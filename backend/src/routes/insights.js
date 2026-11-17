'use strict';

const express = require('express');
const { requireRole, deny, ROLES } = require('../auth/policy');
const { accessActivity } = require('../services/accessInsights');
const { DiagnosisError, periodOf } = require('../services/diagnosisInsights');

/**
 * insights.js
 *
 *   /api/diagnoses  clinicians: search the catalogue, add a missing term,
 *                   tick diagnoses after opening a record (counted
 *                   anonymously; see services/diagnosisInsights.js)
 *   /api/insights   system admins: Access activity and Diagnosis trends,
 *                   and the review queue for new local terms
 */

const DAY = 24 * 3600 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

function sendError(res, err) {
  if (err instanceof DiagnosisError) return res.status(err.status).json({ error: err.message });
  return res.status(400).json({ error: err.message });
}

function diagnosesRouter({ diagnoses, ledgerPromise, providerRegistry }) {
  const router = express.Router();

  // A revoked grant's diagnosis notes are deleted at once; expired ones
  // are purged on the next read or write.
  Promise.resolve(ledgerPromise)
    .then((ledger) => ledger && ledger.onEvent && ledger.onEvent((evt) => {
      if (evt && evt.type === 'AccessRevoked' && evt.payload && evt.payload.grantID) diagnoses.forgetGrant(evt.payload.grantID);
    }))
    .catch(() => {});
  const staff = requireRole(ROLES.CLINICIAN, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN);

  router.get('/search', staff, (req, res) => {
    res.json(diagnoses.search(String(req.query.q || '').slice(0, 120), req.query.limit));
  });

  router.post('/terms', requireRole(ROLES.CLINICIAN, ROLES.SYSTEM_ADMIN), (req, res) => {
    try {
      const { term, created } = diagnoses.addLocalTerm(req.body && req.body.term, { createdBy: req.user.providerID || req.user.sub });
      res.status(created ? 201 : 200).json({ ...term, created });
    } catch (err) {
      sendError(res, err);
    }
  });

  // Who may note diagnoses under a grant: the clinician it names, or any
  // clinician at the requesting hospital for a hospital-wide share.
  async function grantFor(req, res, grantID) {
    if (!grantID || typeof grantID !== 'string') {
      res.status(400).json({ error: 'grantID is required' });
      return null;
    }
    const ledger = await ledgerPromise;
    const grant = await ledger.checkAccess({ grantID });
    if (!grant) {
      res.status(404).json({ error: 'grant not found' });
      return null;
    }
    if (grant.status !== 'ACTIVE') {
      res.status(403).json({ error: `grant is ${grant.status}` });
      return null;
    }
    const viewerHospital = grant.requesterHospitalID || grant.hospitalID;
    let clinicianID = grant.providerID;
    if (!req.user.superuser) {
      if (req.user.hospitalID !== viewerHospital) {
        deny(res, `this grant is for clinicians at ${viewerHospital}`);
        return null;
      }
      const shared = grant.providerID === `hospital-staff@${viewerHospital}`;
      if (!shared && req.user.providerID !== grant.providerID) {
        deny(res, 'only the clinician named on this grant can use it');
        return null;
      }
      clinicianID = req.user.providerID || req.user.sub;
    }
    return { grant, viewerHospital, clinicianID };
  }

  // After opening records under a grant, the clinician ticks what the
  // visit is about. Only anonymous counts change, once per episode per
  // patient; nothing is written on-chain.
  router.post('/tags', requireRole(ROLES.CLINICIAN), async (req, res) => {
    try {
      const ctx = await grantFor(req, res, req.body && req.body.grantID);
      if (!ctx) return undefined;
      const { grant, viewerHospital, clinicianID } = ctx;
      const profile = providerRegistry && clinicianID ? providerRegistry.get(clinicianID, viewerHospital) : null;
      const result = diagnoses.tag({
        codes: req.body.codes,
        grantID: grant.grantID,
        patientDID: grant.patientDID,
        grantEndsAt: grant.expiresAt,
        clinicianID,
        viewerHospitalID: viewerHospital,
        recordsHospitalID: grant.hospitalID,
        role: (profile && profile.role) || grant.providerRole || 'Clinician',
      });
      return res.json({ results: result.results, notes: diagnoses.notesForGrant({ grantID: grant.grantID, clinicianID, grantEndsAt: grant.expiresAt }) });
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.get('/notes', requireRole(ROLES.CLINICIAN), async (req, res) => {
    try {
      const ctx = await grantFor(req, res, req.query.grantID);
      if (!ctx) return undefined;
      return res.json(diagnoses.notesForGrant({ grantID: ctx.grant.grantID, clinicianID: ctx.clinicianID, grantEndsAt: ctx.grant.expiresAt }));
    } catch (err) {
      return sendError(res, err);
    }
  });

  router.delete('/tags/:code', requireRole(ROLES.CLINICIAN), async (req, res) => {
    try {
      const ctx = await grantFor(req, res, req.query.grantID);
      if (!ctx) return undefined;
      diagnoses.undo({ grantID: ctx.grant.grantID, code: req.params.code, clinicianID: ctx.clinicianID });
      return res.json({ notes: diagnoses.notesForGrant({ grantID: ctx.grant.grantID, clinicianID: ctx.clinicianID, grantEndsAt: ctx.grant.expiresAt }) });
    } catch (err) {
      return sendError(res, err);
    }
  });

  return router;
}

function insightsRouter({ diagnoses, ledgerPromise, hospitalRegistry }) {
  const router = express.Router();
  router.use(requireRole(ROLES.SYSTEM_ADMIN));

  router.get('/access', async (req, res) => {
    try {
      const to = DATE.test(req.query.to || '') ? new Date(`${req.query.to}T23:59:59.999Z`) : new Date();
      const from = DATE.test(req.query.from || '') ? new Date(`${req.query.from}T00:00:00Z`) : new Date(to.getTime() - 30 * DAY);
      if (from > to) return res.status(400).json({ error: 'from must be before to' });
      if (to - from > 366 * DAY) return res.status(400).json({ error: 'choose a range of at most one year' });
      const ledger = await ledgerPromise;
      const hospitals = hospitalRegistry ? hospitalRegistry.list().map((h) => h.hospitalID) : [];
      res.json(await accessActivity(ledger, hospitals, { from, to }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/diagnoses', (req, res) => {
    const to = MONTH.test(req.query.to || '') ? req.query.to : periodOf();
    const from = MONTH.test(req.query.from || '') ? req.query.from : to;
    if (from > to) return res.status(400).json({ error: 'from must be before to' });
    res.json(diagnoses.trends({ from, to, hospitalID: req.query.hospitalID || undefined }));
  });

  router.get('/terms/pending', (req, res) => res.json(diagnoses.pendingTerms()));

  // Episode intervals: how long the same diagnosis for the same patient
  // counts once. A default, and an optional value per code.
  router.get('/intervals', (req, res) => res.json(diagnoses.intervals({ q: String(req.query.q || '').slice(0, 120) })));

  router.put('/intervals/default', (req, res) => {
    try {
      res.json({ defaultIntervalDays: diagnoses.setDefaultIntervalDays(req.body && req.body.days) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/intervals/:code', (req, res) => {
    try {
      res.json(diagnoses.setInterval(req.params.code, req.body ? req.body.days : undefined, { by: req.user.sub }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/terms/:code/map', (req, res) => {
    try {
      const { targetCode, newDisplay } = req.body || {};
      res.json(diagnoses.mapTerm(req.params.code, { targetCode, newDisplay, reviewedBy: req.user.sub }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/terms/:code/reject', (req, res) => {
    try {
      res.json(diagnoses.rejectTerm(req.params.code, { reviewedBy: req.user.sub }));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

module.exports = { diagnosesRouter, insightsRouter };
