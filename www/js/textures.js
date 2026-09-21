// Procedural texture library (canvas based) so the demo region needs no downloads.
import * as THREE from "../vendor/three.module.min.js";

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
function toTexture(c, repeat = 1) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.repeat.set(repeat, repeat);
  return t;
}
// periodic value noise — seamlessly tileable
function pnoise(x, y, px, py, seed) {
  const h = (a, b) => {
    let v = Math.sin(a * 127.1 + b * 311.7 + seed * 74.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const wrap = (a, n) => ((a % n) + n) % n;
  const a = h(wrap(xi, px), wrap(yi, py)), b = h(wrap(xi + 1, px), wrap(yi, py));
  const c = h(wrap(xi, px), wrap(yi + 1, py)), d = h(wrap(xi + 1, px), wrap(yi + 1, py));
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, px, py, oct, seed) {
  let s = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < oct; o++) { s += pnoise(x * f, y * f, px * f, py * f, seed + o) * amp; norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}

export function noiseTexture(size, colors, opts = {}) {
  const { px = 4, py = 4, oct = 5, seed = 1, grain = 0.06 } = opts;
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const stops = colors;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / size, y / size, px, py, oct, seed);
      const idx = n * (stops.length - 1);
      const i0 = Math.min(stops.length - 1, Math.floor(idx));
      const i1 = Math.min(stops.length - 1, i0 + 1);
      const t = idx - i0;
      const g = (Math.random() - 0.5) * grain * 255;
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = stops[i0][k] * (1 - t) + stops[i1][k] * t + g;
        img.data[o + k] = Math.max(0, Math.min(255, v));
      }
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

let terrainTex = null;
export function terrainTextures() {
  if (terrainTex) return terrainTex;
  terrainTex = {
    sand: toTexture(noiseTexture(256, [[196, 178, 138], [214, 198, 158], [176, 158, 118]], { px: 3, py: 3, seed: 11 })),
    grass: toTexture(noiseTexture(256, [[78, 116, 52], [96, 138, 62], [64, 98, 44], [110, 148, 70]], { px: 5, py: 5, seed: 23 })),
    rock: toTexture(noiseTexture(256, [[116, 112, 104], [136, 132, 124], [96, 92, 86], [150, 146, 138]], { px: 4, py: 4, seed: 37 })),
    snow: toTexture(noiseTexture(256, [[232, 236, 242], [244, 246, 250], [216, 222, 232]], { px: 3, py: 3, seed: 53 })),
  };
  return terrainTex;
}

export function checkerTexture(size, a, b, cells, seed = 0) {
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  const s = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const n = fbm(x / cells, y / cells, cells, cells, 3, seed);
      ctx.fillStyle = ((x + y) & 1) ? a : b;
      ctx.globalAlpha = 0.75 + n * 0.25;
      ctx.fillRect(x * s, y * s, s + 1, s + 1);
    }
  }
  ctx.globalAlpha = 1;
  return toTexture(c);
}

// SL-ish default "plywood"/concrete prim texture with a faint grid
export function primDefaultTexture() {
  const size = 256;
  const c = noiseTexture(size, [[186, 186, 182], [200, 200, 196], [172, 172, 168]], { px: 4, py: 4, seed: 5, grain: 0.03 });
  const ctx = c.getContext("2d");
  ctx.strokeStyle = "rgba(120,120,120,0.35)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const p = i * size / 8;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  return toTexture(c);
}

