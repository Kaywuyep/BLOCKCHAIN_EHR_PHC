# TEMPLATE — PatientChain Staff Training Plan

> **TEMPLATE. Not an approved plan.** A starting point for [Hospital A / Hospital B] to adapt to its own
> training arrangements. Replace every `[bracketed]` item. Training must be completed before a person is
> given a PatientChain role.

| Field | Value |
|---|---|
| Hospital | [Hospital name] |
| Training owner | [Name, role] |
| Approved by | [Name, role] |
| Version / date | [x.y] / [date] |

## 1. Modules

| Module | Audience | Length | Format | Refresh |
|---|---|---|---|---|
| A. Data protection basics (NDPA 2023, confidentiality, what a breach is, how to report) | Everyone with a role | [45 min] | [Classroom / video] | Yearly |
| B. Using PatientChain — clinician | `clinician` | [60 min] | Hands-on in UAT | On major release |
| C. Explaining PatientChain to patients (consent, grants, revocation, access history, permanent audit) | Clinicians, front desk, records staff | [30 min] | Role-play | Yearly |
| D. Break-glass: when it is allowed, how to record a reason, how it is reviewed | `clinician` | [20 min] | Classroom + scenarios | Yearly |
| E. Administration (provider registrations, audit reports, access reviews) | `hospital_admin` | [60 min] | Hands-on | On major release |
| F. Operations (runbook, alerts, backup/restore, HL7 dead-letter handling) | `system_admin`, on-call | [half day] | Hands-on in UAT | Yearly + after DR test |
| G. Incident response (roles, containment steps, escalation) | `system_admin`, incident roles, DPO | [2 h] | Tabletop exercise | Yearly |
| H. Downtime procedure (what to do when PatientChain is unavailable) | All clinical users | [15 min] | Briefing | Yearly |

## 2. Key messages for clinicians

- Look up records from another hospital only for patients in your care, and only with a grant or a genuine
  emergency.
- Every access is recorded permanently and the patient can see it.
- Break-glass is for emergencies only and every use is reviewed.
- Never share your login. Lock or log out of shared workstations.
- If PatientChain shows a record that looks like the wrong patient, stop, do not use it, and report it.
- If PatientChain is down, use the normal downtime procedure; patient care does not wait for the system.

## 3. Completion and records

- Attendance and completion recorded in [training register] with name, module, date, trainer.
- Short check at the end of modules A, B, and D ([e.g. 5 questions, pass mark 80 %]).
- [IT / access approver] checks the training register before assigning a role.
- Staff who miss refresher training by more than [30 days] have access suspended until completed.

## 4. Materials

- [Quick reference card for clinicians]
- [Patient information leaflet, in local languages]
- [Screenshots / short videos of key tasks]
- Operations: [runbook.md](../../operations/runbook.md),
  [incident-response.md](../../operations/incident-response.md)

## 5. Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Training owner | | | |
| Clinical governance lead | | | |
| Data Protection Officer | | | |
