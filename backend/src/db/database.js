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
  // Diagnosis catalogue and anonymous diagnosis counts (Insights page).
  // diagnosis_terms: ICD-10 codes (system 'ICD-10') and terms clinicians
  //   added (system 'LOCAL', status 'pending' until a health records
  //   officer maps them to ICD-10: status 'mapped', mapped_to = the code).
  // diagnosis_counts: one row per month x viewing hospital x records
  //   hospital x clinician role x code. No patient, grant or clinician ID.
  // diagnosis_count_clinicians: keyed HMACs of clinician IDs, only to
  //   count distinct clinicians; not reversible without the server key.
  // diagnosis_tag_once: keyed HMAC of (grant, code) so re-ticking the
  //   same diagnosis on the same grant is not counted twice.
  `
  CREATE TABLE diagnosis_terms (
    code        TEXT PRIMARY KEY,
    system      TEXT NOT NULL,
    display     TEXT NOT NULL,
    synonyms    TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL,
    mapped_to   TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT
  );
  CREATE INDEX diagnosis_terms_by_status ON diagnosis_terms (status);
  CREATE TABLE diagnosis_counts (
    period              TEXT NOT NULL,
    viewer_hospital_id  TEXT NOT NULL,
    records_hospital_id TEXT NOT NULL,
    role                TEXT NOT NULL,
    code                TEXT NOT NULL,
    views               INTEGER NOT NULL,
    PRIMARY KEY (period, viewer_hospital_id, records_hospital_id, role, code)
  );
  CREATE TABLE diagnosis_count_clinicians (
    period             TEXT NOT NULL,
    viewer_hospital_id TEXT NOT NULL,
    code               TEXT NOT NULL,
    clinician_hash     TEXT NOT NULL,
    PRIMARY KEY (period, viewer_hospital_id, code, clinician_hash)
  );
  CREATE TABLE diagnosis_tag_once (
    token TEXT PRIMARY KEY
  );
  `,
  // Episode intervals and short-lived links (replaces diagnosis_tag_once,
  // whose grant-to-diagnosis hashes never expired).
  // interval_days: how long after a tick the same diagnosis for the same
  //   patient counts as the same episode; NULL = the system default, set by
  //   the system admin in diagnosis_settings.
  // diagnosis_episodes: keyed hash of (patient, code) -> when the current
  //   episode ends. Deleted when it ends.
  // diagnosis_grant_notes: what was ticked under one grant (keyed hash of
  //   the grant), so the clinician sees what they noted and can undo a
  //   mistake the same day. Deleted when the grant expires or is revoked.
  `
  DELETE FROM diagnosis_tag_once;
  ALTER TABLE diagnosis_terms ADD COLUMN interval_days INTEGER;
  ALTER TABLE diagnosis_count_clinicians ADD COLUMN ticks INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE diagnosis_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE diagnosis_episodes (
    token      TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    ends_at    TEXT NOT NULL
  );
  CREATE INDEX diagnosis_episodes_by_end ON diagnosis_episodes (ends_at);
  CREATE TABLE diagnosis_grant_notes (
    grant_token         TEXT NOT NULL,
    code                TEXT NOT NULL,
    noted_at            TEXT NOT NULL,
    counted             INTEGER NOT NULL,
    period              TEXT NOT NULL,
    viewer_hospital_id  TEXT NOT NULL,
    records_hospital_id TEXT NOT NULL,
    role                TEXT NOT NULL,
    clinician_hash      TEXT NOT NULL,
    episode_token       TEXT NOT NULL,
    grant_ends_at       TEXT NOT NULL,
    PRIMARY KEY (grant_token, code, noted_at)
  );
  CREATE INDEX diagnosis_grant_notes_by_end ON diagnosis_grant_notes (grant_ends_at);
  `,
  // Patient emergency codes: 7 characters a family member can give a
  // clinician in place of a hospital number. code_hash (keyed) is the
  // lookup; code_enc lets the patient see their own code again.
  `
  CREATE TABLE emergency_codes (
    patient_did TEXT PRIMARY KEY,
    code_hash   TEXT NOT NULL UNIQUE,
    code_enc    TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
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
