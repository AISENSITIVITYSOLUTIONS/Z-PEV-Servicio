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
   - `ACCESS_KEY` → la clave que usará el personal (elige una propia).
   - `SHEET_ID` → ID de la hoja.
   - `DRIVE_FOLDER_ID` → ID de la carpeta.
5. En el editor, selecciona la función `autorizarPermisos` y ejecútala una vez para aceptar permisos.
6. **Implementar → Nueva implementación → Tipo: Aplicación web**.
   - Ejecutar como: **Yo**.
   - Quién tiene acceso: **Cualquier persona**.
   - Copia la URL que termina en `/exec`.

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

- El personal abre la app, escribe la **clave del equipo** en la barra lateral (se recuerda en ese navegador).
- Captura la orden. La vista previa se actualiza en vivo.
- El cliente lee los términos hasta el final, marca la casilla y firma en el recuadro.
- **Enviar** guarda la fila en la hoja con folio `ZE-AAAAMMDD-NNNN` y la firma en Drive.

## Notas

- La firma se guarda como PNG recortado al trazo, con fondo blanco y 2× de resolución.
- Los términos están en `src/terms.js`. Cualquier cambio legal debe reflejarse ahí y subir `TERMS_VERSION`.
  Los puntos pendientes de revisión legal están marcados en el encabezado de ese archivo.
- La clave de acceso es una protección ligera. Para control por persona, pasar a inicio de sesión de Google o Firebase Auth.
- El pago en línea (anticipo con Mercado Pago) no está incluido en esta versión.
