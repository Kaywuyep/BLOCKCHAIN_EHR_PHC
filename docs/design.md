### PatientChain — Full System Design
1. Design Objective

PatientChain is a federated, blockchain-based authorization and health-record reference platform for interoperability between healthcare institutions.

It is not a centralized Electronic Medical Record (EMR) and does not replace hospital information systems.

The system has four fundamental responsibilities:

Establish a trusted identity for patients, providers and hospitals.
Allow patients to grant and revoke provider access.
Provide references that allow an authorized provider to locate records held by another hospital.
Maintain an immutable audit trail of authorization and access-related transactions.

The clinical data remains with the hospital that generated it.

2. High-Level Architecture
                           ┌───────────────────┐
                           │      PATIENT      │
                           │                   │
                           │ • View permissions│
                           │ • Grant access    │
                           │ • Revoke access   │
                           │ • Review requests │
                           └─────────┬─────────┘
                                     │
                                     │ Authorization
                                     ▼
                    ┌────────────────────────────────┐
                    │          PATIENTCHAIN           │
                    │                                │
                    │      Hyperledger Fabric        │
                    │                                │
                    │ ┌────────────┐ ┌─────────────┐ │
                    │ │ Patient    │ │ Access      │ │
                    │ │ Registry   │ │ Control     │ │
                    │ └────────────┘ └─────────────┘ │
                    │                                │
                    │ ┌────────────┐ ┌─────────────┐ │
                    │ │ Record     │ │ Audit       │ │
                    │ │ Reference  │ │ Log         │ │
                    │ └────────────┘ └─────────────┘ │
                    └───────────────┬────────────────┘
                                    │
                         Authorization / Reference
                                    │
              ┌─────────────────────┴─────────────────────┐
              │                                           │
              ▼                                           ▼
      ┌───────────────────┐                       ┌───────────────────┐
      │    HOSPITAL A     │                       │    HOSPITAL B     │
      │                   │                       │                   │
      │ EMR/HIS           │                       │ EMR/HIS           │
      │ FHIR R4 Server    │                       │ FHIR R4 Server    │
      │                   │                       │                   │
      │ Clinical Records  │                       │ Clinical Records  │
      └───────────────────┘                       └───────────────────┘

The key architectural principle is:

Blockchain stores authorization and references; hospitals store clinical data.

3. System Layers

I recommend using six layers rather than only five.

Layer 1 — Presentation

Applications used by:

Patient
Patient Portal

Dashboard
├── My Profile
├── Access Requests
├── Active Permissions
├── Hospitals
├── Providers
├── Access History
└── Revoke Access
Clinician
Clinician Portal

Dashboard
├── Patient Search
├── Access Requests
├── Authorized Patients
├── Patient Records
└── Access History
Hospital Administrator
Hospital Admin

Dashboard
├── Hospital Profile
├── Providers
├── Patients
├── FHIR Connection
├── Access Policies
├── Audit Logs
└── System Health
4. Identity Layer

This is something I would add strongly to your current implementation.

You need three primary identities.

Patient Identity
Patient
   ↓
PatientChain ID
   ↓
Hospital-specific identifiers

For example:

PatientChain ID: PC-P-00192

Hospital A MRN: HOSP-A-83920
Hospital B MRN: HOSP-B-44219

Do not use the hospital MRN as the global blockchain identity.

The MRN belongs to the hospital.

PatientChain should maintain a mapping/reference.

Patient Matching / Master Patient Index (MPI)

An external review (see `Technical Feedback on PatientChain.docx` in this folder) correctly points out that the mapping above is incomplete on its own: it describes how a PatientChain ID maps to hospital MRNs once a patient is known to be the same person, but not how the system decides that two records at different hospitals belong to the same patient in the first place.

That is a Master Patient Index (MPI) problem, and it should be solved off-chain, in an identity service, not on the ledger:

Registration
   │
   ▼
Demographic attributes
(name, DOB, sex, phone, NIN where available, hospital MRN)
   │
   ▼
Matching algorithm
   ├── Deterministic match (exact identifier, e.g. NIN)
   └── Probabilistic match (weighted demographic similarity)
   │
   ▼
Confident match → auto-link to existing PatientChain ID
Possible duplicate → manual review queue (hospital registrar resolves)

Only once a patient is matched, or confirmed new, does the identity service mint or reuse a PatientChain ID and write the reference mapping. The demographic attributes used for matching stay inside the identity service's own database — they never go on-chain; only the resulting PatientChain ID ↔ hospital-MRN reference does.

