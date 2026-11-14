'use strict';

/**
 * Round: AccessControlContract:CheckAccess(grantID)  -- read-only query.
 * Prerequisites (unmeasured): `grantsToQuery` ACTIVE grants per worker.
 * Queries are evaluated on the gateway peer only (no ordering, no
 * validation), so their latency approximates the endorsement/execution
 * share of the cost (Ce) and is independent of the batch size b.
 */
const { PatientChainWorkload } = require('./common');

class CheckAccessWorkload extends PatientChainWorkload {
    get name() {
        return 'checkAccess';
    }

    async prepare() {
        await this.registerPatientPool();
        const count = Number(this.args.grantsToQuery || 20);
        const pending = await this.createPendingGrants(count);
        this.active = await this.activateGrants(pending);
    }

    async submitTransaction() {
        const n = this.nextIndex();
        const grantID = this.active[n % this.active.length];
        await this.send('AccessControlContract:CheckAccess', [grantID], true);
    }
}

function createWorkloadModule() {
    return new CheckAccessWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
