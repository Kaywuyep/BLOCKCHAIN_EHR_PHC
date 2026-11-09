'use strict';

// testServer.js builds a fully wired PatientChain backend through the same
// createApp() factory server.js uses -- same middleware, same routers --
// but backed by fresh, isolated service instances (in-memory SQLite) and
// listening on an ephemeral port. Route tests exercise the real
// request/response cycle without cross-test state leakage.
//
// By default auth is off (every request is a superuser), which is what the
// functional route tests want. Pass { authMode: 'local' } to test
// authentication and authorization; `login()` then mints tokens.

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const { loadConfig } = require('../config');
const { createLogger } = require('../logger');
const { openDatabase } = require('../db/database');
const { FieldCipher } = require('../db/fieldCipher');
const { createAuth, IdentityStore } = require('../auth/auth');
const { createApp } = require('../app');
const { SimulatedLedgerService } = require('../services/simulatedLedgerService');
const { FhirAdapter } = require('../services/fhirAdapter');
const { ProviderRegistry } = require('../services/providerRegistry');
const { LinkageService } = require('../services/linkageService');
const { OfflineQueue } = require('../sync/offlineQueue');
const { Hl7Inbox } = require('../services/hl7Inbox');

async function createTestServer({ authMode = 'off', env = {}, withInbox = true } = {}) {
  const config = loadConfig({
    AUTH_MODE: authMode,
    AUTH_JWT_SECRET: 'test-secret-test-secret-test-secret-1234',
    RATE_LIMIT_PER_MINUTE: '0',
    ...env,
  });
  const logger = createLogger({ level: 'error', write: () => {} });
  const db = openDatabase(':memory:');
  const cipher = FieldCipher.ephemeral();

  const ledger = new SimulatedLedgerService();
  const fhirAdapter = new FhirAdapter({ db, cipher });
  const providerRegistry = new ProviderRegistry({ db });
  const linkageService = new LinkageService(fhirAdapter);
  const identityStore = new IdentityStore(db);
  const auth = createAuth(config.auth, { identityStore });
  const dbPath = path.join(os.tmpdir(), `patientchain-test-queue-${randomUUID()}.sqlite`);
  const offlineQueue = new OfflineQueue(dbPath);
  const ledgerPromise = Promise.resolve(ledger);
  const inbox = withInbox
    ? new Hl7Inbox({ db, cipher, fhirAdapter, log: { log() {}, warn() {}, error() {} }, retryIntervalMs: 10 })
    : null;

  const app = createApp({
    config,
    logger,
    auth,
    ledgerPromise,
    fhirAdapter,
    providerRegistry,
    linkageService,
    offlineQueue,
    inbox,
    identityStore,
    db,
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  /** Mints a local-mode token: login({ subject, role, hospitalID, providerID }). */
  async function login(identity) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(identity),
    });
    if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
    return (await res.json()).token;
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    offlineQueue.db.close();
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  }

  return {
    baseUrl,
    close,
    login,
    ledger,
    fhirAdapter,
    providerRegistry,
    linkageService,
    offlineQueue,
    inbox,
    identityStore,
  };
}

module.exports = { createTestServer };
