import './style.css';
import { TERMS, TERMS_CLOSING, TERMS_PARTIES, TERMS_TITLE, TERMS_VERSION } from './terms.js';
import { mountHero } from './hero3d.js';
import { mountSignature } from './signature.js';
import { initAuth, getSession, getKnownUser, signOut, renderGoogleButton } from './auth.js';
import { enqueue, listPending, removePending, updatePending, newClientId, requestPersistence, isNetworkError, isAuthError } from './queue.js';
import { mountPhotos } from './photos.js';
import { renderTag, printTag } from './tag.js';
import { renderNote, noteToPdf, canvasToBlob, shareNote, noteFileName } from './note.js';
import { API_URL, PAYMENTS_ENABLED, APLAZO_ENABLED, uploadPhoto, getOrderDetail, updateOrder, createOrder, listOrders, addPayment, setPaymentPlan, completeOrder, deleteOrder, createPaymentLink, createAplazoLink, cancelAplazoLink, sendNoteWhatsApp } from './api.js';
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
// Envío de la orden: una sola vez por captura.
//  - submitting: hay un envío en curso (guardar con firma y fotos tarda 10-15 s); se ignoran más toques.
//  - savedCaptureId: la captura actual ya quedó registrada; no se vuelve a enviar hasta «Capturar otra orden».
//  - captureId: ID de captura estable para todos los intentos de la misma orden, así el servidor
//    devuelve el folio existente si llega un reintento.
let submitting = false;
let savedCaptureId = '';
let captureId = '';
let historyCache = [];
let isAdmin = false;

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

// ================= Fotos del vehículo =================
const photos = mountPhotos($('#fotos'), {
  onChange: () => updatePreview(),
  onError: (msg) => toast(msg, 'error')
});

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
    // El costo presupuesto es solo informativo. Total a pagar = anticipo + IVA 16 % si requiere factura.
    factura: (form.querySelector('input[name="factura"]:checked') || {}).value === 'Sí' ? 'Sí' : 'No',
    ...cobro(num($('#anticipo').value), (form.querySelector('input[name="factura"]:checked') || {}).value === 'Sí'),
    plan: (form.querySelector('input[name="plan"]:checked') || {}).value || 'Anticipo y liquidación',
    aceptaTerminos: acepta.checked,
    firma: signature.hasInk()
  };
}

