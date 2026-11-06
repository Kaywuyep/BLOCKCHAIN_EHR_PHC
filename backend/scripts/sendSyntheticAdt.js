#!/usr/bin/env node
'use strict';

/**
 * scripts/sendSyntheticAdt.js
 *
 * Feeds the synthetic ADT fixtures (services/hl7AdtListener.fixtures.js)
 * through the real HTTP ingestion endpoint (POST /api/hl7/adt/:hospitalID)
 * against a freshly spun-up, isolated backend -- no real hospital feed,
 * no already-running dev server required. This is the "validate the whole
 * path end-to-end before any real vendor integration exists" check called
 * for alongside hl7AdtListener.js: run it any time with
 *
 *   node backend/scripts/sendSyntheticAdt.js
 *
 * It asserts each fixture produces the expected outcome (a specific
 * roster entry, an encounter recorded or not, or a specific rejection for
 * the deliberately-bad fixtures) and exits non-zero if anything doesn't
 * match -- safe to wire into CI later without needing a real HL7 source.
 */

const assert = require('node:assert/strict');
const { createTestServer } = require('../src/testutil/testServer');
const fixtures = require('../src/services/hl7AdtListener.fixtures');

const HOSPITAL_ID = 'synthetic-test-hospital';

const CASES = [
  {
    name: 'A01 admit',
    body: fixtures.adtA01Admit,
    expectStatus: 201,
    check: (result) => {
      assert.equal(result.ok, true);
      assert.equal(result.hospitalNumber, 'LAG-00231');
      assert.equal(result.encounterRecorded, true);
    },
  },
  {
    name: 'A08 update (same patient, same visit)',
    body: fixtures.adtA08Update,
    expectStatus: 201,
    check: (result) => {
      assert.equal(result.ok, true);
      assert.equal(result.hospitalNumber, 'LAG-00231');
    },
  },
  {
    name: 'A03 discharge',
    body: fixtures.adtA03Discharge,
    expectStatus: 201,
    check: (result) => {
      assert.equal(result.ok, true);
      assert.equal(result.hospitalNumber, 'LAG-00231');
      assert.equal(result.encounterRecorded, true);
    },
  },
  {
    name: 'A01 admit, outpatient, no attending doctor recorded',
    body: fixtures.adtA01OutpatientNoAttending,
    expectStatus: 201,
    check: (result) => {
      assert.equal(result.ok, true);
      assert.equal(result.hospitalNumber, 'LAG-00450');
    },
  },
  {
    name: 'A08 demographic-only update, no PV1 segment at all',
    body: fixtures.adtA08NoPv1,
    expectStatus: 201,
    check: (result) => {
      assert.equal(result.ok, true);
      assert.equal(result.encounterRecorded, false);
    },
  },
  {
    name: 'A01 admit with an interspersed vendor Z-segment and a garbled line',
    body: fixtures.adtA01WithUnrecognisedSegments,
    expectStatus: 201,
    check: (result) => {
      assert.equal(result.ok, true);
      assert.equal(result.hospitalNumber, 'LAG-00777');
    },
  },
  {
    name: 'not HL7 at all (expected rejection)',
    body: fixtures.notHl7AtAll,
    expectStatus: 400,
    check: (result) => {
      assert.equal(result.ok, false);
      assert.match(result.reason, /unparseable/);
    },
  },
  {
    name: 'well-formed but non-ADT message, e.g. an ORU result (expected rejection)',
    body: fixtures.oruResultNotAdt,
    expectStatus: 400,
    check: (result) => {
      assert.equal(result.ok, false);
    },
  },
];

async function main() {
  const server = await createTestServer();
  let failures = 0;

  console.log(`Feeding ${CASES.length} synthetic ADT messages through POST /api/hl7/adt/${HOSPITAL_ID} ...\n`);

  for (const testCase of CASES) {
    process.stdout.write(`  ${testCase.name} ... `);
    try {
      const res = await fetch(`${server.baseUrl}/api/hl7/adt/${HOSPITAL_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: testCase.body,
      });
      const result = await res.json();
      assert.equal(res.status, testCase.expectStatus, `expected HTTP ${testCase.expectStatus}, got ${res.status}`);
      testCase.check(result);
      console.log('PASS');
    } catch (err) {
      failures += 1;
      console.log('FAIL');
      console.log(`    ${err.message}`);
    }
  }

  console.log('\nFinal roster at', HOSPITAL_ID, '(via GET /api/patients/local-records/:hospitalID):');
  const roster = await (await fetch(`${server.baseUrl}/api/patients/local-records/${HOSPITAL_ID}`)).json();
  for (const record of roster) {
    console.log(`  ${record.hospitalNumber}  ${record.name}  DOB ${record.dob}`);
  }

  await server.close();

  if (failures > 0) {
    console.log(`\n${failures} of ${CASES.length} case(s) FAILED.`);
    process.exit(1);
  }
  console.log(`\nAll ${CASES.length} cases behaved as expected.`);
}

main().catch((err) => {
  console.error('sendSyntheticAdt.js crashed:', err);
  process.exit(1);
});
