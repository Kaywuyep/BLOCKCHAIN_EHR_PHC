'use strict';

/**
 * demoData.js — the complete demo dataset (development only).
 *
 * One small, consistent world that exercises every part of Cevruni:
 * five hospitals on every connection type, staff in every role, patients
 * with records of every FHIR type in Table 3.6, grants in every state,
 * break-glass (pending and reviewed), record accesses spread over the past
 * week, screenshot attempts, HL7 messages (accepted and rejected), and
 * roster entries that are NOT yet linked so registration and linking can
 * be tried by hand. See docs/demo-guide.md for the walkthrough.
 */

const L = 'general-hospital-langtang';
const W = 'general-hospital-wase';
const J = 'jos-university-teaching-hospital';
const P = 'plateau-specialist-hospital';
const O = 'our-lady-of-apostles-hospital';

// How each hospital connects (applied only to hospitals still on their
// imported defaults, never over an admin's own edits).
const HOSPITAL_SETUP = {
  [L]: { integration: 'hl7', hl7: { mllpEnabled: true, mllpPort: 5001, httpEnabled: true, hl7Version: '2.5' } },
  [W]: { integration: 'hl7', hl7: { mllpEnabled: true, mllpPort: 5002, httpEnabled: true, hl7Version: '2.5' } },
  // JUTH: HL7 over HTTPS for admissions + a FHIR API (served by the
  // built-in demo FHIR server, demo/mockFhirServer.js) for clinical data.
  [J]: { integration: 'both', hl7: { mllpEnabled: false, httpEnabled: true, hl7Version: '2.5' }, fhir: 'demo' },
  [P]: { integration: 'rest' },
  [O]: { integration: 'manual' },
};

// Accounts. Sign in on the login page with the user ID and role (no
// password in AUTH_MODE=local).
const USERS = [
  { subject: 'superadmin', displayName: 'System Administrator', roles: ['system_admin'] },
  { subject: 'admin-langtang', displayName: 'Comfort Gyang (Admin, Langtang)', roles: ['hospital_admin'], hospitalID: L },
  { subject: 'admin-wase', displayName: 'Bala Wase (Admin, Wase)', roles: ['hospital_admin'], hospitalID: W },
  { subject: 'admin-juth', displayName: 'Dr. Rose Pam (Admin, JUTH)', roles: ['hospital_admin'], hospitalID: J },
  { subject: 'admin-psh', displayName: 'Musa Dung (Admin, PSH)', roles: ['hospital_admin'], hospitalID: P },
  { subject: 'admin-ola', displayName: 'Sr. Mary Lar (Admin, OLA)', roles: ['hospital_admin'], hospitalID: O },
  { subject: 'hl7-langtang', displayName: 'Langtang interface engine', roles: ['hl7_interface'], hospitalID: L },
  { subject: 'rest-psh', displayName: 'PSH records export job', roles: ['hl7_interface'], hospitalID: P },
  { subject: 'amina', displayName: 'Amina Yusuf', roles: ['patient'] },
  { subject: 'ibrahim', displayName: 'Ibrahim Musa', roles: ['patient'] },
  { subject: 'fatima', displayName: 'Fatima Bello', roles: ['patient'] },
  { subject: 'chinedu', displayName: 'Chinedu Okeke', roles: ['patient'] },
];

// Clinicians (provider registry + user accounts). Role matters: grants are
// bound to it.
const CLINICIANS = [
  { providerID: 'dr-musa', hospitalID: L, name: 'Dr. Musa Ibrahim', role: 'Physician', department: 'Internal Medicine' },
  { providerID: 'dr-aisha', hospitalID: L, name: 'Dr. Aisha Mohammed', role: 'Physician', department: 'Pediatrics' },
  { providerID: 'nurse-grace', hospitalID: L, name: 'Grace Choji', role: 'Nurse', department: 'Antenatal Clinic' },
  { providerID: 'lab-sani', hospitalID: L, name: 'Sani Adamu', role: 'Laboratory Scientist', department: 'Laboratory' },
  { providerID: 'dr-yakubu', hospitalID: L, name: 'Dr. Yakubu Dalyop', role: 'Physician', department: 'Surgery', status: 'SUSPENDED' },
  { providerID: 'dr-chukwu', hospitalID: W, name: 'Dr. Chukwu Emeka', role: 'Physician', department: 'Surgery' },
  { providerID: 'dr-bello', hospitalID: J, name: 'Dr. Bello Abdullahi', role: 'Consultant', department: 'Cardiology' },
  { providerID: 'dr-danladi', hospitalID: P, name: 'Dr. Grace Danladi', role: 'Consultant', department: 'Ophthalmology' },
  { providerID: 'dr-okon', hospitalID: O, name: 'Dr. Okon Etim', role: 'Physician', department: 'General Practice' },
];

