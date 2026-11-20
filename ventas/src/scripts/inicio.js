import { gsap, reduce, $, $$ } from "./app.js";

/* Estelas de luz: trazos rojos y plata que cruzan en perspectiva detrás del producto. */
const cv = $("canvas.estelas");
if (cv) {
  const ctx = cv.getContext("2d");
  let w, h, dpr, trazos = [];
  const N = innerWidth < 700 ? 26 : 54;
  const nuevo = (inicio) => {
    const y = 0.25 + Math.random() * 0.6; // franja vertical
    const rojo = Math.random() < 0.62;
    return { x: inicio ? Math.random() * 1.4 : 1.15 + Math.random() * 0.3, y, z: 0.25 + Math.random() * 0.9,
      len: 0.08 + Math.random() * 0.3, v: 0.0012 + Math.random() * 0.0035, rojo, a: 0.25 + Math.random() * 0.6 };
  };
  const tam = () => { dpr = Math.min(devicePixelRatio || 1, 2); w = cv.clientWidth; h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  tam(); addEventListener("resize", tam);
  for (let i = 0; i < N; i++) trazos.push(nuevo(true));
  let mx = 0, my = 0;
  addEventListener("pointermove", (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; }, { passive: true });
  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(cv);
  const dibuja = () => {
    ctx.clearRect(0, 0, w, h);
    // horizonte con brillo
    const g = ctx.createRadialGradient(w * 0.68, h * 0.58, 10, w * 0.68, h * 0.58, Math.max(w, h) * 0.6);
    g.addColorStop(0, "rgba(236,42,31,0.16)"); g.addColorStop(0.45, "rgba(236,42,31,0.04)"); g.addColorStop(1, "rgba(7,8,11,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    for (const t of trazos) {
      const x1 = (t.x + mx * 0.04 * t.z) * w, y1 = (t.y + my * 0.03 * t.z) * h + (t.y - 0.58) * h * (1 - t.z) * 0.6;
      const x2 = x1 + t.len * w * t.z;
      const gr = ctx.createLinearGradient(x1, 0, x2, 0);
      const c = t.rojo ? "236,42,31" : "205,210,220";
      gr.addColorStop(0, `rgba(${c},${t.a})`); gr.addColorStop(1, `rgba(${c},0)`);
      ctx.strokeStyle = gr; ctx.lineWidth = Math.max(0.6, 2.2 * t.z); ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y1); ctx.stroke();
      if (!reduce) { t.x -= t.v * (0.6 + t.z); if (t.x + t.len < -0.2) Object.assign(t, nuevo(false)); }
    }
    ctx.globalCompositeOperation = "source-over";
  };
  const loop = () => { if (visible) dibuja(); if (!reduce) requestAnimationFrame(loop); };
  loop();
}

/* Entrada del hero */
if (!reduce) {
  const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
  tl.from(".hero .kicker", { opacity: 0, x: -20, duration: .7 })
    .from(".hero h1 .ln", { yPercent: 105, opacity: 0, duration: 1.1, stagger: .09 }, "-=.4")
    .from(".hero .lead, .hero-ctas, .hero-meta", { opacity: 0, y: 18, duration: .8, stagger: .08 }, "-=.6")
    .from(".stage img.prod", { opacity: 0, x: 120, rotate: 2, duration: 1.4, ease: "expo.out" }, .25)
    .from(".stage .aro, .stage .piso", { scaleX: .2, opacity: 0, duration: 1.2, stagger: .1 }, .4)
    .from(".hud", { opacity: 0, y: 14, scale: .96, duration: .7, stagger: .12 }, .9);
  // contadores del HUD
  $$("[data-cuenta]").forEach((el) => {
    const fin = +el.dataset.cuenta, o = { v: 0 };
    gsap.to(o, { v: fin, duration: 1.6, delay: 1, ease: "power2.out", onUpdate: () => (el.firstChild.nodeValue = Math.round(o.v)) });
  });
  // el producto flota con el puntero
  const prod = $(".stage img.prod");
  if (prod && matchMedia("(pointer:fine)").matches) {
    addEventListener("pointermove", (e) => {
      const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
      gsap.to(prod, { x: x * 18, y: y * 10, rotate: x * 1.4, duration: 1.2, ease: "power2.out", overwrite: "auto" });
    }, { passive: true });
  }
  // bus del ecosistema
  const bus = $(".eco .bus i");
  if (bus) {
    gsap.from(bus, { scaleX: 0, ease: "none", scrollTrigger: { trigger: ".eco", start: "top 75%", end: "top 30%", scrub: true } });
    gsap.to(".eco .pulso", { left: "100%", duration: 4.5, ease: "none", repeat: -1 });
    gsap.from(".eco .nodo", { opacity: 0, y: 30, stagger: .12, duration: .9, ease: "power3.out", scrollTrigger: { trigger: ".eco", start: "top 75%" } });
  }
}
