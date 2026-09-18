// skinTexture.js -- las texturas REALES de la piel, los ojos y el pelo.
//
// Sin sesion de Second Life no se pueden pedir las texturas "cocidas"
// (`bake`) del residente, que es donde estan sus tatuajes, su ropa pintada y
// su cara tal cual. Pero la PIEL DE SISTEMA si se puede reconstruir: el visor
// oficial reparte en su codigo fuente cada una de las capas con las que compone
// la textura, y `avatar_lad.xml` dice exactamente en que orden y con que color
// se pintan. Eso es lo que hace este modulo:
//
//   1. parte de un tono de piel (`skin_color` del XML, o el que se pida);
//   2. lo multiplica por el grano (`head_skingrain.tga` / `body_skingrain.tga`);
//   3. superpone las capas de color (`head_color.tga`, `upperbody_color.tga`...),
//      que son las que traen nariz, labios, pezones, ombligo y demas;
//   4. aplica las mascaras de sombra y brillo;
//   5. y encima labios, cejas y (si se piden) maquillaje.
//
// Los ojos son un caso aparte: `eyewhite.tga` solo trae la esclerotica con sus
// venillas; el iris lo sirve el servidor de SL como activo suelto, asi que aqui
// se dibuja. Para colocarlo bien no basta con ponerlo en el centro de la
// textura: se lee la propia malla del ojo (`avatar_eye.llm`) y se ve a que
// direccion de la esfera corresponde cada texel. Asi el iris queda justo donde
// mira el ojo, sin depender de ninguna suposicion sobre el desplegado UV.
//
// Nada de esto se copia al repositorio: las capas se piden en tiempo de
// ejecucion a la fuente publica del visor (o al retransmisor, si hay sesion).

import { bodyBaseArrays } from "./bodyMesh.js";

// --- colores de los deslizadores del XML -------------------------------------

// `global_color name="skin_color"`: de claro a muy oscuro.
export const SKIN_COLOR_STOPS = [[252, 215, 200], [240, 177, 112], [90, 40, 16], [29, 9, 6]];
// `global_color name="hair_color"`: de negro a rubio.
export const HAIR_COLOR_STOPS = [
  [0, 0, 0], [22, 6, 6], [29, 9, 6], [45, 21, 11], [78, 39, 11], [90, 53, 16],
  [136, 92, 21], [150, 106, 33], [198, 156, 74], [233, 192, 103], [238, 205, 136],
];
// `global_color name="eye_color"`: marron, avellana, verde, azul, gris.
export const EYE_COLOR_STOPS = [
  [50, 25, 5], [109, 55, 15], [150, 93, 49], [152, 118, 25],
  [95, 179, 107], [87, 192, 191], [95, 172, 179], [128, 128, 128],
];

