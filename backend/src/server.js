'use strict';

require('dotenv').config();
const fs = require('fs');
const http = require('http');
const https = require('https');

const { loadConfig, productionProblems } = require('./config');
const { logger } = require('./logger');
const { openDatabase } = require('./db/database');
const { FieldCipher } = require('./db/fieldCipher');
const { createAuth, IdentityStore } = require('./auth/auth');
const { createApp } = require('./app');
const { getLedgerService } = require('./services/ledgerService');
const { FhirAdapter } = require('./services/fhirAdapter');
const { LinkageService } = require('./services/linkageService');
const { ProviderRegistry } = require('./services/providerRegistry');
const { OfflineQueue } = require('./sync/offlineQueue');
const { Hl7Inbox } = require('./services/hl7Inbox');
const { loadHospitalIngestionConfig } = require('./services/hospitalIngestionConfig');
const { recordMessage } = require('./services/hospitalStatus');
const { HospitalRegistry } = require('./services/hospitalRegistry');
const { ReferenceService } = require('./services/referenceService');
const { UserDirectory } = require('./services/userDirectory');
const { Hl7ListenerManager } = require('./services/hl7ListenerManager');

const config = loadConfig();

const problems = productionProblems(config);
if (problems.length) {
  logger.error('refusing to start: configuration is not safe for NODE_ENV=production', { problems });
  process.exit(1);
}
if (!config.production) {
  logger.warn(`development mode: AUTH_MODE=${config.auth.mode}, LEDGER_MODE=${config.ledgerMode}. Not for real patient data.`);
}

// ── Durable, encrypted off-chain store ─────────────────────────────────
const db = openDatabase(config.dbPath);
let cipher;
if (config.encryptionKeys) {
  cipher = FieldCipher.fromSpec(config.encryptionKeys);
} else {
  cipher = FieldCipher.devKeyFile(config.dataDir);
  logger.warn('DATA_ENCRYPTION_KEYS not set: using a development key file in the data directory');
}

const startedAt = Date.now();
const ledgerPromise = getLedgerService();
const fhirAdapter = new FhirAdapter({ db, cipher });


const providerRegistry = new ProviderRegistry({ db });


const linkageService = new LinkageService(fhirAdapter);
const offlineQueue = new OfflineQueue(process.env.SYNC_QUEUE_DB_PATH || require('path').join(config.dataDir, 'sync-queue.sqlite'));
const identityStore = new IdentityStore(db);
const auth = createAuth(config.auth, { identityStore });

// ── Hospital registry + user directory ─────────────────────────────────
// Hospitals are managed in the System Admin UI. On first start the old
// config files (hospitalDirectory.json, hospitalIngestion.json) are
// imported once.
const hospitalRegistry = new HospitalRegistry({ db, cipher, production: config.production });
const imported = hospitalRegistry.importLegacyConfig({ ingestionConfig: loadHospitalIngestionConfig() });
if (imported) logger.info(`imported ${imported} hospital(s) from config files into the hospital registry`);
const userDirectory = new UserDirectory({ db });
// FR3: on-chain pointers registered at the point of care.
const referenceService = new ReferenceService({ ledgerPromise, fhirAdapter, logger }).attach();

// ── HL7 ingestion ───────────────────────────────────────────────────────
const inbox = new Hl7Inbox({
  db,
  cipher,
  fhirAdapter,
  // Read per message, so a field-mapping change in the UI applies at once.
  hospitalOptions: (hospitalID) => ({ fieldMap: hospitalRegistry.fieldMapFor(hospitalID) }),
  onResult: (hospitalID, result) => recordMessage(hospitalID, result),
  log: logger.child({ component: 'hl7' }).asConsole(),
  maxAttempts: config.hl7.maxAttempts,
  retryIntervalMs: config.hl7.retryIntervalMs,
});
inbox.start();

let mllpTls = null;
if (config.hl7.tlsCertPath && config.hl7.tlsKeyPath) {
  mllpTls = {
    cert: fs.readFileSync(config.hl7.tlsCertPath),
    key: fs.readFileSync(config.hl7.tlsKeyPath),
    ca: config.hl7.tlsClientCaPath ? fs.readFileSync(config.hl7.tlsClientCaPath) : undefined,
  };
}

// One MLLP listener per active HL7 hospital, only when HL7_MLLP_ENABLED=true.
// Hospitals added or edited in the admin UI are (re)started on save.
const listenerManager = new Hl7ListenerManager({
  registry: hospitalRegistry,
  inbox,
  mllpEnabled: config.hl7.mllpEnabled,
  tls: mllpTls,
  logger,
});
listenerManager.syncAll().catch((err) => logger.error('starting HL7 listeners failed', { err }));

// ── Demo data (development only; DEMO_SEED=off to disable) ─────────────
const demoEnabled = !config.production && (process.env.DEMO_SEED || 'on').toLowerCase() !== 'off';
if (demoEnabled) {
  const { runDemoSeed } = require('./demo/demoSeed');
  runDemoSeed({
    db, logger, ledgerPromise, fhirAdapter, providerRegistry, hospitalRegistry, userDirectory,
    identityStore, referenceService, listenerManager, inbox, cipher, port: config.port,
  }).catch((err) => logger.error('demo data failed to load', { err }));
}

// ── HTTP(S) ─────────────────────────────────────────────────────────────
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
  hospitalRegistry,
  userDirectory,
  listenerManager,
  referenceService,
  demoFhir: demoEnabled,
  cipher,
  startedAt,
});

const tlsEnabled = config.http.tlsCertPath && config.http.tlsKeyPath;
const server = tlsEnabled
  ? https.createServer(
      { cert: fs.readFileSync(config.http.tlsCertPath), key: fs.readFileSync(config.http.tlsKeyPath), minVersion: config.http.tlsMinVersion },
      app
    )
  : http.createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

ledgerPromise
  .then(() => {
    server.listen(config.port, () => {
      logger.info(`PatientChain backend listening on ${tlsEnabled ? 'https' : 'http'}://localhost:${config.port}`, {
        ledgerMode: config.ledgerMode,
        authMode: auth.mode,
      });
    });
  })
  .catch((err) => {
    logger.error('failed to initialise ledger service', { err });
    process.exit(1);
  });

// ── Graceful shutdown (SIGTERM from Docker/systemd/Kubernetes) ─────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down`);
  const force = setTimeout(() => {
    logger.error('graceful shutdown timed out, exiting');
    process.exit(1);
  }, 15_000);
  force.unref();
  server.close();
  inbox.stop();
  await listenerManager.closeAll();
  try {
    (await ledgerPromise).close?.();
  } catch {
    // ledger never connected
  }
  db.close();
  offlineQueue.db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('unhandled promise rejection', { err }));

module.exports = { app };