For a Nigerian deployment, the National Identification Number (NIN) is the strongest deterministic key where a patient has one and has consented to its use; the algorithm should fall back to probabilistic demographic matching when it isn't available, and always leave a manual-review path for low-confidence matches rather than auto-merging two records.

Provider Identity

Every doctor should have:

Provider ID
Full name
Professional registration reference
Hospital
Department
Role
Status
Public key / credentials

Example:

Provider ID: PC-D-0081

Name: Dr. John Doe
Hospital: Hospital B
Department: Internal Medicine
Role: Physician
Status: ACTIVE

For a real Nigerian implementation, provider verification would need to integrate with the hospital's credentialing process and appropriate professional-registration verification.

5. Hospital Identity

Every participating hospital becomes an organization in the Fabric network.

Hospital A
    │
    ├── Organization ID
    ├── MSP
    ├── Certificate Authority
    ├── Providers
    └── FHIR endpoint

Hospital B
    │
    ├── Organization ID
    ├── MSP
    ├── Certificate Authority
    ├── Providers
    └── FHIR endpoint

Your existing:

2 hospital orgs + orderer + Raft

is therefore a good starting point.

6. Blockchain Layer

I would retain your four chaincodes/modules.

PatientRegistry

Responsible for:

RegisterPatient()
GetPatient()
UpdatePatientReference()
RegisterProvider()
RegisterHospital()
GetPatientHospitals()

Importantly, this registry should contain references, not clinical information.

7. AccessControl

This becomes the most important smart contract.

It should support:

RequestAccess()
GrantAccess()
RejectAccess()
RevokeAccess()
CheckAccess()
GetActivePermissions()
GetAccessRequests()

An authorization object might look conceptually like:

{
  "permissionId": "PERM-001",
  "patientId": "PC-P-00192",
  "providerId": "PC-D-0081",
  "hospitalId": "HOSP-B",
  "sourceHospitalId": "HOSP-A",
  "scope": [
    "Observation",
    "DiagnosticReport",
    "MedicationRequest"
  ],
  "purpose": "Treatment",
  "status": "GRANTED",
  "createdAt": "...",
  "expiresAt": "..."
}
8. Granular Authorization

I strongly recommend scope-based authorization.

Don't make the permission simply:

ACCESS = TRUE

Instead:

Patient
   │
   ├── Doctor A
   │      ├── Lab results ✓
   │      ├── Medication ✓
   │      └── Psychiatric records ✗
   │
   └── Doctor B
          ├── Lab results ✓
          ├── Medication ✗
          └── Psychiatric records ✗

This is much more realistic.

FHIR resources give you a natural way of defining scopes:

Patient
Observation
DiagnosticReport
MedicationRequest
MedicationStatement
Condition
Procedure
AllergyIntolerance
Immunization
Encounter
DocumentReference

You don't necessarily need to implement every resource for the prototype.

Start with:

Patient
Observation
DiagnosticReport
MedicationRequest
Condition
Encounter
9. Hospital-Level Authorization

Your previous requirement about hospitals is important.

Don't force the patient to add individual doctors one by one in every situation.

Support:

Provider
Grant to:

Dr. John Doe
Hospital A
Organization
Grant to:

Hospital A

Scope:
Laboratory + Medication

Then the hospital can determine which authorized clinical users can access the permitted information according to its internal RBAC policies.

This gives you:

Patient
     │
     ├── Grant → Doctor
     │
     └── Grant → Hospital
10. Access Request Workflow

The clinician should request access rather than simply querying the patient's data.

Step 1

Doctor searches for patient.

Patient:
PC-P-00192

Status:
Patient found

[Request Access]
Step 2

Doctor specifies:

Hospital:
Hospital A

Purpose:
Treatment

Requested records:

☑ Laboratory
☑ Medications
☐ Psychiatric
☐ Imaging
Step 3

Patient receives:

ACCESS REQUEST

Dr. John Doe
Hospital B

Requesting:
Laboratory
Medication

Purpose:
Treatment

[GRANT]
[REJECT]
Step 4

Patient grants access.

Step 5

Fabric records the authorization.

Step 6

Doctor queries Hospital A.

Step 7

Hospital A verifies authorization.

Step 8

Hospital A returns the permitted FHIR resources.

11. Record Resolution

