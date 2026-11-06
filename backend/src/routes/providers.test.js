'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestServer } = require('../testutil/testServer');

test('POST /api/providers/register requires providerID and hospitalID', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/providers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerID: 'dr-adeyemi' }),
    });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

test('a registered provider is retrievable both by hospital roster and by direct lookup', async () => {
  const server = await createTestServer();
  try {
    const registered = await fetch(`${server.baseUrl}/api/providers/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerID: 'dr-adeyemi', hospitalID: 'HospitalA-Lagos', name: 'Dr. Adeyemi' }),
    });
    assert.equal(registered.status, 201);

    const roster = await fetch(`${server.baseUrl}/api/providers/hospital/HospitalA-Lagos`);
    const rosterBody = await roster.json();
    assert.equal(rosterBody.length, 1);
    assert.equal(rosterBody[0].name, 'Dr. Adeyemi');

    const direct = await fetch(`${server.baseUrl}/api/providers/HospitalA-Lagos/dr-adeyemi`);
    assert.equal(direct.status, 200);
  } finally {
    await server.close();
  }
});

test('GET /api/providers/:hospitalID/:providerID returns 404 for an unregistered provider', async () => {
  const server = await createTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/providers/HospitalA-Lagos/dr-unknown`);
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});
