'use strict';

const fs = require('fs');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const crypto = require('crypto');

const utf8Decoder = new TextDecoder();

/**
 * fabricLedgerService.js
 *
 * Talks to the real, deployed "patientchain" chaincode over the Fabric
 * Gateway (peer.Gateway v2.5+ service) as a given hospital's client
 * identity. Configure via .env (see .env.example):
 *
 *   LEDGER_MODE=fabric
 *   FABRIC_MSP_ID=HospitalAMSP
 *   FABRIC_PEER_ENDPOINT=localhost:7051
 *   FABRIC_PEER_HOST_ALIAS=peer0.hospitala.patientchain.local
 *   FABRIC_TLS_CERT_PATH=../network/crypto-config/.../peers/.../tls/ca.crt
 *   FABRIC_CERT_PATH=../network/crypto-config/.../users/User1@.../msp/signcerts/cert.pem
 *   FABRIC_KEY_DIR=../network/crypto-config/.../users/User1@.../msp/keystore
 *   FABRIC_CHANNEL_NAME=patientchainchannel
 *   FABRIC_CHAINCODE_NAME=patientchain
 *
 * Production signing key, in order of preference:
 *   1. an HSM over PKCS#11 -- the private key never leaves the device:
 *        FABRIC_HSM_LIBRARY=/usr/lib/softhsm/libsofthsm2.so
 *        FABRIC_HSM_LABEL=patientchain   FABRIC_HSM_PIN=...   FABRIC_HSM_KEY_ID=<CKA_ID>
 *   2. FABRIC_KEY_PATH=<one PEM file>, readable only by the service user;
 *   3. FABRIC_KEY_DIR (the cryptogen layout, for the local network).
 *
 * Certificate rotation: replace the files and send SIGHUP; reconnect()
 * re-reads the TLS root, certificate and key without a restart.
 */
class FabricLedgerService {
  constructor(cfg) {
    this.cfg = cfg;
    this.gateway = null;
    this.contract = null;
  }

  async connect() {
    const client = new grpc.Client(this.cfg.peerEndpoint, grpc.credentials.createSsl(this._readTlsRoot()), {
      'grpc.ssl_target_name_override': this.cfg.peerHostAlias,
    });

    const identity = { mspId: this.cfg.mspId, credentials: this._readCert() };
    const signer = this._createSigner();
    this.client = client;

    this.gateway = connect({
      client,
      identity,
      signer,
      evaluateOptions: () => ({ deadline: Date.now() + 5000 }),
      endorseOptions: () => ({ deadline: Date.now() + 15000 }),
      submitOptions: () => ({ deadline: Date.now() + 5000 }),
      commitStatusOptions: () => ({ deadline: Date.now() + 60000 }),
    });

    const network = this.gateway.getNetwork(this.cfg.channelName);
    this.contract = network.getContract(this.cfg.chaincodeName);
    return this;
  }

  close() {
    this.gateway?.close();
    this.client?.close();
    this._closeSigner?.();
    this._hsmFactory?.dispose();
    this._hsmFactory = null;
  }

  /** Re-reads credentials (after certificate rotation) and reconnects. */
  async reconnect() {
    const old = { gateway: this.gateway, client: this.client, contract: this.contract, closeSigner: this._closeSigner, factory: this._hsmFactory };
    this._hsmFactory = null;
    try {
      await this.connect();
    } catch (err) {
      // Keep serving on the old connection.
      Object.assign(this, { gateway: old.gateway, client: old.client, contract: old.contract, _closeSigner: old.closeSigner, _hsmFactory: old.factory });
      throw err;
    }
    old.gateway?.close();
    old.client?.close();
    old.closeSigner?.();
    old.factory?.dispose();
    return this;
  }

  _createSigner() {
    const hsm = this.cfg.hsm;
    if (hsm && hsm.library) {
      this._hsmFactory = signers.newHSMSignerFactory(hsm.library);
      const { signer, close } = this._hsmFactory.newSigner({ label: hsm.label, pin: hsm.pin, identifier: hsm.keyId });
      this._closeSigner = close;
      return signer;
    }
    return signers.newPrivateKeySigner(this._readPrivateKey());
  }

  _readTlsRoot() {
    return fs.readFileSync(this.cfg.tlsCertPath);
  }

  _readCert() {
    return fs.readFileSync(this.cfg.certPath);
  }

  _readPrivateKey() {
    if (this.cfg.keyPath) {
      const mode = fs.statSync(this.cfg.keyPath).mode & 0o077;
      if (mode && process.env.NODE_ENV === 'production') {
        throw new Error(`${this.cfg.keyPath} is readable by group/others; chmod 0400 it`);
      }
      return crypto.createPrivateKey(fs.readFileSync(this.cfg.keyPath));
    }
    const keyDir = this.cfg.keyDir;
    const files = fs.readdirSync(keyDir);
    if (files.length === 0) throw new Error(`no private key found in ${keyDir}`);
    const keyPem = fs.readFileSync(`${keyDir}/${files[0]}`);
    return crypto.createPrivateKey(keyPem);
  }

