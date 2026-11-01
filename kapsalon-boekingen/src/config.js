'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

// Laad .env (Node >= 20.12 heeft een ingebouwde loader)
const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const port = Number(process.env.PORT) || 3000;
const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

function resolveSecret() {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 32) return process.env.APP_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_SECRET (minimaal 32 tekens) is verplicht in productie.');
  }
  // Ontwikkelmodus: genereer eenmalig een geheim en bewaar het naast de database.
  const file = path.join(dataDir, 'app-secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');

module.exports = {
  ROOT,
  port,
  host: process.env.HOST || '0.0.0.0',
  publicUrl,
  isHttps: publicUrl.startsWith('https://'),
  isProduction: process.env.NODE_ENV === 'production',
  dataDir,
  dbPath: process.env.DATABASE_PATH || path.join(dataDir, 'salon.db'),
  appSecret: resolveSecret(),
  timezone: process.env.SALON_TIMEZONE || 'Europe/Amsterdam',
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  mollieApiBase: (process.env.MOLLIE_API_BASE || 'https://api.mollie.com/v2').replace(/\/+$/, ''),
  // Standaardwaarden voor integraties; kunnen in /admin worden overschreven.
  defaults: {
    mollie_api_key: process.env.MOLLIE_API_KEY || '',
    smtp_host: process.env.SMTP_HOST || '',
    smtp_port: process.env.SMTP_PORT || '587',
    smtp_secure: process.env.SMTP_SECURE || 'false',
    smtp_user: process.env.SMTP_USER || '',
    smtp_pass: process.env.SMTP_PASS || '',
    smtp_from: process.env.SMTP_FROM || '',
  },
};
