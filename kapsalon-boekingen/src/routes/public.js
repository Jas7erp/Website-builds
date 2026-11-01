'use strict';
const express = require('express');
const { db, nowIso } = require('../db');
const settings = require('../lib/settings');
const availability = require('../lib/availability');
const pricing = require('../lib/pricing');
const bookings = require('../lib/bookings');
const payments = require('../lib/payments');
const repo = require('../lib/repo');
const t = require('../lib/time');
const mollie = require('../lib/mollie');
const { emails } = require('../lib/mailer');
const { AppError, ValidationError } = require('../lib/validate');
const { rateLimiter, numericCode, hmac, randomToken, sha256, safeEqual } = require('../lib/security');

const router = express.Router();

const lookupLimiter = rateLimiter({ windowMs: 60_000, max: 60 });
const discountLimiter = rateLimiter({ windowMs: 10 * 60_000, max: 30, message: 'Te veel pogingen met kortingscodes. Probeer het later opnieuw.' });
const bookingLimiter = rateLimiter({ windowMs: 60 * 60_000, max: 20, message: 'Te veel boekingen vanaf dit adres. Probeer het later opnieuw.' });
const manageLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 10, message: 'Te veel pogingen. Probeer het over een kwartier opnieuw.' });

function serviceView(s) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    durationMin: s.duration_min,
    priceCents: s.price_cents,
    depositType: s.deposit_type,
    depositValue: s.deposit_value,
    depositCents: pricing.computeDeposit(s, s.price_cents),
  };
}

function activeServices() {
  return db.prepare('SELECT * FROM services WHERE active = 1 AND deleted_at IS NULL ORDER BY sort_order, name').all();
}

// Optionele beheersessie: bij wijzigen wordt de eigen afspraak niet als bezet gezien.
function manageSession(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const row = db.prepare('SELECT * FROM manage_sessions WHERE token_hash = ? AND expires_at > ?').get(sha256(token), nowIso());
  if (!row) return null;
  return repo.getBooking(row.booking_id);
}

function requireManage(req, res, next) {
  const b = manageSession(req);
  if (!b) return res.status(401).json({ error: 'Je sessie is verlopen. Vraag een nieuwe verificatiecode aan.' });
  req.booking = b;
  next();
}

router.get('/salon', (req, res) => {
  const s = settings.getAll();
  res.json({
    name: s.salon_name,
    tagline: s.salon_tagline,
    logo: s.salon_logo || null,
    phone: s.salon_phone,
    email: s.salon_email,
    address: s.salon_address,
    status: availability.salonStatus(),
    today: t.nowLocal().date,
    maxDaysAhead: s.max_days_ahead,
    notesEnabled: s.booking_notes_enabled,
    allowServiceChange: s.allow_service_change,
    policy: { windowHours: s.cancel_window_hours, lateRefundPct: s.late_cancel_refund_pct, text: s.policy_text },
    paymentsEnabled: mollie.isConfigured(),
  });
});

router.get('/services', (req, res) => {
  res.json({ services: activeServices().map(serviceView) });
});

function durationFromQuery(req, manageBooking) {
  const id = Number(req.query.service);
  const service = repo.getService(id);
  if (service) return service.duration_min;
  if (manageBooking && manageBooking.service_id === id) return manageBooking.duration_min;
  throw new ValidationError('Onbekende behandeling.');
}

router.get('/availability/month', lookupLimiter, (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new ValidationError('Ongeldige maand.');
  const mb = manageSession(req);
  const duration = durationFromQuery(req, mb);
  res.json({ month, days: availability.monthAvailability(month, duration, { excludeBookingId: mb ? mb.id : null }) });
});

router.get('/availability/day', lookupLimiter, (req, res) => {
  const date = String(req.query.date || '');
  if (!t.isValidDate(date)) throw new ValidationError('Ongeldige datum.');
  const mb = manageSession(req);
  const duration = durationFromQuery(req, mb);
  const slots = availability.getSlots(date, duration, { excludeBookingId: mb ? mb.id : null });
  res.json({ date, slots: slots.map(t.toHHMM) });
});

