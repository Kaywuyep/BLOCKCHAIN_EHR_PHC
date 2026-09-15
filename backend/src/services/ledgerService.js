'use strict';

const { SimulatedLedgerService } = require('./simulatedLedgerService');
const { FabricLedgerService } = require('./fabricLedgerService');

let instance = null;

/**
 * getLedgerService() returns a singleton implementing:
 *   registerPatient, getPatient, registerRecordReference,
 *   getRecordReferencesForPatient, requestAccess, grantAccess,
 *   revokeAccess, checkAccess, getGrantsForPatient, writeAuditEntry,
 *   getAuditTrailForPatient, getCounters, getRecentEvents
 *
 * LEDGER_MODE=fabric connects to the real deployed chaincode.
 * LEDGER_MODE=simulated (default) runs entirely in-memory so the demo
 * works without Docker/Fabric running.
 */
async function getLedgerService() {
  if (instance) return instance;

  const mode = (process.env.LEDGER_MODE || 'simulated').toLowerCase();

  if (mode === 'fabric') {
    const cfg = {
      mspId: process.env.FABRIC_MSP_ID,
      peerEndpoint: process.env.FABRIC_PEER_ENDPOINT,
      peerHostAlias: process.env.FABRIC_PEER_HOST_ALIAS,
      tlsCertPath: process.env.FABRIC_TLS_CERT_PATH,
      certPath: process.env.FABRIC_CERT_PATH,
      keyDir: process.env.FABRIC_KEY_DIR,
      channelName: process.env.FABRIC_CHANNEL_NAME || 'patientchainchannel',
      chaincodeName: process.env.FABRIC_CHAINCODE_NAME || 'patientchain',
    };
    const missing = Object.entries(cfg).filter(([, v]) => !v);
    if (missing.length) {
      throw new Error(
        `LEDGER_MODE=fabric but missing env vars: ${missing.map(([k]) => k).join(', ')}. See .env.example.`
      );
    }
    const svc = new FabricLedgerService(cfg);
    await svc.connect();
    console.log(`[ledger] connected to real Fabric network as ${cfg.mspId} on channel ${cfg.channelName}`);
    instance = svc;
    return instance;
  }

  console.log('[ledger] running in SIMULATED mode -- no Fabric network required. Set LEDGER_MODE=fabric to use the real network.');
  instance = new SimulatedLedgerService();
  return instance;
}

module.exports = { getLedgerService };
