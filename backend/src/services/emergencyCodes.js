'use strict';

const crypto = require('crypto');

/**
 * emergencyCodes.js
 *
 * Each patient has a 7-character emergency code (shown on their Health ID
 * page, to print or keep on their phone). In an emergency a family member
 * who does not know the patient's hospital number can give the code to a
 * clinician instead. The code lists the hospitals in the patient's network;
 * the clinician picks one and break-glass proceeds as usual (Section 3.4.7).
 *
 * Alphabet: Crockford base32 (no I, L, O, U), so a code read over the phone
 * is unambiguous; input is forgiving (O->0, I/L->1, spaces and dashes
 * ignored). 32^7 is about 34 billion codes, and wrong guesses lock a
 * clinician out after MAX_FAILS (see attempts()).
 *
 * Only a keyed hash is used for lookup; the code itself is stored
 * encrypted so the patient can see it again. The patient can replace it
 * at any time, which makes the old one stop working.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 7;
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;

class EmergencyCodeError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

/** Upper-cases and maps look-alike characters; null if it cannot be a code. */
function normalize(input) {
  const s = String(input || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  if (s.length !== LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

/** Shown as one 7-character block, e.g. "K7M4QX9". */
const format = (code) => code;

function generate() {
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

class EmergencyCodes {
  constructor({ db, cipher }) {
    this.db = db;
    this.cipher = cipher;
    const key = cipher && cipher.keys ? cipher.keys.get(cipher.activeKid) : crypto.randomBytes(32);
    this.key = crypto.createHmac('sha256', key).update('cevruni-emergency-code-v1').digest();
    this.fails = new Map(); // clinician -> { count, since, lockedUntil }
    this.sql = {
      byPatient: db.prepare('SELECT * FROM emergency_codes WHERE patient_did = ?'),
      byHash: db.prepare('SELECT * FROM emergency_codes WHERE code_hash = ?'),
      put: db.prepare(
        `INSERT INTO emergency_codes (patient_did, code_hash, code_enc, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (patient_did) DO UPDATE SET code_hash = excluded.code_hash, code_enc = excluded.code_enc, created_at = excluded.created_at`
      ),
    };
  }

  _hash(code) {
    return crypto.createHmac('sha256', this.key).update(code).digest('hex');
  }

  _store(patientDID, code) {
    this.sql.put.run(patientDID, this._hash(code), this.cipher.encrypt(code), new Date().toISOString());
  }

  /** The patient's code, created on first use. */
  get(patientDID) {
    let row = this.sql.byPatient.get(patientDID);
    if (!row) {
      this._replace(patientDID);
      row = this.sql.byPatient.get(patientDID);
    }
    const code = this.cipher.decrypt(row.code_enc);
    return { code, display: format(code), createdAt: row.created_at };
  }

  /** A new code; the old one stops working at once. */
  regenerate(patientDID) {
    this._replace(patientDID);
    return this.get(patientDID);
  }

  _replace(patientDID) {
    for (let i = 0; i < 10; i += 1) {
      const code = generate();
      if (this.sql.byHash.get(this._hash(code))) continue;
      this._store(patientDID, code);
      return;
    }
    throw new Error('could not generate a unique emergency code');
  }

  /** Development demo only: a fixed, documented code. */
  setForDemo(patientDID, code) {
    const c = normalize(code);
    if (!c) throw new Error(`bad demo code ${code}`);
    const owner = this.sql.byHash.get(this._hash(c));
    if (owner && owner.patient_did !== patientDID) return;
    this._store(patientDID, c);
  }

  /**
   * The patient a code belongs to, for clinician `who`. Wrong codes count
   * towards a lock-out (MAX_FAILS within WINDOW_MS locks for WINDOW_MS).
   */
  resolve(input, who) {
    const now = Date.now();
    const f = this.fails.get(who);
    if (f && f.lockedUntil > now) {
      throw new EmergencyCodeError(`too many wrong emergency codes; try again after ${new Date(f.lockedUntil).toLocaleTimeString('en-NG')}, or use the hospital number`, 429);
    }
    const code = normalize(input);
    const row = code ? this.sql.byHash.get(this._hash(code)) : null;
    if (!row) {
      const cur = f && now - f.since < WINDOW_MS ? f : { count: 0, since: now, lockedUntil: 0 };
      cur.count += 1;
      if (cur.count >= MAX_FAILS) cur.lockedUntil = now + WINDOW_MS;
      this.fails.set(who, cur);
      const left = Math.max(0, MAX_FAILS - cur.count);
      throw new EmergencyCodeError(
        left ? `no patient has that emergency code (${left} attempt${left === 1 ? '' : 's'} left)` : 'no patient has that emergency code; emergency-code lookups are locked for 15 minutes',
        left ? 404 : 429,
        { attemptsLeft: left }
      );
    }
    this.fails.delete(who);
    return row.patient_did;
  }
}

module.exports = { EmergencyCodes, EmergencyCodeError, normalize, format, ALPHABET, LENGTH, MAX_FAILS };