// Interpola en una lista de paradas. `t` va de 0 a 1.
export function colorAt(stops, t) {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export const skinColorAt = (t) => colorAt(SKIN_COLOR_STOPS, t);
export const hairColorAt = (t) => colorAt(HAIR_COLOR_STOPS, t);
export const eyeColorAt = (t) => colorAt(EYE_COLOR_STOPS, t);

// Valores de partida de un avatar recien creado: piel clara-media, pelo
// castano oscuro, ojos marrones. Todo esto es lo que luego mueve la sesion
// cuando llegan los parametros visuales de verdad.
export const DEFAULT_LOOK = {
  skinTone: 0.18,
  hairTone: 0.36,
  eyeTone: 0.06,
};

// Fuerza de cada capa. Los nombres son los del XML: asi se pueden mover desde
// fuera (los parametros visuales de SL son exactamente estos).
export const DEFAULT_AMOUNTS = {
  shading: 0.42, highlight: 0.15, lips: 0.45, eyebrows: 0.7, rosy: 0.16,
  lipstick: 0, eyeliner: 0, eyeshadow: 0,
};

// --- recetas de capas --------------------------------------------------------

// Cada paso se aplica sobre el resultado del anterior:
//   grain  multiplica el color de fondo por el gris de la textura;
//   over   pinta la textura tal cual, con su alfa;
//   mask   pinta `color` con alfa = gris de la textura * `amount`.
const LIP_COLOR = [214, 110, 110];
const ROSY_COLOR = [198, 71, 71];
const LIPSTICK_COLOR = [216, 37, 67];
const EYELINER_COLOR = [26, 18, 16];
const EYESHADOW_COLOR = [150, 110, 130];

export const REGION_RECIPES = {
  head: [
    { op: "grain", file: "head_skingrain.tga" },
    { op: "over", file: "head_color.tga" },
    { op: "mask", file: "head_shading_alpha.tga", color: [0, 0, 0], amount: "shading" },
    { op: "mask", file: "head_highlights_alpha.tga", color: [255, 255, 255], amount: "highlight" },
    { op: "mask", file: "rosyface_alpha.tga", color: ROSY_COLOR, amount: "rosy" },
    { op: "mask", file: "lips_mask.tga", color: LIP_COLOR, amount: "lips" },
    { op: "mask", file: "lipstick_alpha.tga", color: LIPSTICK_COLOR, amount: "lipstick" },
    { op: "mask", file: "eyeliner_alpha.tga", color: EYELINER_COLOR, amount: "eyeliner" },
    { op: "mask", file: "eyeshadow_outer_alpha.tga", color: EYESHADOW_COLOR, amount: "eyeshadow", amountScale: 0.6 },
    { op: "mask", file: "eyebrows_alpha.tga", color: "hair", amount: "eyebrows" },
  ],
  upperBody: [
    { op: "grain", file: "body_skingrain.tga" },
    { op: "over", file: "upperbody_color.tga" },
    { op: "mask", file: "upperbody_shading_alpha.tga", color: [0, 0, 0], amount: "shading" },
    { op: "mask", file: "upperbody_highlights_alpha.tga", color: [255, 255, 255], amount: "highlight" },
  ],
  lowerBody: [
    { op: "grain", file: "body_skingrain.tga" },
    { op: "over", file: "lowerbody_color.tga" },
    { op: "mask", file: "lowerbody_shading_alpha.tga", color: [0, 0, 0], amount: "shading" },
    { op: "mask", file: "lowerbody_highlights_alpha.tga", color: [255, 255, 255], amount: "highlight" },
  ],
};

export const SKIN_REGIONS = ["head", "upperBody", "lowerBody"];

// Grano del pelo de sistema (`head_hair.tga`, que es el `local_texture`
// "hair_grain" del XML): hecho a mano para los corpusculos de pelo.
export const HAIR_GRAIN_FILE = "head_hair.tga";

// Ficheros que hay que pedir para componer una lista de regiones.
export function textureFilesFor(regions = SKIN_REGIONS, opts = {}) {
  const files = new Set();
  for (const region of regions) {
    const recipe = REGION_RECIPES[region];
    if (!recipe) throw new Error("skinTexture: region desconocida «" + region + "»");
    for (const step of recipe) {
      // El maquillaje solo se pide si se va a usar: son 4 ficheros mas.
      if (step.amount === "lipstick" && !opts.lipstick) continue;
      if (step.amount === "eyeliner" && !opts.eyeliner) continue;
      if (step.amount === "eyeshadow" && !opts.eyeshadow) continue;
      files.add(step.file);
    }
  }
  return [...files];
}

// --- composicion -------------------------------------------------------------

function cloneImage(img) {
  return { width: img.width, height: img.height, data: new Uint8Array(img.data) };
}

// Multiplica el color de fondo por el gris de la textura (el "grano").
function applyGrain(dst, grain, strength) {
  const s = strength === undefined ? 1 : strength;
  for (let i = 0; i < dst.length; i += 4) {
    const g = grain[i] / 255;
    const k = 1 - s + s * g;
    dst[i] *= k; dst[i + 1] *= k; dst[i + 2] *= k;
  }
}

// Pinta `color` con alfa = gris de la mascara * `amount`.
function applyMask(dst, mask, color, amount) {
  if (amount <= 0) return;
  for (let i = 0; i < dst.length; i += 4) {
    const a = (mask[i] / 255) * amount;
    if (a <= 0) continue;
    const ia = 1 - a;
    dst[i] = color[0] * a + dst[i] * ia;
    dst[i + 1] = color[1] * a + dst[i + 1] * ia;
    dst[i + 2] = color[2] * a + dst[i + 2] * ia;
  }
}

// Pinta la textura tal cual, usando su propio alfa.
function applyOver(dst, src, alpha) {
  const k = alpha === undefined ? 1 : alpha;
  for (let i = 0; i < dst.length; i += 4) {
    const a = (src[i + 3] / 255) * k;
    if (a <= 0) continue;
    const ia = 1 - a;
    dst[i] = src[i] * a + dst[i] * ia;
    dst[i + 1] = src[i + 1] * a + dst[i + 1] * ia;
    dst[i + 2] = src[i + 2] * a + dst[i + 2] * ia;
  }
}

function fill(width, height, color) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0]; data[i * 4 + 1] = color[1]; data[i * 4 + 2] = color[2]; data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

