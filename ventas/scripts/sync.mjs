// Une las fuentes del ecosistema en un solo catálogo para el sitio.
//
//   Precios, estado y alias ..... KB_Productos de Z·IA (la misma hoja que lee el bot de WhatsApp)
//   Existencias ................. KB_Inventario de Z·IA (solo si afirmar_existencia = Sí)
//   Promociones con vigencia .... KB_Promociones de Z·IA
//   Productos en revisión ....... KB_PorConfirmar de Z·IA
//   Políticas de tienda y taller  KB_Politicas de Z·IA (las mismas que firma el cliente en Z-PEV Servicio)
//   Clave SAT y unidad .......... catálogo de FacturAI (CFDI 4.0)
//   Especificaciones ............ fichas de zescootersmx.com (datos/fuentes/especificaciones.json)
//
// Si existen KB_CSV_BASE y KB_GIDS (pestañas de la hoja de Z·IA publicadas en la web), descarga
// cada pestaña al vuelo; si no, usa las copias de datos/fuentes/. Así un cambio de precio en la
// hoja llega al sitio con solo volver a construir.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const F = (n) => path.join(RAIZ, "datos/fuentes", n);

// ---------- CSV ----------
function parseCSV(t) {
  t = t.replace(/^﻿/, "");
  const filas = []; let fila = [], c = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { fila.push(c); c = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && t[i + 1] === "\n") i++; fila.push(c); filas.push(fila); fila = []; c = ""; }
    else c += ch;
  }
  if (c !== "" || fila.length) { fila.push(c); filas.push(fila); }
  const h = filas.shift().map((x) => x.trim());
  return filas.filter((f) => f.some((v) => v.trim())).map((f) => Object.fromEntries(h.map((k, i) => [k, (f[i] ?? "").trim()])));
}
async function hoja(pestana, archivo) {
  // KB_CSV_BASE = enlace «Publicar en la web» en CSV, terminado en «&gid=»
  // KB_GIDS     = pestaña=gid separados por coma, p. ej. «KB_Productos=0,KB_Inventario=1846…»
  // Publica SOLO estas pestañas: la hoja también guarda Bitácora, Contactos y KB_Pagos.
  const base = process.env.KB_CSV_BASE;
  const gid = Object.fromEntries((process.env.KB_GIDS || "").split(",").filter(Boolean).map((x) => x.split("=").map((y) => y.trim())))[pestana];
  if (base && gid != null) {
    try {
      const r = await fetch(base + gid);
      if (r.ok) { const t = await r.text(); await fs.writeFile(F(archivo), t); console.log(`↓ ${pestana} desde la hoja publicada`); return parseCSV(t); }
    } catch (e) { console.warn(`No se pudo descargar ${pestana}; uso la copia local.`, e.message); }
  }
  return parseCSV(await fs.readFile(F(archivo), "utf8"));
}

