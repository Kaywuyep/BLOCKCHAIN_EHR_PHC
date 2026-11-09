'use strict';

const { randomUUID } = require('crypto');
const { parseHl7Message, ingestParsedMessage } = require('./hl7AdtListener');

/**
 * hl7Inbox.js
 *
 * Durable store-then-process pipeline for HL7 v2 messages, shared by the
 * MLLP listener and the HTTP route:
 *
 *   1. Parse. Unparseable text is kept as REJECTED (for investigation) and
 *      answered with AR.
 *   2. Duplicate check on (hospital, MSH-10 message control ID). A resend
 *      of a message already stored is answered AA and not applied twice;
 *      interface engines resend whenever they miss an ACK.
 *   3. Persist the raw message, encrypted, as RECEIVED. Only after this
 *      write succeeds can the message be acknowledged: if the database is
 *      down the sender gets AE and keeps the message on its side.
 *   4. Process it into the FHIR adapter.
 *        - success                       -> PROCESSED, AA
 *        - message content is unusable   -> REJECTED,  AR (resending won't help)
 *        - unexpected error while saving -> FAILED,    AA, retried later
 *   5. A timer retries FAILED messages with exponential backoff. After
 *      HL7_MAX_ATTEMPTS failures a message becomes DEAD (the dead-letter
 *      queue): alert on it, fix the cause, then replay it from the admin API.
 *   6. On startup, recover() reprocesses anything left RECEIVED by a crash.
 */

const STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  PROCESSED: 'PROCESSED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  DEAD: 'DEAD',
});

class Hl7Inbox {
  /**
   * @param {object} options
   * @param {import('better-sqlite3').Database} options.db
   * @param {import('../db/fieldCipher').FieldCipher} options.cipher
   * @param {import('./fhirAdapter').FhirAdapter} options.fhirAdapter
   * @param {(hospitalID: string) => object} [options.hospitalOptions]  per-hospital { fieldMap }
   * @param {(hospitalID: string, result: object) => void} [options.onResult]
   */
  constructor({ db, cipher, fhirAdapter, hospitalOptions = () => ({}), onResult = () => {}, log = console, maxAttempts = 5, retryIntervalMs = 30000 }) {
    this.db = db;
    this.cipher = cipher;
    this.fhirAdapter = fhirAdapter;
    this.hospitalOptions = hospitalOptions;
    this.onResult = onResult;
    this.log = log;
    this.maxAttempts = maxAttempts;
    this.retryIntervalMs = retryIntervalMs;
    this._timer = null;
    const q = (sql) => db.prepare(sql);
    this.sql = {
      findByControlId: q('SELECT id, status FROM hl7_messages WHERE hospital_id = ? AND control_id = ?'),
      insert: q(`INSERT INTO hl7_messages (id, hospital_id, control_id, message_type, raw_enc, status, attempts, last_error, received_at)
                 VALUES (@id, @hospitalID, @controlId, @messageType, @rawEnc, @status, 0, @lastError, @receivedAt)`),
      get: q('SELECT * FROM hl7_messages WHERE id = ?'),
      setStatus: q(`UPDATE hl7_messages SET status = @status, attempts = @attempts, last_error = @lastError,
                    processed_at = @processedAt, next_attempt_at = @nextAttemptAt WHERE id = @id`),
      due: q(`SELECT * FROM hl7_messages WHERE status = 'FAILED' AND next_attempt_at <= ? ORDER BY received_at LIMIT 100`),
      byStatus: q(`SELECT * FROM hl7_messages WHERE status = ? ORDER BY received_at LIMIT 1000`),
      counts: q('SELECT status, COUNT(*) AS n FROM hl7_messages GROUP BY status'),
      oldestPending: q(`SELECT MIN(received_at) AS t FROM hl7_messages WHERE status IN ('RECEIVED', 'FAILED')`),
    };
  }

  /**
   * Receives one raw HL7 message. Never throws.
   * @returns {{ ack: 'AA'|'AR'|'AE', id?: string, status?: string, duplicate?: boolean, result?: object, reason?: string }}
   */
  receive(hospitalID, rawText) {
    let message;
    try {
      message = parseHl7Message(rawText);
    } catch (err) {
      const id = this._tryInsert(hospitalID, null, null, rawText, STATUS.REJECTED, `unparseable HL7 message: ${err.message}`);
      this.log.warn(`[hl7Inbox] ${hospitalID}: unparseable message rejected (${id || 'not stored'})`);
      return { ack: 'AR', id, status: STATUS.REJECTED, reason: `unparseable HL7 message: ${err.message}` };
    }

    const controlId = message.get('MSH.10').toString() || null;
    const messageType = [message.get('MSH.9.1').toString(), message.get('MSH.9.2').toString()].filter(Boolean).join('^');

    try {
      if (controlId) {
        const existing = this.sql.findByControlId.get(hospitalID, controlId);
        if (existing) {
          this.log.log(`[hl7Inbox] ${hospitalID}: duplicate control ID ${controlId}, not reprocessed`);
          const ack = existing.status === STATUS.REJECTED ? 'AR' : 'AA';
          return { ack, id: existing.id, status: existing.status, duplicate: true };
        }
      }
    } catch (err) {
      this.log.error(`[hl7Inbox] ${hospitalID}: store unavailable: ${err.message}`);
      return { ack: 'AE', reason: 'message store unavailable, resend later' };
    }

    const id = this._tryInsert(hospitalID, controlId, messageType, rawText, STATUS.RECEIVED, null);
    if (!id) return { ack: 'AE', reason: 'message store unavailable, resend later' };

    return this._process(this.sql.get.get(id), message);
  }

