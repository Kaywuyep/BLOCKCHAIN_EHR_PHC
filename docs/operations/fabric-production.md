# Fabric Production Deployment

How to move PatientChain's Hyperledger Fabric network from the local single-host Docker setup to a
production deployment across Hospital A and Hospital B. Covers section 2 of
[production_ready.md](../production_ready.md).

## 1. Current local network vs. production target

| Aspect | Local network (`network/`) | Production target |
|---|---|---|
| Hosts | Everything on one machine, one Docker network | Each hospital runs its own peer(s) on its own hosts |
| Identities | `cryptogen` from `crypto-config.yaml` | Fabric CA per organisation (plus a separate TLS CA) |
| Orderer | 1 Raft node, `OrdererMSP` | 3–5 Raft nodes, spread across hospitals/sites |
| Peers | `peer0` per hospital | At least 1 per hospital; 2 for availability |
| Private keys | Files in `crypto-config/`, mounted into containers | HSM via PKCS#11, or at minimum `0400` files owned by the service user |
| TLS | Enabled, self-generated certs | Enabled everywhere, including operations endpoints and CA; rotation procedure |
| Chaincode deploy | `deployChaincode.sh` approves for both orgs from one machine | Each hospital's admin approves from its own site with its own admin key |
| Channel | `patientchainchannel`, created by `createChannel.sh` | Same name; created once by agreed process, with admin signatures recorded |
| Docker socket | Mounted into peers for chaincode builds | Avoid; use chaincode-as-a-service or external builders |

Production should keep the same channel name (`patientchainchannel`) and chaincode name (`patientchain`) so
backend configuration stays the same.

## 2. Topology

```
 Hospital A site                           Hospital B site
 ┌─────────────────────────────┐           ┌─────────────────────────────┐
 │ Fabric CA (HospitalAMSP)     │           │ Fabric CA (HospitalBMSP)     │
 │ TLS CA                       │           │ TLS CA                       │
 │ peer0.hospitala  (+peer1)    │◄─gossip──►│ peer0.hospitalb  (+peer1)    │
 │ orderer1, orderer2           │◄──Raft───►│ orderer3 (, orderer4)        │
 │ backend + HL7 + FHIR adapter │           │ backend + HL7 + FHIR adapter │
 └─────────────────────────────┘           └─────────────────────────────┘
          site-to-site VPN or private link; firewall allowlist by IP and port
```

- Inter-site traffic (gossip, Raft, endorsement) runs over a VPN or private link, never the open internet.
- Allow only the required ports between known IPs: peer (e.g. 7051), orderer cluster and client
  (e.g. 7050), orderer admin (e.g. 7053, management network only), CA (7054, management network only),
  operations/metrics (management network only).
- Use DNS names that will not change (e.g. `peer0.hospitala.<real-domain>`). Certificates include these
  names; changing them later requires reissuing certificates and a channel config update.
- Orderer ownership: the local network has a separate `OrdererMSP`. In production, either each hospital runs
  orderer nodes under its own MSP (recommended: no single party controls ordering), or a neutral third party
  operates them. Decide this in the consortium agreement.

## 3. Identities: Fabric CA instead of cryptogen

`cryptogen` is for testing only: it creates all keys in one place and cannot revoke or renew.

Per organisation:

1. Deploy two CAs: an **enrollment CA** (identities) and a **TLS CA**. Ideally use an offline root CA and an
   online intermediate CA.
2. Enable NodeOUs (as in `crypto-config.yaml`) so roles `admin`, `peer`, `client`, `orderer` are encoded in
   certificates. The channel policies in `configtx.yaml` depend on these roles.
3. Register and enroll: one admin per hospital (named person, not shared), each peer, each orderer node,
   and the backend's client identity.
4. Build the org MSP folder (`cacerts`, `intermediatecerts`, `tlscacerts`, `config.yaml` with NodeOUs) and
   share only the **public** MSP with the other hospital for the channel config.
