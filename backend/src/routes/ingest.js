'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const { ROLES, actsForHospital, deny } = require('../auth/policy');
const { validateResource } = require('../services/fhirValidation');

/**
 * ingest.js — the custom REST ingestion path (Section 3.4.8).
 *
 * For hospitals whose system exposes neither FHIR nor HL7 v2: their
 * vendor, or a small database-export job at the hospital, POSTs records to
 *
 *   POST /api/ingest/:hospitalID
 *   { "hospitalNumber": "536728",
 *     "patient":  { "name": "Amina Yusuf", "dob": "1995-03-15" },   (optional)
 *     "resources": [ <FHIR R4 resources>... ] }
 *
 * or a FHIR Bundle (collection / transaction / batch) whose Patient entry
 * carries the hospital number as an identifier. Records converge on the
 * same internal FHIR R4 store as the HL7 path, so the record gateway,
 * scope filter and audit trail work the same. Each clinical record also
 * gets an on-chain pointer if the patient has linked a DID (FR3).
 *
 * Callers: the hospital's interface account (role hl7_interface) or its
 * admins. The hospital must be set up with the "Custom REST" connection.
 */
const MAX_RESOURCES = 200;

function hospitalNumberFrom(body) {
  if (body.hospitalNumber) return String(body.hospitalNumber).trim();
  const patient = (body.entry || []).map((e) => e.resource).find((r) => r && r.resourceType === 'Patient');
  const id = patient && (patient.identifier || []).find((i) => i && i.value);
  return id ? String(id.value).trim() : null;
}

function demographicsFrom(body) {
  if (body.patient && body.patient.name && body.patient.dob) return { name: String(body.patient.name), dob: String(body.patient.dob) };
  const patient = (body.resources || (body.entry || []).map((e) => e.resource)).find((r) => r && r.resourceType === 'Patient');
  if (!patient || !patient.birthDate) return null;
  const n = (patient.name || [])[0] || {};
  const name = n.text || [...(n.given || []), n.family].filter(Boolean).join(' ');
  return name ? { name, dob: patient.birthDate } : null;
}

function ingestRouter(fhirAdapter, hospitalRegistry = null) {
  const router = express.Router();

  router.post('/:hospitalID', (req, res) => {
    const { hospitalID } = req.params;
    if (!actsForHospital(req.user, hospitalID, ROLES.HL7_INTERFACE, ROLES.HOSPITAL_ADMIN)) {
      return deny(res, "only this hospital's interface account or admins can submit its records");
    }
    const hospital = hospitalRegistry ? hospitalRegistry.get(hospitalID) : null;
    if (hospitalRegistry && !hospital) return res.status(404).json({ error: 'unknown hospital' });
    if (hospital && hospital.status !== 'active') return res.status(403).json({ error: 'this hospital is inactive' });
    if (hospital && hospital.integration !== 'rest') {
      return res.status(403).json({ error: 'custom REST ingestion is not enabled for this hospital (System Admin → Hospitals → Connection)' });
    }

    const body = req.body || {};
    const resources = Array.isArray(body.resources)
      ? body.resources
      : body.resourceType === 'Bundle'
        ? (body.entry || []).map((e) => e && e.resource)
        : body.resourceType
          ? [body]
          : [];
    if (!resources.length) return res.status(400).json({ error: 'send "resources" (an array of FHIR R4 resources) or a FHIR Bundle' });
    if (resources.length > MAX_RESOURCES) return res.status(413).json({ error: `at most ${MAX_RESOURCES} resources per request` });

    const hospitalNumber = hospitalNumberFrom(body);
    if (!hospitalNumber) return res.status(400).json({ error: 'hospitalNumber is required (or a Patient entry with an identifier)' });

    const errors = [];
    resources.forEach((r, i) => {
      for (const p of validateResource(r)) errors.push(`resources[${i}]: ${p}`);
    });
    if (errors.length) return res.status(422).json({ error: 'some resources are not valid FHIR R4', problems: errors.slice(0, 50) });

    const demographics = demographicsFrom({ ...body, resources });
    if (demographics) fhirAdapter.addLocalPatientRecord(hospitalID, hospitalNumber, demographics);
    else if (!fhirAdapter.findLocalPatientRecord(hospitalID, hospitalNumber)) {
      return res.status(400).json({ error: 'unknown hospital number: include the patient (name and date of birth) the first time' });
    }

    // Store each clinical resource as its own record; administrative ones
    // (Practitioner, Organization) travel with every record in this request.
    const admin = resources.filter((r) => r.resourceType === 'Practitioner' || r.resourceType === 'Organization');
    const clinical = resources.filter((r) => !['Patient', 'Practitioner', 'Organization'].includes(r.resourceType));
    const stored = clinical.map((r) => {
      const resource = { ...r, id: r.id || randomUUID(), subject: r.subject || { identifier: { value: hospitalNumber } } };
      const bundle = fhirAdapter.recordResourceByHospitalNumber(hospitalID, hospitalNumber, resource, admin);
      return { bundleID: bundle.id, resourceType: resource.resourceType, id: resource.id };
    });
    res.status(201).json({ ok: true, hospitalID, hospitalNumber, patientUpdated: Boolean(demographics), stored });
  });

  return router;
}

module.exports = { ingestRouter };
