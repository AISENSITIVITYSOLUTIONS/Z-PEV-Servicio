/**
 * Z-PEV Servicio · Backend en Google Apps Script
 *
 * Acciones (POST con JSON en text/plain):
 *   create   Registra una orden: folio, firma PNG en Drive y fila en la hoja "Órdenes".
 *   list     Devuelve las últimas órdenes y el conteo del mes (historial de la app).
 *   payment  Uso interno de la función de cobros (Firebase): marca el pago del anticipo.
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
  'ID de captura', 'Capturado en (dispositivo)'
];
const COL = HEADERS.reduce((m, h, i) => { m[h] = i; return m; }, {});
const STATUS_OPTIONS = ['Recibido', 'En reparación', 'Listo para entrega', 'Entregado', 'Anticipo pagado'];

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

    let email;
    try {
      email = verifyUser_(data.idToken, props);
    } catch (authErr) {
      return json_({ ok: false, error: authErr.message });
    }

    const sheet = getSheet_(props.getProperty('SHEET_ID'));
    if (action === 'list') return json_(listOrders_(sheet, data.limit));
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
      firmaUrl: r[COL['Firma (enlace)']]
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
      return { ok: true };
    }
  }
  return { ok: false, error: 'Folio no encontrado.' };
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
