'use strict';

// HTTP hardening: security headers, body limits, CORS allowlist, rate
// limiting, probes and metrics.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestServer } = require('../testutil/testServer');

test('responses carry security headers, a request ID, and no-store caching', async () => {
  const s = await createTestServer();
  try {
    const res = await fetch(`${s.baseUrl}/api/health`);
    assert.ok(res.headers.get('x-request-id'));
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally {
    await s.close();
  }
});

test('oversized and malformed JSON bodies are refused cleanly', async () => {
  const s = await createTestServer({ env: { JSON_BODY_LIMIT: '1kb' } });
  try {
    const big = await fetch(`${s.baseUrl}/api/providers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerID: 'x'.repeat(5000), hospitalID: 'h' }),
    });
    assert.equal(big.status, 413);
    const bad = await fetch(`${s.baseUrl}/api/providers/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'malformed JSON body' });
  } finally {
    await s.close();
  }
});

test('CORS only allows listed origins', async () => {
  const s = await createTestServer({ env: { CORS_ORIGINS: 'https://app.hospital-a.example' } });
  try {
    const ok = await fetch(`${s.baseUrl}/api/health`, { headers: { origin: 'https://app.hospital-a.example' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.hospital-a.example');
    const evil = await fetch(`${s.baseUrl}/api/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.close();
  }
});

test('requests over the per-minute limit get 429', async () => {
  const s = await createTestServer({ env: { RATE_LIMIT_PER_MINUTE: '3' } });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await fetch(`${s.baseUrl}/api/cost/summary`)).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    // probes are never rate-limited
    assert.equal((await fetch(`${s.baseUrl}/api/health`)).status, 200);
  } finally {
    await s.close();
  }
});

test('readiness reports dependencies; metrics need the metrics token when one is set', async () => {
  const s = await createTestServer({ env: { METRICS_TOKEN: 'metrics-secret' } });
  try {
    const ready = await (await fetch(`${s.baseUrl}/api/ready`)).json();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.checks.database, 'ok');
    assert.equal((await fetch(`${s.baseUrl}/api/metrics`)).status, 401);
    const m = await fetch(`${s.baseUrl}/api/metrics`, { headers: { authorization: 'Bearer metrics-secret' } });
    const text = await m.text();
    assert.match(text, /patientchain_up 1/);
    assert.match(text, /patientchain_hl7_messages\{status="DEAD"\} 0/);
  } finally {
    await s.close();
  }
});

test('unknown API routes get a JSON 404 and invalid cost parameters a 400', async () => {
  const s = await createTestServer();
  try {
    const res = await fetch(`${s.baseUrl}/api/nope`);
    assert.equal(res.status, 404);
    assert.equal((await fetch(`${s.baseUrl}/api/cost/summary?b=abc`)).status, 400);
  } finally {
    await s.close();
  }
});
