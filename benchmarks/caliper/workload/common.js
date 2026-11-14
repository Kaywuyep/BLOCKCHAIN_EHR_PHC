'use strict';

/**
 * Shared base class for the PatientChain Caliper workload modules.
 *
 * - Builds Caliper request objects for the single `patientchain` chaincode,
 *   whose functions are namespaced "<ContractName>:<Function>".
 * - Generates IDs that are unique per run, round, worker and transaction:
 *     bench-<runTag>-r<round>-w<worker>-<kind><n>
 *   so a round can be re-run on the same ledger without "already exists"
 *   failures (set BENCH_RUN_TAG to make IDs reproducible).
 * - Creates each round's prerequisites (patients, pending requests, active
 *   grants) inside initializeWorkloadModule. Caliper only activates its
 *   transaction observers after initialisation, so prerequisite
 *   transactions are NOT counted in the round's results.
 * - Optionally records millisecond-precision per-worker statistics to
 *   $BENCH_RAW_DIR/round-<idx>-<name>-w<worker>.json. Caliper's own report
 *   rounds latency to 10 ms; scripts/fit-curve.js prefers these files.
 *
 * Patients are registered with a placeholder (non-SPKI) public key such as
 * "pk-bench-3", for which GrantAccess / RevokeAccess accept an empty
 * signature, so the benchmark measures ledger cost rather than client-side
 * ECDSA signing.
 */

const fs = require('fs');
const path = require('path');
const { WorkloadModuleBase } = require('@hyperledger/caliper-core');

const RUN_TAG = process.env.BENCH_RUN_TAG || Date.now().toString(36);

const DEFAULTS = {
    contractId: 'patientchain',
    invokerIdentity: 'User1',
    invokerMspId: 'HospitalAMSP',
    hospitalID: 'hospital-a',
    providerRole: 'Physician',
    purpose: 'Treatment',
    durationMinutes: 60,
    // Patients registered per worker during initialisation; grants and
    // record references are spread over this pool.
    patientPool: 5,
    // How many prerequisite transactions are in flight at once.
    prereqConcurrency: 25,
    // Total transactions in the round (copy of the round's txNumber) --
    // used to size prerequisites. Caliper does not pass txNumber to the
    // workload module, so config.yaml repeats it in `arguments`.
    txNumber: 100,
    // Extra prerequisites per worker, in case Caliper's split of txNumber
    // across workers is uneven.
    margin: 5,
};

class PatientChainWorkload extends WorkloadModuleBase {
    /** Override: short name used in IDs and raw-stat file names. */
    get name() {
        return 'tx';
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
        this.args = Object.assign({}, DEFAULTS, roundArguments || {});
        this.prefix = `bench-${RUN_TAG}-r${roundIndex}-w${workerIndex}`;
        this.txIndex = 0;
        this.perWorker = Math.ceil(Number(this.args.txNumber) / totalWorkers) + Number(this.args.margin);
        this.stats = { succ: 0, fail: 0, latencies: [], firstCreate: null, lastFinal: null };
        this.patients = [];
        await this.prepare();
    }

    /** Override to create prerequisites. Runs before measurement starts. */
    async prepare() {}

    // ---------------------------------------------------------------- IDs

    nextIndex() {
        return this.txIndex++;
    }

    id(kind, n) {
        return `${this.prefix}-${kind}${n}`;
    }

    patientDID(n) {
        return `did:patientchain:${this.id('pat', n)}`;
    }

    pickPatient(n) {
        return this.patients[n % this.patients.length];
    }

