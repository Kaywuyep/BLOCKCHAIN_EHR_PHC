'use strict';

/**
 * providerRegistry.js
 *
 * The "Level 2 -- Hospital RBAC" layer from docs/design.md Section 16 and
 * Section 35.1: a patient's blockchain grant says a *hospital or provider*
 * may be authorized, but each hospital independently decides which of its
 * own staff may actually exercise that permission. This registry is
 * deliberately off-chain and per-hospital, the same way fhirAdapter.js's
 * hospital databases are -- it is *not* a blockchain asset, because the
 * design explicitly treats hospital-internal RBAC as the hospital's own
 * responsibility, separate from PatientChain's authorization ledger.
 */
const { openDatabase } = require('../db/database');

const STATUSES = new Set(['ACTIVE', 'SUSPENDED', 'INACTIVE']);

class ProviderRegistry {
  /** @param {{ db?: import('better-sqlite3').Database }} [options] */
  constructor({ db } = {}) {
    this.db = db || openDatabase(':memory:');
    this.sql = {
      upsert: this.db.prepare(`INSERT INTO providers (hospital_id, provider_id, data, status, registered_at) VALUES (?, ?, ?, ?, ?)
                               ON CONFLICT (hospital_id, provider_id) DO UPDATE SET data = excluded.data, status = excluded.status`),
      get: this.db.prepare('SELECT data FROM providers WHERE hospital_id = ? AND provider_id = ?'),
      forHospital: this.db.prepare('SELECT data FROM providers WHERE hospital_id = ? ORDER BY provider_id'),
      byProvider: this.db.prepare('SELECT data FROM providers WHERE provider_id = ? ORDER BY registered_at'),
    };
  }

  register({ providerID, hospitalID, name, role, department, status }) {
    if (!providerID || !hospitalID) {
      throw new Error('providerID and hospitalID are required');
    }
    const normalizedStatus = (status || 'ACTIVE').toUpperCase();
    if (!STATUSES.has(normalizedStatus)) {
      throw new Error(`status must be one of ${[...STATUSES].join(', ')}`);
    }
    const existing = this.get(providerID, hospitalID);
    const provider = {
      providerID,
      hospitalID,
      name: name || providerID,
      role: role || 'Physician',
      department: department || 'General',
      status: normalizedStatus,
      registeredAt: existing?.registeredAt || new Date().toISOString(),
    };
    this.sql.upsert.run(hospitalID, providerID, JSON.stringify(provider), provider.status, provider.registeredAt);
    return provider;
  }

  get(providerID, hospitalID) {
    const row = this.sql.get.get(hospitalID, providerID);
    return row ? JSON.parse(row.data) : null;
  }

  /** Every hospital a provider ID is registered at. */
  registrationsOf(providerID) {
    return this.sql.byProvider.all(providerID).map((row) => JSON.parse(row.data));
  }

  getForHospital(hospitalID) {
    return this.sql.forHospital.all(hospitalID).map((row) => JSON.parse(row.data));
  }

  /** Layer-2 check: is this provider currently active staff at this hospital? */
  isAuthorized(providerID, hospitalID) {
    const provider = this.get(providerID, hospitalID);
    return Boolean(provider && provider.status === 'ACTIVE');
  }
}

module.exports = { ProviderRegistry };
