'use strict';

const fs = require('fs');
const path = require('path');
const { resolveFieldMap } = require('./hl7AdtListener');

/**
 * hospitalRegistry.js
 *
 * The list of hospitals connected to the system, kept in SQLite and managed
 * from the System Admin UI (routes/admin.js). Each hospital declares how its
 * records reach us:
 *
 *   fhir    the hospital exposes a FHIR R4 REST API (SMART backend services);
 *   hl7     the hospital's interface engine sends HL7 v2 ADT messages, over
 *           MLLP (a TCP port we listen on) and/or HTTP POST /api/hl7/adt/:id;
 *   both    ADT feed for registrations/admissions + FHIR for clinical data;
 *   rest    neither FHIR nor HL7: the vendor or a database-export job
 *           pushes records to POST /api/ingest/:hospitalID (Section 3.4.8);
 *   manual  no live integration; staff keep the patient roster by hand.
 *
 * The FHIR client secret is stored encrypted and never returned by the API.
 *
 * On first start (empty table) the old hand-edited files are imported:
 * config/hospitalDirectory.json (names) and config/hospitalIngestion.json
 * (HL7 settings), so existing setups keep working.
 */

const INTEGRATIONS = ['fhir', 'hl7', 'both', 'rest', 'manual'];
const HOSPITAL_TYPES = [
  'Primary Health Centre',
  'General Hospital',
  'Specialist Hospital',
  'Teaching Hospital',
  'Faith-based Hospital',
  'Private Hospital',
  'Clinic',
];
const HL7_VERSIONS = ['2.3', '2.3.1', '2.4', '2.5', '2.5.1', '2.6', '2.7'];
const FHIR_AUTH_TYPES = ['client-secret', 'private-key-jwt', 'none'];
const DEFAULT_FHIR_SCOPE =
  'system/Patient.read system/Observation.read system/Encounter.read system/MedicationRequest.read system/Condition.read';
const MLLP_PORT_MIN = 1024;
const MLLP_PORT_MAX = 65535;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const IP_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** Suggests a hospitalID from a name: "General Hospital Pankshin" -> "general-hospital-pankshin". */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function isHttpUrl(value, { allowHttp }) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || (allowHttp && u.protocol === 'http:');
  } catch {
    return false;
  }
}

class HospitalRegistry {
  constructor({ db, cipher, production = false }) {
    this.db = db;
    this.cipher = cipher;
    this.production = production;
    const q = (sql) => db.prepare(sql);
    this.sql = {
      all: q('SELECT * FROM hospitals ORDER BY name COLLATE NOCASE'),
      get: q('SELECT * FROM hospitals WHERE hospital_id = ?'),
      count: q('SELECT COUNT(*) AS n FROM hospitals'),
      insert: q(`INSERT INTO hospitals
        (hospital_id, name, location, type, integration, fhir_json, fhir_secret_enc, hl7_json, status, created_at, updated_at, created_by)
        VALUES (@hospitalID, @name, @location, @type, @integration, @fhirJson, @fhirSecretEnc, @hl7Json, @status, @now, @now, @createdBy)`),
      update: q(`UPDATE hospitals SET name = @name, location = @location, type = @type, integration = @integration,
        fhir_json = @fhirJson, fhir_secret_enc = @fhirSecretEnc, hl7_json = @hl7Json, status = @status, updated_at = @now
        WHERE hospital_id = @hospitalID`),
    };
  }

  // ── Reads ────────────────────────────────────────────────────────────

  /** Full records, secrets decrypted. Internal use only (listeners, FHIR client). */
  getInternal(hospitalID) {
    const row = this.sql.get.get(hospitalID);
    return row ? this._fromRow(row, { withSecret: true }) : null;
  }

  /** Records safe to return to a system admin: no secret, only whether one is set. */
  list() {
    return this.sql.all.all().map((r) => this._fromRow(r));
  }

  get(hospitalID) {
    const row = this.sql.get.get(hospitalID);
    return row ? this._fromRow(row) : null;
  }

  /** What patients and clinicians may see: name and place, nothing technical. */
  directory({ q = '' } = {}) {
    const needle = q.toLowerCase().trim();
    return this.list()
      .filter((h) => h.status === 'active')
      .map(({ hospitalID, name, location, type }) => ({ hospitalID, name, location, type }))
      .filter(
        (h) =>
          !needle ||
          h.name.toLowerCase().includes(needle) ||
          h.location.toLowerCase().includes(needle) ||
          h.type.toLowerCase().includes(needle) ||
          h.hospitalID.includes(needle)
      );
  }

  /** HL7 settings for hospitals that should have an MLLP listener. */
  mllpHospitals() {
    return this.list().filter((h) => h.status === 'active' && h.hl7 && h.hl7.mllpEnabled && h.hl7.mllpPort);
  }

  fieldMapFor(hospitalID) {
    const h = this.get(hospitalID);
    return (h && h.hl7 && h.hl7.fieldMap) || undefined;
  }

  // ── Writes ───────────────────────────────────────────────────────────

