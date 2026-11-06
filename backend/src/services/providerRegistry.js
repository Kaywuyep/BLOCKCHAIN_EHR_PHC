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
class ProviderRegistry {
  constructor() {
    // `${hospitalID}::${providerID}` -> provider record
    this.providers = new Map();
  }

  static key(hospitalID, providerID) {
    return `${hospitalID}::${providerID}`;
  }

  register({ providerID, hospitalID, name, role, department, status }) {
    if (!providerID || !hospitalID) {
      throw new Error('providerID and hospitalID are required');
    }
    const provider = {
      providerID,
      hospitalID,
      name: name || providerID,
      role: role || 'Physician',
      department: department || 'General',
      status: status || 'ACTIVE',
      registeredAt: new Date().toISOString(),
    };
    this.providers.set(ProviderRegistry.key(hospitalID, providerID), provider);
    return provider;
  }

  get(providerID, hospitalID) {
    return this.providers.get(ProviderRegistry.key(hospitalID, providerID)) || null;
  }

  getForHospital(hospitalID) {
    return Array.from(this.providers.values()).filter((p) => p.hospitalID === hospitalID);
  }

  /** Layer-2 check: is this provider currently active staff at this hospital? */
  isAuthorized(providerID, hospitalID) {
    const provider = this.get(providerID, hospitalID);
    return Boolean(provider && provider.status === 'ACTIVE');
  }
}

// Singleton -- starts with no providers registered. Register real staff via
// POST /api/providers/register (see routes/providers.js).
const providerRegistry = new ProviderRegistry();

module.exports = { ProviderRegistry, providerRegistry };
