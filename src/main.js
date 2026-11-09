import './style.css';
import { TERMS, TERMS_CLOSING, TERMS_PARTIES, TERMS_TITLE, TERMS_VERSION } from './terms.js';
import { mountHero } from './hero3d.js';
import { mountSignature } from './signature.js';
import { initAuth, getSession, getKnownUser, signOut, renderGoogleButton } from './auth.js';
import { enqueue, listPending, removePending, updatePending, newClientId, requestPersistence, isNetworkError, isAuthError } from './queue.js';
import { API_URL, PAYMENTS_ENABLED, APLAZO_ENABLED, createOrder, listOrders, addPayment, setPaymentPlan, completeOrder, createPaymentLink, createAplazoLink, cancelAplazoLink } from './api.js';
import { initPWA } from './pwa.js';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const DRAFT_KEY = 'zpev-borrador';
const HISTORY_KEY = 'zpev-historial';
const MONTH_GOAL = 120; // referencia visual del medidor de órdenes del mes

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const form = $('#orderForm');
const submitBtn = $('#submitBtn');
const submitLabel = $('.cta-label', submitBtn);
let session = null;
let offlineUser = null;
let lastOrder = null;
let historyCache = [];

const fmtMXN = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const digits = (v) => String(v || '').replace(/\D/g, '');
const clean = (v) => String(v || '').trim().replace(/\s+/g, ' ');
const pad = (n) => String(n).padStart(2, '0');
const formatPhone = (d) => (d.length === 10 ? `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}` : d);
const waLink = (tel, text) => `https://wa.me/52${digits(tel)}?text=${encodeURIComponent(text)}`;

// ================= Términos =================
function renderTerms() {
  const frag = document.createDocumentFragment();
  const h = Object.assign(document.createElement('h3'), { className: 'terms-title', textContent: TERMS_TITLE });
  const parties = Object.assign(document.createElement('p'), { className: 'terms-parties', textContent: TERMS_PARTIES });
  frag.append(h, parties);
  TERMS.forEach((c) => {
    const art = document.createElement('article');
    art.className = 'clause';
    const head = document.createElement('h4');
    head.textContent = `${c.id}.${c.title ? ` ${c.title}.` : ''}`;
    art.append(head);
    c.paragraphs.forEach((p) => art.append(Object.assign(document.createElement('p'), { textContent: p })));
    if (c.callout) art.append(Object.assign(document.createElement('p'), { className: 'clause-callout', textContent: c.callout }));
    frag.append(art);
  });
  TERMS_CLOSING.forEach((p) => frag.append(Object.assign(document.createElement('p'), { className: 'terms-closing', textContent: p })));
  $('#termsBody').replaceChildren(frag);
}

const termsBox = $('#termsBox');
const acepta = $('#acepta');
const termsHint = $('#termsHint');
let termsRead = false;

function checkTermsRead() {
  const { scrollTop, scrollHeight, clientHeight } = termsBox;
  const span = Math.max(scrollHeight - clientHeight, 1);
  const ratio = scrollHeight - clientHeight <= 4 ? 1 : Math.min(scrollTop / span, 1);
  $('#termsBar').style.width = `${Math.round(ratio * 100)}%`;
  if (ratio >= 0.985) termsRead = true;
  acepta.disabled = !termsRead;
  termsHint.textContent = termsRead ? 'Marca la casilla para aceptar.' : 'Desplázate hasta el final del contrato para continuar.';
  termsHint.classList.toggle('is-hidden', acepta.checked);
}

// ================= Firma =================
let sigReady = false;
const signature = mountSignature($('#sigScene'), {
  canvas: $('#sigCanvas'),
  plane: $('#sigPlane'),
  hintEl: $('#sigHint'),
  stateEl: $('#sigState'),
  undoBtn: $('#undoBtn'),
  clearBtn: $('#clearBtn'),
  onChange: () => sigReady && updatePreview()
});
sigReady = true;

// ================= Valores y validación =================
function values() {
  const enc = form.querySelector('input[name="encendido"]:checked');
  return {
    nombre: clean($('#nombre').value),
    telefono: digits($('#telefono').value),
    fecha: $('#fecha').value,
    hora: $('#hora').value,
    marca: clean($('#marca').value),
    serie: clean($('#serie').value),
    encendido: enc ? enc.value : '',
    servicio: clean($('#servicio').value),
    caracteristicas: clean($('#caracteristicas').value),
    llaves: clean($('#llaves').value),
    cargador: clean($('#cargador').value),
    otros: clean($('#otros').value),
    presupuesto: num($('#presupuesto').value),
    anticipo: num($('#anticipo').value),
    // El costo del servicio es el total de la cuenta; lo que falta pagar = costo − anticipo.
    total: num($('#presupuesto').value),
    plan: (form.querySelector('input[name="plan"]:checked') || {}).value || 'Anticipo y liquidación',
    aceptaTerminos: acepta.checked,
    firma: signature.hasInk()
  };
}

