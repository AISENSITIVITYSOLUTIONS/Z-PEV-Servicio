// Configuración y utilidades compartidas entre las páginas (Astro) y el navegador.

export const CONFIG = {
  // Línea de WhatsApp de Z·IA (la misma que envía las notas de Z-PEV Servicio). Solo dígitos, con 52.
  WA_ZIA: "525564729389",
  WA_ZIA_LEGIBLE: "55 6472 9389",
  // Teléfonos de la tienda (KB_Politicas → contacto)
  TEL_TIENDA: ["55 6501 8583", "55 4497 8500"],
  SITIO: "https://z-pev-ventas.web.app",
};

export const dinero = (n) =>
  n == null || !Number.isFinite(Number(n)) ? "" : "$" + Number(n).toLocaleString("es-MX", { maximumFractionDigits: Number(n) % 1 ? 2 : 0, minimumFractionDigits: Number(n) % 1 ? 2 : 0 });

export function estadoClase(p) {
  if (p.sin_existencias) return ["no", "Sin existencias · consultar"];
  switch (p.estado) {
    case "Disponible": return ["ok", p.existencias ? `En existencia · ${p.existencias.unidades} u.` : "Disponible"];
    case "Pre orden": return ["pre", "Pre orden"];
    case "Agotado": return ["no", "Agotado · avísame"];
    case "Sobre pedido": return ["pre", "Sobre pedido · Hyvel"];
    default: return ["rev", "Disponibilidad por confirmar"];
  }
}

// Monograma para productos sin foto: último bloque del modelo (N16, GT2 RS, Wolf…)
export function monograma(p) {
  const m = String(p.modelo || p.nombre).replace(/\(.*?\)/g, "").trim();
  return m.length > 14 ? m.split(/\s+/).slice(0, 2).join(" ") : m;
}

// Promoción vigente que aplica a un producto (KB_Promociones: fecha_inicio..fecha_fin, aplica_a)
export function promoVigente(p, promos, hoy = new Date()) {
  if (p.seccion !== "vehiculos" || !p.precio) return null;
  const d = hoy.toISOString().slice(0, 10);
  const aplica = (a) => /scooter|monociclo|bicicleta|todo|vehículo/i.test(a) && (p.tipo !== "Moto eléctrica" || /moto/i.test(a));
  const pr = (promos || []).find((x) => x.inicio <= d && d <= x.fin && aplica(x.aplica_a || "") && /porcentual/i.test(x.tipo || ""));
  return pr ? { ...pr, precio: Math.round(p.precio * (1 - pr.valor / 100)) } : null;
}

export const waURL = (texto) => `https://wa.me/${CONFIG.WA_ZIA}?text=${encodeURIComponent(texto)}`;
export const preguntaZIA = (p) => waURL(`Hola Z·IA, me interesa el ${p.nombre} (${p.id}). ¿Me ayudas con disponibilidad y entrega?`);
