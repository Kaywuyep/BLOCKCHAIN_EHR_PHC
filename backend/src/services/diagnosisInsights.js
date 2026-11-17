'use strict';

const crypto = require('crypto');
const { ICD10_STARTER, STARTER_INTERVALS } = require('./icd10Starter');

/**
 * diagnosisInsights.js
 *
 * Diagnosis catalogue (ICD-10 plus local terms awaiting mapping) and the
 * anonymous diagnosis counts behind Insights > Diagnosis trends.
 *
 * After opening a patient's records from another hospital, a clinician may
 * tick the diagnoses the visit concerns. That tick is NOT stored against the
 * patient: Cevruni is not an EMR and clinical data stays at the hospital
 * (Section 3.4.3). It only adds 1 to a monthly count for
 *   (viewing hospital, records hospital, clinician role, diagnosis code),
 * kept off-chain. Distinct clinicians are counted through keyed hashes, and
 * counts below SMALL_CELL are shown as "<5" so a rare diagnosis at a small
 * hospital cannot point to one patient.
 *
 * Episodes: the same diagnosis for the same patient counts once per
 * interval (set per code by the system admin; default 14 days), across all
 * grants and hospitals. A tick inside the interval is still noted for the
 * clinician but not counted again, and the clinician is not told whether
 * someone else noted it (that would reveal another hospital's diagnosis).
 *
 * Short-lived links: the keyed (patient, code) episode marker is deleted
 * when the episode ends, and the per-grant notes when the grant expires or
 * is revoked. After that only the anonymous counts remain.
 */

const SMALL_CELL = 5;
const DEFAULT_INTERVAL_DAYS = 14;
const MAX_INTERVAL_DAYS = 365;
const DAY_MS = 24 * 3600 * 1000;
// "Same day" for undo, in Nigerian time (WAT, UTC+1, no daylight saving).
const watDay = (d) => new Date(new Date(d).getTime() + 3600 * 1000).toISOString().slice(0, 10);
const ICD10_PATTERN = /^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/;
const MAX_TERM = 120;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const nowIso = () => new Date().toISOString();
const periodOf = (date = new Date()) => date.toISOString().slice(0, 7); // YYYY-MM

function validDays(days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL_DAYS) throw new DiagnosisError(`an interval must be a whole number of days from 1 to ${MAX_INTERVAL_DAYS}`);
  return n;
}

class DiagnosisError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

