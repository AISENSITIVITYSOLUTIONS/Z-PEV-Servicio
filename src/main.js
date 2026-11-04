import './style.css';
import { TERMS, TERMS_CLOSING, TERMS_PARTIES, TERMS_TITLE, TERMS_VERSION } from './terms.js';
import { mountHero } from './hero3d.js';
import { mountSignature } from './signature.js';

const API_URL = import.meta.env.VITE_API_URL || '';
const KEY_STORAGE = 'ze-orden-clave';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const form = $('#orderForm');
const submitBtn = $('#submitBtn');
const submitLabel = $('.cta-label', submitBtn);

const fmtMXN = (n) => n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const digits = (v) => String(v || '').replace(/\D/g, '');
const clean = (v) => String(v || '').trim().replace(/\s+/g, ' ');

// ---------- Fecha y hora por defecto (hora local de la captura) ----------
function setNowDefaults() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  $('#fecha').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  $('#hora').value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// ---------- Términos ----------
function renderTerms() {
  const body = $('#termsBody');
  const frag = document.createDocumentFragment();

  const h = document.createElement('h3');
  h.className = 'terms-title';
  h.textContent = TERMS_TITLE;
  frag.append(h);

  const parties = document.createElement('p');
  parties.className = 'terms-parties';
  parties.textContent = TERMS_PARTIES;
  frag.append(parties);

  TERMS.forEach((c) => {
    const art = document.createElement('article');
    art.className = 'clause';
    art.id = `clausula-${c.id.toLowerCase().replace(/\s+/g, '-')}`;
    const head = document.createElement('h4');
    head.innerHTML = `<span class="clause-id">${c.id}.</span>${c.title ? ` ${c.title}.` : ''}`;
    art.append(head);
    c.paragraphs.forEach((p) => {
      const para = document.createElement('p');
      para.textContent = p;
      art.append(para);
    });
    if (c.callout) {
      const box = document.createElement('p');
      box.className = 'clause-callout';
      box.textContent = c.callout;
      art.append(box);
    }
    frag.append(art);
  });

  TERMS_CLOSING.forEach((p) => {
    const para = document.createElement('p');
    para.className = 'terms-closing';
    para.textContent = p;
    frag.append(para);
  });

  body.replaceChildren(frag);
}

const termsBox = $('#termsBox');
const acepta = $('#acepta');
const termsHint = $('#termsHint');
let termsRead = false;

function checkTermsRead() {
  const { scrollTop, scrollHeight, clientHeight } = termsBox;
  const overflow = scrollHeight - clientHeight > 4;
  if (!overflow || scrollTop + clientHeight >= scrollHeight - 12) {
    termsRead = true;
  }
  acepta.disabled = !termsRead;
  termsHint.textContent = termsRead
    ? 'Marca la casilla para aceptar.'
    : 'Desplázate hasta el final del contrato para continuar.';
  termsHint.classList.toggle('is-hidden', acepta.checked);
}

// ---------- Firma ----------
let sigReady = false;
const signature = mountSignature($('#sigScene'), {
  canvas: $('#sigCanvas'),
  plane: $('#sigPlane'),
  hintEl: $('#sigHint'),
  stateEl: $('#sigState'),
  undoBtn: $('#undoBtn'),
  clearBtn: $('#clearBtn'),
  onChange: () => {
    if (sigReady) updatePreview();
  }
});
sigReady = true;

// ---------- Vista previa y validación ----------
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
  const requiredOk = v.fecha && v.hora;
  const ok = Object.values(checks).every(Boolean) && Boolean(requiredOk);
  return { ok, checks };
}

function updateChecklist(checks) {
  $$('.checklist li').forEach((li) => {
    li.classList.toggle('is-done', Boolean(checks[li.dataset.check]));
  });
}

function updatePreview() {
  const v = values();
  const { ok, checks } = validate(v);

  // Saldo = total − anticipo (no negativo)
  const saldo = Math.max(v.total - v.anticipo, 0);
  $('#saldo').value = saldo.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Vista previa
  $('#pvNombre').textContent = v.nombre || 'Nombre pendiente';
  $('#pvTel').textContent = v.telefono ? formatPhone(v.telefono) : 'Teléfono pendiente';
  $('#pvMarca').textContent = v.marca || 'Marca y modelo';
  $('#pvSerie').textContent = v.serie ? `Serie ${v.serie}` : 'Sin número de serie';
  $('#pvServicio').textContent = v.servicio || 'Describe el servicio solicitado.';
  $('#pvPresup').textContent = fmtMXN(num($('#presupuesto').value));
  $('#pvAnticipo').textContent = fmtMXN(v.anticipo);
  $('#pvSaldo').textContent = fmtMXN(saldo);

  const chips = [];
  if (v.encendido) chips.push(v.encendido === 'si' ? 'Encendido' : 'Apagado');
  if (v.llaves) chips.push(`Llaves: ${v.llaves}`);
  if (v.cargador) chips.push(`Cargador: ${v.cargador}`);
  if (v.otros) chips.push(v.otros);
  const chipBox = $('#pvChips');
  chipBox.replaceChildren(
    ...chips.map((t) => {
      const s = document.createElement('span');
      s.className = 'chip';
      s.textContent = t;
      return s;
    })
  );

  // Firma en miniatura
  const thumb = $('#pvSig');
  if (v.firma) {
    const img = document.createElement('img');
    img.alt = 'Firma del cliente';
    img.src = signature.toDataURL();
    thumb.replaceChildren(img);
  } else {
    thumb.replaceChildren(Object.assign(document.createElement('span'), { textContent: 'Pendiente' }));
  }

  // Aviso de batería
  const bat = /bater/i.test(v.servicio);
  $('#batHint').classList.toggle('is-hidden', !bat);
  $('#halfBtn').classList.toggle('is-hidden', !(bat && v.total > 0));

  updateChecklist(checks);
  submitBtn.disabled = !ok;
  submitLabel.textContent = ok ? 'Enviar orden y guardar' : 'Completa la orden para enviar';
}

