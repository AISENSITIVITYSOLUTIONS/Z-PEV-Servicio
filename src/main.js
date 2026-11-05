import './style.css';
import { TERMS, TERMS_CLOSING, TERMS_PARTIES, TERMS_TITLE, TERMS_VERSION } from './terms.js';
import { mountHero } from './hero3d.js';
import { mountSignature } from './signature.js';
import { initAuth, getSession, signOut } from './auth.js';
import { API_URL, PAYMENTS_ENABLED, createOrder, listOrders, createPaymentLink } from './api.js';
import { initPWA } from './pwa.js';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const DRAFT_KEY = 'zpev-borrador';
const MONTH_GOAL = 120; // referencia visual del medidor de órdenes del mes

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const form = $('#orderForm');
const submitBtn = $('#submitBtn');
const submitLabel = $('.cta-label', submitBtn);
let session = null;
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
    total: num($('#total').value),
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
  submitLabel.textContent = overpaid ? 'El anticipo supera el total' : ok ? 'Enviar orden y guardar' : 'Completa la orden para enviar';

  const done = Object.values(checks).filter(Boolean).length;
  const dockCta = $('#dockCta');
  dockCta.disabled = !ok || overpaid;
  dockCta.classList.toggle('is-ready', ok && !overpaid);
  $('#dockProgress').textContent = `${done}/6`;
  $('#dockLabel').textContent = overpaid ? 'Anticipo mayor al total' : ok ? 'Enviar orden' : 'Completa la orden';
}

// ================= Borrador automático =================
const DRAFT_FIELDS = ['nombre', 'telefono', 'marca', 'serie', 'servicio', 'caracteristicas', 'llaves', 'cargador', 'otros', 'presupuesto', 'anticipo', 'total'];
let draftTimer = 0;

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
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
  }, 400);
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
  $('#anticipo').value = (Math.round(num($('#total').value) * 50) / 100).toFixed(2);
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
  recibido: 'Recibido', reparacion: 'En reparación', listo: 'Listo para entrega', entregado: 'Entregado', pagado: 'Anticipo pagado'
};
const statusKey = (s) => {
  const t = String(s || '').toLowerCase();
  if (t.includes('repar')) return 'reparacion';
  if (t.includes('listo')) return 'listo';
  if (t.includes('entreg')) return 'entregado';
  if (t.includes('pagad')) return 'pagado';
  return 'recibido';
};