function validate(v) {
  const checks = {
    cliente: v.nombre.length >= 3 && v.telefono.length === 10,
    vehiculo: v.marca.length >= 2,
    servicio: v.servicio.length >= 5,
    encendido: v.encendido !== '',
    terminos: v.aceptaTerminos,
    firma: v.firma
  };
  const ok = Object.values(checks).every(Boolean) && Boolean(v.fecha && v.hora);
  return { ok, checks };
}

function updatePreview() {
  const v = values();
  const { ok, checks } = validate(v);
  const saldo = Math.max(v.total - v.anticipo, 0);
  $('#saldo').value = saldo.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  $('#pvNombre').textContent = v.nombre || 'Nombre del cliente';
  $('#pvTel').textContent = v.telefono ? formatPhone(v.telefono) : 'Teléfono pendiente';
  $('#pvMarca').textContent = v.marca || 'Marca y modelo';
  $('#pvSerie').textContent = v.serie ? `Serie ${v.serie}` : 'Sin número de serie';
  $('#pvServicio').textContent = v.servicio || 'Describe el servicio solicitado.';
  $('#pvPresup').textContent = fmtMXN(v.presupuesto);
  $('#pvAnticipo').textContent = fmtMXN(v.anticipo);
  $('#pvSaldo').textContent = fmtMXN(saldo);
  $('#planHint').textContent = v.plan === 'Varios pagos'
    ? 'El cliente puede abonar varias veces; cada pago se registra en el historial.'
    : 'El saldo se liquida en un solo pago al entregar.';

  const chips = [];
  if (v.encendido) chips.push(v.encendido === 'si' ? 'Encendido' : 'Apagado');
  if (v.llaves) chips.push(`Llaves: ${v.llaves}`);
  if (v.cargador) chips.push(`Cargador: ${v.cargador}`);
  if (v.otros) chips.push(v.otros);
  $('#pvChips').replaceChildren(...chips.map((t) => Object.assign(document.createElement('span'), { className: 'chip', textContent: t })));

  const thumb = $('#pvSig');
  if (v.firma) {
    const img = Object.assign(document.createElement('img'), { alt: 'Firma del cliente', src: signature.toDataURL() });
    thumb.replaceChildren(img);
  } else {
    thumb.replaceChildren(Object.assign(document.createElement('span'), { textContent: 'Pendiente' }));
  }

  const bat = /bater/i.test(v.servicio);
  $('#batHint').classList.toggle('is-hidden', !bat);
  $('#halfBtn').classList.toggle('is-hidden', !(bat && v.total > 0));

  $$('.checklist li').forEach((li) => li.classList.toggle('is-done', Boolean(checks[li.dataset.check])));
  const overpaid = v.anticipo > v.total && v.total > 0;
  submitBtn.disabled = !ok || overpaid;
  submitLabel.textContent = overpaid ? 'El anticipo supera el costo' : ok ? 'Enviar orden y guardar' : 'Completa la orden para enviar';

  const done = Object.values(checks).filter(Boolean).length;
  const dockCta = $('#dockCta');
  dockCta.disabled = !ok || overpaid;
  dockCta.classList.toggle('is-ready', ok && !overpaid);
  $('#dockProgress').textContent = `${done}/6`;
  $('#dockLabel').textContent = overpaid ? 'Anticipo mayor al costo' : ok ? 'Enviar orden' : 'Completa la orden';
}

// ================= Borrador automático =================
const DRAFT_FIELDS = ['nombre', 'telefono', 'marca', 'serie', 'servicio', 'caracteristicas', 'llaves', 'cargador', 'otros', 'presupuesto', 'anticipo'];
let draftTimer = 0;

function saveDraftNow() {
  clearTimeout(draftTimer);
  writeDraft();
}

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, 400);
}

