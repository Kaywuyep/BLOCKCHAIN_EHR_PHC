# Hospital and Privacy Approval Checklist

Sign-off checklist for section 7 of [production_ready.md](../production_ready.md). **No live patient data
(PHI) may enter PatientChain until every item below is signed for the hospital concerned.**

> **These items require human decisions and signatures by authorised hospital staff.** Engineering can
> supply evidence (documents, test reports, demonstrations) but **cannot complete, approve, or sign any
> item.** A blank Owner/Date/Evidence cell means the item is not done.

Complete one copy per hospital (Hospital A, Hospital B). Items marked **Joint** need both hospitals.

Hospital: ______________________  Checklist version/date: ______________

## 1. Hospital IT / security approval

| # | Item | Owner (name, role) | Date signed | Evidence (doc ref / link) |
|---|---|---|---|---|
| 1.1 | Architecture and data-flow diagram reviewed by hospital IT security | | | |
| 1.2 | Hosting, network segmentation, firewall rules, and VPN to the other hospital approved | | | |
| 1.3 | MLLP endpoint protection (TLS or VPN, IP allowlist) approved | | | |
| 1.4 | Identity provider integration (OIDC) and role mapping (patient, clinician, hospital_admin, system_admin, hl7_interface) approved | | | |
| 1.5 | Key management approved: HSM or file-key controls, `DATA_ENCRYPTION_KEYS` custody, key escrow holders named | | | |
| 1.6 | Vulnerability scan / penetration test done; high and critical findings closed or risk-accepted in writing | | | |
| 1.7 | Backup, restore, and DR test results reviewed ([runbook.md](../operations/runbook.md) §6) | | | |
| 1.8 | RTO/RPO proposals accepted or amended ([runbook.md](../operations/runbook.md) §7) | | | |
| 1.9 | Monitoring, alert routing, and on-call contacts in place | | | |
| 1.10 | Fabric production setup reviewed ([fabric-production.md](../operations/fabric-production.md) §11) | | | |

## 2. Privacy and clinical governance review

| # | Item | Owner | Date signed | Evidence |
|---|---|---|---|---|
| 2.1 | Data Protection Impact Assessment (DPIA) completed and approved by the DPO | | | |
| 2.2 | DPIA addresses permanence of on-chain entries (DIDs, references, grants, audit) and why no clinical content is on-chain | | | |
| 2.3 | Lawful basis for processing and consent model documented (patient-controlled grants, break-glass) | | | |
| 2.4 | Patient privacy notice updated and available in the languages patients use | | | |
| 2.5 | Clinical governance committee approved use for clinical decision-making, and confirmed downtime procedure | | | |
| 2.6 | Break-glass policy approved: who may use it, justification required, who reviews, how fast | | | |
| 2.7 | Clinical safety review of HL7 field mapping (wrong-patient matching risk) | | | |
| 2.8 | Ethics/research approval confirmed if the deployment is part of thesis evaluation with real patients | | | |

## 3. Data-processing agreements (Joint)

| # | Item | Owner | Date signed | Evidence |
|---|---|---|---|---|
| 3.1 | Data-sharing / data-processing agreement between Hospital A and Hospital B signed | | | |
| 3.2 | Agreement covers: purpose limitation, roles (controller/processor), security duties, breach notification between parties, audit rights | | | |
| 3.3 | Network governance agreed: admin key holders, endorsement policy, change approval, chaincode upgrade approval ([fabric-production.md](../operations/fabric-production.md) §6) | | | |
| 3.4 | Exit terms: what happens to each hospital's ledger copy and off-chain data if a hospital leaves | | | |
| 3.5 | Agreements with any third-party hosting or support vendors | | | |

## 4. Access and retention policies

| # | Item | Owner | Date signed | Evidence |
|---|---|---|---|---|
| 4.1 | Access-control policy adopted ([policies/access-control-policy.md](policies/access-control-policy.md)) | | | |
| 4.2 | Joiner/mover/leaver process linked to the identity provider | | | |
| 4.3 | Quarterly access review owner named | | | |
| 4.4 | Data-retention policy adopted with legally confirmed periods ([policies/data-retention-policy.md](policies/data-retention-policy.md)) | | | |
| 4.5 | Log and backup retention configured to match the policy | | | |

## 5. Staff training

| # | Item | Owner | Date signed | Evidence |
|---|---|---|---|---|
| 5.1 | Training plan adopted ([policies/staff-training.md](policies/staff-training.md)) | | | |
| 5.2 | All pilot clinicians and records staff trained; attendance register kept | | | |
| 5.3 | Administrators and on-call staff trained on runbook and incident procedure | | | |
| 5.4 | Patient-facing staff able to explain consent, grants, and revocation to patients | | | |

## 6. Incident and breach procedures

| # | Item | Owner | Date signed | Evidence |
|---|---|---|---|---|
| 6.1 | Incident procedure approved by DPO ([incident-response.md](../operations/incident-response.md)) | | | |
| 6.2 | Incident roles and 24/7 contacts filled in for both hospitals | | | |
| 6.3 | NDPC breach notification route confirmed by DPO | | | |
| 6.4 | Tabletop exercise held with both hospitals | | | |

## 7. User acceptance testing (UAT) sign-off

UAT is run in the hospital's test environment with synthetic or approved test data only. Attach the test
script and results.

```
PATIENTCHAIN UAT SIGN-OFF

Hospital:                         Environment:
Release / version:                Chaincode version & sequence:
UAT period:  from ________ to ________

Scope tested                                              Pass / Fail / N/A   Notes
- Patient registration and DID creation                   [   ]
- HL7 ADT ingestion (A01, A02, A03, A04, A08, vendor-specific) [   ]
- ACK/NACK, retry, dead-letter, replay after downtime     [   ]
- Duplicate detection on MSH-10                           [   ]
- Access request / grant / revoke by patient              [   ]
- Cross-hospital record retrieval                         [   ]
- Break-glass access and review                           [   ]
- Audit trail visible to patient and admin                [   ]
- Role-based access (each role sees only what it should)  [   ]
- Login via hospital identity provider                    [   ]
- Behaviour when the other hospital is offline            [   ]
- Backup and restore                                      [   ]
- No PHI in logs                                          [   ]

Open defects (ID, severity, agreed action):

Decision:   [ ] Accepted   [ ] Accepted with conditions   [ ] Rejected
Conditions:

Signed (hospital clinical lead):    Name ____________  Signature ________  Date ______
Signed (hospital IT lead):          Name ____________  Signature ________  Date ______
Signed (DPO):                       Name ____________  Signature ________  Date ______
Witnessed (project engineer):       Name ____________  Signature ________  Date ______
```

## 8. Final go/no-go for live PHI

| Role | Name | Decision (Go / No-go) | Signature | Date |
|---|---|---|---|---|
| Hospital management (Medical Director or delegate) | | | | |
| Head of IT | | | | |
| Data Protection Officer | | | | |
| Clinical governance lead | | | | |
