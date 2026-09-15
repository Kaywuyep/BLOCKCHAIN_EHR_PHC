'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const { getLedgerService } = require('./services/ledgerService');
const { fhirAdapter, seedDemoData } = require('./services/fhirAdapter');
const { identityService } = require('./services/identityService');
const { providerRegistry, seedDemoProviders } = require('./services/providerRegistry');
const { OfflineQueue } = require('./sync/offlineQueue');

const { patientsRouter } = require('./routes/patients');
const { providersRouter } = require('./routes/providers');
const { accessRouter } = require('./routes/access');
const { recordsRouter } = require('./routes/records');
const { auditRouter } = require('./routes/audit');
const { costRouter } = require('./routes/cost');
const { syncRouter } = require('./routes/sync');

const app = express();
app.use(cors());
app.use(express.json());

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const serverStartedAt = Date.now();
const ledgerPromise = getLedgerService();
const offlineQueue = new OfflineQueue();

seedDemoData();
seedDemoProviders();

app.get('/api/health', async (req, res) => {
  try {
    const ledger = await ledgerPromise;
    res.json({
      status: 'ok',
      ledgerMode: (process.env.LEDGER_MODE || 'simulated').toLowerCase(),
      connectivity: offlineQueue.isConnected() ? 'online' : 'offline',
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.use('/api/patients', patientsRouter(ledgerPromise, fhirAdapter, identityService));
app.use('/api/providers', providersRouter(providerRegistry));
app.use('/api/access', accessRouter(ledgerPromise, offlineQueue));
app.use('/api/records', recordsRouter(ledgerPromise, fhirAdapter, providerRegistry));
app.use('/api/audit', auditRouter(ledgerPromise));
app.use('/api/cost', costRouter(ledgerPromise, serverStartedAt));
app.use('/api/sync', syncRouter(ledgerPromise, offlineQueue));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const PORT = process.env.PORT || 4000;

ledgerPromise
  .then(() => {
    app.listen(PORT, () => {
      console.log(`PatientChain backend listening on http://localhost:${PORT}`);
      console.log(`Ledger mode: ${(process.env.LEDGER_MODE || 'simulated').toUpperCase()}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialise ledger service:', err.message);
    process.exit(1);
  });

module.exports = { app };
