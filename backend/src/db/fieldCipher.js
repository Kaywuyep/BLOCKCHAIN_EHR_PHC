'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * fieldCipher.js
 *
 * Application-level encryption at rest for PHI columns: AES-256-GCM with a
 * random 96-bit IV per value. Each ciphertext carries the ID of the key
 * that made it ("v1.<kid>.<iv>.<tag>.<data>", base64url parts), so keys
 * can be rotated without a flag day:
 *
 *   DATA_ENCRYPTION_KEYS="2026b:<base64 32 bytes>,2026a:<base64 32 bytes>"
 *
 * The first key encrypts new values; every listed key can still decrypt.
 * After adding a new key first in the list, run `npm run rotate-keys` to
 * re-encrypt old rows, then remove the old key.
 *
 * Generate a key with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

function parseKeyRing(spec) {
  const keys = new Map();
  let activeKid = null;
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx <= 0) throw new Error('DATA_ENCRYPTION_KEYS entries must look like "<kid>:<base64 key>"');
    const kid = part.slice(0, idx);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error(`invalid encryption key id "${kid}"`);
    const key = Buffer.from(part.slice(idx + 1), 'base64');
    if (key.length !== 32) throw new Error(`encryption key "${kid}" must be 32 bytes (base64-encoded)`);
    keys.set(kid, key);
    if (!activeKid) activeKid = kid;
  }
  if (!activeKid) throw new Error('DATA_ENCRYPTION_KEYS is empty');
  return { keys, activeKid };
}

class FieldCipher {
  constructor({ keys, activeKid }) {
    this.keys = keys;
    this.activeKid = activeKid;
  }

  static fromSpec(spec) {
    return new FieldCipher(parseKeyRing(spec));
  }

  /** A throwaway key, for in-memory stores (tests, the simulated demo). */
  static ephemeral() {
    return new FieldCipher({ keys: new Map([['mem', crypto.randomBytes(32)]]), activeKid: 'mem' });
  }

  /**
   * Development fallback when no key is configured: a key file in the data
   * directory, created on first use with 0600 permissions. Production
   * refuses to start without DATA_ENCRYPTION_KEYS (see config.js).
   */
  static devKeyFile(dataDir) {
    const file = path.join(dataDir, '.dev-encryption-key');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, `dev:${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    }
    return FieldCipher.fromSpec(fs.readFileSync(file, 'utf8').trim());
  }

  encrypt(plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keys.get(this.activeKid), iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', this.activeKid, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(token) {
    const [version, kid, iv, tag, data] = String(token).split('.');
    if (version !== 'v1') throw new Error('unrecognised ciphertext format');
    const key = this.keys.get(kid);
    if (!key) throw new Error(`no decryption key "${kid}" in DATA_ENCRYPTION_KEYS`);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  encryptJson(value) {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson(token) {
    return JSON.parse(this.decrypt(token));
  }

  /** True when a ciphertext was made with a key other than the active one. */
  needsRotation(token) {
    return String(token).split('.')[1] !== this.activeKid;
  }
}

module.exports = { FieldCipher, parseKeyRing };
