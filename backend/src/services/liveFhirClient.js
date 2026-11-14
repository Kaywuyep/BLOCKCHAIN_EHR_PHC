'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');

/**
 * liveFhirClient.js
 *
 * Pulls a patient's records live from a hospital's own FHIR R4 server, for
 * hospitals set up with the "FHIR API" (or "both") connection in the
 * System Admin UI. Called by the record gateway (routes/records.js) only
 * after the on-chain grant check has passed; nothing fetched here is ever
 * stored by Cevruni or written to the ledger.
 *
 *   1. Sign in: OAuth2 client-credentials (SMART backend services style),
 *      token cached until shortly before it expires.
 *   2. Find the patient: Patient?identifier=<mrnIdentifierSystem>|<MRN>.
 *      Exactly one match is required; zero or several is an error, never a
 *      guess (a wrong match would leak another patient's records).
 *   3. Fetch only the resource types the grant allows:
 *      <Type>?patient=<id>&_count=100, following "next" links.
 *
 * Transport (Section 2.3.5 / Table 3.8): HTTPS with TLS 1.3 by default
 * (FHIR_TLS_MIN_VERSION=TLSv1.2 for servers that cannot do 1.3), and
 * mutual TLS when the hospital's settings name a client certificate and
 * key (clientCertPath / clientKeyPath, plus caPath for a private CA).
 * Plain http:// is accepted only outside production, for test servers.
 */

const TIMEOUT_MS = 15000;
const MAX_PAGES = 10;
const tokenCache = new Map(); // hospitalID -> { token, expiresAt }

class LiveFhirError extends Error {}

function tlsOptions(fhir) {
  const opts = { minVersion: process.env.FHIR_TLS_MIN_VERSION || 'TLSv1.3' };
  if (fhir.clientCertPath && fhir.clientKeyPath) {
    opts.cert = fs.readFileSync(fhir.clientCertPath);
    opts.key = fs.readFileSync(fhir.clientKeyPath);
  }
  if (fhir.caPath) opts.ca = fs.readFileSync(fhir.caPath);
  return opts;
}

function request(url, { method = 'GET', headers = {}, body, fhir }) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  if (!isHttps && (process.env.NODE_ENV || '').toLowerCase() === 'production') {
    return Promise.reject(new LiveFhirError('refusing plain http to a hospital FHIR server in production'));
  }
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method, headers, timeout: TIMEOUT_MS, ...(isHttps ? tlsOptions(fhir) : {}) },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new LiveFhirError(`no answer from ${u.host} within ${TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function accessToken(hospital) {
  const fhir = hospital.fhir;
  if (fhir.authType === 'none') return null;
  const cached = tokenCache.get(hospital.hospitalID);
  if (cached && cached.expiresAt > Date.now() + 30000) return cached.token;
  if (fhir.authType !== 'client-secret') {
    throw new LiveFhirError('private-key JWT sign-in is not configured on this server yet; use a client secret or mutual TLS');
  }
  const secret = hospital._fhirSecret;
  if (!secret) throw new LiveFhirError('no FHIR client secret is stored for this hospital');
  const res = await request(fhir.tokenUrl, {
    method: 'POST',
    fhir,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${fhir.clientId}:${secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: fhir.scope || '' }).toString(),
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    throw new LiveFhirError(`token request failed (HTTP ${res.status})`);
  }
  const ttl = Number(res.json.expires_in) || 300;
  tokenCache.set(hospital.hospitalID, { token: res.json.access_token, expiresAt: Date.now() + ttl * 1000 });
  return res.json.access_token;
}

async function getJson(url, hospital, token) {
  const res = await request(url, {
    fhir: hospital.fhir,
    headers: { accept: 'application/fhir+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401 && token) tokenCache.delete(hospital.hospitalID);
  if (res.status !== 200 || !res.json) throw new LiveFhirError(`FHIR server answered HTTP ${res.status} for ${new URL(url).pathname}`);
  return res.json;
}

/**
 * Returns the patient's resources of the given types from the hospital's
 * FHIR server, as an array of FHIR resources.
 */
async function fetchPatientResources(hospital, hospitalNumber, resourceTypes) {
  const fhir = hospital.fhir;
  const base = fhir.baseUrl.replace(/\/+$/, '');
  const token = await accessToken(hospital);

  const search = await getJson(
    `${base}/Patient?identifier=${encodeURIComponent(`${fhir.mrnIdentifierSystem}|${hospitalNumber}`)}`,
    hospital,
    token
  );
  const matches = (search.entry || []).map((e) => e.resource).filter((r) => r && r.resourceType === 'Patient');
  if (matches.length !== 1) {
    throw new LiveFhirError(
      matches.length ? 'more than one patient matched this hospital number; refusing to guess' : 'no patient with this hospital number on the hospital FHIR server'
    );
  }
  const patient = matches[0];
  const out = [patient];

  for (const type of resourceTypes) {
    let url = `${base}/${type}?patient=${encodeURIComponent(patient.id)}&_count=100`;
    for (let page = 0; url && page < MAX_PAGES; page += 1) {
      const bundle = await getJson(url, hospital, token);
      for (const e of bundle.entry || []) {
        // Only the requested type, and only this patient's (defence in
        // depth against a server that ignores the patient filter).
        const r = e.resource;
        const ref = r && (r.subject || r.patient);
        if (r && r.resourceType === type && (!ref || ref.reference === `Patient/${patient.id}` || ref.reference?.endsWith(`/Patient/${patient.id}`))) {
          out.push(r);
        }
      }
      const next = (bundle.link || []).find((l) => l.relation === 'next');
      url = next && next.url && next.url.startsWith(base) ? next.url : null;
    }
  }
  return out;
}

module.exports = { fetchPatientResources, request, LiveFhirError, _tokenCache: tokenCache };
