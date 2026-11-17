'use strict';

const { request } = require('./liveFhirClient');
const { SMARTCLINIC_DEFAULTS } = require('./hospitalRegistry');

/**
 * smartClinicClient.js
 *
 * Connector for SmartClinic (Primed E-Health), the EMR some Nigerian
 * teaching hospitals run (e.g. JUTH). It has no FHIR or HL7 interface,
 * only the REST API its own web app uses. What we know of that API comes
 * from the SmartClinic web app's code:
 *
 *   POST <base>staff/login   { data: { username, password } }
 *                            -> { token, result, dept } or { error: true, message }
 *   GET  <base><path>?token=<token>
 *
 * Primed has not published the shape of its answers, so where each value
 * sits (hospital number, name, staff ID, …) is a field map the system admin
 * can set in the UI. Blank entries are detected automatically, and
 * "Test connection" shows what was found so the map can be corrected.
 *
 * Uses:
 *   findPatient(hospital, hospitalNumber)  confirm a patient's hospital
 *       number and name when they link this hospital;
 *   fetchStaff(hospital, staffID)          "Add from EMR" for clinicians.
 *
 * Staff identity: JUTH's staff list has no staff-ID column (S/N, first
 * name, last name, sex, email, phone, designation). The clinician is then
 * identified by SmartClinic's own record ID (_id), which is opaque and safe
 * to write on-chain; their email becomes their Cevruni username and never
 * goes on-chain.
 *
 * Exact matches only: a hospital number or staff ID must match one record
 * exactly, never a guess.
 */

const TOKEN_TTL_MS = 20 * 60 * 1000;
// SmartClinic can be slow (JUTH's login has taken ~13 s).
const SMARTCLINIC_TIMEOUT_MS = 45 * 1000;
// Old default (no search, first page only), saved by earlier versions.
const OLD_STAFF_PATHS = new Set(['staff/v2/staffs']);
// Fetching one staff record by its SmartClinic ID when search can't find it:
// read the whole list in pages of this size, up to this many pages.
const PAGE_LIMIT = 500;
const MAX_PAGES = 40;
const tokens = new Map(); // hospitalID -> { token, at }

class SmartClinicError extends Error {}

// ── Reading values out of unknown JSON ──────────────────────────────────

