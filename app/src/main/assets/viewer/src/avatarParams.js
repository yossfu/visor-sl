// avatarParams.js -- el "aspecto" del avatar: parametros visuales y ropa.
//
// En Second Life el cuerpo de un avatar no se guarda como una malla: se guarda
// como un puñado de *parametros visuales* (los deslizadores del editor de
// aspecto: altura, corpulencia, hombros, tamaño de ojos, ...) mas un conjunto de
// *capas* (piel, tatuajes y prendas) que el servidor "cuece" a texturas. Este
// modulo replica esa idea de la forma mas util para un visor: el aspecto es un
// objeto de datos pequeno, serializable y difundible por la red, y la geometria
// y las texturas se GENERAN a partir de el.
//
// Por que asi: es el mismo principio que ya usa el proyecto con los prims
// ("la red transporta parametros, no geometria"). Si dos clientes tienen el
// mismo aspecto, generan el mismo avatar sin mandarse un solo vertice. Y un
// aspecto cabe en ~200 bytes, asi que se puede guardar en `kv` y mandar por el
// socket sin pensarlo.
//
// Los nombres de los parametros siguen a los de `avatar_lad.xml` de Linden Lab
// en lo que tiene sentido (Height, Body Thickness, Shoulders, Head Size, ...),
// pero todos se normalizan a 0..1 para que la interfaz sea homogenea.

export const PARAM_GROUPS = ["Cuerpo", "Cabeza", "Cara", "Piel", "Pelo"];

// Cada parametro: clave, etiqueta en castellano, grupo, valor por defecto y un
// `real` que convierte 0..1 al rango fisico que se muestra en el panel (para que
// el usuario lea "1,78 m" y no "0,45").
export const PARAMS = [
  // --- cuerpo ---
  { key: "genero", label: "Genero", group: "Cuerpo", def: 0.5, real: (v) => (v * 100).toFixed(0) + " % femenino" },
  { key: "altura", label: "Altura", group: "Cuerpo", def: 0.5, real: (v) => (1.45 + v * 0.75).toFixed(2) + " m" },
  { key: "corpulencia", label: "Corpulencia", group: "Cuerpo", def: 0.45 },
  { key: "grasa", label: "Grasa corporal", group: "Cuerpo", def: 0.35 },
  { key: "musculo", label: "Musculo", group: "Cuerpo", def: 0.4 },
  { key: "hombros", label: "Hombros", group: "Cuerpo", def: 0.5 },
  { key: "pecho", label: "Pecho", group: "Cuerpo", def: 0.45 },
  { key: "cintura", label: "Cintura", group: "Cuerpo", def: 0.45 },
  { key: "caderas", label: "Caderas", group: "Cuerpo", def: 0.5 },
  { key: "barriga", label: "Barriga", group: "Cuerpo", def: 0.35 },
  { key: "brazos", label: "Largo de brazos", group: "Cuerpo", def: 0.5 },
  { key: "piernas", label: "Largo de piernas", group: "Cuerpo", def: 0.5 },
  { key: "manos", label: "Tamaño de manos", group: "Cuerpo", def: 0.5 },
  { key: "pies", label: "Tamaño de pies", group: "Cuerpo", def: 0.5 },
  { key: "cuello", label: "Cuello", group: "Cuerpo", def: 0.5 },

  // --- cabeza ---
  { key: "cabeza", label: "Tamaño de cabeza", group: "Cabeza", def: 0.5 },
  { key: "formaCabeza", label: "Forma de cabeza", group: "Cabeza", def: 0.5 },
  { key: "mandibula", label: "Mandibula", group: "Cabeza", def: 0.5 },
  { key: "orejas", label: "Orejas", group: "Cabeza", def: 0.5 },

  // --- cara ---
  { key: "ojosTam", label: "Tamaño de ojos", group: "Cara", def: 0.5 },
  { key: "ojosSep", label: "Separacion de ojos", group: "Cara", def: 0.5 },
  { key: "ojosApertura", label: "Apertura de ojos", group: "Cara", def: 0.5 },
  { key: "cejas", label: "Cejas", group: "Cara", def: 0.5 },
  { key: "nariz", label: "Nariz", group: "Cara", def: 0.5 },
  { key: "boca", label: "Boca", group: "Cara", def: 0.5 },
  { key: "labios", label: "Labios", group: "Cara", def: 0.5 },
  { key: "pomulos", label: "Pomulos", group: "Cara", def: 0.5 },

  // --- piel ---
  { key: "tono", label: "Tono de piel", group: "Piel", def: 0.55, real: (v) => (v * 100).toFixed(0) + " % claro" },
  { key: "brillo", label: "Brillo de piel", group: "Piel", def: 0.35 },

  // --- pelo ---
  { key: "peloLargo", label: "Largo del pelo", group: "Pelo", def: 0.45 },
  { key: "peloVolumen", label: "Volumen del pelo", group: "Pelo", def: 0.5 },
];

