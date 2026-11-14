'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chaincodeError } = require('./fabricLedgerService');

test('chaincode rejection in err.details becomes a readable error', () => {
  const grpc = Object.assign(new Error('10 ABORTED: failed to endorse transaction, see attached details for more info'), {
    code: 10,
    details: [{ address: 'peer0:7051', mspId: 'HospitalAMSP', message: 'chaincode response 500, grant g1 has already been reviewed' }],
  });
  const e = chaincodeError(grpc);
  assert.equal(e.message, 'grant g1 has already been reviewed');
  assert.equal(e.cause, grpc);
  assert.equal(e.code, 10);
});

test('evaluate errors carry the chaincode message in err.message', () => {
  const grpc = new Error('2 UNKNOWN: evaluate call to endorser returned error: chaincode response 500, patient did:x not found');
  assert.equal(chaincodeError(grpc).message, 'patient did:x not found');
});

test('network and timeout errors are passed through unchanged', () => {
  const grpc = Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
  assert.equal(chaincodeError(grpc), grpc);
});

const { eventTime } = require('./fabricLedgerService');

test('replayed events take the latest past time in their payload', () => {
  assert.equal(
    eventTime({ requestedAt: '2026-11-10T10:00:00.000Z', grantedAt: '2026-11-10T11:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' }),
    '2026-11-10T11:00:00.000Z'
  );
  assert.equal(eventTime({ timestamp: '2026-11-12T08:30:00.000Z', detail: 'x' }), '2026-11-12T08:30:00.000Z');
  assert.equal(eventTime({ patientDID: 'did:x' }), null);
  assert.equal(eventTime(null), null);
});
