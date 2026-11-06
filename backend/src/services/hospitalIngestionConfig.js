'use strict';

const fs = require('fs');
const path = require('path');

/**
 * hospitalIngestionConfig.js
 *
 * Item 4 of the HL7 ingestion task: "whichever path (FHIR/REST or HL7 v2)
 * a given hospital's integration uses should be configurable per
 * facility." This is that configuration -- a flat JSON file (see
 * config/hospitalIngestion.example.json) mapping each hospitalID to the
 * ingestion mode it actually speaks. It's read once at startup, not
 * validated against any live connection -- it's a declaration, not a
 * health check.
 *
 * Copy config/hospitalIngestion.example.json to
 * config/hospitalIngestion.json (gitignored, like .env) and fill in real
 * facilities as you onboard them. Missing the file entirely is normal
 * during local dev / the demo network -- it just means no hospital is
 * configured for HL7 ingestion yet, and server.js won't start any MLLP
 * listeners.
 */
function loadHospitalIngestionConfig(configPath) {
  const resolved = configPath || process.env.HOSPITAL_INGESTION_CONFIG || path.join(__dirname, '..', '..', 'config', 'hospitalIngestion.json');
  if (!fs.existsSync(resolved)) return {};
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    console.warn(`[hospitalIngestionConfig] failed to parse ${resolved}: ${err.message} -- treating as empty`);
    return {};
  }
}

module.exports = { loadHospitalIngestionConfig };
