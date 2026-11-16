'use strict';
// Cobro del anticipo a plazos con Aplazo (Online API).
//
// Función propia «aplazo» (Firebase Hosting reescribe /billing/aplazo/** aquí):
//   GET  /billing/aplazo/health    Estado de la configuración (sin secretos).
//   POST /billing/aplazo/checkout  Personal → link de checkout de Aplazo para el anticipo de un folio.
//   GET  /billing/aplazo/status    Personal → estado del pago (?folio=) y sincronización con la hoja.
//   POST /billing/aplazo/cancel    Personal → cancela el link vigente no pagado de un folio.
//   POST /billing/aplazo/refund    Personal → reembolso total o parcial ({ folio, amount, reason }).
//   GET  /billing/aplazo/refunds   Personal → estado de los reembolsos (?folio=).
//   POST /billing/aplazo/webhook   Aplazo → confirmación de pago (token en Authorization).
// Además, la función programada aplazoSweep (index.js) concilia los links pendientes y cancela
// los que superan APLAZO_TTL_HOURS sin pagarse.
//
// Reglas de la matriz de certificación que se cumplen aquí:
//  - cartId único global: <folio>-A<marca de tiempo base 36>. Un monto distinto exige un cartId nuevo.
//  - Un solo link vigente por folio: el mismo monto reutiliza el link; uno distinto cancela el anterior.
//  - El webhook nunca se cree: se reconsulta el estado con GET /v1/loan/status y se responde 200.
//  - El loanId, el cartId y el link quedan en la hoja (columnas «Aplazo …»).

const { env, isTrue, send, httpError, FOLIO_RE, verifyStaff, sheets, notifySheets, safeEqual } = require('./common');

const CART_RE = /^(ZE-\d{8}-\d{4})-A[0-9a-z]{6,12}$/;
const RESERVE_GRACE_MS = 2 * 60 * 1000;

const PENDING = new Set(['Reservado', 'Pendiente']);

function hosts() {
  const tld = env('APLAZO_ENV', 'sandbox').toLowerCase() === 'production' ? 'mx' : 'net';
  return {
    api: `https://api.aplazo.${tld}`,
    merchant: `https://merchant.aplazo.${tld}`,
    refunds: `https://refunds-bifrost.aplazo.${tld}`
  };
}

const enabled = () => isTrue('APLAZO_ENABLED');

function health() {
  return {
    enabled: enabled(),
    env: env('APLAZO_ENV', 'sandbox'),
    merchantId: Boolean(env('APLAZO_MERCHANT_ID')),
    apiToken: Boolean(env('APLAZO_API_TOKEN')),
    webhookToken: Boolean(env('APLAZO_WEBHOOK_TOKEN')),
    sheets: Boolean(env('SHEETS_API_URL') && env('SHEETS_WEBHOOK_TOKEN'))
  };
}

/* ---------- Cliente de la API ---------- */