// Compone la textura de una region. `images` = { "fichero.tga": {width,height,data} }.
export function composeRegionTexture(region, images, opts = {}) {
  const recipe = REGION_RECIPES[region];
  if (!recipe) throw new Error("skinTexture: region desconocida «" + region + "»");
  const amounts = Object.assign({}, DEFAULT_AMOUNTS, opts.amounts);
  const look = Object.assign({}, DEFAULT_LOOK, opts.look);
  const skin = opts.skinColor || skinColorAt(look.skinTone);
  const hair = opts.hairColor || hairColorAt(look.hairTone);

  let size = opts.size | 0;
  if (!size) {
    for (const step of recipe) { const img = images[step.file]; if (img) { size = img.width; break; } }
  }
  if (!size) throw new Error("skinTexture: no hay ninguna capa para «" + region + "»");

  const first = recipe[0];
  let out = cloneImage(images[first.file] || fill(size, size, [255, 255, 255]));
  if (out.width !== size) out = resizeNearest(out, size, size);
  // Paso 1: el color de fondo es el tono de piel (el grano solo lo modula).
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = skin[0]; out.data[i + 1] = skin[1]; out.data[i + 2] = skin[2]; out.data[i + 3] = 255;
  }
  applyGrain(out.data, images[first.file] ? images[first.file].data : out.data, 1);

  const used = [first.file];
  const missing = [];
  for (let s = 1; s < recipe.length; s++) {
    const step = recipe[s];
    const img = images[step.file];
    if (!img) { if (step.amount === undefined || amounts[step.amount] > 0) missing.push(step.file); continue; }
    const src = (img.width === size && img.height === size) ? img.data : resizeNearest(img, size, size).data;
    used.push(step.file);
    if (step.op === "over") applyOver(out.data, src, step.alpha);
    else if (step.op === "mask") {
      const amount = (amounts[step.amount] === undefined ? 1 : amounts[step.amount]) * (step.amountScale === undefined ? 1 : step.amountScale);
      const color = step.color === "hair" ? hair : step.color;
      applyMask(out.data, src, color, amount);
    }
  }
  return { width: size, height: size, data: out.data, region, used, missing };
}

// Reescalado por vecino mas cercano (las capas de SL ya vienen a 512; esto solo
// se usa si alguien pide la textura final a otra medida).
export function resizeNearest(img, width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y + 0.5) * img.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x + 0.5) * img.width / width));
      const s = (sy * img.width + sx) * 4, d = (y * width + x) * 4;
      data[d] = img.data[s]; data[d + 1] = img.data[s + 1]; data[d + 2] = img.data[s + 2]; data[d + 3] = img.data[s + 3];
    }
  }
  return { width, height, data };
}

// --- ojos --------------------------------------------------------------------

