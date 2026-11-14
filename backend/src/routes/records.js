'use strict';

const express = require('express');
const { isProvider, deny } = require('../auth/policy');
const { fetchPatientResources } = require('../services/liveFhirClient');

// Table 3.6. Administrative resources give identity context for a record
// and are always returned; clinical ones only if the grant's scope allows.
const ADMIN_TYPES = ['Patient', 'Practitioner', 'Organization'];
const CLINICAL_TYPES = ['Encounter', 'Observation', 'DiagnosticReport', 'Condition', 'MedicationRequest', 'DocumentReference', 'AllergyIntolerance'];

/** Keeps only the resources a grant's scope covers (empty scope = all). */
function filterByScope(bundles, scope) {
  const allowed = new Set([...ADMIN_TYPES, ...(Array.isArray(scope) && scope.length ? scope : CLINICAL_TYPES)]);
  let withheld = 0;
  const out = [];
  for (const b of bundles) {
    const entry = (b.entry || []).filter((e) => {
      const ok = e.resource && allowed.has(e.resource.resourceType);
      if (!ok) withheld += 1;
      return ok;
    });
    if (entry.length) out.push({ ...b, entry });
  }
  return { bundles: out, withheld };
}

const PRODUCTION = (process.env.NODE_ENV || '').toLowerCase() === 'production';

function recordsRouter(ledgerPromise, fhirAdapter, providerRegistry, hospitalRegistry = null) {
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

      // Step 0: who may use the grant. Cevruni only mediates access between
      // facilities: the viewer must be an active clinician at the grant's
      // requesting hospital -- the clinician it names, or any clinician
      // there for a patient's standing share with that hospital.
      const requester = grant.requesterHospitalID || '';
      if (!requester) {
        // Grants made before facility-to-facility grants existed.
        if (!isProvider(req.user, grant.providerID, grant.hospitalID)) return deny(res, 'only the clinician named on this grant can use it');
      } else if (!req.user.superuser) {
        const sharedWithHospital = grant.providerID === `hospital-staff@${requester}`;
        if (!req.user.roles.includes('clinician') || req.user.hospitalID !== requester) {
          return deny(res, `this grant is for clinicians at ${requester}`);
        }
        if (!sharedWithHospital && req.user.providerID !== grant.providerID) {
          return deny(res, 'only the clinician named on this grant can use it');
        }
      }
      const viewer = req.user.superuser ? (grant.providerID.startsWith('hospital-staff@') ? null : grant.providerID) : req.user.providerID;
      const viewerHospital = requester || grant.hospitalID;

      // Step 1a: hospital RBAC (Level 2, Section 3.4.7). Only clinicians
      // their own hospital has registered and keeps active can use a grant;
      // the blockchain permission alone is never enough.
      if (viewer && !providerRegistry.isAuthorized(viewer, viewerHospital)) {
        return res.status(403).json({
          error: `hospital RBAC: provider ${viewer} is not an active, registered staff member at ${viewerHospital}`,
        });
      }

      // Step 1a': role restriction (Section 3.4.7). A grant issued to a
      // clinician in one role (e.g. Physician) is not usable if that
      // clinician's registered role has since changed.
      if (grant.providerRole && viewer && !req.user.superuser) {
        const profile = providerRegistry.get(viewer, viewerHospital);
        if (!profile || profile.role !== grant.providerRole) {
          return res.status(403).json({
            error: `role restriction: this grant is for a ${grant.providerRole}; provider ${viewer} is registered as ${profile ? profile.role : 'unknown'}`,
          });
        }
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
      const local = fhirAdapter.resolveRecord(hospitalID, grant.patientDID);
      const mrn = local.mrn;
      let allBundles = local.bundles;
      let liveSource = null;

      // Hospitals connected by FHIR API: pull from their own server too,
      // only the resource types the grant allows (Section 3.4.8).
      const hospital = hospitalRegistry ? hospitalRegistry.getInternal(hospitalID) : null;
      if (hospital && hospital.status === 'active' && hospital.fhir && (hospital.integration === 'fhir' || hospital.integration === 'both')) {
        const types = Array.isArray(grant.scope) && grant.scope.length ? grant.scope.filter((t) => CLINICAL_TYPES.includes(t)) : CLINICAL_TYPES;
        try {
          const resources = await fetchPatientResources(hospital, mrn, types);
          allBundles = allBundles.concat([
            { resourceType: 'Bundle', type: 'searchset', id: `live-${grantID}`, timestamp: new Date().toISOString(), entry: resources.map((resource) => ({ resource })) },
          ]);
          liveSource = { ok: true, resources: resources.length };
        } catch (err) {
          liveSource = { ok: false, error: err.message };
        }
      }

      // Step 1c': return only what the grant covers (record-type scope).
      const { bundles, withheld } = filterByScope(allBundles, grant.scope);

      // Step 5/6: log the access event immutably. The record itself is
      // returned to the caller but never written to the ledger.
      await ledger.writeAuditEntry({
        patientDID: grant.patientDID,
        eventType: 'RECORD_ACCESSED',
        actorID: viewer || grant.providerID,
        hospitalID,
        detail: `${grant.grantType === 'BREAK_GLASS' ? 'EMERGENCY ' : ''}records opened from ${viewerHospital} via grant ${grantID}${withheld ? `; ${withheld} out-of-scope resource(s) withheld` : ''}${liveSource ? `; live FHIR ${liveSource.ok ? 'ok' : 'failed'}` : ''}`,
        clientTimestamp: new Date().toISOString(),
        queuedOffline: false,
      });

      res.json({
        grant,
        resolution: {
          hospitalID,
          // Shown only outside production, for the demo: in production the
          // MRN never leaves the hospital's adapter.
          ...(PRODUCTION ? {} : { localMrn: mrn }),
          note: 'MRN is resolved locally by the FHIR Adapter and never leaves this hospital; it is never written on-chain.',
        },
        bundles,
        scope: Array.isArray(grant.scope) && grant.scope.length ? grant.scope : 'all',
        withheld,
        ...(liveSource ? { liveSource } : {}),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { recordsRouter, filterByScope, CLINICAL_TYPES, ADMIN_TYPES };