export const PARAM_KEYS = PARAMS.map((p) => p.key);
const PARAM_BY_KEY = new Map(PARAMS.map((p) => [p.key, p]));

// Estilos de pelo (el indice va en `hair.estilo`).
export const HAIR_STYLES = ["rapado", "corto", "media melena", "melena", "coleta", "moño", "afro"];

// Prendas por ranura. `tipo` es el indice dentro del catalogo de la ranura.
export const OUTFIT_SLOTS = [
  {
    key: "top", label: "Parte de arriba", def: "camiseta",
    types: ["ninguna", "camiseta", "blusa", "top", "camisa"],
  },
  {
    key: "bottom", label: "Parte de abajo", def: "pantalon",
    types: ["ninguna", "pantalon", "pantalon corto", "falda", "falda larga"],
  },
  {
    key: "outer", label: "Abrigo", def: "ninguno",
    types: ["ninguno", "chaqueta", "abrigo", "chaleco"],
  },
  {
    key: "shoes", label: "Calzado", def: "zapatos",
    types: ["ninguna", "zapatos", "botas", "deportivas", "sandalias"],
  },
  {
    key: "hair", label: "Pelo", def: "media melena",
    types: HAIR_STYLES,
  },
  {
    key: "hat", label: "Sombrero", def: "ninguno",
    types: ["ninguno", "gorra", "sombrero"],
  },
  {
    key: "glasses", label: "Gafas", def: "ninguna",
    types: ["ninguna", "gafas", "gafas de sol"],
  },
];

export const OUTFIT_KEYS = OUTFIT_SLOTS.map((s) => s.key);
const SLOT_BY_KEY = new Map(OUTFIT_SLOTS.map((s) => [s.key, s]));

// Paleta de colores de ropa (indices guardados como numero, mas compacto que un
// hex en el protocolo de red, y asi el color no depende del navegador).
export const CLOTH_COLORS = [
  0x4a6f9c, 0x8a4a6f, 0x4a7c4a, 0x7a6a2a, 0x8a5a2a, 0x6a4a8a,
  0x2f3a4a, 0x33383d, 0xb03040, 0xd8d2c8, 0x1c1f24, 0xe0a030,
  0x2a6a5a, 0xa04030, 0x506070, 0xc0c0c8,
];
export const SKIN_TONES = [
  0xf6e0cc, 0xf0d0b4, 0xe4b894, 0xd8a984, 0xc89060, 0xa87048,
  0x8a5838, 0x6a4228, 0x503020, 0x3a2418,
];
export const HAIR_COLORS = [
  0x2a1c14, 0x3a2a1c, 0x5a3a20, 0x8a5a28, 0xc09040, 0xd8c080,
  0x9a3020, 0x503878, 0x1c1c1c, 0xe8e0d0, 0x6a8aa0, 0x2a6a50,
];

// Patrones que se pueden estampar en una prenda. `null` = lisa (color plano).
// Reutiliza la biblioteca procedural de `src/textures.js` (solo los patrones
// que tienen sentido como tela).
export const CLOTH_PATTERNS = [
  null, "tela", "lino", "denim", "cuadros", "rayas", "lunares", "encaje",
  "piel", "seda", "lana",
];

