/**
 * Z-PEV Servicio · Backend en Google Apps Script
 *
 * Acciones (POST con JSON en text/plain):
 *   create   Registra una orden: folio, firma PNG en Drive y fila en la hoja "Órdenes".
 *   list     Devuelve las últimas órdenes y el conteo del mes (historial de la app).
 *   addPayment  Registra un abono o la liquidación de un folio (hoja «Pagos») y recalcula el saldo.
 *   complete    Libera la orden (Estatus = Completada) cuando el saldo es cero.
 *   setPlan     Cambia el plan de pago: «Anticipo y liquidación» o «Varios pagos».
 *   payment  Uso interno de la función de cobros (Firebase): marca el pago del anticipo.
 *   aplazoGet / aplazoReserve / aplazoUpdate / aplazoPending
 *            Uso interno de la función de cobros: estado del link de Aplazo de cada folio.
 *
 * Acceso del personal: cada petición create/list lleva el ID token de Google. Se verifica
 * con tokeninfo (aud = GOOGLE_CLIENT_ID, correo verificado, vigencia) y contra ALLOWED_EMAILS.
 * La acción payment se autentica con SHEETS_WEBHOOK_TOKEN (secreto compartido con Firebase).
 *
 * Propiedades del script (Configuración del proyecto → Propiedades del script):
 *   GOOGLE_CLIENT_ID      ID de cliente OAuth (termina en .apps.googleusercontent.com).
 *   ALLOWED_EMAILS        Correos autorizados, separados por coma, o bien
 *   ALLOWED_EMAIL1..N     una propiedad por correo (ALLOWED_EMAIL1, ALLOWED_EMAIL2, ...).
 *   SHEET_ID              ID de la hoja de cálculo (entre /d/ y /edit en la URL).
 *   DRIVE_FOLDER_ID       ID de la carpeta de Drive para las firmas.
 *   SHEETS_WEBHOOK_TOKEN  Solo si se activan cobros: cadena larga aleatoria, igual a la de Firebase.
 */

const SHEET_NAME = 'Órdenes';
const TZ = 'America/Mexico_City';

const HEADERS = [
  'Folio', 'Registrado', 'Fecha de orden', 'Hora', 'Cliente', 'Teléfono', 'Marca y modelo', 'N° de serie',
  'Descripción del servicio', 'Características generales', 'Encendido',
  'Presupuesto aprox. (MXN)', 'Anticipo (MXN)', 'Total (MXN)', 'Saldo pendiente (MXN)',
  'Llaves o NFC', 'Cargador', 'Otros accesorios',
  'Términos aceptados', 'Versión de términos', 'Firma (enlace)', 'Estatus', 'Capturado por',
  'Pago anticipo', 'Referencia de pago',
  'ID de captura', 'Capturado en (dispositivo)',
  'Método de pago', 'Aplazo cartId', 'Aplazo loanId', 'Aplazo link', 'Aplazo monto', 'Aplazo estado',
  'Aplazo actualizado', 'Aplazo reembolsado', 'Aplazo generado por',
  'Plan de pago', 'Abonos (MXN)', 'Liberada por', 'Liberada el'
];
const PAYMENTS_SHEET = 'Pagos';
const PAYMENT_HEADERS = ['Folio', 'Fecha', 'Tipo', 'Monto (MXN)', 'Método', 'Nota', 'Registrado por', 'Saldo después (MXN)'];
const PAYMENT_METHODS = ['Efectivo', 'Tarjeta', 'Transferencia', 'Aplazo', 'Mercado Pago', 'Otro'];
const PLANS = ['Anticipo y liquidación', 'Varios pagos'];
const APLAZO_FIELDS = {
  cartId: 'Aplazo cartId', loanId: 'Aplazo loanId', url: 'Aplazo link', monto: 'Aplazo monto',
  estado: 'Aplazo estado', actualizado: 'Aplazo actualizado', reembolsado: 'Aplazo reembolsado', por: 'Aplazo generado por'
};
const APLAZO_PENDING = ['Reservado', 'Pendiente'];
const COL = HEADERS.reduce((m, h, i) => { m[h] = i; return m; }, {});
const STATUS_OPTIONS = ['Recibido', 'En reparación', 'Listo para entrega', 'Entregado', 'Anticipo pagado', 'Pagada', 'Completada'];

