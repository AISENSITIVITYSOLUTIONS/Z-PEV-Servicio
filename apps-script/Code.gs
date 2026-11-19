/**
 * Z-PEV Servicio · Backend en Google Apps Script
 *
 * Acciones (POST con JSON en text/plain):
 *   create   Registra una orden: folio, firma PNG en Drive y fila en la hoja "Órdenes".
 *   list     Devuelve las últimas órdenes y el conteo del mes (historial de la app).
 *   addPayment  Registra un abono o la liquidación de un folio (hoja «Pagos») y recalcula el saldo.
 *   complete    Concluye y entrega la orden (Estatus = Completada) cuando el saldo es cero y genera
 *               el comprobante digital de entrega (PDF en Drive, mismo folio). Si ya estaba
 *               completada, devuelve el comprobante existente para reenviarlo.
 *   setPlan     Cambia el plan de pago: «Anticipo y liquidación» o «Varios pagos».
 *   deleteOrder Solo administradores (ADMIN_EMAILS): mueve la orden a la hoja «Órdenes eliminadas»
 *               con quién, cuándo y motivo, y la quita de «Órdenes». El folio no se reutiliza.
 *   payment  Uso interno de la función de cobros (Firebase): marca el pago del anticipo.
 *   sendNote Envía la nota de servicio (PDF adjunto) al WhatsApp del cliente con la API de WhatsApp
 *            Cloud (línea del bot Z·IA): sube el PDF a Meta y manda la plantilla WA_TEMPLATE con el
 *            documento como encabezado. Propiedades: WA_TOKEN, WA_PHONE_ID, WA_TEMPLATE, WA_TEMPLATE_LANG.
 *
 * GET ?action=receipt&f=<folio>&t=<token>  Comprobante público de entrega (solo lectura). El token es
 *   una firma HMAC del folio con RECEIPT_SECRET (se crea sola la primera vez); sin token válido no hay datos.
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
 *   ADMIN_EMAILS          Administradores (pueden eliminar órdenes), separados por coma. Si no existe,
 *                         se usan DEFAULT_ADMINS.
 */

const SHEET_NAME = 'Órdenes';
const TZ = 'America/Mexico_City';

const HEADERS = [
  'Folio', 'Registrado', 'Fecha de orden', 'Hora', 'Cliente', 'Teléfono', 'Marca y modelo', 'N° de serie',
  'Descripción del servicio', 'Características generales', 'Encendido',
  'Costo presupuesto (MXN)', 'Anticipo (MXN)', 'Total (MXN)', 'Saldo pendiente (MXN)',
  'Llaves o NFC', 'Cargador', 'Otros accesorios',
  'Términos aceptados', 'Versión de términos', 'Firma (enlace)', 'Estatus', 'Capturado por',
  'Pago anticipo', 'Referencia de pago',
  'ID de captura', 'Capturado en (dispositivo)',
  'Método de pago', 'Aplazo cartId', 'Aplazo loanId', 'Aplazo link', 'Aplazo monto', 'Aplazo estado',
  'Aplazo actualizado', 'Aplazo reembolsado', 'Aplazo generado por',
  'Plan de pago', 'Abonos (MXN)', 'Liberada por', 'Liberada el', 'Comprobante de entrega',
  'Foto principal', 'Fotos (carpeta)', 'N.º de fotos', 'Requiere factura', 'IVA (MXN)'
];
const DELETED_SHEET = 'Órdenes eliminadas';
// Folio actual ZPEV-26-0001; se siguen aceptando los anteriores ZE-0001 y ZE-AAAAMMDD-0001.
const FOLIO_RE = /^(?:ZPEV-\d{2}-\d{4,}|ZE-(?:\d{8}-)?\d{4,})$/;
const DEFAULT_ADMINS = ['fdealbam@nni.ai', 'fdealbam@gmail.com', 'estebans690@gmail.com'];
const PAYMENTS_SHEET = 'Pagos';
const PAYMENT_HEADERS = ['Folio', 'Fecha', 'Tipo', 'Monto (MXN)', 'Método', 'Nota', 'Registrado por', 'Saldo después (MXN)'];
const PAYMENT_METHODS = ['Efectivo', 'Tarjeta', 'Transferencia', 'Aplazo', 'Mercado Pago', 'Otro'];
const PLANS = ['Anticipo y liquidación', 'Varios pagos'];
// El «Costo presupuesto» es solo informativo (cotización aproximada) y no entra en ninguna suma.
// Total a pagar = Anticipo + IVA (16 % solo si el cliente requiere factura). Saldo = Total − pagos registrados.
const IVA_RATE = 0.16;
const r2_ = function (n) { return Math.round(n * 100) / 100; };
function totals_(anticipo, factura) {
  const a = r2_(Math.max(num_(anticipo), 0));
  const iva = factura ? r2_(a * IVA_RATE) : 0;
  return { anticipo: a, iva: iva, total: r2_(a + iva) };
}
const APLAZO_FIELDS = {
  cartId: 'Aplazo cartId', loanId: 'Aplazo loanId', url: 'Aplazo link', monto: 'Aplazo monto',
  estado: 'Aplazo estado', actualizado: 'Aplazo actualizado', reembolsado: 'Aplazo reembolsado', por: 'Aplazo generado por'
};
const APLAZO_PENDING = ['Reservado', 'Pendiente'];
const COL = HEADERS.reduce((m, h, i) => { m[h] = i; return m; }, {});
const STATUS_OPTIONS = ['Recibido', 'En reparación', 'Listo para entrega', 'Entregado', 'Anticipo pagado', 'Pagada', 'Completada'];

