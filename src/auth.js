// Inicio de sesión con Google (Google Identity Services).
//
// - El ID token de Google (≈1 h) se guarda en localStorage para sobrevivir al cierre de la app
//   instalada. El backend lo verifica en cada envío; el navegador solo lo usa para mostrar al usuario.
// - "Usuario conocido": tras un inicio de sesión válido, el equipo recuerda nombre y correo 7 días.
//   Sin señal no es posible iniciar sesión con Google, así que con un usuario conocido se permite
//   capturar órdenes en modo sin conexión; se envían cuando hay señal y una sesión vigente.
// - Al vencer el token: con señal se pide iniciar sesión de nuevo; sin señal se sigue en modo sin conexión.

const SESSION_KEY = 'zpev-sesion';
const KNOWN_KEY = 'zpev-usuario';
const KNOWN_TTL = 7 * 24 * 3600 * 1000;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* noop */ } }
};

function decodeJwtPayload(jwt) {
  const part = jwt.split('.')[1];
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return JSON.parse(decodeURIComponent(escape(atob(b64 + pad))));
}

/** Sesión con token vigente (margen de 30 s), o null. */
export function getSession() {
  const s = store.get(SESSION_KEY);
  if (!s || !s.token || !s.exp || s.exp * 1000 <= Date.now() + 30000) return null;
  return s;
}

/** Último usuario verificado en este equipo (7 días), o null. */
export function getKnownUser() {
  const u = store.get(KNOWN_KEY);
  if (!u || !u.email || Date.now() - u.at > KNOWN_TTL) return null;
  return u;
}

let listeners = { onSignedIn: () => {}, onSignedOut: () => {}, onExpired: () => {} };
let expiryTimer = 0;

function scheduleExpiry(session) {
  clearTimeout(expiryTimer);
  const ms = session.exp * 1000 - Date.now() - 30000;
  expiryTimer = setTimeout(() => listeners.onExpired(), Math.max(ms, 0));
}

function storeSession(credential) {
  const p = decodeJwtPayload(credential);
  const session = { token: credential, email: p.email || '', name: p.name || p.email || '', picture: p.picture || '', exp: p.exp };
  store.set(SESSION_KEY, session);
  store.set(KNOWN_KEY, { email: session.email, name: session.name, picture: session.picture, at: Date.now() });
  scheduleExpiry(session);
  return session;
}

export function signOut() {
  store.del(SESSION_KEY);
  store.del(KNOWN_KEY);
  clearTimeout(expiryTimer);
  window.google?.accounts?.id?.disableAutoSelect?.();
  listeners.onSignedOut();
}

function waitForGoogle(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (window.google?.accounts?.id) return resolve(window.google.accounts.id);
      if (Date.now() - start > timeoutMs) return reject(new Error('No se cargó el inicio de sesión de Google.'));
      setTimeout(tick, 120);
    };
    tick();
  });
}

let gidReady = null;
let buttonEl = null;

/** Prepara el botón de Google (requiere señal). Se puede llamar varias veces. */
export function renderGoogleButton() {
  if (!gidReady) return Promise.resolve(false);
  return gidReady.then((gid) => {
    if (!gid || !buttonEl) return false;
    gid.renderButton(buttonEl, {
      type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill',
      logo_alignment: 'left', width: Math.min(buttonEl.clientWidth || 320, 400), locale: 'es'
    });
    return true;
  });
}

/**
 * onSignedIn(session)   sesión vigente (al entrar o tras iniciar sesión)
 * onOffline(user)       sin señal y con usuario conocido: entrar en modo sin conexión
 * onSignedOut()         mostrar inicio de sesión
 * onExpired()           el token venció con la app abierta
 * onError(msg)          problema de configuración o de carga
 */
export function initAuth({ clientId, buttonEl: el, onSignedIn, onSignedOut, onOffline, onExpired, onError }) {
  listeners = { onSignedIn, onSignedOut, onExpired };
  buttonEl = el;

  if (!clientId) {
    onError?.('Falta configurar VITE_GOOGLE_CLIENT_ID.');
    return;
  }

  gidReady = waitForGoogle()
    .then((gid) => {
      gid.initialize({
        client_id: clientId,
        callback: (resp) => {
          if (!resp?.credential) return onError?.('Google no devolvió credenciales.');
          onSignedIn(storeSession(resp.credential));
        },
        auto_select: false,
        cancel_on_tap_outside: true,
        ux_mode: 'popup'
      });
      return gid;
    })
    .catch(() => null);

  const session = getSession();
  if (session) {
    scheduleExpiry(session);
    onSignedIn(session);
    return;
  }

  const known = getKnownUser();
  if (known && !navigator.onLine) {
    onOffline(known);
    return;
  }

  onSignedOut();
  renderGoogleButton().then((ok) => {
    if (!ok) {
      if (known) onOffline(known);
      else onError?.(navigator.onLine
        ? 'No se cargó el inicio de sesión de Google. Revisa la conexión o los bloqueadores de anuncios.'
        : 'Sin conexión. Inicia sesión una vez con señal para poder capturar órdenes sin conexión.');
    }
  });
}
