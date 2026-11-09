# PatientChain Operations Runbook

Covers section 6 of [production_ready.md](../production_ready.md): monitoring, logging, restart/HA,
backup and restore, disaster-recovery (DR) testing, RTO/RPO, and audit-log retention.

Scope: one deployment per hospital (Hospital A, Hospital B). Each deployment has:

| Component | Holds | Where |
|---|---|---|
| Backend API (Node/Express) | Off-chain state, HL7 inbox, provider registrations | Container, SQLite at `backend/data/patientchain.sqlite` (field-encrypted, AES-256-GCM) |
| HL7 MLLP listener | Inbound ADT feed from the hospital interface engine | Part of the backend process |
| FHIR adapter | Clinical records (never on-chain) | Hospital-side; follows the hospital EMR's own backup regime |
| Fabric peer | Ledger copy + world state (LevelDB) | `/var/hyperledger/production` volume |
| Fabric orderer (Raft node) | Ordered block log + Raft WAL/snapshots | `/var/hyperledger/production/orderer` volume |
| MSP / TLS material | Identities and private keys | Per-org CA, HSM or locked-down files |

Related: [fabric-production.md](fabric-production.md), [incident-response.md](incident-response.md).

---

## 1. Monitoring and alerting

### Endpoints

| Endpoint | Use | Probe |
|---|---|---|
| `GET /api/health` | Liveness: process is up | Container/orchestrator liveness check; restart on repeated failure |
| `GET /api/ready` | Readiness: dependencies usable (database, ledger, inbox) | Load balancer and alerting; take node out of rotation when failing |
| `GET /api/metrics` | Prometheus text format | Scrape every 15–30 s |
| Fabric peer/orderer operations endpoint | Fabric's own `/healthz` and Prometheus metrics | Enable `operations` + `metrics.provider: prometheus` in `core.yaml` / `orderer.yaml`, bind to a management network only |

Use whatever the hospital already runs (Prometheus + Alertmanager + Grafana is the default suggestion; Zabbix
or a hosted service is fine). On low-resource sites a single small monitoring VM shared by both components is
enough.

### Alert rules

| Alert | Condition (starting point; tune during pilot) | Severity | First response |
|---|---|---|---|
| Readiness failing | `/api/ready` non-200 for > 2 min | High | Check which dependency the response names; see §3 |
| Liveness failing | `/api/health` fails 3 consecutive probes | High | Confirm auto-restart happened; check logs for crash loop |
| HL7 dead-letter not empty | Dead-letter count > 0 | Medium | Inspect message (by MSH-10), fix mapping/data, replay |
| HL7 inbox backlog | Pending inbox messages > 100, or oldest pending > 15 min | Medium (High if > 1 h) | Check ledger/database reachability; check retry errors |
| No HL7 traffic | Zero ADT messages received for > 1 h during clinic hours | Medium | Confirm interface engine and VPN/firewall are up |
| Ledger endorsement errors | Endorsement failure rate > 5 % over 10 min, or any sustained failure | High | Other hospital's peer down or policy mismatch; see fabric-production.md |
| Ledger commit errors / timeouts | Any MVCC conflict spike, or commit timeouts > 1 % | High | Check orderer cluster health and Raft leader |
| Peer block height lag | Peer height behind other org's peer by > 10 blocks for > 10 min | Medium | Check gossip/network between sites |
| Raft cluster degraded | Fewer than a quorum of consenters reachable, or frequent leader changes | High | Restore failed orderer nodes |
| Certificate expiry | Any TLS, enrollment, or CA cert expires in < 30 days | Medium (< 7 days: High) | Rotate; see fabric-production.md §5 |
| Disk usage | > 80 % on ledger, orderer, database, or backup volumes | Medium (> 90 %: High) | Expand volume; check log rotation and backup pruning |
| Backup failed / stale | Last successful backup older than 2× schedule interval | High | Run `npm run backup` manually; investigate |
| Auth failures spike | 401/403 rate well above baseline | Medium | Possible credential stuffing or misconfigured client; see incident-response.md |
| Break-glass used | Any break-glass access event | Notify (not page) | Route to privacy officer for review |
| Host resources | Memory > 90 % or sustained CPU > 90 % | Medium | Target hardware is small (4 GB RAM); check for leaks |

