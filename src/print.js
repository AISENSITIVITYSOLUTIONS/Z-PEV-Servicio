// Versión imprimible de la orden de servicio (excepción para clientes sin WhatsApp).
// Arma una hoja carta con los datos de la orden, la firma y los términos aceptados,
// la muestra solo al imprimir y la retira al terminar.
import { TERMS, TERMS_CLOSING, TERMS_PARTIES, TERMS_TITLE, TERMS_VERSION } from './terms.js';

const fmtMXN = (n) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmtDate = (v) => {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v || '');
};
const phone = (d) => {
  const t = String(d || '').replace(/\D/g, '');
  return t.length === 10 ? `${t.slice(0, 2)} ${t.slice(2, 6)} ${t.slice(6)}` : t;
};

function row(dl, k, v) {
  const d = el('div');
  d.append(el('dt', '', k), el('dd', '', v || '—'));
  dl.append(d);
}

function buildSheet(o) {
  const sheet = el('section', 'pr-sheet');

  const head = el('header', 'pr-head');
  const logo = Object.assign(document.createElement('img'), { src: '/brand/z-logo.png', alt: 'Z e-Scooters México', className: 'pr-logo' });
  const id = el('div', 'pr-id');
  id.append(
    el('strong', '', 'Z e-Scooters México, S.A. de C.V.'),
    el('span', '', 'RFC ZEM210611H42 · Av. Patriotismo 176, Escandón I, CDMX'),
    el('span', '', 'L–V 10:00–19:00 · S 10:00–15:00 · Tel. 55 6501 8583')
  );
  const folio = el('div', 'pr-folio');
  folio.append(el('span', '', 'Orden de servicio'), el('strong', '', o.folio || 'Folio pendiente'));
  head.append(logo, id, folio);
  sheet.append(head);

  const grid = el('div', 'pr-grid');
  const cli = el('dl', 'pr-box');
  cli.append(el('p', 'pr-cap', 'Cliente y vehículo'));
  row(cli, 'Cliente', o.nombre || o.cliente);
  row(cli, 'Teléfono', phone(o.telefono));
  row(cli, 'Vehículo', o.marca);
  row(cli, 'N° de serie', o.serie);
  row(cli, 'Recepción', `${fmtDate(o.fecha)} ${o.hora || ''}`.trim());
  row(cli, 'Encendido', o.encendido);
  const acc = [o.llaves && `Llaves/NFC: ${o.llaves}`, o.cargador && `Cargador: ${o.cargador}`, o.otros].filter(Boolean).join(' · ');
  row(cli, 'Accesorios', acc);

  const pay = el('dl', 'pr-box');
  pay.append(el('p', 'pr-cap', 'Costos'));
  row(pay, 'Costo del servicio', fmtMXN(o.total));
  row(pay, 'Anticipo', fmtMXN(o.anticipo));
  row(pay, 'Total a pagar', fmtMXN(o.saldo));
  row(pay, 'Forma de pago', o.plan || 'Anticipo y liquidación');
  grid.append(cli, pay);
  sheet.append(grid);

  const srv = el('div', 'pr-box');
  srv.append(el('p', 'pr-cap', 'Servicio solicitado'), el('p', 'pr-text', o.servicio || '—'));
  if (o.caracteristicas) srv.append(el('p', 'pr-cap', 'Características generales'), el('p', 'pr-text', o.caracteristicas));
  sheet.append(srv);

  const sign = el('div', 'pr-sign');
  const box = el('div', 'pr-sign-box');
  if (o.firmaSrc) box.append(Object.assign(document.createElement('img'), { src: o.firmaSrc, alt: 'Firma del cliente' }));
  box.append(el('span', '', `Firma de conformidad de ${o.nombre || o.cliente || 'el cliente'}`));
  const note = el('p', 'pr-small',
    `El cliente aceptó los términos y condiciones (versión ${o.termsVersion || TERMS_VERSION}) que se transcriben a continuación. ` +
    'Copia impresa a solicitud del cliente; el registro original es digital.');
  sign.append(box, note);
  sheet.append(sign);

  const terms = el('section', 'pr-terms');
  terms.append(el('h2', '', TERMS_TITLE), el('p', '', TERMS_PARTIES));
  TERMS.forEach((c) => {
    const p = el('p');
    p.append(el('b', '', `${c.id}. `), document.createTextNode(c.paragraphs.join(' ')));
    terms.append(p);
  });
  TERMS_CLOSING.forEach((t) => terms.append(el('p', '', t)));
  sheet.append(terms);
  return sheet;
}

/** Imprime la nota de la orden. o: datos de la orden; firmaSrc: imagen de la firma (data URL o enlace). */
export async function printOrder(o) {
  document.getElementById('printArea')?.remove();
  const area = el('div');
  area.id = 'printArea';
  area.append(buildSheet(o));
  document.body.append(area);
  // Espera a que carguen el logo y la firma para que salgan en papel.
  await Promise.all([...area.querySelectorAll('img')].map((img) => (img.complete ? null : new Promise((r) => {
    img.onload = r; img.onerror = r; setTimeout(r, 4000);
  }))));
  document.body.classList.add('is-printing');
  const done = () => {
    document.body.classList.remove('is-printing');
    area.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}
