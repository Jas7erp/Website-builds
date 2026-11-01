'use strict';
const express = require('express');
const { db, nowIso } = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const settings = require('../lib/settings');
const availability = require('../lib/availability');
const pricing = require('../lib/pricing');
const bookings = require('../lib/bookings');
const payments = require('../lib/payments');
const repo = require('../lib/repo');
const t = require('../lib/time');
const mollie = require('../lib/mollie');
const mailer = require('../lib/mailer');
const caldav = require('../lib/caldav');
const calendarSync = require('../lib/calendarSync');
const { AppError, ValidationError, cleanText, EMAIL_RE } = require('../lib/validate');
const { rateLimiter, randomToken } = require('../lib/security');

const router = express.Router();
const loginLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 20, message: 'Te veel inlogpogingen. Probeer het later opnieuw.' });

// ---------- Authenticatie ----------
router.get('/setup-status', (req, res) => res.json({ hasAdmin: auth.hasAdmin() }));

router.post('/login', loginLimiter, (req, res) => {
  const r = auth.login(req.body.email, req.body.password, { ip: req.ip, userAgent: req.get('user-agent') });
  if (!r.ok) return res.status(401).json({ error: r.error });
  res.setHeader('Set-Cookie', auth.cookieString(r.token, auth.SESSION_HOURS * 3600));
  res.json({ admin: r.admin });
});

router.post('/logout', (req, res) => {
  auth.logout(req);
  res.setHeader('Set-Cookie', auth.cookieString('', 0));
  res.json({ ok: true });
});

router.use(auth.requireAdmin);

router.get('/me', (req, res) => res.json({ email: req.admin.email }));

router.post('/password', (req, res) => {
  try {
    auth.changePassword(req.admin.adminId, req.body.current, req.body.next, req.admin.sessionId);
  } catch (err) {
    throw new AppError(err.message, 400);
  }
  res.json({ ok: true });
});

// ---------- Hulpfuncties ----------
const STATUS_LABEL = {
  pending_payment: 'Wacht op betaling', confirmed: 'Bevestigd', completed: 'Afgerond',
  no_show: 'Niet verschenen', cancelled: 'Geannuleerd', expired: 'Verlopen',
};

function bookingRow(b) {
  return {
    id: b.id, code: b.code, status: b.status, statusLabel: STATUS_LABEL[b.status],
    date: b.date, start: t.toHHMM(b.start_min), end: t.toHHMM(b.end_min), startMin: b.start_min, endMin: b.end_min,
    serviceId: b.service_id, serviceName: b.service_name, durationMin: b.duration_min,
    customer: { name: `${b.first_name} ${b.last_name}`, firstName: b.first_name, lastName: b.last_name, email: b.email, phone: b.phone },
    priceCents: b.price_cents, discountCode: b.discount_code, discountCents: b.discount_cents, finalCents: b.final_price_cents,
    depositCents: b.deposit_cents, depositPaidCents: b.deposit_paid_cents, refundedCents: b.refunded_cents,
    remainingCents: Math.max(0, b.final_price_cents - b.deposit_paid_cents), remainingPaidAt: b.remaining_paid_at,
    cancellationFeeCents: b.cancellation_fee_cents,
    paymentStatus: paymentStatus(b),
    notes: b.notes, adminNotes: b.admin_notes, source: b.source, holdExpiresAt: b.hold_expires_at,
    cancelledAt: b.cancelled_at, cancelledBy: b.cancelled_by, cancelReason: b.cancel_reason,
    calSyncStatus: b.cal_sync_status, calSyncError: b.cal_sync_error, createdAt: b.created_at,
  };
}

function paymentStatus(b) {
  if (b.refunded_cents > 0) return b.refunded_cents >= b.deposit_paid_cents ? 'refunded' : 'partially_refunded';
  if (b.status === 'pending_payment') return 'awaiting_deposit';
  if (b.remaining_paid_at) return 'paid_in_full';
  if (b.deposit_cents > 0 && b.deposit_paid_cents >= b.deposit_cents) return 'deposit_paid';
  if (b.deposit_cents === 0) return 'pay_in_salon';
  return 'open';
}

function bookingDetail(id) {
  const b = repo.getBooking(id);
  if (!b) throw new AppError('Afspraak niet gevonden.', 404);
  const row = bookingRow(b);
  row.payments = db.prepare('SELECT provider_id, amount_cents, status, method, mode, paid_at, created_at FROM payments WHERE booking_id = ? ORDER BY id').all(id);
  row.refunds = db.prepare('SELECT provider_id, amount_cents, status, reason, created_at FROM refunds WHERE booking_id = ? ORDER BY id').all(id);
  row.events = db.prepare('SELECT type, message, actor, created_at FROM booking_events WHERE booking_id = ? ORDER BY id DESC').all(id);
  row.emails = db.prepare('SELECT kind, to_addr, subject, status, error, created_at FROM email_log WHERE booking_id = ? ORDER BY id DESC').all(id);
  row.terms = bookings.cancellationTerms(b);
  row.customerHistory = db.prepare(`SELECT id, code, date, start_min, service_name, status FROM bookings WHERE customer_id = ? AND id <> ? ORDER BY date DESC LIMIT 10`)
    .all(b.customer_id, id).map((h) => ({ ...h, start: t.toHHMM(h.start_min), statusLabel: STATUS_LABEL[h.status] }));
  row.customerStats = db.prepare(`SELECT COUNT(*) AS total, SUM(status = 'no_show') AS noShows, SUM(status = 'cancelled') AS cancelled FROM bookings WHERE customer_id = ?`).get(b.customer_id);
  return row;
}

