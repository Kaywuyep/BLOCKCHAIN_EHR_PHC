'use strict';

/**
 * customApiClient.js
 *
 * Reads from a hospital's own, custom-built EMR API (integration "rest",
 * optional `customApi` settings). Everything about the API is set by the
 * system admin in the hospital setup wizard, because every custom system
 * differs:
 *
 *   sign-in   POST <baseUrl><loginPath> with a JSON body template, e.g.
 *             {"username":"{username}","password":"{password}"}
 *   token     read from the answer at `tokenPath` (blank = detected:
 *             token, access_token, data.token, data when it is a string…)
 *   calls     GET <baseUrl><path> with the token sent as
 *             "Authorization: Bearer <token>" (bearer), a named header
 *             (header), or ?<name>=<token> (query)
 *   lookups   patientSearchPath with {hospitalNumber}; staffSearchPath
 *             with {query} (what the admin types) or {staffID}
 *
 * Where values sit in the answers (hospital number, name, staff ID…) is a
 * field map; blank entries are detected automatically and "Test
 * connection" shows the fields found so the map can be corrected.
 *
 * Exact matches only: a hospital number or staff ID must match exactly one
 * record, never a guess. Push ingest (POST /api/ingest/:hospitalID) still
 * works for the same hospital; this client only adds reading.
 */

const emrRecords = require('./emrRecords');

const CUSTOM_API_TIMEOUT_MS = 45 * 1000;
const TOKEN_TTL_MS = 20 * 60 * 1000;
const tokens = new Map(); // hospitalID -> { token, at }

class CustomApiError extends Error {}

// ── Reading values out of unknown JSON ──────────────────────────────────

function at(obj, path) {
  if (!path) return undefined;
  return String(path)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const EMPTY_WORDS = /^(none|null|undefined|n\/?a|nil|-+|\.)$/i;

/** A readable string for a value that may be an object ({ name }), array or primitive. */
function text(v) {
  if (v == null) return undefined;
  if (typeof v === 'string') return EMPTY_WORDS.test(v.trim()) || !v.trim() ? undefined : v.trim();
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ') || undefined;
  if (typeof v === 'object') return text(v.name ?? v.title ?? v.label ?? v.description);
  return String(v);
}

/** "a + b" joins several fields with spaces (e.g. first + last name). */
function read(obj, spec) {
  if (!spec) return undefined;
  const parts = String(spec).split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) return at(obj, parts[0]);
  const values = parts.map((p) => text(at(obj, p))).filter(Boolean);
  return values.length ? values.join(' ') : undefined;
}

/** Every leaf path in a record, up to 3 levels, for the UI's "fields found" list. */
function leafPaths(obj, prefix = '', depth = 0, out = []) {
  if (obj == null || typeof obj !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leafPaths(v, p, depth + 1, out);
    else out.push(p);
  }
  return out;
}

const LIST_KEYS = ['data', 'result', 'results', 'docs', 'rows', 'items', 'records', 'patients', 'staffs', 'staff', 'users'];

/** The list of records in an answer: at `explicitPath`, the answer itself, or the first array of objects inside it. */
function findList(json, explicitPath) {
  if (explicitPath) {
    const v = at(json, explicitPath);
    if (Array.isArray(v)) return { list: v.filter((x) => x && typeof x === 'object'), path: explicitPath };
    if (v && typeof v === 'object') return { list: [v], path: explicitPath };
    return { list: [], path: explicitPath };
  }
  if (Array.isArray(json)) return { list: json.filter((x) => x && typeof x === 'object'), path: '' };
  let queue = [{ v: json, p: '' }];
  let empty = null;
  for (let depth = 0; depth < 4 && queue.length; depth += 1) {
    const next = [];
    for (const { v, p } of queue) {
      if (!v || typeof v !== 'object') continue;
      const keys = Object.keys(v).sort((a, b) => (LIST_KEYS.includes(b) ? 1 : 0) - (LIST_KEYS.includes(a) ? 1 : 0));
      for (const k of keys) {
        const child = v[k];
        const cp = p ? `${p}.${k}` : k;
        if (Array.isArray(child) && child.some((x) => x && typeof x === 'object')) {
          return { list: child.filter((x) => x && typeof x === 'object'), path: cp };
        }
        if (Array.isArray(child) && !child.length && !empty) empty = { list: [], path: cp };
        if (child && typeof child === 'object' && !Array.isArray(child)) next.push({ v: child, p: cp });
      }
    }
    queue = next;
  }
  return empty || { list: [], path: '' };
}