// Each hospital's own patient register (off-chain, encrypted at rest).
const ROSTER = [
  // Linked to demo Health IDs (see PATIENTS)
  { hospitalID: L, hospitalNumber: '536728', name: 'Amina Yusuf', dob: '1995-03-15' },
  { hospitalID: W, hospitalNumber: '2367941', name: 'Amina Yusuf', dob: '1995-03-15' },
  { hospitalID: J, hospitalNumber: '10045321', name: 'Amina Yusuf', dob: '1995-03-15' },
  { hospitalID: P, hospitalNumber: 'PSH-4420', name: 'Amina Yusuf', dob: '1995-03-15' },
  { hospitalID: L, hospitalNumber: '104892', name: 'Ibrahim Musa', dob: '1988-07-22' },
  { hospitalID: J, hospitalNumber: '10087654', name: 'Ibrahim Musa', dob: '1988-07-22' },
  { hospitalID: W, hospitalNumber: '887412', name: 'Fatima Bello', dob: '1992-11-08' },
  { hospitalID: O, hospitalNumber: 'OLA-7891', name: 'Fatima Bello', dob: '1992-11-08' },
  { hospitalID: O, hospitalNumber: 'OLA-1203', name: 'Chinedu Okeke', dob: '1979-01-30' },
  // NOT linked: for trying registration and "My Hospitals" by hand
  { hospitalID: L, hospitalNumber: 'LTG-2001', name: 'Hauwa Danjuma', dob: '1993-05-20' },
  { hospitalID: W, hospitalNumber: 'W-3002', name: 'Emeka Obi', dob: '1985-09-30' },
  { hospitalID: W, hospitalNumber: '7781234', name: 'Ibrahim Musa', dob: '1988-07-22' },
  { hospitalID: P, hospitalNumber: 'PSH-5510', name: 'Fatima Bello', dob: '1992-11-08' },
];

// Demo patients: their Health ID and the hospitals already linked.
const PATIENTS = [
  { subject: 'amina', did: 'did:patientchain:demo-amina', links: [[L, '536728'], [W, '2367941'], [J, '10045321'], [P, 'PSH-4420']] },
  { subject: 'ibrahim', did: 'did:patientchain:demo-ibrahim', links: [[L, '104892'], [J, '10087654']] },
  { subject: 'fatima', did: 'did:patientchain:demo-fatima', links: [[W, '887412'], [O, 'OLA-7891']] },
  { subject: 'chinedu', did: 'did:patientchain:demo-chinedu', links: [[O, 'OLA-1203']] },
];

