# Production readiness

This was a gap list. It is now a status checklist. Every engineering item is either **done** (in code, with
tests) or marked **open**, with the reason. Sections 7 and 8 need people from the hospitals to sign off.
Engineering can prepare them but cannot complete them.

Legend: ✅ done · 🟡 done in code, needs deployment work by the hospital · ⛔ open

Verified on 2026-11-09: 164 backend tests, 13 Playwright e2e tests, an authenticated golden path against
the local 2-hospital Fabric network, and the Chapter 5 `evaluate.js` run.

---

### 1. Replace demo storage

| Item | Status | Where |
|---|---|---|
| Persistent storage for hospital rosters, DID links, clinical bundles, providers | ✅ | `backend/src/db/database.js` (SQLite, WAL, `synchronous=FULL`, append-only migrations) |
| Encryption at rest | ✅ | `backend/src/db/fieldCipher.js`: AES-256-GCM per value, key ring with key IDs (`DATA_ENCRYPTION_KEYS`), `npm run rotate-keys` |
| Backups | ✅ | `npm run backup` (online, verified with integrity check + row counts, `--keep N`); `npm run restore` (dry run, then `--apply`) |
| Durable message queue | ✅ | `backend/src/services/hl7Inbox.js`: messages are stored before processing, then retried, dead-lettered and replayed |
| Hospital connection status survives restart | ✅ by design | Listener status is rebuilt from live state on startup; message history lives in the inbox |
| Real hospital FHIR/EMR adapter | 🟡 | The adapter contract is unchanged. Connecting a specific EMR is per-hospital work: `docs/fhir-adapter-live-emr-guide.md` |
| Multi-replica database | ⛔ open | SQLite suits one backend per hospital. Several replicas would need PostgreSQL behind the same store classes |

### 2. Use production Fabric

| Item | Status | Where |
|---|---|---|
| `LEDGER_MODE=fabric` enforced | ✅ | `NODE_ENV=production` refuses to start otherwise (`backend/src/config.js`) |
| Private keys in an HSM | ✅ | PKCS#11 signer: `FABRIC_HSM_LIBRARY/LABEL/PIN/KEY_ID`; or `FABRIC_KEY_PATH` (refused unless mode 0400/0600) |
| TLS certificate rotation | ✅ | Replace the files, then `kill -HUP`: the backend reconnects with the new credentials (keeps the old connection if the reload fails) |
| Production peers/orderers, separate MSPs/CAs, endorsement policy, channel governance, Fabric backups, chaincode upgrade | 🟡 | Procedures in `docs/operations/fabric-production.md`. The infrastructure itself must be provisioned per hospital |
| Chaincode dependency vulnerabilities (grpc v1.59, x/net v0.17) | ⛔ open | The Fabric 2.5.4 chaincode builder ships Go 1.20, which can't build the fixed versions. Upgrade Fabric first, then bump them. CI reports this without failing the build |

### 3. Authentication and authorization

| Item | Status | Where |
|---|---|---|
| Login through the hospital's identity provider (OIDC) | ✅ | `backend/src/auth/auth.js` (JWKS discovery, issuer and audience checks, configurable claim names); frontend authorization code + PKCE (`frontend/src/auth.js`) |
| Every API route authenticated | ✅ | Only `/health`, `/ready`, `/metrics` (token) and `/auth/config` are public |
| Provider-level RBAC | ✅ | Roles `patient`, `clinician`, `hospital_admin`, `system_admin`, `hl7_interface` (`backend/src/auth/policy.js`) |
| Hospital-level authorization | ✅ | Staff act only for the hospital in their token |
| Patients act only on their own DID and grants | ✅ | The account is bound to the DID at registration. Offline-queued actions are re-checked on replay |
| Records resolve only for the clinician named on the grant | ✅ | Previously, anyone with a grant ID could read records |
| Restricted admin actions | ✅ | Connectivity toggle needs `system_admin`. Cost, audit stream, roster and HL7 inbox need admins |
| Break-glass controls | ✅ | The clinician must be themselves. Review is by the same hospital's admin and never self-review. The reviewer is taken from the token |
| mTLS for HL7 interface engines | ✅ | `HL7_TLS_CLIENT_CA_PATH`; tested with real certificates |
| Development modes | ✅ | `AUTH_MODE=off/local` exist for the demo and tests, and are refused in production |

### 4. Harden HL7 integration

