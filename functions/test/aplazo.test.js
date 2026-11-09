'use strict';
const test = require('node:test');
const assert = require('node:assert');
const aplazo = require('../aplazo');
const { handler } = require('../billing');

const SHEETS = 'https://sheets.test/exec';
const FOLIO = 'ZE-20261109-0007';

function mockRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const req = (method, path, extra = {}) => ({ method, path, query: {}, body: {}, get: () => '', ...extra });

/** Simula Aplazo y Apps Script; registra cada llamada. */
function fakeWorld({ row = {}, loanStatus = 'NO CONFIRMADO', cancelCode = 202 } = {}) {
  const state = { row: { ...row }, calls: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    state.calls.push({ url: u, method: opts.method || 'GET', body, headers: opts.headers || {} });
    const reply = (code, json) => ({ ok: code >= 200 && code < 300, status: code, json: async () => json, text: async () => JSON.stringify(json) });
    if (u === SHEETS) {
      if (body.token !== 'tok-sheets') return reply(200, { ok: false, error: 'No autorizado.' });
      if (body.action === 'aplazoGet') return reply(200, { ok: true, aplazo: state.row });
      if (body.action === 'aplazoReserve') {
        if ((state.row.cartId || '') !== body.expectedPrev) return reply(200, { ok: false, status: 409, error: 'conflicto' });
        state.row = { cartId: body.cartId, monto: body.monto, estado: 'Reservado', actualizado: new Date().toISOString() };
        return reply(200, { ok: true });
      }
      if (body.action === 'aplazoUpdate') { Object.assign(state.row, body.fields); return reply(200, { ok: true }); }
      if (body.action === 'aplazoPending') return reply(200, { ok: true, rows: state.row.cartId ? [{ folio: FOLIO, ...state.row }] : [] });
      if (body.action === 'payment') { state.paid = body; return reply(200, { ok: true }); }
    }
    if (u.endsWith('/api/auth')) return reply(200, { Authorization: 'Bearer jwt-prueba' });
    if (u.endsWith('/api/loan')) return reply(200, { url: 'https://checkout.aplazo.net/main/abc', loanId: 777, loanToken: 'abc' });
    if (u.includes('/api/v1/loan/status')) return reply(200, { loanId: 777, status: loanStatus });
    if (u.includes('/loan/cancel')) return reply(cancelCode, {});
    if (u.endsWith('/api/loan/refund-from-cart')) return reply(200, { refundId: 1, refundStatus: 'REQUESTED' });
    return reply(404, {});
  };
  return state;
}

function setEnv() {
  Object.assign(process.env, {
    PAYMENTS_ENABLED: 'true', APLAZO_ENABLED: 'true', APLAZO_ENV: 'sandbox', APLAZO_MERCHANT_ID: '4015',
    APLAZO_API_TOKEN: 'api-tok', APLAZO_WEBHOOK_TOKEN: 'wh-secreto', SHEETS_API_URL: SHEETS,
    SHEETS_WEBHOOK_TOKEN: 'tok-sheets', PUBLIC_BASE_URL: 'https://z-pev-servicio.web.app'
  });
}

test('cartId: formato único por folio', () => {
  const id = `${FOLIO}-A${Date.now().toString(36)}`;
  assert.ok(aplazo._internal.CART_RE.test(id));
  assert.strictEqual(id.match(aplazo._internal.CART_RE)[1], FOLIO);
});

test('hosts: sandbox usa .net y producción .mx', () => {
  process.env.APLAZO_ENV = 'sandbox';
  assert.strictEqual(aplazo._internal.hosts().api, 'https://api.aplazo.net');
  process.env.APLAZO_ENV = 'production';
  assert.strictEqual(aplazo._internal.hosts().refunds, 'https://refunds-bifrost.aplazo.mx');
  process.env.APLAZO_ENV = 'sandbox';
});

test('rutas bloqueadas mientras APLAZO_ENABLED no es true', async () => {
  setEnv();
  process.env.APLAZO_ENABLED = 'false';
  const res = mockRes();
  await handler(req('POST', '/billing/aplazo/webhook'), res);
  assert.strictEqual(res.code, 403);
});

