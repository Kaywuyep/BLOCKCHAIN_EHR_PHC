'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { ROLES, requireRole } = require('../auth/policy');
const { getHospitalStatuses } = require('../services/hospitalStatus');

// Load hospital directory once at startup
let hospitalDirectory = [];
try {
  const dirPath = path.join(__dirname, '..', '..', 'config', 'hospitalDirectory.json');
  hospitalDirectory = JSON.parse(fs.readFileSync(dirPath, 'utf8'));
} catch {
  // No directory file — empty list
}

function hospitalsRouter(registry = null) {
  const router = express.Router();

  // Directory for patients and clinicians: active hospitals, by name,
  // location or type. Comes from the registry managed in the System Admin
  // UI; the JSON file is only the fallback when there is no registry.
  router.get('/directory', (req, res) => {
    if (registry) return res.json(registry.directory({ q: String(req.query.q || '') }));
    const q = (req.query.q || '').toLowerCase().trim();
    const results = q
      ? hospitalDirectory.filter(
          (h) =>
            h.name.toLowerCase().includes(q) ||
            h.location.toLowerCase().includes(q) ||
            h.type.toLowerCase().includes(q)
        )
      : hospitalDirectory;
    res.json(results);
  });

  router.get('/status', requireRole(ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN), (req, res) => {
    res.json(getHospitalStatuses());
  });

  return router;
}

module.exports = { hospitalsRouter };
