# Z-PEV Ventas

Sitio de venta de **Z e-Scooters México**. Es la cara pública de la familia Z-PEV y está conectado con las otras tres piezas del ecosistema:

| Pieza | Qué toma o entrega Z-PEV Ventas |
|---|---|
| **Z·IA** (repo `Z-IA-WhatsApp`) | Precios, estados, existencias, promociones y políticas salen de la misma hoja `KB_ZIA_WhatsApp`. La cotización llega a la línea de Z·IA (55 6472 9389) con folio `ZV-…` y las claves `P00xx` que el bot ya reconoce. |
| **FacturAI** (repo `FacturIA`) | Clave SAT y unidad de cada producto vienen del catálogo de FacturAI. La cotización captura RFC, régimen, uso CFDI, CP fiscal y correo, validados antes de enviar. |
| **Z-PEV Servicio** (este repo) | Mismo proyecto de Firebase (`z-pev-servicio`), segundo sitio de Hosting. La página de taller muestra las cláusulas que se firman en la orden de servicio. |

Stack: Astro (estático, 250 páginas) · GSAP + ScrollTrigger · Lenis · Archivo, Geist y Geist Mono autoalojadas.

## Páginas

- `/` inicio con escenario del producto, estelas de luz y el flujo del ecosistema.
- `/catalogo/` 245 productos con filtros (sección, búsqueda, precio, tipo, marca, disponibilidad), orden y comparador de hasta tres.
- `/modelo/<slug>/` una ficha por producto: precio, existencias, medidores, ficha técnica, clave SAT y clave Z·IA.
- `/asistente/` cinco preguntas → tres vehículos con % de coincidencia y autonomía real estimada.
- `/baterias/` Battery Match (solo «compatible» con los seis parámetros críticos) y calculadora Wh.
- `/taller/` agenda por WhatsApp y reglas del taller.
- Cajón **Mi cotización** en todas las páginas.

## Datos

`npm run sync` (corre solo antes de `dev` y `build`) une:

```
datos/fuentes/kb_productos.csv      KB_Productos   (Z·IA)  precio, estado
datos/fuentes/kb_inventario.csv     KB_Inventario  (Z·IA)  existencias si afirmar_existencia = Sí
datos/fuentes/kb_promociones.csv    KB_Promociones (Z·IA)  se aplican solas por fecha
datos/fuentes/kb_politicas.csv      KB_Politicas   (Z·IA)  horario, taller, factura
datos/fuentes/kb_porconfirmar.csv   KB_PorConfirmar(Z·IA)  marca «precio por confirmar»
datos/fuentes/facturai_catalogo.json FacturAI               clave SAT y unidad
datos/fuentes/especificaciones.json fichas de zescootersmx.com
```

**Cambiar un precio:** edítalo en la hoja de Z·IA (`KB_Productos`) y vuelve a construir. Para que el build descargue la hoja sin copiar archivos, publica en la web **solo** las pestañas KB_Productos, KB_Inventario, KB_Promociones, KB_Politicas y KB_PorConfirmar (Archivo → Compartir → Publicar en la web → CSV; nunca Bitácora, Contactos ni KB_Pagos) y define:

```powershell
$env:KB_CSV_BASE = "https://docs.google.com/spreadsheets/d/e/<ID_PUBLICADO>/pub?single=true&output=csv&gid="
$env:KB_GIDS = "KB_Productos=0,KB_Inventario=<gid>,KB_Promociones=<gid>,KB_Politicas=<gid>,KB_PorConfirmar=<gid>"
```

**Fotos:** `public/fotos/<slug>.webp` (recortadas, sin fondo). Para traer las del sitio actual, corre el clonador del kit (`z-pev-ventas/2-playwright`) y luego:

```powershell
npm run fotos -- "H:\Telegram Desktop\0 NNI issues\z-pev-ventas\salida"
```

## Desarrollo y despliegue (PowerShell)

```powershell
cd "<tu carpeta>\Z-PEV-Servicio\ventas"
npm install
npm run dev                      # http://localhost:4321
npm run build                    # genera dist/

# Una sola vez: crear el segundo sitio dentro del proyecto de Z-PEV Servicio
firebase login                   # con fdealbam@nni.ai
firebase hosting:sites:create z-pev-ventas --project z-pev-servicio

firebase deploy --only hosting --project z-pev-servicio   # desde la carpeta ventas
```

El `firebase.json` de esta carpeta apunta al sitio `z-pev-ventas`, así que este deploy no toca la app de órdenes (`z-pev-servicio.web.app`). Queda en `https://z-pev-ventas.web.app`.

## Pendientes

- Fotos de los 58 vehículos restantes (hoy: KS N13 y KS N14 KSE). La foto disponible del KS C1 es rosa y el inventario solo tiene azul y gris: no se usa.
- Fichas técnicas de 54 vehículos (hoy: 7). Mientras falten, la ficha lo dice y manda a Z·IA.
- Confirmar con Z que Z·IA (55 6472 9389) es la línea que debe recibir las cotizaciones del sitio.
- Aviso de privacidad propio del sitio (hoy se remite al de zescootersmx.com).
