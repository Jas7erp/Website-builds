'use strict';
const config = require('../config');
const settings = require('./settings');

class MollieError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

function apiKey() {
  return settings.get('mollie_api_key');
}

function isConfigured() {
  return /^(live|test)_[A-Za-z0-9]{20,}$/.test(apiKey() || '');
}

function mode() {
  const key = apiKey() || '';
  return key.startsWith('live_') ? 'live' : key.startsWith('test_') ? 'test' : null;
}

function centsToValue(cents) {
  return (cents / 100).toFixed(2);
}
function valueToCents(value) {
  return Math.round(Number.parseFloat(value) * 100);
}

async function request(method, path, body, keyOverride) {
  const key = keyOverride || apiKey();
  if (!key) throw new MollieError('Er is geen Mollie API-sleutel ingesteld.', 0);
  const res = await fetch(`${config.mollieApiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/hal+json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const msg = json && (json.detail || json.title) ? `${json.title || 'Fout'}: ${json.detail || ''}` : `HTTP ${res.status}`;
    throw new MollieError(`Mollie: ${msg}`, res.status, json);
  }
  return json;
}

// Mollie accepteert geen webhook-URL's die niet publiek bereikbaar zijn.
function webhookUrl() {
  const url = `${config.publicUrl}/api/webhooks/mollie`;
  if (/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(config.publicUrl) && !process.env.MOLLIE_FORCE_WEBHOOK) return undefined;
  return url;
}

async function createPayment({ amountCents, description, redirectUrl, metadata }) {
  const payload = {
    amount: { currency: 'EUR', value: centsToValue(amountCents) },
    description: description.slice(0, 255),
    redirectUrl,
    metadata,
    locale: 'nl_NL',
  };
  const hook = webhookUrl();
  if (hook) payload.webhookUrl = hook;
  return request('POST', '/payments', payload);
}

function getPayment(id) {
  if (!/^tr_[A-Za-z0-9]+$/.test(id)) throw new MollieError('Ongeldig betalings-ID', 400);
  return request('GET', `/payments/${encodeURIComponent(id)}`);
}

function createRefund(paymentId, amountCents, description) {
  return request('POST', `/payments/${encodeURIComponent(paymentId)}/refunds`, {
    amount: { currency: 'EUR', value: centsToValue(amountCents) },
    description: description.slice(0, 140),
  });
}

function getRefund(paymentId, refundId) {
  return request('GET', `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`);
}

// Controleer een sleutel door de beschikbare betaalmethoden op te vragen
async function testKey(key) {
  const res = await request('GET', '/methods', null, key);
  return (res && res._embedded && res._embedded.methods || []).map((m) => m.description);
}

module.exports = {
  MollieError, isConfigured, mode, createPayment, getPayment, createRefund, getRefund,
  testKey, centsToValue, valueToCents,
};
