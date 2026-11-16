'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { handler } = require('./billing');
const aplazo = require('./aplazo');

// Mercado Pago (oculto). Se despliega por separado: firebase deploy --only functions:billing
exports.billing = onRequest(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 30,
    secrets: ['MERCADOPAGO_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'SHEETS_WEBHOOK_TOKEN']
  },
  handler
);

// Aplazo: función propia, solo con sus secretos. Hosting reescribe /billing/aplazo/** aquí.
const APLAZO_SECRETS = ['APLAZO_API_TOKEN', 'APLAZO_WEBHOOK_TOKEN', 'SHEETS_WEBHOOK_TOKEN'];

exports.aplazo = onRequest(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, secrets: APLAZO_SECRETS },
  aplazo.handler
);

// Concilia los links de Aplazo pendientes (pagos sin webhook) y cancela los vencidos.
exports.aplazoSweep = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'America/Mexico_City', region: 'us-central1', secrets: APLAZO_SECRETS, timeoutSeconds: 300 },
  async () => {
    const r = await aplazo.sweep();
    console.log('aplazoSweep', JSON.stringify(r));
  }
);