/** Value at a dotted path ("data.patient.first_name"); arrays by index. */
function at(obj, path) {
  if (!path) return undefined;
  return String(path)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** "a + b + c" joins several fields with spaces (e.g. first + last name). */
function read(obj, spec) {
  if (!spec) return undefined;
  const parts = String(spec).split('+').map((p) => p.trim()).filter(Boolean);
  const values = parts.map((p) => text(at(obj, p))).filter((v) => v !== undefined && v !== '');
  if (!values.length) return undefined;
  return parts.length > 1 ? values.join(' ') : at(obj, parts[0]);
}

/** A readable string for a value that may be an object ({ name }), array or primitive. */
// Placeholder words some EMRs store instead of leaving a field empty.
const EMPTY_WORDS = /^(none|null|undefined|n\/?a|nil|-+|\.)$/i;

function text(v) {
  if (v == null) return undefined;
  if (typeof v === 'string' && EMPTY_WORDS.test(v.trim())) return undefined;
  if (typeof v === 'object' && !Array.isArray(v)) return text(v.name ?? v.title ?? v.label ?? v.description);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(', ') || undefined;
  return String(v).trim();
}

/** Every leaf path in an object, up to 3 levels: for the "available fields" list in the UI. */
function leafPaths(obj, prefix = '', depth = 0, out = []) {
  if (obj == null || typeof obj !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leafPaths(v, p, depth + 1, out);
    else out.push(p);
  }
  return out;
}

/** The list of records in an answer: the answer itself, or the first array of objects inside it. */
function findList(json, explicitPath) {
  if (explicitPath) {
    const v = at(json, explicitPath);
    if (Array.isArray(v)) return { list: v, path: explicitPath };
    if (v && typeof v === 'object') return { list: [v], path: explicitPath };
    return { list: [], path: explicitPath };
  }
  if (Array.isArray(json)) return { list: json, path: '' };
  const preferred = ['data', 'result', 'results', 'docs', 'patients', 'patient', 'staffs', 'staff', 'items', 'records', 'rows'];
  const queue = [{ v: json, p: '' }];
  let empty = null; // an empty list (e.g. no search hits) is an answer too
  for (let depth = 0; depth < 4 && queue.length; depth += 1) {
    const level = queue.splice(0);
    for (const { v, p } of level) {
      if (!v || typeof v !== 'object') continue;
      const keys = Object.keys(v).sort((a, b) => (preferred.indexOf(b) > -1) - (preferred.indexOf(a) > -1));
      for (const k of keys) {
        const child = v[k];
        const cp = p ? `${p}.${k}` : k;
        if (Array.isArray(child) && child.some((x) => x && typeof x === 'object')) return { list: child, path: cp };
        if (Array.isArray(child) && !child.length && !empty) empty = { list: [], path: cp };
        if (child && typeof child === 'object' && !Array.isArray(child)) queue.push({ v: child, p: cp });
      }
    }
  }
  if (empty) return empty;
  // A single record object (e.g. { data: { hospital_number, ... } }).
  for (const k of preferred) {
    const v = json && json[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return { list: [v], path: k };
  }
  return { list: [], path: '' };
}

// Key-name patterns for automatic detection (first match wins, in order).
const GUESS = {
  patientHospitalNumber: [/^hospital_?(no|number|num)$/i, /^hospitalnumber$/i, /^folder_?(no|number)$/i, /^(mrn|card_?no|file_?no|reg_?no|registration_?(no|number))$/i, /hosp.*(no|num)/i],
  patientName: [/^(full_?name|name|patient_?name|fullname)$/i],
  patientFirst: [/^(f(irst)?_?name|fname|given_?name|firstname)$/i],
  patientMiddle: [/^(m(iddle)?_?name|mname|other_?names?|middlename)$/i],
  patientLast: [/^(l(ast)?_?name|lname|surname|family_?name|lastname)$/i],
  patientDob: [/^(dob|date_?of_?birth|birth_?date|birthday|dateofbirth)$/i],
  staffId: [/^staff_?(id|no|number|num)$/i, /^(employee|personnel|emp)_?(id|no|number)$/i, /^(staffid|staffno|file_?no)$/i, /^(_id|id)$/],
  staffEmail: [/^(email|e_?mail|email_?address|mail)$/i],
  staffRole: [/^(role|designation|cadre|position|job_?title|title|rank)$/i],
  staffDepartment: [/^(dept|department)$/i, /^(specialization|specialty|speciality)$/i, /^(clinic|unit)$/i],
  staffActive: [/^(active|is_?active|enabled|account_?status|employment_?status|status)$/i],
};

// Internal database references (e.g. a MongoDB ObjectId) are not readable values.
const REFERENCE_ID = /^[0-9a-f]{24}$/i;

function guessKey(record, patterns, { readable = false } = {}) {
  // Top-level keys first, so "name" means the record's name, not dept.name.
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
  // A full-name field counts only at the top level ("dept.name" is not a person's name).
  const full = guessKey(record, GUESS.patientName);
  if (full && !full.includes('.') && typeof at(record, full) !== 'object') return full;
  return [guessKey(record, GUESS.patientFirst), guessKey(record, GUESS.patientMiddle), guessKey(record, GUESS.patientLast)].filter(Boolean).join(' + ');
}

/** Suggested field map for a sample patient and/or staff record. */
function suggestFieldMap({ patient, staff, patientListPath, staffListPath } = {}) {
  const s = {};
  if (patient) {
    s.patientList = patientListPath || '';
    s.patientHospitalNumber = guessKey(patient, GUESS.patientHospitalNumber);
    s.patientName = nameSpec(patient);
    s.patientDob = guessKey(patient, GUESS.patientDob);
  }
  if (staff) {
    s.staffList = staffListPath || '';
    s.staffId = guessKey(staff, GUESS.staffId);
    s.staffEmail = guessKey(staff, GUESS.staffEmail);
    s.staffName = nameSpec(staff);
    s.staffRole = guessKey(staff, GUESS.staffRole);
    s.staffDepartment = guessKey(staff, GUESS.staffDepartment, { readable: true });
    s.staffActive = guessKey(staff, GUESS.staffActive);
    // At JUTH "status" is on-duty availability (available/unavailable), not
    // employment: don't let it deactivate anyone.
    if (s.staffActive && DUTY_WORDS.test(String(at(staff, s.staffActive) ?? '').trim())) s.staffActive = '';
  }
  return s;
}

const DUTY_WORDS = /^(available|unavailable|online|offline|busy|away|on[ _-]?duty|off[ _-]?duty|on[ _-]?leave)$/i;

function isActive(v) {
  if (v === undefined || v === null || v === '') return true; // not reported: assume active
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return !/^(false|0|no|inactive|disabled|suspended|deactivated|blocked|terminated|retired|left)$/i.test(String(v).trim());
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
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ── HTTP ────────────────────────────────────────────────────────────────

function settings(hospital) {
  const c = hospital && hospital.smartclinic;
  if (!c || !c.baseUrl) throw new SmartClinicError('this hospital has no SmartClinic connection');
  const out = { ...SMARTCLINIC_DEFAULTS, ...c, fieldMap: c.fieldMap || {} };
  if (OLD_STAFF_PATHS.has(String(out.staffSearchPath).trim())) out.staffSearchPath = SMARTCLINIC_DEFAULTS.staffSearchPath;
  return out;
}

function urlFor(c, pathTemplate, vars = {}, token) {
  const path = String(pathTemplate).replace(/^\/+/, '').replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
  const u = new URL(path, c.baseUrl);
  // Paging overrides, for paths that page (e.g. ?page=1&limit=50).
  if (vars._page && u.searchParams.has('page')) u.searchParams.set('page', String(vars._page));
  if (vars._limit && u.searchParams.has('limit')) u.searchParams.set('limit', String(vars._limit));
  if (token) u.searchParams.set('token', token);
  return u.toString();
}

async function call(c, url, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await request(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      fhir: {},
      timeoutMs: SMARTCLINIC_TIMEOUT_MS,
    });
  } catch (err) {
    const code = err.code || (err.cause && err.cause.code);
    if (code === 'ECONNREFUSED') throw new SmartClinicError(`connection refused by ${new URL(url).host} (server down or wrong port)`);
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') throw new SmartClinicError(`cannot reach ${new URL(url).host}: is this computer on the hospital network?`);
    throw new SmartClinicError(err.message);
  }
  return res;
}

async function login(hospital, { fresh = false } = {}) {
  const c = settings(hospital);
  const cached = tokens.get(hospital.hospitalID || c.baseUrl);
  if (!fresh && cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;
  const password = hospital._emrSecret || hospital.smartclinic.password;
  if (!password) throw new SmartClinicError('no SmartClinic password is stored for this hospital');
  const res = await call(c, urlFor(c, c.loginPath), { method: 'POST', body: { data: { username: c.username, password } } });
  const j = res.json || {};
  if (res.status >= 400 || j.error) {
    throw new SmartClinicError(`SmartClinic refused the login (HTTP ${res.status}${j.message ? `: ${j.message}` : ''})`);
  }
  const token = j.token || (j.data && (j.data.v1Token || j.data.token));
  if (!token) throw new SmartClinicError('SmartClinic accepted the login but returned no token');
  tokens.set(hospital.hospitalID || c.baseUrl, { token, at: Date.now() });
  return token;
}

/** GET with the session token; logs in again once if the token has expired. */
async function get(hospital, pathTemplate, vars) {
  const c = settings(hospital);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await login(hospital, { fresh: attempt > 0 });
    const res = await call(c, urlFor(c, pathTemplate, vars, token));
    const j = res.json;
    const expired = res.status === 401 || res.status === 403 || (j && j.error && /token|session|expired|auth/i.test(String(j.message || '')));
    if (expired && attempt === 0) continue;
    if (res.status >= 400 || (j && j.error === true)) {
      throw new SmartClinicError(`SmartClinic answered HTTP ${res.status}${j && j.message ? `: ${j.message}` : ''} for ${String(pathTemplate).split('?')[0]}`);
    }
    if (j == null) throw new SmartClinicError(`SmartClinic did not answer with JSON for ${String(pathTemplate).split('?')[0]}`);
    return j;
  }
  throw new SmartClinicError('SmartClinic session could not be renewed');
}

// ── Lookups ─────────────────────────────────────────────────────────────

/** { hospitalNumber, name, dob } for exactly one matching patient, or null. */
async function findPatient(hospital, hospitalNumber) {
  const c = settings(hospital);
  const json = await get(hospital, c.patientSearchPath, { hospitalNumber });
  const { list, path } = findList(json, c.fieldMap.patientList);
  const fm = { ...suggestFieldMap({ patient: list[0], patientListPath: path }), ...c.fieldMap };
  const matches = list.filter((r) => sameId(read(r, fm.patientHospitalNumber), hospitalNumber));
  if (matches.length !== 1) return null;
  const r = matches[0];
  const name = text(read(r, fm.patientName));
  if (!name) return null;
  return { hospitalNumber: String(read(r, fm.patientHospitalNumber)).trim(), name, dob: isoDate(read(r, fm.patientDob)) };
}

/** One page of the staff list (the path may use {query} / {staffID}) and the field map to read it. */
async function staffList(hospital, term, { page, limit } = {}) {
  const c = settings(hospital);
  const json = await get(hospital, c.staffSearchPath, { staffID: term, query: term, _page: page, _limit: limit });
  const { list, path } = findList(json, c.fieldMap.staffList);
  const fm = { ...suggestFieldMap({ staff: list.find((r) => r && typeof r === 'object'), staffListPath: path }), ...c.fieldMap };
  if (list.length && !fm.staffId) throw new SmartClinicError('could not tell which field holds the staff ID: set it under Field mapping');
  const total = Number(json && json.pagination && json.pagination.count);
  return { list: list.filter((r) => r && typeof r === 'object'), fm, total: Number.isFinite(total) ? total : null };
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

/**
 * One staff record by its ID (staff number or SmartClinic record ID).
 * Tries SmartClinic's search with the ID, then with `hints` (e.g. the
 * email or name shown when the admin picked them), then reads the whole
 * list page by page. Exact ID match only.
 */
async function findStaffRecord(hospital, staffID, hints = []) {
  const c = settings(hospital);
  const match = ({ list, fm }) => {
    const m = list.filter((r) => sameId(read(r, fm.staffId), staffID));
    if (m.length > 1) throw new SmartClinicError(`${m.length} SmartClinic staff records have the ID ${staffID}; refusing to guess`);
    return m.length ? staffRecord(m[0], fm) : null;
  };
  // SmartClinic's search is slow for its own record IDs: try the email/name first.
  const terms = REFERENCE_ID.test(String(staffID)) ? [...hints.filter(Boolean), staffID] : [staffID, ...hints.filter(Boolean)];
  for (const term of terms) {
    const hit = match(await staffList(hospital, term));
    if (hit) return hit;
  }
  if (/\{(query|staffID)\}/.test(c.staffSearchPath) && /[?&]page=/.test(c.staffSearchPath)) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await staffList(hospital, '', { page, limit: PAGE_LIMIT });
      const hit = match(res);
      if (hit) return hit;
      if (!res.list.length || (res.total != null && page * PAGE_LIMIT >= res.total)) break;
    }
  }
  return null;
}

