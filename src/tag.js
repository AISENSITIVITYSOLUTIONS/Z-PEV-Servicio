// Etiqueta interna del taller: se imprime y se pega en el vehículo en lugar de la hoja de papel.
// 100 × 70 mm a 300 dpi: folio grande, foto, cliente, vehículo, servicio, fecha y un QR que abre la orden.
import QRCode from 'qrcode';

const MM = 300 / 25.4;
const W = Math.round(100 * MM);
const H = Math.round(70 * MM);
const INK = '#0F1115';
const MUTED = '#5B6068';
const SANS = "'Geist', ui-sans-serif, system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, Menlo, monospace";

export const orderUrl = (folio) => `${location.origin}/?folio=${encodeURIComponent(folio)}`;

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fit(ctx, text, font, maxW) {
  ctx.font = font;
  let s = String(text || '');
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function lines(ctx, text, font, maxW, max) {
  ctx.font = font;
  const out = [];
  let line = '';
  for (const w of String(text || '').split(/\s+/)) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
  }
  if (line) out.push(line);
  if (out.length > max) { out.length = max; out[max - 1] = fit(ctx, `${out[max - 1]} …`, font, maxW); }
  return out;
}

export async function renderTag(d) {
  try { await document.fonts?.ready; } catch (_) { /* noop */ }
  const [foto, qrUrl] = await Promise.all([
    loadImage(d.fotoUrl),
    QRCode.toDataURL(orderUrl(d.folio), { errorCorrectionLevel: 'M', margin: 0, width: 360, color: { dark: INK, light: '#FFFFFF' } })
  ]);
  const qr = await loadImage(qrUrl);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
  const P = 52;

  // Franja superior con folio
  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, 230);
  ctx.fillStyle = '#D9F84A'; ctx.font = `600 34px ${MONO}`; ctx.textBaseline = 'alphabetic';
  ctx.fillText('Z e-SCOOTERS · TALLER', P, 70);
  ctx.fillStyle = '#FFFFFF'; ctx.font = `700 132px ${MONO}`;
  ctx.fillText(fit(ctx, d.folio, `700 132px ${MONO}`, W - P * 2), P, 196);

  // QR
  const qs = 300;
  const qx = W - P - qs;
  const qy = 262;
  if (qr) ctx.drawImage(qr, qx, qy, qs, qs);
  ctx.fillStyle = MUTED; ctx.font = `500 24px ${SANS}`; ctx.textAlign = 'center';
  ctx.fillText('Escanear para ver la orden', qx + qs / 2, qy + qs + 38);
  ctx.textAlign = 'left';

  // Foto
  let x = P;
  if (foto) {
    const fs = 300;
    ctx.save();
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(P, qy, fs, fs, 22) : ctx.rect(P, qy, fs, fs); ctx.clip();
    const s = Math.max(fs / foto.width, fs / foto.height);
    ctx.drawImage(foto, P + (fs - foto.width * s) / 2, qy + (fs - foto.height * s) / 2, foto.width * s, foto.height * s);
    ctx.restore();
    x = P + fs + 36;
  }
  const tw = qx - 36 - x;

  // Datos
  let y = qy + 40;
  const lab = (t) => { ctx.fillStyle = MUTED; ctx.font = `600 22px ${SANS}`; ctx.fillText(t.toUpperCase(), x, y); y += 46; };
  lab('Cliente');
  ctx.fillStyle = INK; ctx.fillText(fit(ctx, d.nombre, `600 40px ${SANS}`, tw), x, y); y += 40;
  ctx.fillStyle = MUTED; ctx.fillText(fit(ctx, d.telefono ? String(d.telefono).replace(/(\d{2})(\d{4})(\d{4})/, '$1 $2 $3') : '', `400 28px ${MONO}`, tw), x, y); y += 60;
  lab('Vehículo');
  ctx.fillStyle = INK; ctx.fillText(fit(ctx, d.marca, `600 36px ${SANS}`, tw), x, y); y += 38;
  ctx.fillStyle = MUTED; ctx.fillText(fit(ctx, d.serie ? `Serie ${d.serie}` : 'Sin número de serie', `400 26px ${MONO}`, tw), x, y);

  // Servicio y fecha
  y = qy + 300 + 92;
  ctx.fillStyle = '#E2E0D9'; ctx.fillRect(P, y - 44, W - P * 2, 2);
  ctx.fillStyle = MUTED; ctx.font = `600 22px ${SANS}`; ctx.fillText('SERVICIO', P, y);
  ctx.textAlign = 'right'; ctx.font = `500 26px ${MONO}`;
  ctx.fillText(`${d.fecha || ''}  ${d.hora || ''}`.trim(), W - P, y);
  ctx.textAlign = 'left';
  y += 46;
  ctx.fillStyle = INK;
  lines(ctx, d.servicio, `500 32px ${SANS}`, W - P * 2, 2).forEach((l) => { ctx.fillText(l, P, y); y += 42; });
  return c;
}

/** Abre el diálogo de impresión con la etiqueta a tamaño real (100 × 70 mm). */
export function printTag(canvas, folio) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><title>Etiqueta ${folio}</title><style>
    @page { size: 100mm 70mm; margin: 0; }
    html, body { margin: 0; padding: 0; }
    img { display: block; width: 100mm; height: 70mm; }
  </style></head><body><img src="${canvas.toDataURL('image/png')}" alt=""></body></html>`);
  doc.close();
  const img = doc.querySelector('img');
  const go = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 60000);
  };
  if (img.complete) setTimeout(go, 50); else img.onload = go;
}
