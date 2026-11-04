'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verifySignature, buildManifest } = require('../webhook-signature');
const { handler } = require('../billing');

const SECRET = 'clave-de-prueba';
const sign = (dataId, requestId, ts) =>
  `ts=${ts},v1=${crypto.createHmac('sha256', SECRET).update(buildManifest({ dataId, requestId, ts })).digest('hex')}`;

test('firma válida', () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.deepStrictEqual(verifySignature({ secret: SECRET, signatureHeader: sign('123', 'req-1', ts), requestId: 'req-1', dataId: '123' }), { ok: true });
});

test('sin secreto se rechaza (fail-closed)', () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.strictEqual(verifySignature({ secret: '', signatureHeader: sign('1', 'r', ts), requestId: 'r', dataId: '1' }).reason, 'missing_secret');
});

test('firma alterada o vencida se rechaza', () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.strictEqual(verifySignature({ secret: SECRET, signatureHeader: sign('1', 'r', ts), requestId: 'r', dataId: '2' }).reason, 'invalid_signature');
  const old = ts - 3600;
  assert.strictEqual(verifySignature({ secret: SECRET, signatureHeader: sign('1', 'r', old), requestId: 'r', dataId: '1' }).reason, 'stale_signature');
  assert.strictEqual(verifySignature({ secret: SECRET, signatureHeader: 'basura', requestId: 'r', dataId: '1' }).reason, 'malformed_signature');
});

function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const req = (method, path, extra = {}) => ({ method, path, query: {}, body: {}, get: () => '', ...extra });

test('checkout bloqueado mientras PAYMENTS_ENABLED no es true', async () => {
  process.env.PAYMENTS_ENABLED = 'false';
  const res = mockRes();
  await handler(req('POST', '/billing/checkout'), res);
  assert.strictEqual(res.code, 403);
});

test('webhook sin secreto responde 401', async () => {
  delete process.env.MP_WEBHOOK_SECRET;
  const res = mockRes();
  await handler(req('POST', '/billing/webhook', { query: { 'data.id': '1', type: 'payment' } }), res);
  assert.strictEqual(res.code, 401);
});

test('health no expone secretos', async () => {
  process.env.MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-secreto';
  const res = mockRes();
  await handler(req('GET', '/billing/health'), res);
  assert.strictEqual(res.code, 200);
  assert.ok(!JSON.stringify(res.body).includes('APP_USR'));
});
