'use strict';

const express = require('express');

function recordsRouter(ledgerPromise, fhirAdapter, providerRegistry) {
  const router = express.Router();

  // This route IS the walkthrough in Figure 3 step 4-6 / Figure 4 in full:
  //   1. validate the grant on-chain
  //   1a/1b. hospital RBAC + purpose/scope checks (Section 16, 29, 35.1) --
  //          the blockchain grant is necessary but never sufficient
  //   2/3. resolve DID -> local MRN and pull from the hospital's own DB
  //   4/5. return the FHIR bundle (never touched the chain) + write audit entry
  router.get('/resolve', async (req, res) => {
    const { grantID, hospitalID, purpose, resourceTypes } = req.query;
    if (!grantID || !hospitalID) {
      return res.status(400).json({ error: 'grantID and hospitalID query params are required' });
    }

    try {
      const ledger = await ledgerPromise;

      // Step 1: confirm the grant is valid on-chain, right now.
      const grant = await ledger.checkAccess({ grantID });
      if (!grant) return res.status(404).json({ error: 'grant not found' });
      if (grant.status !== 'ACTIVE') {
        return res.status(403).json({ error: `access not permitted -- grant status is ${grant.status}` });
      }
      if (grant.hospitalID !== hospitalID) {
        return res.status(403).json({ error: 'grant does not cover this hospital' });
      }

      // Step 1a: Level-2 "hospital RBAC" (Section 16/35.1). A patient
      // authorizing "Hospital B" doesn't mean every employee of Hospital B
      // can use it -- only staff the hospital itself has registered and
      // keeps active. Never trust the blockchain permission alone
      // (Section 29).
      if (!providerRegistry.isAuthorized(grant.providerID, hospitalID)) {
        return res.status(403).json({
          error: `hospital RBAC: provider ${grant.providerID} is not an active, registered staff member at ${hospitalID}`,
        });
      }

      // Step 1b: purpose-of-use limitation (Section 35.1). Only enforced
      // when the caller declares a purpose different from the one the
      // grant was authorized for -- omitting it keeps the previous,
      // permissive demo behaviour.
      if (purpose && grant.purpose && purpose !== grant.purpose) {
        return res.status(403).json({
          error: `purpose-of-use mismatch: grant was authorized for "${grant.purpose}", request declared "${purpose}"`,
        });
      }

      // Step 1c: scope check (Section 8). Only enforced when the caller
      // declares which FHIR resource types it's asking for *and* the
      // grant recorded a scope restriction.
      if (resourceTypes && Array.isArray(grant.scope) && grant.scope.length) {
        const requested = resourceTypes.split(',').map((t) => t.trim()).filter(Boolean);
        const outOfScope = requested.filter((t) => !grant.scope.includes(t));
        if (outOfScope.length) {
          return res.status(403).json({
            error: `requested resource type(s) [${outOfScope.join(', ')}] are outside the granted scope [${grant.scope.join(', ')}]`,
          });
        }
      }

      // Steps 2-4: FHIR Adapter resolves locally and pulls from the
      // hospital's own database -- entirely off the blockchain.
      const { mrn, bundles } = fhirAdapter.resolveRecord(hospitalID, grant.patientDID);

      // Step 5/6: log the access event immutably. The record itself is
      // returned to the caller but never written to the ledger.
      await ledger.writeAuditEntry({
        patientDID: grant.patientDID,
        eventType: 'RECORD_ACCESSED',
        actorID: grant.providerID,
        hospitalID,
        detail: `FHIR resolution via grant ${grantID}`,
        clientTimestamp: new Date().toISOString(),
        queuedOffline: false,
      });

      res.json({
        grant,
        resolution: {
          hospitalID,
          localMrn: mrn, // shown here only for the demo -- a real Adapter would never expose this to the caller
          note: 'MRN is resolved locally by the FHIR Adapter and never leaves this hospital; it is never written on-chain.',
        },
        bundles,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { recordsRouter };
