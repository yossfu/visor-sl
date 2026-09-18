// region.js -- la region de SL: terreno, agua y cielo.
//
// Coordenadas: la region de SL es de 256 x 256 m. Aqui se trabaja en metros con
// la convencion de three.js (X este, Y arriba, Z sur), asi que la coordenada
// global de SL se recupera con slX = x + 128, slY = 128 - z. La altura (Z de SL)
// es la Y de three.js.
//
//   - `Terrain`: campo de altura de 256 x 256 celdas (1 m por celda por
//     defecto) generado con ruido de valor+fbm sembrado, con una meseta plana
//     en el centro (donde se construye) y una playa alrededor del agua.
//     Guarda la altura como Float32Array para poder editarla (esculpir) mas
//     adelante, y expone `heightAt()` para la fisica del avatar.
//   - `createWater`: plano con olas (dos trenes de senos cruzados), fresnel,
//     transparencia y espuma cerca de la orilla.
//   - `createSky`: cupula con degradado, disco solar/lunar y estrellas; el
//     ciclo dia/noche mueve el sol, el color del cielo y la niebla.
//
// Todo procedural: no se descarga ninguna textura.

import * as THREE from "./three.js";

export const REGION_SIZE = 256;
export const DEFAULT_WATER_LEVEL = 20;
// Cuanto pesa la luz reflejada del cielo (scene.environment, horneada como PMREM)
// en los materiales estandar. Se usa en todo el proyecto para que los metales,
// el terreno, el avatar y los prims respondan con la misma intensidad.
export const ENV_INTENSITY = 0.62;

