'use strict';
const { onRequest } = require('firebase-functions/v2/https');
const { handler } = require('./billing');

exports.billing = onRequest(
  {
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 30,
    secrets: ['MERCADOPAGO_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'SHEETS_WEBHOOK_TOKEN']
  },
  handler
);
