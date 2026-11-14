'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const { ROLES, hasRole, actsForHospital, isPatientSelf, deny } = require('../auth/policy');

function patientsRouter(ledgerPromise, fhirAdapter, linkageService, identityStore = null, referenceService = null) {
  const router = express.Router();

  // ledger.getPatient() throws (synchronously, in simulated mode; via a
  // rejected promise in Fabric mode) when the patient doesn't exist. A
  // real try/catch handles both cases; `.catch()` chaining would miss the
  // synchronous case.
  async function tryGetPatient(ledger, patientDID) {
    if (!patientDID) return null;
    try {
      return await ledger.getPatient(patientDID);
    } catch {
      return null;
    }
  }

  // FR1 step 1: before a patient has a DID, they look up the record at the
  // first hospital they registered with (hospital number + date of birth).
  // Same generic answer and rate limit as link-facility.
  router.post('/register/lookup', (req, res) => {
    const user = req.user;
    if (!hasRole(user, ROLES.PATIENT)) return deny(res, 'requires role: patient');
    const { hospitalID, hospitalNumber, dateOfBirth } = req.body || {};
    if (!hospitalID || !hospitalNumber || !dateOfBirth) {
      return res.status(400).json({ error: 'hospitalID, hospitalNumber and dateOfBirth are required' });
    }
    try {
      res.json(linkageService.linkFacility(`pending:${user.sub}`, hospitalID, hospitalNumber, dateOfBirth));
    } catch (err) {
      if (err.message.startsWith('too many lookup attempts')) return res.status(429).json({ error: err.message });
      res.status(404).json({ error: err.message });
    }
  });

  // Register a new patient DID on-chain, and (separately, off-chain) at a
  // hospital's local patient index -- mirroring how a real deployment
  // would have the patient app write to PatientRegistry and,
  // independently, the hospital's registration desk assign a fresh MRN.
  // No demographic matching happens here: PatientRegistry.RegisterPatient
  // only ever mints or reuses a DID. Linking that DID to a record a
  // patient already has at some *other* hospital is a separate,
  // patient-asserted step -- see POST /:did/link-facility below.
  router.post('/register', async (req, res) => {
    const user = req.user;
    const asPatient = !user.superuser && user.roles.includes(ROLES.PATIENT);
    if (!hasRole(user, ROLES.PATIENT, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) {
      return deny(res, 'requires role: patient, hospital_admin or system_admin');
    }
    if (asPatient) {
      // A patient registers only themselves: they may not claim an existing
      // DID that isn't already bound to their account, and may not attach
      // a hospital number directly -- that goes through the verified
      // link-facility flow.
      if (req.body.patientDID && req.body.patientDID !== user.patientDID) {
        return deny(res, 'a patient can only register their own DID');
      }
      if (req.body.mrn || req.body.hospitalID) {
        return deny(res, 'patients link a hospital record through link-facility, not at registration');
      }
      // FR1: a new patient's DID is registered only after identity
      // resolution at their first hospital (register/lookup, then confirm
      // here with the same hospital and number).
      if (!user.patientDID) {
        const first = req.body.firstFacility || {};
        if (!first.hospitalID || !first.hospitalNumber) {
          return res.status(400).json({ error: 'confirm your record at your first hospital (hospital number and date of birth) before creating your Health ID' });
        }
        const linkedTo = fhirAdapter.findDidByHospitalNumber(first.hospitalID, first.hospitalNumber);
        if (linkedTo) return res.status(409).json({ error: 'this hospital record is already linked to a Health ID' });
        if (!linkageService.consumePending(`pending:${user.sub}`, first.hospitalID, first.hospitalNumber)) {
          return res.status(400).json({ error: 'no confirmed match pending for that hospital number -- look it up again first' });
        }
        req.firstFacility = first;
      }
    } else if (req.body.hospitalID && !actsForHospital(user, req.body.hospitalID, ROLES.HOSPITAL_ADMIN)) {
      return deny(res, 'hospital staff can only register patients at their own hospital');
    }
    try {
      const ledger = await ledgerPromise;
      let patientDID = asPatient ? user.patientDID || undefined : req.body.patientDID;

      let patient;
      const alreadyRegistered = await tryGetPatient(ledger, patientDID);

      if (alreadyRegistered) {
        patient = alreadyRegistered;
      } else {
        patientDID = patientDID || `did:patientchain:${randomUUID()}`;
        const publicKey = req.body.publicKey || `pubkey-${randomUUID().slice(0, 12)}`;
        patient = await ledger.registerPatient({ patientDID, publicKey });
      }
      if (asPatient && identityStore) identityStore.bind(user.sub, patientDID);

      const response = { patient };
      if (req.firstFacility) {
        const { hospitalID, hospitalNumber } = req.firstFacility;
        fhirAdapter.registerLocalPatient(hospitalID, patientDID, hospitalNumber);
        response.firstFacility = { hospitalID, hospitalNumber };
        if (referenceService) response.references = (await referenceService.registerExisting(hospitalID, patientDID, hospitalNumber)).length;
      }
      if (req.body.hospitalID) {
        const mrn = fhirAdapter.registerLocalPatient(req.body.hospitalID, patientDID, req.body.mrn);
        response.localHospitalMrn = mrn;
      }
      res.status(201).json(response);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Lets a hospital add an entry to its own pre-existing patient roster --
  // the off-chain "legacy EMR data" that link-facility below checks a
  // patient's claimed hospital number + date of birth against. Represents
  // a hospital's registration desk (or a one-off data migration), never a
  // PatientChain identity operation -- nothing here ever touches the
  // ledger. See the Admin Dashboard's "Hospital local patient roster" panel.
  router.post('/local-records/:hospitalID', (req, res) => {
    if (!actsForHospital(req.user, req.params.hospitalID, ROLES.HOSPITAL_ADMIN, ROLES.HL7_INTERFACE)) {
      return deny(res, 'only this hospital\'s staff or interface engine can add to its roster');
    }
    try {
      const { hospitalNumber, name, dob } = req.body;
      if (!hospitalNumber || !name || !dob) {
        return res.status(400).json({ error: 'hospitalNumber, name and dob are required' });
      }
      const record = fhirAdapter.addLocalPatientRecord(req.params.hospitalID, hospitalNumber, { name, dob });
      res.status(201).json(record);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/local-records/:hospitalID', (req, res) => {
    if (!actsForHospital(req.user, req.params.hospitalID, ROLES.HOSPITAL_ADMIN)) {
      return deny(res, 'only this hospital\'s admins can view its roster');
    }
    res.json(fhirAdapter.listLocalPatientRecords(req.params.hospitalID));
  });

  // Step 1 of the patient-asserted facility-linkage flow: the patient
  // claims a hospital number and date of birth for a hospital they
  // already have a record at. A match returns the record's name so the
  // patient can confirm it's them -- it does not link anything yet. No
  // match (wrong number OR wrong date of birth -- deliberately
  // indistinguishable) returns a generic 404, and repeated attempts are
  // rate-limited per patient as a second layer against enumeration.
  router.post('/:did/link-facility', (req, res) => {
    if (!isPatientSelf(req.user, req.params.did)) return deny(res, 'patients can only link facilities to their own DID');
    try {
      const { hospitalID, hospitalNumber, dateOfBirth } = req.body;
      if (!hospitalID || !hospitalNumber || !dateOfBirth) {
        return res.status(400).json({ error: 'hospitalID, hospitalNumber and dateOfBirth are required' });
      }
      const result = linkageService.linkFacility(req.params.did, hospitalID, hospitalNumber, dateOfBirth);
      res.json(result);
    } catch (err) {
      if (err.message.startsWith('too many lookup attempts')) {
        return res.status(429).json({ error: err.message });
      }
      res.status(404).json({ error: err.message });
    }
  });

  // Step 2: only succeeds once the patient has seen the matched name from
  // link-facility and explicitly confirmed it's them. Records the DID
  // <-> hospital-number mapping locally via the FHIR Adapter -- never
  // on-chain.
  router.post('/:did/confirm-link', async (req, res) => {
    if (!isPatientSelf(req.user, req.params.did)) return deny(res, 'patients can only link facilities to their own DID');
    try {
      const { hospitalID, hospitalNumber } = req.body;
      if (!hospitalID || !hospitalNumber) {
        return res.status(400).json({ error: 'hospitalID and hospitalNumber are required' });
      }
      const result = linkageService.confirmLink(req.params.did, hospitalID, hospitalNumber);
      // Pointers for the records this hospital already holds (FR3).
      if (referenceService) result.references = (await referenceService.registerExisting(hospitalID, req.params.did, hospitalNumber)).length;
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Clinician looks up a patient by their hospital number at the clinician's
  // hospital. Returns the patient's DID and name if found — this is how a
  // clinician finds a patient without knowing the raw DID.
  router.get('/lookup-by-hospital-number/:hospitalID/:hospitalNumber', (req, res) => {
    if (!hasRole(req.user, ROLES.CLINICIAN, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) {
      return deny(res, 'requires clinician, hospital_admin or system_admin role');
    }
    const { hospitalID, hospitalNumber } = req.params;
    // A clinician looks patients up at their OWN hospital only. Finding a
    // patient by another hospital's number is part of break-glass, where it
    // is justified and logged.
    if (!actsForHospital(req.user, hospitalID, ROLES.CLINICIAN, ROLES.HOSPITAL_ADMIN)) {
      return deny(res, 'you can only look up patients by your own hospital\'s numbers');
    }
    const patientDID = fhirAdapter.findDidByHospitalNumber(hospitalID, hospitalNumber);
    if (!patientDID) {
      return res.status(404).json({ error: 'No patient with that hospital number is linked in Cevruni' });
    }
    // Also get the patient's name from the local roster for display
    const localRecord = fhirAdapter.findLocalPatientRecord(hospitalID, hospitalNumber);
    // The other hospitals in the patient's network: where Cevruni can
    // request records from (never their hospital numbers there).
    const network = fhirAdapter
      .listLinksForPatient(patientDID)
      .filter((l) => l.hospitalID !== hospitalID)
      .map((l) => ({ hospitalID: l.hospitalID }));
    res.json({
      patientDID,
      hospitalNumber,
      hospitalID,
      name: localRecord ? localRecord.name : null,
      network,
    });
  });

  router.get('/:did', async (req, res) => {
    if (!isPatientSelf(req.user, req.params.did) && !hasRole(req.user, ROLES.CLINICIAN, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) {
      return deny(res);
    }
    try {
      const ledger = await ledgerPromise;
      const patient = await ledger.getPatient(req.params.did);
      res.json(patient);
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // Hospital's Reference & Query Service registers a new record pointer
  // (Figure 3, step 2). Never accepts clinical content in this call --
  // only metadata, enforced by the request shape itself.
  router.post('/:did/references', async (req, res) => {
    try {
      const ledger = await ledgerPromise;
      const { hospitalID, recordType, date } = req.body;
      if (!hospitalID || !recordType) {
        return res.status(400).json({ error: 'hospitalID and recordType are required' });
      }
      if (!actsForHospital(req.user, hospitalID, ROLES.HOSPITAL_ADMIN, ROLES.CLINICIAN, ROLES.HL7_INTERFACE)) {
        return deny(res, 'only this hospital\'s staff can register its record references');
      }
      const ref = await ledger.registerRecordReference({
        refID: req.body.refID || randomUUID(),
        patientDID: req.params.did,
        hospitalID,
        recordType,
        date: date || new Date().toISOString(),
      });
      res.status(201).json(ref);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // The hospitals this patient has linked (from each hospital's local
  // DID-to-MRN mapping; never on-chain).
  router.get('/:did/facilities', (req, res) => {
    if (!isPatientSelf(req.user, req.params.did)) return deny(res);
    res.json(fhirAdapter.listLinksForPatient(req.params.did));
  });

  router.get('/:did/references', async (req, res) => {
    if (!isPatientSelf(req.user, req.params.did) && !hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) {
      return deny(res);
    }
    try {
      const ledger = await ledgerPromise;
      const refs = await ledger.getRecordReferencesForPatient(req.params.did);
      res.json(refs || []);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { patientsRouter };
