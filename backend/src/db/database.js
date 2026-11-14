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
  // Screen-capture attempts seen by the frontend's ScreenShield. The
  // tamper-evident copy is the SCREEN_CAPTURE_ATTEMPT ledger audit entry;
  // this table lets hospital admins list attempts across all patients.
  `
  CREATE TABLE screen_capture_attempts (
    id          TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    actor_id    TEXT NOT NULL,
    role        TEXT,
    hospital_id TEXT,
    patient_did TEXT,
    method      TEXT NOT NULL,
    confidence  TEXT NOT NULL,
    page        TEXT,
    ledger_entry_id TEXT
  );
  CREATE INDEX screen_capture_by_hospital ON screen_capture_attempts (hospital_id, occurred_at);
  `,
  // Hospital registry, managed from the System Admin UI. Replaces the
  // hand-edited config/hospitalDirectory.json + hospitalIngestion.json,
  // which are imported once when this table is empty.
  // integration: fhir | hl7 | both | manual. fhir_json / hl7_json hold the
  // non-secret connection settings; the FHIR client secret is encrypted.
  //
  // User directory: every identity that has signed in (source 'seen') or
  // that a system admin created ahead of first sign-in (source 'created').
  // status 'disabled' blocks sign-in at the API.
  `
  CREATE TABLE hospitals (
    hospital_id     TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    location        TEXT NOT NULL DEFAULT '',
    type            TEXT NOT NULL DEFAULT '',
    integration     TEXT NOT NULL,
    fhir_json       TEXT,
    fhir_secret_enc TEXT,
    hl7_json        TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    created_by      TEXT
  );
  CREATE TABLE users (
    subject       TEXT PRIMARY KEY,
    display_name  TEXT,
    roles         TEXT NOT NULL,
    hospital_id   TEXT,
    provider_id   TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    source        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    created_by    TEXT,
    last_seen_at  TEXT
  );
  CREATE INDEX users_by_hospital ON users (hospital_id);
  `,
  // Who asked for an emergency (break-glass) access on behalf of an
  // unresponsive patient (NHA 2014 s.26(2)(d)). Encrypted; only a salted
  // hash goes on-chain.
  `
  CREATE TABLE emergency_representatives (
    grant_id     TEXT PRIMARY KEY,
    details_enc  TEXT NOT NULL,
    details_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL
  );
  `,
  // Emergency-access notes kept OFF-chain (Section 3.4.7): the clinician's
  // justification, the family member / representative, and each extension
  // reason. Encrypted; the ledger holds only "sha256:<hash>" of each note.
  `
  CREATE TABLE emergency_notes (
    hash        TEXT PRIMARY KEY,
    grant_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    details_enc TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX emergency_notes_by_grant ON emergency_notes (grant_id);
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
