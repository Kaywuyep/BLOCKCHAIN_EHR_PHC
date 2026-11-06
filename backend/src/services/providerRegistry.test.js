'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ProviderRegistry } = require('./providerRegistry');

test('register requires providerID and hospitalID', () => {
  const registry = new ProviderRegistry();
  assert.throws(() => registry.register({ hospitalID: 'HospitalA-Lagos' }), /providerID and hospitalID are required/);
  assert.throws(() => registry.register({ providerID: 'dr-x' }), /providerID and hospitalID are required/);
});

test('register applies sensible defaults for role, department and status', () => {
  const registry = new ProviderRegistry();
  const provider = registry.register({ providerID: 'dr-x', hospitalID: 'HospitalA-Lagos' });
  assert.equal(provider.role, 'Physician');
  assert.equal(provider.department, 'General');
  assert.equal(provider.status, 'ACTIVE');
  assert.equal(provider.name, 'dr-x');
});

test('get is scoped per hospital: the same providerID at a different hospital is a different registration', () => {
  const registry = new ProviderRegistry();
  registry.register({ providerID: 'dr-x', hospitalID: 'HospitalA-Lagos', name: 'Dr. X at A' });
  registry.register({ providerID: 'dr-x', hospitalID: 'HospitalB-Ibadan', name: 'Dr. X at B' });

  assert.equal(registry.get('dr-x', 'HospitalA-Lagos').name, 'Dr. X at A');
  assert.equal(registry.get('dr-x', 'HospitalB-Ibadan').name, 'Dr. X at B');
  assert.equal(registry.get('dr-x', 'HospitalC-Kano'), null);
});

test('getForHospital only returns providers registered at that hospital', () => {
  const registry = new ProviderRegistry();
  registry.register({ providerID: 'dr-a', hospitalID: 'HospitalA-Lagos' });
  registry.register({ providerID: 'dr-b', hospitalID: 'HospitalA-Lagos' });
  registry.register({ providerID: 'dr-c', hospitalID: 'HospitalB-Ibadan' });

  const atA = registry.getForHospital('HospitalA-Lagos');
  assert.equal(atA.length, 2);
  assert.ok(atA.every((p) => p.hospitalID === 'HospitalA-Lagos'));
});

test('isAuthorized is true only for an ACTIVE, registered provider at that hospital', () => {
  const registry = new ProviderRegistry();
  registry.register({ providerID: 'dr-active', hospitalID: 'HospitalA-Lagos', status: 'ACTIVE' });
  registry.register({ providerID: 'dr-suspended', hospitalID: 'HospitalA-Lagos', status: 'SUSPENDED' });

  assert.equal(registry.isAuthorized('dr-active', 'HospitalA-Lagos'), true);
  assert.equal(registry.isAuthorized('dr-suspended', 'HospitalA-Lagos'), false);
  assert.equal(registry.isAuthorized('dr-unknown', 'HospitalA-Lagos'), false);
  // A patient's on-chain grant naming "HospitalB-Ibadan" must not authorize
  // staff who only exist at a different hospital's roster.
  assert.equal(registry.isAuthorized('dr-active', 'HospitalB-Ibadan'), false);
});

test('re-registering the same providerID at the same hospital overwrites the prior record', () => {
  const registry = new ProviderRegistry();
  registry.register({ providerID: 'dr-x', hospitalID: 'HospitalA-Lagos', status: 'ACTIVE' });
  registry.register({ providerID: 'dr-x', hospitalID: 'HospitalA-Lagos', status: 'SUSPENDED' });

  assert.equal(registry.get('dr-x', 'HospitalA-Lagos').status, 'SUSPENDED');
  assert.equal(registry.getForHospital('HospitalA-Lagos').length, 1);
});
