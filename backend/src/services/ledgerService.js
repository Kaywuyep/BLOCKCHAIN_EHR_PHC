'use strict';

const { SimulatedLedgerService } = require('./simulatedLedgerService');
const { FabricLedgerService } = require('./fabricLedgerService');
const { logger } = require('../logger');

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
    // The signing key can come from an HSM, a single key file, or a key
    // directory; only one is needed.
    const keySource = process.env.FABRIC_HSM_LIBRARY || process.env.FABRIC_KEY_PATH || process.env.FABRIC_KEY_DIR;
    if (keySource) cfg.keyDir = cfg.keyDir || '(unused)';
    const missing = Object.entries(cfg).filter(([, v]) => !v);
    if (missing.length) {
      throw new Error(
        `LEDGER_MODE=fabric but missing env vars: ${missing.map(([k]) => k).join(', ')}. See .env.example.`
      );
    }
    cfg.keyPath = process.env.FABRIC_KEY_PATH || '';
    if (process.env.FABRIC_HSM_LIBRARY) {
      cfg.hsm = {
        library: process.env.FABRIC_HSM_LIBRARY,
        label: process.env.FABRIC_HSM_LABEL,
        pin: process.env.FABRIC_HSM_PIN,
        keyId: process.env.FABRIC_HSM_KEY_ID,
      };
    }
    const svc = new FabricLedgerService(cfg);
    await svc.connect();
    logger.info(`[ledger] connected to Fabric as ${cfg.mspId} on channel ${cfg.channelName}`, {
      signer: cfg.hsm ? 'hsm' : cfg.keyPath ? 'key-file' : 'key-dir',
    });
    // Certificate rotation without a restart: replace the files, then SIGHUP.
    process.on('SIGHUP', () => {
      svc
        .reconnect()
        .then(() => logger.info('[ledger] reconnected with reloaded credentials'))
        .catch((err) => logger.error('[ledger] credential reload failed; keeping the old connection', { err }));
    });
    instance = svc;
    return instance;
  }

  logger.warn('[ledger] running in SIMULATED mode -- no Fabric network required. Set LEDGER_MODE=fabric to use the real network.');
  instance = new SimulatedLedgerService();
  return instance;
}

module.exports = { getLedgerService };
