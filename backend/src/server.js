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
const { startMllpListener, resolveFieldMap } = require('./services/hl7AdtListener');
const { loadHospitalIngestionConfig } = require('./services/hospitalIngestionConfig');
const { configureHospital, markDisabled, markListening, markError, recordMessage } = require('./services/hospitalStatus');

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

// ── HL7 ingestion ───────────────────────────────────────────────────────
const ingestionConfig = loadHospitalIngestionConfig();
for (const [hospitalID, cfg] of Object.entries(ingestionConfig)) {
  if (hospitalID.startsWith('_')) continue;
  if (cfg.fieldMap) resolveFieldMap(cfg.fieldMap); // fail fast on a bad mapping
}

const inbox = new Hl7Inbox({
  db,
  cipher,
  fhirAdapter,
  hospitalOptions: (hospitalID) => ({ fieldMap: ingestionConfig[hospitalID]?.fieldMap }),
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

const mllpListeners = [];
// Opt-in: only starts MLLP listeners for hospitals actually configured for
// HL7 ingestion (config/hospitalIngestion.json) and only when explicitly
// enabled -- local dev runs should never bind TCP ports nobody asked for.
for (const [hospitalID, cfg] of Object.entries(ingestionConfig)) {
  if (hospitalID.startsWith('_')) continue;
  configureHospital({ hospitalID, ...cfg });
  if (cfg.mode !== 'hl7' || !cfg.mllpPort) {
    markDisabled(hospitalID, 'not configured for HL7/MLLP');
    continue;
  }
  if (!config.hl7.mllpEnabled) {
    markDisabled(hospitalID, 'HL7_MLLP_ENABLED is not true');
    continue;
  }
  const hl7Log = logger.child({ component: 'mllp', hospitalID });
  const listener = startMllpListener({
    inbox,
    hospitalID,
    port: cfg.mllpPort,
    version: cfg.hl7Version || '2.5',
    tls: mllpTls,
    allowedIps: cfg.allowedIps || [],
    bindAddress: cfg.bindAddress,
    log: {
      log: (...args) => {
        markListening(hospitalID);
        hl7Log.info(args.join(' '));
      },
      warn: (...args) => {
        if (args.some((arg) => String(arg).includes('listener error'))) markError(hospitalID, args.at(-1));
        hl7Log.warn(args.join(' '));
      },
    },
  });
  mllpListeners.push(listener);
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
  startedAt,
});

const tlsEnabled = config.http.tlsCertPath && config.http.tlsKeyPath;
const server = tlsEnabled
  ? https.createServer(
      { cert: fs.readFileSync(config.http.tlsCertPath), key: fs.readFileSync(config.http.tlsKeyPath), minVersion: 'TLSv1.2' },
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
  await Promise.allSettled(mllpListeners.map((l) => l.close()));
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