function writeDraft() {
  const data = Object.fromEntries(DRAFT_FIELDS.map((k) => [k, $(`#${k}`).value]));
  const enc = form.querySelector('input[name="encendido"]:checked');
  data.encendido = enc ? enc.value : '';
  const empty = Object.values(data).every((x) => !x);
  try {
    if (empty) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify({ data, at: Date.now() }));
  } catch (_) { /* almacenamiento no disponible */ }
  const now = new Date();
  $('#draftState').textContent = empty ? '' : `Borrador guardado · ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const { data, at } = JSON.parse(raw);
    DRAFT_FIELDS.forEach((k) => { if (data[k]) $(`#${k}`).value = data[k]; });
    if (data.encendido) {
      const r = form.querySelector(`input[name="encendido"][value="${data.encendido}"]`);
      if (r) r.checked = true;
    }
    const d = new Date(at);
    $('#draftState').textContent = `Borrador recuperado · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (_) { /* borrador dañado: se ignora */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (_) { /* noop */ }
  $('#draftState').textContent = '';
}

// ================= Eventos del formulario =================
form.addEventListener('input', () => { updatePreview(); saveDraft(); });
form.addEventListener('change', () => { updatePreview(); saveDraft(); });
$('#telefono').addEventListener('input', (e) => { e.target.value = digits(e.target.value).slice(0, 10); });
$('#halfBtn').addEventListener('click', () => {
  $('#anticipo').value = (Math.round(num($('#presupuesto').value) * 50) / 100).toFixed(2);
  updatePreview();
  saveDraft();
});
termsBox.addEventListener('scroll', checkTermsRead, { passive: true });
acepta.addEventListener('change', () => { termsHint.classList.toggle('is-hidden', acepta.checked); updatePreview(); });
$('#discardBtn').addEventListener('click', () => { resetForm(); toast('Borrador descartado.'); });

// ================= Vistas =================
function setView(name) {
  $('#view-orden').hidden = name !== 'orden';
  $('#view-historial').hidden = name !== 'historial';
  $('#dock').dataset.view = name;
  $$('.nav-item[data-view], .dock-tab').forEach((b) => {
    const on = b.dataset.view === name;
    b.classList.toggle('is-active', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'historial') loadHistory();
  window.scrollTo({ top: 0 });
}
$$('.nav-item[data-view], .dock-tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$$('.nav-item[data-jump]').forEach((a) => a.addEventListener('click', () => { if ($('#view-orden').hidden) setView('orden'); }));

// ================= Historial =================
const STATUS = {
  recibido: 'Recibido', reparacion: 'En reparación', listo: 'Listo para entrega', entregado: 'Entregado',
  pagado: 'Anticipo pagado', pagada: 'Pagada', completada: 'Completada'
};
const statusKey = (s) => {
  const t = String(s || '').toLowerCase();
  if (t.includes('complet')) return 'completada';
  if (t.includes('anticipo')) return 'pagado';
  if (t.includes('pagad')) return 'pagada';
  if (t.includes('repar')) return 'reparacion';
  if (t.includes('listo')) return 'listo';
  if (t.includes('entreg')) return 'entregado';
  return 'recibido';
};
const isClosed = (o) => statusKey(o.estatus) === 'completada';

function svg(path) {
  return `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
const ICON_WA = svg('<path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z"/><path d="M9 9.5c.5 2 2.3 4 4.5 4.6l1.2-1.2 2 .9c-.2 1.3-1.4 2-2.7 1.8C10.6 15 8 12.5 7.6 9.3c-.1-1.2.6-2.4 1.8-2.6l.9 2z"/>');
const ICON_PAY = svg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18M7 15h3"/>');
const ICON_DONE = svg('<path d="M5 12.5l4.2 4.2L19 7"/>');
const ICON_SIG = svg('<path d="M3 17c3-2 4 2 6 0s3-4 5-2 2 3 4 1"/><path d="M3 21h18"/>');

function renderHistory() {
  const q = clean($('#histSearch').value).toLowerCase();
  const rows = historyCache.filter((o) => !q || [o.folio, o.cliente, o.marca, o.telefono].join(' ').toLowerCase().includes(q));
  const body = $('#histBody');
  body.replaceChildren(...rows.map((o) => {
    const tr = document.createElement('tr');
    const key = statusKey(o.estatus);
    const msg = key === 'listo'
      ? `Hola ${o.cliente}, tu ${o.marca} (orden ${o.folio}) ya está listo para recoger en Z e-Scooters México, Av. Patriotismo 176. Horario: L–V 10:00–19:00, S 10:00–15:00. Total a pagar: ${fmtMXN(o.saldo)}.`
      : `Hola ${o.cliente}, te escribimos de Z e-Scooters México sobre tu orden ${o.folio} (${o.marca}).`;
    tr.innerHTML = `
      <td><div class="td-main mono"></div><div class="td-sub"></div></td>
      <td><div class="td-main"></div><div class="td-sub mono"></div></td>
      <td><div class="td-main"></div></td>
      <td class="num"></td>
      <td class="num"></td>
      <td><span class="badge" data-s="${key}"></span></td>
      <td><div class="td-actions"></div></td>`;
    const tds = tr.children;
    tds[0].children[0].textContent = o.folio;
    tds[0].children[1].textContent = o.fecha || '';
    tds[1].children[0].textContent = o.cliente;
    tds[1].children[1].textContent = formatPhone(digits(o.telefono));
    tds[2].children[0].textContent = o.marca;
    tds[3].textContent = fmtMXN(o.total);
    tds[4].textContent = fmtMXN(o.saldo);
    tds[5].firstElementChild.textContent = STATUS[key];
    const actions = tds[6].firstElementChild;
    if (digits(o.telefono).length === 10) {
      const a = Object.assign(document.createElement('a'), { className: 'icon-btn', href: waLink(o.telefono, msg), target: '_blank', rel: 'noopener', title: 'Escribir por WhatsApp' });
      a.innerHTML = ICON_WA;
      a.setAttribute('aria-label', `WhatsApp a ${o.cliente}`);
      actions.append(a);
    }
    if (!isClosed(o) && num(o.saldo) > 0) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn', title: 'Registrar pago' });
      b.innerHTML = ICON_PAY;
      b.setAttribute('aria-label', `Registrar pago de la orden ${o.folio}`);
      b.addEventListener('click', () => openPayDialog(o));
      actions.append(b);
    }
    if (!isClosed(o) && num(o.saldo) <= 0) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn is-go', title: 'Liberar orden (completada)' });
      b.innerHTML = ICON_DONE;
      b.setAttribute('aria-label', `Liberar la orden ${o.folio}`);
      b.addEventListener('click', () => releaseOrder(o, b));
      actions.append(b);
    }
    if (o.firmaUrl) {
      const a = Object.assign(document.createElement('a'), { className: 'icon-btn', href: o.firmaUrl, target: '_blank', rel: 'noopener', title: 'Ver firma' });
      a.innerHTML = ICON_SIG;
      a.setAttribute('aria-label', `Firma de la orden ${o.folio}`);
      actions.append(a);
    }
    return tr;
  }));
  const empty = $('#histEmpty');
  empty.hidden = rows.length > 0;
  if (!rows.length) empty.textContent = historyCache.length ? 'Ninguna orden coincide con la búsqueda.' : 'Aún no hay órdenes registradas. Captura la primera en Nueva orden.';

  const open = historyCache.filter((o) => !['entregado', 'completada'].includes(statusKey(o.estatus)));
  $('#stOrders').textContent = historyCache.length;
  $('#stOpen').textContent = open.length;
  $('#stAdv').textContent = fmtMXN(historyCache.reduce((a, o) => a + num(o.anticipo), 0));
  $('#stDue').textContent = fmtMXN(open.reduce((a, o) => a + num(o.saldo), 0));
}