function svg(path) {
  return `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
const ICON_WA = svg('<path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z"/><path d="M9 9.5c.5 2 2.3 4 4.5 4.6l1.2-1.2 2 .9c-.2 1.3-1.4 2-2.7 1.8C10.6 15 8 12.5 7.6 9.3c-.1-1.2.6-2.4 1.8-2.6l.9 2z"/>');
const ICON_SIG = svg('<path d="M3 17c3-2 4 2 6 0s3-4 5-2 2 3 4 1"/><path d="M3 21h18"/>');

function renderHistory() {
  const q = clean($('#histSearch').value).toLowerCase();
  const rows = historyCache.filter((o) => !q || [o.folio, o.cliente, o.marca, o.telefono].join(' ').toLowerCase().includes(q));
  const body = $('#histBody');
  body.replaceChildren(...rows.map((o) => {
    const tr = document.createElement('tr');
    const key = statusKey(o.estatus);
    const msg = key === 'listo'
      ? `Hola ${o.cliente}, tu ${o.marca} (orden ${o.folio}) ya está listo para recoger en Z e-Scooters México, Av. Patriotismo 176. Horario: L–V 10:00–19:00, S 10:00–15:00. Saldo pendiente: ${fmtMXN(o.saldo)}.`
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

  const open = historyCache.filter((o) => !['entregado'].includes(statusKey(o.estatus)));
  $('#stOrders').textContent = historyCache.length;
  $('#stOpen').textContent = open.length;
  $('#stAdv').textContent = fmtMXN(historyCache.reduce((a, o) => a + num(o.anticipo), 0));
  $('#stDue').textContent = fmtMXN(open.reduce((a, o) => a + num(o.saldo), 0));
}

function paintMonth(count) {
  if (!Number.isFinite(count)) return;
  $('#monthCount').textContent = `${count}`;
  $('#monthBar').style.width = `${Math.min(100, (count / MONTH_GOAL) * 100)}%`;
}

async function loadHistory() {
  session = getSession();
  if (!session) return showLogin('Tu sesión venció. Vuelve a iniciar sesión.');
  $('#histEmpty').hidden = false;
  $('#histEmpty').textContent = 'Cargando órdenes…';
  try {
    const res = await listOrders(session.token);
    historyCache = res.orders || [];
    paintMonth(res.monthCount);
    renderHistory();
  } catch (err) {
    historyCache = [];
    renderHistory();
    $('#histEmpty').textContent = `No se pudo cargar el historial: ${err.message}`;
  }
}
$('#histSearch').addEventListener('input', renderHistory);
$('#histReload').addEventListener('click', loadHistory);

// ================= Sesión =================
function setConnStatus() {
  const el = $('#connStatus');
  if (!API_URL) { el.textContent = 'Falta la URL de Apps Script'; el.dataset.state = 'warn'; }
  else if (!session) { el.textContent = 'Inicia sesión para enviar'; el.dataset.state = 'warn'; }
  else { el.textContent = 'Conectado a la hoja del taller'; el.dataset.state = 'ok'; }
}

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
function showApp(s) {
  session = s;
  $('#login').hidden = true;
  $('.shell').hidden = false;
  $('#dock').hidden = false;
  paintUser(s);
  setConnStatus();
  updatePreview();
  requestAnimationFrame(checkTermsRead);
  if (!heroMounted) heroMounted = mountHero($('#hero3d'));
  const vista = new URLSearchParams(location.search).get('vista');
  if (vista === 'historial') setView('historial');
  else if (API_URL) listOrders(s.token, 1).then((r) => paintMonth(r.monthCount)).catch(() => {});
}

function showLogin(message = '') {
  session = null;
  $('#login').hidden = false;
  $('.shell').hidden = true;
  $('#dock').hidden = true;
  paintUser(null);
  const denied = $('#loginDenied');
  denied.textContent = message;
  denied.classList.toggle('is-hidden', !message);
  setConnStatus();
}

$('#signOutBtn').addEventListener('click', () => signOut());

// ================= Mensajes =================
const toastEl = $('#toast');
let toastTimer = 0;
function toast(msg, tone = 'info') {
  toastEl.textContent = msg;
  toastEl.dataset.tone = tone;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4200);
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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = values();
  const { ok, checks } = validate(v);
  if (!ok) {
    toast(`Falta: ${Object.keys(checks).filter((k) => !checks[k]).map((k) => MISSING[k]).join(', ')}.`, 'warn');
    return;
  }
  if (!API_URL) return toast('Configura VITE_API_URL con la URL de la Web App de Apps Script.', 'error');
  session = getSession();
  if (!session) return showLogin('Tu sesión venció. Vuelve a iniciar sesión.');

  const order = {
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
    llaves: v.llaves,
    cargador: v.cargador,
    otros: v.otros,
    firmaPng: signature.toDataURL()
  };

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
    toast(`No se pudo guardar: ${err.message}`, 'error');
    submitBtn.disabled = false;
    submitLabel.textContent = 'Enviar orden y guardar';
  } finally {
    submitBtn.classList.remove('is-loading');
  }
});

// ================= Confirmación =================
const overlay = $('#success');
function showSuccess(o) {
  $('#okFolio').textContent = o.folio;
  const msg = `Hola ${o.nombre}, Z e-Scooters México registró tu orden ${o.folio} para ${o.marca}. `
    + `Servicio: ${o.servicio}. Anticipo: ${fmtMXN(o.anticipo)}; saldo pendiente: ${fmtMXN(o.saldo)}. `
    + 'Te avisaremos por este medio cuando tu vehículo esté listo. Consultas: 55 6501 8583.';
  $('#okWa').href = waLink(o.telefono, msg);

  // Cobro del anticipo: integrado, oculto hasta activar VITE_PAYMENTS_ENABLED.
  const canCharge = PAYMENTS_ENABLED && o.anticipo > 0;
  $('#payBlock').hidden = !canCharge;
  $('#payLink').hidden = true;
  $('#payBtn').hidden = false;
  $('#payAmount').textContent = fmtMXN(o.anticipo);

  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  $('#newBtn').focus();
}

$('#payBtn').addEventListener('click', async () => {
  if (!lastOrder) return;
  session = getSession();
  if (!session) return showLogin('Tu sesión venció. Vuelve a iniciar sesión.');
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
  onSignedOut: () => showLogin(),
  onError: (msg) => showLogin(msg)
});
