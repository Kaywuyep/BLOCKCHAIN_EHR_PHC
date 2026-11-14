# PatientChain Caliper benchmarks: measuring Caction(b)

This workspace runs [Hyperledger Caliper](https://hyperledger-caliper.github.io/caliper/) 0.6 against the
PatientChain Fabric 2.5 network in `network/`. Its job is to replace the illustrative cost-model constants in
`backend/src/services/costModel.js` with measured ones, by checking the per-action cost model of
Section 3.5.2 against the batching discussion in Section 3.4.4:

```
Caction(b) = Ce + Cv + Co / b
```

- `b` is the number of transactions per block, set by the orderer's `BatchSize.MaxMessageCount` (and limited by
  `BatchTimeout`) in `network/configtx.yaml`.
- `Ce + Cv` (endorsement + validation/commit, paid by every transaction) is the asymptote the curve approaches as `b` grows.
- `Co` (ordering and block-processing overhead, paid once per block) is shared by the `b` transactions in the block.

Caliper runs the benchmark once per batch size. `scripts/fit-curve.js` then does a least-squares fit of
`A + Co/b` to the measurements and reports `A` (the measured `Ce + Cv`) and `Co`.

## Layout

| Path | What it is |
|---|---|
| `package.json` | Pins `@hyperledger/caliper-cli` 0.6.0. Its npm scripts bind Caliper to `fabric:2.5` and run it. |
| `networks/fabric-network.yaml` | Caliper Fabric connector config: channel `patientchainchannel`, chaincode `patientchain`, HospitalA's `User1` identity from `network/crypto-config`. |
| `networks/connection-profile-hospitala.yaml` | Connection profile for the gateway peer `peer0.hospitala.patientchain.local`, reached at `localhost:7051` with a TLS host-name override. |
| `benchmarks/config.yaml` | The full benchmark (26 rounds; see below). |
| `benchmarks/config-smoke.yaml` | A few transactions per function, to check the setup end to end in about a minute. |
| `workload/*.js` | One `WorkloadModuleBase` module per chaincode function, sharing `workload/common.js`. |
| `scripts/run-batch-sweep.sh` | Runs the benchmark for each `b` in `1 2 5 10 20 50` and saves the output to `results/b-<n>/`. |
| `scripts/fit-curve.js` | Fits `Caction(b) = A + Co/b` and writes CSVs for the chart. |
| `samples/sample-sweep.csv` | **Synthetic** example input for `fit-curve.js`, used to test the script. These are not measurements. |

## Prerequisites

1. **The network is running and the chaincode is deployed** with the current access-control signatures:
   `RequestAccess(..., providerRole)`, `GrantAccess(grantID, durationMinutes, signature)` and
   `RevokeAccess(grantID, signature)`:
   ```bash
   cd network
   ./scripts/network-up.sh
   ./scripts/deployChaincode.sh
   ```
   `deployChaincode.sh` installs version 1.0 at sequence 1. If you already deployed an older build of the
   chaincode on this network, recreate the network (see the sweep below) or raise `CC_VERSION` and
   `CC_SEQUENCE` in that script. Otherwise the 7-argument `RequestAccess` call fails.
2. **Node.js 18.19 or later.** Caliper 0.6 is tested on Node 18 and 20, so `nvm use 20` (or 18) is the safe choice.
   The backend's Node 22 should also work, but Node 26 has not been tested with Caliper.
3. **Docker socket access** for the resource monitor in `config.yaml`, which records CPU and memory for the
   orderer and both peers. If you don't want it, delete the `monitors:` block.
4. Install Caliper and bind it once:
   ```bash
   cd benchmarks/caliper
   npm install
   npm run bind            # caliper bind --caliper-bind-sut fabric:2.5  (installs @hyperledger/fabric-gateway)
   ```