// Clinical records held at each hospital (FHIR R4, every Table 3.6 type).
const CLINICAL = [
  // ── General Hospital Langtang — Amina's records ──
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'Encounter', id: 'enc-langtang-001', status: 'finished',
      class: { code: 'AMB', display: 'Ambulatory' },
      reasonCode: [{ text: 'Routine antenatal care visit — 28 weeks gestation' }],
      period: { start: '2026-06-12T09:00:00Z', end: '2026-06-12T10:30:00Z' },
      participant: [{ individual: { display: 'Dr. Musa Ibrahim' } }],
      serviceProvider: { display: 'General Hospital Langtang' },
    },
  },
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'Observation', id: 'obs-langtang-001', status: 'final',
      code: { text: 'Full Blood Count (FBC)' },
      valueString: 'Hb: 11.2 g/dL, WBC: 6.8×10⁹/L, Platelets: 245×10⁹/L — within normal range',
      effectiveDateTime: '2026-06-12T09:15:00Z',
      performer: [{ display: 'General Hospital Langtang Laboratory' }],
    },
  },
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'Observation', id: 'obs-langtang-002', status: 'final',
      code: { text: 'Blood Glucose (Fasting)' },
      valueString: '4.8 mmol/L — Normal',
      effectiveDateTime: '2026-07-20T08:30:00Z',
      performer: [{ display: 'General Hospital Langtang Laboratory' }],
    },
  },
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'MedicationRequest', id: 'med-langtang-001', status: 'active',
      intent: 'order',
      code: { text: 'Ferrous Sulphate 200mg + Folic Acid 5mg' },
      reasonCode: [{ text: 'Iron supplementation — pregnancy' }],
      dosageInstruction: [{ text: '1 tablet daily after meals' }],
      authoredOn: '2026-06-12T10:00:00Z',
      requester: { display: 'Dr. Musa Ibrahim — General Hospital Langtang' },
    },
  },
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'Encounter', id: 'enc-langtang-002', status: 'finished',
      class: { code: 'AMB', display: 'Ambulatory' },
      reasonCode: [{ text: 'Follow-up visit — malaria treatment review' }],
      period: { start: '2026-09-03T11:00:00Z', end: '2026-09-03T11:45:00Z' },
      participant: [{ individual: { display: 'Dr. Aisha Mohammed' } }],
      serviceProvider: { display: 'General Hospital Langtang' },
    },
  },

  // ── General Hospital Wase — Amina's records ──
  {
    hospitalID: W, hospitalNumber: '2367941',
    resource: {
      resourceType: 'Encounter', id: 'enc-wase-001', status: 'finished',
      class: { code: 'EMER', display: 'Emergency' },
      reasonCode: [{ text: 'Emergency admission — severe dehydration secondary to acute gastroenteritis' }],
      period: { start: '2026-04-18T02:30:00Z', end: '2026-04-20T14:00:00Z' },
      participant: [{ individual: { display: 'Dr. Chukwu Emeka' } }],
      serviceProvider: { display: 'General Hospital Wase' },
    },
  },
  {
    hospitalID: W, hospitalNumber: '2367941',
    resource: {
      resourceType: 'Observation', id: 'obs-wase-001', status: 'final',
      code: { text: 'Electrolyte Panel' },
      valueString: 'Na⁺: 131 mmol/L (low), K⁺: 3.1 mmol/L (low), Cl⁻: 96 mmol/L — hyponatraemia, hypokalaemia',
      effectiveDateTime: '2026-04-18T03:00:00Z',
      performer: [{ display: 'General Hospital Wase Laboratory' }],
    },
  },
  {
    hospitalID: W, hospitalNumber: '2367941',
    resource: {
      resourceType: 'MedicationRequest', id: 'med-wase-001', status: 'completed',
      intent: 'order',
      code: { text: 'Normal Saline (0.9% NaCl) IV infusion + Oral Rehydration Salts' },
      reasonCode: [{ text: 'IV fluid resuscitation — severe dehydration' }],
      dosageInstruction: [{ text: '1L over 4 hours initially, then ORS ad libitum' }],
      authoredOn: '2026-04-18T03:15:00Z',
      requester: { display: 'Dr. Chukwu Emeka — General Hospital Wase' },
    },
  },
  {
    hospitalID: W, hospitalNumber: '2367941',
    resource: {
      resourceType: 'Observation', id: 'obs-wase-002', status: 'final',
      code: { text: 'Malaria Rapid Diagnostic Test (mRDT)' },
      valueString: 'Positive — Plasmodium falciparum',
      effectiveDateTime: '2026-04-18T03:10:00Z',
      performer: [{ display: 'General Hospital Wase Laboratory' }],
    },
  },
  {
    hospitalID: W, hospitalNumber: '2367941',
    resource: {
      resourceType: 'MedicationRequest', id: 'med-wase-002', status: 'completed',
      intent: 'order',
      code: { text: 'Artemether-Lumefantrine (ACT) 80/480mg' },
      reasonCode: [{ text: 'Uncomplicated P. falciparum malaria' }],
      dosageInstruction: [{ text: '4 tablets at 0, 8, 24, 36, 48, 60 hours' }],
      authoredOn: '2026-04-18T03:20:00Z',
      requester: { display: 'Dr. Chukwu Emeka — General Hospital Wase' },
    },
  },

  // ── JUTH — Amina's records ──
  {
    hospitalID: J, hospitalNumber: '10045321',
    resource: {
      resourceType: 'Encounter', id: 'enc-juth-001', status: 'finished',
      class: { code: 'AMB', display: 'Ambulatory' },
      reasonCode: [{ text: 'Cardiology outpatient referral — intermittent palpitations' }],
      period: { start: '2026-08-05T10:00:00Z', end: '2026-08-05T11:30:00Z' },
      participant: [{ individual: { display: 'Dr. Bello Abdullahi (Consultant Cardiologist)' } }],
      serviceProvider: { display: 'Jos University Teaching Hospital (JUTH)' },
    },
  },
  {
    hospitalID: J, hospitalNumber: '10045321',
    resource: {
      resourceType: 'Observation', id: 'obs-juth-001', status: 'final',
      code: { text: '12-Lead Electrocardiogram (ECG)' },
      valueString: 'Normal sinus rhythm, rate 78 bpm, no ST changes, normal QTc',
      effectiveDateTime: '2026-08-05T10:20:00Z',
      performer: [{ display: 'JUTH Cardiology Unit' }],
    },
  },
  {
    hospitalID: J, hospitalNumber: '10045321',
    resource: {
      resourceType: 'Observation', id: 'obs-juth-002', status: 'final',
      code: { text: 'Echocardiogram (2D Echo)' },
      valueString: 'LVEF 62%, no valvular abnormalities, normal chamber dimensions — structurally normal heart',
      effectiveDateTime: '2026-08-05T10:45:00Z',
      performer: [{ display: 'JUTH Cardiology Unit' }],
    },
  },

  // Table 3.6 coverage: a diagnostic report and a clinical document.
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'DiagnosticReport', id: 'dr-langtang-001', status: 'final',
      code: { text: 'Obstetric ultrasound report' },
      conclusion: 'Single live intrauterine pregnancy, 28 weeks. Normal fetal growth and amniotic fluid.',
      effectiveDateTime: '2026-06-12T09:40:00Z',
      performer: [{ display: 'General Hospital Langtang Radiology' }],
    },
  },
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'DocumentReference', id: 'doc-langtang-001', status: 'current',
      type: { text: 'Antenatal clinic note' },
      description: 'Antenatal clinic note: 28 weeks',
      date: '2026-06-12T10:30:00Z',
      content: [{ attachment: { contentType: 'text/plain', title: 'Clinic note', data: 'UGF0aWVudCB3ZWxsLiBCUCAxMTAvNzAuIEZ1bmRhbCBoZWlnaHQgMjggY20uIFJldmlldyBpbiA0IHdlZWtzLg==' } }],
    },
  },

  // ── Plateau Specialist Hospital — Amina's records ──
  {
    hospitalID: P, hospitalNumber: 'PSH-4420',
    resource: {
      resourceType: 'Encounter', id: 'enc-psh-001', status: 'finished',
      class: { code: 'AMB', display: 'Ambulatory' },
      reasonCode: [{ text: 'Ophthalmology consultation — recurrent eye irritation' }],
      period: { start: '2026-10-10T14:00:00Z', end: '2026-10-10T14:45:00Z' },
      participant: [{ individual: { display: 'Dr. Grace Danladi (Ophthalmologist)' } }],
      serviceProvider: { display: 'Plateau Specialist Hospital' },
    },
  },
  {
    hospitalID: P, hospitalNumber: 'PSH-4420',
    resource: {
      resourceType: 'Observation', id: 'obs-psh-001', status: 'final',
      code: { text: 'Visual Acuity Test' },
      valueString: 'Right eye: 6/6, Left eye: 6/9 — mild refractive error left eye',
      effectiveDateTime: '2026-10-10T14:10:00Z',
      performer: [{ display: 'Plateau Specialist Hospital — Ophthalmology' }],
    },
  },
  {
    hospitalID: P, hospitalNumber: 'PSH-4420',
    resource: {
      resourceType: 'MedicationRequest', id: 'med-psh-001', status: 'active',
      intent: 'order',
      code: { text: 'Artificial Tears (Carboxymethylcellulose 0.5%)' },
      reasonCode: [{ text: 'Dry eye syndrome' }],
      dosageInstruction: [{ text: '1-2 drops in each eye, 3-4 times daily as needed' }],
      authoredOn: '2026-10-10T14:40:00Z',
      requester: { display: 'Dr. Grace Danladi — Plateau Specialist Hospital' },
    },
  },

  // ── Langtang — more of Amina's history (diagnostic report, document,
  //    and a sensitive diagnosis that lab-only grants must NOT reveal) ──
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'DiagnosticReport', id: 'dr-langtang-001', status: 'final',
      code: { text: 'Obstetric ultrasound report' },
      conclusion: 'Single live intrauterine pregnancy, 28 weeks. Normal fetal growth and amniotic fluid.',
      effectiveDateTime: '2026-06-12T09:40:00Z',
      performer: [{ display: 'General Hospital Langtang Radiology' }],
    },
  },
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'DocumentReference', id: 'doc-langtang-001', status: 'current',
      type: { text: 'Antenatal clinic note' },
      description: 'Antenatal clinic note: 28 weeks',
      date: '2026-06-12T10:30:00Z',
      content: [{ attachment: { contentType: 'text/plain', title: 'Clinic note', data: 'UGF0aWVudCB3ZWxsLiBCUCAxMTAvNzAuIEZ1bmRhbCBoZWlnaHQgMjggY20uIFJldmlldyBpbiA0IHdlZWtzLg==' } }],
    },
  },
  {
    hospitalID: L, hospitalNumber: '536728',
    resource: {
      resourceType: 'Condition', id: 'cond-langtang-001',
      code: { text: 'Postpartum depression (mild), under follow-up' },
      recordedDate: '2026-10-02T11:00:00Z',
      clinicalStatus: { text: 'active' },
    },
  },

  // ── Langtang — Ibrahim Musa: hypertension ──
  {
    hospitalID: L, hospitalNumber: '104892',
    resource: {
      resourceType: 'Encounter', id: 'enc-langtang-101', status: 'finished',
      class: { code: 'AMB', display: 'Ambulatory' },
      reasonCode: [{ text: 'Hypertension review clinic' }],
      period: { start: '2026-09-15T09:00:00Z', end: '2026-09-15T09:40:00Z' },
      participant: [{ individual: { display: 'Dr. Musa Ibrahim' } }],
      serviceProvider: { display: 'General Hospital Langtang' },
    },
  },
  {
    hospitalID: L, hospitalNumber: '104892',
    resource: {
      resourceType: 'Observation', id: 'obs-langtang-101', status: 'final',
      code: { text: 'Blood pressure' },
      valueString: '152/96 mmHg (stage 2 hypertension)',
      effectiveDateTime: '2026-09-15T09:10:00Z',
      performer: [{ display: 'General Hospital Langtang OPD' }],
    },
  },
  {
    hospitalID: L, hospitalNumber: '104892',
    resource: {
      resourceType: 'Observation', id: 'obs-langtang-102', status: 'final',
      code: { text: 'Serum creatinine' },
      valueString: '98 µmol/L, normal',
      effectiveDateTime: '2026-09-15T09:30:00Z',
      performer: [{ display: 'General Hospital Langtang Laboratory' }],
    },
  },
  {
    hospitalID: L, hospitalNumber: '104892',
    resource: {
      resourceType: 'MedicationRequest', id: 'med-langtang-101', status: 'active', intent: 'order',
      medicationCodeableConcept: { text: 'Amlodipine 10mg' },
      dosageInstruction: [{ text: '1 tablet once daily' }],
      authoredOn: '2026-09-15T09:35:00Z',
      requester: { display: 'Dr. Musa Ibrahim — General Hospital Langtang' },
    },
  },
  {
    hospitalID: L, hospitalNumber: '104892',
    resource: {
      resourceType: 'Condition', id: 'cond-langtang-101',
      code: { text: 'Essential hypertension' },
      recordedDate: '2026-09-15T09:35:00Z',
      clinicalStatus: { text: 'active' },
    },
  },

  // ── Wase — Fatima Bello ──
  {
    hospitalID: W, hospitalNumber: '887412',
    resource: {
      resourceType: 'Encounter', id: 'enc-wase-201', status: 'finished',
      class: { code: 'EMER', display: 'Emergency' },
      reasonCode: [{ text: 'Road traffic accident: right forearm injury' }],
      period: { start: '2026-11-10T19:20:00Z', end: '2026-11-11T08:00:00Z' },
      participant: [{ individual: { display: 'Dr. Chukwu Emeka' } }],
      serviceProvider: { display: 'General Hospital Wase' },
    },
  },
  {
    hospitalID: W, hospitalNumber: '887412',
    resource: {
      resourceType: 'DiagnosticReport', id: 'dr-wase-201', status: 'final',
      code: { text: 'X-ray right forearm' },
      conclusion: 'Undisplaced fracture of the distal radius. No dislocation.',
      effectiveDateTime: '2026-11-10T20:05:00Z',
      performer: [{ display: 'General Hospital Wase Radiology' }],
    },
  },
  {
    hospitalID: W, hospitalNumber: '887412',
    resource: {
      resourceType: 'MedicationRequest', id: 'med-wase-201', status: 'active', intent: 'order',
      medicationCodeableConcept: { text: 'Paracetamol 1g' },
      dosageInstruction: [{ text: '1g every 8 hours for 5 days' }],
      authoredOn: '2026-11-10T20:30:00Z',
      requester: { display: 'Dr. Chukwu Emeka — General Hospital Wase' },
    },
  },

  // ── Allergies (the first thing an emergency team needs) ──
  {
    hospitalID: J, hospitalNumber: '10045321',
    resource: {
      resourceType: 'AllergyIntolerance', id: 'allergy-juth-001',
      code: { text: 'Penicillin' },
      reaction: [{ manifestation: [{ text: 'Urticaria and facial swelling' }], severity: 'severe' }],
      recordedDate: '2025-03-04T10:00:00Z',
      clinicalStatus: { text: 'active' },
    },
  },
  {
    hospitalID: J, hospitalNumber: '10045321',
    resource: {
      resourceType: 'MedicationRequest', id: 'med-juth-001', status: 'active', intent: 'order',
      medicationCodeableConcept: { text: 'Bisoprolol 2.5mg' },
      dosageInstruction: [{ text: '1 tablet each morning' }],
      authoredOn: '2026-08-05T11:20:00Z',
      requester: { display: 'Dr. Bello Abdullahi — JUTH' },
    },
  },
  {
    hospitalID: J, hospitalNumber: '10045321',
    resource: {
      resourceType: 'Condition', id: 'cond-juth-001',
      code: { text: 'Paroxysmal supraventricular tachycardia' },
      recordedDate: '2026-08-05T11:00:00Z',
      clinicalStatus: { text: 'active' },
    },
  },
  {
    hospitalID: L, hospitalNumber: '104892',
    resource: {
      resourceType: 'AllergyIntolerance', id: 'allergy-langtang-101',
      code: { text: 'Ibuprofen (NSAIDs)' },
      reaction: [{ manifestation: [{ text: 'Bronchospasm' }], severity: 'moderate' }],
      recordedDate: '2026-09-15T09:20:00Z',
      clinicalStatus: { text: 'active' },
    },
  },
  {
    hospitalID: O, hospitalNumber: 'OLA-7891',
    resource: {
      resourceType: 'AllergyIntolerance', id: 'allergy-ola-301',
      code: { text: 'Latex' },
      reaction: [{ manifestation: [{ text: 'Contact dermatitis' }], severity: 'mild' }],
      recordedDate: '2025-08-20T09:00:00Z',
      clinicalStatus: { text: 'active' },
    },
  },
  {
    hospitalID: O, hospitalNumber: 'OLA-7891',
    resource: {
      resourceType: 'Condition', id: 'cond-ola-301',
      code: { text: 'Asthma (mild intermittent)' },
      recordedDate: '2024-02-11T09:00:00Z',
      clinicalStatus: { text: 'active' },
    },
  },

  // ── Our Lady of Apostles — Fatima and Chinedu ──
  {
    hospitalID: O, hospitalNumber: 'OLA-7891',
    resource: {
      resourceType: 'DocumentReference', id: 'doc-ola-301', status: 'current',
      type: { text: 'Discharge summary' },
      description: 'Discharge summary: appendicectomy, 2025',
      date: '2025-08-22T12:00:00Z',
      content: [{ attachment: { contentType: 'text/plain', title: 'Discharge summary', data: 'TGFwYXJvc2NvcGljIGFwcGVuZGljZWN0b215LiBVbmV2ZW50ZnVsIHJlY292ZXJ5LiBEaXNjaGFyZ2VkIGRheSAyLg==' } }],
    },
  },
  {
    hospitalID: O, hospitalNumber: 'OLA-1203',
    resource: {
      resourceType: 'Observation', id: 'obs-ola-401', status: 'final',
      code: { text: 'HbA1c' },
      valueString: '7.8%, above target',
      effectiveDateTime: '2026-10-20T10:00:00Z',
      performer: [{ display: 'Our Lady of Apostles Laboratory' }],
    },
  },
];