// ----- Pagos posteriores y liberación -----
let payOrder = null;
const payDlg = $('#payDlg');

function syncPayAmount() {
  const due = num(payOrder?.saldo);
  const plan = (payDlg.querySelector('input[name="pdPlan"]:checked') || {}).value;
  const monto = $('#pdMonto');
  if (plan !== 'Varios pagos') {
    monto.value = due.toFixed(2);
    monto.readOnly = true;
  } else {
    monto.readOnly = false;
    if (num(monto.value) > due) monto.value = due.toFixed(2);
  }
  monto.max = due.toFixed(2);
}

function openPayDialog(o) {
  payOrder = o;
  const paid = Math.max(num(o.total) - num(o.saldo), 0);
  $('#pdFolio').textContent = `${o.folio} · ${o.cliente}`;
  $('#pdTotal').textContent = fmtMXN(o.total);
  $('#pdPaid').textContent = fmtMXN(paid);
  $('#pdDue').textContent = fmtMXN(o.saldo);
  const plan = o.plan === 'Varios pagos' ? 'Varios pagos' : 'Anticipo y liquidación';
  payDlg.querySelectorAll('input[name="pdPlan"]').forEach((r) => { r.checked = r.value === plan; });
  $('#pdMonto').value = '';
  $('#pdNota').value = '';
  $('#pdMetodo').selectedIndex = 0;
  syncPayAmount();
  payDlg.hidden = false;
  requestAnimationFrame(() => payDlg.classList.add('is-in'));
  $('#pdMonto').focus();
}

function closePayDialog() {
  payDlg.classList.remove('is-in');
  payDlg.hidden = true;
  payOrder = null;
}

payDlg.querySelectorAll('input[name="pdPlan"]').forEach((r) => r.addEventListener('change', syncPayAmount));
$('#pdCancel').addEventListener('click', closePayDialog);
payDlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePayDialog(); });

