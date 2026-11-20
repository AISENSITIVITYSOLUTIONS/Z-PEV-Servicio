import { $, $$, catalogo, agregar, abrirCot, gsap, reduce } from "./app.js";
import { CONFIG, dinero } from "../lib/z.js";

/* ---------- Battery Match ---------- */
const B = { necesidad: "Reemplazar mi batería", voltaje: null };
$$("[data-bm]").forEach((g) => $$("button", g).forEach((b) => b.addEventListener("click", () => {
  $$("button", g).forEach((x) => x.setAttribute("aria-pressed", String(x === b))); B[g.dataset.bm] = b.dataset.v;
})));
const folioBM = () => "BM-" + Array.from(crypto.getRandomValues(new Uint8Array(5)), (x) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[x % 31]).join("");
const CRIT = [["voltaje", "Voltaje"], ["quimica", "Química de litio"], ["bms", "BMS / corriente"], ["conector", "Conector"], ["medidas", "Medidas"], ["cargador", "Cargador"]];

$("[data-bm-ir]").addEventListener("click", async () => {
  const c = await catalogo();
  const ok = { voltaje: !!B.voltaje && B.voltaje !== "No sé" };
  $$("[data-c]").forEach((i) => (ok[i.dataset.c] = i.checked));
  const faltan = CRIT.filter(([k]) => !ok[k]);
  const compatible = faltan.length === 0 && B.necesidad !== "Fabricar a medida" && B.necesidad !== "Reparar mi batería";
  const v = ok.voltaje ? B.voltaje : null;
  const ah = parseFloat(($("#bm-ah").value || "").replace(",", "."));
  const re = v ? new RegExp(`\\b${v}\\s?v\\b`, "i") : null;
  let cands = c.productos.filter((p) => p.seccion === "baterias" && (!re || re.test(p.nombre)));
  if (B.necesidad === "Cargador") cands = cands.filter((p) => /cargador/i.test(p.tipo + p.nombre));
  else cands = cands.filter((p) => !/cargador|conector/i.test(p.tipo));
  if (Number.isFinite(ah)) {
    const ahDe = (p) => parseFloat((p.nombre.match(/(\d+(?:[.,]\d+)?)\s?ah/i) || [])[1]?.replace(",", "."));
    const min = B.necesidad === "Más autonomía" ? ah : ah * 0.8;
    cands = cands.filter((p) => !Number.isFinite(ahDe(p)) || ahDe(p) >= min).sort((a, b) => (ahDe(a) || 99) - (ahDe(b) || 99));
  } else cands.sort((a, b) => (a.precio || 0) - (b.precio || 0));
  cands = cands.slice(0, 6);
  const folio = folioBM();
  const veh = $("#bm-veh").value.trim();
  const msg = [`Hola Z·IA, solicito evaluación Battery Match. Folio ${folio}`, `Necesidad: ${B.necesidad}`, veh && `Vehículo: ${veh}`, `Voltaje: ${v ? v + " V" : "no lo sé"}${Number.isFinite(ah) ? ` · ${ah} Ah` : ""}`,
    `Confirmado: ${CRIT.filter(([k]) => ok[k]).map(([, t]) => t).join(", ") || "nada aún"}`, faltan.length && `Pendiente: ${faltan.map(([, t]) => t).join(", ")}`,
    cands.length && `Candidatas: ${cands.slice(0, 3).map((p) => `${p.nombre} (${p.id})`).join("; ")}`, "Envío foto de la etiqueta y del conector."].filter(Boolean).join("\n");
  const wa = `https://wa.me/${CONFIG.WA_ZIA}?text=${encodeURIComponent(msg)}`;
  $("[data-bm-res]").innerHTML = `
    <div class="veredicto ${compatible ? "ok" : "eval"}">
      <span class="kicker">Clasificación del caso · Folio ${folio}</span>
      <h2 class="h3">${compatible ? "Compatible por especificación: confirma con el asesor y compra" : "Requiere evaluación técnica antes de comprar"}</h2>
      <p class="muted">${compatible ? "Los seis parámetros críticos están confirmados. Un especialista valida la etiqueta y te aparta la batería." : `Falta confirmar: ${faltan.map(([, t]) => t.toLowerCase()).join(", ")}. No bloqueamos tu compra por gusto: una batería que no coincide puede dañar el controlador o el motor.`}</p>
      <div class="checks">${CRIT.map(([k, t]) => `<div class="${ok[k] ? "si" : "no"}"><i>${ok[k] ? "✓" : "!"}</i>${t}</div>`).join("")}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px"><a class="btn btn-red" href="${wa}" target="_blank" rel="noopener">Enviar folio a Z·IA por WhatsApp</a></div>
    </div>
    ${cands.length ? `<h3 class="h3" style="margin:30px 0 14px">${v ? `Candidatas de ${v} V` : "Opciones del catálogo"} ${compatible ? "" : "<span class='nota'>(sujetas a la evaluación)</span>"}</h3>
    <div class="grid-prod">${cands.map((p) => `<article class="card"><div class="info" style="padding:10px 6px 0">
      <span class="tipo">${p.marca} · ${p.tipo}</span><a class="nom cubre" href="/modelo/${p.slug}/" style="font-size:16px">${p.nombre}</a>
      <div class="fila"><span class="precio">${p.precio_tipo === "A partir de" ? "desde " : ""}${dinero(p.precio)}</span><span class="estado pre"><i></i>${p.estado}</span></div></div>
      <div class="acciones"><button class="btn btn-sm" type="button" data-cot="${p.id}" ${compatible ? "" : 'title="Se cotiza junto con la evaluación"'}>Cotizar</button></div></article>`).join("")}</div>` : ""}`;
  $$("[data-cot]", $("[data-bm-res]")).forEach((b) => b.addEventListener("click", () => { agregar(b.dataset.cot); abrirCot(); }));
  if (!reduce) gsap.from("[data-bm-res] > *", { opacity: 0, y: 20, stagger: .1, duration: .7, ease: "power3.out" });
  $("[data-bm-res]").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
});

/* ---------- calculadora ---------- */
const C = { v: 48, ah: 13, kg: 75, t: 1 };
function calc() {
  const wh = C.v * C.ah;
  const cons = (C.v >= 60 ? 22 : C.v >= 48 ? 17 : 13) * (0.75 + C.kg / 300) * C.t; // Wh/km de referencia por clase de vehículo
  const lo = Math.round((wh * 0.8) / cons * 0.85), hi = Math.round((wh * 0.8) / cons * 1.1);
  $("[data-rango]").innerHTML = `${lo}–${hi}<small>km</small>`;
  $("[data-wh]").textContent = Math.round(wh);
  $("[data-cons]").textContent = cons.toFixed(1);
  $("[data-carga]").textContent = `≈${(C.ah / 2 * 1.15).toFixed(1)} h`;
  $("[data-formula]").textContent = `Wh = V × Ah → ${C.v} V × ${C.ah} Ah = ${Math.round(wh)} Wh · usable 80 %`;
}
$$("[data-k]").forEach((r) => {
  const f = () => { C[r.dataset.k] = +r.value; r.style.setProperty("--p", ((r.value - r.min) / (r.max - r.min)) * 100 + "%"); $(`[data-o="${r.dataset.k}"]`).firstChild.nodeValue = r.value; calc(); };
  r.addEventListener("input", f); f();
});
$$("[data-terreno] button").forEach((b) => b.addEventListener("click", () => { $$("[data-terreno] button").forEach((x) => x.setAttribute("aria-pressed", String(x === b))); C.t = +b.dataset.v; calc(); }));
calc();
