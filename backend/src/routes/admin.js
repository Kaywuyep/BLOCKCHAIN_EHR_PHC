'use strict';

const express = require('express');
const { ROLES, requireRole, actorID } = require('../auth/policy');
const {
  HOSPITAL_TYPES,
  HL7_VERSIONS,
  FHIR_AUTH_TYPES,
  DEFAULT_FHIR_SCOPE,
  slugify,
} = require('../services/hospitalRegistry');
const { DEFAULT_FIELD_MAP, parseHl7Message, mapAdtMessageToResources, resolveFieldMap } = require('../services/hl7AdtListener');
const { getHospitalStatus } = require('../services/hospitalStatus');
const fixtures = require('../services/hl7AdtListener.fixtures');
const { request } = require('../services/liveFhirClient');

/**
 * admin.js — System Admin only.
 *
 *   /api/admin/hospitals   onboard and manage hospitals (FHIR, HL7 ADT, both, manual)
 *   /api/admin/users       every user of the system and their roles
 *
 * Hospital changes take effect immediately: the MLLP listener for a
 * hospital is started, restarted or stopped as soon as it is saved.
 */

const FIRST_MLLP_PORT = 5001;
const TEST_TIMEOUT_MS = 8000;

function sendError(res, err) {
  res.status(err.status || 400).json({ error: err.message });
}

// Uses the same HTTP client (and TLS settings) as the live FHIR pull, so the
// test reflects what will really happen. Node's fetch is avoided: it
// refuses some ports (e.g. 6000) that a hospital server may use.
async function fetchWithTimeout(url, options = {}) {
  const r = await request(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body ? String(options.body) : undefined,
    fhir: options.fhir || {},
  });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json || {} };
}