// Mapa direccion -> texel de la malla del ojo. La esclerotica de SL desplega el
// globo como un disco: el frente queda en el centro de la textura y el ecuador
// en el borde de un circulo de radio 0,5. Pero en vez de fiarnos de esa
// formula, se rasterizan los triangulos en el espacio UV y se interpola la
// posicion: vale para cualquier malla y no hay que suponer nada.
export function rasterizeUvDirections(mesh, size) {
  const arrays = bodyBaseArrays(mesh);
  const n = mesh.vertexCount;
  const uv = mesh.texCoords;
  const idx = mesh.indices;
  const W = size, H = size;
  const dirs = new Float32Array(W * H * 3);

  // Centro de la esfera: se aproxima con el punto medio de la nube de vertices
  // en el eje de la mirada, que en estas mallas esta en el origen.
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
    if (i0 >= n || i1 >= n || i2 >= n) continue;
    const ux0 = uv[i0 * 2] * W, uy0 = (1 - uv[i0 * 2 + 1]) * H;
    const ux1 = uv[i1 * 2] * W, uy1 = (1 - uv[i1 * 2 + 1]) * H;
    const ux2 = uv[i2 * 2] * W, uy2 = (1 - uv[i2 * 2 + 1]) * H;
    const den = (uy1 - uy2) * (ux0 - ux2) + (ux2 - ux1) * (uy0 - uy2);
    if (Math.abs(den) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ux0, ux1, ux2)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ux0, ux1, ux2)));
    const y0 = Math.max(0, Math.floor(Math.min(uy0, uy1, uy2)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(uy0, uy1, uy2)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((uy1 - uy2) * (px - ux2) + (ux2 - ux1) * (py - uy2)) / den;
        if (w0 < -1e-6) continue;
        const w1 = ((uy2 - uy0) * (px - ux2) + (ux0 - ux2) * (py - uy2)) / den;
        if (w1 < -1e-6) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < -1e-6) continue;
        let vx = 0, vy = 0, vz = 0;
        const wa = [w0, w1, w2], verts = [i0, i1, i2];
        for (let k = 0; k < 3; k++) {
          vx += arrays.positions[verts[k] * 3] * wa[k];
          vy += arrays.positions[verts[k] * 3 + 1] * wa[k];
          vz += arrays.positions[verts[k] * 3 + 2] * wa[k];
        }
        const len = Math.hypot(vx, vy, vz);
        const o = (y * W + x) * 3;
        if (len < 1e-7) { dirs[o] = 0; dirs[o + 1] = 0; dirs[o + 2] = -1; continue; }
        dirs[o] = vx / len; dirs[o + 1] = vy / len; dirs[o + 2] = vz / len;
      }
    }
  }
  return dirs;
}

// Direccion a la que mira la malla del ojo (el vertice mas adelantado).
export function gazeDirection(mesh) {
  const arrays = bodyBaseArrays(mesh);
  const n = mesh.vertexCount;
  let best = -1, bestZ = Infinity;
  for (let i = 0; i < n; i++) { const z = arrays.positions[i * 3 + 2]; if (z < bestZ) { bestZ = z; best = i; } }
  if (best < 0) return [0, 0, -1];
  const len = Math.hypot(arrays.positions[best * 3], arrays.positions[best * 3 + 1], arrays.positions[best * 3 + 2]) || 1;
  return [arrays.positions[best * 3] / len, arrays.positions[best * 3 + 1] / len, arrays.positions[best * 3 + 2] / len];
}

// Ruido barato y determinista, para las fibras del iris (no hace falta que sea
// bonito: solo que no salga un circulo plano).
function hash11(x) {
  const s = Math.sin(x * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

// Textura del ojo: se parte de `eyewhite.tga` (esclerotica y venillas) y se
// dibuja el iris sobre la parte de la textura que mira al frente.
export function bakeEyeTexture(opts = {}) {
  const base = opts.eyewhite;
  if (!base) throw new Error("skinTexture: falta eyewhite.tga para el ojo");
  const size = opts.size || base.width;
  const src = base.width === size ? base : resizeNearest(base, size, size);
  const out = cloneImage(src);
  const mesh = opts.mesh || null;
  let dirs = null, gaze = [0, 0, -1];
  if (mesh) { dirs = rasterizeUvDirections(mesh, size); gaze = opts.gaze || gazeDirection(mesh); }

  const color = opts.color || eyeColorAt(DEFAULT_LOOK.eyeTone);
  const irisAngle = opts.irisAngle === undefined ? 0.52 : opts.irisAngle;   // ~30 grados
  const pupilRatio = opts.pupilRatio === undefined ? 0.30 : opts.pupilRatio;
  const limbal = 0.84;                                                      // anillo oscuro del borde
  const d = out.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let cosA;
      if (dirs) {
        const o = (y * size + x) * 3;
        cosA = dirs[o] * gaze[0] + dirs[o + 1] * gaze[1] + dirs[o + 2] * gaze[2];
      } else {
        // Sin malla: se supone el disco radial (frente en el centro).
        const dx = (x + 0.5) / size - 0.5, dy = (y + 0.5) / size - 0.5;
        cosA = Math.sqrt(Math.max(0, 1 - 4 * (dx * dx + dy * dy)));
      }
      const theta = Math.acos(Math.max(-1, Math.min(1, cosA)));
      if (theta >= irisAngle) continue;

      const t = theta / irisAngle;
      let r, g, b;
      if (t < pupilRatio) {
        // Pupila: casi negra, con un pelin de luz justo en el borde.
        const k = 0.06 + 0.10 * (t / pupilRatio);
        r = color[0] * k; g = color[1] * k; b = color[2] * k;
      } else {
        const s = (t - pupilRatio) / (1 - pupilRatio);       // 0 = borde de la pupila, 1 = borde del iris
        // Fibras radiales: ruido por angulo, que da las vetas del iris.
        const ang = Math.atan2(y - size / 2, x - size / 2);
        const fiber = 0.82 + 0.36 * hash11(Math.floor((ang + Math.PI) / (Math.PI * 2) * 220));
        const near = 0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - s * s)); // aclarado alrededor de la pupila
        let k = (0.55 + 0.75 * near) * fiber;
        if (s > limbal) k *= 1 - 0.75 * ((s - limbal) / (1 - limbal)); // anillo limbal
        r = color[0] * k; g = color[1] * k; b = color[2] * k;
      }
      d[i] = Math.max(0, Math.min(255, Math.round(r)));
      d[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      d[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      d[i + 3] = 255;
    }
  }
  return { width: size, height: size, data: d, irisAngle, pupilRatio, gaze };
}

