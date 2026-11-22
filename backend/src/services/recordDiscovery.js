'use strict';

/**
 * recordDiscovery.js
 *
 * "Find records automatically" in the hospital setup wizard. For a hospital
 * whose own API Cevruni reads (custom API, SmartClinic), works out the
 * record sources (services/emrRecords.js) from one test patient, so the
 * admin doesn't have to type API paths:
 *
 *   1. candidate API paths: read from the hospital's own web app (the GET
 *      calls in its JavaScript, same host as the API only), plus common
 *      patterns;
 *   2. visits: try the visit-like paths with the patient's hospital number
 *      or ID; keep the first that returns this patient's visits;
 *   3. per-patient and per-visit paths: try each with the patient ID or the
 *      newest visit ID; every list in the answer whose items carry THIS
 *      patient's ID becomes a source (lab tests, drugs, diagnoses…).
 *
 * Safety: GET requests only; paths that could change anything at the
 * hospital (create, update, delete, generate, approve, dispense…) or that
 * are reports/statistics are never tried; at most MAX_PROBES requests.
 * Nothing is stored: the result is a suggestion the admin reviews, tests
 * and saves.
 */

const { cleanRecordSources, personRefsIn, personName } = require('./emrRecords');

const MAX_PROBES = 70;
const MAX_SCRIPT_FILES = 40;
const MAX_SCRIPT_BYTES = 12 * 1024 * 1024;
const WEB_TIMEOUT_MS = 20 * 1000;

const RECORD_WORDS = /(visit|encounter|consult|prescri|diagnos|result|test|lab|drug|medic|pharm|investigat|radiolog|imaging|histor|note|vital|observ|allerg|triage|clinical|record|admission|ward|nursing)/i;
const UNSAFE_WORDS = /(create|add|new|update|edit|save|delete|remove|destroy|generate|merge|revive|mark|toggle|dispense|approve|verify|reject|cancel|send|sync|reset|logout|login|signin|register|convert|upload|download|pdf|print|export|pay|bill|invoice|deposit|refund|stat|report|count|summary|dashboard|today|queue|setting|config|role|permission|token|password|certificate|signature|card|price|inventory|store|stock|audit)/i;
const PATIENT_FIELDS = ['patient_id', 'patientId', 'patientID', 'patient', 'patient._id', 'patient.id', 'pid'];

// Kind of record from a list's key or path words, in order.
const KIND_RULES = [
  [/allerg/i, 'AllergyIntolerance'],
  [/(drug|medic|prescri.*drug|pharm)/i, 'MedicationRequest'],
  [/(investigat|radiolog|imaging|scan|xray|x-ray|ultrasound)/i, 'DiagnosticReport'],
  [/(diagnos|condition|problem|icd)/i, 'Condition'],
  [/(test|lab|sample|result|specimen)/i, 'Observation'],
  [/(vital|observation|triage)/i, 'Observation'],
  [/(note|histor|consult|complaint|document|ward_?round|doctor_?report)/i, 'DocumentReference'],
  [/(visit|encounter|admission)/i, 'Encounter'],
];
const SKIP_LISTS = /^(services?|items?|payments?|bills?|billing|insurances?|invoices?|deposits?|accounts?|dependants?|staffs?|users?|roles?|permissions?)$/i;

