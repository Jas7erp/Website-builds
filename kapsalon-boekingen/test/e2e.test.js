'use strict';
/**
 * End-to-end test van het volledige boekingsproces via de echte HTTP-API:
 * boeken, kortingscodes, aanbetaling (Mollie), webhooks, terugbetalingen,
 * "Mijn afspraak" met e-mailverificatie, beheeromgeving en CalDAV-synchronisatie.
 * Externe diensten (Mollie, iCloud, SMTP) worden vervangen door lokale testdubbels.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { mockMollie, mockCalDav, mockSmtp } = require('./mocks');

let base;
let server;
let mollie;
let caldav;
let smtp;
let adminCookie = '';
let db;

const ADMIN = { email: 'eigenaar@salon.test', password: 'Sterk-Wachtwoord-123' };
const MOLLIE_KEY = 'test_abcdefghijklmnopqrstuvwxyz1234';

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

async function req(method, url, { body, cookie, token, headers = {}, form } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (form) h['Content-Type'] = 'application/x-www-form-urlencoded';
  if (cookie) h.Cookie = cookie;
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers: h, body: form ? new URLSearchParams(form).toString() : body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* geen json */ }
  return { status: res.status, json, text, headers: res.headers };
}
const admin = (method, url, body) => req(method, `/api/admin${url}`, { body, cookie: adminCookie });

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 30)); }
  return fn();
};

let openDates = [];
async function findOpenDates(serviceId, count = 6) {
  const out = [];
  const start = new Date(Date.now() + 2 * 86_400_000);
  for (let i = 0; i < 40 && out.length < count; i++) {
    const d = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    const r = await req('GET', `/api/availability/day?service=${serviceId}&date=${d}`);
    if (r.json.slots.length >= 6) out.push({ date: d, slots: r.json.slots });
  }
  return out;
}

function bookingBody(over = {}) {
  return { serviceId: 1, firstName: 'Sanne', lastName: 'de Vries', email: 'sanne@example.com', phone: '06 12345678', notes: 'Graag laagjes', acceptPolicy: true, ...over };
}

const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');
const mailsTo = (addr, re) => smtp.messages.filter((m) => m.to.includes(addr) && (!re || re.test(m.subject)));

