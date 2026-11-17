# Z-PEV Servicio

Orden de servicio de **Z e-Scooters México**: recepción del vehículo, contrato de prestación
de servicios, firma digital del cliente y registro automático en Google Sheets. Base del
futuro CRM/ERP del taller.

Diseño con el sistema visual de **FacturAI** (Geist / Geist Mono, paper `#F3F2EE`, rail ink,
acento lima `#D9F84A`, vista previa tipo comprobante).

## Qué hace

- **Acceso con Google**: solo correos en `ALLOWED_EMAILS`; verificación del ID token en el servidor.
- **Nueva orden**: cliente, vehículo, servicio, accesorios, presupuesto, anticipo y saldo calculado.
  Vista previa en vivo, checklist y borrador guardado en el navegador.
- **Términos y condiciones** completos (cláusulas PRIMERA a DÉCIMA NOVENA); la casilla se habilita
  al leer hasta el final.
- **Firma digital** en una placa 3D, exportada como PNG a Drive.
- **Pagos y cierre**: costo del servicio − anticipo = total a pagar. Plan «Anticipo y liquidación» o «Varios pagos»;
  cada pago queda en la hoja «Pagos». Con saldo cero la orden pasa a **Pagada**; el botón ✓ la concluye y entrega (**Completada**), genera el comprobante digital en PDF con el mismo folio y lo envía al cliente por WhatsApp.
- **Historial**: últimas órdenes, búsqueda, totales (anticipos y saldo por cobrar), enlace a la firma
  y aviso al cliente por WhatsApp.
- **Cobro del anticipo con Mercado Pago**: integrado y **oculto**; ver `docs/MERCADO_PAGO.md`.
- **Pago a plazos con Aplazo** («¿No tienes tarjeta de crédito?»): integrado y **oculto**; ver `docs/APLAZO.md`.

## Arquitectura

| Pieza | Dónde | Función |
|---|---|---|
| Frontend | Vite + JS + three.js → Firebase Hosting | Formulario, firma, historial |
| Registro | Google Apps Script + Sheets + Drive | Folio `ZPEV-AA-NNNN` (consecutivo por año), filas, firmas |
| Cobros | Firebase Function `billing` (Node 22) | Mercado Pago (Checkout Pro), oculto |
| Pago a plazos | Firebase Function `aplazo` (Node 22) | Aplazo (Online API) y su webhook |
| Conciliación | Firebase Function `aplazoSweep` (cada 60 min) | Pagos de Aplazo sin webhook y links vencidos |

## 1. Google Sheets y Apps Script

1. Crea una hoja de cálculo y una carpeta de Drive para las firmas; copia sus IDs.
2. En la hoja: **Extensiones → Apps Script**, pega `apps-script/Code.gs`.
3. **Configuración del proyecto → Propiedades del script**:
   `GOOGLE_CLIENT_ID`, `SHEET_ID`, `DRIVE_FOLDER_ID` y los correos autorizados:
   `ALLOWED_EMAILS` (separados por coma) o una propiedad por correo (`ALLOWED_EMAIL1`, `ALLOWED_EMAIL2`…)
   (y `SHEETS_WEBHOOK_TOKEN` solo al activar cobros).
4. Ejecuta `autorizarPermisos` una vez.
5. **Implementar → Nueva implementación → Aplicación web**: ejecutar como *Yo*, acceso *Cualquier persona*.
   Copia la URL `/exec`.

La hoja se crea sola con encabezados, formato de moneda y lista de estatus
(Recibido, En reparación, Listo para entrega, Entregado, Anticipo pagado, Pagada, Completada).
El personal cambia el estatus directamente en la hoja; el historial lo refleja.

## 2. Inicio de sesión con Google

1. Google Cloud Console → **Pantalla de consentimiento de OAuth** (Externo).
2. **Credenciales → ID de cliente de OAuth → Aplicación web**. Orígenes autorizados:
   `https://z-pev-servicio.web.app`, el dominio propio si lo hay, y `http://localhost:5173`.
3. El mismo ID va en `VITE_GOOGLE_CLIENT_ID`, en la propiedad `GOOGLE_CLIENT_ID` de Apps Script
   y en `functions/.env`.

