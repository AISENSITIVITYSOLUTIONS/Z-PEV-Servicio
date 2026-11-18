// Nota de servicio: la misma imagen que recibe el cliente y que el taller ve en el Historial.
// Se dibuja en canvas (1080 px de ancho) con folio, fecha y hora apilados, cliente, vehículo,
// foto principal, servicio, costos y firma. Se comparte como PNG o PDF.

const W = 1080;
const PAD = 64;
const INK = '#0F1115';
const LIME = '#D9F84A';
const PAPER = '#F3F2EE';
const MUTED = '#6B7079';
const LINE = '#E2E0D9';
const SANS = "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "'Geist Mono', ui-monospace, Menlo, monospace";

const num = (n) => Number(n) || 0;
const fmtMXN = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fechaLarga(f) {
  const m = String(f || '').match(/^(\d{4})-(\d{2})-(\d{2})$/) || String(f || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return f || '—';
  const [y, mo, d] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
  return `${parseInt(d, 10)} de ${MESES[parseInt(mo, 10) - 1]} de ${y}`;
}

function loadImage(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function wrap(ctx, text, maxW) {
  const out = [];
  String(text || '').split(/\n/).forEach((para) => {
    let line = '';
    para.split(/\s+/).forEach((word) => {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = word; } else line = test;
    });
    out.push(line);
  });
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Dibuja la nota. Llama dos veces: la primera mide la altura, la segunda pinta. */
function draw(ctx, d, imgs, paint) {
  let y = 0;
  const text = (s, x, yy, font, color = INK, align = 'left') => {
    if (!paint) return;
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, yy);
  };
  const rule = (yy) => { if (paint) { ctx.fillStyle = LINE; ctx.fillRect(PAD, yy, W - PAD * 2, 2); } };
  const label = (s, x, yy) => text(s.toUpperCase(), x, yy, `600 22px ${SANS}`, MUTED);

  // Encabezado
  const headH = 220;
  if (paint) {
    ctx.fillStyle = INK; ctx.fillRect(0, 0, W, headH);
    ctx.fillStyle = '#FFFFFF'; roundRect(ctx, PAD, 52, 116, 116, 24); ctx.fill();
    if (imgs.logo) {
      const s = Math.min(92 / imgs.logo.width, 92 / imgs.logo.height);
      ctx.drawImage(imgs.logo, PAD + 58 - (imgs.logo.width * s) / 2, 110 - (imgs.logo.height * s) / 2, imgs.logo.width * s, imgs.logo.height * s);
    }
  }
  text('Nota de servicio', PAD + 148, 104, `600 46px ${SANS}`, '#FFFFFF');
  text('Z e-Scooters México · Taller de servicio', PAD + 148, 148, `400 26px ${SANS}`, '#A9ADB4');
  text(d.offline ? 'PENDIENTE' : 'RECIBIDO', W - PAD, 104, `600 22px ${MONO}`, LIME, 'right');
  y = headH;

  // Folio, fecha y hora apilados
  y += 64;
  label('Folio', PAD, y);
  y += 72;
  text(d.folio || 'Folio pendiente', PAD, y, `600 72px ${MONO}`, INK);
  y += 52;
  label('Fecha', PAD, y); label('Hora', W / 2, y);
  y += 44;
  text(fechaLarga(d.fecha), PAD, y, `500 34px ${SANS}`);
  text(d.hora ? `${d.hora} h` : '—', W / 2, y, `500 34px ${MONO}`);
  y += 40;
  rule(y);

  // Foto principal
  if (imgs.foto) {
    y += 40;
    const fw = W - PAD * 2;
    const fh = Math.round(fw * 9 / 16);
    if (paint) {
      ctx.save(); roundRect(ctx, PAD, y, fw, fh, 24); ctx.clip();
      const s = Math.max(fw / imgs.foto.width, fh / imgs.foto.height);
      ctx.drawImage(imgs.foto, PAD + (fw - imgs.foto.width * s) / 2, y + (fh - imgs.foto.height * s) / 2, imgs.foto.width * s, imgs.foto.height * s);
      ctx.restore();
    }
    y += fh;
    if (d.fotos > 1) { y += 34; text(`${d.fotos} fotos de la recepción en el expediente del taller`, PAD, y, `400 22px ${SANS}`, MUTED); }
  }

  // Cliente y vehículo
  y += 64;
  label('Cliente', PAD, y); label('Vehículo', W / 2, y);
  y += 46;
  ctx.font = `600 34px ${SANS}`;
  const nameLines = wrap(ctx, d.nombre || '—', W / 2 - PAD - 24);
  const carLines = wrap(ctx, d.marca || '—', W / 2 - PAD);
  nameLines.forEach((l, i) => text(l, PAD, y + i * 44, `600 34px ${SANS}`));
  carLines.forEach((l, i) => text(l, W / 2, y + i * 44, `600 34px ${SANS}`));
  y += Math.max(nameLines.length, carLines.length) * 44 - 4;
  text(d.telefono ? d.telefono.replace(/(\d{2})(\d{4})(\d{4})/, '$1 $2 $3') : '', PAD, y + 4, `400 28px ${MONO}`, '#4A4F57');
  text(d.serie ? `Serie ${d.serie}` : 'Sin número de serie', W / 2, y + 4, `400 26px ${MONO}`, '#4A4F57');
  y += 44;
  text(d.encendido === 'No' ? 'Entregado apagado' : d.encendido ? 'Entregado encendido' : '', W / 2, y, `500 24px ${SANS}`, MUTED);
  y += 36;
  rule(y);

  // Servicio
  y += 56;
  label('Servicio solicitado', PAD, y);
  y += 44;
  ctx.font = `400 30px ${SANS}`;
  wrap(ctx, d.servicio || '—', W - PAD * 2).forEach((l) => { text(l, PAD, y, `400 30px ${SANS}`); y += 42; });
  if (d.caracteristicas) {
    y += 16; label('Estado al recibir', PAD, y); y += 40;
    ctx.font = `400 26px ${SANS}`;
    wrap(ctx, d.caracteristicas, W - PAD * 2).forEach((l) => { text(l, PAD, y, `400 26px ${SANS}`, '#4A4F57'); y += 36; });
  }
  const acc = [d.llaves && `Llaves/NFC: ${d.llaves}`, d.cargador && `Cargador: ${d.cargador}`, d.otros && `Otros: ${d.otros}`].filter(Boolean);
  if (acc.length) {
    y += 16; label('Accesorios recibidos', PAD, y); y += 40;
    ctx.font = `400 26px ${SANS}`;
    wrap(ctx, acc.join(' · '), W - PAD * 2).forEach((l) => { text(l, PAD, y, `400 26px ${SANS}`, '#4A4F57'); y += 36; });
  }
  y += 8;
  rule(y);

  // Costos
  y += 56;
  const row = (k, v, yy) => { text(k, PAD, yy, `400 28px ${SANS}`, '#4A4F57'); text(v, W - PAD, yy, `500 28px ${MONO}`, INK, 'right'); };
  row('Anticipo', fmtMXN(d.anticipo), y); y += 46;
  if (num(d.iva) > 0) { row('IVA 16 % (con factura)', fmtMXN(d.iva), y); y += 46; }
  y -= 16;
  const boxH = 104;
  if (paint) { ctx.fillStyle = PAPER; roundRect(ctx, PAD - 8, y, W - PAD * 2 + 16, boxH, 22); ctx.fill(); }
  text('Total a pagar', PAD + 20, y + 64, `600 30px ${SANS}`);
  text(fmtMXN(d.total ?? (num(d.anticipo) + num(d.iva))), W - PAD - 20, y + 66, `600 46px ${MONO}`, INK, 'right');
  y += boxH + 44;
  text(`Costo presupuesto (aproximado): ${fmtMXN(d.presupuesto)}`, PAD, y, `500 26px ${SANS}`, '#4A4F57');
  y += 36;
  ctx.font = `400 22px ${SANS}`;
  wrap(ctx, 'Cotización informativa: no se suma al total. El costo final se confirma al revisar la unidad y requiere su autorización.', W - PAD * 2)
    .forEach((l) => { text(l, PAD, y, `400 22px ${SANS}`, MUTED); y += 30; });
  y += 14;

  // Firma
  y += 24;
  label('Firma del cliente', PAD, y);
  y += 20;
  const sigH = 200;
  if (paint) {
    ctx.fillStyle = '#FFFFFF'; roundRect(ctx, PAD, y, W - PAD * 2, sigH, 20); ctx.fill();
    ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
    if (imgs.firma) {
      const s = Math.min((W - PAD * 2 - 80) / imgs.firma.width, (sigH - 40) / imgs.firma.height);
      ctx.drawImage(imgs.firma, W / 2 - (imgs.firma.width * s) / 2, y + sigH / 2 - (imgs.firma.height * s) / 2, imgs.firma.width * s, imgs.firma.height * s);
    }
  }
  y += sigH + 38;
  text(`${d.nombre || ''} · aceptó los términos y condiciones del servicio`, PAD, y, `400 22px ${SANS}`, MUTED);

  // Pie
  y += 52;
  const footH = 150;
  if (paint) { ctx.fillStyle = INK; ctx.fillRect(0, y, W, footH); }
  text('Conserve esta nota: se solicita para entregar su vehículo.', PAD, y + 54, `500 24px ${SANS}`, '#FFFFFF');
  text('Av. Patriotismo 176, Escandón I, CDMX · L–V 10–19 h · S 10–15 h', PAD, y + 92, `400 22px ${SANS}`, '#A9ADB4');
  text('55 6501 8583 · 55 4497 8500 · zescootersmx.com', PAD, y + 124, `400 22px ${MONO}`, LIME);
  y += footH;
  return y;
}

/** Devuelve un canvas con la nota. d: datos de la orden; fotoUrl/firmaUrl: data URLs o URLs del mismo origen. */
export async function renderNote(d) {
  try { await document.fonts?.ready; } catch (_) { /* noop */ }
  const [logo, foto, firma] = await Promise.all([loadImage('/brand/z-logo.png'), loadImage(d.fotoUrl), loadImage(d.firmaUrl)]);
  const imgs = { logo, foto, firma };
  const probe = document.createElement('canvas').getContext('2d');
  const h = Math.ceil(draw(probe, d, imgs, false));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, h);
  draw(ctx, d, imgs, true);
  return canvas;
}

export const noteFileName = (d, ext) => `Nota-${d.folio || 'pendiente'}-${String(d.nombre || 'cliente').split(' ')[0]}.${ext}`.replace(/[^\w.-]+/g, '_');

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function noteToPdf(canvas, d) {
  const { jsPDF } = await import('jspdf');
  const wMm = 120;
  const hMm = (canvas.height / canvas.width) * wMm;
  const pdf = new jsPDF({ unit: 'mm', format: [wMm, hMm], orientation: 'portrait' });
  pdf.setProperties({ title: `Nota de servicio ${d.folio || ''}`, author: 'Z e-Scooters México', subject: 'Orden de servicio' });
  pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, wMm, hMm);
  return pdf.output('blob');
}

/**
 * Comparte la nota como archivo (WhatsApp, correo…) con la hoja de compartir del teléfono.
 * Si el navegador no puede compartir archivos, la descarga. Devuelve 'shared' | 'downloaded' | 'cancelled'.
 */
export async function shareNote(blob, fileName, text) {
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Nota de servicio', text });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}
