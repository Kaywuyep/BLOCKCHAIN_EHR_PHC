# PatientChain

A blockchain-based patient-controlled access and reference system for cross-hospital health record
interoperability in resource-constrained environments — the implementation of the architecture proposed in
*"Development of a Blockchain-Based Patient-Controlled Access and Reference System with Smart Contract
Transaction Optimisation for Cross-Hospital Health Record Interoperability in Resource-Constrained Hospital
Environments."*

## What's in this repo

```
patientchain/
├── chaincode/       Go smart contracts (PatientRegistry, AccessControl, AuditLog, CostMetrics)
├── network/         Hyperledger Fabric network config (2 hospital orgs + orderer, Raft, LevelDB)
├── backend/         Node.js/Express API — Fabric Gateway client + in-memory simulator + offline sync
├── frontend/        React demo app — Patient App, Clinician Portal, Admin Dashboard
└── docs/            Additional notes
```

Every module is traceable back to a section of the paper — see the comments at the top of each source file.

## Two ways to run this

### 1. Demo mode (no Docker needed) — for day-to-day development and rehearsing the defense

The backend ships with `LEDGER_MODE=simulated`: an in-memory service that implements the *exact same*
operations as the chaincode (same function names, same state machine, same cost counters), so the whole app
runs with just Node.

```bash
cd backend
npm install
cp .env.example .env      # LEDGER_MODE=simulated by default
npm start                 # http://localhost:4000

cd ../frontend
npm install
npm run dev                # http://localhost:5173
```

Open the app, register the demo patient, request/grant/revoke access, toggle "hospital offline" in the Admin
tab, and watch the cost-model charts update live.

### 2. Real network mode — for the defense itself

This spins up an actual 2-hospital Hyperledger Fabric network, deploys the chaincode, and points the backend
at it.

**Prerequisites** (install these on your own machine — they can't be installed in a sandboxed dev
environment):
- Docker + Docker Compose
- Fabric binaries: `curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/bootstrap.sh | bash -s -- 2.5.16 1.5.17`
  (adds `cryptogen`, `configtxgen`, `peer` to `./bin`, add that to your `PATH`)
- Go 1.21+ (for `go mod vendor` during chaincode packaging)

```bash
cd network
cd /home/katie/Desktop/BLOCKCHAIN_EHR_PHC/network

curl -sSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/bootstrap.sh \
  | bash -s -- 2.5.4 1.5.7

export PATH="$PWD/bin:$PATH"

./scripts/network-up.sh

# Verify before rerunning:


command -v cryptogen
command -v configtxgen
command -v peer


# To make the PATH permanent:


echo 'export PATH="/home/katie/Desktop/BLOCKCHAIN_EHR_PHC/network/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

./scripts/network-up.sh        # generates crypto material, starts orderer + 2 peers, creates the channel
./scripts/deployChaincode.sh   # packages, installs, approves, commits the chaincode

cd ../backend
# edit .env: set LEDGER_MODE=fabric (see .env.example for the rest of the fields)
npm start

cd ../frontend
npm run dev
npm run dev -- --host 0.0.0.0
```

add hospitals in the config file the check the are listening on assigned port and verify by sending an adt message to each port
```bash
ss -ltnp | grep -E ':(5001|5002)\b'

### Hospital Langtang — port 5001


printf '\x0bMSH|^~\\&|ADTAPP|LANGTANG|PATIENTCHAIN|PCH|20261009080000||ADT^A01|LANGTANG-001|P|2.5\rPID|1||LANGTANG-TEST-001||OKAFOR^ADA||19900412|F\rPV1|1|I|WARD^101^A\r\x1c\r' \
| nc -q 1 127.0.0.1 5001 | tr '\r' '\n'


### Hospital Wase — port 5002


printf '\x0bMSH|^~\\&|ADTAPP|WASE|PATIENTCHAIN|PCH|20261009080500||ADT^A01|WASE-001|P|2.5\rPID|1||WASE-TEST-001||BELLO^CHIDI||19851103|M\rPV1|1|O|CLINIC^202^B\r\x1c\r' \
| nc -q 1 127.0.0.1 5002 | tr '\r' '\n'

```

