// textures.js -- biblioteca de texturas procedurales para las caras de los prims.
//
// Todo se dibuja en un canvas 2D con funciones puras escritas en espacio
// normalizado (u, v), asi que la misma receta sirve para la miniatura (64 px) y
// para la textura final (256 px). El ruido es el mismo `fbmP` periodico del
// terreno (`region.js`), de modo que todas las texturas son **repetibles**: al
// baldosarlas (repeats per meter > 1) no aparecen costuras.
//
// Cada textura se genera a peticion y se cachea; el mapa de normales se deriva
// de la luminancia del albedo (gradiente central), como en `region.js`.

import * as THREE from "./three.js";
import { hash2, fbmP } from "./region.js";

const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
const lerp = (a, b, t) => a + (b - a) * t;

// --- utilidades de dibujo ---------------------------------------------------

function makeCanvas(size, fn) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const px = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      fn(x, y, x / size, y / size, px);
      const o = (y * size + x) * 4;
      d[o] = px[0]; d[o + 1] = px[1]; d[o + 2] = px[2]; d[o + 3] = px[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Mapa de normales tangente desde la luminancia del albedo.
function normalFromCanvas(canvas, strength) {
  const size = canvas.width;
  const ctx = canvas.getContext("2d");
  const src = ctx.getImageData(0, 0, size, size).data;
  const H = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    H[i] = (0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2]) / 255;
  }
  const out = makeCanvas(size, (x, y, u, v, px) => {
    const at = (i, j) => H[(((j % size) + size) % size) * size + (((i % size) + size) % size)];
    let nx = -(at(x + 1, y) - at(x - 1, y)) * strength;
    let ny = -(at(x, y + 1) - at(x, y - 1)) * strength;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
    nx *= inv; ny *= inv;
    px[0] = (nx * 0.5 + 0.5) * 255;
    px[1] = (ny * 0.5 + 0.5) * 255;
    px[2] = (inv * 0.5 + 0.5) * 255;
    px[3] = 255;
  });
  return out;
}

function rgb(px, r, g, b, a) { px[0] = r * 255; px[1] = g * 255; px[2] = b * 255; px[3] = a === undefined ? 255 : a * 255; }

// --- recetas ---------------------------------------------------------------
// Cada receta: { key, label, relief, alpha, draw(x, y, u, v, px) }

