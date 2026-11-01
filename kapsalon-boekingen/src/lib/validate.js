'use strict';
const { normalizePhone, normalizeEmail } = require('./pricing');

class ValidationError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.status = 400;
    this.fields = fields;
    this.expose = true;
  }
}

class AppError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.expose = true;
    Object.assign(this, extra);
  }
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function customer(input) {
  const fields = {};
  const firstName = cleanText(input.firstName, 60);
  const lastName = cleanText(input.lastName, 80);
  const email = normalizeEmail(input.email);
  const phoneRaw = cleanText(input.phone, 30);
  const phone = normalizePhone(phoneRaw);
  if (!firstName) fields.firstName = 'Vul je voornaam in.';
  else if (!/^[\p{L}][\p{L}\p{M}' .-]*$/u.test(firstName)) fields.firstName = 'Gebruik alleen letters.';
  if (!lastName) fields.lastName = 'Vul je achternaam in.';
  else if (!/^[\p{L}][\p{L}\p{M}' .-]*$/u.test(lastName)) fields.lastName = 'Gebruik alleen letters.';
  if (!email) fields.email = 'Vul je e-mailadres in.';
  else if (email.length > 254 || !EMAIL_RE.test(email)) fields.email = 'Dit e-mailadres lijkt niet te kloppen.';
  if (!phoneRaw) fields.phone = 'Vul je telefoonnummer in.';
  else if (!/^\+?\d{9,15}$/.test(phone) || !/^[\d\s+()./-]+$/.test(phoneRaw)) fields.phone = 'Dit telefoonnummer lijkt niet te kloppen.';
  if (Object.keys(fields).length) throw new ValidationError('Controleer je gegevens.', fields);
  return { firstName, lastName, email, phone: phoneRaw, phoneNormalized: phone };
}

function int(v, { min = -Infinity, max = Infinity, name = 'waarde' } = {}) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`Ongeldige ${name}.`);
  return n;
}

module.exports = { ValidationError, AppError, customer, cleanText, int, EMAIL_RE };