function doGet(e) {
  const q = (e && e.parameter) || {};
  if (q.action === 'receipt') {
    try {
      return json_(publicReceipt_(q));
    } catch (err) {
      return json_({ ok: false, error: 'No se pudo cargar el comprobante.' });
    }
  }
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
    if (!props.getProperty('COBRO_V2')) {
      lock.waitLock(20000);
      migrateCobros_(sheet, props);
      lock.releaseLock();
    }
    if (action === 'list') return json_(Object.assign(listOrders_(sheet, data.limit), { isAdmin: isAdmin_(email, props) }));
    if (action === 'deleteOrder') {
      if (!isAdmin_(email, props)) return json_({ ok: false, error: 'Solo un administrador puede eliminar órdenes.' });
      lock.waitLock(20000);
      return json_(deleteOrder_(sheet, data, email));
    }
    if (action === 'addPayment' || action === 'complete' || action === 'setPlan') {
      lock.waitLock(20000);
      if (action === 'addPayment') return json_(addPayment_(sheet, data, email));
      if (action === 'setPlan') return json_(setPlan_(sheet, data));
      return json_(completeOrder_(sheet, data, email));
    }
    if (action === 'detail') return json_(orderDetail_(sheet, data));
    if (action === 'sendNote') return json_(sendNoteWhatsApp_(data, props, email));
    if (action === 'photo') {
      lock.waitLock(20000);
      return json_(addPhoto_(sheet, data, props));
    }
    if (action !== 'create') return json_({ ok: false, error: 'Acción no reconocida.' });

    const problem = validate_(data);
    if (problem) return json_({ ok: false, error: problem });

    lock.waitLock(20000);

    // Idempotencia: un reintento desde la cola del teléfono no duplica la orden.
    const existing = findByClientId_(sheet, data.clientId);
    if (existing) return json_({ ok: true, folio: existing, duplicate: true, monthCount: monthCount_(sheet) });
    const same = findRecentSame_(sheet, data);
    // Misma orden capturada otra vez: se devuelve el folio existente y no se suben fotos de nuevo.
    if (same) return json_({ ok: true, folio: same, duplicate: true, skipPhotos: true, monthCount: monthCount_(sheet) });

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
    set('Costo presupuesto (MXN)', num_(data.presupuesto));
    const factura = data.factura === 'Sí';
    const t = totals_(data.anticipo, factura);
    set('Anticipo (MXN)', t.anticipo);
    set('Requiere factura', factura ? 'Sí' : 'No');
    set('IVA (MXN)', t.iva);
    set('Total (MXN)', t.total);
    set('Saldo pendiente (MXN)', t.total);
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
    if (isJpeg_(data.fotoPrincipal)) {
      const f = savePhoto_(props.getProperty('DRIVE_FOLDER_ID'), folio, 'vista', 'Vista completa', data.fotoPrincipal);
      set('Foto principal', f.url);
      set('Fotos (carpeta)', f.folderUrl);
      set('N.º de fotos', 1);
    }
    sheet.appendRow(row);
    SpreadsheetApp.flush();

    return json_({ ok: true, folio: folio, firmaUrl: firmaUrl, total: t.total, iva: t.iva, monthCount: monthCount_(sheet) });
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
      presupuesto: num_(r[COL['Costo presupuesto (MXN)']]),
      anticipo: num_(r[COL['Anticipo (MXN)']]),
      factura: r[COL['Requiere factura']] || '',
      iva: num_(r[COL['IVA (MXN)']]),
      total: num_(r[COL['Total (MXN)']]),
      saldo: num_(r[COL['Saldo pendiente (MXN)']]),
      estatus: r[COL['Estatus']],
      pago: r[COL['Pago anticipo']],
      firmaUrl: r[COL['Firma (enlace)']],
      plan: r[COL['Plan de pago']] || PLANS[0],
      abonos: num_(r[COL['Abonos (MXN)']]),
      comprobanteUrl: r[COL['Comprobante de entrega']] || '',
      receiptUrl: r[COL['Estatus']] === 'Completada' ? receiptUrl_(r[COL['Folio']]) : '',
      entregada: fmtDate_(r[COL['Liberada el']]),
      fotoId: driveId_(r[COL['Foto principal']]),
      fotosUrl: r[COL['Fotos (carpeta)']] || '',
      fotos: num_(r[COL['N.º de fotos']])
    };
  });
  return { ok: true, orders: orders, monthCount: monthCount_(sheet) };
}