// Prijsberekening incl. server-side controle van de kortingscode
router.post('/quote', discountLimiter, (req, res) => {
  const service = repo.getService(Number(req.body.serviceId));
  if (!service) throw new ValidationError('Onbekende behandeling.');
  const code = String(req.body.discountCode || '');
  const q = pricing.quote({ service, discountCode: code, email: req.body.email, phone: req.body.phone });
  res.json({
    priceCents: q.priceCents,
    discount: q.discount ? { code: q.discount.code, label: q.discount.label, cents: q.discount.cents } : null,
    discountError: q.discountError,
    finalCents: q.finalCents,
    depositCents: q.depositCents,
    remainingCents: q.remainingCents,
  });
});

router.post('/bookings', bookingLimiter, async (req, res) => {
  const b = req.body || {};
  if (!b.acceptPolicy) throw new ValidationError('Ga akkoord met de annuleringsvoorwaarden om te boeken.');
  if (b.website) throw new ValidationError('Ongeldige aanvraag.'); // honeypot
  const result = await bookings.createBooking({
    serviceId: b.serviceId, date: b.date, time: b.time,
    firstName: b.firstName, lastName: b.lastName, email: b.email, phone: b.phone,
    notes: settings.get('booking_notes_enabled') ? b.notes : '',
    discountCode: b.discountCode,
  }, { source: 'online' });
  res.status(201).json({
    code: result.booking.code,
    token: result.token,
    status: result.booking.status,
    checkoutUrl: result.checkoutUrl,
    booking: bookings.publicView(result.booking),
  });
});

// Status na terugkeer van de betaalpagina
router.get('/bookings/:code/status', lookupLimiter, async (req, res) => {
  let b = repo.getBookingByCode(req.params.code);
  if (!b || !bookings.verifyAccessToken(b, req.query.t)) throw new AppError('Boeking niet gevonden.', 404);
  if (b.status === 'pending_payment' || b.status === 'expired') {
    const open = db.prepare("SELECT provider_id FROM payments WHERE booking_id = ? AND status NOT IN ('paid') ORDER BY id DESC LIMIT 1").get(b.id);
    if (open) {
      try { await payments.syncPayment(open.provider_id); } catch (err) { console.error('[mollie] status ophalen mislukt', err.message); }
      b = repo.getBooking(b.id);
    }
  }
  const lastPayment = db.prepare('SELECT status FROM payments WHERE booking_id = ? ORDER BY id DESC LIMIT 1').get(b.id);
  const canRetry = b.status === 'pending_payment' && b.hold_expires_at > nowIso() && (!lastPayment || ['failed', 'canceled', 'expired'].includes(lastPayment.status));
  res.json({ booking: bookings.publicView(b), paymentStatus: lastPayment ? lastPayment.status : null, canRetry });
});

