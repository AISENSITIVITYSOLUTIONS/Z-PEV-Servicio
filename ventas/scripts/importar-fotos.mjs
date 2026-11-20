// Toma las fotos que bajó el clonador (kit z-pev-ventas, carpeta salida/) y las pone en
// public/fotos/<slug>.<ext> según la URL de cada producto en Wix.
//
//   npm run fotos -- "H:\ruta\z-pev-ventas\salida"
//
// Después: npm run build. Las fotos .webp sin fondo que ya existan no se sobrescriben.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SALIDA = path.resolve(process.argv[2] || "../salida");
const productos = JSON.parse(await fs.readFile(path.join(SALIDA, "productos.json"), "utf8"));
const cat = JSON.parse(await fs.readFile(path.join(RAIZ, "src/data/catalogo.json"), "utf8"));
const norm = (u) => decodeURIComponent(String(u || "")).toLowerCase().replace(/\/$/, "");
const porUrl = new Map(cat.productos.filter((p) => p.url_wix).map((p) => [norm(p.url_wix), p]));
const destino = path.join(RAIZ, "public/fotos");
await fs.mkdir(destino, { recursive: true });
let n = 0, sin = [];
for (const w of productos) {
  const p = porUrl.get(norm(w.url));
  if (!p) continue;
  const foto = (w.fotos || [])[0];
  if (!foto) { sin.push(p.nombre); continue; }
  const archivo = decodeURIComponent(foto.split("/media/")[1] || "").replace(/[^a-zA-Z0-9._~-]/g, "_");
  const ext = (archivo.match(/\.(jpe?g|png|webp)$/i) || [, "jpg"])[1].toLowerCase().replace("jpeg", "jpg");
  try { await fs.access(path.join(destino, `${p.slug}.webp`)); continue; } catch {}
  try { await fs.copyFile(path.join(SALIDA, "imagenes", archivo), path.join(destino, `${p.slug}.${ext}`)); n++; }
  catch { sin.push(p.nombre); }
}
console.log(`${n} fotos importadas a public/fotos.${sin.length ? ` Sin foto: ${sin.join(", ")}` : ""}`);
