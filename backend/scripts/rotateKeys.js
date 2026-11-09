#!/usr/bin/env node
'use strict';

/**
 * rotateKeys.js -- re-encrypt stored PHI with the active key.
 *
 * Key rotation:
 *   1. generate a key:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   2. put it FIRST in DATA_ENCRYPTION_KEYS, keeping the old key after it
 *   3. restart the backend (new writes use the new key)
 *   4. npm run backup, then npm run rotate-keys
 *   5. once this reports 0 remaining, remove the old key from the list
 *
 * Backups taken before rotation are still encrypted with the old key.
 * Keep the old key in escrow (not in the running config) until the last
 * of those backups has expired, or they can no longer be restored.
 *
 * Runs in one transaction per table, so it can be safely re-run.
 */
require('dotenv').config();
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db/database');
const { FieldCipher } = require('../src/db/fieldCipher');

const COLUMNS = [
  ['local_patient_index', 'data_enc', ['hospital_id', 'hospital_number']],
  ['clinical_bundles', 'bundle_enc', ['id']],
  ['hl7_messages', 'raw_enc', ['id']],
];

const config = loadConfig();
if (!config.encryptionKeys) {
  console.error('DATA_ENCRYPTION_KEYS is not set');
  process.exit(2);
}
const cipher = FieldCipher.fromSpec(config.encryptionKeys);
const db = openDatabase(config.dbPath);
let total = 0;
for (const [table, column, keys] of COLUMNS) {
  const rows = db.prepare(`SELECT ${keys.join(', ')}, ${column} AS v FROM ${table}`).all();
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`);
  const stale = rows.filter((r) => cipher.needsRotation(r.v));
  db.transaction(() => {
    for (const r of stale) update.run(cipher.encrypt(cipher.decrypt(r.v)), ...keys.map((k) => r[k]));
  })();
  console.log(`${table}: re-encrypted ${stale.length} of ${rows.length}`);
  total += stale.length;
}
db.close();
console.log(`done: ${total} value(s) now use key "${cipher.activeKid}"; 0 remaining under old keys`);
