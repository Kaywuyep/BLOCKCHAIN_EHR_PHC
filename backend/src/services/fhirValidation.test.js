'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateResource } = require('./fhirValidation');
const { parseHl7Message, mapAdtMessageToResources } = require('./hl7AdtListener');
const fixtures = require('./hl7AdtListener.fixtures');

test('resources generated from HL7 v2 ADT messages pass FHIR R4 validation', () => {
  for (const name of ['adtA01Admit', 'adtA08Update', 'adtA03Discharge', 'adtA01OutpatientNoAttending']) {
    const mapped = mapAdtMessageToResources(parseHl7Message(fixtures[name]), { log: { warn() {}, log() {} } });
    for (const r of [mapped.patient.sourceResource, mapped.encounterResource, mapped.practitionerResource].filter(Boolean)) {
      assert.deepEqual(validateResource(r), [], `${name}: ${r.resourceType}`);
    }
  }
});

test('the validator rejects missing required elements and bad status codes', () => {
  assert.match(validateResource({ resourceType: 'Observation', status: 'final' }).join(), /code is required/);
  assert.match(validateResource({ resourceType: 'Encounter', status: 'done', class: {} }).join(), /not a valid R4 code/);
  assert.match(validateResource({ resourceType: 'Claim' }).join(), /not one Cevruni accepts/);
  assert.deepEqual(validateResource({ resourceType: 'MedicationRequest', status: 'active', intent: 'order', medicationCodeableConcept: { text: 'ACT' } }), []);
});
