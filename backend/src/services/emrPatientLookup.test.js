'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const smartClinic = require('./smartClinicClient');
const { refreshFromEmr } = require('./emrPatientLookup');
const { FhirAdapter } = require('./fhirAdapter');

const hospital = { hospitalID: 'h1', status: 'active', integration: 'smartclinic', smartclinic: { baseUrl: 'http://emr.invalid/' } };
const hospitalRegistry = { getInternal: () => hospital };

test('refreshFromEmr gives up on a slow EMR at its deadline and keeps the roster held', async (t) => {
  t.mock.method(smartClinic, 'findPatient', () => new Promise(() => {})); // never answers
  const fhirAdapter = new FhirAdapter();
  fhirAdapter.addLocalPatientRecord('h1', 'N-1', { name: 'Old Name' });
  const warnings = [];
  const started = Date.now();
  const ok = await refreshFromEmr({ hospitalRegistry, fhirAdapter, logger: { warn: (m, d) => warnings.push(d) }, timeoutMs: 50 }, 'h1', 'N-1');
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 1000);
  assert.match(warnings[0].err, /within 0.05s/);
  assert.equal(fhirAdapter.findLocalPatientRecord('h1', 'N-1').name, 'Old Name');
});

test('refreshFromEmr updates the roster when the EMR answers in time', async (t) => {
  t.mock.method(smartClinic, 'findPatient', async () => ({ hospitalNumber: 'N-2', name: 'Ada Bello', dob: null }));
  const fhirAdapter = new FhirAdapter();
  const ok = await refreshFromEmr({ hospitalRegistry, fhirAdapter, timeoutMs: 1000 }, 'h1', 'N-2');
  assert.equal(ok, true);
  assert.equal(fhirAdapter.findLocalPatientRecord('h1', 'N-2').name, 'Ada Bello');
});
