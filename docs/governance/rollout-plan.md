# Staged Rollout Plan

Expands section 8 of [production_ready.md](../production_ready.md). PatientChain moves through six stages.
Each stage has entry criteria (must be true to start), exit criteria (must be true to move on), and
rollback triggers (stop and step back).

Hospital A goes first. Hospital B joins as a live site only at Stage 6, though its peer runs on the network
from Stage 2 so that cross-hospital endorsement is exercised throughout. If Hospital B is ready first, swap
the roles.

Moving to the next stage is a decision by the hospital, recorded with date and signatories. Engineering
recommends; it does not decide.

## Overview

| Stage | Data | Users | Where | Typical length |
|---|---|---|---|---|
| 1. Synthetic | Generated HL7 and FHIR test data | Project team | Dev / lab network | 2–4 weeks |
| 2. Hospital UAT | Synthetic + vendor test messages | Hospital IT, a few clinicians | Hospital test/UAT environment | 3–6 weeks |
| 3. One department, test data | Fake or approved test data | One department's staff | Production infrastructure, isolated | 2–4 weeks |
| 4. Limited PHI pilot | Real PHI, limited patients | One department, named staff | Production | 6–12 weeks |
| 5. Production (Hospital A) | Real PHI | All intended departments | Production | Ongoing |
| 6. Second hospital | Real PHI, cross-hospital | Hospital B departments | Production | Repeat stages 2–5 for Hospital B, faster |

## Stage 1 — Synthetic messages

**Entry**
- [ ] Backend, chaincode, and frontend test suites pass
- [ ] Local Fabric network runs (`network/scripts/network-up.sh`, `deployChaincode.sh`)

**Activities**
- Send synthetic ADT (A01, A02, A03, A04, A08) over MLLP, including malformed and duplicate messages.
- Run with `LEDGER_MODE=fabric`. Kill containers mid-flow to test retry, dead-letter, and replay.
- Run backup and restore. Run load tests against the evaluation targets in `docs/evaluation/`.

**Exit**
- [ ] All ADT types processed; duplicates (same MSH-10) ignored; malformed messages NACKed or dead-lettered
- [ ] No message lost across a forced restart
- [ ] Restore from backup verified
- [ ] No PHI-like fields in logs
- [ ] Health, readiness, and metrics endpoints feed a working dashboard and alerts

## Stage 2 — Hospital test / UAT environment

**Entry**
- [ ] Stage 1 exit met
- [ ] Hospital IT has provided a UAT environment and a test interface-engine feed
- [ ] Hospital-specific HL7 field mapping drafted with the hospital's interface analyst
- [ ] OIDC connected to the hospital's test identity provider

**Activities**
- Run the UAT script in [approval-checklist.md](approval-checklist.md) §7.
- Test vendor-specific messages from the hospital's actual EMR/interface engine.
- Run the DR test ([runbook.md](../operations/runbook.md) §6) and an incident tabletop exercise.
- Rehearse a chaincode upgrade and rollback; rehearse revoking a Fabric identity.

**Exit**
- [ ] UAT sign-off form signed by the hospital
- [ ] DR test results within proposed RTO/RPO, or gaps accepted in writing
- [ ] Security testing done; high/critical findings closed
- [ ] Approval-checklist sections 1–6 signed (required before any PHI in Stage 4; Stage 3 may start with
      sections 1 and 7 signed if only fake data is used)

## Stage 3 — One department, fake or approved test data

**Entry**
- [ ] Stage 2 exit met
- [ ] Production infrastructure built per [fabric-production.md](../operations/fabric-production.md)
- [ ] One department chosen (e.g. outpatient clinic) with a named clinical champion
- [ ] Department staff trained ([policies/staff-training.md](policies/staff-training.md))

**Activities**
- Staff use PatientChain alongside normal work with test patients only.
- Collect usability feedback; fix workflow problems.
- Operations team runs the daily/weekly routine from the runbook.

**Exit**
- [ ] Two consecutive weeks without SEV-1/SEV-2 incidents
- [ ] Alerts are actionable (few false alarms); on-call has responded to at least one real alert
- [ ] Staff feedback addressed or accepted
- [ ] Full approval checklist (sections 1–8) signed for live PHI

