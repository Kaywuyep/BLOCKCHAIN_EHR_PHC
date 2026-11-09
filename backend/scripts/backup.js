#!/usr/bin/env node
'use strict';

/**
 * backup.js -- online backup of the off-chain store.
 *
 *   npm run backup                 writes $BACKUP_DIR/patientchain-<timestamp>.sqlite
 *   npm run backup -- --keep 14    and deletes all but the newest 14 backups
 *
 * Uses SQLite's online backup API, so it is safe while the server runs.
 * PHI columns are already AES-256-GCM encrypted inside the file, so the
 * backup is unreadable without DATA_ENCRYPTION_KEYS. Store the keys
 * separately from the backups (see docs/operations/runbook.md).
 *
 * Each backup is verified after writing: integrity_check must pass and
 * the table row counts must match the source.
 *
 * Schedule it (cron, systemd timer) at least as often as the agreed RPO.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { loadConfig } = require('../src/config');

const TABLES = ['local_patient_index', 'did_links', 'clinical_bundles', 'providers', 'identity_bindings', 'hl7_messages'];

async function main() {
  const config = loadConfig();
  const keepIdx = process.argv.indexOf('--keep');
  const keep = keepIdx > 0 ? Number(process.argv[keepIdx + 1]) : 0;
  if (!fs.existsSync(config.dbPath)) throw new Error(`no database at ${config.dbPath}`);

  fs.mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(config.backupDir, `patientchain-${stamp}.sqlite`);

  const source = new Database(config.dbPath, { readonly: true });
  await source.backup(target);
  fs.chmodSync(target, 0o600);

  const copy = new Database(target, { readonly: true });
  const integrity = copy.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`backup integrity check failed: ${integrity}`);
  for (const table of TABLES) {
    const a = source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    const b = copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    if (a !== b) throw new Error(`row count mismatch in ${table}: ${a} vs ${b}`);
  }
  copy.close();
  source.close();
  console.log(JSON.stringify({ level: 'info', msg: 'backup written and verified', file: target, bytes: fs.statSync(target).size }));

  // The offline sync queue lives in its own file: access actions queued
  // while the ledger was unreachable and not yet replayed.
  const queuePath = process.env.SYNC_QUEUE_DB_PATH || path.join(config.dataDir, 'sync-queue.sqlite');
  if (fs.existsSync(queuePath)) {
    const queueTarget = path.join(config.backupDir, `sync-queue-${stamp}.sqlite`);
    const queue = new Database(queuePath, { readonly: true });
    await queue.backup(queueTarget);
    queue.close();
    fs.chmodSync(queueTarget, 0o600);
    console.log(JSON.stringify({ level: 'info', msg: 'offline queue backed up', file: queueTarget }));
  }

  if (keep > 0) {
    const old = fs
      .readdirSync(config.backupDir)
      .filter((f) => /^patientchain-.*\.sqlite$/.test(f))
      .sort()
      .slice(0, -keep)
      .flatMap((f) => [f, f.replace(/^patientchain-/, 'sync-queue-')])
      .filter((f) => fs.existsSync(path.join(config.backupDir, f)));
    for (const f of old) fs.rmSync(path.join(config.backupDir, f));
    if (old.length) console.log(JSON.stringify({ level: 'info', msg: 'old backups pruned', removed: old.length }));
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'backup failed', error: err.message }));
  process.exit(1);
});