5. Keep CA databases and signing keys backed up and escrowed (see [runbook.md](runbook.md) §4).

Revocation: `fabric-ca-client revoke` then `fabric-ca-client gencrl`; add the CRL to the org's MSP in the
channel config (channel config update) so all nodes reject the revoked identity. See
[incident-response.md](incident-response.md).

## 4. Private keys

- **Preferred:** HSM via PKCS#11 for peer, orderer, CA, and admin signing keys. Configure the `BCCSP`
  section of `core.yaml` / `orderer.yaml` / CA config with `Default: PKCS11`, library path, label, and PIN
  (PIN from a secret store, not a file in Git). Test with SoftHSM in UAT first.
- **Minimum (no HSM available):**
  - Key files `chmod 0400`, owned by the user the container runs as; directory `0700`.
  - Full-disk encryption on hosts.
  - Admin keys are not stored on peer or orderer hosts; they live on an admin workstation or offline media
    and are brought in only for admin operations.
  - Do not mount the whole `crypto-config/` tree into any container (the local `cli` container does this).
- Record every key, its location, holder, and expiry in a key register.

## 5. TLS and certificate rotation

TLS is required on every Fabric endpoint: peer, orderer (client and cluster), orderer admin, CA, and
operations endpoints. Use mutual TLS where Fabric supports it (`CORE_PEER_TLS_CLIENTAUTHREQUIRED=true`,
`ORDERER_GENERAL_TLS_CLIENTAUTHREQUIRED=true`) once all clients present certificates.

Alert at < 30 days to expiry (see runbook §1). Suggested lifetimes: TLS and enrollment certs 1 year;
intermediate CA 3–5 years; root CA 10+ years, kept offline.

### Rotating a peer's TLS or enrollment certificate

1. Re-enroll with the org CA (`fabric-ca-client reenroll`; same key or new key per policy).
2. Place the new cert (and key, if new) in the peer's TLS or MSP folder.
3. Restart the peer. Confirm it rejoins gossip and serves endorsements.
4. Check backend connectivity: the backend trusts the TLS CA, not the leaf cert, so no backend change is
   needed unless the TLS CA itself changed.

### Rotating an orderer's TLS certificate

The orderer's TLS certificate is listed in the channel config consenter set (`ClientTLSCert`,
`ServerTLSCert` in `configtx.yaml`). Rotate **one node at a time**:

1. Issue the new TLS cert for the node.
2. Channel config update replacing that consenter's certs (requires orderer admin signatures per policy).
3. Swap the cert on the node and restart it.
4. Confirm the node rejoins the Raft cluster before rotating the next one.

Never let a quorum of orderer certs expire at once: the cluster cannot then sign the update needed to fix
it.

### Rotating a CA certificate

Add the new CA cert to the org MSP (`cacerts` / `intermediatecerts` / `tlscacerts`) through a channel config
update **before** issuing certs from it; keep the old CA cert until every cert it issued is replaced; then
remove it in a second config update.

## 6. Endorsement policy and channel governance

### Current configuration

From `network/configtx.yaml`:

| Policy | Rule | Effect with 2 hospitals |
|---|---|---|
| `Application/Endorsement` | `MAJORITY Endorsement` | Both Hospital A and Hospital B peers must endorse every transaction |
| `Application/LifecycleEndorsement` | `MAJORITY Endorsement` | Both must approve a chaincode definition before commit |
| `Application/Admins`, `Channel/Admins`, `Orderer/Admins` | `MAJORITY Admins` | Both hospitals' admins must sign config changes |
| `Readers` / `Writers` | `ANY` | Any member org can read / submit |
| Per org `Endorsement` | `OR('<Org>.peer')` | Any peer of that org can endorse for it |

`deployChaincode.sh` does not pass `--signature-policy`, so the chaincode uses the channel default
(`/Channel/Application/Endorsement`).

