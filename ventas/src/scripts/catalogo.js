import { $, $$, catalogo, toast, agregar, abrirCot } from "./app.js";
import { dinero } from "../lib/z.js";

const items = $$("[data-grid] .it");
const grid = $("[data-grid]");
const F = { seccion: "vehiculos", q: "", min: null, max: null, tipo: new Set(), marca: new Set(), estado: new Set() };
const sinAc = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// estado inicial desde la URL (?seccion=, ?tipo=, ?marca=, ?q=)
const u = new URLSearchParams(location.search);
if (u.get("seccion")) F.seccion = u.get("seccion");
if (u.get("q")) { F.q = u.get("q"); $("#q").value = F.q; }
["tipo", "marca"].forEach((k) => u.getAll(k).forEach((v) => F[k].add(v)));

const pasa = (it, salvo) => {
  const d = it.dataset, precio = d.precio === "" ? null : +d.precio;
  if (d.seccion !== F.seccion) return false;
  if (F.q && !sinAc(F.q).split(/\s+/).every((w) => d.texto.includes(w))) return false;
  if (F.min != null && (precio == null || precio < F.min)) return false;
  if (F.max != null && (precio == null || precio > F.max)) return false;
  for (const k of ["tipo", "marca", "estado"]) if (k !== salvo && F[k].size && !F[k].has(d[k])) return false;
  return true;
};

function aplicar() {
  let n = 0;
  items.forEach((it) => { const ok = pasa(it); it.hidden = !ok; if (ok) n++; });
  $("[data-conteo]").textContent = `${n} resultado${n === 1 ? "" : "s"}`;
  $("[data-vacio]").hidden = n > 0;
  $$("[data-c]").forEach((c) => {
    const [k, v] = c.dataset.c.split("|");
    const cnt = items.filter((it) => it.dataset[k] === v && pasa(it, k)).length;
    c.textContent = cnt; c.closest(".op").style.opacity = cnt ? 1 : 0.45;
  });
  const qs = new URLSearchParams();
  if (F.seccion !== "vehiculos") qs.set("seccion", F.seccion);
  if (F.q) qs.set("q", F.q);
  F.tipo.forEach((v) => qs.append("tipo", v)); F.marca.forEach((v) => qs.append("marca", v));
  history.replaceState(null, "", location.pathname + (qs.toString() ? "?" + qs : ""));
}

function ordenar(modo) {
  const val = (it) => (it.dataset.precio === "" ? Infinity : +it.dataset.precio);
  const fns = {
    "precio-asc": (a, b) => val(a) - val(b),
    "precio-desc": (a, b) => (val(b) === Infinity ? -1 : val(b)) - (val(a) === Infinity ? -1 : val(a)),
    nombre: (a, b) => a.dataset.texto.localeCompare(b.dataset.texto, "es"),
    existencia: (a, b) => +b.dataset.exist - +a.dataset.exist || val(a) - val(b),
  };
  items.slice().sort(fns[modo]).forEach((it) => grid.appendChild(it));
}

