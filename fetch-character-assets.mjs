// fetch-character-assets.mjs -- mete EL MODELO en la app.
//
// POR QUE
// Para que un avatar se deforme "como en Second Life" hacen falta las MALLAS
// REALES del cuerpo de sistema (`avatar_head.llm`, `avatar_upper_body.llm`...)
// y sus texturas base. No son un modelo inventado: son los ficheros del visor
// oficial de Linden Lab, que se distribuye como codigo abierto (LGPL 2.1). El
// visor de `src/` los pide por red en tiempo de ejecucion (`characterAssets.js`)
// y por eso mismo funciona en perchance, donde no se puede empaquetar nada.
//
// Dentro del APK no queremos depender de la red: este script descarga esos
// ficheros AL COMPILAR y los deja en `app/src/main/assets/viewer/character/`.
// Asi el movil lleva el modelo dentro, la deformacion (forma, morphs de Bento,
// pesos de hueso) funciona SIN conexion, y `characterAssets.js` los usa
// directamente (espejo local "character/").
//
// LOS FICHEROS NO SE SUBEN AL REPOSITORIO: se descargan en cada compilacion
// (la carpeta `app/src/main/assets/viewer/` esta en .gitignore). El repositorio
// solo guarda este script, la receta de que descargar.
//
// Uso, desde la raiz del repositorio (despues de `node build-viewer.mjs`):
//
//     node fetch-character-assets.mjs
//     node fetch-character-assets.mjs --strict   # falla si algo no baja
//     node fetch-character-assets.mjs --force    # vuelve a bajarlo todo
//
// No hace falta npm: solo `node:fs`/`node:path` y el `fetch` global de Node 18+.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, "app", "src", "main", "assets", "viewer", "character");

const argv = process.argv.slice(2);
const STRICT = argv.includes("--strict");
const FORCE = argv.includes("--force");
const BASE = (argv.find((a) => a.startsWith("--base=")) || "").slice(7)
  || "https://raw.githubusercontent.com/secondlife/viewer/main/indra/newview/character/";

// --- que hace falta -----------------------------------------------------------
// Las ocho piezas del cuerpo de sistema, en los cinco niveles de detalle. Los
// nombres y la tabla son los MISMOS que en `src/sl/characterAssets.js`: si
// cambian alli, cambian aqui.
const SYSTEM_BODY_FILES = [
  "avatar_head.llm",
  "avatar_eyelashes.llm",
  "avatar_upper_body.llm",
  "avatar_lower_body.llm",
  "avatar_skirt.llm",
  "avatar_hair.llm",
  "avatar_eye.llm",
];
const LOD_COUNT = 5;

// Texturas base de la piel, el pelo, los ojos y el maquillaje. Misma lista que
// `SYSTEM_TEXTURE_FILES` + `MAKEUP_TEXTURE_FILES` de `characterAssets.js`.
const TEXTURE_FILES = [
  "head_skingrain.tga", "body_skingrain.tga",
  "head_color.tga", "upperbody_color.tga", "lowerbody_color.tga",
  "head_shading_alpha.tga", "head_highlights_alpha.tga",
  "upperbody_shading_alpha.tga", "upperbody_highlights_alpha.tga",
  "lowerbody_shading_alpha.tga", "lowerbody_highlights_alpha.tga",
  "rosyface_alpha.tga", "lips_mask.tga", "eyebrows_alpha.tga",
  "head_hair.tga", "eyewhite.tga",
  "lipstick_alpha.tga", "eyeliner_alpha.tga",
  "eyeshadow_outer_alpha.tga", "eyeshadow_inner_alpha.tga",
];

function lodFile(base, lod) {
  return lod === 0 ? base : base.replace(/\.llm$/, "_" + lod + ".llm");
}

const FILES = [];
for (const base of SYSTEM_BODY_FILES) for (let l = 0; l < LOD_COUNT; l++) FILES.push(lodFile(base, l));
for (const t of TEXTURE_FILES) FILES.push(t);

// --- descarga con reintentos y un poco de paralelismo -------------------------
const CONCURRENCY = 6;
const RETRIES = 3;

function joinUrl(base, file) {
  return base.replace(/\/?$/, "/") + file;
}

function human(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KiB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
}

async function download(file) {
  const dest = path.join(OUT, file);
  if (!FORCE && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return { file, bytes: fs.statSync(dest).size, skipped: true };
  }
  const url = joinUrl(BASE, file);
  let lastError = null;
  for (let intento = 1; intento <= RETRIES; intento++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status + " en " + url);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("respuesta vacia en " + url);
      fs.writeFileSync(dest, buf);
      return { file, bytes: buf.length, skipped: false };
    } catch (e) {
      lastError = e;
      if (intento < RETRIES) await new Promise((r) => setTimeout(r, 400 * intento));
    }
  }
  return { file, error: lastError ? (lastError.message || String(lastError)) : "error" };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log("descargando el modelo del avatar de " + BASE);
  console.log("destino: app/src/main/assets/viewer/character/  (" + FILES.length + " ficheros)");

  const results = new Array(FILES.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < FILES.length) {
      const i = next++;
      results[i] = await download(FILES[i]);
      done++;
      const r = results[i];
      if (r.error) console.warn("  [" + done + "/" + FILES.length + "] FALLO  " + r.file + "  (" + r.error + ")");
      else if (done % 10 === 0 || !r.skipped) console.log("  [" + done + "/" + FILES.length + "] " + (r.skipped ? "ya estaba " : "bajado     ") + r.file + "  " + human(r.bytes));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const totalBytes = ok.reduce((n, r) => n + (r.bytes || 0), 0);
  console.log("modelo: " + ok.length + "/" + FILES.length + " ficheros, " + human(totalBytes));

  if (failed.length) {
    console.warn("no se pudieron bajar " + failed.length + " ficheros:");
    for (const f of failed) console.warn("  - " + f.file + ": " + f.error);
    console.warn("El visor seguira funcionando: pedira esos ficheros por red en tiempo de ejecucion.");
    if (STRICT) process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR: " + (e && e.message ? e.message : e));
  if (STRICT) process.exit(1);
});