// --- pelo --------------------------------------------------------------------

// Pelo de sistema: grano de pelo teñido con el color de pelo.
export function bakeHairTexture(opts = {}) {
  const grain = opts.grain;
  const color = opts.color || hairColorAt(DEFAULT_LOOK.hairTone);
  if (!grain) throw new Error("skinTexture: falta el grano de pelo");
  const out = cloneImage(grain);
  for (let i = 0; i < out.data.length; i += 4) {
    const k = out.data[i] / 255;
    out.data[i] = Math.min(255, color[0] * (0.55 + 0.65 * k));
    out.data[i + 1] = Math.min(255, color[1] * (0.55 + 0.65 * k));
    out.data[i + 2] = Math.min(255, color[2] * (0.55 + 0.65 * k));
    out.data[i + 3] = 255;
  }
  return out;
}

// --- material de three.js ----------------------------------------------------

// Pasa una imagen de trabajo (filas de arriba abajo) a una textura de three.js.
// El TGA guarda las filas al reves y las UV de SL tienen la v hacia arriba, asi
// que `bottomUp` invierte las filas para que texel (u,0) sea la base de la
// imagen. Se hace a mano en vez de con `flipY` porque subir un
// `Uint8Array` no respeta ese ajuste en todos los navegadores.
export function toTextureData(img, bottomUp) {
  if (!bottomUp) return img.data;
  const { width: w, height: h } = img;
  const row = w * 4;
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < h; y++) out.set(img.data.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}

