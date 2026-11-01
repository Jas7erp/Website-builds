'use strict';
const { db, nowIso } = require('../db');
const settings = require('./settings');
const t = require('./time');

// ---- Intervalhulpjes (minuten na middernacht, [start, end) ) ----
function mergeIntervals(list) {
  const sorted = list.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function subtractIntervals(base, remove) {
  let result = mergeIntervals(base);
  for (const [rs, re] of mergeIntervals(remove)) {
    const next = [];
    for (const [s, e] of result) {
      if (re <= s || rs >= e) { next.push([s, e]); continue; }
      if (rs > s) next.push([s, rs]);
      if (re < e) next.push([re, e]);
    }
    result = next;
  }
  return result;
}

const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

// Statussen die een tijdslot bezet houden
const BLOCKING_SQL = `(status IN ('confirmed','completed','no_show') OR (status = 'pending_payment' AND hold_expires_at > ?))`;

const stmts = {
  hours: db.prepare('SELECT * FROM opening_hours WHERE weekday = ?'),
  breaks: db.prepare('SELECT * FROM breaks WHERE weekday = ? ORDER BY start_time'),
  exceptions: db.prepare('SELECT * FROM availability_exceptions WHERE start_date <= ? AND end_date >= ? ORDER BY start_time'),
  bookings: db.prepare(`SELECT id, start_min, end_min FROM bookings WHERE date = ? AND ${BLOCKING_SQL}`),
};

/**
 * Bepaal de werkvensters van een dag (openingstijden + extra beschikbaarheid
 * minus pauzes en blokkades). Houdt nog geen rekening met afspraken.
 */
function getDaySchedule(date) {
  const wd = t.weekday(date);
  const hours = stmts.hours.get(wd);
  const exceptions = stmts.exceptions.all(date, date);
  const closedException = exceptions.find((e) => e.type === 'closed');

  const open = [];
  if (hours && hours.is_open && !closedException) {
    open.push([t.toMinutes(hours.open_time), t.toMinutes(hours.close_time)]);
  }
  const extras = exceptions.filter((e) => e.type === 'extra' && e.start_time && e.end_time);
  for (const e of extras) open.push([t.toMinutes(e.start_time), t.toMinutes(e.end_time)]);

  const busy = [];
  const breaks = closedException ? [] : stmts.breaks.all(wd);
  for (const b of breaks) busy.push([t.toMinutes(b.start_time), t.toMinutes(b.end_time)]);
  const blocks = exceptions.filter((e) => e.type === 'block' && e.start_time && e.end_time);
  for (const b of blocks) busy.push([t.toMinutes(b.start_time), t.toMinutes(b.end_time)]);

  return {
    date,
    weekday: wd,
    closed: closedException ? (closedException.label || 'Gesloten') : null,
    open: mergeIntervals(open),
    windows: subtractIntervals(open, busy),
    breaks: breaks.map((b) => ({ start: b.start_time, end: b.end_time, label: b.label })),
    blocks: blocks.map((b) => ({ id: b.id, start: b.start_time, end: b.end_time, label: b.label })),
    extras: extras.map((b) => ({ id: b.id, start: b.start_time, end: b.end_time, label: b.label })),
  };
}

function busyIntervals(date, excludeBookingId) {
  const buffer = settings.get('buffer_min') || 0;
  return stmts.bookings
    .all(date, nowIso())
    .filter((b) => b.id !== excludeBookingId)
    .map((b) => [b.start_min - buffer, b.end_min + buffer]);
}

function bookingLimits() {
  const now = t.nowLocal();
  return {
    today: now.date,
    lastDate: t.addDays(now.date, settings.get('max_days_ahead')),
    earliestTs: Date.now() + settings.get('min_notice_min') * 60_000,
  };
}

/**
 * Alle beschikbare starttijden (minuten) voor een datum en behandelduur.
 * enforceLimits: publieke regels (minimale aanlooptijd, max. dagen vooruit).
 */
function getSlots(date, durationMin, { excludeBookingId = null, enforceLimits = true } = {}) {
  if (!t.isValidDate(date) || !(durationMin > 0)) return [];
  let limits = null;
  if (enforceLimits) {
    limits = bookingLimits();
    if (date < limits.today || date > limits.lastDate) return [];
  }
  const schedule = getDaySchedule(date);
  if (!schedule.windows.length) return [];
  const busy = busyIntervals(date, excludeBookingId);
  const step = Math.max(5, settings.get('slot_interval_min') || 15);
  const slots = [];
  for (const [ws, we] of schedule.windows) {
    for (let s = ws; s + durationMin <= we; s += step) {
      const e = s + durationMin;
      if (busy.some(([bs, be]) => overlaps(s, e, bs, be))) continue;
      if (limits && t.localToUtc(date, s) < limits.earliestTs) continue;
      slots.push(s);
    }
  }
  return slots;
}

/** Controle voor een specifiek tijdstip. Publieke boekingen moeten exact op een slot vallen. */
function isSlotAvailable(date, startMin, durationMin, opts = {}) {
  return getSlots(date, durationMin, opts).includes(startMin);
}

/**
 * Admin: willekeurige tijd toegestaan, maar nooit overlappend met andere afspraken.
 * Geeft { ok, conflict, outsideHours } terug.
 */
function checkAdminSlot(date, startMin, durationMin, excludeBookingId = null) {
  const end = startMin + durationMin;
  const conflict = busyIntervals(date, excludeBookingId).some(([bs, be]) => overlaps(startMin, end, bs, be));
  const schedule = getDaySchedule(date);
  const insideWindow = schedule.windows.some(([ws, we]) => startMin >= ws && end <= we);
  return { ok: !conflict, conflict, outsideHours: !insideWindow };
}

function monthAvailability(month, durationMin, opts = {}) {
  const days = [];
  const total = t.daysInMonth(month);
  for (let d = 1; d <= total; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    days.push({ date, available: getSlots(date, durationMin, opts).length > 0 });
  }
  return days;
}

/** Status voor de header: nu open/gesloten en eerstvolgende opening */
function salonStatus() {
  const now = t.nowLocal();
  const today = getDaySchedule(now.date);
  const openNow = today.open.some(([s, e]) => now.minutes >= s && now.minutes < e);
  if (openNow) {
    const current = today.open.find(([s, e]) => now.minutes >= s && now.minutes < e);
    return { open: true, label: `Nu open · tot ${t.toHHMM(current[1])}` };
  }
  for (let i = 0; i < 14; i++) {
    const date = t.addDays(now.date, i);
    const sch = i === 0 ? today : getDaySchedule(date);
    const next = sch.open.find(([s]) => i > 0 || s > now.minutes);
    if (next) {
      const dayLabel = i === 0 ? 'vandaag' : i === 1 ? 'morgen'
        : new Intl.DateTimeFormat('nl-NL', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
      return { open: false, label: `Gesloten · opent ${dayLabel} om ${t.toHHMM(next[0])}` };
    }
  }
  return { open: false, label: 'Gesloten' };
}

module.exports = {
  mergeIntervals, subtractIntervals, getDaySchedule, getSlots, isSlotAvailable,
  checkAdminSlot, monthAvailability, salonStatus, bookingLimits, BLOCKING_SQL,
};