Each alert must have a named on-call contact per hospital before go-live (see
[approval-checklist.md](../governance/approval-checklist.md)).

## 2. Centralized logging

- The backend writes JSON structured logs to stdout with PHI redaction. Do not add file logging inside the
  app; let the container runtime collect stdout.
- Ship container logs (backend, peer, orderer, CA) to one central store per hospital: e.g. Loki, an ELK/
  OpenSearch stack, or syslog to a SIEM the hospital already has.
- Transport logs over TLS. Restrict log-store access to named operations and security staff.
- Treat logs as potentially sensitive even with redaction. Periodically sample logs and check that no
  names, phone numbers, dates of birth, or HL7 payloads appear. A failed check is a security incident.
- Do not log raw HL7 messages or FHIR resources. Reference them by MSH-10 control ID or record ID.
- Keep host clocks synced (NTP) on every node; log correlation and certificate validation depend on it.
- Set Docker log rotation (`max-size`, `max-file`) on every host so local logs cannot fill the disk.
- Fabric: run at `FABRIC_LOGGING_SPEC=INFO` in production. Use `DEBUG` only temporarily for diagnosis.

## 3. High availability and restart

- All containers run with a restart policy (`unless-stopped` or `always`). Verify after every host reboot.
- The host itself should start Docker on boot (`systemctl enable docker`).
- Plan for power cuts: put each server on a UPS sized for a clean shutdown, and test that the stack comes
  back cleanly after a hard power loss.
- Ledger availability: with the current endorsement policy (both hospitals must endorse), a write fails if
  either hospital's peer is down. Reads from the local peer still work. The backend's offline/inbox path
  queues work until the ledger is back. Running two peers per hospital removes the single-peer failure point.
- Orderer availability: a Raft cluster of 3 or 5 nodes tolerates 1 or 2 failed nodes (see
  fabric-production.md §8). A single orderer, as in the local network, is a single point of failure.
- Backend: SQLite means one active backend instance per hospital. HA is achieved by fast restart plus
  frequent backups, not active-active. If active-active is required later, the store must change.
- HL7: the interface engine should retry on missing ACK. Confirm its retry window is longer than the
  expected backend restart time.

### Readiness failure triage

1. `docker ps` — are all containers running? Check restart counts.
2. Read the `/api/ready` response body to see which check failed.
3. Database: disk full? file permissions? encryption key present in `DATA_ENCRYPTION_KEYS`?
4. Ledger: can the backend reach its peer? Peer logs for TLS or MSP errors? Is the other hospital's peer up?
5. Check recent changes (deploys, cert rotation, firewall changes).

## 4. Backup

### What to back up

| Item | Method | Frequency (proposed) | Retention (proposed) |
|---|---|---|---|
| Off-chain SQLite | `npm run backup` (online backup to `BACKUP_DIR`) | Every 15 min | 15-min copies for 48 h; daily for 90 days; monthly for the retention period in §7 |
| Peer ledger | `peer snapshot submitrequest` (Fabric ledger snapshot), plus volume backup | Daily snapshot; weekly volume backup | Last 7 snapshots |
| Orderer data (Raft WAL, snapshots, block store) | Volume backup with node stopped, one node at a time | Weekly, and before any upgrade | Last 4 |
| MSP / crypto material, CA databases | Encrypted archive | On every change (new identity, rotation) | All versions until expired + 1 year |
| Config (`configtx.yaml`, compose files, `core.yaml`, `.env` without secrets) | Version control | On change | Indefinite |
| Encryption keys (`DATA_ENCRYPTION_KEYS`), CA root keys | Key escrow (below) | On change | Until all data encrypted with them is destroyed |

### Off-chain database

```bash
cd backend
npm run backup          # writes a consistent SQLite copy to BACKUP_DIR
```

- Schedule with cron or a systemd timer. Alert if it fails (see §1).
- The backup file contains field-encrypted data. It is useless without the matching key ring, and anyone
  with both the backup and the keys can read PHI. Store backups and keys in different places.
- Copy backups off the host: at least one copy at a second location (other building, or encrypted cloud
  storage approved by the hospital).