/** Same shape as liveFhirClient.fetchPractitioner, for "Add from EMR". */
async function fetchStaff(hospital, staffID, { hints = [] } = {}) {
  const rec = await findStaffRecord(hospital, staffID, hints);
  if (!rec) throw new SmartClinicError(`no staff member with the ID ${staffID} in the hospital's EMR`);
  return { ...rec, staffID: String(rec.staffID || staffID) };
}

/**
 * Search by name, email or staff ID, using SmartClinic's own search.
 * Everyone SmartClinic returns is listed (it may match other fields, e.g.
 * designation), best matches first: exact ID/email, then ID/email
 * containing the text, then names containing every word typed. If
 * SmartClinic finds nothing for several words ("john test"), each word is
 * searched and the narrowest answer is filtered here.
 * Returns { results, total } (total = how many SmartClinic matched).
 */
async function searchStaff(hospital, query, { limit = 50 } = {}) {
  const q = String(query || '').trim();
  const ql = q.toLowerCase();
  const words = ql.split(/\s+/).filter(Boolean);
  let { list, fm, total } = await staffList(hospital, q);
  let filterByWords = false;
  if (!list.length && words.length > 1) {
    let best = null;
    for (const w of [...new Set(words)].filter((x) => x.length >= 2)) {
      const res = await staffList(hospital, w);
      if (res.list.length && (!best || (res.total ?? res.list.length) < (best.total ?? best.list.length))) best = res;
    }
    if (best) ({ list, fm, total } = best);
    filterByWords = true;
  }
  const scored = [];
  for (const r of list) {
    const rec = staffRecord(r, fm);
    const id = (rec.staffID || '').toLowerCase();
    const email = (rec.email || '').toLowerCase();
    const name = (rec.name || '').toLowerCase();
    const nameHit = words.length && words.every((w) => name.includes(w));
    let score = 0;
    if ((id && id === ql) || (email && email === ql)) score = 4;
    else if ((id && ql.length >= 2 && id.includes(ql)) || (email && ql.length >= 3 && email.includes(ql))) score = 3;
    else if (nameHit) score = 2;
    else if (!filterByWords) score = 1; // SmartClinic matched it on another field
    if (score) scored.push({ score, rec });
  }
  scored.sort((a, b) => b.score - a.score || String(a.rec.name).localeCompare(String(b.rec.name)));
  const results = scored.slice(0, limit).map((x) => x.rec);
  return { results, total: filterByWords ? results.length : total ?? results.length };
}