| Item | Status | Where |
|---|---|---|
| TLS-protected MLLP or VPN | ✅ | `HL7_TLS_CERT_PATH/KEY_PATH`, or an explicit `HL7_PRIVATE_NETWORK=true`. Production refuses neither |
| Firewall allowlist by interface-engine IP | ✅ | Per hospital `allowedIps` and `bindAddress` in `config/hospitalIngestion.json`. Also restrict it at the network firewall |
| Hospital-specific field mapping | ✅ | Per-hospital `fieldMap`, validated at startup |
| ACK/NACK | ✅ | AA on success or durable acceptance, AR for unusable content, AE when the store is down so the sender keeps the message |
| Retry and dead-letter queue | ✅ | Exponential backoff, `HL7_MAX_ATTEMPTS`, then DEAD. Alerted via metrics; `POST /api/hl7/messages/:id/replay` |
| Message persistence | ✅ | Raw message encrypted at rest. The admin API returns metadata only |
| Duplicate detection on MSH-10 | ✅ | Unique per hospital. A resend is acknowledged, not reapplied |
| Replay and recovery after downtime | ✅ | Messages left `RECEIVED` by a crash are processed on startup |
| A01, A02, A03, A04, A08 tested | ✅ | `hl7Inbox.test.js` |
| Vendor-specific messages | 🟡 | Needs each hospital's real feed samples in UAT |
| Labs, medications, notes | ⛔ open | ADT carries no clinical content. This needs FHIR/EMR integration per hospital |

### 5. Secure the web/API layer

| Item | Status | Where |
|---|---|---|
| HTTPS | ✅ | Node TLS (`TLS_CERT_PATH`) or a TLS proxy with `TRUST_PROXY`. Plain HTTP is refused in production; HSTS is set |
| Restricted CORS | ✅ | `CORS_ORIGINS` allowlist. A wildcard is refused in production. The nginx image serves the API on the same origin |
| Rate limiting | ✅ | Global per-IP limit plus a stricter login limit. Link-facility lookups also have their own per-patient limit |
| Request size limits and validation | ✅ | 100 kb JSON (configurable), 413/400 for oversized or malformed bodies, input checks on login, durations and cost parameters, request timeouts |
| Security headers | ✅ | helmet on the API. CSP, HSTS, `Permissions-Policy` and no-store caching in nginx (`frontend/security-headers.inc`) |
| Secret management | 🟡 | All secrets come from the environment or mounted files; `.env.production.example`. Choosing a secret manager is up to the hospital |
| PHI-redacted logs | ✅ | `backend/src/logger.js`: JSON lines; names, DOB, MRNs, notes and HL7 segments are redacted and DIDs masked; tested |
| Encryption in transit and at rest | ✅ | See sections 1, 2 and 4 |
| Network segmentation | 🟡 | The compose file binds MLLP and web to chosen interfaces on an internal network; `/api/metrics` is not exposed through nginx |
| Vulnerability and dependency scanning | ✅ | `.github/workflows/ci.yml`: npm audit (backend and frontend currently at 0), govulncheck, gitleaks, weekly schedule |
| Screen-capture deterrent | ✅ | `frontend/src/components/ScreenShield.jsx`: white noise on focus loss, screenshot shortcuts and print. This is a deterrent only: a web page cannot block OS screenshots or cameras |

### 6. Production operations

| Item | Status | Where |
|---|---|---|
| Health and readiness checks | ✅ | `/api/health` (liveness), `/api/ready` (ledger and database, 503 when not ready) |
| Monitoring and alerting | ✅ | `/api/metrics` (Prometheus: requests, latency, HL7 inbox by status, oldest pending, offline queue). Alert rules in `docs/operations/runbook.md` |
| Centralized logs | 🟡 | Structured JSON on stdout with request IDs. Shipping them to the hospital's log platform is a deployment step |
| Automatic restart, graceful shutdown | ✅ | Docker `restart: unless-stopped`, health checks, SIGTERM drains HTTP and MLLP and closes the stores |
| Hardened containers | ✅ | Non-root, read-only root filesystem, dropped capabilities (`backend/Dockerfile`, `frontend/Dockerfile`, `deploy/docker-compose.prod.yml`) |
| Backup and restore procedures | ✅ | Scheduled 15-minute verified backups in the compose file. Runbook procedure; tested end to end, including key rotation |
| Disaster-recovery testing, RTO/RPO | 🟡 | Procedure and proposed RTO/RPO in the runbook. The drill and sign-off must be done in each hospital's environment |
| Audit-log retention | 🟡 | The on-chain audit log is permanent. App-log retention is a policy template for the DPO to set |
| Incident response | 🟡 | `docs/operations/incident-response.md`. Roles and contacts must be filled in per hospital |
| High availability | ⛔ open | One backend per hospital with automatic restart. Active-active needs the PostgreSQL move (section 1) |

### 7. Hospital and privacy approval ⛔ needs people, not code

Prepared: `docs/governance/approval-checklist.md` (IT security, DPIA, data-processing agreements, access and
retention policies, training, incident procedures, UAT sign-off form) and policy templates in
`docs/governance/policies/`. Each item needs a named signatory at Hospital A and Hospital B.

### 8. Roll out gradually ⛔ needs people, not code

Prepared: `docs/governance/rollout-plan.md`, with six stages, entry and exit criteria, metrics and rollback
triggers. The system can now enter stage 1 (synthetic messages) and stage 2 (hospital UAT).

---

**Current verdict:** the engineering gaps for a single-backend-per-hospital deployment are closed. The system
is ready for hospital UAT (rollout stage 2). It is **not yet approved for live PHI**: that needs section 7
signed, production Fabric infrastructure provisioned (section 2), and the open items above accepted or
resolved.
