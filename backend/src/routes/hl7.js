'use strict';

const express = require('express');
const { ingestRawAdtText } = require('../services/hl7AdtListener');
const { ROLES, actsForHospital, hasRole, isSystemAdmin, deny } = require('../auth/policy');

// Exposes the HTTP side of the HL7 v2 ADT ingestion path
// (services/hl7AdtListener.js) -- the one you'll actually use for
// local/synthetic testing (see scripts/sendSyntheticAdt.js), and a
// realistic fallback for any real hospital whose integration engine can
// deliver ADT messages over HTTP instead of raw MLLP. Both transports go
// through the same durable inbox (services/hl7Inbox.js) when one is
// configured: duplicate detection on MSH-10, retry, dead-letter queue.
//
// Callers must be the hospital's interface engine (role hl7_interface,
// typically an OIDC client-credentials token) or one of its admins.
function hl7Router(fhirAdapter, inbox = null) {
  const router = express.Router();

  // Body must arrive as the raw HL7 v2 message text, not JSON -- send it
  // with `Content-Type: text/plain` (or any non-application/json type;
  // express.text({ type: '*/*' }) here accepts anything the server's
  // global express.json() didn't already claim).
  router.post('/adt/:hospitalID', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
    const { hospitalID } = req.params;
    if (!actsForHospital(req.user, hospitalID, ROLES.HL7_INTERFACE, ROLES.HOSPITAL_ADMIN)) {
      return deny(res, 'only this hospital\'s interface engine or admins can submit its HL7 messages');
    }
    if (typeof req.body !== 'string' || !req.body.trim()) {
      return res.status(400).json({ ok: false, reason: 'request body must be the raw HL7 v2 message text' });
    }

    if (!inbox) {
      const result = ingestRawAdtText(fhirAdapter, hospitalID, req.body);
      return res.status(result.ok ? 201 : 400).json(result);
    }

    const outcome = inbox.receive(hospitalID, req.body);
    const body = {
      ok: outcome.ack === 'AA',
      ack: outcome.ack,
      messageID: outcome.id,
      status: outcome.status,
      duplicate: Boolean(outcome.duplicate),
      ...(outcome.result || {}),
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
    body.ok = outcome.ack === 'AA';
    if (outcome.ack === 'AE') return res.status(503).json(body);
    if (outcome.ack === 'AR') return res.status(400).json(body);
    return res.status(outcome.duplicate ? 200 : outcome.status === 'PROCESSED' ? 201 : 202).json(body);
  });

  // Inbox monitoring: message metadata only, never the raw (PHI) text.
  router.get('/messages', (req, res) => {
    if (!inbox) return res.json([]);
    if (!hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) return deny(res, 'requires role: hospital_admin');
    const hospitalID = req.user.superuser || isSystemAdmin(req.user) ? req.query.hospitalID : req.user.hospitalID;
    res.json(inbox.list({ status: req.query.status, hospitalID }));
  });

  router.get('/stats', (req, res) => {
    if (!hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) return deny(res, 'requires role: hospital_admin');
    res.json(inbox ? inbox.stats() : { counts: {}, oldestPendingAgeSeconds: 0 });
  });

  // Reprocess a dead-lettered or rejected message once its cause is fixed
  // (e.g. a fieldMap corrected in config/hospitalIngestion.json).
  router.post('/messages/:id/replay', (req, res) => {
    if (!inbox) return res.status(404).json({ error: 'no HL7 inbox configured' });
    const msg = inbox.get(req.params.id);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    if (!actsForHospital(req.user, msg.hospitalID, ROLES.HOSPITAL_ADMIN)) return deny(res);
    try {
      const outcome = inbox.replay(req.params.id);
      res.json({ ack: outcome.ack, status: outcome.status, reason: outcome.reason || null });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { hl7Router };