const GUESS = {
  hospitalNumber: [/^hospital_?(no|number|num|id)$/i, /^folder_?(no|number)$/i, /^(mrn|card_?(no|number)|file_?(no|number)|reg_?(no|number)|registration_?(no|number)|patient_?(no|number|id))$/i, /hosp.*(no|num)/i],
  fullName: [/^(full_?name|name|patient_?name|fullname|display_?name)$/i],
  first: [/^(f(irst)?_?name|fname|given_?name|firstname|forename)$/i],
  middle: [/^(m(iddle)?_?name|mname|other_?names?|middlename)$/i],
  last: [/^(l(ast)?_?name|lname|surname|family_?name|lastname)$/i],
  dob: [/^(dob|date_?of_?birth|birth_?date|birthday|dateofbirth)$/i],
  staffId: [/^staff_?(id|no|number|num)$/i, /^(employee|personnel|emp)_?(id|no|number)$/i, /^(staffid|staffno|file_?no)$/i, /^(_id|id|uuid)$/i],
  email: [/^(email|e_?mail|email_?address|mail)$/i],
  role: [/^(role|designation|cadre|position|job_?title|title|rank|user_?type)$/i],
  department: [/^(dept|department|department_?name)$/i, /^(specialization|specialty|speciality)$/i, /^(clinic|unit)$/i],
  active: [/^(active|is_?active|enabled|account_?status|employment_?status|status)$/i],
};
const REFERENCE_ID = /^[0-9a-f]{24}$/i;
const DUTY_WORDS = /^(available|unavailable|online|offline|busy|away|on[ _-]?duty|off[ _-]?duty|on[ _-]?leave)$/i;

function guessKey(record, patterns, { readable = false } = {}) {
  const paths = [...new Set(Object.keys(record || {}).concat(leafPaths(record)))];
  for (const re of patterns) {
    const hit = paths.find((p) => {
      if (!re.test(p.split('.').pop())) return false;
      if (!readable) return true;
      const v = text(at(record, p));
      return Boolean(v) && !REFERENCE_ID.test(v);
    });
    if (hit) return hit;
  }
  return '';
}

function nameSpec(record) {
  const full = guessKey(record, GUESS.fullName);
  if (full && !full.includes('.') && typeof at(record, full) !== 'object') return full;
  return [guessKey(record, GUESS.first), guessKey(record, GUESS.middle), guessKey(record, GUESS.last)].filter(Boolean).join(' + ');
}

/** Suggested field map for a sample patient and/or staff record. */
function suggestFieldMap({ patient, staff, patientListPath, staffListPath } = {}) {
  const s = {};
  if (patient) {
    s.patientList = patientListPath || '';
    s.patientId = ['id', '_id', 'patient_id', 'uuid'].find((k) => patient[k] != null && patient[k] !== '') || '';
    s.patientHospitalNumber = guessKey(patient, GUESS.hospitalNumber);
    s.patientName = nameSpec(patient);
    s.patientDob = guessKey(patient, GUESS.dob);
  }
  if (staff) {
    s.staffList = staffListPath || '';
    s.staffId = guessKey(staff, GUESS.staffId);
    s.staffEmail = guessKey(staff, GUESS.email);
    s.staffName = nameSpec(staff);
    s.staffRole = guessKey(staff, GUESS.role, { readable: true });
    s.staffDepartment = guessKey(staff, GUESS.department, { readable: true });
    s.staffActive = guessKey(staff, GUESS.active);
    if (s.staffActive && DUTY_WORDS.test(String(at(staff, s.staffActive) ?? '').trim())) s.staffActive = '';
  }
  return s;
}