$('#payForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!payOrder) return;
  session = getSession();
  if (!session) return promptLogin('Tu sesión venció. Vuelve a iniciar sesión.');
  const monto = Math.round(num($('#pdMonto').value) * 100) / 100;
  const due = num(payOrder.saldo);
  if (!(monto > 0) || monto > due) return toast(`El monto debe ser mayor a cero y no superar ${fmtMXN(due)}.`, 'error');
  const btn = $('#pdSubmit');
  btn.disabled = true;
  try {
    const plan = (payDlg.querySelector('input[name="pdPlan"]:checked') || {}).value;
    if (plan && plan !== (payOrder.plan || 'Anticipo y liquidación')) {
      await setPaymentPlan(session.token, payOrder.folio, plan);
      payOrder.plan = plan;
    }
    const res = await addPayment(session.token, {
      folio: payOrder.folio, monto, metodo: $('#pdMetodo').value, nota: clean($('#pdNota').value)
    });
    Object.assign(payOrder, { saldo: res.saldo, abonos: res.abonos, estatus: res.estatus });
    renderHistory();
    const folio = payOrder.folio;
    closePayDialog();
    toast(res.saldo > 0
      ? `Pago registrado en ${folio}. Por pagar: ${fmtMXN(res.saldo)}.`
      : `${folio} quedó pagada. Usa el botón ✓ para liberarla al entregar.`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

async function releaseOrder(o, btn) {
  session = getSession();
  if (!session) return promptLogin('Tu sesión venció. Vuelve a iniciar sesión.');
  btn.disabled = true;
  try {
    await completeOrder(session.token, o.folio);
    o.estatus = 'Completada';
    renderHistory();
    toast(`${o.folio} completada y liberada.`, 'ok');
  } catch (err) {
    btn.disabled = false;
    toast(err.message, 'error');
  }
}

function paintMonth(count) {
  if (!Number.isFinite(count)) return;
  $('#monthCount').textContent = `${count}`;
  $('#monthBar').style.width = `${Math.min(100, (count / MONTH_GOAL) * 100)}%`;
}

async function loadHistory() {
  const cached = (() => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null'); } catch (_) { return null; } })();
  renderPending();
  session = getSession();
  if (!session || !navigator.onLine) {
    historyCache = cached?.orders || [];
    renderHistory();
    const when = cached?.at ? new Date(cached.at) : null;
    $('#histEmpty').hidden = false;
    $('#histEmpty').textContent = !navigator.onLine
      ? `Sin conexión. ${when ? `Mostrando el historial guardado a las ${pad(when.getHours())}:${pad(when.getMinutes())}.` : 'El historial se carga al volver la señal.'}`
      : 'Inicia sesión para actualizar el historial.';
    if (historyCache.length) $('#histEmpty').classList.add('is-note');
    return;
  }
  $('#histEmpty').classList.remove('is-note');
  $('#histEmpty').hidden = false;
  $('#histEmpty').textContent = 'Cargando órdenes…';
  try {
    const res = await listOrders(session.token);
    historyCache = res.orders || [];
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify({ at: Date.now(), orders: historyCache })); } catch (_) { /* noop */ }
    paintMonth(res.monthCount);
    renderHistory();
  } catch (err) {
    historyCache = cached?.orders || [];
    renderHistory();
    $('#histEmpty').hidden = false;
    $('#histEmpty').textContent = isNetworkError(err)
      ? 'Sin conexión con la hoja. Se muestra el último historial guardado.'
      : `No se pudo cargar el historial: ${err.message}`;
    if (isAuthError(err)) promptLogin('Tu sesión venció. Inicia sesión para ver el historial.');
  }
}
$('#histSearch').addEventListener('input', renderHistory);
$('#histReload').addEventListener('click', loadHistory);

// ================= Conexión y sesión =================
function setConnStatus() {
  const el = $('#connStatus');
  const strip = $('#offlineStrip');
  const online = navigator.onLine;
  if (!API_URL) { el.textContent = 'Falta la URL de Apps Script'; el.dataset.state = 'warn'; }
  else if (!online) { el.textContent = 'Sin conexión · guardando en el teléfono'; el.dataset.state = 'warn'; }
  else if (!session) { el.textContent = 'Inicia sesión para enviar'; el.dataset.state = 'warn'; }
  else { el.textContent = 'Conectado a la hoja del taller'; el.dataset.state = 'ok'; }

  const inApp = !$('.shell').hidden;
  if (inApp && !online) {
    strip.hidden = false;
    strip.dataset.tone = 'offline';
    $('#offlineText').textContent = 'Sin conexión. Las órdenes se guardan en este teléfono y se envían solas al volver la señal.';
  } else if (inApp && online && !session) {
    strip.hidden = false;
    strip.dataset.tone = 'login';
    $('#offlineText').textContent = 'Hay señal. Inicia sesión para enviar las órdenes guardadas en el teléfono.';
  } else {
    strip.hidden = true;
  }
}
$('#offlineStrip').addEventListener('click', () => {
  if ($('#offlineStrip').dataset.tone === 'login') promptLogin('Inicia sesión para enviar las órdenes guardadas.');
});

function paintAvatar(el, s) {
  if (s?.picture) {
    const img = Object.assign(document.createElement('img'), { src: s.picture, alt: '', referrerPolicy: 'no-referrer' });
    el.replaceChildren(img);
  } else {
    el.textContent = (s?.name || 'Z E').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  }
}

function paintUser(s) {
  $('#userName').textContent = s?.name || 'Sin sesión';
  $('#userMail').textContent = s?.email || '';
  paintAvatar($('#userAvatar'), s);
  paintAvatar($('#topAvatar'), s);
}

let heroMounted = null;
function enterApp(user) {
  $('#login').hidden = true;
  $('.shell').hidden = false;
  $('#dock').hidden = false;
  paintUser(user);
  setConnStatus();
  updatePreview();
  requestAnimationFrame(checkTermsRead);
  if (!heroMounted) heroMounted = mountHero($('#hero3d'));
  renderPending();
}

function showApp(s) {
  session = s;
  offlineUser = null;
  enterApp(s);
  const vista = new URLSearchParams(location.search).get('vista');
  if (vista === 'historial') setView('historial');
  else if (API_URL) listOrders(s.token, 1).then((r) => paintMonth(r.monthCount)).catch(() => {});
  syncQueue();
}

function showOffline(user) {
  session = null;
  offlineUser = user;
  enterApp(user);
}

function showLogin(message = '') {
  session = null;
  offlineUser = null;
  $('#login').hidden = false;
  $('.shell').hidden = true;
  $('#dock').hidden = true;
  paintUser(null);
  const denied = $('#loginDenied');
  denied.textContent = message;
  denied.classList.toggle('is-hidden', !message);
  setConnStatus();
  renderGoogleButton();
}

/** Pide iniciar sesión sin perder lo capturado (el borrador y la cola quedan en el teléfono). */
function promptLogin(message) {
  saveDraftNow();
  showLogin(message);
}

$('#signOutBtn').addEventListener('click', async () => {
  const pend = await listPending().catch(() => []);
  if (pend.length && !confirm(`Hay ${pend.length} orden(es) sin enviar en este teléfono. Se conservarán y se enviarán cuando alguien inicie sesión. ¿Cerrar sesión?`)) return;
  signOut();
});

window.addEventListener('online', () => {
  setConnStatus();
  if (session) syncQueue();
  else if (offlineUser) {
    listPending().then((p) => { if (p.length) toast(`Hay señal. Inicia sesión para enviar ${p.length} orden(es) guardada(s).`, 'warn'); });
  }
});
window.addEventListener('offline', () => {
  setConnStatus();
  if (session === null && !offlineUser && !$('#login').hidden) {
    const known = getKnownUser();
    if (known) showOffline(known);
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncQueue(); });
setInterval(() => syncQueue(), 45000);

// ================= Mensajes =================
const toastEl = $('#toast');
let toastTimer = 0;
function toast(msg, tone = 'info') {
  toastEl.textContent = msg;
  toastEl.dataset.tone = tone;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 5200);
}

// ================= Cola de pendientes =================
const fmtTime = (ms) => { const d = new Date(ms); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

async function renderPending() {
  const items = await listPending().catch(() => []);
  const n = items.length;
  const chip = $('#pendChip');
  chip.hidden = n === 0;
  chip.classList.toggle('has-error', items.some((i) => i.error));
  $('#pendChipText').textContent = `${n} por enviar`;

  const card = $('#pendCard');
  card.hidden = n === 0;
  $('#pendNote').textContent = navigator.onLine
    ? (session ? 'Guardadas en este teléfono · se envían solas' : 'Inicia sesión para enviarlas')
    : 'Guardadas en este teléfono · esperando señal';
  $('#pendSync').hidden = !(navigator.onLine && session);
  $('#pendList').replaceChildren(...items.map((it) => {
    const li = document.createElement('li');
    li.className = 'pend-item' + (it.error ? ' has-error' : '');
    const main = document.createElement('div');
    main.className = 'pend-main';
    const name = Object.assign(document.createElement('span'), { className: 'td-main', textContent: `${it.order.nombre} · ${it.order.marca}` });
    const meta = Object.assign(document.createElement('span'), {
      className: 'td-sub',
      textContent: it.error ? `No se pudo enviar: ${it.error}` : `Capturada ${fmtTime(it.queuedAt)}${it.attempts ? ` · ${it.attempts} intento(s)` : ''}`
    });
    main.append(name, meta);
    li.append(main);
    if (it.error) {
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost pend-del', textContent: 'Descartar' });
      del.addEventListener('click', async () => {
        if (!confirm(`¿Descartar la orden de ${it.order.nombre}? Se borrará de este teléfono.`)) return;
        await removePending(it.clientId);
        renderPending();
      });
      li.append(del);
    }
    return li;
  }));
}
$('#pendChip').addEventListener('click', () => { setView('historial'); syncQueue(); });
$('#pendSync').addEventListener('click', () => syncQueue(true));

let syncing = false;
async function syncQueue(manual = false) {
  if (syncing || !API_URL) return;
  if (!navigator.onLine) { if (manual) toast('Sin conexión: las órdenes siguen guardadas en el teléfono.', 'warn'); return; }
  session = getSession();
  if (!session) {
    const pend = await listPending().catch(() => []);
    if (pend.length && manual) promptLogin(`Inicia sesión para enviar ${pend.length} orden(es) guardada(s).`);
    setConnStatus();
    return;
  }
  const items = await listPending().catch(() => []);
  if (!items.length) return;
  syncing = true;
  $('#pendChip').classList.add('is-syncing');
  const sent = [];
  try {
    for (const it of items) {
      try {
        const res = await createOrder(session.token, it.order);
        await removePending(it.clientId);
        sent.push(res.folio);
        if (Number.isFinite(res.monthCount)) paintMonth(res.monthCount);
      } catch (err) {
        if (isNetworkError(err)) break;
        if (isAuthError(err)) { promptLogin('Tu sesión venció. Inicia sesión para enviar las órdenes guardadas.'); break; }
        it.attempts += 1;
        it.error = err.message;
        await updatePending(it);
      }
    }
  } finally {
    syncing = false;
    $('#pendChip').classList.remove('is-syncing');
    await renderPending();
    setConnStatus();
  }
  if (sent.length) {
    toast(sent.length === 1 ? `Se envió la orden guardada · ${sent[0]}` : `Se enviaron ${sent.length} órdenes guardadas · ${sent.join(', ')}`, 'ok');
    if (!$('#view-historial').hidden) loadHistory();
  }
}

// ================= Envío =================
const MISSING = {
  cliente: 'nombre y teléfono de 10 dígitos',
  vehiculo: 'marca y modelo',
  servicio: 'descripción del servicio',
  encendido: 'si el vehículo está encendido',
  terminos: 'aceptar los términos',
  firma: 'firma del cliente'
};

async function saveOffline(order, reason) {
  await enqueue(order);
  requestPersistence();
  clearDraft();
  showSuccess({ ...order, folio: '' }, { offline: true });
  renderPending();
  setConnStatus();
  if (reason) toast(reason, 'warn');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = values();
  const { ok, checks } = validate(v);
  if (!ok) {
    toast(`Falta: ${Object.keys(checks).filter((k) => !checks[k]).map((k) => MISSING[k]).join(', ')}.`, 'warn');
    return;
  }
  if (!API_URL) return toast('Configura VITE_API_URL con la URL de la Web App de Apps Script.', 'error');

  const order = {
    clientId: newClientId(),
    termsVersion: TERMS_VERSION,
    capturadoEn: new Date().toISOString(),
    fecha: v.fecha,
    hora: v.hora,
    nombre: v.nombre,
    telefono: v.telefono,
    marca: v.marca,
    serie: v.serie,
    encendido: v.encendido === 'si' ? 'Sí' : 'No',
    servicio: v.servicio,
    caracteristicas: v.caracteristicas,
    presupuesto: v.presupuesto,
    anticipo: v.anticipo,
    total: v.total,
    saldo: Math.max(v.total - v.anticipo, 0),
    plan: v.plan,
    llaves: v.llaves,
    cargador: v.cargador,
    otros: v.otros,
    firmaPng: signature.toDataURL()
  };

  session = getSession();
  if (!navigator.onLine || !session) {
    return saveOffline(order, !navigator.onLine ? '' : 'Tu sesión venció: la orden quedó guardada en el teléfono. Inicia sesión para enviarla.');
  }

  submitBtn.disabled = true;
  submitBtn.classList.add('is-loading');
  submitLabel.textContent = 'Guardando orden…';
  try {
    const res = await createOrder(session.token, order);
    lastOrder = { ...order, folio: res.folio };
    clearDraft();
    showSuccess(lastOrder);
    if (Number.isFinite(res.monthCount)) paintMonth(res.monthCount);
  } catch (err) {
    if (isNetworkError(err)) {
      await saveOffline(order, 'Se perdió la señal: la orden quedó guardada en el teléfono y se enviará sola.');
    } else if (isAuthError(err)) {
      await saveOffline(order, 'Tu sesión venció: la orden quedó guardada en el teléfono. Inicia sesión para enviarla.');
    } else {
      toast(`No se pudo guardar: ${err.message}`, 'error');
      submitBtn.disabled = false;
      submitLabel.textContent = 'Enviar orden y guardar';
    }
  } finally {
    submitBtn.classList.remove('is-loading');
    updatePreview();
  }
});

// ================= Confirmación =================
const overlay = $('#success');
function showSuccess(o, { offline = false } = {}) {
  $('#okTitle').textContent = offline ? 'Orden guardada en el teléfono' : 'Orden registrada';
  $('#okFolio').textContent = offline ? 'Folio pendiente' : o.folio;
  $('#okOffline').hidden = !offline;
  $('.success-text', overlay).hidden = offline;
  $('#okWa').hidden = offline;
  $('.success-mark', overlay).classList.toggle('is-pending', offline);

  if (!offline) {
    const msg = `Hola ${o.nombre}, Z e-Scooters México registró tu orden ${o.folio} para ${o.marca}. `
      + `Servicio: ${o.servicio}. Costo: ${fmtMXN(o.total)}; anticipo: ${fmtMXN(o.anticipo)}; total a pagar: ${fmtMXN(o.saldo)}. `
      + 'Te avisaremos por este medio cuando tu vehículo esté listo. Consultas: 55 6501 8583.';
    $('#okWa').href = waLink(o.telefono, msg);
  }

  // Cobro del anticipo: Mercado Pago (VITE_PAYMENTS_ENABLED) y pago a plazos con Aplazo (VITE_APLAZO_ENABLED).
  const canCharge = !offline && o.anticipo > 0;
  const showMp = PAYMENTS_ENABLED && canCharge;
  const showAplazo = APLAZO_ENABLED && canCharge && o.anticipo >= 100;
  $('#payBlock').hidden = !(showMp || showAplazo);
  $('#payMp').hidden = !showMp;
  $('#payAplazo').hidden = !showAplazo;
  $('#payLink').hidden = true;
  $('#payBtn').hidden = false;
  $('#bnplLink').hidden = true;
  $('#bnplBtn').hidden = false;
  $('#payAmount').textContent = fmtMXN(o.anticipo);

  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  $('#newBtn').focus();
}

$('#payBtn').addEventListener('click', async () => {
  if (!lastOrder) return;
  session = getSession();
  if (!session) return promptLogin('Tu sesión venció. Vuelve a iniciar sesión.');
  const btn = $('#payBtn');
  btn.disabled = true;
  btn.textContent = 'Generando link…';
  try {
    const { init_point: url } = await createPaymentLink(session.token, {
      folio: lastOrder.folio,
      amount: lastOrder.anticipo,
      nombre: lastOrder.nombre,
      telefono: lastOrder.telefono,
      concepto: `Anticipo orden ${lastOrder.folio} · ${lastOrder.marca}`
    });
    $('#payUrl').value = url;
    $('#payWa').href = waLink(lastOrder.telefono, `Hola ${lastOrder.nombre}, este es el link para pagar el anticipo de ${fmtMXN(lastOrder.anticipo)} de tu orden ${lastOrder.folio}: ${url}`);
    $('#payLink').hidden = false;
    btn.hidden = true;
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generar link de pago del anticipo';
  }
});

$('#payCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#payUrl').value);
    toast('Link copiado.', 'ok');
  } catch (_) {
    $('#payUrl').select();
  }
});

