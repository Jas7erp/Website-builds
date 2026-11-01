'use strict';
const { db, nowIso } = require('../db');
const t = require('./time');

const USED_STATUS_SQL = `(b.status IN ('confirmed','completed','no_show') OR (b.status = 'pending_payment' AND b.hold_expires_at > ?))`;

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizePhone(phone) {
  let p = String(phone || '').replace(/[^\d+]/g, '');
  if (p.startsWith('00')) p = `+${p.slice(2)}`;
  if (p.startsWith('0')) p = `+31${p.slice(1)}`; // Nederlandse nummers
  return p;
}

function codeServices(codeId) {
  return db.prepare('SELECT service_id FROM discount_code_services WHERE code_id = ?').all(codeId).map((r) => r.service_id);
}

function usageCount(codeId, excludeBookingId = null) {
  return db.prepare(`SELECT COUNT(*) AS n FROM bookings b WHERE b.discount_code_id = ? AND ${USED_STATUS_SQL} AND b.id IS NOT ?`)
    .get(codeId, nowIso(), excludeBookingId).n;
}

function customerUsed(codeId, email, phone, excludeBookingId = null) {
  return db.prepare(`SELECT COUNT(*) AS n FROM bookings b JOIN customers c ON c.id = b.customer_id
      WHERE b.discount_code_id = ? AND ${USED_STATUS_SQL} AND b.id IS NOT ?
        AND (c.email = ? OR (c.phone_normalized <> '' AND c.phone_normalized = ?))`)
    .get(codeId, nowIso(), excludeBookingId, normalizeEmail(email), normalizePhone(phone)).n > 0;
}

function codeState(code, today = t.nowLocal().date) {
  if (!code.active) return 'inactive';
  if (code.expires_on && today > code.expires_on) return 'expired';
  if (code.starts_on && today < code.starts_on) return 'scheduled';
  if (code.max_uses != null && usageCount(code.id) >= code.max_uses) return 'exhausted';
  return 'active';
}

function computeDiscount(code, priceCents) {
  if (code.discount_type === 'percent') {
    return Math.min(priceCents, Math.round((priceCents * Math.min(code.discount_value, 100)) / 100));
  }
  return Math.min(priceCents, code.discount_value);
}

/**
 * Controleer een kortingscode server-side.
 * ctx: { service, email, phone, excludeBookingId }
 */
function evaluateDiscount(rawCode, ctx) {
  const codeStr = normalizeCode(rawCode);
  if (!codeStr) return { ok: false, error: 'Vul een kortingscode in.' };
  if (codeStr.length > 40 || !/^[A-Z0-9_-]+$/.test(codeStr)) return { ok: false, error: 'Deze kortingscode bestaat niet.' };

  const code = db.prepare('SELECT * FROM discount_codes WHERE code = ?').get(codeStr);
  if (!code) return { ok: false, error: 'Deze kortingscode bestaat niet.' };

  const today = t.nowLocal().date;
  if (!code.active) return { ok: false, error: 'Deze kortingscode is niet meer geldig.' };
  if (code.starts_on && today < code.starts_on) {
    return { ok: false, error: `Deze kortingscode is geldig vanaf ${t.formatDateLong(code.starts_on)}.` };
  }
  if (code.expires_on && today > code.expires_on) return { ok: false, error: 'Deze kortingscode is verlopen.' };
  if (code.max_uses != null && usageCount(code.id, ctx.excludeBookingId) >= code.max_uses) {
    return { ok: false, error: 'Deze kortingscode is al het maximale aantal keer gebruikt.' };
  }
  const service = ctx.service;
  if (!code.applies_to_all) {
    if (!service || !codeServices(code.id).includes(service.id)) {
      return { ok: false, error: 'Deze kortingscode is niet geldig voor de gekozen behandeling.' };
    }
  }
  const price = service ? service.price_cents : 0;
  if (code.min_amount_cents && price < code.min_amount_cents) {
    return { ok: false, error: `Deze kortingscode geldt vanaf een bedrag van ${t.formatEuro(code.min_amount_cents)}.` };
  }
  if (code.once_per_customer) {
    if (!ctx.email) return { ok: false, error: 'Vul eerst je e-mailadres in om deze code te gebruiken.' };
    if (customerUsed(code.id, ctx.email, ctx.phone, ctx.excludeBookingId)) {
      return { ok: false, error: 'Je hebt deze kortingscode al eens gebruikt.' };
    }
  }
  const discountCents = computeDiscount(code, price);
  if (discountCents <= 0) return { ok: false, error: 'Deze kortingscode levert geen korting op voor deze behandeling.' };
  return {
    ok: true,
    code,
    discountCents,
    label: code.discount_type === 'percent' ? `${code.discount_value}% korting` : `${t.formatEuro(code.discount_value)} korting`,
  };
}

function computeDeposit(service, finalCents) {
  if (!service || service.deposit_type === 'none' || finalCents <= 0) return 0;
  if (service.deposit_type === 'fixed') return Math.min(service.deposit_value, finalCents);
  if (service.deposit_type === 'percent') return Math.min(finalCents, Math.round((finalCents * Math.min(service.deposit_value, 100)) / 100));
  return 0;
}

/** Volledige prijsopbouw voor een behandeling met optionele kortingscode. */
function quote({ service, discountCode, email, phone, excludeBookingId }) {
  const priceCents = service.price_cents;
  let discount = null;
  let discountError = null;
  if (discountCode && String(discountCode).trim()) {
    const res = evaluateDiscount(discountCode, { service, email, phone, excludeBookingId });
    if (res.ok) discount = { id: res.code.id, code: res.code.code, label: res.label, cents: res.discountCents };
    else discountError = res.error;
  }
  const finalCents = priceCents - (discount ? discount.cents : 0);
  const depositCents = computeDeposit(service, finalCents);
  return {
    priceCents,
    discount,
    discountError,
    finalCents,
    depositCents,
    remainingCents: finalCents - depositCents,
  };
}

module.exports = {
  normalizeCode, normalizeEmail, normalizePhone, evaluateDiscount, computeDeposit, quote,
  usageCount, codeState, codeServices, computeDiscount,
};