function isActive(v) {
  if (v === undefined || v === null || v === '') return true;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return !/^(false|0|no|inactive|disabled|suspended|deactivated|blocked|terminated|retired|left|deleted)$/i.test(String(v).trim());
}

function validEmail(v) {
  const s = v == null ? '' : String(v).trim().toLowerCase();
  return /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s) ? s : null;
}

function sameId(a, b) {
  return a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function isoDate(v) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ── HTTP ────────────────────────────────────────────────────────────────

function settings(hospital) {
  const c = hospital && hospital.customApi;
  if (!c || !c.baseUrl) throw new CustomApiError('this hospital has no API connection set up');
  const { CUSTOM_API_DEFAULTS } = require('./hospitalRegistry');
  return { ...CUSTOM_API_DEFAULTS, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== '' && v != null)), fieldMap: c.fieldMap || {} };
}

function cacheKey(hospital, c) {
  return hospital.hospitalID || c.baseUrl;
}

/** {hospitalNumber}, {query}… in a path template, URL-encoded. */
function urlFor(c, template, vars = {}, token) {
  const path = String(template || '').replace(/^\/+/, '').replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
  const u = new URL(path, c.baseUrl.endsWith('/') ? c.baseUrl : `${c.baseUrl}/`);
  if (token && c.tokenIn === 'query') u.searchParams.set(c.tokenName || 'token', token);
  return u.toString();
}

function authHeaders(c, token) {
  if (!token) return {};
  if (c.tokenIn === 'bearer') return { authorization: `Bearer ${token}` };
  if (c.tokenIn === 'header') return { [String(c.tokenName || 'x-access-token').toLowerCase()]: token };
  return {};
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(CUSTOM_API_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (err) {
    const code = err.code || (err.cause && err.cause.code);
    if (err.name === 'TimeoutError') throw new CustomApiError(`no answer from ${hostOf(url)} within ${CUSTOM_API_TIMEOUT_MS / 1000}s`);
    if (code === 'ECONNREFUSED') throw new CustomApiError(`connection refused by ${hostOf(url)} (server down or wrong port)`);
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') {
      throw new CustomApiError(`cannot reach ${hostOf(url)}: is this computer on the hospital network?`);
    }
    if (code === 'ENOTFOUND') throw new CustomApiError(`unknown host ${hostOf(url)}`);
    throw new CustomApiError(err.message);
  }
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function apiMessage(j) {
  if (!j || typeof j !== 'object') return '';
  const m = j.message || j.error_description || j.msg || (typeof j.error === 'string' ? j.error : '');
  return m ? String(m).slice(0, 200) : '';
}

function looksLikeError(res) {
  const j = res.json;
  return res.status >= 400 || (j && typeof j === 'object' && (j.error === true || j.success === false || /^(error|fail(ed|ure)?)$/i.test(String(j.status || ''))));
}

/** Replaces "{username}" / "{password}" in the string values of the body template (no JSON string building). */
function fillTemplate(node, vars) {
  if (typeof node === 'string') return node.replace(/\{(username|password)\}/g, (_, k) => vars[k]);
  if (Array.isArray(node)) return node.map((x) => fillTemplate(x, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillTemplate(v, vars)]));
  return node;
}

const TOKEN_PATHS = ['token', 'access_token', 'accessToken', 'jwt', 'data.token', 'data.access_token', 'data.accessToken', 'data.jwt', 'result.token', 'data'];

function findToken(json, tokenPath) {
  if (tokenPath) {
    const v = at(json, tokenPath);
    return typeof v === 'string' && v ? v : null;
  }
  for (const p of TOKEN_PATHS) {
    const v = at(json, p);
    if (typeof v === 'string' && v.length >= 8) return v;
  }
  return null;
}

// Sign-ins are never run in parallel (some systems allow one session per
// account), and a request whose session was replaced uses the new one.
const signingIn = new Map();