// ----- Pago a plazos con Aplazo -----
$('#bnplBtn').addEventListener('click', async () => {
  if (!lastOrder) return;
  session = getSession();
  if (!session) return promptLogin('Tu sesión venció. Vuelve a iniciar sesión.');
  const btn = $('#bnplBtn');
  btn.disabled = true;
  btn.textContent = 'Generando link…';
  try {
    const { url, reused } = await createAplazoLink(session.token, {
      folio: lastOrder.folio,
      amount: lastOrder.anticipo,
      nombre: lastOrder.nombre,
      telefono: lastOrder.telefono,
      concepto: `Anticipo orden ${lastOrder.folio} · ${lastOrder.marca}`
    });
    $('#bnplUrl').value = url;
    $('#bnplWa').href = waLink(lastOrder.telefono, `Hola ${lastOrder.nombre}, ¿no tienes tarjeta de crédito? Puedes pagar el anticipo de ${fmtMXN(lastOrder.anticipo)} de tu orden ${lastOrder.folio} a plazos con Aplazo aquí: ${url}`);
    $('#bnplLink').hidden = false;
    btn.hidden = true;
    if (reused) toast('Este folio ya tenía un link de Aplazo vigente; se reutilizó.', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generar link de pago a plazos';
  }
});

$('#bnplCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#bnplUrl').value);
    toast('Link copiado.', 'ok');
  } catch (_) {
    $('#bnplUrl').select();
  }
});

