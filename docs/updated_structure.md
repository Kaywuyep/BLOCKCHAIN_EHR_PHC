# PatientChain: System Overview and Data Governance

## 1. Overview

PatientChain is a blockchain-based patient-controlled access and reference system designed to support secure interoperability of health records across hospitals in resource-constrained environments.

The system addresses a common problem in healthcare: a patient's medical history may be distributed across multiple hospitals, while healthcare providers often lack a secure and standardized mechanism for determining whether another institution is authorized to access the patient's records.

PatientChain does **not store patients' clinical records on the blockchain**. Instead, the blockchain stores patient identifiers, references, authorization decisions, and audit information. The actual medical records remain within the hospital or healthcare provider that created and maintains them.

This separation is intentional. It reduces privacy risks, avoids placing sensitive clinical information on an immutable ledger, and allows each healthcare institution to remain responsible for the records in its custody.

## 2. Patient-Controlled Access Model

A key adjustment to the implementation is that patients will **not directly browse or retrieve their complete clinical records through PatientChain**.

Instead, the patient acts as the primary authority for granting or revoking access to healthcare providers.

For example, a patient may have records distributed across:

* Hospital A — consultations and diagnoses
* Hospital B — laboratory investigations
* Hospital C — psychiatric treatment
* Hospital D — medications and prescriptions

These records remain within the respective hospitals.

The patient can use PatientChain to grant a doctor or healthcare provider permission to access relevant records. The authorization may be granted to:

1. A specific healthcare provider;
2. A specific hospital;
3. A specific category of records; or
4. The patient's records within a particular healthcare institution.

The system should therefore support both **grant** and **revoke** operations.

For example:

> A patient visits a new hospital and authorizes a doctor at that hospital to access relevant records from Hospital A. PatientChain records the authorization, and the doctor's system uses that authorization to retrieve the permitted information from Hospital A's local/FHIR-based record system.

The blockchain therefore acts as a **trusted authorization and reference layer**, rather than a centralized repository of medical records.

## 3. Hospital Data Custodianship

Each hospital remains responsible for the clinical information it creates and maintains.

PatientChain does not transfer ownership or custody of the hospital's electronic medical record system to the blockchain network.

The architecture therefore follows this principle:

**Hospital database → stores clinical records**

**FHIR/API layer → provides controlled access to records**

**PatientChain → manages authorization, references and audit events**

**Patient/Provider → controls or exercises authorized access**

For example, a psychiatrist working at Hospital B should not automatically receive access to a patient's psychiatric records held by Hospital A simply because the patient exists on the blockchain.

Access must be explicitly authorized or otherwise legally permitted.

This approach also preserves hospital-level separation. A patient's records from different hospitals do not need to be physically merged into one database merely to support interoperability.

## 4. Privacy and Legal Alignment

PatientChain is designed around the principles of confidentiality, authorization, least-privilege access, accountability and data minimization.

### Nigeria

The Nigerian National Health Act 2014 provides that information concerning a healthcare user, including health status, treatment and stay in a health establishment, is confidential. Disclosure is restricted and includes circumstances such as written patient consent, legal requirements, authorized representatives and serious public-health situations. The Act also requires health establishments holding records to establish controls preventing unauthorized access.

The Nigeria Data Protection Act 2023 also classifies health status as sensitive personal data and establishes obligations around the lawful processing and protection of personal data.

PatientChain therefore implements privacy primarily through **controlled authorization rather than unrestricted data sharing**.

### HIPAA

Where the system is evaluated against HIPAA principles, PatientChain follows the concepts of minimum necessary access, authorization, confidentiality, access controls and auditability.

However, HIPAA generally gives individuals a right to access their own protected health information maintained by covered entities, subject to limited exceptions.

Therefore, PatientChain should not claim that patients are legally prohibited from seeing their own health information.

Instead, the system distinguishes between:

**Patient access to their own records:**
Handled by the hospital/healthcare provider according to applicable law and its patient-access procedures.

**Patient authorization of third-party/provider access:**
Handled through PatientChain.

This distinction allows PatientChain to remain focused on its core research contribution: **patient-controlled authorization and cross-hospital record interoperability**.

## 5. Security and Auditability

Every authorization-related action should be auditable.

The blockchain can record events such as:

