'use strict';
const crypto = require('node:crypto');
const { db, nowIso } = require('../db');
const settings = require('./settings');
const availability = require('./availability');
const pricing = require('./pricing');
const repo = require('./repo');
const t = require('./time');
const calendarSync = require('./calendarSync');
const { emails } = require('./mailer');
const { AppError, ValidationError, cleanText } = require('./validate');
const { bookingCode, randomToken, sha256 } = require('./security');

// Per-boeking slot zodat gelijktijdige acties (bv. dubbel annuleren) elkaar niet kruisen.
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((r) => { release = r; });
  const chained = prev.then(() => current);
  locks.set(key, chained);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chained) locks.delete(key);
  }
}

function upsertCustomer(c) {
  const now = nowIso();
  const existing = db.prepare('SELECT id FROM customers WHERE email = ?').get(c.email);
  if (existing) {
    db.prepare('UPDATE customers SET first_name = ?, last_name = ?, phone = ?, phone_normalized = ?, updated_at = ? WHERE id = ?')
      .run(c.firstName, c.lastName, c.phone, c.phoneNormalized, now, existing.id);
    return existing.id;
  }
  return db.prepare('INSERT INTO customers (first_name, last_name, email, phone, phone_normalized, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(c.firstName, c.lastName, c.email, c.phone, c.phoneNormalized, now, now).lastInsertRowid;
}

function uniqueCode() {
  for (let i = 0; i < 20; i++) {
    const code = bookingCode(6);
    if (!db.prepare('SELECT 1 FROM bookings WHERE code = ?').get(code)) return code;
  }
  throw new Error('Kon geen unieke boekingscode maken');
}

function parseSlot(date, time) {
  if (!t.isValidDate(date)) throw new ValidationError('Kies een geldige datum.');
  if (!t.isValidTime(time)) throw new ValidationError('Kies een geldig tijdstip.');
  return t.toMinutes(time);
}

/**
 * Nieuwe boeking. Beschikbaarheid, korting en aanbetaling worden binnen één
 * exclusieve databasetransactie gecontroleerd, zodat dubbele boekingen onmogelijk zijn.
 */
async function createBooking(input, { source = 'online', actor = 'klant', force = false } = {}) {
  const customer = require('./validate').customer(input);
  const service = repo.getService(Number(input.serviceId), { includeInactive: source === 'admin' });
  if (!service) throw new ValidationError('Deze behandeling is niet (meer) beschikbaar.');
  const startMin = parseSlot(input.date, input.time);
  const notes = cleanText(input.notes, 500);
  const adminNotes = source === 'admin' ? cleanText(input.adminNotes, 1000) : '';
  const s = settings.getAll();

  const result = db.transaction(() => {
    if (source === 'online') {
      if (!availability.isSlotAvailable(input.date, startMin, service.duration_min)) {
        throw new AppError('Dit tijdstip is helaas net bezet geraakt. Kies een ander tijdstip.', 409, { code: 'slot_taken' });
      }
    } else {
      const check = availability.checkAdminSlot(input.date, startMin, service.duration_min);
      if (check.conflict && !force) throw new AppError('Dit tijdstip overlapt met een andere afspraak.', 409, { code: 'slot_taken' });
    }

    const q = pricing.quote({ service, discountCode: input.discountCode, email: customer.email, phone: customer.phoneNormalized });
    if (q.discountError) throw new AppError(q.discountError, 422, { code: 'discount_invalid' });

    const depositCents = source === 'online' ? q.depositCents : 0;
    const status = depositCents > 0 ? 'pending_payment' : 'confirmed';
    const customerId = upsertCustomer(customer);
    const token = randomToken(24);
    const now = nowIso();
    const code = uniqueCode();
    const id = db.prepare(`INSERT INTO bookings (code, uid, customer_id, service_id, service_name, duration_min, date, start_min, end_min, status,
        price_cents, discount_code_id, discount_code, discount_cents, final_price_cents, deposit_cents, notes, admin_notes, source,
        hold_expires_at, access_token_hash, confirmed_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      code, `${crypto.randomUUID()}@kapsalon-boekingen`, customerId, service.id, service.name, service.duration_min,
      input.date, startMin, startMin + service.duration_min, status,
      q.priceCents, q.discount ? q.discount.id : null, q.discount ? q.discount.code : null, q.discount ? q.discount.cents : 0,
      q.finalCents, depositCents, notes, adminNotes, source,
      status === 'pending_payment' ? new Date(Date.now() + s.hold_minutes * 60_000).toISOString() : null,
      sha256(token), status === 'confirmed' ? now : null, now, now,
    ).lastInsertRowid;
    repo.logEvent(id, 'created', source === 'admin' ? 'Handmatig aangemaakt door eigenaar' : 'Online geboekt', actor);
    if (q.discount) repo.logEvent(id, 'discount', `Kortingscode ${q.discount.code} toegepast (– ${t.formatEuro(q.discount.cents)})`, actor);
    return { id, token, status };
  }).immediate();

  let booking = repo.getBooking(result.id);
  let checkoutUrl = null;
  if (result.status === 'pending_payment') {
    try {
      checkoutUrl = await require('./payments').startDepositPayment(booking, result.token);
    } catch (err) {
      db.prepare("UPDATE bookings SET status = 'expired', hold_expires_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), booking.id);
      repo.logEvent(booking.id, 'payment_error', `Betaling starten mislukt: ${err.message}`);
      throw new AppError('De betaling kon niet worden gestart. Probeer het later opnieuw of neem contact op met de salon.', 502);
    }
  } else {
    await onConfirmed(booking, { sendEmail: source === 'online' || input.notifyCustomer !== false });
  }
  booking = repo.getBooking(result.id);
  return { booking, token: result.token, checkoutUrl };
}

async function onConfirmed(booking, { sendEmail = true } = {}) {
  calendarSync.queueSync(booking.id);
  if (sendEmail) await emails.bookingConfirmed(repo.getBooking(booking.id)).catch((e) => console.error(e));
}

/** Annuleringsvoorwaarden voor een boeking op dit moment */
function cancellationTerms(b, now = Date.now()) {
  const s = settings.getAll();
  const startTs = t.localToUtc(b.date, b.start_min);
  const deadlineTs = startTs - s.cancel_window_hours * 3_600_000;
  const inTime = now <= deadlineTs;
  const refundable = Math.max(0, b.deposit_paid_cents - b.refunded_cents);
  const refundCents = inTime ? refundable : Math.round((refundable * Math.min(100, Math.max(0, s.late_cancel_refund_pct))) / 100);
  return {
    inTime,
    deadline: new Date(deadlineTs).toISOString(),
    started: now >= startTs,
    refundCents,
    feeCents: refundable - refundCents,
    windowHours: s.cancel_window_hours,
    lateRefundPct: s.late_cancel_refund_pct,
  };
}

function canCustomerChange(b) {
  if (b.status !== 'confirmed') return { ok: false, reason: 'Deze afspraak kan niet meer worden gewijzigd.' };
  const terms = cancellationTerms(b);
  if (terms.started) return { ok: false, reason: 'Deze afspraak is al begonnen of voorbij.' };
  if (!terms.inTime) {
    return { ok: false, reason: `Wijzigen kan tot ${terms.windowHours} uur voor de afspraak. Neem contact op met de salon.` };
  }
  return { ok: true };
}

/** Prijsopbouw bij een (mogelijke) behandelingswijziging, met behoud van de oorspronkelijke kortingscode. */
function changeQuote(b, service) {
  const q = pricing.quote({ service, discountCode: b.discount_code, email: b.email, phone: b.phone, excludeBookingId: b.id });
  const requiredDeposit = q.depositCents;
  const paid = b.deposit_paid_cents - b.refunded_cents;
  let blocked = null;
  if (requiredDeposit > paid) blocked = 'Voor deze behandeling is een hogere aanbetaling nodig. Annuleer en boek opnieuw, of neem contact op met de salon.';
  else if (q.finalCents < paid) blocked = 'De prijs van deze behandeling is lager dan je aanbetaling. Neem contact op met de salon om te wijzigen.';
  return { ...q, depositCents: paid, remainingCents: q.finalCents - paid, blocked, discountDropped: Boolean(b.discount_code && !q.discount) };
}

async function reschedule(bookingId, { date, time, serviceId }, { actor = 'klant', isAdmin = false, force = false, notify = true } = {}) {
  return withLock(`b${bookingId}`, async () => {
    const b = repo.getBooking(bookingId);
    if (!b) throw new AppError('Afspraak niet gevonden.', 404);
    if (!isAdmin) {
      const can = canCustomerChange(b);
      if (!can.ok) throw new AppError(can.reason, 403);
    } else if (!['confirmed', 'pending_payment'].includes(b.status)) {
      throw new AppError('Alleen actieve afspraken kunnen worden verzet.', 400);
    }
    const startMin = parseSlot(date, time);
    let service = null;
    if (serviceId && Number(serviceId) !== b.service_id) {
      if (!isAdmin && !settings.get('allow_service_change')) throw new AppError('Het wijzigen van de behandeling is niet toegestaan.', 403);
      service = repo.getService(Number(serviceId), { includeInactive: isAdmin });
      if (!service) throw new ValidationError('Deze behandeling is niet beschikbaar.');
    }
    const duration = service ? service.duration_min : b.duration_min;
    const previous = `${t.formatDateLong(b.date)} om ${t.toHHMM(b.start_min)}`;

    db.transaction(() => {
      if (isAdmin) {
        const check = availability.checkAdminSlot(date, startMin, duration, b.id);
        if (check.conflict && !force) throw new AppError('Dit tijdstip overlapt met een andere afspraak.', 409, { code: 'slot_taken' });
      } else if (!availability.isSlotAvailable(date, startMin, duration, { excludeBookingId: b.id })) {
        throw new AppError('Dit tijdstip is niet (meer) beschikbaar. Kies een ander tijdstip.', 409, { code: 'slot_taken' });
      }
      const fields = { date, start_min: startMin, end_min: startMin + duration };
      if (service) {
        const q = changeQuote(b, service);
        if (q.blocked && !isAdmin) throw new AppError(q.blocked, 422);
        Object.assign(fields, {
          service_id: service.id, service_name: service.name, duration_min: service.duration_min,
          price_cents: q.priceCents, discount_cents: q.discount ? q.discount.cents : 0,
          discount_code_id: q.discount ? q.discount.id : null, discount_code: q.discount ? q.discount.code : null,
          final_price_cents: q.finalCents, deposit_cents: Math.max(q.depositCents, 0),
        });
      }
      const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE bookings SET ${sets}, sequence = sequence + 1, updated_at = @now WHERE id = @id`).run({ ...fields, now: nowIso(), id: b.id });
      repo.logEvent(b.id, 'rescheduled', `Verzet van ${previous} naar ${t.formatDateLong(date)} om ${time}${service ? ` (behandeling: ${service.name})` : ''}`, actor);
    }).immediate();

    const updated = repo.getBooking(b.id);
    if (updated.status === 'confirmed') {
      calendarSync.queueSync(b.id);
      if (notify) await emails.bookingRescheduled(updated, previous).catch((e) => console.error(e));
    }
    return updated;
  });
}

