/* Gedeelde UI-hulpfuncties (publiek + beheer). Geen externe afhankelijkheden. */
(function () {
  'use strict';

  // Conditionele kinderen (cond ? el : null) mogen nooit als tekst "null" in de pagina belanden:
  // laat native append/prepend lege waarden overslaan.
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    for (const method of ['append', 'prepend']) {
      const native = proto[method];
      proto[method] = function (...nodes) {
        return native.apply(this, nodes.filter((n) => n != null && n !== false));
      };
    }
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'html') el.innerHTML = v; // alleen voor vaste, eigen markup (iconen)
        else if (v === true) el.setAttribute(k, '');
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v);
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.status = status;
      this.data = data || {};
      this.fields = this.data.fields || {};
      this.code = this.data.code;
    }
  }

  async function api(path, { method = 'GET', body, token, signal } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin', signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ApiError('Geen verbinding. Controleer je internet en probeer het opnieuw.', 0);
    }
    let data = null;
    try { data = await res.json(); } catch { /* leeg */ }
    if (!res.ok) throw new ApiError((data && data.error) || 'Er ging iets mis.', res.status, data);
    return data;
  }

  const eurFmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
  const euro = (cents) => eurFmt.format((cents || 0) / 100);

  function parseDate(date) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12));
  }
  function fmtDate(date, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
    return new Intl.DateTimeFormat('nl-NL', { ...opts, timeZone: 'UTC' }).format(parseDate(date));
  }
  function addDays(date, n) {
    const d = parseDate(date);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function addMonths(month, n) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  }
  function weekdayIndex(date) { return parseDate(date).getUTCDay(); }
  const toMin = (hhmm) => { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; };
  const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  function duration(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} u ${m} min` : `${h} uur`;
  }

  function toast(message, type = 'info', ms = 3600) {
    let root = document.querySelector('.toasts');
    if (!root) {
      root = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.append(root);
    }
    const el = h('div', { class: `toast glass ${type}` }, message);
    root.append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
  }

  const ICONS = {
    close: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    back: '<svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true"><path d="M8.5 1.5L2 8l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    left: '<svg width="9" height="14" viewBox="0 0 9 14" aria-hidden="true"><path d="M7.5 1.5L2 7l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    right: '<svg width="9" height="14" viewBox="0 0 9 14" aria-hidden="true"><path d="M1.5 1.5L7 7l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true"><path d="M6 14.5l5.2 5.2L22 8.8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1v12M1 7h12" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    clock: '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.4 1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    calendar: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="11.4" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.8 6.3h12.4M5 1.3v3M11 1.3v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  };
  const icon = (name) => h('span', { class: 'icon', 'aria-hidden': 'true', html: ICONS[name] || '' });

  /** Modaal venster (bottom sheet op mobiel). Retourneert { el, body, close }. */
  function modal({ title, subtitle, content, wide = false, onClose } = {}) {
    const body = h('div', { class: 'modal-body' });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      root.classList.add('closing');
      document.removeEventListener('keydown', onKey);
      setTimeout(() => { root.remove(); if (onClose) onClose(); }, 220);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    };
    const head = h('div', { class: 'modal-head' },
      h('div', null, title ? h('h2', { id: 'modal-title' }, title) : null, subtitle ? h('div', { class: 'muted small', style: { marginTop: '4px' } }, subtitle) : null),
      h('button', { class: 'btn btn-glass btn-icon modal-close', 'aria-label': 'Sluiten', onclick: close, html: ICONS.close }));
    const box = h('div', { class: `modal glass ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? 'modal-title' : null }, head, body);
    const root = h('div', { class: 'modal-root' }, h('div', { class: 'modal-scrim', onclick: close }), box);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const prevFocus = document.activeElement;
    document.addEventListener('keydown', onKey);
    if (content) append(body, [content]);
    document.body.append(root);
    setTimeout(() => { const f = box.querySelector('input, select, textarea, button:not(.modal-close)'); if (f) f.focus({ preventScroll: true }); }, 60);
    return { el: box, body, close, setTitle: (tx) => { const t = head.querySelector('h2'); if (t) t.textContent = tx; } };
  }

  function confirmDialog({ title, message, confirmLabel = 'Bevestigen', danger = false }) {
    return new Promise((resolve) => {
      let answered = false;
      const m = modal({
        title,
        content: [
          h('p', { class: 'muted', style: { margin: 0 } }, message),
          h('div', { class: 'modal-foot' },
            h('button', { class: 'btn btn-glass', onclick: () => { answered = true; m.close(); resolve(false); } }, 'Annuleren'),
            h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { answered = true; m.close(); resolve(true); } }, confirmLabel)),
        ],
        onClose: () => { if (!answered) resolve(false); },
      });
    });
  }

  /** Knop in laadtoestand zetten tijdens een async actie. */
  async function busy(button, fn) {
    if (!button) return fn();
    const old = Array.from(button.childNodes);
    button.disabled = true;
    const w = button.offsetWidth;
    button.style.minWidth = `${w}px`;
    clear(button).append(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
    try {
      return await fn();
    } finally {
      clear(button).append(...old);
      button.disabled = false;
      button.style.minWidth = '';
    }
  }

  /**
   * Maandkalender. load(month) -> Promise<[{date, available}]>.
   * Opties: month, minMonth, maxMonth, selected, onSelect(date), today, allowAll (alle dagen klikbaar).
   */
  function monthCalendar(opts) {
    let month = opts.month;
    let selected = opts.selected || null;
    const root = h('div', { class: 'cal' });
    const title = h('div', { class: 'cal-title', 'aria-live': 'polite' });
    const prev = h('button', { class: 'btn btn-glass btn-icon btn-sm', 'aria-label': 'Vorige maand', html: ICONS.left, onclick: () => go(-1) });
    const next = h('button', { class: 'btn btn-glass btn-icon btn-sm', 'aria-label': 'Volgende maand', html: ICONS.right, onclick: () => go(1) });
    const grid = h('div', { class: 'cal-grid', role: 'grid' });
    root.append(h('div', { class: 'cal-head' }, prev, title, next), grid);
    if (!opts.allowAll) {
      root.append(h('div', { class: 'cal-legend' }, h('span', null, h('i'), 'Beschikbaar'), h('span', null, h('i', { class: 'off' }), 'Niet beschikbaar')));
    }
    let reqId = 0;

    function go(n) {
      month = addMonths(month, n);
      render();
    }

    async function render() {
      const id = ++reqId;
      prev.disabled = opts.minMonth && month <= opts.minMonth;
      next.disabled = opts.maxMonth && month >= opts.maxMonth;
      title.textContent = new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseDate(`${month}-01`));
      grid.classList.add('cal-loading');
      if (!grid.childNodes.length) drawGrid([]);
      let days = [];
      try { days = opts.allowAll ? [] : await opts.load(month); } catch (err) { toast(err.message, 'error'); }
      if (id !== reqId) return;
      drawGrid(days);
      grid.classList.remove('cal-loading');
    }

    function drawGrid(days) {
      clear(grid);
      for (const d of ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']) grid.append(h('div', { class: 'cal-dow', role: 'columnheader' }, d));
      const first = `${month}-01`;
      const offset = (weekdayIndex(first) + 6) % 7;
      for (let i = 0; i < offset; i++) grid.append(h('div', { class: 'cal-day empty' }));
      const [y, m] = month.split('-').map(Number);
      const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const map = new Map(days.map((d) => [d.date, d]));
      for (let d = 1; d <= total; d++) {
        const date = `${month}-${String(d).padStart(2, '0')}`;
        const info = map.get(date);
        const available = opts.allowAll || (info && info.available);
        const cls = ['cal-day'];
        if (available && !opts.allowAll) cls.push('avail');
        if (date === opts.today) cls.push('today');
        if (date === selected) cls.push('selected');
        grid.append(h('button', {
          class: cls.join(' '), disabled: !available, 'aria-pressed': date === selected ? 'true' : 'false',
          'aria-label': `${fmtDate(date)}${available ? '' : ', niet beschikbaar'}`,
          dataset: { date },
          onclick: () => {
            selected = date;
            grid.querySelectorAll('.cal-day.selected').forEach((x) => { x.classList.remove('selected'); x.setAttribute('aria-pressed', 'false'); });
            const btn = grid.querySelector(`.cal-day[data-date="${date}"]`);
            if (btn) { btn.classList.add('selected'); btn.setAttribute('aria-pressed', 'true'); }
            opts.onSelect(date);
          },
        }, String(d)));
      }
    }

    render();
    return { el: root, refresh: render, setMonth: (m) => { month = m; render(); } };
  }

  /** Tijdsloten gegroepeerd in ochtend / middag / avond. */
  function slotPicker(slots, { selected, onSelect }) {
    const groups = [
      ['Ochtend', (m) => m < 720],
      ['Middag', (m) => m >= 720 && m < 1020],
      ['Avond', (m) => m >= 1020],
    ];
    const root = h('div', { class: 'slot-picker' });
    for (const [label, test] of groups) {
      const list = slots.filter((s) => test(toMin(s)));
      if (!list.length) continue;
      root.append(h('div', { class: 'slot-group' },
        h('h4', null, label),
        h('div', { class: 'slots' }, list.map((s) => h('button', {
          class: `slot ${s === selected ? 'selected' : ''}`, 'aria-pressed': s === selected ? 'true' : 'false',
          onclick: (e) => { root.querySelectorAll('.slot.selected').forEach((x) => x.classList.remove('selected')); e.currentTarget.classList.add('selected'); onSelect(s); },
        }, s)))));
    }
    return root;
  }

  function field({ label, name, type = 'text', value = '', placeholder, autocomplete, inputmode, required, hint, maxlength, textarea }) {
    const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
    const input = textarea
      ? h('textarea', { class: 'textarea', id, name, placeholder, maxlength })
      : h('input', { class: 'input', id, name, type, placeholder, autocomplete, inputmode, required, maxlength });
    input.value = value || '';
    const error = h('div', { class: 'field-error', id: `${id}-err`, role: 'alert' });
    input.setAttribute('aria-describedby', `${id}-err`);
    const wrap = h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null, error);
    return {
      el: wrap, input,
      setError(msg) { error.textContent = msg || ''; input.classList.toggle('invalid', Boolean(msg)); input.setAttribute('aria-invalid', msg ? 'true' : 'false'); },
    };
  }

  window.UI = {
    h, append, clear, api, ApiError, euro, fmtDate, parseDate, addDays, addMonths, weekdayIndex, toMin, toHHMM, duration,
    toast, icon, ICONS, modal, confirmDialog, busy, monthCalendar, slotPicker, field,
  };
})();
