'use strict';

const express = require('express');
const { ROLES, hasRole, isSystemAdmin, deny, actorID } = require('../auth/policy');
const { EmergencyDetails } = require('../services/emergencyDetails');

/**
 * hospitalAdmin.js — the Hospital Admin view (Chapter 3, NFR9, Table 3.7).
 *
 * Everything a hospital's administration needs about its own hospital:
 *
 *   GET  /overview        headline numbers
 *   GET  /access-log      every record access at this hospital and who did it
 *                         (from the immutable ledger audit trail)
 *   GET  /grants          every access grant covering this hospital's records
 *   GET  /clinicians      registered clinicians, with their access activity
 *   POST /clinicians      register / update a clinician (role, department, status)
 *   GET  /patients        patients who have linked their Health ID here
 *
 * A hospital admin sees only their own hospital; a system admin passes
 * ?hospitalID=. Patient names come from the hospital's own roster and
 * never leave this hospital's view.
 */

const ACCESS_EVENTS = new Set(['RECORD_ACCESSED', 'BREAK_GLASS_ACCESS']);

function hospitalAdminRouter({ ledgerPromise, fhirAdapter, providerRegistry, hospitalRegistry = null, db = null, cipher = null }) {
  const router = express.Router();
  const emergency = db && cipher ? new EmergencyDetails({ db, cipher }) : null;

  router.use((req, res, next) => {
    if (!hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) return deny(res, 'requires role: hospital_admin');
    const all = req.user.superuser || isSystemAdmin(req.user);
    const hospitalID = all ? String(req.query.hospitalID || req.body?.hospitalID || '') : req.user.hospitalID;
    if (!hospitalID) return res.status(400).json({ error: 'hospitalID is required' });
    req.hospitalID = hospitalID;
    next();
  });

  // Names, resolved inside this hospital only.
  function directory(hospitalID) {
    const providers = new Map(providerRegistry.getForHospital(hospitalID).map((p) => [p.providerID, p]));
    const links = fhirAdapter.listLinks(hospitalID);
    const patients = new Map();
    for (const l of links) {
      const rec = fhirAdapter.findLocalPatientRecord(hospitalID, l.hospitalNumber);
      patients.set(l.patientDID, { ...l, name: rec ? rec.name : null });
    }
    return { providers, patients, links };
  }

  function describeActor(id, providers) {
    const p = providers.get(id);
    if (p) return { id, name: p.name, role: p.role, department: p.department, kind: 'clinician', hospitalID: p.hospitalID, ours: true };
    if (String(id).startsWith('hospital-staff@')) return { id, name: `All clinicians at ${hospitalName(id.slice(15))}`, kind: 'hospital', hospitalID: id.slice(15) };
    const elsewhere = providerRegistry.registrationsOf ? providerRegistry.registrationsOf(id)[0] : null;
    if (elsewhere) return { id, name: elsewhere.name, role: elsewhere.role, department: elsewhere.department, kind: 'clinician', hospitalID: elsewhere.hospitalID, ours: false, hospitalName: hospitalName(elsewhere.hospitalID) };
    if (String(id).startsWith('did:')) return { id, name: null, kind: 'patient' };
    return { id, name: null, kind: 'other' };
  }

  function hospitalName(id) {
    const h = hospitalRegistry ? hospitalRegistry.get(id) : null;
    return h ? h.name : id;
  }

  // Both directions: entries about this hospital's records, and entries
  // caused by this hospital's own clinicians at other hospitals.
  async function auditFor(hospitalID) {
    const ledger = await ledgerPromise;
    const byId = new Map();
    for (const e of (ledger.getAuditTrailForHospital ? await ledger.getAuditTrailForHospital(hospitalID) : []) || []) byId.set(e.entryID, { ...e, direction: 'our-records' });
    if (ledger.getAuditTrailForActor) {
      for (const p of providerRegistry.getForHospital(hospitalID)) {
        for (const e of (await ledger.getAuditTrailForActor(p.providerID)) || []) {
          if (!byId.has(e.entryID)) byId.set(e.entryID, { ...e, direction: 'our-clinician' });
        }
      }
    }
    return [...byId.values()];
  }

  async function grantsFor(hospitalID) {
    const ledger = await ledgerPromise;
    const byId = new Map();
    for (const g of (ledger.getGrantsForHospital ? await ledger.getGrantsForHospital(hospitalID) : []) || []) byId.set(g.grantID, { ...g, direction: 'our-records' });
    for (const g of (ledger.getGrantsByRequesterHospital ? await ledger.getGrantsByRequesterHospital(hospitalID) : []) || []) {
      if (!byId.has(g.grantID)) byId.set(g.grantID, { ...g, direction: 'our-clinician' });
    }
    return [...byId.values()];
  }

  router.get('/overview', async (req, res) => {
    try {
      const h = req.hospitalID;
      const [audit, grants] = await Promise.all([auditFor(h), grantsFor(h)]);
      const since = Date.now() - 7 * 24 * 3600 * 1000;
      const providers = providerRegistry.getForHospital(h);
      const hospital = hospitalRegistry ? hospitalRegistry.get(h) : null;
      let screenshots = 0;
      if (db) screenshots = db.prepare('SELECT COUNT(*) AS n FROM screen_capture_attempts WHERE hospital_id = ? AND occurred_at >= ?').get(h, new Date(since).toISOString()).n;
      res.json({
        hospitalID: h,
        hospitalName: hospital ? hospital.name : h,
        integration: hospital ? hospital.integration : null,
        linkedPatients: fhirAdapter.listLinks(h).length,
        rosterSize: fhirAdapter.listLocalPatientRecords(h).length,
        clinicians: providers.filter((p) => p.status === 'ACTIVE').length,
        cliniciansSuspended: providers.filter((p) => p.status !== 'ACTIVE').length,
        grants: {
          active: grants.filter((g) => g.status === 'ACTIVE').length,
          pending: grants.filter((g) => g.status === 'PENDING').length,
          revoked: grants.filter((g) => g.status === 'REVOKED').length,
          expired: grants.filter((g) => g.status === 'EXPIRED').length,
        },
        breakGlassAwaitingReview: grants.filter((g) => g.grantType === 'BREAK_GLASS' && !g.reviewed).length,
        emergencyActiveNow: grants.filter((g) => g.grantType === 'BREAK_GLASS' && g.status === 'ACTIVE').length,
        ourRecordsOpenedLast7Days: audit.filter((e) => e.direction === 'our-records' && ACCESS_EVENTS.has(e.eventType) && new Date(e.timestamp).getTime() >= since).length,
        ourCliniciansOpenedLast7Days: audit.filter((e) => e.direction === 'our-clinician' && ACCESS_EVENTS.has(e.eventType) && new Date(e.timestamp).getTime() >= since).length,
        recordAccessesLast7Days: audit.filter((e) => ACCESS_EVENTS.has(e.eventType) && new Date(e.timestamp).getTime() >= since).length,
        screenshotAttemptsLast7Days: screenshots,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/access-log', async (req, res) => {
    try {
      const h = req.hospitalID;
      const { providers, patients } = directory(h);
      const type = String(req.query.type || 'access');
      let entries = await auditFor(h);
      if (type === 'access') entries = entries.filter((e) => ACCESS_EVENTS.has(e.eventType));
      else if (type !== 'all') entries = entries.filter((e) => e.eventType === type);
      if (req.query.providerID) entries = entries.filter((e) => e.actorID === req.query.providerID);
      if (req.query.patientDID) entries = entries.filter((e) => e.patientDID === req.query.patientDID);
      if (req.query.from) entries = entries.filter((e) => e.timestamp >= String(req.query.from));
      if (req.query.to) entries = entries.filter((e) => e.timestamp <= String(req.query.to));
      entries = entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, Math.min(Number(req.query.limit) || 500, 2000));
      res.json(
        entries.map((e) => ({
          ...e,
          actor: describeActor(e.actorID, providers),
          patient: patients.get(e.patientDID) || { patientDID: e.patientDID, name: null },
          breakGlass: e.eventType === 'BREAK_GLASS_ACCESS' || e.eventType === 'BREAK_GLASS_EXTENDED',
          recordsAt: { hospitalID: e.hospitalID, name: hospitalName(e.hospitalID) },
        }))
      );
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/grants', async (req, res) => {
    try {
      const h = req.hospitalID;
      const { providers, patients } = directory(h);
      let grants = await grantsFor(h);
      if (req.query.status) grants = grants.filter((g) => g.status === req.query.status);
      res.json(
        grants.map((g) => ({
          ...(emergency ? emergency.enrich(g) : g),
          provider: describeActor(g.providerID, providers),
          patient: patients.get(g.patientDID) || { patientDID: g.patientDID, name: null },
          recordsAt: { hospitalID: g.hospitalID, name: hospitalName(g.hospitalID) },
          viewedFrom: { hospitalID: g.requesterHospitalID, name: hospitalName(g.requesterHospitalID) },
        }))
      );
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/clinicians', async (req, res) => {
    try {
      const h = req.hospitalID;
      const audit = await auditFor(h);
      const grants = await grantsFor(h);
      res.json(
        providerRegistry.getForHospital(h).map((p) => {
          const mine = audit.filter((e) => e.actorID === p.providerID && ACCESS_EVENTS.has(e.eventType));
          return {
            ...p,
            recordAccesses: mine.length,
            breakGlassUses: mine.filter((e) => e.eventType === 'BREAK_GLASS_ACCESS').length,
            patientsAccessed: new Set(mine.map((e) => e.patientDID)).size,
            lastAccessAt: mine.length ? mine.map((e) => e.timestamp).sort().at(-1) : null,
            activeGrants: grants.filter((g) => g.providerID === p.providerID && g.status === 'ACTIVE').length,
          };
        })
      );
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/clinicians', (req, res) => {
    try {
      const { providerID, name, role, department, status } = req.body || {};
      if (!providerID || !/^[\w.@:-]{2,128}$/.test(providerID)) return res.status(400).json({ error: 'providerID is required (letters, digits, . _ - @ :)' });
      const provider = providerRegistry.register({ providerID, hospitalID: req.hospitalID, name, role, department, status });
      res.status(201).json({ ...provider, registeredBy: actorID(req.user, 'hospital-admin') });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/patients', async (req, res) => {
    try {
      const h = req.hospitalID;
      const { patients } = directory(h);
      const [audit, grants] = await Promise.all([auditFor(h), grantsFor(h)]);
      res.json(
        [...patients.values()].map((p) => {
          const accesses = audit.filter((e) => e.patientDID === p.patientDID && ACCESS_EVENTS.has(e.eventType));
          return {
            ...p,
            activeGrants: grants.filter((g) => g.patientDID === p.patientDID && g.status === 'ACTIVE').length,
            recordAccesses: accesses.length,
            lastAccessAt: accesses.length ? accesses.map((e) => e.timestamp).sort().at(-1) : null,
          };
        })
      );
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { hospitalAdminRouter };
