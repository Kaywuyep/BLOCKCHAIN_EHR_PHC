'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const { getLedgerService } = require('./services/ledgerService');
const { fhirAdapter } = require('./services/fhirAdapter');
const { LinkageService } = require('./services/linkageService');
const { providerRegistry } = require('./services/providerRegistry');
const { OfflineQueue } = require('./sync/offlineQueue');
const { startMllpListener } = require('./services/hl7AdtListener');
const { loadHospitalIngestionConfig } = require('./services/hospitalIngestionConfig');

const { patientsRouter } = require('./routes/patients');
const { providersRouter } = require('./routes/providers');
const { accessRouter } = require('./routes/access');
const { recordsRouter } = require('./routes/records');
const { auditRouter } = require('./routes/audit');
const { costRouter } = require('./routes/cost');
const { syncRouter } = require('./routes/sync');
const { hl7Router } = require('./routes/hl7');
const { hospitalsRouter } = require('./routes/hospitals');
const {
  configureHospital,
  markDisabled,
  markListening,
  markError,
  recordMessage,
} = require('./services/hospitalStatus');

const app = express();
app.use(cors());
app.use(express.json());

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const serverStartedAt = Date.now();
const ledgerPromise = getLedgerService();
const offlineQueue = new OfflineQueue();
const linkageService = new LinkageService(fhirAdapter);

// Opt-in: only starts MLLP listeners for hospitals actually configured
// for HL7 ingestion (config/hospitalIngestion.json, see
// config/hospitalIngestion.example.json) and only when explicitly
// enabled -- the demo network and most local dev runs use neither, and
// should never try to bind TCP ports nobody asked for.
const ingestionConfig = loadHospitalIngestionConfig();
const hl7MllpEnabled = (process.env.HL7_MLLP_ENABLED || '').toLowerCase() === 'true';
for (const [hospitalID, cfg] of Object.entries(ingestionConfig)) {
  configureHospital({ hospitalID, ...cfg });
  if (cfg.mode !== 'hl7' || !cfg.mllpPort) {
    markDisabled(hospitalID, 'not configured for HL7/MLLP');
    continue;
  }
  if (!hl7MllpEnabled) {
    markDisabled(hospitalID, 'HL7_MLLP_ENABLED is not true');
    continue;
  }
  startMllpListener({
    fhirAdapter,
    hospitalID,
    port: cfg.mllpPort,
    version: cfg.hl7Version || '2.5',
    onMessage: (result) => recordMessage(hospitalID, result),
    log: {
      log: (...args) => {
        markListening(hospitalID);
        console.log(...args);
      },
      warn: (...args) => {
        if (args.some((arg) => String(arg).includes('listener error'))) markError(hospitalID, args.at(-1));
        console.warn(...args);
      },
    },
  });
}

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

app.use('/api/patients', patientsRouter(ledgerPromise, fhirAdapter, linkageService));
app.use('/api/providers', providersRouter(providerRegistry));
app.use('/api/access', accessRouter(ledgerPromise, offlineQueue));
app.use('/api/records', recordsRouter(ledgerPromise, fhirAdapter, providerRegistry));
app.use('/api/audit', auditRouter(ledgerPromise));
app.use('/api/cost', costRouter(ledgerPromise, serverStartedAt));
app.use('/api/sync', syncRouter(ledgerPromise, offlineQueue));
app.use('/api/hl7', hl7Router(fhirAdapter));
app.use('/api/hospitals', hospitalsRouter());

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