// --- ruido de valor sembrado -------------------------------------------------
export function makeRng(seed = 1) {
  let s = (seed | 0) || 1;
  return function rng() {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export function hash2(ix, iy, seed) {
  let h = ix * 374761393 + iy * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 1000000) / 1000000;
}

const smooth = (t) => t * t * (3 - 2 * t);

// Ruido de valor bilineal con suavizado.
function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

// fbm de `octaves` octavas: cada una con la mitad de amplitud y el doble de
// frecuencia. Devuelve un valor en [0,1].
function fbm(x, y, seed, octaves = 5) {
  let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(fx, fy, seed + o * 101);
    norm += amp;
    amp *= 0.5; fx *= 2; fy *= 2;
  }
  return sum / norm;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// --- texturas de superficie (albedo + relieve) ------------------------------
// Ruido periodico: la rejilla de hash se envuelve con modulo `period`, que es
// exactamente la frecuencia del octava, asi que la textura es 100% repetible y
// al baldosarla no se ven costuras. (`textures.js` reutiliza este ruido.)
export function valueNoiseP(x, y, seed, period) {
  const mod = (i) => ((i % period) + period) % period;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const x0 = mod(ix), x1 = mod(ix + 1), y0 = mod(iy), y1 = mod(iy + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

// fbm periodico. `base` es la frecuencia del primer octava (potencia de dos,
// para que todos los octavas caigan en la misma rejilla periodica).
export function fbmP(u, v, seed, octaves = 4, base = 4) {
  let sum = 0, amp = 1, norm = 0, f = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoiseP(u * f, v * f, seed + o * 101, f);
    norm += amp;
    amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

// Campo de altura del material: tres escalas de ruido. Se usa tanto para el
// color como (por su gradiente) para el mapa de normales. Todas las frecuencias
// se quedan bastante por debajo de la de Nyquist de la textura: el objetivo es
// relieve y manchas suaves, no grano de un texel (eso se ve como "grava").
function reliefHeight(u, v, seed) {
  return 0.55 * fbmP(u, v, seed, 4, 4) + 0.30 * fbmP(u, v, seed + 7, 3, 8) + 0.15 * fbmP(u, v, seed + 13, 2, 16);
}

// Genera el par de texturas procedurales de una superficie: color (R = manchas,
// G = detalle medio, B = grano fino) y normal (relieve del campo de altura).
// `relief` es la fuerza del relieve; 0 desactiva el mapa de normales.
export function makeSurfaceTextures(size = 256, seed = 99, relief = 10) {
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) H[y * size + x] = reliefHeight(x / size, y / size, seed);
  }
  const cCanvas = document.createElement("canvas");
  const nCanvas = document.createElement("canvas");
  cCanvas.width = cCanvas.height = nCanvas.width = nCanvas.height = size;
  const cctx = cCanvas.getContext("2d"), nctx = nCanvas.getContext("2d");
  const cimg = cctx.createImageData(size, size), nimg = nctx.createImageData(size, size);
  const cd = cimg.data, nd = nimg.data;
  const at = (x, y) => H[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const u = x / size, v = y / size;
      // Campos de ruido de contraste medio y suave: el albedo debe modular, no
      // salpicar. R = manchas grandes, G = detalle medio, B = grano micro.
      cd[o] = Math.round(clamp(0.5 + (fbmP(u, v, seed + 3, 4, 4) - 0.5) * 1.2, 0, 1) * 255);
      cd[o + 1] = Math.round(clamp(0.5 + (fbmP(u, v, seed + 11, 3, 8) - 0.5) * 1.5, 0, 1) * 255);
      cd[o + 2] = Math.round(clamp(0.5 + (fbmP(u, v, seed + 23, 2, 16) - 0.5) * 1.6, 0, 1) * 255);
      cd[o + 3] = 255;
      // Normal en espacio tangente a partir del gradiente central del campo.
      // `relief` es el multiplicador de pendiente: la diferencia entre texels
      // vecinos es pequeña, asi que se escala para obtener inclinaciones de unos
      // 10-25 grados (mas que eso se ve como "grava"/sombra sucia).
      let nx = -(at(x + 1, y) - at(x - 1, y)) * relief;
      let ny = -(at(x, y + 1) - at(x, y - 1)) * relief;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv;
      nd[o] = Math.round((nx * 0.5 + 0.5) * 255);
      nd[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      nd[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      nd[o + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);
  const T = THREE;
  const mk = (canvas) => {
    const t = new T.CanvasTexture(canvas);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  const color = mk(cCanvas), normal = mk(nCanvas);
  color.name = "surface-color"; normal.name = "surface-normal";
  return { color, normal, size, seed };
}

// El detalle de superficie se guarda fuera de `material.userData` a proposito:
// `Material.clone()` serializa `userData` a JSON, y meter ahi texturas (que
// arrastran canvas y datos de imagen) hace que clonar un material tarde ~130 ms
// y genere basura enorme. Con este WeakMap el userData solo tiene numeros.
const surfaceInfo = new WeakMap();
export function materialSurfaceInfo(mat) { return mat === null || mat === undefined ? null : (surfaceInfo.get(mat) || null); }

// Inyecta el detalle de superficie en un MeshStandardMaterial: modula el color y
// la rugosidad con el ruido, y le pone el mapa de normales (solo cuando las UV
// de la malla permiten baldosarlo; ver `applyPrimDetail`).
//   opts.scale    repeticiones por unidad de `coord` (por cara en prims, por
//                 metro en el terreno).
//   opts.useUV    true = muestrear en las UV de la malla (prims), false =
//                 coordenadas de mundo en XZ (terreno).
//   opts.relief   fuerza del relieve; 0 = sin mapa de normales.
export function addSurfaceDetail(mat, surf, opts = {}) {
  const scale = opts.scale || 0.34;
  const useUV = !!opts.useUV;
  const relief = opts.relief === undefined ? 1.0 : opts.relief;
  surfaceInfo.set(mat, { surf, scale, useUV, relief, normalRepeat: opts.normalRepeat });
  if (relief > 0) {
    const n = surf.normal;
    const rep = opts.normalRepeat !== undefined ? opts.normalRepeat : scale;
    n.repeat.set(rep, rep);
    n.needsUpdate = true;
    mat.normalMap = n;
    mat.normalScale.set(relief, relief);
  }
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: surf.color };
    shader.uniforms.uDetailScale = { value: scale };
    shader.vertexShader = "varying vec3 vWorldPosT;\nvarying vec2 vUvT;\n" + shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  vWorldPosT = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vUvT = uv;"
    );
    const coord = useUV ? "vUvT * uDetailScale" : "vWorldPosT.xz * uDetailScale";
    shader.fragmentShader = "uniform sampler2D uDetail;\nuniform float uDetailScale;\nvarying vec3 vWorldPosT;\nvarying vec2 vUvT;\n" + shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>
       vec2 duv = ${coord};
       float dFar = texture2D(uDetail, duv * 0.3).r;
       float dMid = texture2D(uDetail, duv).r;
       float dFine = texture2D(uDetail, duv).g;
       float grain = texture2D(uDetail, duv).b;
       float amp = 0.90 + 0.20 * dFar;
       amp *= 0.95 + 0.12 * dMid;
       diffuseColor.rgb *= amp;
       diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.04, 1.01, 0.95), dFine * 0.3);
       diffuseColor.rgb *= 0.98 + 0.04 * grain;`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <roughnessmap_fragment>",
      `#include <roughnessmap_fragment>
       roughnessFactor = clamp(roughnessFactor * (0.9 + 0.2 * texture2D(uDetail, ${useUV ? "vUvT" : "vWorldPosT.xz"} * uDetailScale).r), 0.55, 1.0);`
    );
  };
  mat.customProgramCacheKey = () => "surface-detail-" + scale + (useUV ? "-uv" : "-world") + "-r" + relief + "-n" + (opts.normalRepeat === undefined ? scale : opts.normalRepeat);
  return mat;
}

// Texturas de superficie compartidas por los prims sin textura (mismo `scale`,
// asi que comparten el mismo mapa de normales sin pelearse por el `repeat`).
let sharedSurface = null;
export function primSurface(seed = 99) {
  if (!sharedSurface) sharedSurface = makeSurfaceTextures(256, seed, 10);
  return sharedSurface;
}
export function detailTexture(seed = 99) { return primSurface(seed).color; }

// Aspecto por defecto de un prim sin textura: superficie con grano y relieve
// sutil, como el "blank texture" del visor de SL pero con algo de materia.
export function applyPrimDetail(mat, opts = {}) {
  return addSurfaceDetail(mat, primSurface(), Object.assign({ scale: 3.2, useUV: true, relief: 0.5 }, opts));
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
export class Terrain {
  constructor(opts = {}) {
    this.size = opts.size || REGION_SIZE;          // metros
    this.cells = opts.cells || this.size;          // 1 m por celda
    this.step = this.size / this.cells;
    this.seed = opts.seed === undefined ? 1337 : opts.seed;
    this.waterLevel = opts.waterLevel === undefined ? DEFAULT_WATER_LEVEL : opts.waterLevel;
    this.n = this.cells + 1;                       // vertices por lado
    this.heights = new Float32Array(this.n * this.n);
    this.pads = [];                                // solares aplanados
    this.generate();
  }

  // Posicion en metros del vertice (i,j) relativa al centro de la region.
  vertexX(i) { return -this.size / 2 + i * this.step; }
  vertexZ(j) { return -this.size / 2 + j * this.step; }

  generate() {
    const { n, step, size, seed } = this;
    const half = size / 2;
    const base = this.baseHeights || (this.baseHeights = new Float32Array(n * n));
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = this.vertexX(i), z = this.vertexZ(j);
        // Ruido de gran escala: colinas y valles.
        const big = fbm((x + 512) / 170, (z + 512) / 170, seed, 4);
        // Detalle medio: ondulaciones de decenas de metros.
        const mid = fbm((x + 512) / 42, (z + 512) / 42, seed + 7, 4);
        // Detalle fino: rugosidad de metros.
        const fine = fbm((x + 512) / 9, (z + 512) / 9, seed + 13, 3);
        let h = this.waterLevel + 1.5 + (big - 0.5) * 26 + (mid - 0.5) * 7 + (fine - 0.5) * 1.6;
        // Meseta de construccion: se aplana suavemente hacia el centro.
        const r = Math.hypot(x, z);
        const plateau = 1 - smoothstep(26, 62, r);
        h = h * (1 - plateau) + (this.waterLevel + 4.6) * plateau;
        // Orilla: se hunde hacia el borde para que el agua rodee la region.
        const edge = smoothstep(half - 8, half, Math.max(Math.abs(x), Math.abs(z)));
        h = h * (1 - edge) + (this.waterLevel - 3) * edge;
        base[j * n + i] = h;
      }
    }
    this.applyPads();
  }

  // Aplana el terreno dentro de un rectangulo redondeado. `falloff` es el ancho
  // de la transicion hacia el terreno natural (0 = borde duro). Los pads se
  // aplican siempre sobre el campo base, no sobre el resultado anterior, asi que
  // se puede anadir o quitar terreno aplanado sin acumular error: es la misma
  // operacion que hara la herramienta de terreno del editor.
  addPad(opts = {}) {
    const pad = {
      x: opts.x || 0, z: opts.z || 0,
      halfW: opts.halfW || 8, halfD: opts.halfD || 8,
      height: opts.height === undefined ? this.waterLevel + 6 : opts.height,
      falloff: opts.falloff === undefined ? 10 : opts.falloff,
      // `wobble` deforma el borde con ruido (metros) y `bowl` ahueca el centro
      // (metros). Sin ellos un lago es un rectangulo redondeado perfecto, que es
      // justo lo que delata que el terreno es artificial.
      wobble: opts.wobble || 0,
      bowl: opts.bowl || 0,
    };
    this.pads.push(pad);
    this.applyPads();
    return pad;
  }

  clearPads() { this.pads.length = 0; this.applyPads(); }

  // --- capa de esculpido -----------------------------------------------------
  // El pincel del editor no toca `heights` directamente: escribe un DELTA por
  // vertice en `sculpt`, que se suma DESPUES de los pads. Asi el terreno de
  // ejemplo (y sus solares) queda intacto y se puede "revertir" a cero, el
  // deshacer guarda solo el trozo tocado, y el guardado de la region es un array
  // de deltas (casi todo ceros) en vez de una copia entera de las alturas.
  ensureSculpt() {
    if (!this.sculpt) this.sculpt = new Float32Array(this.n * this.n);
    return this.sculpt;
  }

  // Altura sin la capa de esculpido (lo que seria el terreno "de fabrica").
  nativeHeightAt(x, z) {
    const fx = (x + this.size / 2) / this.step;
    const fz = (z + this.size / 2) / this.step;
    const i = clamp(Math.floor(fx), 0, this.n - 2);
    const j = clamp(Math.floor(fz), 0, this.n - 2);
    const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
    const h = this.heights, sc = this.sculpt;
    const at = (k) => h[k] - (sc ? sc[k] : 0);
    const h00 = at(j * this.n + i), h10 = at(j * this.n + i + 1);
    const h01 = at((j + 1) * this.n + i), h11 = at((j + 1) * this.n + i + 1);
    return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
  }

  applyPads() {
    const n = this.n, h = this.heights;
    h.set(this.baseHeights);
    for (const pad of this.pads) {
      const f = Math.max(0.001, pad.falloff);
      for (let j = 0; j < n; j++) {
        const wz = this.vertexZ(j);
        const dz = Math.abs(wz - pad.z) - pad.halfD;
        const dzc = dz > 0 ? dz : 0;
        for (let i = 0; i < n; i++) {
          const wx = this.vertexX(i);
          const dx = Math.abs(wx - pad.x) - pad.halfW;
          const dxc = dx > 0 ? dx : 0;
          const edge = pad.wobble
            ? Math.hypot(dxc, dzc) + pad.wobble * (Math.sin(wx * 0.13 + 1.7) * Math.cos(wz * 0.11 - 0.4) * 0.62
              + Math.sin(wx * 0.31 - 0.8) * Math.cos(wz * 0.27 + 1.1) * 0.38)
            : Math.hypot(dxc, dzc);
          const k = 1 - smoothstep(0, f, edge);
          if (k <= 0) continue;
          const idx = j * n + i;
          h[idx] = h[idx] * (1 - k) + (pad.height - pad.bowl * k) * k;
        }
      }
    }
    this.applySculpt();
  }

  // Suma la capa de esculpido (si la hay) a las alturas ya generadas. Se llama
  // al final de `applyPads` y despues de cada trazo del pincel.
  applySculpt() {
    const sc = this.sculpt;
    const h = this.heights;
    if (sc) for (let i = 0; i < h.length; i++) h[i] += sc[i];
    this.refreshPeak();
  }

  refreshPeak() {
    let p = -Infinity;
    const h = this.heights;
    for (let i = 0; i < h.length; i++) if (h[i] > p) p = h[i];
    this.peak = p;
    return p;
  }

  // Altura interpolada bilinealmente en coordenadas de mundo (metros).
  heightAt(x, z) {
    const fx = (x + this.size / 2) / this.step;
    const fz = (z + this.size / 2) / this.step;
    const i = clamp(Math.floor(fx), 0, this.n - 2);
    const j = clamp(Math.floor(fz), 0, this.n - 2);
    const tx = clamp(fx - i, 0, 1), tz = clamp(fz - j, 0, 1);
    const h = this.heights;
    const h00 = h[j * this.n + i], h10 = h[j * this.n + i + 1];
    const h01 = h[(j + 1) * this.n + i], h11 = h[(j + 1) * this.n + i + 1];
    return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
  }

  // Pendiente (0 = llano, 1 = 45 grados o mas) en un punto, por diferencias.
  slopeAt(x, z) {
    const d = this.step;
    const dx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const dz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    return clamp(Math.hypot(dx, dz) / (2 * d), 0, 1);
  }

  // Color del terreno segun altura y pendiente: arena junto al agua, hierba en
  // las zonas llanas, roca en las pendientes y tierra en las cumbres.
  // Escribe en `out` (sin reservar memoria: se llama una vez por vertice).
  colorAt(h, slope, out) {
    const c = out || new THREE.Color();
    const pal = this._pal || (this._pal = {
      sand: new THREE.Color(0xc8b98a),
      grassLow: new THREE.Color(0x8fa15e),
      grass: new THREE.Color(0x5f7a45),
      dry: new THREE.Color(0x6b7360),
      rock: new THREE.Color(0x6d6a63),
    });
    const w = this.waterLevel;
    if (h < w + 1.2) c.copy(pal.sand);
    else if (h < w + 3.5) c.copy(pal.grassLow);
    else if (h < w + 12) c.copy(pal.grass);
    else c.copy(pal.dry);
    const rock = smoothstep(0.45, 0.75, slope);
    if (rock > 0) c.lerp(pal.rock, rock);
    return c;
  }

  build() {
    const { n, cells } = this;
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const h = this.heights;
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i, o = k * 3;
        const x = this.vertexX(i), z = this.vertexZ(j), y = h[k];
        pos[o] = x; pos[o + 1] = y; pos[o + 2] = z;
        this.colorAt(y, this.slopeAt(x, z), c);
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
        uv[k * 2] = i / cells; uv[k * 2 + 1] = j / cells;
      }
    }
    const idx = new Uint32Array(cells * cells * 6);
    let p = 0;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const a = j * n + i, b = a + 1, d = a + n, e = d + 1;
        idx[p++] = a; idx[p++] = d; idx[p++] = b;
        idx[p++] = b; idx[p++] = d; idx[p++] = e;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: ENV_INTENSITY,
    });
    const surf = this.surface || (this.surface = makeSurfaceTextures(256, this.seed + 5, 10));
    // Detalle en coordenadas de mundo (0.34 repeticiones/m = baldosas de ~3 m);
    // el mapa de normales si va en UV, asi que se le pasa su propia repeticion.
    addSurfaceDetail(mat, surf, { scale: 0.34, useUV: false, relief: 1.0, normalRepeat: Math.round(this.size * 0.34) });
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = "terrain";
    mesh.userData.terrain = this;
    this.mesh = mesh;
    return mesh;
  }

  // Reescribe la malla a partir de `heights` (tras editar el terreno o mover un
  // pad). No reserva memoria: reutiliza los atributos que ya existen.
  refreshMesh() {
    const mesh = this.mesh;
    if (!mesh) return null;
    const n = this.n, h = this.heights;
    const geometry = mesh.geometry;
    const pos = geometry.attributes.position.array;
    const col = geometry.attributes.color.array;
    const c = this._refreshColor || (this._refreshColor = new THREE.Color());
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i, o = k * 3;
        const x = this.vertexX(i), z = this.vertexZ(j), y = h[k];
        pos[o + 1] = y;
        this.colorAt(y, this.slopeAt(x, z), c);
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return mesh;
  }

  // Rehace SOLO el trozo de malla que ha tocado el pincel (`i0..i1`, `j0..j1` en
  // indices de vertice, ambos inclusive). Un trazo de 8 m toca ~10x10 vertices,
  // no los 16.000 (o 66.000) de la region: es lo que hace que el pincel vaya a
  // 60 fps en un movil. Las normales se recalculan analiticamente desde el campo
  // de alturas (diferencias centrales) en vez de `computeVertexNormals`, que es
  // O(toda la malla).
  refreshRegion(i0, i1, j0, j1) {
    const mesh = this.mesh;
    if (!mesh) return null;
    const n = this.n, h = this.heights, step = this.step;
    const geometry = mesh.geometry;
    const pos = geometry.attributes.position.array;
    const nrm = geometry.attributes.normal.array;
    const col = geometry.attributes.color.array;
    const c = this._refreshColor || (this._refreshColor = new THREE.Color());
    const a = clamp(Math.floor(i0), 0, n - 1), b = clamp(Math.ceil(i1), 0, n - 1);
    const d = clamp(Math.floor(j0), 0, n - 1), e = clamp(Math.ceil(j1), 0, n - 1);
    // El borde se amplia un vertice para que las normales de la frontera usen
    // diferencias centrales completas y no se vea la costura del parche.
    const a2 = Math.max(0, a - 1), b2 = Math.min(n - 1, b + 1);
    const d2 = Math.max(0, d - 1), e2 = Math.min(n - 1, e + 1);
    for (let j = d2; j <= e2; j++) {
      for (let i = a2; i <= b2; i++) {
        const k = j * n + i, o = k * 3;
        const x = this.vertexX(i), z = this.vertexZ(j), y = h[k];
        pos[o + 1] = y;
        const xm = h[j * n + Math.max(0, i - 1)], xp = h[j * n + Math.min(n - 1, i + 1)];
        const zm = h[Math.max(0, j - 1) * n + i], zp = h[Math.min(n - 1, j + 1) * n + i];
        const nx = -(xp - xm), nz = -(zp - zm);
        const inv = 1 / Math.hypot(nx, 2 * step, nz);
        nrm[o] = nx * inv; nrm[o + 1] = 2 * step * inv; nrm[o + 2] = nz * inv;
        this.colorAt(y, this.slopeAt(x, z), c);
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.computeBoundingSphere();
    return mesh;
  }

  // Rectangulo de vertices que cubre un circulo de mundo (para el pincel).
  vertexRange(x0, x1, z0, z1) {
    const n = this.n;
    return {
      i0: clamp(Math.floor((x0 + this.size / 2) / this.step) - 1, 0, n - 1),
      i1: clamp(Math.ceil((x1 + this.size / 2) / this.step) + 1, 0, n - 1),
      j0: clamp(Math.floor((z0 + this.size / 2) / this.step) - 1, 0, n - 1),
      j1: clamp(Math.ceil((z1 + this.size / 2) / this.step) + 1, 0, n - 1),
    };
  }

  // --- guardado de la capa de esculpido --------------------------------------
  // Deltas en centimetros (Int16) en base64: 2 bytes por vertice y, sobre todo,
  // una representacion que el navegador comprime muy bien. Devuelve `null` si no
  // hay nada esculpido, para no ensuciar el guardado de la region.
  encodeSculpt() {
    if (!this.sculpt) return null;
    const sc = this.sculpt;
    const i16 = new Int16Array(sc.length);
    let any = false;
    for (let i = 0; i < sc.length; i++) {
      const q = Math.round(sc[i] * 100);
      i16[i] = q;
      if (q !== 0) any = true;
    }
    if (!any) return null;
    return { res: this.n, cm: b64FromBytes(new Uint8Array(i16.buffer)) };
  }

  // Aplica una capa guardada. Si la resolucion no coincide con la de esta
  // region, se muestrea (asi un guardado viejo sigue cargando).
  decodeSculpt(rec) {
    if (!rec || !rec.cm) { this.sculpt = null; this.applyPads(); if (this.mesh) this.refreshMesh(); return false; }
    const src = new Int16Array(bytesFromB64(rec.cm).buffer);
    const res = rec.res || Math.round(Math.sqrt(src.length));
    const n = this.n;
    const sc = this.ensureSculpt();
    if (res === n) {
      for (let i = 0; i < sc.length; i++) sc[i] = src[i] / 100;
    } else {
      for (let j = 0; j < n; j++) {
        const sj = Math.min(res - 1, Math.round((j / (n - 1)) * (res - 1)));
        for (let i = 0; i < n; i++) {
          const si = Math.min(res - 1, Math.round((i / (n - 1)) * (res - 1)));
          sc[j * n + i] = src[sj * res + si] / 100;
        }
      }
    }
    this.applyPads();
    if (this.mesh) this.refreshMesh();
    return true;
  }

  clearSculpt() {
    if (this.sculpt) this.sculpt.fill(0);
    this.applyPads();
    if (this.mesh) this.refreshMesh();
  }

  // --- terreno de un mundo de verdad ------------------------------------------
  //
  // En modo exterior el terreno no se genera: llega de fuera, en parches de
  // 16x16 m con 16x16 alturas, que es exactamente el LayerData que manda un
  // simulador de Second Life. `applyPads` deja de usarse (no hay pads que
  // aplicar) y el esculpido queda como capa encima, por si se quiere retocar el
  // terreno recibido.
  //
  // La rejilla de esta clase es de 1 m por vertice (257x257), asi que el vertice
  // 16 de un parche ES el vertice 0 del parche vecino: no hay costura que coser,
  // que es justo el motivo por el que el visor comparte una sola rejilla en vez
  // de mallar parche a parche.
  useExternalTerrain(opts = {}) {
    this.external = true;
    if (opts.waterLevel !== undefined) this.waterLevel = opts.waterLevel;
    if (opts.base === undefined || opts.base === null) this.baseHeights.fill(this.waterLevel);
    else this.baseHeights.fill(opts.base);
    this.pads.length = 0;
    this.heights.set(this.baseHeights);
    this.refreshPeak();
    if (this.mesh) this.refreshMesh();
    return this;
  }

  // Alturas de un parche. `heights` trae 16x16 muestras (una por metro) o 17x17
  // (la 17 es la del parche vecino, que en esta rejilla ya es el mismo vertice).
  // `px`, `py` van de 0 al numero de parches por lado menos 1.
  //
  // Ojo con la rejilla de destino: NO siempre hay un vertice por metro (en el
  // movil `cells` es 128, o sea 2 m por vertice). Por eso el parche se recorre
  // en METROS y se muestrea la altura que toca en cada vertice que cae dentro,
  // de modo que el mismo parche sirve para cualquier resolucion de terreno.
  applyPatch(px, py, heights) {
    if (!this.external) this.useExternalTerrain();
    const PATCH_M = 16;
    const per = PATCH_M + 1;
    const hasSeam = heights.length >= per * per;
    const step = this.step, n = this.n, h = this.heights;
    const kmax = hasSeam ? PATCH_M : PATCH_M - 1;
    const x0 = px * PATCH_M, y0 = py * PATCH_M;
    const i0 = Math.max(0, Math.ceil(x0 / step));
    const i1 = Math.min(n - 1, Math.floor((x0 + PATCH_M) / step));
    const j0 = Math.max(0, Math.ceil(y0 / step));
    const j1 = Math.min(n - 1, Math.floor((y0 + PATCH_M) / step));
    for (let j = j0; j <= j1; j++) {
      const ky = Math.max(0, Math.min(kmax, Math.round(j * step - y0)));
      for (let i = i0; i <= i1; i++) {
        const kx = Math.max(0, Math.min(kmax, Math.round(i * step - x0)));
        const k = hasSeam ? ky * per + kx : ky * PATCH_M + kx;
        if (k < heights.length) h[j * n + i] = heights[k];
      }
    }
    this.patchMask = this.patchMask || new Uint8Array(16 * 16);
    const slot = py * 16 + px;
    if (slot >= 0 && slot < this.patchMask.length) this.patchMask[slot] = 1;
    return this;
  }

  patchesReceived() {
    if (!this.patchMask) return 0;
    let n = 0;
    for (let i = 0; i < this.patchMask.length; i++) n += this.patchMask[i];
    return n;
  }

  // Los parches llegan en desorden y a decenas por segundo: rehacer la malla
  // entera por cada uno seria tirar el frame. Se acumula el rectangulo tocado y
  // se rehace una sola vez (lo mismo que hace el pincel con `refreshRegion`).
  applyPatches(list) {
    let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
    const step = this.step, PATCH_M = 16;
    for (const p of list) {
      this.applyPatch(p.px, p.py, p.heights);
      const x0 = p.px * PATCH_M, y0 = p.py * PATCH_M;
      i0 = Math.min(i0, Math.ceil(x0 / step));
      j0 = Math.min(j0, Math.ceil(y0 / step));
      i1 = Math.max(i1, Math.floor((x0 + PATCH_M) / step));
      j1 = Math.max(j1, Math.floor((y0 + PATCH_M) / step));
    }
    if (i0 === Infinity) return this;
    this.applySculpt();
    if (this.mesh) this.refreshRegion(i0, i1, j0, j1);
    else this.refreshPeak();
    return this;
  }
}

// base64 sin `apply` sobre arrays gigantes (se desborda la pila con 66.000
// elementos): se trocea.
function b64FromBytes(bytes) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function bytesFromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Agua
// ---------------------------------------------------------------------------
export function createWater(opts = {}) {
  const size = opts.size || REGION_SIZE * 2;
  const level = opts.level === undefined ? DEFAULT_WATER_LEVEL : opts.level;
  const terrain = opts.terrain || null;
  const geo = new THREE.PlaneGeometry(size, size, Math.min(160, size / 2), Math.min(160, size / 2));
  geo.rotateX(-Math.PI / 2);
  // El terreno se empaqueta en una textura (2 bytes por vertice = 1/64 m de
  // precision) para que el shader del agua sepa a que profundidad esta el fondo
  // y pueda quedarse transparente en la orilla. `syncTerrain()` se llama despues
  // del sandbox porque los solares esculpidos cambian las alturas.
  const fieldN = terrain ? terrain.n : 2;
  const fieldData = new Uint8Array(fieldN * fieldN * 2);
  const fieldTex = new THREE.DataTexture(fieldData, fieldN, fieldN, THREE.RGFormat, THREE.UnsignedByteType);
  fieldTex.magFilter = fieldTex.minFilter = THREE.LinearFilter;
  fieldTex.wrapS = fieldTex.wrapT = THREE.ClampToEdgeWrapping;
  fieldTex.needsUpdate = true;
  const uniforms = {
    uTime: { value: 0 },
    uShallow: { value: new THREE.Color(0x3f8fa8) },
    uShore: { value: new THREE.Color(0x83c6bd) },
    uDeep: { value: new THREE.Color(0x0d2b45) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.2) },
    uSunColor: { value: new THREE.Color(0xfff2d8) },
    uSkyColor: { value: new THREE.Color(0x8fb7e8) },
    uFogColor: { value: new THREE.Color(0xbcd2ef) },
    uFogNear: { value: 60 },
    uFogFar: { value: 340 },
    uHeights: { value: fieldTex },
    uFieldSize: { value: terrain ? terrain.size : REGION_SIZE },
    uHasField: { value: terrain ? 1 : 0 },
    uLevel: { value: level },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */`
      uniform float uTime;
      varying vec3 vWorld;
      void main() {
        vec3 p = position;
        float w = sin(p.x * 0.35 + uTime * 1.1) * 0.07
                + sin(p.z * 0.28 - uTime * 0.9) * 0.06
                + sin((p.x + p.z) * 0.11 + uTime * 0.5) * 0.05;
        p.y += w;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uFogNear, uFogFar, uLevel, uFieldSize, uHasField;
      uniform vec3 uShallow, uShore, uDeep, uSunDir, uSunColor, uSkyColor, uFogColor;
      uniform sampler2D uHeights;
      varying vec3 vWorld;
      // Normal del agua por derivadas analiticas de las olas (dos escalas: la
      // larga da el oleaje y la fina los destellos que hacen que se lea como
      // agua y no como una lamina de plastico).
      vec3 waterNormal(vec2 p) {
        float dx = cos(p.x * 0.35 + uTime * 1.1) * 0.35 * 0.07
                 + cos((p.x + p.y) * 0.11 + uTime * 0.5) * 0.11 * 0.05
                 + cos(p.x * 1.7 + uTime * 1.9) * 1.7 * 0.012
                 + cos(p.y * 1.3 - uTime * 1.6) * 1.3 * 0.010;
        float dz = cos(p.y * 0.28 - uTime * 0.9) * 0.28 * 0.06
                 + cos((p.x + p.y) * 0.11 + uTime * 0.5) * 0.11 * 0.05
                 + cos(p.y * 1.5 + uTime * 1.7) * 1.5 * 0.011;
        return normalize(vec3(-dx, 1.0, -dz));
      }
      void main() {
        vec3 n = waterNormal(vWorld.xz);
        vec3 view = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(dot(n, view), 0.0), 3.0);
        // Profundidad real leida del campo de alturas del terreno: sin esto la
        // orilla es el corte duro de dos planos y no se lee como agua.
        float wd = 40.0;
        if (uHasField > 0.5) {
          vec2 huv = vWorld.xz / uFieldSize + 0.5;
          float q = texture2D(uHeights, huv).r * 255.0 + texture2D(uHeights, huv).g * 65280.0;
          wd = uLevel - q / 64.0;
        }
        float shallow = 1.0 - smoothstep(0.0, 3.0, max(wd, 0.0));
        vec3 col = mix(uDeep, uShallow, clamp(0.35 + 0.3 * n.y, 0.0, 1.0));
        col = mix(col, uShore, shallow * 0.9);
        col = mix(col, uSkyColor, clamp(fres * (1.0 - 0.45 * shallow), 0.0, 0.85));
        vec3 h = normalize(uSunDir + view);
        float d = max(dot(n, h), 0.0);
        col += uSunColor * (pow(d, 220.0) * 1.4 + pow(d, 26.0) * 0.10);
        float fogF = clamp((distance(cameraPosition, vWorld) - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
        col = mix(col, uFogColor, fogF * 0.85);
        float alpha = mix(0.10, 0.88, smoothstep(0.0, 3.0, max(wd, 0.0)));
        gl_FragColor = vec4(col, mix(alpha, 1.0, fogF * 0.85));
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = level;
  mesh.name = "water";
  mesh.renderOrder = 1;
  function syncTerrain(rect) {
    if (!terrain) return;
    const n = terrain.n, h = terrain.heights;
    const i0 = rect ? clamp(rect.i0, 0, n - 1) : 0, i1 = rect ? clamp(rect.i1, 0, n - 1) : n - 1;
    const j0 = rect ? clamp(rect.j0, 0, n - 1) : 0, j1 = rect ? clamp(rect.j1, 0, n - 1) : n - 1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * n + i;
        const q = Math.max(0, Math.min(65535, Math.round(h[k] * 64)));
        fieldData[k * 2] = q & 255;
        fieldData[k * 2 + 1] = (q >> 8) & 255;
      }
    }
    fieldTex.needsUpdate = true;
  }
  syncTerrain();
  return { mesh, uniforms, level, syncTerrain, update: (t) => { uniforms.uTime.value = t; } };
}

// ---------------------------------------------------------------------------
// Cielo + ciclo dia/noche
// ---------------------------------------------------------------------------
const SKY_VS = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const SKY_FS = /* glsl */`
  uniform vec3 uZenith, uHorizon, uGround, uSunColor;
  uniform vec3 uSunDir, uMoonDir;
  uniform float uStars, uTime, uClouds;
  varying vec3 vDir;
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  // Ruido de valor 2D para las nubes.
  float chash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float cnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = chash(i), b = chash(i + vec2(1.0, 0.0));
    float c = chash(i + vec2(0.0, 1.0)), e = chash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, e, f.x), f.y);
  }
  float cfbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * cnoise(p); p *= 2.03; a *= 0.5; }
    return s / 0.9375;
  }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.65));
    col = mix(col, uGround, clamp(-h * 3.0, 0.0, 1.0));
    // Halo del sol y disco; lo mismo, mas tenue, para la luna.
    float sd = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * pow(sd, 900.0) * 2.0;
    col += uSunColor * pow(sd, 12.0) * 0.18;
    float md = max(dot(d, normalize(uMoonDir)), 0.0);
    col += vec3(0.55, 0.6, 0.7) * pow(md, 1600.0) * 0.9;
    col += vec3(0.25, 0.3, 0.42) * pow(md, 40.0) * 0.06;
    // Nubes: el plano se proyecta desde la direccion de vista (perspectiva).
    float day = clamp(uSunDir.y * 1.6 + 0.15, 0.0, 1.0);
    if (uClouds > 0.001 && h > 0.015) {
      vec2 cp = d.xz / max(h, 0.05) * 0.5 + vec2(uTime * 0.0035, uTime * 0.0018);
      float n = cfbm(cp * 1.35);
      float cov = smoothstep(0.56 - 0.22 * uClouds, 0.84 - 0.16 * uClouds, n);
      float fade = smoothstep(0.015, 0.20, h);
      vec3 lit = mix(vec3(0.55, 0.58, 0.66), uSunColor * 1.05, 0.55 + 0.35 * sd);
      lit = mix(vec3(0.14, 0.16, 0.24), lit, 0.25 + 0.75 * day);
      lit *= 0.75 + 0.5 * n;
      col = mix(col, lit, cov * fade * clamp(uClouds * 1.4, 0.0, 1.0));
    }
    // Estrellas: solo de noche y por encima del horizonte.
    if (uStars > 0.01 && h > -0.02) {
      vec3 q = floor(d * 260.0);
      float s = hash(q);
      float star = smoothstep(0.9975, 1.0, s);
      col += vec3(star) * uStars * smoothstep(-0.02, 0.25, h) * 1.4;
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

export function createSky(opts = {}) {
  const radius = opts.radius || 3000;
  const geo = new THREE.SphereGeometry(radius, 32, 20);
  const uniforms = {
    uZenith: { value: new THREE.Color(0x3f7fd4) },
    uHorizon: { value: new THREE.Color(0xbcd2ef) },
    uGround: { value: new THREE.Color(0x2b3440) },
    uSunColor: { value: new THREE.Color(0xfff0c9) },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5).normalize() },
    uMoonDir: { value: new THREE.Vector3(-0.3, -0.8, -0.5).normalize() },
    uStars: { value: 0 },
    uTime: { value: 0 },
    uClouds: { value: 0.55 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, side: THREE.BackSide, depthWrite: false, vertexShader: SKY_VS, fragmentShader: SKY_FS,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "sky";
  mesh.frustumCulled = false;
  // Se dibuja al final: como la cupula esta detras de todo y no escribe
  // profundidad, el test de profundidad descarta los pixeles ya cubiertos por el
  // terreno y los prims, y eso ahorra mucho relleno (el limitante real en movil).
  mesh.renderOrder = 1000;
  return { mesh, uniforms, radius };
}

// Paleta del cielo (estilo WindLight, simplificado) para una altura del sol
// dada (seno de la elevacion, -1 noche cerrada, 1 sol en el cenit).
export function skyPalette(sunElev) {
  // El tramo util esta comprimido cerca del horizonte: si el naranja del
  // crepusculo se estira hasta media tarde, el cielo se pasa la mayor parte del
  // dia rojizo y no queda luz de dia.
  const t = clamp((sunElev + 0.15) / 0.60, 0, 1);
  const night = { zen: 0x050a18, hor: 0x0b1424, gnd: 0x05070c, sun: 0x2a3a55 };
  const dusk = { zen: 0x2b3f74, hor: 0xd9773f, gnd: 0x241d24, sun: 0xff9a4a };
  const day = { zen: 0x3f7fd4, hor: 0xbcd2ef, gnd: 0x3a4450, sun: 0xfff0c9 };
  const mix2 = (a, b, u) => ({
    zen: new THREE.Color(a.zen).lerp(new THREE.Color(b.zen), u),
    hor: new THREE.Color(a.hor).lerp(new THREE.Color(b.hor), u),
    gnd: new THREE.Color(a.gnd).lerp(new THREE.Color(b.gnd), u),
    sun: new THREE.Color(a.sun).lerp(new THREE.Color(b.sun), u),
  });
  if (t < 0.30) return mix2(night, dusk, clamp(t / 0.30, 0, 1));
  return mix2(dusk, day, clamp((t - 0.30) / 0.70, 0, 1));
}

// Ciclo dia/noche: la hora 0..24 mapea el sol a una orbita inclinada (como la
// de SL, que no pasa por el cenit). `minutesPerDay` es la duracion real de un
// dia completo (0 = tiempo congelado).
export class DayCycle {
  constructor(opts = {}) {
    this.hour = opts.hour === undefined ? 10.5 : opts.hour;
    this.minutesPerDay = opts.minutesPerDay === undefined ? 20 : opts.minutesPerDay;
    this.sunDirection = new THREE.Vector3();
    this.moonDirection = new THREE.Vector3();
    this.sunElev = 0;
    this.update(0);
  }

  setHour(h) { this.hour = ((h % 24) + 24) % 24; this.update(0); return this.hour; }

  advance(dt) {
    if (this.minutesPerDay > 0) this.hour = (this.hour + (dt / 60) / this.minutesPerDay * 24) % 24;
    this.update(0);
    return this.hour;
  }

  update() {
    const a = (this.hour / 24) * Math.PI * 2 - Math.PI / 2;
    // Orbita inclinada 22 grados respecto al este-oeste.
    const dir = new THREE.Vector3(Math.cos(a) * 0.93, Math.sin(a), -Math.cos(a) * 0.36).normalize();
    this.sunDirection.copy(dir);
    this.moonDirection.copy(dir).multiplyScalar(-1);
    this.sunElev = dir.y;
  }
}

// Aplica el estado del ciclo a la cupula, la luz solar, la niebla y el agua.
export function applySky(sky, cycle, env) {
  const p = skyPalette(cycle.sunElev);
  const u = sky.uniforms;
  u.uZenith.value.copy(p.zen);
  u.uHorizon.value.copy(p.hor);
  u.uGround.value.copy(p.gnd);
  u.uSunColor.value.copy(p.sun);
  u.uSunDir.value.copy(cycle.sunDirection);
  u.uMoonDir.value.copy(cycle.moonDirection);
  u.uStars.value = clamp(1 - (cycle.sunElev + 0.15) / 0.25, 0, 1);
  if (env && env.time !== undefined) u.uTime.value = env.time;
  if (!env) return p;
  const daylight = clamp(cycle.sunElev * 1.9 + 0.30, 0, 1);
  // De noche el sol esta bajo el horizonte: si se siguiera usando su direccion
  // la luz vendria desde abajo, el terreno quedaria negro y solo se veria el
  // cielo. Al caer el sol la luz direccional se entrega a la luna (que es la que
  // se ve en el cielo a esas horas) con un cruce suave para que no haya un
  // salto brusco de color e intensidad en el crepusculo.
  const moonW = clamp((0.02 - cycle.sunElev) / 0.16, 0, 1);
  const moonlit = moonW > 0.5;
  const dir = moonlit ? cycle.moonDirection : cycle.sunDirection;
  if (!cycle.lightDirection) cycle.lightDirection = new THREE.Vector3();
  cycle.lightDirection.copy(dir);
  if (env.sun) {
    env.sun.position.copy(dir).multiplyScalar(120);
    if (moonlit) {
      env.sun.color.setHex(0x9fb4d8);
      env.sun.intensity = 0.6 * moonW;
    } else {
      env.sun.color.copy(p.sun);
      // Un sol algo mas suave y mas luz de cielo: con el sol a 2.5 las caras en
      // sombra caian a negro y el bosquejo se veia duro y sucio.
      env.sun.intensity = 2.15 * daylight * (1 - moonW);
    }
  }
  if (env.hemi) {
    env.hemi.color.copy(p.hor);
    env.hemi.groundColor.setHex(0x4e565f).lerp(new THREE.Color(0x252d3a), moonW);
    // Cuando hay mapa de entorno horneado (env.ambientFactor < 1) el propio
    // cielo ya aporta la luz ambiente, asi que la hemisferica se rebaja: si no,
    // se sumarian las dos y el mediodia quedaria lavado.
    const ambF = env.ambientFactor === undefined ? 1 : env.ambientFactor;
    env.hemi.intensity = ((0.40 + 0.85 * daylight) * (1 - moonW) + 0.34 * moonW) * ambF;
  }
  if (env.scene && env.scene.fog) {
    env.scene.fog.color.copy(p.hor);
    env.scene.fog.near = 90 + 60 * daylight;
    env.scene.fog.far = 420 + 260 * daylight;
  }
  if (env.water) {
    env.water.uniforms.uSunDir.value.copy(dir);
    env.water.uniforms.uSunColor.value.copy(p.sun);
    env.water.uniforms.uSkyColor.value.copy(p.hor).lerp(p.zen, 0.4);
    env.water.uniforms.uFogColor.value.copy(p.hor);
  }
  return p;
}
