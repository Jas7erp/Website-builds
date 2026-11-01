'use strict';
const config = require('../config');
const t = require('./time');

function esc(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Regels vouwen op 75 octets (RFC 5545)
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let current = '';
  let currentLen = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    const limit = parts.length === 0 ? 75 : 74;
    if (currentLen + len > limit) {
      parts.push(current);
      current = '';
      currentLen = 0;
    }
    current += ch;
    currentLen += len;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function utcStamp(ts) {
  return new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function eventLines(booking, { audience = 'owner', salonName = '', salonAddress = '', cancelledMode = 'mark' } = {}) {
  const start = t.localToUtc(booking.date, booking.start_min);
  const end = t.localToUtc(booking.date, booking.end_min);
  const cancelled = booking.status === 'cancelled';
  const customerName = `${booking.first_name || ''} ${booking.last_name || ''}`.trim();

  let summary;
  let description;
  if (audience === 'owner') {
    summary = `${customerName} – ${booking.service_name}`;
    if (cancelled) summary = `GEANNULEERD: ${summary}`;
    const lines = [
      `Klant: ${customerName}`,
      `Telefoon: ${booking.phone || '-'}`,
      `E-mail: ${booking.email || '-'}`,
      `Behandeling: ${booking.service_name} (${booking.duration_min} min)`,
      `Datum: ${t.formatDateLong(booking.date)} ${t.toHHMM(booking.start_min)}–${t.toHHMM(booking.end_min)}`,
      `Prijs: ${t.formatEuro(booking.final_price_cents)}${booking.discount_cents ? ` (incl. ${t.formatEuro(booking.discount_cents)} korting, code ${booking.discount_code})` : ''}`,
      booking.deposit_cents ? `Aanbetaling: ${t.formatEuro(booking.deposit_paid_cents)} betaald van ${t.formatEuro(booking.deposit_cents)}` : null,
      `Nog te betalen in salon: ${t.formatEuro(Math.max(0, booking.final_price_cents - booking.deposit_paid_cents))}`,
      booking.notes ? `Opmerkingen: ${booking.notes}` : null,
      `Boekingscode: ${booking.code}`,
      `Beheer: ${config.publicUrl}/admin#/agenda?booking=${booking.id}`,
    ].filter(Boolean);
    description = lines.join('\n');
  } else {
    summary = `${booking.service_name} bij ${salonName}`;
    description = `Boekingscode: ${booking.code}\nWijzigen of annuleren: ${config.publicUrl}/?beheer=${booking.code}`;
  }

  return [
    'BEGIN:VEVENT',
    `UID:${booking.uid}`,
    `DTSTAMP:${utcStamp(Date.now())}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SEQUENCE:${booking.sequence || 0}`,
    `SUMMARY:${esc(summary)}`,
    `DESCRIPTION:${esc(description)}`,
    salonAddress ? `LOCATION:${esc(salonAddress)}` : null,
    `STATUS:${cancelled && cancelledMode === 'mark' ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    `LAST-MODIFIED:${utcStamp(Date.parse(booking.updated_at) || Date.now())}`,
    'END:VEVENT',
  ].filter(Boolean);
}

function calendar(eventsLines, { name, method } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kapsalon Boekingen//NL',
    'CALSCALE:GREGORIAN',
    method ? `METHOD:${method}` : null,
    name ? `X-WR-CALNAME:${esc(name)}` : null,
    name ? 'X-PUBLISHED-TTL:PT15M' : null,
    name ? 'REFRESH-INTERVAL;VALUE=DURATION:PT15M' : null,
    ...eventsLines.flat(),
    'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

module.exports = { eventLines, calendar, esc, fold };
