'use strict';

const { randomUUID } = require('crypto');
const D = require('./demoData');
const { EmergencyDetails } = require('../services/emergencyDetails');
const fixtures = require('../services/hl7AdtListener.fixtures');

/**
 * demoSeed.js — loads the demo world (development only).
 *
 * Runs at backend start unless NODE_ENV=production or DEMO_SEED=off.
 *
 *   Off-chain (SQLite, persists):  hospitals' connection setup, user
 *     accounts, clinicians, patient rosters, clinical records, DID links,
 *     screenshot attempts, HL7 inbox messages. Each item is only added if
 *     it is missing, so restarts never duplicate anything and nothing an
 *     admin changed by hand is overwritten.
 *
 *   On-chain (ledger):  patient DIDs, record pointers, grants in every
 *     state, break-glass events, audit history. The simulated ledger is
 *     in memory, so this part is rebuilt on every start; on a real Fabric
 *     ledger it runs once (skipped when the demo patients already exist).
 *
 * Demo patients have no signing key on any device, so they act unsigned.
 * To try patient signatures, register a new patient in the app (e.g. the
 * unlinked roster entry Hauwa Danjuma, LTG-2001, born 1993-05-20).
 */

const HOUR = 3600 * 1000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();

async function exists(fn) {
  try {
    return Boolean(await fn());
  } catch {
    return false;
  }
}

/** Steps done once per database (demo_seed table), so admin edits made afterwards are never overwritten. */
function once(db, key, fn) {
  db.exec('CREATE TABLE IF NOT EXISTS demo_seed (key TEXT PRIMARY KEY, done_at TEXT NOT NULL)');
  if (db.prepare('SELECT 1 FROM demo_seed WHERE key = ?').get(key)) return;
  fn();
  db.prepare('INSERT INTO demo_seed (key, done_at) VALUES (?, ?)').run(key, new Date().toISOString());
}

function seedHospitals({ db, hospitalRegistry, port, logger }) {
  once(db, 'hospital-connections', () => {
    for (const [id, setup] of Object.entries(D.HOSPITAL_SETUP)) {
      const h = hospitalRegistry.get(id);
      if (!h || h.createdBy !== 'import:config-files') continue;
      const input = { integration: setup.integration, hl7: setup.hl7 || null, fhir: null };
      if (setup.fhir === 'demo') {
        const base = `http://127.0.0.1:${port}/demo-fhir/juth`;
        input.fhir = {
          baseUrl: `${base}/R4`,
          authType: 'client-secret',
          tokenUrl: `${base}/token`,
          clientId: D.JUTH_FHIR.clientId,
          clientSecret: D.JUTH_FHIR.clientSecret,
          mrnIdentifierSystem: D.JUTH_FHIR.identifierSystem,
        };
      }
      try {
        hospitalRegistry.update(id, input);
      } catch (err) {
        logger.warn(`demo: could not set up ${id}: ${err.message}`);
      }
    }
  });
}

function seedPeople({ userDirectory, providerRegistry }) {
  for (const u of D.USERS) {
    if (userDirectory.getAccount(u.subject)) continue;
    try {
      userDirectory.create(u, { createdBy: 'demo-seed' });
    } catch {
      // already present via the registry merge
    }
  }
  for (const c of D.CLINICIANS) {
    if (!providerRegistry.get(c.providerID, c.hospitalID)) providerRegistry.register(c);
    if (!userDirectory.getAccount(c.providerID)) {
      try {
        userDirectory.create({ subject: c.providerID, displayName: c.name, roles: ['clinician'], hospitalID: c.hospitalID, providerID: c.providerID }, { createdBy: 'demo-seed' });
      } catch {
        // ignore
      }
    }
    if (c.status === 'SUSPENDED' && providerRegistry.get(c.providerID, c.hospitalID).status !== 'SUSPENDED') {
      providerRegistry.register(c);
    }
  }
}