This is where your fhirAdapter.js becomes very important.

The flow should be:

Doctor
   │
   ▼
PatientChain API
   │
   ▼
CheckAccess()
   │
   ├── DENIED → Stop
   │
   └── GRANTED
          │
          ▼
    Record Reference
          │
          ▼
   Hospital FHIR API
          │
          ▼
   FHIR Resources

PatientChain never needs to retrieve everything.

It retrieves only what the authorization allows.

12. FHIR Architecture

Eventually:

PatientChain
      │
      ▼
FHIR Adapter
      │
      ├──── Hospital A
      │       │
      │       └── FHIR R4
      │
      ├──── Hospital B
      │       │
      │       └── FHIR R4
      │
      └──── Hospital C
              │
              └── FHIR R4

The adapter should hide hospital-specific differences.

For example:

getPatientRecords(
    hospitalId,
    patientReference,
    scope
)

rather than:

getHospitalARecords()
13. Important Privacy Architecture

Never do:

Blockchain
    ↓
Patient diagnosis
Patient medication
Patient psychiatric notes
Patient laboratory results

Instead:

Blockchain

Patient ID
Provider ID
Hospital ID
Record Reference
Permission
Scope
Timestamp
Audit Event

Clinical information:

Hospital database

Diagnosis
Medication
Lab
Imaging
Clinical notes
Psychiatric records

This is one of the strongest architectural decisions in your project.

14. Encryption

For a real system, add encryption at multiple levels.

In transit
TLS 1.2/1.3

between:

Patient → API
Doctor → API
API → FHIR server
Hospital → PatientChain
At rest

Hospital databases should use encryption at rest.

Sensitive application secrets should not live in source code or .env files in production.

Use something like:

Vault / managed secrets service

for production.

15. Authentication

I would introduce an identity provider.

For example:

Patient
     │
     ▼
Identity Provider
     │
     ▼
JWT / OAuth2 / OpenID Connect
     │
     ▼
PatientChain API

And similarly:

Doctor
  ↓
Hospital Identity Provider
  ↓
OIDC
  ↓
PatientChain

Your prototype can use a simpler implementation initially, but your full architecture should include proper identity management.

16. Authorization Architecture

You actually need two levels of authorization.

Level 1 — Blockchain authorization
Has patient granted access?
Level 2 — Hospital authorization
Is this person actually permitted to access this record within the hospital?

So:

Doctor
  │
  ▼
Hospital Authentication
  │
  ▼
Hospital RBAC
  │
  ▼
PatientChain Permission
  │
  ▼
FHIR Access Policy
  │
  ▼
Clinical Record

This is much safer than making the blockchain permission the only security mechanism.

17. Audit Architecture

Every important action should generate an audit event.

Examples:

ACCESS_REQUESTED
ACCESS_GRANTED
ACCESS_REJECTED
ACCESS_REVOKED
RECORD_REFERENCE_RESOLVED
RECORD_ACCESSED
UNAUTHORIZED_ACCESS_ATTEMPT

Example:

{
  "event": "ACCESS_GRANTED",
  "patientId": "PC-P-00192",
  "providerId": "PC-D-0081",
  "hospitalId": "HOSP-B",
  "scope": ["Observation"],
  "timestamp": "...",
  "transactionId": "..."
}

Do not put sensitive clinical payloads into the audit log.

18. Revocation

Revocation needs special attention.

Suppose:

09:00 → Patient grants access
10:00 → Doctor accesses records
11:00 → Patient revokes access

At 11:01:

CheckAccess()
      ↓
REVOKED
      ↓
No new access

However, revocation cannot magically erase information the doctor has already legitimately received.

This is an important limitation you should explicitly document.

The system controls future access, not information that has already been legitimately disclosed.

19. Offline Architecture

Your existing offline queue is good.

I would structure it as:

Hospital B
     │
     ▼
Offline Queue
     │
     ├── Access Request
     ├── Grant
     ├── Revoke
     └── Audit Event
     │
     ▼
Connection restored
     │
     ▼
Synchronization
     │
     ▼
Fabric

But introduce transaction IDs and timestamps to prevent duplicate operations.

For example:

transactionId
deviceId
createdAt
operation
payloadHash
status
20. Conflict Resolution

Suppose:

Device A:
GRANT

Device B:
REVOKE

while offline.

You need a deterministic rule.

For example:

The latest valid authorization transaction wins according to the authoritative ordering mechanism.

