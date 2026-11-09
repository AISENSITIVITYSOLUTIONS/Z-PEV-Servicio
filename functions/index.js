'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { handler } = require('./billing');
const aplazo = require('./aplazo');

const SECRETS = ['MERCADOPAGO_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'SHEETS_WEBHOOK_TOKEN', 'APLAZO_API_TOKEN', 'APLAZO_WEBHOOK_TOKEN'];

exports.billing = onRequest(
  { region: 'us-central1', memory: '256MiB', timeoutSeconds: 60, secrets: SECRETS },
  handler
);

// Concilia los links de Aplazo pendientes (pagos sin webhook) y cancela los vencidos.
exports.aplazoSweep = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'America/Mexico_City', region: 'us-central1', secrets: SECRETS, timeoutSeconds: 300 },
  async () => {
    const r = await aplazo.sweep();
    console.log('aplazoSweep', JSON.stringify(r));
  }
);