  async _evaluate(contractName, fn, ...args) {
    const result = await this.contract.evaluateTransaction(`${contractName}:${fn}`, ...args);
    return this._parse(result);
  }

  async _submit(contractName, fn, ...args) {
    const result = await this.contract.submitTransaction(`${contractName}:${fn}`, ...args);
    return this._parse(result);
  }

  _parse(bytes) {
    const text = utf8Decoder.decode(bytes);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  // ---------- PatientRegistry ----------
  // The chaincode's write functions return only an error, so after each
  // submit (which waits for the block to commit) we read the committed
  // state back. That keeps the return values identical to the simulator's,
  // which the routes rely on.
  async registerPatient({ patientDID, publicKey }) {
    await this._submit('PatientRegistryContract', 'RegisterPatient', patientDID, publicKey || '');
    return this.getPatient(patientDID);
  }
  getPatient(patientDID) {
    return this._evaluate('PatientRegistryContract', 'GetPatient', patientDID);
  }
  async registerRecordReference({ refID, patientDID, hospitalID, recordType, date }) {
    await this._submit(
      'PatientRegistryContract',
      'RegisterRecordReference',
      refID,
      patientDID,
      hospitalID,
      recordType,
      date || new Date().toISOString()
    );
    const refs = (await this.getRecordReferencesForPatient(patientDID)) || [];
    return refs.find((r) => r.refID === refID) || null;
  }
  getRecordReferencesForPatient(patientDID) {
    return this._evaluate('PatientRegistryContract', 'GetRecordReferencesForPatient', patientDID);
  }

  // ---------- AccessControl ----------
  // scope is JSON-encoded because Fabric chaincode arguments are plain
  // strings; the chaincode decodes it back into []string (see
  // accesscontrol.go's RequestAccess).
  async requestAccess({ grantID, patientDID, providerID, hospitalID, scope, purpose }) {
    await this._submit(
      'AccessControlContract',
      'RequestAccess',
      grantID,
      patientDID,
      providerID,
      hospitalID,
      JSON.stringify(scope || []),
      purpose || 'Treatment'
    );
    return this.checkAccess({ grantID });
  }
  async grantAccess({ grantID, durationMinutes }) {
    await this._submit('AccessControlContract', 'GrantAccess', grantID, String(durationMinutes));
    return this.checkAccess({ grantID });
  }
  async revokeAccess({ grantID }) {
    await this._submit('AccessControlContract', 'RevokeAccess', grantID);
    return this.checkAccess({ grantID });
  }
  checkAccess({ grantID }) {
    return this._evaluate('AccessControlContract', 'CheckAccess', grantID);
  }
  getGrantsForPatient(patientDID) {
    return this._evaluate('AccessControlContract', 'GetGrantsForPatient', patientDID);
  }
  async breakGlassAccess({ grantID, patientDID, providerID, hospitalID, justification }) {
    await this._submit('AccessControlContract', 'BreakGlassAccess', grantID, patientDID, providerID, hospitalID, justification);
    return this.checkAccess({ grantID });
  }
  async reviewBreakGlass({ grantID, reviewerID, notes }) {
    await this._submit('AccessControlContract', 'ReviewBreakGlass', grantID, reviewerID, notes || '');
    return this.checkAccess({ grantID });
  }
  getPendingBreakGlassReviews() {
    return this._evaluate('AccessControlContract', 'GetPendingBreakGlassReviews');
  }

  // ---------- AuditLog ----------
  writeAuditEntry({ entryID, patientDID, eventType, actorID, hospitalID, detail, clientTimestamp, queuedOffline }) {
    return this._submit(
      'AuditLogContract',
      'WriteAuditEntry',
      // Callers (routes, offline reconcile) don't supply an ID; the
      // simulator mints one, so the Fabric path must too or every audit
      // write after the first collides on the same key.
      entryID || crypto.randomUUID(),
      patientDID,
      eventType,
      actorID,
      hospitalID,
      detail || '',
      clientTimestamp || '',
      String(!!queuedOffline)
    );
  }
  getAuditTrailForPatient(patientDID) {
    return this._evaluate('AuditLogContract', 'GetAuditTrailForPatient', patientDID);
  }

  // ---------- CostMetrics ----------
  async getCounters() {
    return this._evaluate('CostMetricsContract', 'GetCounters');
  }

  // Fabric has no polling-friendly "recent events" query out of the box;
  // a production build would use the Gateway's chaincode event stream
  // (contract.network.getChaincodeEvents) and buffer it server-side. Not
  // implemented in this MVP backend -- see docs/ARCHITECTURE.md.
  getRecentEvents() {
    return [];
  }
}

module.exports = { FabricLedgerService };