router.post('/bookings/:code/pay', bookingLimiter, async (req, res) => {
  const b = repo.getBookingByCode(req.params.code);
  if (!b || !bookings.verifyAccessToken(b, req.body.token)) throw new AppError('Boeking niet gevonden.', 404);
  if (b.status !== 'pending_payment' || !(b.hold_expires_at > nowIso())) {
    throw new AppError('Deze reservering is verlopen. Maak een nieuwe afspraak.', 409);
  }
  const open = db.prepare("SELECT checkout_url FROM payments WHERE booking_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(b.id);
  if (open && open.checkout_url) return res.json({ checkoutUrl: open.checkout_url });
  const checkoutUrl = await payments.startDepositPayment(b, req.body.token);
  res.json({ checkoutUrl });
});

router.get('/bookings/:code/ics', lookupLimiter, (req, res) => {
  const b = repo.getBookingByCode(req.params.code);
  if (!b || !bookings.verifyAccessToken(b, req.query.t) || b.status !== 'confirmed') throw new AppError('Boeking niet gevonden.', 404);
  const ics = require('../lib/ics');
  const s = settings.getAll();
  res.type('text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="afspraak-${b.code}.ics"`);
  res.send(ics.calendar([ics.eventLines(b, { audience: 'customer', salonName: s.salon_name, salonAddress: s.salon_address })], { method: 'PUBLISH' }));
});

// ---------- Mijn afspraak ----------

router.post('/manage/request', manageLimiter, async (req, res) => {
  const email = pricing.normalizeEmail(req.body.email);
  const code = String(req.body.code || '').trim().toUpperCase();
  const generic = { ok: true, message: 'Als de gegevens kloppen, hebben we een verificatiecode naar je e-mailadres gestuurd.' };
  if (!email || !/^[A-Z0-9]{4,12}$/.test(code)) throw new ValidationError('Vul je e-mailadres en boekingscode in.');
  const b = repo.getBookingByCode(code);
  if (!b || b.email.toLowerCase() !== email || !['confirmed', 'pending_payment', 'completed', 'cancelled'].includes(b.status)) {
    return res.json(generic);
  }
  // Maximaal 3 codes per kwartier per boeking
  const recent = db.prepare('SELECT COUNT(*) AS n FROM manage_verifications WHERE booking_id = ? AND created_at > ?')
    .get(b.id, new Date(Date.now() - 15 * 60_000).toISOString()).n;
  if (recent >= 3) return res.json(generic);
  const otp = numericCode(6);
  db.prepare('UPDATE manage_verifications SET used_at = ? WHERE booking_id = ? AND used_at IS NULL').run(nowIso(), b.id);
  db.prepare('INSERT INTO manage_verifications (booking_id, code_hash, expires_at, created_at) VALUES (?,?,?,?)')
    .run(b.id, hmac(`${b.id}:${otp}`), new Date(Date.now() + 10 * 60_000).toISOString(), nowIso());
  await emails.verificationCode(b, otp);
  res.json(generic);
});

router.post('/manage/verify', manageLimiter, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const otp = String(req.body.otp || '').replace(/\D/g, '');
  const fail = () => { throw new AppError('De verificatiecode is onjuist of verlopen.', 401); };
  const b = repo.getBookingByCode(code);
  if (!b || otp.length !== 6) fail();
  const v = db.prepare('SELECT * FROM manage_verifications WHERE booking_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1').get(b.id, nowIso());
  if (!v || v.attempts >= 5) fail();
  if (!safeEqual(v.code_hash, hmac(`${b.id}:${otp}`))) {
    db.prepare('UPDATE manage_verifications SET attempts = attempts + 1 WHERE id = ?').run(v.id);
    fail();
  }
  db.prepare('UPDATE manage_verifications SET used_at = ? WHERE id = ?').run(nowIso(), v.id);
  const token = randomToken(32);
  db.prepare('DELETE FROM manage_sessions WHERE expires_at < ?').run(nowIso());
  db.prepare('INSERT INTO manage_sessions (token_hash, booking_id, expires_at, created_at) VALUES (?,?,?,?)')
    .run(sha256(token), b.id, new Date(Date.now() + 30 * 60_000).toISOString(), nowIso());
  res.json({ token });
});

function manageView(b) {
  const view = bookings.publicView(b);
  const can = bookings.canCustomerChange(b);
  return {
    ...view,
    canChange: can.ok,
    changeBlockedReason: can.ok ? null : can.reason,
    canCancel: b.status === 'confirmed' && !view.terms.started,
    allowServiceChange: settings.get('allow_service_change'),
  };
}

router.get('/manage/booking', requireManage, (req, res) => {
  res.json({ booking: manageView(req.booking) });
});

router.post('/manage/change-quote', requireManage, (req, res) => {
  const service = repo.getService(Number(req.body.serviceId));
  if (!service) throw new ValidationError('Onbekende behandeling.');
  const q = bookings.changeQuote(req.booking, service);
  res.json({
    priceCents: q.priceCents, discount: q.discount, finalCents: q.finalCents,
    depositCents: q.depositCents, remainingCents: q.remainingCents, blocked: q.blocked, discountDropped: q.discountDropped,
  });
});

router.post('/manage/reschedule', requireManage, async (req, res) => {
  const updated = await bookings.reschedule(req.booking.id, {
    date: req.body.date, time: req.body.time, serviceId: req.body.serviceId,
  }, { actor: 'klant' });
  res.json({ booking: manageView(updated) });
});

router.post('/manage/cancel', requireManage, async (req, res) => {
  const result = await bookings.cancel(req.booking.id, { actor: 'klant', reason: req.body.reason });
  res.json({ booking: manageView(result.booking), refundCents: result.refundCents, feeCents: result.feeCents });
});

module.exports = router;
