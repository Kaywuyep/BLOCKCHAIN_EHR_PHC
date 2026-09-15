'use strict';

const express = require('express');

function syncRouter(ledgerPromise, offlineQueue) {
  const router = express.Router();

  // GET status
  router.get('/status', (req, res) => {
    res.json({
      connected: offlineQueue.isConnected(),
      retryIntervalMs: offlineQueue.retryIntervalMs,
      queuedCount: offlineQueue.getQueued().length,
    });
  });

  // POST toggle -- lets the demo simulate a facility going offline
  // (Section 3.6). When flipped back to connected, queued actions are
  // reconciled immediately, matching Figure 5's "Connectivity Restored ->
  // Sync Engine Fires" step.
  router.post('/connectivity', async (req, res) => {
    const { connected } = req.body;
    const ledger = await ledgerPromise;
    let reconcileResults = [];

    offlineQueue.setConnected(!!connected, () => {
      // fire-and-await via a wrapped async call below
    });

    if (connected) {
      reconcileResults = await offlineQueue.reconcile(ledger);
    }

    res.json({
      connected: offlineQueue.isConnected(),
      reconciled: reconcileResults,
    });
  });

  router.get('/queue', (req, res) => {
    res.json(offlineQueue.getAll());
  });

  return router;
}

module.exports = { syncRouter };
