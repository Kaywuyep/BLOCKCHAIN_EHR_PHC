'use strict';

/**
 * Round: PatientRegistryContract:RegisterPatient(patientDID, publicKey)
 * No prerequisites; every transaction registers a fresh DID with a
 * placeholder (non-SPKI) public key.
 */
const { PatientChainWorkload } = require('./common');

class RegisterPatientWorkload extends PatientChainWorkload {
    get name() {
        return 'registerPatient';
    }

    async submitTransaction() {
        const n = this.nextIndex();
        await this.send('PatientRegistryContract:RegisterPatient', [
            `did:patientchain:${this.id('p', n)}`,
            `pk-bench-${n}`,
        ]);
    }
}

function createWorkloadModule() {
    return new RegisterPatientWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
