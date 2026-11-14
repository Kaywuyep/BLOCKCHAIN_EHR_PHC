'use strict';

/**
 * Round: AuditLogContract:WriteAuditEntry(entryID, patientDID, eventType,
 *            actorID, hospitalID, detail, clientTimestampRFC3339, queuedOffline)
 * No prerequisites (the chaincode does not require the patient to exist).
 * lambda_a in the cost model.
 */
const { PatientChainWorkload } = require('./common');

const EVENT_TYPES = ['RECORD_ACCESSED', 'GRANT_ISSUED', 'GRANT_REVOKED', 'REFERENCE_ADDED'];

class WriteAuditEntryWorkload extends PatientChainWorkload {
    get name() {
        return 'writeAuditEntry';
    }

    async submitTransaction() {
        const n = this.nextIndex();
        await this.send('AuditLogContract:WriteAuditEntry', [
            this.id('a', n),
            this.patientDID(n % Number(this.args.patientPool)),
            EVENT_TYPES[n % EVENT_TYPES.length],
            `provider-${this.prefix}`,
            this.args.hospitalID,
            'caliper benchmark entry',
            PatientChainWorkload.rfc3339Now(),
            'false',
        ]);
    }
}

function createWorkloadModule() {
    return new WriteAuditEntryWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
