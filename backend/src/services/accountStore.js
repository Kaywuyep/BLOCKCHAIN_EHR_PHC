'use strict';

const crypto = require('crypto');
const { ROLES } = require('../auth/auth');

/**
 * accountStore.js
 *
 * Password accounts for AUTH_MODE=password: the sign-in a real pilot uses
 * when the hospital has no identity provider of its own.
 *
 *   patients      sign themselves up with full name, email and password;
 *   hospital admins
 *                 get an account (username admin@<hospitalID>) when a system
 *                 admin creates their hospital, with a temporary password;
 *   clinicians    get an account (username <staffID>@<hospitalID>) when
 *                 their hospital admin pulls them in from the EMR, with a
 *                 temporary password.
 *
 * A temporary password must be changed at first sign-in (must_change);
 * until then the token only allows changing the password.
 *
 * Passwords are hashed with scrypt (N=2^15, r=8, p=1) and a 16-byte salt
 * per user. Five wrong passwords lock the account for 15 minutes; the lock
 * is stored, so a restart does not clear it.
 *
 * Roles, hospital and display name live in the `users` table
 * (userDirectory.js); this store only holds the login and the hash.
 */

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
// No look-alike characters (0/O, 1/l/I) in temporary passwords: they are read out or copied by hand.
const TEMP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

class AccountError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return crypto.timingSafeEqual(expected, actual);
}

// Spent on unknown logins too, so response time doesn't reveal which emails have accounts.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

/** The rules a new password must meet. Returns an error message or null. */
function passwordProblem(password, { login, fullName } = {}) {
  if (typeof password !== 'string' || password.length < 10) return 'password must be at least 10 characters';
  if (password.length > 200) return 'password must be at most 200 characters';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return 'password must contain at least one letter and one number';
  const lower = password.toLowerCase();
  if (login && lower.includes(String(login).toLowerCase().split('@')[0]) && String(login).split('@')[0].length >= 4) {
    return 'password must not contain your email or username';
  }
  if (fullName) {
    for (const part of String(fullName).toLowerCase().split(/\s+/)) {
      if (part.length >= 4 && lower.includes(part)) return 'password must not contain your name';
    }
  }
  return null;
}

function temporaryPassword() {
  // 12 characters, always with a digit and a letter.
  for (;;) {
    const bytes = crypto.randomBytes(12);
    const pw = [...bytes].map((b) => TEMP_ALPHABET[b % TEMP_ALPHABET.length]).join('');
    if (/\d/.test(pw) && /[A-Za-z]/.test(pw)) return pw;
  }
}

function normaliseLogin(login) {
  return String(login || '').trim().toLowerCase();
}

class AccountStore {
  constructor({ db }) {
    this.db = db;
    const q = (sql) => db.prepare(sql);
    this.sql = {
      byLogin: q('SELECT * FROM credentials WHERE login = ?'),
      bySubject: q('SELECT * FROM credentials WHERE subject = ?'),
      insert: q(`INSERT INTO credentials (subject, login, password_hash, must_change, password_changed_at, created_at)
                 VALUES (@subject, @login, @hash, @mustChange, @now, @now)`),
      setPassword: q(`UPDATE credentials SET password_hash = @hash, must_change = @mustChange, failed_attempts = 0,
                      locked_until = NULL, password_changed_at = @now WHERE subject = @subject`),
      failed: q('UPDATE credentials SET failed_attempts = ?, locked_until = ? WHERE subject = ?'),
      cleared: q('UPDATE credentials SET failed_attempts = 0, locked_until = NULL WHERE subject = ?'),
      countAdmins: q(`SELECT COUNT(*) AS n FROM credentials c JOIN users u ON u.subject = c.subject
                      WHERE (',' || u.roles || ',') LIKE '%,system_admin,%'`),
      insertUser: q(`INSERT INTO users (subject, display_name, roles, hospital_id, provider_id, status, source, created_at, created_by)
                     VALUES (@subject, @displayName, @roles, @hospitalID, @providerID, 'active', @source, @now, @createdBy)`),
      user: q('SELECT * FROM users WHERE subject = ?'),
    };
  }

  loginTaken(login) {
    return Boolean(this.sql.byLogin.get(normaliseLogin(login)));
  }

  hasCredentials(subject) {
    return Boolean(this.sql.bySubject.get(subject));
  }

