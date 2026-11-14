'use strict';

const crypto = require('crypto');

/**
 * patientSignature.js
 *
 * Patients hold their own key pair (ECDSA P-256, generated in their
 * browser; the private key never leaves the device). The public key is
 * registered with their DID as base64 SPKI. Approving or revoking a grant
 * requires the patient's signature over a fixed message:
 *
 *   approve:  "grant:<grantID>:<durationMinutes>"
 *   revoke:   "revoke:<grantID>"
 *
 * The chaincode verifies the same signature on-chain
 * (verifyPatientSignature in chaincode/accesscontrol.go); this module is
 * the identical check for the simulated ledger and for early rejection in
 * the API. Signatures are WebCrypto's raw r||s (IEEE P1363), base64.
 *
 * A patient registered without an SPKI key (older demo data, scripts) has
 * nothing to verify against and may act unsigned.
 */

function grantMessage(grantID, durationMinutes) {
  return `grant:${grantID}:${durationMinutes}`;
}

function revokeMessage(grantID) {
  return `revoke:${grantID}`;
}

/** The patient's key as a KeyObject, or null if they have no SPKI key. */
function publicKeyOf(patient) {
  if (!patient || typeof patient.publicKey !== 'string') return null;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(patient.publicKey, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' ? key : null;
  } catch {
    return null;
  }
}

/**
 * Throws if the patient has a key and the signature is missing or wrong.
 * Returns true when a signature was verified, false for a keyless patient.
 */
function verifyPatientSignature(patient, message, signature) {
  const key = publicKeyOf(patient);
  if (!key) return false;
  if (!signature) throw new Error("this action must be signed with the patient's key");
  let sig;
  try {
    sig = Buffer.from(signature, 'base64');
  } catch {
    throw new Error('malformed patient signature');
  }
  if (sig.length !== 64) throw new Error('malformed patient signature');
  const ok = crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }, sig);
  if (!ok) throw new Error('patient signature does not verify');
  return true;
}

module.exports = { grantMessage, revokeMessage, publicKeyOf, verifyPatientSignature };
