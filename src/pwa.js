// App instalable: registro del service worker, botón "Instalar" y aviso de versión nueva.
//  - Android / Chrome / Edge: usa el evento beforeinstallprompt (instalación de un toque).
//  - iPhone / iPad (Safari): no existe ese evento; se muestra una hoja con los pasos
//    Compartir → Agregar a inicio.
import { registerSW } from 'virtual:pwa-register';

const $ = (s) => document.querySelector(s);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function initPWA() {
  const buttons = [$('#installBtn'), $('#installBtnLogin')].filter(Boolean);
  const show = (on) => buttons.forEach((b) => { b.hidden = !on; });
  let deferred = null;

  if (isStandalone()) {
    document.documentElement.classList.add('is-standalone');
  } else if (isIOS()) {
    show(true);
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    show(true);
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    show(false);
  });

  buttons.forEach((b) =>
    b.addEventListener('click', async () => {
      if (deferred) {
        deferred.prompt();
        const { outcome } = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
        if (outcome === 'accepted') show(false);
        deferred = null;
        return;
      }
      if (isIOS()) openIosSheet();
    })
  );

  const sheet = $('#iosSheet');
  const openIosSheet = () => {
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add('is-in'));
    $('#iosClose').focus();
  };
  const closeIosSheet = () => {
    sheet.classList.remove('is-in');
    sheet.hidden = true;
  };
  $('#iosClose').addEventListener('click', closeIosSheet);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeIosSheet(); });

  // Service worker con aviso de actualización (no recarga sola: puede haber una orden a medio capturar).
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    const updateSW = registerSW({
      onNeedRefresh() {
        $('#updateBar').hidden = false;
      }
    });
    $('#updateBtn').addEventListener('click', () => updateSW(true));
  }
}
