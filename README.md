# Orden de servicio · Z e-Scooters MX

Formulario y firma digital de la orden de servicio. Cada orden se guarda en Google Sheets
(hoja **Órdenes**) con folio, datos del vehículo, pagos y un enlace a la firma en Drive.

Stack: Vite + JavaScript + three.js (logo 3D) + Google Apps Script (backend).

## 1. Backend en Google Sheets

1. Crea una hoja de cálculo en Google Sheets (cualquier nombre). Copia su **ID**
   (el tramo entre `/d/` y `/edit` en la URL).
2. Crea una carpeta en Drive para las firmas y copia su **ID** (el final de la URL de la carpeta).
3. En la hoja: **Extensiones → Apps Script**. Borra el contenido y pega `apps-script/Code.gs`.
4. **Configuración del proyecto → Propiedades del script → Agregar**:
   - `GOOGLE_CLIENT_ID` → ID de cliente OAuth (ver sección 1b).
   - `ALLOWED_EMAILS` → correos autorizados, separados por coma (ej. `ana@x.mx,luis@x.mx`).
   - `SHEET_ID` → ID de la hoja.
   - `DRIVE_FOLDER_ID` → ID de la carpeta.
5. En el editor, selecciona la función `autorizarPermisos` y ejecútala una vez para aceptar permisos.
6. **Implementar → Nueva implementación → Tipo: Aplicación web**.
   - Ejecutar como: **Yo**.
   - Quién tiene acceso: **Cualquier persona**.
   - Copia la URL que termina en `/exec`.

## 1b. Inicio de sesión con Google (Google Cloud Console)

1. Google Cloud Console → **APIs y servicios → Pantalla de consentimiento de OAuth**: tipo *Externo*, nombre
   «Orden de servicio · Z e-Scooters», correo de soporte. Estado de publicación: *En producción* o agrega los usuarios de prueba.
2. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web**.
   - Orígenes de JavaScript autorizados: la URL donde publicarás la app (ej. `https://orden.zescootersmx.com`) y `http://localhost:5173` para desarrollo.
3. Copia el ID de cliente en `VITE_GOOGLE_CLIENT_ID` (frontend) y en la propiedad `GOOGLE_CLIENT_ID` (Apps Script). Es el mismo valor.

## 2. Frontend

```bash
cp .env.example .env          # pega tu URL de /exec en VITE_API_URL
npm install
npm run dev                   # desarrollo en http://localhost:5173
npm run build                 # genera dist/ para publicar
```

Publica `dist/` en cualquier hosting estático (Firebase Hosting, Netlify, Vercel o el sitio de zescootersmx.com).
Si usas Firebase Hosting con el mismo proyecto que AllAIs o www.nni.ai, usa un sitio separado.

## 3. Uso diario

- El personal entra con su cuenta de Google. Solo entran los correos listados en `ALLOWED_EMAILS`.
  La sesión dura lo que dure el token de Google (aprox. 1 h) y se cierra sola al vencer.
- Captura la orden. La vista previa se actualiza en vivo.
- El cliente lee los términos hasta el final, marca la casilla y firma en el recuadro.
- **Enviar** guarda la fila en la hoja con folio `ZE-AAAAMMDD-NNNN` y la firma en Drive.

## Notas

- La firma se guarda como PNG recortado al trazo, con fondo blanco y 2× de resolución.
- Los términos están en `src/terms.js`. Cualquier cambio legal debe reflejarse ahí y subir `TERMS_VERSION`.
  Los puntos pendientes de revisión legal están marcados en el encabezado de ese archivo.
- El pago en línea (anticipo con Mercado Pago) no está incluido en esta versión.
