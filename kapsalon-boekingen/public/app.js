/* Publieke boekingsflow */
(function () {
  'use strict';
  const { h, clear, api, euro, fmtDate, duration, toast, icon, ICONS, modal, busy, monthCalendar, slotPicker, field } = UI;

  const $ = (id) => document.getElementById(id);
  const stepEl = $('step');
  const STEPS = [
    { key: 'service', title: 'Kies een behandeling' },
    { key: 'date', title: 'Kies een datum' },
    { key: 'time', title: 'Kies een tijd' },
    { key: 'details', title: 'Je gegevens' },
    { key: 'discount', title: 'Kortingscode' },
    { key: 'confirm', title: 'Controleer en bevestig' },
  ];

  const state = {
    salon: null,
    services: [],
    step: 0,
    service: null,
    date: null,
    time: null,
    month: null,
    customer: { firstName: '', lastName: '', email: '', phone: '', notes: '' },
    discountCode: '',
    discount: null,
    quote: null,
  };

  // ---------- Init ----------
  async function init() {
    $('backBtn').innerHTML = ICONS.back;
    $('backBtn').addEventListener('click', () => go(state.step - 1));
    $('manageBtn').addEventListener('click', () => openManage());
    try {
      const [salon, services] = await Promise.all([api('/api/salon'), api('/api/services')]);
      state.salon = salon;
      state.services = services.services;
      renderHeader();
    } catch (err) {
      clear(stepEl).append(h('div', { class: 'empty-state' }, err.message));
      return;
    }
    const params = new URLSearchParams(location.search);
    if (params.get('boeking') && params.get('t')) {
      showPaymentReturn(params.get('boeking'), params.get('t'));
      return;
    }
    go(0);
    if (params.get('beheer')) openManage(params.get('beheer'));
  }

  function renderHeader() {
    const s = state.salon;
    document.title = `Afspraak maken · ${s.name}`;
    $('salonName').textContent = s.name;
    const st = $('status');
    st.classList.toggle('open', s.status.open);
    st.querySelector('span').textContent = s.status.label;
    if (s.logo) {
      const logo = $('logo');
      logo.classList.add('custom');
      clear(logo).append(h('img', { src: s.logo, alt: '' }));
    }
    const parts = [s.address, s.phone ? h('a', { href: `tel:${s.phone.replace(/\s/g, '')}` }, s.phone) : null, s.email ? h('a', { href: `mailto:${s.email}` }, s.email) : null].filter(Boolean);
    const foot = clear($('foot'));
    parts.forEach((p, i) => { if (i) foot.append(' · '); foot.append(p); });
  }

  // ---------- Navigatie ----------
  function go(i) {
    i = Math.max(0, Math.min(STEPS.length - 1, i));
    state.step = i;
    const step = STEPS[i];
    $('stepLabel').textContent = `Stap ${i + 1} van ${STEPS.length}`;
    $('stepTitle').textContent = step.title;
    $('progressBar').style.width = `${((i + 1) / STEPS.length) * 100}%`;
    $('backBtn').hidden = i === 0;
    $('booking').querySelector('.progress').hidden = false;
    renderSelection();
    clear(stepEl);
    const content = h('div', { class: 'fade-in' });
    stepEl.append(content);
    ({ service: stepService, date: stepDate, time: stepTime, details: stepDetails, discount: stepDiscount, confirm: stepConfirm })[step.key](content);
    if (i > 0) $('booking').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderSelection() {
    const el = clear($('selection'));
    const chips = [];
    if (state.service && state.step > 0) chips.push(h('button', { class: 'chip', onclick: () => go(0) }, state.service.name));
    if (state.date && state.step > 1) chips.push(h('button', { class: 'chip', onclick: () => go(1) }, icon('calendar'), fmtDate(state.date, { weekday: 'short', day: 'numeric', month: 'short' })));
    if (state.time && state.step > 2) chips.push(h('button', { class: 'chip', onclick: () => go(2) }, icon('clock'), state.time));
    el.hidden = !chips.length;
    el.append(...chips);
  }

  function actions(...buttons) {
    return h('div', { class: 'step-actions' }, ...buttons);
  }

  // ---------- Stap 1: behandeling ----------
  function depositText(s) {
    if (s.depositType === 'none' || !s.depositCents) return null;
    return `Aanbetaling ${s.depositType === 'percent' ? `${s.depositValue}%` : euro(s.depositCents)}`;
  }

  function stepService(root) {
    if (!state.services.length) {
      root.append(h('div', { class: 'empty-state' }, 'Er zijn op dit moment geen behandelingen online te boeken.'));
      return;
    }
    root.append(h('div', { class: 'services', role: 'list' }, state.services.map((s) => h('button', {
      class: `service ${state.service && state.service.id === s.id ? 'selected' : ''}`, role: 'listitem',
      onclick: () => {
        if (!state.service || state.service.id !== s.id) { state.time = null; state.quote = null; }
        state.service = s;
        go(1);
      },
    },
    h('div', { class: 'service-name' }, s.name),
    s.description ? h('div', { class: 'service-desc' }, s.description) : null,
    h('div', { class: 'service-meta' }, h('span', { class: 'row', style: { gap: '5px' } }, icon('clock'), duration(s.durationMin)), depositText(s) ? h('span', { class: 'badge plain' }, depositText(s)) : null),
    h('div', { class: 'service-price' }, euro(s.priceCents))))));
  }

  // ---------- Stap 2: datum ----------
  function stepDate(root) {
    const today = state.salon.today;
    const maxDate = UI.addDays(today, state.salon.maxDaysAhead);
    const cal = monthCalendar({
      month: state.month || (state.date || today).slice(0, 7),
      minMonth: today.slice(0, 7),
      maxMonth: maxDate.slice(0, 7),
      today,
      selected: state.date,
      load: async (month) => {
        state.month = month;
        const r = await api(`/api/availability/month?service=${state.service.id}&month=${month}`);
        return r.days;
      },
      onSelect: (date) => {
        if (state.date !== date) state.time = null;
        state.date = date;
        setTimeout(() => go(2), 180);
      },
    });
    root.append(cal.el);
  }

  // ---------- Stap 3: tijd ----------
  async function stepTime(root) {
    root.append(h('p', { class: 'muted', style: { margin: '0 0 16px' } }, `${fmtDate(state.date)} · ${state.service.name} (${duration(state.service.durationMin)})`));
    const holder = h('div', null, h('div', { class: 'skeleton', style: { height: '140px' } }));
    root.append(holder);
    try {
      const r = await api(`/api/availability/day?service=${state.service.id}&date=${state.date}`);
      clear(holder);
      if (!r.slots.length) {
        holder.append(h('div', { class: 'empty-state' }, 'Er zijn geen tijden meer vrij op deze dag.', h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn btn-glass', onclick: () => go(1) }, 'Andere datum kiezen'))));
        return;
      }
      if (state.time && !r.slots.includes(state.time)) state.time = null;
      holder.append(slotPicker(r.slots, { selected: state.time, onSelect: (time) => { state.time = time; setTimeout(() => go(3), 160); } }));
    } catch (err) {
      clear(holder).append(h('div', { class: 'empty-state' }, err.message));
    }
  }

  // ---------- Stap 4: gegevens ----------
  const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
  function validateCustomer(c) {
    const e = {};
    const nameRe = /^[\p{L}][\p{L}\p{M}' .-]*$/u;
    if (!c.firstName.trim()) e.firstName = 'Vul je voornaam in.'; else if (!nameRe.test(c.firstName.trim())) e.firstName = 'Gebruik alleen letters.';
    if (!c.lastName.trim()) e.lastName = 'Vul je achternaam in.'; else if (!nameRe.test(c.lastName.trim())) e.lastName = 'Gebruik alleen letters.';
    if (!c.email.trim()) e.email = 'Vul je e-mailadres in.'; else if (!EMAIL_RE.test(c.email.trim())) e.email = 'Dit e-mailadres lijkt niet te kloppen.';
    const digits = c.phone.replace(/\D/g, '');
    if (!c.phone.trim()) e.phone = 'Vul je telefoonnummer in.'; else if (digits.length < 9 || digits.length > 15 || !/^[\d\s+()./-]+$/.test(c.phone)) e.phone = 'Dit telefoonnummer lijkt niet te kloppen.';
    return e;
  }

  function stepDetails(root) {
    const c = state.customer;
    const f = {
      firstName: field({ label: 'Voornaam', name: 'firstName', value: c.firstName, autocomplete: 'given-name', maxlength: 60 }),
      lastName: field({ label: 'Achternaam', name: 'lastName', value: c.lastName, autocomplete: 'family-name', maxlength: 80 }),
      email: field({ label: 'E-mailadres', name: 'email', type: 'email', value: c.email, autocomplete: 'email', inputmode: 'email', hint: 'Hier ontvang je de bevestiging.', maxlength: 254 }),
      phone: field({ label: 'Telefoonnummer', name: 'phone', type: 'tel', value: c.phone, autocomplete: 'tel', inputmode: 'tel', maxlength: 30 }),
    };
    const notes = state.salon.notesEnabled ? field({ label: 'Opmerking (optioneel)', name: 'notes', value: c.notes, textarea: true, maxlength: 500, placeholder: 'Bijvoorbeeld wensen of bijzonderheden' }) : null;
    const form = h('form', { class: 'form', novalidate: true },
      h('div', { class: 'grid-2' }, f.firstName.el, f.lastName.el),
      f.email.el, f.phone.el, notes ? notes.el : null,
      actions(h('button', { class: 'btn btn-primary', type: 'submit' }, 'Verder')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.input.value]));
      values.notes = notes ? notes.input.value : '';
      const errors = validateCustomer(values);
      for (const [k, v] of Object.entries(f)) v.setError(errors[k]);
      if (Object.keys(errors).length) { f[Object.keys(errors)[0]].input.focus(); return; }
      const emailChanged = values.email.trim().toLowerCase() !== state.customer.email.trim().toLowerCase();
      state.customer = { ...values, email: values.email.trim(), firstName: values.firstName.trim(), lastName: values.lastName.trim(), phone: values.phone.trim() };
      if (emailChanged) state.discount = null; // opnieuw controleren
      go(4);
    });
    root.append(form);
  }

  // ---------- Stap 5: kortingscode ----------
  async function fetchQuote(code) {
    return api('/api/quote', { method: 'POST', body: { serviceId: state.service.id, discountCode: code || '', email: state.customer.email, phone: state.customer.phone } });
  }

  function priceList(q) {
    const rows = [h('div', { class: 'list-row' }, h('span', { class: 'k' }, state.service.name), h('span', { class: 'v' }, euro(q.priceCents)))];
    if (q.discount) rows.push(h('div', { class: 'list-row discount' }, h('span', { class: 'k' }, `Korting · ${q.discount.code}`), h('span', { class: 'v' }, `– ${euro(q.discount.cents)}`)));
    rows.push(h('div', { class: 'list-row total' }, h('span', { class: 'k' }, 'Totaal'), h('span', { class: 'v' }, euro(q.finalCents))));
    if (q.depositCents) {
      rows.push(h('div', { class: 'list-row' }, h('span', { class: 'k' }, 'Aanbetaling (nu online)'), h('span', { class: 'v' }, euro(q.depositCents))));
      rows.push(h('div', { class: 'list-row' }, h('span', { class: 'k' }, 'Resterend (in de salon)'), h('span', { class: 'v' }, euro(q.remainingCents))));
    } else {
      rows.push(h('div', { class: 'list-row' }, h('span', { class: 'k' }, 'Te betalen in de salon'), h('span', { class: 'v' }, euro(q.finalCents))));
    }
    return h('div', { class: 'summary-card list' }, rows);
  }

  function stepDiscount(root) {
    const priceHolder = h('div', { class: 'section-gap' });
    const codeField = field({ label: 'Heb je een kortingscode?', name: 'discount', value: state.discount ? state.discount.code : state.discountCode, placeholder: 'Bijv. WELKOM10', autocomplete: 'off', maxlength: 40 });
    codeField.input.setAttribute('autocapitalize', 'characters');
    codeField.input.setAttribute('spellcheck', 'false');
    const applyBtn = h('button', { class: 'btn btn-glass', type: 'submit' }, 'Toepassen');
    const box = h('div');

    function renderBox() {
      clear(box);
      if (state.discount) {
        box.append(h('div', { class: 'discount-ok' },
          h('span', null, `${state.discount.code} · ${state.discount.label}`),
          h('button', { class: 'btn btn-plain btn-sm', type: 'button', onclick: async () => { state.discount = null; state.discountCode = ''; codeField.input.value = ''; renderBox(); await refreshPrice(); } }, 'Verwijderen')));
      } else {
        const row = h('div', { class: 'discount-row' }, codeField.input, applyBtn);
        const label = codeField.el.querySelector('label');
        const err = codeField.el.querySelector('.field-error');
        box.append(h('form', { class: 'field', novalidate: true, onsubmit: apply }, label, row, err));
      }
    }

    async function apply(e) {
      e.preventDefault();
      const code = codeField.input.value.trim();
      if (!code) { codeField.setError('Vul een kortingscode in.'); return; }
      await busy(applyBtn, async () => {
        try {
          const q = await fetchQuote(code);
          if (q.discountError) { codeField.setError(q.discountError); return; }
          codeField.setError('');
          state.discount = q.discount;
          state.discountCode = q.discount.code;
          state.quote = q;
          renderBox();
          renderPrice(q);
          toast(`Kortingscode toegepast: ${q.discount.label}`);
        } catch (err) { codeField.setError(err.message); }
      });
    }

    function renderPrice(q) { clear(priceHolder).append(priceList(q)); }
    async function refreshPrice() {
      try {
        const q = await fetchQuote(state.discount ? state.discount.code : '');
        if (state.discount && q.discountError) { state.discount = null; codeField.setError(q.discountError); renderBox(); }
        state.quote = q;
        renderPrice(q);
      } catch (err) { toast(err.message, 'error'); }
    }

    renderBox();
    root.append(box, priceHolder, actions(h('button', { class: 'btn btn-primary', onclick: () => go(5) }, state.discount ? 'Verder' : 'Verder zonder code')));
    priceHolder.append(h('div', { class: 'skeleton', style: { height: '130px' } }));
    refreshPrice();
  }

  // ---------- Stap 6: bevestigen ----------
  function policyText() {
    const p = state.salon.policy;
    const late = p.lateRefundPct >= 100 ? 'krijg je je aanbetaling alsnog volledig terug'
      : p.lateRefundPct > 0 ? `krijg je ${p.lateRefundPct}% van je aanbetaling terug` : 'wordt je aanbetaling niet terugbetaald';
    return `Wijzigen of annuleren kan kosteloos tot ${p.windowHours} uur voor je afspraak via "Mijn afspraak". Annuleer je later, dan ${late}.`;
  }

  async function stepConfirm(root) {
    root.append(h('div', { class: 'skeleton', style: { height: '220px' } }));
    let q;
    try {
      q = await fetchQuote(state.discount ? state.discount.code : '');
    } catch (err) { clear(root).append(h('div', { class: 'empty-state' }, err.message)); return; }
    clear(root);
    if (state.discount && q.discountError) {
      toast(q.discountError, 'error');
      state.discount = null;
    }
    state.quote = q;
    const c = state.customer;
    const details = h('div', { class: 'summary-card list' },
      row('Behandeling', `${state.service.name} · ${duration(state.service.durationMin)}`),
      row('Datum', fmtDate(state.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })),
      row('Tijd', state.time),
      row('Naam', `${c.firstName} ${c.lastName}`),
      row('E-mail', c.email),
      row('Telefoon', c.phone),
      c.notes ? row('Opmerking', c.notes) : null);

    const agree = h('input', { type: 'checkbox', id: 'agree' });
    const p = state.salon.policy;
    const policy = h('div', { class: 'note section-gap' },
      h('strong', null, 'Annuleringsvoorwaarden'), h('br'), policyText(),
      p.text ? h('div', { style: { marginTop: '8px' } }, p.text) : null);
    const needsPayment = q.depositCents > 0;
    const submit = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, needsPayment ? `Bevestig en betaal ${euro(q.depositCents)}` : 'Bevestig afspraak');
    agree.addEventListener('change', () => { submit.disabled = !agree.checked; });
    const honeypot = h('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', class: 'honeypot', 'aria-hidden': 'true' });

    submit.addEventListener('click', () => busy(submit, async () => {
      try {
        const r = await api('/api/bookings', {
          method: 'POST',
          body: {
            serviceId: state.service.id, date: state.date, time: state.time,
            firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, notes: c.notes,
            discountCode: state.discount ? state.discount.code : '', acceptPolicy: agree.checked, website: honeypot.value,
          },
        });
        if (r.checkoutUrl) {
          try { sessionStorage.setItem('lastBooking', JSON.stringify({ code: r.code, token: r.token })); } catch { /* ignore */ }
          location.href = r.checkoutUrl;
          return;
        }
        showConfirmed(r.booking, r.token);
      } catch (err) {
        if (err.code === 'slot_taken') { toast(err.message, 'error', 5000); state.time = null; go(2); return; }
        if (err.code === 'discount_invalid') { toast(err.message, 'error', 5000); state.discount = null; go(4); return; }
        if (err.fields && Object.keys(err.fields).length) { toast(err.message, 'error'); go(3); return; }
        toast(err.message, 'error', 5000);
      }
    }));

    root.append(
      details,
      h('div', { class: 'section-gap' }, priceList(q)),
      needsPayment ? h('div', { class: 'note blue section-gap' }, `Je betaalt nu een aanbetaling van ${euro(q.depositCents)} via een beveiligde betaalpagina (iDEAL, kaart e.d.). Het resterende bedrag van ${euro(q.remainingCents)} betaal je in de salon.`) : null,
      needsPayment && !state.salon.paymentsEnabled ? h('div', { class: 'note orange section-gap' }, 'Online betalen is op dit moment niet beschikbaar. Neem contact op met de salon om deze behandeling te boeken.') : null,
      policy,
      h('label', { class: 'check section-gap', for: 'agree' }, agree, h('span', null, 'Ik ga akkoord met de annuleringsvoorwaarden en de verwerking van mijn gegevens voor deze afspraak.')),
      honeypot,
      actions(submit));
    if (needsPayment && !state.salon.paymentsEnabled) submit.remove();
  }

  function row(k, v, cls = '') {
    return h('div', { class: `list-row ${cls}` }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));
  }

  // ---------- Resultaat ----------
  function resultShell(title) {
    $('stepLabel').textContent = state.salon.name;
    $('stepTitle').textContent = title;
    $('backBtn').hidden = true;
    $('booking').querySelector('.progress').hidden = true;
    $('selection').hidden = true;
    clear(stepEl);
    const content = h('div', { class: 'fade-in' });
    stepEl.append(content);
    return content;
  }

  function bookingSummary(b) {
    return h('div', { class: 'summary-card list' },
      row('Behandeling', b.serviceName),
      row('Datum', b.dateLabel),
      row('Tijd', `${b.time} – ${b.endTime}`),
      b.discountCents ? row(`Korting · ${b.discountCode}`, `– ${euro(b.discountCents)}`, 'discount') : null,
      row('Totaal', euro(b.finalCents), 'total'),
      b.depositPaidCents ? row('Aanbetaling voldaan', euro(b.depositPaidCents)) : null,
      row('Te betalen in de salon', euro(b.remainingCents)));
  }

  function showConfirmed(b, token) {
    const root = resultShell('Afspraak bevestigd');
    root.append(h('div', { class: 'result' },
      h('div', { class: 'result-icon', html: ICONS.check }),
      h('h2', null, `Tot ${UI.fmtDate(b.date, { weekday: 'long' })}, ${b.firstName}!`),
      h('p', null, `We hebben een bevestiging gestuurd naar ${b.email}.`),
      h('div', { class: 'code-box' }, h('span', { class: 'small muted' }, 'Je boekingscode'), h('strong', null, b.code)),
      bookingSummary(b),
      h('div', { class: 'result-actions' },
        token ? h('a', { class: 'btn btn-glass', href: `/api/bookings/${encodeURIComponent(b.code)}/ics?t=${encodeURIComponent(token)}` }, icon('calendar'), 'Zet in mijn agenda') : null,
        h('button', { class: 'btn btn-primary', onclick: resetFlow }, 'Nieuwe afspraak'))));
    history.replaceState(null, '', '/');
  }

  function resetFlow() {
    Object.assign(state, { step: 0, service: null, date: null, time: null, month: null, discount: null, discountCode: '', quote: null });
    history.replaceState(null, '', '/');
    go(0);
  }

  async function showPaymentReturn(code, token) {
    const root = resultShell('Betaling controleren');
    root.append(h('div', { class: 'result' }, h('div', { class: 'spinner', style: { width: '36px', height: '36px' } }), h('p', null, 'Een moment, we controleren je betaling…')));
    let tries = 0;
    const poll = async () => {
      tries++;
      let r;
      try {
        r = await api(`/api/bookings/${encodeURIComponent(code)}/status?t=${encodeURIComponent(token)}`);
      } catch (err) {
        clear(root).append(h('div', { class: 'result' }, h('div', { class: 'result-icon fail', html: ICONS.close }), h('h2', null, 'Boeking niet gevonden'), h('p', null, err.message), h('div', { class: 'result-actions' }, h('button', { class: 'btn btn-primary', onclick: resetFlow }, 'Afspraak maken'))));
        return;
      }
      const b = r.booking;
      if (b.status === 'confirmed' || b.status === 'completed') return showConfirmed(b, token);
      if (b.status === 'pending_payment' && !r.canRetry && tries < 15) { setTimeout(poll, 2000); return; }
      if (b.status === 'pending_payment' && r.canRetry) {
        const retry = h('button', { class: 'btn btn-primary' }, `Opnieuw betalen (${euro(b.depositCents - b.depositPaidCents)})`);
        retry.addEventListener('click', () => busy(retry, async () => {
          try { const p = await api(`/api/bookings/${encodeURIComponent(code)}/pay`, { method: 'POST', body: { token } }); location.href = p.checkoutUrl; } catch (err) { toast(err.message, 'error'); }
        }));
        resultShell('Betaling niet afgerond');
        clear(stepEl).append(h('div', { class: 'result fade-in' },
          h('div', { class: 'result-icon wait', html: ICONS.clock }),
          h('h2', null, 'Je betaling is niet gelukt'),
          h('p', null, `We houden het tijdstip nog even voor je vast. Rond de aanbetaling af om je afspraak op ${b.dateLabel} om ${b.time} te bevestigen.`),
          h('div', { class: 'result-actions' }, h('button', { class: 'btn btn-glass', onclick: resetFlow }, 'Ander tijdstip kiezen'), retry)));
        return;
      }
      if (b.status === 'pending_payment') {
        clear(root).append(h('div', { class: 'result' }, h('div', { class: 'result-icon wait', html: ICONS.clock }), h('h2', null, 'Betaling wordt verwerkt'),
          h('p', null, 'Je betaling is nog niet bevestigd. Zodra dat gebeurt, ontvang je een bevestiging per e-mail.'),
          h('div', { class: 'result-actions' }, h('button', { class: 'btn btn-primary', onclick: () => { tries = 0; poll(); } }, 'Opnieuw controleren'))));
        return;
      }
      const msg = b.status === 'cancelled' ? 'Deze afspraak is geannuleerd.' : 'De reservering is verlopen omdat de betaling niet op tijd is afgerond.';
      clear(root).append(h('div', { class: 'result' }, h('div', { class: 'result-icon fail', html: ICONS.close }), h('h2', null, 'Geen afspraak gemaakt'), h('p', null, msg),
        h('div', { class: 'result-actions' }, h('button', { class: 'btn btn-primary', onclick: resetFlow }, 'Nieuwe afspraak maken'))));
    };
    poll();
  }

  // ---------- Mijn afspraak ----------
  function openManage(prefillCode) {
    let token = null;
    try { const saved = JSON.parse(sessionStorage.getItem('manage') || 'null'); if (saved && saved.exp > Date.now()) token = saved.token; } catch { /* ignore */ }
    const m = modal({ title: 'Mijn afspraak', subtitle: 'Bekijk, wijzig of annuleer je afspraak' });
    const body = m.body;

    const saveToken = (t) => { token = t; try { sessionStorage.setItem('manage', JSON.stringify({ token: t, exp: Date.now() + 29 * 60_000 })); } catch { /* ignore */ } };
    const dropToken = () => { token = null; try { sessionStorage.removeItem('manage'); } catch { /* ignore */ } };

    async function authed(path, opts = {}) {
      try { return await api(path, { ...opts, token }); } catch (err) {
        if (err.status === 401) { dropToken(); toast(err.message, 'error'); lookup(); }
        throw err;
      }
    }

    function lookup() {
      clear(body);
      const email = field({ label: 'E-mailadres', name: 'memail', type: 'email', autocomplete: 'email', inputmode: 'email', value: state.customer.email });
      const code = field({ label: 'Boekingscode', name: 'mcode', value: prefillCode || '', placeholder: 'Bijv. K7M2QX', autocomplete: 'off', maxlength: 12 });
      code.input.style.textTransform = 'uppercase';
      const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Stuur verificatiecode');
      const form = h('form', { class: 'form fade-in', novalidate: true }, h('p', { class: 'muted', style: { margin: 0 } }, 'Vul het e-mailadres en de boekingscode uit je bevestigingsmail in. We sturen je een code om te controleren dat jij het bent.'), email.el, code.el, btn);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const ev = email.input.value.trim();
        const cv = code.input.value.trim().toUpperCase();
        email.setError(EMAIL_RE.test(ev) ? '' : 'Vul een geldig e-mailadres in.');
        code.setError(/^[A-Z0-9]{4,12}$/.test(cv) ? '' : 'Vul je boekingscode in.');
        if (!EMAIL_RE.test(ev) || !/^[A-Z0-9]{4,12}$/.test(cv)) return;
        busy(btn, async () => {
          try {
            const r = await api('/api/manage/request', { method: 'POST', body: { email: ev, code: cv } });
            verify(cv, ev, r.message);
          } catch (err) { toast(err.message, 'error'); }
        });
      });
      body.append(form);
    }

    function verify(code, email, message) {
      clear(body);
      const otp = field({ label: 'Verificatiecode', name: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '••••••' });
      otp.input.classList.add('otp');
      const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Bevestigen');
      const form = h('form', { class: 'form fade-in', novalidate: true },
        h('div', { class: 'note blue' }, message, h('br'), h('span', { class: 'small' }, `Verstuurd naar ${email}`)),
        otp.el, btn,
        h('button', { class: 'btn btn-plain', type: 'button', onclick: lookup }, 'Andere gegevens invullen'));
      otp.input.addEventListener('input', () => { otp.input.value = otp.input.value.replace(/\D/g, '').slice(0, 6); if (otp.input.value.length === 6) form.requestSubmit(); });
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (otp.input.value.length !== 6) { otp.setError('Vul de 6 cijfers in.'); return; }
        busy(btn, async () => {
          try {
            const r = await api('/api/manage/verify', { method: 'POST', body: { code, otp: otp.input.value } });
            saveToken(r.token);
            overview();
          } catch (err) { otp.setError(err.message); otp.input.select(); }
        });
      });
      body.append(form);
    }

    async function overview() {
      clear(body).append(h('div', { class: 'skeleton', style: { height: '220px' } }));
      let b;
      try { b = (await authed('/api/manage/booking')).booking; } catch { return; }
      clear(body);
      const statusBadge = {
        confirmed: h('span', { class: 'badge green' }, 'Bevestigd'), cancelled: h('span', { class: 'badge red' }, 'Geannuleerd'),
        pending_payment: h('span', { class: 'badge orange' }, 'Wacht op betaling'), completed: h('span', { class: 'badge' }, 'Afgerond'),
      }[b.status] || h('span', { class: 'badge' }, b.status);
      const wrap = h('div', { class: 'fade-in' },
        h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '12px' } }, h('strong', { class: 'num' }, `Boeking ${b.code}`), statusBadge),
        bookingSummary(b));
      if (b.status === 'cancelled') {
        wrap.append(h('div', { class: 'note section-gap' }, b.refundedCents ? `Er is ${euro(b.refundedCents)} teruggestort.` : 'Deze afspraak is geannuleerd.'));
      } else if (b.status === 'confirmed') {
        const t = b.terms;
        wrap.append(h('div', { class: `note section-gap ${t.inTime ? '' : 'orange'}` },
          t.inTime
            ? `Kosteloos wijzigen of annuleren kan tot ${new Date(t.deadline).toLocaleString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.`
            : `De kosteloze annuleringstermijn (${t.windowHours} uur) is verstreken.${b.depositPaidCents ? ` Bij annuleren ontvang je ${euro(t.refundCents)} terug.` : ''}`));
        const foot = h('div', { class: 'modal-foot' });
        if (b.canCancel) foot.append(h('button', { class: 'btn btn-danger', onclick: () => cancelView(b) }, 'Annuleren'));
        if (b.canChange) foot.append(h('button', { class: 'btn btn-primary', onclick: () => changeView(b) }, 'Wijzigen'));
        else if (b.changeBlockedReason) wrap.append(h('p', { class: 'hint' }, b.changeBlockedReason));
        wrap.append(foot);
      }
      body.append(wrap);
    }

    function changeView(b) {
      clear(body);
      const sel = { serviceId: b.serviceId, durationMin: b.durationMin, date: null, time: null };
      const wrap = h('div', { class: 'fade-in' });
      const quoteBox = h('div');
      const calBox = h('div', { class: 'section-gap' });
      const slotBox = h('div', { class: 'section-gap' });
      const save = h('button', { class: 'btn btn-primary', disabled: true }, 'Wijziging opslaan');
      let blocked = null;

      if (b.allowServiceChange && state.services.length > 1) {
        const select = h('select', { class: 'select', id: 'm-service' }, state.services.map((s) => h('option', { value: String(s.id), selected: s.id === b.serviceId }, `${s.name} · ${duration(s.durationMin)} · ${euro(s.priceCents)}`)));
        if (!state.services.some((s) => s.id === b.serviceId)) select.prepend(h('option', { value: String(b.serviceId), selected: true }, b.serviceName));
        select.addEventListener('change', async () => {
          sel.serviceId = Number(select.value);
          const svc = state.services.find((s) => s.id === sel.serviceId);
          sel.durationMin = svc ? svc.durationMin : b.durationMin;
          sel.time = null;
          clear(slotBox);
          clear(quoteBox);
          blocked = null;
          if (sel.serviceId !== b.serviceId) {
            try {
              const q = await authed('/api/manage/change-quote', { method: 'POST', body: { serviceId: sel.serviceId } });
              blocked = q.blocked;
              quoteBox.append(h('div', { class: `note section-gap ${q.blocked ? 'orange' : ''}` },
                q.blocked || `Nieuwe prijs ${euro(q.finalCents)}${q.discount ? ` (incl. korting ${q.discount.code})` : ''}. Al betaald: ${euro(q.depositCents)}. In de salon: ${euro(q.remainingCents)}.`,
                q.discountDropped && !q.blocked ? h('div', null, 'Let op: je kortingscode geldt niet voor deze behandeling.') : null));
            } catch { /* afgehandeld */ }
          }
          cal.refresh();
          updateSave();
        });
        wrap.append(h('div', { class: 'field' }, h('label', { for: 'm-service' }, 'Behandeling'), select), quoteBox);
      }

      const today = state.salon.today;
      const cal = monthCalendar({
        month: b.date.slice(0, 7) < today.slice(0, 7) ? today.slice(0, 7) : b.date.slice(0, 7),
        minMonth: today.slice(0, 7), maxMonth: UI.addDays(today, state.salon.maxDaysAhead).slice(0, 7), today,
        load: async (month) => (await authed(`/api/availability/month?service=${sel.serviceId}&month=${month}`)).days,
        onSelect: async (date) => {
          sel.date = date;
          sel.time = null;
          updateSave();
          clear(slotBox).append(h('div', { class: 'skeleton', style: { height: '100px' } }));
          try {
            const r = await authed(`/api/availability/day?service=${sel.serviceId}&date=${date}`);
            clear(slotBox);
            if (!r.slots.length) { slotBox.append(h('p', { class: 'muted' }, 'Geen tijden vrij op deze dag.')); return; }
            slotBox.append(h('div', { class: 'label', style: { marginBottom: '10px' } }, fmtDate(date)), slotPicker(r.slots, { onSelect: (time) => { sel.time = time; updateSave(); } }));
          } catch { clear(slotBox); }
        },
      });
      calBox.append(cal.el);

      function updateSave() { save.disabled = !(sel.date && sel.time) || Boolean(blocked); }
      save.addEventListener('click', () => busy(save, async () => {
        try {
          await authed('/api/manage/reschedule', { method: 'POST', body: { date: sel.date, time: sel.time, serviceId: sel.serviceId } });
          toast('Je afspraak is gewijzigd. Je ontvangt een bevestiging per e-mail.');
          overview();
        } catch (err) { if (err.status !== 401) toast(err.message, 'error', 5000); if (err.code === 'slot_taken') cal.refresh(); }
      }));

      wrap.append(calBox, slotBox, h('div', { class: 'modal-foot' }, h('button', { class: 'btn btn-glass', onclick: overview }, 'Terug'), save));
      body.append(wrap);
    }

    function cancelView(b) {
      clear(body);
      const t = b.terms;
      const lines = [];
      if (b.depositPaidCents) {
        lines.push(row('Betaalde aanbetaling', euro(b.depositPaidCents - b.refundedCents)));
        if (t.feeCents) lines.push(row('Annuleringskosten', euro(t.feeCents)));
        lines.push(row('Terugbetaling', euro(t.refundCents), 'total'));
      }
      const btn = h('button', { class: 'btn btn-danger' }, 'Afspraak annuleren');
      btn.addEventListener('click', () => busy(btn, async () => {
        try {
          const r = await authed('/api/manage/cancel', { method: 'POST', body: {} });
          toast(r.refundCents ? `Geannuleerd. ${euro(r.refundCents)} wordt teruggestort.` : 'Je afspraak is geannuleerd.');
          overview();
        } catch (err) { if (err.status !== 401) toast(err.message, 'error', 5000); }
      }));
      body.append(h('div', { class: 'fade-in' },
        h('p', { style: { marginTop: 0 } }, `Weet je zeker dat je je afspraak voor ${b.serviceName} op ${b.dateLabel} om ${b.time} wilt annuleren?`),
        lines.length ? h('div', { class: 'summary-card list' }, lines) : null,
        h('div', { class: `note section-gap ${t.inTime ? 'green' : 'orange'}` },
          t.inTime ? 'Je annuleert binnen de gratis annuleringstermijn.' : `Je annuleert minder dan ${t.windowHours} uur van tevoren; het annuleringsbeleid is van toepassing.`),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn btn-glass', onclick: overview }, 'Terug'), btn)));
    }

    if (token && !prefillCode) overview(); else lookup();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