"MAJORITY" of 2 is 2. This is strong (neither hospital can write alone) but means any outage at one
hospital blocks all writes. Options to discuss with both hospitals:

- Keep `MAJORITY` and add a second peer per hospital to reduce outage risk (recommended for 2 orgs).
- Use a chaincode-level policy such as `OR('HospitalAMSP.peer','HospitalBMSP.peer')` for availability, at the
  cost of trust: each hospital could then write alone. Not recommended for access grants.
- With 3+ hospitals, `MAJORITY` naturally tolerates one hospital being down.

### Changing a channel policy (config update)

Any change to channel config (policies, orgs, orderer set, CRLs, capabilities) follows the same steps:

1. Fetch the current config block:
   `peer channel fetch config config_block.pb -c patientchainchannel -o <orderer> --tls --cafile <ca>`
2. Decode to JSON with `configtxlator proto_decode`, extract `.data.data[0].payload.data.config`.
3. Edit a copy of the JSON.
4. Compute the delta: `configtxlator compute_update` (original vs. modified), wrap in an envelope.
5. Collect signatures: each required org admin runs `peer channel signconfigtx -f update_envelope.pb` at
   their own site with their own admin identity. Under `MAJORITY Admins`, both Hospital A and Hospital B
   must sign. Orderer-section changes need orderer admin signatures.
6. Submit: `peer channel update -f update_envelope.pb -c patientchainchannel -o <orderer> --tls --cafile <ca>`.
7. Verify by fetching the config again; record the change, approvers, and date in the change log.

Governance rules to agree in writing (consortium / data-sharing agreement):

- Who holds admin keys at each hospital, and the minimum approvers per change type.
- Change request and review process; lead time for non-emergency changes.
- Emergency change process (e.g. revoking a compromised identity).
- How a hospital leaves the consortium and what happens to its ledger copy.

## 7. Adding a third hospital

1. Hospital C sets up its own CAs, peer(s), and optionally orderer node(s) (§3–4). Add an entry in
   `crypto-config.yaml` only for local testing; production uses its Fabric CA.
2. Generate Hospital C's org definition: `configtxgen -printOrg HospitalCMSP > hospitalc.json` (needs an org
   entry in `configtx.yaml` with its MSP dir, policies, and anchor peer).
3. Channel config update (§6) adding `HospitalCMSP` under `channel_group.groups.Application.groups`.
   Hospital A and Hospital B admins sign.
4. Hospital C fetches block 0 (or a snapshot) and joins its peer(s): `peer channel join` or
   `peer channel joinbysnapshot`.
5. Hospital C sets its anchor peer via a config update signed by its own admin.
6. Chaincode: Hospital C installs the **same package** and approves the **currently committed** definition
   (same name, version, sequence). It can then endorse.
7. Note the endorsement effect: `MAJORITY` of 3 is 2. Confirm all three hospitals accept this before step 3.
8. Optional: add Hospital C orderer node(s) to the Raft consenter set (§8).
9. Onboard the backend, HL7 feed, and FHIR adapter for Hospital C following the rollout plan
   ([rollout-plan.md](../governance/rollout-plan.md)).

## 8. Raft orderer cluster

- Run **3 nodes** (tolerates 1 failure) or **5 nodes** (tolerates 2). Even numbers add cost without
  adding fault tolerance.
- Spread nodes across hospitals and power circuits, e.g. 2 at Hospital A, 1 at Hospital B for 3 nodes; or
  2 + 2 + 1 (third site or hosted) for 5. With 3 nodes split 2/1, losing Hospital A's site stops ordering,
  so a third location is preferable when available.
- Each node has its own TLS cert listed in the consenter set and in `Orderer.Addresses`.
- Adding a node: issue its certs → config update adding it to `Consenters` (and addresses) → start the node
  → `osnadmin channel join` with the latest config block → wait for it to catch up. Add one node at a time.
