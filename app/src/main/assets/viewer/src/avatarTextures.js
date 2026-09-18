// avatarTextures.js -- texturas procedurales del avatar: piel, pelo y tejidos.
//
// POR QUE EXISTE ESTE MODULO
// --------------------------
// El aspecto de un avatar de Second Life no lo define solo la forma: la piel
// tiene poro y manchas, el pelo tiene hebras y la ropa tiene tejido. Sin eso,
// cualquier cuerpo parece plastico. Aqui se dibujan esas texturas en canvas 2D
// (nada de ficheros externos) para que el avatar se vea "de verdad" y siga
// siendo 100% reproducible: dos clientes con el mismo aspecto generan la misma
// textura, byte a byte, sin intercambiar imagenes.
//
// Se reutiliza la infraestructura de `src/textures.js` (`makeCanvas` y el mapa
// de normales derivado de la luminancia) y el ruido periodico de `region.js`,
// que es lo que hace que las texturas sean repetibles y no muestren costuras al
// baldosarlas.
//
// Las texturas de tela son CASI EN GRIS a proposito: el color de la prenda lo
// pone el material (`material.color`), y el mapa solo aporta tejido, sombra y
// relieve. Asi una misma receta sirve para todos los colores de la paleta.

import * as THREE from "./three.js";
import { makeCanvas, normalFromCanvas } from "./textures.js";
import { hash2, fbmP } from "./region.js";

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

function rgb(px, r, g, b, a) {
  px[0] = clamp01(r) * 255;
  px[1] = clamp01(g) * 255;
  px[2] = clamp01(b) * 255;
  px[3] = (a === undefined ? 1 : clamp01(a)) * 255;
}

// --- cache ------------------------------------------------------------------

const cache = new Map();
function cached(key, make) {
  const hit = cache.get(key);
  if (hit) return hit;
  const val = make();
  cache.set(key, val);
  return val;
}

let anisotropy = 4;
export function configureAvatarTextures(opts = {}) {
  if (opts.anisotropy !== undefined) anisotropy = opts.anisotropy;
}

