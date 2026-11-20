import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { CONFIG, dinero, promoVigente } from "../lib/z.js";

gsap.registerPlugin(ScrollTrigger);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
export const $ = (s, c = document) => c.querySelector(s);
export const $$ = (s, c = document) => [...c.querySelectorAll(s)];

/* ---------- datos (mismo JSON para todas las páginas) ---------- */
let _cat;
export function catalogo() {
  if (!_cat) _cat = fetch("/data/catalogo.json").then((r) => r.json()).then((d) => ({ ...d, porId: new Map(d.productos.map((p) => [p.id, p])) }));
  return _cat;
}

/* ---------- desplazamiento suave y revelados ---------- */
let lenis;
if (!reduce) {
  lenis = new Lenis({ lerp: 0.1 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  $$("[data-reveal]").forEach((el) =>
    gsap.to(el, { opacity: 1, y: 0, duration: 1.05, ease: "power3.out", delay: +(el.dataset.reveal || 0), scrollTrigger: { trigger: el, start: "top 90%" } }));
}
export const scrollA = (el) => (lenis ? lenis.scrollTo(el, { offset: -80 }) : el.scrollIntoView({ behavior: "smooth" }));

const nav = $("[data-nav]");
const marcaNav = () => nav.classList.toggle("solida", scrollY > 24);
addEventListener("scroll", marcaNav, { passive: true }); marcaNav();
const burger = $("[data-burger]");
burger?.addEventListener("click", () => { const ab = $("#menu").classList.toggle("abierto"); burger.setAttribute("aria-expanded", ab); });
$$("#menu a").forEach((a) => a.addEventListener("click", () => $("#menu").classList.remove("abierto")));

/* ---------- aviso breve ---------- */
let tt;
export function toast(msg) {
  const t = $("[data-toast]"); t.textContent = msg; t.classList.add("on");
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove("on"), 2600);
}

/* ---------- promociones vigentes (KB_Promociones) sobre los precios impresos ---------- */
catalogo().then((c) => {
  $$("[data-precio]").forEach((el) => {
    const p = c.porId.get(el.dataset.precio); const pr = p && promoVigente(p, c.promociones);
    if (pr) el.innerHTML = `<s class="precio-antes">${dinero(p.precio)}</s>${dinero(pr.precio)}`;
  });
});

/* ---------- cotización ---------- */
const K = "zpev-cotizacion-v1";
const leer = () => { try { return JSON.parse(localStorage.getItem(K)) || {}; } catch { return {}; } };
let estado = Object.assign({ items: {}, folio: "", datos: {} }, leer());
const guardar = () => { try { localStorage.setItem(K, JSON.stringify(estado)); } catch {} };
const nuevoFolio = () => {
  const d = new Date(), z = (n) => String(n).padStart(2, "0");
  const az = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31]).join("");
  return `ZV-${String(d.getFullYear()).slice(2)}${z(d.getMonth() + 1)}${z(d.getDate())}-${az}`;
};
if (!estado.folio) estado.folio = nuevoFolio();

const cajon = $("[data-cajon]");
const campos = ["c-nombre", "c-cp", "c-factura", "c-rfc", "c-cpf", "c-razon", "c-regimen", "c-uso", "c-correo"];
campos.forEach((id) => {
  const el = $("#" + id); if (!el) return;
  const v = estado.datos[id]; if (v != null) el.type === "checkbox" ? (el.checked = v) : (el.value = v);
  el.addEventListener("input", () => { estado.datos[id] = el.type === "checkbox" ? el.checked : el.value; guardar(); pintar(); });
});
const RFC = /^([A-ZÑ&]{3,4})\d{6}[A-Z\d]{3}$/;

export function agregar(id, cant = 1) {
  estado.items[id] = (estado.items[id] || 0) + cant;
  if (estado.items[id] <= 0) delete estado.items[id];
  guardar(); pintar();
}
export function abrirCot() { cajon.classList.add("abierto"); cajon.setAttribute("aria-hidden", "false"); lenis?.stop(); setTimeout(() => $("[data-cerrar-cot].cerrar")?.focus(), 50); }
function cerrarCot() { cajon.classList.remove("abierto"); cajon.setAttribute("aria-hidden", "true"); lenis?.start(); }
$$("[data-abrir-cot]").forEach((b) => b.addEventListener("click", abrirCot));
$$("[data-cerrar-cot]").forEach((b) => b.addEventListener("click", cerrarCot));
addEventListener("keydown", (e) => { if (e.key === "Escape" && cajon.classList.contains("abierto")) cerrarCot(); });

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-agregar]");
  if (a) {
    e.preventDefault();
    agregar(a.dataset.agregar);
    const c = await catalogo(); const p = c.porId.get(a.dataset.agregar);
    toast(`${p ? p.nombre : "Producto"} en tu cotización`);
    if (a.hasAttribute("data-abrir")) abrirCot();
  }
});