* Access requested
* Access granted
* Access revoked
* Provider identity
* Hospital/organization
* Record reference
* Scope of authorization
* Timestamp
* Authorization status

The blockchain should **not contain the clinical content itself**.

This is particularly important because blockchain records are designed to be difficult to modify or remove. Storing diagnoses, laboratory results, medications or other identifiable clinical information directly on-chain could create significant privacy and compliance concerns.

Instead, PatientChain stores only the minimum information required to establish and verify authorization and record references.

## 6. Resulting Architecture

The final architecture can therefore be summarized as:

**Patient**
→ grants/revokes authorization

**PatientChain / Hyperledger Fabric**
→ stores authorization, references and audit events

**Hospital A / Hospital B / Hospital C**
→ retain custody of their clinical records

**FHIR/API Adapter**
→ translates an authorized request into a controlled query against the hospital's record system

**Healthcare Provider**
→ receives only the records for which access has been authorized or is otherwise legally permitted

This creates a federated model rather than a centralized medical-record repository.

## 7. Project Scope

The implementation demonstrates the feasibility of this model using Hyperledger Fabric, Go chaincode, Node.js/Express, and a simulated FHIR adapter.

The prototype focuses on:

* Patient registration and identification
* Provider and hospital registration
* Access requests
* Patient authorization
* Access revocation
* Cross-hospital record referencing
* Audit logging
* Offline synchronization
* Transaction-cost measurement
* Separation of blockchain authorization data from hospital clinical data

The prototype does not claim to be a complete production HIPAA or Nigerian healthcare compliance solution. Rather, it demonstrates an architecture that incorporates key privacy, confidentiality, authorization and auditability principles and provides a foundation for integration with real hospital FHIR infrastructure.

## 8. Core Design Principle

> **PatientChain does not put the patient's medical records on the blockchain. It puts the patient's authorization and references on the blockchain while leaving clinical records under the custody of the healthcare institutions that created them.**

This allows hospitals to retain responsibility for their records while giving patients meaningful control over **who can access those records across participating healthcare institutions**.


One important implementation change

I would also change your frontend from a traditional "Patient App → Your Records" model to something closer to:

Patient Portal

My Identity
My Hospitals
Access Permissions
Pending Access Requests
Granted Access
Revoked Access
Providers/Hospitals
Audit/Access History

The patient doesn't need a page that exposes the hospital's actual clinical database. They need a permission-management interface.

And for your defense, I'd phrase the distinction very carefully:

"Patient-controlled" does not mean that the patient becomes the custodian of the medical record. It means that the patient has a mechanism to control and authorize interoperable access to records that remain under the custody and governance of the healthcare provider."

## 9. Second External Review

A second, independent review (`Technical Feedback on PatientChain.docx`, in this folder) assessed this document specifically and confirmed the direction above — the separation of clinical custody from blockchain-based authorization was described as "a sound architectural direction" and "particularly appropriate." It raised five points this document should incorporate:

1. **Patient identity and record matching.** Section 3 above assumes the system can already tell that a record at Hospital A and a record at Hospital B belong to the same patient. That assumption needs its own mechanism — a Master Patient Index that resolves identity across facilities (see `docs/design.md` §4, "Patient Matching / Master Patient Index (MPI)") — rather than being taken for granted.
2. **Authorization is one control, not the only control.** Section 5 (Security and Auditability) should not treat a patient's grant as sufficient on its own. Real deployments also need emergency ("break-glass") access, purpose-of-use limits, consent expiry, and each hospital's own role-based restrictions on its staff (`docs/design.md` §35.1).
3. **Revocation needs two enforcement points, not one.** Because blockchain records are hard to remove, a revocation should be recorded on-chain *and* independently checked by the hospital's FHIR gateway before every record release — the chain alone is not the enforcement point.
4. **The FHIR adapter should mature toward defined resources and profiles**, not stay a generic pass-through (`docs/design.md` §35.2).
5. **The system's positioning should be explicit:** PatientChain is not a replacement for a hospital's EMR/HMIS. It is an interoperability and authorization infrastructure layer that sits above the systems hospitals already run — a framing the reviewer considers important for real-world hospital adoption, since it signals that participating facilities keep their existing systems rather than being asked to give them up.

These points are worked into the full design in `docs/design.md` (§4 and §35) and tracked as open items in `docs/limitations_from_original_design.md`.