function tex(canvas, { srgb = false, repeat = 1 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = anisotropy;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// --- piel -------------------------------------------------------------------
//
// La piel se construye con tres escalas: manchas grandes (la "vida" del tono),
// poro fino, y una rugosidad variable que simula la grasa natural (frente y
// nariz mas brillantes, mejillas mas mates). El albedo queda casi blanco para
// que el color de piel del material siga mandando, pero no plano.

function skinCanvases(seed) {
  const size = 256;
  const albedo = makeCanvas(size, (x, y, u, v, px) => {
    const mottle = fbmP(u, v, seed, 3, 3) - 0.5;          // manchas
    const mid = fbmP(u, v, seed + 31, 3, 12) - 0.5;       // grano medio
    const pore = hash2(x, y, seed + 71) - 0.5;            // poro
    const freck = hash2(x, y, seed + 113);
    let t = 0.95 + mottle * 0.10 + mid * 0.06 + pore * 0.05;
    if (freck > 0.9975) t -= 0.10;                        // pecas sueltas
    // Un pelin mas calido en los valles de las manchas, como la piel real.
    const warm = -mottle * 0.02;
    rgb(px, t + warm, t * 0.995, t * 0.975);
  });
  const rough = makeCanvas(size, (x, y, u, v, px) => {
    const mottle = fbmP(u, v, seed + 53, 3, 4) - 0.5;
    const pore = hash2(x, y, seed + 91);
    // 0 = muy brillante, 1 = mate. La piel ronda 0,45..0,75.
    const t = clamp01(0.58 + mottle * 0.18 + (pore - 0.5) * 0.12);
    rgb(px, t, t, t);
  });
  return { albedo, rough };
}

export function skinTexture(seed = 0) {
  return cached("skin:" + seed, () => {
    const { albedo, rough } = skinCanvases(seed);
    return {
      map: tex(albedo, { srgb: true, repeat: 3 }),
      normalMap: tex(normalFromCanvas(albedo, 5), { repeat: 3 }),
      roughnessMap: tex(rough, { repeat: 3 }),
    };
  });
}

// --- pelo -------------------------------------------------------------------
//
// Hebras dirigidas a lo largo de `v` (que en la cabeza va de la coronilla hacia
// abajo), con mechones irregulares. Casi en gris, teñido por el material.

function hairCanvases(seed) {
  const size = 256;
  const albedo = makeCanvas(size, (x, y, u, v, px) => {
    const strand = Math.sin((u * 46 + (fbmP(u, v, seed, 3, 6) - 0.5) * 9) * Math.PI);
    const strand2 = Math.sin((u * 118 + (fbmP(u, v, seed + 5, 2, 10) - 0.5) * 14) * Math.PI);
    const clump = fbmP(u, v, seed + 9, 3, 4) - 0.5;
    let t = 0.72 + strand * 0.16 + strand2 * 0.08 + clump * 0.22;
    if (hash2(x, y, seed + 17) > 0.99) t += 0.10;          // brillo de hebra
    rgb(px, t, t * 0.99, t * 0.97);
  });
  return { albedo };
}

export function hairTexture(seed = 0) {
  return cached("hair:" + seed, () => {
    const { albedo } = hairCanvases(seed);
    return {
      map: tex(albedo, { srgb: true, repeat: 2 }),
      normalMap: tex(normalFromCanvas(albedo, 10), { repeat: 2 }),
    };
  });
}

// --- tejidos ----------------------------------------------------------------
//
// Cada receta devuelve el dibujo (en gris), la fuerza del relieve, el tamaño con
// el que debe baldosarse y la rugosidad base. `alpha` marca los tejidos con
// agujeros (encaje), que necesitan transparencia.

const CLOTH = {
  tela: {
    label: "Tela", relief: 8, repeat: 6, rough: 0.86,
    draw(x, y, u, v, px) {
      const n = 24;
      const wx = (u * n) % 1, wy = (v * n) % 1;
      const warp = wx < 0.5 ? 1.0 : 0.80;
      const weft = wy < 0.5 ? 1.0 : 0.88;
      const fuzz = (hash2(x, y, 227) - 0.5) * 0.10;
      const t = clamp01(0.70 * warp * weft + fuzz + 0.16);
      rgb(px, t, t, t * 0.99);
    },
  },
  lino: {
    label: "Lino", relief: 12, repeat: 5, rough: 0.92,
    draw(x, y, u, v, px) {
      const n = 16;
      const warp = Math.abs(Math.sin(u * n * Math.PI));
      const weft = Math.abs(Math.sin(v * n * Math.PI));
      // Hilos irregulares: el lino tiene "slubs" (grumos) que rompen la trama.
      const slub = fbmP(u * 1.0, v * 1.0, 301, 2, 8);
      const both = clamp01(0.55 * warp + 0.55 * weft - 0.12);
      const t = clamp01(0.60 + both * 0.28 + (slub - 0.5) * 0.26 + (hash2(x, y, 303) - 0.5) * 0.08);
      rgb(px, t, t * 0.995, t * 0.98);
    },
  },
  denim: {
    label: "Mezclilla", relief: 10, repeat: 7, rough: 0.94,
    draw(x, y, u, v, px) {
      // Sarga: hilos diagonales. El indigo es mas oscuro en la urdimbre.
      const d = (u * 26 + v * 26);
      const twill = (Math.floor(d) % 2) ? 1.0 : 0.78;
      const fine = fbmP(u, v, 307, 2, 32) - 0.5;
      const fade = fbmP(u, v, 311, 3, 4) - 0.5;
      const t = clamp01(0.52 + twill * 0.24 + fine * 0.22 + fade * 0.10);
      rgb(px, t * 0.98, t, t * 1.02);
    },
  },
  cuadros: {
    label: "Cuadros", relief: 6, repeat: 4, rough: 0.88,
    draw(x, y, u, v, px) {
      const big = 4, thin = 12;
      const band = (p) => {
        const f = (p * thin) % 1;
        const thinLine = f < 0.10 ? 0.22 : 0;
        const g = (p * big) % 1;
        const wide = g < 0.34 ? 0.16 : 0;
        return thinLine + wide;
      };
      const dark = clamp01(band(u) + band(v));
      const t = clamp01(0.94 - dark * 0.9 + (hash2(x, y, 313) - 0.5) * 0.05);
      rgb(px, t, t * 0.98, t * 0.96);
    },
  },
  rayas: {
    label: "Rayas", relief: 3, repeat: 8, rough: 0.85,
    draw(x, y, u, v, px) {
      const f = (u * 4) % 1;
      const thin = ((u * 16) % 1) < 0.06 ? 0.12 : 0;
      const t = clamp01((f < 0.5 ? 0.34 : 0.96) - thin + (hash2(x, y, 317) - 0.5) * 0.05);
      rgb(px, t, t, t * 0.99);
    },
  },
  lunares: {
    label: "Lunares", relief: 3, repeat: 5, rough: 0.85,
    draw(x, y, u, v, px) {
      const n = 4;
      const cu = u * n, cv = v * n;
      const ci = Math.floor(cu), cj = Math.floor(cv);
      const ox = (cj % 2) ? 0.5 : 0;
      const dx = (cu - ci - 0.5 + 0.5 * ox) % 1;
      const dy = cv - cj - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const r = 0.24 * (0.85 + hash2(ci, cj, 331) * 0.3);
      const dot = d < r ? 0.20 : 0.98;
      const t = clamp01(dot + (hash2(x, y, 333) - 0.5) * 0.05);
      rgb(px, t, t * 0.99, t * 0.98);
    },
  },
  encaje: {
    label: "Encaje", relief: 14, repeat: 4, rough: 0.74, alpha: true,
    draw(x, y, u, v, px) {
      // Motivo floral enrejado sobre malla: rombos con un "corazon" central.
      const n = 4;
      const cu = u * n, cv = v * n;
      const ci = Math.floor(cu), cj = Math.floor(cv);
      const fx = cu - ci - 0.5, fy = cv - cj - 0.5;
      const r = Math.sqrt(fx * fx + fy * fy);
      const ang = Math.atan2(fy, fx);
      const petal = Math.abs(Math.cos(ang * 4)) * 0.16;
      const inFlower = r < 0.36 + petal && r > 0.06;
      const inRing = Math.abs(r - 0.42) < 0.045;
      const thread = inFlower || inRing ? 1 : 0;
      if (!thread) { px[0] = 0; px[1] = 0; px[2] = 0; px[3] = 0; return; }
      const t = clamp01(0.72 + (hash2(x, y, 337) - 0.5) * 0.22);
      rgb(px, t, t, t * 0.98);
    },
  },
  piel: {
    label: "Cuero", relief: 12, repeat: 4, rough: 0.52,
    draw(x, y, u, v, px) {
      // Grano de cuero: celulas poligonales suaves con pliegues finos.
      let best = 9;
      const n = 10;
      const cu = u * n, cv = v * n;
      const ci = Math.floor(cu), cj = Math.floor(cv);
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const gi = ci + di, gj = cj + dj;
        const h1 = hash2(gi, gj, 347), h2 = hash2(gi, gj, 349);
        const dx = cu - (gi + 0.2 + h1 * 0.6), dy = cv - (gj + 0.2 + h2 * 0.6);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) best = d;
      }
      const crease = fbmP(u, v, 353, 3, 16) - 0.5;
      const t = clamp01(0.62 + (0.55 - best) * 0.5 + crease * 0.18);
      rgb(px, t, t * 0.985, t * 0.965);
    },
  },
  seda: {
    label: "Seda", relief: 2, repeat: 3, rough: 0.30,
    draw(x, y, u, v, px) {
      // Satén: bandas suaves de brillo + grano muy fino.
      const sheen = Math.sin((u * 3 + (fbmP(u, v, 359, 2, 4) - 0.5)) * Math.PI) * 0.5 + 0.5;
      const t = clamp01(0.80 + sheen * 0.16 + (hash2(x, y, 361) - 0.5) * 0.05);
      rgb(px, t, t * 0.99, t);
    },
  },
  lana: {
    label: "Lana", relief: 18, repeat: 6, rough: 0.97,
    draw(x, y, u, v, px) {
      // Punto de lana: columnas de "puntos" en relieve.
      const n = 10;
      const cu = u * n, cv = v * n;
      const ci = Math.floor(cu), cj = Math.floor(cv);
      const fx = cu - ci, fy = cv - cj;
      const loopNub = Math.sin(fx * Math.PI) * Math.sin(fy * Math.PI);
      const fuzz = fbmP(u, v, 367, 3, 24) - 0.5;
      const t = clamp01(0.60 + loopNub * 0.30 + fuzz * 0.30);
      rgb(px, t, t * 0.995, t * 0.99);
    },
  },
};

