// Inicio de sesión con Google (Google Identity Services).
// El ID token se guarda en sessionStorage y se envía al backend, que lo verifica
// y comprueba que el correo esté autorizado. La verificación real ocurre en Apps Script.

const SESSION_KEY = 'ze-orden-session';

function decodeJwtPayload(jwt) {
  const part = jwt.split('.')[1];
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return JSON.parse(decodeURIComponent(escape(atob(b64 + pad))));
}

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s.token || !s.exp || s.exp * 1000 <= Date.now() + 15000) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch (_) {
    return null;
  }
}

let expiryTimer = 0;
let listeners = { onSignedIn: () => {}, onSignedOut: () => {} };

function storeSession(credential) {
  const payload = decodeJwtPayload(credential);
  const session = {
    token: credential,
    email: payload.email || '',
    name: payload.name || payload.email || '',
    picture: payload.picture || '',
    exp: payload.exp
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  scheduleExpiry(session);
  return session;
}

function scheduleExpiry(session) {
  clearTimeout(expiryTimer);
  const ms = session.exp * 1000 - Date.now() - 15000;
  expiryTimer = setTimeout(() => signOut(), Math.max(ms, 0));
}

export function getSession() {
  return readSession();
}

export function signOut() {
  sessionStorage.removeItem(SESSION_KEY);
  clearTimeout(expiryTimer);
  window.google?.accounts?.id?.disableAutoSelect?.();
  listeners.onSignedOut();
}

function waitForGoogle(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (window.google?.accounts?.id) return resolve(window.google.accounts.id);
      if (Date.now() - start > timeoutMs) return reject(new Error('No se cargó Google Identity Services.'));
      setTimeout(tick, 120);
    };
    tick();
  });
}

/**
 * Monta el botón de Google y restaura la sesión si sigue vigente.
 * onSignedIn(session) / onSignedOut() notifican cambios de estado.
 */
export async function initAuth({ clientId, buttonEl, onSignedIn, onSignedOut, onError }) {
  listeners = { onSignedIn, onSignedOut };

  if (!clientId) {
    onError?.('Falta configurar VITE_GOOGLE_CLIENT_ID.');
    return;
  }

  const session = readSession();
  if (session) {
    scheduleExpiry(session);
    onSignedIn(session);
    return;
  }

  try {
    const gid = await waitForGoogle();
    gid.initialize({
      client_id: clientId,
      callback: (resp) => {
        if (!resp?.credential) return onError?.('Google no devolvió credenciales.');
        const s = storeSession(resp.credential);
        onSignedIn(s);
      },
      auto_select: false,
      cancel_on_tap_outside: true,
      ux_mode: 'popup'
    });
    gid.renderButton(buttonEl, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'pill',
      logo_alignment: 'left',
      width: Math.min(buttonEl.clientWidth || 320, 400),
      locale: 'es'
    });
    onSignedOut();
  } catch (err) {
    onError?.(`${err.message} Revisa la conexión o los bloqueadores de anuncios.`);
  }
}
