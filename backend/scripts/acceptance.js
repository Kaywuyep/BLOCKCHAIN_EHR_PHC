#!/usr/bin/env node
'use strict';

/**
 * scripts/acceptance.js
 *
 * Scenario-based acceptance checks (thesis Section 5.1.3, Table 5.2): signs
 * in as every role with the local login and works through the functional
 * requirements against a running backend loaded with the demo dataset.
 *
 * It expects a FRESHLY seeded demo world, because it changes it (approves,
 * declines and revokes grants, reviews an emergency access). For the real
 * network:
 *
 *   network/scripts/network-up.sh && network/scripts/deployChaincode.sh
 *   rm -rf data/fabric && DATA_DIR=$PWD/data/fabric LEDGER_MODE=fabric npm start
 *   # wait for "demo data loaded", then:
 *   node scripts/acceptance.js [--port 6000]
 *
 * Exit code 0 when every check passes.
 */
const http = require('http');
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 6000);
const net = require('net');
const L = 'general-hospital-langtang', W = 'general-hospital-wase', J = 'jos-university-teaching-hospital',
  P = 'plateau-specialist-hospital', O = 'our-lady-of-apostles-hospital';
const ADMIN = ['Patient', 'Practitioner', 'Organization'];
const typesOf = (j) => [...new Set(((j && j.bundles) || []).flatMap((b) => (b.entry || []).map((e) => e.resource.resourceType)))].filter((t) => !ADMIN.includes(t));
const isBG = (g) => g.grantType === 'BREAK_GLASS';
const EMERGENCY = ['AllergyIntolerance', 'MedicationRequest', 'Condition', 'Encounter', 'Observation'];

function call(method, path, body, token, raw) {
  return new Promise((res, rej) => {
    const d = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api' + path, method, headers: {
      'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(d ? { 'content-length': Buffer.byteLength(d) } : {}) } },
    (s) => { let t = ''; s.on('data', (c) => (t += c)); s.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { j = t; } res({ status: s.statusCode, json: j }); }); });
    r.on('error', rej); if (d) r.write(d); r.end();
  });
}
const tokens = {};
async function as(subject, role, hospitalID) {
  const k = subject + role;
  if (!tokens[k]) {
    const r = await call('POST', '/auth/login', { subject, role, hospitalID });
    if (r.status !== 200) throw new Error(`login ${subject}: ${r.status} ${JSON.stringify(r.json)}`);
    tokens[k] = r.json.token;
  }
  const t = tokens[k];
  return { get: (p) => call('GET', p, null, t), post: (p, b) => call('POST', p, b || {}, t), put: (p, b) => call('PUT', p, b, t) };
}

let pass = 0, fail = 0;
function check(name, ok, info) {
  if (ok) { pass++; console.log('  ok   ' + name); } else { fail++; console.log('  FAIL ' + name + (info !== undefined ? '  -> ' + JSON.stringify(info).slice(0, 400) : '')); }
}
const t0 = Date.now();
const timed = async (fn) => { const s = Date.now(); const r = await fn(); r.ms = Date.now() - s; return r; };