class DiagnosisInsights {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {Buffer|string} opts.hashKey  secret for the keyed hashes
   */
  constructor({ db, hashKey }) {
    if (!db) throw new Error('DiagnosisInsights needs a database');
    this.db = db;
    this.hashKey = crypto.createHmac('sha256', hashKey || crypto.randomBytes(32)).update('cevruni-diagnosis-counts-v1').digest();
    this.sql = {
      term: db.prepare('SELECT * FROM diagnosis_terms WHERE code = ?'),
      searchable: db.prepare("SELECT * FROM diagnosis_terms WHERE status IN ('standard', 'pending')"),
      byStatus: db.prepare('SELECT * FROM diagnosis_terms WHERE status = ? ORDER BY created_at'),
      insert: db.prepare(
        'INSERT INTO diagnosis_terms (code, system, display, synonyms, status, mapped_to, created_by, created_at) VALUES (@code, @system, @display, @synonyms, @status, @mapped_to, @created_by, @created_at)'
      ),
      localCount: db.prepare("SELECT COUNT(*) AS n FROM diagnosis_terms WHERE system = 'LOCAL'"),
      count: db.prepare('SELECT COUNT(*) AS n FROM diagnosis_terms'),
      addCount: db.prepare(
        `INSERT INTO diagnosis_counts (period, viewer_hospital_id, records_hospital_id, role, code, views)
         VALUES (@period, @viewer, @records, @role, @code, @n)
         ON CONFLICT (period, viewer_hospital_id, records_hospital_id, role, code) DO UPDATE SET views = views + excluded.views`
      ),
      addClinician: db.prepare(
        `INSERT INTO diagnosis_count_clinicians (period, viewer_hospital_id, code, clinician_hash, ticks) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (period, viewer_hospital_id, code, clinician_hash) DO UPDATE SET ticks = ticks + 1`
      ),
      setting: db.prepare('SELECT value FROM diagnosis_settings WHERE key = ?'),
      putSetting: db.prepare('INSERT INTO diagnosis_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
      episode: db.prepare('SELECT * FROM diagnosis_episodes WHERE token = ?'),
      putEpisode: db.prepare(
        'INSERT INTO diagnosis_episodes (token, started_at, ends_at) VALUES (?, ?, ?) ON CONFLICT (token) DO UPDATE SET started_at = excluded.started_at, ends_at = excluded.ends_at'
      ),
      lastNote: db.prepare('SELECT * FROM diagnosis_grant_notes WHERE grant_token = ? AND code = ? ORDER BY noted_at DESC LIMIT 1'),
      notes: db.prepare('SELECT * FROM diagnosis_grant_notes WHERE grant_token = ? ORDER BY noted_at DESC'),
      putNote: db.prepare(
        `INSERT INTO diagnosis_grant_notes (grant_token, code, noted_at, counted, period, viewer_hospital_id, records_hospital_id, role, clinician_hash, episode_token, grant_ends_at)
         VALUES (@grant_token, @code, @noted_at, @counted, @period, @viewer, @records, @role, @clinician_hash, @episode_token, @grant_ends_at)`
      ),
    };
    this.seed();
    this.seedIntervals();
  }

  /** Starting intervals for chronic conditions etc., applied once. */
  seedIntervals() {
    if (this.sql.setting.get('starter_intervals_v1')) return;
    this.db.transaction(() => {
      const upd = this.db.prepare('UPDATE diagnosis_terms SET interval_days = ? WHERE code = ? AND interval_days IS NULL');
      for (const [code, days] of Object.entries(STARTER_INTERVALS)) upd.run(days, code);
      this.sql.putSetting.run('starter_intervals_v1', nowIso());
    })();
  }

  // ── Episode intervals (system admin) ──

  defaultIntervalDays() {
    const row = this.sql.setting.get('default_interval_days');
    return row ? Number(row.value) : DEFAULT_INTERVAL_DAYS;
  }

  setDefaultIntervalDays(days) {
    const n = validDays(days);
    this.sql.putSetting.run('default_interval_days', String(n));
    return n;
  }

  /** Days after a tick during which the same diagnosis for the same patient is the same episode. */
  intervalFor(code) {
    const row = this.sql.term.get(code);
    return row && row.interval_days ? row.interval_days : this.defaultIntervalDays();
  }

  /** Sets one code's interval; null returns it to the default. */
  setInterval(code, days, { by } = {}) {
    const row = this.sql.term.get(code);
    if (!row || !['standard', 'pending'].includes(row.status)) throw new DiagnosisError('no such diagnosis in the catalogue', 404);
    const n = days === null || days === '' || days === undefined ? null : validDays(days);
    this.db.prepare('UPDATE diagnosis_terms SET interval_days = ?, reviewed_by = COALESCE(?, reviewed_by) WHERE code = ?').run(n, by || null, code);
    return { ...this._fromRow(this.sql.term.get(code)), intervalDays: n, effectiveIntervalDays: n || this.defaultIntervalDays() };
  }

  intervals({ q = '' } = {}) {
    const def = this.defaultIntervalDays();
    const needle = norm(q);
    const rows = this.db.prepare("SELECT * FROM diagnosis_terms WHERE status IN ('standard', 'pending') ORDER BY system, code").all()
      .map((r) => ({ ...this._fromRow(r), intervalDays: r.interval_days || null, effectiveIntervalDays: r.interval_days || def }))
      .filter((t) => !needle || t.code.toLowerCase().includes(needle) || norm(t.display).includes(needle) || t.synonyms.some((x) => x.includes(needle)));
    return { defaultIntervalDays: def, terms: rows };
  }

  /** Drops links whose episode or grant has ended. */
  purge(now = new Date()) {
    const t = now.toISOString();
    this.db.prepare('DELETE FROM diagnosis_episodes WHERE ends_at <= ?').run(t);
    this.db.prepare('DELETE FROM diagnosis_grant_notes WHERE grant_ends_at <= ?').run(t);
  }

  /** A grant was revoked: its notes go at once. */
  forgetGrant(grantID) {
    this.db.prepare('DELETE FROM diagnosis_grant_notes WHERE grant_token = ?').run(this._hash('grant', grantID));
  }

  /** Loads the ICD-10 starter list into an empty catalogue. */
  seed() {
    if (this.sql.count.get().n > 0) return;
    const at = nowIso();
    this.db.transaction(() => {
      for (const [code, display, synonyms] of ICD10_STARTER) {
        this.sql.insert.run({ code, system: 'ICD-10', display, synonyms: JSON.stringify(synonyms), status: 'standard', mapped_to: null, created_by: 'icd10-starter', created_at: at });
      }
    })();
  }

  _hash(...parts) {
    return crypto.createHmac('sha256', this.hashKey).update(parts.join('\u0000')).digest('hex');
  }

  _fromRow(r) {
    return {
      code: r.code,
      system: r.system,
      display: r.display,
      synonyms: JSON.parse(r.synonyms || '[]'),
      status: r.status,
      mappedTo: r.mapped_to || undefined,
      createdBy: r.created_by || undefined,
      createdAt: r.created_at,
      reviewedBy: r.reviewed_by || undefined,
      reviewedAt: r.reviewed_at || undefined,
    };
  }

  /** The term a code currently stands for, following a mapped LOCAL code to its ICD-10 code. */
  resolve(code) {
    let row = this.sql.term.get(String(code || '').trim());
    for (let i = 0; row && row.status === 'mapped' && row.mapped_to && i < 5; i += 1) row = this.sql.term.get(row.mapped_to);
    return row && (row.status === 'standard' || row.status === 'pending') ? this._fromRow(row) : null;
  }

  /**
   * Type-ahead search over codes, names and local names. Exact and
   * prefix matches rank first.
   */
  search(q, limit = 10) {
    const needle = norm(q);
    if (!needle) return [];
    const scored = [];
    for (const row of this.sql.searchable.all()) {
      const t = this._fromRow(row);
      const names = [norm(t.display), ...t.synonyms.map(norm)];
      const code = t.code.toLowerCase();
      let score = 0;
      if (code === needle || names.includes(needle)) score = 100;
      else if (code.startsWith(needle)) score = 80;
      else if (names.some((n) => n.startsWith(needle))) score = 70;
      else if (names.some((n) => n.split(/[\s,()/-]+/).some((w) => w.startsWith(needle)))) score = 50;
      else if (names.some((n) => n.includes(needle))) score = 30;
      else if (needle.length >= 4 && names.some((n) => needle.includes(n) && n.length >= 4)) score = 20;
      if (score) scored.push({ score: score - (t.status === 'pending' ? 5 : 0), t });
    }
    scored.sort((a, b) => b.score - a.score || a.t.display.localeCompare(b.t.display));
    return scored.slice(0, Math.max(1, Math.min(Number(limit) || 10, 25))).map((s) => s.t);
  }

  /**
   * A diagnosis the catalogue does not have. Returns the existing term if
   * the name matches one; otherwise creates LOCAL-nnnn, pending review.
   */
  addLocalTerm(term, { createdBy } = {}) {
    const display = String(term || '').trim().replace(/\s+/g, ' ');
    if (display.length < 3 || display.length > MAX_TERM) throw new DiagnosisError(`a diagnosis name must be 3-${MAX_TERM} characters`);
    const exact = this.search(display, 25).find((t) => norm(t.display) === norm(display) || t.synonyms.map(norm).includes(norm(display)));
    if (exact) return { term: exact, created: false };
    const code = this.db.transaction(() => {
      const next = `LOCAL-${String(this.sql.localCount.get().n + 1).padStart(4, '0')}`;
      this.sql.insert.run({ code: next, system: 'LOCAL', display, synonyms: '[]', status: 'pending', mapped_to: null, created_by: createdBy || null, created_at: nowIso() });
      return next;
    })();
    return { term: this._fromRow(this.sql.term.get(code)), created: true };
  }

  /**
   * Notes the diagnoses a clinician ticked for a patient under one grant.
   * Each counts once per episode for that patient (any grant, any
   * hospital). Returns, per code, 'noted' or 'already-noted' (this grant,
   * inside the interval) -- never whether another clinician noted it.
   */
  tag({ codes, grantID, patientDID, grantEndsAt, clinicianID, viewerHospitalID, recordsHospitalID, role, at = new Date() }) {
    if (!Array.isArray(codes) || codes.length === 0) throw new DiagnosisError('tick at least one diagnosis');
    if (codes.length > 10) throw new DiagnosisError('at most 10 diagnoses per record');
    if (!patientDID) throw new DiagnosisError('the grant has no patient');
    const terms = [];
    for (const c of codes) {
      const t = this.resolve(c);
      if (!t) throw new DiagnosisError(`unknown diagnosis code ${c}`);
      if (!terms.some((x) => x.code === t.code)) terms.push(t);
    }
    const now = new Date(at);
    this.purge(now);
    const period = periodOf(now);
    const grantToken = this._hash('grant', grantID);
    const clinicianHash = this._hash('clinician', clinicianID);
    const endsAt = grantEndsAt && !Number.isNaN(new Date(grantEndsAt).getTime()) ? new Date(grantEndsAt).toISOString() : new Date(now.getTime() + 30 * DAY_MS).toISOString();
    const results = [];
    this.db.transaction(() => {
      for (const t of terms) {
        const days = this.intervalFor(t.code);
        const last = this.sql.lastNote.get(grantToken, t.code);
        if (last) {
          const next = new Date(new Date(last.noted_at).getTime() + days * DAY_MS);
          if (next > now) {
            results.push({ code: t.code, display: t.display, system: t.system, status: 'already-noted', notedAt: last.noted_at, nextAt: next.toISOString() });
            continue;
          }
        }
        const episodeToken = this._hash('episode', patientDID, t.code);
        const ep = this.sql.episode.get(episodeToken);
        const counted = !(ep && new Date(ep.ends_at) > now);
        if (counted) {
          this.sql.addCount.run({ period, viewer: viewerHospitalID, records: recordsHospitalID, role: role || 'Clinician', code: t.code, n: 1 });
          this.sql.addClinician.run(period, viewerHospitalID, t.code, clinicianHash);
          this.sql.putEpisode.run(episodeToken, now.toISOString(), new Date(now.getTime() + days * DAY_MS).toISOString());
        }
        this.sql.putNote.run({
          grant_token: grantToken, code: t.code, noted_at: now.toISOString(), counted: counted ? 1 : 0, period,
          viewer: viewerHospitalID, records: recordsHospitalID, role: role || 'Clinician', clinician_hash: clinicianHash,
          episode_token: episodeToken, grant_ends_at: endsAt,
        });
        results.push({ code: t.code, display: t.display, system: t.system, status: 'noted', notedAt: now.toISOString(), nextAt: new Date(now.getTime() + days * DAY_MS).toISOString() });
      }
    })();
    return { results, counted: results.filter((r) => r.status === 'noted').map((r) => r.code) };
  }

  /**
   * What has been noted under this grant (for the clinicians who may use
   * it), newest first, with when each can be noted again and whether the
   * caller can still undo it (their own tick, same day).
   */
  notesForGrant({ grantID, clinicianID, grantEndsAt, now = new Date() }) {
    this.purge(now);
    const grantToken = this._hash('grant', grantID);
    if (grantEndsAt) this.db.prepare('UPDATE diagnosis_grant_notes SET grant_ends_at = ? WHERE grant_token = ?').run(new Date(grantEndsAt).toISOString(), grantToken);
    const me = this._hash('clinician', clinicianID);
    const today = watDay(now);
    const seen = new Set();
    return this.sql.notes.all(grantToken).map((n) => {
      const t = this._fromRow(this.sql.term.get(n.code) || { code: n.code, system: '?', display: n.code, synonyms: '[]', status: 'standard', created_at: '' });
      const latest = !seen.has(n.code);
      seen.add(n.code);
      const nextAt = new Date(new Date(n.noted_at).getTime() + this.intervalFor(n.code) * DAY_MS);
      return {
        code: n.code, display: t.display, system: t.system, notedAt: n.noted_at,
        nextAt: latest && nextAt > now ? nextAt.toISOString() : null,
        byYou: n.clinician_hash === me,
        canUndo: latest && n.clinician_hash === me && watDay(n.noted_at) === today,
      };
    });
  }

  /** Undoes the caller's own tick made today (WAT) under this grant. */
  undo({ grantID, code, clinicianID, now = new Date() }) {
    const grantToken = this._hash('grant', grantID);
    const n = this.sql.lastNote.get(grantToken, code);
    if (!n) throw new DiagnosisError('nothing noted for that diagnosis on this access', 404);
    if (n.clinician_hash !== this._hash('clinician', clinicianID)) throw new DiagnosisError('you can only undo your own ticks', 403);
    if (watDay(n.noted_at) !== watDay(now)) throw new DiagnosisError('a tick can only be undone on the day it was made', 409);
    this.db.transaction(() => {
      if (n.counted) {
        this.db.prepare('UPDATE diagnosis_counts SET views = views - 1 WHERE period = ? AND viewer_hospital_id = ? AND records_hospital_id = ? AND role = ? AND code = ?')
          .run(n.period, n.viewer_hospital_id, n.records_hospital_id, n.role, n.code);
        this.db.prepare('DELETE FROM diagnosis_counts WHERE views <= 0').run();
        this.db.prepare('UPDATE diagnosis_count_clinicians SET ticks = ticks - 1 WHERE period = ? AND viewer_hospital_id = ? AND code = ? AND clinician_hash = ?')
          .run(n.period, n.viewer_hospital_id, n.code, n.clinician_hash);
        this.db.prepare('DELETE FROM diagnosis_count_clinicians WHERE ticks <= 0').run();
        this.db.prepare('DELETE FROM diagnosis_episodes WHERE token = ? AND started_at = ?').run(n.episode_token, n.noted_at);
      }
      this.db.prepare('DELETE FROM diagnosis_grant_notes WHERE grant_token = ? AND code = ? AND noted_at = ?').run(grantToken, code, n.noted_at);
    })();
    return { undone: code };
  }

  /**
   * Diagnosis trends between two months (inclusive), optionally for one
   * viewing hospital. Small counts are suppressed.
   */
  trends({ from, to, hospitalID } = {}) {
    const end = to || periodOf();
    const start = from || end;
    const where = ['period >= ?', 'period <= ?'];
    const args = [start, end];
    if (hospitalID) {
      where.push('viewer_hospital_id = ?');
      args.push(hospitalID);
    }
    const W = where.join(' AND ');
    const byCode = this.db.prepare(`SELECT code, SUM(views) AS views, COUNT(DISTINCT viewer_hospital_id) AS hospitals FROM diagnosis_counts WHERE ${W} GROUP BY code`).all(...args);
    const clin = new Map(
      this.db.prepare(`SELECT code, COUNT(DISTINCT viewer_hospital_id || ':' || clinician_hash) AS n FROM diagnosis_count_clinicians WHERE ${W} GROUP BY code`).all(...args).map((r) => [r.code, r.n])
    );
    const byRole = this.db.prepare(`SELECT code, role, SUM(views) AS views FROM diagnosis_counts WHERE ${W} GROUP BY code, role`).all(...args);
    const byHospital = this.db.prepare(`SELECT code, viewer_hospital_id AS hospitalID, SUM(views) AS views FROM diagnosis_counts WHERE ${W} GROUP BY code, viewer_hospital_id`).all(...args);
    const byMonth = this.db.prepare(`SELECT code, period, SUM(views) AS views FROM diagnosis_counts WHERE ${W} GROUP BY code, period ORDER BY period`).all(...args);

    const cell = (n) => (n >= SMALL_CELL ? { value: n } : { value: null, suppressed: true });
    const rows = byCode
      .map((r) => {
        const t = this._fromRow(this.sql.term.get(r.code) || { code: r.code, system: '?', display: r.code, synonyms: '[]', status: 'standard', created_at: '' });
        return {
          code: t.code,
          system: t.system,
          display: t.display,
          status: t.status,
          views: cell(r.views),
          clinicians: cell(clin.get(r.code) || 0),
          hospitals: r.hospitals,
          byRole: byRole.filter((x) => x.code === r.code).map((x) => ({ role: x.role, views: cell(x.views) })),
          byHospital: byHospital.filter((x) => x.code === r.code).map((x) => ({ hospitalID: x.hospitalID, views: cell(x.views) })),
          byMonth: byMonth.filter((x) => x.code === r.code).map((x) => ({ period: x.period, views: cell(x.views) })),
          _sort: r.views,
        };
      })
      .sort((a, b) => b._sort - a._sort)
      .map(({ _sort, ...r }) => r);
    const totals = this.db.prepare(`SELECT COALESCE(SUM(views), 0) AS views FROM diagnosis_counts WHERE ${W}`).get(...args);
    const clinicians = this.db.prepare(`SELECT COUNT(DISTINCT viewer_hospital_id || ':' || clinician_hash) AS n FROM diagnosis_count_clinicians WHERE ${W}`).get(...args);
    return {
      from: start,
      to: end,
      smallCellThreshold: SMALL_CELL,
      totals: { taggedViews: totals.views, diagnoses: rows.length, clinicians: clinicians.n },
      diagnoses: rows,
    };
  }

  pendingTerms() {
    return this.sql.byStatus.all('pending').map((r) => {
      const t = this._fromRow(r);
      const views = this.db.prepare('SELECT COALESCE(SUM(views), 0) AS n FROM diagnosis_counts WHERE code = ?').get(t.code).n;
      return { ...t, views, suggestions: this.search(t.display, 3).filter((s) => s.system === 'ICD-10') };
    });
  }

  /**
   * Maps a pending LOCAL term to an ICD-10 code: an existing one, or a new
   * one the reviewer enters (code + name). Its counts move to that code and
   * its name becomes a local name of the code, so the next clinician who
   * types it lands on ICD-10 directly.
   */
  mapTerm(localCode, { targetCode, newDisplay, reviewedBy } = {}) {
    const local = this.sql.term.get(localCode);
    if (!local || local.system !== 'LOCAL') throw new DiagnosisError('no such local term', 404);
    if (local.status !== 'pending') throw new DiagnosisError(`this term is already ${local.status}`, 409);
    const code = String(targetCode || '').trim().toUpperCase();
    if (!ICD10_PATTERN.test(code)) throw new DiagnosisError('enter an ICD-10 code such as B54 or A01.0');
    let target = this.sql.term.get(code);
    if (target && target.status !== 'standard') throw new DiagnosisError(`${code} is not an active ICD-10 code in the catalogue`);
    if (!target && !String(newDisplay || '').trim()) throw new DiagnosisError(`${code} is not in the catalogue yet: give its ICD-10 name to add it`);

    const at = nowIso();
    this.db.transaction(() => {
      if (!target) {
        this.sql.insert.run({ code, system: 'ICD-10', display: String(newDisplay).trim().slice(0, MAX_TERM), synonyms: '[]', status: 'standard', mapped_to: null, created_by: reviewedBy || null, created_at: at });
        target = this.sql.term.get(code);
      }
      const syn = JSON.parse(target.synonyms || '[]');
      if (!syn.map(norm).includes(norm(local.display)) && norm(local.display) !== norm(target.display)) syn.push(local.display.toLowerCase());
      this.db.prepare('UPDATE diagnosis_terms SET synonyms = ? WHERE code = ?').run(JSON.stringify(syn), code);
      this.db.prepare("UPDATE diagnosis_terms SET status = 'mapped', mapped_to = ?, reviewed_by = ?, reviewed_at = ? WHERE code = ?").run(code, reviewedBy || null, at, localCode);
      this.db.prepare(
        `INSERT INTO diagnosis_counts (period, viewer_hospital_id, records_hospital_id, role, code, views)
         SELECT period, viewer_hospital_id, records_hospital_id, role, ?, views FROM diagnosis_counts WHERE code = ? AND true
         ON CONFLICT (period, viewer_hospital_id, records_hospital_id, role, code) DO UPDATE SET views = views + excluded.views`
      ).run(code, localCode);
      this.db.prepare('DELETE FROM diagnosis_counts WHERE code = ?').run(localCode);
      this.db.prepare(
        `INSERT INTO diagnosis_count_clinicians (period, viewer_hospital_id, code, clinician_hash, ticks)
         SELECT period, viewer_hospital_id, ?, clinician_hash, ticks FROM diagnosis_count_clinicians WHERE code = ? AND true
         ON CONFLICT (period, viewer_hospital_id, code, clinician_hash) DO UPDATE SET ticks = ticks + excluded.ticks`
      ).run(code, localCode);
      this.db.prepare('DELETE FROM diagnosis_count_clinicians WHERE code = ?').run(localCode);
      this.db.prepare('UPDATE OR IGNORE diagnosis_grant_notes SET code = ? WHERE code = ?').run(code, localCode);
    })();
    return { local: this._fromRow(this.sql.term.get(localCode)), target: this._fromRow(this.sql.term.get(code)) };
  }

  /** Rejects a pending term that is not a diagnosis (a typo, a symptom list); its counts are dropped. */
  rejectTerm(localCode, { reviewedBy } = {}) {
    const local = this.sql.term.get(localCode);
    if (!local || local.system !== 'LOCAL') throw new DiagnosisError('no such local term', 404);
    if (local.status !== 'pending') throw new DiagnosisError(`this term is already ${local.status}`, 409);
    this.db.transaction(() => {
      this.db.prepare("UPDATE diagnosis_terms SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE code = ?").run(reviewedBy || null, nowIso(), localCode);
      this.db.prepare('DELETE FROM diagnosis_counts WHERE code = ?').run(localCode);
      this.db.prepare('DELETE FROM diagnosis_count_clinicians WHERE code = ?').run(localCode);
      this.db.prepare('DELETE FROM diagnosis_grant_notes WHERE code = ?').run(localCode);
    })();
    return this._fromRow(this.sql.term.get(localCode));
  }
}

module.exports = { DiagnosisInsights, DiagnosisError, SMALL_CELL, ICD10_PATTERN, DEFAULT_INTERVAL_DAYS, periodOf, watDay };