  create(input, { createdBy } = {}) {
    const hospitalID = String(input.hospitalID || slugify(input.name)).trim();
    if (!ID_PATTERN.test(hospitalID)) {
      throw new ValidationError('hospitalID must be 3-64 characters: lower-case letters, digits and hyphens');
    }
    if (this.sql.get.get(hospitalID)) throw new ValidationError(`a hospital with ID "${hospitalID}" already exists`);
    const clean = this._validate({ ...input, hospitalID }, null);
    this.sql.insert.run({ ...clean, now: new Date().toISOString(), createdBy: createdBy || null });
    return this.get(hospitalID);
  }

  update(hospitalID, input) {
    const existingRow = this.sql.get.get(hospitalID);
    if (!existingRow) return null;
    const existing = this._fromRow(existingRow, { withSecret: true });
    const merged = {
      ...existing,
      ...input,
      hospitalID,
      fhir: input.fhir === undefined ? existing.fhir : input.fhir,
      hl7: input.hl7 === undefined ? existing.hl7 : input.hl7,
    };
    const clean = this._validate(merged, existing);
    this.sql.update.run({ ...clean, now: new Date().toISOString() });
    return this.get(hospitalID);
  }

  setStatus(hospitalID, status) {
    if (!['active', 'inactive'].includes(status)) throw new ValidationError('status must be active or inactive');
    return this.update(hospitalID, { status });
  }

  /** One-time import of the old JSON config files into an empty table. */
  importLegacyConfig({ directoryPath, ingestionConfig = {} } = {}) {
    if (this.sql.count.get().n > 0) return 0;
    let directory = [];
    const dirPath = directoryPath || path.join(__dirname, '..', '..', 'config', 'hospitalDirectory.json');
    try {
      directory = JSON.parse(fs.readFileSync(dirPath, 'utf8'));
    } catch {
      // no directory file
    }
    const byId = new Map(directory.map((h) => [h.hospitalID, { ...h }]));
    for (const [hospitalID, cfg] of Object.entries(ingestionConfig)) {
      if (hospitalID.startsWith('_') || hospitalID.startsWith('example-')) continue;
      const entry = byId.get(hospitalID) || { hospitalID, name: hospitalID, location: '', type: '' };
      entry.ingestion = cfg;
      byId.set(hospitalID, entry);
    }
    let imported = 0;
    for (const h of byId.values()) {
      const cfg = h.ingestion || {};
      const integration = cfg.mode === 'hl7' ? 'hl7' : cfg.mode === 'fhir-rest' ? 'fhir' : 'manual';
      try {
        this.create(
          {
            hospitalID: h.hospitalID,
            name: h.name,
            location: h.location,
            type: h.type,
            integration,
            hl7:
              integration === 'hl7'
                ? {
                    mllpEnabled: Boolean(cfg.mllpPort),
                    mllpPort: cfg.mllpPort,
                    hl7Version: cfg.hl7Version,
                    allowedIps: cfg.allowedIps,
                    bindAddress: cfg.bindAddress,
                    fieldMap: cfg.fieldMap,
                    httpEnabled: true,
                  }
                : undefined,
          },
          { createdBy: 'import:config-files' }
        );
        imported += 1;
      } catch {
        // skip an entry the new validation rejects; it can be re-added in the UI
      }
    }
    return imported;
  }

  // ── Internals ────────────────────────────────────────────────────────