- Removing a node: config update removing it from `Consenters` → stop it → wipe its data.
- Monitor leader changes and per-node block height (runbook §1).
- Tune `BatchTimeout` and `BatchSize` from the evaluation results in `docs/evaluation/` (current:
  `BatchTimeout: 2s`, `MaxMessageCount: 100`).

## 9. Chaincode upgrade procedure

Fabric chaincode lifecycle: every change (new code or new policy) is a new definition with an incremented
**sequence**; new code also gets a new **version** label and package.

### Prepare

- [ ] Code reviewed and tests pass (`go test ./...` in `chaincode/`).
- [ ] Data compatibility checked: new code can read state written by the old code. No breaking change to
      stored JSON without a migration path.
- [ ] Upgrade rehearsed end-to-end in UAT with a copy of realistic (synthetic) state.
- [ ] Rollback package (the currently running version) archived and its package ID recorded.
- [ ] Change approved by both hospitals per §6; window announced.

### Steps

1. Package: `peer lifecycle chaincode package patientchain_<ver>.tar.gz --path <src> --lang golang
   --label patientchain_<ver>`. Share the identical file with both hospitals; compare SHA-256 hashes.
2. Install on every peer of every hospital: `peer lifecycle chaincode install`.
   Get the package ID with `queryinstalled`.
3. Each hospital admin approves at its own site:
   `peer lifecycle chaincode approveformyorg -C patientchainchannel -n patientchain -v <ver>
   --package-id <id> --sequence <current+1> ...` (plus any policy flags, which must match across orgs).
4. Check: `peer lifecycle chaincode checkcommitreadiness ...` shows `true` for both orgs.
5. Commit (one admin, targeting peers of both orgs to collect endorsements):
   `peer lifecycle chaincode commit ... --sequence <current+1> --peerAddresses <A> --peerAddresses <B>`.
6. Verify: `peer lifecycle chaincode querycommitted -C patientchainchannel -n patientchain`; run smoke tests
   via the backend (register test DID, grant, revoke, read audit).
7. Record version, sequence, package hash, approvers, and time in the change log.

### Rollback

Fabric has no "undo"; rollback is a forward upgrade to the old code:

1. Approve the **previous** package ID with sequence `<current+1>` (sequence always increases).
2. Commit as above.
3. Only safe if the new version did not write state the old version cannot read. This is why data
   compatibility is checked before the upgrade.

## 10. Backups

See [runbook.md](runbook.md) §4–5 for schedules and procedures. Fabric-specific points:

- Peer ledgers are replicated across hospitals; take periodic `peer snapshot submitrequest` snapshots to
  speed up rebuilding a peer.
- Orderer volumes: back up with the node stopped, one node at a time. Prefer replacing failed nodes over
  restoring old data.
- CA databases, CA keys, MSP folders, and channel config history are the hardest items to recreate. Back
  them up on every change and escrow the keys.
- Keep a copy of every chaincode package that has been committed.

## 11. Go-live checklist

- [ ] Per-org Fabric CA and TLS CA running; cryptogen material removed from production hosts
- [ ] Peers on separate hosts per hospital; inter-site VPN and firewall allowlists in place
- [ ] Raft cluster of 3 or 5 nodes across sites
- [ ] TLS on all endpoints; mutual TLS enabled where supported
- [ ] Keys in HSM, or 0400 files with disk encryption; admin keys off servers
- [ ] Docker socket not mounted into peers (chaincode-as-a-service / external builder)
- [ ] Endorsement and admin policies agreed in writing by both hospitals
- [ ] Chaincode upgrade and rollback rehearsed in UAT
- [ ] Revocation (CRL) procedure rehearsed in UAT
- [ ] Cert expiry monitoring and alerting live
- [ ] Backups, snapshots, and key escrow tested (runbook §6)
- [ ] Backend runs with `LEDGER_MODE=fabric` using a client identity (not an admin identity)
