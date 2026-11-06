'use strict';

const express = require('express');
const { getHospitalStatuses } = require('../services/hospitalStatus');

function hospitalsRouter() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    res.json(getHospitalStatuses());
  });

  return router;
}

module.exports = { hospitalsRouter };