function weekRange(date) {
  const wd = t.weekday(date);
  const monday = t.addDays(date, wd === 0 ? -6 : 1 - wd);
  return [monday, t.addDays(monday, 6)];
}

// ---------- Dashboard ----------
router.get('/dashboard', (req, res) => {
  const now = t.nowLocal();
  const nowTs = nowIso();
  const [weekStart, weekEnd] = weekRange(now.date);
  const visible = `(b.status IN ('confirmed','completed','no_show') OR (b.status = 'pending_payment' AND b.hold_expires_at > '${nowTs}'))`;
  const today = db.prepare(`${repo.BOOKING_SELECT} WHERE b.date = ? AND ${visible} ORDER BY b.start_min`).all(now.date).map(bookingRow);
  const upcoming = db.prepare(`${repo.BOOKING_SELECT} WHERE b.status = 'confirmed' AND (b.date > ? OR (b.date = ? AND b.start_min >= ?)) ORDER BY b.date, b.start_min LIMIT 8`)
    .all(now.date, now.date, now.minutes).map(bookingRow);
  const week = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(final_price_cents),0) AS revenue FROM bookings b WHERE b.date BETWEEN ? AND ? AND b.status IN ('confirmed','completed','no_show')`).get(weekStart, weekEnd);
  const cancelledSince = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const cancelled = db.prepare(`${repo.BOOKING_SELECT} WHERE b.status = 'cancelled' AND b.cancelled_at > ? ORDER BY b.cancelled_at DESC`).all(cancelledSince).map(bookingRow);
  const awaiting = db.prepare(`${repo.BOOKING_SELECT} WHERE b.status = 'pending_payment' AND b.hold_expires_at > ? ORDER BY b.created_at DESC`).all(nowTs).map(bookingRow);
  const toCollect = db.prepare(`${repo.BOOKING_SELECT} WHERE b.status = 'confirmed' AND b.remaining_paid_at IS NULL AND (b.date < ? OR (b.date = ? AND b.end_min <= ?)) ORDER BY b.date DESC, b.start_min DESC LIMIT 50`)
    .all(now.date, now.date, now.minutes).map(bookingRow);
  const pendingRefunds = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE status IN ('queued','pending','processing')").get();

  const warnings = [];
  if (!mollie.isConfigured()) warnings.push({ key: 'mollie', text: 'Online betalen is nog niet ingesteld. Behandelingen met een aanbetaling kunnen niet online worden geboekt.' });
  else if (mollie.mode() === 'test') warnings.push({ key: 'mollie', text: 'Mollie staat in testmodus. Gebruik een live-sleutel om echte betalingen te ontvangen.' });
  if (!mailer.isConfigured()) warnings.push({ key: 'email', text: 'E-mail is nog niet ingesteld. Klanten ontvangen geen bevestigingen.' });
  if (!calendarSync.isEnabled()) warnings.push({ key: 'calendar', text: 'Apple Agenda is nog niet gekoppeld.' });
  const calErrors = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE cal_sync_status = 'error'").get().n;
  if (calErrors && calendarSync.isEnabled()) warnings.push({ key: 'calendar', text: `${calErrors} afspraak/afspraken konden niet naar je agenda worden gesynchroniseerd.` });

  res.json({
    date: now.date, dateLabel: t.formatDateLong(now.date), status: availability.salonStatus(),
    today, upcoming,
    week: { count: week.n, revenueCents: week.revenue, from: weekStart, to: weekEnd },
    cancelled: { count: cancelled.length, recent: cancelled.slice(0, 5) },
    openPayments: {
      awaitingCount: awaiting.length, awaitingCents: awaiting.reduce((s, b) => s + b.depositCents - b.depositPaidCents, 0), awaiting,
      toCollectCount: toCollect.length, toCollectCents: toCollect.reduce((s, b) => s + b.remainingCents, 0), toCollect,
      pendingRefunds,
    },
    warnings,
  });
});

// ---------- Agenda / afspraken ----------
router.get('/bookings', (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!t.isValidDate(from) || !t.isValidDate(to) || t.diffDays(from, to) > 62 || to < from) throw new ValidationError('Ongeldige periode.');
  const includeCancelled = req.query.cancelled === '1';
  const statuses = includeCancelled
    ? "('pending_payment','confirmed','completed','no_show','cancelled')"
    : "('pending_payment','confirmed','completed','no_show')";
  const rows = db.prepare(`${repo.BOOKING_SELECT} WHERE b.date BETWEEN ? AND ? AND b.status IN ${statuses} ORDER BY b.date, b.start_min`).all(from, to)
    .filter((b) => b.status !== 'pending_payment' || b.hold_expires_at > nowIso());
  const days = [];
  for (let d = from; d <= to; d = t.addDays(d, 1)) {
    const s = availability.getDaySchedule(d);
    days.push({
      date: d, closed: s.closed,
      open: s.open.map(([a, b]) => [a, b]), windows: s.windows, breaks: s.breaks, blocks: s.blocks,
    });
  }
  res.json({ bookings: rows.map(bookingRow), days });
});

router.get('/search', (req, res) => {
  const q = cleanText(req.query.q, 80);
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = db.prepare(`${repo.BOOKING_SELECT} WHERE b.status <> 'expired' AND (b.code LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR (c.first_name || ' ' || c.last_name) LIKE ?)
      ORDER BY b.date DESC LIMIT 25`).all(like, like, like, like);
  res.json({ results: rows.map(bookingRow) });
});

router.get('/bookings/:id', (req, res) => res.json({ booking: bookingDetail(Number(req.params.id)) }));

router.get('/slots', (req, res) => {
  const date = String(req.query.date || '');
  const service = repo.getService(Number(req.query.service), { includeInactive: true });
  if (!t.isValidDate(date) || !service) throw new ValidationError('Ongeldige aanvraag.');
  const duration = Number(req.query.duration) || service.duration_min;
  const slots = availability.getSlots(date, duration, { excludeBookingId: Number(req.query.exclude) || null, enforceLimits: false });
  res.json({ slots: slots.map(t.toHHMM) });
});

router.post('/bookings', async (req, res) => {
  const b = req.body;
  const result = await bookings.createBooking({
    serviceId: b.serviceId, date: b.date, time: b.time, firstName: b.firstName, lastName: b.lastName,
    email: b.email, phone: b.phone, notes: b.notes, adminNotes: b.adminNotes, discountCode: b.discountCode,
    notifyCustomer: b.notifyCustomer !== false,
  }, { source: 'admin', actor: 'eigenaar', force: Boolean(b.force) });
  res.status(201).json({ booking: bookingDetail(result.booking.id) });
});

router.post('/bookings/:id/reschedule', async (req, res) => {
  const updated = await bookings.reschedule(Number(req.params.id), {
    date: req.body.date, time: req.body.time, serviceId: req.body.serviceId,
  }, { actor: 'eigenaar', isAdmin: true, force: Boolean(req.body.force), notify: req.body.notify !== false });
  res.json({ booking: bookingDetail(updated.id) });
});

router.post('/bookings/:id/cancel', async (req, res) => {
  const mode = ['policy', 'full', 'none', 'custom'].includes(req.body.refundMode) ? req.body.refundMode : 'full';
  const r = await bookings.cancel(Number(req.params.id), {
    actor: 'eigenaar', isAdmin: true, refundMode: mode, refundCents: req.body.refundCents,
    reason: req.body.reason, notify: req.body.notify !== false,
  });
  res.json({ booking: bookingDetail(r.booking.id), refundCents: r.refundCents });
});

router.post('/bookings/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const b = repo.getBooking(id);
  if (!b) throw new AppError('Afspraak niet gevonden.', 404);
  const status = req.body.status;
  if (!['confirmed', 'completed', 'no_show'].includes(status)) throw new ValidationError('Ongeldige status.');
  if (!['confirmed', 'completed', 'no_show'].includes(b.status)) throw new AppError('De status van deze afspraak kan niet worden gewijzigd.', 400);
  const remainingPaid = status === 'completed' ? (req.body.remainingPaid === false ? null : nowIso()) : null;
  db.prepare('UPDATE bookings SET status = ?, remaining_paid_at = ?, updated_at = ? WHERE id = ?').run(status, remainingPaid, nowIso(), id);
  repo.logEvent(id, 'status', `Status gewijzigd naar "${STATUS_LABEL[status]}"${remainingPaid ? ' · restbedrag ontvangen' : ''}`, 'eigenaar');
  calendarSync.queueSync(id);
  res.json({ booking: bookingDetail(id) });
});

router.patch('/bookings/:id', (req, res) => {
  const id = Number(req.params.id);
  const b = repo.getBooking(id);
  if (!b) throw new AppError('Afspraak niet gevonden.', 404);
  if ('adminNotes' in req.body) db.prepare('UPDATE bookings SET admin_notes = ?, updated_at = ? WHERE id = ?').run(cleanText(req.body.adminNotes, 1000), nowIso(), id);
  if (req.body.customer) {
    const c = require('../lib/validate').customer(req.body.customer);
    const clash = db.prepare('SELECT id FROM customers WHERE email = ? AND id <> ?').get(c.email, b.customer_id);
    if (clash) throw new AppError('Er bestaat al een andere klant met dit e-mailadres.', 409);
    db.prepare('UPDATE customers SET first_name = ?, last_name = ?, email = ?, phone = ?, phone_normalized = ?, updated_at = ? WHERE id = ?')
      .run(c.firstName, c.lastName, c.email, c.phone, c.phoneNormalized, nowIso(), b.customer_id);
    repo.logEvent(id, 'customer', 'Klantgegevens bijgewerkt', 'eigenaar');
    calendarSync.queueSync(id);
  }
  res.json({ booking: bookingDetail(id) });
});

router.post('/bookings/:id/refund', async (req, res) => {
  const id = Number(req.params.id);
  const b = repo.getBooking(id);
  if (!b) throw new AppError('Afspraak niet gevonden.', 404);
  const amount = Math.round(Number(req.body.amountCents));
  if (!(amount > 0)) throw new ValidationError('Vul een bedrag in.');
  await bookings.withLock(`b${id}`, () => payments.refundBooking(b, amount, `Terugbetaling afspraak ${b.code}`));
  res.json({ booking: bookingDetail(id) });
});

router.post('/bookings/:id/resend', async (req, res) => {
  const b = repo.getBooking(Number(req.params.id));
  if (!b || b.status !== 'confirmed') throw new AppError('Alleen bevestigde afspraken kunnen opnieuw worden verstuurd.', 400);
  await mailer.emails.bookingConfirmed(b);
  res.json({ booking: bookingDetail(b.id) });
});

router.post('/bookings/:id/sync', async (req, res) => {
  const result = await calendarSync.syncBooking(Number(req.params.id));
  res.json({ result, booking: bookingDetail(Number(req.params.id)) });
});

router.post('/bookings/:id/check-payment', async (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare("SELECT provider_id FROM payments WHERE booking_id = ? AND status <> 'paid'").all(id);
  for (const r of rows) await payments.syncPayment(r.provider_id);
  res.json({ booking: bookingDetail(id) });
});

// ---------- Behandelingen ----------
function serviceInput(body) {
  const name = cleanText(body.name, 80);
  if (!name) throw new ValidationError('Vul een naam in.');
  const duration = Number(body.durationMin);
  if (!Number.isInteger(duration) || duration < 5 || duration > 600) throw new ValidationError('De behandeltijd moet tussen 5 en 600 minuten liggen.');
  const price = Math.round(Number(body.priceCents));
  if (!Number.isFinite(price) || price < 0 || price > 10_000_00) throw new ValidationError('Ongeldige prijs.');
  const depositType = ['none', 'fixed', 'percent'].includes(body.depositType) ? body.depositType : 'none';
  let depositValue = Math.round(Number(body.depositValue) || 0);
  if (depositType === 'percent' && (depositValue < 1 || depositValue > 100)) throw new ValidationError('Het aanbetalingspercentage moet tussen 1 en 100 liggen.');
  if (depositType === 'fixed' && (depositValue < 100 || depositValue > price)) throw new ValidationError('De vaste aanbetaling moet minimaal € 1,00 en maximaal de prijs zijn.');
  if (depositType === 'none') depositValue = 0;
  return {
    name, description: cleanText(body.description, 300), duration_min: duration, price_cents: price,
    deposit_type: depositType, deposit_value: depositValue, active: body.active === false ? 0 : 1,
    sort_order: Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
  };
}

function serviceOut(s) {
  const stats = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE service_id = ? AND status IN ('confirmed','pending_payment') AND date >= ?").get(s.id, t.nowLocal().date);
  return {
    id: s.id, name: s.name, description: s.description, durationMin: s.duration_min, priceCents: s.price_cents,
    depositType: s.deposit_type, depositValue: s.deposit_value, depositCents: pricing.computeDeposit(s, s.price_cents),
    active: Boolean(s.active), sortOrder: s.sort_order, upcomingBookings: stats.n,
  };
}

router.get('/services', (req, res) => {
  res.json({ services: db.prepare('SELECT * FROM services WHERE deleted_at IS NULL ORDER BY sort_order, name').all().map(serviceOut) });
});

router.post('/services', (req, res) => {
  const v = serviceInput(req.body);
  const now = nowIso();
  const id = db.prepare(`INSERT INTO services (name, description, duration_min, price_cents, deposit_type, deposit_value, active, sort_order, created_at, updated_at)
      VALUES (@name, @description, @duration_min, @price_cents, @deposit_type, @deposit_value, @active, @sort_order, @now, @now)`).run({ ...v, now }).lastInsertRowid;
  res.status(201).json({ service: serviceOut(repo.getService(id, { includeInactive: true })) });
});

router.put('/services/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!repo.getService(id, { includeInactive: true })) throw new AppError('Behandeling niet gevonden.', 404);
  const v = serviceInput(req.body);
  db.prepare(`UPDATE services SET name=@name, description=@description, duration_min=@duration_min, price_cents=@price_cents, deposit_type=@deposit_type,
      deposit_value=@deposit_value, active=@active, sort_order=@sort_order, updated_at=@now WHERE id=@id`).run({ ...v, now: nowIso(), id });
  res.json({ service: serviceOut(repo.getService(id, { includeInactive: true })) });
});

router.delete('/services/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!repo.getService(id, { includeInactive: true })) throw new AppError('Behandeling niet gevonden.', 404);
  const used = db.prepare('SELECT COUNT(*) AS n FROM bookings WHERE service_id = ?').get(id).n;
  // Gebruikte behandelingen blijven bewaard voor de historie (zacht verwijderen)
  if (used) db.prepare('UPDATE services SET deleted_at = ?, active = 0 WHERE id = ?').run(nowIso(), id);
  else db.prepare('DELETE FROM services WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------- Openingstijden en beschikbaarheid ----------
function timeOrThrow(v, label) {
  if (!t.isValidTime(v)) throw new ValidationError(`Ongeldige tijd bij ${label}.`);
  return v;
}

router.get('/schedule', (req, res) => {
  const today = t.nowLocal().date;
  res.json({
    hours: db.prepare('SELECT * FROM opening_hours ORDER BY weekday').all().map((h) => ({ weekday: h.weekday, isOpen: Boolean(h.is_open), open: h.open_time, close: h.close_time })),
    breaks: db.prepare('SELECT * FROM breaks ORDER BY weekday, start_time').all().map((b) => ({ id: b.id, weekday: b.weekday, start: b.start_time, end: b.end_time, label: b.label })),
    exceptions: db.prepare('SELECT * FROM availability_exceptions WHERE end_date >= ? ORDER BY start_date, start_time').all(today)
      .map((e) => ({ id: e.id, type: e.type, startDate: e.start_date, endDate: e.end_date, start: e.start_time, end: e.end_time, label: e.label })),
  });
});

router.put('/schedule/hours', (req, res) => {
  const hours = Array.isArray(req.body.hours) ? req.body.hours : [];
  if (hours.length !== 7) throw new ValidationError('Geef de openingstijden voor alle 7 dagen op.');
  const upd = db.prepare('INSERT INTO opening_hours (weekday, is_open, open_time, close_time) VALUES (?,?,?,?) ON CONFLICT(weekday) DO UPDATE SET is_open=excluded.is_open, open_time=excluded.open_time, close_time=excluded.close_time');
  db.transaction(() => {
    for (const h of hours) {
      const wd = Number(h.weekday);
      if (!(wd >= 0 && wd <= 6)) throw new ValidationError('Ongeldige dag.');
      const open = timeOrThrow(h.open, 'openingstijd');
      const close = timeOrThrow(h.close, 'sluitingstijd');
      if (h.isOpen && t.toMinutes(close) <= t.toMinutes(open)) throw new ValidationError('De sluitingstijd moet na de openingstijd liggen.');
      upd.run(wd, h.isOpen ? 1 : 0, open, close);
    }
  })();
  res.json({ ok: true });
});

router.post('/schedule/breaks', (req, res) => {
  const wd = Number(req.body.weekday);
  if (!(wd >= 0 && wd <= 6)) throw new ValidationError('Ongeldige dag.');
  const start = timeOrThrow(req.body.start, 'begin pauze');
  const end = timeOrThrow(req.body.end, 'einde pauze');
  if (t.toMinutes(end) <= t.toMinutes(start)) throw new ValidationError('Het einde van de pauze moet na het begin liggen.');
  const id = db.prepare('INSERT INTO breaks (weekday, start_time, end_time, label) VALUES (?,?,?,?)').run(wd, start, end, cleanText(req.body.label, 40) || 'Pauze').lastInsertRowid;
  res.status(201).json({ id });
});

router.delete('/schedule/breaks/:id', (req, res) => {
  db.prepare('DELETE FROM breaks WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/schedule/exceptions', (req, res) => {
  const type = req.body.type;
  if (!['closed', 'block', 'extra'].includes(type)) throw new ValidationError('Ongeldig type.');
  const startDate = req.body.startDate;
  const endDate = type === 'closed' ? (req.body.endDate || startDate) : startDate;
  if (!t.isValidDate(startDate) || !t.isValidDate(endDate) || endDate < startDate) throw new ValidationError('Ongeldige datum(s).');
  if (t.diffDays(startDate, endDate) > 366) throw new ValidationError('De periode mag maximaal een jaar zijn.');
  let start = null;
  let end = null;
  if (type !== 'closed') {
    start = timeOrThrow(req.body.start, 'begintijd');
    end = timeOrThrow(req.body.end, 'eindtijd');
    if (t.toMinutes(end) <= t.toMinutes(start)) throw new ValidationError('De eindtijd moet na de begintijd liggen.');
  }
  const id = db.prepare('INSERT INTO availability_exceptions (type, start_date, end_date, start_time, end_time, label, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(type, startDate, endDate, start, end, cleanText(req.body.label, 80), nowIso()).lastInsertRowid;
  // Waarschuwing als er al afspraken in een gesloten periode vallen
  let conflicts = [];
  if (type !== 'extra') {
    conflicts = db.prepare(`${repo.BOOKING_SELECT} WHERE b.date BETWEEN ? AND ? AND b.status IN ('confirmed','pending_payment')`).all(startDate, endDate)
      .filter((b) => type === 'closed' || (b.start_min < t.toMinutes(end) && b.end_min > t.toMinutes(start)))
      .map(bookingRow);
  }
  res.status(201).json({ id, conflicts });
});

router.delete('/schedule/exceptions/:id', (req, res) => {
  db.prepare('DELETE FROM availability_exceptions WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Kortingscodes ----------
function discountStats(id) {
  return db.prepare(`SELECT COUNT(*) AS uses, COALESCE(SUM(discount_cents),0) AS total FROM bookings
      WHERE discount_code_id = ? AND status IN ('confirmed','completed','no_show')`).get(id);
}

function discountOut(c) {
  const stats = discountStats(c.id);
  return {
    id: c.id, code: c.code, description: c.description, discountType: c.discount_type, discountValue: c.discount_value,
    startsOn: c.starts_on, expiresOn: c.expires_on, maxUses: c.max_uses, oncePerCustomer: Boolean(c.once_per_customer),
    minAmountCents: c.min_amount_cents, appliesToAll: Boolean(c.applies_to_all), active: Boolean(c.active),
    serviceIds: pricing.codeServices(c.id), state: pricing.codeState(c), uses: stats.uses, totalDiscountCents: stats.total,
    createdAt: c.created_at,
  };
}

function discountInput(body) {
  const code = pricing.normalizeCode(body.code);
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new ValidationError('De code mag alleen letters, cijfers, - en _ bevatten (3–40 tekens).');
  const type = body.discountType === 'fixed' ? 'fixed' : 'percent';
  const value = Math.round(Number(body.discountValue));
  if (type === 'percent' && !(value >= 1 && value <= 100)) throw new ValidationError('Het percentage moet tussen 1 en 100 liggen.');
  if (type === 'fixed' && !(value >= 1 && value <= 10_000_00)) throw new ValidationError('Ongeldig kortingsbedrag.');
  const startsOn = body.startsOn || null;
  const expiresOn = body.expiresOn || null;
  if (startsOn && !t.isValidDate(startsOn)) throw new ValidationError('Ongeldige startdatum.');
  if (expiresOn && !t.isValidDate(expiresOn)) throw new ValidationError('Ongeldige vervaldatum.');
  if (startsOn && expiresOn && expiresOn < startsOn) throw new ValidationError('De vervaldatum ligt voor de startdatum.');
  let maxUses = body.maxUses === '' || body.maxUses == null ? null : Number(body.maxUses);
  if (maxUses != null && !(Number.isInteger(maxUses) && maxUses >= 1)) throw new ValidationError('Het maximale aantal keer gebruiken moet 1 of meer zijn.');
  const minAmount = Math.max(0, Math.round(Number(body.minAmountCents) || 0));
  const appliesToAll = body.appliesToAll !== false;
  const serviceIds = appliesToAll ? [] : (Array.isArray(body.serviceIds) ? body.serviceIds.map(Number).filter(Number.isInteger) : []);
  if (!appliesToAll && !serviceIds.length) throw new ValidationError('Kies minimaal één behandeling.');
  return {
    code, description: cleanText(body.description, 200), discount_type: type, discount_value: value,
    starts_on: startsOn, expires_on: expiresOn, max_uses: maxUses, once_per_customer: body.oncePerCustomer ? 1 : 0,
    min_amount_cents: minAmount, applies_to_all: appliesToAll ? 1 : 0, active: body.active === false ? 0 : 1, serviceIds,
  };
}

function saveDiscountServices(codeId, ids) {
  db.prepare('DELETE FROM discount_code_services WHERE code_id = ?').run(codeId);
  const ins = db.prepare('INSERT OR IGNORE INTO discount_code_services (code_id, service_id) SELECT ?, id FROM services WHERE id = ?');
  for (const sid of ids) ins.run(codeId, sid);
}

router.get('/discounts', (req, res) => {
  res.json({ discounts: db.prepare('SELECT * FROM discount_codes ORDER BY created_at DESC').all().map(discountOut) });
});

router.get('/discounts/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(Number(req.params.id));
  if (!c) throw new AppError('Kortingscode niet gevonden.', 404);
  const used = db.prepare(`${repo.BOOKING_SELECT} WHERE b.discount_code_id = ? AND b.status NOT IN ('expired') ORDER BY b.date DESC`).all(c.id).map(bookingRow);
  res.json({ discount: discountOut(c), bookings: used });
});

router.post('/discounts', (req, res) => {
  const v = discountInput(req.body);
  if (db.prepare('SELECT 1 FROM discount_codes WHERE code = ?').get(v.code)) throw new AppError('Deze code bestaat al.', 409);
  const now = nowIso();
  const id = db.transaction(() => {
    const newId = db.prepare(`INSERT INTO discount_codes (code, description, discount_type, discount_value, starts_on, expires_on, max_uses, once_per_customer,
        min_amount_cents, applies_to_all, active, created_at, updated_at) VALUES (@code,@description,@discount_type,@discount_value,@starts_on,@expires_on,
        @max_uses,@once_per_customer,@min_amount_cents,@applies_to_all,@active,@now,@now)`).run({ ...v, now }).lastInsertRowid;
    saveDiscountServices(newId, v.serviceIds);
    return newId;
  })();
  res.status(201).json({ discount: discountOut(db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id)) });
});

router.put('/discounts/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM discount_codes WHERE id = ?').get(id)) throw new AppError('Kortingscode niet gevonden.', 404);
  const v = discountInput(req.body);
  if (db.prepare('SELECT 1 FROM discount_codes WHERE code = ? AND id <> ?').get(v.code, id)) throw new AppError('Deze code bestaat al.', 409);
  db.transaction(() => {
    db.prepare(`UPDATE discount_codes SET code=@code, description=@description, discount_type=@discount_type, discount_value=@discount_value,
        starts_on=@starts_on, expires_on=@expires_on, max_uses=@max_uses, once_per_customer=@once_per_customer, min_amount_cents=@min_amount_cents,
        applies_to_all=@applies_to_all, active=@active, updated_at=@now WHERE id=@id`).run({ ...v, now: nowIso(), id });
    saveDiscountServices(id, v.serviceIds);
  })();
  res.json({ discount: discountOut(db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id)) });
});

router.post('/discounts/:id/toggle', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE discount_codes SET active = ?, updated_at = ? WHERE id = ?').run(req.body.active ? 1 : 0, nowIso(), id);
  const c = db.prepare('SELECT * FROM discount_codes WHERE id = ?').get(id);
  if (!c) throw new AppError('Kortingscode niet gevonden.', 404);
  res.json({ discount: discountOut(c) });
});

router.delete('/discounts/:id', (req, res) => {
  // Boekingen behouden de code als tekst (discount_code), de koppeling vervalt.
  db.prepare('DELETE FROM discount_codes WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Betalingen ----------
router.get('/payments', (req, res) => {
  const filter = req.query.filter;
  let where = '1=1';
  if (filter === 'open') where = "p.status IN ('open','pending','authorized')";
  else if (filter === 'paid') where = "p.status = 'paid'";
  else if (filter === 'failed') where = "p.status IN ('failed','canceled','expired')";
  const rows = db.prepare(`SELECT p.*, b.code, b.id AS booking_id, b.date, b.start_min, b.service_name, b.status AS booking_status, b.refunded_cents,
        c.first_name, c.last_name
      FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN customers c ON c.id = b.customer_id
      WHERE ${where} ORDER BY p.id DESC LIMIT 300`).all();
  const refunds = db.prepare(`SELECT r.*, b.code, b.id AS booking_id, c.first_name, c.last_name FROM refunds r JOIN bookings b ON b.id = r.booking_id
      JOIN customers c ON c.id = b.customer_id ORDER BY r.id DESC LIMIT 100`).all();
  const summary = db.prepare(`SELECT
      COALESCE((SELECT SUM(amount_cents) FROM payments WHERE status = 'paid'),0) AS received,
      COALESCE((SELECT SUM(amount_cents) FROM refunds WHERE status NOT IN ('failed','canceled')),0) AS refunded,
      COALESCE((SELECT SUM(cancellation_fee_cents) FROM bookings WHERE status = 'cancelled'),0) AS retained,
      (SELECT COUNT(*) FROM payments WHERE status IN ('open','pending','authorized')) AS openCount`).get();
  res.json({
    summary, mollieMode: mollie.mode(),
    payments: rows.map((p) => ({
      id: p.id, providerId: p.provider_id, amountCents: p.amount_cents, status: p.status, method: p.method, mode: p.mode, paidAt: p.paid_at,
      createdAt: p.created_at, bookingId: p.booking_id, bookingCode: p.code, bookingStatus: p.booking_status,
      date: p.date, start: t.toHHMM(p.start_min), serviceName: p.service_name, customer: `${p.first_name} ${p.last_name}`,
    })),
    refunds: refunds.map((r) => ({
      providerId: r.provider_id, amountCents: r.amount_cents, status: r.status, reason: r.reason, createdAt: r.created_at,
      bookingId: r.booking_id, bookingCode: r.code, customer: `${r.first_name} ${r.last_name}`,
    })),
  });
});

router.post('/payments/reconcile', async (req, res) => {
  await payments.reconcile();
  res.json({ ok: true });
});

// ---------- Instellingen ----------
const GENERAL_KEYS = ['salon_name', 'salon_tagline', 'salon_logo', 'salon_email', 'salon_phone', 'salon_address', 'accent_color',
  'slot_interval_min', 'min_notice_min', 'max_days_ahead', 'buffer_min', 'hold_minutes', 'allow_service_change', 'booking_notes_enabled',
  'cancel_window_hours', 'late_cancel_refund_pct', 'policy_text', 'owner_notify_email', 'owner_notify_enabled',
  'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_from', 'caldav_on_cancel'];
const SECRET_INPUTS = ['mollie_api_key', 'smtp_pass'];

function settingsOut() {
  const all = settings.getAll();
  const out = {};
  for (const k of GENERAL_KEYS) out[k] = all[k];
  out.mollie_api_key_set = Boolean(all.mollie_api_key);
  out.mollie_mode = mollie.mode();
  out.mollie_api_key_hint = all.mollie_api_key ? `${all.mollie_api_key.slice(0, 5)}••••${all.mollie_api_key.slice(-4)}` : '';
  out.smtp_pass_set = Boolean(all.smtp_pass);
  out.email_configured = mailer.isConfigured();
  out.public_url = config.publicUrl;
  out.webhook_reachable = !/^https?:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(config.publicUrl);
  return out;
}

const RANGES = {
  slot_interval_min: [5, 120], min_notice_min: [0, 60 * 24 * 14], max_days_ahead: [1, 365], buffer_min: [0, 120],
  hold_minutes: [10, 60], cancel_window_hours: [0, 24 * 14], late_cancel_refund_pct: [0, 100], smtp_port: [1, 65535],
};

router.get('/settings', (req, res) => res.json({ settings: settingsOut() }));

router.put('/settings', (req, res) => {
  const body = req.body || {};
  const update = {};
  for (const k of GENERAL_KEYS) {
    if (!(k in body)) continue;
    let v = body[k];
    const def = settings.DEFS[k];
    if (def.type === 'int') {
      v = Number(v);
      const [min, max] = RANGES[k] || [0, 1e9];
      if (!Number.isInteger(v) || v < min || v > max) throw new ValidationError(`Ongeldige waarde voor ${k.replace(/_/g, ' ')} (${min}–${max}).`);
    } else if (def.type === 'bool') {
      v = Boolean(v);
    } else {
      v = k === 'salon_logo' ? String(v || '') : cleanText(v, k === 'policy_text' ? 1500 : 200);
    }
    if (k === 'salon_name' && !v) throw new ValidationError('Vul de naam van de salon in.');
    if (k === 'salon_logo' && v && (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 400_000)) {
      throw new ValidationError('Het logo moet een PNG, JPG, WEBP of SVG van maximaal 300 kB zijn.');
    }
    if (['salon_email', 'owner_notify_email'].includes(k) && v && !EMAIL_RE.test(v)) throw new ValidationError('Ongeldig e-mailadres.');
    if (k === 'caldav_on_cancel' && !['delete', 'mark'].includes(v)) throw new ValidationError('Ongeldige keuze.');
    update[k] = v;
  }
  for (const k of SECRET_INPUTS) {
    if (typeof body[k] === 'string' && body[k].trim()) update[k] = body[k].trim();
    if (body[`${k}_clear`]) update[k] = '';
  }
  if (update.mollie_api_key && !/^(live|test)_[A-Za-z0-9]{20,}$/.test(update.mollie_api_key)) {
    throw new ValidationError('Een Mollie API-sleutel begint met live_ of test_.');
  }
  settings.set(update);
  res.json({ settings: settingsOut() });
});

router.post('/settings/test-mollie', async (req, res) => {
  const key = (req.body.key && String(req.body.key).trim()) || settings.get('mollie_api_key');
  if (!key) throw new ValidationError('Vul eerst een API-sleutel in.');
  try {
    const methods = await mollie.testKey(key);
    res.json({ ok: true, mode: key.startsWith('live_') ? 'live' : 'test', methods });
  } catch (err) {
    throw new AppError(`Verbinding met Mollie mislukt: ${err.message}`, 400);
  }
});

router.post('/settings/test-email', async (req, res) => {
  const to = String(req.body.to || '').trim() || settings.get('owner_notify_email') || settings.get('salon_email') || req.admin.email;
  try {
    await mailer.emails.test(to);
  } catch (err) {
    throw new AppError(`Testmail versturen mislukt: ${err.message}`, 400);
  }
  res.json({ ok: true, to });
});

router.get('/email-log', (req, res) => {
  res.json({ emails: db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 100').all() });
});

// ---------- Apple Agenda (CalDAV) & ICS-feed ----------
function calendarOut() {
  const s = settings.getAll();
  const token = settings.icsFeedToken();
  const feedUrl = `${config.publicUrl}/agenda/${token}.ics`;
  return {
    enabled: s.caldav_enabled, connected: calendarSync.isEnabled(), serverUrl: s.caldav_server_url, username: s.caldav_username,
    passwordSet: Boolean(s.caldav_password), calendarUrl: s.caldav_calendar_url, calendarName: s.caldav_calendar_name,
    onCancel: s.caldav_on_cancel, lastOk: s.caldav_last_ok, lastError: s.caldav_last_error,
    errorCount: db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE cal_sync_status = 'error'").get().n,
    feedUrl, webcalUrl: feedUrl.replace(/^https?:\/\//, 'webcal://'),
  };
}

router.get('/calendar', (req, res) => res.json({ calendar: calendarOut() }));

router.post('/calendar/discover', async (req, res) => {
  const serverUrl = String(req.body.serverUrl || 'https://caldav.icloud.com').trim();
  if (!/^https:\/\//.test(serverUrl) && !(process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.)/.test(serverUrl))) {
    throw new ValidationError('De serverURL moet met https:// beginnen.');
  }
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '').trim() || settings.get('caldav_password');
  if (!username || !password) throw new ValidationError('Vul je Apple ID en app-specifieke wachtwoord in.');
  let result;
  try {
    result = await caldav.discoverCalendars({ serverUrl, username, password });
  } catch (err) {
    throw new AppError(err.message, 400);
  }
  settings.set({ caldav_server_url: serverUrl, caldav_username: username, caldav_password: password });
  res.json({ calendars: result.calendars });
});

router.post('/calendar/connect', async (req, res) => {
  const url = String(req.body.calendarUrl || '');
  if (!/^https?:\/\//.test(url)) throw new ValidationError('Kies een agenda.');
  settings.set({
    caldav_calendar_url: url, caldav_calendar_name: cleanText(req.body.calendarName, 120), caldav_enabled: true,
    caldav_on_cancel: req.body.onCancel === 'mark' ? 'mark' : 'delete',
  });
  // Testitem plaatsen en verwijderen om schrijfrechten te controleren
  const s = settings.getAll();
  const uid = `test-${randomToken(8)}@kapsalon-boekingen`;
  try {
    const ics = require('../lib/ics');
    const now = Date.now();
    const stamp = (ts) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const body = ics.calendar([[ 'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(now + 86_400_000)}`, `DTEND:${stamp(now + 86_400_000 + 900_000)}`, 'SUMMARY:Test boekingsportaal', 'END:VEVENT' ]]);
    const { href } = await caldav.putEvent({ calendarUrl: url, username: s.caldav_username, password: s.caldav_password, uid, ics: body });
    await caldav.deleteEvent({ href, username: s.caldav_username, password: s.caldav_password });
  } catch (err) {
    settings.set({ caldav_enabled: false });
    throw new AppError(`Kan niet naar deze agenda schrijven: ${err.message}`, 400);
  }
  settings.set({ caldav_last_ok: nowIso(), caldav_last_error: '' });
  const result = await calendarSync.resyncAll();
  res.json({ calendar: calendarOut(), synced: result });
});

router.post('/calendar/resync', async (req, res) => {
  if (!calendarSync.isEnabled()) throw new AppError('Er is geen agenda gekoppeld.', 400);
  const result = await calendarSync.resyncAll();
  res.json({ calendar: calendarOut(), synced: result });
});

router.post('/calendar/settings', (req, res) => {
  settings.set({ caldav_on_cancel: req.body.onCancel === 'mark' ? 'mark' : 'delete' });
  res.json({ calendar: calendarOut() });
});

router.post('/calendar/disconnect', (req, res) => {
  settings.set({ caldav_enabled: false, caldav_calendar_url: '', caldav_calendar_name: '', caldav_password: '', caldav_last_error: '' });
  res.json({ calendar: calendarOut() });
});

router.post('/calendar/feed/regenerate', (req, res) => {
  settings.set({ ics_feed_token: randomToken(24) });
  res.json({ calendar: calendarOut() });
});

module.exports = router;