  loginFor(subject) {
    const row = this.sql.bySubject.get(subject);
    return row ? row.login : null;
  }

  systemAdminCount() {
    return this.sql.countAdmins.get().n;
  }

  /** Checks a patient sign-up without writing anything. Returns the cleaned values. */
  checkPatientSignUp({ fullName, email, password }) {
    fullName = String(fullName || '').trim().replace(/\s+/g, ' ');
    const login = normaliseLogin(email);
    if (fullName.length < 3 || fullName.length > 120 || !/\s/.test(fullName)) {
      throw new AccountError('enter your full name (first name and surname)');
    }
    if (!EMAIL_PATTERN.test(login) || login.length > 254) throw new AccountError('enter a valid email address');
    const problem = passwordProblem(password, { login, fullName });
    if (problem) throw new AccountError(problem);
    if (this.loginTaken(login)) throw new AccountError('an account with this email already exists', 409);
    return { fullName, login, password };
  }

  /** Creates a patient account. Call checkPatientSignUp first. */
  createPatient({ subject, fullName, login, password }) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.sql.insertUser.run({
        subject, displayName: fullName, roles: ROLES.PATIENT, hospitalID: null, providerID: null, source: 'signup', now, createdBy: null,
      });
      this.sql.insert.run({ subject, login, hash: hashPassword(password), mustChange: 0, now });
    })();
    return { subject, login };
  }

  /**
   * Gives an existing `users` row (staff, system admin) a login with a
   * temporary password. Returns the temporary password; it is not stored
   * anywhere in the clear.
   */
  issueTemporary(subject, login) {
    login = normaliseLogin(login);
    if (!/^[\w.@:+-]{3,128}$/.test(login)) throw new AccountError('username may contain letters, digits and . _ - @ : +');
    if (!this.sql.user.get(subject)) throw new AccountError(`no user "${subject}"`, 404);
    const existing = this.sql.bySubject.get(subject);
    const temp = temporaryPassword();
    const now = new Date().toISOString();
    if (existing) {
      this.sql.setPassword.run({ subject, hash: hashPassword(temp), mustChange: 1, now });
    } else {
      if (this.loginTaken(login)) throw new AccountError(`the username "${login}" is already taken`, 409);
      this.sql.insert.run({ subject, login, hash: hashPassword(temp), mustChange: 1, now });
    }
    return { subject, login: existing ? existing.login : login, temporaryPassword: temp };
  }

  /**
   * Checks a login and password. Returns { subject, mustChange } or throws.
   * The error never says whether the login exists.
   */
  authenticate(login, password) {
    const row = this.sql.byLogin.get(normaliseLogin(login));
    if (!row) {
      verifyPassword(String(password || ''), DUMMY_HASH);
      throw new AccountError('wrong email/username or password', 401);
    }
    if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
      throw new AccountError('too many wrong passwords: this account is locked for 15 minutes', 429);
    }
    if (!verifyPassword(String(password || ''), row.password_hash)) {
      const failed = (row.locked_until ? 0 : row.failed_attempts) + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MS).toISOString() : null;
      this.sql.failed.run(lock ? 0 : failed, lock, row.subject);
      if (lock) throw new AccountError('too many wrong passwords: this account is locked for 15 minutes', 429);
      throw new AccountError('wrong email/username or password', 401);
    }
    if (row.failed_attempts || row.locked_until) this.sql.cleared.run(row.subject);
    return { subject: row.subject, login: row.login, mustChange: Boolean(row.must_change) };
  }

  changePassword(subject, currentPassword, newPassword) {
    const row = this.sql.bySubject.get(subject);
    if (!row) throw new AccountError('this account has no password', 404);
    if (!verifyPassword(String(currentPassword || ''), row.password_hash)) throw new AccountError('current password is wrong', 403);
    if (currentPassword === newPassword) throw new AccountError('choose a password different from the current one');
    const user = this.sql.user.get(subject);
    const problem = passwordProblem(newPassword, { login: row.login, fullName: user && user.display_name });
    if (problem) throw new AccountError(problem);
    this.sql.setPassword.run({ subject, hash: hashPassword(newPassword), mustChange: 0, now: new Date().toISOString() });
  }
}

module.exports = { AccountStore, AccountError, hashPassword, verifyPassword, passwordProblem, temporaryPassword, normaliseLogin };
