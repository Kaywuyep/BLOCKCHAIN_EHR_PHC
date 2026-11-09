'use strict';

const { SignJWT, jwtVerify, createRemoteJWKSet } = require('jose');

/**
 * auth.js
 *
 * Authentication: turns a bearer token into `req.user`.
 *
 *   AUTH_MODE=oidc   Production. Tokens come from the hospital's identity
 *                    provider (Keycloak, Entra ID, ...) and are verified
 *                    against its published signing keys, issuer and
 *                    audience. Role/hospital/provider claim names are
 *                    configurable (see config.js).
 *   AUTH_MODE=local  Development. POST /api/auth/login issues HS256 tokens
 *                    for any identity, with no password. Refused in
 *                    production.
 *   AUTH_MODE=off    Demo and tests. Every request acts as a superuser.
 *                    Refused in production.
 *
 * req.user = { sub, roles[], hospitalID, providerID, patientDID, superuser }
 *
 * A patient's DID is minted by PatientChain, not by the identity
 * provider, so it usually isn't a token claim. After registration the
 * token subject is bound to the DID (identityStore) and looked up here on
 * every request.
 */

const ROLES = Object.freeze({
  PATIENT: 'patient',
  CLINICIAN: 'clinician',
  HOSPITAL_ADMIN: 'hospital_admin',
  SYSTEM_ADMIN: 'system_admin',
  HL7_INTERFACE: 'hl7_interface',
});
const ALL_ROLES = new Set(Object.values(ROLES));

function claimAt(payload, dottedPath) {
  return dottedPath.split('.').reduce((obj, key) => (obj == null ? undefined : obj[key]), payload);
}

class IdentityStore {
  constructor(db) {
    this.get = db.prepare('SELECT patient_did FROM identity_bindings WHERE subject = ?');
    this.insert = db.prepare('INSERT INTO identity_bindings (subject, patient_did, bound_at) VALUES (?, ?, ?)');
  }

  patientDidFor(subject) {
    return this.get.get(subject)?.patient_did || null;
  }

  bind(subject, patientDID) {
    const existing = this.patientDidFor(subject);
    if (existing && existing !== patientDID) throw new Error('this account is already bound to a different patient DID');
    if (!existing) this.insert.run(subject, patientDID, new Date().toISOString());
  }
}

function createAuth(authConfig, { identityStore } = {}) {
  const mode = authConfig.mode;
  if (!['off', 'local', 'oidc'].includes(mode)) throw new Error(`unknown AUTH_MODE "${mode}"`);
  if (mode === 'local' && authConfig.jwtSecret.length < 32) {
    throw new Error('AUTH_MODE=local requires AUTH_JWT_SECRET of at least 32 characters');
  }

  const localKey = mode === 'local' ? new TextEncoder().encode(authConfig.jwtSecret) : null;
  let remoteJwks = null;

  async function oidcKeys() {
    if (remoteJwks) return remoteJwks;
    let jwksUri = authConfig.oidcJwksUri;
    if (!jwksUri) {
      const res = await fetch(`${authConfig.oidcIssuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      jwksUri = (await res.json()).jwks_uri;
    }
    remoteJwks = createRemoteJWKSet(new URL(jwksUri));
    return remoteJwks;
  }

  function toUser(payload) {
    let roles = claimAt(payload, authConfig.rolesClaim) || [];
    if (typeof roles === 'string') roles = roles.split(/[ ,]+/);
    roles = roles.filter((r) => ALL_ROLES.has(r));
    const user = {
      sub: String(payload.sub || ''),
      roles,
      hospitalID: claimAt(payload, authConfig.hospitalClaim) || null,
      providerID: claimAt(payload, authConfig.providerClaim) || null,
      patientDID: claimAt(payload, authConfig.patientDidClaim) || null,
      superuser: false,
    };
    if (!user.patientDID && roles.includes(ROLES.PATIENT) && identityStore) {
      user.patientDID = identityStore.patientDidFor(user.sub);
    }
    return user;
  }

  async function verify(token) {
    if (mode === 'local') {
      const { payload } = await jwtVerify(token, localKey, { issuer: 'patientchain-local', audience: 'patientchain' });
      return toUser(payload);
    }
    const { payload } = await jwtVerify(token, await oidcKeys(), {
      issuer: authConfig.oidcIssuer,
      audience: authConfig.oidcAudience,
    });
    return toUser(payload);
  }

  /** Express middleware: sets req.user, or answers 401. */
  async function authenticate(req, res, next) {
    if (mode === 'off') {
      req.user = { sub: 'anonymous', roles: [...ALL_ROLES], hospitalID: null, providerID: null, patientDID: null, superuser: true };
      return next();
    }
    const header = req.headers.authorization || '';
    const match = /^Bearer (.+)$/i.exec(header);
    if (!match) return res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'authentication required' });
    try {
      req.user = await verify(match[1]);
      if (!req.user.sub) throw new Error('token has no subject');
      return next();
    } catch {
      return res.status(401).set('WWW-Authenticate', 'Bearer error="invalid_token"').json({ error: 'invalid or expired token' });
    }
  }

  /** AUTH_MODE=local only: issues a development token. */
  async function issueLocalToken({ sub, roles, hospitalID, providerID }) {
    if (mode !== 'local') throw new Error('local login is only available with AUTH_MODE=local');
    const claims = { roles: roles.filter((r) => ALL_ROLES.has(r)) };
    if (hospitalID) claims.hospital_id = hospitalID;
    if (providerID) claims.provider_id = providerID;
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setIssuer('patientchain-local')
      .setAudience('patientchain')
      .setIssuedAt()
      .setExpirationTime(`${authConfig.tokenTtlSeconds}s`)
      .sign(localKey);
  }

  return { mode, authenticate, issueLocalToken, verify };
}

module.exports = { createAuth, IdentityStore, ROLES, ALL_ROLES };
