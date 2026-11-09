# Pago a plazos con Aplazo

Estado: **integrado y oculto**. La sección «¿No tienes tarjeta de crédito?» aparece en la
confirmación de la orden solo con `VITE_APLAZO_ENABLED=true` (frontend) y, en la función,
`PAYMENTS_ENABLED=true` + `APLAZO_ENABLED=true`. Anticipos desde $100 MXN.

## Flujo

1. El personal registra la orden con anticipo y pulsa **Generar link de pago a plazos**.
2. `POST /billing/aplazo/checkout` verifica el ID token de Google contra `ALLOWED_EMAILS`, pide un
   Bearer nuevo (`POST /api/auth`) y crea el pago (`POST /api/loan`) con `cartId = <folio>-A<marca>`.
3. El link se copia o se envía por WhatsApp. El cliente paga en Aplazo y vuelve a `/pago.html`.
4. Aplazo notifica a `POST /billing/aplazo/webhook` con `Authorization: Bearer <APLAZO_WEBHOOK_TOKEN>`.
   La función rechaza con 400 si el token no coincide, **reconsulta** `GET /v1/loan/status` y, si está
   `ACTIVO`, marca la orden: `Pago anticipo = Pagado`, `Método de pago = Aplazo`, `Estatus = Anticipo pagado`.
5. `aplazoSweep` (cada 60 min) concilia los links pendientes (pagos sin webhook) y cancela los que
   llevan más de `APLAZO_TTL_HOURS` sin pagarse.

Reglas de carrito: un solo link vigente por folio. El mismo monto reutiliza el link; un monto distinto
cancela el anterior y genera un `cartId` nuevo. Si el link anterior ya se pagó, no se genera otro.

## Rutas para el personal (Bearer = ID token de Google)

| Ruta | Uso |
|---|---|
| `POST /billing/aplazo/checkout` | `{ folio, amount, nombre, telefono, concepto }` → `{ url, cartId, loanId }` |
| `GET /billing/aplazo/status?folio=` | Estado del pago y sincronización con la hoja |
| `POST /billing/aplazo/cancel` | `{ folio }` cancela el link vigente no pagado |
| `POST /billing/aplazo/refund` | `{ folio, amount, reason }` reembolso total o parcial |
| `GET /billing/aplazo/refunds?folio=` | Estado de los reembolsos |

## Hoja «Órdenes»

Columnas nuevas (se agregan solas): `Método de pago`, `Aplazo cartId`, `Aplazo loanId`, `Aplazo link`,
`Aplazo monto`, `Aplazo estado` (Reservado, Pendiente, Pagado, Cancelado, Cancelado (vencido),
Cancelado (reemplazado), Error, Reembolso parcial, Reembolso total), `Aplazo actualizado`,
`Aplazo reembolsado`, `Aplazo generado por`.

## Configuración

Secretos (patrón sin BOM de `docs/MERCADO_PAGO.md`):

| Secreto | Origen |
|---|---|
| `APLAZO_API_TOKEN` | API token de sandbox que entrega Aplazo (producción solo tras certificar) |
| `APLAZO_WEBHOOK_TOKEN` | Cadena aleatoria larga; se entrega a Aplazo para que la envíe como Bearer en el webhook |
| `SHEETS_WEBHOOK_TOKEN` | Ya existente; también en propiedades de Apps Script |

`functions/.env`: `APLAZO_ENABLED`, `APLAZO_ENV` (`sandbox` → dominios `.net`, `production` → `.mx`),
`APLAZO_MERCHANT_ID`, `APLAZO_SHOP_ID`, `APLAZO_MIN_AMOUNT_MXN`, `APLAZO_MAX_AMOUNT_MXN`, `APLAZO_TTL_HOURS`.
`ALLOWED_EMAILS` debe incluir a todo el personal que genere links (no se lee de Apps Script).

## Activación (sandbox)

1. Pegar `apps-script/Code.gs` actualizado en el proyecto «Z-PEV Servicio API» y **actualizar la
   implementación** (Implementar → Gestionar implementaciones → Editar → Nueva versión), sin cambiar la URL.
2. Guardar `APLAZO_API_TOKEN` y `APLAZO_WEBHOOK_TOKEN` en Secret Manager.
3. `functions/.env`: `PAYMENTS_ENABLED=true`, `APLAZO_ENABLED=true`, `APLAZO_ENV=sandbox`, `APLAZO_MERCHANT_ID`.
4. Enviar a Aplazo: webhook `https://z-pev-servicio.web.app/billing/aplazo/webhook` y el token Bearer.
5. `firebase deploy --only functions:billing,functions:aplazoSweep,hosting` (requiere plan Blaze y
   Cloud Scheduler para `aplazoSweep`).
6. `GET /billing/health` → `aplazo` con todo en `true`.
7. `.env` del frontend: `VITE_APLAZO_ENABLED=true`, `npm run build`, desplegar hosting.
8. Probar con los teléfonos y la OTP de sandbox que entregó Aplazo.

## Matriz de certificación

| # | Criterio | Estado |
|---|---|---|
| 1.1 | Aplazo como opción clara | Sección propia «¿No tienes tarjeta de crédito?» |
| 1.2 | Widget de Aplazo | N/A a confirmar: no hay página de producto ni checkout público; el link se genera en el taller |
| 1.3 | Guías de marca | Pendiente: falta el logo oficial de Aplazo (`public/brand/`) |
| 2.1–2.6 | cartId, productos, successUrl, webHookUrl, cartUrl, errorUrl | Sí |
| 3.1 | cartId único global | Sí (`folio` + marca de tiempo) |
| 3.2 | Carrito modificado → cartId nuevo | Sí (monto distinto) |
| 3.3 | Sin loans duplicados por cartId | Sí (reutiliza el link; reserva con LockService) |
| 4.1 | Cancelaciones | Sí (`/cancel`, reemplazo y vencimiento) |
| 4.2 | Cancelación automática por inactividad | Sí (`aplazoSweep`, `APLAZO_TTL_HOURS`) |
| 4.3 | Pago de carrito desactualizado bloqueado | Sí (se cancela el carrito anterior) |
| 5.1 | Confirmación por webhook | Sí |
| 5.2 | Webhook responde 200 | Sí (400 solo con token inválido, como indica Aplazo) |
| 5.3 | Verificación por GET de estado | Sí (webhook y conciliación) |
| 6.1 | Reembolsos por API | Sí (`/refund`) |
| 6.2 | Reembolsos desde el Panel del Merchant | Operativo (fuera de la app) |
| 6.3 / 6.4 | Reembolso total / parcial | Sí |
| 7.1 | Se almacena el loanId | Sí (hoja) |
| 7.2 / 7.3 | Liquidación por SFTP / Panel | Operativo: Panel del Merchant; SFTP no implementado |
