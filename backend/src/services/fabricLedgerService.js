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
    const signer = signers.newPrivateKeySigner(this._readPrivateKey());

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
  }

  _readTlsRoot() {
    return fs.readFileSync(this.cfg.tlsCertPath);
  }

  _readCert() {
    return fs.readFileSync(this.cfg.certPath);
  }

  _readPrivateKey() {
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
  registerPatient({ patientDID, publicKey }) {
    return this._submit('PatientRegistryContract', 'RegisterPatient', patientDID, publicKey || '');
  }
  getPatient(patientDID) {
    return this._evaluate('PatientRegistryContract', 'GetPatient', patientDID);
  }
  registerRecordReference({ refID, patientDID, hospitalID, recordType, date }) {
    return this._submit(
      'PatientRegistryContract',
      'RegisterRecordReference',
      refID,
      patientDID,
      hospitalID,
      recordType,
      date || new Date().toISOString()
    );
  }
  getRecordReferencesForPatient(patientDID) {
    return this._evaluate('PatientRegistryContract', 'GetRecordReferencesForPatient', patientDID);
  }

  // ---------- AccessControl ----------
  // scope is JSON-encoded because Fabric chaincode arguments are plain
  // strings; the chaincode decodes it back into []string (see
  // accesscontrol.go's RequestAccess).
  requestAccess({ grantID, patientDID, providerID, hospitalID, scope, purpose }) {
    return this._submit(
      'AccessControlContract',
      'RequestAccess',
      grantID,
      patientDID,
      providerID,
      hospitalID,
      JSON.stringify(scope || []),
      purpose || 'Treatment'
    );
  }
  grantAccess({ grantID, durationMinutes }) {
    return this._submit('AccessControlContract', 'GrantAccess', grantID, String(durationMinutes));
  }
  revokeAccess({ grantID }) {
    return this._submit('AccessControlContract', 'RevokeAccess', grantID);
  }
  checkAccess({ grantID }) {
    return this._evaluate('AccessControlContract', 'CheckAccess', grantID);
  }
  getGrantsForPatient(patientDID) {
    return this._evaluate('AccessControlContract', 'GetGrantsForPatient', patientDID);
  }
  breakGlassAccess({ grantID, patientDID, providerID, hospitalID, justification }) {
    return this._submit('AccessControlContract', 'BreakGlassAccess', grantID, patientDID, providerID, hospitalID, justification);
  }
  reviewBreakGlass({ grantID, reviewerID, notes }) {
    return this._submit('AccessControlContract', 'ReviewBreakGlass', grantID, reviewerID, notes || '');
  }
  getPendingBreakGlassReviews() {
    return this._evaluate('AccessControlContract', 'GetPendingBreakGlassReviews');
  }

  // ---------- AuditLog ----------
  writeAuditEntry({ entryID, patientDID, eventType, actorID, hospitalID, detail, clientTimestamp, queuedOffline }) {
    return this._submit(
      'AuditLogContract',
      'WriteAuditEntry',
      entryID,
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
