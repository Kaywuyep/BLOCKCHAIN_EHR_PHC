'use strict';

const express = require('express');
const { ROLES, requireRole } = require('../auth/policy');
const { getHospitalStatuses } = require('../services/hospitalStatus');

function hospitalsRouter() {
  const router = express.Router();

  router.get('/status', requireRole(ROLES.HOSPITAL_ADMIN, ROLES.SYSTEM_ADMIN), (req, res) => {
    res.json(getHospitalStatuses());
  });

  return router;
}

module.exports = { hospitalsRouter };
