'use strict';

// Encryption at rest, PHI-redacting logs, and the production config gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { FieldCipher } = require('./fieldCipher');
const { createLogger } = require('../logger');
const { loadConfig, productionProblems } = require('../config');

const key = () => crypto.randomBytes(32).toString('base64');

test('field cipher round-trips, uses a fresh IV per value, and detects tampering', () => {
  const c = FieldCipher.fromSpec(`k1:${key()}`);
  const a = c.encrypt('Amina Bello');
  const b = c.encrypt('Amina Bello');
  assert.notEqual(a, b);
  assert.equal(c.decrypt(a), 'Amina Bello');
  const parts = a.split('.');
  parts[4] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => c.decrypt(parts.join('.')));
});

test('key rotation: a new active key still decrypts values made with the old one', () => {
  const oldKey = key();
  const before = FieldCipher.fromSpec(`old:${oldKey}`);
  const token = before.encrypt('secret');
  const after = FieldCipher.fromSpec(`new:${key()},old:${oldKey}`);
  assert.equal(after.decrypt(token), 'secret');
  assert.equal(after.needsRotation(token), true);
  assert.equal(after.needsRotation(after.encrypt('x')), false);
});

test('malformed key rings are refused', () => {
  assert.throws(() => FieldCipher.fromSpec('nocolon'));
  assert.throws(() => FieldCipher.fromSpec(`k1:${Buffer.alloc(16).toString('base64')}`), /32 bytes/);
  assert.throws(() => FieldCipher.fromSpec(''), /empty/);
});

test('the logger redacts PHI fields, masks DIDs and strips HL7 segments', () => {
  const lines = [];
  const log = createLogger({ write: (_lvl, line) => lines.push(JSON.parse(line)) });
  log.info('linked did:patientchain:0f8fad5b-d9cb-469f-a165-70867728950e', {
    name: 'Amina Bello',
    dob: '1990-04-12',
    hospitalNumber: 'LAG-1',
    nested: { justification: 'unconscious', grantID: 'g-1' },
    raw: 'MSH|^~\\&|A|B',
    note: 'PID|1||LAG-1||BELLO^AMINA',
  });
  const out = JSON.stringify(lines[0]);
  for (const secret of ['Amina', '1990-04-12', 'LAG-1', 'unconscious', 'BELLO', '0f8fad5b']) {
    assert.ok(!out.includes(secret), `log line leaked "${secret}"`);
  }
  assert.equal(lines[0].nested.grantID, 'g-1', 'non-PHI fields are kept');
  assert.match(lines[0].msg, /did:patientchain:…28950e/);
});

test('production refuses demo settings and accepts a complete configuration', () => {
  const demo = loadConfig({ NODE_ENV: 'production' });
  const problems = productionProblems(demo);
  assert.ok(problems.length >= 5);

  const prod = loadConfig({
    NODE_ENV: 'production',
    LEDGER_MODE: 'fabric',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example/realms/hospital-a',
    OIDC_AUDIENCE: 'patientchain',
    DATA_ENCRYPTION_KEYS: `k1:${key()}`,
    CORS_ORIGINS: 'https://patientchain.hospital-a.example',
    TRUST_PROXY: '1',
    METRICS_TOKEN: 'x'.repeat(32),
  });
  assert.deepEqual(productionProblems(prod), []);

  const wildcard = loadConfig({ ...process.env, NODE_ENV: 'production', CORS_ORIGINS: '*' });
  assert.ok(productionProblems(wildcard).some((p) => p.includes('CORS')));
  assert.deepEqual(productionProblems(loadConfig({ NODE_ENV: 'development' })), []);
});