function describeFetchError(err) {
  if (err.name === 'AbortError' || /no answer/.test(err.message)) return `no answer within ${TEST_TIMEOUT_MS / 1000} seconds`;
  const code = err.code || (err.cause && err.cause.code);
  if (code === 'ENOTFOUND') return 'host name not found (check the URL / DNS)';
  if (code === 'ECONNREFUSED') return 'connection refused (server down or wrong port)';
  if (code && code.startsWith('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return `TLS certificate problem (${code})`;
  }
  return code ? `${err.message} (${code})` : err.message;
}

function adminRouter({ registry, users, listenerManager }) {
  const router = express.Router();
  router.use(requireRole(ROLES.SYSTEM_ADMIN));

  // ── Hospitals ────────────────────────────────────────────────────────

  function withRuntime(h) {
    const runtime = getHospitalStatus(h.hospitalID);
    const staff = users.list().filter((u) => u.hospitalID === h.hospitalID);
    return {
      ...h,
      runtime,
      staffCount: staff.length,
      adminCount: staff.filter((u) => u.roles.includes(ROLES.HOSPITAL_ADMIN)).length,
      hl7HttpEndpoint: h.hl7 && h.hl7.httpEnabled ? `/api/hl7/adt/${h.hospitalID}` : null,
    };
  }

  /** Everything the setup wizard needs to pre-fill and validate its fields. */
  router.get('/hospitals/options', (req, res) => {
    const used = new Set(registry.list().filter((h) => h.hl7 && h.hl7.mllpPort).map((h) => h.hl7.mllpPort));
    let nextPort = FIRST_MLLP_PORT;
    while (used.has(nextPort)) nextPort += 1;
    res.json({
      hospitalTypes: HOSPITAL_TYPES,
      hl7Versions: HL7_VERSIONS,
      fhirAuthTypes: FHIR_AUTH_TYPES,
      defaultFhirScope: DEFAULT_FHIR_SCOPE,
      defaultFieldMap: DEFAULT_FIELD_MAP,
      nextMllpPort: nextPort,
      mllpEnabledOnServer: listenerManager.mllpEnabled,
      sampleAdtMessage: fixtures.adtA01Admit.replace(/\r/g, '\n'),
      suggestedID: req.query.name ? slugify(req.query.name) : undefined,
    });
  });

  router.get('/hospitals', (req, res) => {
    res.json(registry.list().map(withRuntime));
  });

  router.get('/hospitals/:hospitalID', (req, res) => {
    const h = registry.get(req.params.hospitalID);
    if (!h) return res.status(404).json({ error: 'hospital not found' });
    res.json(withRuntime(h));
  });

  // Creates a hospital and, optionally, its first hospital admin account,
  // in one step.
  router.post('/hospitals', async (req, res) => {
    const body = req.body || {};
    const createdBy = actorID(req.user, 'system-admin');
    try {
      if (body.adminUser && body.adminUser.subject) {
        // Validate the admin account before creating anything.
        const taken = users.get(String(body.adminUser.subject).trim());
        if (taken) return res.status(409).json({ error: `a user with ID "${body.adminUser.subject}" already exists` });
      }
      const hospital = registry.create(body, { createdBy });
      let adminUser = null;
      if (body.adminUser && body.adminUser.subject) {
        try {
          adminUser = users.create(
            { ...body.adminUser, roles: [ROLES.HOSPITAL_ADMIN], hospitalID: hospital.hospitalID },
            { createdBy }
          );
        } catch (err) {
          return res.status(201).json({ ...withRuntime(hospital), adminUserError: err.message });
        }
      }
      await listenerManager.sync(hospital.hospitalID);
      res.status(201).json({ ...withRuntime(registry.get(hospital.hospitalID)), adminUser });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/hospitals/:hospitalID', async (req, res) => {
    try {
      const { hospitalID: _ignored, ...input } = req.body || {};
      const hospital = registry.update(req.params.hospitalID, input);
      if (!hospital) return res.status(404).json({ error: 'hospital not found' });
      await listenerManager.sync(hospital.hospitalID);
      res.json(withRuntime(registry.get(hospital.hospitalID)));
    } catch (err) {
      sendError(res, err);
    }
  });

  // Deactivate / reactivate. Hospitals are never deleted: patients' links
  // and the audit trail refer to their IDs.
  router.post('/hospitals/:hospitalID/status', async (req, res) => {
    try {
      const hospital = registry.setStatus(req.params.hospitalID, (req.body || {}).status);
      if (!hospital) return res.status(404).json({ error: 'hospital not found' });
      await listenerManager.sync(hospital.hospitalID);
      res.json(withRuntime(registry.get(hospital.hospitalID)));
    } catch (err) {
      sendError(res, err);
    }
  });

  /**
   * Checks a FHIR server before (or after) saving: reads its
   * CapabilityStatement and, when credentials are given, asks the token
   * endpoint for an access token. A blank secret with a hospitalID uses
   * the stored one.
   */
  router.post('/hospitals/test-fhir', async (req, res) => {
    const { baseUrl, authType = 'client-secret', tokenUrl, clientId, scope, hospitalID } = req.body || {};
    let { clientSecret } = req.body || {};
    const steps = [];
    let base;
    try {
      base = new URL(String(baseUrl || '').trim().replace(/\/+$/, ''));
      if (!['http:', 'https:'].includes(base.protocol)) throw new Error('bad protocol');
    } catch {
      return res.status(400).json({ ok: false, steps: [{ step: 'FHIR base URL', ok: false, detail: 'not a valid http(s) URL' }] });
    }

    try {
      const r = await fetchWithTimeout(`${base.href.replace(/\/$/, '')}/metadata`, { headers: { accept: 'application/fhir+json' } });
      if (!r.ok) {
        steps.push({ step: 'Server capability statement', ok: false, detail: `HTTP ${r.status} from /metadata` });
      } else {
        const cap = await r.json().catch(() => null);
        if (!cap || cap.resourceType !== 'CapabilityStatement') {
          steps.push({ step: 'Server capability statement', ok: false, detail: '/metadata did not return a FHIR CapabilityStatement' });
        } else {
          const types = new Set(((cap.rest || [])[0] || { resource: [] }).resource.map((x) => x.type));
          const needed = ['Patient', 'Observation', 'Encounter', 'MedicationRequest', 'Condition'];
          const missing = needed.filter((t) => !types.has(t));
          steps.push({
            step: 'Server capability statement',
            ok: true,
            detail: `FHIR ${cap.fhirVersion || '?'}${cap.software && cap.software.name ? ` · ${cap.software.name}` : ''}`,
          });
          steps.push({
            step: 'Resource types Cevruni reads',
            ok: missing.length === 0,
            detail: missing.length ? `not supported: ${missing.join(', ')}` : needed.join(', '),
          });
          if (cap.fhirVersion && !String(cap.fhirVersion).startsWith('4.')) {
            steps.push({ step: 'FHIR version', ok: false, detail: `Cevruni expects FHIR R4 (4.x), server reports ${cap.fhirVersion}` });
          }
        }
      }
    } catch (err) {
      steps.push({ step: 'Server capability statement', ok: false, detail: describeFetchError(err) });
    }

    if (authType === 'client-secret') {
      if (!clientSecret && hospitalID) {
        const stored = registry.getInternal(hospitalID);
        clientSecret = stored && stored._fhirSecret;
      }
      if (!tokenUrl || !clientId || !clientSecret) {
        steps.push({ step: 'OAuth2 token', ok: false, detail: 'token URL, client ID and client secret are needed to test sign-in' });
      } else {
        try {
          const r = await fetchWithTimeout(tokenUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            },
            body: new URLSearchParams({ grant_type: 'client_credentials', scope: scope || DEFAULT_FHIR_SCOPE }),
          });
          const body = await r.json().catch(() => ({}));
          steps.push(
            r.ok && body.access_token
              ? { step: 'OAuth2 token', ok: true, detail: `token issued${body.expires_in ? `, valid ${body.expires_in}s` : ''}` }
              : { step: 'OAuth2 token', ok: false, detail: `HTTP ${r.status}${body.error ? `: ${body.error}` : ''}${body.error_description ? ` (${body.error_description})` : ''}` }
          );
        } catch (err) {
          steps.push({ step: 'OAuth2 token', ok: false, detail: describeFetchError(err) });
        }
      }
    } else if (authType === 'private-key-jwt') {
      steps.push({ step: 'OAuth2 token', ok: true, detail: 'private-key JWT sign-in is checked when the live FHIR adapter connects' });
    }

    res.json({ ok: steps.every((s) => s.ok), steps });
  });

  /**
   * Dry run of an ADT message against a field mapping: shows what Cevruni
   * would extract, without storing anything. Lets the admin check a
   * hospital's feed layout before going live.
   */
  router.post('/hospitals/test-hl7', (req, res) => {
    const { message, fieldMap = {} } = req.body || {};
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ ok: false, error: 'paste an HL7 v2 ADT message to test' });
    }
    const cleanMap = {};
    for (const [k, v] of Object.entries(fieldMap || {})) if (v) cleanMap[k] = String(v).trim();
    let resolved;
    try {
      resolved = resolveFieldMap(cleanMap);
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    const warnings = [];
    const log = { log() {}, warn: (m) => warnings.push(String(m).replace(/^\[hl7AdtListener\]\s*/, '')), error() {} };
    let parsed;
    try {
      parsed = parseHl7Message(message.replace(/\r?\n/g, '\r').trim());
    } catch (err) {
      return res.json({ ok: false, error: `not a valid HL7 v2 message: ${err.message}` });
    }
    let mapped;
    try {
      mapped = mapAdtMessageToResources(parsed, { log, fieldMap: cleanMap });
    } catch (err) {
      return res.json({ ok: false, error: err.message, warnings });
    }
    if (!mapped) return res.json({ ok: false, error: warnings[0] || 'message could not be mapped', warnings });
    const enc = mapped.encounterResource;
    res.json({
      ok: true,
      warnings,
      fieldMap: resolved,
      extracted: {
        messageType: `ADT^${mapped.triggerEvent}`,
        controlId: mapped.controlId,
        hospitalNumber: mapped.hospitalNumber,
        patientName: mapped.patient.name,
        dateOfBirth: mapped.patient.dob,
        sex: mapped.patient.sex,
        encounter: enc
          ? {
              class: enc.class && (enc.class.display || enc.class.code),
              status: enc.status,
              location: (enc.location || []).map((l) => l.location && l.location.display).filter(Boolean).join(', ') || null,
              attending: (enc.participant || []).map((p) => p.individual && p.individual.display).filter(Boolean).join(', ') || null,
              start: enc.period && enc.period.start,
              end: enc.period && enc.period.end,
            }
          : null,
      },
    });
  });

  // ── Users ────────────────────────────────────────────────────────────

  router.get('/users', (req, res) => {
    const names = new Map(registry.list().map((h) => [h.hospitalID, h.name]));
    res.json(users.list().map((u) => ({ ...u, hospitalName: u.hospitalID ? names.get(u.hospitalID) || null : null })));
  });

  router.post('/users', (req, res) => {
    try {
      const body = req.body || {};
      if (body.hospitalID && !registry.get(body.hospitalID)) {
        return res.status(400).json({ error: `unknown hospital "${body.hospitalID}"` });
      }
      res.status(201).json(users.create(body, { createdBy: actorID(req.user, 'system-admin') }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/users/:subject', (req, res) => {
    try {
      const body = req.body || {};
      if (body.hospitalID && !registry.get(body.hospitalID)) {
        return res.status(400).json({ error: `unknown hospital "${body.hospitalID}"` });
      }
      const user = users.update(req.params.subject, body);
      if (!user) return res.status(404).json({ error: 'user not found (users known only from the registry must be enabled/disabled first)' });
      res.json(user);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/users/:subject/status', (req, res) => {
    try {
      const status = (req.body || {}).status;
      if (status === 'disabled' && req.user && !req.user.superuser && req.user.sub === req.params.subject) {
        return res.status(400).json({ error: 'you cannot disable your own account' });
      }
      const user = users.setStatus(req.params.subject, status);
      if (!user) return res.status(404).json({ error: 'user not found' });
      res.json(user);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

module.exports = { adminRouter };