export function makeTexture(THREE, img, opts = {}) {
  const t = new THREE.DataTexture(toTextureData(img, opts.bottomUp !== false), img.width, img.height, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = opts.anisotropy || 4;
  t.needsUpdate = true;
  return t;
}

function makeMaterial(THREE, texture, opts) {
  const m = new THREE.MeshStandardMaterial({
    map: texture || null,
    color: opts.color === undefined ? 0xffffff : opts.color,
    roughness: opts.roughness === undefined ? 0.8 : opts.roughness,
    metalness: opts.metalness || 0,
    transparent: !!opts.transparent,
    alphaTest: opts.alphaTest || 0,
    side: opts.side || THREE.FrontSide,
  });
  m.name = "piel:" + (opts.name || "capa");
  return m;
}

// Devuelve `{ materials, textures }` listo para `AvatarMesh({ materials })`.
// Las piezas que no tengan textura se quedan con su color plano de siempre.
export function buildAvatarMaterials(THREE, images, opts = {}) {
  const materials = {}, textures = {};
  const look = Object.assign({}, DEFAULT_LOOK, opts.look);
  const skin = opts.skinColor || skinColorAt(look.skinTone);
  const hair = opts.hairColor || hairColorAt(look.hairTone);

  for (const region of SKIN_REGIONS) {
    try {
      const composed = composeRegionTexture(region, images, opts);
      textures[region] = makeTexture(THREE, composed, opts);
      materials[region] = makeMaterial(THREE, textures[region], { name: region, roughness: 0.72 });
    } catch (e) { if (opts.strict) throw e; }
  }

  if (images[HAIR_GRAIN_FILE]) {
    try {
      const hairImg = bakeHairTexture({ grain: images[HAIR_GRAIN_FILE], color: hair });
      textures.hair = makeTexture(THREE, hairImg, opts);
      materials.hair = makeMaterial(THREE, textures.hair, { name: "hair", roughness: 0.88 });
    } catch (e) { if (opts.strict) throw e; }
  }

  const eyewhite = images["eyewhite.tga"] || null;
  if (eyewhite) {
    try {
      const eyeImg = bakeEyeTexture(Object.assign({}, opts.eye, {
        eyewhite,
        color: opts.eyeColor || eyeColorAt(look.eyeTone),
      }));
      textures.eye = makeTexture(THREE, eyeImg, opts);
      // Los dos ojos comparten malla, textura y material: no hay motivo para
      // tener dos copias y ademas asi no se pueden desincronizar.
      const eyeMat = makeMaterial(THREE, textures.eye, { name: "eye", roughness: 0.22, metalness: 0.0 });
      materials.eyeLeft = eyeMat;
      materials.eyeRight = eyeMat;
    } catch (e) { if (opts.strict) throw e; }
  }

  // Las pestañas del cuerpo de sistema no traen textura propia: en SL salen del
  // mismo `bake` de la cabeza. Un color oscuro y poco brillo hace el papel.
  materials.eyelashes = makeMaterial(THREE, null, { name: "eyelashes", color: 0x241d16, roughness: 0.6 });

  return { materials, textures, skinColor: skin, hairColor: hair };
}

// --- autotest -----------------------------------------------------------------

export function runSkinTextureSelfTest() {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });

  // Color: las paradas se devuelven tal cual y en medio se interpola.
  ok("colorAt devuelve la primera parada", colorAt(SKIN_COLOR_STOPS, 0).join() === "252,215,200");
  ok("colorAt devuelve la ultima parada", colorAt(SKIN_COLOR_STOPS, 1).join() === "29,9,6");
  const mid = colorAt([[0, 0, 0], [100, 200, 40]], 0.5);
  ok("colorAt interpola en medio", mid.join() === "50,100,20", mid.join());
  ok("colorAt recorta fuera de rango", colorAt(SKIN_COLOR_STOPS, -3).join() === "252,215,200" && colorAt(SKIN_COLOR_STOPS, 9).join() === "29,9,6");
  ok("el pelo va de negro a rubio", hairColorAt(0).join() === "0,0,0" && hairColorAt(1)[0] > 200);
  ok("el ojo tiene 8 paradas", EYE_COLOR_STOPS.length === 8);

  // Recetas: cada paso apunta a un fichero con pinta de textura.
  const files = textureFilesFor();
  ok("se piden las capas de las tres regiones", files.length >= 11, files.length);
  ok("el grano del cuerpo se pide una sola vez", files.filter((f) => f === "body_skingrain.tga").length === 1);
  ok("sin maquillaje no se piden sus mascaras", !files.includes("lipstick_alpha.tga") && !files.includes("eyeliner_alpha.tga"));
  ok("con maquillaje si se piden", textureFilesFor(SKIN_REGIONS, { lipstick: true, eyeliner: true, eyeshadow: true }).includes("lipstick_alpha.tga"));
  ok("una region desconocida da error", (() => { try { textureFilesFor(["codo"]); return false; } catch (e) { return true; } })());

  // Composicion: se le dan capas sinteticas y se comprueba el resultado exacto.
  const W = 4, H = 4;
  const flat = (v) => { const d = new Uint8Array(W * H * 4); for (let i = 0; i < W * H; i++) { d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = v; } return { width: W, height: H, data: d }; };
  const images = {
    "head_skingrain.tga": flat(255),          // grano neutro
    "head_color.tga": flat(0),                // totalmente transparente: no pinta nada
    "head_shading_alpha.tga": flat(0),        // sin sombra
    "head_highlights_alpha.tga": flat(0),
    "rosyface_alpha.tga": flat(0),
    "lips_mask.tga": flat(255),               // labios a tope
    "lipstick_alpha.tga": flat(0),
    "eyeliner_alpha.tga": flat(0),
    "eyeshadow_outer_alpha.tga": flat(0),
    "eyebrows_alpha.tga": flat(0),
  };
  const head = composeRegionTexture("head", images, { look: { skinTone: 0, hairTone: 0 }, amounts: { shading: 0, highlight: 0, rosy: 0, lips: 0, eyebrows: 0, lipstick: 0, eyeliner: 0, eyeshadow: 0 } });
  ok("la cabeza sale a 4x4", head.width === 4 && head.height === 4);
  // Grano 255 y sin ninguna capa activa => queda el tono de piel puro.
  ok("sin capas activas queda el tono de piel", [head.data[0], head.data[1], head.data[2]].join() === skinColorAt(0).join(), [head.data[0], head.data[1], head.data[2]].join());
  ok("no falta ninguna capa", head.missing.length === 0, head.missing.join());

  const tinted = composeRegionTexture("head", images, { look: { skinTone: 0, hairTone: 0 }, amounts: { shading: 0, highlight: 0, rosy: 0, lips: 0.5, eyebrows: 0, lipstick: 0, eyeliner: 0, eyeshadow: 0 } });
  ok("la mascara de labios tine el resultado", tinted.data[0] !== skinColorAt(0)[0], tinted.data[0] + " vs " + skinColorAt(0)[0]);
  ok("los labios tiran hacia el color de labios", tinted.data[1] < skinColorAt(0)[1] && tinted.data[2] < skinColorAt(0)[2], [tinted.data[0], tinted.data[1], tinted.data[2]].join());

  // El gris 0 de grano oscurece a la mitad con fuerza 1... el grano multiplica
  // por gris/255, asi que un grano negro deja la piel en negro.
  const dark = composeRegionTexture("head", Object.assign({}, images, { "head_skingrain.tga": flat(0) }), { look: { skinTone: 0 }, amounts: { lips: 0 } });
  ok("un grano negro apaga el tono de piel", dark.data[0] === 0 && dark.data[1] === 0 && dark.data[2] === 0, [dark.data[0], dark.data[1], dark.data[2]].join());

  // Capas que faltan: se anotan pero no revientan.
  const partial = composeRegionTexture("head", { "head_skingrain.tga": flat(255) }, { look: { skinTone: 0 } });
  ok("una capa que falta se apunta", partial.missing.includes("head_color.tga"));
  ok("con lo que hay se compone igual", partial.data[3] === 255);

  // Ojos: la textura sintetica tiene la pupila oscura en el centro y la
  // esclerotica intacta en el borde.
  const W2 = 64, H2 = 64;
  const white = { width: W2, height: H2, data: new Uint8Array(W2 * H2 * 4) };
  for (let i = 0; i < W2 * H2; i++) { white.data[i * 4] = 250; white.data[i * 4 + 1] = 250; white.data[i * 4 + 2] = 250; white.data[i * 4 + 3] = 255; }
  const irisDark = [80, 40, 10];
  const eye = bakeEyeTexture({ eyewhite: white, size: W2, color: irisDark });
  const at = (x, y) => { const i = (y * W2 + x) * 4; return [eye.data[i], eye.data[i + 1], eye.data[i + 2]]; };
  const c = at(32, 32);
  ok("el centro del ojo es la pupila (muy oscura)", c[0] < 30 && c[1] < 30 && c[2] < 30, c.join());
  const ring = at(32, 32 - Math.round(W2 * 0.5 * Math.sin(0.40)));
  ok("a media distancia hay iris, no pupila", ring[0] > c[0], ring.join() + " vs " + c.join());
  const far = at(32, 1);
  ok("el borde sigue siendo esclerotica", far[0] > 200 && far[1] > 200, far.join());

  // Subida a textura: las filas se invierten cuando se pide.
  const img2 = { width: 2, height: 2, data: new Uint8Array([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]) };
  const flipped = toTextureData(img2, true);
  ok("toTextureData invierte las filas", flipped[0] === 3 && flipped[4] === 4 && flipped[8] === 1 && flipped[12] === 2, [...flipped].join());
  ok("sin invertir deja las filas igual", toTextureData(img2, false)[0] === 1);

  const failed = checks.filter((c2) => !c2.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "skinTexture selftest: all " + checks.length + " checks passed"
      : "skinTexture selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c2) => c2.name).join(", ") + ")",
  };
}
