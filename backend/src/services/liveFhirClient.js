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

function request(url, { method = 'GET', headers = {}, body, fhir, timeoutMs = TIMEOUT_MS }) {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  if (!isHttps && (process.env.NODE_ENV || '').toLowerCase() === 'production') {
    return Promise.reject(new LiveFhirError('refusing plain http to a hospital FHIR server in production'));
  }
  const lib = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      { method, headers, timeout: timeoutMs, ...(isHttps ? tlsOptions(fhir) : {}) },
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
    req.on('timeout', () => req.destroy(new LiveFhirError(`no answer from ${u.host} within ${timeoutMs / 1000}s`)));
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


function humanName(names) {
  const n = (names || []).find((x) => x.use === 'official') || (names || [])[0];
  if (!n) return null;
  if (n.text) return String(n.text).trim();
  return [...(n.prefix || []), ...(n.given || []), n.family].filter(Boolean).join(' ').trim() || null;
}

function conceptText(c) {
  if (!c) return null;
  return c.text || (c.coding || []).map((x) => x.display || x.code).find(Boolean) || null;
}

/**
 * Looks a staff member up in the hospital's EMR by their staff ID:
 * Practitioner?identifier=<staffIdentifierSystem>|<staffID>, then their
 * PractitionerRole(s) for job title, department and whether the role is
 * active. The EMR is the authority: Cevruni copies what it says and never
 * overrides it.
 *
 * Returns { staffID, name, role, department, active, practitionerId }, or
 * throws LiveFhirError (not found, several matches, server error).
 */
async function fetchPractitioner(hospital, staffID) {
  const fhir = hospital.fhir;
  if (!fhir || !fhir.baseUrl) throw new LiveFhirError('this hospital has no FHIR connection to its EMR');
  const base = fhir.baseUrl.replace(/\/+$/, '');
  const token = await accessToken(hospital);
  const identifier = fhir.staffIdentifierSystem ? `${fhir.staffIdentifierSystem}|${staffID}` : String(staffID);
  const search = await getJson(`${base}/Practitioner?identifier=${encodeURIComponent(identifier)}`, hospital, token);
  const matches = (search.entry || []).map((e) => e.resource).filter((r) => r && r.resourceType === 'Practitioner');
  if (matches.length !== 1) {
    throw new LiveFhirError(
      matches.length
        ? `${matches.length} staff records in the EMR have the ID ${staffID}; refusing to guess`
        : `no staff member with the ID ${staffID} in the hospital's EMR`
    );
  }
  const p = matches[0];
  let roles = [];
  try {
    const rb = await getJson(`${base}/PractitionerRole?practitioner=${encodeURIComponent(p.id)}`, hospital, token);
    roles = (rb.entry || [])
      .map((e) => e.resource)
      .filter((r) => r && r.resourceType === 'PractitionerRole')
      .filter((r) => !r.practitioner || !r.practitioner.reference || r.practitioner.reference.endsWith(`Practitioner/${p.id}`));
  } catch {
    // Some EMRs don't expose PractitionerRole; Practitioner alone is enough.
  }
  const now = Date.now();
  const current = (r) =>
    r.active !== false && (!r.period || !r.period.end || new Date(r.period.end).getTime() > now);
  const role = roles.find(current) || null;
  const qualification = (p.qualification || [])[0];
  return {
    staffID: String(staffID),
    practitionerId: p.id,
    name: humanName(p.name),
    role: (role && conceptText((role.code || [])[0])) || conceptText(qualification && qualification.code) || null,
    department: (role && (conceptText((role.specialty || [])[0]) || (role.organization && role.organization.display))) || null,
    email: ((p.telecom || []).find((t) => t.system === 'email' && t.value) || {}).value?.toLowerCase() || null,
    // Inactive in the EMR, or every role there has ended: not active here either.
    active: p.active !== false && (roles.length === 0 || Boolean(role)),
  };
}

/** { hospitalNumber, name, dob } for exactly one Patient with this hospital number, or null. */
async function findPatientDemographics(hospital, hospitalNumber) {
  const fhir = hospital.fhir;
  const base = fhir.baseUrl.replace(/\/+$/, '');
  const token = await accessToken(hospital);
  const search = await getJson(
    `${base}/Patient?identifier=${encodeURIComponent(`${fhir.mrnIdentifierSystem}|${hospitalNumber}`)}`,
    hospital,
    token
  );
  const matches = (search.entry || []).map((e) => e.resource).filter((r) => r && r.resourceType === 'Patient');
  if (matches.length !== 1) return null;
  const name = humanName(matches[0].name);
  return name ? { hospitalNumber: String(hospitalNumber), name, dob: matches[0].birthDate || null } : null;
}

/**
 * Search staff by staff ID or name. A staff ID is looked up exactly
 * (with role and department); otherwise Practitioner?name= is used, and
 * role/department are read when one is picked (fetchPractitioner).
 */
async function searchPractitioners(hospital, query, { limit = 20 } = {}) {
  const q = String(query || '').trim();
  const out = [];
  try {
    out.push(await fetchPractitioner(hospital, q));
  } catch (err) {
    if (!/no staff member/.test(err.message)) throw err;
  }
  if (!/[a-z]{2}/i.test(q)) return out;
  const fhir = hospital.fhir;
  const base = fhir.baseUrl.replace(/\/+$/, '');
  const token = await accessToken(hospital);
  const bundle = await getJson(`${base}/Practitioner?name=${encodeURIComponent(q)}&_count=${limit}`, hospital, token);
  for (const p of (bundle.entry || []).map((e) => e.resource).filter((r) => r && r.resourceType === 'Practitioner')) {
    const ids = p.identifier || [];
    const id = (fhir.staffIdentifierSystem ? ids.find((i) => i.system === fhir.staffIdentifierSystem) : ids[0]) || null;
    const staffID = id && id.value ? String(id.value) : null;
    if (staffID && out.some((o) => o.staffID === staffID)) continue;
    out.push({ staffID, practitionerId: p.id, name: humanName(p.name), role: null, department: null, active: p.active !== false });
  }
  return { results: out.slice(0, limit), total: out.length };
}

module.exports = { searchPractitioners, findPatientDemographics, fetchPractitioner, fetchPatientResources, request, LiveFhirError, _tokenCache: tokenCache };
