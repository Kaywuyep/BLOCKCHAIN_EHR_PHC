'use strict';

const express = require('express');
const { JUTH_FHIR } = require('./demoData');

/**
 * mockFhirServer.js — a tiny FHIR R4 server standing in for JUTH's EMR in
 * the demo (development only, never mounted in production).
 *
 *   POST /demo-fhir/juth/token          OAuth2 client credentials
 *   GET  /demo-fhir/juth/R4/metadata    CapabilityStatement
 *   GET  /demo-fhir/juth/R4/Patient?identifier=<system>|<MRN>
 *   GET  /demo-fhir/juth/R4/<Type>?patient=<id>
 *
 * It lets the System Admin "Test connection" button and the live FHIR pull
 * in the record gateway be tried end to end without a real hospital.
 */
const TYPES = ['Patient', 'Encounter', 'Observation', 'DiagnosticReport', 'Condition', 'MedicationRequest', 'DocumentReference', 'AllergyIntolerance'];
const TOKEN = 'demo-juth-access-token';

function mockFhirRouter() {
  const router = express.Router();
  const fhir = (res, body, status = 200) => res.status(status).type('application/fhir+json').send(JSON.stringify(body));

  router.post('/juth/token', express.urlencoded({ extended: false }), (req, res) => {
    const basic = Buffer.from(`${JUTH_FHIR.clientId}:${JUTH_FHIR.clientSecret}`).toString('base64');
    if (req.headers.authorization !== `Basic ${basic}`) return res.status(401).json({ error: 'invalid_client' });
    res.json({ access_token: TOKEN, token_type: 'bearer', expires_in: 3600, scope: req.body.scope || '' });
  });

  router.get('/juth/R4/metadata', (req, res) =>
    fhir(res, {
      resourceType: 'CapabilityStatement',
      status: 'active',
      kind: 'instance',
      fhirVersion: '4.0.1',
      software: { name: 'JUTH EMR (Cevruni demo)' },
      format: ['json'],
      rest: [{ mode: 'server', resource: TYPES.map((type) => ({ type })) }],
    })
  );

  router.use('/juth/R4', (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return fhir(res, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'login' }] }, 401);
    next();
  });

  router.get('/juth/R4/Patient', (req, res) => {
    const [system, mrn] = String(req.query.identifier || '').split('|');
    const p = system === JUTH_FHIR.identifierSystem ? JUTH_FHIR.patients[mrn] : null;
    const entry = p
      ? [{ resource: { resourceType: 'Patient', id: p.id, identifier: [{ system, value: mrn }], name: [{ text: p.name }], birthDate: p.birthDate } }]
      : [];
    fhir(res, { resourceType: 'Bundle', type: 'searchset', total: entry.length, entry });
  });

  router.get('/juth/R4/:type', (req, res) => {
    const { type } = req.params;
    if (!TYPES.includes(type)) return fhir(res, { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-supported' }] }, 404);
    const mrn = Object.keys(JUTH_FHIR.patients).find((k) => JUTH_FHIR.patients[k].id === req.query.patient);
    const entry = (JUTH_FHIR.resources[mrn] || [])
      .filter((r) => r.resourceType === type)
      .map((r) => ({ resource: { ...r, subject: { reference: `Patient/${req.query.patient}` } } }));
    fhir(res, { resourceType: 'Bundle', type: 'searchset', total: entry.length, entry });
  });

  return router;
}

module.exports = { mockFhirRouter };
