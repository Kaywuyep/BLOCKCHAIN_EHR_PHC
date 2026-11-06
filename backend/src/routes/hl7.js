'use strict';

const express = require('express');
const { ingestRawAdtText } = require('../services/hl7AdtListener');

// Exposes the HTTP side of the HL7 v2 ADT ingestion path
// (services/hl7AdtListener.js) -- the one you'll actually use for
// local/synthetic testing (see scripts/sendSyntheticAdt.js), and a
// realistic fallback for any real hospital whose integration engine can
// deliver ADT messages over HTTP instead of raw MLLP. The MLLP TCP path
// (services/hl7AdtListener.js's startMllpListener) is the one a real
// hospital's ADT feed more traditionally speaks; both converge on the
// exact same ingestParsedMessage() call underneath.
function hl7Router(fhirAdapter) {
  const router = express.Router();

  // Body must arrive as the raw HL7 v2 message text, not JSON -- send it
  // with `Content-Type: text/plain` (or any non-application/json type;
  // express.text({ type: '*/*' }) here accepts anything the server's
  // global express.json() didn't already claim).
  router.post('/adt/:hospitalID', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (typeof req.body !== 'string' || !req.body.trim()) {
      return res.status(400).json({ ok: false, reason: 'request body must be the raw HL7 v2 message text' });
    }
    const result = ingestRawAdtText(fhirAdapter, req.params.hospitalID, req.body);
    res.status(result.ok ? 201 : 400).json(result);
  });

  return router;
}

module.exports = { hl7Router };
