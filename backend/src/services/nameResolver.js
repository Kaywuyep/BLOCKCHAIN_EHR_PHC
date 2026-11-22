'use strict';

/**
 * nameResolver.js
 *
 * People's names for display and audit. The ledger and the access log only
 * hold opaque IDs (provider IDs, account subjects); every screen should
 * show the clinician's NAME instead (user decision, 2026-11-18: "the ID
 * can remain backend").
 *
 * enrich(body) walks an API answer and, next to every providerID / actorID
 * / reviewedBy / reviewerID / requestedBy it finds, adds providerName /
 * actorName / reviewedByName / reviewerName / requestedByName when the
 * name is known. IDs are left in place for the system to use. Names come
 * from Cevruni's own off-chain registers (clinicians as their hospital
 * registered them, user accounts) and are never written on-chain.
 *
 * Patient identifiers (DIDs, patient accounts) are deliberately NOT
 * resolved: a patient's name is not added to answers by this layer.
 */

const HOSPITAL_STAFF = 'hospital-staff@';
const FIELDS = [
  ['providerID', 'providerName'],
  ['actorID', 'actorName'],
  ['reviewedBy', 'reviewedByName'],
  ['reviewerID', 'reviewerName'],
  ['requestedBy', 'requestedByName'],
];
const MAX_NODES = 20000;

function createNameResolver({ providerRegistry = null, userDirectory = null, hospitalRegistry = null } = {}) {
  const hospitalName = (id) => {
    const h = id && hospitalRegistry ? hospitalRegistry.get(id) : null;
    return h ? h.name : id;
  };

  /** A clinician's or staff member's name, or null (patients are never resolved). */
  function nameOf(id, hospitalHint) {
    if (typeof id !== 'string' || !id) return null;
    if (id.startsWith(HOSPITAL_STAFF)) return `All clinicians at ${hospitalName(id.slice(HOSPITAL_STAFF.length))}`;
    if (id.startsWith('did:')) return null;
    if (providerRegistry) {
      const p = (hospitalHint && providerRegistry.get(id, hospitalHint)) || (providerRegistry.registrationsOf(id) || [])[0];
      if (p && p.name) return p.name;
    }
    if (userDirectory) {
      const a = userDirectory.getAccount(id);
      if (a) {
        const roles = Array.isArray(a.roles) ? a.roles : String(a.roles || '').split(',');
        if (roles.includes('patient') && roles.length === 1) return null;
        if (a.providerID && providerRegistry) {
          const p = providerRegistry.get(a.providerID, a.hospitalID) || (providerRegistry.registrationsOf(a.providerID) || [])[0];
          if (p && p.name) return p.name;
        }
        if (a.displayName) return a.displayName;
      }
    }
    if (id === 'superadmin') return 'System admin';
    return null;
  }

  /** Adds names next to IDs throughout an API answer (new object; IDs kept). */
  function enrich(body) {
    const cache = new Map();
    let nodes = 0;
    const lookup = (id, hint) => {
      const key = `${id}|${hint || ''}`;
      if (!cache.has(key)) {
        let n = null;
        try {
          n = nameOf(id, hint);
        } catch {
          n = null;
        }
        cache.set(key, n);
      }
      return cache.get(key);
    };
    const walk = (v, depth) => {
      if (v == null || typeof v !== 'object' || depth > 8 || nodes > MAX_NODES) return v;
      nodes += 1;
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      if (Buffer.isBuffer(v) || v instanceof Date) return v;
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = x && typeof x === 'object' ? walk(x, depth + 1) : x;
      const hint = v.requesterHospitalID || v.hospitalID || null;
      for (const [idKey, nameKey] of [['hospitalID', 'hospitalName'], ['requesterHospitalID', 'requesterHospitalName']]) {
        if (typeof v[idKey] === 'string' && out[nameKey] == null && hospitalRegistry) {
          const hk = `hospital|${v[idKey]}`;
          if (!cache.has(hk)) {
            const h = hospitalRegistry.get(v[idKey]);
            cache.set(hk, h && h.name ? h.name : null);
          }
          if (cache.get(hk)) out[nameKey] = cache.get(hk);
        }
      }
      for (const [idKey, nameKey] of FIELDS) {
        if (typeof v[idKey] === 'string' && out[nameKey] == null) {
          const n = lookup(v[idKey], hint);
          if (n) out[nameKey] = n;
        }
      }
      return out;
    };
    try {
      return walk(body, 0);
    } catch {
      return body;
    }
  }

  return { nameOf, enrich };
}

module.exports = { createNameResolver };