function validate(v) {
  const checks = {
    fotos: Boolean(photos && photos.main()),
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
  const main = photos && photos.main();
  $('#pvPhoto').hidden = !main;
  if (main && $('#pvPhoto img').src !== main.dataUrl) $('#pvPhoto img').src = main.dataUrl;
  $('#pvPhotoN').textContent = photos && photos.count() > 1 ? `${photos.count()} fotos` : '';
  const saldo = v.total;
  $('#saldo').value = saldo.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  $('#pvNombre').textContent = v.nombre || 'Nombre del cliente';
  $('#pvTel').textContent = v.telefono ? formatPhone(v.telefono) : 'Teléfono pendiente';
  $('#pvMarca').textContent = v.marca || 'Marca y modelo';
  $('#pvSerie').textContent = v.serie ? `Serie ${v.serie}` : 'Sin número de serie';
  $('#pvServicio').textContent = v.servicio || 'Describe el servicio solicitado.';
  $('#pvPresup').textContent = fmtMXN(v.presupuesto);
  $('#pvAnticipo').textContent = fmtMXN(v.anticipo);
  $('#pvSaldo').textContent = fmtMXN(saldo);
  $('#pvIvaRow').hidden = v.factura !== 'Sí';
  $('#pvIva').textContent = fmtMXN(v.iva);
  $('#totalHint').textContent = v.factura === 'Sí' ? 'anticipo + IVA 16 %' : 'anticipo';
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
  $('#halfBtn').classList.toggle('is-hidden', !(bat && v.presupuesto > 0));

  $$('.checklist li').forEach((li) => li.classList.toggle('is-done', Boolean(checks[li.dataset.check])));
  const overpaid = false;
  const locked = submitting || Boolean(savedCaptureId);
  submitBtn.disabled = !ok || overpaid || locked;
  submitLabel.textContent = submitting ? 'Guardando orden…' : savedCaptureId ? 'Orden registrada' : overpaid ? 'El anticipo supera el costo' : ok ? 'Enviar orden y guardar' : 'Completa la orden para enviar';

  const done = Object.values(checks).filter(Boolean).length;
  const dockCta = $('#dockCta');
  dockCta.disabled = !ok || overpaid || locked;
  dockCta.classList.toggle('is-ready', ok && !overpaid && !locked);
  $('#dockProgress').textContent = `${done}/${Object.keys(checks).length}`;
  $('#dockLabel').textContent = submitting ? 'Guardando…' : savedCaptureId ? 'Orden registrada' : overpaid ? 'Anticipo mayor al costo' : ok ? 'Enviar orden' : 'Completa la orden';
}

// ================= Borrador automático =================
const DRAFT_FIELDS = ['nombre', 'telefono', 'marca', 'serie', 'servicio', 'caracteristicas', 'llaves', 'cargador', 'otros', 'presupuesto', 'anticipo'];

function cobro(anticipo, factura) {
  const a = Math.round(Math.max(anticipo, 0) * 100) / 100;
  const iva = factura ? Math.round(a * 16) / 100 : 0;
  return { iva, total: Math.round((a + iva) * 100) / 100 };
}
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
  const empty0 = Object.values(data).every((x) => !x);
  data.factura = (form.querySelector('input[name="factura"]:checked') || {}).value === 'Sí' ? 'Sí' : '';
  const empty = empty0 && !data.factura;
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
    if (data.factura === 'Sí') {
      const f = form.querySelector('input[name="factura"][value="Sí"]');
      if (f) f.checked = true;
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
  pagado: 'Anticipo pagado', pagada: 'Pagada', completada: 'Concluido y entregado'
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
const ICON_RCPT = svg('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>');
const ICON_DEL = svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>');
const ICON_NOTE = svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>');
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
    if (o.fotoId) {
      const a = Object.assign(document.createElement('a'), { className: 'td-thumb', href: o.fotosUrl || '#', target: '_blank', rel: 'noopener', title: `Ver ${o.fotos || 1} foto(s)` });
      const img = Object.assign(document.createElement('img'), { src: `https://drive.google.com/thumbnail?id=${encodeURIComponent(o.fotoId)}&sz=w240`, alt: `Foto de ${o.marca}`, loading: 'lazy', referrerPolicy: 'no-referrer' });
      img.addEventListener('error', () => a.remove());
      a.append(img);
      if (o.fotos > 1) a.append(Object.assign(document.createElement('span'), { className: 'mono', textContent: `${o.fotos}` }));
      tds[2].prepend(a);
      tds[2].classList.add('has-thumb');
    }
    tds[3].textContent = fmtMXN(o.total);
    tds[4].textContent = fmtMXN(o.saldo);
    tds[5].firstElementChild.textContent = STATUS[key];
    const actions = tds[6].firstElementChild;
    {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn is-note', title: 'Nota de servicio' });
      b.innerHTML = ICON_NOTE;
      b.setAttribute('aria-label', `Nota de servicio de la orden ${o.folio}`);
      b.addEventListener('click', () => openNoteForFolio(o.folio));
      actions.append(b);
    }
    tds[0].classList.add('is-link');
    tds[0].addEventListener('click', () => openNoteForFolio(o.folio));
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
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn is-go', title: 'Concluir y entregar' });
      b.innerHTML = ICON_DONE;
      b.setAttribute('aria-label', `Concluir y entregar la orden ${o.folio}`);
      b.addEventListener('click', () => openDoneDialog(o));
      actions.append(b);
    }
    if (isClosed(o)) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn', title: 'Comprobante de entrega' });
      b.innerHTML = ICON_RCPT;
      b.setAttribute('aria-label', `Comprobante de entrega de la orden ${o.folio}`);
      b.addEventListener('click', () => openDoneDialog(o));
      actions.append(b);
    }
    if (isAdmin) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn is-danger', title: 'Eliminar orden (administrador)' });
      b.innerHTML = ICON_DEL;
      b.setAttribute('aria-label', `Eliminar la orden ${o.folio}`);
      b.addEventListener('click', () => openDeleteDialog(o));
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
      : `${folio} quedó pagada. Usa el botón ✓ para concluir y entregar.`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ----- Servicio concluido y entregado: comprobante digital -----
const doneDlg = $('#doneDlg');
let doneOrder = null;

function deliveryMessage(o, url) {
  const nombre = String(o.cliente || '').trim().split(/\s+/)[0] || 'cliente';
  return `Estimado(a) ${nombre}:\n\n`
    + `Le confirmamos que el servicio de su *${o.marca}* fue *concluido y entregado*.\n\n`
    + `*Folio:* ${o.folio}\n`
    + `*Total:* ${fmtMXN(o.total)} · pagado en su totalidad\n`
    + `*Entrega:* ${o.entregada || new Date().toLocaleDateString('es-MX')}\n\n`
    + `Su comprobante digital de entrega está disponible aquí:\n${url}\n\n`
    + `Gracias por confiar su vehículo a *Z e-Scooters México*. Quedamos a sus órdenes en este mismo número.`;
}

function showDelivered(o, url) {
  $('#doneTitle').textContent = 'Servicio concluido y entregado';
  $('#dnText').textContent = 'Envía al cliente el comprobante digital con el mismo folio de la orden.';
  $('#dnConfirm').hidden = true;
  const link = o.receiptUrl || url;
  $('#dnPdf').href = link;
  $('#dnPdf').hidden = !link;
  const tel = digits(o.telefono);
  $('#dnWa').hidden = tel.length !== 10;
  if (tel.length === 10) $('#dnWa').href = waLink(tel, deliveryMessage(o, link));
  $('#dnClose').textContent = 'Cerrar';
}