// Aplazo recomienda generar un Bearer nuevo por petición.
async function bearer() {
  const merchantId = Number(env('APLAZO_MERCHANT_ID'));
  const apiToken = env('APLAZO_API_TOKEN');
  if (!merchantId || !apiToken) throw httpError('Aplazo no está configurado (APLAZO_MERCHANT_ID / APLAZO_API_TOKEN).', 503);
  const res = await fetch(`${hosts().api}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiToken, merchantId })
  });
  const json = await res.json().catch(() => ({}));
  const auth = String(json.Authorization || '');
  if (!res.ok || !/^Bearer\s+\S+/.test(auth)) throw httpError(`Aplazo rechazó la autenticación (HTTP ${res.status}).`, 502);
  return auth;
}

async function call(url, { method = 'GET', body } = {}) {
  const headers = { Authorization: await bearer() };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

async function loanStatus(cartId) {
  const r = await call(`${hosts().merchant}/api/v1/loan/status?cart_id=${encodeURIComponent(cartId)}`);
  if (r.status === 404) return { status: 'NO ENCONTRADO' };
  if (!r.ok) throw httpError(`Aplazo no devolvió el estado (HTTP ${r.status}).`, 502, { aplazo: r.json });
  return { status: String(r.json.status || '').toUpperCase(), loanId: r.json.loanId };
}

const isPaid = (s) => s === 'ACTIVO' || s === 'ACTIVE' || s === 'OUTSTANDING';
const isClosed = (s) => /CANCELADO|DEVUELTO|CANCELLED|REFUNDED/.test(s);

async function cancelLoan(cartId) {
  const r = await call(`${hosts().refunds}/api/v1/merchant/loan/cancel?cartId=${encodeURIComponent(cartId)}`);
  return { accepted: r.status === 202 || r.ok, status: r.status, detail: r.json };
}

/* ---------- Hoja ---------- */

async function sheet(action, payload) {
  const r = await sheets(action, payload);
  if (!r.ok) throw httpError(r.error || `Apps Script no completó ${action}.`, r.status || 502);
  return r;
}

const nowIso = () => new Date().toISOString();

async function markPaid(folio, cartId, loanId, amount) {
  await sheet('aplazoUpdate', { folio, cartId, fields: { loanId: String(loanId || ''), estado: 'Pagado' }, force: true });
  const r = await notifySheets({ folio, status: 'approved', paymentId: `APLAZO-${loanId || cartId}`, amount, method: 'Aplazo' });
  if (!r.ok) console.error('aplazo: no se registró el pago en la hoja', folio, r.error);
}

/** Revisa el link vigente: lo marca pagado, lo cancela si venció o deja todo igual. */
async function reconcile(row, { expire = false } = {}) {
  const { folio, cartId } = row;
  const st = await loanStatus(cartId);
  if (isPaid(st.status)) {
    await markPaid(folio, cartId, st.loanId, row.monto);
    return 'Pagado';
  }
  if (isClosed(st.status)) {
    await sheet('aplazoUpdate', { folio, cartId, fields: { estado: 'Cancelado' } });
    return 'Cancelado';
  }
  if (expire) {
    const c = await cancelLoan(cartId);
    if (c.accepted || st.status === 'NO ENCONTRADO') {
      await sheet('aplazoUpdate', { folio, cartId, fields: { estado: 'Cancelado (vencido)' } });
      return 'Cancelado (vencido)';
    }
    console.warn('aplazo: no se pudo cancelar', cartId, c.status, c.detail);
  }
  return row.estado;
}

/* ---------- Rutas del personal ---------- */

function splitName(nombre) {
  const parts = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] || 'Cliente', lastName: '.' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

async function checkout(req, res, staff) {
  const { folio, amount, nombre, telefono, email, concepto } = req.body || {};
  const value = Math.round(Number(amount) * 100) / 100;
  const max = Number(env('APLAZO_MAX_AMOUNT_MXN', '50000'));
  const min = Number(env('APLAZO_MIN_AMOUNT_MXN', '100'));
  if (!FOLIO_RE.test(String(folio || ''))) return send(res, 400, { error: 'Folio inválido.' });
  if (!Number.isFinite(value) || value < min || value > max) {
    return send(res, 400, { error: `Monto fuera del rango de Aplazo (${min}–${max} MXN).` });
  }

  // 1. Link vigente del folio.
  const cur = (await sheet('aplazoGet', { folio })).aplazo || {};
  if (cur.estado === 'Pagado') return send(res, 409, { error: 'El anticipo de este folio ya se pagó con Aplazo.' });
  if (cur.cartId && PENDING.has(cur.estado)) {
    const age = Date.now() - Date.parse(cur.actualizado || 0);
    if (cur.estado === 'Reservado' && age < RESERVE_GRACE_MS) {
      return send(res, 409, { error: 'Ya se está generando un link para este folio. Intenta en un minuto.' });
    }
    if (cur.estado === 'Pendiente' && cur.url && Number(cur.monto) === value) {
      return send(res, 200, { url: cur.url, cartId: cur.cartId, reused: true });
    }
    // Monto distinto o reserva fallida: el carrito anterior queda desactualizado y se bloquea.
    const st = await loanStatus(cur.cartId).catch(() => ({ status: '' }));
    if (isPaid(st.status)) {
      await markPaid(folio, cur.cartId, st.loanId, cur.monto);
      return send(res, 409, { error: 'El link anterior de este folio ya se pagó.' });
    }
    if (!isClosed(st.status) && st.status !== 'NO ENCONTRADO') await cancelLoan(cur.cartId).catch(() => null);
    await sheet('aplazoUpdate', { folio, cartId: cur.cartId, fields: { estado: 'Cancelado (reemplazado)' } });
  }

  // 2. Reserva atómica del nuevo cartId (Apps Script con LockService).
  const cartId = `${folio}-A${Date.now().toString(36)}`;
  await sheet('aplazoReserve', { folio, cartId, monto: value, expectedPrev: cur.cartId || '', at: nowIso() });

  // 3. Crear el pago.
  const base = env('PUBLIC_BASE_URL');
  const back = (estado) => `${base}/pago.html?proveedor=aplazo&estado=${estado}&folio=${encodeURIComponent(folio)}`;
  const tel = String(telefono || '').replace(/\D/g, '').slice(-10);
  const title = String(concepto || `Anticipo orden ${folio}`).slice(0, 120);
  const buyer = { ...splitName(nombre), phone: tel };
  if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) buyer.email = String(email).trim();

  const r = await call(`${hosts().api}/api/loan`, {
    method: 'POST',
    body: {
      totalPrice: value,
      shopId: env('APLAZO_SHOP_ID', 'z-pev-servicio'),
      cartId,
      successUrl: back('ok'),
      errorUrl: back('error'),
      cartUrl: back('carrito'),
      webHookUrl: `${base}/billing/aplazo/webhook`,
      buyer,
      products: [{
        id: folio,
        count: 1,
        title,
        description: 'Anticipo de servicio de reparación o mantenimiento · Z e-Scooters México',
        price: value
      }],
      discount: { price: 0, title: 'Sin descuento' },
      shipping: { price: 0, title: 'Servicio en taller' },
      taxes: { price: 0, title: 'IVA incluido' }
    }
  });

  if (!r.ok || !r.json.url) {
    await sheet('aplazoUpdate', { folio, cartId, fields: { estado: 'Error' } }).catch(() => null);
    const dup = JSON.stringify(r.json).includes('OUTSTANDING_LOAN_ALREADY_EXISTS');
    throw httpError(dup ? 'Aplazo ya tiene un pago activo para este carrito.' : `Aplazo no generó el link (HTTP ${r.status}).`,
      dup ? 409 : 502, { aplazo: r.json });
  }

  // 4. Guardar el link, el loanId y quién lo generó.
  await sheet('aplazoUpdate', {
    folio, cartId,
    fields: { url: r.json.url, loanId: String(r.json.loanId ?? ''), estado: 'Pendiente', por: staff }
  });
  return send(res, 200, { url: r.json.url, cartId, loanId: r.json.loanId });
}

async function currentRow(folio) {
  if (!FOLIO_RE.test(String(folio || ''))) throw httpError('Folio inválido.', 400);
  const row = (await sheet('aplazoGet', { folio })).aplazo || {};
  if (!row.cartId) throw httpError('Este folio no tiene pagos con Aplazo.', 404);
  return { folio, ...row };
}

async function status(req, res) {
  const row = await currentRow(req.query.folio);
  const estado = PENDING.has(row.estado) ? await reconcile(row) : row.estado;
  return send(res, 200, { folio: row.folio, cartId: row.cartId, loanId: row.loanId, estado, monto: row.monto });
}

async function cancel(req, res) {
  const row = await currentRow((req.body || {}).folio);
  if (!PENDING.has(row.estado)) return send(res, 409, { error: `No se puede cancelar: el pago está «${row.estado}».` });
  const st = await loanStatus(row.cartId);
  if (isPaid(st.status)) {
    await markPaid(row.folio, row.cartId, st.loanId, row.monto);
    return send(res, 409, { error: 'El cliente ya pagó; usa un reembolso.' });
  }
  const c = await cancelLoan(row.cartId);
  if (!c.accepted && st.status !== 'NO ENCONTRADO') return send(res, 502, { error: `Aplazo no aceptó la cancelación (HTTP ${c.status}).` });
  await sheet('aplazoUpdate', { folio: row.folio, cartId: row.cartId, fields: { estado: 'Cancelado' } });
  return send(res, 200, { ok: true, estado: 'Cancelado' });
}

async function refund(req, res, staff) {
  const { folio, amount, reason } = req.body || {};
  const row = await currentRow(folio);
  if (!/^Pagado|^Reembolso/.test(row.estado || '')) return send(res, 409, { error: 'Solo se reembolsan pagos confirmados.' });
  const value = Math.round(Number(amount) * 100) / 100;
  const available = Math.round((Number(row.monto) - Number(row.reembolsado || 0)) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0 || value > available) {
    return send(res, 400, { error: `Monto inválido: disponible para reembolso ${available} MXN.` });
  }
  const motivo = String(reason || '').trim().slice(0, 200);
  if (motivo.length < 3) return send(res, 400, { error: 'Indica el motivo del reembolso.' });

  const r = await call(`${hosts().merchant}/api/loan/refund-from-cart`, {
    method: 'POST',
    body: { cartId: row.cartId, totalAmount: value, reason: motivo }
  });
  if (!r.ok) return send(res, 502, { error: `Aplazo no aceptó el reembolso (HTTP ${r.status}).` });

  const total = Math.round((Number(row.reembolsado || 0) + value) * 100) / 100;
  await sheet('aplazoUpdate', {
    folio: row.folio, cartId: row.cartId,
    fields: { reembolsado: total, estado: total >= Number(row.monto) ? 'Reembolso total' : 'Reembolso parcial', por: staff },
    force: true
  });
  return send(res, 200, { ok: true, refundId: r.json.refundId, refundStatus: r.json.refundStatus, reembolsado: total });
}

async function refunds(req, res) {
  const row = await currentRow(req.query.folio);
  const r = await call(`${hosts().merchant}/api/v1/merchant/refund/status?cartId=${encodeURIComponent(row.cartId)}`);
  if (!r.ok) return send(res, 502, { error: `Aplazo no devolvió los reembolsos (HTTP ${r.status}).` });
  return send(res, 200, { folio: row.folio, refunds: Array.isArray(r.json) ? r.json : [] });
}

/* ---------- Webhook ---------- */

async function webhook(req, res) {
  const expected = env('APLAZO_WEBHOOK_TOKEN');
  const got = String(req.get('authorization') || '').replace(/^(Bearer|Basic)\s+/i, '');
  // Fail-closed: sin token configurado o con token distinto, se rechaza (Aplazo indica 400).
  if (!expected || !safeEqual(got, expected)) return send(res, 400, { error: 'invalid_token' });

  const cartId = String((req.body || {}).cartId || '');
  const m = cartId.match(CART_RE);
  if (!m) return send(res, 200, { ignored: true });
  if (Number((req.body || {}).merchantId) !== Number(env('APLAZO_MERCHANT_ID'))) return send(res, 200, { ignored: true });

  // Nunca se confía en el cuerpo: se reconsulta el estado en la API.
  const st = await loanStatus(cartId);
  if (!isPaid(st.status)) return send(res, 200, { ok: true, status: st.status });
  const row = (await sheet('aplazoGet', { folio: m[1] })).aplazo || {};
  await markPaid(m[1], cartId, st.loanId, row.cartId === cartId ? row.monto : undefined);
  return send(res, 200, { ok: true });
}

/* ---------- Conciliación programada ---------- */

async function sweep() {
  if (!enabled()) return { skipped: true };
  const ttlMs = Number(env('APLAZO_TTL_HOURS', '48')) * 3600 * 1000;
  const { rows = [] } = await sheet('aplazoPending', {});
  const out = { revisados: 0, pagados: 0, cancelados: 0 };
  for (const row of rows) {
    out.revisados++;
    try {
      const expire = Date.now() - Date.parse(row.actualizado || 0) > ttlMs;
      const estado = await reconcile(row, { expire });
      if (estado === 'Pagado') out.pagados++;
      else if (/^Cancelado/.test(estado || '')) out.cancelados++;
    } catch (err) {
      console.error('aplazo sweep', row.folio, err.message);
    }
  }
  return out;
}

/* ---------- Enrutador ---------- */

async function route(req, res, path) {
  if (req.method === 'GET' && path === '/health') return send(res, 200, health());
  if (!enabled()) return send(res, 403, { error: 'Los cobros con Aplazo no están activos.' });
  if (req.method === 'POST' && path === '/webhook') return webhook(req, res);

  const staff = await verifyStaff(req);
  if (req.method === 'POST' && path === '/checkout') return checkout(req, res, staff);
  if (req.method === 'GET' && path === '/status') return status(req, res);
  if (req.method === 'POST' && path === '/cancel') return cancel(req, res);
  if (req.method === 'POST' && path === '/refund') return refund(req, res, staff);
  if (req.method === 'GET' && path === '/refunds') return refunds(req, res);
  return send(res, 404, { error: 'Ruta no encontrada.' });
}

async function handler(req, res) {
  const path = req.path.replace(/^\/billing\/aplazo/, '') || '/';
  try {
    return await route(req, res, path);
  } catch (err) {
    console.error('aplazo', path, err.message, err.aplazo || '');
    return send(res, err.code && err.code < 600 ? err.code : 500, { error: err.message });
  }
}

module.exports = { handler, route, sweep, health, _internal: { CART_RE, splitName, hosts, checkout, refund } };
