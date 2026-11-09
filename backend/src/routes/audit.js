'use strict';

const express = require('express');
const { ROLES, hasRole, isPatientSelf, isSystemAdmin, deny } = require('../auth/policy');

function auditRouter(ledgerPromise) {
  const router = express.Router();

  router.get('/patient/:did', async (req, res) => {
    if (!isPatientSelf(req.user, req.params.did) && !hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) {
      return deny(res);
    }
    try {
      const ledger = await ledgerPromise;
      const entries = await ledger.getAuditTrailForPatient(req.params.did);
      res.json(entries || []);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/events/recent', async (req, res) => {
    if (!hasRole(req.user, ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN)) return deny(res, 'requires role: hospital_admin');
    try {
      const ledger = await ledgerPromise;
      const events = (ledger.getRecentEvents ? await ledger.getRecentEvents(50) : []) || [];
      const own = req.user.superuser || isSystemAdmin(req.user);
      res.json(own ? events : events.filter((e) => !e.hospitalID || e.hospitalID === req.user.hospitalID));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { auditRouter };
