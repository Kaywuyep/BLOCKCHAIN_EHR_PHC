# TEMPLATE — PatientChain Access Control Policy

> **TEMPLATE. Not an approved policy.** This is a starting point for [Hospital A / Hospital B] to adapt to
> its own policies, identity systems, and legal advice. Replace every `[bracketed]` item. It takes effect
> only when approved by the people listed in §10.

| Field | Value |
|---|---|
| Hospital | [Hospital name] |
| Policy owner | [Name, role] |
| Approved by | [Name, role] |
| Version / effective date | [x.y] / [date] |
| Next review | [date, at most 12 months later] |

## 1. Purpose and scope

Sets who can access PatientChain and the data it references, how access is granted and removed, and how
access is reviewed. Applies to all staff, contractors, systems, and patients using PatientChain at
[Hospital].

## 2. Principles

- **Patient control:** clinicians at another hospital see a patient's records only after the patient grants
  access, or under break-glass (§6).
- **Least privilege:** each person gets only the role they need for their job.
- **Named accounts:** no shared logins. Every action must be traceable to a person or a named system.
- **Accountability:** access to records is recorded in the on-chain audit trail and cannot be erased.

## 3. Roles

| Role | Who | Can | Cannot |
|---|---|---|---|
| `patient` | Registered patients | View own records and access history; grant and revoke access | See other patients |
| `clinician` | Doctors, nurses, [other clinical staff] | Request access; view records the patient has granted; use break-glass (§6) | Administer users or systems |
| `hospital_admin` | [Records office / department admin] | Manage provider registrations for [Hospital]; view audit reports | View clinical content unless also a clinician with a grant |
| `system_admin` | [Named IT staff, max N people] | Operate the system, deploy, manage configuration | View clinical content; grant access on behalf of patients |
| `hl7_interface` | The hospital's interface engine (system identity) | Submit HL7 ADT messages | Use the web app or API for anything else |

Roles are assigned in [the hospital identity provider] and passed to PatientChain in the login token.

## 4. Granting access (joiners and movers)

1. Line manager requests access, stating role and reason, via [form / ticket system].
2. [Approver role] approves.
3. [IT] creates or updates the account in the identity provider and assigns the role.
4. Staff member completes training ([staff-training.md](staff-training.md)) before first login.
5. Records kept: request, approval, date, training completion.

`system_admin` and `hospital_admin` additionally need approval from [Head of IT / DPO].

## 5. Removing access (leavers)

- Disable the identity-provider account **on or before the last working day**. Remove PatientChain roles
  the same day a staff member changes jobs to one that does not need them.
- For system administrators who held Fabric admin keys or escrowed secrets: rotate those credentials (see
  [fabric-production.md](../../operations/fabric-production.md)).

## 6. Break-glass (emergency) access

- Use only when [a patient's life or health is at immediate risk and the patient cannot give consent].
- The clinician must enter a reason. The access is recorded on-chain and flagged.
- [Privacy officer / clinical lead] reviews every break-glass event within [72 hours].
- The patient is informed of the access [method, timing].
- Misuse is handled under [disciplinary policy] and may be a reportable incident.

## 7. Authentication

- Staff log in through [hospital identity provider] using [MFA requirement, e.g. MFA required for
  `system_admin` and `hospital_admin`; recommended for all].
- Sessions time out after [N] minutes of inactivity on shared workstations.
- System identities (HL7 interface, backend Fabric client) use certificates or secrets held in [secret
  store], rotated every [12 months] and on staff change.

## 8. Access review

- [Quarterly]: [Owner] reviews all accounts with `clinician`, `hospital_admin`, `system_admin`, and
  `hl7_interface` roles and removes any that are not needed.
- [Monthly]: [Owner] reviews break-glass events and unusual access patterns from the audit trail.
- Results and actions are recorded in [location].

## 9. Breaches of this policy

Suspected misuse must be reported to [contact] and handled under the incident procedure
([incident-response.md](../../operations/incident-response.md)).

## 10. Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Data Protection Officer | | | |
| Head of IT | | | |
| Clinical governance lead | | | |
