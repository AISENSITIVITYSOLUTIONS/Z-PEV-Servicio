import { $, $$, catalogo, agregar, abrirCot, gsap, reduce, scrollA } from "./app.js";
import { dinero, estadoClase, monograma, promoVigente, preguntaZIA } from "../lib/z.js";

const R = { uso: null, tipo: "", km: 15, peso: 75, pend: null, presupuesto: 25000 };
let paso = 0;
const ultimo = 5;

$$("[data-grupo]").forEach((g) => $$("button", g).forEach((b) => b.addEventListener("click", () => {
  $$("button", g).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  R[g.dataset.grupo] = b.dataset.v;
  if (g.dataset.grupo !== "tipo") setTimeout(() => ir(paso + 1), 220);
})));
$$("[data-r]").forEach((r) => {
  const pinta = () => {
    const k = r.dataset.r; R[k] = +r.value;
    r.style.setProperty("--p", ((r.value - r.min) / (r.max - r.min)) * 100 + "%");
    const o = $(`[data-out="${k}"]`); o.firstChild.nodeValue = k === "presupuesto" ? dinero(+r.value) : r.value;
  };
  r.addEventListener("input", pinta); pinta();
});

function ir(n) {
  if (n === 1 && !R.uso) return;
  if (n === 4 && R.pend == null) return;
  paso = Math.max(0, Math.min(ultimo, n));
  $$("[data-paso]").forEach((p) => (p.hidden = +p.dataset.paso !== paso));
  $$("[data-pasos] li").forEach((li, i) => { li.classList.toggle("activo", i === paso); li.classList.toggle("hecho", i < paso); });
  $("[data-atras]").style.visibility = paso === 0 ? "hidden" : "visible";
  $("[data-sig]").textContent = paso === 4 ? "Ver mis tres opciones" : "Continuar";
  $("[data-navwiz]").hidden = paso === ultimo;
  if (paso === ultimo) $$("[data-pasos] li").forEach((li) => li.classList.add("hecho"));
  if (paso === ultimo) recomendar();
  const el = $(`[data-paso="${paso}"]`);
  if (!reduce) gsap.from(el, { opacity: 0, y: 16, duration: .5, ease: "power3.out" });
  if (innerWidth < 980) scrollA($(".wizard"));
}
$("[data-sig]").addEventListener("click", () => ir(paso + 1));
$("[data-atras]").addEventListener("click", () => ir(paso - 1));
$("[data-reiniciar]").addEventListener("click", () => ir(0));
ir(0);

const USO = { ciudad: "trayectos diarios en ciudad", ultima: "último kilómetro", potencia: "velocidad y potencia", terreno: "todo terreno" };
const PEND = { 0: "camino plano", 12: "subidas moderadas", 20: "subidas fuertes" };

