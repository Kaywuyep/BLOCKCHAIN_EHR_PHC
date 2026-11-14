/**
 * patientKeys.js — the patient's own key pair (Sections 2.3.5, 3.4.1).
 *
 * Generated in the browser with WebCrypto (ECDSA P-256). The private key is
 * created NON-EXTRACTABLE and stored in this device's IndexedDB: page
 * scripts can ask it to sign, but nobody — not Cevruni, not the hospital —
 * can read it out. Only the public key (SPKI, base64) is sent to the
 * server and registered on-chain with the patient's DID.
 *
 * Approving or revoking access is signed with it:
 *   approve  "grant:<grantID>:<durationMinutes>"
 *   revoke   "revoke:<grantID>"
 * and the chaincode verifies the signature before the grant changes.
 *
 * The key lives on one device. A patient who switches device cannot sign
 * until key recovery / re-registration is added (future work).
 */

const DB = 'cevruni-keys';
const STORE = 'keys';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

export function keysSupported() {
  return Boolean(window.crypto && window.crypto.subtle && window.indexedDB);
}

/** The stored key pair for this account on this device, or null. */
export async function getKeyPair(account) {
  if (!keysSupported()) return null;
  try {
    return (await idb('readonly', (s) => s.get(account))) || null;
  } catch {
    return null;
  }
}

/** Creates (or returns the existing) key pair; returns the public key as base64 SPKI. */
export async function ensureKeyPair(account) {
  if (!keysSupported()) throw new Error('this browser cannot create a secure patient key');
  let pair = await getKeyPair(account);
  if (!pair) {
    pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await idb('readwrite', (s) => s.put(pair, account));
  }
  return b64(await crypto.subtle.exportKey('spki', pair.publicKey));
}

/** Public key (base64 SPKI) on this device, or null. */
export async function publicKeyOnDevice(account) {
  const pair = await getKeyPair(account);
  return pair ? b64(await crypto.subtle.exportKey('spki', pair.publicKey)) : null;
}

async function sign(account, message) {
  const pair = await getKeyPair(account);
  if (!pair) throw new Error('your signing key is not on this device. Use the device where you created your Health ID.');
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(message));
  return b64(sig); // WebCrypto returns raw r||s, which the chaincode expects
}

export const signGrant = (account, grantID, durationMinutes) => sign(account, `grant:${grantID}:${durationMinutes}`);
export const signRevoke = (account, grantID) => sign(account, `revoke:${grantID}`);

/** A fresh grant ID the patient's app can sign before sending. */
export function newGrantID() {
  return crypto.randomUUID();
}