/**
 * "Test connection" in the hospital setup wizard: sign in, then (if given)
 * look up one hospital number and one staff ID. Returns each step, what was
 * read, a suggested field map, and a sample record with the field names
 * found, so the admin can correct the map.
 */
async function testConnection(hospital, { hospitalNumber, staffID } = {}) {
  const steps = [];
  const out = { ok: false, steps, suggested: {}, samples: {} };
  const c = settings(hospital);
  tokens.delete(hospital.hospitalID || c.baseUrl);
  try {
    await login(hospital, { fresh: true });
    steps.push({ step: 'Sign in', ok: true, detail: `signed in as ${c.username}` });
  } catch (err) {
    steps.push({ step: 'Sign in', ok: false, detail: err.message });
    return out;
  }

  if (hospitalNumber) {
    try {
      const json = await get(hospital, c.patientSearchPath, { hospitalNumber });
      const { list, path } = findList(json, c.fieldMap.patientList);
      const suggested = suggestFieldMap({ patient: list[0], patientListPath: path });
      Object.assign(out.suggested, suggested);
      out.samples.patient = { listPath: path, count: list.length, fields: list[0] ? leafPaths(list[0]) : [], record: list[0] || null, raw: list.length ? undefined : json };
      const found = await findPatient(hospital, hospitalNumber);
      steps.push(
        found
          ? { step: 'Patient by hospital number', ok: true, detail: `${found.name}${found.dob ? `, born ${found.dob}` : ', no date of birth'}`, value: found }
          : { step: 'Patient by hospital number', ok: false, detail: list.length ? `${list.length} record(s) came back but none matched ${hospitalNumber} exactly: check the field mapping` : 'no records came back: check the hospital number or the search path' }
      );
    } catch (err) {
      steps.push({ step: 'Patient by hospital number', ok: false, detail: err.message });
    }
  }

  if (staffID) {
    try {
      const json = await get(hospital, c.staffSearchPath, { staffID });
      const { list, path } = findList(json, c.fieldMap.staffList);
      const sample = list.find((r) => r && typeof r === 'object');
      Object.assign(out.suggested, suggestFieldMap({ staff: sample, staffListPath: path }));
      out.samples.staff = { listPath: path, count: list.length, fields: sample ? leafPaths(sample) : [], record: sample || null, raw: list.length ? undefined : json };
      const s = await fetchStaff(hospital, staffID);
      steps.push({ step: 'Staff by staff ID', ok: true, detail: `${s.name || '(no name)'} · ${s.role || 'no role'} · ${s.department || 'no department'} · ${s.active ? 'active' : 'not active'}`, value: s });
    } catch (err) {
      steps.push({ step: 'Staff by staff ID', ok: false, detail: err.message });
    }
  }

  out.ok = steps.every((s) => s.ok);
  return out;
}

module.exports = {
  findPatient,
  fetchStaff,
  searchStaff,
  testConnection,
  suggestFieldMap,
  findList,
  read,
  leafPaths,
  isActive,
  SmartClinicError,
  _tokens: tokens,
};