function doGet() {
  return json_({ ok: true, service: 'z-pev-servicio', time: new Date().toISOString() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const props = PropertiesService.getScriptProperties();
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = data.action || 'create';

    if (action === 'payment') return json_(recordPayment_(data, props));
    if (action.indexOf('aplazo') === 0) return json_(aplazo_(action, data, props, lock));

    let email;
    try {
      email = verifyUser_(data.idToken, props);
    } catch (authErr) {
      return json_({ ok: false, error: authErr.message });
    }

    const sheet = getSheet_(props.getProperty('SHEET_ID'));
    if (action === 'list') return json_(listOrders_(sheet, data.limit));
    if (action === 'addPayment' || action === 'complete' || action === 'setPlan') {
      lock.waitLock(20000);
      if (action === 'addPayment') return json_(addPayment_(sheet, data, email));
      if (action === 'setPlan') return json_(setPlan_(sheet, data));
      return json_(completeOrder_(sheet, data, email));
    }
    if (action !== 'create') return json_({ ok: false, error: 'Acción no reconocida.' });

    const problem = validate_(data);
    if (problem) return json_({ ok: false, error: problem });

    lock.waitLock(20000);

    // Idempotencia: un reintento desde la cola del teléfono no duplica la orden.
    const existing = findByClientId_(sheet, data.clientId);
    if (existing) return json_({ ok: true, folio: existing, duplicate: true, monthCount: monthCount_(sheet) });

    const folio = nextFolio_(sheet);
    const firmaUrl = saveSignature_(props.getProperty('DRIVE_FOLDER_ID'), folio, data.firmaPng);
    const row = new Array(HEADERS.length).fill('');
    const set = (h, v) => { row[COL[h]] = v; };
    set('Folio', folio);
    set('Registrado', new Date());
    set('Fecha de orden', data.fecha);
    set('Hora', data.hora);
    set('Cliente', clip_(data.nombre, 120));
    set('Teléfono', "'" + data.telefono);
    set('Marca y modelo', clip_(data.marca, 120));
    set('N° de serie', clip_(data.serie, 80));
    set('Descripción del servicio', clip_(data.servicio, 2000));
    set('Características generales', clip_(data.caracteristicas, 2000));
    set('Encendido', data.encendido === 'Sí' ? 'Sí' : 'No');
    set('Presupuesto aprox. (MXN)', num_(data.presupuesto));
    set('Anticipo (MXN)', num_(data.anticipo));
    set('Total (MXN)', num_(data.total));
    set('Saldo pendiente (MXN)', Math.max(num_(data.total) - num_(data.anticipo), 0));
    set('Llaves o NFC', clip_(data.llaves, 120));
    set('Cargador', clip_(data.cargador, 120));
    set('Otros accesorios', clip_(data.otros, 200));
    set('Términos aceptados', 'Sí');
    set('Versión de términos', clip_(data.termsVersion, 40));
    set('Firma (enlace)', firmaUrl);
    set('Estatus', 'Recibido');
    set('Capturado por', email);
    set('Pago anticipo', num_(data.anticipo) > 0 ? 'Pendiente' : '');
    set('ID de captura', clip_(data.clientId, 64));
    set('Capturado en (dispositivo)', data.capturadoEn ? new Date(data.capturadoEn) : '');
    set('Plan de pago', PLANS.indexOf(data.plan) >= 0 ? data.plan : PLANS[0]);
    set('Abonos (MXN)', 0);
    sheet.appendRow(row);
    SpreadsheetApp.flush();

    return json_({ ok: true, folio: folio, firmaUrl: firmaUrl, monthCount: monthCount_(sheet) });
  } catch (err) {
    return json_({ ok: false, error: 'Error del servidor: ' + err.message });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

/* ---------- Historial ---------- */

function listOrders_(sheet, limit) {
  const n = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 300);
  const last = sheet.getLastRow();
  if (last < 2) return { ok: true, orders: [], monthCount: 0 };
  const start = Math.max(2, last - n + 1);
  const values = sheet.getRange(start, 1, last - start + 1, HEADERS.length).getValues();
  const orders = values.reverse().map(function (r) {
    return {
      folio: r[COL['Folio']],
      fecha: fmtDate_(r[COL['Fecha de orden']]),
      cliente: r[COL['Cliente']],
      telefono: String(r[COL['Teléfono']]).replace(/^'/, ''),
      marca: r[COL['Marca y modelo']],
      anticipo: num_(r[COL['Anticipo (MXN)']]),
      total: num_(r[COL['Total (MXN)']]),
      saldo: num_(r[COL['Saldo pendiente (MXN)']]),
      estatus: r[COL['Estatus']],
      pago: r[COL['Pago anticipo']],
      firmaUrl: r[COL['Firma (enlace)']],
      plan: r[COL['Plan de pago']] || PLANS[0],
      abonos: num_(r[COL['Abonos (MXN)']])
    };
  });
  return { ok: true, orders: orders, monthCount: monthCount_(sheet) };
}

function monthCount_(sheet) {
  const prefix = 'ZE-' + Utilities.formatDate(new Date(), TZ, 'yyyyMM');
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  return sheet.getRange(2, 1, last - 1, 1).getValues().filter(function (r) {
    return String(r[0]).indexOf(prefix) === 0;
  }).length;
}

function findByClientId_(sheet, clientId) {
  if (!clientId) return '';
  const last = sheet.getLastRow();
  if (last < 2) return '';
  const col = COL['ID de captura'] + 1;
  const ids = sheet.getRange(2, col, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i][0] === clientId) return sheet.getRange(i + 2, 1).getValue();
  }
  return '';
}

/* ---------- Pagos posteriores y cierre ---------- */

function orderRow_(sheet, folio) {
  const last = sheet.getLastRow();
  if (!folio || last < 2) return 0;
  const folios = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = folios.length - 1; i >= 0; i--) if (folios[i][0] === folio) return i + 2;
  return 0;
}

