#!/usr/bin/env node
'use strict';

/**
 * restore.js -- restore the off-chain store from a backup.
 *
 *   npm run restore -- <backup-file>            dry run: verify the backup only
 *   npm run restore -- <backup-file> --apply    replace the live database
 *
 * Stop the backend first. --apply keeps the current database as
 * <db>.before-restore-<timestamp> so the restore itself can be undone.
 * The restore checks that the configured DATA_ENCRYPTION_KEYS can decrypt
 * the backup before touching anything.
 */
require('dotenv').config();
const fs = require('fs');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');
const { FieldCipher } = require('../src/db/fieldCipher');

function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file) {
    console.error('usage: npm run restore -- <backup-file> [--apply]');
    process.exit(2);
  }
  const config = loadConfig();
  const backup = new Database(file, { readonly: true });
  const integrity = backup.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`backup failed integrity check: ${integrity}`);

  const cipher = config.encryptionKeys ? FieldCipher.fromSpec(config.encryptionKeys) : FieldCipher.devKeyFile(config.dataDir);
  const sample = backup.prepare('SELECT data_enc FROM local_patient_index LIMIT 1').get() || backup.prepare('SELECT bundle_enc AS data_enc FROM clinical_bundles LIMIT 1').get();
  if (sample) cipher.decrypt(sample.data_enc); // throws if the keys don't match
  backup.close();
  console.log(`backup ${file} is intact${sample ? ' and decryptable with the configured keys' : ' (no encrypted rows to test)'}`);

  if (flag !== '--apply') {
    console.log('dry run only; re-run with --apply (backend stopped) to restore');
    return;
  }
  if (fs.existsSync(config.dbPath)) {
    const keepAside = `${config.dbPath}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(config.dbPath, keepAside);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(config.dbPath + suffix, { force: true });
    console.log(`previous database kept at ${keepAside}`);
  }
  fs.copyFileSync(file, config.dbPath);
  fs.chmodSync(config.dbPath, 0o600);
  console.log(`restored ${file} -> ${config.dbPath}; start the backend and check /api/ready`);
}

try {
  main();
} catch (err) {
  console.error(`restore failed: ${err.message}`);
  process.exit(1);
}
