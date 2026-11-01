'use strict';
const path = require('node:path');
const express = require('express');
const config = require('./config');
const settings = require('./lib/settings');
const payments = require('./lib/payments');
const calendarSync = require('./lib/calendarSync');
const { safeEqual } = require('./lib/security');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '));
  if (config.isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// Bescherming tegen cross-site requests: state-wijzigende API-calls moeten van dezelfde origin komen.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const host = req.get('host');
  if (origin) {
    try {
      if (new URL(origin).host !== host && origin !== config.publicUrl) {
        return res.status(403).json({ error: 'Ongeldige herkomst van het verzoek.' });
      }
    } catch {
      return res.status(403).json({ error: 'Ongeldige herkomst van het verzoek.' });
    }
  }
  const hasBody = Number(req.get('content-length') || 0) > 0 || req.get('transfer-encoding');
  if (hasBody && !req.is('application/json')) return res.status(415).json({ error: 'Verwacht JSON.' });
  next();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders);

  // Mollie-webhook: alleen het ID wordt gebruikt; de status halen we altijd zelf op bij Mollie.
  app.post('/api/webhooks/mollie', express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
    const id = String((req.body && req.body.id) || '');
    if (!/^tr_[A-Za-z0-9]+$/.test(id)) return res.status(200).end();
    try {
      await payments.syncPayment(id);
      res.status(200).end();
    } catch (err) {
      console.error('[webhook] verwerken mislukt', id, err.message);
      res.status(500).end(); // Mollie probeert het later opnieuw
    }
  });

  app.use('/api/admin', express.json({ limit: '600kb' }), sameOrigin, require('./routes/admin'));
  app.use('/api', express.json({ limit: '20kb' }), sameOrigin, require('./routes/public'));

  // ICS-abonnement voor Apple Agenda (alternatief voor CalDAV)
  app.get('/agenda/:token.ics', (req, res) => {
    const token = settings.get('ics_feed_token');
    if (!token || !safeEqual(req.params.token, token)) return res.status(404).send('Niet gevonden');
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/calendar; charset=utf-8').send(calendarSync.feed());
  });

  const pub = path.join(config.ROOT, 'public');
  app.get(['/admin', '/admin/'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(pub, 'admin', 'index.html'));
  });
  app.use(express.static(pub, { index: false, maxAge: config.isProduction ? '1h' : 0 }));
  app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Niet gevonden.' }));
  app.use((req, res) => res.status(404).sendFile(path.join(pub, 'index.html')));

  // Foutafhandeling
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ongeldige invoer.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'De invoer is te groot.' });
    const status = err.status && err.expose ? err.status : 500;
    if (status >= 500 && !err.expose) console.error(err);
    res.status(status).json({
      error: err.expose ? err.message : 'Er ging iets mis. Probeer het opnieuw.',
      fields: err.fields,
      code: err.code && typeof err.code === 'string' && !err.code.startsWith('SQLITE') ? err.code : undefined,
    });
  });
  return app;
}

function startJobs() {
  const every = (ms, fn) => setInterval(() => fn().catch((e) => console.error('[taak]', e.message)), ms).unref();
  every(2 * 60_000, payments.reconcile);
  every(3 * 60_000, () => calendarSync.retryPending());
}

module.exports = { createApp, startJobs };