async function login(hospital, { fresh = false, replacing = null } = {}) {
  const c = settings(hospital);
  const key = cacheKey(hospital, c);
  const cached = tokens.get(key);
  if (!fresh && cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;
  if (fresh && replacing && cached && cached.token !== replacing) return cached.token;
  if (signingIn.has(key)) return signingIn.get(key);
  const p = signInOnce(hospital, c, key).finally(() => signingIn.delete(key));
  signingIn.set(key, p);
  return p;
}

async function signInOnce(hospital, c, key) {
  const password = hospital._emrSecret || c.password;
  if (!password) throw new CustomApiError('no API password is stored for this hospital');
  let template;
  try {
    template = JSON.parse(c.loginBody);
  } catch {
    throw new CustomApiError('the sign-in body is not valid JSON');
  }
  const res = await call(urlFor(c, c.loginPath), { method: 'POST', body: fillTemplate(template, { username: c.username, password }) });
  if (looksLikeError(res)) {
    const m = apiMessage(res.json);
    throw new CustomApiError(`the hospital's API refused the sign-in (HTTP ${res.status}${m ? `: ${m}` : ''})`);
  }
  const token = findToken(res.json, c.tokenPath);
  if (!token) {
    throw new CustomApiError(`signed in, but no token was found${c.tokenPath ? ` at "${c.tokenPath}"` : ''} in the answer (fields: ${leafPaths(res.json || {}).slice(0, 12).join(', ') || 'none'}): set "Token in answer"`);
  }
  tokens.set(key, { token, at: Date.now() });
  return token;
}

/** GET with the session token; signs in again once if the token was rejected. */
async function get(hospital, template, vars) {
  const c = settings(hospital);
  const label = String(template).split('?')[0];
  let used = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await login(hospital, { fresh: attempt > 0, replacing: used });
    used = token;
    const res = await call(urlFor(c, template, vars, token), { headers: authHeaders(c, token) });
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    if (looksLikeError(res)) {
      const m = apiMessage(res.json);
      throw new CustomApiError(`the hospital's API answered HTTP ${res.status}${m ? `: ${m}` : ''} for ${label}`);
    }
    if (res.json == null) throw new CustomApiError(`the hospital's API did not answer with JSON for ${label}`);
    return res.json;
  }
  throw new CustomApiError('the API session could not be renewed');
}

// ── Lookups ─────────────────────────────────────────────────────────────

async function patientCandidates(hospital, hospitalNumber) {
  const c = settings(hospital);
  if (!c.patientSearchPath) throw new CustomApiError('no patient search path is set');
  const json = await get(hospital, c.patientSearchPath, { hospitalNumber });
  const { list, path } = findList(json, c.fieldMap.patientList);
  const fm = { ...suggestFieldMap({ patient: list[0], patientListPath: path }), ...c.fieldMap };
  return { json, list, path, fm };
}

/** The one raw patient record whose hospital number matches exactly, or null. */
async function findPatientRecord(hospital, hospitalNumber) {
  const { list, fm } = await patientCandidates(hospital, hospitalNumber);
  if (!fm.patientHospitalNumber) return null;
  const matches = list.filter((r) => sameId(read(r, fm.patientHospitalNumber), hospitalNumber));
  return matches.length === 1 ? { record: matches[0], fm } : null;
}

/** { hospitalNumber, name, dob } for exactly one matching patient, or null. */
async function findPatient(hospital, hospitalNumber) {
  const hit = await findPatientRecord(hospital, hospitalNumber);
  if (!hit) return null;
  const { record: r, fm } = hit;
  const name = text(read(r, fm.patientName));
  if (!name) return null;
  return { hospitalNumber: String(read(r, fm.patientHospitalNumber)).trim(), name, dob: isoDate(read(r, fm.patientDob)) };
}

async function staffList(hospital, term) {
  const c = settings(hospital);
  if (!c.staffSearchPath) throw new CustomApiError('no staff search path is set');
  const json = await get(hospital, c.staffSearchPath, { query: term, staffID: term });
  const { list, path } = findList(json, c.fieldMap.staffList);
  const fm = { ...suggestFieldMap({ staff: list[0], staffListPath: path }), ...c.fieldMap };
  if (list.length && !fm.staffId) throw new CustomApiError('could not tell which field holds the staff ID: set it under Field mapping');
  return { json, list, path, fm };
}