before(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-test-'));
  mollie = await mockMollie();
  caldav = await mockCalDav({ username: 'eigenaar@icloud.com', password: 'abcd-efgh-ijkl-mnop' });
  smtp = await mockSmtp();
  const port = await freePort();
  Object.assign(process.env, {
    DATA_DIR: tmp, PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}`, MOLLIE_API_BASE: mollie.base,
    APP_SECRET: 'x'.repeat(48), NODE_ENV: 'test', ENV_FILE: path.join(tmp, 'none.env'),
  });
  const { createApp } = require('../src/app');
  require('../src/lib/auth').createAdmin(ADMIN.email, ADMIN.password);
  db = require('../src/db').db;
  server = createApp().listen(port, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await Promise.all([mollie.close(), caldav.close(), smtp.close()]);
});

test('beheer: login is beveiligd', async () => {
  assert.equal((await req('GET', '/api/admin/dashboard')).status, 401);
  const bad = await req('POST', '/api/admin/login', { body: { email: ADMIN.email, password: 'fout' } });
  assert.equal(bad.status, 401);
  const ok = await req('POST', '/api/admin/login', { body: ADMIN });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  adminCookie = cookie.split(';')[0];
  assert.equal((await admin('GET', '/me')).json.email, ADMIN.email);
  // Cross-site verzoek wordt geweigerd
  const cross = await req('POST', '/api/admin/services', { body: {}, cookie: adminCookie, headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});

test('beheer: integraties instellen (SMTP, Mollie, iCloud-agenda)', async () => {
  let r = await admin('PUT', '/settings', {
    smtp_host: '127.0.0.1', smtp_port: smtp.port, smtp_secure: false, smtp_user: 'salon', smtp_pass: 'smtp-geheim',
    smtp_from: 'afspraken@salon.test', owner_notify_email: 'eigenaar@salon.test', salon_address: 'Dorpsstraat 1, Utrecht',
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.settings.email_configured, true);
  assert.equal(r.json.settings.smtp_pass_set, true);
  assert.equal(r.json.settings.smtp_pass, undefined, 'wachtwoord wordt niet teruggegeven');

  r = await admin('PUT', '/settings', { mollie_api_key: 'onzin' });
  assert.equal(r.status, 400);
  r = await admin('POST', '/settings/test-mollie', { key: MOLLIE_KEY });
  assert.equal(r.status, 200, r.text);
  r = await admin('PUT', '/settings', { mollie_api_key: MOLLIE_KEY });
  assert.equal(r.json.settings.mollie_mode, 'test');
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'mollie_api_key'").get().value;
  assert.match(stored, /^enc:v1:/, 'API-sleutel is versleuteld opgeslagen');

  r = await admin('POST', '/settings/test-email', {});
  assert.equal(r.status, 200, r.text);
  assert.ok(mailsTo('eigenaar@salon.test', /Testbericht/).length);

  r = await admin('POST', '/calendar/discover', { serverUrl: caldav.url, username: 'eigenaar@icloud.com', password: 'fout-wachtwoord' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /app-specifiek/);
  r = await admin('POST', '/calendar/discover', { serverUrl: caldav.url, username: 'eigenaar@icloud.com', password: 'abcd-efgh-ijkl-mnop' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.calendars.map((c) => c.name), ['Salon'], 'alleen agenda’s met VEVENT');
  r = await admin('POST', '/calendar/connect', { calendarUrl: r.json.calendars[0].url, calendarName: 'Salon', onCancel: 'delete' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.calendar.connected, true);
  assert.equal(caldav.events.size, 0, 'testitem is weer verwijderd');
});

test('beheer: kortingscodes aanmaken en valideren', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let r = await admin('POST', '/discounts', { code: 'welkom10', discountType: 'percent', discountValue: 10, oncePerCustomer: true, appliesToAll: true });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.discount.code, 'WELKOM10');
  assert.equal((await admin('POST', '/discounts', { code: 'WELKOM10', discountType: 'percent', discountValue: 5 })).status, 409);
  await admin('POST', '/discounts', { code: 'OUD', discountType: 'percent', discountValue: 20, startsOn: '2020-01-01', expiresOn: yesterday });
  await admin('POST', '/discounts', { code: 'HEREN5', discountType: 'fixed', discountValue: 500, appliesToAll: false, serviceIds: [2] });
  await admin('POST', '/discounts', { code: 'EENMALIG', discountType: 'fixed', discountValue: 1000, maxUses: 1, minAmountCents: 3000, startsOn: today });
  const off = await admin('POST', '/discounts', { code: 'UIT', discountType: 'percent', discountValue: 50 });
  await admin('POST', `/discounts/${off.json.discount.id}/toggle`, { active: false });
  r = await admin('GET', '/discounts');
  const states = Object.fromEntries(r.json.discounts.map((d) => [d.code, d.state]));
  assert.deepEqual(states, { WELKOM10: 'active', OUD: 'expired', HEREN5: 'active', EENMALIG: 'active', UIT: 'inactive' });

  const q = (code, serviceId = 1, email = 'sanne@example.com') => req('POST', '/api/quote', { body: { serviceId, discountCode: code, email, phone: '0612345678' } });
  r = await q('WELKOM10');
  assert.equal(r.json.discount.cents, 420);
  assert.equal(r.json.finalCents, 3780);
  assert.match((await q('OUD')).json.discountError, /verlopen/);
  assert.match((await q('UIT')).json.discountError, /niet meer geldig/);
  assert.match((await q('HEREN5', 1)).json.discountError, /niet geldig voor de gekozen behandeling/);
  assert.equal((await q('HEREN5', 2)).json.discount.cents, 500);
  assert.match((await q('BESTAATNIET')).json.discountError, /bestaat niet/);
  assert.match((await q('EENMALIG', 3)).json.discountError, /vanaf een bedrag/);
  // Aanbetaling wordt berekend over de prijs NA korting: Kleuren €75, 25%, -10% = €67,50 → €16,88
  r = await q('WELKOM10', 4);
  assert.equal(r.json.finalCents, 6750);
  assert.equal(r.json.depositCents, 1688);
  assert.equal(r.json.remainingCents, 5062);
});

test('boeken zonder aanbetaling: bevestiging, e-mail en agenda-item', async () => {
  openDates = await findOpenDates(1);
  assert.ok(openDates.length >= 4, 'genoeg open dagen gevonden');
  const { date, slots } = openDates[0];
  const time = slots[2];

  const invalid = await req('POST', '/api/bookings', { body: bookingBody({ date, time, email: 'geen-email', phone: '12' }) });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.json.fields.email && invalid.json.fields.phone);
  const notAccepted = await req('POST', '/api/bookings', { body: bookingBody({ date, time, acceptPolicy: false }) });
  assert.equal(notAccepted.status, 400);
  const offSlot = await req('POST', '/api/bookings', { body: bookingBody({ date, time: '03:00' }) });
  assert.equal(offSlot.status, 409, 'niet-bestaand tijdslot geweigerd');

  const r = await req('POST', '/api/bookings', { body: bookingBody({ date, time, discountCode: 'welkom10' }) });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.status, 'confirmed');
  assert.equal(r.json.checkoutUrl, null);
  assert.match(r.json.code, /^[A-Z2-9]{6}$/);
  assert.equal(r.json.booking.discountCents, 420);
  assert.equal(r.json.booking.finalCents, 3780);

  // Dubbele boeking op hetzelfde (of overlappende) tijdstip is onmogelijk
  const dup = await req('POST', '/api/bookings', { body: bookingBody({ date, time, email: 'ander@example.com' }) });
  assert.equal(dup.status, 409);
  const overlap = await req('POST', '/api/bookings', { body: bookingBody({ date, time: slots[3], email: 'ander@example.com' }) });
  assert.equal(overlap.status, 409, 'overlappende 45-min afspraak geweigerd');
  const after = await req('GET', `/api/availability/day?service=1&date=${date}`);
  assert.ok(!after.json.slots.includes(time), 'tijdslot niet meer beschikbaar');

  // Kortingscode maximaal één keer per klant
  const again = await req('POST', '/api/bookings', { body: bookingBody({ date: openDates[1].date, time: openDates[1].slots[0], discountCode: 'WELKOM10', email: 'SANNE@example.com' }) });
  assert.equal(again.status, 422);
  assert.match(again.json.error, /al eens gebruikt/);
  const samePhone = await req('POST', '/api/quote', { body: { serviceId: 1, discountCode: 'WELKOM10', email: 'nieuw@example.com', phone: '+31612345678' } });
  assert.match(samePhone.json.discountError, /al eens gebruikt/, 'ook herkend op telefoonnummer');

  await waitFor(() => mailsTo('sanne@example.com', /Bevestiging/).length);
  const mail = mailsTo('sanne@example.com', /Bevestiging/)[0];
  assert.match(mail.raw, /afspraak\.ics/, 'bevestiging bevat agenda-bijlage');
  assert.ok(mailsTo('eigenaar@salon.test', /Nieuwe afspraak/).length, 'eigenaar krijgt melding');

  await waitFor(() => caldav.events.size === 1);
  const ics = unfold([...caldav.events.values()][0]);
  assert.match(ics, /SUMMARY:Sanne de Vries – Knippen dames/);
  assert.match(ics, /Telefoon: 06 12345678/);
  assert.match(ics, /Opmerkingen: Graag laagjes/);
  assert.match(ics, /LOCATION:Dorpsstraat 1\\, Utrecht/);
});

let depositBooking;
test('boeken met aanbetaling via Mollie (webhook)', async () => {
  const kleuren = await findOpenDates(4, 3);
  const { date, slots } = kleuren[1];
  const r = await req('POST', '/api/bookings', { body: bookingBody({ serviceId: 4, date, time: slots[0], email: 'eva@example.com', firstName: 'Eva', lastName: 'Jansen', phone: '0687654321', discountCode: 'WELKOM10' }) });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.status, 'pending_payment');
  assert.match(r.json.checkoutUrl, /^https:\/\/mollie\.test\/checkout\/tr_/);
  const payment = [...mollie.payments.values()].at(-1);
  assert.equal(payment.amount.value, '16.88');
  assert.match(payment.redirectUrl, new RegExp(`boeking=${r.json.code}&t=`));

  // Tijdens het betalen is het tijdslot gereserveerd
  const slotsNow = await req('GET', `/api/availability/day?service=4&date=${date}`);
  assert.ok(!slotsNow.json.slots.includes(slots[0]));
  // Nog geen bevestiging en geen agenda-item
  assert.equal(mailsTo('eva@example.com').length, 0);

  // Webhook met een niet-betaalde status wijzigt niets
  let w = await req('POST', '/api/webhooks/mollie', { form: { id: payment.id } });
  assert.equal(w.status, 200);
  let st = await req('GET', `/api/bookings/${r.json.code}/status?t=${r.json.token}`);
  assert.equal(st.json.booking.status, 'pending_payment');
  assert.equal((await req('GET', `/api/bookings/${r.json.code}/status?t=verkeerd`)).status, 404);

  mollie.setStatus(payment.id, 'paid');
  w = await req('POST', '/api/webhooks/mollie', { form: { id: payment.id } });
  assert.equal(w.status, 200);
  await req('POST', '/api/webhooks/mollie', { form: { id: payment.id } }); // dubbele webhook is idempotent
  st = await req('GET', `/api/bookings/${r.json.code}/status?t=${r.json.token}`);
  assert.equal(st.json.booking.status, 'confirmed');
  assert.equal(st.json.booking.depositPaidCents, 1688, 'aanbetaling één keer geboekt');
  assert.equal(st.json.booking.remainingCents, 5062);
  await waitFor(() => mailsTo('eva@example.com', /Bevestiging/).length);
  await waitFor(() => caldav.events.size === 2);
  const ics = unfold([...caldav.events.values()].find((x) => x.includes('Eva Jansen')));
  assert.match(ics, /Aanbetaling: €\s16\\,88 betaald/);
  depositBooking = { code: r.json.code, token: r.json.token, date, time: slots[0] };
});

test('mislukte betaling: opnieuw betalen binnen de reserveringstijd', async () => {
  const { date, slots } = openDates[2];
  const r = await req('POST', '/api/bookings', { body: bookingBody({ serviceId: 5, date, time: slots[0], email: 'noor@example.com', firstName: 'Noor', lastName: 'Bakker', phone: '0611122233' }) });
  assert.equal(r.status, 201, r.text);
  const p1 = [...mollie.payments.values()].at(-1);
  assert.equal(p1.amount.value, '40.00', 'vaste aanbetaling balayage');
  mollie.setStatus(p1.id, 'canceled');
  let st = await req('GET', `/api/bookings/${r.json.code}/status?t=${r.json.token}`);
  assert.equal(st.json.booking.status, 'pending_payment');
  assert.equal(st.json.canRetry, true);
  const pay = await req('POST', `/api/bookings/${r.json.code}/pay`, { body: { token: r.json.token } });
  assert.equal(pay.status, 200, pay.text);
  const p2 = [...mollie.payments.values()].at(-1);
  assert.notEqual(p1.id, p2.id);
  mollie.setStatus(p2.id, 'paid', 'creditcard');
  st = await req('GET', `/api/bookings/${r.json.code}/status?t=${r.json.token}`);
  assert.equal(st.json.booking.status, 'confirmed', 'terugkeerpagina haalt status zelf op bij Mollie');
  assert.equal(st.json.booking.depositPaidCents, 4000);
});

test('verlopen reservering: late betaling op bezet tijdslot wordt automatisch terugbetaald', async () => {
  const { date, slots } = openDates[3];
  const r = await req('POST', '/api/bookings', { body: bookingBody({ serviceId: 5, date, time: slots[0], email: 'laat@example.com', firstName: 'Lars', lastName: 'Laat', phone: '0699988877' }) });
  const p = [...mollie.payments.values()].at(-1);
  // Simuleer dat de houdtijd verstreken is
  db.prepare('UPDATE bookings SET hold_expires_at = ? WHERE code = ?').run(new Date(Date.now() - 60_000).toISOString(), r.json.code);
  const free = await req('GET', `/api/availability/day?service=5&date=${date}`);
  assert.ok(free.json.slots.includes(slots[0]), 'tijdslot weer vrij na verlopen reservering');
  const other = await req('POST', '/api/bookings', { body: bookingBody({ serviceId: 1, date, time: slots[0], email: 'snel@example.com', firstName: 'Sem', lastName: 'Snel', phone: '0644455566' }) });
  assert.equal(other.status, 201);
  mollie.setStatus(p.id, 'paid');
  await req('POST', '/api/webhooks/mollie', { form: { id: p.id } });
  const st = await req('GET', `/api/bookings/${r.json.code}/status?t=${r.json.token}`);
  assert.equal(st.json.booking.status, 'cancelled');
  assert.equal(st.json.booking.refundedCents, 4000);
  assert.equal(p.amountRefunded.value, '40.00', 'terugbetaling daadwerkelijk bij Mollie aangevraagd');
  await waitFor(() => mailsTo('laat@example.com', /teruggestort/).length);
});

let manageToken;
test('Mijn afspraak: e-mailverificatie', async () => {
  const before = mailsTo('eva@example.com', /verificatiecode/).length;
  let r = await req('POST', '/api/manage/request', { body: { email: 'hacker@example.com', code: depositBooking.code } });
  assert.equal(r.status, 200, 'generiek antwoord bij verkeerd e-mailadres');
  assert.equal(mailsTo('hacker@example.com').length, 0);
  r = await req('POST', '/api/manage/request', { body: { email: 'EVA@example.com', code: depositBooking.code.toLowerCase() } });
  assert.equal(r.status, 200);
  await waitFor(() => mailsTo('eva@example.com', /verificatiecode/).length > before);
  const otp = mailsTo('eva@example.com', /verificatiecode/).at(-1).subject.match(/(\d{6})/)[1];
  assert.equal((await req('GET', '/api/manage/booking')).status, 401);
  const wrong = await req('POST', '/api/manage/verify', { body: { code: depositBooking.code, otp: otp === '000000' ? '111111' : '000000' } });
  assert.equal(wrong.status, 401);
  r = await req('POST', '/api/manage/verify', { body: { code: depositBooking.code, otp } });
  assert.equal(r.status, 200, r.text);
  manageToken = r.json.token;
  const reuse = await req('POST', '/api/manage/verify', { body: { code: depositBooking.code, otp } });
  assert.equal(reuse.status, 401, 'code is eenmalig');
  r = await req('GET', '/api/manage/booking', { token: manageToken });
  assert.equal(r.json.booking.code, depositBooking.code);
  assert.equal(r.json.booking.canChange, true);
  assert.equal(r.json.booking.terms.refundCents, 1688);
});

test('Mijn afspraak: wijzigen houdt boekingscode en agenda-item gelijk', async () => {
  const hrefsBefore = [...caldav.events.keys()];
  const avail = await req('GET', `/api/availability/day?service=4&date=${depositBooking.date}`, { token: manageToken });
  assert.ok(avail.json.slots.includes(depositBooking.time), 'eigen tijdslot telt niet als bezet');
  const newTime = avail.json.slots.find((s) => s !== depositBooking.time && s > depositBooking.time);
  // Andere behandeling met hogere aanbetaling is niet toegestaan zonder bijbetaling
  const cq = await req('POST', '/api/manage/change-quote', { token: manageToken, body: { serviceId: 5 } });
  assert.ok(cq.json.blocked);
  const blocked = await req('POST', '/api/manage/reschedule', { token: manageToken, body: { date: depositBooking.date, time: newTime, serviceId: 5 } });
  assert.equal(blocked.status, 422);

  const r = await req('POST', '/api/manage/reschedule', { token: manageToken, body: { date: depositBooking.date, time: newTime } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.booking.code, depositBooking.code);
  assert.equal(r.json.booking.time, newTime);
  await waitFor(() => mailsTo('eva@example.com', /Gewijzigd/).length);
  await waitFor(() => [...caldav.events.values()].some((x) => x.includes('Eva Jansen') && x.includes('SEQUENCE:1')));
  assert.deepEqual([...caldav.events.keys()].sort(), hrefsBefore.sort(), 'geen dubbel agenda-item');
  depositBooking.time = newTime;
});

test('Mijn afspraak: tijdig annuleren betaalt aanbetaling volledig terug', async () => {
  const r = await req('POST', '/api/manage/cancel', { token: manageToken, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.refundCents, 1688);
  assert.equal(r.json.feeCents, 0);
  const refund = [...mollie.refunds.values()].at(-1);
  assert.equal(refund.amount.value, '16.88');
  assert.equal((await req('POST', '/api/manage/cancel', { token: manageToken, body: {} })).status, 409, 'niet dubbel annuleren');
  await waitFor(() => mailsTo('eva@example.com', /Geannuleerd/).length);
  await waitFor(() => ![...caldav.events.values()].some((x) => x.includes('Eva Jansen')));
  const slots = await req('GET', `/api/availability/day?service=4&date=${depositBooking.date}`);
  assert.ok(slots.json.slots.includes(depositBooking.time), 'tijdslot weer vrij');
});

test('te late annulering: beleid wordt toegepast (50% terug)', async () => {
  await admin('PUT', '/settings', { cancel_window_hours: 336, late_cancel_refund_pct: 50 });
  const noor = db.prepare("SELECT b.code FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE c.email = 'noor@example.com'").get();
  await req('POST', '/api/manage/request', { body: { email: 'noor@example.com', code: noor.code } });
  await waitFor(() => mailsTo('noor@example.com', /verificatiecode/).length);
  const otp = mailsTo('noor@example.com', /verificatiecode/).at(-1).subject.match(/(\d{6})/)[1];
  const { json: { token } } = await req('POST', '/api/manage/verify', { body: { code: noor.code, otp } });
  const view = await req('GET', '/api/manage/booking', { token });
  assert.equal(view.json.booking.canChange, false, 'wijzigen niet meer toegestaan na termijn');
  assert.equal(view.json.booking.terms.refundCents, 2000);
  assert.equal(view.json.booking.terms.feeCents, 2000);
  const r = await req('POST', '/api/manage/cancel', { token, body: {} });
  assert.equal(r.json.refundCents, 2000);
  assert.equal(r.json.feeCents, 2000);
  await admin('PUT', '/settings', { cancel_window_hours: 24, late_cancel_refund_pct: 0 });
});

test('beheer: dashboard, agenda, handmatige afspraak, verzetten en annuleren', async () => {
  let r = await admin('GET', '/dashboard');
  assert.equal(r.status, 200);
  assert.ok(r.json.upcoming.length >= 2);
  assert.ok(r.json.cancelled.count >= 2);

  const { date, slots } = openDates[0];
  r = await admin('GET', `/bookings?from=${date}&to=${date}`);
  const sanne = r.json.bookings.find((b) => b.customer.email === 'sanne@example.com');
  assert.ok(sanne);
  assert.equal(sanne.discountCode, 'WELKOM10');
  assert.equal(r.json.days[0].breaks.length >= 0, true);

  // Handmatige afspraak die overlapt → conflict, met force toch mogelijk
  r = await admin('POST', '/bookings', { serviceId: 2, date, time: sanne.start, firstName: 'Piet', lastName: 'Klant', email: 'piet@example.com', phone: '0623456789', notifyCustomer: false });
  assert.equal(r.status, 409);
  r = await admin('POST', '/bookings', { serviceId: 2, date, time: slots[slots.length - 1], firstName: 'Piet', lastName: 'Klant', email: 'piet@example.com', phone: '0623456789', notifyCustomer: false, adminNotes: 'Vaste klant' });
  assert.equal(r.status, 201, r.text);
  const piet = r.json.booking;
  assert.equal(piet.status, 'confirmed');
  assert.equal(piet.source, 'admin');
  assert.equal(mailsTo('piet@example.com').length, 0, 'geen mail als dat is uitgezet');

  // Verzetten naar een tijd buiten de openingstijden mag voor de eigenaar
  r = await admin('POST', `/bookings/${piet.id}/reschedule`, { date, time: '07:30', notify: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.booking.start, '07:30');
  r = await admin('POST', `/bookings/${piet.id}/reschedule`, { date, time: sanne.start, notify: false });
  assert.equal(r.status, 409);
  r = await admin('POST', `/bookings/${piet.id}/status`, { status: 'completed', remainingPaid: true });
  assert.equal(r.json.booking.paymentStatus, 'paid_in_full');

  // Afspraak openen met alle details
  r = await admin('GET', `/bookings/${sanne.id}`);
  assert.equal(r.json.booking.customer.phone, '06 12345678');
  assert.ok(r.json.booking.events.length >= 2);
  assert.ok(r.json.booking.emails.some((e) => e.kind === 'confirmation' && e.status === 'sent'));
  assert.equal(r.json.booking.calSyncStatus, 'synced');

  // Annuleren door eigenaar
  r = await admin('POST', `/bookings/${sanne.id}/cancel`, { refundMode: 'none', notify: true, reason: 'Ziek' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.booking.status, 'cancelled');
  await waitFor(() => mailsTo('sanne@example.com', /Geannuleerd/).length);

  // Kortingscode-statistieken
  r = await admin('GET', '/discounts');
  const welkom = r.json.discounts.find((d) => d.code === 'WELKOM10');
  assert.equal(welkom.uses, 0, 'geannuleerde boekingen tellen niet mee');
  r = await admin('GET', `/discounts/${welkom.id}`);
  assert.equal(r.json.bookings.length, 2, 'beide boekingen met de code zichtbaar');

  // Betalingsoverzicht
  r = await admin('GET', '/payments');
  assert.equal(r.json.summary.received, 1688 + 4000 + 4000);
  assert.equal(r.json.summary.refunded, 1688 + 4000 + 2000);
});

test('beheer: behandelingen en openingstijden', async () => {
  let r = await admin('POST', '/services', { name: 'Föhnen', durationMin: 30, priceCents: 2500, depositType: 'percent', depositValue: 150 });
  assert.equal(r.status, 400);
  r = await admin('POST', '/services', { name: 'Föhnen', durationMin: 30, priceCents: 2500, depositType: 'fixed', depositValue: 500 });
  assert.equal(r.status, 201, r.text);
  const id = r.json.service.id;
  r = await req('GET', '/api/services');
  assert.ok(r.json.services.some((s) => s.id === id));
  await admin('PUT', `/services/${id}`, { ...r.json.services.find((s) => s.id === id), active: false, depositType: 'none', durationMin: 30, priceCents: 2500 });
  r = await req('GET', '/api/services');
  assert.ok(!r.json.services.some((s) => s.id === id), 'uitgeschakelde behandeling niet zichtbaar');
  assert.equal((await admin('DELETE', `/services/${id}`)).status, 200);

  // Vrije dag blokkeert online boeken
  const { date } = openDates[4] || openDates[1];
  r = await admin('POST', '/schedule/exceptions', { type: 'closed', startDate: date, endDate: date, label: 'Studiedag' });
  assert.equal(r.status, 201);
  r = await req('GET', `/api/availability/day?service=1&date=${date}`);
  assert.equal(r.json.slots.length, 0);
  const month = await req('GET', `/api/availability/month?service=1&month=${date.slice(0, 7)}`);
  assert.equal(month.json.days.find((d) => d.date === date).available, false);
  // Extra beschikbaarheid op die dag
  await admin('POST', '/schedule/exceptions', { type: 'extra', startDate: date, start: '18:00', end: '19:00' });
  r = await req('GET', `/api/availability/day?service=1&date=${date}`);
  assert.deepEqual(r.json.slots, ['18:00', '18:15']);
  // Tijdsblok blokkeren
  await admin('POST', '/schedule/exceptions', { type: 'block', startDate: date, start: '18:00', end: '18:30' });
  r = await req('GET', `/api/availability/day?service=2&date=${date}`);
  assert.deepEqual(r.json.slots, ['18:30']);
});

test('ICS-abonnementslink voor Apple Agenda', async () => {
  const { json: { calendar } } = await admin('GET', '/calendar');
  assert.match(calendar.webcalUrl, /^webcal:\/\//);
  const feedPath = new URL(calendar.feedUrl).pathname;
  const r = await req('GET', feedPath);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  assert.match(r.text, /BEGIN:VCALENDAR/);
  assert.match(r.text, /STATUS:CANCELLED/);
  assert.match(unfold(r.text), /Noor Bakker/);
  assert.equal((await req('GET', '/agenda/verkeerd-token.ics')).status, 404);
});

test('beveiliging: wachtwoord wijzigen en uitloggen', async () => {
  let r = await admin('POST', '/password', { current: 'fout', next: 'Nieuw-Wachtwoord-456' });
  assert.equal(r.status, 400);
  r = await admin('POST', '/password', { current: ADMIN.password, next: 'Nieuw-Wachtwoord-456' });
  assert.equal(r.status, 200);
  await admin('POST', '/logout', {});
  assert.equal((await admin('GET', '/me')).status, 401);
  const login = await req('POST', '/api/admin/login', { body: { email: ADMIN.email, password: 'Nieuw-Wachtwoord-456' } });
  assert.equal(login.status, 200);
});
