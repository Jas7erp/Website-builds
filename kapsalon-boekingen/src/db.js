'use strict';
const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id          INTEGER PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);

CREATE TABLE IF NOT EXISTS services (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  duration_min   INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 600),
  price_cents    INTEGER NOT NULL CHECK (price_cents >= 0),
  deposit_type   TEXT NOT NULL DEFAULT 'none' CHECK (deposit_type IN ('none','fixed','percent')),
  deposit_value  INTEGER NOT NULL DEFAULT 0 CHECK (deposit_value >= 0),
  active         INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- weekday: 0 = zondag ... 6 = zaterdag
CREATE TABLE IF NOT EXISTS opening_hours (
  weekday     INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  is_open     INTEGER NOT NULL DEFAULT 0,
  open_time   TEXT NOT NULL DEFAULT '09:00',
  close_time  TEXT NOT NULL DEFAULT '17:00'
);

CREATE TABLE IF NOT EXISTS breaks (
  id          INTEGER PRIMARY KEY,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT 'Pauze'
);

-- type: closed = hele dag(en) dicht (vakantie / vrije dag)
--       block  = tijdsblok op een datum blokkeren
--       extra  = extra beschikbaarheid op een datum
CREATE TABLE IF NOT EXISTS availability_exceptions (
  id          INTEGER PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('closed','block','extra')),
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  label       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exceptions_dates ON availability_exceptions(start_date, end_date);

CREATE TABLE IF NOT EXISTS customers (
  id                INTEGER PRIMARY KEY,
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone             TEXT NOT NULL,
  phone_normalized  TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_normalized);

CREATE TABLE IF NOT EXISTS discount_codes (
  id                 INTEGER PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description        TEXT NOT NULL DEFAULT '',
  discount_type      TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')),
  discount_value     INTEGER NOT NULL CHECK (discount_value > 0),
  starts_on          TEXT,
  expires_on         TEXT,
  max_uses           INTEGER,
  once_per_customer  INTEGER NOT NULL DEFAULT 0,
  min_amount_cents   INTEGER NOT NULL DEFAULT 0,
  applies_to_all     INTEGER NOT NULL DEFAULT 1,
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discount_code_services (
  code_id     INTEGER NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
  service_id  INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (code_id, service_id)
);

-- Tijden zijn lokale salontijd: date = YYYY-MM-DD, start_min/end_min = minuten na middernacht.
CREATE TABLE IF NOT EXISTS bookings (
  id                     INTEGER PRIMARY KEY,
  code                   TEXT NOT NULL UNIQUE,
  uid                    TEXT NOT NULL UNIQUE,
  customer_id            INTEGER NOT NULL REFERENCES customers(id),
  service_id             INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name           TEXT NOT NULL,
  duration_min           INTEGER NOT NULL,
  date                   TEXT NOT NULL,
  start_min              INTEGER NOT NULL,
  end_min                INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('pending_payment','confirmed','completed','no_show','cancelled','expired')),
  price_cents            INTEGER NOT NULL,
  discount_code_id       INTEGER REFERENCES discount_codes(id) ON DELETE SET NULL,
  discount_code          TEXT,
  discount_cents         INTEGER NOT NULL DEFAULT 0,
  final_price_cents      INTEGER NOT NULL,
  deposit_cents          INTEGER NOT NULL DEFAULT 0,
  deposit_paid_cents     INTEGER NOT NULL DEFAULT 0,
  refunded_cents         INTEGER NOT NULL DEFAULT 0,
  cancellation_fee_cents INTEGER NOT NULL DEFAULT 0,
  remaining_paid_at      TEXT,
  notes                  TEXT NOT NULL DEFAULT '',
  admin_notes            TEXT NOT NULL DEFAULT '',
  source                 TEXT NOT NULL DEFAULT 'online' CHECK (source IN ('online','admin')),
  hold_expires_at        TEXT,
  access_token_hash      TEXT,
  cancelled_at           TEXT,
  cancelled_by           TEXT,
  cancel_reason          TEXT,
  confirmed_at           TEXT,
  sequence               INTEGER NOT NULL DEFAULT 0,
  cal_href               TEXT,
  cal_etag               TEXT,
  cal_sync_status        TEXT NOT NULL DEFAULT 'pending',
  cal_sync_error         TEXT,
  cal_synced_at          TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_discount ON bookings(discount_code_id);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY,
  booking_id    INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL DEFAULT 'mollie',
  provider_id   TEXT NOT NULL UNIQUE,
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL,
  method        TEXT,
  checkout_url  TEXT,
  mode          TEXT,
  paid_at       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);

CREATE TABLE IF NOT EXISTS refunds (
  id            INTEGER PRIMARY KEY,
  payment_id    INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  booking_id    INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  provider_id   TEXT NOT NULL UNIQUE,
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manage_verifications (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manage_sessions (
  token_hash  TEXT PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_log (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  status      TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS booking_events (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  message     TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT 'system',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_booking ON booking_events(booking_id);
`;

db.exec(SCHEMA);

function nowIso() {
  return new Date().toISOString();
}

// Eenmalige standaardgegevens bij een lege database
function seed() {
  const hasHours = db.prepare('SELECT COUNT(*) AS n FROM opening_hours').get().n;
  if (!hasHours) {
    const ins = db.prepare('INSERT INTO opening_hours (weekday, is_open, open_time, close_time) VALUES (?,?,?,?)');
    const defaults = {
      0: [0, '10:00', '16:00'],
      1: [0, '09:00', '17:30'],
      2: [1, '09:00', '17:30'],
      3: [1, '09:00', '17:30'],
      4: [1, '09:00', '20:00'],
      5: [1, '09:00', '17:30'],
      6: [1, '09:00', '16:00'],
    };
    const insBreak = db.prepare('INSERT INTO breaks (weekday, start_time, end_time, label) VALUES (?,?,?,?)');
    db.transaction(() => {
      for (const [wd, [open, o, c]] of Object.entries(defaults)) ins.run(Number(wd), open, o, c);
      for (const wd of [2, 3, 4, 5]) insBreak.run(wd, '12:30', '13:00', 'Lunchpauze');
    })();
  }
  const hasServices = db.prepare('SELECT COUNT(*) AS n FROM services').get().n;
  if (!hasServices) {
    const now = nowIso();
    const ins = db.prepare(`INSERT INTO services (name, description, duration_min, price_cents, deposit_type, deposit_value, sort_order, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      ins.run('Knippen dames', 'Wassen, knippen en stylen', 45, 4200, 'none', 0, 1, now, now);
      ins.run('Knippen heren', 'Wassen en knippen', 30, 2800, 'none', 0, 2, now, now);
      ins.run('Kinderen t/m 12 jaar', 'Knippen', 30, 2000, 'none', 0, 3, now, now);
      ins.run('Kleuren', 'Uitgroei of volledige kleuring, inclusief föhnen', 90, 7500, 'percent', 25, 4, now, now);
      ins.run('Balayage', 'Handgeschilderde highlights, inclusief toner en styling', 150, 14500, 'fixed', 4000, 5, now, now);
    })();
  }
}
seed();

module.exports = { db, nowIso };
