// Cliente del backend.
//  - Apps Script (VITE_API_URL): crear órdenes y leer el historial en Google Sheets.
//  - Firebase Function billing (VITE_BILLING_URL): link de pago del anticipo (Mercado Pago o Aplazo).
// Apps Script no acepta preflight CORS, por eso se envía JSON como text/plain.

export const API_URL = import.meta.env.VITE_API_URL || '';
export const BILLING_URL = import.meta.env.VITE_BILLING_URL || '/billing';
export const PAYMENTS_ENABLED = import.meta.env.VITE_PAYMENTS_ENABLED === 'true';
export const APLAZO_ENABLED = import.meta.env.VITE_APLAZO_ENABLED === 'true';

async function postSheets(body, timeoutMs = 30000) {
  if (!API_URL) throw new Error('Falta configurar VITE_API_URL');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Respuesta inválida del servidor');
  return json;
}

export function createOrder(idToken, order) {
  return postSheets({ action: 'create', idToken, ...order });
}

export function listOrders(idToken, limit = 60) {
  return postSheets({ action: 'list', idToken, limit });
}

export async function createPaymentLink(idToken, { folio, amount, nombre, telefono, concepto }) {
  const res = await fetch(`${BILLING_URL}/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ folio, amount, nombre, telefono, concepto })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.init_point) throw new Error(json.error || `No se pudo generar el link (HTTP ${res.status})`);
  return json;
}

async function billing(path, idToken, { method = 'POST', body } = {}) {
  const res = await fetch(`${BILLING_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Error del servidor de cobros (HTTP ${res.status})`);
  return json;
}

/** Link de pago a plazos con Aplazo para el anticipo. */
export function createAplazoLink(idToken, { folio, amount, nombre, telefono, concepto }) {
  return billing('/aplazo/checkout', idToken, { body: { folio, amount, nombre, telefono, concepto } });
}

export function cancelAplazoLink(idToken, folio) {
  return billing('/aplazo/cancel', idToken, { body: { folio } });
}
