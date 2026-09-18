// build-viewer.mjs -- mete el visor web dentro de los assets de la app Android.
//
// El visor es el MISMO codigo que corre en perchance: la pagina `index.html` y
// los modulos de `src/**`. La app los sirve desde sus propios assets (los lee
// `ViewerServer.kt` y los entrega por http://127.0.0.1:PUERTO). Este script
// hace lo que separa "el visor de perchance" de "el visor de la app":
//
//   1. Copia al arbol de assets `index.html`, `env.js` y `src/**` (TODOS los
//      modulos, incluidos los que se anadan mas adelante: no hay lista fija).
//   2. Quita del index.html el bloque `<script type="text/x-server-plugin">`:
//      ese bloque es codigo de servidor de perchance y aqui no existe.
//   3. Inserta `<script src="env.js"></script>` justo antes del modulo
//      principal, para que `window.root` (kv, superFetch, el enlace interno)
//      este listo cuando arranque `src/app.js`.
//   4. Le pone el envoltorio `<html><head>...` que en perchance pone la
//      plataforma (el index.html del proyecto es solo el cuerpo).
//
// Origen del visor: si existe una carpeta `viewer/` con su propio index.html se
// usa esa; si no, se usa la raiz del repositorio (`index.html`, `env.js`,
// `src/**`), que es como lo deja `prepare-repo.mjs`. Asi nunca hay una copia
// duplicada y desactualizada del visor: se compila siempre el codigo actual.
//
// Uso, desde la raiz del repositorio:
//
//     node build-viewer.mjs
//
// No hace falta npm ni instalar nada: solo los modulos `node:fs`/`node:path`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, "app", "src", "main", "assets", "viewer");

function fail(msg) {
  console.error("ERROR: " + msg);
  process.exit(1);
}

// --- de donde sale el visor ---------------------------------------------------
const packedDir = path.join(ROOT, "viewer");
const packed = fs.existsSync(path.join(packedDir, "index.html"));
const SRC = packed ? packedDir : ROOT;

if (!fs.existsSync(path.join(SRC, "index.html"))) {
  fail("no encuentro index.html en " + SRC + ". ¿Falta el visor en el repositorio?");
}
if (!fs.existsSync(path.join(SRC, "src", "app.js"))) {
  fail("no encuentro src/app.js en " + SRC + ". ¿Falta el codigo del visor?");
}

const ENV_SRC = fs.existsSync(path.join(SRC, "env.js"))
  ? path.join(SRC, "env.js")
  : path.join(ROOT, "env.js");
if (!fs.existsSync(ENV_SRC)) fail("no encuentro env.js (ni en " + SRC + " ni en la raiz).");

// --- 1. copia del arbol completo ---------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

fs.copyFileSync(path.join(SRC, "index.html"), path.join(OUT, "index.html"));
fs.copyFileSync(ENV_SRC, path.join(OUT, "env.js"));

// `src/**` entero, salvo la propia carpeta de la app Android (que en la raiz
// del proyecto perchance vive dentro de `src/`, pero no es codigo del visor).
fs.cpSync(path.join(SRC, "src"), path.join(OUT, "src"), {
  recursive: true,
  filter: (p) => path.basename(p) !== "android" && !p.split(path.sep).includes("android"),
});
console.log("copiado  " + (packed ? "viewer/" : "index.html + env.js + src/**") + " -> app/src/main/assets/viewer/");

// --- 2 y 3. parcheo del index.html ya copiado --------------------------------
const indexPath = path.join(OUT, "index.html");
let html = fs.readFileSync(indexPath, "utf8");

const before = html.length;
html = html.replace(/<script\s+type="text\/x-server-plugin">[\s\S]*?<\/script>\s*/i, "");
if (html.length === before) {
  console.warn("aviso: no habia bloque server-plugin en el index.html (¿ya estaba quitado?)");
}

const MODULE_TAG = '<script type="module" src="src/app.js"></script>';
if (!html.includes(MODULE_TAG)) {
  fail("el index.html no contiene el modulo principal " + MODULE_TAG);
}
html = html.replace(MODULE_TAG, '<script src="env.js"></script>\n' + MODULE_TAG);

// --- 4. envoltorio -----------------------------------------------------------
// El index.html del proyecto es solo el CUERPO de la pagina (en perchance el
// envoltorio lo pone la plataforma). En la app no hay plataforma: se le pone el
// envoltorio aqui. El <meta viewport> es imprescindible: sin el, el WebView
// asume una pagina de 980px y el visor sale diminuto en el movil.
const HEAD =
  '<!doctype html>\n<html lang="es">\n<head>\n' +
  '<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1, ' +
  'maximum-scale=1, user-scalable=no, viewport-fit=cover">\n' +
  '<meta name="color-scheme" content="dark">\n' +
  '<title>Visor SL</title>\n' +
  '</head>\n<body>\n';
html = HEAD + html + '\n</body>\n</html>\n';

fs.writeFileSync(indexPath, html, "utf8");
console.log("parcheado app/src/main/assets/viewer/index.html (" + html.length + " bytes)");

// --- recuento ----------------------------------------------------------------
function count(dir) {
  let n = 0;
  let bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = count(p); n += r.n; bytes += r.bytes; }
    else { n++; bytes += fs.statSync(p).size; }
  }
  return { n, bytes };
}
const total = count(OUT);
console.log("listo: " + total.n + " archivos, " + (total.bytes / 1024).toFixed(1) + " KiB en assets/viewer/");