function paymentsSheet_(sheet) {
  const ss = sheet.getParent();
  let p = ss.getSheetByName(PAYMENTS_SHEET);
  if (!p) {
    p = ss.insertSheet(PAYMENTS_SHEET);
    p.appendRow(PAYMENT_HEADERS);
    p.setFrozenRows(1);
    p.getRange(1, 1, 1, PAYMENT_HEADERS.length).setFontWeight('bold').setBackground('#0F1115').setFontColor('#D9F84A');
    p.getRange(2, 2, p.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    p.getRange(2, 4, p.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
    p.getRange(2, 8, p.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
  }
  return p;
}

function orderSummary_(sheet, r) {
  const v = sheet.getRange(r, 1, 1, HEADERS.length).getValues()[0];
  return {
    folio: v[COL['Folio']], total: num_(v[COL['Total (MXN)']]), anticipo: num_(v[COL['Anticipo (MXN)']]),
    abonos: num_(v[COL['Abonos (MXN)']]), saldo: num_(v[COL['Saldo pendiente (MXN)']]),
    estatus: v[COL['Estatus']], plan: v[COL['Plan de pago']] || PLANS[0]
  };
}

/** Abono o liquidación. Saldo = Total − Anticipo − Abonos. Con saldo cero, Estatus = Pagada. */
function addPayment_(sheet, data, email) {
  const r = orderRow_(sheet, data.folio);
  if (!r) return { ok: false, error: 'Folio no encontrado.' };
  const o = orderSummary_(sheet, r);
  if (o.estatus === 'Completada') return { ok: false, error: 'La orden ya está completada y liberada.' };
  const monto = num_(data.monto);
  const saldo = Math.max(Math.round((o.total - o.anticipo - o.abonos) * 100) / 100, 0);
  if (saldo <= 0) return { ok: false, error: 'Esta orden no tiene saldo pendiente.' };
  if (!(monto > 0)) return { ok: false, error: 'Indica el monto del pago.' };
  if (monto > saldo) return { ok: false, error: 'El pago supera el saldo pendiente (' + saldo.toFixed(2) + ' MXN).' };
  if (o.plan !== 'Varios pagos' && monto !== saldo) {
    return { ok: false, error: 'Con plan «Anticipo y liquidación» el pago debe cubrir el saldo completo (' + saldo.toFixed(2) + ' MXN). Cambia el plan a «Varios pagos» para abonar.' };
  }
  const metodo = PAYMENT_METHODS.indexOf(data.metodo) >= 0 ? data.metodo : 'Otro';
  const nuevoSaldo = Math.round((saldo - monto) * 100) / 100;
  const abonos = Math.round((o.abonos + monto) * 100) / 100;
  paymentsSheet_(sheet).appendRow([o.folio, new Date(), nuevoSaldo === 0 ? 'Liquidación' : 'Abono', monto, metodo,
    clip_(data.nota, 200), email, nuevoSaldo]);
  sheet.getRange(r, COL['Abonos (MXN)'] + 1).setValue(abonos);
  sheet.getRange(r, COL['Saldo pendiente (MXN)'] + 1).setValue(nuevoSaldo);
  if (nuevoSaldo === 0) sheet.getRange(r, COL['Estatus'] + 1).setValue('Pagada');
  SpreadsheetApp.flush();
  return { ok: true, folio: o.folio, saldo: nuevoSaldo, abonos: abonos, estatus: nuevoSaldo === 0 ? 'Pagada' : o.estatus };
}

/** Cambia el plan de pago de un folio (por ejemplo, a «Varios pagos» si el cliente abonará). */
function setPlan_(sheet, data) {
  const r = orderRow_(sheet, data.folio);
  if (!r) return { ok: false, error: 'Folio no encontrado.' };
  if (PLANS.indexOf(data.plan) === -1) return { ok: false, error: 'Plan de pago no válido.' };
  sheet.getRange(r, COL['Plan de pago'] + 1).setValue(data.plan);
  return { ok: true, plan: data.plan };
}

/** Libera la orden: requiere saldo cero. */
function completeOrder_(sheet, data, email) {
  const r = orderRow_(sheet, data.folio);
  if (!r) return { ok: false, error: 'Folio no encontrado.' };
  const o = orderSummary_(sheet, r);
  if (o.estatus === 'Completada') return { ok: true, estatus: 'Completada' };
  const saldo = Math.max(Math.round((o.total - o.anticipo - o.abonos) * 100) / 100, 0);
  if (saldo > 0) return { ok: false, error: 'No se puede liberar: falta pagar ' + saldo.toFixed(2) + ' MXN.' };
  sheet.getRange(r, COL['Estatus'] + 1).setValue('Completada');
  sheet.getRange(r, COL['Liberada por'] + 1).setValue(email);
  sheet.getRange(r, COL['Liberada el'] + 1).setValue(new Date());
  SpreadsheetApp.flush();
  return { ok: true, estatus: 'Completada' };
}

/* ---------- Pago del anticipo (desde Firebase) ---------- */

function recordPayment_(data, props) {
  const secret = props.getProperty('SHEETS_WEBHOOK_TOKEN');
  if (!secret || data.token !== secret) return { ok: false, error: 'No autorizado.' };
  const sheet = getSheet_(props.getProperty('SHEET_ID'));
  const last = sheet.getLastRow();
  if (last < 2) return { ok: false, error: 'Folio no encontrado.' };
  const folios = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = folios.length - 1; i >= 0; i--) {
    if (folios[i][0] === data.folio) {
      const r = i + 2;
      const approved = data.status === 'approved';
      sheet.getRange(r, COL['Pago anticipo'] + 1).setValue(approved ? 'Pagado' : String(data.status || ''));
      sheet.getRange(r, COL['Referencia de pago'] + 1).setValue(String(data.paymentId || ''));
      if (approved) sheet.getRange(r, COL['Estatus'] + 1).setValue('Anticipo pagado');
      if (data.method) sheet.getRange(r, COL['Método de pago'] + 1).setValue(String(data.method).slice(0, 40));
      return { ok: true };
    }
  }
  return { ok: false, error: 'Folio no encontrado.' };
}

/* ---------- Aplazo (desde Firebase) ---------- */

function aplazo_(action, data, props, lock) {
  const secret = props.getProperty('SHEETS_WEBHOOK_TOKEN');
  if (!secret || data.token !== secret) return { ok: false, status: 401, error: 'No autorizado.' };
  const sheet = getSheet_(props.getProperty('SHEET_ID'));
  if (action === 'aplazoPending') return { ok: true, rows: aplazoPending_(sheet) };

  const r = rowOfFolio_(sheet, data.folio);
  if (!r) return { ok: false, status: 404, error: 'Folio no encontrado.' };
  if (action === 'aplazoGet') return { ok: true, aplazo: readAplazo_(sheet, r) };

  lock.waitLock(20000);
  const cur = readAplazo_(sheet, r);
  if (action === 'aplazoReserve') {
    if ((cur.cartId || '') !== (data.expectedPrev || '')) {
      return { ok: false, status: 409, error: 'Otro link de Aplazo se generó al mismo tiempo. Intenta de nuevo.' };
    }
    writeAplazo_(sheet, r, { cartId: data.cartId, loanId: '', url: '', monto: num_(data.monto), estado: 'Reservado', reembolsado: 0 });
    return { ok: true };
  }
  if (action === 'aplazoUpdate') {
    if (cur.cartId !== data.cartId && !data.force) return { ok: true, ignored: 'carrito reemplazado' };
    const fields = Object.assign({}, data.fields || {});
    if (cur.cartId !== data.cartId) fields.cartId = data.cartId; // pago de un carrito anterior: se registra igual
    writeAplazo_(sheet, r, fields);
    return { ok: true };
  }
  return { ok: false, status: 400, error: 'Acción de Aplazo no reconocida.' };
}

function rowOfFolio_(sheet, folio) {
  const last = sheet.getLastRow();
  if (!folio || last < 2) return 0;
  const folios = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = folios.length - 1; i >= 0; i--) if (folios[i][0] === folio) return i + 2;
  return 0;
}

function readAplazo_(sheet, r) {
  const v = sheet.getRange(r, 1, 1, HEADERS.length).getValues()[0];
  const out = {};
  Object.keys(APLAZO_FIELDS).forEach(function (k) { out[k] = v[COL[APLAZO_FIELDS[k]]]; });
  out.cartId = String(out.cartId || '');
  out.loanId = String(out.loanId || '');
  out.estado = String(out.estado || '');
  out.monto = num_(out.monto);
  out.reembolsado = num_(out.reembolsado);
  out.actualizado = out.actualizado instanceof Date ? out.actualizado.toISOString() : String(out.actualizado || '');
  return out;
}

function writeAplazo_(sheet, r, fields) {
  fields.actualizado = new Date();
  Object.keys(fields).forEach(function (k) {
    if (!APLAZO_FIELDS[k]) return;
    const v = fields[k];
    sheet.getRange(r, COL[APLAZO_FIELDS[k]] + 1).setValue(typeof v === 'string' ? clip_(v, 500) : v);
  });
  SpreadsheetApp.flush();
}

function aplazoPending_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const rows = [];
  values.forEach(function (v, i) {
    if (APLAZO_PENDING.indexOf(String(v[COL['Aplazo estado']])) === -1) return;
    const a = readAplazo_(sheet, i + 2);
    a.folio = v[COL['Folio']];
    rows.push(a);
  });
  return rows;
}

