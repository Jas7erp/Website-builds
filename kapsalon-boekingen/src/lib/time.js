'use strict';
const config = require('../config');

const TZ = config.timezone;

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function zonedParts(ts) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(new Date(ts))) p[type] = value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
  };
}

// Huidige datum en minuut in de tijdzone van de salon
function nowLocal(ts = Date.now()) {
  const p = zonedParts(ts);
  return {
    date: `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`,
    minutes: p.hour * 60 + p.minute,
  };
}

function tzOffsetMs(ts) {
  const p = zonedParts(ts);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

// Lokale salontijd -> UTC timestamp (ms)
function localToUtc(date, minutes) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let ts = guess - tzOffsetMs(guess);
  const off2 = tzOffsetMs(ts);
  ts = guess - off2;
  return ts;
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function isValidTime(s) {
  return typeof s === 'string' && TIME_RE.test(s);
}
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function toHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function weekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function diffDays(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const longDateFmt = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
function formatDateLong(date) {
  const [y, m, d] = date.split('-').map(Number);
  return longDateFmt.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

const eurFmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
function formatEuro(cents) {
  return eurFmt.format((cents || 0) / 100);
}

module.exports = {
  TZ, nowLocal, localToUtc, isValidDate, isValidTime, toMinutes, toHHMM,
  weekday, addDays, diffDays, daysInMonth, formatDateLong, formatEuro,
};