export function woodTexture() {
  const size = 256;
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const g = (Math.sin((x * 0.09) + Math.sin(x * 0.021 + y * 0.004) * 6) * 0.5 + 0.5);
      const n = fbm(x / size, y / size, 6, 6, 4, 9);
      const r = 120 + g * 60 + n * 24, gg = 78 + g * 40 + n * 18, b = 44 + g * 24 + n * 10;
      const o = (y * size + x) * 4;
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

export function brickTexture() {
  const size = 256;
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#b9b2a6"; ctx.fillRect(0, 0, size, size);
  const rows = 8, cols = 4;
  const bh = size / rows, bw = size / cols;
  for (let r = 0; r < rows; r++) {
    for (let i = -1; i < cols + 1; i++) {
      const x = i * bw + (r % 2 ? bw / 2 : 0);
      const v = fbm((i + 10) / cols, r / rows, 3, 3, 3, r * 13 + i);
      const col = `rgb(${150 + v * 45},${70 + v * 30},${58 + v * 24})`;
      ctx.fillStyle = col;
      ctx.fillRect(x + 2, r * bh + 2, bw - 4, bh - 4);
    }
  }
  return toTexture(c);
}

export function metalTexture() {
  const size = 256;
  const c = noiseTexture(size, [[150, 155, 165], [178, 184, 196], [130, 136, 148]], { px: 2, py: 8, seed: 17, grain: 0.02 });
  const ctx = c.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, "rgba(255,255,255,0.18)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.0)");
  grad.addColorStop(1, "rgba(0,0,0,0.12)");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);
  return toTexture(c);
}

export function signTexture(text, opts = {}) {
  const { w = 512, h = 128, bg = "#20242c", fg = "#ffffff", font = "bold 64px system-ui, sans-serif" } = opts;
  const c = canvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 4; ctx.strokeRect(2, 2, w - 4, h - 4);
  ctx.fillStyle = fg;
  ctx.font = font;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function faceTexture(seed = 1) {
  const size = 128;
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  const skin = ["#e8c39e", "#c68642", "#8d5524", "#ffdbb4", "#5a3825"][seed % 5];
  ctx.fillStyle = skin; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#3b2a20";
  ctx.beginPath(); ctx.ellipse(size / 2, size * 0.32, size * 0.36, size * 0.26, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#2b2b2b";
  for (const dx of [-22, 22]) { ctx.beginPath(); ctx.ellipse(size / 2 + dx, size * 0.52, 7, 9, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = "#8a5a4a"; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(size / 2, size * 0.66, 18, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  return new THREE.CanvasTexture(c);
}

export function makeSculptTorusKnot(size = 64, opts = {}) {
  // RGB encodes (x,y,z) in 0..1, exactly like SL sculpt maps (lossy 8-bit)
  const { p = 2, q = 3, tube = 0.28 } = opts;
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1) * Math.PI * 2;
      const v = y / (size - 1) * Math.PI * 2;
      const r = 1 + tube * Math.cos(q * u);
      const px = r * Math.cos(p * u), py = r * Math.sin(p * u), pz = tube * Math.sin(q * u);
      const rr = Math.sqrt(px * px + py * py);
      const nx = px / (rr + 1e-6), ny = py / (rr + 1e-6);
      const tx = Math.cos(v) * nx, ty = Math.sin(v) * nx, tz = Math.sin(v);
      const sx = px + tx * tube * Math.cos(v) * 0;
      const X = px + tx * (tube * 0.5), Y = py + ty * (tube * 0.5), Z = pz + tz * (tube * 0.5);
      const o = (y * size + x) * 4;
      img.data[o] = Math.max(0, Math.min(255, (X / 3 + 0.5) * 255));
      img.data[o + 1] = Math.max(0, Math.min(255, (Y / 3 + 0.5) * 255));
      img.data[o + 2] = Math.max(0, Math.min(255, (Z / 2 + 0.5) * 255));
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export function stoneTexture() {
  const size = 256;
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / size, y / size, 6, 6, 5, 61);
      const tile = Math.max(
        Math.abs(((x / 32) % 1) - 0.5), Math.abs(((y / 32) % 1) - 0.5));
      const g = 150 + n * 42 - Math.max(0, 0.5 - tile) * 26;
      const o = (y * size + x) * 4;
      img.data[o] = g; img.data[o + 1] = g * 0.99; img.data[o + 2] = g * 0.95; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = "rgba(90,88,84,0.55)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    const p = i * size / 8;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }
  return toTexture(c);
}

export function roofTexture() {
  const size = 256;
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#4a3b34"; ctx.fillRect(0, 0, size, size);
  const rows = 10;
  const rh = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let i = -1; i < 6; i++) {
      const v = fbm((i + 8) / 6, r / rows, 3, 3, 3, r * 7 + i);
      ctx.fillStyle = `rgb(${64 + v * 40},${50 + v * 32},${44 + v * 28})`;
      ctx.fillRect(i * (size / 5) + (r % 2 ? size / 10 : 0) + 1, r * rh + 1, size / 5 - 2, rh - 2);
    }
  }
  return toTexture(c);
}

export function leafTexture() {
  const size = 256;
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / size, y / size, 7, 7, 5, 41);
      const leaves = Math.abs(Math.sin(x * 0.22) * Math.cos(y * 0.19) * Math.sin((x + y) * 0.07));
      const v = n * 0.6 + leaves * 0.55;
      const o = (y * size + x) * 4;
      img.data[o] = 44 + v * 62;
      img.data[o + 1] = 82 + v * 92;
      img.data[o + 2] = 34 + v * 44;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(c);
}

// Maps a prim texture name (or SL texture UUID) to a three.Texture
const UUID_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function missingTexture(uuid) {
  const size = 64;
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  const h = parseInt((uuid || "0").replace(/-/g, "").slice(0, 6), 16) || 0;
  const hue = h % 360;
  ctx.fillStyle = `hsl(${hue}, 18%, 46%)`;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, size); ctx.lineTo(size, 0); ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, size - 12, size, 12);
  return toTexture(c);
}