$('#bnplCancel').addEventListener('click', async () => {
  if (!lastOrder) return;
  session = getSession();
  if (!session) return promptLogin('Tu sesión venció. Vuelve a iniciar sesión.');
  try {
    await cancelAplazoLink(session.token, lastOrder.folio);
    $('#bnplLink').hidden = true;
    $('#bnplBtn').hidden = false;
    toast('Link de Aplazo cancelado.', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#newBtn').addEventListener('click', () => {
  overlay.classList.remove('is-in');
  overlay.hidden = true;
  resetForm();
});

function setNowDefaults() {
  const now = new Date();
  $('#fecha').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  $('#hora').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function resetForm() {
  form.reset();
  const planDefault = form.querySelector('input[name="plan"][value="Anticipo y liquidación"]');
  if (planDefault) planDefault.checked = true;
  signature.clear();
  acepta.disabled = true;
  acepta.checked = false;
  termsRead = false;
  termsBox.scrollTop = 0;
  clearDraft();
  setNowDefaults();
  checkTermsRead();
  updatePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ================= Arranque =================
initPWA();
renderTerms();
setNowDefaults();
restoreDraft();
updatePreview();
window.addEventListener('resize', checkTermsRead);

initAuth({
  clientId: GOOGLE_CLIENT_ID,
  buttonEl: $('#googleBtn'),
  onSignedIn: showApp,
  onOffline: showOffline,
  onSignedOut: () => showLogin(),
  onExpired: () => {
    // No se interrumpe la captura: lo que se envíe sin sesión queda en la cola del teléfono.
    session = null;
    offlineUser = getKnownUser();
    setConnStatus();
    renderPending();
  },
  onError: (msg) => showLogin(msg)
});
