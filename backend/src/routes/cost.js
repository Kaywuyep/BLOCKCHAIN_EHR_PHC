'use strict';

const express = require('express');
const { computeCostSummary, DEFAULT_PARAMS } = require('../services/costModel');
const { ROLES, requireRole } = require('../auth/policy');

function costRouter(ledgerPromise, serverStartedAt) {
  const router = express.Router();
  router.use(requireRole(ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN));

  // GET /api/cost/summary?b=10&k=2&Ce=12&Co=40&Cv=6
  // Returns everything the frontend's transaction-optimisation dashboard
  // needs: current counters, derived rates, Caction(b), the batching
  // diminishing-returns curve, and ledger growth vs the full-record-on-chain
  // baseline -- all per Section 3.5.2.
  router.get('/summary', async (req, res) => {
    try {
      const ledger = await ledgerPromise;
      const counters = await ledger.getCounters();
      const windowSeconds = Math.max(1, (Date.now() - serverStartedAt) / 1000);

      const params = { ...DEFAULT_PARAMS };
      for (const key of ['k', 'Ce', 'Co', 'Cv', 'b']) {
        if (req.query[key] === undefined) continue;
        const value = Number(req.query[key]);
        if (!Number.isFinite(value) || value < 0 || value > 1e6) {
          return res.status(400).json({ error: `${key} must be a number between 0 and 1000000` });
        }
        params[key] = value;
      }

      const summary = computeCostSummary({ counters, windowSeconds, params });
      res.json(summary);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { costRouter };
