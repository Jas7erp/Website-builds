'use strict';
const { db } = require('../db');
const config = require('../config');
const { encrypt, decrypt, randomToken } = require('./security');

// Alle instelbare waarden met hun standaard. Type bepaalt de conversie.
const DEFS = {
  salon_name:               { type: 'string', def: 'Studio Lumen' },
  salon_tagline:            { type: 'string', def: 'Kapsalon' },
  salon_logo:               { type: 'string', def: '' }, // data-URL
  salon_email:              { type: 'string', def: '' },
  salon_phone:              { type: 'string', def: '' },
  salon_address:            { type: 'string', def: '' },
  accent_color:             { type: 'string', def: '#1d1d1f' },

  slot_interval_min:        { type: 'int', def: 15 },
  min_notice_min:           { type: 'int', def: 120 },
  max_days_ahead:           { type: 'int', def: 60 },
  buffer_min:               { type: 'int', def: 0 },
  hold_minutes:             { type: 'int', def: 20 },
  allow_service_change:     { type: 'bool', def: true },
  booking_notes_enabled:    { type: 'bool', def: true },

  cancel_window_hours:      { type: 'int', def: 24 },
  late_cancel_refund_pct:   { type: 'int', def: 0 },
  policy_text:              { type: 'string', def: '' },

  mollie_api_key:           { type: 'secret', def: () => config.defaults.mollie_api_key },

  smtp_host:                { type: 'string', def: () => config.defaults.smtp_host },
  smtp_port:                { type: 'int', def: () => Number(config.defaults.smtp_port) || 587 },
  smtp_secure:              { type: 'bool', def: () => config.defaults.smtp_secure === 'true' },
  smtp_user:                { type: 'string', def: () => config.defaults.smtp_user },
  smtp_pass:                { type: 'secret', def: () => config.defaults.smtp_pass },
  smtp_from:                { type: 'string', def: () => config.defaults.smtp_from },
  owner_notify_email:       { type: 'string', def: '' },
  owner_notify_enabled:     { type: 'bool', def: true },

  caldav_enabled:           { type: 'bool', def: false },
  caldav_server_url:        { type: 'string', def: 'https://caldav.icloud.com' },
  caldav_username:          { type: 'string', def: '' },
  caldav_password:          { type: 'secret', def: '' },
  caldav_calendar_url:      { type: 'string', def: '' },
  caldav_calendar_name:     { type: 'string', def: '' },
  caldav_on_cancel:         { type: 'string', def: 'delete' }, // delete | mark
  caldav_last_ok:           { type: 'string', def: '' },
  caldav_last_error:        { type: 'string', def: '' },

  ics_feed_token:           { type: 'string', def: '' },
};

const SECRET_KEYS = Object.keys(DEFS).filter((k) => DEFS[k].type === 'secret');

function parse(key, raw) {
  const d = DEFS[key];
  if (!d) return raw;
  if (raw === undefined || raw === null) {
    return typeof d.def === 'function' ? d.def() : d.def;
  }
  switch (d.type) {
    case 'int': return Number.parseInt(raw, 10);
    case 'bool': return raw === '1' || raw === 'true';
    case 'secret': return decrypt(raw);
    default: return raw;
  }
}

function serialize(key, value) {
  const d = DEFS[key];
  switch (d.type) {
    case 'int': return String(Math.trunc(Number(value) || 0));
    case 'bool': return value ? '1' : '0';
    case 'secret': return encrypt(value || '');
    default: return String(value ?? '');
  }
}

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function get(key) {
  const row = getStmt.get(key);
  return parse(key, row ? row.value : undefined);
}

function getAll() {
  const out = {};
  for (const key of Object.keys(DEFS)) out[key] = get(key);
  return out;
}

function set(values) {
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) {
      if (!DEFS[key]) continue;
      setStmt.run(key, serialize(key, value));
    }
  })();
}

function icsFeedToken() {
  let token = get('ics_feed_token');
  if (!token) {
    token = randomToken(24);
    set({ ics_feed_token: token });
  }
  return token;
}

module.exports = { get, getAll, set, DEFS, SECRET_KEYS, icsFeedToken };
