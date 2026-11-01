'use strict';
// Testdubbels voor externe diensten: Mollie API, CalDAV-server (iCloud-achtig) en SMTP.
const http = require('node:http');
const crypto = require('node:crypto');
const { SMTPServer } = require('smtp-server');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
  });
}

async function mockMollie() {
  const payments = new Map();
  const refunds = new Map();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    calls.push({ method: req.method, url: req.url, body });
    const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/hal+json' }); res.end(JSON.stringify(json)); };
    if (!/^Bearer (test|live)_[A-Za-z0-9]{20,}$/.test(req.headers.authorization || '')) return send(401, { status: 401, title: 'Unauthorized Request', detail: 'Missing authentication' });
    let m;
    if (req.method === 'GET' && req.url === '/v2/methods') return send(200, { _embedded: { methods: [{ description: 'iDEAL' }, { description: 'Creditcard' }] } });
    if (req.method === 'POST' && req.url === '/v2/payments') {
      const p = JSON.parse(body);
      const id = `tr_${crypto.randomBytes(5).toString('hex')}`;
      const payment = { resource: 'payment', id, mode: 'test', status: 'open', amount: p.amount, description: p.description, redirectUrl: p.redirectUrl, webhookUrl: p.webhookUrl, metadata: p.metadata, method: null, amountRefunded: { value: '0.00', currency: 'EUR' }, _links: { checkout: { href: `https://mollie.test/checkout/${id}` } } };
      payments.set(id, payment);
      return send(201, payment);
    }
    if (req.method === 'GET' && (m = req.url.match(/^\/v2\/payments\/(tr_\w+)$/))) {
      const p = payments.get(m[1]);
      return p ? send(200, p) : send(404, { status: 404, title: 'Not Found', detail: 'No payment exists with token' });
    }
    if (req.method === 'POST' && (m = req.url.match(/^\/v2\/payments\/(tr_\w+)\/refunds$/))) {
      const p = payments.get(m[1]);
      if (!p) return send(404, { title: 'Not Found', detail: 'no payment' });
      if (p.status !== 'paid') return send(422, { title: 'Unprocessable Entity', detail: 'The payment is not refundable' });
      const amount = Math.round(Number(JSON.parse(body).amount.value) * 100);
      const already = Math.round(Number(p.amountRefunded.value) * 100);
      if (already + amount > Math.round(Number(p.amount.value) * 100)) return send(422, { title: 'Unprocessable Entity', detail: 'The amount exceeds the refundable amount' });
      p.amountRefunded = { currency: 'EUR', value: ((already + amount) / 100).toFixed(2) };
      const refund = { resource: 'refund', id: `re_${crypto.randomBytes(5).toString('hex')}`, amount: { currency: 'EUR', value: (amount / 100).toFixed(2) }, status: 'pending', paymentId: p.id };
      refunds.set(refund.id, refund);
      return send(201, refund);
    }
    if (req.method === 'GET' && (m = req.url.match(/^\/v2\/payments\/(tr_\w+)\/refunds\/(re_\w+)$/))) {
      const r = refunds.get(m[2]);
      return r ? send(200, r) : send(404, { title: 'Not Found' });
    }
    send(404, { title: 'Not Found', detail: req.url });
  });
  const port = await listen(server);
  return {
    base: `http://127.0.0.1:${port}/v2`, payments, refunds, calls, server,
    setStatus(id, status, method = 'ideal') { const p = payments.get(id); p.status = status; if (status === 'paid') { p.method = method; p.paidAt = new Date().toISOString(); } },
    close: () => new Promise((r) => server.close(r)),
  };
}

async function mockCalDav({ username, password }) {
  const events = new Map(); // pad -> ics
  const log = [];
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    log.push({ method: req.method, url: req.url });
    if (req.headers.authorization !== auth) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }); return res.end(); }
    const ms = (inner) => { res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' }); res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">${inner}</d:multistatus>`); };
    if (req.method === 'PROPFIND' && req.url === '/') {
      return ms('<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/123456/principal/</d:href></d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
    }
    if (req.method === 'PROPFIND' && req.url === '/123456/principal/') {
      return ms('<d:response><d:href>/123456/principal/</d:href><d:propstat><d:prop><cal:calendar-home-set><d:href>/123456/calendars/</d:href></cal:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>');
    }
    if (req.method === 'PROPFIND' && req.url === '/123456/calendars/') {
      return ms(`
        <d:response><d:href>/123456/calendars/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
        <d:response><d:href>/123456/calendars/salon/</d:href><d:propstat><d:prop><d:displayname>Salon</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set><ic:calendar-color>#FF2968</ic:calendar-color></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
        <d:response><d:href>/123456/calendars/tasks/</d:href><d:propstat><d:prop><d:displayname>Herinneringen</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
    }
    if (req.method === 'PUT' && req.url.startsWith('/123456/calendars/salon/')) {
      const existed = events.has(req.url);
      events.set(req.url, body);
      res.writeHead(existed ? 204 : 201, { ETag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
      return res.end();
    }
    if (req.method === 'DELETE' && req.url.startsWith('/123456/calendars/salon/')) {
      const existed = events.delete(req.url);
      res.writeHead(existed ? 204 : 404);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/`, events, log, close: () => new Promise((r) => server.close(r)) };
}

async function mockSmtp() {
  const messages = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => { raw += c; });
      stream.on('end', () => {
        const subjectRaw = (raw.match(/^Subject: (.*(?:\r?\n[ \t].*)*)/m) || [])[1] || '';
        const subject = decodeHeader(subjectRaw.replace(/\r?\n[ \t]/g, ' '));
        messages.push({ to: session.envelope.rcptTo.map((r) => r.address), subject, raw });
        cb();
      });
    },
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.server.address().port)));
  return { port, messages, close: () => new Promise((r) => server.close(r)) };
}

function decodeHeader(v) {
  return v.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=\s*/gi, (_, enc, text) => {
    if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString('utf8');
    return Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1').toString('utf8');
  });
}

module.exports = { mockMollie, mockCalDav, mockSmtp };
