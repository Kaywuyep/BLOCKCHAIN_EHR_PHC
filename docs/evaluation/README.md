# Evaluation results (thesis Chapter Five)

All files were produced on 14 November 2026 from the final code, on the
development workstation described in Table 4.1. Each Fabric run used a newly
created network (`docker compose down -v`, `network-up.sh`, `deployChaincode.sh`).

| File | What it is | How it was produced |
|---|---|---|
| `results-fabric-2s.json` | evaluate.js, Fabric, orderer BatchTimeout 2 s (the committed default) | see below |
| `results-fabric-500ms.json` | evaluate.js, Fabric, BatchTimeout 500 ms | `BatchTimeout: 500ms` in `network/configtx.yaml`, then as below |
| `results-simulated.json` | evaluate.js against the simulated ledger (baseline) | as below with `LEDGER_MODE=simulated`, without `--fabric` |
| `dockerstats-fabric-*.txt` | container memory at the end of each Fabric run | `docker stats --no-stream` |
| `acceptance-fabric.txt` | 57 role-by-role acceptance checks (Table 5.2) | `backend/scripts/acceptance.js` on a freshly seeded Fabric demo world |
| `page-sweep-fabric.txt` | browser pass through every page for each demo account | `frontend/scripts/page-sweep.cjs` |

evaluate.js runs (from `backend/`), with `config/hospitalIngestion.ab.json`
giving `hospital-a` and `hospital-b` HL7 MLLP listeners on ports 5101 and 5102:

```
DATA_DIR=<empty dir> AUTH_MODE=off DEMO_SEED=off HOSPITAL_INGESTION_CONFIG=config/hospitalIngestion.ab.json \
  HL7_MLLP_ENABLED=true LEDGER_MODE=fabric PORT=4600 RATE_LIMIT_PER_MINUTE=0 node src/server.js
node scripts/evaluate.js --base http://localhost:4600 --mllp-a 5101 --mllp-b 5102 \
  --patients 10 --out results-fabric-2s.json --fabric
```

The figures in Chapter Five (authorisation latency; batching with the fitted
cost model) are drawn directly from these JSON files.
