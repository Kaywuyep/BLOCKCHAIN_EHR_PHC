'use strict';

/**
 * logger.js
 *
 * JSON-lines logger with PHI redaction. Every line is one JSON object on
 * stdout/stderr, ready for a log shipper (Loki, ELK, CloudWatch...).
 *
 * Redaction rules:
 * - values under known PHI keys (names, dates of birth, hospital numbers,
 *   MRNs, free-text clinical notes) are replaced with "[REDACTED]";
 * - patient DIDs are shortened to their last 6 characters, enough to
 *   correlate log lines without exposing the full identifier;
 * - raw HL7 text is never logged: HL7 segments in a string are replaced.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const PHI_KEYS = new Set(
  [
    'name', 'family', 'given', 'text', 'dob', 'dateofbirth', 'birthdate', 'hospitalnumber', 'mrn',
    'localmrn', 'justification', 'notes', 'detail', 'raw', 'rawtext', 'body', 'sourceresource',
    'address', 'telecom', 'phone', 'email', 'nin',
  ].map((k) => k.toLowerCase())
);

const DID_PATTERN = /did:patientchain:[0-9a-f-]{8,}/gi;
const HL7_SEGMENT_PATTERN = /(MSH|PID|PV1|EVN|NK1|OBX|ORC|OBR)\|[^\r\n]*/g;

function maskDid(did) {
  return `did:patientchain:…${did.slice(-6)}`;
}

function redactString(value) {
  return value.replace(HL7_SEGMENT_PATTERN, '$1|[REDACTED]').replace(DID_PATTERN, maskDid);
}

function redact(value, depth = 0) {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) return { message: redactString(value.message), name: value.name };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = PHI_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function createLogger({ level = process.env.LOG_LEVEL || 'info', base = {}, write } = {}) {
  const threshold = LEVELS[level] || LEVELS.info;
  const sink =
    write ||
    ((lvl, line) => {
      (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
    });

  function emit(lvl, msg, fields) {
    if (LEVELS[lvl] < threshold) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg: redactString(String(msg)), ...base };
    if (fields !== undefined) Object.assign(entry, redact(fields instanceof Error ? { err: fields } : fields));
    sink(lvl, JSON.stringify(entry));
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (extra) => createLogger({ level, base: { ...base, ...extra }, write: sink }),
    // console-shaped adapter, for modules that take a `log` with log()/warn()
    asConsole() {
      return {
        log: (...args) => emit('info', args.map(String).join(' ')),
        warn: (...args) => emit('warn', args.map(String).join(' ')),
        error: (...args) => emit('error', args.map(String).join(' ')),
      };
    },
  };
}

const logger = createLogger();

module.exports = { createLogger, logger, redact };