// --- FORMA REAL DE SECOND LIFE ----------------------------------------------
// El aspecto procedural de arriba (parametros 0..1 inventados por este visor)
// sirve para el cuerpo parametrico. Pero un avatar de verdad se ve como se ve
// por sus PARAMETROS VISUALES de `avatar_lad.xml` (los del editor de forma de
// SL) aplicados sobre las mallas de sistema. Este bloque viaja DENTRO del
// aspecto, para que un residente remoto llegue ya con su forma real.
//
//   shape = {
//     sex: "male" | "female" | "both" | "auto",
//     visualParams: [[id, peso], ...],   // id de avatar_lad -> peso
//     bakes: { head|upper|lower|eyes|hair|skirt|eyelashes: {uuid} },
//   }
//
// Los `bakes` son las texturas "cocidas" del Bakes-on-Mesh (BoM): la piel con
// la ropa ya compuesta. Solo se guarda su uuid; la textura la sirve el
// retransmisor y el visor la resuelve con `World.getAssetTexture`.

export function normalizeShape(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  const sex = input.sex;
  out.sex = (sex === "male" || sex === "female" || sex === "both" || sex === "auto") ? sex : "auto";
  const vp = input.visualParams;
  const params = [];
  if (Array.isArray(vp)) {
    for (const pair of vp) {
      const id = Array.isArray(pair) ? Number(pair[0]) : Number(pair && pair.id);
      const w = Array.isArray(pair) ? Number(pair[1]) : Number(pair && pair.value);
      if (Number.isFinite(id) && Number.isFinite(w)) params.push([id, w]);
    }
  } else if (vp && typeof vp === "object") {
    for (const k in vp) {
      const id = Number(k), w = Number(vp[k]);
      if (Number.isFinite(id) && Number.isFinite(w)) params.push([id, w]);
    }
  }
  out.visualParams = params;
  const bakes = {};
  const bin = input.bakes && typeof input.bakes === "object" ? input.bakes : null;
  if (bin) {
    for (const slot of BAKE_SLOT_KEYS) {
      const b = bin[slot];
      if (!b) continue;
      const uuid = typeof b === "string" ? b : (b.uuid || null);
      if (uuid) bakes[slot] = { uuid: String(uuid) };
      else if (b.texture) bakes[slot] = { texture: true };
    }
  }
  out.bakes = bakes;
  return out;
}

// Los slots de bake del BoM (mismos nombres que `slAppearance.js`), en un array
// local para no crear una dependencia circular entre los dos modulos.
export const BAKE_SLOT_KEYS = ["head", "upper", "lower", "eyes", "hair", "skirt", "eyelashes"];

// El bloque de forma de un aspecto, ya normalizado (o null si no hay).
export function shapeOf(app) {
  if (!app) return null;
  if (app.shape) return app.shape;
  if (app.visualParams) return normalizeShape(app);
  return null;
}