async function recomendar() {
  const c = await catalogo();
  const pend = +R.pend;
  const cand = c.productos.filter((p) => p.seccion === "vehiculos" && p.precio && p.estado !== "Agotado" && !p.sin_existencias && (!R.tipo || p.tipo === R.tipo));
  const evals = cand.map((p) => {
    const s = p.specs, por = [], ojo = [];
    const precio = promoVigente(p, c.promociones)?.precio || p.precio;
    if (precio > R.presupuesto * 1.08) return null;
    let sc = 0;
    // precio: aprovechar el presupuesto sin pasarse
    sc += 26 * (precio <= R.presupuesto ? 0.45 + 0.55 * (precio / R.presupuesto) : 0.3);
    if (precio <= R.presupuesto) por.push(`Dentro de tu presupuesto (${dinero(precio)})`); else ojo.push(`Rebasa tu presupuesto por ${dinero(precio - R.presupuesto)}`);
    let estimado = null;
    if (s) {
      if (s.c && s.c < R.peso) return null;
      const f = R.peso > 90 ? 0.88 : 1, lo = Math.round(s.a * 0.6 * f), hi = Math.round(s.a * 0.75 * f);
      estimado = s.a ? [lo, hi] : null;
      if (estimado) { if (lo >= R.km) { sc += 22; por.push(`Autonomía real estimada ${lo}–${hi} km para tus ${R.km} km`); } else if (hi >= R.km) { sc += 12; ojo.push(`Autonomía justa: ${lo}–${hi} km; carga a diario`); } else { sc -= 8; ojo.push(`Autonomía corta para ${R.km} km (${lo}–${hi} km)`); } }
      if (s.g != null) { if (s.g >= pend) { sc += 12; if (pend) por.push(`Sube pendientes de hasta ${s.g}°`); } else { sc -= 6; ojo.push(`Pendiente máxima ${s.g}°`); } } else sc += 5;
      const u = R.uso;
      if (u === "ciudad") sc += s.v >= 20 && s.v <= 45 ? 18 : 9;
      if (u === "ultima") { sc += s.kg && s.kg <= 16 ? 20 : s.kg <= 21 ? 10 : 2; if (s.kg) por.push(`${s.kg} kg para cargarlo`); }
      if (u === "potencia") { sc += s.v >= 45 ? 20 : s.v >= 35 ? 11 : 3; if (s.v) por.push(`${s.v} km/h de velocidad máxima`); }
      if (u === "terreno") { sc += s.g >= 20 || /off|terreno/i.test(s.r) ? 20 : 4; if (/off|terreno/i.test(s.r)) por.push(`Llantas ${s.r}`); }
    } else {
      // sin ficha técnica: heurística por precio y tipo, con tope
      const u = R.uso;
      sc += 18 + (u === "potencia" || u === "terreno" ? (p.precio >= 40000 ? 14 : 2) : p.precio <= 25000 ? 12 : 4);
      ojo.push("Ficha técnica por confirmar con Z·IA");
    }
    if (p.existencias) { sc += 12; por.push(`${p.existencias.unidades} en existencia`); }
    else if (p.estado === "Disponible") sc += 7;
    else if (p.estado === "Pre orden") { sc -= 2; ojo.push("Pre orden"); }
    else { sc -= 4; ojo.push("Disponibilidad por confirmar"); }
    if (!s) sc = Math.min(sc, 64);
    return { p, precio, sc: Math.max(5, Math.min(98, Math.round(sc))), por, ojo, estimado };
  }).filter(Boolean).sort((a, b) => b.sc - a.sc);

  const top = evals.slice(0, 3);
  $("[data-perfil]").textContent = `${USO[R.uso]}, ${R.km} km al día, ${R.peso} kg, ${PEND[R.pend]}, hasta ${dinero(R.presupuesto)}${R.tipo ? ` · ${R.tipo.toLowerCase()}` : ""}`;
  $("[data-resultado]").innerHTML = top.length ? top.map((r, i) => {
    const [cls, txt] = estadoClase(r.p);
    return `<article class="res-card ${i === 0 ? "top" : ""}">
      <span class="match">${r.sc}% · ${i === 0 ? "La mejor" : i === 1 ? "Alternativa" : "También"}</span>
      ${r.p.foto ? `<div class="visual"><img src="${r.p.foto}" alt="${r.p.nombre}"></div>` : `<div class="visual sin-foto"><span class="estela"></span><span class="mono-grande">${monograma(r.p)}</span></div>`}
      <div class="info" style="display:grid;gap:6px;padding:0 6px">
        <span class="tipo" style="font:500 11px/1.2 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)">${r.p.marca} · ${r.p.tipo}</span>
        <a class="h3" href="/modelo/${r.p.slug}/">${r.p.modelo}</a>
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><span class="mono" style="font-size:20px;font-weight:600">${dinero(r.precio)}</span><span class="estado ${cls}"><i></i>${txt}</span></div>
      </div>
      <div class="por"><ul>${r.por.map((t) => `<li>${t}</li>`).join("")}${r.ojo.map((t) => `<li style="color:var(--warn)">${t}</li>`).join("")}</ul>
      ${r.estimado ? `<p class="nota">Autonomía real estimada: ${r.estimado[0]}–${r.estimado[1]} km (no es garantía).</p>` : ""}</div>
      <div style="display:grid;gap:8px;padding:0 6px">
        <button class="btn btn-sm btn-red" type="button" data-cot="${r.p.id}">Agregar a mi cotización</button>
        <a class="btn btn-sm" href="${preguntaZIA(r.p)}" target="_blank" rel="noopener">Preguntar a Z·IA</a>
      </div></article>`;
  }).join("") : `<div class="panel"><p class="h3">Con ese presupuesto no hay un vehículo disponible que cumpla.</p><p class="nota" style="margin-top:8px">Sube el presupuesto o cambia el tipo; también puedes preguntarle a Z·IA por preventas.</p></div>`;
  $$("[data-cot]").forEach((b) => b.addEventListener("click", () => { agregar(b.dataset.cot); abrirCot(); }));
  if (!reduce) gsap.from(".res-card", { opacity: 0, y: 30, stagger: .1, duration: .8, ease: "power3.out" });
}