test('webhook sin token o con token incorrecto responde 400 (fail-closed)', async () => {
  setEnv();
  fakeWorld();
  let res = mockRes();
  await handler(req('POST', '/billing/aplazo/webhook', { body: { cartId: `${FOLIO}-Aabcdef1`, merchantId: 4015 } }), res);
  assert.strictEqual(res.code, 400);
  res = mockRes();
  await handler(req('POST', '/billing/aplazo/webhook', { get: () => 'Bearer otro', body: { cartId: `${FOLIO}-Aabcdef1`, merchantId: 4015 } }), res);
  assert.strictEqual(res.code, 400);
});

test('webhook válido reconsulta el estado y marca el pago; responde 200', async () => {
  setEnv();
  const cartId = `${FOLIO}-Aabcdef1`;
  const w = fakeWorld({ row: { cartId, monto: 500, estado: 'Pendiente' }, loanStatus: 'ACTIVO' });
  const res = mockRes();
  await handler(req('POST', '/billing/aplazo/webhook', {
    get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer wh-secreto' : ''),
    body: { status: 'Activo', loanId: 777, cartId, merchantId: 4015 }
  }), res);
  assert.strictEqual(res.code, 200);
  assert.ok(w.calls.some((c) => c.url.includes('/api/v1/loan/status?cart_id=')));
  assert.strictEqual(w.row.estado, 'Pagado');
  assert.strictEqual(w.paid.method, 'Aplazo');
  assert.strictEqual(w.paid.status, 'approved');
});

test('webhook no marca pagado si la API no confirma (no confía en el cuerpo)', async () => {
  setEnv();
  const cartId = `${FOLIO}-Aabcdef1`;
  const w = fakeWorld({ row: { cartId, monto: 500, estado: 'Pendiente' }, loanStatus: 'NO CONFIRMADO' });
  const res = mockRes();
  await handler(req('POST', '/billing/aplazo/webhook', {
    get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer wh-secreto' : ''),
    body: { status: 'Activo', loanId: 777, cartId, merchantId: 4015 }
  }), res);
  assert.strictEqual(res.code, 200);
  assert.strictEqual(w.row.estado, 'Pendiente');
  assert.strictEqual(w.paid, undefined);
});

test('sweep: cancela links vencidos y concilia pagados', async () => {
  setEnv();
  process.env.APLAZO_TTL_HOURS = '48';
  const old = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  let w = fakeWorld({ row: { cartId: `${FOLIO}-Aabcdef1`, monto: 500, estado: 'Pendiente', actualizado: old } });
  let r = await aplazo.sweep();
  assert.strictEqual(r.cancelados, 1);
  assert.ok(w.calls.some((c) => c.url.includes('refunds-bifrost.aplazo.net/api/v1/merchant/loan/cancel?cartId=')));
  assert.strictEqual(w.row.estado, 'Cancelado (vencido)');

  w = fakeWorld({ row: { cartId: `${FOLIO}-Aabcdef1`, monto: 500, estado: 'Pendiente', actualizado: new Date().toISOString() }, loanStatus: 'ACTIVO' });
  r = await aplazo.sweep();
  assert.strictEqual(r.pagados, 1);
  assert.strictEqual(w.row.estado, 'Pagado');
});

test('sweep: no cancela un link reciente sin pagar', async () => {
  setEnv();
  const w = fakeWorld({ row: { cartId: `${FOLIO}-Aabcdef1`, monto: 500, estado: 'Pendiente', actualizado: new Date().toISOString() } });
  const r = await aplazo.sweep();
  assert.strictEqual(r.cancelados, 0);
  assert.ok(!w.calls.some((c) => c.url.includes('/loan/cancel')));
});

test('health no expone secretos de Aplazo', async () => {
  setEnv();
  const res = mockRes();
  await handler(req('GET', '/billing/health'), res);
  assert.strictEqual(res.code, 200);
  const s = JSON.stringify(res.body);
  assert.ok(!s.includes('api-tok') && !s.includes('wh-secreto'));
  assert.strictEqual(res.body.aplazo.apiToken, true);
});

test('nombre del comprador se separa en nombre y apellido', () => {
  assert.deepStrictEqual(aplazo._internal.splitName('Ana María López'), { firstName: 'Ana María', lastName: 'López' });
  assert.deepStrictEqual(aplazo._internal.splitName('Ana'), { firstName: 'Ana', lastName: '.' });
});