// Cuantos parametros/bakes lleva una forma (para los informes y la interfaz).
export function shapeSummary(shape) {
  if (!shape) return "sin forma real";
  const n = shape.visualParams ? shape.visualParams.length : 0;
  const b = shape.bakes ? Object.keys(shape.bakes).length : 0;
  return "forma " + shape.sex + ": " + n + " parámetros" + (b ? ", " + b + " bakes (BoM)" : ", sin bakes");
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rngFrom(seed) {
  let s = (typeof seed === "number" ? seed : hash32(String(seed))) >>> 0;
  return function () {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function defaultAppearance(name = "Residente") {
  const params = {};
  for (const p of PARAMS) params[p.key] = p.def;
  const outfit = {};
  for (const s of OUTFIT_SLOTS) {
    outfit[s.key] = {
      tipo: s.def,
      color: CLOTH_COLORS[OUTFIT_KEYS.indexOf(s.key) % CLOTH_COLORS.length],
      patron: null,
    };
  }
  outfit.hair.color = HAIR_COLORS[1];
  return {
    v: 1,
    name,
    params,
    skin: { color: SKIN_TONES[3] },
    outfit,
    shape: null,
  };
}

// Un aspecto aleatorio pero estable para una semilla (asi los residentes del
// simulador de pruebas no dependen del azar de cada carga, y dos clientes que
// reciben la misma semilla ven lo mismo).
export function randomAppearance(seed, name = "Residente") {
  const rnd = rngFrom(seed);
  const app = defaultAppearance(name);
  const p = app.params;
  p.genero = rnd();
  p.altura = 0.25 + rnd() * 0.6;
  p.corpulencia = 0.2 + rnd() * 0.6;
  p.grasa = rnd() * 0.7;
  p.musculo = rnd();
  p.hombros = 0.2 + rnd() * 0.7;
  p.pecho = rnd();
  p.cintura = rnd();
  p.caderas = 0.2 + rnd() * 0.7;
  p.barriga = rnd() * 0.6;
  p.brazos = 0.25 + rnd() * 0.5;
  p.piernas = 0.3 + rnd() * 0.45;
  p.manos = 0.3 + rnd() * 0.5;
  p.pies = 0.3 + rnd() * 0.5;
  p.cuello = 0.3 + rnd() * 0.5;
  p.cabeza = 0.3 + rnd() * 0.4;
  p.formaCabeza = rnd();
  p.mandibula = rnd();
  p.orejas = rnd();
  p.ojosTam = rnd();
  p.ojosSep = rnd();
  p.ojosApertura = 0.3 + rnd() * 0.5;
  p.cejas = rnd();
  p.nariz = rnd();
  p.boca = rnd();
  p.labios = rnd();
  p.pomulos = rnd();
  p.tono = rnd();
  p.brillo = 0.2 + rnd() * 0.5;
  p.peloLargo = rnd();
  p.peloVolumen = rnd();

  app.skin.color = SKIN_TONES[Math.round(p.tono * (SKIN_TONES.length - 1))];
  for (const slot of OUTFIT_SLOTS) {
    const o = outfitSlot(app, slot.key);
    if (slot.key === "hair") continue;
    o.tipo = slot.types[Math.floor(rnd() * slot.types.length)] || "ninguna";
    o.color = CLOTH_COLORS[Math.floor(rnd() * CLOTH_COLORS.length)];
    o.patron = CLOTH_PATTERNS[Math.floor(rnd() * CLOTH_PATTERNS.length)];
  }
  const hair = outfitSlot(app, "hair");
  hair.tipo = HAIR_STYLES[Math.floor(rnd() * HAIR_STYLES.length)];
  hair.color = HAIR_COLORS[Math.floor(rnd() * HAIR_COLORS.length)];
  return app;
}

export function outfitSlot(app, key) {
  if (!app.outfit) app.outfit = {};
  if (!app.outfit[key] || typeof app.outfit[key] !== "object") {
    const def = SLOT_BY_KEY.get(key);
    app.outfit[key] = { tipo: def ? def.def : "ninguna", color: 0x888888, patron: null };
  }
  return app.outfit[key];
}

// Rellena lo que falte y recorta los valores. Nunca tira lo que ya hay: sirve
// tanto para un aspecto viejo guardado en `kv` como para uno que llega por la
// red de una version distinta.
export function normalizeAppearance(input) {
  const src = input && typeof input === "object" ? input : {};
  const base = defaultAppearance(src.name || "Residente");
  const out = base;
  if (src.name) out.name = String(src.name).slice(0, 40);
  const pin = src.params && typeof src.params === "object" ? src.params : {};
  for (const p of PARAMS) {
    if (typeof pin[p.key] === "number" && isFinite(pin[p.key])) out.params[p.key] = clamp01(pin[p.key]);
  }
  if (src.skin && typeof src.skin === "object") {
    if (typeof src.skin.color === "number") out.skin.color = src.skin.color | 0;
    else if (typeof src.skin.color === "string") out.skin.color = hexToInt(src.skin.color);
  }
  const oin = src.outfit && typeof src.outfit === "object" ? src.outfit : {};
  for (const slot of OUTFIT_SLOTS) {
    const s = SLOT_BY_KEY.get(slot.key);
    const raw = oin[slot.key];
    const dst = outfitSlot(out, slot.key);
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.tipo === "string" && slot.types.includes(raw.tipo)) dst.tipo = raw.tipo;
    if (typeof raw.color === "number") dst.color = raw.color | 0;
    else if (typeof raw.color === "string") dst.color = hexToInt(raw.color);
    if (raw.patron === null || raw.patron === undefined) dst.patron = null;
    else if (typeof raw.patron === "string" && CLOTH_PATTERNS.includes(raw.patron)) dst.patron = raw.patron;
  }
  // La forma real de SL (avatar_lad + bakes) viaja con el aspecto. Se acepta
  // tanto anidada (`shape`) como suelta (`visualParams`), que es lo que devuelve
  // `SLAppearance.snapshot()`.
  const shape = normalizeShape(src.shape || (src.visualParams ? src : null));
  if (shape && (shape.visualParams.length || Object.keys(shape.bakes).length)) out.shape = shape;
  return out;
}

// Una version compacta para la red y para `kv`: solo lo que difiere del defecto
// se manda, con las claves en corto. Un aspecto tipico cabe en menos de 300
// bytes de JSON.
export function packAppearance(app) {
  const a = normalizeAppearance(app);
  const params = {};
  for (const p of PARAMS) {
    const v = Math.round(clamp01(a.params[p.key]) * 255);
    if (v !== Math.round(p.def * 255)) params[p.key] = v;
  }
  const outfit = {};
  for (const slot of OUTFIT_SLOTS) {
    outfit[slot.key] = [a.outfit[slot.key].tipo, a.outfit[slot.key].color, a.outfit[slot.key].patron];
  }
  const out = { n: a.name, p: params, s: a.skin.color, o: outfit };
  // La forma real de SL, si la hay: los pesos a 3 decimales (sobra) y los
  // bakes como uuid corto. Un cuerpo de SL completo en forma compacta sigue
  // cabiendo en unos pocos cientos de bytes.
  if (a.shape) {
    const sh = { x: a.shape.sex };
    if (a.shape.visualParams && a.shape.visualParams.length) {
      sh.v = a.shape.visualParams.map(([id, w]) => [id, Math.round(w * 1000) / 1000]);
    }
    const bk = a.shape.bakes || {};
    const b = {};
    for (const k in bk) if (bk[k] && bk[k].uuid) b[k] = bk[k].uuid;
    if (Object.keys(b).length) sh.b = b;
    out.h = sh;
  }
  return out;
}

export function unpackAppearance(packed) {
  const src = packed && typeof packed === "object" ? packed : {};
  const app = defaultAppearance(src.n || "Residente");
  if (src.s !== undefined) app.skin.color = src.s | 0;
  if (src.p && typeof src.p === "object") {
    for (const k of Object.keys(src.p)) {
      if (PARAM_BY_KEY.has(k) && typeof src.p[k] === "number") app.params[k] = clamp01(src.p[k] / 255);
    }
  }
  if (src.o && typeof src.o === "object") {
    for (const slot of OUTFIT_SLOTS) {
      const raw = src.o[slot.key];
      const dst = outfitSlot(app, slot.key);
      if (!Array.isArray(raw)) continue;
      if (typeof raw[0] === "string" && slot.types.includes(raw[0])) dst.tipo = raw[0];
      if (typeof raw[1] === "number") dst.color = raw[1] | 0;
      if (raw[2] === null || typeof raw[2] === "string") dst.patron = raw[2] || null;
    }
  }
  if (src.h && typeof src.h === "object") {
    const shape = normalizeShape({
      sex: src.h.x,
      visualParams: src.h.v || [],
      bakes: src.h.b || {},
    });
    if (shape && (shape.visualParams.length || Object.keys(shape.bakes).length)) app.shape = shape;
  }
  return app;
}

export function hexToInt(s) {
  if (typeof s === "number") return s | 0;
  const t = String(s).replace("#", "").trim();
  const n = parseInt(t.length === 3 ? t[0] + t[0] + t[1] + t[1] + t[2] + t[2] : t, 16);
  return isFinite(n) ? n : 0x888888;
}

export function paramInfo(key) { return PARAM_BY_KEY.get(key) || null; }
export function slotInfo(key) { return SLOT_BY_KEY.get(key) || null; }
