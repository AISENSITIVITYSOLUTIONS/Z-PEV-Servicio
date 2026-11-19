# Envío de la nota de servicio por WhatsApp (API de WhatsApp Cloud)

El botón **«Enviar por WhatsApp al cliente»** genera el PDF de la nota y el backend (Apps Script)
lo envía directamente al teléfono de la orden desde la línea de WhatsApp Business de Z·IA
(+52 55 6472 9389). No hay que elegir contacto ni pulsar Enviar. Cada envío queda en la pestaña
**WhatsApp** de la hoja (fecha, folio, teléfono, quién lo envió, resultado).

## 1. Plantilla en Meta (una sola vez)
WhatsApp Manager → Plantillas de mensaje → Crear plantilla (cuenta de Z·IA, WABA 1594115192518789):

| Campo | Valor |
|---|---|
| Categoría | **Utilidad** |
| Nombre | `nota_servicio` |
| Idioma | Español (MEX) — `es_MX` |
| Encabezado | **Documento** (sube cualquier PDF de muestra) |
| Cuerpo | `Hola {{1}}, Z e-Scooters México registró tu orden de servicio {{2}}. Te enviamos tu nota de servicio en PDF. Total a pagar: {{3}}. Para cualquier duda llama al 55 6501 8583.` |
| Pie | `Z e-Scooters México` |

Ejemplos de variables: `Miguel Ángel`, `ZPEV-26-0013`, `$4,640.00`. Esperar a que quede **Activa** (Meta suele aprobar Utilidad en minutos).

## 2. Propiedades del script
Apps Script → Configuración del proyecto → Propiedades del script:

| Propiedad | Valor |
|---|---|
| `WA_TOKEN` | Token permanente del System User (el mismo del bot Z·IA; empieza con `EAA`). Se obtiene con `firebase functions:secrets:access WA_TOKEN --project z-ia-whatsapp` |
| `WA_PHONE_ID` | `1451228848071523` |
| `WA_TEMPLATE` | `nota_servicio` |
| `WA_TEMPLATE_LANG` | `es_MX` |

Sin `WA_TEMPLATE`, el backend intenta un mensaje de documento directo; Meta solo lo entrega si el
cliente escribió a la línea en las últimas 24 horas.

## 3. Publicar el backend
Copiar `apps-script/Code.gs` al proyecto de Apps Script → **Implementar → Administrar implementaciones →
editar → Versión: nueva → Implementar** (la URL `/exec` no cambia).

## Errores frecuentes
| Mensaje | Causa |
|---|---|
| Falta configurar WA_TOKEN y WA_PHONE_ID | Faltan propiedades del script |
| 132001 / template does not exist | Nombre o idioma de la plantilla distintos, o aún no aprobada |
| 131047 / re-engagement | Sin plantilla y el cliente no ha escrito en 24 h: configurar `WA_TEMPLATE` |
| 190 / access token | Token vencido o mal copiado |
| 131026 | El número del cliente no tiene WhatsApp |

Las respuestas del cliente llegan a la línea de Z·IA, donde contesta el bot o un asesor.