/* ---------- Acceso ---------- */

function verifyUser_(idToken, props) {
  if (!idToken) throw new Error('Sesión no iniciada. Vuelve a iniciar sesión con Google.');
  const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), {
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error('Sesión no válida o vencida. Vuelve a iniciar sesión.');
  const info = JSON.parse(resp.getContentText());

  const clientId = props.getProperty('GOOGLE_CLIENT_ID');
  if (!clientId || info.aud !== clientId) throw new Error('El token no corresponde a esta aplicación.');
  if (info.email_verified !== 'true' && info.email_verified !== true) throw new Error('Tu correo de Google no está verificado.');
  if (Number(info.exp) * 1000 <= Date.now()) throw new Error('Sesión vencida. Vuelve a iniciar sesión.');

  const email = String(info.email || '').toLowerCase();
  const allowed = allowedEmails_(props);
  if (allowed.indexOf(email) === -1) throw new Error('Tu cuenta (' + email + ') no tiene acceso. Pide que te den de alta.');
  return email;
}

/**
 * Correos autorizados: ALLOWED_EMAILS (lista separada por comas) y/o
 * una propiedad por correo: ALLOWED_EMAIL1, ALLOWED_EMAIL2, ALLOWED_EMAIL3...
 */
function allowedEmails_(props) {
  const all = props.getProperties();
  const out = [];
  Object.keys(all).forEach(function (k) {
    if (/^ALLOWED_EMAILS?\d*$/i.test(k)) {
      String(all[k] || '').split(/[,;\s]+/).forEach(function (x) {
        const e = x.trim().toLowerCase();
        if (e && out.indexOf(e) === -1) out.push(e);
      });
    }
  });
  return out;
}

