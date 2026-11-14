'use strict';

const path = require('path');

/**
 * config.js
 *
 * Every environment variable the backend reads, in one place, plus the
 * production safety checks. In NODE_ENV=production the server refuses to
 * start with a demo-only setting (simulated ledger, auth off, wildcard
 * CORS, no encryption key, plain HTTP without a TLS proxy). A demo setting
 * reaching production by accident is the failure this prevents.
 */

function list(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(env = process.env) {
  const production = (env.NODE_ENV || '').toLowerCase() === 'production';
  const dataDir = env.DATA_DIR || path.join(__dirname, '..', 'data');
  return {
    production,
    port: int(env.PORT, 4000),
    ledgerMode: (env.LEDGER_MODE || 'simulated').toLowerCase(),
    dataDir,
    dbPath: env.DATA_DB_PATH || path.join(dataDir, 'patientchain.sqlite'),
    encryptionKeys: env.DATA_ENCRYPTION_KEYS || '',

    auth: {
      // off: no authentication (demo and tests only, refused in production)
      // local: HS256 tokens from POST /api/auth/login (development only)
      // oidc: bearer tokens from the hospital's identity provider
      mode: (env.AUTH_MODE || (production ? 'oidc' : 'off')).toLowerCase(),
      jwtSecret: env.AUTH_JWT_SECRET || '',
      tokenTtlSeconds: int(env.AUTH_TOKEN_TTL_SECONDS, 3600),
      oidcIssuer: env.OIDC_ISSUER || '',
      oidcAudience: env.OIDC_AUDIENCE || '',
      // Public client ID the frontend uses for the authorization-code + PKCE flow.
      oidcClientId: env.OIDC_CLIENT_ID || '',
      oidcJwksUri: env.OIDC_JWKS_URI || '',
      // Claim names, so any IdP (Keycloak, Entra ID, ...) can be mapped.
      rolesClaim: env.OIDC_ROLES_CLAIM || 'roles',
      hospitalClaim: env.OIDC_HOSPITAL_CLAIM || 'hospital_id',
      providerClaim: env.OIDC_PROVIDER_CLAIM || 'provider_id',
      patientDidClaim: env.OIDC_PATIENT_DID_CLAIM || 'patient_did',
    },

    http: {
      corsOrigins: list(env.CORS_ORIGINS),
      trustProxy: env.TRUST_PROXY || '',
      tlsCertPath: env.TLS_CERT_PATH || '',
      // TLS 1.3 by default (Table 3.8); TLS_MIN_VERSION=TLSv1.2 only for old clients.
      tlsMinVersion: env.TLS_MIN_VERSION || 'TLSv1.3',
      tlsKeyPath: env.TLS_KEY_PATH || '',
      jsonLimit: env.JSON_BODY_LIMIT || '100kb',
      rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 300),
      authRateLimitPerMinute: int(env.AUTH_RATE_LIMIT_PER_MINUTE, 20),
    },

    hl7: {
      mllpEnabled: bool(env.HL7_MLLP_ENABLED),
      tlsCertPath: env.HL7_TLS_CERT_PATH || '',
      tlsKeyPath: env.HL7_TLS_KEY_PATH || '',
      // CA bundle for interface-engine client certificates. Setting it
      // turns on mutual TLS: clients without a certificate signed by it
      // are refused during the handshake.
      tlsClientCaPath: env.HL7_TLS_CLIENT_CA_PATH || '',
      // Acknowledges that MLLP runs over a VPN/private link instead of TLS.
      privateNetwork: bool(env.HL7_PRIVATE_NETWORK),
      maxAttempts: int(env.HL7_MAX_ATTEMPTS, 5),
      retryIntervalMs: int(env.HL7_RETRY_INTERVAL_MS, 30000),
    },

    metricsToken: env.METRICS_TOKEN || '',
    logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
    backupDir: env.BACKUP_DIR || path.join(dataDir, 'backups'),
  };
}

/** Returns a list of problems that make this config unsafe for production. */
function productionProblems(cfg) {
  if (!cfg.production) return [];
  const problems = [];
  if (cfg.ledgerMode !== 'fabric') problems.push('LEDGER_MODE must be "fabric" (the simulated ledger is in-memory)');
  if (cfg.auth.mode !== 'oidc') problems.push('AUTH_MODE must be "oidc" (off/local are for development only)');
  if (cfg.auth.mode === 'oidc' && (!cfg.auth.oidcIssuer || !cfg.auth.oidcAudience)) {
    problems.push('OIDC_ISSUER and OIDC_AUDIENCE are required');
  }
  if (!cfg.encryptionKeys) problems.push('DATA_ENCRYPTION_KEYS is required (encryption at rest)');
  if (!cfg.http.corsOrigins.length || cfg.http.corsOrigins.includes('*')) {
    problems.push('CORS_ORIGINS must list the allowed frontend origins (no wildcard)');
  }
  const directTls = cfg.http.tlsCertPath && cfg.http.tlsKeyPath;
  if (!directTls && !cfg.http.trustProxy) {
    problems.push('HTTPS required: set TLS_CERT_PATH/TLS_KEY_PATH, or TRUST_PROXY when a TLS proxy terminates HTTPS');
  }
  if (cfg.hl7.mllpEnabled && !(cfg.hl7.tlsCertPath && cfg.hl7.tlsKeyPath) && !cfg.hl7.privateNetwork) {
    problems.push('HL7 MLLP needs TLS (HL7_TLS_CERT_PATH/HL7_TLS_KEY_PATH) or HL7_PRIVATE_NETWORK=true for a VPN link');
  }
  if (!cfg.metricsToken) problems.push('METRICS_TOKEN is required to protect /api/metrics');
  return problems;
}

module.exports = { loadConfig, productionProblems };
