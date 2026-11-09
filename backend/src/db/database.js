'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * database.js
 *
 * The backend's durable off-chain store: one SQLite file (WAL mode) for
 * everything that used to live in memory: each hospital's patient roster,
 * DID <-> hospital-number links, clinical bundles, the provider registry,
 * identity bindings and the HL7 inbox. PHI columns hold AES-256-GCM
 * ciphertext (see fieldCipher.js); identifiers needed for lookups are
 * stored in the clear.
 *
 * SQLite suits a single backend instance per hospital, which is the
 * deployment the design describes. A hospital running several replicas
 * would move these tables to PostgreSQL behind the same store classes.
 *
 * Migrations are append-only: add a new entry to MIGRATIONS, never edit
 * an applied one.
 */

const MIGRATIONS = [
  `
  CREATE TABLE local_patient_index (
    hospital_id     TEXT NOT NULL,
    hospital_number TEXT NOT NULL,
    data_enc        TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (hospital_id, hospital_number)
  );
  CREATE TABLE did_links (
    hospital_id     TEXT NOT NULL,
    patient_did     TEXT NOT NULL,
    hospital_number TEXT NOT NULL,
    linked_at       TEXT NOT NULL,
    PRIMARY KEY (hospital_id, patient_did)
  );
  CREATE TABLE clinical_bundles (
    id              TEXT PRIMARY KEY,
    hospital_id     TEXT NOT NULL,
    hospital_number TEXT NOT NULL,
    bundle_enc      TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX clinical_bundles_by_patient ON clinical_bundles (hospital_id, hospital_number, created_at);
  CREATE TABLE providers (
    hospital_id   TEXT NOT NULL,
    provider_id   TEXT NOT NULL,
    data          TEXT NOT NULL,
    status        TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    PRIMARY KEY (hospital_id, provider_id)
  );
  CREATE TABLE identity_bindings (
    subject     TEXT PRIMARY KEY,
    patient_did TEXT NOT NULL UNIQUE,
    bound_at    TEXT NOT NULL
  );
  CREATE TABLE hl7_messages (
    id            TEXT PRIMARY KEY,
    hospital_id   TEXT NOT NULL,
    control_id    TEXT,
    message_type  TEXT,
    raw_enc       TEXT NOT NULL,
    status        TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    received_at   TEXT NOT NULL,
    processed_at  TEXT,
    next_attempt_at TEXT
  );
  CREATE UNIQUE INDEX hl7_messages_dedupe ON hl7_messages (hospital_id, control_id) WHERE control_id IS NOT NULL AND control_id <> '';
  CREATE INDEX hl7_messages_by_status ON hl7_messages (status, next_attempt_at);
  `,
];

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    })();
  });
}

/** Opens (creating if needed) and migrates a database. ':memory:' for tests. */
function openDatabase(dbPath = ':memory:') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // not fatal on filesystems without POSIX permissions
    }
  }
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

module.exports = { openDatabase, MIGRATIONS };