function openDoneDialog(o) {
  doneOrder = o;
  $('#dnFolio').textContent = `${o.folio} · ${o.cliente}`;
  $('#dnTotal').textContent = fmtMXN(o.total);
  $('#dnPaid').textContent = fmtMXN(o.total);
  $('#doneTitle').textContent = 'Concluir y entregar';
  $('#dnText').textContent = 'El servicio quedará como concluido y entregado, y se generará el comprobante digital con este folio.';
  $('#dnConfirm').hidden = false;
  $('#dnConfirm').disabled = false;
  $('.cta-label', $('#dnConfirm')).textContent = isClosed(o) ? 'Obtener comprobante' : 'Confirmar entrega';
  $('#dnWa').hidden = true;
  $('#dnPdf').hidden = true;
  $('#dnClose').textContent = 'Cancelar';
  if (isClosed(o) && (o.receiptUrl || o.comprobanteUrl)) showDelivered(o, o.comprobanteUrl);
  doneDlg.hidden = false;
  requestAnimationFrame(() => doneDlg.classList.add('is-in'));
}

function closeDoneDialog() {
  doneDlg.classList.remove('is-in');
  doneDlg.hidden = true;
  doneOrder = null;
}
$('#dnClose').addEventListener('click', closeDoneDialog);
doneDlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDoneDialog(); });

$('#dnConfirm').addEventListener('click', async () => {
  if (!doneOrder) return;
  session = getSession();
  if (!session) return promptLogin('Tu sesión venció. Vuelve a iniciar sesión.');
  const btn = $('#dnConfirm');
  btn.disabled = true;
  $('.cta-label', btn).textContent = 'Generando comprobante…';
  try {
    const res = await completeOrder(session.token, doneOrder.folio);
    Object.assign(doneOrder, {
      estatus: 'Completada', comprobanteUrl: res.comprobanteUrl, receiptUrl: res.receiptUrl || '',
      entregada: res.entregada || doneOrder.entregada
    });
    renderHistory();
    showDelivered(doneOrder, res.comprobanteUrl);
  } catch (err) {
    btn.disabled = false;
    $('.cta-label', btn).textContent = 'Confirmar entrega';
    toast(err.message, 'error');
  }
});

// ----- Eliminar orden (solo administradores; el servidor vuelve a verificarlo) -----
const delDlg = $('#delDlg');
let delOrder = null;

function openDeleteDialog(o) {
  delOrder = o;
  $('#delFolio').textContent = o.folio;
  $('#delInfo').textContent = `${o.cliente} · ${o.marca} · costo ${fmtMXN(o.total)}`;
  $('#delMotivo').value = '';
  delDlg.hidden = false;
  requestAnimationFrame(() => delDlg.classList.add('is-in'));
  $('#delMotivo').focus();
}

function closeDeleteDialog() {
  delDlg.classList.remove('is-in');
  delDlg.hidden = true;
  delOrder = null;
}
$('#delCancel').addEventListener('click', closeDeleteDialog);
delDlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDeleteDialog(); });

$('#delForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!delOrder) return;
  const motivo = clean($('#delMotivo').value);
  if (motivo.length < 3) return toast('Escribe el motivo de la eliminación.', 'error');
  session = getSession();
  if (!session) return promptLogin('Tu sesión venció. Vuelve a iniciar sesión.');
  const btn = $('#delSubmit');
  btn.disabled = true;
  try {
    const res = await deleteOrder(session.token, delOrder.folio, motivo);
    const folio = delOrder.folio;
    historyCache = historyCache.filter((x) => x.folio !== folio);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify({ at: Date.now(), orders: historyCache })); } catch (_) { /* noop */ }
    if (Number.isFinite(res.monthCount)) paintMonth(res.monthCount);
    renderHistory();
    closeDeleteDialog();
    toast(`${folio} eliminada y archivada en «Órdenes eliminadas».`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

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
    isAdmin = res.isAdmin === true;
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
  restoreSuccess();
}

function showApp(s) {
  session = s;
  offlineUser = null;
  enterApp(s);
  const params = new URLSearchParams(location.search);
  const vista = params.get('vista');
  const folioQr = params.get('folio');
  if (folioQr && /^(?:ZPEV-\d{2}-\d{4,}|ZE-(?:\d{8}-)?\d{4,})$/.test(folioQr)) {
    // QR de la etiqueta: abre el Historial con la nota de esa orden.
    history.replaceState(null, '', location.pathname);
    setView('historial');
    openNoteForFolio(folioQr);
  } else if (vista === 'historial') setView('historial');
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
      textContent: it.error
        ? `No se pudo enviar: ${it.error}`
        : it.order._folio
          ? `${it.order._folio} registrada · faltan ${(it.order.fotos || []).length - (it.order._sent || []).length} foto(s)`
          : `Capturada ${fmtTime(it.queuedAt)}${(it.order.fotos?.length || 0) + (it.order.fotoPrincipal ? 1 : 0) ? ` · ${(it.order.fotos?.length || 0) + (it.order.fotoPrincipal ? 1 : 0)} fotos` : ''}${it.attempts ? ` · ${it.attempts} intento(s)` : ''}`
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
        const res = await deliverOrder(session.token, it.order, () => updatePending(it));
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
  firma: 'firma del cliente',
  fotos: 'foto de la vista completa'
};