export function clothKeys() { return Object.keys(CLOTH); }
export function clothInfo(name) { return CLOTH[name] || null; }

// Devuelve { map, normalMap, alpha, roughness, repeat } de un tejido. `null` (o
// un nombre desconocido) devuelve null: la prenda se pinta lisa.
export function clothTexture(name, size = 256) {
  const rec = CLOTH[name];
  if (!rec) return null;
  return cached("cloth:" + name + ":" + size, () => {
    const canvas = makeCanvas(size, (x, y, u, v, px) => rec.draw(x, y, u, v, px));
    return {
      key: name,
      label: rec.label,
      alpha: !!rec.alpha,
      repeat: rec.repeat,
      roughness: rec.rough,
      map: tex(canvas, { srgb: true, repeat: rec.repeat }),
      normalMap: tex(normalFromCanvas(canvas, rec.relief), { repeat: rec.repeat }),
    };
  });
}

// Miniatura (data URL) para el panel de aspecto.
const thumbs = new Map();
export function clothThumb(name, size = 56) {
  if (thumbs.has(name)) return thumbs.get(name);
  const rec = CLOTH[name];
  if (!rec) return null;
  const canvas = makeCanvas(size, (x, y, u, v, px) => rec.draw(x, y, u, v, px));
  let url;
  if (rec.alpha) {
    const out = document.createElement("canvas");
    out.width = out.height = size;
    const ctx = out.getContext("2d");
    for (let j = 0; j < size; j += 7) for (let i = 0; i < size; i += 7) {
      ctx.fillStyle = ((i / 7 + j / 7) % 2) ? "#4a5260" : "#2a313c";
      ctx.fillRect(i, j, 7, 7);
    }
    ctx.drawImage(canvas, 0, 0);
    url = out.toDataURL("image/png");
  } else {
    url = canvas.toDataURL("image/png");
  }
  thumbs.set(name, url);
  return url;
}
