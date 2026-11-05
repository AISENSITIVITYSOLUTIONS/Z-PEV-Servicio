// Cola de órdenes pendientes en el teléfono (IndexedDB).
// Cada orden lleva un clientId único: si un envío llegó al servidor pero la respuesta se perdió,
// el reintento no duplica la fila (Apps Script devuelve el folio ya asignado).

const DB = 'zpev';
const STORE = 'pendientes';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'clientId' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const newClientId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function enqueue(order) {
  const item = { clientId: order.clientId, order, queuedAt: Date.now(), attempts: 0, error: '' };
  return tx('readwrite', (s) => s.put(item)).then(() => item);
}

export function listPending() {
  return tx('readonly', (s) => s.getAll()).then((all) => (all || []).sort((a, b) => a.queuedAt - b.queuedAt));
}

export function removePending(clientId) {
  return tx('readwrite', (s) => s.delete(clientId));
}

export function updatePending(item) {
  return tx('readwrite', (s) => s.put(item));
}

/** Pide al navegador no borrar estos datos cuando falta espacio (Chrome/Android; en iOS se ignora). */
export function requestPersistence() {
  try { navigator.storage?.persist?.(); } catch (_) { /* noop */ }
}

// Error de red (sin señal, servidor inalcanzable) frente a respuesta del servidor con error.
export const isNetworkError = (err) =>
  Boolean(err) && (err.name === 'TypeError' || err.name === 'AbortError' || /Failed to fetch|NetworkError|Load failed|network|timeout/i.test(err.message));
// Sesión vencida o inválida: se resuelve iniciando sesión de nuevo y reintentando.
export const isAuthError = (err) => Boolean(err) && /sesi[oó]n|token no corresponde/i.test(err.message);