  _validate(input, existing) {
    const name = String(input.name || '').trim();
    if (name.length < 3 || name.length > 160) throw new ValidationError('name is required (3-160 characters)');
    const location = String(input.location || '').trim().slice(0, 160);
    const type = String(input.type || '').trim().slice(0, 80);
    const integration = input.integration || 'manual';
    if (!INTEGRATIONS.includes(integration)) {
      throw new ValidationError(`integration must be one of ${INTEGRATIONS.join(', ')}`);
    }
    const status = input.status || 'active';
    if (!['active', 'inactive'].includes(status)) throw new ValidationError('status must be active or inactive');

    let fhir = null;
    let fhirSecretEnc = null;
    if (integration === 'fhir' || integration === 'both') {
      const f = input.fhir || {};
      const allowHttp = !this.production;
      const baseUrl = String(f.baseUrl || '').trim().replace(/\/+$/, '');
      if (!isHttpUrl(baseUrl, { allowHttp })) {
        throw new ValidationError(`FHIR base URL must be a valid ${allowHttp ? 'http(s)' : 'https'} URL`);
      }
      const authType = f.authType || 'client-secret';
      if (!FHIR_AUTH_TYPES.includes(authType)) {
        throw new ValidationError(`FHIR authType must be one of ${FHIR_AUTH_TYPES.join(', ')}`);
      }
      const tokenUrl = String(f.tokenUrl || '').trim();
      const clientId = String(f.clientId || '').trim();
      if (authType !== 'none') {
        if (!isHttpUrl(tokenUrl, { allowHttp })) throw new ValidationError('FHIR token URL is required for OAuth2 authentication');
        if (!clientId) throw new ValidationError('FHIR client ID is required for OAuth2 authentication');
      }
      const mrnIdentifierSystem = String(f.mrnIdentifierSystem || '').trim();
      if (!mrnIdentifierSystem) {
        throw new ValidationError("FHIR MRN identifier system is required (the URI on the hospital's Patient.identifier for its hospital number)");
      }
      // Mutual TLS (Table 3.8): client certificate + key files on this
      // server, and an optional private CA, for the hospital's FHIR API.
      const certPaths = {};
      for (const k of ['clientCertPath', 'clientKeyPath', 'caPath']) {
        const v = String(f[k] || '').trim();
        if (!v) continue;
        if (!fs.existsSync(v)) throw new ValidationError(`${k}: file not found on the server: ${v}`);
        certPaths[k] = v;
      }
      if (Boolean(certPaths.clientCertPath) !== Boolean(certPaths.clientKeyPath)) {
        throw new ValidationError('mutual TLS needs both a client certificate and a client key');
      }
      fhir = {
        ...certPaths,
        baseUrl,
        authType,
        tokenUrl: authType === 'none' ? '' : tokenUrl,
        clientId: authType === 'none' ? '' : clientId,
        mrnIdentifierSystem,
        scope: String(f.scope || DEFAULT_FHIR_SCOPE).trim(),
      };
      // A blank secret on update keeps the stored one.
      const secret = typeof f.clientSecret === 'string' ? f.clientSecret : '';
      if (authType === 'client-secret') {
        if (secret) fhirSecretEnc = this.cipher.encrypt(secret);
        else if (existing && existing.fhir && existing._fhirSecret) fhirSecretEnc = this.cipher.encrypt(existing._fhirSecret);
        else throw new ValidationError('FHIR client secret is required for client-secret authentication');
      }
    }

    let hl7 = null;
    if (integration === 'hl7' || integration === 'both') {
      const h = input.hl7 || {};
      const mllpEnabled = h.mllpEnabled !== false;
      const httpEnabled = h.httpEnabled !== false;
      if (!mllpEnabled && !httpEnabled) throw new ValidationError('enable at least one HL7 transport: MLLP or HTTP');
      let mllpPort = null;
      if (mllpEnabled) {
        mllpPort = Number(h.mllpPort);
        if (!Number.isInteger(mllpPort) || mllpPort < MLLP_PORT_MIN || mllpPort > MLLP_PORT_MAX) {
          throw new ValidationError(`MLLP port must be a whole number between ${MLLP_PORT_MIN} and ${MLLP_PORT_MAX}`);
        }
        const clash = this.list().find(
          (o) => o.hospitalID !== input.hospitalID && o.hl7 && o.hl7.mllpEnabled && o.hl7.mllpPort === mllpPort
        );
        if (clash) throw new ValidationError(`MLLP port ${mllpPort} is already used by ${clash.name}`);
      }
      const hl7Version = h.hl7Version || '2.5';
      if (!HL7_VERSIONS.includes(hl7Version)) throw new ValidationError(`HL7 version must be one of ${HL7_VERSIONS.join(', ')}`);
      const allowedIps = (Array.isArray(h.allowedIps) ? h.allowedIps : String(h.allowedIps || '').split(/[\s,]+/))
        .map((ip) => String(ip).trim())
        .filter(Boolean);
      for (const ip of allowedIps) if (!IP_PATTERN.test(ip)) throw new ValidationError(`"${ip}" is not a valid IP address`);
      const bindAddress = String(h.bindAddress || '').trim();
      if (bindAddress && !IP_PATTERN.test(bindAddress)) throw new ValidationError(`"${bindAddress}" is not a valid bind address`);
      const fieldMap = {};
      for (const [k, v] of Object.entries(h.fieldMap || {})) if (v) fieldMap[k] = String(v).trim();
      try {
        resolveFieldMap(fieldMap);
      } catch (err) {
        throw new ValidationError(err.message);
      }
      hl7 = { mllpEnabled, mllpPort, httpEnabled, hl7Version, allowedIps, bindAddress, fieldMap };
    }

    return {
      hospitalID: input.hospitalID,
      name,
      location,
      type,
      integration,
      status,
      fhirJson: fhir ? JSON.stringify(fhir) : null,
      fhirSecretEnc,
      hl7Json: hl7 ? JSON.stringify(hl7) : null,
    };
  }

  _fromRow(row, { withSecret = false } = {}) {
    const fhir = row.fhir_json ? JSON.parse(row.fhir_json) : null;
    if (fhir) fhir.hasClientSecret = Boolean(row.fhir_secret_enc);
    const out = {
      hospitalID: row.hospital_id,
      name: row.name,
      location: row.location,
      type: row.type,
      integration: row.integration,
      status: row.status,
      fhir,
      hl7: row.hl7_json ? JSON.parse(row.hl7_json) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
    };
    if (withSecret && row.fhir_secret_enc) {
      Object.defineProperty(out, '_fhirSecret', { value: this.cipher.decrypt(row.fhir_secret_enc), enumerable: false });
    }
    return out;
  }
}

module.exports = {
  HospitalRegistry,
  ValidationError,
  slugify,
  INTEGRATIONS,
  HOSPITAL_TYPES,
  HL7_VERSIONS,
  FHIR_AUTH_TYPES,
  DEFAULT_FHIR_SCOPE,
};