/**
 * Envía una orden y luego sus fotos, una por una. El avance (folio y fotos enviadas) queda en la
 * propia orden; persist() lo guarda en la cola para reanudar sin repetir nada si se cae la señal.
 */
async function deliverOrder(token, order, persist = async () => {}) {
  let res = null;
  if (!order._folio) {
    res = await createOrder(token, order);
    order._folio = res.folio;
    order._sent = res.skipPhotos ? (order.fotos || []).map((p) => p.slot) : (order._sent || []);
    await persist();
  }
  for (const ph of order.fotos || []) {
    if ((order._sent || []).includes(ph.slot)) continue;
    await uploadPhoto(token, { folio: order._folio, clientId: order.clientId, slot: ph.slot, label: ph.label, dataUrl: ph.dataUrl });
    order._sent = [...(order._sent || []), ph.slot];
    await persist();
  }
  return { folio: order._folio, monthCount: res?.monthCount };
}

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
  if (submitting) return;
  if (savedCaptureId) {
    toast('Esta orden ya quedó registrada. Pulsa «Capturar otra orden» para una nueva.', 'warn');
    return;
  }
  const v = values();
  const { ok, checks } = validate(v);
  if (!ok) {
    toast(`Falta: ${Object.keys(checks).filter((k) => !checks[k]).map((k) => MISSING[k]).join(', ')}.`, 'warn');
    return;
  }
  if (!API_URL) return toast('Configura VITE_API_URL con la URL de la Web App de Apps Script.', 'error');

  setNowDefaults();
  v.fecha = $('#fecha').value;
  v.hora = $('#hora').value;
  if (!captureId) captureId = newClientId();
  const order = {
    clientId: captureId,
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
    saldo: v.total,
    factura: v.factura,
    iva: v.iva,
    plan: v.plan,
    llaves: v.llaves,
    cargador: v.cargador,
    otros: v.otros,
    firmaPng: signature.toDataURL(),
    fotoPrincipal: photos.main()?.dataUrl || '',
    fotos: photos.list().filter((p) => p.slot !== 'vista')
  };

  session = getSession();
  if (!navigator.onLine || !session) {
    savedCaptureId = captureId;
    return saveOffline(order, !navigator.onLine ? '' : 'Tu sesión venció: la orden quedó guardada en el teléfono. Inicia sesión para enviarla.');
  }

  submitting = true;
  submitBtn.classList.add('is-loading');
  updatePreview();
  try {
    submitLabel.textContent = order.fotos.length ? `Guardando orden y ${order.fotos.length + 1} fotos…` : 'Guardando orden…';
    const res = await deliverOrder(session.token, order);
    savedCaptureId = captureId;
    lastOrder = { ...order, folio: res.folio };
    clearDraft();
    showSuccess(lastOrder);
    if (Number.isFinite(res.monthCount)) paintMonth(res.monthCount);
  } catch (err) {
    if (order._folio && (isNetworkError(err) || isAuthError(err))) {
      // La orden ya tiene folio; solo faltan fotos. Se terminan de subir desde la cola.
      savedCaptureId = captureId;
      await enqueue(order);
      requestPersistence();
      lastOrder = { ...order, folio: order._folio };
      clearDraft();
      showSuccess(lastOrder);
      renderPending();
      toast('Orden registrada. Algunas fotos se terminarán de subir al volver la señal.', 'warn');
    } else if (isNetworkError(err)) {
      savedCaptureId = captureId;
      await saveOffline(order, 'Se perdió la señal: la orden quedó guardada en el teléfono y se enviará sola.');
    } else if (isAuthError(err)) {
      savedCaptureId = captureId;
      await saveOffline(order, 'Tu sesión venció: la orden quedó guardada en el teléfono. Inicia sesión para enviarla.');
    } else {
      // Error del servidor: se puede reintentar; el mismo captureId evita duplicar si sí se guardó.
      toast(`No se pudo guardar: ${err.message}`, 'error');
    }
  } finally {
    submitting = false;
    submitBtn.classList.remove('is-loading');
    updatePreview();
  }
});

// ================= Nota de servicio =================
let noteSource = null; // datos de la última orden registrada (con foto y firma locales)
let noteCurrent = null; // { data, canvas }