// ---------- utilidades ----------
const sinAcentos = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const slugify = (s) => sinAcentos(String(s)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const norm = (s) => sinAcentos(String(s || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };
const MARCAS = { KINGSONG: "KingSong", KAABO: "Kaabo", LANGFEITE: "Langfeite", NOSFET: "Nosfet", INMOTION: "Inmotion" };
const marcaBonita = (m) => MARCAS[String(m).toUpperCase()] || String(m || "");
// "MANTIS 8 PLUS" -> "Mantis 8 Plus"; respeta códigos como KS, N14, KSE, GT, ECO
function modeloBonito(m, marca) {
  const s = String(m).replace(new RegExp("^" + marca + "\\s+", "i"), "").trim();
  return s.split(/\s+/).map((w) => (/\d/.test(w) || w.length <= 3 || w !== w.toUpperCase() || /^(KSE|ECO|PRO|GTR)$/.test(w) ? w : w[0] + w.slice(1).toLowerCase())).join(" ");
}

const SECCION = (cat) => {
  if (cat === "Scooter" || cat === "Monociclo EUC") return "vehiculos";
  if (cat.startsWith("Hyvel") || cat.startsWith("Batería")) return "baterias";
  return "refacciones";
};
const TIPO = (cat, marca) => {
  if (cat === "Scooter") return marca === "NOSFET" ? "Moto eléctrica" : "Scooter eléctrico";
  if (cat === "Monociclo EUC") return "Monociclo eléctrico";
  if (cat === "Batería (venta Z)") return "Batería";
  if (cat.startsWith("Hyvel · ")) return cat.replace("Hyvel · ", "");
  return "Refacción o accesorio";
};

// ---------- fuentes ----------
const productos = await hoja("KB_Productos", "kb_productos.csv");
const inventario = await hoja("KB_Inventario", "kb_inventario.csv");
const promociones = await hoja("KB_Promociones", "kb_promociones.csv");
const politicas = await hoja("KB_Politicas", "kb_politicas.csv");
const porConfirmar = await hoja("KB_PorConfirmar", "kb_porconfirmar.csv");
const facturai = JSON.parse(await fs.readFile(F("facturai_catalogo.json"), "utf8"));
const specs = JSON.parse(await fs.readFile(F("especificaciones.json"), "utf8"));
// public/fotos/<slug>.webp (recortada, sin fondo) tiene prioridad sobre .jpg/.png importadas del sitio
const fotos = new Map();
for (const f of (await fs.readdir(path.join(RAIZ, "public/fotos")).catch(() => [])).sort((a, b) => (a.endsWith(".webp") ? 1 : 0) - (b.endsWith(".webp") ? 1 : 0)))
  fotos.set(f.replace(/\.[a-z]+$/i, ""), `/fotos/${f}`);

const inv = new Map(inventario.map((r) => [norm(r.modelo), r]));
const satPorUrl = new Map(), satPorModelo = new Map();
for (const it of facturai.items || []) {
  if (it.url) satPorUrl.set(decodeURIComponent(it.url).toLowerCase(), it);
  satPorModelo.set(norm(it.model), it);
}
const enRevision = porConfirmar.flatMap((r) => r.producto.split(/\s+y\s+/i).map((p) => ({ clave: norm(p), dato: r.dato_del_asociado, accion: r.accion })));

const usados = new Set();
const catalogo = productos.map((p) => {
  const marcaRaw = p.marca_o_compatibilidad;
  const hyvel = p.fuente.startsWith("Hyvel");
  const vehiculo = SECCION(p.categoria) === "vehiculos";
  const marca = hyvel ? "Hyvel" : vehiculo ? marcaBonita(marcaRaw) : ["Refacción", "Accesorio"].includes(marcaRaw) ? "Z e-Scooters" : marcaRaw;
  const modelo = vehiculo ? modeloBonito(p.modelo, marca) : p.modelo;
  const urlSeg = /zescootersmx\.com/.test(p.url_ficha) ? slugify(decodeURIComponent(p.url_ficha.split("/").pop())) : "";
  let slug = slugify(p.modelo);
  if (!slug || usados.has(slug)) slug = slugify(`${marca} ${p.modelo}`);
  if (usados.has(slug)) slug = `${slug}-${p.id.toLowerCase()}`;
  usados.add(slug);
  const clave = norm(p.modelo);
  const i = inv.get(clave);
  const sat = satPorUrl.get(decodeURIComponent(p.url_ficha || "").toLowerCase()) || satPorModelo.get(clave);
  const revision = enRevision.find((r) => r.clave && (clave.includes(r.clave) || r.clave.includes(clave)));
  const sp = specs[urlSeg] || specs[slug] || null;
  const estado = hyvel ? "Sobre pedido" : p.estado || "Por verificar";
  return {
    id: p.id, slug, seccion: SECCION(p.categoria), tipo: TIPO(p.categoria, marcaRaw), categoria_kb: p.categoria,
    marca, modelo, nombre: vehiculo ? `${marca} ${modelo}` : modelo, compatibilidad: vehiculo || hyvel || ["Refacción", "Accesorio"].includes(marcaRaw) ? null : marcaRaw,
    precio: num(p.precio_lista_mxn), precio_tipo: hyvel ? p.estado : "Lista", estado,
    precio_por_confirmar: !!revision || hyvel || estado === "Por verificar",
    revision: revision ? revision.accion : null,
    existencias: i && i.afirmar_existencia === "Sí" ? { unidades: num(i.unidades), variantes: i.variantes || "", corte: i.fecha_corte } : null,
    sin_existencias: i && num(i.unidades) === 0 ? true : false,
    sat: sat ? { clave: sat.product_key, unidad: sat.unit_key } : null,
    foto: fotos.get(slug) || fotos.get(urlSeg) || null,
    url_wix: p.url_ficha || null,
    alias: (p.aliases || "").split("|").map((a) => a.trim()).filter(Boolean).slice(0, 4),
    specs: sp,
  };
});

const pol = Object.fromEntries(politicas.map((r) => [r.clave, { titulo: r.titulo, texto: r.texto_para_el_bot }]));
const promos = promociones.filter((r) => r.activa === "Sí").map((r) => ({
  id: r.id, nombre: r.nombre, tipo: r.tipo, valor: num(r.valor), aplica_a: r.aplica_a, inicio: r.fecha_inicio, fin: r.fecha_fin,
}));

const salida = {
  generado: new Date().toISOString(),
  fuentes: { precios: "KB_ZIA_WhatsApp → KB_Productos", sat: facturai.source || "FacturAI", inventario_corte: inventario[0]?.fecha_corte || null },
  conteo: catalogo.reduce((a, p) => ((a[p.seccion] = (a[p.seccion] || 0) + 1), a), { total: catalogo.length }),
  productos: catalogo, promociones: promos, politicas: pol,
};
await fs.mkdir(path.join(RAIZ, "src/data"), { recursive: true });
await fs.mkdir(path.join(RAIZ, "public/data"), { recursive: true });
await fs.writeFile(path.join(RAIZ, "src/data/catalogo.json"), JSON.stringify(salida, null, 1));
// versión ligera para el navegador (sin políticas ni alias)
const ligero = { generado: salida.generado, promociones: promos, productos: catalogo.map(({ alias, categoria_kb, url_wix, ...r }) => ({ ...r, specs: r.specs ? { v: num(r.specs.velocidad_kmh), a: num(r.specs.autonomia_km), p: num(r.specs.potencia_w), m: num(r.specs.motores), kg: num(r.specs.peso_kg), c: num(r.specs.carga_max_kg), g: num(r.specs.pendiente_grados), r: r.specs.neumaticos || "" } : null })) };
await fs.writeFile(path.join(RAIZ, "public/data/catalogo.json"), JSON.stringify(ligero));
console.log(`Catálogo: ${catalogo.length} productos · ${salida.conteo.vehiculos} vehículos · ${catalogo.filter((p) => p.sat).length} con clave SAT · ${catalogo.filter((p) => p.specs).length} con ficha técnica · ${catalogo.filter((p) => p.foto).length} con foto`);