const RECIPES = [
  {
    key: "ladrillo", label: "Ladrillo", relief: 14,
    draw(x, y, u, v, px) {
      const rows = 8, cols = 4;
      const ri = Math.floor(v * rows);
      const off = (ri % 2) ? 0.5 : 0;
      const cu = ((u + off / cols) % 1) * cols;      // 0..cols dentro de la fila
      const ci = Math.floor(cu);
      const fx = cu - ci, fy = v * rows - ri;
      const mortar = Math.min(fx, 1 - fx) * (1 / cols) < 0.0055 || Math.min(fy, 1 - fy) * (1 / rows) < 0.007;
      const j = hash2(ci, ri, 11);
      const grain = fbmP(u, v, 5, 3, 16) - 0.5;
      if (mortar) {
        const g = 0.68 + grain * 0.35;
        rgb(px, g, g * 0.985, g * 0.94);
      } else {
        const t = 0.55 + j * 0.5 + grain * 0.5;
        rgb(px, 0.42 + t * 0.32, 0.19 + t * 0.17, 0.13 + t * 0.11);
      }
    },
  },
  {
    key: "piedra", label: "Piedra", relief: 12,
    draw(x, y, u, v, px) {
      const rows = 4;
      const ri = Math.floor(v * rows), fy = v * rows - ri;
      // Juntas verticales irregulares pero fijas por fila (incluyen 0 y 1, asi
      // que la textura sigue siendo repetible).
      const cuts = [0, 0.30 + hash2(ri, 1, 3) * 0.06, 0.57 + hash2(ri, 2, 3) * 0.08, 1];
      let ci = 0;
      while (ci < cuts.length - 2 && u >= cuts[ci + 1]) ci++;
      const w = cuts[ci + 1] - cuts[ci];
      const fx = (u - cuts[ci]) / w;
      const seam = Math.min(fx, 1 - fx) * w < 0.006 || Math.min(fy, 1 - fy) * (1 / rows) < 0.008;
      const grain = fbmP(u * 1.0, v * 1.0, 9, 4, 8) - 0.5;
      const speck = hash2(x, y, 21);
      if (seam) {
        const g = 0.44 + grain * 0.3;
        rgb(px, g, g * 0.97, g * 0.92);
      } else {
        const j = hash2(ci, ri, 17);
        const t = 0.62 + j * 0.22 + grain * 0.75 + (speck > 0.985 ? -0.25 : 0);
        rgb(px, t * 0.99, t * 0.97, t * 0.93);
      }
    },
  },
  {
    key: "adoquin", label: "Adoquín", relief: 16,
    draw(x, y, u, v, px) {
      const n = 8;
      const cu = u * n, cv = v * n;
      const ci = Math.floor(cu), cj = Math.floor(cv);
      let best = 9;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const gi = ci + di, gj = cj + dj;
          const h1 = hash2(gi, gj, 31), h2 = hash2(gi, gj, 47);
          const cxp = gi + 0.2 + h1 * 0.6, cyp = gj + 0.2 + h2 * 0.6;
          const dx = cu - cxp, dy = cv - cyp;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < best) best = d;
        }
      }
      const grain = fbmP(u, v, 3, 3, 16) - 0.5;
      const h = hash2(Math.floor(cu), Math.floor(cv), 53);
      const t = clamp(0.55 + h * 0.3 + grain * 0.5 + (0.62 - best) * 0.45, 0, 1);
      rgb(px, t * 0.86, t * 0.85, t * 0.83);
    },
  },
  {
    key: "hormigon", label: "Hormigón", relief: 8,
    draw(x, y, u, v, px) {
      const m = fbmP(u, v, 61, 5, 4) - 0.5;
      const fine = fbmP(u, v, 67, 3, 32) - 0.5;
      const g = 0.66 + m * 0.16 + fine * 0.10;
      const speck = hash2(x, y, 71);
      const k = speck > 0.994 ? -0.16 : (speck > 0.975 ? -0.06 : 0);
      rgb(px, g + k, g + k * 0.97, g + k * 0.9);
    },
  },
  {
    key: "marmol", label: "Mármol", relief: 5,
    draw(x, y, u, v, px) {
      const t = fbmP(u, v, 73, 5, 4);
      const vein = Math.abs(Math.sin((u * 2.1 + v * 1.35 + t * 3.4) * Math.PI));
      const vv = Math.pow(vein, 5);
      const g = 0.93 - vv * 0.36;
      const warm = 0.02 * (t - 0.5);
      rgb(px, g + warm, g + warm * 0.5, g);
    },
  },
  {
    key: "azulejo", label: "Azulejo", relief: 10,
    draw(x, y, u, v, px) {
      const n = 4;
      const cu = u * n, cv = v * n;
      const ci = Math.floor(cu), cj = Math.floor(cv);
      const fx = cu - ci, fy = cv - cj;
      const grout = Math.min(fx, 1 - fx) < 0.035 || Math.min(fy, 1 - fy) < 0.035;
      if (grout) {
        const g = 0.60 + (hash2(x, y, 81) - 0.5) * 0.12;
        rgb(px, g, g, g * 0.97);
      } else {
        const h = hash2(ci, cj, 83);
        const base = 0.88 - h * 0.10;
        const gloss = clamp(1 - Math.abs((fx + fy) * 0.5 - 0.55) * 2.2, 0, 1) * 0.10;
        const t = clamp(base + gloss, 0, 1);
        rgb(px, t, t * 0.995, t * 0.97);
      }
    },
  },
  {
    key: "tejado", label: "Tejado", relief: 14,
    draw(x, y, u, v, px) {
      const rows = 8, cols = 8;
      const ri = Math.floor(v * rows), rj = v * rows - ri;
      const cu = ((u + (ri % 2 ? 0.5 : 0) / cols) % 1) * cols;
      const ci = Math.floor(cu), fx = cu - ci;
      const arc = Math.sin(fx * Math.PI);
      const h = hash2(ci, ri, 91);
      const rowShade = rj < 0.10 ? 0.45 : 1.0 - rj * 0.16;
      const t = clamp((0.42 + arc * 0.5 + (h - 0.5) * 0.16) * rowShade, 0, 1);
      rgb(px, t * 1.0, t * 0.55, t * 0.44);
    },
  },
  {
    key: "madera", label: "Madera", relief: 9,
    draw(x, y, u, v, px) {
      const planks = 4;
      const ri = Math.floor(v * planks), fy = v * planks - ri;
      const h = hash2(0, ri, 101);
      const warp = (fbmP(u, v, 103, 3, 8) - 0.5) * 0.9;
      const grain = Math.sin((v * 26 + warp * 6 + h * 5) * Math.PI) * 0.5 + 0.5;
      const t = clamp(0.55 + h * 0.18 + grain * 0.14 - (fy > 0.965 ? 0.4 : 0), 0, 1);
      rgb(px, t * 0.72, t * 0.48, t * 0.28);
    },
  },
  {
    key: "tablones", label: "Tablones", relief: 10,
    draw(x, y, u, v, px) {
      const planks = 8;
      const ci = Math.floor(u * planks), fx = u * planks - ci;
      const h = hash2(ci, 0, 107);
      const warp = (fbmP(u, v, 109, 3, 8) - 0.5) * 0.9;
      const grain = Math.sin((u * 34 + warp * 7 + h * 5) * Math.PI) * 0.5 + 0.5;
      const t = clamp(0.52 + h * 0.2 + grain * 0.16 - (fx > 0.96 ? 0.42 : 0), 0, 1);
      rgb(px, t * 0.80, t * 0.63, t * 0.42);
    },
  },
  {
    key: "corteza", label: "Corteza", relief: 18,
    draw(x, y, u, v, px) {
      const warp = fbmP(u, v, 113, 4, 4);
      const ridge = Math.abs(Math.sin((u * 7 + warp * 3.2) * Math.PI));
      const t = clamp(0.22 + ridge * 0.55 + (fbmP(u, v, 127, 3, 16) - 0.5) * 0.25, 0, 1);
      rgb(px, t * 0.55, t * 0.38, t * 0.24);
    },
  },
  {
    key: "hierba", label: "Hierba", relief: 11,
    draw(x, y, u, v, px) {
      const m = fbmP(u, v, 131, 4, 6);
      const blades = fbmP(u, v, 137, 2, 48);
      const s = hash2(x, y, 139);
      let t = 0.34 + m * 0.34 + (blades - 0.5) * 0.3;
      if (s > 0.975) t += 0.14; else if (s < 0.02) t -= 0.12;
      t = clamp(t, 0, 1);
      rgb(px, t * 0.55, t * 0.92, t * 0.30);
    },
  },
  {
    key: "arena", label: "Arena", relief: 6,
    draw(x, y, u, v, px) {
      const ripple = Math.sin((u * 13 + v * 21 + fbmP(u, v, 149, 3, 6) * 4) * Math.PI) * 0.03;
      const g = (hash2(x, y, 151) - 0.5) * 0.10 + fbmP(u, v, 157, 2, 24) * 0.06;
      const t = 0.80 + ripple + g;
      rgb(px, t * 0.96, t * 0.88, t * 0.66);
    },
  },
  {
    key: "tierra", label: "Tierra", relief: 10,
    draw(x, y, u, v, px) {
      const m = fbmP(u, v, 163, 4, 6) - 0.5;
      const s = hash2(x, y, 167);
      let t = 0.36 + m * 0.5;
      if (s > 0.988) t += 0.22; else if (s > 0.97) t -= 0.14;
      t = clamp(t, 0, 1);
      rgb(px, t * 0.78, t * 0.62, t * 0.44);
    },
  },
  {
    key: "grava", label: "Grava", relief: 20,
    draw(x, y, u, v, px) {
      const n = 20;
      const cu = u * n, cv = v * n;
      const ci = Math.floor(cu), cj = Math.floor(cv);
      let best = 9, bh = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const gi = ci + di, gj = cj + dj;
          const h1 = hash2(gi, gj, 173), h2 = hash2(gi, gj, 179);
          const dx = cu - (gi + 0.15 + h1 * 0.7), dy = cv - (gj + 0.15 + h2 * 0.7);
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < best) { best = d; bh = hash2(gi, gj, 181); }
        }
      }
      const grain = hash2(x, y, 191) - 0.5;
      const t = clamp(0.34 + bh * 0.5 + (0.5 - best) * 0.55 + grain * 0.1, 0, 1);
      rgb(px, t * 0.86, t * 0.83, t * 0.78);
    },
  },
  {
    key: "metal", label: "Metal", relief: 6,
    draw(x, y, u, v, px) {
      const brush = fbmP(u * 4, v * 0.35, 193, 3, 8) - 0.5;
      const scratch = hash2(x, Math.floor(v * 256 * 0.25), 197) > 0.985 ? -0.06 : 0;
      // El color de un metal ES su reflectancia: si el mapa es gris medio, el
      // metal solo puede devolver la mitad de la luz del cielo y se ve negro.
      // Por eso la base es clara (acero pulido) y el cepillado solo la modula.
      const t = clamp(0.88 + brush * 0.10 + scratch, 0, 1);
      rgb(px, t, t * 1.0, t * 1.02);
    },
  },
  {
    key: "oxido", label: "Óxido", relief: 16,
    draw(x, y, u, v, px) {
      const m = fbmP(u, v, 199, 4, 5);
      const rust = clamp((m - 0.42) * 2.4, 0, 1);
      const speck = hash2(x, y, 211);
      const s = speck > 0.97 ? -0.18 : 0;
      const r = lerp(0.55, 0.52, rust) + s;
      const g = lerp(0.58, 0.26, rust) + s;
      const b = lerp(0.60, 0.14, rust) + s;
      rgb(px, clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1));
    },
  },
  {
    key: "oro", label: "Oro", relief: 5,
    draw(x, y, u, v, px) {
      const m = fbmP(u, v, 223, 3, 6) - 0.5;
      const band = Math.sin((v * 3 + m * 2) * Math.PI) * 0.06;
      // Igual que el metal: el oro es reflectante, asi que su valor base es alto.
      const t = clamp(0.88 + m * 0.10 + band, 0, 1);
      rgb(px, t, t * 0.80, t * 0.32);
    },
  },
  {
    key: "tela", label: "Tela", relief: 9,
    draw(x, y, u, v, px) {
      const n = 32;
      const wx = (u * n) % 1, wy = (v * n) % 1;
      const warp = wx < 0.5 ? 1 : 0.74;
      const weft = wy < 0.5 ? 1 : 0.86;
      const fuzz = (hash2(x, y, 227) - 0.5) * 0.10;
      const t = clamp(0.62 * warp * weft + fuzz, 0, 1);
      rgb(px, t * 0.86, t * 0.82, t * 0.76);
    },
  },
  {
    key: "rejilla", label: "Rejilla", relief: 12, alpha: true,
    draw(x, y, u, v, px) {
      const n = 8;
      const bx = Math.abs(((u * n) % 1) - 0.5) * 2;   // 0 centro, 1 borde
      const by = Math.abs(((v * n) % 1) - 0.5) * 2;
      const bar = bx > 0.62 || by > 0.62;
      if (!bar) { px[0] = 0; px[1] = 0; px[2] = 0; px[3] = 0; return; }
      const hl = clamp((Math.max(bx, by) - 0.62) / 0.38, 0, 1);
      const t = 0.30 + hl * 0.26 + (hash2(x, y, 229) - 0.5) * 0.08;
      rgb(px, t, t * 1.0, t * 1.04);
    },
  },
  {
    key: "cristal", label: "Cristal", relief: 3, alpha: true,
    draw(x, y, u, v, px) {
      const m = fbmP(u, v, 233, 3, 6) - 0.5;
      const t = clamp(0.80 + m * 0.12, 0, 1);
      rgb(px, t * 0.86, t * 0.95, t * 1.0, 0.34);
    },
  },
];