function staffRecord(r, fm) {
  const id = read(r, fm.staffId);
  return {
    staffID: id == null || id === '' ? null : String(id).trim(),
    practitionerId: String(r._id || r.id || id || ''),
    email: validEmail(read(r, fm.staffEmail)),
    name: text(read(r, fm.staffName)) || null,
    role: text(read(r, fm.staffRole)) || null,
    department: text(read(r, fm.staffDepartment)) || null,
    active: isActive(read(r, fm.staffActive)),
  };
}

/** One staff member by exact ID; searches with the ID, then with hints (email, name). */
async function fetchStaff(hospital, staffID, { hints = [] } = {}) {
  for (const term of [staffID, ...hints.filter(Boolean)]) {
    const { list, fm } = await staffList(hospital, term);
    const m = list.filter((r) => sameId(read(r, fm.staffId), staffID));
    if (m.length > 1) throw new CustomApiError(`${m.length} staff records have the ID ${staffID}; refusing to guess`);
    if (m.length === 1) return { ...staffRecord(m[0], fm), staffID: String(staffID) };
  }
  throw new CustomApiError(`no staff member with the ID ${staffID} in the hospital's EMR`);
}

/** Search by name, email or staff ID, best matches first. Returns { results, total }. */
async function searchStaff(hospital, query, { limit = 50 } = {}) {
  const q = String(query || '').trim();
  const ql = q.toLowerCase();
  const words = ql.split(/\s+/).filter(Boolean);
  const { list, fm } = await staffList(hospital, q);
  const scored = list.map((r) => {
    const rec = staffRecord(r, fm);
    const id = (rec.staffID || '').toLowerCase();
    const email = (rec.email || '').toLowerCase();
    const name = (rec.name || '').toLowerCase();
    let score = 1; // the API matched it on some field
    if ((id && id === ql) || (email && email === ql)) score = 4;
    else if ((id && id.includes(ql)) || (email && email.includes(ql))) score = 3;
    else if (words.length && words.every((w) => name.includes(w))) score = 2;
    return { score, rec };
  });
  scored.sort((a, b) => b.score - a.score || String(a.rec.name).localeCompare(String(b.rec.name)));
  return { results: scored.slice(0, limit).map((x) => x.rec), total: list.length };
}

/**
 * "Test connection" in the hospital setup wizard: sign in, then (if given)
 * look up one hospital number and one staff search. Returns each step, a
 * suggested field map and a sample record so the admin can correct the map.
 */
async function testConnection(hospital, { hospitalNumber, staffID } = {}) {
  const steps = [];
  const out = { ok: false, steps, suggested: {}, samples: {} };
  let c;
  try {
    c = settings(hospital);
    tokens.delete(cacheKey(hospital, c));
    await login(hospital, { fresh: true });
    steps.push({ step: 'Sign in', ok: true, detail: `signed in as ${c.username}` });
  } catch (err) {
    steps.push({ step: 'Sign in', ok: false, detail: err.message });
    return out;
  }

  if (hospitalNumber) {
    try {
      const { json, list, path } = await patientCandidates(hospital, hospitalNumber);
      Object.assign(out.suggested, suggestFieldMap({ patient: list[0], patientListPath: path }));
      out.samples.patient = { listPath: path, count: list.length, fields: list[0] ? leafPaths(list[0]) : [], record: list[0] || null, raw: list.length ? undefined : json };
      const found = await findPatient(hospital, hospitalNumber);
      steps.push(
        found
          ? { step: 'Patient by hospital number', ok: true, detail: `${found.name}${found.dob ? `, born ${found.dob}` : ', no date of birth'}`, value: found }
          : { step: 'Patient by hospital number', ok: false, detail: list.length ? `${list.length} record(s) came back but none matched ${hospitalNumber} exactly: check the field mapping` : 'no records came back: check the hospital number or the patient search path' }
      );
    } catch (err) {
      steps.push({ step: 'Patient by hospital number', ok: false, detail: err.message });
    }
  }

  if (staffID) {
    try {
      const { json, list, path, fm } = await staffList(hospital, staffID);
      Object.assign(out.suggested, suggestFieldMap({ staff: list[0], staffListPath: path }));
      out.samples.staff = { listPath: path, count: list.length, fields: list[0] ? leafPaths(list[0]) : [], record: list[0] || null, raw: list.length ? undefined : json };
      const hit = list.filter((r) => sameId(read(r, fm.staffId), staffID));
      if (hit.length === 1) {
        const s = staffRecord(hit[0], fm);
        steps.push({ step: 'Staff search', ok: true, detail: `${s.name || '(no name)'} · ${s.role || 'no role'} · ${s.department || 'no department'} · ${s.active ? 'active' : 'not active'}`, value: s });
      } else if (list.length) {
        const s = staffRecord(list[0], fm);
        steps.push({ step: 'Staff search', ok: true, detail: `${list.length} found; first: ${s.name || '(no name)'} (ID ${s.staffID || '?'}${s.email ? `, ${s.email}` : ''})` });
      } else {
        steps.push({ step: 'Staff search', ok: false, detail: 'no staff came back: check the search text or the staff search path' });
      }
    } catch (err) {
      steps.push({ step: 'Staff search', ok: false, detail: err.message });
    }
  }

  out.ok = steps.every((s) => s.ok);
  return out;
}

