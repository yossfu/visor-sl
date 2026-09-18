// characterAssets.js -- los ficheros de personaje REALES de Second Life.
//
// El cuerpo y la cabeza "de sistema" (los que llevaba todo el mundo antes de
// las cabezas mesh) no son un modelo inventado: son los originales del visor
// oficial, que los distribuye como parte de su código fuente. Este visor NO
// los copia en su propio repositorio (buena parte de los activos de SL son de
// Linden Lab o de los creadores, con todos los derechos reservados, y copiarlos
// aquí sería redistribuirlos): los pide a la fuente original en tiempo de
// ejecución y los guarda en memoria mientras dura la página. Es exactamente lo
// que hace cualquier visor con sus ficheros de instalación.
//
// Cuando hay una sesión con el retransmisor (`VIEWER-REAL.md`), esos bytes
// llegan por el socket y esta caché se rellena desde `provider`, así que el
// mismo código sirve para los dos caminos:
//
//   - `provider`  función `async (nombre) => Uint8Array` (el retransmisor).
//   - por defecto, los ficheros públicos del código fuente del visor.
//
// MODELO INCLUIDO EN LA APP: la app Android puede llevar estos mismos ficheros
// dentro del APK (los descarga al compilar `src/android/fetch-character-assets.mjs`),
// en `assets/viewer/character/`. Si están, se usan ANTES que la red y el visor
// tiene el cuerpo real de sistema aunque no haya conexión; si no, se pide por
// red como siempre. En perchance esa carpeta no existe y la petición local da
// 404, así que simplemente se cae al espejo público.

import { decodeTga } from "./tga.js";

export const CHARACTER_MIRRORS = [
  "https://raw.githubusercontent.com/secondlife/viewer/main/indra/newview/character/",
];

// Espejo local (relativo a la página). Es donde la app Android mete el modelo.
export const LOCAL_MIRROR = "character/";

// ¿Estamos dentro de la app Android? `env.js` deja `window.__SL_APP__` puesto
// antes de que arranque el visor.
export function isAndroidApp() {
  return typeof window !== "undefined" && !!(window.__SL_APP__ && window.__SL_APP__.android);
}

// Piezas del cuerpo de sistema: nombre de pieza -> fichero (lod 0).
export const SYSTEM_BODY_FILE_BY_PART = {
  head: "avatar_head.llm",
  eyelashes: "avatar_eyelashes.llm",
  upperBody: "avatar_upper_body.llm",
  lowerBody: "avatar_lower_body.llm",
  skirt: "avatar_skirt.llm",
  hair: "avatar_hair.llm",
  eyeLeft: "avatar_eye.llm",
  eyeRight: "avatar_eye.llm",
};

// Niveles de detalle (los `_1`.. `_4` del directorio). El visor elige uno según
// el tamaño en pantalla; aquí se usan para bajar el coste con mucha gente.
export const SYSTEM_BODY_LOD_COUNT = 5;

// Fichero de una pieza en un nivel de detalle concreto.
export function systemBodyFile(part, lod = 0) {
  const base = SYSTEM_BODY_FILE_BY_PART[part];
  if (!base) return null;
  const l = Math.max(0, Math.min(SYSTEM_BODY_LOD_COUNT - 1, lod | 0));
  return l === 0 ? base : base.replace(/\.llm$/, "_" + l + ".llm");
}

// Texturas base de la piel clásica (se componen en `skinTexture.js`).
export const SKIN_TEXTURE_FILES = {
  headColor: "head_color.tga",
  upperColor: "upperbody_color.tga",
  lowerColor: "lowerbody_color.tga",
  bodyGrain: "body_skingrain.tga",
  headGrain: "head_skingrain.tga",
  upperShading: "upperbody_shading_alpha.tga",
  upperHighlights: "upperbody_highlights_alpha.tga",
  headShading: "head_shading_alpha.tga",
  headHighlights: "head_highlights_alpha.tga",
  lowerShading: "lowerbody_shading_alpha.tga",
  lowerHighlights: "lowerbody_highlights_alpha.tga",
  lipsMask: "lips_mask.tga",
  lipstick: "lipstick_alpha.tga",
  eyeWhite: "eyewhite.tga",
  eyebrows: "eyebrows_alpha.tga",
  eyeliner: "eyeliner_alpha.tga",
};
function joinUrl(base, file) {
  return base.replace(/\/?$/, "/") + file;
}