const { checkout, refund } = aplazo._internal;
const order = { folio: FOLIO, amount: 500, nombre: 'Ana López', telefono: '5512345678', concepto: 'Anticipo' };

test('checkout: crea el pago con los campos requeridos y guarda link y loanId', async () => {
  setEnv();
  const w = fakeWorld();
  const res = mockRes();
  await checkout({ body: order }, res, 'staff@x.mx');
  assert.strictEqual(res.code, 200);
  const loan = w.calls.find((c) => c.url === 'https://api.aplazo.net/api/loan');
  for (const k of ['totalPrice', 'shopId', 'cartId', 'successUrl', 'errorUrl', 'cartUrl', 'webHookUrl', 'buyer', 'products', 'discount', 'shipping', 'taxes']) {
    assert.ok(k in loan.body, `falta ${k}`);
  }
  assert.strictEqual(loan.headers.Authorization, 'Bearer jwt-prueba');
  assert.strictEqual(loan.body.webHookUrl, 'https://z-pev-servicio.web.app/billing/aplazo/webhook');
  assert.ok(aplazo._internal.CART_RE.test(loan.body.cartId));
  assert.strictEqual(w.row.estado, 'Pendiente');
  assert.strictEqual(w.row.loanId, '777');
  assert.strictEqual(w.row.url, 'https://checkout.aplazo.net/main/abc');
});

test('checkout: mismo monto reutiliza el link (sin préstamo duplicado)', async () => {
  setEnv();
  const w = fakeWorld({ row: { cartId: `${FOLIO}-Aabcdef1`, monto: 500, estado: 'Pendiente', url: 'https://checkout.aplazo.net/main/x', actualizado: new Date().toISOString() } });
  const res = mockRes();
  await checkout({ body: order }, res, 'staff@x.mx');
  assert.strictEqual(res.body.reused, true);
  assert.ok(!w.calls.some((c) => c.url.endsWith('/api/loan')));
});

test('checkout: monto distinto cancela el carrito anterior y genera cartId nuevo', async () => {
  setEnv();
  const prev = `${FOLIO}-Aabcdef1`;
  const w = fakeWorld({ row: { cartId: prev, monto: 400, estado: 'Pendiente', url: 'u', actualizado: new Date().toISOString() } });
  const res = mockRes();
  await checkout({ body: order }, res, 'staff@x.mx');
  assert.strictEqual(res.code, 200);
  assert.ok(w.calls.some((c) => c.url.includes(`/loan/cancel?cartId=${encodeURIComponent(prev)}`)));
  assert.notStrictEqual(res.body.cartId, prev);
});

test('checkout: si el link anterior ya se pagó, no genera otro', async () => {
  setEnv();
  const w = fakeWorld({ row: { cartId: `${FOLIO}-Aabcdef1`, monto: 400, estado: 'Pendiente', url: 'u', actualizado: new Date().toISOString() }, loanStatus: 'ACTIVO' });
  const res = mockRes();
  await checkout({ body: order }, res, 'staff@x.mx');
  assert.strictEqual(res.code, 409);
  assert.strictEqual(w.row.estado, 'Pagado');
});

test('checkout: monto menor al mínimo se rechaza', async () => {
  setEnv();
  fakeWorld();
  const res = mockRes();
  await checkout({ body: { ...order, amount: 50 } }, res, 'staff@x.mx');
  assert.strictEqual(res.code, 400);
});

test('reembolso parcial y luego total; no excede lo pagado', async () => {
  setEnv();
  const w = fakeWorld({ row: { cartId: `${FOLIO}-Aabcdef1`, monto: 500, estado: 'Pagado', reembolsado: 0 } });
  let res = mockRes();
  await refund({ body: { folio: FOLIO, amount: 200, reason: 'Pieza no disponible' } }, res, 'staff@x.mx');
  assert.strictEqual(res.code, 200);
  assert.strictEqual(w.row.estado, 'Reembolso parcial');
  res = mockRes();
  await refund({ body: { folio: FOLIO, amount: 400, reason: 'Excede' } }, res, 'staff@x.mx');
  assert.strictEqual(res.code, 400);
  res = mockRes();
  await refund({ body: { folio: FOLIO, amount: 300, reason: 'Cancelación del servicio' } }, res, 'staff@x.mx');
  assert.strictEqual(w.row.estado, 'Reembolso total');
});