/** The EMR's own patient ID: the mapped field, or id / _id / patient_id. */
function patientIdOf(record, fm) {
  const v = fm.patientId ? read(record, fm.patientId) : (record.id ?? record._id ?? record.patient_id);
  return v == null || v === '' ? null : String(v).trim();
}

/**
 * Live record reading (routes/records.js): finds the patient by hospital
 * number, then reads the hospital's record sources for that patient.
 * Nothing is stored. Throws if the patient can't be found exactly.
 */
async function readPatientRecords(hospital, hospitalNumber, { types } = {}) {
  const c = settings(hospital);
  const sources = c.recordSources || [];
  if (!sources.length) throw new CustomApiError('no record sources are set up for this hospital');
  const hit = await findPatientRecord(hospital, hospitalNumber);
  if (!hit) throw new CustomApiError('the patient was not found in the hospital system by their hospital number');
  const patientId = patientIdOf(hit.record, hit.fm);
  if (!patientId) throw new CustomApiError('could not tell the patient\'s ID in the hospital system: set "Patient ID" under Field mapping');
  return emrRecords.readRecords({
    sources,
    patientId,
    hospitalNumber,
    types,
    staffPath: c.staffLookupPath || '',
    getJson: (path, vars) => get(hospital, path, vars),
  });
}

/** "Find records automatically": suggested record sources from one test patient (nothing stored). */
async function discoverRecords(hospital, hospitalNumber, { webAppUrl } = {}) {
  const { discoverRecordSources } = require('./recordDiscovery');
  const c = settings(hospital);
  const hit = await findPatientRecord(hospital, hospitalNumber);
  if (!hit) throw new CustomApiError('that hospital number was not found in the hospital system');
  const patientId = patientIdOf(hit.record, hit.fm);
  if (!patientId) throw new CustomApiError('could not tell the patient\'s ID in the hospital system: set "Patient ID" under Field mapping');
  const out = await discoverRecordSources({
    getJson: (path, vars) => get(hospital, path, vars),
    patientId,
    hospitalNumber,
    webAppUrl: webAppUrl || new URL(c.baseUrl).origin + '/',
    apiBaseUrl: c.baseUrl,
  });
  return { ...out, patientIdField: hit.fm.patientId || ['id', '_id', 'patient_id'].find((k) => hit.record[k] != null) };
}

module.exports = {
  discoverRecords,
  getJson: get,
  readPatientRecords,
  patientCandidates,
  findPatient,
  fetchStaff,
  searchStaff,
  testConnection,
  suggestFieldMap,
  findList,
  findToken,
  fillTemplate,
  CustomApiError,
  _tokens: tokens,
};