export function assetUrl(file, opts = {}) {
  const base = opts.base || (opts.mirrors && opts.mirrors.length ? opts.mirrors[0] : CHARACTER_MIRRORS[0]);
  return joinUrl(base, file);
}

// --- caché -------------------------------------------------------------------

const _cache = new Map();   // file -> Uint8Array
const _promises = new Map(); // file -> Promise (para no pedir dos veces lo mismo)

export function cachedCharacterFile(file) {
  return _cache.get(file) || null;
}

export function clearCharacterCache() {
  _cache.clear();
  _promises.clear();
}

// Pide un fichero. `opts.provider` (el retransmisor) manda si está; si no, se
// prueban los espejos públicos en orden. El resultado se cachea.
export async function fetchCharacterFile(file, opts = {}) {
  if (_cache.has(file)) return _cache.get(file);
  if (_promises.has(file)) return _promises.get(file);
  const task = (async () => {
    if (opts.provider) {
      const bytes = await opts.provider(file);
      if (!bytes) throw new Error("characterAssets: el retransmisor no tiene «" + file + "»");
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      _cache.set(file, u8);
      return u8;
    }
    const mirrors = [];
    // El espejo local (el modelo metido en el APK, o `opts.local`) va primero.
    const wantLocal = opts.local !== undefined ? !!opts.local : isAndroidApp();
    if (wantLocal) mirrors.push(opts.localBase || LOCAL_MIRROR);
    for (const m of (opts.mirrors || CHARACTER_MIRRORS)) mirrors.push(m);
    let lastError = null;
    for (const base of mirrors) {
      const url = joinUrl(base, file);
      try {
        const res = await fetch(url, { cache: "force-cache", mode: "cors" });
        if (!res.ok) { lastError = new Error("HTTP " + res.status + " en " + url); continue; }
        const u8 = new Uint8Array(await res.arrayBuffer());
        _cache.set(file, u8);
        return u8;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("characterAssets: no se pudo pedir «" + file + "»");
  })();
  _promises.set(file, task);
  try {
    return await task;
  } catch (e) {
    _promises.delete(file);
    throw e;
  }
}

// Cuerpo de sistema completo: `{ head: Uint8Array, upperBody: ..., ... }`, listo
// para `avatarMesh.loadSystemBody`. Se piden en paralelo y se avisa del avance
// con `opts.onProgress(done, total)`.
export async function fetchSystemBodyFiles(opts = {}) {
  const lod = opts.lod | 0;
  const parts = opts.parts || Object.keys(SYSTEM_BODY_FILE_BY_PART);
  const out = {};
  let done = 0;
  const total = parts.length;
  await Promise.all(parts.map(async (part) => {
    const file = systemBodyFile(part, lod);
    const bytes = await fetchCharacterFile(file, opts);
    out[part] = bytes;
    done++;
    if (opts.onProgress) opts.onProgress(done, total, part);
  }));
  return out;
}

// --- texturas ----------------------------------------------------------------

// Todo lo que hace falta para reconstruir la piel de sistema, los ojos y el
// pelo de un residente (`skinTexture.js` las compone). Es la lista "completa":
// quien pida menos, que pase su propia lista a `fetchCharacterTextures`.
export const SYSTEM_TEXTURE_FILES = [
  "head_skingrain.tga", "body_skingrain.tga",
  "head_color.tga", "upperbody_color.tga", "lowerbody_color.tga",
  "head_shading_alpha.tga", "head_highlights_alpha.tga",
  "upperbody_shading_alpha.tga", "upperbody_highlights_alpha.tga",
  "lowerbody_shading_alpha.tga", "lowerbody_highlights_alpha.tga",
  "rosyface_alpha.tga", "lips_mask.tga", "eyebrows_alpha.tga",
  "head_hair.tga", "eyewhite.tga",
];

// Ficheros de maquillaje: solo se piden si el avatar los lleva.
export const MAKEUP_TEXTURE_FILES = ["lipstick_alpha.tga", "eyeliner_alpha.tga", "eyeshadow_outer_alpha.tga", "eyeshadow_inner_alpha.tga"];

const _textureCache = new Map();   // file -> { width, height, data }

export function cachedCharacterTexture(file) {
  return _textureCache.get(file) || null;
}

export function clearTextureCache() {
  _textureCache.clear();
}

// Pide y decodifica un puñado de TGA en paralelo. `opts.onProgress(done, total)`
// para la barra de carga.
export async function fetchCharacterTextures(files, opts = {}) {
  const list = files || SYSTEM_TEXTURE_FILES;
  const out = {};
  let done = 0;
  const total = list.length;
  await Promise.all(list.map(async (file) => {
    let img = _textureCache.get(file);
    if (!img) {
      const bytes = await fetchCharacterFile(file, opts);
      img = decodeTga(bytes);
      _textureCache.set(file, img);
    }
    out[file] = img;
    done++;
    if (opts.onProgress) opts.onProgress(done, total, file);
  }));
  return out;
}

// --- autotest -----------------------------------------------------------------

// Comprueba la tabla, la construcción de las rutas y la caché sin tocar la red
// (se le inyecta un `provider` de mentira).
export async function runCharacterAssetsSelfTest() {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });

  ok("ocho piezas de sistema", Object.keys(SYSTEM_BODY_FILE_BY_PART).length === 8);
  ok("cabeza y ojos son .llm", SYSTEM_BODY_FILE_BY_PART.head.endsWith(".llm") && SYSTEM_BODY_FILE_BY_PART.eyeLeft.endsWith(".llm"));
  ok("el ojo izquierdo y el derecho son el mismo fichero", SYSTEM_BODY_FILE_BY_PART.eyeLeft === SYSTEM_BODY_FILE_BY_PART.eyeRight);
  ok("lod 0 no lleva sufijo", systemBodyFile("head", 0) === "avatar_head.llm");
  ok("lod 3 lleva sufijo _3", systemBodyFile("head", 3) === "avatar_head_3.llm");
  ok("lod fuera de rango se recorta", systemBodyFile("head", 99) === "avatar_head_4.llm" && systemBodyFile("head", -5) === "avatar_head.llm");
  ok("pieza desconocida devuelve null", systemBodyFile("nope", 0) === null);
  ok("la url sale del espejo", assetUrl("avatar_head.llm").endsWith("/character/avatar_head.llm"));
  ok("el espejo local es relativo a la pagina", LOCAL_MIRROR === "character/");
  ok("assetUrl acepta el espejo local", assetUrl("avatar_head.llm", { base: LOCAL_MIRROR }) === "character/avatar_head.llm");

  clearCharacterCache();
  const asked = [];
  const provider = async (file) => { asked.push(file); return new Uint8Array([1, 2, 3, file.length]); };
  const files = await fetchSystemBodyFiles({ provider, lod: 0 });
  ok("se piden las ocho piezas", Object.keys(files).length === 8, Object.keys(files).length);
  ok("el ojo solo se pide una vez", asked.filter((f) => f === "avatar_eye.llm").length === 1, asked.filter((f) => f === "avatar_eye.llm").length);
  ok("cada pieza son bytes", files.head instanceof Uint8Array && files.head.length === 4, files.head.length);
  ok("la respuesta queda cacheada", cachedCharacterFile("avatar_head.llm") === files.head);
  clearCharacterCache();
  ok("la caché se puede vaciar", cachedCharacterFile("avatar_head.llm") === null);

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "characterAssets selftest: all " + checks.length + " checks passed"
      : "characterAssets selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
