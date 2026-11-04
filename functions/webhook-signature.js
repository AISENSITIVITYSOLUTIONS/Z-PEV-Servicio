'use strict';
// Verificación de la firma x-signature de los webhooks de Mercado Pago (HMAC-SHA256).
// Fail-closed: sin secreto configurado, toda notificación se rechaza.
//
// Formato del encabezado: "ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a5e839"
// Plantilla firmada:      "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
// (si falta data.id o x-request-id, ese segmento se omite, según la documentación de MP).

const crypto = require('crypto');

function parseSignature(header) {
  const out = {};
  String(header || '').split(',').forEach((part) => {
    const [k, v] = part.split('=').map((s) => (s || '').trim());
    if (k && v) out[k] = v;
  });
  return out;
}

function buildManifest({ dataId, requestId, ts }) {
  let m = '';
  if (dataId) m += `id:${/^[a-z0-9]+$/i.test(dataId) ? String(dataId).toLowerCase() : dataId};`;
  if (requestId) m += `request-id:${requestId};`;
  m += `ts:${ts};`;
  return m;
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifySignature({ secret, signatureHeader, requestId, dataId, maxAgeSec = 600, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'missing_secret' };
  const { ts, v1 } = parseSignature(signatureHeader);
  if (!ts || !v1) return { ok: false, reason: 'malformed_signature' };

  // MP envía ts en milisegundos en algunas integraciones y en segundos en otras.
  const tsMs = String(ts).length > 11 ? Number(ts) : Number(ts) * 1000;
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > maxAgeSec * 1000) return { ok: false, reason: 'stale_signature' };

  const expected = crypto.createHmac('sha256', secret).update(buildManifest({ dataId, requestId, ts })).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(String(v1), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'invalid_signature' };
  return { ok: true };
}

module.exports = { verifySignature, parseSignature, buildManifest };
