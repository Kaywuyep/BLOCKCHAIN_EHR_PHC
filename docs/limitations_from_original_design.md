### Limitations Compared with the Original Design

| Original Design | Current/Adjusted Implementation | Limitation |
|---|---|---|
| **Patient-controlled health record access** | Patient controls **provider access**, not direct viewing of records | The implementation narrows “patient-controlled” to **patient-controlled authorization**. Patients do not directly interact with their clinical data through the system. |
| **Patient App** | Patient portal primarily manages permissions | The patient-facing functionality is reduced. It is an authorization-management interface rather than a complete personal health-record application. |
| **React Native + PWA** | React web application | The implementation is a web prototype rather than the mobile/PWA architecture described in the original paper. |
| **Real hospital/FHIR interoperability** | Simulated `fhirAdapter.js` | The system demonstrates the interoperability concept but does not yet communicate with real hospital FHIR R4 servers. |
| **Cross-hospital records** | Simulated hospital databases | Cross-hospital interoperability is demonstrated conceptually rather than through actual independent hospital infrastructures. |
| **Production Fabric network** | Can run Fabric, but development primarily uses simulator | Much of the demonstration can operate without a real blockchain network, so real Fabric performance cannot be inferred from the demo. |
| **Fabric chaincode events** | `getRecentEvents()` is a no-op | Real-time blockchain event monitoring is not fully implemented. |
| **Cost optimisation/benchmarking** | Illustrative `Ce`, `Co`, `Cv` values | The reported cost benefits are not experimentally validated until Caliper benchmarking is performed. |
| **Offline-first operation** | SQLite-backed queue | Offline synchronization is implemented at prototype level; conflict resolution and large-scale reliability have not been validated. |
| **HIPAA/Nigerian compliance** | Privacy-aware architecture | The prototype should **not claim to be HIPAA- or NDPA-compliant**. Compliance requires organizational, technical, legal, and operational controls beyond the software itself. |
| **Patient access to information** | Patient does not directly see clinical records | This is an intentional scope change, but it means the system does not itself implement the patient's legal right to obtain/access their health records. That remains with the healthcare provider. |
| **Provider access** | Authorization-based access | The system needs additional real-world identity, authentication, role/credential verification, and consent mechanisms before it could safely authorize actual clinicians. |
| **Patient identity resolution (MPI)** | Conceptual PatientChain-ID ↔ MRN mapping only, no matching logic | There is no implemented Master Patient Index — a mechanism to reliably decide that two records at different hospitals belong to the same patient (deterministic/probabilistic demographic matching, duplicate handling) is designed (`docs/design.md` §4) but not yet built. |
| **Layered access control** | Patient authorization only | A second reviewer noted that patient authorization should be one layer within a broader policy framework. Break-glass/emergency access, purpose-of-use limits, consent expiry, and hospital-side role restrictions are designed (`docs/design.md` §35.1) but not yet implemented. |
| **FHIR resource/profile coverage** | Fixed subset: Patient, Observation, DiagnosticReport, MedicationRequest, Condition, Encounter | Practitioner, Organization, AllergyIntolerance, Immunization, Procedure, DocumentReference, and a defined FHIR conformance profile are deferred to later phases (`docs/design.md` §35.2). |
| **Blockchain's specific value proposition** | Assumed rather than measured | The benefit of Hyperledger Fabric over a conventional federated authorization/audit service without blockchain has not yet been benchmarked. Authorization latency, interoperability success rate, revocation effectiveness, audit integrity, offline sync, transaction throughput and data-access accuracy are defined as required pilot metrics (`docs/design.md` §35.3) but not yet collected. |

#### The biggest conceptual limitation

The most important difference is this:

- Original concept:
`Patient → controls access to their health records`

- Your implemented concept:
`Patient → controls who is authorized to access their hospital-held health records`

##### limitations from database
SQLite. It's an embedded, serverless file — no daemon or network connection
  required to read/write it — so a hospital node can keep operating fully
  offline and just sync the file/queue later; that's exactly why it's already
  your choice for offlineQueue.js and fits the "resource-constrained
  environment" framing of the paper. Postgres is better for concurrent
  multi-writer, larger-scale workloads, but it needs a running server process,
  so it doesn't degrade as gracefully when a node is actually disconnected —
  it's the right choice for a real hospital's central FHIR-adjacent store, not
  for the edge/offline queue itself.
 
  Main tradeoff: SQLite has weaker concurrent-write handling (single-writer
  locking), so if you ever need multiple processes writing to the same queue
  simultaneously, that's where it strains — but for a single-process offline
  queue per node, it's the standard pattern (this is also what SQLite's own
  "Appropriate Uses" docs and most offline-first/edge sync frameworks
  recommend).