function noteDataFromOrder(o) {
  return {
    folio: o.folio, fecha: o.fecha, hora: o.hora, nombre: o.nombre, telefono: o.telefono,
    marca: o.marca, serie: o.serie, encendido: o.encendido, servicio: o.servicio,
    caracteristicas: o.caracteristicas, llaves: o.llaves, cargador: o.cargador, otros: o.otros,
    presupuesto: o.presupuesto, anticipo: o.anticipo, iva: o.iva, factura: o.factura, total: o.total, saldo: o.saldo ?? o.total,
    fotos: (o.fotos?.length || 0) + (o.fotoPrincipal ? 1 : 0),
    fotoUrl: o.fotoPrincipal || '', firmaUrl: o.firmaPng || ''
  };
}

const noteView = $('#noteView');
function setNoteButtons(on) { ['#noteShare', '#notePdf', '#notePng', '#noteTag', '#noteEdit'].forEach((id) => { $(id).disabled = !on; }); }

function openNoteShell(title) {
  $('#noteTitle').textContent = title;
  $('#noteBody').replaceChildren(Object.assign(document.createElement('p'), { className: 'note-loading', textContent: 'Preparando la nota…' }));
  $('#notePhotos').hidden = true;
  setNoteButtons(false);
  noteView.hidden = false;
  requestAnimationFrame(() => noteView.classList.add('is-in'));
}

async function showNote(data) {
  noteCurrent = null;
  const canvas = await renderNote(data);
  noteCurrent = { data, canvas };
  const img = Object.assign(document.createElement('img'), { src: canvas.toDataURL('image/png'), alt: `Nota de servicio ${data.folio}` });
  $('#noteBody').replaceChildren(img);
  $('#noteTitle').textContent = data.folio;
  $('#noteEdit').hidden = !data.estatus || data.estatus === 'Completada';
  if (data.fotosUrl) { $('#notePhotos').href = data.fotosUrl; $('#notePhotos').hidden = false; }
  setNoteButtons(true);
}

async function openNote(data) {
  openNoteShell(data.folio);
  try { await showNote(data); } catch (err) { $('#noteBody .note-loading').textContent = `No se pudo generar la nota: ${err.message}`; }
}

async function openNoteForFolio(folio) {
  openNoteShell(folio);
  session = getSession();
  if (!navigator.onLine || !session) {
    $('#noteBody .note-loading').textContent = !navigator.onLine
      ? 'Sin conexión: la nota se genera con los datos de la hoja. Inténtalo al volver la señal.'
      : 'Inicia sesión para ver la nota.';
    return;
  }
  try {
    const { order } = await getOrderDetail(session.token, folio);
    await showNote(order);
  } catch (err) {
    const el = $('#noteBody .note-loading');
    if (el) el.textContent = `No se pudo cargar la nota: ${err.message}`;
  }
}

// ----- Editar la orden desde su ficha -----
const EDIT_FIELDS = [
  ['nombre', 'Cliente', 'text'], ['telefono', 'Teléfono', 'tel'], ['marca', 'Marca y modelo', 'text'],
  ['serie', 'N° de serie', 'text'], ['encendido', 'Encendido', 'yesno'], ['servicio', 'Servicio solicitado', 'area'],
  ['caracteristicas', 'Estado al recibir', 'area'], ['llaves', 'Llaves o NFC', 'text'], ['cargador', 'Cargador', 'text'],
  ['otros', 'Otros accesorios', 'text'], ['presupuesto', 'Costo presupuesto (informativo)', 'money'],
  ['anticipo', 'Anticipo', 'money'], ['factura', '¿Requiere factura? (+16 % IVA)', 'yesno']
];