// What the JUTH demo FHIR server holds (fetched live through the FHIR
// adapter when a clinician opens JUTH records), keyed by JUTH MRN.
const JUTH_FHIR = {
  identifierSystem: 'urn:juth:mrn',
  clientId: 'cevruni-demo',
  clientSecret: 'demo-secret',
  patients: {
    10045321: { id: 'juth-p-1', name: 'Amina Yusuf', birthDate: '1995-03-15' },
    10087654: { id: 'juth-p-2', name: 'Ibrahim Musa', birthDate: '1988-07-22' },
  },
  resources: {
    10087654: [
      { resourceType: 'Encounter', id: 'juth-enc-9', status: 'finished', class: { code: 'AMB', display: 'Ambulatory' }, reasonCode: [{ text: 'Cardiology review: hypertensive heart disease screen' }], period: { start: '2026-10-28T10:00:00Z' }, serviceProvider: { display: 'JUTH EMR (live FHIR)' } },
      { resourceType: 'DiagnosticReport', id: 'juth-dr-9', status: 'final', code: { text: 'Echocardiogram' }, conclusion: 'Mild concentric left ventricular hypertrophy. LVEF 58%.', effectiveDateTime: '2026-10-28T10:40:00Z', performer: [{ display: 'JUTH Cardiology (live FHIR)' }] },
      { resourceType: 'Observation', id: 'juth-obs-9', status: 'final', code: { text: 'Lipid profile' }, valueString: 'Total cholesterol 5.9 mmol/L, LDL 3.8 mmol/L', effectiveDateTime: '2026-10-28T09:30:00Z', performer: [{ display: 'JUTH Laboratory (live FHIR)' }] },
      { resourceType: 'MedicationRequest', id: 'juth-med-9', status: 'active', intent: 'order', medicationCodeableConcept: { text: 'Atorvastatin 20mg' }, dosageInstruction: [{ text: '1 tablet at night' }], authoredOn: '2026-10-28T11:00:00Z', requester: { display: 'Dr. Bello Abdullahi — JUTH' } },
    ],
    10045321: [
      { resourceType: 'AllergyIntolerance', id: 'juth-allergy-1', code: { text: 'Sulfonamides (co-trimoxazole)' }, reaction: [{ manifestation: [{ text: 'Rash' }], severity: 'moderate' }], recordedDate: '2024-11-02T09:00:00Z' },
      { resourceType: 'Observation', id: 'juth-obs-1', status: 'final', code: { text: '24-hour Holter monitor' }, valueString: 'Sinus rhythm throughout; occasional isolated ectopics', effectiveDateTime: '2026-08-07T09:00:00Z', performer: [{ display: 'JUTH Cardiology (live FHIR)' }] },
    ],
  },
};

module.exports = { L, W, J, P, O, HOSPITAL_SETUP, USERS, CLINICIANS, ROSTER, PATIENTS, CLINICAL, JUTH_FHIR };
