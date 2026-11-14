'use strict';

const crypto = require('crypto');

/**
 * emergencyDetails.js — the off-chain part of an emergency (break-glass)
 * access (Section 3.4.7).
 *
 * The clinician's justification, the family member or representative who
 * asked (NHA 2014 s.26(2)(d)), and every extension reason are free text
 * that may contain clinical or personal details. They are kept here,
 * encrypted, and the ledger stores only "sha256:<hash>" of each note. The
 * blockchain therefore proves that a reason was given, when, and that it
 * has not been altered since, without replicating it on every hospital's
 * ledger forever. A random salt in each note stops anyone guessing its
 * contents (e.g. a phone number) from the hash.
 */
const PREFIX = 'sha256:';

class EmergencyDetails {
  constructor({ db, cipher }) {
    this.cipher = cipher;
    this.insert = db.prepare('INSERT OR IGNORE INTO emergency_notes (hash, grant_id, kind, details_enc, created_at) VALUES (?, ?, ?, ?, ?)');
    this.byHash = db.prepare('SELECT details_enc FROM emergency_notes WHERE hash = ?');
  }

  /** Cleans the optional representative fields; null if none were given. */
  static clean(rep) {
    if (!rep || typeof rep !== 'object') return null;
    const name = String(rep.name || '').trim().slice(0, 120);
    const relationship = String(rep.relationship || '').trim().slice(0, 60);
    const phone = String(rep.phone || '').trim().slice(0, 30);
    if (!name && !relationship && !phone) return null;
    if (phone && !/^[+\d][\d\s()-]{5,}$/.test(phone)) throw Object.assign(new Error('representative phone number is not valid'), { status: 400 });
    return { name, relationship, phone };
  }

  /** Stores a note; returns the "sha256:<hash>" reference to put on-chain. */
  put(grantID, kind, payload) {
    const record = { grantID, kind, ...payload, salt: crypto.randomBytes(16).toString('hex'), recordedAt: new Date().toISOString() };
    const hash = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
    this.insert.run(hash, grantID, kind, this.cipher.encryptJson(record), record.recordedAt);
    return `${PREFIX}${hash}`;
  }

  /** The note behind an on-chain reference, with `verified` = its hash still matches. */
  get(ref) {
    if (typeof ref !== 'string' || !ref.startsWith(PREFIX)) return null;
    const hash = ref.slice(PREFIX.length);
    const row = this.byHash.get(hash);
    if (!row) return { missing: true, verified: false };
    const record = this.cipher.decryptJson(row.details_enc);
    const ok = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex') === hash;
    const { salt, ...shown } = record;
    return { ...shown, verified: ok };
  }

  /** A grant as the ledger returns it, with its off-chain notes filled in for display. */
  enrich(grant) {
    if (!grant || grant.grantType !== 'BREAK_GLASS') return grant;
    const out = { ...grant };
    const note = this.get(grant.justification);
    if (note) {
      out.justificationRef = grant.justification;
      out.justification = note.missing ? '(reason recorded off-chain at another site)' : note.justification;
      out.justificationVerified = note.verified;
      out.representative = note.representative ? { ...note.representative, verified: note.verified } : null;
    }
    out.extensions = (grant.extensions || []).map((x) => {
      const n = this.get(x.reason);
      return n ? { ...x, reasonRef: x.reason, reason: n.missing ? '(recorded off-chain)' : n.reason, verified: n.verified } : x;
    });
    return out;
  }
}

module.exports = { EmergencyDetails, PREFIX };