function openEdit() {
  if (!noteCurrent) return;
  const d = noteCurrent.data;
  const form = document.createElement('form');
  form.className = 'edit-form';
  form.noValidate = true;
  const yes = (v) => v === 'Sí' || v === 'si' || v === true;
  EDIT_FIELDS.forEach(([k, label, type]) => {
    const wrap = document.createElement('label');
    wrap.className = `ef ef-${type}`;
    wrap.append(Object.assign(document.createElement('span'), { textContent: label }));
    let input;
    if (type === 'area') input = Object.assign(document.createElement('textarea'), { rows: 2, value: d[k] || '' });
    else if (type === 'yesno') {
      input = document.createElement('select');
      ['No', 'Sí'].forEach((o) => input.append(new Option(o, o, false, yes(d[k]) ? o === 'Sí' : o === 'No')));
    } else {
      input = Object.assign(document.createElement('input'), {
        type: type === 'money' ? 'number' : type === 'tel' ? 'tel' : 'text',
        value: type === 'money' ? (Number(d[k]) || 0).toFixed(2) : (d[k] || '')
      });
      if (type === 'money') { input.min = '0'; input.step = '0.01'; input.inputMode = 'decimal'; }
      if (type === 'tel') { input.inputMode = 'numeric'; input.maxLength = 10; }
    }
    input.name = k;
    input.className = 'input' + (type === 'money' || type === 'tel' ? ' mono' : '');
    wrap.append(input);
    form.append(wrap);
  });
  const total = Object.assign(document.createElement('p'), { className: 'ef-total mono' });
  const calc = () => {
    const a = Math.max(num(form.anticipo.value), 0);
    const iva = form.factura.value === 'Sí' ? Math.round(a * 16) / 100 : 0;
    total.textContent = `Total a pagar: ${fmtMXN(a + iva)}${iva ? ` (incluye IVA ${fmtMXN(iva)})` : ''}`;
  };
  form.addEventListener('input', calc);
  calc();
  form.append(total, Object.assign(document.createElement('p'), {
    className: 'ef-hint',
    textContent: 'Folio, fecha, hora, firma y fotos no cambian. Cada corrección queda registrada en la hoja «Cambios».'
  }));
  const bar = document.createElement('div');
  bar.className = 'ef-bar';
  const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: 'Regresar' });
  const save = Object.assign(document.createElement('button'), { type: 'submit', className: 'note-share', textContent: 'Guardar cambios' });
  bar.append(cancel, save);
  form.append(bar);
  cancel.addEventListener('click', () => { noteView.classList.remove('is-editing'); $('#noteBody').replaceChildren(Object.assign(document.createElement('img'), { src: noteCurrent.canvas.toDataURL('image/png'), alt: `Nota ${d.folio}` })); setNoteButtons(true); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const changes = {};
    EDIT_FIELDS.forEach(([k, , type]) => {
      let v = form[k].value;
      if (type === 'tel') v = digits(v);
      if (type === 'money') v = num(v);
      const old = type === 'money' ? num(d[k]) : type === 'yesno' ? (yes(d[k]) ? 'Sí' : 'No') : String(d[k] ?? '');
      if (String(v).trim() !== String(old).trim()) changes[k] = typeof v === 'string' ? v.trim() : v;
    });
    if (!Object.keys(changes).length) { cancel.click(); return; }
    if ('telefono' in changes && changes.telefono.length !== 10) { toast('El teléfono debe tener 10 dígitos.', 'error'); return; }
    session = getSession();
    if (!navigator.onLine || !session) { toast(!navigator.onLine ? 'Sin conexión: no se puede guardar.' : 'Inicia sesión para guardar.', 'error'); return; }
    save.disabled = true;
    save.textContent = 'Guardando…';
    try {
      const res = await updateOrder(session.token, d.folio, changes);
      toast(res.changed ? `Orden ${d.folio} actualizada (${res.changed} ${res.changed === 1 ? 'cambio' : 'cambios'}).` : 'Sin cambios.', 'ok');
      noteView.classList.remove('is-editing');
      await openNoteForFolio(d.folio);
      loadHistory();
    } catch (err) {
      toast(`No se pudo guardar: ${err.message}`, 'error');
      save.disabled = false;
      save.textContent = 'Guardar cambios';
    }
  });
  $('#noteBody').replaceChildren(form);
  noteView.classList.add('is-editing');
  setNoteButtons(false);
  form.nombre.focus();
}
$('#noteEdit').addEventListener('click', openEdit);

function closeNote() { noteView.classList.remove('is-in', 'is-editing'); noteView.hidden = true; }
$('#noteClose').addEventListener('click', closeNote);
noteView.addEventListener('click', (e) => { if (e.target === noteView) closeNote(); });

const noteText = (d) => `Nota de servicio ${d.folio} · Z e-Scooters México. Consultas: 55 6501 8583.`;

async function sendNote(kind = 'png') {
  if (!noteCurrent) return;
  const { data, canvas } = noteCurrent;
  try {
    // El PNG ya viene preparado: navigator.share se llama dentro del mismo toque del usuario.
    const blob = kind === 'pdf' ? await noteToPdf(canvas, data) : (noteCurrent.png || await canvasToBlob(canvas, 'image/png'));
    const r = await shareNote(blob, noteFileName(data, kind), noteText(data));
    if (r === 'downloaded') toast(kind === 'pdf' ? 'PDF descargado. Adjúntalo en WhatsApp o correo.' : 'Imagen descargada. Adjúntala en WhatsApp.', 'ok');
  } catch (err) {
    toast(`No se pudo preparar la nota: ${err.message}`, 'error');
  }
}
// Envío automático: la app genera el PDF de la nota y el backend lo manda por la API de WhatsApp
// directamente al teléfono de la orden (sin elegir contacto ni pulsar Enviar).
const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function sendNoteAuto(btn, data, canvas) {
  session = getSession();
  if (!navigator.onLine || !session) {
    toast(!navigator.onLine ? 'Sin conexión: no se puede enviar la nota.' : 'Tu sesión venció. Inicia sesión y vuelve a enviar.', 'error');
    return false;
  }
  const prev = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-busy');
  try {
    btn.lastChild.textContent = ' Enviando…';
    const pdf = await noteToPdf(canvas, data);
    const r = await sendNoteWhatsApp(session.token, {
      folio: data.folio, telefono: data.telefono, nombre: data.nombre, total: fmtMXN(data.total),
      fileName: noteFileName(data, 'pdf'), dataUrl: await blobToDataUrl(pdf), mensaje: noteWaMsg(data)
    });
    toast(`Nota enviada por WhatsApp al ${formatPhone(r.to || digits(data.telefono))}.`, 'ok');
    return true;
  } catch (err) {
    toast(`No se pudo enviar la nota por WhatsApp: ${err.message}`, 'error');
    return false;
  } finally {
    btn.innerHTML = prev;
    btn.disabled = false;
    btn.classList.remove('is-busy');
  }
}