### Fabric ledger

Ledger data is replicated to every peer on the channel, so loss of one hospital's peer is recoverable from
the other hospital. Backups protect against loss of all copies, corruption, and slow rebuilds.

```bash
# Request a snapshot at the next block (run as a peer admin of that org)
peer snapshot submitrequest -c patientchainchannel -b 0 --peerAddress <peer:port> --tlsRootCertFile <ca.crt>
peer snapshot listpending  -c patientchainchannel --peerAddress <peer:port> --tlsRootCertFile <ca.crt>
```

Snapshots are written under the peer's `ledger.snapshots.rootDir` (default inside
`/var/hyperledger/production/snapshots/completed/`). Copy completed snapshots off the host.
A new or rebuilt peer can join the channel from a snapshot (`peer channel joinbysnapshot`) instead of
replaying every block.

### Orderer / Raft

- Do not restore an old Raft data directory onto a running cluster member; it can cause a stale node.
  Prefer replacing a failed node by adding a fresh consenter that catches up from the others.
- Volume backups of orderer data are for full-cluster loss only. Take them with the node stopped.

### MSP, crypto material, and key escrow

- Back up: each org's CA database and CA signing key, admin identities, peer and orderer enrollment
  material, and TLS CA material.
- Escrow: the CA root keys and `DATA_ENCRYPTION_KEYS` must be recoverable if the administrator who holds
  them is unavailable. Use split custody: e.g. an encrypted export sealed in the hospital safe plus a second
  copy held by a named senior officer, or HSM backup tokens. Record who holds what in the key register.
- Never put private keys or the key ring in Git, tickets, chat, or email.
- Losing `DATA_ENCRYPTION_KEYS` means losing the encrypted fields in every backup. Test key recovery as
  part of the DR test.

## 5. Restore

### Off-chain database

1. Stop the backend (`docker compose stop backend` or equivalent) so nothing writes during restore.
2. Pick the backup. Confirm its timestamp and that the current `DATA_ENCRYPTION_KEYS` contains the key IDs
   used when it was written.
3. Verify the backup first with `npm run restore -- <backup-file>` (a dry run: integrity check, and a test
   decryption with the configured `DATA_ENCRYPTION_KEYS`). Then apply it with
   `npm run restore -- <backup-file> --apply`. The current database is kept aside as
   `<db>.before-restore-<timestamp>`. Also copy back the matching `sync-queue-<timestamp>.sqlite`
   to `DATA_DIR/sync-queue.sqlite` if offline actions were pending.
   Backups taken before a key rotation need the old key: keep retired keys in escrow until the
   last backup encrypted with them has expired.
4. Start the backend. Confirm `/api/ready` returns 200.
5. Reconcile with the ledger: grants, revocations, and audit entries made after the backup timestamp are on
   the ledger and are authoritative. Check that the app view matches ledger queries for a sample of patients.
6. Ask the hospital interface engine to resend ADT messages from the backup time onward. Duplicate
   detection on MSH-10 makes the replay safe.
7. Record the restore in the operations log: who, when, which backup, data window lost.

### Peer

1. Provision the host and peer with the org's existing identity (or a newly enrolled one from the org CA).
2. Join the channel from the latest snapshot (`peer channel joinbysnapshot --snapshotpath <dir>`) or from the
   genesis/config block and let it sync from the other peers.
3. Install the same chaincode package and confirm `peer lifecycle chaincode queryinstalled` matches the
   committed definition.
4. Confirm block height matches the other hospital's peer.

### Orderer

- One node lost: remove it from the consenter set, add a replacement (channel config update), join it with
  `osnadmin channel join`. See fabric-production.md §8.
- Quorum lost: restore orderer volumes from backup on all nodes to the same point, restart, and verify
  height. This is the slowest path; practise it in the DR test.

## 6. Disaster-recovery test

Run before production go-live and then every 6 months, and after any major infrastructure change. Use the
UAT environment, never production.

**Checklist**

- [ ] Announce the test window to both hospitals.
- [ ] Record the start time (this is t0 for measuring RTO).
- [ ] Scenario A — lose the backend host: destroy the backend container and volume; restore the database
      from backup; replay HL7. Measure time to `/api/ready` = 200 and data window lost.