function monthCount_(sheet) {
  const month = Utilities.formatDate(new Date(), TZ, 'yyyyMM');
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  return sheet.getRange(2, COL['Registrado'] + 1, last - 1, 1).getValues().filter(function (r) {
    return r[0] instanceof Date && Utilities.formatDate(r[0], TZ, 'yyyyMM') === month;
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

/**
 * Segunda defensa contra órdenes duplicadas: la misma orden (mismo teléfono, vehículo, serie,
 * servicio, estado y costo) registrada hace menos de DUP_WINDOW_MIN minutos devuelve el folio
 * existente. Cubre reenvíos desde versiones viejas de la app (sin ID de captura) y dobles toques.
 * Dos unidades iguales del mismo cliente se distinguen por la serie o por la descripción.
 */
const DUP_WINDOW_MIN = 10;
function findRecentSame_(sheet, data) {
  const last = sheet.getLastRow();
  if (last < 2) return '';
  const from = Math.max(2, last - 40);
  const rows = sheet.getRange(from, 1, last - from + 1, HEADERS.length).getValues();
  const norm = function (v) { return String(v == null ? '' : v).replace(/^'/, '').trim().toLowerCase(); };
  const want = [norm(data.telefono), norm(data.marca), norm(data.serie), norm(data.servicio), norm(data.caracteristicas)];
  const cost = num_(data.presupuesto);
  const limit = Date.now() - DUP_WINDOW_MIN * 60000;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const reg = r[COL['Registrado']];
    const at = reg instanceof Date ? reg.getTime() : new Date(reg).getTime();
    if (!at || at < limit) continue;
    const have = [norm(r[COL['Teléfono']]), norm(r[COL['Marca y modelo']]), norm(r[COL['N° de serie']]),
      norm(r[COL['Descripción del servicio']]), norm(r[COL['Características generales']])];
    if (have.join('|') === want.join('|') && num_(r[COL['Costo presupuesto (MXN)']]) === cost) return r[COL['Folio']];
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

/** Pago (anticipo, abono o liquidación). Saldo = Total − pagos registrados. Con saldo cero, Estatus = Pagada. */
function addPayment_(sheet, data, email) {
  const r = orderRow_(sheet, data.folio);
  if (!r) return { ok: false, error: 'Folio no encontrado.' };
  const o = orderSummary_(sheet, r);
  if (o.estatus === 'Completada') return { ok: false, error: 'La orden ya está completada y liberada.' };
  const monto = num_(data.monto);
  const saldo = Math.max(r2_(o.total - o.abonos), 0);
  if (saldo <= 0) return { ok: false, error: 'Esta orden no tiene saldo pendiente.' };
  if (!(monto > 0)) return { ok: false, error: 'Indica el monto del pago.' };
  if (monto > saldo) return { ok: false, error: 'El pago supera el saldo pendiente (' + saldo.toFixed(2) + ' MXN).' };
  if (o.plan !== 'Varios pagos' && monto !== saldo) {
    return { ok: false, error: 'Con plan «Anticipo y liquidación» el pago debe cubrir el saldo completo (' + saldo.toFixed(2) + ' MXN). Cambia el plan a «Varios pagos» para abonar.' };
  }
  const metodo = PAYMENT_METHODS.indexOf(data.metodo) >= 0 ? data.metodo : 'Otro';
  const nuevoSaldo = Math.round((saldo - monto) * 100) / 100;
  const abonos = Math.round((o.abonos + monto) * 100) / 100;
  const tipo = o.abonos === 0 && nuevoSaldo > 0 ? 'Anticipo' : nuevoSaldo === 0 ? 'Liquidación' : 'Abono';
  paymentsSheet_(sheet).appendRow([o.folio, new Date(), tipo, monto, metodo,
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

/** Concluye y entrega la orden: requiere saldo cero. Genera el comprobante digital de entrega. */
function completeOrder_(sheet, data, email) {
  const r = orderRow_(sheet, data.folio);
  if (!r) return { ok: false, error: 'Folio no encontrado.' };
  const o = orderSummary_(sheet, r);
  const props = PropertiesService.getScriptProperties();
  if (o.estatus === 'Completada') {
    let url = sheet.getRange(r, COL['Comprobante de entrega'] + 1).getValue();
    if (!url) {
      url = deliveryReceipt_(sheet, r, props.getProperty('DRIVE_FOLDER_ID'));
      sheet.getRange(r, COL['Comprobante de entrega'] + 1).setValue(url);
    }
    return Object.assign({ ok: true, estatus: 'Completada', comprobanteUrl: url, receiptUrl: receiptUrl_(o.folio), reenvio: true }, deliveryInfo_(sheet, r));
  }
  const saldo = Math.max(Math.round((o.total - o.anticipo - o.abonos) * 100) / 100, 0);
  if (saldo > 0) return { ok: false, error: 'No se puede entregar: falta pagar ' + saldo.toFixed(2) + ' MXN.' };
  sheet.getRange(r, COL['Estatus'] + 1).setValue('Completada');
  sheet.getRange(r, COL['Liberada por'] + 1).setValue(email);
  sheet.getRange(r, COL['Liberada el'] + 1).setValue(new Date());
  SpreadsheetApp.flush();
  const url = deliveryReceipt_(sheet, r, props.getProperty('DRIVE_FOLDER_ID'));
  sheet.getRange(r, COL['Comprobante de entrega'] + 1).setValue(url);
  SpreadsheetApp.flush();
  return Object.assign({ ok: true, estatus: 'Completada', comprobanteUrl: url, receiptUrl: receiptUrl_(o.folio) }, deliveryInfo_(sheet, r));
}

/* ---------- Comprobante público (página para el cliente) ---------- */

function receiptSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('RECEIPT_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('RECEIPT_SECRET', secret);
  }
  return secret;
}

function receiptToken_(folio) {
  const sig = Utilities.computeHmacSha256Signature(String(folio), receiptSecret_());
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '').slice(0, 24);
}

function receiptUrl_(folio) {
  const base = PropertiesService.getScriptProperties().getProperty('PUBLIC_BASE_URL') || 'https://z-pev-servicio.web.app';
  return base + '/comprobante.html?f=' + encodeURIComponent(folio) + '&t=' + receiptToken_(folio);
}

/** Datos mínimos para la página del cliente: sin teléfono completo ni correos del personal. */
function publicReceipt_(q) {
  const folio = String(q.f || '');
  if (!FOLIO_RE.test(folio)) return { ok: false, error: 'Comprobante no válido.' };
  const expected = receiptToken_(folio);
  const got = String(q.t || '');
  let diff = expected.length ^ got.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (got.charCodeAt(i) || 0);
  if (diff !== 0) return { ok: false, error: 'Comprobante no válido.' };

  const props = PropertiesService.getScriptProperties();
  const sheet = getSheet_(props.getProperty('SHEET_ID'));
  const r = orderRow_(sheet, folio);
  if (!r) return { ok: false, error: 'Comprobante no encontrado.' };
  const v = sheet.getRange(r, 1, 1, HEADERS.length).getValues()[0];
  if (v[COL['Estatus']] !== 'Completada') return { ok: false, error: 'Este servicio aún no ha sido entregado.' };

  const total = num_(v[COL['Total (MXN)']]);
  const anticipo = num_(v[COL['Anticipo (MXN)']]);
  const pagos = [];
  if (anticipo > 0 && !v[COL['Requiere factura']]) pagos.push({ concepto: 'Anticipo', fecha: fmtDateTime_(v[COL['Registrado']]), metodo: String(v[COL['Método de pago']] || ''), monto: anticipo });
  paymentsOf_(sheet, folio).forEach(function (p) {
    pagos.push({ concepto: p.tipo, fecha: fmtDateTime_(p.fecha), metodo: p.metodo, monto: p.monto });
  });
  const pagado = pagos.reduce(function (a, p) { return a + p.monto; }, 0);
  const tel = String(v[COL['Teléfono']]).replace(/\D/g, '');
  return {
    ok: true,
    folio: folio,
    cliente: String(v[COL['Cliente']] || ''),
    telefono: tel ? '•• •••• ' + tel.slice(-4) : '',
    vehiculo: String(v[COL['Marca y modelo']] || ''),
    serie: String(v[COL['N° de serie']] || ''),
    servicio: String(v[COL['Descripción del servicio']] || ''),
    recepcion: fmtDate_(v[COL['Fecha de orden']]) + (v[COL['Hora']] ? ' · ' + v[COL['Hora']] : ''),
    entrega: fmtDateTime_(v[COL['Liberada el']]),
    total: total,
    pagado: Math.round(pagado * 100) / 100,
    saldo: Math.max(Math.round((total - pagado) * 100) / 100, 0),
    pagos: pagos,
    pdfUrl: String(v[COL['Comprobante de entrega']] || '')
  };
}

function deliveryInfo_(sheet, r) {
  const v = sheet.getRange(r, 1, 1, HEADERS.length).getValues()[0];
  return {
    folio: v[COL['Folio']], cliente: v[COL['Cliente']], telefono: String(v[COL['Teléfono']]).replace(/^'/, ''),
    marca: v[COL['Marca y modelo']], total: num_(v[COL['Total (MXN)']]),
    entregada: fmtDate_(v[COL['Liberada el']])
  };
}

function paymentsOf_(sheet, folio) {
  const p = sheet.getParent().getSheetByName(PAYMENTS_SHEET);
  if (!p || p.getLastRow() < 2) return [];
  return p.getRange(2, 1, p.getLastRow() - 1, PAYMENT_HEADERS.length).getValues()
    .filter(function (x) { return x[0] === folio; })
    .map(function (x) { return { fecha: x[1], tipo: x[2], monto: num_(x[3]), metodo: x[4] }; });
}

function esc_(v) {
  return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function money_(n) {
  return '$' + num_(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtDateTime_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'dd/MM/yyyy HH:mm') : String(v || '');
}

/** Imagen pública de la app como data URI (logo y sello del comprobante). */
function brandImage_(path) {
  try {
    const base = PropertiesService.getScriptProperties().getProperty('PUBLIC_BASE_URL') || 'https://z-pev-servicio.web.app';
    const res = UrlFetchApp.fetch(base + path, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return '';
    return 'data:image/png;base64,' + Utilities.base64Encode(res.getBlob().getBytes());
  } catch (e) {
    return '';
  }
}

/** PDF «Comprobante de servicio concluido y entregado», con el mismo folio de la orden. */
function deliveryReceipt_(sheet, r, folderId) {
  const v = sheet.getRange(r, 1, 1, HEADERS.length).getValues()[0];
  const folio = v[COL['Folio']];
  const total = num_(v[COL['Total (MXN)']]);
  const anticipo = num_(v[COL['Anticipo (MXN)']]);
  const pagos = paymentsOf_(sheet, folio);
  const filas = [];
  if (anticipo > 0 && !v[COL['Requiere factura']]) {
    filas.push(['Anticipo', fmtDateTime_(v[COL['Registrado']]), String(v[COL['Método de pago']] || '—'), anticipo]);
  }
  pagos.forEach(function (p) { filas.push([p.tipo, fmtDateTime_(p.fecha), p.metodo, p.monto]); });
  const pagado = filas.reduce(function (a, f) { return a + num_(f[3]); }, 0);
  const logo = brandImage_('/brand/z-logo.png');
  const sello = brandImage_('/brand/sello-entrega.png');
  const INK = '#121418', RED = '#D7262E', MUTED = '#6B7078', LINE = '#E4E1DA', PAPER = '#FBFAF7';
  const tr = filas.map(function (f, i) {
    const bg = i % 2 ? '#FFFFFF' : '#F6F4EF';
    return '<tr style="background:' + bg + '"><td class="c">' + esc_(f[0]) + '</td><td class="c">' + esc_(f[1]) +
      '</td><td class="c">' + esc_(f[2] || '—') + '</td><td class="c n">' + money_(f[3]) + '</td></tr>';
  }).join('');
  const dato = function (k, val) {
    return '<tr><td class="k">' + k + '</td><td class="v">' + val + '</td></tr>';
  };
  const html = '<html><head><meta charset="utf-8"><style>' +
    '@page{margin:0}body{margin:0;font-family:Helvetica,Arial,sans-serif;color:' + INK + ';font-size:10.5pt;background:' + PAPER + '}' +
    '.band{background:' + INK + ';color:#FFFFFF;padding:26px 40px 22px}' +
    '.band td{vertical-align:middle;color:#FFFFFF}.brand{font-size:8.5pt;letter-spacing:2.5pt;color:#B9BDC4}' +
    '.title{font-family:Georgia,"Times New Roman",serif;font-size:22pt;line-height:1.15;margin-top:6px}' +
    '.redline{height:4px;background:' + RED + '}.silverline{height:2px;background:#C9CDD3}' +
    '.wrap{padding:26px 40px 10px}' +
    '.card{border:1px solid ' + LINE + ';background:#FFFFFF;border-bottom:4px solid #DCD8CF;border-right:3px solid #E7E3DB;padding:18px 20px;margin-bottom:16px}' +
    '.eyebrow{font-size:7.5pt;letter-spacing:2pt;color:' + MUTED + ';text-transform:uppercase}' +
    '.folio{font-family:"Courier New",monospace;font-size:20pt;font-weight:bold;letter-spacing:1.5pt;margin-top:4px}' +
    '.status{display:inline-block;margin-top:10px;background:' + RED + ';color:#FFFFFF;font-size:8.5pt;font-weight:bold;letter-spacing:1pt;padding:6px 12px}' +
    'table{border-collapse:collapse;width:100%}.k{width:30%;color:' + MUTED + ';font-size:9pt;padding:7px 0;border-bottom:1px solid ' + LINE + ';vertical-align:top}' +
    '.v{padding:7px 0;border-bottom:1px solid ' + LINE + ';vertical-align:top}' +
    '.h th{font-size:7.5pt;letter-spacing:1.2pt;color:' + MUTED + ';text-transform:uppercase;text-align:left;padding:0 8px 7px;font-weight:normal;border-bottom:1.5px solid ' + INK + '}' +
    '.c{padding:8px;vertical-align:top}.n{text-align:right;white-space:nowrap;font-family:"Courier New",monospace}' +
    '.tot td{padding:8px;border-top:1px solid ' + LINE + '}.grand td{background:' + INK + ';color:#FFFFFF;font-weight:bold;padding:10px 8px}' +
    '.thanks{font-family:Georgia,"Times New Roman",serif;font-size:12.5pt;line-height:1.5;color:' + INK + '}' +
    '.foot{padding:14px 40px 24px;font-size:8pt;color:' + MUTED + ';line-height:1.5}' +
    '</style></head><body>' +
    '<div class="band"><table><tr>' +
      '<td>' + (logo ? '<img src="' + logo + '" style="height:46px;background:#FFFFFF;padding:6px 8px">' : '<b>Z e-Scooters México</b>') + '</td>' +
      '<td style="text-align:right"><div class="brand">COMPROBANTE DE ENTREGA</div>' +
      '<div class="title">Servicio concluido<br>y entregado</div></td>' +
    '</tr></table></div><div class="redline"></div><div class="silverline"></div>' +
    '<div class="wrap">' +
      '<div class="card"><table><tr><td style="vertical-align:middle">' +
        '<div class="eyebrow">Folio de la orden de servicio</div>' +
        '<div class="folio">' + esc_(folio) + '</div>' +
        '<div class="status">PAGADO EN SU TOTALIDAD · ' + money_(total) + ' MXN</div>' +
      '</td><td style="width:120px;text-align:right;vertical-align:middle">' +
        (sello ? '<img src="' + sello + '" style="width:112px;height:112px">' : '') +
      '</td></tr></table></div>' +
      '<div class="card"><div class="eyebrow" style="margin-bottom:6px">Datos del servicio</div><table>' +
        dato('Cliente', esc_(v[COL['Cliente']])) +
        dato('Vehículo', esc_(v[COL['Marca y modelo']]) + (v[COL['N° de serie']] ? ' &nbsp;·&nbsp; Serie ' + esc_(v[COL['N° de serie']]) : '')) +
        dato('Servicio realizado', esc_(v[COL['Descripción del servicio']])) +
        dato('Recepción', esc_(fmtDate_(v[COL['Fecha de orden']])) + ' &nbsp;' + esc_(v[COL['Hora']])) +
        dato('Entrega', esc_(fmtDateTime_(v[COL['Liberada el']]))) +
      '</table></div>' +
      '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Pagos recibidos</div><table>' +
        '<tr class="h"><th>Concepto</th><th>Fecha</th><th>Método</th><th style="text-align:right">Monto</th></tr>' + tr +
        (num_(v[COL['IVA (MXN)']]) > 0 ? '<tr class="tot"><td class="c" colspan="3">IVA 16 % (factura)</td><td class="c n">' + money_(num_(v[COL['IVA (MXN)']])) + '</td></tr>' : '') +
        '<tr class="tot"><td class="c" colspan="3">Total del servicio</td><td class="c n">' + money_(total) + '</td></tr>' +
        '<tr class="tot"><td class="c" colspan="3">Total pagado</td><td class="c n">' + money_(pagado) + '</td></tr>' +
        '<tr class="grand"><td colspan="3">Saldo pendiente</td><td class="n">' + money_(Math.max(total - pagado, 0)) + '</td></tr>' +
      '</table></div>' +
      '<p class="thanks">Gracias por confiar su vehículo a Z e-Scooters México. Su servicio fue concluido y entregado conforme a la orden ' + esc_(folio) + '. Quedamos a sus órdenes para cualquier aclaración.</p>' +
    '</div>' +
    '<div class="foot">Z e-Scooters México · Av. Patriotismo 176, Ciudad de México · Tel. 55 6501 8583<br>' +
      'Documento emitido el ' + esc_(fmtDateTime_(new Date())) + ' por Z-PEV Servicio. Complementa la orden de servicio ' + esc_(folio) +
      ' y no sustituye a la factura (CFDI).</div>' +
    '</body></html>';
  const pdf = Utilities.newBlob(html, 'text/html', folio + '-entrega.html').getAs('application/pdf').setName(folio + '-comprobante-entrega.pdf');
  const file = DriveApp.getFolderById(folderId).createFile(pdf);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
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
      if (approved) {
        sheet.getRange(r, COL['Estatus'] + 1).setValue('Anticipo pagado');
        const v = sheet.getRange(r, 1, 1, HEADERS.length).getValues()[0];
        if (v[COL['Requiere factura']]) {
          const monto = num_(data.amount) || num_(v[COL['Total (MXN)']]);
          const abonos = r2_(num_(v[COL['Abonos (MXN)']]) + monto);
          const saldo = Math.max(r2_(num_(v[COL['Total (MXN)']]) - abonos), 0);
          sheet.getRange(r, COL['Abonos (MXN)'] + 1).setValue(abonos);
          sheet.getRange(r, COL['Saldo pendiente (MXN)'] + 1).setValue(saldo);
          paymentsSheet_(sheet).appendRow([data.folio, new Date(), 'Anticipo', monto, String(data.method || 'En línea').slice(0, 40), String(data.paymentId || ''), 'sistema', saldo]);
        }
      }
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

/* ---------- Eliminar orden (solo administradores) ---------- */

function isAdmin_(email, props) {
  const raw = props.getProperty('ADMIN_EMAILS');
  const list = raw ? raw.split(/[,;\s]+/) : DEFAULT_ADMINS;
  return list.map(function (x) { return x.trim().toLowerCase(); }).indexOf(String(email || '').toLowerCase()) >= 0;
}

function deletedSheet_(sheet) {
  const ss = sheet.getParent();
  let d = ss.getSheetByName(DELETED_SHEET);
  if (!d) {
    d = ss.insertSheet(DELETED_SHEET);
    const head = HEADERS.concat(['Eliminada por', 'Eliminada el', 'Motivo de eliminación']);
    d.appendRow(head);
    d.setFrozenRows(1);
    d.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#5A1A1E').setFontColor('#FFFFFF');
  }
  return d;
}

/** Archiva la fila en «Órdenes eliminadas» y la quita de «Órdenes». */
function deleteOrder_(sheet, data, email) {
  const r = orderRow_(sheet, data.folio);
  if (!r) return { ok: false, error: 'Folio no encontrado.' };
  const motivo = clip_(String(data.motivo || '').trim(), 300);
  if (motivo.length < 3) return { ok: false, error: 'Indica el motivo de la eliminación.' };
  const row = sheet.getRange(r, 1, 1, HEADERS.length).getValues()[0];
  deletedSheet_(sheet).appendRow(row.concat([email, new Date(), motivo]));
  sheet.deleteRow(r);
  SpreadsheetApp.flush();
  return { ok: true, folio: data.folio, monthCount: monthCount_(sheet) };
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
    sheet.getRange(2, COL['Costo presupuesto (MXN)'] + 1, sheet.getMaxRows() - 1, 4).setNumberFormat('$#,##0.00');
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build();
    sheet.getRange(2, COL['Estatus'] + 1, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
  } else if (ensureColumns_(sheet) && sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0].join('|') !== HEADERS.join('|')) {
    // Migración: hojas creadas con una versión anterior reciben las columnas nuevas.
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#0F1115').setFontColor('#D9F84A');
    sheet.getRange(2, COL['Capturado en (dispositivo)'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sheet.getRange(2, COL['Aplazo actualizado'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sheet.getRange(2, COL['Aplazo monto'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
    sheet.getRange(2, COL['Aplazo reembolsado'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
    sheet.getRange(2, COL['Abonos (MXN)'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
    sheet.getRange(2, COL['IVA (MXN)'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00');
    sheet.getRange(2, COL['Liberada el'] + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build();
    sheet.getRange(2, COL['Estatus'] + 1, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
  }
  return sheet;
}

function ensureColumns_(sheet) {
  const missing = HEADERS.length - sheet.getMaxColumns();
  if (missing > 0) sheet.insertColumnsAfter(sheet.getMaxColumns(), missing);
  return true;
}

/**
 * Folio consecutivo por año: ZPEV-26-0001, ZPEV-26-0002… y en 2027 empieza en ZPEV-27-0001.
 * El contador vive en la propiedad FOLIO_SEQ_<AA>. Si falta, se reconstruye con el mayor folio
 * ZPEV del año en la hoja y en «Órdenes eliminadas», así nunca se repite. Se llama con el candado tomado.
 */
function nextFolio_(sheet) {
  const props = PropertiesService.getScriptProperties();
  const yy = Utilities.formatDate(new Date(), TZ, 'yy');
  const key = 'FOLIO_SEQ_' + yy;
  let seq = parseInt(props.getProperty(key), 10);
  if (!(seq >= 0)) {
    seq = 0;
    const re = new RegExp('^ZPEV-' + yy + '-(\\d+)$');
    [sheet, sheet.getParent().getSheetByName(DELETED_SHEET)].forEach(function (sh) {
      if (!sh) return;
      const last = sh.getLastRow();
      if (last < 2) return;
      sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) {
        const m = String(r[0]).match(re);
        if (m) seq = Math.max(seq, parseInt(m[1], 10));
      });
    });
  }
  seq += 1;
  props.setProperty(key, String(seq));
  return 'ZPEV-' + yy + '-' + ('000' + seq).slice(-Math.max(4, String(seq).length));
}

/* ---------- Migración única al nuevo esquema de cobro ---------- */

/**
 * Órdenes abiertas creadas antes del cambio: el presupuesto deja de ser el total.
 * Total = Anticipo (sin factura), Saldo = Total − pagos registrados (un anticipo ya pagado en línea cuenta como pago).
 * Las órdenes Pagadas o Completadas no se tocan. Se ejecuta una sola vez (propiedad COBRO_V2).
 */
function migrateCobros_(sheet, props) {
  if (props.getProperty('COBRO_V2')) return;
  const last = sheet.getLastRow();
  if (last >= 2) {
    const n = last - 1;
    // Solo se leen y escriben las columnas de cobro, para no alterar teléfonos, fechas ni enlaces.
    const col = function (h) { return sheet.getRange(2, COL[h] + 1, n, 1); };
    const read = function (h) { return col(h).getValues(); };
    const folio = read('Folio'), estatus = read('Estatus'), factura = read('Requiere factura'), pago = read('Pago anticipo');
    const anticipo = read('Anticipo (MXN)'), abonos = read('Abonos (MXN)'), iva = read('IVA (MXN)');
    const total = read('Total (MXN)'), saldo = read('Saldo pendiente (MXN)');
    for (let i = 0; i < n; i++) {
      if (!folio[i][0] || factura[i][0]) continue;
      if (estatus[i][0] === 'Pagada' || estatus[i][0] === 'Completada') continue;
      const a = num_(anticipo[i][0]);
      let ab = num_(abonos[i][0]);
      if (pago[i][0] === 'Pagado') ab = r2_(ab + a);
      factura[i][0] = 'No';
      iva[i][0] = 0;
      total[i][0] = a;
      abonos[i][0] = ab;
      saldo[i][0] = Math.max(r2_(a - ab), 0);
    }
    col('Requiere factura').setValues(factura);
    col('IVA (MXN)').setValues(iva);
    col('Total (MXN)').setValues(total);
    col('Abonos (MXN)').setValues(abonos);
    col('Saldo pendiente (MXN)').setValues(saldo);
    SpreadsheetApp.flush();
  }
  props.setProperty('COBRO_V2', new Date().toISOString());
}

/* ---------- Nota de servicio ---------- */

function driveDataUrl_(url, mime) {
  const id = driveId_(url);
  if (!id) return '';
  try {
    const blob = DriveApp.getFileById(id).getBlob();
    return 'data:' + (mime || blob.getContentType()) + ';base64,' + Utilities.base64Encode(blob.getBytes());
  } catch (err) {
    return '';
  }
}

/** Datos completos de una orden para la nota de servicio (incluye firma y foto principal). */
function orderDetail_(sheet, data) {
  const r = orderRow_(sheet, data.folio);
  if (!r) return { ok: false, error: 'Folio no encontrado.' };
  const v = sheet.getRange(r, 1, 1, HEADERS.length).getValues()[0];
  const g = function (h) { return v[COL[h]]; };
  const fecha = g('Fecha de orden');
  const hora = g('Hora');
  return {
    ok: true,
    order: {
      folio: g('Folio'),
      fecha: fecha instanceof Date ? Utilities.formatDate(fecha, TZ, 'yyyy-MM-dd') : String(fecha || ''),
      hora: hora instanceof Date ? Utilities.formatDate(hora, TZ, 'HH:mm') : String(hora || '').slice(0, 5),
      nombre: g('Cliente'),
      telefono: String(g('Teléfono')).replace(/^'/, ''),
      marca: g('Marca y modelo'),
      serie: g('N° de serie'),
      encendido: g('Encendido'),
      servicio: g('Descripción del servicio'),
      caracteristicas: g('Características generales'),
      llaves: g('Llaves o NFC'),
      cargador: g('Cargador'),
      otros: g('Otros accesorios'),
      presupuesto: num_(g('Costo presupuesto (MXN)')),
      factura: g('Requiere factura') || 'No',
      iva: num_(g('IVA (MXN)')),
      anticipo: num_(g('Anticipo (MXN)')),
      total: num_(g('Total (MXN)')),
      saldo: num_(g('Saldo pendiente (MXN)')),
      estatus: g('Estatus'),
      fotos: num_(g('N.º de fotos')),
      fotosUrl: g('Fotos (carpeta)') || '',
      firmaUrl: driveDataUrl_(g('Firma (enlace)'), 'image/png'),
      fotoUrl: driveDataUrl_(g('Foto principal'), 'image/jpeg')
    }
  };
}

/* ---------- Fotos del vehículo ---------- */

const MAX_PHOTO_CHARS = 4 * 1024 * 1024; // ≈3 MB de JPEG en base64

function isJpeg_(dataUrl) {
  return typeof dataUrl === 'string' && dataUrl.indexOf('data:image/jpeg;base64,') === 0 && dataUrl.length < MAX_PHOTO_CHARS;
}

function driveId_(url) {
  const m = String(url || '').match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

/** Carpeta Fotos/<folio> dentro de la carpeta de firmas. */
function photoFolder_(rootId, folio) {
  const root = DriveApp.getFolderById(rootId);
  const it = root.getFoldersByName('Fotos');
  const fotos = it.hasNext() ? it.next() : root.createFolder('Fotos');
  const f = fotos.getFoldersByName(folio);
  if (f.hasNext()) return f.next();
  const folder = fotos.createFolder(folio);
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return folder;
}

/** Guarda una foto como <folio>-<slot>.jpg; si ya existe (reintento) no la duplica. */
function savePhoto_(rootId, folio, slot, label, dataUrl) {
  const folder = photoFolder_(rootId, folio);
  const safeSlot = String(slot).replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'foto';
  const name = folio + '-' + safeSlot + '.jpg';
  const existing = folder.getFilesByName(name);
  let file;
  if (existing.hasNext()) {
    file = existing.next();
  } else {
    const blob = Utilities.newBlob(Utilities.base64Decode(dataUrl.split(',')[1]), 'image/jpeg', name);
    file = folder.createFile(blob);
    file.setDescription(clip_(label, 80));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }
  let count = 0;
  const all = folder.getFiles();
  while (all.hasNext()) { all.next(); count += 1; }
  return { url: file.getUrl(), folderUrl: folder.getUrl(), count: count };
}

/** Acción photo: agrega una foto a una orden existente. Solo desde el mismo equipo que la capturó. */
function addPhoto_(sheet, data, props) {
  if (!FOLIO_RE.test(String(data.folio || ''))) return { ok: false, error: 'Folio inválido.' };
  if (!isJpeg_(data.dataUrl)) return { ok: false, error: 'La foto no es válida o es demasiado grande.' };
  const r = orderRow_(sheet, data.folio);
  if (!r) return { ok: false, error: 'Folio no encontrado.' };
  const capturedId = sheet.getRange(r, COL['ID de captura'] + 1).getValue();
  if (capturedId && data.clientId !== capturedId) return { ok: false, error: 'La foto no corresponde a esta orden.' };
  const f = savePhoto_(props.getProperty('DRIVE_FOLDER_ID'), data.folio, data.slot, data.label, data.dataUrl);
  if (data.slot === 'vista' || !sheet.getRange(r, COL['Foto principal'] + 1).getValue()) {
    sheet.getRange(r, COL['Foto principal'] + 1).setValue(f.url);
  }
  sheet.getRange(r, COL['Fotos (carpeta)'] + 1).setValue(f.folderUrl);
  sheet.getRange(r, COL['N.º de fotos'] + 1).setValue(f.count);
  return { ok: true, folio: data.folio, fotos: f.count };
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


// ---------- Nota de servicio por WhatsApp (API de WhatsApp Cloud) ----------
//
// Propiedades del script:
//   WA_TOKEN          Token permanente del System User de Meta (el mismo del bot Z·IA, empieza con EAA).
//   WA_PHONE_ID       PHONE_NUMBER_ID de la línea que envía (Z·IA: 1451228848071523).
//   WA_TEMPLATE       Nombre de la plantilla aprobada (categoría Utilidad, encabezado Documento),
//                     cuerpo con 3 variables: {{1}} nombre, {{2}} folio, {{3}} total a pagar.
//   WA_TEMPLATE_LANG  Idioma de la plantilla (por omisión es_MX).
// Sin WA_TEMPLATE se intenta un mensaje de documento directo, que Meta solo entrega si el cliente
// escribió a la línea en las últimas 24 h.
const WA_GRAPH_ = 'https://graph.facebook.com/v23.0/';

function sendNoteWhatsApp_(data, props, email) {
  const token = props.getProperty('WA_TOKEN');
  const phoneId = props.getProperty('WA_PHONE_ID');
  if (!token || !phoneId) return { ok: false, error: 'Falta configurar WA_TOKEN y WA_PHONE_ID en el backend.' };

  const tel = String(data.telefono || '').replace(/\D/g, '').slice(-10);
  if (tel.length !== 10) return { ok: false, error: 'La orden no tiene un teléfono de 10 dígitos.' };
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(data.dataUrl || ''));
  if (!m) return { ok: false, error: 'No llegó el archivo de la nota.' };

  const folio = String(data.folio || '').slice(0, 40);
  const fileName = String(data.fileName || ('Nota-' + folio + '.pdf')).replace(/[^\w.\-]/g, '_');
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], fileName);
  const isPdf = m[1] === 'application/pdf';

  // 1) Subir el archivo a Meta.
  const up = UrlFetchApp.fetch(WA_GRAPH_ + phoneId + '/media', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + token },
    payload: { messaging_product: 'whatsapp', type: m[1], file: blob },
    muteHttpExceptions: true
  });
  const upJson = JSON.parse(up.getContentText() || '{}');
  if (!upJson.id) return { ok: false, error: 'Meta no aceptó el archivo: ' + waError_(upJson) };

  const media = isPdf ? { id: upJson.id, filename: fileName } : { id: upJson.id };
  const to = '52' + tel;
  const template = props.getProperty('WA_TEMPLATE');
  let msg;
  if (template) {
    msg = {
      messaging_product: 'whatsapp', to: to, type: 'template',
      template: {
        name: template,
        language: { code: props.getProperty('WA_TEMPLATE_LANG') || 'es_MX' },
        components: [
          { type: 'header', parameters: [isPdf ? { type: 'document', document: media } : { type: 'image', image: media }] },
          { type: 'body', parameters: [
            { type: 'text', text: String(data.nombre || 'cliente').slice(0, 60) },
            { type: 'text', text: folio },
            { type: 'text', text: String(data.total || '$0.00') }
          ] }
        ]
      }
    };
  } else {
    msg = { messaging_product: 'whatsapp', to: to, type: isPdf ? 'document' : 'image' };
    msg[msg.type] = Object.assign({}, media, { caption: String(data.mensaje || ('Nota de servicio ' + folio + ' · Z e-Scooters México')).slice(0, 1000) });
  }

  // 2) Enviar al número del cliente.
  const res = UrlFetchApp.fetch(WA_GRAPH_ + phoneId + '/messages', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(msg), muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText() || '{}');
  const id = json.messages && json.messages[0] && json.messages[0].id;
  logWhatsApp_(props, { folio: folio, tel: tel, email: email, ok: !!id, detalle: id || waError_(json) });
  if (!id) return { ok: false, error: 'WhatsApp no envió la nota: ' + waError_(json) };
  return { ok: true, messageId: id, to: tel };
}

function waError_(j) {
  const e = (j && j.error) || {};
  return [e.code, e.error_data && e.error_data.details, e.message].filter(Boolean).join(' · ') || 'respuesta sin detalle';
}

// Bitácora en la pestaña «WhatsApp» de la hoja.
function logWhatsApp_(props, r) {
  try {
    const ss = SpreadsheetApp.openById(props.getProperty('SHEET_ID'));
    const sh = ss.getSheetByName('WhatsApp') || ss.insertSheet('WhatsApp');
    if (sh.getLastRow() === 0) sh.appendRow(['Fecha', 'Folio', 'Teléfono', 'Enviado por', 'Resultado', 'Detalle']);
    sh.appendRow([new Date(), r.folio, r.tel, r.email, r.ok ? 'Enviado' : 'Error', r.detalle]);
  } catch (_) { /* la bitácora no debe impedir el envío */ }
}