function mensaje(c, lista) {
  const d = estado.datos, L = [];
  L.push(`Hola Z·IA, quiero cotizar. Folio ${estado.folio}`);
  lista.forEach(({ p, n, precio }) => L.push(`• ${n} × ${p.nombre} (${p.id}) — ${dinero(precio)}${p.precio_por_confirmar ? " (precio por confirmar)" : ""}`));
  const total = lista.reduce((s, x) => s + x.precio * x.n, 0);
  if (lista.length) L.push(`Total de lista: ${dinero(total)} MXN con IVA`);
  if (d["c-nombre"]) L.push(`Nombre: ${d["c-nombre"]}`);
  if (d["c-cp"]) L.push(`Entrega a domicilio, CP ${d["c-cp"]}`);
  if (d["c-factura"]) {
    L.push("Requiero factura CFDI 4.0:");
    L.push(`RFC ${String(d["c-rfc"] || "").toUpperCase()} · ${d["c-razon"] || ""}`);
    L.push(`Régimen ${d["c-regimen"] || "—"} · Uso ${d["c-uso"] || "G03"} · CP fiscal ${d["c-cpf"] || "—"}`);
    if (d["c-correo"]) L.push(`Correo: ${d["c-correo"]}`);
    const claves = [...new Set(lista.map((x) => x.p.sat?.clave).filter(Boolean))];
    if (claves.length) L.push(`Claves SAT: ${claves.join(", ")}`);
  }
  return L.join("\n");
}

async function pintar() {
  const c = await catalogo();
  const lista = Object.entries(estado.items).map(([id, n]) => {
    const p = c.porId.get(id); if (!p) return null;
    const pr = promoVigente(p, c.promociones);
    return { p, n, precio: pr ? pr.precio : p.precio || 0 };
  }).filter(Boolean);
  const cuenta = lista.reduce((s, x) => s + x.n, 0);
  $$("[data-cot-cuenta]").forEach((b) => (b.textContent = cuenta || ""));
  $("[data-folio]").textContent = `Folio ${estado.folio}`;
  $("[data-items]").innerHTML = lista.length ? `<div style="display:grid;gap:10px">${lista.map(({ p, n, precio }) => `
    <div class="item">
      <div class="mini">${p.foto ? `<img src="${p.foto}" alt="">` : (p.modelo || "").split(" ").pop().slice(0, 5)}</div>
      <div><div class="n">${p.nombre}</div><div class="s">${p.id} · ${dinero(precio)}${p.sat ? ` · SAT ${p.sat.clave}` : ""}</div></div>
      <div class="qty"><button type="button" data-q="${p.id}" data-d="-1" aria-label="Quitar uno">−</button><span>${n}</span><button type="button" data-q="${p.id}" data-d="1" aria-label="Agregar uno">+</button></div>
    </div>`).join("")}</div>`
    : `<div class="vacio"><p class="h3" style="color:var(--text)">Tu cotización está vacía</p><p style="margin-top:8px">Agrega modelos desde el catálogo o pídele a Z·IA una recomendación.</p><a class="btn btn-sm" href="/catalogo/" style="margin-top:18px">Ir al catálogo</a></div>`;
  $$("[data-q]").forEach((b) => (b.onclick = () => agregar(b.dataset.q, +b.dataset.d)));
  $("[data-total]").textContent = dinero(lista.reduce((s, x) => s + x.precio * x.n, 0)) || "$0";
  const fact = !!estado.datos["c-factura"];
  $("[data-fiscal]").hidden = !fact;
  // validación mínima para la factura (los datos los usa FacturAI tal cual)
  let err = "";
  const rfc = String(estado.datos["c-rfc"] || "").toUpperCase().trim();
  $("#c-rfc").classList.toggle("err", fact && rfc !== "" && !RFC.test(rfc));
  if (fact && rfc && !RFC.test(rfc)) err = "El RFC no tiene el formato del SAT (12 o 13 caracteres).";
  if (fact && !rfc) err = "Para facturar, escribe tu RFC.";
  const cp = estado.datos["c-cp"]; if (cp && !/^\d{5}$/.test(cp)) err = "El CP de entrega lleva 5 dígitos.";
  const txt = mensaje(c, lista);
  $("[data-preview]").textContent = txt;
  $("[data-error]").textContent = err;
  const env = $("[data-enviar]");
  env.href = `https://wa.me/${CONFIG.WA_ZIA}?text=${encodeURIComponent(txt)}`;
  env.setAttribute("aria-disabled", String(!lista.length || !!err));
  $("[data-copiar]").onclick = async () => {
    try { await navigator.clipboard.writeText(txt); toast("Mensaje copiado"); }
    catch { const r = document.createRange(); r.selectNodeContents($("[data-preview]")); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selecciona y copia el mensaje"); }
  };
}
$("[data-enviar]").addEventListener("click", () => { if ($("[data-enviar]").getAttribute("aria-disabled") !== "true") setTimeout(() => { estado.folio = nuevoFolio(); guardar(); pintar(); }, 800); });
pintar();
if (location.hash === "#cotizacion") abrirCot();

export { gsap, ScrollTrigger, reduce, lenis };