/* ---------- Utilidades ---------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function num_(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function clip_(v, max) {
  return String(v == null ? '' : v).slice(0, max);
}

function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'dd/MM/yyyy');
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(v || '');
}

function validate_(d) {
  if (!d.nombre || String(d.nombre).trim().length < 3) return 'Falta el nombre del cliente.';
  if (!/^\d{10}$/.test(String(d.telefono || ''))) return 'El teléfono debe tener 10 dígitos.';
  if (!d.marca) return 'Falta la marca y modelo.';
  if (!d.servicio) return 'Falta la descripción del servicio.';
  if (!d.fecha || !d.hora) return 'Falta la fecha u hora.';
  if (num_(d.anticipo) > num_(d.total) && num_(d.total) > 0) return 'El anticipo no puede superar el total.';
  if (!d.firmaPng || String(d.firmaPng).indexOf('data:image/png;base64,') !== 0) return 'Falta la firma del cliente.';
  if (!d.termsVersion) return 'Falta la versión de los términos aceptados.';
  return '';
}

function getSheet_(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#0F1115').setFontColor('#D9F84A');
    sheet.getRange(2, COL['Registrado'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sheet.getRange(2, COL['Presupuesto aprox. (MXN)'] + 1, sheet.getMaxRows() - 1, 4).setNumberFormat('$#,##0.00');
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build();
    sheet.getRange(2, COL['Estatus'] + 1, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
  } else if (sheet.getLastColumn() < HEADERS.length || sheet.getRange(1, HEADERS.length).getValue() !== HEADERS[HEADERS.length - 1]) {
    // Migración: hojas creadas con una versión anterior reciben las columnas nuevas.
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#0F1115').setFontColor('#D9F84A');
    sheet.getRange(2, COL['Capturado en (dispositivo)'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sheet.getRange(2, COL['Aplazo actualizado'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sheet.getRange(2, COL['Aplazo monto'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
    sheet.getRange(2, COL['Aplazo reembolsado'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
    sheet.getRange(2, COL['Abonos (MXN)'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
    sheet.getRange(2, COL['Liberada el'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build();
    sheet.getRange(2, COL['Estatus'] + 1, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
  }
  return sheet;
}

function nextFolio_(sheet) {
  const today = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  const prefix = 'ZE-' + today + '-';
  const last = sheet.getLastRow();
  let seq = 0;
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) {
      const f = String(r[0]);
      if (f.indexOf(prefix) === 0) seq = Math.max(seq, parseInt(f.slice(prefix.length), 10) || 0);
    });
  }
  return prefix + ('000' + (seq + 1)).slice(-4);
}

function saveSignature_(folderId, folio, dataUrl) {
  const bytes = Utilities.base64Decode(String(dataUrl).split(',')[1]);
  const blob = Utilities.newBlob(bytes, 'image/png', folio + '-firma.png');
  const file = DriveApp.getFolderById(folderId).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

/* Ejecutar una vez desde el editor para autorizar permisos. */
function autorizarPermisos() {
  const props = PropertiesService.getScriptProperties();
  getSheet_(props.getProperty('SHEET_ID'));
  DriveApp.getFolderById(props.getProperty('DRIVE_FOLDER_ID')).getName();
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
  Logger.log('Permisos correctos.');
}