const noteWaMsg = (d) => `Hola ${d.nombre || ''}, te compartimos la nota de servicio ${d.folio} de Z e-Scooters México`
  + `${d.marca ? ` (${d.marca})` : ''}. Total a pagar: ${fmtMXN(d.total)}. Consultas: 55 6501 8583.`;



$('#noteShare').addEventListener('click', () => {
  if (!noteCurrent) return;
  const { data, canvas } = noteCurrent;
  if (digits(data.telefono).length !== 10) return sendNote('png');
  sendNoteAuto($('#noteShare'), data, canvas);
});
$('#notePng').addEventListener('click', async () => {
  if (!noteCurrent) return;
  const blob = await canvasToBlob(noteCurrent.canvas, 'image/png');
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: noteFileName(noteCurrent.data, 'png') });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
});
$('#notePdf').addEventListener('click', () => sendNote('pdf'));

async function printOrderTag(data) {
  try {
    printTag(await renderTag(data), data.folio);
  } catch (err) {
    toast(`No se pudo preparar la etiqueta: ${err.message}`, 'error');
  }
}
$('#noteTag').addEventListener('click', () => noteCurrent && printOrderTag(noteCurrent.data));
$('#okTag').addEventListener('click', () => noteSource && printOrderTag(noteSource));

// Desde la confirmación: la nota se arma con la foto y firma que ya están en el teléfono.
// Se prepara en cuanto aparece la confirmación para compartir al instante (sin perder el gesto).
let notePrep = null;
function prepareSuccessNote() {
  if (!noteSource) { notePrep = null; return; }
  const src = noteSource;
  notePrep = renderNote(src)
    .then(async (canvas) => ({ data: src, canvas, png: await canvasToBlob(canvas, 'image/png') }))
    .catch(() => null);
}

async function noteFromSuccess(kind) {
  if (!noteSource) return;
  if (kind === 'view') return openNote(noteSource);
  try {
    let prep = notePrep ? await notePrep : null;
    if (!prep || prep.data !== noteSource) {
      const canvas = await renderNote(noteSource);
      prep = { data: noteSource, canvas, png: await canvasToBlob(canvas, 'image/png') };
      notePrep = Promise.resolve(prep);
    }
    noteCurrent = prep;
    await sendNote(kind);
  } catch (err) {
    toast(`No se pudo preparar la nota: ${err.message}`, 'error');
  }
}
// Confirmación: la nota se envía al teléfono de la orden (okWaUrl solo indica que hay teléfono válido).
let okWaUrl = '';
$('#okNoteShare').addEventListener('click', async () => {
  if (!okWaUrl || !noteSource) { toast('La orden no tiene un teléfono de 10 dígitos. Comparte la nota como archivo.', 'error'); return; }
  const src = noteSource;
  const btn = $('#okNoteShare');
  btn.disabled = true;
  try {
    const prep = notePrep ? await notePrep : null;
    const canvas = prep?.data === src ? prep.canvas : await renderNote(src);
    await sendNoteAuto(btn, src, canvas);
  } finally {
    btn.disabled = false;
  }
});
$('#okShareFile').addEventListener('click', () => noteFromSuccess('png'));
$('#okNotePdf').addEventListener('click', () => noteFromSuccess('pdf'));
$('#okNoteView').addEventListener('click', () => noteFromSuccess('view'));

