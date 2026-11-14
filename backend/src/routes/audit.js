'use strict';

const { randomUUID } = require('crypto');
const express = require('express');
const { ROLES, hasRole, isPatientSelf, isSystemAdmin, deny, actorID } = require('../auth/policy');

// How the frontend's ScreenShield saw the attempt (see ScreenShield.jsx).
const CAPTURE_METHODS = new Set(['print-screen', 'mac-shortcut', 'windows-snip', 'print']);
// confirmed: the page saw the capture key itself.
// suspected: Cmd/Win+Shift was held and released with no other key reaching
// the page, which is what happens when the OS consumes the capture key.
const CAPTURE_CONFIDENCE = new Set(['confirmed', 'suspected']);
const DID_PATTERN = /^[\w.:-]{1,200}$/;

function auditRouter(ledgerPromise, { db = null, logger = null } = {}) {
  const router = express.Router();

  router.get('/patient/:did', async (req, res) => {
    if (!isPatientSelf(req.user, req.params.did) && !hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) {
      return deny(res);
    }
    try {
      const ledger = await ledgerPromise;
      const entries = await ledger.getAuditTrailForPatient(req.params.did);
      res.json(entries || []);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/events/recent', async (req, res) => {
    if (!hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) return deny(res, 'requires role: hospital_admin');
    try {
      const ledger = await ledgerPromise;
      const events = (ledger.getRecentEvents ? await ledger.getRecentEvents(50) : []) || [];
      const own = req.user.superuser || isSystemAdmin(req.user);
      res.json(own ? events : events.filter((e) => !e.hospitalID || e.hospitalID === req.user.hospitalID));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Records a screenshot attempt. Any signed-in user may report their own
  // attempt; the actor is taken from the token, never from the body.
  router.post('/screen-capture', async (req, res) => {
    const { method, confidence = 'confirmed', page = '', patientDID } = req.body || {};
    if (!CAPTURE_METHODS.has(method)) {
      return res.status(400).json({ error: `method must be one of ${[...CAPTURE_METHODS].join(', ')}` });
    }
    if (!CAPTURE_CONFIDENCE.has(confidence)) {
      return res.status(400).json({ error: `confidence must be one of ${[...CAPTURE_CONFIDENCE].join(', ')}` });
    }
    const user = req.user;
    // A patient's attempt is always filed under their own DID; staff report
    // the patient whose record was on screen, if any.
    let subjectDID = '';
    if (user && !user.superuser && user.roles.includes(ROLES.PATIENT)) {
      subjectDID = user.patientDID || '';
    } else if (typeof patientDID === 'string' && DID_PATTERN.test(patientDID)) {
      subjectDID = patientDID;
    }
    const attempt = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      actorID: actorID(user, 'anonymous'),
      role: user && !user.superuser ? user.roles.join(',') : null,
      hospitalID: (user && user.hospitalID) || '',
      patientDID: subjectDID,
      method,
      confidence,
      // Path only: query strings can carry identifiers.
      page: String(page).split('?')[0].slice(0, 200),
      ledgerEntryID: null,
    };

    try {
      const ledger = await ledgerPromise;
      const entry = await ledger.writeAuditEntry({
        entryID: attempt.id,
        patientDID: attempt.patientDID,
        eventType: 'SCREEN_CAPTURE_ATTEMPT',
        actorID: attempt.actorID,
        hospitalID: attempt.hospitalID,
        detail: `method=${method}; confidence=${confidence}; page=${attempt.page}`,
        clientTimestamp: attempt.occurredAt,
        queuedOffline: false,
      });
      attempt.ledgerEntryID = (entry && entry.entryID) || attempt.id;
    } catch (err) {
      // Keep the off-chain record even if the ledger is unreachable.
      if (logger) logger.error('screen capture ledger write failed', { requestId: req.id, err });
    }

    if (db) {
      db.prepare(
        `INSERT INTO screen_capture_attempts
           (id, occurred_at, actor_id, role, hospital_id, patient_did, method, confidence, page, ledger_entry_id)
         VALUES (@id, @occurredAt, @actorID, @role, @hospitalID, @patientDID, @method, @confidence, @page, @ledgerEntryID)`
      ).run(attempt);
    }
    if (logger) {
      logger.warn('screen capture attempt', {
        requestId: req.id,
        actor: attempt.actorID,
        hospitalID: attempt.hospitalID || undefined,
        method,
        confidence,
      });
    }
    res.status(201).json(attempt);
  });

  // Lists recent attempts. Hospital admins see their own hospital's.
  router.get('/screen-captures', (req, res) => {
    if (!hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) return deny(res, 'requires role: hospital_admin');
    if (!db) return res.json([]);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const all = req.user.superuser || isSystemAdmin(req.user);
    const rows = all
      ? db.prepare('SELECT * FROM screen_capture_attempts ORDER BY occurred_at DESC LIMIT ?').all(limit)
      : db
          .prepare('SELECT * FROM screen_capture_attempts WHERE hospital_id = ? ORDER BY occurred_at DESC LIMIT ?')
          .all(req.user.hospitalID || '', limit);
    res.json(
      rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurred_at,
        actorID: r.actor_id,
        role: r.role,
        hospitalID: r.hospital_id,
        patientDID: r.patient_did,
        method: r.method,
        confidence: r.confidence,
        page: r.page,
        ledgerEntryID: r.ledger_entry_id,
      }))
    );
  });

  return router;
}

module.exports = { auditRouter };