**How Caliper connects.** Caliper uses the Fabric Gateway client, just like `backend/src/services/fabricLedgerService.js`.
It talks only to `peer0.hospitala`, and that peer's gateway collects the second endorsement from `peer0.hospitalb`
inside the docker network. The channel's endorsement policy (`MAJORITY Endorsement`) requires both hospitals,
which is `k = 2` in the cost model. If the TLS host-name override doesn't take effect on your machine, add
`127.0.0.1 peer0.hospitala.patientchain.local` to `/etc/hosts` and change the `url` in the connection profile
(the profile's header comment explains how).

## Running

Run the smoke test first, against whatever batch size the network currently has:

```bash
npm run benchmark:smoke        # report in results/smoke/report.html
```

Run the full benchmark once, without the sweep:

```bash
npm run benchmark              # report.html in this folder
```

### The batch-size sweep

`MaxMessageCount` is part of the channel configuration. `network-up.sh` builds the channel's genesis block from
`network/configtx.yaml`. Note that this is **`network/configtx.yaml`, not `network/config/configtx.yaml`**,
because the script sets `FABRIC_CFG_PATH=network/`. So each `b` needs these steps:

1. Edit `network/configtx.yaml` and set `Orderer` → `BatchSize` → `MaxMessageCount: <b>`. The repository
   default is 100. Leave `BatchTimeout: 2s` as it is.
2. Recreate the network **with its volumes**, because the old ledger still holds the old channel config, and
   redeploy the chaincode:
   ```bash
   cd network
   docker compose -f docker-compose.yaml down -v
   docker rm -f $(docker ps -aq --filter name=dev-peer) 2>/dev/null || true   # old chaincode containers
   ./scripts/network-up.sh
   ./scripts/deployChaincode.sh
   ```
3. Run Caliper and keep that run's output in `results/b-<b>/`.

`scripts/run-batch-sweep.sh` automates this in three modes:

```bash
bash scripts/run-batch-sweep.sh                 # manual: prints the steps for each b, waits for you, checks configtx.yaml, runs Caliper
bash scripts/run-batch-sweep.sh --auto          # edits configtx.yaml, tears down/recreates the network, deploys, runs; restores configtx.yaml at the end
bash scripts/run-batch-sweep.sh --current 10    # run once against the network as it is now, saved as results/b-10/
BATCH_SIZES="1 5 25" bash scripts/run-batch-sweep.sh --auto     # a different set of b values
BENCH_CONFIG=benchmarks/config-smoke.yaml bash scripts/run-batch-sweep.sh --auto   # quick dry run of the whole sweep
```

`--auto` **destroys the running network's ledger** each time it changes `b`. Don't use it on a network whose
data you need.

Each `results/b-<n>/` contains:
- `report.html`: Caliper's report.
- `caliper.log`: the console output.
- `meta.txt`: `MaxMessageCount`, `BatchTimeout`, git revision, Node version and host.
- `raw/round-XX-<fn>-wN.json`: millisecond-precision statistics per worker. Caliper's report rounds latencies to
  10 ms, so `fit-curve.js` uses these files when they exist.

Plan for 10–20 minutes per batch size on a laptop. The `b = 1` run is the slowest.

### Fitting the curve

```bash
node scripts/fit-curve.js --results results --out results/fit
```

This prints the following, per function and pooled over all functions (`all`):

```
group   n  b-values         A=Ce+Cv  +/-   Co     +/-   R^2    RMSE
...
Headline (pooled over all functions):  Ce + Cv = <A> ms,  Co = <Co> ms
CheckAccess query latency (...): <q> ms
  -> Ce ~ <q> ms,  Cv ~ A - Ce = <A-q> ms
```

It also writes three files:
- `results/fit/fit-points.csv`: `group,label,b_nominal,b_eff,observed_ms,fitted_ms,residual_ms`. These are the
  measured points and the model's value at each one.
- `results/fit/fit-curve.csv`: `group,b,fitted_ms,asymptote_ms` for `b = 1..50`. This is the fitted curve and
  the `Ce + Cv` asymptote, ready to chart.
- `results/fit/fit-summary.json`: all of the above in one machine-readable file.

To try the script without a network, use the synthetic sample:

```bash
node scripts/fit-curve.js --csv samples/sample-sweep.csv --out samples/fit-output
# A ~ 18, Co ~ 40: it recovers the parameters the sample was generated from
```

**CSV input.** If you collect numbers some other way, `--csv` accepts a header with `b` plus one of these
columns: `value_ms`, `avg_latency_ms`, or `throughput_tps` (converted to `1000 / tps`). Add a `function` column
to fit several series at once. Lines starting with `#` are ignored.

## What is measured, and why

### The rounds

`benchmarks/config.yaml` runs 2 local workers through these rounds:

| Function (chaincode) | Rounds | Prerequisites (created during round initialisation, not measured) |
|---|---|---|
| `PatientRegistryContract:RegisterPatient` | `-r10`, `-r25`, `-r50`, `-max` | none |
| `PatientRegistryContract:RegisterRecordReference` | same | 5 patients per worker |
| `AccessControlContract:RequestAccess` | same | 5 patients per worker |
| `AccessControlContract:GrantAccess` | same | patients plus one PENDING request per transaction |
| `AccessControlContract:RevokeAccess` | same | patients plus one ACTIVE grant per transaction |
| `AuditLogContract:WriteAuditEntry` | same | none |
| `AccessControlContract:CheckAccess` (query) | `-r50`, `-r100` | 20 ACTIVE grants per worker |

- **IDs.** Every ID has the form `bench-<runTag>-r<round>-w<worker>-<kind><n>`, so rounds and repeated runs never
  collide on the same ledger. Set `BENCH_RUN_TAG` to make IDs reproducible. The sweep script sets it to
  `b<n>-<epoch>`.
- **Patient keys.** Patients are registered with placeholder keys such as `pk-bench-3`. These are not SPKI keys,
  so the chaincode accepts `GrantAccess` and `RevokeAccess` with an empty `signature`. The benchmark therefore
  measures ledger cost, not client-side ECDSA signing.
- **No write conflicts.** The cost counters write one marker key per transaction (`costevent~<category>~<txID>`),
  and each grant, entry and reference has its own key. Concurrent transactions in one block therefore never cause
  MVCC conflicts, and failures should be zero. A non-zero `Fail` column means a real problem, such as a chaincode
  version mismatch or a wrong argument count.

### Which number is Caction(b)

A block is cut when it holds `MaxMessageCount` transactions or when `BatchTimeout` (2 s) expires, whichever
comes first. At send rate `R`, blocks therefore hold about `b_eff = min(MaxMessageCount, R × BatchTimeout)`
transactions. The two kinds of round use this differently:

- **Fixed-rate rounds** (`-r10`, `-r25`, `-r50`) fill blocks to different sizes. For example, at `b = 50` the
  `-r10` round only reaches about 20 transactions per block. Their **latency** is what a user waits for, but it
  includes the time a transaction spends waiting for its block to fill, roughly `(b_eff − 1) / 2R`. That wait
  grows with `b`, so latency is not `Caction(b)`. Report it in the latency column of Table 3.9, but don't fit
  the model to it. (`--metric latency` exists for descriptive plots and prints this warning.)
- **Saturating `-max` rounds** (fixed-load, 150 transactions in flight) keep the orderer's queue full, so every
  block is cut by count and `b_eff = MaxMessageCount`. The pipeline then processes one block of `b` transactions
  in time `Co + b·(Ce + Cv)`. So the **ledger time per committed transaction**, `1000 / throughput` (ms), equals
  `Ce + Cv + Co/b`, which is exactly the model. `fit-curve.js` fits this by default
  (`--metric invtps --rounds '-max$'`).

**Splitting `Ce + Cv`.** The fit only identifies their sum, `A`. `CheckAccess` is a query: the gateway peer
evaluates it with no ordering or validation. Its latency is therefore a reasonable stand-in for the
endorsement/execution share `Ce`, and `Cv ≈ A − Ce`. This is an approximation. A submitted transaction's two
endorsements run in parallel on two peers, and the query latency also includes a client round trip. Present the
split as indicative and `A` as the measured quantity.

**Checks before you trust a fit.**
1. Every `-max` round should have `Fail = 0`.
2. The `-max` throughput should be clearly below what the fixed-rate rounds achieved at the same `b`; otherwise
   the run wasn't saturated.
3. `R²` should be high, and `Co` and `A` should both be positive. The script warns when they aren't.
4. If the Caliper host's CPU is the bottleneck (check the docker monitor table and `top`), you are measuring the
   client. Raise `test.workers.number` or `transactionLoad`, or run Caliper on another machine.

## How this maps to the thesis

- **Section 3.4.4 (batching).** The sweep varies the batch size `b` directly. The fitted curve shows how much of
  the per-block overhead `Co` batching amortises, and where the diminishing returns that Section 3.5.2 predicts
  start: past roughly `b ≈ Co / (0.1 · A)`, the `Co/b` term is under 10 % of the cost. The chaincode also has
  `AccessControlContract:GrantAccessBatch` (application-level batching, several grants in one transaction).
  It isn't part of this config, but a round can be added by copying `workload/grantAccess.js`.
- **Table 3.9.** Fill one row per batch size from `results/fit/fit-points.csv` (`b_nominal`, `observed_ms`,
  `fitted_ms`, `residual_ms`, using the `all` group or a single function). Take throughput and latency from the
  matching `report.html`. Report the fitted `Ce + Cv`, `Co` (± standard error) and `R²` underneath, and chart
  `fit-curve.csv` (fitted curve plus the dashed `asymptote_ms` line) with the observed points on top. That chart
  is the "empirical curve fitted against the modelled Ce + Cv asymptote".
- Record the hardware and software environment (`meta.txt`) alongside the table. The absolute numbers are only
  valid for that host.

## Updating the backend cost model from the fit

`backend/src/services/costModel.js` holds illustrative defaults:

```js
const DEFAULT_PARAMS = {
  k: 2,
  Ce: 12, // illustrative ms; replace with Hyperledger Caliper benchmarking results (Section 3.12)
  Co: 40,
  Cv: 6,
  b: 10,
};
```

After a sweep:

1. Set `Co` to the fitted `Co`, rounded to whole ms.
2. Set `Ce` to the `CheckAccess` estimate and `Cv` to `A − Ce`. If you don't want to use the query-latency split,
   divide `A` in a ratio you can justify and say so in the thesis. The model and the dashboard only ever use
   `Ce + Cv` together, so the curve doesn't change either way.
3. Set `b` to the `MaxMessageCount` the pilot network actually runs with. `network/configtx.yaml` ships with 100.
   If you change the network's default, change both values together.
4. Replace the "illustrative" comment with the source, for example: `// Caliper 0.6 sweep 2026-11-xx, b=1..50, R²=0.98, see benchmarks/caliper/results/fit`.
5. Update `backend/src/services/costModel.test.js`. Lines 18–21 hard-code `12 + 6 + 40 / b`, and the test at
   line 37 expects the cost at `b = 50` to be within 1 ms of the floor, which only holds while `Co < 50`.
   Rewrite those assertions in terms of `DEFAULT_PARAMS`, or relax the tolerance to `Co / 50`.
6. You can also try the measured values without editing code: `GET /api/cost/summary?Ce=..&Cv=..&Co=..&b=..`
   overrides them per request.

## Things to watch

- `network-up.sh` regenerates all crypto material each time it runs. The paths in `networks/` stay valid because
  cryptogen keeps the same file names (`keystore/priv_sk`).
- Caliper does not pass `txNumber` to workload modules, so each round repeats it in `workload.arguments.txNumber`
  to size its prerequisites. If you change one, change the other.
- The workload modules assume the access-control signatures listed under Prerequisites. If the chaincode changes
  again, update `requestArgs()` in `workload/common.js` and the calls in `grantAccess.js`, `revokeAccess.js` and
  `checkAccess.js`.
