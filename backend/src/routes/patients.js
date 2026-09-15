'use strict';

const express = require('express');
const { randomUUID } = require('crypto');

function patientsRouter(ledgerPromise, fhirAdapter, identityService) {
  const router = express.Router();

  function demographicsFromBody(body) {
    const { name, dob, sex, phone, nin } = body;
    return { name, dob, sex, phone, nin };
  }

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

  // Preview-only MPI lookup (docs/design.md Section 4): lets a hospital
  // registrar check whether a person looks like an existing PatientChain
  // patient *before* deciding how to register them. Never writes anything.
  router.get('/match', (req, res) => {
    try {
      const query = demographicsFromBody(req.query);
      if (!identityService.constructor.hasAnyDemographics(query)) {
        return res.status(400).json({ error: 'at least one of name, dob, sex, phone or nin is required' });
      }
      res.json(identityService.matchPatient(query));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Register a new patient DID on-chain, and (separately, off-chain) at a
  // hospital's local patient index -- mirroring how a real deployment
  // would have the patient app write to PatientRegistry and, independently,
  // the hospital's registration desk assign an MRN.
  //
  // If demographic fields are supplied, this runs the Master Patient Index
  // match first (docs/design.md Section 4): a confident match reuses the
  // existing PatientChain DID instead of minting a new one, and a possible
  // duplicate is refused (409) with candidates for manual review, unless
  // the caller passes `force: true` to register a new identity anyway.
  router.post('/register', async (req, res) => {
    try {
      const ledger = await ledgerPromise;
      const demographics = demographicsFromBody(req.body);
      const hasDemographics = identityService.constructor.hasAnyDemographics(demographics);

      let patientDID = req.body.patientDID;
      let identityResult = null;

      if (hasDemographics && !patientDID && !req.body.force) {
        identityResult = identityService.matchPatient(demographics);
        if (identityResult.matchType === 'POSSIBLE_DUPLICATE') {
          return res.status(409).json({
            error: 'possible duplicate patient -- resolve via POST /:did/link or resubmit with force:true',
            identity: identityResult,
          });
        }
        if (identityResult.matchType === 'CONFIDENT_MATCH') {
          patientDID = identityResult.patientDID;
        }
      }

      let patient;
      const alreadyRegistered = await tryGetPatient(ledger, patientDID);

      if (alreadyRegistered) {
        patient = alreadyRegistered;
      } else {
        patientDID = patientDID || `did:patientchain:${randomUUID()}`;
        const publicKey = req.body.publicKey || `pubkey-${randomUUID().slice(0, 12)}`;
        patient = await ledger.registerPatient({ patientDID, publicKey });
      }

      if (hasDemographics) {
        identityService.registerDemographics(patientDID, demographics);
      }

      const response = { patient, identity: identityResult };
      if (req.body.hospitalID) {
        const mrn = fhirAdapter.registerLocalPatient(req.body.hospitalID, patientDID, req.body.mrn);
        response.localHospitalMrn = mrn;
      }
      res.status(201).json(response);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Lets a registrar explicitly resolve an MPI "possible duplicate": link
  // the demographics (and optionally a hospital MRN) to an *existing*
  // PatientChain DID rather than minting a new one.
  router.post('/:did/link', async (req, res) => {
    try {
      const ledger = await ledgerPromise;
      const patientDID = req.params.did;
      const patient = await ledger.getPatient(patientDID); // throws 404-ish if not registered
      const demographics = demographicsFromBody(req.body);
      if (identityService.constructor.hasAnyDemographics(demographics)) {
        identityService.registerDemographics(patientDID, demographics);
      }

      const response = { patient };
      if (req.body.hospitalID) {
        const mrn = fhirAdapter.registerLocalPatient(req.body.hospitalID, patientDID, req.body.mrn);
        response.localHospitalMrn = mrn;
      }
      res.json(response);
    } catch (err) {
      res.status(404).json({ error: err.message });
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