  _tryInsert(hospitalID, controlId, messageType, rawText, status, lastError) {
    const id = randomUUID();
    try {
      this.sql.insert.run({
        id,
        hospitalID,
        controlId,
        messageType,
        rawEnc: this.cipher.encrypt(rawText),
        status,
        lastError,
        receivedAt: new Date().toISOString(),
      });
      return id;
    } catch (err) {
      if (/UNIQUE/.test(err.message) && controlId) {
        // Lost a race with a concurrent resend of the same message.
        return this.sql.findByControlId.get(hospitalID, controlId)?.id || null;
      }
      this.log.error(`[hl7Inbox] ${hospitalID}: could not store message: ${err.message}`);
      return null;
    }
  }

  _process(row, parsed) {
    const attempts = row.attempts + 1;
    let result;
    try {
      const message = parsed || parseHl7Message(this.cipher.decrypt(row.raw_enc));
      result = ingestParsedMessage(this.fhirAdapter, row.hospital_id, message, {
        log: this.log,
        ...this.hospitalOptions(row.hospital_id),
      });
    } catch (err) {
      const dead = attempts >= this.maxAttempts;
      const backoff = this.retryIntervalMs * 2 ** (attempts - 1);
      this._setStatus(row.id, {
        status: dead ? STATUS.DEAD : STATUS.FAILED,
        attempts,
        lastError: err.message,
        nextAttemptAt: dead ? null : new Date(Date.now() + backoff).toISOString(),
      });
      this.log.error(`[hl7Inbox] ${row.hospital_id}: message ${row.id} failed (attempt ${attempts}): ${err.message}${dead ? ' -- moved to dead-letter queue' : ''}`);
      this._notify(row.hospital_id, { ok: false, reason: err.message });
      // Stored durably, so the sender must not resend: acknowledge receipt.
      return { ack: 'AA', id: row.id, status: dead ? STATUS.DEAD : STATUS.FAILED, reason: err.message };
    }

    if (result.ok) {
      this._setStatus(row.id, { status: STATUS.PROCESSED, attempts, lastError: null, processedAt: new Date().toISOString() });
      this._notify(row.hospital_id, result);
      return { ack: 'AA', id: row.id, status: STATUS.PROCESSED, result };
    }
    this._setStatus(row.id, { status: STATUS.REJECTED, attempts, lastError: result.reason, processedAt: new Date().toISOString() });
    this._notify(row.hospital_id, result);
    return { ack: 'AR', id: row.id, status: STATUS.REJECTED, result, reason: result.reason };
  }

  _setStatus(id, { status, attempts, lastError = null, processedAt = null, nextAttemptAt = null }) {
    this.sql.setStatus.run({ id, status, attempts, lastError, processedAt, nextAttemptAt });
  }

  _notify(hospitalID, result) {
    try {
      this.onResult(hospitalID, result);
    } catch (err) {
      this.log.warn(`[hl7Inbox] status callback failed: ${err.message}`);
    }
  }

  /** Retries FAILED messages whose backoff has elapsed. */
  retryDue(now = new Date()) {
    return this.sql.due.all(now.toISOString()).map((row) => this._process(row));
  }

  /** Reprocesses messages left RECEIVED by a crash or restart. */
  recover() {
    const rows = this.sql.byStatus.all(STATUS.RECEIVED);
    if (rows.length) this.log.log(`[hl7Inbox] recovering ${rows.length} message(s) received before restart`);
    return rows.map((row) => this._process(row));
  }

  /** Manually reprocesses one message (e.g. a DEAD one after fixing its cause). */
  replay(id) {
    const row = this.sql.get.get(id);
    if (!row) throw new Error('message not found');
    if (row.status === STATUS.PROCESSED) throw new Error('message was already processed');
    return this._process({ ...row, attempts: 0 });
  }

  /** One message's metadata, or null. */
  get(id) {
    const row = this.sql.get.get(id);
    return row ? Hl7Inbox._meta(row) : null;
  }

  static _meta(r) {
    return {
      id: r.id,
      hospitalID: r.hospital_id,
      controlId: r.control_id,
      messageType: r.message_type,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      receivedAt: r.received_at,
      processedAt: r.processed_at,
      nextAttemptAt: r.next_attempt_at,
    };
  }

  /** Message metadata only; the raw (PHI-bearing) text is never returned. */
  list({ status, hospitalID } = {}) {
    const rows = status ? this.sql.byStatus.all(status) : this.db.prepare('SELECT * FROM hl7_messages ORDER BY received_at DESC LIMIT 1000').all();
    return rows
      .filter((r) => !hospitalID || r.hospital_id === hospitalID)
      .map(Hl7Inbox._meta);
  }

  stats() {
    const counts = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
    for (const { status, n } of this.sql.counts.all()) counts[status] = n;
    const oldest = this.sql.oldestPending.get().t;
    return { counts, oldestPendingAgeSeconds: oldest ? Math.round((Date.now() - Date.parse(oldest)) / 1000) : 0 };
  }

  start() {
    if (this._timer) return;
    this.recover();
    this._timer = setInterval(() => {
      try {
        this.retryDue();
      } catch (err) {
        this.log.error(`[hl7Inbox] retry sweep failed: ${err.message}`);
      }
    }, Math.min(this.retryIntervalMs, 30000));
    this._timer.unref();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { Hl7Inbox, HL7_STATUS: STATUS };
