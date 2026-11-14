'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

test('GET /api/hospitals/directory returns the full hospital list', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/hospitals/directory`);
    assert.equal(res.status, 200);
    const hospitals = await res.json();
    assert.ok(Array.isArray(hospitals));
    assert.ok(hospitals.length > 0, 'directory should have at least one hospital');
    assert.ok(hospitals[0].hospitalID, 'each hospital must have a hospitalID');
    assert.ok(hospitals[0].name, 'each hospital must have a name');
  } finally {
    await server.close();
  }
});

test('GET /api/hospitals/directory?q=langtang filters by name', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/hospitals/directory?q=langtang`);
    assert.equal(res.status, 200);
    const hospitals = await res.json();
    assert.ok(hospitals.every(h => h.name.toLowerCase().includes('langtang')));
  } finally {
    await server.close();
  }
});

test('GET /api/hospitals/directory?q=wase filters by name', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/hospitals/directory?q=wase`);
    const hospitals = await res.json();
    assert.ok(hospitals.length >= 1);
    assert.ok(hospitals[0].name.toLowerCase().includes('wase'));
  } finally {
    await server.close();
  }
});

test('GET /api/hospitals/directory?q=nonexistent returns empty array', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/hospitals/directory?q=xyznonexistent`);
    const hospitals = await res.json();
    assert.equal(hospitals.length, 0);
  } finally {
    await server.close();
  }
});

test('GET /api/hospitals/directory searches location and type too', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/hospitals/directory?q=plateau`);
    const hospitals = await res.json();
    // Should match hospitals with "Plateau" in location or name
    assert.ok(hospitals.length > 0, 'searching by location should return results');
  } finally {
    await server.close();
  }
});

test('GET /api/hospitals/status requires admin role (returns 403 for patients in local auth)', async () => {
  const server = await createTestServer({ authMode: 'local' });
  try {
    const token = await server.login({ subject: 'patient1', role: 'patient' });
    const res = await fetch(`${server.baseUrl}/api/hospitals/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await server.close();
  }
});
