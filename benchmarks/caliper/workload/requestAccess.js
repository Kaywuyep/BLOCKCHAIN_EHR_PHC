'use strict';

/**
 * Round: AccessControlContract:RequestAccess(
 *            grantID, patientDID, providerID, hospitalID, scopeJSON, purpose, providerRole)
 * Prerequisite: a small pool of registered patients per worker. Each
 * transaction creates a new PENDING grant (lambda_g in the cost model).
 */
const { PatientChainWorkload } = require('./common');

class RequestAccessWorkload extends PatientChainWorkload {
    get name() {
        return 'requestAccess';
    }

    async prepare() {
        await this.registerPatientPool();
    }

    async submitTransaction() {
        const n = this.nextIndex();
        await this.send('AccessControlContract:RequestAccess', this.requestArgs(this.id('g', n), this.pickPatient(n)));
    }
}

function createWorkloadModule() {
    return new RequestAccessWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