function seedRecords({ fhirAdapter }) {
  for (const r of D.ROSTER) {
    if (!fhirAdapter.findLocalPatientRecord(r.hospitalID, r.hospitalNumber)) {
      fhirAdapter.addLocalPatientRecord(r.hospitalID, r.hospitalNumber, { name: r.name, dob: r.dob });
    }
  }
  const held = new Map();
  for (const rec of D.CLINICAL) {
    const key = `${rec.hospitalID}|${rec.hospitalNumber}`;
    if (!held.has(key)) {
      held.set(key, new Set(fhirAdapter.listBundlesByHospitalNumber(rec.hospitalID, rec.hospitalNumber).flatMap((b) => b.entry.map((e) => e.resource.id))));
    }
    if (held.get(key).has(rec.resource.id)) continue;
    fhirAdapter.recordResourceByHospitalNumber(rec.hospitalID, rec.hospitalNumber, rec.resource);
  }
}

/** Each demo patient's DID: an existing account binding wins, so earlier demo data stays valid. */
function resolvePatients({ identityStore, fhirAdapter }) {
  return D.PATIENTS.map((p) => {
    const bound = identityStore.patientDidFor(p.subject);
    const linkedTo = fhirAdapter.findDidByHospitalNumber(p.links[0][0], p.links[0][1]);
    const did = bound || linkedTo || p.did;
    if (!bound) {
      try {
        identityStore.bind(p.subject, did);
      } catch {
        // bound elsewhere
      }
    }
    for (const [hospitalID, hospitalNumber] of p.links) {
      const owner = fhirAdapter.findDidByHospitalNumber(hospitalID, hospitalNumber);
      if (!owner) fhirAdapter.registerLocalPatient(hospitalID, did, hospitalNumber);
    }
    return { ...p, did };
  });
}

function seedHl7Inbox({ db, inbox }) {
  if (!inbox) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM hl7_messages WHERE hospital_id IN (?, ?)').get(D.L, D.W).n;
  if (count > 0) return;
  inbox.receive(D.L, fixtures.adtA01Admit); // new admission: LAG-00231 Adaeze Okafor
  inbox.receive(D.L, fixtures.adtA08Update);
  inbox.receive(D.L, fixtures.adtA03Discharge);
  inbox.receive(D.W, fixtures.oruResultNotAdt); // wrong message type: rejected
}

