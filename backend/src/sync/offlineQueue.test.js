'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const { OfflineQueue } = require('./offlineQueue');

function newQueue() {
  const dbPath = path.join(os.tmpdir(), `patientchain-offlinequeue-test-${randomUUID()}.sqlite`);
  const queue = new OfflineQueue(dbPath);
  return {
    queue,
    cleanup() {
      queue.db.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    },
  };
}

test('a fresh queue starts connected and empty', () => {
  const { queue, cleanup } = newQueue();
  try {
    assert.equal(queue.isConnected(), true);
    assert.deepEqual(queue.getQueued(), []);
  } finally {
    cleanup();
  }
});

test('enqueue persists an action as QUEUED and getQueued returns it in chronological order', () => {
  const { queue, cleanup } = newQueue();
  try {
    const first = queue.enqueue('REQUEST_ACCESS', { grantID: 'g1' });
    const second = queue.enqueue('GRANT_ACCESS', { grantID: 'g1', durationMinutes: 30 });

    const queued = queue.getQueued();
    assert.equal(queued.length, 2);
    assert.equal(queued[0].id, first.id);
    assert.equal(queued[1].id, second.id);
    assert.equal(queued[0].status, 'QUEUED');
    assert.deepEqual(queued[0].payload, { grantID: 'g1' });
  } finally {
    cleanup();
  }
});

test('setConnected(true) after being disconnected fires the onReconnect callback exactly once', () => {
  const { queue, cleanup } = newQueue();
  try {
    let reconnectCount = 0;
    queue.setConnected(false);
    queue.setConnected(true, () => reconnectCount++);
    assert.equal(reconnectCount, 1);

    // Already connected -- flipping to connected again must not re-fire.
    queue.setConnected(true, () => reconnectCount++);
    assert.equal(reconnectCount, 1);
  } finally {
    cleanup();
  }
});

test('reconcile replays queued actions chronologically against the ledger and marks them SYNCED', async () => {
  const { queue, cleanup } = newQueue();
  try {
    queue.enqueue('REQUEST_ACCESS', { grantID: 'g1', patientDID: 'did:p1', providerID: 'prov-1', hospitalID: 'HospitalA' });
    queue.enqueue('GRANT_ACCESS', { grantID: 'g1', durationMinutes: 30 });

    const calls = [];
    const fakeLedger = {
      requestAccess: async (payload) => {
        calls.push(['requestAccess', payload]);
        return { grantID: payload.grantID, status: 'PENDING' };
      },
      grantAccess: async (payload) => {
        calls.push(['grantAccess', payload]);
        return { grantID: payload.grantID, status: 'ACTIVE' };
      },
    };

    const results = await queue.reconcile(fakeLedger);

    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.status === 'SYNCED'));
    assert.deepEqual(calls.map((c) => c[0]), ['requestAccess', 'grantAccess'], 'actions must replay in the order they were queued');
    assert.deepEqual(queue.getQueued(), [], 'synced actions must no longer show up as queued');
  } finally {
    cleanup();
  }
});

test('reconcile marks a failing action FAILED without losing or duplicating the others', async () => {
  const { queue, cleanup } = newQueue();
  try {
    queue.enqueue('REQUEST_ACCESS', { grantID: 'will-fail' });
    queue.enqueue('GRANT_ACCESS', { grantID: 'will-succeed', durationMinutes: 15 });

    const fakeLedger = {
      requestAccess: async () => {
        throw new Error('ledger unavailable');
      },
      grantAccess: async (payload) => ({ grantID: payload.grantID, status: 'ACTIVE' }),
    };

    const results = await queue.reconcile(fakeLedger);
    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'FAILED');
    assert.match(results[0].error, /ledger unavailable/);
    assert.equal(results[1].status, 'SYNCED');

    // The failed item must remain queued for a later retry, not silently dropped.
    const stillQueued = queue.getQueued();
    assert.equal(stillQueued.length, 1);
    assert.equal(stillQueued[0].payload.grantID, 'will-fail');
  } finally {
    cleanup();
  }
});

test('a revoke replayed from the offline queue writes an audit entry flagged queuedOffline', async () => {
  const { queue, cleanup } = newQueue();
  try {
    queue.enqueue('REVOKE_ACCESS', { grantID: 'g1', patientDID: 'did:p1', hospitalID: 'HospitalA', actorID: 'did:p1' });

    const auditCalls = [];
    const fakeLedger = {
      revokeAccess: async (payload) => ({ grantID: payload.grantID, status: 'REVOKED' }),
      writeAuditEntry: async (entry) => {
        auditCalls.push(entry);
        return entry;
      },
    };

    await queue.reconcile(fakeLedger);

    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].eventType, 'GRANT_REVOKED');
    assert.equal(auditCalls[0].queuedOffline, true, 'the audit trail must record that this write was delayed by an offline period');
  } finally {
    cleanup();
  }
});

test('reconcile rejects an unrecognised queued action type', async () => {
  const { queue, cleanup } = newQueue();
  try {
    queue.enqueue('SOMETHING_UNKNOWN', {});
    const results = await queue.reconcile({});
    assert.equal(results[0].status, 'FAILED');
    assert.match(results[0].error, /unknown queued action type/);
  } finally {
    cleanup();
  }
});
