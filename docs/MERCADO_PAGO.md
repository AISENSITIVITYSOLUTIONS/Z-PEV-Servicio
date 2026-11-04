# Cobro del anticipo con Mercado Pago

Estado: **integrado y oculto**. Ni la interfaz ni la función cobran mientras
`VITE_PAYMENTS_ENABLED` (frontend) y `PAYMENTS_ENABLED` (función) no valgan `true`.

## Flujo

1. El personal registra la orden con anticipo mayor a cero.
2. En la confirmación aparece **Generar link de pago del anticipo** (solo si está activo).
3. `POST /billing/checkout` verifica el ID token de Google y la lista `ALLOWED_EMAILS`,
   y crea una preferencia de Checkout Pro (pago único, MXN, vigencia 72 h) con
   `external_reference = folio`.
4. El link se copia o se envía al cliente por WhatsApp.
5. Mercado Pago notifica a `POST /billing/webhook`. La función valida `x-signature`
   (HMAC-SHA256, fail-closed), **reconsulta el pago en la API** y llama a Apps Script
   (`action: payment`, autenticado con `SHEETS_WEBHOOK_TOKEN`).
6. En la hoja: `Pago anticipo = Pagado`, `Referencia de pago = <id>` y `Estatus = Anticipo pagado`.

## Despliegue

Sin `pinTag` en `firebase.json`, así que basta:

```powershell
npm run build
firebase deploy --only functions:billing,hosting
```

Si en el futuro se agrega `"pinTag": true` a la reescritura de `/billing/**`, la función
debe ir siempre junto con `hosting` en el mismo `--only`.

## Secretos (Secret Manager) — usar el patrón sin BOM

```powershell
$token = Read-Host "Pega el valor del secreto y presiona Enter"
$clean = $token.TrimStart([char]0xFEFF).Trim()
[System.IO.File]::WriteAllBytes("$env:TEMP\sec.txt", [System.Text.Encoding]::UTF8.GetBytes($clean))
cmd /c "type %TEMP%\sec.txt | firebase functions:secrets:set NOMBRE_DEL_SECRETO"
Remove-Item "$env:TEMP\sec.txt"
```

| Secreto | Origen |
|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | Desarrolladores → Credenciales de producción (`APP_USR-…`) |
| `MP_WEBHOOK_SECRET` | Clave secreta mostrada al registrar el webhook |
| `SHEETS_WEBHOOK_TOKEN` | Cadena aleatoria larga; la misma en propiedades de Apps Script |

## Variables en `functions/.env` (no versionado)

Ver `functions/.env.example`. En producción: `PAYMENTS_ENABLED=true`, `BILLING_MOCK=false`.

## Checklist de activación

1. Proyecto Firebase creado y `.firebaserc` con su ID.
2. Secretos guardados con el patrón sin BOM.
3. `functions/.env` con `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS`, `PUBLIC_BASE_URL`, `SHEETS_API_URL`.
4. Propiedad `SHEETS_WEBHOOK_TOKEN` en Apps Script (mismo valor que el secreto).
5. Webhook en Mercado Pago: `https://<dominio>/billing/webhook`, modo productivo, evento **Pagos**.
6. Probar primero con `BILLING_MOCK=true` (devuelve un link de prueba, no cobra).
7. `GET https://<dominio>/billing/health` debe mostrar todo en `true`.
8. Activar `PAYMENTS_ENABLED=true` y `VITE_PAYMENTS_ENABLED=true`, reconstruir y desplegar.
9. Prueba real con una cuenta distinta a la dueña de Mercado Pago (MP rechaza
   "payer and collector cannot be the same user").

## Diagnóstico

```powershell
firebase functions:log --only billing | Select-Object -Last 20
```

Los registros están en UTC (CDMX = UTC−6).
