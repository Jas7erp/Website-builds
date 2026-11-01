'use strict';
const { db, nowIso } = require('../db');
const config = require('../config');
const { hashPassword, verifyPassword, randomToken, sha256 } = require('./security');

const COOKIE = 'salon_admin';
const SESSION_HOURS = 12;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(value, maxAgeSec) {
  return [
    `${COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    config.isHttps ? 'Secure' : null,
    `Max-Age=${maxAgeSec}`,
  ].filter(Boolean).join('; ');
}

function createAdmin(email, password) {
  if (!email || !/@/.test(email)) throw new Error('Ongeldig e-mailadres');
  validatePassword(password);
  const now = nowIso();
  return db.prepare('INSERT INTO admins (email, password_hash, created_at, updated_at) VALUES (?,?,?,?)')
    .run(email.trim().toLowerCase(), hashPassword(password), now, now).lastInsertRowid;
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw new Error('Het wachtwoord moet minimaal 10 tekens lang zijn.');
  if (pw.length > 200) throw new Error('Het wachtwoord is te lang.');
}

function hasAdmin() {
  return db.prepare('SELECT COUNT(*) AS n FROM admins').get().n > 0;
}

// Constante rekentijd, ook als het account niet bestaat.
const DUMMY_HASH = hashPassword(randomToken(16));

function login(email, password, { ip, userAgent }) {
  const admin = db.prepare('SELECT * FROM admins WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (admin && admin.locked_until && admin.locked_until > nowIso()) {
    verifyPassword(String(password || ''), DUMMY_HASH);
    return { ok: false, error: `Te veel mislukte pogingen. Probeer het over ${LOCK_MINUTES} minuten opnieuw.` };
  }
  const valid = verifyPassword(String(password || ''), admin ? admin.password_hash : DUMMY_HASH) && Boolean(admin);
  if (!valid) {
    if (admin) {
      const failed = admin.failed_attempts + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
      db.prepare('UPDATE admins SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : failed, lock, admin.id);
    }
    return { ok: false, error: 'E-mailadres of wachtwoord is onjuist.' };
  }
  db.prepare('UPDATE admins SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(admin.id);
  const token = randomToken(32);
  const now = nowIso();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, created_at, last_seen, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?,?)')
    .run(sha256(token), admin.id, now, now, new Date(Date.now() + SESSION_HOURS * 3_600_000).toISOString(), ip, String(userAgent || '').slice(0, 200));
  return { ok: true, token, admin: { id: admin.id, email: admin.email } };
}

function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT s.*, a.email FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), nowIso());
  if (!row) return null;
  // Glijdende verlenging
  db.prepare('UPDATE admin_sessions SET last_seen = ?, expires_at = ? WHERE id = ?')
    .run(nowIso(), new Date(Date.now() + SESSION_HOURS * 3_600_000).toISOString(), row.id);
  return { sessionId: row.id, adminId: row.admin_id, email: row.email, token };
}

function requireAdmin(req, res, next) {
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Niet ingelogd.' });
  req.admin = session;
  res.setHeader('Set-Cookie', cookieString(session.token, SESSION_HOURS * 3600));
  next();
}

function logout(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
}

function changePassword(adminId, current, next, keepSessionId) {
  const admin = db.prepare('SELECT * FROM admins WHERE id = ?').get(adminId);
  if (!admin || !verifyPassword(String(current || ''), admin.password_hash)) throw new Error('Het huidige wachtwoord is onjuist.');
  validatePassword(next);
  db.prepare('UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(next), nowIso(), adminId);
  db.prepare('DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?').run(adminId, keepSessionId);
}

module.exports = {
  COOKIE, SESSION_HOURS, cookieString, createAdmin, hasAdmin, login, requireAdmin, logout, changePassword, validatePassword, parseCookies,
};