function seedScreenshots({ db, ledger }, patients) {
  const amina = patients.find((p) => p.subject === 'amina');
  const fatima = patients.find((p) => p.subject === 'fatima');
  once(db, 'screenshots', () => {
    const rows = [
      { actorID: 'dr-musa', role: 'clinician', hospitalID: D.L, patientDID: amina.did, method: 'print-screen', confidence: 'confirmed', page: '/clinician/records', at: ago(30) },
      { actorID: 'dr-chukwu', role: 'clinician', hospitalID: D.W, patientDID: fatima.did, method: 'windows-snip', confidence: 'suspected', page: '/clinician/records', at: ago(52) },
      { actorID: amina.did, role: 'patient', hospitalID: '', patientDID: amina.did, method: 'mac-shortcut', confidence: 'confirmed', page: '/patient/records', at: ago(75) },
    ];
    const insert = db.prepare(`INSERT INTO screen_capture_attempts
      (id, occurred_at, actor_id, role, hospital_id, patient_did, method, confidence, page, ledger_entry_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      const id = `demo-sc-${randomUUID().slice(0, 8)}`;
      insert.run(id, r.at, r.actorID, r.role, r.hospitalID, r.patientDID, r.method, r.confidence, r.page, id);
    }
  });
  // (Re)write their ledger audit entries -- the simulated ledger starts empty.
  for (const r of db.prepare("SELECT * FROM screen_capture_attempts WHERE id LIKE 'demo-sc-%'").all()) {
    try {
      ledger.writeAuditEntry({
        entryID: r.id, patientDID: r.patient_did, eventType: 'SCREEN_CAPTURE_ATTEMPT', actorID: r.actor_id, hospitalID: r.hospital_id,
        detail: `method=${r.method}; confidence=${r.confidence}; page=${r.page}`, clientTimestamp: r.occurred_at,
      });
    } catch {
      // already on this ledger
    }
  }
}

/** The on-chain part: DIDs, pointers, grants in every state, audit history. */
async function seedLedger(ctx, patients) {
  const { ledger, referenceService, fhirAdapter } = ctx;
  const by = Object.fromEntries(patients.map((p) => [p.subject, p]));
  if (await exists(() => ledger.getPatient(by.ibrahim.did))) return false; // already on this ledger

  for (const p of patients) {
    if (!(await exists(() => ledger.getPatient(p.did)))) {
      await ledger.registerPatient({ patientDID: p.did, publicKey: `demo-key-${p.subject}` });
    }
    for (const [hospitalID, hospitalNumber] of p.links) {
      if (fhirAdapter.findDidByHospitalNumber(hospitalID, hospitalNumber) === p.did) {
        await referenceService.registerExisting(hospitalID, p.did, hospitalNumber);
      }
    }
  }

  const audit = (patientDID, eventType, actorID, hospitalID, detail, hoursAgo) =>
    ledger.writeAuditEntry({ patientDID, eventType, actorID, hospitalID, detail, clientTimestamp: ago(hoursAgo) });
  const nameOf = (id) => (ctx.hospitalRegistry && ctx.hospitalRegistry.get(id) ? ctx.hospitalRegistry.get(id).name : id);
  const homeOf = (providerID) => (providerID.startsWith('hospital-staff@') ? providerID.slice(15) : D.CLINICIANS.find((c) => c.providerID === providerID).hospitalID);

  // grant(): a clinician at one hospital asks for the patient's records at
  // ANOTHER hospital (+ optional approve / revoke), with audit entries.
  async function grant({ patient, providerID, recordsAt, scope = [], purpose = 'Treatment', role = '', approve = null, revoke = false, requestedHoursAgo = 48 }) {
    const grantID = `demo-${randomUUID().slice(0, 8)}`;
    const requesterHospitalID = homeOf(providerID);
    await ledger.requestAccess({ grantID, patientDID: patient.did, providerID, hospitalID: recordsAt, scope, purpose, providerRole: role, requesterHospitalID });
    if (approve) {
      await ledger.grantAccess({ grantID, durationMinutes: approve });
      const detail = providerID.startsWith('hospital-staff@')
        ? `Patient shared ${nameOf(recordsAt)} records with ${nameOf(requesterHospitalID)} for ${approve} minutes`
        : `Access to ${nameOf(recordsAt)} records granted to ${providerID} (${nameOf(requesterHospitalID)}) for ${approve} minutes`;
      await audit(patient.did, providerID.startsWith('hospital-staff@') ? 'PATIENT_GRANTED_HOSPITAL' : 'GRANT_ISSUED', patient.did, recordsAt, detail, requestedHoursAgo - 1);
    }
    if (revoke) {
      await ledger.revokeAccess({ grantID });
      await audit(patient.did, 'GRANT_REVOKED', patient.did, recordsAt, `Access revoked from ${providerID}`, requestedHoursAgo - 6);
    }
    return grantID;
  }
  const accessed = (patient, providerID, recordsAt, grantID, hoursAgo, emergency = false) =>
    audit(patient.did, 'RECORD_ACCESSED', providerID, recordsAt, `${emergency ? 'EMERGENCY ' : ''}records opened from ${homeOf(providerID)} via grant ${grantID}`, hoursAgo);

  // breakGlass(): emergency access by hospital number, with the family
  // member who asked (kept off-chain, hash on-chain).
  async function breakGlass({ patient, providerID, recordsAt, justification, representative, hoursAgo = 0 }) {
    const grantID = `demo-bg-${randomUUID().slice(0, 6)}`;
    // Reason and representative off-chain; the ledger gets their hash.
    const ref = ctx.emergencyDetails ? ctx.emergencyDetails.put(grantID, 'justification', { justification, representative }) : justification;
    await ledger.breakGlassAccess({ grantID, patientDID: patient.did, providerID, hospitalID: recordsAt, requesterHospitalID: homeOf(providerID), justification: ref, representativeHash: representative && ctx.emergencyDetails ? ref.slice(7) : '' });
    const rep = representative ? `; requested by ${representative.relationship} ${representative.name}` : '';
    await audit(patient.did, 'BREAK_GLASS_ACCESS', providerID, recordsAt, `Emergency access from ${nameOf(homeOf(providerID))}; reason${rep ? ' and requesting representative' : ''} recorded off-chain (${String(ref).slice(0, 19)})`, hoursAgo);
    await accessed(patient, providerID, recordsAt, grantID, hoursAgo, true);
    return grantID;
  }

  const { amina, ibrahim, fatima } = by;
  const DAY = 24 * 60;
  const LAB = ['Observation', 'DiagnosticReport'];

  // ── Amina: network Langtang, Wase, JUTH, Plateau Specialist ──
  const g1 = await grant({ patient: amina, providerID: 'dr-musa', recordsAt: D.J, scope: [...LAB, 'MedicationRequest'], role: 'Physician', approve: 7 * DAY, requestedHoursAgo: 120 });
  for (const h of [118, 70, 26]) await accessed(amina, 'dr-musa', D.J, g1, h);
  const g2 = await grant({ patient: amina, providerID: 'dr-musa', recordsAt: D.W, scope: [...LAB, 'MedicationRequest'], role: 'Physician', approve: 7 * DAY, requestedHoursAgo: 119 });
  await accessed(amina, 'dr-musa', D.W, g2, 69);
  await grant({ patient: amina, providerID: 'dr-chukwu', recordsAt: D.L, scope: ['Encounter'], purpose: 'Referral', role: 'Physician', requestedHoursAgo: 5 });
  await grant({ patient: amina, providerID: 'dr-bello', recordsAt: D.L, purpose: 'Second Opinion', role: 'Consultant', requestedHoursAgo: 2 });
  await grant({ patient: amina, providerID: 'dr-danladi', recordsAt: D.L, scope: ['Observation', 'MedicationRequest'], role: 'Consultant', requestedHoursAgo: 1 });
  const g5 = await grant({ patient: amina, providerID: 'dr-aisha', recordsAt: D.W, scope: ['Encounter'], role: 'Physician', approve: 3 * DAY, revoke: true, requestedHoursAgo: 150 });
  await accessed(amina, 'dr-aisha', D.W, g5, 148);
  const g6 = await grant({ patient: amina, providerID: 'nurse-grace', recordsAt: D.P, scope: ['Observation'], role: 'Nurse', approve: 60, requestedHoursAgo: 96 });
  await accessed(amina, 'nurse-grace', D.P, g6, 95);
  if (ledger.grants) {
    // Simulated ledger only: let this one run out, to show an EXPIRED grant.
    const g = ledger.grants.get(g6);
    g.grantedAt = ago(95);
    g.expiresAt = ago(94);
  }
  // Suspended clinician still holding a grant: the gateway refuses it.
  await grant({ patient: amina, providerID: 'dr-yakubu', recordsAt: D.J, role: 'Physician', approve: 7 * DAY, requestedHoursAgo: 40 });
  // Standing share: every Langtang clinician may see her Plateau Specialist records.
  await grant({ patient: amina, providerID: `hospital-staff@${D.L}`, recordsAt: D.P, purpose: 'Continuity of care', approve: 30 * DAY, requestedHoursAgo: 200 });
  // THE emergency: unresponsive, rushed to Langtang; her husband gives her
  // JUTH number; Dr. Musa opens her JUTH emergency records. Active now.
  await breakGlass({
    patient: amina, providerID: 'dr-musa', recordsAt: D.J,
    justification: 'Brought in unresponsive after collapsing at home; needed allergies, current medication and cardiac history from JUTH',
    representative: { name: 'Musa Yusuf', relationship: 'Husband', phone: '+234 803 555 0142' },
  });

  // ── Ibrahim: network Langtang, JUTH ──
  const g7 = await grant({ patient: ibrahim, providerID: 'lab-sani', recordsAt: D.J, scope: ['Observation'], role: 'Laboratory Scientist', approve: 2 * DAY, requestedHoursAgo: 20 });
  await accessed(ibrahim, 'lab-sani', D.J, g7, 19);
  const g8 = await grant({ patient: ibrahim, providerID: 'dr-bello', recordsAt: D.L, role: 'Consultant', approve: 7 * DAY, requestedHoursAgo: 30 });
  await accessed(ibrahim, 'dr-bello', D.L, g8, 28);
  await grant({ patient: ibrahim, providerID: 'dr-musa', recordsAt: D.J, scope: ['Encounter', 'Observation', 'DiagnosticReport', 'MedicationRequest'], role: 'Physician', requestedHoursAgo: 1 });

  // ── Fatima: network Wase, Our Lady of Apostles ──
  const g10 = await grant({ patient: fatima, providerID: 'dr-chukwu', recordsAt: D.O, role: 'Physician', approve: 2 * DAY, requestedHoursAgo: 60 });
  await accessed(fatima, 'dr-chukwu', D.O, g10, 59);
  await accessed(fatima, 'dr-chukwu', D.O, g10, 33);
  await grant({ patient: fatima, providerID: `hospital-staff@${D.O}`, recordsAt: D.W, purpose: 'Continuity of care', approve: 30 * DAY, requestedHoursAgo: 200 });
  // A past emergency at Wase using her OLA records: extended once, then reviewed by OLA.
  const bg2 = await breakGlass({
    patient: fatima, providerID: 'dr-chukwu', recordsAt: D.O, hoursAgo: 90,
    justification: 'Road traffic accident, sedated for surgery; needed allergy and asthma history',
    representative: { name: 'Hadiza Bello', relationship: 'Sister', phone: '' },
  });
  const extRef = ctx.emergencyDetails ? ctx.emergencyDetails.put(bg2, 'extension', { reason: 'Still in theatre; anaesthetist needs asthma history' }) : 'Still in theatre';
  await ledger.extendBreakGlass({ grantID: bg2, providerID: 'dr-chukwu', reason: extRef, minutes: 60 });
  await audit(fatima.did, 'BREAK_GLASS_EXTENDED', 'dr-chukwu', D.O, `Emergency access extended by 60 min; reason recorded off-chain (${String(extRef).slice(0, 19)})`, 89);
  await ledger.reviewBreakGlass({ grantID: bg2, reviewerID: 'admin-ola', notes: 'Justified: emergency surgery, patient sedated, sister present.' });
  await audit(fatima.did, 'BREAK_GLASS_REVIEWED', 'admin-ola', D.O, 'Reviewed by Our Lady of Apostles Hospital: Justified: emergency surgery, patient sedated, sister present.', 80);
  if (ledger.grants) {
    const g = ledger.grants.get(bg2);
    g.grantedAt = ago(90);
    g.requestedAt = ago(90);
    g.expiresAt = ago(88);
  }
  return true;
}

async function runDemoSeed(ctx) {
  const { logger } = ctx;
  seedHospitals(ctx);
  seedPeople(ctx);
  seedRecords(ctx);
  const patients = resolvePatients(ctx);
  const ledger = await ctx.ledgerPromise;
  if (ctx.cipher) ctx.emergencyDetails = new EmergencyDetails({ db: ctx.db, cipher: ctx.cipher });
  if (ctx.listenerManager) await ctx.listenerManager.syncAll();
  seedHl7Inbox(ctx);
  const fresh = await seedLedger({ ...ctx, ledger }, patients);
  if (fresh) seedScreenshots({ db: ctx.db, ledger }, patients);
  if (ctx.listenerManager) await ctx.listenerManager.syncAll();
  logger.info(`demo data ${fresh ? 'loaded' : 'already present'} (see docs/demo-guide.md; DEMO_SEED=off to disable)`);
}

module.exports = { runDemoSeed };