/**
 * Annuleren. refundMode: 'policy' (standaard), 'full', 'none' of 'custom' (refundCents).
 * De terugbetaling wordt eerst bij Mollie uitgevoerd; mislukt die, dan blijft de afspraak staan.
 */
async function cancel(bookingId, { actor = 'klant', isAdmin = false, refundMode = 'policy', refundCents: customRefund, reason = '', notify = true } = {}) {
  return withLock(`b${bookingId}`, async () => {
    const b = repo.getBooking(bookingId);
    if (!b) throw new AppError('Afspraak niet gevonden.', 404);
    if (['cancelled', 'expired'].includes(b.status)) throw new AppError('Deze afspraak is al geannuleerd.', 409);
    if (!isAdmin) {
      if (b.status !== 'confirmed') throw new AppError('Deze afspraak kan niet online worden geannuleerd.', 403);
      if (cancellationTerms(b).started) throw new AppError('Deze afspraak is al begonnen of voorbij.', 403);
      refundMode = 'policy';
    }
    const terms = cancellationTerms(b);
    const refundable = Math.max(0, b.deposit_paid_cents - b.refunded_cents);
    let refund = terms.refundCents;
    if (refundMode === 'full') refund = refundable;
    else if (refundMode === 'none') refund = 0;
    else if (refundMode === 'custom') refund = Math.max(0, Math.min(refundable, Math.round(Number(customRefund) || 0)));

    if (refund > 0) {
      await require('./payments').refundBooking(b, refund, `Annulering afspraak ${b.code}`);
    }
    const fee = refundable - refund;
    db.prepare(`UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, cancellation_fee_cents = ?,
        hold_expires_at = NULL, sequence = sequence + 1, updated_at = ? WHERE id = ?`)
      .run(nowIso(), isAdmin ? 'owner' : 'customer', cleanText(reason, 300), fee, nowIso(), b.id);
    repo.logEvent(b.id, 'cancelled', `Geannuleerd door ${isAdmin ? 'eigenaar' : 'klant'}${refund ? ` · ${t.formatEuro(refund)} terugbetaald` : ''}${fee ? ` · ${t.formatEuro(fee)} ingehouden` : ''}`, actor);

    const updated = repo.getBooking(b.id);
    calendarSync.queueSync(b.id);
    if (notify && b.status !== 'pending_payment') {
      await emails.bookingCancelled(updated, { refundCents: refund, feeCents: fee, byOwner: isAdmin }).catch((e) => console.error(e));
    }
    return { booking: updated, refundCents: refund, feeCents: fee };
  });
}

