'use strict';

const fs = require('fs');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const protos = require('@hyperledger/fabric-protos');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const utf8Decoder = new TextDecoder();

// How many recent blocks to replay into the event feed at start-up.
const EVENT_REPLAY_BLOCKS = BigInt(process.env.FABRIC_EVENT_REPLAY_BLOCKS || 1000);

/**
 * When a replayed event happened. Chaincode events carry no block time, so
 * use the latest time recorded in the payload itself (grant or audit entry),
 * ignoring expiresAt, which is in the future.
 */
function eventTime(payload) {
  if (!payload || typeof payload !== 'object') return null;
  let latest = null;
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'expiresAt' || typeof v !== 'string' || !/(At|timestamp|Timestamp)$/.test(k)) continue;
    const t = Date.parse(v);
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/**
 * A chaincode rejection reaches the Gateway client as a gRPC error such as
 * "10 ABORTED: failed to endorse transaction", with the chaincode's own
 * message ("chaincode response 500, grant X has already been reviewed")
 * only in err.details. Surface that message, as the simulated ledger does,
 * so the API returns a readable 400 instead of a gRPC status line.
 * Network, timeout and commit errors are returned unchanged.
 */
function chaincodeError(err) {
  const texts = [...(Array.isArray(err && err.details) ? err.details.map((d) => d && d.message) : []), err && err.message];
  for (const text of texts) {
    const m = typeof text === 'string' && text.match(/chaincode response \d+, ([\s\S]+)$/);
    if (m) {
      const e = new Error(m[1].trim());
      e.cause = err;
      e.code = err.code;
      return e;
    }
  }
  return err;
}

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
    // Chaincode events, pushed to subscribers (the SSE stream) and kept in
    // a small buffer for the admin "recent events" list.
    this.eventLog = [];
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
  }

  onEvent(listener) {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
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
    this.network = network;
    this._listenForEvents(network);
    return this;
  }

  /**
   * Event-driven updates (Section 3.4.4): subscribes to the chaincode's own
   * events (AccessRequested, AccessGranted, AccessRevoked, BreakGlass...,
   * AuditEntryWritten) through the Gateway instead of polling the ledger.
   *
   * On start it replays the most recent blocks (EVENT_REPLAY_BLOCKS) so the
   * "Ledger Events" feed shows history after a restart; replayed events
   * fill the log but are not pushed to live subscribers. If the stream
   * drops it reconnects with a short backoff and resumes from the last
   * block seen, skipping transactions it already has, so nothing is lost.
   */
  async _listenForEvents(network) {
    this._eventsClosed = false;
    let backoff = 1000;
    const height = await this._chainHeight(network).catch(() => null);
    let resumeFrom = height === null ? undefined : (height > EVENT_REPLAY_BLOCKS ? height - EVENT_REPLAY_BLOCKS : 0n);
    const seen = new Set(this.eventLog.map((e) => e.txID));
    let lastReplayTime = null;
    while (!this._eventsClosed && this.network === network) {
      try {
        this._eventStream = await network.getChaincodeEvents(
          this.cfg.chaincodeName,
          resumeFrom === undefined ? undefined : { startBlock: resumeFrom }
        );
        backoff = 1000;
        for await (const ev of this._eventStream) {
          resumeFrom = ev.blockNumber;
          if (seen.has(ev.transactionId)) continue;
          seen.add(ev.transactionId);
          if (seen.size > 5000) seen.delete(seen.values().next().value);
          let payload = null;
          try {
            payload = JSON.parse(utf8Decoder.decode(ev.payload));
          } catch {
            payload = null;
          }
          const replayed = height !== null && ev.blockNumber < height;
          // A replayed event with no time of its own (e.g. a record pointer)
          // takes the time of the event before it in block order.
          if (replayed) lastReplayTime = eventTime(payload) || lastReplayTime;
          const evt = {
            type: ev.eventName,
            payload,
            timestamp: (replayed && lastReplayTime) || new Date().toISOString(),
            txID: ev.transactionId,
            block: String(ev.blockNumber),
          };
          this.eventLog.push(evt);
          if (this.eventLog.length > 500) this.eventLog.shift();
          if (!replayed) this.events.emit('event', evt);
        }
      } catch (err) {
        if (this._eventsClosed) return;
        this.events.emit('stream-error', err);
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }

  /** Current block height of the channel, from the qscc system chaincode. */
  async _chainHeight(network) {
    const bytes = await network.getContract('qscc').evaluateTransaction('GetChainInfo', this.cfg.channelName);
    const info = protos.common.BlockchainInfo.deserializeBinary(bytes);
    return BigInt(info.getHeight());
  }

  close() {
    this._eventsClosed = true;
    this._eventStream?.close?.();
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
    try {
      const result = await this.contract.evaluateTransaction(`${contractName}:${fn}`, ...args);
      return this._parse(result);
    } catch (err) {
      throw chaincodeError(err);
    }
  }

  async _submit(contractName, fn, ...args) {
    try {
      const result = await this.contract.submitTransaction(`${contractName}:${fn}`, ...args);
      return this._parse(result);
    } catch (err) {
      throw chaincodeError(err);
    }
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
  async requestAccess({ grantID, patientDID, providerID, hospitalID, scope, purpose, providerRole, requesterHospitalID }) {
    await this._submit(
      'AccessControlContract',
      'RequestAccess',
      grantID,
      patientDID,
      providerID,
      hospitalID,
      JSON.stringify(scope || []),
      purpose || 'Treatment',
      providerRole || '',
      requesterHospitalID || ''
    );
    return this.checkAccess({ grantID });
  }
  async grantAccess({ grantID, durationMinutes, signature }) {
    await this._submit('AccessControlContract', 'GrantAccess', grantID, String(durationMinutes), signature || '');
    return this.checkAccess({ grantID });
  }
  /** Several approvals in ONE transaction (Section 3.4.4). */
  async grantAccessBatch(items) {
    const clean = items.map(({ grantID, durationMinutes, signature }) => ({ grantID, durationMinutes, signature: signature || '' }));
    await this._submit('AccessControlContract', 'GrantAccessBatch', JSON.stringify(clean));
    return Promise.all(clean.map(({ grantID }) => this.checkAccess({ grantID })));
  }
  async revokeAccess({ grantID, signature }) {
    await this._submit('AccessControlContract', 'RevokeAccess', grantID, signature || '');
    return this.checkAccess({ grantID });
  }
  async getGrantsForProvider(providerID) {
    return (await this._evaluate('AccessControlContract', 'GetGrantsForProvider', providerID)) || [];
  }
  async getGrantsForHospital(hospitalID) {
    return (await this._evaluate('AccessControlContract', 'GetGrantsForHospital', hospitalID)) || [];
  }
  checkAccess({ grantID }) {
    return this._evaluate('AccessControlContract', 'CheckAccess', grantID);
  }
  getGrantsForPatient(patientDID) {
    return this._evaluate('AccessControlContract', 'GetGrantsForPatient', patientDID);
  }
  async breakGlassAccess({ grantID, patientDID, providerID, hospitalID, requesterHospitalID, justification, representativeHash }) {
    await this._submit('AccessControlContract', 'BreakGlassAccess', grantID, patientDID, providerID, hospitalID, requesterHospitalID || '', justification, representativeHash || '');
    return this.checkAccess({ grantID });
  }
  async extendBreakGlass({ grantID, providerID, reason, minutes }) {
    await this._submit('AccessControlContract', 'ExtendBreakGlass', grantID, providerID, reason, String(minutes));
    return this.checkAccess({ grantID });
  }
  async getGrantsByRequesterHospital(hospitalID) {
    return (await this._evaluate('AccessControlContract', 'GetGrantsByRequesterHospital', hospitalID)) || [];
  }
  async getAuditTrailForActor(actorID) {
    return (await this._evaluate('AuditLogContract', 'GetAuditTrailForActor', actorID)) || [];
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
  async getAuditTrailForHospital(hospitalID) {
    return (await this._evaluate('AuditLogContract', 'GetAuditTrailForHospital', hospitalID)) || [];
  }

  // ---------- CostMetrics ----------
  async getCounters() {
    return this._evaluate('CostMetricsContract', 'GetCounters');
  }

  /** Most recent chaincode events first, from the live event stream. */
  getRecentEvents(limit = 50) {
    return this.eventLog.slice(-limit).reverse();
  }
}

module.exports = { FabricLedgerService, chaincodeError, eventTime };