## Stage 4 — Limited pilot with monitored PHI

**Entry**
- [ ] Stage 3 exit met, go/no-go signed
- [ ] Patient enrolment limit agreed (e.g. up to 100–200 consenting patients)
- [ ] Patient information leaflets and consent process in place
- [ ] Extra monitoring in place: daily review of audit trail and break-glass events

**Activities**
- Enrol consenting patients in the chosen department.
- Real ADT feed for the department.
- Weekly review meeting: metrics, incidents, feedback, privacy review of access patterns.

**Exit**
- [ ] Pilot length met (minimum 6 weeks proposed)
- [ ] Metrics within targets (below) for the last 4 weeks
- [ ] No unresolved privacy incidents; any incidents reviewed and actions closed
- [ ] Clinical lead and DPO agree to expand

## Stage 5 — Production at Hospital A

**Entry**
- [ ] Stage 4 exit met; management sign-off to expand
- [ ] Capacity checked for the expected patient and message volume
- [ ] All target departments' staff trained

**Activities**
- Expand department by department, not all at once. Watch metrics after each.
- Move from weekly to monthly governance review once stable.

**Exit (to start Stage 6)**
- [ ] At least 3 months stable in production
- [ ] At least one routine chaincode or backend upgrade done without incident
- [ ] A DR test passed on production infrastructure (or a production-equivalent)

## Stage 6 — Second hospital (Hospital B)

**Entry**
- [ ] Stage 5 exit met at Hospital A
- [ ] Data-processing agreement between Hospital A and Hospital B signed
- [ ] Hospital B has completed its own approval checklist

**Activities**
- Repeat Stages 2–4 at Hospital B (shorter, since the platform is proven).
- Enable cross-hospital access: a patient seen at both sites grants access across hospitals.
- Test behaviour when either hospital's site is offline.

**Exit**
- [ ] Cross-hospital grants and retrievals work in production with consenting patients
- [ ] Both hospitals' incident contacts have exercised a joint tabletop
- [ ] Joint governance meeting established

## Metrics to watch

| Metric | Source | Proposed target (pilot) |
|---|---|---|
| API availability (`/api/ready` success) | Monitoring | ≥ 99 % in clinic hours |
| HL7 messages processed / received | `/api/metrics` | 100 % (after retries) |
| HL7 dead-letter count | `/api/metrics` | 0 at end of each day |
| HL7 end-to-end latency (receive → stored) | `/api/metrics` | p95 < 30 s |
| Ledger transaction latency | `/api/metrics` | Within evaluation baseline in `docs/evaluation/` |
| Endorsement / commit error rate | `/api/metrics`, peer logs | < 1 % |
| Patient-matching errors (wrong patient, duplicate patient) | Clinical incident reports | 0 |
| Break-glass events | Audit trail | Each one reviewed within 72 h |
| Access denied / auth errors | Logs | No unexplained spikes |
| Backup success and restore test | Backup logs | 100 %, monthly restore passes |
| Staff support requests | Helpdesk | Falling week on week |
| Patient opt-outs / complaints | Records office | Tracked; each reviewed |

## Rollback triggers

Stop the stage and step back (to the previous stage, or to paper/EMR-only workflow) if any of these occur:

- Any confirmed PHI breach (SEV-1), or a SEV-2 not contained within 24 h
- Any wrong-patient match leading to a record shown for the wrong person
- HL7 messages lost (not just delayed) and not recoverable by replay
- Ledger write outage longer than the agreed RTO, or two outages in a week
- Backup or restore failing and not fixed within 48 h
- DPO, clinical lead, or hospital IT withdraws approval
- Staff routinely working around the system in ways that bypass consent or audit

**How to roll back**
1. Incident lead declares rollback; inform both hospitals and pilot staff.
2. Staff revert to the existing downtime / paper / EMR procedure.
3. For PHI stages: stop the HL7 feed (close the MLLP port), set the frontend to read-only or take it
   offline. Do not delete data; ledger entries are permanent and off-chain data falls under the retention
   policy.
4. Run the incident procedure and post-incident review.
5. Re-enter the stage only after the review's actions are closed and the hospital re-approves.
