'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { randomUUID } = require('crypto');

/**
 * offlineQueue.js
 *
 * Implements the offline-first synchronisation protocol from Section 3.6
 * / Figure 5: access-grant actions are queued locally (here, SQLite
 * standing in for the patient app's on-device cache) whenever the ledger
 * is unreachable, then replayed chronologically once connectivity
 * returns, with an audit entry written for every action including those
 * that were queued -- so the audit trail reflects the true event
 * timeline, not the connectivity timeline.
 *
 * connectivityState is toggled by the /api/sync/connectivity route so the
 * demo can show an "offline hospital" scenario live.
 */
class OfflineQueue {
  constructor(dbPath) {
    this.db = new Database(dbPath || path.join(__dirname, '..', '..', 'data', 'sync-queue.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queue (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        client_timestamp TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'QUEUED',
        created_at TEXT NOT NULL,
        synced_at TEXT
      );
    `);
    this.connected = true; // in-memory connectivity flag for the demo
    this.retryIntervalMs = 30000; // "i" in Section 3.5.2, default 30s per Section 3.6
    this._retryTimer = null;
  }

  setConnected(value, onReconnect) {
    const wasDisconnected = !this.connected;
    this.connected = value;
    if (value && wasDisconnected && typeof onReconnect === 'function') {
      onReconnect();
    }
  }

  isConnected() {
    return this.connected;
  }

  /** Enqueue an access-grant action generated while (possibly) offline. */
  enqueue(actionType, payload) {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO queue (id, action_type, payload, client_timestamp, status, created_at)
         VALUES (?, ?, ?, ?, 'QUEUED', ?)`
      )
      .run(id, actionType, JSON.stringify(payload), now, now);
    return { id, actionType, payload, clientTimestamp: now };
  }

  /** All actions still awaiting sync, in chronological order. */
  getQueued() {
    return this.db
      .prepare(`SELECT * FROM queue WHERE status = 'QUEUED' ORDER BY created_at ASC`)
      .all()
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  markSynced(id) {
    this.db
      .prepare(`UPDATE queue SET status = 'SYNCED', synced_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
  }

  getAll(limit = 100) {
    return this.db
      .prepare(`SELECT * FROM queue ORDER BY created_at DESC LIMIT ?`)
      .all(limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  /**
   * Replays every queued action against the ledger, chronologically,
   * writing an audit entry (queuedOffline=true) for each -- the
   * "Reconcile" -> "Commit" steps in Figure 5.
   */
  async reconcile(ledger) {
    const queued = this.getQueued();
    const results = [];
    for (const item of queued) {
      try {
        const result = await this._applyAction(ledger, item);
        this.markSynced(item.id);
        results.push({ id: item.id, status: 'SYNCED', result });
      } catch (err) {
        // A bad patient signature can never become valid on retry.
        if (err.permanent || /signature/.test(err.message)) {
          // Never valid: replaying it again would fail the same way.
          this.db.prepare(`UPDATE queue SET status = 'REJECTED', synced_at = ? WHERE id = ?`).run(new Date().toISOString(), item.id);
          results.push({ id: item.id, status: 'REJECTED', error: err.message });
        } else {
          results.push({ id: item.id, status: 'FAILED', error: err.message });
        }
      }
    }
    return results;
  }

  async _applyAction(ledger, item) {
    const { action_type: actionType, payload, client_timestamp: clientTimestamp } = item;
    // Grant/revoke queued by an authenticated patient: the ledger couldn't
    // be asked who owns the grant while offline, so check it now.
    if (payload.actorPatientDID && (actionType === 'GRANT_ACCESS' || actionType === 'REVOKE_ACCESS')) {
      const grant = await ledger.checkAccess({ grantID: payload.grantID });
      if (!grant || grant.patientDID !== payload.actorPatientDID) {
        const err = new Error('queued action rejected: the grant does not belong to the patient who queued it');
        err.permanent = true;
        throw err;
      }
    }
    if (payload.actorPatientDID && actionType === 'GRANT_ACCESS_BATCH') {
      for (const it of payload.items || []) {
        const grant = await ledger.checkAccess({ grantID: it.grantID });
        if (!grant || grant.patientDID !== payload.actorPatientDID) {
          const err = new Error('queued action rejected: a grant in the batch does not belong to the patient who queued it');
          err.permanent = true;
          throw err;
        }
      }
    }
    switch (actionType) {
      case 'GRANT_ACCESS_BATCH': {
        const grants = await ledger.grantAccessBatch(payload.items);
        for (const g of grants) {
          await ledger.writeAuditEntry({
            patientDID: g.patientDID,
            eventType: 'GRANT_ISSUED',
            actorID: g.patientDID,
            hospitalID: g.hospitalID,
            detail: `Batch approval queued while offline at ${clientTimestamp}`,
            clientTimestamp,
            queuedOffline: true,
          });
        }
        return grants;
      }
      case 'REQUEST_ACCESS':
        return ledger.requestAccess(payload);
      case 'GRANT_ACCESS':
        return ledger.grantAccess(payload);
      case 'REVOKE_ACCESS': {
        const grant = await ledger.revokeAccess(payload);
        await ledger.writeAuditEntry({
          patientDID: payload.patientDID,
          eventType: 'GRANT_REVOKED',
          actorID: payload.actorID || payload.patientDID,
          hospitalID: payload.hospitalID || '',
          detail: `Revocation queued while offline at ${clientTimestamp}`,
          clientTimestamp,
          queuedOffline: true,
        });
        return grant;
      }
      default:
        throw new Error(`unknown queued action type: ${actionType}`);
    }
  }
}

module.exports = { OfflineQueue };
