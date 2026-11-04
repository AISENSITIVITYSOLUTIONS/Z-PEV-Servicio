// Pad de firma con trazo suave, grosor por velocidad y plano 3D reactivo.
// Los trazos se guardan en píxeles CSS para poder redibujarlos al cambiar el tamaño
// y exportarlos en alta resolución.

const INK = '#0F1115';
const SHADOW = 'rgba(15,17,21,0.28)';
const MIN_W = 1.2;
const MAX_W = 3.4;

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Dibuja un trazo como segmentos cuadráticos con grosor propio (escala s).
function drawStroke(ctx, pts, s) {
  if (pts.length === 0) return;
  ctx.save();
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = 2 * s;
  ctx.shadowOffsetY = 1.2 * s;

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x * s, pts[0].y * s, (pts[0].w * s) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const a = i === 1 ? prev : mid(pts[i - 2], prev);
    const b = i === pts.length - 1 ? cur : mid(prev, cur);
    ctx.lineWidth = cur.w * s;
    ctx.beginPath();
    ctx.moveTo(a.x * s, a.y * s);
    ctx.quadraticCurveTo(prev.x * s, prev.y * s, b.x * s, b.y * s);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Monta el pad de firma dentro de `scene` (contenedor con #sigPlane y #sigCanvas).
 * onChange(hasInk) se llama al empezar o borrar trazos.
 */
export function mountSignature(scene, { canvas, plane, hintEl, stateEl, undoBtn, clearBtn, onChange }) {
  const ctx = canvas.getContext('2d');
  const strokes = [];
  let current = null;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let lastPt = null;
  let lastW = 2;

  const setState = () => {
    const has = strokes.length > 0;
    scene.classList.toggle('has-ink', has);
    hintEl.classList.toggle('is-hidden', has);
    stateEl.textContent = has ? 'Firma registrada' : 'Sin firma';
    stateEl.classList.toggle('is-ok', has);
    undoBtn.disabled = !has;
    clearBtn.disabled = !has;
    onChange?.(has);
  };

  const redraw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    strokes.forEach((st) => drawStroke(ctx, st, 1));
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    cssW = rect.width;
    cssH = rect.height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    redraw();
  };

  const pointFrom = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = pointFrom(e);
    current = [{ ...p, w: lastW, t: performance.now() }];
    lastPt = p;
    scene.classList.add('is-drawing');
    drawStroke(ctx, current, 1);
  };

  const onMove = (e) => {
    if (!current) return;
    const p = pointFrom(e);
    const now = performance.now();
    const last = current[current.length - 1];
    const dist = Math.hypot(p.x - last.x, p.y - last.y);
    if (dist < 1.2) return;
    const dt = Math.max(now - last.t, 1);
    const speed = dist / dt; // px por ms
    const target = Math.min(MAX_W, Math.max(MIN_W, 3.6 - speed * 2.2));
    lastW += (target - lastW) * 0.35;
    current.push({ x: p.x, y: p.y, w: lastW, t: now });

    // Redibujado incremental del último tramo
    const n = current.length;
    const seg = current.slice(Math.max(0, n - 3));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStroke(ctx, seg, 1);
    lastPt = p;
  };

  const onUp = (e) => {
    if (!current) return;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) { /* noop */ }
    if (current.length > 0) {
      strokes.push(current);
    }
    current = null;
    scene.classList.remove('is-drawing');
    redraw();
    setState();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.buttons === 0) onUp(e);
  });

  // Inclinación 3D siguiendo el puntero + brillo especular
  const tilt = (e) => {
    const rect = plane.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const ry = (px - 0.5) * 7;
    const rx = (0.5 - py) * 5;
    plane.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
    plane.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    plane.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
    plane.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
  };
  const untilt = () => {
    plane.style.setProperty('--rx', '0deg');
    plane.style.setProperty('--ry', '0deg');
  };
  scene.addEventListener('pointermove', tilt);
  scene.addEventListener('pointerleave', untilt);

  undoBtn.addEventListener('click', () => {
    if (!strokes.length) return;
    strokes.pop();
    redraw();
    setState();
  });
  clearBtn.addEventListener('click', () => {
    strokes.length = 0;
    redraw();
    setState();
  });

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  setState();

  /**
   * Exporta la firma como PNG recortado al trazo, fondo blanco, 2× de resolución.
   * Devuelve null si no hay trazos.
   */
  const toDataURL = () => {
    if (!strokes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    strokes.forEach((st) =>
      st.forEach((p) => {
        minX = Math.min(minX, p.x - p.w);
        minY = Math.min(minY, p.y - p.w);
        maxX = Math.max(maxX, p.x + p.w);
        maxY = Math.max(maxY, p.y + p.w);
      })
    );
    const pad = 14;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(cssW, maxX + pad);
    maxY = Math.min(cssH, maxY + pad);
    const w = maxX - minX;
    const h = maxY - minY;
    const s = 2;
    const off = document.createElement('canvas');
    off.width = Math.round(w * s);
    off.height = Math.round(h * s);
    const octx = off.getContext('2d');
    octx.fillStyle = '#FFFFFF';
    octx.fillRect(0, 0, off.width, off.height);
    octx.translate(-minX * s, -minY * s);
    strokes.forEach((st) => drawStroke(octx, st, s));
    return off.toDataURL('image/png');
  };

  const hasInk = () => strokes.length > 0;

  return { toDataURL, hasInk, clear: () => clearBtn.click(), destroy: () => ro.disconnect() };
}
