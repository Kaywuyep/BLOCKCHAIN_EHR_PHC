'use strict';

const { randomUUID } = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const { patientsRouter } = require('./routes/patients');
const { providersRouter } = require('./routes/providers');
const { accessRouter } = require('./routes/access');
const { recordsRouter } = require('./routes/records');
const { auditRouter } = require('./routes/audit');
const { costRouter } = require('./routes/cost');
const { syncRouter } = require('./routes/sync');
const { hl7Router } = require('./routes/hl7');
const { hospitalsRouter } = require('./routes/hospitals');
const { ALL_ROLES } = require('./auth/auth');
const { createMetrics } = require('./metrics');

/**
 * app.js
 *
 * Builds the Express app: security middleware, public probes, auth, and
 * the API routers. server.js and the test server both call this, so tests
 * exercise the same middleware stack production runs.
 *
 * Order matters:
 *   request ID + access log -> HTTPS enforcement -> helmet -> CORS ->
 *   rate limit -> body parsing (size-limited) -> public endpoints
 *   (/health, /ready, /metrics, /auth/*) -> authenticate -> routers.
 */
function createApp({
  config,
  logger,
  auth,
  ledgerPromise,
  fhirAdapter,
  providerRegistry,
  linkageService,
  offlineQueue,
  inbox = null,
  identityStore = null,
  db = null,
  startedAt = Date.now(),
}) {
  const app = express();
  const metrics = createMetrics();
  app.disable('x-powered-by');
  if (config.http.trustProxy) {
    const tp = config.http.trustProxy;
    app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp === 'true' ? 1 : tp);
  }

  // Request ID + structured access log. Paths are logged without query
  // strings, which can carry identifiers.
  app.use((req, res, next) => {
    req.id = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].slice(0, 64)) || randomUUID();
    res.set('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = req.route ? `${req.baseUrl}${req.route.path}` : req.baseUrl || req.path;
      metrics.observeRequest(req.method, route, res.statusCode, ms);
      if (req.path === '/api/health' || req.path === '/api/ready' || req.path === '/api/metrics') return;
      logger.info('request', {
        requestId: req.id,
        method: req.method,
        route,
        status: res.statusCode,
        ms: Math.round(ms),
        user: req.user && !req.user.superuser ? req.user.sub : undefined,
      });
    });
    next();
  });

  // Behind a TLS-terminating proxy, refuse plain HTTP (except the probes,
  // which orchestrators call over the internal network).
  if (config.production && config.http.trustProxy && !(config.http.tlsCertPath && config.http.tlsKeyPath)) {
    app.use((req, res, next) => {
      if (req.secure || ['/api/health', '/api/ready'].includes(req.path)) return next();
      return res.status(403).json({ error: 'HTTPS required' });
    });
  }

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      strictTransportSecurity: config.production ? { maxAge: 31536000, includeSubDomains: true } : false,
    })
  );
  app.use((req, res, next) => {
    // API responses carry PHI: never cache them.
    res.set('Cache-Control', 'no-store');
    next();
  });

  const origins = config.http.corsOrigins;
  app.use(
    cors({
      origin: origins.length ? (origin, cb) => cb(null, !origin || origins.includes(origin)) : !config.production,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    })
  );

  const limiterBase = { windowMs: 60_000, standardHeaders: 'draft-7', legacyHeaders: false };
  if (config.http.rateLimitPerMinute > 0) {
    app.use(
      '/api',
      rateLimit({
        ...limiterBase,
        limit: config.http.rateLimitPerMinute,
        skip: (req) => ['/health', '/ready', '/metrics'].includes(req.path),
        message: { error: 'too many requests, slow down' },
      })
    );
  }
  const authLimiter = rateLimit({ ...limiterBase, limit: config.http.authRateLimitPerMinute, message: { error: 'too many login attempts' } });

  app.use(express.json({ limit: config.http.jsonLimit, strict: true }));

  // ── Public probes ──────────────────────────────────────────────────────
  // Liveness: the process is up. Says nothing about dependencies.
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      ledgerMode: config.ledgerMode,
      connectivity: offlineQueue.isConnected() ? 'online' : 'offline',
      authMode: auth.mode,
    });
  });

  // Readiness: dependencies answer. A load balancer should only route here
  // when this is 200.
  app.get('/api/ready', async (req, res) => {
    const checks = {};
    try {
      const ledger = await withTimeout(ledgerPromise, 3000);
      await withTimeout(Promise.resolve(ledger.getCounters()), 3000);
      checks.ledger = 'ok';
    } catch (err) {
      checks.ledger = `error: ${err.message}`;
    }
    try {
      if (db) db.prepare('SELECT 1').get();
      checks.database = 'ok';
    } catch (err) {
      checks.database = `error: ${err.message}`;
    }
    if (inbox) {
      const { counts } = inbox.stats();
      checks.hl7DeadLetters = counts.DEAD;
    }
    const ready = checks.ledger === 'ok' && checks.database === 'ok';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready', checks });
  });

  app.get('/api/metrics', (req, res) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /i, '');
    const allowed = config.metricsToken ? token === config.metricsToken : auth.mode === 'off';
    if (!allowed) return res.status(401).json({ error: 'metrics token required' });
    res.type('text/plain; version=0.0.4').send(
      metrics.render({
        uptimeSeconds: (Date.now() - startedAt) / 1000,
        offlineQueued: offlineQueue.getQueued().length,
        hl7: inbox ? inbox.stats() : null,
      })
    );
  });

  // ── Auth endpoints ─────────────────────────────────────────────────────
  app.get('/api/auth/config', (req, res) => {
    res.json({
      mode: auth.mode,
      oidc:
        auth.mode === 'oidc'
          ? { issuer: config.auth.oidcIssuer, clientId: config.auth.oidcClientId || config.auth.oidcAudience }
          : null,
    });
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    if (auth.mode !== 'local') return res.status(404).json({ error: 'local login is disabled' });
    const { subject, role, hospitalID, providerID } = req.body || {};
    if (typeof subject !== 'string' || !/^[\w.@:-]{1,128}$/.test(subject)) {
      return res.status(400).json({ error: 'subject is required (letters, digits, . _ - @ :)' });
    }
    if (!ALL_ROLES.has(role)) return res.status(400).json({ error: `role must be one of ${[...ALL_ROLES].join(', ')}` });
    if (['clinician', 'hospital_admin', 'hl7_interface'].includes(role) && !hospitalID) {
      return res.status(400).json({ error: 'hospitalID is required for hospital staff' });
    }
    const token = await auth.issueLocalToken({
      sub: subject,
      roles: [role],
      hospitalID,
      providerID: role === 'clinician' ? providerID || subject : undefined,
    });
    res.json({ token, expiresIn: config.auth.tokenTtlSeconds });
  });

  app.use('/api', auth.authenticate);

  app.get('/api/auth/me', (req, res) => {
    const { sub, roles, hospitalID, providerID, patientDID, superuser } = req.user;
    res.json({ sub, roles, hospitalID, providerID, patientDID, superuser });
  });

  // ── API ────────────────────────────────────────────────────────────────
  app.use('/api/patients', patientsRouter(ledgerPromise, fhirAdapter, linkageService, identityStore));
  app.use('/api/providers', providersRouter(providerRegistry));
  app.use('/api/access', accessRouter(ledgerPromise, offlineQueue));
  app.use('/api/records', recordsRouter(ledgerPromise, fhirAdapter, providerRegistry));
  app.use('/api/audit', auditRouter(ledgerPromise));
  app.use('/api/cost', costRouter(ledgerPromise, startedAt));
  app.use('/api/sync', syncRouter(ledgerPromise, offlineQueue));
  app.use('/api/hl7', hl7Router(fhirAdapter, inbox));
  app.use('/api/hospitals', hospitalsRouter());

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // Errors: log server-side with the request ID; never echo internals.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request body too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'malformed JSON body' });
    logger.error('unhandled error', { requestId: req.id, err });
    res.status(500).json({ error: 'internal server error', requestId: req.id });
  });

  return app;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

module.exports = { createApp };