Then verify the records arrived under the correct hospital:

``` bash
curl http://localhost:6000/api/patients/local-records/general-hospital-langtang
curl http://localhost:6000/api/patients/local-records/general-hospital-wase
```

The frontend and every route are identical in both modes — only the ledger underneath changes. The header
badge in the app shows which mode is active (`ledger: simulated` / `ledger: fabric`).

## Security and production deployment

Both modes above run with `AUTH_MODE=off` by default: no login, every request acts as a superuser, so the
demo and the Chapter 5 evaluation script work unchanged. To try sign-in and role-based access locally, set
`AUTH_MODE=local` and `AUTH_JWT_SECRET` (32+ characters) in `backend/.env`. The app then shows a
development sign-in form (patient / clinician / hospital admin / system admin).

With `NODE_ENV=production` the backend refuses to start until it has a safe configuration: Fabric ledger,
OIDC login, encryption keys, a CORS allowlist, HTTPS, and TLS or a VPN for HL7. See
`backend/.env.production.example`, `deploy/docker-compose.prod.yml`, and the checklist in
`docs/production_ready.md`. Operations and governance runbooks are in `docs/operations/` and
`docs/governance/`.

The frontend covers itself with white noise when a screen capture is likely: when the window loses focus,
on screenshot shortcuts, and when printing. Set `VITE_SCREEN_SHIELD=off` to take documentation screenshots.

## Mapping to the paper

| Paper section | Where it lives |
|---|---|
| 3.4 System Architecture (5 layers) | `frontend` (presentation) → `backend/src/routes` (API/app layer) → `chaincode` (blockchain) → `backend/src/services/fhirAdapter.js` (hospital DB, simulated) |
| 3.5 Smart Contract Design | `chaincode/patientregistry.go`, `accesscontrol.go`, `auditlog.go` |
| 3.5.1 Record Resolution / local DID→MRN mapping | `backend/src/services/fhirAdapter.js`, `backend/src/routes/records.js` |
| 3.5.2 Cost Model | `backend/src/services/costModel.js`, visualised in `frontend/src/pages/AdminDashboard.jsx` |
| 3.6 Offline-First Sync | `backend/src/sync/offlineQueue.js` (SQLite-backed queue + reconciliation) |
| 3.7 On-chain reference vs hospital-custodied data | Enforced structurally: `chaincode` never accepts a clinical payload; `fhirAdapter.js` never writes to the ledger |
| 3.9 Technology stack | Hyperledger Fabric + Go chaincode + LevelDB (no CouchDB) + React Native/PWA pattern reflected in the web frontend |

## Honest limitations of this implementation

- The frontend is a **web app**, not the React Native + PWA mobile app described in Section 3.4 — same
  component logic, different shell. Porting `frontend/src` into a React Native project is straightforward
  since the API layer (`api.js`) is framework-agnostic.
- The FHIR Adapter (`fhirAdapter.js`) keeps each hospital's data in an encrypted local SQLite store rather
  than integrating a real FHIR R4 server — this is the seam you'd replace with an actual HL7 FHIR API client
  per Section 3.9.
- `getRecentEvents()` in `fabricLedgerService.js` is a no-op; a production build should subscribe to Fabric's
  chaincode event stream (`network.getChaincodeEvents`) rather than relying on the simulator's in-memory log.
- The cost-model parameters (`Ce`, `Co`, `Cv` in `costModel.js`) are illustrative defaults, exactly as Section
  3.5.2 specifies they should be until Hyperledger Caliper benchmarking is run against the real network
  (Section 3.12) — replace them once you have real numbers.