Fabric's ordering service can provide the final transaction order once transactions reach the network.

You should document this explicitly.

21. Network Architecture

For your two-hospital prototype:

                   ORDERER
                     │
              Raft Consensus
                     │
         ┌───────────┴───────────┐
         │                       │
         ▼                       ▼
   Hospital A Org          Hospital B Org
         │                       │
     Peer 0                  Peer 0
         │                       │
         └───────────┬───────────┘
                     │
                  Channel
                     │
                PatientChain

For a real deployment, I would avoid having every hospital automatically share everything.

Use Fabric's organization/channel/private-data capabilities according to your governance and privacy requirements.

22. Nigerian Deployment Model

I would recommend a federated hospital model.

              PatientChain Governance
                       │
          ┌────────────┴────────────┐
          │                         │
     Hospital A                Hospital B
          │                         │
     EMR/FHIR                  EMR/FHIR
          │                         │
          └────────────┬────────────┘
                       │
                  PatientChain

Each hospital retains:

its EMR
its database
its clinical records
its staff accounts
its internal access controls

PatientChain provides:

cross-institution authorization
record references
auditability
interoperability coordination

This is much more realistic than trying to create one blockchain containing every Nigerian patient's medical records.

23. Patient Portal

Your patient application should not be called "My Medical Records" if you want the system's role to be very clear.

I would use:

PatientChain
Dashboard

Welcome, Patient

Access Requests
───────────────
2 pending requests

Active Permissions
───────────────────
3 providers
2 hospitals

Recent Activity
────────────────
Dr. John Doe accessed Laboratory Record
Hospital B requested Medication Records

Then:

Active Permissions
Dr. John Doe
Hospital B

Access:
✓ Laboratory
✓ Medication
✗ Psychiatric

Granted:
07 Sept 2026

Expires:
07 Oct 2026

[REVOKE]
24. Clinician Portal
Dashboard

My Patients
Access Requests
Authorized Records
Recent Access

Patient:

Patient: PC-P-00192

Authorization Status:

Hospital A
✓ Laboratory
✓ Medication
✗ Psychiatric

[View Authorized Records]

The clinician shouldn't see:

"View All Patient Data"

unless that level of access has explicitly been authorized and is permitted by hospital policy.

25. Hospital Admin

Hospital administrators need:

Providers
Patients
FHIR Configuration
Access Policies
Audit
System Status

For example:

FHIR Status

Hospital FHIR Server
● Connected

Last synchronization:
14:32:08

FHIR Version:
R4
26. Data Model

A simplified relational model outside Fabric could be:

users
─────
id
type
identity_id

patients
────────
patient_id
status

providers
─────────
provider_id
hospital_id
role
status

hospitals
─────────
hospital_id
name
fhir_endpoint
status

record_references
─────────────────
reference_id
patient_id
hospital_id
resource_type
resource_id

permissions
───────────
permission_id
patient_id
provider_id
hospital_id
source_hospital_id
scope
purpose
status
created_at
expires_at

access_requests
───────────────
request_id
patient_id
provider_id
hospital_id
scope
purpose
status

audit_events
────────────
event_id
actor_id
event_type
patient_id
timestamp
transaction_id
27. Smart Contract State

Fabric should have corresponding assets.

Patient
PatientAsset
Provider
ProviderAsset
Hospital
HospitalAsset
Permission
AccessPermissionAsset
Record reference
RecordReferenceAsset
Audit event
AuditEventAsset
28. API Design

Your Node backend could expose:

/api/auth
/api/patients
/api/providers
/api/hospitals
/api/access
/api/records
/api/audit
/api/sync
Patient
GET /api/patients/:id
GET /api/patients/:id/permissions
GET /api/patients/:id/requests
Access
POST /api/access/request
POST /api/access/:id/grant
POST /api/access/:id/reject
POST /api/access/:id/revoke
GET  /api/access/check
Records
GET /api/records/:patientId

But this endpoint must first perform authorization.

Conceptually:

if (!hasPermission(patient, provider, requestedScope)) {
    return 403;
}

return fhirAdapter.getRecords(...);
29. Important Security Rule

Never trust the frontend.

Don't do:

Frontend:
"scope = laboratory"

Backend:
"Okay."

The backend must independently determine:

Authenticated user?
        ↓
Provider verified?
        ↓
Patient exists?
        ↓
Permission exists?
        ↓
Permission active?
        ↓