// --- cache -----------------------------------------------------------------

const cache = new Map();
let anisotropy = 4;

export function configureTextures(opts = {}) {
  if (opts.anisotropy !== undefined) anisotropy = opts.anisotropy;
}

export function patternKeys() { return RECIPES.map((r) => r.key); }
export function patternInfo(key) { return RECIPES.find((r) => r.key === key) || null; }
export function allPatterns() { return RECIPES; }

function toTexture(canvas, srgb, relief) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Devuelve { key, label, alpha, map, normalMap } de una receta procedural.
export function patternTexture(key, size = 256) {
  const rec = patternInfo(key);
  if (!rec) return null;
  let entry = cache.get(key);
  if (!entry) {
    const canvas = makeCanvas(size, (x, y, u, v, px) => rec.draw(x, y, u, v, px));
    const ncanvas = normalFromCanvas(canvas, rec.relief);
    entry = {
      key, label: rec.label, alpha: !!rec.alpha, canvas, normalCanvas: ncanvas,
      map: toTexture(canvas, true),
      normalMap: toTexture(ncanvas, false),
    };
    cache.set(key, entry);
  }
  return entry;
}

// Miniatura (data URL) para el selector. Se dibuja a tamano pequeno porque solo
// se usa como boton, y asi el panel abre al instante.
const thumbs = new Map();
export function patternThumb(key, size = 56) {
  if (thumbs.has(key)) return thumbs.get(key);
  const rec = patternInfo(key);
  if (!rec) return null;
  const canvas = makeCanvas(size, (x, y, u, v, px) => rec.draw(x, y, u, v, px));
  // Las recetas con agujeros se ven mejor sobre un fondo a cuadros.
  const out = document.createElement("canvas");
  out.width = out.height = size;
  const ctx = out.getContext("2d");
  if (rec.alpha) {
    for (let j = 0; j < size; j += 8) for (let i = 0; i < size; i += 8) {
      ctx.fillStyle = ((i / 8 + j / 8) % 2) ? "#3a4250" : "#232a35";
      ctx.fillRect(i, j, 8, 8);
    }
  }
  ctx.drawImage(canvas, 0, 0);
  const url = out.toDataURL("image/png");
  thumbs.set(key, url);
  return url;
}

// Textura desde una URL (o un data URL). El loader de three no lanza en errores
// de red: hay que escuchar `onError` para avisar al usuario.
export function textureFromUrl(url, onLoad, onError) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin("anonymous");
  const t = loader.load(url, (tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = anisotropy;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    if (onLoad) onLoad(tex);
  }, undefined, () => { if (onError) onError(); });
  return t;
}

export { makeCanvas, normalFromCanvas };
