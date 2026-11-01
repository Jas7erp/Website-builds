'use strict';
const { db, nowIso } = require('../db');
const config = require('../config');
const mollie = require('./mollie');
const repo = require('./repo');
const availability = require('./availability');
const t = require('./time');
const { AppError } = require('./validate');

/** Start (of herstart) de aanbetaling voor een boeking in afwachting van betaling. */
async function startDepositPayment(booking, accessToken) {
  if (!mollie.isConfigured()) throw new AppError('Online betalen is nog niet ingesteld door de salon.', 503);
  const amount = booking.deposit_cents - booking.deposit_paid_cents;
  if (amount <= 0) throw new AppError('Er staat geen aanbetaling open.', 400);
  const redirectUrl = `${config.publicUrl}/?boeking=${encodeURIComponent(booking.code)}&t=${encodeURIComponent(accessToken)}`;
  const payment = await mollie.createPayment({
    amountCents: amount,
    description: `Aanbetaling ${booking.service_name} ${booking.code}`,
    redirectUrl,
    metadata: { bookingCode: booking.code, bookingId: booking.id },
  });
  const checkoutUrl = payment._links && payment._links.checkout ? payment._links.checkout.href : null;
  db.prepare(`INSERT INTO payments (booking_id, provider, provider_id, amount_cents, status, checkout_url, mode, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(booking.id, 'mollie', payment.id, amount, payment.status, checkoutUrl, payment.mode || mollie.mode(), nowIso(), nowIso());
  repo.logEvent(booking.id, 'payment_started', `Aanbetaling van ${t.formatEuro(amount)} gestart (${payment.id})`);
  if (!checkoutUrl) throw new AppError('Mollie gaf geen betaallink terug.', 502);
  return checkoutUrl;
}

/**
 * Haal de actuele status op bij Mollie en verwerk die. Wordt aangeroepen door
 * de webhook, de terugkeerpagina en de periodieke controle. Idempotent.
 */
async function syncPayment(providerId) {
  const row = db.prepare('SELECT * FROM payments WHERE provider_id = ?').get(providerId);
  if (!row) return null;
  const remote = await mollie.getPayment(providerId);
  return applyPaymentStatus(row, remote);
}

async function applyPaymentStatus(row, remote) {
  const status = remote.status;
  const wasPaid = row.status === 'paid';
  db.prepare('UPDATE payments SET status = ?, method = ?, paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ?')
    .run(status, remote.method || row.method, status === 'paid' ? (remote.paidAt || nowIso()) : null, nowIso(), row.id);

  // Bijhouden van terugbetalingen die via het Mollie-dashboard zijn gedaan
  if (remote.amountRefunded) {
    const refundedRemote = mollie.valueToCents(remote.amountRefunded.value);
    const known = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM refunds WHERE payment_id = ? AND status <> 'failed' AND status <> 'canceled'").get(row.id).s;
    if (refundedRemote > known) {
      const diff = refundedRemote - known;
      db.prepare('INSERT INTO refunds (payment_id, booking_id, provider_id, amount_cents, status, reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(row.id, row.booking_id, `ext_${row.provider_id}_${Date.now()}`, diff, 'refunded', 'Via Mollie-dashboard', nowIso(), nowIso());
      db.prepare('UPDATE bookings SET refunded_cents = refunded_cents + ?, updated_at = ? WHERE id = ?').run(diff, nowIso(), row.booking_id);
      repo.logEvent(row.booking_id, 'refund', `${t.formatEuro(diff)} terugbetaald via het Mollie-dashboard`);
    }
  }

  if (status === 'paid' && !wasPaid) {
    await handlePaid(row);
  } else if (['failed', 'canceled', 'expired'].includes(status) && row.status !== status) {
    const b = repo.getBooking(row.booking_id);
    repo.logEvent(b.id, 'payment_' + status, `Aanbetaling ${({ failed: 'mislukt', canceled: 'geannuleerd', expired: 'verlopen' })[status]} (${row.provider_id})`);
    const otherPaid = db.prepare("SELECT 1 FROM payments WHERE booking_id = ? AND status = 'paid'").get(b.id);
    const otherOpen = db.prepare("SELECT 1 FROM payments WHERE booking_id = ? AND id <> ? AND status IN ('open','pending','authorized')").get(b.id, row.id);
    // De klant kan het opnieuw proberen zolang de reservering geldig is.
    if (b.status === 'pending_payment' && !otherPaid && !otherOpen && (!b.hold_expires_at || b.hold_expires_at <= nowIso())) {
      db.prepare("UPDATE bookings SET status = 'expired', hold_expires_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), b.id);
      repo.logEvent(b.id, 'expired', 'Reservering vervallen (geen betaling ontvangen)');
    }
  }
  return status;
}

async function handlePaid(row) {
  const bookings = require('./bookings');
  return bookings.withLock(`b${row.booking_id}`, async () => {
    const b = repo.getBooking(row.booking_id);
    db.prepare('UPDATE bookings SET deposit_paid_cents = deposit_paid_cents + ?, updated_at = ? WHERE id = ?').run(row.amount_cents, nowIso(), b.id);
    repo.logEvent(b.id, 'payment_paid', `Aanbetaling van ${t.formatEuro(row.amount_cents)} ontvangen (${row.provider_id})`);

    if (b.status === 'pending_payment' || b.status === 'expired') {
      // Binnen de reservering is het tijdslot nog van deze klant. Daarna opnieuw controleren.
      const confirmed = db.transaction(() => {
        const fresh = repo.getBooking(b.id);
        const holdValid = fresh.status === 'pending_payment' && fresh.hold_expires_at && fresh.hold_expires_at > nowIso();
        const free = holdValid || !availability.checkAdminSlot(fresh.date, fresh.start_min, fresh.duration_min, fresh.id).conflict;
        if (!free) return false;
        db.prepare("UPDATE bookings SET status = 'confirmed', confirmed_at = ?, hold_expires_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), b.id);
        return true;
      }).immediate();

      if (confirmed) {
        repo.logEvent(b.id, 'confirmed', 'Afspraak bevestigd na betaling');
        await bookings.onConfirmed(repo.getBooking(b.id));
      } else {
        // Tijdslot inmiddels bezet: volledig terugbetalen.
        try {
          await refundBooking(repo.getBooking(b.id), row.amount_cents, `Terugbetaling ${b.code}: tijdslot niet meer beschikbaar`);
          db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'system', cancel_reason = ?, updated_at = ? WHERE id = ?")
            .run(nowIso(), 'Betaling na verlopen reservering; tijdslot bezet', nowIso(), b.id);
          repo.logEvent(b.id, 'cancelled', 'Betaling te laat ontvangen; tijdslot bezet. Volledig terugbetaald.');
          await require('./mailer').emails.lateRefund(repo.getBooking(b.id), row.amount_cents).catch(() => {});
        } catch (err) {
          repo.logEvent(b.id, 'refund_error', `Automatische terugbetaling mislukt: ${err.message}`);
        }
      }
    }
  });
}

/** Terugbetaling via Mollie, verdeeld over de betaalde betalingen van de boeking. */
async function refundBooking(booking, amountCents, description) {
  const fresh = repo.getBooking(booking.id);
  const refundable = fresh.deposit_paid_cents - fresh.refunded_cents;
  if (amountCents <= 0) return 0;
  if (amountCents > refundable) throw new AppError(`Er kan maximaal ${t.formatEuro(refundable)} worden terugbetaald.`, 400);
  const paid = db.prepare(`SELECT p.*, COALESCE((SELECT SUM(r.amount_cents) FROM refunds r WHERE r.payment_id = p.id AND r.status NOT IN ('failed','canceled')),0) AS refunded
      FROM payments p WHERE p.booking_id = ? AND p.status = 'paid' ORDER BY p.id DESC`).all(fresh.id);
  let left = amountCents;
  for (const p of paid) {
    const available = p.amount_cents - p.refunded;
    if (available <= 0 || left <= 0) continue;
    const part = Math.min(available, left);
    let refund;
    try {
      refund = await mollie.createRefund(p.provider_id, part, description);
    } catch (err) {
      repo.logEvent(fresh.id, 'refund_error', `Terugbetaling mislukt: ${err.message}`);
      throw new AppError(`De terugbetaling kon niet worden verwerkt (${err.message}). Er is niets gewijzigd.`, 502);
    }
    db.prepare('INSERT INTO refunds (payment_id, booking_id, provider_id, amount_cents, status, reason, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(p.id, fresh.id, refund.id, part, refund.status || 'pending', description, nowIso(), nowIso());
    db.prepare('UPDATE bookings SET refunded_cents = refunded_cents + ?, updated_at = ? WHERE id = ?').run(part, nowIso(), fresh.id);
    repo.logEvent(fresh.id, 'refund', `${t.formatEuro(part)} terugbetaald via Mollie (${refund.id})`);
    left -= part;
  }
  if (left > 0) throw new AppError('Niet het volledige bedrag kon worden terugbetaald.', 502);
  return amountCents;
}

/** Periodiek: openstaande betalingen nalopen (voor als een webhook niet aankomt). */
async function reconcile() {
  if (!mollie.isConfigured()) return;
  const open = db.prepare(`SELECT p.provider_id FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.status IN ('open','pending','authorized') AND p.created_at > ? ORDER BY p.id LIMIT 30`)
    .all(new Date(Date.now() - 2 * 86_400_000).toISOString());
  for (const p of open) {
    try { await syncPayment(p.provider_id); } catch (err) { console.error('[mollie] controle mislukt', p.provider_id, err.message); }
  }
  // Reserveringen waarvan de houdtijd ruim voorbij is en geen open betaling meer hebben
  const stale = db.prepare(`SELECT b.id FROM bookings b WHERE b.status = 'pending_payment' AND b.hold_expires_at < ?
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status IN ('open','pending','authorized','paid'))`)
    .all(nowIso());
  for (const s of stale) {
    db.prepare("UPDATE bookings SET status = 'expired', hold_expires_at = NULL, updated_at = ? WHERE id = ?").run(nowIso(), s.id);
    repo.logEvent(s.id, 'expired', 'Reservering vervallen (geen betaling ontvangen)');
  }
  // Status van lopende terugbetalingen bijwerken
  const refunds = db.prepare(`SELECT r.*, p.provider_id AS payment_provider_id FROM refunds r JOIN payments p ON p.id = r.payment_id
      WHERE r.status IN ('queued','pending','processing') AND r.provider_id LIKE 're_%' LIMIT 30`).all();
  for (const r of refunds) {
    try {
      const remote = await mollie.getRefund(r.payment_provider_id, r.provider_id);
      if (remote.status !== r.status) {
        db.prepare('UPDATE refunds SET status = ?, updated_at = ? WHERE id = ?').run(remote.status, nowIso(), r.id);
        if (['failed', 'canceled'].includes(remote.status)) {
          db.prepare('UPDATE bookings SET refunded_cents = MAX(0, refunded_cents - ?), updated_at = ? WHERE id = ?').run(r.amount_cents, nowIso(), r.booking_id);
          repo.logEvent(r.booking_id, 'refund_error', `Terugbetaling ${r.provider_id} is ${remote.status === 'failed' ? 'mislukt' : 'geannuleerd'}`);
        }
      }
    } catch (err) { console.error('[mollie] refund-controle mislukt', r.provider_id, err.message); }
  }
}

module.exports = { startDepositPayment, syncPayment, refundBooking, reconcile };
