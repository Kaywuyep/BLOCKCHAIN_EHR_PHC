'use strict';

/**
 * Round: AccessControlContract:RevokeAccess(grantID, signature)
 * Prerequisites (unmeasured): patient pool, then RequestAccess + GrantAccess
 * for one ACTIVE grant per transaction this worker will send.
 */
const { PatientChainWorkload } = require('./common');

class RevokeAccessWorkload extends PatientChainWorkload {
    get name() {
        return 'revokeAccess';
    }

    async prepare() {
        await this.registerPatientPool();
        const pending = await this.createPendingGrants(this.perWorker);
        this.active = await this.activateGrants(pending);
    }

    async submitTransaction() {
        const n = this.nextIndex();
        const grantID = this.active[n % this.active.length];
        await this.send('AccessControlContract:RevokeAccess', [grantID, '']);
    }
}

function createWorkloadModule() {
    return new RevokeAccessWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
