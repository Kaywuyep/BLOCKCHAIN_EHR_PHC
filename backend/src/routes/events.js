'use strict';

const express = require('express');
const { ROLES, hasRole, isSystemAdmin } = require('../auth/policy');

/**
 * events.js — event-driven updates (Section 3.4.4).
 *
 *   GET /api/events/stream   (Server-Sent Events)
 *
 * Pushes ledger events (Fabric chaincode events, or the simulator's
 * equivalent) to the browser as they happen, so the apps never poll the
 * ledger for changes. Each user only receives events about them:
 *
 *   patient          events for their own DID (e.g. a new access request)
 *   clinician        events naming them as the provider
 *   hospital admin   events at their hospital
 *   system admin     everything
 */
const HEARTBEAT_MS = 25000;

function flatten(evt) {
  // A batch approval is one ledger event carrying several grants.
  if (Array.isArray(evt.payload)) {
    return evt.payload.map((p) => ({ ...evt, type: evt.type === 'AccessGrantedBatch' ? 'AccessGranted' : evt.type, payload: p, batch: true }));
  }
  return [evt];
}

function visibleTo(user, evt) {
  if (user.superuser || isSystemAdmin(user)) return true;
  const p = evt.payload || {};
  if (hasRole(user, ROLES.PATIENT) && user.patientDID && p.patientDID === user.patientDID) return true;
  if (hasRole(user, ROLES.CLINICIAN) && user.providerID && p.providerID === user.providerID) return true;
  if (hasRole(user, ROLES.CLINICIAN) && user.hospitalID && p.providerID === `hospital-staff@${user.hospitalID}`) return true;
  if (hasRole(user, ROLES.HOSPITAL_ADMIN) && user.hospitalID && (p.hospitalID === user.hospitalID || p.requesterHospitalID === user.hospitalID)) return true;
  return false;
}

function eventsRouter(ledgerPromise) {
  const router = express.Router();

  router.get('/stream', async (req, res) => {
    const ledger = await ledgerPromise;
    if (!ledger.onEvent) return res.status(501).json({ error: 'this ledger does not publish events' });
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(': connected\n\n');

    const send = (evt) => {
      for (const e of flatten(evt)) {
        if (!visibleTo(req.user, e)) continue;
        res.write(`event: ledger\ndata: ${JSON.stringify({ type: e.type, payload: e.payload, timestamp: e.timestamp, batch: e.batch || undefined })}\n\n`);
      }
    };
    const unsubscribe = ledger.onEvent(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}

module.exports = { eventsRouter, visibleTo };
