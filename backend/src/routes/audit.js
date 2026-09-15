'use strict';

const express = require('express');

function auditRouter(ledgerPromise) {
  const router = express.Router();

  router.get('/patient/:did', async (req, res) => {
    try {
      const ledger = await ledgerPromise;
      const entries = await ledger.getAuditTrailForPatient(req.params.did);
      res.json(entries || []);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/events/recent', async (req, res) => {
    try {
      const ledger = await ledgerPromise;
      const events = ledger.getRecentEvents ? ledger.getRecentEvents(50) : [];
      res.json(events);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { auditRouter };
