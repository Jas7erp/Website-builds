/* Beheeromgeving (SPA met hash-routering) */
(function () {
  'use strict';
  const { h, clear, api, euro, fmtDate, duration, toast, icon, ICONS, modal, confirmDialog, busy, monthCalendar, slotPicker, field } = UI;
  const app = document.getElementById('app');

  const NAV = [
    ['dashboard', 'Overzicht', '<path d="M3 10.5 10 4l7 6.5V17a1 1 0 0 1-1 1h-4v-5H8v5H4a1 1 0 0 1-1-1z"/>'],
    ['agenda', 'Agenda', '<rect x="2.8" y="4" width="14.4" height="13" rx="3"/><path d="M2.8 8h14.4M6.5 2.2v3.4M13.5 2.2v3.4"/>'],
    ['behandelingen', 'Behandelingen', '<circle cx="6" cy="14" r="2.6"/><circle cx="14" cy="14" r="2.6"/><path d="M7.8 12.1 15 3.5M12.2 12.1 5 3.5"/>'],
    ['beschikbaarheid', 'Openingstijden', '<circle cx="10" cy="10" r="7.2"/><path d="M10 5.8V10l3 2"/>'],
    ['kortingscodes', 'Kortingscodes', '<path d="M3 10.6V4a1 1 0 0 1 1-1h6.6l6.4 6.4a1.4 1.4 0 0 1 0 2L11.4 17a1.4 1.4 0 0 1-2 0z"/><circle cx="7" cy="7" r="1.3"/>'],
    ['betalingen', 'Betalingen', '<rect x="2.5" y="4.5" width="15" height="11" rx="2.5"/><path d="M2.5 8.5h15M6 12.5h3"/>'],
    ['instellingen', 'Instellingen', '<circle cx="10" cy="10" r="2.6"/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"/>'],
  ];
  const navIcon = (paths) => h('span', { html: `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>` });

  const STATUS = {
    pending_payment: ['Wacht op betaling', 'orange'], confirmed: ['Bevestigd', 'blue'], completed: ['Afgerond', 'green'],
    no_show: ['Niet verschenen', 'red'], cancelled: ['Geannuleerd', ''], expired: ['Verlopen', ''],
  };
  const PAY_STATUS = {
    awaiting_deposit: ['Aanbetaling open', 'orange'], deposit_paid: ['Aanbetaling voldaan', 'green'], paid_in_full: ['Volledig betaald', 'green'],
    pay_in_salon: ['Betalen in salon', ''], refunded: ['Terugbetaald', 'purple'], partially_refunded: ['Deels terugbetaald', 'purple'], open: ['Open', 'orange'],
  };
  const MOLLIE_STATUS = { open: ['Open', 'orange'], pending: ['In behandeling', 'orange'], authorized: ['Geautoriseerd', 'blue'], paid: ['Betaald', 'green'], failed: ['Mislukt', 'red'], canceled: ['Geannuleerd', ''], expired: ['Verlopen', ''] };
  const REFUND_STATUS = { queued: 'In wachtrij', pending: 'In behandeling', processing: 'Wordt verwerkt', refunded: 'Teruggestort', failed: 'Mislukt', canceled: 'Geannuleerd' };
  const badge = ([label, color] = ['–', '']) => h('span', { class: `badge ${color}` }, label);
  const statusBadge = (s) => badge(STATUS[s]);
  const dt = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
  const row = (k, v, cls = '') => h('div', { class: `list-row ${cls}` }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());

  let me = null;
  let salon = { name: '', logo: null };
  let services = [];

  // ---------- Routering ----------
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query] = raw.split('?');
    return { path: path || 'dashboard', params: new URLSearchParams(query || '') };
  }
  function navigate(path, params) {
    const q = params ? `?${new URLSearchParams(params)}` : '';
    location.hash = `#/${path}${q}`;
  }

  async function boot() {
    try {
      const r = await api('/api/admin/me');
      me = r.email;
    } catch {
      return renderLogin();
    }
    await loadBasics();
    window.addEventListener('hashchange', route);
    route();
  }

  async function loadBasics() {
    const [s, sv] = await Promise.all([api('/api/admin/settings'), api('/api/admin/services')]);
    salon = { name: s.settings.salon_name, logo: s.settings.salon_logo };
    services = sv.services;
  }

  // ---------- Inloggen ----------
  async function renderLogin() {
    clear(app);
    let hasAdmin = true;
    try { hasAdmin = (await api('/api/admin/setup-status')).hasAdmin; } catch { /* ignore */ }
    const email = field({ label: 'E-mailadres', name: 'email', type: 'email', autocomplete: 'username' });
    const pw = field({ label: 'Wachtwoord', name: 'password', type: 'password', autocomplete: 'current-password' });
    const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Inloggen');
    const err = h('div', { class: 'field-error', role: 'alert' });
    const form = h('form', { class: 'login glass fade-in', novalidate: true },
      h('div', { class: 'logo' }),
      h('h1', { style: { fontSize: '26px' } }, 'Beheer'),
      h('p', { class: 'muted', style: { margin: '6px 0 22px' } }, 'Log in om je agenda en instellingen te beheren.'),
      !hasAdmin ? h('div', { class: 'note orange', style: { marginBottom: '16px' } }, 'Er is nog geen eigenaarsaccount. Maak er een aan op de server met ', h('code', null, 'npm run create-admin'), '.') : null,
      h('div', { class: 'form' }, email.el, pw.el, err, btn));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      err.textContent = '';
      busy(btn, async () => {
        try {
          const r = await api('/api/admin/login', { method: 'POST', body: { email: email.input.value, password: pw.input.value } });
          me = r.admin.email;
          await loadBasics();
          window.addEventListener('hashchange', route);
          route();
        } catch (e2) { err.textContent = e2.message; pw.input.select(); }
      });
    });
    app.append(h('div', { class: 'login-wrap' }, form));
    email.input.focus();
  }

  // ---------- Layout ----------
  function shell(active, content) {
    clear(app);
    const logo = h('div', { class: 'logo' }, salon.logo ? h('img', { src: salon.logo, alt: '' }) : null);
    const nav = NAV.map(([key, label, paths]) => h('a', { class: `nav-item ${active === key ? 'active' : ''}`, href: `#/${key}` }, navIcon(paths), label));
    const sidebar = h('aside', { class: 'sidebar' }, h('div', { class: 'sidebar-inner glass' },
      h('div', { class: 'side-brand' }, logo, h('div', null, h('strong', null, salon.name), h('span', { class: 'small muted' }, 'Beheer'))),
      ...nav,
      h('div', { class: 'nav-spacer' }),
      h('a', { class: 'nav-item', href: '/', target: '_blank', rel: 'noopener' }, navIcon('<path d="M8 4H4.5A1.5 1.5 0 0 0 3 5.5v10A1.5 1.5 0 0 0 4.5 17h10a1.5 1.5 0 0 0 1.5-1.5V12M11 3h6v6M17 3l-8 8"/>'), 'Boekingspagina'),
      h('button', { class: 'nav-item btn-plain', style: { border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left' }, onclick: logout }, navIcon('<path d="M8 17H4.5A1.5 1.5 0 0 1 3 15.5v-11A1.5 1.5 0 0 1 4.5 3H8M13 14l4-4-4-4M17 10H8"/>'), 'Uitloggen')));
    const SHORT = { dashboard: 'Overzicht', agenda: 'Agenda', behandelingen: 'Diensten', beschikbaarheid: 'Tijden', kortingscodes: 'Korting', betalingen: 'Betaling', instellingen: 'Meer' };
  const tabbar = h('nav', { class: 'tabbar glass' }, NAV.map(([key, label, paths]) => h('a', { class: active === key ? 'active' : '', href: `#/${key}`, 'aria-label': label }, navIcon(paths), SHORT[key])));
    const main = h('main', { class: 'main fade-in' }, content);
    app.append(h('div', { class: 'layout' }, sidebar, main), tabbar);
    return main;
  }

  function pageHead(title, sub, ...tools) {
    return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null), h('div', { class: 'toolbar' }, ...tools));
  }

  async function logout() {
    await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {});
    location.hash = '';
    location.reload();
  }

  async function route() {
    const { path, params } = parseHash();
    const views = { dashboard: viewDashboard, agenda: viewAgenda, behandelingen: viewServices, beschikbaarheid: viewSchedule, kortingscodes: viewDiscounts, betalingen: viewPayments, instellingen: viewSettings };
    const view = views[path] || viewDashboard;
    try {
      await view(params);
    } catch (err) {
      if (err.status === 401) return renderLogin();
      toast(err.message, 'error');
    }
  }

  // ---------- Dashboard ----------
  function apptItem(b, { showDate = false } = {}) {
    return h('button', { class: 'appt', onclick: () => openBooking(b.id) },
      h('div', { class: 'time' }, b.start, showDate ? h('small', null, fmtDate(b.date, { weekday: 'short', day: 'numeric', month: 'short' })) : h('small', null, b.end)),
      h('div', { class: 'who' }, h('strong', null, b.customer.name), h('span', null, `${b.serviceName} · ${euro(b.finalCents)}`)),
      statusBadge(b.status));
  }

  async function viewDashboard() {
    const d = await api('/api/admin/dashboard');
    const content = h('div');
    shell('dashboard', content);
    content.append(pageHead(`Goedendag`, `${d.dateLabel} · ${d.status.label}`,
      searchBox(),
      h('button', { class: 'btn btn-primary', onclick: () => newBookingModal({ date: d.date }) }, icon('plus'), 'Afspraak')));
    if (d.warnings.length) {
      content.append(h('div', { class: 'warnings' }, d.warnings.map((w) => h('div', { class: 'note orange' }, h('span', null, w.text),
        h('a', { class: 'btn btn-glass btn-sm', href: `#/instellingen?tab=${({ mollie: 'betalingen', email: 'email', calendar: 'agenda' })[w.key]}` }, 'Instellen')))));
    }
    const op = d.openPayments;
    content.append(h('div', { class: 'cards' },
      stat('Vandaag', d.today.length, d.today.length === 1 ? 'afspraak' : 'afspraken'),
      stat('Deze week', d.week.count, `${euro(d.week.revenueCents)} omzet gepland`),
      stat('Geannuleerd', d.cancelled.count, 'afgelopen 30 dagen'),
      stat('Openstaand', op.awaitingCount + op.toCollectCount, `${euro(op.awaitingCents + op.toCollectCents)} te ontvangen`)));

    const todayPanel = h('section', { class: 'panel glass' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Vandaag'), h('a', { class: 'btn btn-plain btn-sm', href: `#/agenda?view=day&date=${d.date}` }, 'Dagweergave')),
      d.today.length ? h('div', { class: 'appt-list' }, d.today.map((b) => apptItem(b))) : h('div', { class: 'empty' }, 'Geen afspraken vandaag.'));
    const upcomingPanel = h('section', { class: 'panel glass' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Eerstvolgende'), h('a', { class: 'btn btn-plain btn-sm', href: '#/agenda?view=week' }, 'Week')),
      d.upcoming.length ? h('div', { class: 'appt-list' }, d.upcoming.map((b) => apptItem(b, { showDate: true }))) : h('div', { class: 'empty' }, 'Geen geplande afspraken.'));
    content.append(h('div', { class: 'two-col' }, todayPanel, upcomingPanel));

    const openList = [...op.awaiting, ...op.toCollect];
    content.append(h('div', { class: 'two-col' },
      h('section', { class: 'panel glass' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Openstaande betalingen'), h('a', { class: 'btn btn-plain btn-sm', href: '#/betalingen' }, 'Alle betalingen')),
        openList.length ? h('div', { class: 'appt-list' }, openList.slice(0, 10).map((b) => h('button', { class: 'appt', onclick: () => openBooking(b.id) },
          h('div', { class: 'time' }, b.start, h('small', null, fmtDate(b.date, { day: 'numeric', month: 'short' }))),
          h('div', { class: 'who' }, h('strong', null, b.customer.name), h('span', null, b.status === 'pending_payment' ? `Aanbetaling ${euro(b.depositCents - b.depositPaidCents)} open` : `Restbedrag ${euro(b.remainingCents)} in salon`)),
          b.status === 'pending_payment' ? badge(['Wacht op betaling', 'orange']) : badge(['Te innen', 'orange'])))) : h('div', { class: 'empty' }, 'Alles is voldaan.'),
        op.pendingRefunds.n ? h('div', { class: 'note', style: { marginTop: '10px' } }, `${op.pendingRefunds.n} terugbetaling(en) worden verwerkt (${euro(op.pendingRefunds.s)}).`) : null),
      h('section', { class: 'panel glass' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Recent geannuleerd')),
        d.cancelled.recent.length ? h('div', { class: 'appt-list' }, d.cancelled.recent.map((b) => apptItem(b, { showDate: true }))) : h('div', { class: 'empty' }, 'Geen annuleringen.'))));
  }

  function stat(label, value, meta) {
    return h('div', { class: 'stat glass' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, String(value)), h('div', { class: 'meta' }, meta));
  }

  function searchBox() {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Zoek klant of boekingscode', 'aria-label': 'Zoeken' });
    const results = h('div', { class: 'search-results glass glass-strong', hidden: true });
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) { results.hidden = true; return; }
        const r = await api(`/api/admin/search?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
        clear(results);
        results.hidden = false;
        if (!r.results.length) results.append(h('div', { class: 'empty' }, 'Niets gevonden'));
        results.append(...r.results.map((b) => apptItem(b, { showDate: true })));
      }, 220);
    });
    input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 200));
    return h('div', { class: 'search' }, input, results);
  }

  // ---------- Agenda ----------
  const agendaState = { view: window.innerWidth < 860 ? 'day' : 'week', date: null, cancelled: false };
  const PX = 1.3; // pixels per minuut

  function rangeFor(view, date) {
    if (view === 'day') return [date, date];
    if (view === 'week') {
      const wd = UI.weekdayIndex(date);
      const mon = UI.addDays(date, wd === 0 ? -6 : 1 - wd);
      return [mon, UI.addDays(mon, 6)];
    }
    const first = `${date.slice(0, 7)}-01`;
    const wd = UI.weekdayIndex(first);
    const start = UI.addDays(first, wd === 0 ? -6 : 1 - wd);
    return [start, UI.addDays(start, 41)];
  }

  async function viewAgenda(params) {
    if (params.get('view')) agendaState.view = params.get('view');
    agendaState.date = params.get('date') || agendaState.date || todayStr();
    const { view, date } = agendaState;
    const [from, to] = rangeFor(view, date);
    const data = await api(`/api/admin/bookings?from=${from}&to=${to}${agendaState.cancelled ? '&cancelled=1' : ''}`);

    const content = h('div');
    shell('agenda', content);
    const step = (n) => {
      const d = view === 'day' ? UI.addDays(date, n) : view === 'week' ? UI.addDays(date, 7 * n) : `${UI.addMonths(date.slice(0, 7), n)}-01`;
      navigate('agenda', { view, date: d });
    };
    const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Weergave' }, [['day', 'Dag'], ['week', 'Week'], ['month', 'Maand']].map(([k, l]) =>
      h('button', { 'aria-pressed': view === k ? 'true' : 'false', onclick: () => navigate('agenda', { view: k, date }) }, l)));
    let rangeLabel;
    if (view === 'day') rangeLabel = fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    else if (view === 'week') rangeLabel = `${fmtDate(from, { day: 'numeric', month: 'short' })} – ${fmtDate(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    else rangeLabel = fmtDate(`${date.slice(0, 7)}-15`, { month: 'long', year: 'numeric' });

    const cancelledToggle = h('label', { class: 'check', style: { alignItems: 'center' } }, h('input', { type: 'checkbox', checked: agendaState.cancelled, onchange: (e) => { agendaState.cancelled = e.target.checked; route(); } }), 'Toon geannuleerd');
    content.append(pageHead('Agenda', null, searchBox(), h('button', { class: 'btn btn-primary', onclick: () => newBookingModal({ date: view === 'month' ? todayStr() : date }) }, icon('plus'), 'Afspraak')));
    content.append(h('div', { class: 'cal-toolbar' },
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-glass btn-icon btn-sm', 'aria-label': 'Vorige', html: ICONS.left, onclick: () => step(-1) }),
        h('button', { class: 'btn btn-glass btn-sm', onclick: () => navigate('agenda', { view, date: todayStr() }) }, 'Vandaag'),
        h('button', { class: 'btn btn-glass btn-icon btn-sm', 'aria-label': 'Volgende', html: ICONS.right, onclick: () => step(1) }),
        h('div', { class: 'cal-range' }, rangeLabel)),
      h('div', { class: 'row' }, cancelledToggle, seg)));

    const panel = h('section', { class: 'panel glass agenda' });
    content.append(panel);
    if (view === 'month') panel.append(monthGrid(data, date));
    else panel.append(timeGrid(data, view === 'day' ? [date] : Array.from({ length: 7 }, (_, i) => UI.addDays(from, i))));

    const bid = params.get('booking');
    if (bid) { openBooking(Number(bid)); history.replaceState(null, '', `#/agenda?view=${view}&date=${date}`); }
  }

  function timeGrid(data, dates) {
    const dayMap = new Map(data.days.map((d) => [d.date, d]));
    let minM = 9 * 60;
    let maxM = 18 * 60;
    for (const d of data.days) for (const [s, e] of d.open) { minM = Math.min(minM, s); maxM = Math.max(maxM, e); }
    for (const b of data.bookings) { minM = Math.min(minM, b.startMin); maxM = Math.max(maxM, b.endMin); }
    minM = Math.max(0, Math.floor(minM / 60) * 60 - 60);
    maxM = Math.min(24 * 60, Math.ceil(maxM / 60) * 60 + 60);
    const height = (maxM - minM) * PX;
    const cols = `56px repeat(${dates.length}, minmax(${dates.length > 1 ? 110 : 200}px, 1fr))`;
    const today = todayStr();

    const head = h('div', { class: 'tg-head', style: { gridTemplateColumns: cols } }, h('div'),
      dates.map((d) => h('div', { class: `dh ${d === today ? 'today' : ''}`, onclick: () => navigate('agenda', { view: 'day', date: d }) },
        fmtDate(d, { weekday: 'short' }), h('strong', null, String(Number(d.slice(8)))))));

    const times = h('div', { class: 'tg-times', style: { height: `${height}px` } });
    for (let m = minM; m <= maxM; m += 60) times.append(h('span', { style: { top: `${(m - minM) * PX}px` } }, m === minM ? '' : UI.toHHMM(m)));

    const columns = dates.map((d) => {
      const info = dayMap.get(d) || { open: [], breaks: [], blocks: [] };
      const col = h('div', { class: 'tg-col', style: { height: `${height}px` } });
      // gesloten delen arceren
      let cursor = minM;
      const opens = [...info.open].sort((a, b) => a[0] - b[0]);
      for (const [s, e] of opens) { if (s > cursor) col.append(h('div', { class: 'closed', style: { top: `${(cursor - minM) * PX}px`, height: `${(s - cursor) * PX}px` } })); cursor = Math.max(cursor, e); }
      if (cursor < maxM) col.append(h('div', { class: 'closed', style: { top: `${(cursor - minM) * PX}px`, height: `${(maxM - cursor) * PX}px` } }));
      for (let m = minM; m < maxM; m += 60) {
        col.append(h('div', { class: 'hour', style: { top: `${(m - minM) * PX}px` } }), h('div', { class: 'half', style: { top: `${(m + 30 - minM) * PX}px` } }));
      }
      for (const br of [...info.breaks, ...info.blocks]) {
        const s = UI.toMin(br.start); const e = UI.toMin(br.end);
        col.append(h('div', { class: 'brk', style: { top: `${(s - minM) * PX}px`, height: `${(e - s) * PX}px` } }, br.label || 'Geblokkeerd'));
      }
      const adder = h('div', { class: 'add', style: { top: 0, height: `${height}px` }, title: 'Klik om een afspraak toe te voegen' });
      adder.addEventListener('click', (e) => {
        const rect = adder.getBoundingClientRect();
        const m = minM + Math.round((e.clientY - rect.top) / PX / 15) * 15;
        newBookingModal({ date: d, time: UI.toHHMM(Math.max(0, Math.min(m, 23 * 60 + 45))) });
      });
      col.append(adder);
      // afspraken met eenvoudige baanverdeling bij overlap
      const evs = data.bookings.filter((b) => b.date === d).sort((a, b) => a.startMin - b.startMin);
      const lanes = [];
      const placed = evs.map((b) => {
        let lane = lanes.findIndex((end) => end <= b.startMin);
        if (lane < 0) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = b.endMin;
        return { b, lane };
      });
      const laneCount = Math.max(1, lanes.length);
      for (const { b, lane } of placed) {
        const top = (b.startMin - minM) * PX;
        const hgt = Math.max(22, (b.endMin - b.startMin) * PX - 2);
        col.append(h('button', {
          class: `ev ${b.status}`, style: { top: `${top}px`, height: `${hgt}px`, left: `calc(${(lane / laneCount) * 100}% + 4px)`, right: 'auto', width: `calc(${100 / laneCount}% - 8px)` },
          onclick: () => openBooking(b.id), title: `${b.start}–${b.end} ${b.customer.name} · ${b.serviceName}`,
        }, h('strong', null, `${b.start} ${b.customer.name}`), hgt > 34 ? h('span', null, b.serviceName) : null, hgt > 52 && b.customer.phone ? h('span', null, b.customer.phone) : null));
      }
      if (d === today) {
        const now = new Date();
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).split(':').map(Number);
        const nm = parts[0] * 60 + parts[1];
        if (nm >= minM && nm <= maxM) col.append(h('div', { class: 'now', style: { top: `${(nm - minM) * PX}px` } }));
      }
      return col;
    });
    const body = h('div', { class: 'tg-body', style: { gridTemplateColumns: cols } }, times, ...columns);
    const wrap = h('div', { style: { overflowX: 'auto' } }, h('div', { style: { minWidth: dates.length > 1 ? '820px' : '0' } }, head, body));
    setTimeout(() => {
      const first = Math.min(...data.days.flatMap((d) => d.open.map(([s]) => s)), 9 * 60);
      body.scrollTop = Math.max(0, (first - minM - 30) * PX);
    }, 30);
    return wrap;
  }

  function monthGrid(data, date) {
    const month = date.slice(0, 7);
    const today = todayStr();
    const byDate = new Map();
    for (const b of data.bookings) { if (!byDate.has(b.date)) byDate.set(b.date, []); byDate.get(b.date).push(b); }
    const dayInfo = new Map(data.days.map((d) => [d.date, d]));
    const grid = h('div', { class: 'month' }, ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((d) => h('div', { class: 'dow' }, d)));
    for (const d of data.days.map((x) => x.date)) {
      const list = byDate.get(d) || [];
      const info = dayInfo.get(d);
      const cell = h('div', { class: `cell ${d.slice(0, 7) !== month ? 'other' : ''} ${d === today ? 'today' : ''} ${info && !info.open.length ? 'closed' : ''}`, onclick: () => navigate('agenda', { view: 'day', date: d }) },
        h('div', { class: 'd' }, String(Number(d.slice(8)))),
        list.slice(0, 3).map((b) => h('div', { class: `mi ${b.status}`, title: `${b.start} ${b.customer.name}` }, `${b.start} ${b.customer.firstName}`)),
        list.length > 3 ? h('div', { class: 'more' }, `+${list.length - 3} meer`) : null);
      grid.append(cell);
    }
    return grid;
  }

  // ---------- Afspraakdetail ----------
  async function openBooking(id) {
    const m = modal({ title: 'Afspraak', wide: true });
    const load = async () => {
      clear(m.body).append(h('div', { class: 'skeleton', style: { height: '300px' } }));
      try {
        const { booking } = await api(`/api/admin/bookings/${id}`);
        renderDetail(m, booking, load);
      } catch (err) { clear(m.body).append(h('div', { class: 'empty' }, err.message)); }
    };
    load();
    return m;
  }

  function renderDetail(m, b, reload) {
    m.setTitle(`${b.customer.name}`);
    const refundable = b.depositPaidCents - b.refundedCents;
    const active = ['confirmed', 'pending_payment'].includes(b.status);
    const adminNotes = h('textarea', { class: 'textarea', maxlength: 1000, placeholder: 'Alleen zichtbaar voor jou' });
    adminNotes.value = b.adminNotes || '';
    adminNotes.addEventListener('change', async () => {
      try { await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { adminNotes: adminNotes.value } }); toast('Notitie opgeslagen'); } catch (err) { toast(err.message, 'error'); }
    });

    const after = async (promise, msg) => {
      try { await promise; if (msg) toast(msg); reload(); refreshCurrent(); } catch (err) { toast(err.message, 'error', 5000); }
    };

    const actionsBar = h('div', { class: 'action-bar' });
    if (active) {
      actionsBar.append(h('button', { class: 'btn btn-glass btn-sm', onclick: () => rescheduleModal(b, () => { reload(); refreshCurrent(); }) }, 'Verzetten'));
      actionsBar.append(h('button', { class: 'btn btn-danger btn-sm', onclick: () => cancelModal(b, () => { reload(); refreshCurrent(); }) }, 'Annuleren'));
    }
    if (b.status === 'confirmed') {
      actionsBar.append(h('button', { class: 'btn btn-glass btn-sm', onclick: (e) => busy(e.currentTarget, () => after(api(`/api/admin/bookings/${b.id}/status`, { method: 'POST', body: { status: 'completed', remainingPaid: true } }), 'Afgerond')) }, `Afronden${b.remainingCents ? ` · ${euro(b.remainingCents)} ontvangen` : ''}`));
      actionsBar.append(h('button', { class: 'btn btn-glass btn-sm', onclick: (e) => busy(e.currentTarget, () => after(api(`/api/admin/bookings/${b.id}/status`, { method: 'POST', body: { status: 'no_show' } }), 'Gemarkeerd als niet verschenen')) }, 'Niet verschenen'));
      actionsBar.append(h('button', { class: 'btn btn-plain btn-sm', onclick: (e) => busy(e.currentTarget, () => after(api(`/api/admin/bookings/${b.id}/resend`, { method: 'POST', body: {} }), 'Bevestiging opnieuw verstuurd')) }, 'Bevestiging opnieuw sturen'));
    }
    if (['completed', 'no_show'].includes(b.status)) {
      actionsBar.append(h('button', { class: 'btn btn-glass btn-sm', onclick: (e) => busy(e.currentTarget, () => after(api(`/api/admin/bookings/${b.id}/status`, { method: 'POST', body: { status: 'confirmed' } }), 'Teruggezet naar bevestigd')) }, 'Terugzetten naar bevestigd'));
    }
    if (refundable > 0) actionsBar.append(h('button', { class: 'btn btn-glass btn-sm', onclick: () => refundModal(b, () => { reload(); refreshCurrent(); }) }, 'Terugbetalen'));
    if (b.status === 'pending_payment') actionsBar.append(h('button', { class: 'btn btn-glass btn-sm', onclick: (e) => busy(e.currentTarget, () => after(api(`/api/admin/bookings/${b.id}/check-payment`, { method: 'POST', body: {} }), 'Betaalstatus bijgewerkt')) }, 'Betaling controleren'));

    const calStatus = { synced: badge(['Gesynchroniseerd', 'green']), pending: badge(['Wordt gesynchroniseerd', 'orange']), error: badge(['Fout', 'red']), disabled: badge(['Niet gekoppeld', '']) }[b.calSyncStatus] || badge(['–', '']);

    clear(m.body).append(h('div', { class: 'fade-in' },
      h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '16px' } }, statusBadge(b.status), badge(PAY_STATUS[b.paymentStatus]), h('span', { class: 'mono muted' }, b.code), b.source === 'admin' ? h('span', { class: 'badge plain' }, 'Handmatig') : null),
      h('div', { class: 'detail-grid' },
        h('div', { class: 'detail-block' }, h('h3', null, 'Afspraak'),
          row('Behandeling', `${b.serviceName} · ${duration(b.durationMin)}`),
          row('Datum', fmtDate(b.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
          row('Tijd', `${b.start} – ${b.end}`),
          b.notes ? row('Opmerking klant', b.notes) : null,
          b.status === 'cancelled' ? row('Geannuleerd', `${dt(b.cancelledAt)} door ${b.cancelledBy === 'owner' ? 'jou' : b.cancelledBy === 'customer' ? 'klant' : 'systeem'}`) : null,
          b.cancelReason ? row('Reden', b.cancelReason) : null),
        h('div', { class: 'detail-block' }, h('h3', null, 'Klant'),
          row('Naam', b.customer.name),
          row('Telefoon', h('a', { href: `tel:${b.customer.phone.replace(/\s/g, '')}` }, b.customer.phone)),
          row('E-mail', h('a', { href: `mailto:${b.customer.email}` }, b.customer.email)),
          row('Afspraken', `${b.customerStats.total} totaal${b.customerStats.noShows ? ` · ${b.customerStats.noShows}× niet verschenen` : ''}${b.customerStats.cancelled ? ` · ${b.customerStats.cancelled}× geannuleerd` : ''}`),
          h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn btn-plain btn-sm', onclick: () => editCustomerModal(b, reload) }, 'Gegevens wijzigen'))),
        h('div', { class: 'detail-block' }, h('h3', null, 'Prijs & betaling'),
          row('Prijs', euro(b.priceCents)),
          b.discountCode ? row(`Kortingscode ${b.discountCode}`, `– ${euro(b.discountCents)}`, 'discount') : row('Kortingscode', 'Geen'),
          row('Totaal', euro(b.finalCents), 'total'),
          b.depositCents ? row('Aanbetaling', `${euro(b.depositPaidCents)} van ${euro(b.depositCents)}`) : row('Aanbetaling', 'Niet vereist'),
          b.refundedCents ? row('Terugbetaald', euro(b.refundedCents)) : null,
          b.cancellationFeeCents ? row('Ingehouden', euro(b.cancellationFeeCents)) : null,
          b.status !== 'cancelled' ? row('Resterend in salon', b.remainingPaidAt ? `${euro(b.remainingCents)} · ontvangen` : euro(b.remainingCents)) : null,
          b.payments.length ? h('div', { style: { marginTop: '8px' } }, b.payments.map((p) => h('div', { class: 'row small', style: { justifyContent: 'space-between', padding: '4px 0' } },
            h('span', { class: 'mono' }, p.provider_id), h('span', null, euro(p.amount_cents)), badge(MOLLIE_STATUS[p.status]), p.mode === 'test' ? h('span', { class: 'badge plain' }, 'test') : null))) : null,
          b.refunds.length ? h('div', { style: { marginTop: '6px' } }, b.refunds.map((r) => h('div', { class: 'row small', style: { justifyContent: 'space-between', padding: '4px 0' } },
            h('span', null, 'Terugbetaling'), h('span', null, euro(r.amount_cents)), h('span', { class: 'muted' }, REFUND_STATUS[r.status] || r.status)))) : null),
        h('div', { class: 'detail-block' }, h('h3', null, 'Notities & agenda'),
          adminNotes,
          h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '12px' } }, h('span', { class: 'small muted' }, 'Apple Agenda'), calStatus),
          b.calSyncError ? h('div', { class: 'hint' }, b.calSyncError) : null,
          b.calSyncStatus === 'error' ? h('button', { class: 'btn btn-plain btn-sm', onclick: (e) => busy(e.currentTarget, () => after(api(`/api/admin/bookings/${b.id}/sync`, { method: 'POST', body: {} }), 'Opnieuw gesynchroniseerd')) }, 'Opnieuw proberen') : null)),
      actionsBar,
      h('details', { style: { marginTop: '18px' } }, h('summary', { class: 'small muted', style: { cursor: 'pointer' } }, 'Geschiedenis, e-mails en eerdere afspraken'),
        h('div', { class: 'timeline', style: { marginTop: '12px' } }, b.events.map((e) => h('div', null, h('time', null, dt(e.created_at)), h('span', null, e.message)))),
        b.emails.length ? h('div', { class: 'timeline', style: { marginTop: '12px' } }, b.emails.map((e) => h('div', null, h('time', null, dt(e.created_at)), h('span', null, `${e.subject} → ${e.to_addr} (${e.status === 'sent' ? 'verzonden' : e.status === 'skipped' ? 'niet verzonden: ' + (e.error || '') : 'mislukt: ' + (e.error || '')})`)))) : null,
        b.customerHistory.length ? h('div', { class: 'timeline', style: { marginTop: '12px' } }, b.customerHistory.map((x) => h('div', null, h('time', null, `${fmtDate(x.date, { day: 'numeric', month: 'short', year: '2-digit' })} ${x.start}`), h('a', { href: '#', onclick: (e) => { e.preventDefault(); m.close(); openBooking(x.id); } }, `${x.service_name} · ${x.statusLabel}`)))) : null)));
  }

  function refreshCurrent() {
    const { path } = parseHash();
    if (['dashboard', 'agenda', 'betalingen'].includes(path)) route();
  }

  function editCustomerModal(b, reload) {
    const f = {
      firstName: field({ label: 'Voornaam', name: 'firstName', value: b.customer.firstName }),
      lastName: field({ label: 'Achternaam', name: 'lastName', value: b.customer.lastName }),
      email: field({ label: 'E-mail', name: 'email', type: 'email', value: b.customer.email }),
      phone: field({ label: 'Telefoon', name: 'phone', type: 'tel', value: b.customer.phone }),
    };
    const save = h('button', { class: 'btn btn-primary' }, 'Opslaan');
    const m = modal({ title: 'Klantgegevens', content: [h('div', { class: 'form' }, h('div', { class: 'grid-2' }, f.firstName.el, f.lastName.el), f.email.el, f.phone.el), h('div', { class: 'modal-foot' }, save)] });
    save.addEventListener('click', () => busy(save, async () => {
      try {
        await api(`/api/admin/bookings/${b.id}`, { method: 'PATCH', body: { customer: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.input.value])) } });
        m.close(); toast('Opgeslagen'); reload();
      } catch (err) { for (const [k, v] of Object.entries(f)) v.setError(err.fields[k]); if (!Object.keys(err.fields).length) toast(err.message, 'error'); }
    }));
  }

  // Datum + tijd kiezer voor beheer (vrije tijd toegestaan)
  function adminSlotChooser({ serviceId, durationMin, date, time, excludeId, onChange }) {
    const sel = { date: date || todayStr(), time: time || '' };
    const dateInput = h('input', { class: 'input', type: 'date', value: sel.date });
    const timeInput = h('input', { class: 'input', type: 'time', step: '300', value: sel.time });
    const slotsBox = h('div', { class: 'section-gap' });
    let currentService = serviceId;
    let currentDuration = durationMin;
    async function loadSlots() {
      clear(slotsBox);
      if (!sel.date || !currentService) return;
      try {
        const r = await api(`/api/admin/slots?date=${sel.date}&service=${currentService}${currentDuration ? `&duration=${currentDuration}` : ''}${excludeId ? `&exclude=${excludeId}` : ''}`);
        slotsBox.append(h('div', { class: 'label', style: { marginBottom: '8px' } }, r.slots.length ? 'Vrije tijden (binnen openingstijden)' : 'Geen vrije tijden binnen de openingstijden. Je kunt hierboven een eigen tijd invullen.'));
        if (r.slots.length) slotsBox.append(slotPicker(r.slots, { selected: sel.time, onSelect: (tm) => { sel.time = tm; timeInput.value = tm; onChange(sel); } }));
      } catch (err) { slotsBox.append(h('div', { class: 'hint' }, err.message)); }
    }
    dateInput.addEventListener('change', () => { sel.date = dateInput.value; loadSlots(); onChange(sel); });
    timeInput.addEventListener('change', () => { sel.time = timeInput.value; onChange(sel); });
    loadSlots();
    return {
      el: h('div', null, h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', null, 'Datum'), dateInput), h('div', { class: 'field' }, h('label', null, 'Tijd'), timeInput)), slotsBox),
      setService(id, dur) { currentService = id; currentDuration = dur; loadSlots(); },
      get value() { return sel; },
    };
  }

  function serviceSelect(selectedId, { includeInactive = true } = {}) {
    const list = services.filter((s) => includeInactive || s.active);
    return h('select', { class: 'select' }, list.map((s) => h('option', { value: String(s.id), selected: s.id === selectedId }, `${s.name} · ${duration(s.durationMin)} · ${euro(s.priceCents)}${s.active ? '' : ' (uitgeschakeld)'}`)));
  }

  function newBookingModal({ date, time } = {}) {
    if (!services.length) { toast('Voeg eerst een behandeling toe.', 'error'); return; }
    const svc = serviceSelect(services.find((s) => s.active)?.id || services[0].id);
    const f = {
      firstName: field({ label: 'Voornaam', name: 'firstName' }),
      lastName: field({ label: 'Achternaam', name: 'lastName' }),
      email: field({ label: 'E-mail', name: 'email', type: 'email' }),
      phone: field({ label: 'Telefoon', name: 'phone', type: 'tel' }),
    };
    const notes = field({ label: 'Opmerking (zichtbaar in agenda)', name: 'notes', textarea: true, maxlength: 500 });
    const code = field({ label: 'Kortingscode (optioneel)', name: 'code', maxlength: 40 });
    const notify = h('input', { type: 'checkbox', checked: true });
    const svcObj = () => services.find((s) => s.id === Number(svc.value));
    const chooser = adminSlotChooser({ serviceId: Number(svc.value), durationMin: svcObj().durationMin, date, time, onChange: () => {} });
    svc.addEventListener('change', () => chooser.setService(Number(svc.value), svcObj().durationMin));
    const save = h('button', { class: 'btn btn-primary' }, 'Afspraak toevoegen');
    const m = modal({
      title: 'Nieuwe afspraak', wide: true,
      content: [h('div', { class: 'form' },
        h('div', { class: 'field' }, h('label', null, 'Behandeling'), svc), chooser.el,
        h('div', { class: 'grid-2' }, f.firstName.el, f.lastName.el), h('div', { class: 'grid-2' }, f.email.el, f.phone.el),
        notes.el, code.el,
        h('label', { class: 'check' }, notify, 'Stuur de klant een bevestigingsmail'),
        h('div', { class: 'hint' }, 'Bij handmatige afspraken wordt geen aanbetaling gevraagd; het volledige bedrag wordt in de salon betaald.')),
      h('div', { class: 'modal-foot' }, save)],
    });
    const submit = async (force = false) => {
      const v = chooser.value;
      if (!v.date || !v.time) { toast('Kies een datum en tijd.', 'error'); return; }
      try {
        const r = await api('/api/admin/bookings', { method: 'POST', body: {
          serviceId: Number(svc.value), date: v.date, time: v.time, notes: notes.input.value, discountCode: code.input.value,
          notifyCustomer: notify.checked, force, ...Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.input.value])),
        } });
        m.close();
        toast('Afspraak toegevoegd');
        refreshCurrent();
        openBooking(r.booking.id);
      } catch (err) {
        for (const [k, x] of Object.entries(f)) x.setError(err.fields[k]);
        if (err.code === 'slot_taken' && await confirmDialog({ title: 'Tijd overlapt', message: `${err.message} Toch inplannen?`, confirmLabel: 'Toch inplannen' })) return submit(true);
        if (err.code === 'discount_invalid') code.setError(err.message);
        else if (!Object.keys(err.fields).length && err.code !== 'slot_taken') toast(err.message, 'error', 5000);
      }
    };
    save.addEventListener('click', () => busy(save, () => submit(false)));
  }

  function rescheduleModal(b, done) {
    const svc = serviceSelect(b.serviceId);
    if (!services.some((s) => s.id === b.serviceId)) svc.prepend(h('option', { value: String(b.serviceId), selected: true }, b.serviceName));
    const svcObj = () => services.find((s) => s.id === Number(svc.value));
    const chooser = adminSlotChooser({ serviceId: b.serviceId, durationMin: b.durationMin, date: b.date, time: b.start, excludeId: b.id, onChange: () => {} });
    svc.addEventListener('change', () => { const s = svcObj(); chooser.setService(Number(svc.value), s ? s.durationMin : b.durationMin); });
    const notify = h('input', { type: 'checkbox', checked: true });
    const save = h('button', { class: 'btn btn-primary' }, 'Verzetten');
    const m = modal({ title: 'Afspraak verzetten', subtitle: `${b.customer.name} · nu ${fmtDate(b.date)} ${b.start}`, wide: true,
      content: [h('div', { class: 'form' }, h('div', { class: 'field' }, h('label', null, 'Behandeling'), svc), chooser.el, h('label', { class: 'check' }, notify, 'Stuur de klant een e-mail over de wijziging')), h('div', { class: 'modal-foot' }, save)] });
    const submit = async (force) => {
      const v = chooser.value;
      try {
        await api(`/api/admin/bookings/${b.id}/reschedule`, { method: 'POST', body: { date: v.date, time: v.time, serviceId: Number(svc.value), force, notify: notify.checked } });
        m.close(); toast('Afspraak verzet'); done();
      } catch (err) {
        if (err.code === 'slot_taken' && await confirmDialog({ title: 'Tijd overlapt', message: `${err.message} Toch verzetten?`, confirmLabel: 'Toch verzetten' })) return submit(true);
        if (err.code !== 'slot_taken') toast(err.message, 'error', 5000);
      }
    };
    save.addEventListener('click', () => busy(save, () => submit(false)));
  }

  function cancelModal(b, done) {
    const refundable = b.depositPaidCents - b.refundedCents;
    const t = b.terms;
    let mode = refundable > 0 ? 'full' : 'none';
    const customInput = h('input', { class: 'input', type: 'number', min: '0', step: '0.01', max: (refundable / 100).toFixed(2), value: (refundable / 100).toFixed(2), hidden: true });
    const opts = refundable > 0 ? h('div', { class: 'field' }, h('label', null, 'Terugbetaling aanbetaling'),
      h('div', { class: 'segmented', style: { flexWrap: 'wrap' } }, [
        ['full', `Volledig (${euro(refundable)})`], ['policy', `Volgens beleid (${euro(t.refundCents)})`], ['none', 'Geen'], ['custom', 'Ander bedrag'],
      ].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': k === mode ? 'true' : 'false', onclick: (e) => {
        mode = k; e.currentTarget.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === e.currentTarget ? 'true' : 'false')); customInput.hidden = k !== 'custom';
      } }, l))), customInput, h('div', { class: 'hint' }, 'De terugbetaling wordt direct via Mollie verwerkt.')) : null;
    const reason = field({ label: 'Reden (optioneel, intern)', name: 'reason', maxlength: 300 });
    const notify = h('input', { type: 'checkbox', checked: true });
    const btn = h('button', { class: 'btn btn-danger' }, 'Afspraak annuleren');
    const m = modal({ title: 'Afspraak annuleren', subtitle: `${b.customer.name} · ${fmtDate(b.date)} ${b.start}`,
      content: [h('div', { class: 'form' }, opts, reason.el, h('label', { class: 'check' }, notify, 'Stuur de klant een annuleringsbevestiging')), h('div', { class: 'modal-foot' }, btn)] });
    btn.addEventListener('click', () => busy(btn, async () => {
      try {
        const r = await api(`/api/admin/bookings/${b.id}/cancel`, { method: 'POST', body: { refundMode: mode, refundCents: Math.round(Number(customInput.value) * 100), reason: reason.input.value, notify: notify.checked } });
        m.close(); toast(r.refundCents ? `Geannuleerd · ${euro(r.refundCents)} terugbetaald` : 'Afspraak geannuleerd'); done();
      } catch (err) { toast(err.message, 'error', 6000); }
    }));
  }

  function refundModal(b, done) {
    const refundable = b.depositPaidCents - b.refundedCents;
    const amount = h('input', { class: 'input', type: 'number', min: '0.01', step: '0.01', max: (refundable / 100).toFixed(2), value: (refundable / 100).toFixed(2) });
    const btn = h('button', { class: 'btn btn-primary' }, 'Terugbetalen');
    const m = modal({ title: 'Terugbetalen', subtitle: `Maximaal ${euro(refundable)}`, content: [h('div', { class: 'field' }, h('label', null, 'Bedrag (€)'), amount), h('div', { class: 'modal-foot' }, btn)] });
    btn.addEventListener('click', () => busy(btn, async () => {
      try { await api(`/api/admin/bookings/${b.id}/refund`, { method: 'POST', body: { amountCents: Math.round(Number(amount.value) * 100) } }); m.close(); toast('Terugbetaling verwerkt'); done(); } catch (err) { toast(err.message, 'error', 5000); }
    }));
  }

  // ---------- Behandelingen ----------
  async function viewServices() {
    const r = await api('/api/admin/services');
    services = r.services;
    const content = h('div');
    shell('behandelingen', content);
    content.append(pageHead('Behandelingen', 'Prijzen, behandeltijden en aanbetalingen', h('button', { class: 'btn btn-primary', onclick: () => serviceModal() }, icon('plus'), 'Behandeling')));
    const tbody = h('tbody');
    for (const s of services) {
      const dep = s.depositType === 'none' ? '–' : s.depositType === 'percent' ? `${s.depositValue}% (${euro(s.depositCents)})` : euro(s.depositValue);
      const toggle = h('label', { class: 'switch', onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: s.active, 'aria-label': 'Online boekbaar' }), h('span'));
      toggle.querySelector('input').addEventListener('change', async (e) => {
        try { await api(`/api/admin/services/${s.id}`, { method: 'PUT', body: { ...s, active: e.target.checked } }); toast(e.target.checked ? 'Ingeschakeld' : 'Uitgeschakeld'); } catch (err) { toast(err.message, 'error'); e.target.checked = !e.target.checked; }
      });
      tbody.append(h('tr', { class: 'click', onclick: () => serviceModal(s) },
        h('td', null, h('strong', null, s.name), s.description ? h('div', { class: 'small muted' }, s.description) : null),
        h('td', null, duration(s.durationMin)), h('td', { class: 'num' }, euro(s.priceCents)), h('td', null, dep),
        h('td', null, s.upcomingBookings ? `${s.upcomingBookings} gepland` : h('span', { class: 'muted' }, '–')), h('td', { class: 'actions' }, toggle)));
    }
    content.append(h('section', { class: 'panel glass' }, services.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Behandeling'), h('th', null, 'Duur'), h('th', { class: 'num' }, 'Prijs'), h('th', null, 'Aanbetaling'), h('th', null, 'Afspraken'), h('th', { class: 'actions' }, 'Online'))), tbody))
      : h('div', { class: 'empty' }, 'Nog geen behandelingen.')));
  }

  function serviceModal(s) {
    const isNew = !s;
    s = s || { name: '', description: '', durationMin: 30, priceCents: 0, depositType: 'none', depositValue: 0, active: true, sortOrder: services.length + 1 };
    const name = field({ label: 'Naam', name: 'name', value: s.name, maxlength: 80 });
    const desc = field({ label: 'Korte omschrijving (optioneel)', name: 'desc', value: s.description, maxlength: 300 });
    const dur = field({ label: 'Behandeltijd (minuten)', name: 'dur', type: 'number', value: String(s.durationMin) });
    const price = field({ label: 'Prijs (€)', name: 'price', type: 'number', value: (s.priceCents / 100).toFixed(2) });
    price.input.step = '0.01'; dur.input.step = '5'; dur.input.min = '5';
    const depType = h('select', { class: 'select' }, [['none', 'Geen aanbetaling'], ['fixed', 'Vast bedrag'], ['percent', 'Percentage van de prijs']].map(([v, l]) => h('option', { value: v, selected: s.depositType === v }, l)));
    const depVal = field({ label: s.depositType === 'percent' ? 'Percentage (%)' : 'Bedrag (€)', name: 'depval', type: 'number', value: s.depositType === 'fixed' ? (s.depositValue / 100).toFixed(2) : String(s.depositValue || '') });
    const sort = field({ label: 'Volgorde', name: 'sort', type: 'number', value: String(s.sortOrder) });
    const active = h('input', { type: 'checkbox', checked: s.active });
    const syncDep = () => { depVal.el.hidden = depType.value === 'none'; depVal.el.querySelector('label').textContent = depType.value === 'percent' ? 'Percentage (%)' : 'Bedrag (€)'; };
    depType.addEventListener('change', syncDep);
    syncDep();
    const save = h('button', { class: 'btn btn-primary' }, 'Opslaan');
    const del = !isNew ? h('button', { class: 'btn btn-danger', style: { marginRight: 'auto' } }, 'Verwijderen') : null;
    const m = modal({ title: isNew ? 'Nieuwe behandeling' : 'Behandeling bewerken', content: [
      h('div', { class: 'form' }, name.el, desc.el, h('div', { class: 'grid-2' }, dur.el, price.el),
        h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', null, 'Aanbetaling'), depType), depVal.el),
        h('div', { class: 'hint' }, 'De aanbetaling wordt berekend over de prijs na eventuele korting en online betaald via Mollie.'),
        h('div', { class: 'grid-2' }, sort.el, h('label', { class: 'check', style: { alignSelf: 'end', paddingBottom: '12px' } }, active, 'Online boekbaar'))),
      h('div', { class: 'modal-foot' }, del, save)] });
    save.addEventListener('click', () => busy(save, async () => {
      const body = {
        name: name.input.value, description: desc.input.value, durationMin: Number(dur.input.value), priceCents: Math.round(Number(price.input.value) * 100),
        depositType: depType.value, depositValue: depType.value === 'fixed' ? Math.round(Number(depVal.input.value) * 100) : Number(depVal.input.value) || 0,
        active: active.checked, sortOrder: Number(sort.input.value) || 0,
      };
      try {
        await api(isNew ? '/api/admin/services' : `/api/admin/services/${s.id}`, { method: isNew ? 'POST' : 'PUT', body });
        m.close(); toast('Opgeslagen'); viewServices();
      } catch (err) { toast(err.message, 'error'); }
    }));
    if (del) del.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Behandeling verwijderen?', message: s.upcomingBookings ? `Er staan nog ${s.upcomingBookings} afspraken gepland. Die blijven bestaan; de behandeling is daarna niet meer te boeken.` : 'De behandeling is daarna niet meer te boeken.', confirmLabel: 'Verwijderen', danger: true }))) return;
      try { await api(`/api/admin/services/${s.id}`, { method: 'DELETE' }); m.close(); toast('Verwijderd'); viewServices(); } catch (err) { toast(err.message, 'error'); }
    });
  }

  // ---------- Openingstijden ----------
  const DAYS = ['Zondag', 'Maandag', 'Dinsdag', 'Woensdag', 'Donderdag', 'Vrijdag', 'Zaterdag'];
  async function viewSchedule() {
    const sch = await api('/api/admin/schedule');
    const content = h('div');
    shell('beschikbaarheid', content);
    content.append(pageHead('Openingstijden', 'Bepaalt welke tijden klanten online kunnen boeken'));

    const order = [1, 2, 3, 4, 5, 6, 0];
    const rows = order.map((wd) => {
      const hr = sch.hours.find((x) => x.weekday === wd) || { weekday: wd, isOpen: false, open: '09:00', close: '17:00' };
      const open = h('input', { class: 'input', type: 'time', value: hr.open, step: '300' });
      const close = h('input', { class: 'input', type: 'time', value: hr.close, step: '300' });
      const sw = h('input', { type: 'checkbox', checked: hr.isOpen, 'aria-label': `${DAYS[wd]} open` });
      const breaks = sch.breaks.filter((b) => b.weekday === wd);
      const times = h('div', { class: 'times' }, open, h('span', { class: 'muted' }, 'tot'), close,
        breaks.map((b) => h('span', { class: 'break-chip' }, `${b.label} ${b.start}–${b.end}`, h('button', { 'aria-label': 'Pauze verwijderen', html: ICONS.close, onclick: async () => { await api(`/api/admin/schedule/breaks/${b.id}`, { method: 'DELETE' }); viewSchedule(); } }))),
        h('button', { class: 'btn btn-plain btn-sm', onclick: () => breakModal(wd) }, icon('plus'), 'Pauze'));
      const setState = () => { times.style.opacity = sw.checked ? '1' : '.35'; open.disabled = close.disabled = !sw.checked; };
      sw.addEventListener('change', setState);
      setState();
      return { wd, el: h('div', { class: 'hours-row' }, h('strong', null, DAYS[wd]), h('label', { class: 'switch' }, sw, h('span')), times), get: () => ({ weekday: wd, isOpen: sw.checked, open: open.value, close: close.value }) };
    });
    const saveBtn = h('button', { class: 'btn btn-primary' }, 'Openingstijden opslaan');
    saveBtn.addEventListener('click', () => busy(saveBtn, async () => {
      try { await api('/api/admin/schedule/hours', { method: 'PUT', body: { hours: rows.map((r) => r.get()) } }); toast('Openingstijden opgeslagen'); } catch (err) { toast(err.message, 'error'); }
    }));
    content.append(h('section', { class: 'panel glass' }, h('div', { class: 'panel-head' }, h('h2', null, 'Vaste openingstijden'), saveBtn), h('div', { class: 'hours' }, rows.map((r) => r.el))));

    const TYPE = { closed: ['Gesloten', 'red'], block: ['Geblokkeerd', 'orange'], extra: ['Extra open', 'green'] };
    const tbody = h('tbody', null, sch.exceptions.map((e) => h('tr', null,
      h('td', null, badge(TYPE[e.type])),
      h('td', null, e.startDate === e.endDate ? fmtDate(e.startDate, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : `${fmtDate(e.startDate, { day: 'numeric', month: 'short' })} – ${fmtDate(e.endDate, { day: 'numeric', month: 'short', year: 'numeric' })}`),
      h('td', null, e.start ? `${e.start} – ${e.end}` : 'Hele dag'),
      h('td', null, e.label || h('span', { class: 'muted' }, '–')),
      h('td', { class: 'actions' }, h('button', { class: 'btn btn-plain btn-sm', onclick: async () => { if (await confirmDialog({ title: 'Verwijderen?', message: 'Deze uitzondering verwijderen?', confirmLabel: 'Verwijderen', danger: true })) { await api(`/api/admin/schedule/exceptions/${e.id}`, { method: 'DELETE' }); viewSchedule(); } } }, 'Verwijderen')))));
    content.append(h('section', { class: 'panel glass' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Vakanties, vrije dagen en uitzonderingen'),
        h('div', { class: 'toolbar' },
          h('button', { class: 'btn btn-glass btn-sm', onclick: () => exceptionModal('closed') }, 'Vakantie / vrije dag'),
          h('button', { class: 'btn btn-glass btn-sm', onclick: () => exceptionModal('block') }, 'Tijd blokkeren'),
          h('button', { class: 'btn btn-glass btn-sm', onclick: () => exceptionModal('extra') }, 'Extra beschikbaarheid'))),
      sch.exceptions.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, h('th', null, 'Type'), h('th', null, 'Datum'), h('th', null, 'Tijd'), h('th', null, 'Omschrijving'), h('th'))), tbody))
        : h('div', { class: 'empty' }, 'Geen geplande uitzonderingen.')));
  }

  function breakModal(wd) {
    const start = h('input', { class: 'input', type: 'time', value: '12:30', step: '300' });
    const end = h('input', { class: 'input', type: 'time', value: '13:00', step: '300' });
    const label = field({ label: 'Omschrijving', name: 'label', value: 'Pauze', maxlength: 40 });
    const btn = h('button', { class: 'btn btn-primary' }, 'Toevoegen');
    const m = modal({ title: `Pauze op ${DAYS[wd].toLowerCase()}`, content: [h('div', { class: 'form' }, h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', null, 'Van'), start), h('div', { class: 'field' }, h('label', null, 'Tot'), end)), label.el), h('div', { class: 'modal-foot' }, btn)] });
    btn.addEventListener('click', () => busy(btn, async () => {
      try { await api('/api/admin/schedule/breaks', { method: 'POST', body: { weekday: wd, start: start.value, end: end.value, label: label.input.value } }); m.close(); viewSchedule(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  function exceptionModal(type) {
    const titles = { closed: 'Vakantie of vrije dag', block: 'Tijd blokkeren', extra: 'Extra beschikbaarheid' };
    const startDate = h('input', { class: 'input', type: 'date', value: todayStr() });
    const endDate = h('input', { class: 'input', type: 'date', value: todayStr() });
    const start = h('input', { class: 'input', type: 'time', value: type === 'extra' ? '18:00' : '12:00', step: '300' });
    const end = h('input', { class: 'input', type: 'time', value: type === 'extra' ? '21:00' : '14:00', step: '300' });
    const label = field({ label: 'Omschrijving (optioneel)', name: 'label', placeholder: type === 'closed' ? 'Bijv. Zomervakantie' : '', maxlength: 80 });
    startDate.addEventListener('change', () => { if (endDate.value < startDate.value) endDate.value = startDate.value; });
    const btn = h('button', { class: 'btn btn-primary' }, 'Opslaan');
    const m = modal({ title: titles[type], content: [h('div', { class: 'form' },
      type === 'closed'
        ? h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', null, 'Van'), startDate), h('div', { class: 'field' }, h('label', null, 'Tot en met'), endDate))
        : h('div', { class: 'field' }, h('label', null, 'Datum'), startDate),
      type !== 'closed' ? h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', null, 'Van'), start), h('div', { class: 'field' }, h('label', null, 'Tot'), end)) : null,
      label.el,
      h('div', { class: 'hint' }, type === 'extra' ? 'Klanten kunnen in dit tijdvak boeken, ook als de salon normaal gesloten is.' : 'Klanten kunnen in deze periode niet online boeken. Bestaande afspraken blijven staan.')),
    h('div', { class: 'modal-foot' }, btn)] });
    btn.addEventListener('click', () => busy(btn, async () => {
      try {
        const r = await api('/api/admin/schedule/exceptions', { method: 'POST', body: { type, startDate: startDate.value, endDate: endDate.value, start: start.value, end: end.value, label: label.input.value } });
        m.close();
        if (r.conflicts.length) toast(`Let op: ${r.conflicts.length} bestaande afspraak/afspraken vallen in deze periode.`, 'error', 7000); else toast('Opgeslagen');
        viewSchedule();
      } catch (err) { toast(err.message, 'error'); }
    }));
  }

  // ---------- Kortingscodes ----------
  const CODE_STATE = { active: ['Actief', 'green'], inactive: ['Gedeactiveerd', ''], expired: ['Verlopen', 'red'], scheduled: ['Gepland', 'blue'], exhausted: ['Opgebruikt', 'orange'] };
  async function viewDiscounts() {
    const r = await api('/api/admin/discounts');
    const content = h('div');
    shell('kortingscodes', content);
    content.append(pageHead('Kortingscodes', 'Acties en kortingen voor online boekingen', h('button', { class: 'btn btn-primary', onclick: () => discountModal() }, icon('plus'), 'Kortingscode')));
    const totalUses = r.discounts.reduce((s, d) => s + d.uses, 0);
    const totalDisc = r.discounts.reduce((s, d) => s + d.totalDiscountCents, 0);
    content.append(h('div', { class: 'cards', style: { marginBottom: '18px' } },
      stat('Actieve codes', r.discounts.filter((d) => d.state === 'active').length, `${r.discounts.length} in totaal`),
      stat('Keer gebruikt', totalUses, 'bevestigde boekingen'),
      stat('Totaal korting', euro(totalDisc), 'verleend'),
      stat('Verlopen', r.discounts.filter((d) => d.state === 'expired').length, 'codes')));
    const tbody = h('tbody', null, r.discounts.map((d) => {
      const sw = h('label', { class: 'switch', onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: d.active, 'aria-label': 'Actief' }), h('span'));
      sw.querySelector('input').addEventListener('change', async (e) => { try { await api(`/api/admin/discounts/${d.id}/toggle`, { method: 'POST', body: { active: e.target.checked } }); viewDiscounts(); } catch (err) { toast(err.message, 'error'); } });
      return h('tr', { class: 'click', onclick: () => discountDetail(d.id) },
        h('td', null, h('strong', { class: 'mono' }, d.code), d.description ? h('div', { class: 'small muted' }, d.description) : null),
        h('td', null, d.discountType === 'percent' ? `${d.discountValue}%` : euro(d.discountValue)),
        h('td', null, d.startsOn || d.expiresOn ? `${d.startsOn ? fmtDate(d.startsOn, { day: 'numeric', month: 'short' }) : '…'} – ${d.expiresOn ? fmtDate(d.expiresOn, { day: 'numeric', month: 'short', year: 'numeric' }) : '…'}` : h('span', { class: 'muted' }, 'Onbeperkt')),
        h('td', { class: 'num' }, `${d.uses}${d.maxUses ? ` / ${d.maxUses}` : ''}`),
        h('td', { class: 'num' }, euro(d.totalDiscountCents)),
        h('td', null, badge(CODE_STATE[d.state])),
        h('td', { class: 'actions' }, sw));
    }));
    content.append(h('section', { class: 'panel glass' }, r.discounts.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Code'), h('th', null, 'Korting'), h('th', null, 'Geldig'), h('th', { class: 'num' }, 'Gebruikt'), h('th', { class: 'num' }, 'Korting totaal'), h('th', null, 'Status'), h('th', { class: 'actions' }, 'Actief'))), tbody))
      : h('div', { class: 'empty' }, 'Nog geen kortingscodes. Maak er een aan, bijvoorbeeld WELKOM10.')));
  }

  async function discountDetail(id) {
    const m = modal({ title: 'Kortingscode', wide: true });
    const r = await api(`/api/admin/discounts/${id}`);
    const d = r.discount;
    m.setTitle(d.code);
    const svcNames = d.appliesToAll ? 'Alle behandelingen' : d.serviceIds.map((sid) => (services.find((s) => s.id === sid) || {}).name).filter(Boolean).join(', ');
    clear(m.body).append(h('div', { class: 'fade-in' },
      h('div', { class: 'row', style: { marginBottom: '14px' } }, badge(CODE_STATE[d.state]), d.description ? h('span', { class: 'muted' }, d.description) : null),
      h('div', { class: 'detail-grid' },
        h('div', { class: 'detail-block' }, h('h3', null, 'Voorwaarden'),
          row('Korting', d.discountType === 'percent' ? `${d.discountValue}%` : euro(d.discountValue)),
          row('Geldig vanaf', d.startsOn ? fmtDate(d.startsOn, { day: 'numeric', month: 'long', year: 'numeric' }) : 'Direct'),
          row('Vervalt', d.expiresOn ? fmtDate(d.expiresOn, { day: 'numeric', month: 'long', year: 'numeric' }) : 'Nooit'),
          row('Max. gebruik', d.maxUses ? `${d.maxUses}×` : 'Onbeperkt'),
          row('Eén keer per klant', d.oncePerCustomer ? 'Ja' : 'Nee'),
          row('Minimale waarde', d.minAmountCents ? euro(d.minAmountCents) : 'Geen'),
          row('Behandelingen', svcNames || '–')),
        h('div', { class: 'detail-block' }, h('h3', null, 'Resultaat'),
          row('Keer gebruikt', String(d.uses)), row('Totaal korting', euro(d.totalDiscountCents)))),
      h('h3', { style: { margin: '20px 0 8px' } }, 'Boekingen met deze code'),
      r.bookings.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Datum'), h('th', null, 'Klant'), h('th', null, 'Behandeling'), h('th', { class: 'num' }, 'Korting'), h('th', null, 'Status'))),
        h('tbody', null, r.bookings.map((b) => h('tr', { class: 'click', onclick: () => { m.close(); openBooking(b.id); } },
          h('td', null, `${fmtDate(b.date, { day: 'numeric', month: 'short' })} ${b.start}`), h('td', null, b.customer.name), h('td', null, b.serviceName), h('td', { class: 'num' }, euro(b.discountCents)), h('td', null, statusBadge(b.status)))))))
        : h('div', { class: 'empty' }, 'Nog niet gebruikt.'),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn btn-danger', style: { marginRight: 'auto' }, onclick: async () => {
          if (!(await confirmDialog({ title: `${d.code} verwijderen?`, message: 'Bestaande boekingen behouden hun korting. De code werkt daarna niet meer.', confirmLabel: 'Verwijderen', danger: true }))) return;
          await api(`/api/admin/discounts/${d.id}`, { method: 'DELETE' }); m.close(); toast('Verwijderd'); viewDiscounts();
        } }, 'Verwijderen'),
        h('button', { class: 'btn btn-primary', onclick: () => { m.close(); discountModal(d); } }, 'Bewerken'))));
  }

  function discountModal(d) {
    const isNew = !d;
    d = d || { code: '', description: '', discountType: 'percent', discountValue: 10, startsOn: null, expiresOn: null, maxUses: null, oncePerCustomer: false, minAmountCents: 0, appliesToAll: true, active: true, serviceIds: [] };
    const code = field({ label: 'Code', name: 'code', value: d.code, placeholder: 'WELKOM10', maxlength: 40 });
    code.input.style.textTransform = 'uppercase';
    const desc = field({ label: 'Omschrijving (intern)', name: 'desc', value: d.description, maxlength: 200 });
    const type = h('select', { class: 'select' }, h('option', { value: 'percent', selected: d.discountType === 'percent' }, 'Percentage'), h('option', { value: 'fixed', selected: d.discountType === 'fixed' }, 'Vast bedrag'));
    const value = field({ label: d.discountType === 'percent' ? 'Korting (%)' : 'Korting (€)', name: 'value', type: 'number', value: d.discountType === 'fixed' ? (d.discountValue / 100).toFixed(2) : String(d.discountValue) });
    value.input.step = '0.01';
    type.addEventListener('change', () => { value.el.querySelector('label').textContent = type.value === 'percent' ? 'Korting (%)' : 'Korting (€)'; });
    const starts = h('input', { class: 'input', type: 'date', value: d.startsOn || '' });
    const expires = h('input', { class: 'input', type: 'date', value: d.expiresOn || '' });
    const maxUses = field({ label: 'Maximaal aantal keer te gebruiken', name: 'max', type: 'number', value: d.maxUses ? String(d.maxUses) : '', placeholder: 'Onbeperkt' });
    const minAmount = field({ label: 'Minimale bestelwaarde (€)', name: 'min', type: 'number', value: d.minAmountCents ? (d.minAmountCents / 100).toFixed(2) : '', placeholder: 'Geen' });
    const once = h('input', { type: 'checkbox', checked: d.oncePerCustomer });
    const active = h('input', { type: 'checkbox', checked: d.active });
    const all = h('input', { type: 'checkbox', checked: d.appliesToAll });
    const svcBox = h('div', { class: 'svc-check' }, services.map((s) => h('label', null, h('input', { type: 'checkbox', value: String(s.id), checked: d.serviceIds.includes(s.id) }), s.name)));
    const syncAll = () => { svcBox.hidden = all.checked; };
    all.addEventListener('change', syncAll);
    syncAll();
    const save = h('button', { class: 'btn btn-primary' }, 'Opslaan');
    const m = modal({ title: isNew ? 'Nieuwe kortingscode' : `${d.code} bewerken`, wide: true, content: [
      h('div', { class: 'form-grid' },
        code.el, desc.el,
        h('div', { class: 'field' }, h('label', null, 'Soort korting'), type), value.el,
        h('div', { class: 'field' }, h('label', null, 'Startdatum'), starts), h('div', { class: 'field' }, h('label', null, 'Vervaldatum'), expires),
        maxUses.el, minAmount.el,
        h('label', { class: 'check full' }, once, 'Maximaal één keer per klant (op basis van e-mailadres en telefoonnummer)'),
        h('label', { class: 'check full' }, all, 'Geldig voor alle behandelingen'),
        h('div', { class: 'full' }, svcBox),
        h('label', { class: 'check full' }, active, 'Actief')),
      h('div', { class: 'modal-foot' }, save)] });
    save.addEventListener('click', () => busy(save, async () => {
      const body = {
        code: code.input.value, description: desc.input.value, discountType: type.value,
        discountValue: type.value === 'fixed' ? Math.round(Number(value.input.value) * 100) : Number(value.input.value),
        startsOn: starts.value || null, expiresOn: expires.value || null, maxUses: maxUses.input.value ? Number(maxUses.input.value) : null,
        minAmountCents: minAmount.input.value ? Math.round(Number(minAmount.input.value) * 100) : 0,
        oncePerCustomer: once.checked, appliesToAll: all.checked, active: active.checked,
        serviceIds: Array.from(svcBox.querySelectorAll('input:checked')).map((x) => Number(x.value)),
      };
      try {
        await api(isNew ? '/api/admin/discounts' : `/api/admin/discounts/${d.id}`, { method: isNew ? 'POST' : 'PUT', body });
        m.close(); toast('Kortingscode opgeslagen'); viewDiscounts();
      } catch (err) { toast(err.message, 'error'); }
    }));
  }

  // ---------- Betalingen ----------
  async function viewPayments(params) {
    const filter = params.get('filter') || '';
    const r = await api(`/api/admin/payments${filter ? `?filter=${filter}` : ''}`);
    const content = h('div');
    shell('betalingen', content);
    const refreshBtn = h('button', { class: 'btn btn-glass' }, 'Status bijwerken');
    refreshBtn.addEventListener('click', () => busy(refreshBtn, async () => { await api('/api/admin/payments/reconcile', { method: 'POST', body: {} }); viewPayments(params); }));
    content.append(pageHead('Betalingen', r.mollieMode ? `Mollie · ${r.mollieMode === 'live' ? 'live' : 'testmodus'}` : 'Mollie is niet gekoppeld', refreshBtn));
    const s = r.summary;
    content.append(h('div', { class: 'cards', style: { marginBottom: '18px' } },
      stat('Ontvangen', euro(s.received), 'aan aanbetalingen'), stat('Terugbetaald', euro(s.refunded), 'via Mollie'),
      stat('Ingehouden', euro(s.retained), 'annuleringskosten'), stat('Open', s.openCount, 'betalingen in afwachting')));
    const seg = h('div', { class: 'segmented tabs' }, [['', 'Alle'], ['open', 'Open'], ['paid', 'Betaald'], ['failed', 'Mislukt/verlopen']].map(([k, l]) => h('button', { 'aria-pressed': filter === k ? 'true' : 'false', onclick: () => navigate('betalingen', k ? { filter: k } : null) }, l)));
    content.append(seg);
    content.append(h('section', { class: 'panel glass' }, h('div', { class: 'panel-head' }, h('h2', null, 'Aanbetalingen')),
      r.payments.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Datum'), h('th', null, 'Klant'), h('th', null, 'Afspraak'), h('th', null, 'Methode'), h('th', { class: 'num' }, 'Bedrag'), h('th', null, 'Status'))),
        h('tbody', null, r.payments.map((p) => h('tr', { class: 'click', onclick: () => openBooking(p.bookingId) },
          h('td', null, dt(p.createdAt)), h('td', null, p.customer), h('td', null, `${fmtDate(p.date, { day: 'numeric', month: 'short' })} ${p.start} · ${p.serviceName}`),
          h('td', null, p.method || '–', p.mode === 'test' ? h('span', { class: 'badge plain', style: { marginLeft: '6px' } }, 'test') : null),
          h('td', { class: 'num' }, euro(p.amountCents)), h('td', null, badge(MOLLIE_STATUS[p.status])))))))
        : h('div', { class: 'empty' }, 'Geen betalingen gevonden.')));
    if (r.refunds.length) {
      content.append(h('section', { class: 'panel glass' }, h('div', { class: 'panel-head' }, h('h2', null, 'Terugbetalingen')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, h('th', null, 'Datum'), h('th', null, 'Klant'), h('th', null, 'Omschrijving'), h('th', { class: 'num' }, 'Bedrag'), h('th', null, 'Status'))),
          h('tbody', null, r.refunds.map((x) => h('tr', { class: 'click', onclick: () => openBooking(x.bookingId) },
            h('td', null, dt(x.createdAt)), h('td', null, x.customer), h('td', null, x.reason), h('td', { class: 'num' }, euro(x.amountCents)), h('td', null, REFUND_STATUS[x.status] || x.status))))))));
    }
  }

  // ---------- Instellingen ----------
  async function viewSettings(params) {
    const tab = params.get('tab') || 'salon';
    const [{ settings: s }, { calendar }] = await Promise.all([api('/api/admin/settings'), api('/api/admin/calendar')]);
    const content = h('div');
    shell('instellingen', content);
    content.append(pageHead('Instellingen'));
    const TABS = [['salon', 'Salon'], ['boeken', 'Boekingsregels'], ['annulering', 'Annuleren'], ['betalingen', 'Betalingen'], ['email', 'E-mail'], ['agenda', 'Apple Agenda'], ['account', 'Account']];
    content.append(h('div', { class: 'segmented tabs' }, TABS.map(([k, l]) => h('button', { 'aria-pressed': tab === k ? 'true' : 'false', onclick: () => navigate('instellingen', { tab: k }) }, l))));
    const panel = h('section', { class: 'panel glass fade-in' });
    content.append(panel);
    ({ salon: settingsSalon, boeken: settingsBooking, annulering: settingsCancel, betalingen: settingsPayments, email: settingsEmail, agenda: settingsCalendar, account: settingsAccount })[tab](panel, s, calendar);
  }

  async function saveSettings(body, btn, msg = 'Opgeslagen') {
    return busy(btn, async () => {
      try { const r = await api('/api/admin/settings', { method: 'PUT', body }); toast(msg); return r.settings; } catch (err) { toast(err.message, 'error', 5000); return null; }
    });
  }

  function settingsSalon(panel, s) {
    const name = field({ label: 'Naam van de salon', name: 'n', value: s.salon_name, maxlength: 80 });
    const tagline = field({ label: 'Ondertitel', name: 't', value: s.salon_tagline, maxlength: 80 });
    const email = field({ label: 'E-mailadres salon', name: 'e', type: 'email', value: s.salon_email, hint: 'Wordt gebruikt als antwoordadres in e-mails.' });
    const phone = field({ label: 'Telefoonnummer', name: 'p', value: s.salon_phone });
    const address = field({ label: 'Adres', name: 'a', value: s.salon_address, hint: 'Wordt als locatie in agenda-items gezet.' });
    let logo = s.salon_logo;
    const preview = h('div', { class: 'logo-preview' }, logo ? h('img', { src: logo, alt: '' }) : null);
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', class: 'sr-only', id: 'logo-file' });
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 300 * 1024) { toast('Het logo mag maximaal 300 kB zijn.', 'error'); return; }
      const reader = new FileReader();
      reader.onload = () => { logo = reader.result; clear(preview).append(h('img', { src: logo, alt: '' })); };
      reader.readAsDataURL(f);
    });
    const save = h('button', { class: 'btn btn-primary' }, 'Opslaan');
    save.addEventListener('click', async () => {
      const r = await saveSettings({ salon_name: name.input.value, salon_tagline: tagline.input.value, salon_email: email.input.value, salon_phone: phone.input.value, salon_address: address.input.value, salon_logo: logo || '' }, save);
      if (r) { salon = { name: r.salon_name, logo: r.salon_logo }; route(); }
    });
    panel.append(h('div', { class: 'form' },
      h('div', { class: 'row' }, preview, h('div', { class: 'row' }, h('label', { class: 'btn btn-glass btn-sm', for: 'logo-file' }, 'Logo kiezen'), file, logo ? h('button', { class: 'btn btn-plain btn-sm', onclick: () => { logo = ''; clear(preview); } }, 'Verwijderen') : null)),
      h('div', { class: 'grid-2' }, name.el, tagline.el), h('div', { class: 'grid-2' }, email.el, phone.el), address.el),
    h('div', { class: 'modal-foot' }, save));
  }

  function numberField(label, name, value, hint) {
    const f = field({ label, name, type: 'number', value: String(value), hint });
    return f;
  }

  function switchRow(title, desc, checked) {
    const input = h('input', { type: 'checkbox', checked });
    return { el: h('div', { class: 'setting-row' }, h('div', null, h('div', { class: 't' }, title), desc ? h('div', { class: 'd' }, desc) : null), h('label', { class: 'switch' }, input, h('span'))), input };
  }

  function settingsBooking(panel, s) {
    const interval = numberField('Tijdslot-interval (minuten)', 'i', s.slot_interval_min, 'Om de hoeveel minuten een starttijd wordt aangeboden.');
    const notice = numberField('Minimale aanlooptijd (uren)', 'mn', s.min_notice_min / 60, 'Hoe lang van tevoren klanten minimaal moeten boeken.');
    notice.input.step = '0.5';
    const ahead = numberField('Maximaal vooruit boeken (dagen)', 'a', s.max_days_ahead);
    const buffer = numberField('Buffer tussen afspraken (minuten)', 'b', s.buffer_min, 'Bijvoorbeeld om op te ruimen.');
    const hold = numberField('Tijdslot vasthouden tijdens betalen (minuten)', 'h', s.hold_minutes, 'Hoe lang een tijdslot gereserveerd blijft terwijl de klant de aanbetaling doet.');
    const change = switchRow('Behandeling wijzigen toestaan', 'Klanten kunnen bij "Mijn afspraak" een andere behandeling kiezen.', s.allow_service_change);
    const notes = switchRow('Opmerkingenveld tonen', 'Klanten kunnen een opmerking bij hun boeking plaatsen.', s.booking_notes_enabled);
    const save = h('button', { class: 'btn btn-primary' }, 'Opslaan');
    save.addEventListener('click', () => saveSettings({
      slot_interval_min: Number(interval.input.value), min_notice_min: Math.round(Number(notice.input.value) * 60), max_days_ahead: Number(ahead.input.value),
      buffer_min: Number(buffer.input.value), hold_minutes: Number(hold.input.value), allow_service_change: change.input.checked, booking_notes_enabled: notes.input.checked,
    }, save));
    panel.append(h('div', { class: 'form-grid' }, interval.el, notice.el, ahead.el, buffer.el, hold.el), h('div', { class: 'section-gap' }, change.el, notes.el), h('div', { class: 'modal-foot' }, save));
  }

  function settingsCancel(panel, s) {
    const windowH = numberField('Kosteloos annuleren tot (uren voor de afspraak)', 'w', s.cancel_window_hours, 'Binnen deze termijn kunnen klanten ook zelf wijzigen.');
    const pct = numberField('Terugbetaling bij te late annulering (%)', 'p', s.late_cancel_refund_pct, '0% = aanbetaling volledig ingehouden, 50% = de helft terug, 100% = altijd alles terug.');
    const text = field({ label: 'Aanvullende voorwaarden (optioneel)', name: 'tx', value: s.policy_text, textarea: true, maxlength: 1500, hint: 'Wordt getoond voordat de klant boekt.' });
    const save = h('button', { class: 'btn btn-primary' }, 'Opslaan');
    save.addEventListener('click', () => saveSettings({ cancel_window_hours: Number(windowH.input.value), late_cancel_refund_pct: Number(pct.input.value), policy_text: text.input.value }, save));
    panel.append(h('div', { class: 'form' }, h('div', { class: 'grid-2' }, windowH.el, pct.el), text.el,
      h('div', { class: 'note' }, 'Bij tijdige annulering wordt de aanbetaling automatisch en volledig teruggestort via Mollie. Bij een te late annulering wordt het ingestelde percentage teruggestort en de rest ingehouden als annuleringskosten.')),
    h('div', { class: 'modal-foot' }, save));
  }

  function settingsPayments(panel, s) {
    const key = field({ label: 'Mollie API-sleutel', name: 'k', type: 'password', placeholder: s.mollie_api_key_set ? `${s.mollie_api_key_hint} (ingesteld)` : 'live_… of test_…', autocomplete: 'off' });
    const status = s.mollie_api_key_set ? badge(s.mollie_mode === 'live' ? ['Live', 'green'] : ['Testmodus', 'orange']) : badge(['Niet gekoppeld', 'red']);
    const test = h('button', { class: 'btn btn-glass' }, 'Verbinding testen');
    const save = h('button', { class: 'btn btn-primary' }, 'Opslaan');
    test.addEventListener('click', () => busy(test, async () => {
      try { const r = await api('/api/admin/settings/test-mollie', { method: 'POST', body: { key: key.input.value } }); toast(`Verbonden (${r.mode}). Beschikbaar: ${r.methods.join(', ') || 'geen methoden actief'}`, 'info', 6000); } catch (err) { toast(err.message, 'error', 6000); }
    }));
    save.addEventListener('click', async () => { if (!key.input.value) { toast('Vul een sleutel in.', 'error'); return; } const r = await saveSettings({ mollie_api_key: key.input.value }, save); if (r) route(); });
    panel.append(h('div', { class: 'form' },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', null, 'Mollie'), status),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Aanbetalingen worden afgerekend via Mollie (iDEAL, creditcard, Bancontact, Apple Pay, …). Terugbetalingen bij annuleringen gaan automatisch via dezelfde koppeling.'),
      key.el,
      h('ol', { class: 'steps-list' },
        h('li', null, 'Maak een account aan op mollie.com en activeer de gewenste betaalmethoden.'),
        h('li', null, 'Ga in het Mollie-dashboard naar Ontwikkelaars → API-sleutels en kopieer de Live API key (begint met live_). Gebruik een test_-sleutel om eerst te testen.'),
        h('li', null, 'Plak de sleutel hierboven, test de verbinding en sla op.')),
      !s.webhook_reachable ? h('div', { class: 'note orange' }, `De website draait op ${s.public_url}. Mollie kan dit adres niet bereiken voor statusmeldingen; de betaalstatus wordt daarom gecontroleerd zodra de klant terugkeert en elke 2 minuten op de achtergrond. Stel PUBLIC_URL in op je echte https-adres voor directe verwerking.`) : h('div', { class: 'note' }, `Statusmeldingen van Mollie komen binnen op ${s.public_url}/api/webhooks/mollie.`),
      s.mollie_api_key_set ? h('button', { class: 'btn btn-plain btn-sm', style: { justifySelf: 'start' }, onclick: async (e) => { if (await confirmDialog({ title: 'Mollie ontkoppelen?', message: 'Behandelingen met aanbetaling kunnen dan niet meer online worden geboekt.', confirmLabel: 'Ontkoppelen', danger: true })) { await saveSettings({ mollie_api_key_clear: true }, e.target); route(); } } }, 'Sleutel verwijderen') : null),
    h('div', { class: 'modal-foot' }, test, save));
  }

  function settingsEmail(panel, s) {
    const host = field({ label: 'SMTP-server', name: 'h', value: s.smtp_host, placeholder: 'smtp.voorbeeld.nl' });
    const port = field({ label: 'Poort', name: 'po', type: 'number', value: String(s.smtp_port) });
    const secure = h('select', { class: 'select' }, h('option', { value: 'false', selected: !s.smtp_secure }, 'STARTTLS (poort 587)'), h('option', { value: 'true', selected: s.smtp_secure }, 'SSL/TLS (poort 465)'));
    const user = field({ label: 'Gebruikersnaam', name: 'u', value: s.smtp_user, autocomplete: 'off' });
    const pass = field({ label: 'Wachtwoord', name: 'pw', type: 'password', placeholder: s.smtp_pass_set ? '•••••••• (ingesteld)' : '', autocomplete: 'new-password' });
    const from = field({ label: 'Afzender', name: 'f', value: s.smtp_from, placeholder: `"${s.salon_name}" <afspraken@jouwsalon.nl>` });
    const notifyTo = field({ label: 'Meldingen naar (eigenaar)', name: 'o', type: 'email', value: s.owner_notify_email, placeholder: s.salon_email || 'jij@jouwsalon.nl' });
    const notify = switchRow('Meldingen bij nieuwe, gewijzigde en geannuleerde afspraken', null, s.owner_notify_enabled);
    const save = h('button', { class: 'btn btn-primary' }, 'Opslaan');
    const test = h('button', { class: 'btn btn-glass' }, 'Testmail sturen');
    save.addEventListener('click', () => saveSettings({
      smtp_host: host.input.value, smtp_port: Number(port.input.value), smtp_secure: secure.value === 'true', smtp_user: user.input.value,
      smtp_pass: pass.input.value, smtp_from: from.input.value, owner_notify_email: notifyTo.input.value, owner_notify_enabled: notify.input.checked,
    }, save));
    test.addEventListener('click', () => busy(test, async () => {
      try { const r = await api('/api/admin/settings/test-email', { method: 'POST', body: {} }); toast(`Testmail verstuurd naar ${r.to}`); } catch (err) { toast(err.message, 'error', 6000); }
    }));
    panel.append(h('div', { class: 'form' },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', null, 'E-mail'), badge(s.email_configured ? ['Ingesteld', 'green'] : ['Niet ingesteld', 'red'])),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Klanten ontvangen automatisch een bevestiging (met agenda-bijlage), wijzigingsbericht, annuleringsbevestiging en verificatiecodes. Gebruik de SMTP-gegevens van je e-mailprovider of een dienst als Postmark, Brevo of Amazon SES.'),
      h('div', { class: 'form-grid' }, host.el, h('div', { class: 'grid-2' }, port.el, h('div', { class: 'field' }, h('label', null, 'Beveiliging'), secure)), user.el, pass.el, from.el, notifyTo.el),
      notify.el),
    h('div', { class: 'modal-foot' }, test, save));
  }

  function settingsCalendar(panel, s, cal) {
    const copy = (value) => h('div', { class: 'copy-row' }, h('input', { class: 'input', readonly: true, value, onfocus: (e) => e.target.select() }),
      h('button', { class: 'btn btn-glass btn-sm', onclick: async () => { try { await navigator.clipboard.writeText(value); toast('Gekopieerd'); } catch { toast('Kopiëren mislukt', 'error'); } } }, 'Kopieer'));

    const statusBadge2 = cal.connected ? badge(['Gekoppeld', 'green']) : badge(['Niet gekoppeld', '']);
    const box = h('div', { class: 'form' },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', null, 'Apple Agenda via iCloud (CalDAV)'), statusBadge2),
      h('p', { class: 'muted', style: { margin: 0 } }, 'Elke bevestigde afspraak verschijnt automatisch in je Apple Agenda op iPhone, iPad en Mac – met naam, behandeling, tijd, telefoonnummer en opmerkingen. Verzetten werkt het bestaande item bij; annuleren verwijdert het item of markeert het als geannuleerd.'));

    if (cal.connected) {
      const onCancel = h('select', { class: 'select' }, h('option', { value: 'delete', selected: cal.onCancel === 'delete' }, 'Verwijderen uit agenda'), h('option', { value: 'mark', selected: cal.onCancel === 'mark' }, 'Laten staan, gemarkeerd als geannuleerd'));
      onCancel.addEventListener('change', async () => { await api('/api/admin/calendar/settings', { method: 'POST', body: { onCancel: onCancel.value } }); toast('Opgeslagen'); });
      const resync = h('button', { class: 'btn btn-glass' }, 'Alles opnieuw synchroniseren');
      resync.addEventListener('click', () => busy(resync, async () => { try { const r = await api('/api/admin/calendar/resync', { method: 'POST', body: {} }); toast(`${r.synced.ok} van ${r.synced.total} afspraken gesynchroniseerd`); } catch (err) { toast(err.message, 'error'); } }));
      const disconnect = h('button', { class: 'btn btn-danger' }, 'Ontkoppelen');
      disconnect.addEventListener('click', async () => { if (await confirmDialog({ title: 'Agenda ontkoppelen?', message: 'Nieuwe afspraken worden dan niet meer automatisch in je agenda gezet. Bestaande items blijven staan.', confirmLabel: 'Ontkoppelen', danger: true })) { await api('/api/admin/calendar/disconnect', { method: 'POST', body: {} }); route(); } });
      box.append(
        h('div', { class: 'summary-card list' }, row('Account', cal.username), row('Agenda', cal.calendarName || cal.calendarUrl), row('Laatst gelukt', dt(cal.lastOk)), cal.errorCount ? row('Mislukt', `${cal.errorCount} afspraak/afspraken – worden automatisch opnieuw geprobeerd`) : null),
        cal.lastError ? h('div', { class: 'note orange' }, cal.lastError) : null,
        h('div', { class: 'field' }, h('label', null, 'Bij annuleren'), onCancel),
        h('div', { class: 'modal-foot' }, disconnect, resync));
    } else {
      const user = field({ label: 'Apple ID (e-mailadres)', name: 'u', type: 'email', value: cal.username, autocomplete: 'off' });
      const pass = field({ label: 'App-specifiek wachtwoord', name: 'p', type: 'password', placeholder: cal.passwordSet ? '•••• (ingesteld)' : 'xxxx-xxxx-xxxx-xxxx', autocomplete: 'new-password', hint: 'Niet je gewone Apple ID-wachtwoord.' });
      const server = field({ label: 'CalDAV-server', name: 's', value: cal.serverUrl || 'https://caldav.icloud.com', hint: 'Voor iCloud: https://caldav.icloud.com. Andere CalDAV-agenda’s (Fastmail, Nextcloud) werken ook.' });
      const list = h('div');
      const findBtn = h('button', { class: 'btn btn-primary' }, 'Agenda’s zoeken');
      findBtn.addEventListener('click', () => busy(findBtn, async () => {
        try {
          const r = await api('/api/admin/calendar/discover', { method: 'POST', body: { serverUrl: server.input.value, username: user.input.value, password: pass.input.value } });
          clear(list);
          if (!r.calendars.length) { list.append(h('div', { class: 'note orange' }, 'Geen agenda’s gevonden. Maak in Apple Agenda eerst een (iCloud-)agenda aan, bijvoorbeeld "Salon".')); return; }
          const sel = h('select', { class: 'select' }, r.calendars.map((c) => h('option', { value: c.url }, c.name)));
          const onCancel = h('select', { class: 'select' }, h('option', { value: 'delete' }, 'Verwijderen uit agenda'), h('option', { value: 'mark' }, 'Laten staan, gemarkeerd als geannuleerd'));
          const connect = h('button', { class: 'btn btn-primary' }, 'Koppelen');
          connect.addEventListener('click', () => busy(connect, async () => {
            try {
              const c = r.calendars.find((x) => x.url === sel.value);
              const res = await api('/api/admin/calendar/connect', { method: 'POST', body: { calendarUrl: sel.value, calendarName: c ? c.name : '', onCancel: onCancel.value } });
              toast(`Gekoppeld · ${res.synced.ok} afspraken gesynchroniseerd`);
              route();
            } catch (err) { toast(err.message, 'error', 6000); }
          }));
          list.append(h('div', { class: 'form section-gap' }, h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', null, 'Kies de agenda voor afspraken'), sel), h('div', { class: 'field' }, h('label', null, 'Bij annuleren'), onCancel)), h('div', { class: 'modal-foot' }, connect)));
        } catch (err) { toast(err.message, 'error', 6000); }
      }));
      box.append(
        h('div', { class: 'note blue' }, h('strong', null, 'Eenmalig instellen'),
          h('ol', { class: 'steps-list', style: { marginTop: '8px' } },
            h('li', null, 'Maak in de Agenda-app een nieuwe iCloud-agenda, bijvoorbeeld "Salon" (aanbevolen, zodat afspraken gescheiden blijven).'),
            h('li', null, 'Ga naar account.apple.com → Inloggen en beveiliging → App-specifieke wachtwoorden en maak een wachtwoord aan met de naam "Boekingsportaal". Twee-factor-authenticatie moet aan staan.'),
            h('li', null, 'Vul hieronder je Apple ID en dat app-specifieke wachtwoord in en klik op "Agenda’s zoeken".'),
            h('li', null, 'Kies de agenda en klik op "Koppelen". We plaatsen en verwijderen een testitem om te controleren dat alles werkt.'))),
        h('div', { class: 'grid-2' }, user.el, pass.el), server.el,
        h('div', { class: 'modal-foot' }, findBtn), list,
        h('div', { class: 'hint' }, 'Het wachtwoord wordt versleuteld opgeslagen en alleen gebruikt om afspraken in je agenda te zetten. Je kunt het op elk moment intrekken via je Apple ID.'));
    }
    panel.append(box);

    const regen = h('button', { class: 'btn btn-plain btn-sm' }, 'Nieuwe link maken');
    regen.addEventListener('click', async () => { if (await confirmDialog({ title: 'Nieuwe abonnementslink?', message: 'De oude link werkt daarna niet meer. Je moet het abonnement in Apple Agenda opnieuw toevoegen.', confirmLabel: 'Nieuwe link' })) { await api('/api/admin/calendar/feed/regenerate', { method: 'POST', body: {} }); route(); } });
    panel.parentElement.append(h('section', { class: 'panel glass' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Alternatief: agenda-abonnement (ICS / webcal)'), regen),
      h('p', { class: 'muted', style: { marginTop: 0 } }, 'Wil je geen wachtwoord koppelen? Abonneer je dan op deze privélink. Apple Agenda haalt de afspraken periodiek op (instelbaar, standaard elke 15 minuten tot elk uur). Wijzigingen verschijnen dus met wat vertraging; je kunt in de app niets aan deze afspraken wijzigen.'),
      copy(cal.webcalUrl),
      h('ol', { class: 'steps-list', style: { marginTop: '12px' } },
        h('li', null, 'iPhone/iPad: open de link hierboven in Safari, of ga naar Instellingen → Agenda → Accounts → Voeg account toe → Andere → Voeg agenda-abonnement toe en plak de link.'),
        h('li', null, 'Mac: Agenda → Archief → Nieuw agenda-abonnement… en plak de link. Kies bij "Vernieuw" voor elke 5 of 15 minuten.')),
      h('div', { class: 'note orange', style: { marginTop: '12px' } }, 'Deze link bevat klantgegevens. Deel hem met niemand. Maak een nieuwe link als je denkt dat hij is uitgelekt.')));
  }

  function settingsAccount(panel) {
    const cur = field({ label: 'Huidig wachtwoord', name: 'c', type: 'password', autocomplete: 'current-password' });
    const nw = field({ label: 'Nieuw wachtwoord', name: 'n', type: 'password', autocomplete: 'new-password', hint: 'Minimaal 10 tekens.' });
    const nw2 = field({ label: 'Herhaal nieuw wachtwoord', name: 'n2', type: 'password', autocomplete: 'new-password' });
    const save = h('button', { class: 'btn btn-primary' }, 'Wachtwoord wijzigen');
    save.addEventListener('click', () => {
      if (nw.input.value !== nw2.input.value) { nw2.setError('De wachtwoorden komen niet overeen.'); return; }
      nw2.setError('');
      busy(save, async () => {
        try { await api('/api/admin/password', { method: 'POST', body: { current: cur.input.value, next: nw.input.value } }); toast('Wachtwoord gewijzigd. Andere sessies zijn uitgelogd.'); cur.input.value = nw.input.value = nw2.input.value = ''; } catch (err) { toast(err.message, 'error'); }
      });
    });
    panel.append(h('div', { class: 'form', style: { maxWidth: '440px' } }, h('div', { class: 'muted' }, `Ingelogd als ${me}`), cur.el, nw.el, nw2.el), h('div', { class: 'modal-foot', style: { justifyContent: 'flex-start' } }, save));
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