## 3. Desarrollo y despliegue (PowerShell)

```powershell
copy .env.example .env      # pega la URL /exec y el client ID
npm install
npm run dev                 # http://localhost:5173
npm run build
firebase deploy --only hosting
```

Con cobros activos: `firebase deploy --only functions:billing,hosting` (ver `docs/MERCADO_PAGO.md`).

## Notas

- Los términos viven en `src/terms.js`; cualquier cambio legal sube `TERMS_VERSION`.
  Pendientes de revisión legal: CUARTA («no periodo»), DÉCIMA SEXTA («PRESENTADOR»),
  DÉCIMA NOVENA («conduce»).
- Las firmas se comparten en Drive como «cualquiera con el enlace»; si se prefiere, cambia
  `saveSignature_` para limitarlas al dominio.
- La sesión dura lo que el token de Google (≈1 h) y se cierra sola al vencer.

## App instalable (teléfono y computadora)

- **Android / Chrome / Edge:** botón **Instalar app** en el login o en la barra lateral.
- **iPhone / iPad (Safari):** el mismo botón muestra los pasos: Compartir → Agregar a inicio.
- La app abre a pantalla completa con su ícono y carga sin conexión. Enviar órdenes todavía requiere señal.
- Cuando hay una versión nueva aparece el aviso **Actualizar**; no se recarga sola para no perder una orden a medio capturar.

## Modo sin conexión

- Sin señal, la orden con su firma se guarda en el teléfono (IndexedDB) y se envía sola al volver la conexión
  (al recuperar señal, al volver a la app y cada 45 s). El contador **N por enviar** muestra lo pendiente.
- El teléfono recuerda al último usuario verificado durante 7 días: puede abrir la app y capturar sin señal.
  El servidor vuelve a verificar la sesión de Google al enviar.
- Si la sesión vence, la captura no se interrumpe: la orden queda en el teléfono y una franja pide iniciar sesión.
- Cada orden lleva un **ID de captura**; si un envío llegó pero la respuesta se perdió, el reintento devuelve el
  mismo folio y no se duplica la fila.
- La hoja suma las columnas **ID de captura** y **Capturado en (dispositivo)** automáticamente.

## Fotos del vehículo

- Primera sección de la orden: **Vista completa** (obligatoria), Frente/manubrio, N° de serie, Golpes o detalles
  y hasta 4 fotos extra (máximo 8). Abre la cámara trasera del teléfono.
- Cada foto se reduce en el teléfono (1600 px, JPEG ≈ 0.72; unos 100–350 KB) antes de enviarse.
- La vista completa viaja con la orden; las demás se suben una por una. Si se cae la señal, se reanudan desde la
  cola sin repetir la orden ni duplicar fotos.
- Drive: `Firmas/Fotos/<folio>/<folio>-<toma>.jpg`. La hoja guarda **Foto principal**, **Fotos (carpeta)** y **N.º de fotos**;
  el historial muestra la miniatura de la unidad.

## Nota de servicio para el cliente

Al registrar una orden aparece **Enviar nota al cliente**: genera una imagen (PNG) con folio, fecha, hora, cliente, teléfono, vehículo, foto principal, servicio, costos y firma, y abre la hoja de compartir del teléfono (WhatsApp, correo…). El botón **PDF** genera la misma nota en PDF. Si el navegador no puede compartir archivos, la nota se descarga.

En **Historial**, el ícono de documento (o el folio) abre la nota de cualquier orden, incluidas las que se guardaron sin conexión, con los datos de la hoja (acción `detail` del Apps Script, que devuelve la firma y la foto en base64).

## Etiqueta interna con QR

El botón **Etiqueta** (en la confirmación y en la nota del Historial) imprime una etiqueta de 100 × 70 mm para pegar en el vehículo. Lleva el folio grande, la foto, el cliente, el vehículo, el servicio, la fecha y un QR. El QR abre la app en `/?folio=ZPEV-26-0001`, que muestra la nota de esa orden; para verla hay que tener sesión iniciada. Funciona con impresoras de etiquetas o con hoja normal.