export class TextureLibrary {
  constructor() {
    this.cache = new Map();
    // UUIDs whose *real* pixels came from the grid. `cache` also holds the
    // placeholders the renderer shows while a texture is on its way, and the
    // avatar code must never mistake one of those for the real thing.
    this.installed = new Set();
    this.default = primDefaultTexture();
    this.wood = woodTexture();
    this.brick = brickTexture();
    this.metal = metalTexture();
    this.grid = checkerTexture(256, "#3a6ea5", "#e6ecf2", 8, 3);
    this.leaf = leafTexture();
    this.stone = stoneTexture();
    this.roof = roofTexture();
    this.uuidLoader = null;
  }
  /**
   * Stores a texture downloaded from the grid. The bytes arrive as an
   * ImageBitmap, and a plain `new THREE.Texture(bitmap)` has version 0, so the
   * renderer never uploads it and every textured face rendered **black**. It
   * needs `needsUpdate` (and sRGB, since these are colour textures).
   */
  install(uuid, source) {
    const tex = source && source.isTexture ? source : new THREE.Texture(source);
    if (tex.version === 0) tex.needsUpdate = true;
    if (tex.colorSpace === undefined || tex.colorSpace === "") tex.colorSpace = THREE.SRGBColorSpace;
    // Grid textures are sampled with explicit UV transforms (repeatU/repeatV) and
    // the terrain tiles them across the whole region, so they must wrap and
    // mip-map; the default clamp showed a stretched edge pixel instead.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    this.cache.set(uuid, tex);
    this.installed.add(uuid);
    return tex;
  }
  get(key) {
    if (!key) return this.default;
    if (this.cache.has(key)) return this.cache.get(key);
    if (UUID_KEY_RE.test(key)) {
      const ph = key.startsWith("0") ? this.default : missingTexture(key);
      this.cache.set(key, ph);
      if (this.uuidLoader) this.uuidLoader(key);
      return ph;
    }
    if (key.startsWith("gen:")) {
      const name = key.slice(4);
      if (name.startsWith("sign:")) {
        const t = signTexture(name.slice(5));
        this.cache.set(key, t);
        return t;
      }
      if (name.startsWith("face")) {
        const n = parseInt(name.slice(4) || "1", 10) || 1;
        const t = faceTexture(n);
        this.cache.set(key, t);
        return t;
      }
      if (this[name] && this[name].isTexture) return this[name];
    }
    return this.default;
  }
}
