// Fotos del vehículo en la recepción.
// 4 tomas guiadas (la vista completa es obligatoria: identifica la unidad aunque haya dos modelos
// iguales) y hasta 4 extra para golpes, rayones o accesorios. Cada foto se reduce en el teléfono
// a 1600 px por lado y JPEG ~0.72 (≈250–350 KB) antes de guardarse o enviarse.

export const SLOTS = [
  { id: 'vista', label: 'Vista completa', hint: 'Toda la unidad, de lado', required: true },
  { id: 'frente', label: 'Frente / manubrio', hint: 'Display y controles' },
  { id: 'serie', label: 'N° de serie', hint: 'Etiqueta o grabado' },
  { id: 'detalle', label: 'Golpes o detalles', hint: 'Daños visibles' }
];
export const MAX_EXTRA = 4;
const MAX_SIDE = 1600;
const QUALITY = 0.72;

const ICON_CAM = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const ICON_X = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_PLUS = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

/** Reduce y comprime una imagen; devuelve un data URL JPEG. Respeta la orientación EXIF. */
export async function compressImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bitmap.width;
  const h = bitmap.height;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', QUALITY);
}

/**
 * Monta la sección de fotos dentro de `root`. onChange() se llama al agregar o quitar fotos.
 * Devuelve { list(), main(), count(), clear() }.
 */
export function mountPhotos(root, { onChange, onError } = {}) {
  const photos = new Map(); // id → { slot, label, dataUrl }
  let extraSeq = 0;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.setAttribute('capture', 'environment');
  input.hidden = true;
  root.append(input);
  let pending = null;

  const pick = (id, label) => {
    pending = { id, label };
    input.value = '';
    input.click();
  };

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file || !pending) return;
    const target = pending;
    const tile = root.querySelector(`[data-photo="${target.id}"]`);
    tile?.classList.add('is-loading');
    try {
      const dataUrl = await compressImage(file);
      photos.set(target.id, { slot: target.id, label: target.label, dataUrl });
      render();
      onChange?.();
    } catch (err) {
      tile?.classList.remove('is-loading');
      onError?.(err.message || 'No se pudo procesar la foto.');
    }
  });

  function tileFor(id, label, hint, required) {
    const p = photos.get(id);
    const tile = document.createElement('div');
    tile.className = 'photo-tile' + (p ? ' has-photo' : '') + (required ? ' is-required' : '');
    tile.dataset.photo = id;
    if (p) {
      tile.innerHTML = `<img alt="" /><span class="photo-cap"></span>
        <button type="button" class="photo-del" aria-label="Quitar foto">${ICON_X}</button>
        <button type="button" class="photo-redo">Repetir</button>`;
      tile.querySelector('img').src = p.dataUrl;
      tile.querySelector('img').alt = label;
      tile.querySelector('.photo-cap').textContent = label;
      tile.querySelector('.photo-del').addEventListener('click', () => {
        photos.delete(id);
        render();
        onChange?.();
      });
      tile.querySelector('.photo-redo').addEventListener('click', () => pick(id, label));
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo-add';
      btn.innerHTML = `${ICON_CAM}<span class="photo-label"></span><span class="photo-hint"></span>`;
      btn.querySelector('.photo-label').textContent = label + (required ? ' *' : '');
      btn.querySelector('.photo-hint').textContent = hint;
      btn.addEventListener('click', () => pick(id, label));
      tile.append(btn);
    }
    return tile;
  }

  function render() {
    const grid = root.querySelector('.photo-grid');
    const tiles = SLOTS.map((s) => tileFor(s.id, s.label, s.hint, s.required));
    const extras = [...photos.values()].filter((p) => p.slot.startsWith('extra'));
    extras.forEach((p) => tiles.push(tileFor(p.slot, p.label, '', false)));
    if (extras.length < MAX_EXTRA) {
      const more = document.createElement('div');
      more.className = 'photo-tile is-more';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo-add';
      btn.innerHTML = `${ICON_PLUS}<span class="photo-label">Agregar foto</span><span class="photo-hint">${MAX_EXTRA - extras.length} disponibles</span>`;
      btn.addEventListener('click', () => {
        extraSeq += 1;
        pick(`extra${extraSeq}`, `Extra ${extras.length + 1}`);
      });
      more.append(btn);
      tiles.push(more);
    }
    grid.replaceChildren(...tiles);
    const n = photos.size;
    root.querySelector('.photo-count').textContent = `${n} de ${SLOTS.length + MAX_EXTRA}`;
  }

  render();

  const ordered = () => {
    const order = [...SLOTS.map((s) => s.id)];
    return [...photos.values()].sort((a, b) => {
      const ia = order.indexOf(a.slot);
      const ib = order.indexOf(b.slot);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.slot.localeCompare(b.slot);
    });
  };

  return {
    list: () => ordered().map((p) => ({ slot: p.slot, label: p.label, dataUrl: p.dataUrl })),
    main: () => photos.get('vista') || null,
    count: () => photos.size,
    clear: () => { photos.clear(); extraSeq = 0; render(); onChange?.(); }
  };
}
