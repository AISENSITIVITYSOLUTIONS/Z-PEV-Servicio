/**
 * Z e-Scooters MX · Orden de servicio · Backend
 *
 * Recibe la orden desde la app web, asigna folio, guarda la firma (PNG) en Drive
 * y agrega una fila a la hoja "Órdenes".
 *
 * Propiedades del script (Configuración del proyecto → Propiedades del script):
 *   ACCESS_KEY        Clave que escribe el personal en la app (cámbiala por una propia).
 *   SHEET_ID          ID de la hoja de cálculo (el tramo entre /d/ y /edit en la URL).
 *   DRIVE_FOLDER_ID   ID de la carpeta de Drive donde se guardan las firmas.
 */

const SHEET_NAME = 'Órdenes';

const HEADERS = [
  'Folio',
  'Registrado',
  'Fecha de orden',
  'Hora',
  'Cliente',
  'Teléfono',
  'Marca y modelo',
  'N° de serie',
  'Descripción del servicio',
  'Características generales',
  'Encendido',
  'Presupuesto aprox. (MXN)',
  'Anticipo (MXN)',
  'Total (MXN)',
  'Saldo pendiente (MXN)',
  'Llaves o NFC',
  'Cargador',
  'Otros accesorios',
  'Términos aceptados',
  'Versión de términos',
  'Firma (enlace)',
  'Estatus',
  'Capturado desde'
];

function doGet() {
  return json_({ ok: true, service: 'zescooters-orden-servicio', time: new Date().toISOString() });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    const props = PropertiesService.getScriptProperties();
    const data = JSON.parse(e.postData.contents || '{}');

    if (!data.clave || data.clave !== props.getProperty('ACCESS_KEY')) {
      return json_({ ok: false, error: 'Clave de acceso incorrecta.' });
    }

    const problem = validate_(data);
    if (problem) return json_({ ok: false, error: problem });

    const sheet = getSheet_(props.getProperty('SHEET_ID'));
    const folio = nextFolio_(sheet);
    const firmaUrl = saveSignature_(props.getProperty('DRIVE_FOLDER_ID'), folio, data.firmaPng);
    const now = new Date();

    sheet.appendRow([
      folio,
      now,
      data.fecha,
      data.hora,
      data.nombre,
      data.telefono,
      data.marca,
      data.serie || '',
      data.servicio,
      data.caracteristicas || '',
      data.encendido,
      num_(data.presupuesto),
      num_(data.anticipo),
      num_(data.total),
      num_(data.saldo),
      data.llaves || '',
      data.cargador || '',
      data.otros || '',
      'Sí',
      data.termsVersion || '',
      firmaUrl,
      'Recibido',
      'App de órdenes'
    ]);

    return json_({ ok: true, folio: folio, firmaUrl: firmaUrl });
  } catch (err) {
    return json_({ ok: false, error: 'Error del servidor: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Helpers ---------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function num_(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function validate_(d) {
  if (!d.nombre || String(d.nombre).trim().length < 3) return 'Falta el nombre del cliente.';
  if (!/^\d{10}$/.test(String(d.telefono || ''))) return 'El teléfono debe tener 10 dígitos.';
  if (!d.marca) return 'Falta la marca y modelo.';
  if (!d.servicio) return 'Falta la descripción del servicio.';
  if (!d.fecha || !d.hora) return 'Falta la fecha u hora.';
  if (!d.firmaPng || String(d.firmaPng).indexOf('data:image/png;base64,') !== 0) return 'Falta la firma del cliente.';
  if (!d.termsVersion) return 'Falta la versión de los términos aceptados.';
  return '';
}

function getSheet_(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length)
      .setFontWeight('bold')
      .setBackground('#0F1115')
      .setFontColor('#FFFFFF');
    sheet.getRange('B:B').setNumberFormat('dd/mm/yyyy hh:mm');
    sheet.getRange('L:O').setNumberFormat('$#,##0.00');
  }
  return sheet;
}

function nextFolio_(sheet) {
  const today = Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyyyMMdd');
  const seq = Math.max(sheet.getLastRow(), 1); // fila 1 son encabezados
  return 'ZE-' + today + '-' + ('000' + seq).slice(-4);
}

function saveSignature_(folderId, folio, dataUrl) {
  const base64 = String(dataUrl).split(',')[1];
  const bytes = Utilities.base64Decode(base64);
  const blob = Utilities.newBlob(bytes, 'image/png', folio + '-firma.png');
  const folder = DriveApp.getFolderById(folderId);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

/* Prueba manual desde el editor: ejecuta esta función una vez para autorizar permisos. */
function autorizarPermisos() {
  const props = PropertiesService.getScriptProperties();
  SpreadsheetApp.openById(props.getProperty('SHEET_ID')).getName();
  DriveApp.getFolderById(props.getProperty('DRIVE_FOLDER_ID')).getName();
  Logger.log('Permisos correctos.');
}
