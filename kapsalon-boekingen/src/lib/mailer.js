'use strict';
const nodemailer = require('nodemailer');
const { db, nowIso } = require('../db');
const config = require('../config');
const settings = require('./settings');
const ics = require('./ics');
const t = require('./time');

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let cachedTransport = null;
let cachedKey = '';

function transport() {
  const s = settings.getAll();
  if (!s.smtp_host) return null;
  const key = JSON.stringify([s.smtp_host, s.smtp_port, s.smtp_secure, s.smtp_user, s.smtp_pass]);
  if (cachedTransport && key === cachedKey) return cachedTransport;
  cachedTransport = nodemailer.createTransport({
    host: s.smtp_host,
    port: s.smtp_port,
    secure: s.smtp_secure,
    auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
    connectionTimeout: 15_000,
    tls: process.env.SMTP_ALLOW_SELF_SIGNED === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  cachedKey = key;
  return cachedTransport;
}

function isConfigured() {
  return Boolean(settings.get('smtp_host') && fromAddress());
}

function fromAddress() {
  const s = settings.getAll();
  const addr = s.smtp_from || s.salon_email || s.smtp_user;
  if (!addr) return '';
  return addr.includes('<') ? addr : `"${s.salon_name.replace(/"/g, '')}" <${addr}>`;
}

function layout({ title, intro, rows = [], footer = '', button }) {
  const s = settings.getAll();
  const rowsHtml = rows.filter(Boolean).map(([k, v, strong]) => `
      <tr><td style="padding:10px 0;color:#6e6e73;font-size:14px;border-bottom:1px solid #f0f0f2">${escHtml(k)}</td>
      <td style="padding:10px 0;text-align:right;font-size:14px;border-bottom:1px solid #f0f0f2;${strong ? 'font-weight:600;color:#1d1d1f' : 'color:#1d1d1f'}">${escHtml(v)}</td></tr>`).join('');
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:24px;padding:32px;box-shadow:0 8px 30px rgba(0,0,0,.06)">
      <tr><td>
        <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#86868b;margin-bottom:8px">${escHtml(s.salon_name)}</div>
        <h1 style="font-size:24px;line-height:1.25;margin:0 0 12px;font-weight:650">${escHtml(title)}</h1>
        <p style="font-size:15px;line-height:1.55;color:#424245;margin:0 0 20px">${intro}</p>
        ${rowsHtml ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rowsHtml}</table>` : ''}
        ${button ? `<div style="margin-top:24px"><a href="${escHtml(button.href)}" style="display:inline-block;background:#1d1d1f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-size:15px;font-weight:500">${escHtml(button.label)}</a></div>` : ''}
        ${footer ? `<p style="font-size:13px;line-height:1.5;color:#86868b;margin:24px 0 0">${footer}</p>` : ''}
      </td></tr>
    </table>
    <p style="font-size:12px;color:#86868b;margin-top:16px">${escHtml([s.salon_name, s.salon_address, s.salon_phone].filter(Boolean).join(' · '))}</p>
  </td></tr></table>
</body></html>`;
}

function htmlToText(html) {
  return html.replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<\/(tr|p|h1|div)>/g, '\n').replace(/<td[^>]*>/g, ' ')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

async function send({ to, subject, html, kind, bookingId = null, attachments }) {
  const log = db.prepare('INSERT INTO email_log (booking_id, kind, to_addr, subject, status, error, created_at) VALUES (?,?,?,?,?,?,?)');
  const tr = transport();
  if (!tr || !fromAddress()) {
    log.run(bookingId, kind, to, subject, 'skipped', 'E-mail (SMTP) is niet ingesteld', nowIso());
    console.warn(`[mail] niet verzonden (SMTP niet ingesteld): ${kind} -> ${to}`);
    return false;
  }
  try {
    await tr.sendMail({ from: fromAddress(), to, subject, html, text: htmlToText(html), attachments, replyTo: settings.get('salon_email') || undefined });
    log.run(bookingId, kind, to, subject, 'sent', null, nowIso());
    return true;
  } catch (err) {
    log.run(bookingId, kind, to, subject, 'failed', String(err.message).slice(0, 500), nowIso());
    console.error(`[mail] verzenden mislukt (${kind} -> ${to}):`, err.message);
    return false;
  }
}

function whenText(b) {
  return `${t.formatDateLong(b.date)} om ${t.toHHMM(b.start_min)}`;
}

function priceRows(b) {
  const rows = [['Behandeling', `${b.service_name} · ${b.duration_min} min`], ['Datum en tijd', whenText(b), true]];
  if (b.discount_cents) {
    rows.push(['Prijs', t.formatEuro(b.price_cents)]);
    rows.push([`Korting (${b.discount_code})`, `– ${t.formatEuro(b.discount_cents)}`]);
  }
  rows.push(['Totaal', t.formatEuro(b.final_price_cents), true]);
  if (b.deposit_cents) rows.push(['Aanbetaling voldaan', t.formatEuro(b.deposit_paid_cents)]);
  rows.push(['Te betalen in de salon', t.formatEuro(Math.max(0, b.final_price_cents - b.deposit_paid_cents))]);
  rows.push(['Boekingscode', b.code, true]);
  return rows;
}

function policyFooter() {
  const s = settings.getAll();
  const refund = s.late_cancel_refund_pct;
  return `Wijzigen of annuleren kan kosteloos tot ${s.cancel_window_hours} uur voor je afspraak. ` +
    `Annuleer je later, dan ${refund >= 100 ? 'krijg je je aanbetaling alsnog volledig terug' : refund > 0 ? `krijg je ${refund}% van je aanbetaling terug` : 'wordt je aanbetaling niet terugbetaald'}.`;
}

function customerIcs(b) {
  const s = settings.getAll();
  return {
    filename: 'afspraak.ics',
    content: ics.calendar([ics.eventLines(b, { audience: 'customer', salonName: s.salon_name, salonAddress: s.salon_address })], { method: 'PUBLISH' }),
    contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
  };
}

const manageUrl = (b) => `${config.publicUrl}/?beheer=${encodeURIComponent(b.code)}`;

function ownerAddress() {
  const s = settings.getAll();
  if (!s.owner_notify_enabled) return null;
  return s.owner_notify_email || s.salon_email || null;
}

async function notifyOwner(b, kind, title) {
  const to = ownerAddress();
  if (!to) return;
  const html = layout({
    title,
    intro: `${escHtml(b.first_name)} ${escHtml(b.last_name)} · ${escHtml(b.phone)} · ${escHtml(b.email)}`,
    rows: [...priceRows(b), b.notes ? ['Opmerking', b.notes] : null],
    button: { label: 'Open in beheer', href: `${config.publicUrl}/admin#/agenda?booking=${b.id}` },
  });
  await send({ to, subject: `${title}: ${b.first_name} ${b.last_name} – ${t.formatDateLong(b.date)} ${t.toHHMM(b.start_min)}`, html, kind, bookingId: b.id });
}

const emails = {
  async bookingConfirmed(b) {
    const html = layout({
      title: 'Je afspraak is bevestigd',
      intro: `Hoi ${escHtml(b.first_name)}, bedankt voor je boeking. We zien je graag op <strong>${escHtml(whenText(b))}</strong>.`,
      rows: priceRows(b),
      button: { label: 'Afspraak wijzigen of annuleren', href: manageUrl(b) },
      footer: escHtml(policyFooter()),
    });
    await send({ to: b.email, subject: `Bevestiging: ${b.service_name} op ${t.formatDateLong(b.date)} om ${t.toHHMM(b.start_min)}`, html, kind: 'confirmation', bookingId: b.id, attachments: [customerIcs(b)] });
    await notifyOwner(b, 'owner_new', 'Nieuwe afspraak');
  },

  async bookingRescheduled(b, previous) {
    const html = layout({
      title: 'Je afspraak is gewijzigd',
      intro: `Hoi ${escHtml(b.first_name)}, je afspraak is verplaatst. Je nieuwe afspraak is op <strong>${escHtml(whenText(b))}</strong>.`
        + (previous ? `<br><span style="color:#86868b">Was: ${escHtml(previous)}</span>` : ''),
      rows: priceRows(b),
      button: { label: 'Afspraak bekijken', href: manageUrl(b) },
      footer: escHtml(policyFooter()),
    });
    await send({ to: b.email, subject: `Gewijzigd: ${b.service_name} op ${t.formatDateLong(b.date)} om ${t.toHHMM(b.start_min)}`, html, kind: 'rescheduled', bookingId: b.id, attachments: [customerIcs(b)] });
    await notifyOwner(b, 'owner_rescheduled', 'Afspraak verzet');
  },

  async bookingCancelled(b, { refundCents = 0, feeCents = 0, byOwner = false } = {}) {
    const rows = [['Behandeling', b.service_name], ['Datum en tijd', whenText(b)], ['Boekingscode', b.code]];
    if (b.deposit_paid_cents) {
      rows.push(['Terugbetaling', t.formatEuro(refundCents), true]);
      if (feeCents) rows.push(['Annuleringskosten', t.formatEuro(feeCents)]);
    }
    const html = layout({
      title: 'Je afspraak is geannuleerd',
      intro: byOwner
        ? `Hoi ${escHtml(b.first_name)}, helaas moeten we je afspraak annuleren. Neem gerust contact met ons op of plan direct een nieuwe afspraak.`
        : `Hoi ${escHtml(b.first_name)}, je afspraak is geannuleerd.`,
      rows,
      button: { label: 'Nieuwe afspraak maken', href: config.publicUrl },
      footer: refundCents ? 'De terugbetaling wordt verwerkt via je oorspronkelijke betaalmethode en staat meestal binnen enkele werkdagen op je rekening.' : '',
    });
    await send({ to: b.email, subject: `Geannuleerd: ${b.service_name} op ${t.formatDateLong(b.date)}`, html, kind: 'cancelled', bookingId: b.id });
    if (!byOwner) await notifyOwner(b, 'owner_cancelled', 'Afspraak geannuleerd');
  },

  async lateRefund(b, refundCents) {
    const html = layout({
      title: 'Je betaling is teruggestort',
      intro: `Hoi ${escHtml(b.first_name)}, je betaling kwam binnen nadat de reservering was verlopen en het tijdstip niet meer beschikbaar was. We hebben ${escHtml(t.formatEuro(refundCents))} volledig teruggestort. Plan gerust een nieuwe afspraak.`,
      button: { label: 'Nieuwe afspraak maken', href: config.publicUrl },
    });
    await send({ to: b.email, subject: 'Je betaling is teruggestort', html, kind: 'late_refund', bookingId: b.id });
  },

  async verificationCode(b, code) {
    const html = layout({
      title: 'Je verificatiecode',
      intro: `Gebruik onderstaande code om je afspraak <strong>${escHtml(b.code)}</strong> te beheren. De code is 10 minuten geldig.<br><br>
        <span style="display:inline-block;font-size:32px;letter-spacing:.3em;font-weight:650;background:#f5f5f7;border-radius:14px;padding:12px 18px">${escHtml(code)}</span>`,
      footer: 'Heb je deze code niet aangevraagd? Dan kun je deze e-mail negeren.',
    });
    return send({ to: b.email, subject: `${code} is je verificatiecode`, html, kind: 'verification', bookingId: b.id });
  },

  async test(to) {
    const html = layout({ title: 'Testbericht', intro: 'De e-mailinstellingen van je boekingsportaal werken.' });
    const tr = transport();
    if (!tr) throw new Error('SMTP is niet ingesteld.');
    await tr.sendMail({ from: fromAddress(), to, subject: 'Testbericht boekingsportaal', html, text: htmlToText(html) });
  },
};

module.exports = { emails, isConfigured, send, layout, escHtml };
