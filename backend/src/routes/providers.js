'use strict';

const express = require('express');

// Exposes the off-chain, per-hospital provider/RBAC registry described in
// docs/design.md Section 16/35.1 ("Level 2 -- hospital authorization").
// Deliberately not backed by the ledger: each hospital is responsible for
// its own staff roster, independent of PatientChain's authorization layer.
function providersRouter(providerRegistry) {
  const router = express.Router();

  router.post('/register', (req, res) => {
    try {
      const provider = providerRegistry.register(req.body);
      res.status(201).json(provider);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/hospital/:hospitalID', (req, res) => {
    res.json(providerRegistry.getForHospital(req.params.hospitalID));
  });

  router.get('/:hospitalID/:providerID', (req, res) => {
    const provider = providerRegistry.get(req.params.providerID, req.params.hospitalID);
    if (!provider) return res.status(404).json({ error: 'provider not registered at this hospital' });
    res.json(provider);
  });

  return router;
}

module.exports = { providersRouter };
