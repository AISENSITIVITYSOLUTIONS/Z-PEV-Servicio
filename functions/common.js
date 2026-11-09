'use strict';
// Utilidades compartidas por los cobros (Mercado Pago y Aplazo).

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const oauth = new OAuth2Client();

const env = (k, d = '') => String(process.env[k] ?? d).replace(/^﻿/, '').trim();
const isTrue = (k) => env(k).toLowerCase() === 'true';
const send = (res, code, body) => res.status(code).json(body);
const httpError = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

const FOLIO_RE = /^ZE-\d{8}-\d{4}$/;

/** Personal autorizado: ID token de Google válido y correo en ALLOWED_EMAILS. */
async function verifyStaff(req) {
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) throw httpError('Sesión no iniciada.', 401);
  const ticket = await oauth.verifyIdToken({ idToken: m[1], audience: env('GOOGLE_CLIENT_ID') });
  const p = ticket.getPayload() || {};
  const email = String(p.email || '').toLowerCase();
  const allowed = env('ALLOWED_EMAILS').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!p.email_verified || !allowed.includes(email)) throw httpError('Tu cuenta no tiene acceso a cobros.', 403);
  return email;
}

/** Llamada autenticada a Apps Script (secreto compartido SHEETS_WEBHOOK_TOKEN). */
async function sheets(action, payload = {}) {
  const url = env('SHEETS_API_URL');
  if (!url) return { ok: false, error: 'SHEETS_API_URL vacío' };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: env('SHEETS_WEBHOOK_TOKEN'), ...payload }),
    redirect: 'follow'
  });
  return res.json().catch(() => ({ ok: false, error: `Apps Script respondió ${res.status}` }));
}

const notifySheets = (payload) => sheets('payment', payload);

/** Comparación en tiempo constante. */
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { env, isTrue, send, httpError, FOLIO_RE, verifyStaff, sheets, notifySheets, safeEqual };
