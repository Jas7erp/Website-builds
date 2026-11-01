'use strict';
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  isArray: (name) => ['response', 'propstat', 'comp', 'href'].includes(name),
});

function authHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function davRequest(url, { method, username, password, depth, body, headers = {} }) {
  let current = url;
  // Handmatig redirects volgen zodat de methode (PROPFIND/PUT) behouden blijft.
  for (let i = 0; i < 5; i++) {
    const res = await fetch(current, {
      method,
      redirect: 'manual',
      headers: {
        Authorization: authHeader(username, password),
        ...(depth !== undefined ? { Depth: String(depth) } : {}),
        ...(body ? { 'Content-Type': headers['Content-Type'] || 'application/xml; charset=utf-8' } : {}),
        ...headers,
      },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if ([301, 302, 307, 308].includes(res.status) && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, url: current };
  }
  throw new Error('Te veel doorverwijzingen van de agendaserver.');
}

function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return asText(v[0]);
  if (typeof v === 'object' && '#text' in v) return String(v['#text']);
  return '';
}

function firstHref(prop) {
  if (!prop) return null;
  const h = prop.href;
  return h ? asText(h) : null;
}

function parseMultistatus(text) {
  const xml = parser.parse(text);
  const ms = xml.multistatus;
  if (!ms) return [];
  return (ms.response || []).map((r) => {
    const okStat = (r.propstat || []).find((p) => /\s200\s/.test(asText(p.status))) || (r.propstat || [])[0];
    return { href: asText(r.href), prop: okStat ? okStat.prop || {} : {} };
  });
}

function ensureOk(res, what) {
  if (res.status === 401 || res.status === 403) {
    throw new Error('Inloggen bij de agendaserver is mislukt. Controleer je Apple ID en app-specifiek wachtwoord.');
  }
  if (res.status !== 207 && (res.status < 200 || res.status >= 300)) {
    throw new Error(`${what} mislukt (HTTP ${res.status}).`);
  }
}

const PROP_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
const PROP_HOME = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
const PROP_CALENDARS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
  <d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/></d:prop>
</d:propfind>`;

/** Zoek de agenda's van een account (werkt met iCloud en andere CalDAV-servers). */
async function discoverCalendars({ serverUrl, username, password }) {
  const auth = { username, password };
  // 1. principal
  let res = await davRequest(serverUrl, { method: 'PROPFIND', depth: 0, body: PROP_PRINCIPAL, ...auth });
  ensureOk(res, 'Verbinden met de agendaserver');
  let entries = parseMultistatus(res.text);
  const principalHref = entries.map((e) => firstHref(e.prop['current-user-principal'])).find(Boolean);
  if (!principalHref) throw new Error('De agendaserver gaf geen gebruikersaccount terug.');
  const principalUrl = new URL(principalHref, res.url).toString();

  // 2. calendar home
  res = await davRequest(principalUrl, { method: 'PROPFIND', depth: 0, body: PROP_HOME, ...auth });
  ensureOk(res, 'Agenda-overzicht opvragen');
  entries = parseMultistatus(res.text);
  const homeHref = entries.map((e) => firstHref(e.prop['calendar-home-set'])).find(Boolean);
  if (!homeHref) throw new Error('Geen agenda-map gevonden voor dit account.');
  const homeUrl = new URL(homeHref, res.url).toString();

  // 3. agenda's
  res = await davRequest(homeUrl, { method: 'PROPFIND', depth: 1, body: PROP_CALENDARS, ...auth });
  ensureOk(res, "Agenda's opvragen");
  entries = parseMultistatus(res.text);
  const calendars = [];
  for (const e of entries) {
    const rt = e.prop.resourcetype;
    if (!rt || typeof rt !== 'object' || !('calendar' in rt)) continue;
    const comps = e.prop['supported-calendar-component-set'];
    if (comps && comps.comp) {
      const names = comps.comp.map((c) => c['@_name']);
      if (!names.includes('VEVENT')) continue;
    }
    calendars.push({
      url: new URL(e.href, res.url).toString(),
      name: asText(e.prop.displayname) || e.href,
      color: asText(e.prop['calendar-color']) || null,
    });
  }
  return { principalUrl, homeUrl, calendars };
}

function eventUrl(calendarUrl, uid) {
  const base = calendarUrl.endsWith('/') ? calendarUrl : `${calendarUrl}/`;
  return new URL(`${encodeURIComponent(uid)}.ics`, base).toString();
}

async function putEvent({ calendarUrl, username, password, uid, ics, href }) {
  const url = href || eventUrl(calendarUrl, uid);
  const res = await davRequest(url, {
    method: 'PUT', username, password, body: ics,
    headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
  });
  if (res.status === 401 || res.status === 403) ensureOk(res);
  if (![200, 201, 204].includes(res.status)) throw new Error(`Agenda-item opslaan mislukt (HTTP ${res.status}).`);
  return { href: url, etag: res.headers.get('etag') };
}

async function deleteEvent({ href, username, password }) {
  const res = await davRequest(href, { method: 'DELETE', username, password });
  if (res.status === 401 || res.status === 403) ensureOk(res);
  if (![200, 204, 404, 410].includes(res.status)) throw new Error(`Agenda-item verwijderen mislukt (HTTP ${res.status}).`);
}

module.exports = { discoverCalendars, putEvent, deleteEvent, eventUrl, parseMultistatus };
