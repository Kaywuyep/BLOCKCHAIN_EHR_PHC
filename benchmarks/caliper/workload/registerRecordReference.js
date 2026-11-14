'use strict';

/**
 * Round: PatientRegistryContract:RegisterRecordReference(
 *            refID, patientDID, hospitalID, recordType, dateRFC3339)
 * Prerequisite: a small pool of registered patients per worker (the
 * chaincode rejects references for unknown DIDs). lambda_r in the cost model.
 */
const { PatientChainWorkload } = require('./common');

const RECORD_TYPES = ['Encounter', 'Observation', 'MedicationRequest', 'DiagnosticReport'];

class RegisterRecordReferenceWorkload extends PatientChainWorkload {
    get name() {
        return 'registerRecordReference';
    }

    async prepare() {
        await this.registerPatientPool();
    }

    async submitTransaction() {
        const n = this.nextIndex();
        await this.send('PatientRegistryContract:RegisterRecordReference', [
            this.id('ref', n),
            this.pickPatient(n),
            this.args.hospitalID,
            RECORD_TYPES[n % RECORD_TYPES.length],
            PatientChainWorkload.rfc3339Now(),
        ]);
    }
}

function createWorkloadModule() {
    return new RegisterRecordReferenceWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
