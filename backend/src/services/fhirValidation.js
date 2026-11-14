'use strict';

/**
 * fhirValidation.js
 *
 * Structural checks on FHIR R4 resources entering Cevruni through the
 * custom REST ingestion path (routes/ingest.js), and on resources the
 * HL7 v2 mapper generates (tested in fhirValidation.test.js). Covers the
 * resource types of Table 3.6 and the R4 cardinality-1..1 elements each
 * of them requires, plus the code/subject elements the Nigeria Core FHIR
 * IG draft makes mandatory for clinical resources. It is a floor, not a
 * full profile validator: a production deployment would run the official
 * HL7 validator against the published IG once it leaves draft.
 */

const SUPPORTED = {
  Patient: [],
  Practitioner: [],
  Organization: [],
  Encounter: ['status', 'class'],
  Observation: ['status', 'code'],
  DiagnosticReport: ['status', 'code'],
  Condition: ['code'],
  MedicationRequest: ['status', 'intent', ['medicationCodeableConcept', 'medicationReference']],
  DocumentReference: ['status', 'content'],
  // Allergies: the first thing an emergency team needs (not in Table 3.6
  // originally; added with the emergency record set).
  AllergyIntolerance: ['code'],
};

const STATUS = {
  Encounter: ['planned', 'arrived', 'triaged', 'in-progress', 'onleave', 'finished', 'cancelled', 'entered-in-error', 'unknown'],
  Observation: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'],
  DiagnosticReport: ['registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown'],
  MedicationRequest: ['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown'],
  DocumentReference: ['current', 'superseded', 'entered-in-error'],
};

const ID = /^[A-Za-z0-9\-.]{1,64}$/;

/** Returns a list of problems; empty means the resource is acceptable. */
function validateResource(r) {
  const problems = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['not a JSON object'];
  const type = r.resourceType;
  if (!SUPPORTED[type]) return [`resourceType "${type}" is not one Cevruni accepts (${Object.keys(SUPPORTED).join(', ')})`];
  if (r.id !== undefined && !ID.test(String(r.id))) problems.push(`${type}.id is not a valid FHIR id`);
  for (const req of SUPPORTED[type]) {
    if (Array.isArray(req)) {
      if (!req.some((k) => r[k] !== undefined && r[k] !== null)) problems.push(`${type} needs one of ${req.join(' / ')}`);
    } else if (r[req] === undefined || r[req] === null || r[req] === '') {
      problems.push(`${type}.${req} is required`);
    }
  }
  if (STATUS[type] && r.status && !STATUS[type].includes(r.status)) problems.push(`${type}.status "${r.status}" is not a valid R4 code`);
  if (type === 'DocumentReference' && Array.isArray(r.content) && !r.content.every((c) => c && c.attachment)) {
    problems.push('DocumentReference.content[].attachment is required');
  }
  if ((type === 'Observation' || type === 'DiagnosticReport' || type === 'Condition' || type === 'AllergyIntolerance') && r.code && !(r.code.text || (r.code.coding && r.code.coding.length))) {
    problems.push(`${type}.code needs text or a coding`);
  }
  return problems;
}

module.exports = { validateResource, SUPPORTED_TYPES: Object.keys(SUPPORTED) };
