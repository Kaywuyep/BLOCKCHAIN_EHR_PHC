'use strict';

const express = require('express');
const { randomUUID } = require('crypto');

function patientsRouter(ledgerPromise, fhirAdapter, linkageService) {
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

  // Register a new patient DID on-chain, and (separately, off-chain) at a
  // hospital's local patient index -- mirroring how a real deployment
  // would have the patient app write to PatientRegistry and,
  // independently, the hospital's registration desk assign a fresh MRN.
  // No demographic matching happens here: PatientRegistry.RegisterPatient
  // only ever mints or reuses a DID. Linking that DID to a record a
  // patient already has at some *other* hospital is a separate,
  // patient-asserted step -- see POST /:did/link-facility below.
  router.post('/register', async (req, res) => {
    try {
      const ledger = await ledgerPromise;
      let patientDID = req.body.patientDID;

      let patient;
      const alreadyRegistered = await tryGetPatient(ledger, patientDID);

      if (alreadyRegistered) {
        patient = alreadyRegistered;
      } else {
        patientDID = patientDID || `did:patientchain:${randomUUID()}`;
        const publicKey = req.body.publicKey || `pubkey-${randomUUID().slice(0, 12)}`;
        patient = await ledger.registerPatient({ patientDID, publicKey });
      }

      const response = { patient };
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
  router.post('/:did/confirm-link', (req, res) => {
    try {
      const { hospitalID, hospitalNumber } = req.body;
      if (!hospitalID || !hospitalNumber) {
        return res.status(400).json({ error: 'hospitalID and hospitalNumber are required' });
      }
      const result = linkageService.confirmLink(req.params.did, hospitalID, hospitalNumber);
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/:did', async (req, res) => {
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

  router.get('/:did/references', async (req, res) => {
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