function seccion(s) {
  F.seccion = s; F.tipo.clear(); F.marca.clear();
  $$("[data-f='tipo'],[data-f='marca']").forEach((i) => (i.checked = false));
  $$("[role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.seccion === s)));
  $$("[data-solo]").forEach((g) => (g.hidden = g.dataset.solo !== s));
  aplicar();
}
$$("[role=tab]").forEach((b) => b.addEventListener("click", () => seccion(b.dataset.seccion)));
$$("[data-f]").forEach((i) => {
  if (F[i.dataset.f].has(i.value)) i.checked = true;
  i.addEventListener("change", () => { i.checked ? F[i.dataset.f].add(i.value) : F[i.dataset.f].delete(i.value); aplicar(); });
});
$("#q").addEventListener("input", (e) => { F.q = e.target.value.trim(); aplicar(); });
const numOrNull = (v) => (v === "" ? null : +v);
$("#pmin").addEventListener("input", (e) => { F.min = numOrNull(e.target.value); marcarRango(); aplicar(); });
$("#pmax").addEventListener("input", (e) => { F.max = numOrNull(e.target.value); marcarRango(); aplicar(); });
function marcarRango() { $$("[data-r]").forEach((b) => { const [a, z] = b.dataset.r.split("-"); b.setAttribute("aria-pressed", String(F.min === numOrNull(a) && F.max === numOrNull(z))); }); }
$$("[data-r]").forEach((b) => b.addEventListener("click", () => {
  const [a, z] = b.dataset.r.split("-"); const ya = b.getAttribute("aria-pressed") === "true";
  F.min = ya ? null : numOrNull(a); F.max = ya ? null : numOrNull(z);
  $("#pmin").value = F.min ?? ""; $("#pmax").value = F.max ?? ""; marcarRango(); aplicar();
}));
$("#orden").addEventListener("change", (e) => ordenar(e.target.value));
$("[data-limpiar]").addEventListener("click", () => {
  F.q = ""; F.min = F.max = null; ["tipo", "marca", "estado"].forEach((k) => F[k].clear());
  $("#q").value = $("#pmin").value = $("#pmax").value = ""; $$("[data-f]").forEach((i) => (i.checked = false)); marcarRango(); aplicar();
});
const vf = $("[data-ver-filtros]");
vf.addEventListener("click", () => { const ab = $("#filtros").classList.toggle("abierto"); vf.setAttribute("aria-expanded", ab); });

seccion(F.seccion);
ordenar("precio-asc");

/* ---------- comparador ---------- */
const sel = new Set();
const bandeja = $("[data-bandeja]");
function pintaBandeja() {
  bandeja.classList.toggle("on", sel.size > 0);
  $("[data-bandeja-txt]").textContent = `${sel.size} de 3 para comparar`;
  $("[data-ver-comp]").disabled = sel.size < 2;
}
$$("[data-comparar]").forEach((c) => c.addEventListener("change", () => {
  if (c.checked && sel.size >= 3) { c.checked = false; toast("Compara hasta tres a la vez"); return; }
  c.checked ? sel.add(c.dataset.comparar) : sel.delete(c.dataset.comparar); pintaBandeja();
}));
const dlg = $("[data-comp]");
$("[data-cerrar-comp]").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
$("[data-ver-comp]").addEventListener("click", async () => {
  const c = await catalogo(); const ps = [...sel].map((id) => c.porId.get(id));
  const filas = [
    ["Precio de lista", (p) => p.precio, (v) => dinero(v), "min"],
    ["Velocidad máxima", (p) => p.specs?.v, (v) => `${v} km/h`, "max"],
    ["Autonomía declarada", (p) => p.specs?.a, (v) => `${v} km`, "max"],
    ["Potencia", (p) => (p.specs?.p ? p.specs.p * (p.specs.m || 1) : null), (v) => `${v} W`, "max"],
    ["Peso", (p) => p.specs?.kg, (v) => `${v} kg`, "min"],
    ["Carga máxima", (p) => p.specs?.c, (v) => `${v} kg`, "max"],
    ["Pendiente máxima", (p) => p.specs?.g, (v) => `${v}°`, "max"],
    ["Neumáticos", (p) => p.specs?.r || null, (v) => v, null],
    ["Disponibilidad", (p) => (p.existencias ? `${p.estado} · ${p.existencias.unidades} u.` : p.estado), (v) => v, null],
    ["Clave SAT", (p) => p.sat?.clave, (v) => v, null],
  ];
  const html = `<table class="comp-tabla"><thead><tr><th></th>${ps.map((p) => `<td><a class="h3" href="/modelo/${p.slug}/">${p.nombre}</a><div class="nota">${p.tipo}</div></td>`).join("")}</tr></thead><tbody>${filas.map(([t, f, fmt, mejor]) => {
    const vals = ps.map(f); const nums = vals.filter((v) => typeof v === "number");
    const best = mejor && nums.length > 1 ? (mejor === "min" ? Math.min(...nums) : Math.max(...nums)) : null;
    return `<tr><th>${t}</th>${vals.map((v) => `<td class="${v === best ? "mejor" : ""}">${v == null || v === "" ? '<span class="muted">Por confirmar</span>' : fmt(v)}</td>`).join("")}</tr>`;
  }).join("")}<tr><th></th>${ps.map((p) => `<td><button class="btn btn-sm btn-red" type="button" data-cot="${p.id}">Cotizar</button></td>`).join("")}</tr></tbody></table>
  <p class="nota" style="margin-top:14px">«Por confirmar»: la ficha técnica de ese modelo aún no está en la base; Z·IA o un asesor te la confirman.</p>`;
  $("[data-comp-tabla]").innerHTML = html;
  $$("[data-cot]", dlg).forEach((b) => b.addEventListener("click", () => { agregar(b.dataset.cot); dlg.close(); abrirCot(); }));
  dlg.showModal();
});
pintaBandeja();