- [ ] Scenario B — lose one hospital's peer: delete the peer volume; rebuild from snapshot. Verify block
      height and a sample of chaincode queries.
- [ ] Scenario C — lose one orderer node: stop it permanently; confirm the cluster keeps ordering; add a
      replacement.
- [ ] Scenario D — key recovery: retrieve `DATA_ENCRYPTION_KEYS` and an org admin key from escrow without
      the usual administrator. Decrypt a restored backup.
- [ ] Scenario E — full site power loss: cut power to one hospital's servers; confirm automatic restart and
      that the other hospital continues reads.
- [ ] Verify no PHI appears in logs generated during the test.
- [ ] Compare measured recovery time and data loss against the RTO/RPO table below.
- [ ] Write up results, gaps, and owners for fixes. File with the operations records.

**Record**

| Date | Scenario | Measured RTO | Measured RPO | Pass/Fail | Issues | Owner |
|---|---|---|---|---|---|---|
| | | | | | | |

## 7. RTO / RPO

> **PROPOSED — requires sign-off by Hospital A and Hospital B** (IT lead and clinical governance). These are
> engineering proposals based on the current design, not agreed service levels.

| Component | Proposed RPO (max data loss) | Proposed RTO (max time to restore) | Basis |
|---|---|---|---|
| Off-chain SQLite (registrations, inbox, local state) | 15 min | 4 h | 15-min scheduled backups; HL7 replay from interface engine closes most of the gap |
| HL7 messages in flight | ~0 | 4 h | Interface engine retries until ACK; durable inbox stores messages before ACK (verify in UAT) |
| Fabric ledger (DIDs, grants, audit) | ~0 | 4 h | Every committed block is replicated to both hospitals' peers and all orderers |
| Single peer loss | 0 | 2 h | Rebuild from snapshot / sync from other org |
| Single orderer node loss (3+ node cluster) | 0 | No outage; replace within 24 h | Raft quorum continues |
| MSP / CA material | Last change | 8 h | Restore from escrowed encrypted archive |
| Clinical records (FHIR adapter / EMR) | Per hospital EMR policy | Per hospital EMR policy | Not held by PatientChain |

During an outage, clinical care must continue using the hospital's existing paper/EMR downtime procedure.
PatientChain is a records-access aid, not a system clinical care depends on to function.

## 8. Audit-log retention

- **On-chain audit entries are permanent.** They cannot be edited or deleted; they live as long as the
  channel ledger exists. They contain identifiers and references, not clinical content. This permanence
  must be stated in the DPIA and the patient-facing privacy notice.
- **Application logs** (backend, access logs, HL7 processing logs): proposed retention of **6 years**,
  matching common health-records practice. Keep 90 days in fast searchable storage, the rest in compressed
  archive.
- **Backups** follow the schedule in §4; the longest-retained backups follow the same period as app logs.
- **Infrastructure logs** (Fabric peer/orderer/CA): 1 year proposed, unless a security incident requires a
  hold.
- **Legal hold:** during an incident or dispute, suspend deletion for the affected data.
- **Legal basis to confirm locally:** the Nigeria Data Protection Act 2023 (NDPA) and guidance from the
  Nigeria Data Protection Commission (NDPC), National Health Insurance Authority (NHIA) guidance, the
  National Health Act, and each hospital's own records-management policy. This document does not state the
  legal retention period; the hospital's Data Protection Officer (DPO) and records officer must confirm it
  and record it in [data-retention-policy.md](../governance/policies/data-retention-policy.md).

## 9. Routine tasks

| Frequency | Task |
|---|---|
| Daily | Check dashboard: readiness, dead-letter, backlog, backup age |
| Weekly | Review break-glass events and auth-failure trends; check disk growth |
| Monthly | Test-restore one off-chain backup to a scratch host; review cert expiry list; apply OS/container security patches in UAT then production |
| Quarterly | Access review: remove staff who left; review admin and `system_admin` role holders |
| 6-monthly | Full DR test (§6) |
| Yearly | Review this runbook, RTO/RPO, and retention with both hospitals |