function formatPhone(d) {
  if (d.length !== 10) return d;
  return `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`;
}

form.addEventListener('input', updatePreview);
form.addEventListener('change', updatePreview);

$('#telefono').addEventListener('input', (e) => {
  e.target.value = digits(e.target.value).slice(0, 10);
});

$('#halfBtn').addEventListener('click', () => {
  const total = num($('#total').value);
  $('#anticipo').value = (Math.round(total * 50) / 100).toFixed(2);
  updatePreview();
});

termsBox.addEventListener('scroll', checkTermsRead, { passive: true });
acepta.addEventListener('change', () => {
  termsHint.classList.toggle('is-hidden', acepta.checked);
  updatePreview();
});

// ---------- Clave de acceso ----------
const keyInput = $('#accessKey');
keyInput.value = localStorage.getItem(KEY_STORAGE) || '';
keyInput.addEventListener('change', () => {
  localStorage.setItem(KEY_STORAGE, keyInput.value.trim());
  setConnStatus();
});

function setConnStatus() {
  const el = $('#connStatus');
  if (!API_URL) {
    el.textContent = 'Falta configurar la URL de Apps Script';
    el.dataset.state = 'warn';
  } else if (!keyInput.value.trim()) {
    el.textContent = 'Escribe la clave del equipo';
    el.dataset.state = 'warn';
  } else {
    el.textContent = 'Listo para enviar';
    el.dataset.state = 'ok';
  }
}

// ---------- Mensajes ----------
const toastEl = $('#toast');
let toastTimer = 0;
function toast(msg, tone = 'info') {
  toastEl.textContent = msg;
  toastEl.dataset.tone = tone;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4200);
}

// ---------- Envío ----------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = values();
  const { ok, checks } = validate(v);
  if (!ok) {
    const miss = {
      cliente: 'nombre y teléfono de 10 dígitos',
      vehiculo: 'marca y modelo',
      servicio: 'descripción del servicio',
      encendido: 'si el vehículo está encendido',
      terminos: 'aceptar los términos',
      firma: 'firma del cliente'
    };
    const pending = Object.keys(checks).filter((k) => !checks[k]).map((k) => miss[k]);
    toast(`Falta: ${pending.join(', ')}.`, 'warn');
    if (!checks.cliente) $('#nombre').focus();
    else if (!checks.vehiculo) $('#marca').focus();
    else if (!checks.servicio) $('#servicio').focus();
    else if (!checks.firma) $('#firma').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  if (!API_URL) {
    toast('Configura VITE_API_URL con la URL de la Web App de Apps Script.', 'error');
    return;
  }
  const clave = keyInput.value.trim();
  if (!clave) {
    keyInput.focus();
    toast('Escribe la clave del equipo en la barra lateral.', 'warn');
    return;
  }

  const payload = {
    clave,
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
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'No se pudo guardar');
    showSuccess(json.folio);
    setConnStatus();
  } catch (err) {
    console.error(err);
    toast(`No se pudo guardar: ${err.message}. Revisa la clave y la conexión.`, 'error');
    submitBtn.disabled = false;
    submitLabel.textContent = 'Enviar orden y guardar';
  } finally {
    submitBtn.classList.remove('is-loading');
  }
});

// ---------- Confirmación y reinicio ----------
const overlay = $('#success');
function showSuccess(folio) {
  $('#okFolio').textContent = folio;
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('is-in'));
  $('#newBtn').focus();
}

$('#newBtn').addEventListener('click', () => {
  overlay.classList.remove('is-in');
  overlay.hidden = true;
  resetForm();
});

function resetForm() {
  form.reset();
  signature.clear();
  acepta.disabled = true;
  acepta.checked = false;
  termsRead = false;
  termsBox.scrollTop = 0;
  checkTermsRead();
  setNowDefaults();
  $('#halfBtn').classList.add('is-hidden');
  $('#batHint').classList.add('is-hidden');
  updatePreview();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- Arranque ----------
renderTerms();
setNowDefaults();
setConnStatus();
updatePreview();
requestAnimationFrame(checkTermsRead);
window.addEventListener('resize', checkTermsRead);

const hero = mountHero($('#hero3d'));
window.addEventListener('pagehide', () => hero.destroy());