function at(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function kindOf(...hints) {
  for (const h of hints) {
    for (const [re, type] of KIND_RULES) if (re.test(String(h || ''))) return type;
  }
  return null;
}

function title(s) {
  const t = String(s).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── Candidate paths ─────────────────────────────────────────────────────

/**
 * GET paths in a web app's JavaScript: { path, takesId, params } where
 * takesId = an ID is appended ("/visits/" + id), params = query keys seen.
 */
function pathsFromScript(js) {
  const out = new Map();
  const add = (path, takesId, params = []) => {
    const p = path.replace(/^\/+/, '').replace(/\/api\//, '').replace(/^api\//, '');
    if (!p || p.length > 120 || /\s/.test(p)) return;
    const key = `${p}|${takesId}`;
    const prev = out.get(key);
    out.set(key, { path: p, takesId, params: [...new Set([...(prev ? prev.params : []), ...params])] });
  };
  // .get("/x/y/", {params:{a:..,b:..}})  and  .get("/x/".concat(id))  and  .get("/x/" + id)
  const re = /\.get\(\s*(["'`])(\/?[A-Za-z0-9_\-/.]+)\1\s*(\.concat\(|\+)?([^)]{0,300})/g;
  let m;
  while ((m = re.exec(js))) {
    const params = [];
    const pm = /params\s*:\s*\{([^}]*)\}/.exec(m[4] || '');
    if (pm) for (const k of pm[1].matchAll(/([A-Za-z_][\w]*)\s*:/g)) params.push(k[1]);
    add(m[2], Boolean(m[3]), params);
  }
  // Plain string paths used with a base URL (e.g. SmartClinic: base + "patient/v2/...").
  const re2 = /(["'`])((?:[a-z][a-z0-9_-]*\/){1,4}[a-zA-Z0-9_-]+\/?)\1\s*(\+|\.concat\()?/g;
  while ((m = re2.exec(js))) {
    if (/\.(js|css|png|svg|jpg|html|json|vue)$/i.test(m[2]) || /^(node_modules|src|static|assets|http)/.test(m[2])) continue;
    add(m[2], Boolean(m[3]) || m[2].endsWith('/'), []);
  }
  return [...out.values()].filter((c) => RECORD_WORDS.test(c.path) && !UNSAFE_WORDS.test(c.path));
}

/** Script URLs on a web app page (same host only), then their text. */
async function readWebApp(webAppUrl, apiHost) {
  const page = new URL(webAppUrl);
  if (page.hostname !== apiHost) throw new Error(`the web app must be on the same computer as the API (${apiHost})`);
  const get = async (u) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(WEB_TIMEOUT_MS), redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
    return r.text();
  };
  const html = await get(page.href);
  const urls = [...html.matchAll(/(?:src|href)=["']?([^"'\s>]+\.js)(?:\?[^"'\s>]*)?["'\s>]/gi)]
    .map((x) => new URL(x[1], page.href))
    .filter((u) => u.hostname === page.hostname)
    .map((u) => u.href);
  // Main bundles first (app/main/index), then the rest.
  const ordered = [...new Set(urls)].sort((a, b) => (/\/(app|main|index)[.-]/.test(b) ? 1 : 0) - (/\/(app|main|index)[.-]/.test(a) ? 1 : 0));
  let bytes = 0;
  let js = '';
  for (const u of ordered.slice(0, MAX_SCRIPT_FILES)) {
    if (bytes > MAX_SCRIPT_BYTES) break;
    try {
      const t = await get(u);
      bytes += t.length;
      js += `\n${t}`;
    } catch {
      // a missing chunk is not fatal
    }
  }
  return { js, files: Math.min(ordered.length, MAX_SCRIPT_FILES) };
}

const COMMON = [
  { path: 'visits', takesId: false, params: ['patient_id'] },
  { path: 'encounters', takesId: false, params: ['patient'] },
  { path: 'patients/{patientId}/visits', takesId: false, params: [], fixed: true },
  { path: 'patients/{patientId}/encounters', takesId: false, params: [], fixed: true },
  { path: 'patient/{patientId}/visits', takesId: false, params: [], fixed: true },
];

// ── Probing ─────────────────────────────────────────────────────────────

function patientFieldOf(item, patientId) {
  for (const f of PATIENT_FIELDS) {
    const v = at(item, f);
    if (v != null && typeof v !== 'object' && String(v).trim() === String(patientId)) return f;
  }
  return null;
}

/** Every list of objects in an answer (depth <= 4): { listPath, key, items }. */
function listsIn(json, prefix = '', depth = 0, out = []) {
  if (json == null || typeof json !== 'object' || depth > 4) return out;
  if (Array.isArray(json)) {
    if (json.some((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      out.push({ listPath: prefix, key: prefix.split('.').filter((p) => !/^\d+$/.test(p)).pop() || '', items: json.filter((x) => x && typeof x === 'object') });
      const first = json.find((x) => x && typeof x === 'object');
      for (const [k, v] of Object.entries(first || {})) if (v && typeof v === 'object') listsIn(v, `${prefix ? `${prefix}.` : ''}0.${k}`, depth + 1, out);
    }
    return out;
  }
  for (const [k, v] of Object.entries(json)) listsIn(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  return out;
}

const DATE_KEY = /^(date|date_?(requested|prescribed|created|recorded|visit_?start|of_?visit)|visit_?date|start_?date|created_?at|createdAt)$/i;

/** Display fields guessed from one sample record. */
function displayFor(item, type) {
  const keys = Object.keys(item || {});
  const nestedName = keys.find((k) => item[k] && typeof item[k] === 'object' && !Array.isArray(item[k]) && typeof item[k].name === 'string' && !/^(staff|patient|requester|examiner|doctor|user|created_?by|department)$/i.test(k));
  const who = keys.find((k) => item[k] && typeof item[k] === 'object' && !Array.isArray(item[k]) && typeof item[k].fullname === 'string' && k !== 'patient');
  const statusKey = keys.find((k) => /^(result_status|dispense_status)$/i.test(k)) || keys.find((k) => k === 'status');
  const dateKey = keys.find((k) => DATE_KEY.test(k));
  const d = {
    titleField: nestedName ? `${nestedName}.name` : '',
    dateField: dateKey || '',
    statusField: statusKey || '',
    whoField: who ? `${who}.fullname` : '',
    detailField: '',
  };
  if (type === 'Encounter') {
    const parts = ['department', 'professional', 'clinic', 'unit', 'specialty'].filter((k) => keys.includes(k));
    if (parts.length) d.titleField = parts.map((k) => `{${k}}`).join(' · ');
    const extra = ['category', 'type', 'priority', 'reason'].filter((k) => keys.includes(k));
    if (extra.length) d.detailField = extra.map((k) => `{${k}}`).join(' · ');
  } else if (type === 'MedicationRequest') {
    const dose = [
      keys.includes('prescribed_strength') || keys.includes('strength') ? `{prescribed_strength}{strength.name}` : '',
      keys.includes('dosage_form') ? '{dosage_form.name}' : '',
    ].filter(Boolean).join(' ');
    const parts = [dose, keys.includes('route') ? '{route.name}' : '', keys.includes('frequency') ? `{frequency}${keys.includes('duration') ? ' for {duration} {duration_unit}' : ''}` : '', keys.includes('notes') ? '{notes}' : ''].filter(Boolean);
    if (parts.length) d.detailField = parts.join(' · ');
  } else if (['Observation', 'DiagnosticReport'].includes(type)) {
    const r = keys.find((k) => /^(result|value|finding|findings|conclusion|report)$/i.test(k));
    if (r) d.detailField = r;
  } else if (type === 'DocumentReference') {
    const notes = keys.filter((k) => /(note|complaint|history|examination|plan|summary|comment)/i.test(k) && typeof item[k] === 'string');
    if (notes.length) {
      d.titleField = d.titleField || '';
      d.detailField = notes.slice(0, 6).map((k) => `{${k}}`).join(' · ');
    }
  }
  return d;
}

/**
 * Finds record sources for one patient. `getJson(path, vars)` calls the
 * hospital's API signed in; `patient` is the raw patient record found by
 * hospital number and `patientId` its ID. Returns { sources, steps, probes }.
 */
async function discoverRecordSources({ getJson, patientId, hospitalNumber, webAppUrl, apiBaseUrl }) {
  const steps = [];
  let probes = 0;
  const tried = new Set();
  const probe = async (path, vars) => {
    if (probes >= MAX_PROBES) return null;
    const key = `${path}|${JSON.stringify(vars)}`;
    if (tried.has(key)) return null;
    tried.add(key);
    probes += 1;
    try {
      return await getJson(path, vars);
    } catch {
      return null;
    }
  };

  // 1. Candidates
  let candidates = [...COMMON];
  let staffCands = ['staffs/', 'staff/', 'users/', 'employees/'];
  if (webAppUrl) {
    try {
      const { js, files } = await readWebApp(webAppUrl, new URL(apiBaseUrl).hostname);
      const fromApp = [...js.matchAll(/\.get\(\s*(["'`])\/?(?:api\/)?((?:staffs?|users?|employees?|personnel|practitioners?)\/)\1\s*(?:\.concat\(|\+)/g)].map((m) => m[2]);
      staffCands = [...new Set([...fromApp, ...staffCands])];
      const found = pathsFromScript(js);
      candidates = [...found, ...COMMON];
      steps.push({ step: 'Read the hospital web app', ok: true, detail: `${files} script file(s); ${found.length} possible record address(es)` });
    } catch (err) {
      steps.push({ step: 'Read the hospital web app', ok: false, detail: `${err.message}; trying common addresses only` });
    }
  }

  const withQuery = (path, q) => `${path}${path.includes('?') ? '&' : '?'}${q}`;
  const pageQ = (c) => (c.params.includes('currentPage') ? '&currentPage=1&pageLimit=50' : c.params.includes('page') ? '&page=1&limit=50' : '');

  // 2. Visits
  // Lists of all visits first; "active"/"pending" lists last.
  const rank = (c) => (/\ball\b|\/all\//i.test(c.path) ? 0 : /(past|history)/i.test(c.path) ? 1 : /(active|pending|current|open|today)/i.test(c.path) ? 3 : 2);
  const visitCands = candidates
    .filter((c) => /(visit|encounter)/i.test(c.path) && !/(prescri|diagnos|result|test|drug|triage|categor|professional|assigned)/i.test(c.path))
    .sort((a, b) => rank(a) - rank(b));
  let visitSource = null;
  let visitIds = [];
  for (const c of visitCands) {
    if (visitSource || probes >= MAX_PROBES) break;
    const variants = c.fixed
      ? [c.path]
      : c.takesId
        ? [`${c.path.replace(/\/?$/, '/')}{patientId}`]
        : [
            withQuery(c.path, `search={hospitalNumber}${pageQ(c)}`),
            withQuery(c.path, `patient_id={patientId}${pageQ(c)}`),
            withQuery(c.path, `patientId={patientId}${pageQ(c)}`),
          ];
    for (const path of variants) {
      const json = await probe(path, { patientId, hospitalNumber });
      if (!json) continue;
      for (const l of listsIn(json)) {
        const mine = l.items.filter((it) => patientFieldOf(it, patientId));
        if (!mine.length) continue;
        const pf = patientFieldOf(mine[0], patientId);
        visitIds = mine
          .map((it) => ({ id: it.id ?? it._id, date: String(it.date_visit_start || it.visit_date || it.date || it.createdAt || '') }))
          .filter((v) => v.id != null)
          .sort((a, b) => (b.date > a.date ? 1 : -1))
          .map((v) => String(v.id));
        visitSource = { label: 'Visits', resourceType: 'Encounter', path, listPath: l.listPath, patientField: pf, ...displayFor(mine[0], 'Encounter') };
        break;
      }
      if (visitSource) break;
    }
  }
  steps.push(visitSource
    ? { step: 'Visits', ok: true, detail: `found ${visitIds.length} visit(s) at ${visitSource.path.split('?')[0]}` }
    : { step: 'Visits', ok: false, detail: 'no address returned this patient’s visits' });

  // 3. Per-patient and per-visit lists
  // Every list of this patient's records found, chosen from at the end.
  const hits = [];
  const visitSet = new Set(visitIds);
  const consider = (json, path, hint) => {
    for (const l of listsIn(json)) {
      if (SKIP_LISTS.test(l.key)) continue;
      const mine = l.items.filter((it) => patientFieldOf(it, patientId));
      if (!mine.length) continue;
      const type = kindOf(l.key, hint, path);
      if (!type || (type === 'Encounter' && visitSource)) continue;
      // A list of the visits themselves (e.g. a "history" of visits) is not a new kind of record.
      const ids = mine.map((it) => it.id ?? it._id).filter((x) => x != null).map(String);
      if (ids.length && ids.every((id) => visitSet.has(id)) && mine.some((it) => it.date_visit_start || it.visit_date)) continue;
      hits.push({
        sig: ids.length === mine.length ? `${type}:${[...ids].sort().join(',')}` : `${type}|${(l.key || path).toLowerCase()}`,
        source: {
          label: title(l.key && !/^(data|docs|result|results|rows|items)$/i.test(l.key) ? l.key : hint || type),
          resourceType: type,
          path,
          listPath: l.listPath,
          patientField: patientFieldOf(mine[0], patientId),
          ...displayFor(mine[0], type),
        },
        sample: mine[0],
        depth: l.listPath.split('.').length,
        order: hits.length,
      });
    }
  };

  const newestVisit = visitIds[0];
  const others = candidates.filter((c) => !c.fixed && !(visitSource && visitSource.path.startsWith(c.path)));
  for (const c of others) {
    if (probes >= MAX_PROBES) break;
    const hint = c.path.split('/').filter((p) => p && !/^(get|v\d+|all|list)$/i.test(p)).pop() || c.path;
    const variants = [];
    const visitish = /(visit|prescri|consult|diagnos|triage|investigat|test|result|drug)/i.test(c.path);
    if (c.takesId) {
      if (newestVisit && visitish) variants.push([`${c.path.replace(/\/?$/, '/')}{visitId}`, { visitId: newestVisit }]);
      if (/patient|histor|allerg|vital/i.test(c.path)) variants.push([`${c.path.replace(/\/?$/, '/')}{patientId}`, {}]);
    } else if (c.params.some((p) => /visit/i.test(p)) && newestVisit) {
      const vk = c.params.find((p) => /visit/i.test(p));
      variants.push([withQuery(c.path, `${vk}={visitId}${pageQ(c)}`), { visitId: newestVisit }]);
    } else if (c.params.some((p) => /patient/i.test(p))) {
      const pk = c.params.find((p) => /patient/i.test(p));
      variants.push([withQuery(c.path, `${pk}={patientId}${pageQ(c)}`), {}]);
    }
    for (const [path, extra] of variants) {
      const json = await probe(path, { patientId, hospitalNumber, ...extra });
      if (json) consider(json, path, hint);
    }
  }

  // The same records under several addresses (e.g. PSSH "orders" and
  // "prescriptions"): keep one copy, preferring an address that also gives
  // other kinds of record (fewer requests when a doctor opens records),
  // then the simplest place in the answer, then the first found.
  const kindsAt = new Map();
  for (const h of hits) kindsAt.set(h.source.path, (kindsAt.get(h.source.path) || new Set()).add(h.sig));
  const better = (a, b) =>
    kindsAt.get(b.source.path).size - kindsAt.get(a.source.path).size || a.depth - b.depth || a.order - b.order;
  const best = new Map();
  for (const h of hits) {
    const prev = best.get(h.sig);
    if (!prev || better(h, prev) < 0) best.set(h.sig, h);
  }
  const found = new Map([...best.values()].sort((a, b) => a.order - b.order).map((h) => [h.sig, h.source]));

  const NAMES = { Observation: 'Lab tests', DiagnosticReport: 'Radiology & reports', MedicationRequest: 'Medications', Condition: 'Diagnoses', AllergyIntolerance: 'Allergies', DocumentReference: 'Notes' };
  const used = new Set(['Visits']);
  const named = [...found.values()].map((s) => {
    let label = NAMES[s.resourceType] || s.label;
    if (used.has(label)) label = `${label} (${s.label})`;
    used.add(label);
    return { ...s, label };
  });
  // Full results (any kind of record): if records carry a link to a result
  // (result_id, report_id…) and the web app has a matching "…result…/<id>"
  // address, read it when a doctor opens the record (shown only if the
  // answer names this same patient; see emrRecords.readResult).
  const TYPE_WORDS = {
    Observation: /(lab|test|sample|specimen)/i,
    DiagnosticReport: /(radiolog|investigat|imaging|scan)/i,
    MedicationRequest: /(drug|pharm|medic|prescri)/i,
    Condition: /(diagnos|condition)/i,
    DocumentReference: /(note|consult|report|document)/i,
    AllergyIntolerance: /allerg/i,
    Encounter: /(visit|encounter)/i,
  };
  const resultAddrs = candidates.filter((c) => c.takesId && /(result|report|finding)/i.test(c.path));
  for (const src of named) {
    const sample = [...best.values()].find((h) => h.source.path === src.path && h.source.listPath === src.listPath)?.sample || {};
    const links = Object.keys(sample).filter((k) => /(result|report|finding)s?_?id$/i.test(k) || /_prescription_id$/i.test(k));
    const addr = resultAddrs.find((c) => TYPE_WORDS[src.resourceType] && TYPE_WORDS[src.resourceType].test(c.path));
    if (addr && links.length) {
      const order = links.sort((a, b) => (/result/i.test(b) ? 1 : 0) - (/result/i.test(a) ? 1 : 0));
      src.resultPath = order.map((k) => `${addr.path.replace(/\/?$/, '/')}{${k}}`).join(' | ');
    }
  }
  const sources = [visitSource, ...named].filter(Boolean);
  // Keep only what passes the same checks as a saved setup.
  let clean = [];
  try {
    clean = cleanRecordSources(sources.filter((s) => !s.path.includes('{visitId}') || visitSource));
  } catch (err) {
    steps.push({ step: 'Check', ok: false, detail: err.message });
  }
  for (const s of clean.filter((x) => x !== clean[0] || !visitSource)) {
    steps.push({ step: s.label, ok: true, detail: `${s.resourceType} at ${s.path.split('?')[0]}${s.listPath ? ` (${s.listPath})` : ''}` });
  }
  if (probes >= MAX_PROBES) steps.push({ step: 'Limit', ok: true, detail: `stopped after ${MAX_PROBES} requests; run again later if something is missing` });
  // Staff lookup: turns "requester: 390" into the requester's name. Tried
  // with a staff number seen in this patient's records; kept if the answer
  // is a person with a name.
  let staffLookupPath = '';
  const refs = new Set();
  for (const h of hits) personRefsIn(h.sample, 0, refs);
  const someRef = [...refs][0];
  if (someRef) {
    for (const base of staffCands) {
      if (probes >= MAX_PROBES + 5) break;
      const path = `${base}{id}`;
      probes += 1;
      let json = null;
      try {
        json = await getJson(path.replace('{id}', encodeURIComponent(someRef)), {});
      } catch {
        json = null;
      }
      const body = json && json.data && typeof json.data === 'object' ? json.data : json;
      if (body && !Array.isArray(body) && personName(body)) {
        staffLookupPath = path;
        steps.push({ step: 'Staff names', ok: true, detail: `staff numbers in records are shown as names (via ${base})` });
        break;
      }
    }
  }
  return { sources: clean, steps, probes, staffLookupPath };
}

module.exports = { discoverRecordSources, pathsFromScript, listsIn, displayFor, UNSAFE_WORDS, RECORD_WORDS };
