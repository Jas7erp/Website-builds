'use strict';
const { db, nowIso } = require('../db');
const settings = require('./settings');
const caldav = require('./caldav');
const ics = require('./ics');
const repo = require('./repo');

const ACTIVE = ['confirmed', 'completed', 'no_show'];

function isEnabled() {
  const s = settings.getAll();
  return Boolean(s.caldav_enabled && s.caldav_calendar_url && s.caldav_username && s.caldav_password);
}

function creds() {
  return {
    calendarUrl: settings.get('caldav_calendar_url'),
    username: settings.get('caldav_username'),
    password: settings.get('caldav_password'),
  };
}

function markPending(bookingId) {
  db.prepare("UPDATE bookings SET cal_sync_status = 'pending' WHERE id = ?").run(bookingId);
}

const inFlight = new Map();

/** Synchroniseer één boeking naar de gekoppelde agenda (idempotent). */
async function syncBooking(bookingId) {
  // Voorkom gelijktijdige synchronisaties van dezelfde boeking (dubbele items)
  if (inFlight.has(bookingId)) {
    await inFlight.get(bookingId).catch(() => {});
  }
  const p = doSync(bookingId);
  inFlight.set(bookingId, p);
  try {
    return await p;
  } finally {
    if (inFlight.get(bookingId) === p) inFlight.delete(bookingId);
  }
}

async function doSync(bookingId) {
  const b = repo.getBooking(bookingId);
  if (!b) return null;
  if (!isEnabled()) {
    db.prepare("UPDATE bookings SET cal_sync_status = 'disabled' WHERE id = ? AND cal_sync_status <> 'synced'").run(b.id);
    return 'disabled';
  }
  const c = creds();
  const s = settings.getAll();
  try {
    if (ACTIVE.includes(b.status) || (b.status === 'cancelled' && b.cal_href && s.caldav_on_cancel === 'mark')) {
      const body = ics.calendar([ics.eventLines(b, { audience: 'owner', salonAddress: s.salon_address, cancelledMode: 'mark' })]);
      // Altijd dezelfde URL (op basis van UID): bijwerken in plaats van een nieuw item.
      const { href, etag } = await caldav.putEvent({ ...c, uid: b.uid, ics: body, href: b.cal_href });
      db.prepare(`UPDATE bookings SET cal_href = ?, cal_etag = ?, cal_sync_status = 'synced', cal_sync_error = NULL, cal_synced_at = ? WHERE id = ?`)
        .run(href, etag, nowIso(), b.id);
    } else if (b.cal_href) {
      await caldav.deleteEvent({ ...c, href: b.cal_href });
      db.prepare(`UPDATE bookings SET cal_href = NULL, cal_etag = NULL, cal_sync_status = 'synced', cal_sync_error = NULL, cal_synced_at = ? WHERE id = ?`)
        .run(nowIso(), b.id);
    } else {
      db.prepare("UPDATE bookings SET cal_sync_status = 'synced', cal_sync_error = NULL WHERE id = ?").run(b.id);
    }
    settings.set({ caldav_last_ok: nowIso(), caldav_last_error: '' });
    return 'synced';
  } catch (err) {
    db.prepare("UPDATE bookings SET cal_sync_status = 'error', cal_sync_error = ? WHERE id = ?").run(String(err.message).slice(0, 500), b.id);
    settings.set({ caldav_last_error: `${new Date().toLocaleString('nl-NL')}: ${err.message}` });
    console.error(`[agenda] synchronisatie boeking ${b.code} mislukt:`, err.message);
    return 'error';
  }
}

function queueSync(bookingId) {
  markPending(bookingId);
  setImmediate(() => { syncBooking(bookingId).catch(() => {}); });
}

/** Opnieuw proberen van mislukte of openstaande synchronisaties. */
async function retryPending(limit = 25) {
  if (!isEnabled()) return 0;
  const rows = db.prepare(`SELECT id FROM bookings WHERE cal_sync_status IN ('pending','error','disabled')
      AND (status IN ('confirmed','completed','no_show') OR cal_href IS NOT NULL) ORDER BY updated_at LIMIT ?`).all(limit);
  for (const r of rows) await syncBooking(r.id);
  return rows.length;
}

/** Alle toekomstige afspraken (opnieuw) naar de agenda zetten. */
async function resyncAll() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT id FROM bookings WHERE date >= ? AND (status IN ('confirmed','completed','no_show') OR cal_href IS NOT NULL)`).all(today);
  let ok = 0;
  for (const r of rows) if ((await syncBooking(r.id)) === 'synced') ok++;
  return { total: rows.length, ok };
}

/** ICS-abonnementsfeed (alternatief voor CalDAV) */
function feed() {
  const s = settings.getAll();
  const from = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const rows = db.prepare(`${repo.BOOKING_SELECT} WHERE b.date >= ? AND b.status IN ('confirmed','completed','no_show','cancelled') ORDER BY b.date, b.start_min`).all(from);
  const events = rows
    .filter((b) => b.status !== 'cancelled' || b.confirmed_at)
    .map((b) => ics.eventLines(b, { audience: 'owner', salonAddress: s.salon_address, cancelledMode: 'mark' }));
  return ics.calendar(events, { name: `${s.salon_name} – Afspraken` });
}

module.exports = { isEnabled, syncBooking, queueSync, retryPending, resyncAll, feed };
