'use strict';

// testServer.js builds a fully wired PatientChain backend -- the same
// router set server.js mounts -- but backed by fresh, isolated service
// instances instead of the app's shared singletons, and listening on an
// ephemeral port instead of server.js's fixed PORT. This lets route tests
// exercise the real request/response cycle (routing, JSON parsing, status
// codes) against real service logic, without any cross-test state leakage
// or the side effects (demo seeding, a long-lived listener) that requiring
// server.js directly would cause.

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const express = require('express');

const { SimulatedLedgerService } = require('../services/simulatedLedgerService');
const { FhirAdapter } = require('../services/fhirAdapter');
const { ProviderRegistry } = require('../services/providerRegistry');
const { LinkageService } = require('../services/linkageService');
const { OfflineQueue } = require('../sync/offlineQueue');

const { patientsRouter } = require('../routes/patients');
const { providersRouter } = require('../routes/providers');
const { accessRouter } = require('../routes/access');
const { recordsRouter } = require('../routes/records');
const { auditRouter } = require('../routes/audit');
const { costRouter } = require('../routes/cost');
const { syncRouter } = require('../routes/sync');
const { hl7Router } = require('../routes/hl7');

async function createTestServer() {
  const ledger = new SimulatedLedgerService();
  const fhirAdapter = new FhirAdapter();
  const providerRegistry = new ProviderRegistry();
  const linkageService = new LinkageService(fhirAdapter);
  const dbPath = path.join(os.tmpdir(), `patientchain-test-queue-${randomUUID()}.sqlite`);
  const offlineQueue = new OfflineQueue(dbPath);
  const ledgerPromise = Promise.resolve(ledger);

  const app = express();
  app.use(express.json());
  app.use('/api/patients', patientsRouter(ledgerPromise, fhirAdapter, linkageService));
  app.use('/api/providers', providersRouter(providerRegistry));
  app.use('/api/access', accessRouter(ledgerPromise, offlineQueue));
  app.use('/api/records', recordsRouter(ledgerPromise, fhirAdapter, providerRegistry));
  app.use('/api/audit', auditRouter(ledgerPromise));
  app.use('/api/cost', costRouter(ledgerPromise, Date.now()));
  app.use('/api/sync', syncRouter(ledgerPromise, offlineQueue));
  app.use('/api/hl7', hl7Router(fhirAdapter));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    offlineQueue.db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  }

  return {
    baseUrl,
    close,
    ledger,
    fhirAdapter,
    providerRegistry,
    linkageService,
    offlineQueue,
  };
}

module.exports = { createTestServer };
