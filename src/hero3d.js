import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// Contorno de la Z de la marca (coordenadas 0–100 × 0–120).
// Trazo superior horizontal, banda diagonal con el corte de rayo y barra inferior.
const Z_OUTLINE = [
  [0, 120], [100, 120], [100, 96], [30, 28], [100, 28],
  [100, 0], [0, 0], [0, 24], [70, 92], [0, 92]
];

const RED = new THREE.Color('#E01B24');
const SILVER = new THREE.Color('#B7BABE');

function buildZShape() {
  const shape = new THREE.Shape();
  Z_OUTLINE.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  return shape;
}

// Colorea cada triángulo: encima de la línea central de la diagonal, rojo; debajo, plata.
function colorize(geometry) {
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const c = cy - 0.971 * cx - 11.4 > 0 ? RED : SILVER;
    for (let k = 0; k < 3; k++) {
      colors.set([c.r, c.g, c.b], (i + k) * 3);
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function shadowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(15,17,21,0.55)');
  g.addColorStop(0.6, 'rgba(15,17,21,0.12)');
  g.addColorStop(1, 'rgba(15,17,21,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Monta el logo 3D de la marca en un canvas.
 * Devuelve { destroy } para liberar WebGL.
 */
export function mountHero(canvas) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 500);
  camera.position.set(0, 0, 292);

  // Z extruida con bisel suave
  const shape = buildZShape();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 26,
    bevelEnabled: true,
    bevelThickness: 5,
    bevelSize: 3.2,
    bevelSegments: 5,
    curveSegments: 1
  });
  colorize(geometry);
  geometry.center();
  geometry.computeVertexNormals();

  const material = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    metalness: 0.28,
    roughness: 0.3,
    clearcoat: 1,
    clearcoatRoughness: 0.16,
    reflectivity: 0.6
  });

  const logo = new THREE.Mesh(geometry, material);
  const pivot = new THREE.Group();
  pivot.add(logo);
  scene.add(pivot);

  // Sombra de contacto en el suelo virtual
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.85 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -92;
  scene.add(shadow);

  // Luces
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(90, 140, 160);
  const rim = new THREE.DirectionalLight(0xffffff, 1.1);
  rim.position.set(-160, 60, -120);
  const fill = new THREE.AmbientLight(0xffffff, 0.25);
  scene.add(key, rim, fill);

  // Interacción: el logo se inclina hacia el puntero
  const target = { x: 0, y: 0 };
  const current = { x: 0, y: 0 };
  const onPointer = (e) => {
    const rect = canvas.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    target.y = nx * 0.9;
    target.x = ny * 0.5;
  };
  const onLeave = () => {
    target.x = 0;
    target.y = 0;
  };
  const host = canvas.parentElement;
  host.addEventListener('pointermove', onPointer);
  host.addEventListener('pointerleave', onLeave);

  // Tamaño
  const resize = () => {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // Solo animar cuando el canvas está visible
  let visible = true;
  const io = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  });
  io.observe(canvas);

  let raf = 0;
  const clock = new THREE.Clock();
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!visible) return;
    const t = clock.getElapsedTime();
    const idle = reduceMotion ? 0 : Math.sin(t * 0.7) * 0.08;
    current.x += (target.x + idle * 0.4 - current.x) * 0.06;
    current.y += (target.y + idle - current.y) * 0.06;
    pivot.rotation.x = current.x;
    pivot.rotation.y = current.y;
    pivot.position.y = reduceMotion ? 0 : Math.sin(t * 1.1) * 3;
    renderer.render(scene, camera);
  };
  tick();

  return {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      host.removeEventListener('pointermove', onPointer);
      host.removeEventListener('pointerleave', onLeave);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    }
  };
}