function verifyAccessToken(b, token) {
  if (!b || !b.access_token_hash || !token) return false;
  return require('./security').safeEqual(sha256(token), b.access_token_hash);
}

/** Publieke weergave van een boeking (geen interne velden) */
function publicView(b) {
  const terms = cancellationTerms(b);
  return {
    code: b.code,
    status: b.status,
    serviceId: b.service_id,
    serviceName: b.service_name,
    durationMin: b.duration_min,
    date: b.date,
    time: t.toHHMM(b.start_min),
    endTime: t.toHHMM(b.end_min),
    dateLabel: t.formatDateLong(b.date),
    firstName: b.first_name,
    lastName: b.last_name,
    email: b.email,
    phone: b.phone,
    notes: b.notes,
    priceCents: b.price_cents,
    discountCode: b.discount_code,
    discountCents: b.discount_cents,
    finalCents: b.final_price_cents,
    depositCents: b.deposit_cents,
    depositPaidCents: b.deposit_paid_cents,
    refundedCents: b.refunded_cents,
    remainingCents: Math.max(0, b.final_price_cents - b.deposit_paid_cents),
    cancellationFeeCents: b.cancellation_fee_cents,
    holdExpiresAt: b.hold_expires_at,
    terms,
  };
}

module.exports = {
  createBooking, reschedule, cancel, cancellationTerms, canCustomerChange, changeQuote,
  onConfirmed, verifyAccessToken, publicView, withLock, upsertCustomer,
};