    static rfc3339Now() {
        // Strip milliseconds: chaincode parses with Go's time.RFC3339.
        return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    // ----------------------------------------------------------- requests

    request(fn, args, readOnly = false) {
        return {
            contractId: this.args.contractId,
            contractFunction: fn,
            contractArguments: args.map(String),
            invokerIdentity: this.args.invokerIdentity,
            invokerMspId: this.args.invokerMspId,
            readOnly,
        };
    }

    /** Measured transaction: sends one request and records raw stats. */
    async send(fn, args, readOnly = false) {
        let result;
        try {
            result = await this.sutAdapter.sendRequests(this.request(fn, args, readOnly));
        } catch (err) {
            // Caliper has already counted the failure; keep our stats in step.
            this.stats.fail++;
            return undefined;
        }
        this.record(result);
        return result;
    }

    record(result) {
        if (!result) {
            return;
        }
        const created = result.GetTimeCreate();
        const final = result.GetTimeFinal();
        if (created && (this.stats.firstCreate === null || created < this.stats.firstCreate)) {
            this.stats.firstCreate = created;
        }
        if (final && (this.stats.lastFinal === null || final > this.stats.lastFinal)) {
            this.stats.lastFinal = final;
        }
        if (result.IsCommitted()) {
            this.stats.succ++;
            if (created && final) {
                this.stats.latencies.push(final - created);
            }
        } else {
            this.stats.fail++;
        }
    }

    /**
     * Unmeasured prerequisite batch. `items` are arbitrary values; toArgs
     * maps one to [fn, argsArray]. Returns the items whose transaction
     * committed. Throws if fewer than half succeeded (the round would be
     * meaningless).
     */
    async prereq(label, items, toArgs) {
        const ok = [];
        const size = Math.max(1, Number(this.args.prereqConcurrency));
        for (let i = 0; i < items.length; i += size) {
            const chunk = items.slice(i, i + size);
            const reqs = chunk.map((item) => {
                const [fn, args] = toArgs(item);
                return this.request(fn, args, false);
            });
            let results;
            try {
                results = await this.sutAdapter.sendRequests(reqs);
            } catch (err) {
                // sendRequests rethrows the first unexpected error after
                // settling every request; per-request status is lost, so
                // count the whole chunk as failed.
                results = [];
            }
            results.forEach((r, idx) => {
                if (r && r.IsCommitted()) {
                    ok.push(chunk[idx]);
                }
            });
        }
        // eslint-disable-next-line no-console
        console.log(`[${this.prefix}] prerequisite ${label}: ${ok.length}/${items.length} committed`);
        if (items.length > 0 && ok.length < items.length / 2) {
            throw new Error(`Too many prerequisite ${label} transactions failed (${ok.length}/${items.length}); check the network and chaincode version`);
        }
        return ok;
    }

    /** Register this worker's patient pool (placeholder keys). */
    async registerPatientPool() {
        const idx = [...Array(Number(this.args.patientPool)).keys()];
        const ok = await this.prereq('RegisterPatient', idx, (n) => [
            'PatientRegistryContract:RegisterPatient',
            [this.patientDID(n), `pk-bench-${n}`],
        ]);
        this.patients = ok.map((n) => this.patientDID(n));
    }

    requestArgs(grantID, patientDID) {
        return [
            grantID,
            patientDID,
            `provider-${this.prefix}`,
            this.args.hospitalID,
            JSON.stringify(['Observation', 'MedicationRequest']),
            this.args.purpose,
            this.args.providerRole,
        ];
    }

    /** Create `count` PENDING grants; returns the committed grant IDs. */
    async createPendingGrants(count) {
        const idx = [...Array(count).keys()];
        const ok = await this.prereq('RequestAccess', idx, (n) => [
            'AccessControlContract:RequestAccess',
            this.requestArgs(this.id('pg', n), this.pickPatient(n)),
        ]);
        return ok.map((n) => this.id('pg', n));
    }

    /** Approve the given PENDING grants; returns the now-ACTIVE grant IDs. */
    async activateGrants(grantIDs) {
        return this.prereq('GrantAccess', grantIDs, (g) => [
            'AccessControlContract:GrantAccess',
            [g, String(this.args.durationMinutes), ''],
        ]);
    }

    // ------------------------------------------------------------ cleanup

    async cleanupWorkloadModule() {
        const dir = process.env.BENCH_RAW_DIR;
        if (!dir) {
            return;
        }
        const lat = this.stats.latencies.slice().sort((a, b) => a - b);
        const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
        const sum = lat.reduce((a, b) => a + b, 0);
        const out = {
            roundIndex: this.roundIndex,
            name: this.name,
            workerIndex: this.workerIndex,
            totalWorkers: this.totalWorkers,
            runTag: RUN_TAG,
            arguments: this.roundArguments,
            succ: this.stats.succ,
            fail: this.stats.fail,
            firstCreateMs: this.stats.firstCreate,
            lastFinalMs: this.stats.lastFinal,
            latencyMs: {
                n: lat.length,
                sum,
                mean: lat.length ? sum / lat.length : null,
                p50: pct(0.5),
                p95: pct(0.95),
                min: lat.length ? lat[0] : null,
                max: lat.length ? lat[lat.length - 1] : null,
            },
        };
        try {
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `round-${String(this.roundIndex).padStart(2, '0')}-${this.name}-w${this.workerIndex}.json`);
            fs.writeFileSync(file, JSON.stringify(out, null, 2));
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`Could not write raw stats to ${dir}: ${err.message}`);
        }
    }
}

module.exports = { PatientChainWorkload, RUN_TAG };