Requested resource within scope?
        ↓
Hospital allows provider?
        ↓
FHIR request
30. Compliance Position

For your thesis, I would use this language:

PatientChain is designed around privacy, confidentiality, authorization, data minimization, least-privilege access and auditability principles relevant to Nigerian health-data regulation and HIPAA-aligned security practices. It is not itself claimed to constitute a fully HIPAA-compliant or legally compliant healthcare deployment.

That distinction is extremely important.

Also, don't say:

"PatientChain is HIPAA compliant."

Say:

"PatientChain incorporates HIPAA-aligned privacy and security principles."

And for Nigeria:

"PatientChain is designed to support applicable Nigerian health-data protection and confidentiality requirements."

Actual deployment would require a formal legal/privacy assessment.

31. What Goes On-Chain vs Off-Chain

This should probably become one of your thesis diagrams.

Data	Blockchain	Hospital
PatientChain ID	✓	✓ reference
Hospital ID	✓	✓
Provider ID	✓	✓
Access permission	✓	✓
Access request	✓	✓
Audit event	✓	✓
Record reference	✓	✓
Diagnosis	✗	✓
Laboratory result	✗	✓
Medication details	✗	✓
Psychiatric notes	✗	✓
Medical images	✗	✓
Clinical documents	✗	✓

This separation should be one of the defining characteristics of PatientChain.

32. Recommended Development Phases

Don't try to build everything simultaneously.

Phase 1 — Core Fabric

Implement:

PatientRegistry
ProviderRegistry
HospitalRegistry
AccessControl
AuditLog

Design the Master Patient Index / identity-matching rules and the break-glass, purpose-of-use and consent-expiry policies now, even though most of the logic lands inside AccessControl and the identity service rather than as separate chaincodes — see Section 35.
Phase 2 — Backend

Implement:

Authentication
Patient API
Provider API
Access API
Record API
Audit API
Phase 3 — Patient Portal

Implement:

Access Requests
Grant
Reject
Revoke
Permission Management
Audit History
Phase 4 — Clinician Portal

Implement:

Patient search
Access request
Authorization status
Record retrieval
Phase 5 — Simulated FHIR

Create two simulated hospitals:

Hospital A FHIR
Hospital B FHIR

with realistic FHIR resources.

Phase 6 — Real FHIR Server

Replace:

fhirAdapter.js

with actual:

FHIR R4 API

For the pilot, you can run your own FHIR server rather than immediately connecting to a hospital's production EMR.

Phase 7 — Real Fabric

Deploy:

Hospital A Org
Hospital B Org
Orderer
CA
Peers
Channel
Chaincode
Phase 8 — Pilot

Start with:

2 hospitals
5–20 providers
20–50 synthetic/de-identified patients

and evaluate the system.

33. What I Would Change in Your Existing Repository

Your current structure:

patientchain/
├── chaincode/
├── network/
├── backend/
├── frontend/
└── docs/

is good.

I would evolve it to:

patientchain/
│
├── chaincode/
│   ├── patientregistry/
│   ├── accesscontrol/
│   ├── auditlog/
│   ├── recordreference/
│   └── costmetrics/
│
├── network/
│   ├── organizations/
│   │   ├── hospital-a/
│   │   └── hospital-b/
│   ├── channel/
│   ├── config/
│   └── scripts/
│
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── services/
│   │   │   ├── fabric/
│   │   │   ├── fhir/
│   │   │   ├── identity/
│   │   │   ├── authorization/
│   │   │   └── audit/
│   │   ├── middleware/
│   │   ├── sync/
│   │   └── utils/
│   └── tests/
│
├── frontend/
│   └── src/
│       ├── pages/
│       │   ├── patient/
│       │   ├── clinician/
│       │   └── admin/
│       ├── components/
│       └── services/
│
├── fhir/
│   ├── hospital-a/
│   ├── hospital-b/
│   └── seed-data/
│
├── docs/
│   ├── architecture.md
│   ├── security.md
│   ├── privacy.md
│   ├── api.md
│   ├── fhir.md
│   └── pilot.md
│
└── docker-compose.yml
34. The Most Important Design Decision

If this were my project, I would make this the central architectural statement:

PatientChain is not a blockchain medical-record repository. It is a patient-controlled authorization and reference layer that enables authorized healthcare providers to securely locate and retrieve appropriate records from the hospitals that retain custody of those records.

That gives you a much cleaner separation between:

Patient control