(async () => {
  console.log('\n== health ==');
  const h = await call('GET', '/health');
  check('health 200, ledger fabric', h.status === 200 && JSON.stringify(h.json).includes('fabric'), h.json);

  console.log('\n== patient: amina ==');
  const amina = await as('amina', 'patient');
  const me = await amina.get('/auth/me');
  const did = me.json.patientDID;
  check('amina has Health ID', did === 'did:patientchain:demo-amina', me.json);
  const pat = await amina.get(`/patients/${encodeURIComponent(did)}`);
  check('patient on ledger', pat.status === 200, pat.json);
  const fac = await amina.get(`/patients/${encodeURIComponent(did)}/facilities`);
  const facIDs = (fac.json.facilities || fac.json || []).map((f) => f.hospitalID);
  check('4 hospitals in network', [L, W, J, P].every((x) => facIDs.includes(x)), fac.json);
  const refs = await amina.get(`/patients/${encodeURIComponent(did)}/references`);
  check('pointers on ledger', refs.status === 200 && (refs.json.length || (refs.json.references || []).length) > 0, refs.json);
  let grants = (await amina.get(`/access/patient/${encodeURIComponent(did)}`)).json;
  const byStatus = (s) => grants.filter((g) => g.status === s);
  check('grants listed (pending/active/revoked/break-glass)', byStatus('PENDING').length >= 1 && byStatus('ACTIVE').length >= 3 && byStatus('REVOKED').length >= 1 && grants.some(isBG), grants.map((g) => [g.providerID, g.status, g.grantType]));
  const trail = await amina.get(`/audit/patient/${encodeURIComponent(did)}`);
  check('audit trail from ledger', trail.status === 200 && trail.json.length >= 5, trail.status);
  const other = await amina.get('/patients/did%3Apatientchain%3Ademo-ibrahim');
  check("cannot read another patient's record (403)", other.status === 403, other.status);

  console.log('\n== patient approves / declines ==');
  const bello = grants.find((g) => g.providerID === 'dr-bello' && g.hospitalID === L);
  const ap = bello.status === 'PENDING' ? await timed(() => amina.post(`/access/${bello.grantID}/grant`, { durationMinutes: 60 })) : { status: 200, json: bello, ms: 'earlier run' };
  check(`approve dr-bello (${ap.ms} ms)`, ap.status === 200 && ap.json.status === 'ACTIVE', ap.json);
  const danladi = grants.find((g) => g.providerID === 'dr-danladi');
  const dc = danladi.status === 'PENDING' ? await amina.post(`/access/${danladi.grantID}/revoke`, {}) : { status: 200, json: danladi };
  check('decline dr-danladi', dc.status === 200 && dc.json.status === 'REVOKED', dc.json);

  console.log('\n== clinician dr-bello (JUTH) reads Langtang records ==');
  const drBello = await as('dr-bello', 'clinician', J);
  const rr = await timed(() => drBello.get(`/records/resolve?grantID=${bello.grantID}&hospitalID=${L}`));
  const types = typesOf(rr.json);
  check(`resolve via grant (${rr.ms} ms)`, rr.status === 200 && types.length > 0, rr.json);
  console.log('       types:', types.join(','));
  const wrongH = await drBello.get(`/records/resolve?grantID=${bello.grantID}&hospitalID=${W}`);
  check('grant does not open another hospital (403)', wrongH.status === 403, wrongH.status);
  const dg = await drBello.get(`/records/resolve?grantID=${danladi.grantID}&hospitalID=${L}`);
  check("cannot use someone else's grant (403)", dg.status === 403, dg.status);

  console.log('\n== clinician dr-musa (Langtang): break-glass already active ==');
  const drMusa = await as('dr-musa', 'clinician', L);
  const mine = (await drMusa.get('/access/provider/me')).json;
  const bg = (mine.grants || mine).find((g) => isBG(g) && g.status === 'ACTIVE');
  check('active break-glass in My Grants', !!bg, mine);
  const er = await drMusa.get(`/records/resolve?grantID=${bg.grantID}&hospitalID=${J}`);
  const etypes = typesOf(er.json);
  check('emergency read returns only emergency types', er.status === 200 && etypes.length > 0 && etypes.every((t) => EMERGENCY.includes(t)), { status: er.status, etypes });
  const ed = await drMusa.get(`/access/${bg.grantID}/emergency-details`);
  check('emergency details decrypt and match ledger hash', ed.status === 200 && JSON.stringify(ed.json).includes('Musa Yusuf') && JSON.stringify(ed.json).includes('"verified":true'), ed.json);
  const ex = await timed(() => drMusa.post(`/access/${bg.grantID}/extend`, { minutes: 30, reason: 'Still unstable in resus' }));
  check(`extend break-glass (${ex.ms} ms)`, ex.status === 200, ex.json);
  const exNo = await drMusa.post(`/access/${bg.grantID}/extend`, { minutes: 30 });
  check('extend without reason refused', exNo.status >= 400, exNo.status);

  console.log('\n== request rules ==');
  const rq = await timed(() => drMusa.post('/access/request', { providerID: 'dr-musa', patientDID: did, hospitalID: P, scope: ['Observation'], purpose: 'Treatment' }));
  check(`cross-facility request in network (${rq.ms} ms)`, rq.status === 200 || rq.status === 201, rq.json);
  const own = await drMusa.post('/access/request', { providerID: 'dr-musa', patientDID: did, hospitalID: L, purpose: 'Treatment' });
  check('own-hospital request refused (400)', own.status === 400, own.status);
  const notNet = await drMusa.post('/access/request', { providerID: 'dr-musa', patientDID: 'did:patientchain:demo-chinedu', hospitalID: O, purpose: 'Treatment' });
  check('patient without Langtang in network refused', notNet.status >= 400 && notNet.status < 500, notNet);
  const lk = await drMusa.get(`/patients/lookup-by-hospital-number/${L}/536728`);
  check('lookup by own hospital number', lk.status === 200, lk.json);
  const lkO = await drMusa.get(`/patients/lookup-by-hospital-number/${J}/10045321`);
  check("lookup at another hospital's numbers refused", lkO.status === 403, lkO.status);

  console.log('\n== new break-glass on Fabric ==');
  const drOkon = await as('dr-okon', 'clinician', O);
  const nb = await timed(() => drOkon.post('/access/break-glass', { hospitalID: W, hospitalNumber: '887412', justification: 'Severe asthma attack, cannot speak', representative: { name: 'Hadiza Bello', relationship: 'Sister' } }));
  check(`break-glass by hospital number (${nb.ms} ms)`, nb.status === 200 || nb.status === 201, nb.json);
  check('scope = emergency set, 60 min', nb.json && JSON.stringify((nb.json.grant || nb.json).scope || []) === JSON.stringify(EMERGENCY), nb.json);
  const nbOut = await drOkon.post('/access/break-glass', { hospitalID: L, hospitalNumber: '104892', justification: 'test' });
  check('break-glass for patient without OLA in network refused (409)', nbOut.status === 409, nbOut);
  const drChukwu = await as('dr-chukwu', 'clinician', W);
  const ownBg = await drChukwu.post('/access/break-glass', { hospitalID: W, hospitalNumber: '887412', justification: 'test' });
  check('break-glass at own hospital refused (400)', ownBg.status === 400, ownBg.status);

  console.log('\n== suspended clinician ==');
  const yak = await as('dr-yakubu', 'clinician', L);
  const yg = (await yak.get('/access/provider/me')).json;
  const yGrant = (yg.grants || yg).find && (yg.grants || yg).find((g) => g.status === 'ACTIVE');
  const yr = yGrant ? await yak.get(`/records/resolve?grantID=${yGrant.grantID}&hospitalID=${J}`) : { status: 'no grant listed', json: yg };
  check('suspended clinician refused despite ACTIVE grant', yr.status === 403, yr);

  console.log('\n== hospital admins ==');
  const aJ = await as('admin-juth', 'hospital_admin', J);
  for (const p of ['overview', 'access-log', 'grants', 'clinicians', 'patients']) {
    const r = await aJ.get(`/hospital-admin/${p}`);
    check(`JUTH admin ${p}`, r.status === 200, r.json);
  }
  const pend = await aJ.get('/access/break-glass/pending');
  const mineToReview = (pend.json || []).find((g) => g.grantID === bg.grantID);
  check('JUTH admin sees pending break-glass', !!mineToReview, pend.json);
  const rv = await timed(() => aJ.post(`/access/${bg.grantID}/review`, { notes: 'Justified: unresponsive, husband present.' }));
  check(`JUTH admin reviews break-glass (${rv.ms} ms)`, rv.status === 200, rv.json);
  const rv2 = await aJ.post(`/access/${bg.grantID}/review`, { notes: 'again' });
  check('second review refused with readable chaincode message', rv2.status === 400 && /already been reviewed/.test(rv2.json.error), rv2);
  const aL = await as('admin-langtang', 'hospital_admin', L);
  const lg = await aL.get('/hospital-admin/grants');
  check('Langtang admin sees outgoing grants', lg.status === 200 && JSON.stringify(lg.json).includes('dr-musa'), lg.status);
  const aW = await as('admin-wase', 'hospital_admin', W);
  const crossAdmin = await aW.get(`/hospital-admin/overview?hospitalID=${J}`);
  check("Wase admin cannot see JUTH's view", crossAdmin.status === 403 || !JSON.stringify(crossAdmin.json).includes(J), crossAdmin.status);

  console.log('\n== system admin ==');
  const sa = await as('superadmin', 'system_admin');
  for (const p of ['/admin/hospitals', '/admin/users', '/hospitals/status', '/hl7/stats', '/hl7/messages', '/sync/status', '/cost/summary', '/audit/screen-captures', '/audit/events/recent']) {
    const r = await sa.get(p);
    check(`GET ${p}`, r.status === 200, r.json);
  }
  const jh = (await sa.get(`/admin/hospitals/${J}`)).json;
  const tf = await sa.post('/admin/hospitals/test-fhir', { ...jh.fhir, hospitalID: J });
  check('test JUTH FHIR connection', tf.status === 200 && tf.json.ok !== false, tf.json);
  const th = await sa.post('/admin/hospitals/test-hl7', { message: 'MSH|^~\\&|EMR|LTG|PC|PC|20261114120000||ADT^A01|T1|P|2.5\rPID|1||999111^^^LTG^MR||Test^Patient||19900101|F' });
  check('test HL7 parse', th.status === 200, th.json);
  const evts = (await sa.get('/audit/events/recent')).json;
  check('chaincode events arriving from Fabric', evts.length > 0, evts.length);

  console.log('\n== patient revokes; clinician loses access ==');
  grants = (await amina.get(`/access/patient/${encodeURIComponent(did)}`)).json;
  const g1 = grants.find((g) => g.providerID === 'dr-musa' && g.hospitalID === J && g.status === 'ACTIVE' && !isBG(g));
  const rk = await timed(() => amina.post(`/access/${g1.grantID}/revoke`, {}));
  check(`revoke (${rk.ms} ms)`, rk.status === 200 && rk.json.status === 'REVOKED', rk.json);
  const after = await drMusa.get(`/records/resolve?grantID=${g1.grantID}&hospitalID=${J}`);
  check('revoked grant refused (403)', after.status === 403, after.status);

  console.log('\n== standing share (hospital-staff) ==');
  const share = (await drMusa.get('/access/provider/me')).json;
  const st = (share.grants || share).find((g) => g.providerID === `hospital-staff@${L}` && g.status === 'ACTIVE');
  const sr = st ? await drMusa.get(`/records/resolve?grantID=${st.grantID}&hospitalID=${P}`) : { status: 'none listed' };
  check('Langtang clinician reads PSH records via standing share', sr.status === 200, sr);

  console.log('\n== registration + first-facility link (Hauwa) ==');
  const hauwa = await as('hauwa-' + Date.now(), 'patient');
  const lu = await hauwa.post('/patients/register/lookup', { hospitalID: L, hospitalNumber: 'LTG-2001', dateOfBirth: '1993-05-20' });
  check('registration lookup', lu.status === 200, lu.json);
  const reg = await timed(() => hauwa.post('/patients/register', { firstFacility: { hospitalID: L, hospitalNumber: 'LTG-2001', dateOfBirth: '1993-05-20' } }));
  check(`register DID on Fabric (${reg.ms} ms)`, reg.status === 200 || reg.status === 201, reg.json);

  console.log('\n== ingestion ==');
  const ack = await new Promise((resolve) => {
    const s = net.connect(5001, '127.0.0.1', () => {
      const msg = `MSH|^~\\&|EMR|LTG|PC|PC|20261114120000||ADT^A01|FAB${Date.now()}|P|2.5\rEVN|A01|20261114120000\rPID|1||LTG-9${Date.now() % 1000}^^^LTG^MR||Smoke^Fabric||19900101|F\rPV1|1|I\r`;
      s.write('\x0b' + msg + '\x1c\x0d');
    });
    let b = ''; s.on('data', (c) => { b += c; if (b.includes('\x1c')) { s.end(); resolve(b); } });
    s.on('error', (e) => resolve('ERR ' + e.message)); setTimeout(() => resolve(b || 'timeout'), 8000);
  });
  check('HL7 A01 over MLLP (Langtang) -> AA', ack.includes('MSA|AA'), ack.replace(/\r/g, ' | '));
  const rp = await as('rest-psh', 'hl7_interface', P);
  const ing = await rp.post(`/ingest/${P}`, { hospitalNumber: 'PSH-4420', resources: [{ resourceType: 'Observation', id: 'obs-fab-smoke', status: 'final', code: { text: 'Smoke test' }, valueString: 'ok' }] });
  check('REST ingest (PSH)', ing.status === 200 || ing.status === 201, ing.json);

  console.log(`\n${pass} passed, ${fail} failed  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e.stack); process.exit(2); });
