// Comprobante de entrega para el cliente: lee el folio y el token del enlace,
// consulta el comprobante (solo lectura) y lo presenta en la tarjeta 3D.
import './comprobante.css';

const API_URL = import.meta.env.VITE_API_URL || '';
const $ = (s) => document.querySelector(s);
const fmtMXN = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

const ticket = $('#ticket');

function fail(message) {
  ticket.hidden = true;
  $('#notice').hidden = false;
  if (message) $('#noticeText').textContent = message;
}

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function render(d) {
  document.title = `Comprobante ${d.folio} · Z e-Scooters México`;
  $('#folio').textContent = d.folio;
  $('#cliente').textContent = d.cliente;
  $('#vehiculo').textContent = d.serie ? `${d.vehiculo} · Serie ${d.serie}` : d.vehiculo;
  $('#servicio').textContent = d.servicio || '—';
  $('#recepcion').textContent = d.recepcion || '—';
  $('#entrega').textContent = d.entrega || '—';
  $('#total').textContent = fmtMXN(d.total);
  $('#pagado').textContent = fmtMXN(d.pagado);
  $('#saldo').textContent = fmtMXN(d.saldo);
  $('#paid').lastChild.textContent = d.saldo > 0 ? `Saldo pendiente ${fmtMXN(d.saldo)}` : 'Pagado en su totalidad';
  $('#pays').replaceChildren(...(d.pagos || []).map((p) => {
    const tr = document.createElement('tr');
    tr.append(cell(p.concepto), cell(p.fecha), cell(p.metodo || '—'), cell(fmtMXN(p.monto), 'n'));
    return tr;
  }));
  if (d.pdfUrl) {
    $('#pdf').href = d.pdfUrl;
    $('#pdf').hidden = false;
  }
  ticket.classList.remove('is-loading');
}

async function load() {
  const q = new URLSearchParams(location.search);
  const f = q.get('f') || '';
  const t = q.get('t') || '';
  if (!/^(?:ZPEV-\d{2}-\d{4,}|ZE-(?:\d{8}-)?\d{4,})$/.test(f) || !t || !API_URL) return fail();
  try {
    const res = await fetch(`${API_URL}?action=receipt&f=${encodeURIComponent(f)}&t=${encodeURIComponent(t)}`);
    const data = await res.json();
    if (!data.ok) return fail(data.error);
    render(data);
  } catch (_) {
    fail('No pudimos cargar el comprobante. Revisa tu conexión e inténtalo de nuevo.');
  }
}

// Inclinación 3D con el puntero (escritorio) o el dedo (móvil).
function tilt() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const MAX = 6;
  const move = (x, y) => {
    const r = ticket.getBoundingClientRect();
    const px = Math.min(Math.max((x - r.left) / r.width, 0), 1);
    const py = Math.min(Math.max((y - r.top) / r.height, 0), 1);
    ticket.classList.add('is-tilting');
    ticket.style.setProperty('--ry', `${(px - 0.5) * MAX * 2}deg`);
    ticket.style.setProperty('--rx', `${(0.5 - py) * MAX}deg`);
    ticket.style.setProperty('--mx', `${px * 100}%`);
    ticket.style.setProperty('--my', `${py * 100}%`);
  };
  const reset = () => {
    ticket.classList.remove('is-tilting');
    ticket.style.setProperty('--rx', '0deg');
    ticket.style.setProperty('--ry', '0deg');
  };
  ticket.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
  ticket.addEventListener('pointerleave', reset);
  ticket.addEventListener('pointerup', reset);
}

tilt();
load();