// ================= Confirmación =================
const overlay = $('#success');
function showSuccess(o, { offline = false } = {}) {
  $('#okTitle').textContent = offline ? 'Orden guardada en el teléfono' : 'Orden registrada';
  $('#okFolio').textContent = offline ? 'Folio pendiente' : o.folio;
  $('#okOffline').hidden = !offline;
  $('.success-text', overlay).hidden = offline;
  $('#okShareFile').hidden = offline;
  $('#okNoteActions').hidden = offline;
  noteSource = offline ? null : noteDataFromOrder(o);
  $('.success-mark', overlay).classList.toggle('is-pending', offline);

  if (!offline) {
    const msg = `Hola ${o.nombre}, Z e-Scooters México registró tu orden ${o.folio} para ${o.marca}. `
      + `Servicio: ${o.servicio}. Presupuesto aproximado: ${fmtMXN(o.presupuesto)}; anticipo: ${fmtMXN(o.anticipo)}${o.iva > 0 ? ` + IVA ${fmtMXN(o.iva)} (con factura)` : ''}; total a pagar: ${fmtMXN(o.total)}. `
      + 'Te avisaremos por este medio cuando tu vehículo esté listo. Consultas: 55 6501 8583.';
    okWaUrl = digits(o.telefono).length === 10 ? waLink(o.telefono, msg) : '';
  }

  // Cobro del anticipo: Mercado Pago (VITE_PAYMENTS_ENABLED) y pago a plazos con Aplazo (VITE_APLAZO_ENABLED).
  const canCharge = !offline && o.total > 0;
  const showMp = PAYMENTS_ENABLED && canCharge;
  const showAplazo = APLAZO_ENABLED && canCharge && o.total >= 100;
  $('#payBlock').hidden = !(showMp || showAplazo);
  $('#payMp').hidden = !showMp;
  $('#payAplazo').hidden = !showAplazo;
  $('#payLink').hidden = true;
  $('#payBtn').hidden = false;
  $('#bnplLink').hidden = true;
  $('#bnplBtn').hidden = false;
  $('#payAmount').textContent = fmtMXN(o.total);

  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  $('#newBtn').focus();
  heroMounted?.pause();
  prepareSuccessNote();
  if (!offline && !restoring) persistSuccess(o);
}

// ----- Confirmación persistente -----
// Al compartir la nota a WhatsApp la app pasa a segundo plano y Android puede cerrarla para
// liberar memoria. Se guarda la última confirmación para reabrirla al volver.
const SUCCESS_KEY = 'zpev.ultimaConfirmacion';
const SUCCESS_TTL = 2 * 60 * 60 * 1000;
let restoring = false;

function shrinkImage(dataUrl, maxW = 1080, quality = 0.78) {
  return new Promise((resolve) => {
    if (!dataUrl) return resolve('');
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

async function persistSuccess(o) {
  try {
    const { fotos, ...rest } = o;
    const saved = { ...rest, fotosCount: fotos?.length || 0, fotoPrincipal: await shrinkImage(o.fotoPrincipal) };
    localStorage.setItem(SUCCESS_KEY, JSON.stringify({ at: Date.now(), order: saved }));
  } catch (_) { /* almacenamiento lleno o bloqueado: no es crítico */ }
}

function clearSuccess() {
  try { localStorage.removeItem(SUCCESS_KEY); } catch (_) { /* noop */ }
}

function restoreSuccess() {
  if (!overlay.hidden) return;
  let rec = null;
  try { rec = JSON.parse(localStorage.getItem(SUCCESS_KEY) || 'null'); } catch (_) { rec = null; }
  if (!rec?.order?.folio) return;
  if (Date.now() - rec.at > SUCCESS_TTL) return clearSuccess();
  const o = { ...rec.order, fotos: Array.from({ length: rec.order.fotosCount || 0 }) };
  lastOrder = o;
  restoring = true;
  try { showSuccess(o); } finally { restoring = false; }
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
      amount: lastOrder.total,
      nombre: lastOrder.nombre,
      telefono: lastOrder.telefono,
      concepto: `Anticipo orden ${lastOrder.folio} · ${lastOrder.marca}`
    });
    $('#payUrl').value = url;
    $('#payWa').href = waLink(lastOrder.telefono, `Hola ${lastOrder.nombre}, este es el link para pagar el anticipo de ${fmtMXN(lastOrder.total)} de tu orden ${lastOrder.folio}: ${url}`);
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
      amount: lastOrder.total,
      nombre: lastOrder.nombre,
      telefono: lastOrder.telefono,
      concepto: `Anticipo orden ${lastOrder.folio} · ${lastOrder.marca}`
    });
    $('#bnplUrl').value = url;
    $('#bnplWa').href = waLink(lastOrder.telefono, `Hola ${lastOrder.nombre}, ¿no tienes tarjeta de crédito? Puedes pagar el anticipo de ${fmtMXN(lastOrder.total)} de tu orden ${lastOrder.folio} a plazos con Aplazo aquí: ${url}`);
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
  clearSuccess();
  notePrep = null;
  heroMounted?.resume();
  resetForm();
});

// Fecha y hora automáticas: no se editan; se refrescan cada 20 s y se fijan al enviar.
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function setNowDefaults() {
  const now = new Date();
  $('#fecha').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  $('#hora').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  $('#stampText').textContent = `${DIAS[now.getDay()]} ${now.getDate()} ${MESES[now.getMonth()]} ${now.getFullYear()} · ${$('#hora').value}`;
}
setInterval(() => { if (!overlay || overlay.hidden) setNowDefaults(); }, 20000);

function resetForm() {
  submitting = false;
  savedCaptureId = '';
  captureId = '';
  form.reset();
  const planDefault = form.querySelector('input[name="plan"][value="Anticipo y liquidación"]');
  if (planDefault) planDefault.checked = true;
  signature.clear();
  photos.clear();
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
