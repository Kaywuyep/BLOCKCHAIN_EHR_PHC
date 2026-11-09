# Incident and Breach Response Procedure

For security incidents and personal-data breaches affecting PatientChain at Hospital A or Hospital B.
Covers the "incident-response procedures" item in section 6 and "incident and breach procedures" in
section 7 of [production_ready.md](../production_ready.md).

This is an engineering starting point. Each hospital must align it with its own incident policy and have
it approved by its Data Protection Officer (DPO) and management (see
[approval-checklist.md](../governance/approval-checklist.md)).

## 1. What counts as an incident

Any event that does or could compromise the confidentiality, integrity, or availability of PatientChain
data or services. Examples:

- PHI in logs, backups, or files where it should not be
- Lost/stolen device, backup, or key material
- Compromised credential: staff OIDC account, OIDC client secret, Fabric identity, HL7 interface host
- Unexplained access grants, break-glass use without clinical reason, or unusual audit-trail patterns
- Unauthorised connection to the MLLP port or API
- Malware or ransomware on a PatientChain host
- Prolonged outage affecting clinical access to records
- Vulnerability disclosed in a dependency that is exposed in production

**Report anything suspicious.** A false alarm costs little; an unreported breach can cost a great deal.

## 2. Severity levels

| Level | Definition | Examples | Response start | Notify |
|---|---|---|---|---|
| **SEV-1 Critical** | Confirmed or likely PHI exposure, or active attacker, or ledger/identity compromise | Stolen DB backup + keys; compromised org admin key; ransomware | Immediately, 24/7 | Incident lead, DPO, hospital management, other hospital |
| **SEV-2 High** | Possible PHI exposure, or loss of a security control, or full service outage | Compromised staff account; PHI found in logs; one hospital's peer and backend down > RTO | Within 1 h | Incident lead, DPO |
| **SEV-3 Medium** | Security weakness without evidence of exposure, or partial outage | Unpatched critical CVE; dead-letter growing; failed backup for 24 h | Within 1 working day | Operations lead |
| **SEV-4 Low** | Minor policy deviation, no data at risk | Single misrouted alert; shared password found and changed | Within 1 week | Operations lead |

When unsure, pick the higher level. Severity can be lowered after assessment.

## 3. Roles

Fill in names and 24/7 contact numbers per hospital before go-live.

| Role | Responsibility | Hospital A | Hospital B |
|---|---|---|---|
| Incident lead | Owns the incident, decisions, timeline | | |
| Technical lead | Containment and recovery actions on systems | | |
| Data Protection Officer (DPO) | Assesses breach, decides and makes regulator and patient notifications | | |
| Clinical lead | Assesses patient-safety impact, downtime procedures | | |
| Communications | Staff, patient, and public messages (approved by DPO/management) | | |
| Fabric admin (key holder) | Revocation and channel config updates | | |
| Scribe | Keeps the incident log | | |

Because the network is shared, a SEV-1 or SEV-2 at one hospital must be reported to the other hospital's
incident lead, even if the other hospital seems unaffected.

## 4. Procedure

Keep a timestamped incident log from the first report: who did what, when, and why. Preserve evidence
before changing systems wherever this does not delay containment.

### 4.1 Detect and report

- [ ] Record the time of discovery (the 72-hour clock for regulator notification can start here; see §5).
- [ ] Record source: alert, staff report, patient complaint, third party.
- [ ] Assign incident lead and severity.
- [ ] Open the incident log.

### 4.2 Assess

- [ ] What data, systems, and patients are affected? Off-chain (SQLite, logs, backups, FHIR adapter) vs.
      on-chain (DIDs, references, grants, audit entries — no clinical content).
- [ ] Is it ongoing?
- [ ] Use the on-chain audit trail and app logs to establish who accessed which records and when.
- [ ] Inform the DPO now if personal data may be involved.

### 4.3 Contain

Pick the actions that fit. Record each one.

| Threat | Containment action |
|---|---|
| Compromised staff/patient account | Disable the user in the hospital identity provider; revoke sessions/tokens; remove PatientChain roles |
| Compromised OIDC client or secret | Disable the OIDC client in the identity provider; issue a new client secret; redeploy backend with it |
| Compromised Fabric identity (backend client, peer, admin) | `fabric-ca-client revoke -e <id>` → `fabric-ca-client gencrl` → channel config update adding the CRL to the org MSP (needs admin signatures, see [fabric-production.md](fabric-production.md) §6) → enroll a replacement identity |
| Compromised data encryption key | Add a new key to `DATA_ENCRYPTION_KEYS` as the active key, re-encrypt data, then remove the old key; treat any backup encrypted with the old key as exposed if it may have been taken |
| Suspicious HL7 traffic / unknown sender | Firewall the MLLP port to block all but known interface-engine IPs, or close it entirely; the interface engine queues messages until it reopens |
| Compromised host (malware, ransomware) | Isolate it from the network (do not power off if forensic memory capture is needed); fail over or keep the service down |
| Malicious or erroneous access grants | Revoke via the application; the revocation is recorded on-chain |
| PHI in logs | Stop the leaking component or fix redaction; restrict access to the log store; identify all copies |

