'use strict';
const { db, nowIso } = require('../db');

const BOOKING_SELECT = `
  SELECT b.*, c.first_name, c.last_name, c.email, c.phone
  FROM bookings b JOIN customers c ON c.id = b.customer_id`;

function getBooking(id) {
  return db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).get(id);
}

function getBookingByCode(code) {
  return db.prepare(`${BOOKING_SELECT} WHERE b.code = ?`).get(String(code || '').trim().toUpperCase());
}

function logEvent(bookingId, type, message, actor = 'system') {
  db.prepare('INSERT INTO booking_events (booking_id, type, message, actor, created_at) VALUES (?,?,?,?,?)')
    .run(bookingId, type, message, actor, nowIso());
}

function getService(id, { includeInactive = false } = {}) {
  const row = db.prepare('SELECT * FROM services WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return null;
  if (!includeInactive && !row.active) return null;
  return row;
}

module.exports = { BOOKING_SELECT, getBooking, getBookingByCode, logEvent, getService };
