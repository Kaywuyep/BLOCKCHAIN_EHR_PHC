'use strict';

/**
 * Round: AccessControlContract:GrantAccess(grantID, durationMinutes, signature)
 * Prerequisites (unmeasured): patient pool + one PENDING request per
 * transaction this worker will send. signature is "" because the patients
 * carry placeholder (non-SPKI) keys.
 */
const { PatientChainWorkload } = require('./common');

class GrantAccessWorkload extends PatientChainWorkload {
    get name() {
        return 'grantAccess';
    }

    async prepare() {
        await this.registerPatientPool();
        this.pending = await this.createPendingGrants(this.perWorker);
    }

    async submitTransaction() {
        const n = this.nextIndex();
        // Wraps around only if Caliper sends more than perWorker
        // transactions; those repeats fail (grant no longer PENDING) and
        // show up as failures rather than being silently skipped.
        const grantID = this.pending[n % this.pending.length];
        await this.send('AccessControlContract:GrantAccess', [grantID, String(this.args.durationMinutes), '']);
    }
}

function createWorkloadModule() {
    return new GrantAccessWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
