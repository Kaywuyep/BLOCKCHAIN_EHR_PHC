#!/usr/bin/env node
'use strict';

/**
 * scripts/demoBreakGlass.js — creates a fresh emergency (break-glass)
 * access in the running demo, through the real API, exactly as a clinician
 * would from Clinician Portal → Emergency Access.
 *
 * The clinician at their own hospital opens the patient's records held at
 * ANOTHER hospital, using the patient's number there (as family would give
 * it). Active for 1 hour. Both hospitals must be in the patient's network.
 *
 *   npm run demo:break-glass                      # dr-musa (Langtang) → Ibrahim Musa's JUTH records
 *   npm run demo:break-glass -- --clinician dr-chukwu --patient fatima      # Wase → OLA
 *   npm run demo:break-glass -- --clinician dr-bello --patient amina --at general-hospital-langtang
 *   npm run demo:break-glass -- --clinician dr-musa --patient chinedu       # refused: not in network
 *
 * Options: --clinician <providerID>  --patient <amina|ibrahim|fatima|chinedu>
 *          --at <hospital holding the records>  --reason "<justification>"
 *          --family "<name>,<relationship>,<phone>"  --base http://127.0.0.1:6000
 * Needs AUTH_MODE=local (the demo default).
 */

const http = require('http');
const https = require('https');
const D = require('../src/demo/demoData');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = arg('base', `http://127.0.0.1:${process.env.PORT || 6000}`);
const clinicianID = arg('clinician', 'dr-musa');
const patientKey = arg('patient', 'ibrahim');

function call(method, path, body, token) {
  const url = new URL(`/api${path}`, BASE);
  const lib = url.protocol === 'https:' ? https : http;
  const data = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = { error: text };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(subject, role, hospitalID) {
  const r = await call('POST', '/auth/login', { subject, role, hospitalID });
  if (r.status !== 200) throw new Error(`login as ${subject} failed: ${r.json && r.json.error}`);
  return r.json.token;
}

(async () => {
  const clinician = D.CLINICIANS.find((c) => c.providerID === clinicianID);
  if (!clinician) throw new Error(`unknown clinician "${clinicianID}" (try: ${D.CLINICIANS.map((c) => c.providerID).join(', ')})`);
  const patient = D.PATIENTS.find((p) => p.subject === patientKey);
  if (!patient) throw new Error(`unknown patient "${patientKey}" (try: ${D.PATIENTS.map((p) => p.subject).join(', ')})`);
  const at = arg('at', null);
  const elsewhere = patient.links.filter(([h]) => h !== clinician.hospitalID);
  const link = at ? patient.links.find(([h]) => h === at) : elsewhere[0];
  if (!link) {
    throw new Error(`${patient.subject} has no record ${at ? `at ${at}` : 'at any hospital other than the clinician\'s'} (network: ${patient.links.map(([h]) => h).join(', ')})`);
  }

  const token = await login(clinician.providerID, 'clinician', clinician.hospitalID);
  const reason = arg('reason', `Brought in unresponsive; needed allergies, current medication and history from ${link[0]} (${new Date().toLocaleTimeString()})`);
  const [fname, frel, fphone] = (arg('family', 'Family member,Relative,') || '').split(',').map((x) => (x || '').trim());
  const bg = await call('POST', '/access/break-glass', {
    hospitalID: link[0],
    hospitalNumber: link[1],
    justification: reason,
    representative: { name: fname, relationship: frel, phone: fphone },
  }, token);
  if (bg.status !== 201) throw new Error(`break-glass refused (${bg.status}): ${bg.json && bg.json.error}`);
  const look = { json: { name: bg.json.patientName } };

  // Open the records once, as the clinician would: this is what appears
  // in both hospitals' access logs and the patient's audit trail.
  const open = await call('GET', `/records/resolve?grantID=${bg.json.grantID}&hospitalID=${link[0]}`, null, token);

  console.log(`Break-glass created: ${clinician.name} (${clinician.hospitalID}) → ${look.json.name}'s records at ${link[0]} (No. ${link[1]})`);
  console.log(`  grant      ${bg.json.grantID}`);
  console.log(`  active     until ${new Date(bg.json.expiresAt).toLocaleString()} (1 hour; extend in View Records with a reason, up to 24 h)`);
  console.log(`  records    ${bg.json.scope.join(', ')}`);
  console.log(`  reason     ${reason}`);
  console.log(`  opened     ${open.status === 200 ? 'once (logged)' : `not opened: ${open.json && open.json.error}`}`);
  console.log('See it as:');
  console.log(`  ${clinician.providerID.padEnd(14)} Clinician Portal → View Records (EMERGENCY card)`);
  const adminOf = (h) => `admin-${{ [D.L]: 'langtang', [D.W]: 'wase', [D.J]: 'juth', [D.P]: 'psh', [D.O]: 'ola' }[h]}`;
  console.log(`  ${adminOf(clinician.hospitalID).padEnd(14)} Admin → Break-Glass Review (their clinician), Record Access Log`);
  console.log(`  ${adminOf(link[0]).padEnd(14)} Admin → Break-Glass Review (their records), Record Access Log`);
  console.log(`  ${patient.subject.padEnd(14)} Patient → Access Control and Audit Trail`);
})().catch((err) => {
  console.error(`demo:break-glass: ${err.message}`);
  process.exit(1);
});
