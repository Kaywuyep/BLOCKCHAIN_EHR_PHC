'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNameResolver } = require('./nameResolver');

const providers = {
  get: (id, h) => (id === '6afc' && h === 'juth' ? { name: 'Test Doctor John', role: 'Doctor' } : null),
  registrationsOf: (id) => (id === '6afc' ? [{ name: 'Test Doctor John' }] : []),
};
const users = {
  getAccount: (s) => ({
    '6afc@juth': { displayName: 'Test Doctor John', roles: ['clinician'], providerID: '6afc', hospitalID: 'juth' },
    'pt-1': { displayName: 'Nanret Geofrey', roles: ['patient'] },
    'admin@pssh': { displayName: 'PSSH Admin', roles: ['hospital_admin'] },
  })[s] || null,
};
const hospitals = { get: (id) => ({ pssh: { name: 'PSSH' } })[id] || null };

test('clinician names are added next to IDs everywhere; IDs stay; patients are never named', () => {
  const { enrich } = createNameResolver({ providerRegistry: providers, userDirectory: users, hospitalRegistry: hospitals });
  const out = enrich({
    grants: [{ providerID: '6afc', requesterHospitalID: 'juth', patientDID: 'did:x' }, { providerID: 'hospital-staff@pssh' }],
    audit: [{ actorID: '6afc@juth' }, { actorID: 'pt-1' }, { actorID: 'did:patientchain:1' }, { actorID: 'admin@pssh' }],
    event: { payload: { reviewedBy: '6afc' } },
  });
  assert.equal(out.grants[0].providerName, 'Test Doctor John');
  assert.equal(out.grants[0].providerID, '6afc');
  assert.equal(out.grants[1].providerName, 'All clinicians at PSSH');
  assert.equal(out.audit[0].actorName, 'Test Doctor John');
  assert.equal(out.audit[1].actorName, undefined);
  assert.equal(out.audit[2].actorName, undefined);
  assert.equal(out.audit[3].actorName, 'PSSH Admin');
  assert.equal(out.event.payload.reviewedByName, 'Test Doctor John');
});
