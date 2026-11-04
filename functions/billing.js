'use strict';
// Cobro del anticipo de una orden de servicio con Mercado Pago (pago único, Checkout Pro).
//
// Rutas (Firebase Hosting reescribe /billing/** a esta función):
//   POST /billing/checkout  Personal autenticado con Google → preferencia de pago → init_point.
//   POST /billing/webhook   Notificación de MP → firma x-signature → reconsulta del pago → hoja.
//   GET  /billing/health    Estado de la configuración (sin secretos).
//
// La función queda inactiva mientras PAYMENTS_ENABLED no sea "true": responde 403 y la
// interfaz tampoco muestra el bloque de cobro (VITE_PAYMENTS_ENABLED).

const { OAuth2Client } = require('google-auth-library');
const { verifySignature } = require('./webhook-signature');

const MP_API = 'https://api.mercadopago.com';
const oauth = new OAuth2Client();

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const isTrue = (k) => env(k).toLowerCase() === 'true';
const send = (res, code, body) => res.status(code).json(body);

async function verifyStaff(req) {
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) throw Object.assign(new Error('Sesión no iniciada.'), { code: 401 });
  const ticket = await oauth.verifyIdToken({ idToken: m[1], audience: env('GOOGLE_CLIENT_ID') });
  const p = ticket.getPayload() || {};
  const email = String(p.email || '').toLowerCase();
  const allowed = env('ALLOWED_EMAILS').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!p.email_verified || !allowed.includes(email)) {
    throw Object.assign(new Error('Tu cuenta no tiene acceso a cobros.'), { code: 403 });
  }
  return email;
}

async function mp(path, { method = 'GET', body, idempotencyKey } = {}) {
  const token = env('MERCADOPAGO_ACCESS_TOKEN').replace(/^﻿/, '');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`${MP_API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.message || `Mercado Pago respondió ${res.status}`), { code: 502, mp: json });
  return json;
}

async function notifySheets(payload) {
  const url = env('SHEETS_API_URL');
  if (!url) return { ok: false, error: 'SHEETS_API_URL vacío' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'payment', token: env('SHEETS_WEBHOOK_TOKEN'), ...payload }),
    redirect: 'follow'
  });
  return res.json().catch(() => ({ ok: false }));
}

async function checkout(req, res) {
  if (!isTrue('PAYMENTS_ENABLED')) return send(res, 403, { error: 'Los cobros no están activos.' });
  const staff = await verifyStaff(req);

  const { folio, amount, nombre, telefono, concepto } = req.body || {};
  const value = Math.round(Number(amount) * 100) / 100;
  const max = Number(env('MP_MAX_AMOUNT_MXN', '50000'));
  if (!/^ZE-\d{8}-\d{4}$/.test(String(folio || ''))) return send(res, 400, { error: 'Folio inválido.' });
  if (!Number.isFinite(value) || value < 1 || value > max) return send(res, 400, { error: `Monto fuera de rango (1–${max} MXN).` });

  if (isTrue('BILLING_MOCK')) {
    return send(res, 200, { mock: true, init_point: `${env('PUBLIC_BASE_URL')}/?pago=prueba&folio=${encodeURIComponent(folio)}` });
  }

  const base = env('PUBLIC_BASE_URL');
  const expires = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  const pref = await mp('/checkout/preferences', {
    method: 'POST',
    idempotencyKey: `${folio}-${value}`,
    body: {
      items: [{
        id: folio,
        title: String(concepto || `Anticipo orden ${folio}`).slice(0, 120),
        description: 'Anticipo de servicio de reparación o mantenimiento · Z e-Scooters México',
        quantity: 1,
        currency_id: 'MXN',
        unit_price: value
      }],
      payer: { name: String(nombre || '').slice(0, 80), phone: { area_code: '52', number: String(telefono || '').replace(/\D/g, '').slice(-10) } },
      external_reference: folio,
      metadata: { folio, capturado_por: staff },
      notification_url: `${base}/billing/webhook`,
      back_urls: { success: `${base}/?pago=ok`, pending: `${base}/?pago=pendiente`, failure: `${base}/?pago=error` },
      statement_descriptor: 'ZESCOOTERS',
      expires: true,
      expiration_date_to: expires
    }
  });
  return send(res, 200, { init_point: pref.init_point, preference_id: pref.id });
}

async function webhook(req, res) {
  const dataId = String(req.query['data.id'] || req.body?.data?.id || '');
  const type = String(req.query.type || req.body?.type || req.query.topic || '');
  const sig = verifySignature({
    secret: env('MP_WEBHOOK_SECRET'),
    signatureHeader: req.get('x-signature'),
    requestId: req.get('x-request-id'),
    dataId
  });
  if (!sig.ok) {
    console.warn('webhook rechazado', sig.reason);
    return send(res, 401, { error: sig.reason });
  }
  if (type !== 'payment' || !dataId) return send(res, 200, { ignored: true });

  // Nunca se confía en el cuerpo de la notificación: se reconsulta el pago en la API.
  const pay = await mp(`/v1/payments/${encodeURIComponent(dataId)}`);
  const folio = String(pay.external_reference || '');
  if (!/^ZE-\d{8}-\d{4}$/.test(folio)) return send(res, 200, { ignored: true });

  const r = await notifySheets({ folio, status: pay.status, paymentId: String(pay.id), amount: pay.transaction_amount });
  if (!r.ok) console.error('No se actualizó la hoja', folio, r.error);
  return send(res, 200, { ok: true });
}

async function handler(req, res) {
  const path = req.path.replace(/^\/billing/, '') || '/';
  try {
    if (req.method === 'GET' && path === '/health') {
      return send(res, 200, {
        payments: isTrue('PAYMENTS_ENABLED'),
        mock: isTrue('BILLING_MOCK'),
        accessToken: Boolean(env('MERCADOPAGO_ACCESS_TOKEN')),
        webhookSecret: Boolean(env('MP_WEBHOOK_SECRET')),
        sheets: Boolean(env('SHEETS_API_URL') && env('SHEETS_WEBHOOK_TOKEN'))
      });
    }
    if (req.method === 'POST' && path === '/checkout') return await checkout(req, res);
    if (req.method === 'POST' && path === '/webhook') return await webhook(req, res);
    return send(res, 404, { error: 'Ruta no encontrada.' });
  } catch (err) {
    console.error(path, err.message, err.mp || '');
    return send(res, err.code && err.code < 600 ? err.code : 500, { error: err.message });
  }
}

module.exports = { handler };
