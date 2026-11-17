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
 *
 * The patient waits at most EMR_PATIENT_LOOKUP_TIMEOUT_MS (default 10 s) for
 * the EMR, much less than the 45 s staff tools allow, so an unreachable
 * hospital network does not keep them on a spinner. A call still in flight
 * carries on in the background, so a slow SmartClinic login is cached for
 * the next try.
 */
const LOOKUP_TIMEOUT_MS = Number(process.env.EMR_PATIENT_LOOKUP_TIMEOUT_MS) || 10 * 1000;

function withDeadline(promise, ms, host) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer from ${host} within ${ms / 1000}s`)), ms);
  });
  promise.catch(() => {}); // a late failure after the deadline is not unhandled
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function refreshFromEmr({ hospitalRegistry, fhirAdapter, logger, timeoutMs = LOOKUP_TIMEOUT_MS }, hospitalID, hospitalNumber) {
  if (!hospitalRegistry || !hospitalID || !hospitalNumber) return false;
  const hospital = hospitalRegistry.getInternal(hospitalID);
  if (!hospital || hospital.status !== 'active') return false;
  try {
    let found = null;
    if (hospital.integration === 'smartclinic' && hospital.smartclinic) {
      found = await withDeadline(smartClinic.findPatient(hospital, hospitalNumber), timeoutMs, 'the hospital\'s SmartClinic');
    } else if (['fhir', 'both'].includes(hospital.integration) && hospital.fhir && hospital.fhir.baseUrl) {
      found = await withDeadline(findPatientDemographics(hospital, hospitalNumber), timeoutMs, 'the hospital\'s FHIR server');
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
