'use strict';

const { findPatientDemographics } = require('./liveFhirClient');
const smartClinic = require('./smartClinicClient');

/**
 * emrPatientLookup.js
 *
 * When a patient enters a hospital number for a hospital whose EMR we can
 * query (FHIR API or SmartClinic), read that one record from the EMR first
 * and refresh the hospital's roster entry with it. The normal linkage check
 * (hospital number + name, date of birth optional) then runs against
 * current EMR data, so a hospital without an ADT feed still works.
 *
 * Failures are silent to the patient: if the EMR is unreachable the check
 * falls back to the roster already held, and the answer stays the same
 * generic "no matching record" either way.
 */
async function refreshFromEmr({ hospitalRegistry, fhirAdapter, logger }, hospitalID, hospitalNumber) {
  if (!hospitalRegistry || !hospitalID || !hospitalNumber) return false;
  const hospital = hospitalRegistry.getInternal(hospitalID);
  if (!hospital || hospital.status !== 'active') return false;
  try {
    let found = null;
    if (hospital.integration === 'smartclinic' && hospital.smartclinic) {
      found = await smartClinic.findPatient(hospital, hospitalNumber);
    } else if (['fhir', 'both'].includes(hospital.integration) && hospital.fhir && hospital.fhir.baseUrl) {
      found = await findPatientDemographics(hospital, hospitalNumber);
    } else {
      return false;
    }
    if (!found) return false;
    const existing = fhirAdapter.findLocalPatientRecord(hospitalID, hospitalNumber) || {};
    fhirAdapter.addLocalPatientRecord(hospitalID, String(hospitalNumber).trim(), {
      ...existing,
      name: found.name,
      dob: found.dob || existing.dob || null,
      source: hospital.integration,
      refreshedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    if (logger) logger.warn('EMR patient lookup failed; using the roster already held', { hospitalID, err: err.message });
    return false;
  }
}

module.exports = { refreshFromEmr };
