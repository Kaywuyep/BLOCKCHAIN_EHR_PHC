# TEMPLATE — PatientChain Data Retention Policy

> **TEMPLATE. Not an approved policy.** Retention periods below are **placeholders**, not legal advice.
> [Hospital A / Hospital B] must confirm every period with its Data Protection Officer (DPO) and records
> officer against the Nigeria Data Protection Act 2023 (NDPA), Nigeria Data Protection Commission (NDPC)
> guidance, National Health Insurance Authority (NHIA) guidance, the National Health Act, and the hospital's
> own records-management policy. Replace every `[bracketed]` item.

| Field | Value |
|---|---|
| Hospital | [Hospital name] |
| Policy owner | [Name, role — usually DPO or Head of Records] |
| Approved by | [Name, role] |
| Version / effective date | [x.y] / [date] |
| Next review | [date] |

## 1. Purpose

Sets how long each kind of PatientChain data is kept, where, and how it is disposed of.

## 2. Retention schedule

| Data | Location | Contains PHI? | Retention (placeholder — confirm) | Disposal |
|---|---|---|---|---|
| Clinical records | Hospital EMR / FHIR adapter | Yes | [Per hospital health-records policy] | Per hospital policy (not PatientChain) |
| On-chain entries: patient DIDs, record references, access grants/revocations, audit entries | Fabric ledger on every peer | Identifiers and references only; no clinical content | **Permanent** — cannot be deleted while the ledger exists | Only by decommissioning the whole channel by agreement of all hospitals |
| Off-chain database (registrations, mappings, inbox state) | `patientchain.sqlite`, field-encrypted | Yes (encrypted) | [Duration of patient relationship + N years] | Secure deletion; destroy keys for retired data |
| HL7 messages in the inbox / dead-letter | Off-chain database | Yes | [N days after successful processing] | Automatic purge |
| Application logs (PHI-redacted) | Central log store | Should not; treat as sensitive | [Proposed 6 years] | Automatic expiry |
| Infrastructure logs (Fabric, OS) | Central log store | No | [1 year] | Automatic expiry |
| Database backups | Backup storage | Yes (encrypted) | Per [runbook.md](../../operations/runbook.md) §4 schedule; longest copies [same as app logs] | Automatic expiry; verify deletion |
| Encryption keys (`DATA_ENCRYPTION_KEYS`) | Secret store + escrow | Protects PHI | Until every backup encrypted with the key has expired | Secure destruction, recorded |
| Incident records and post-incident reviews | [Incident register] | May | [N years] | Per hospital policy |
| Approval and sign-off records | [Governance file] | No | [Life of system + N years] | Per hospital policy |

## 3. On-chain data and the right to erasure

- Ledger entries are permanent by design. This is why PatientChain stores **no clinical content** on-chain.
- When a patient asks for erasure or withdraws from PatientChain: revoke all active grants, deactivate the
  DID, and delete or anonymise off-chain data as the law allows. The on-chain record that access existed
  remains, but it no longer resolves to records.
- The DPO must confirm this approach meets NDPA obligations and explain it in the patient privacy notice
  and DPIA.

## 4. Legal hold

When there is an incident, complaint, investigation, or legal claim, [DPO] may suspend deletion for the
affected data. Holds are recorded and lifted in writing.

## 5. Disposal

- Use automatic expiry where possible; check it works at least [yearly].
- Media and disks are wiped or destroyed per [hospital IT disposal procedure] before reuse or disposal.
- Record disposal of backups and keys: what, when, by whom.

## 6. Review

[Owner] reviews this schedule [yearly] and whenever the law, the system, or hospital policy changes.

## 7. Approval

| Role | Name | Signature | Date |
|---|---|---|---|
| Data Protection Officer | | | |
| Head of Records | | | |
| Head of IT | | | |