Notes:
- On-chain entries cannot be deleted. If an on-chain entry is wrong, record a correcting entry and document
  it. This is why no clinical content goes on-chain.
- Revoking a Fabric identity takes effect only after the CRL config update is committed. Until then, also
  block the identity's host at the firewall.

### 4.4 Eradicate

- [ ] Find and fix the root cause (vulnerability, misconfiguration, weak credential, process gap).
- [ ] Patch, rebuild compromised hosts from clean images, rotate all credentials that host could reach.
- [ ] Confirm no persistence remains (new accounts, keys, cron jobs, unexpected containers).

### 4.5 Recover

- [ ] Restore from known-good backups if needed ([runbook.md](runbook.md) §5).
- [ ] Reopen the MLLP port and request HL7 replay from the interface engine for the outage window.
- [ ] Confirm `/api/ready`, ledger health, and that both hospitals' peers agree on block height.
- [ ] Watch closely (extra alerting) for at least 7 days.
- [ ] Clinical lead confirms normal service can resume.

### 4.6 Notify

Decisions on notification are made by the DPO with hospital management, not by engineering.

- [ ] **Regulator:** see §5.
- [ ] **Patients:** see §6.
- [ ] **Other hospital:** always for SEV-1/2.
- [ ] **Data-processing partners/vendors:** per data-processing agreements.
- [ ] **Law enforcement:** where criminal activity is suspected, per hospital policy.

## 5. Regulator notification (NDPA 2023)

- The Nigeria Data Protection Act 2023 (NDPA) requires notification of a personal-data breach to the
  Nigeria Data Protection Commission (NDPC) **within 72 hours** of becoming aware of it, where the breach is
  likely to result in a risk to individuals' rights and freedoms. **Confirm the exact obligations,
  threshold, and form with the hospital's DPO.**
- If full facts are not known within 72 hours, notify with what is known and send updates.
- Typical content (confirm against current NDPC requirements):
  - Nature of the breach; categories and approximate number of data subjects and records
  - DPO contact details
  - Likely consequences
  - Measures taken or proposed to address it and mitigate harm
- Health data is sensitive personal data; assume a breach of it is likely to be high-risk unless the DPO
  determines otherwise.
- Record the decision and reasoning even when the DPO decides notification is not required.

## 6. Patient notification

- The NDPA also provides for informing affected individuals where a breach is likely to result in high
  risk to them. The DPO confirms whether and when this applies; plan to notify without undue delay.
- Use plain language, in the languages patients use. Include: what happened, what data, what the hospital
  is doing, what the patient can do, and who to contact.
- Use contact routes that do not themselves leak information (e.g. do not name the condition in an SMS).
- Patients can view their own access history in the Patient App; point them to it where useful.
- Prepare staff (front desk, records office) with a short script before notifications go out.

## 7. Post-incident review

Hold within 2 weeks of closing any SEV-1 or SEV-2 incident (optional for SEV-3). Blameless: focus on
systems and processes, not individuals.

### Template

```
Incident ID:
Severity (initial / final):
Hospitals affected:            [ ] Hospital A   [ ] Hospital B
Date/time detected:            Date/time contained:          Date/time resolved:
Incident lead:                 DPO:
Review date / attendees:

1. Summary (2–3 sentences)

2. Timeline (timestamped, from first sign to resolution)

3. Impact
   - Patients/records affected:
   - Data categories:
   - Service downtime:
   - Clinical impact:

4. Root cause (and contributing factors)

5. Detection: how was it found? How could it have been found sooner?

6. Response: what worked, what did not?

7. Notifications made
   | To | Date/time | By | Reference |
   - NDPC:
   - Patients:
   - Other hospital:
   - Others:

8. Actions
   | # | Action | Owner | Due | Status |

9. Changes needed to this procedure, the runbook, or policies
```

File the completed review with the hospital's incident register. Track actions to completion.

## 8. Readiness checklist

- [ ] Roles and 24/7 contacts filled in (§3) for both hospitals
- [ ] DPO has reviewed and approved this procedure
- [ ] Contact details for NDPC breach reporting confirmed by DPO and recorded here: ____________
- [ ] Revocation (CRL), OIDC client disable, key rotation, and MLLP firewall steps rehearsed in UAT
- [ ] Tabletop exercise held with both hospitals before PHI pilot, then yearly
- [ ] Patient notification template drafted and approved