and

hospital data custodianship.

It also makes the architecture substantially more realistic for a Nigerian multi-hospital deployment.

35. Addendum — Incorporating the Second External Technical Review

A follow-up review (`Technical Feedback on PatientChain.docx`, from a reviewer with hands-on CoreHealth/HMIS deployment experience) confirmed the core direction above — clinical data stays at the hospital, the blockchain stores only authorization, reference and audit data — and raised four further points that this design now folds in.

35.1 Authorization is one layer, not the only layer

Section 16 already separates blockchain authorization (has the patient granted access?) from hospital authorization (is this person actually permitted to see this record inside the hospital?). The review adds three concrete policies that sit inside that second layer and must be designed explicitly rather than assumed:

- Break-glass / emergency access — a clinician can request emergency override access to a patient's record without a prior grant, but every break-glass access must (a) require a stated emergency justification, (b) be flagged and logged as `BREAK_GLASS_ACCESS`, distinct from a normal `ACCESS_GRANTED` event, and (c) trigger a mandatory post-hoc review by the hospital and be visible to the patient afterwards.
- Purpose-of-use and consent expiry — every permission carries a `purpose` (e.g. "Treatment", "Referral") and an `expiresAt`. `CheckAccess()` must reject a request whose stated purpose doesn't match the granted purpose, or whose permission has expired, even if it was never explicitly revoked.
- Provider role restrictions — a hospital's own RBAC decides which of its staff may exercise a patient-granted permission. A permission granted to "Hospital B" doesn't mean every employee of Hospital B can use it — only staff whose role and department match the permission's scope, per the hospital's own policy.

35.2 Expanded FHIR resource & profile coverage

Section 8's starting resource set (Patient, Observation, DiagnosticReport, MedicationRequest, Condition, Encounter) stays as the prototype's scope, but the design should name the resources deferred to later phases so the FHIR adapter's interface doesn't have to change shape later: Practitioner, Organization, AllergyIntolerance, Immunization, Procedure and DocumentReference. Phase 6 (Real FHIR Server) should also define which FHIR conformance profile the adapter targets, rather than an ad hoc subset of fields.

35.3 The blockchain has to earn its place

The review's most important challenge: what does Hyperledger Fabric provide here that a conventional federated authorization/audit service — a regular multi-tenant database with an API — could not? The honest answer for this project is tamper-evident, multi-party-witnessed authorization history: no single hospital, including the one whose provider requested access, can unilaterally alter or erase a `GRANT`/`REVOKE` record after the fact, because every participating organization's peer independently validates and commits it. That is a real property a conventional single-operator database does not give you for free.

This design should stop treating that as self-evident and instead measure it. Phase 8's pilot (Section 32) should report, at minimum:

- Authorization latency — time from `GrantAccess()` submission to committed block
- Interoperability success rate — % of authorized record requests resolved end-to-end (doctor → `CheckAccess` → FHIR adapter → response)
- Revocation effectiveness — time from a committed `RevokeAccess()` to the FHIR gateway actually refusing a subsequent request
- Audit integrity — % of access events with a matching, verifiable on-chain audit record
- Offline synchronization — queue drain time and conflict rate after a simulated hospital outage
- Transaction throughput — Caliper-benchmarked TPS for the four chaincodes under pilot-scale load
- Data-access accuracy — % of returned records that were actually within the granted scope (should be 100%; any deviation is a bug)

These are the numbers Section 3.12 of the paper and `costModel.js`'s "illustrative until Caliper" caveat already point to — the review is asking for them to be treated as a required deliverable, not an optional nice-to-have.

35.4 Positioning statement

The review's own framing is worth adopting verbatim for the thesis defense and README: PatientChain should be positioned "not as a replacement for EMR/HMIS platforms, but as an interoperability and authorization infrastructure layer that can sit above heterogeneous healthcare information systems." That sharpens Section 34's "central architectural statement" with an explicit reassurance to participating hospitals — PatientChain is not there to replace their existing systems — which the review flags as important for real-world adoption.

One further recommendation

Before you start modifying the code, we should turn this into three concrete deliverables:

System architecture diagram — complete production/pilot architecture.
Database + Fabric data model — exact entities, fields and relationships.
End-to-end workflows — patient registration → doctor request → patient grant → FHIR retrieval → audit → revoke, including all error/security cases.

Those three will give you the actual blueprint from which we can then modify your existing repository rather than building features ad hoc.