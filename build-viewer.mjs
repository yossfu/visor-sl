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

// --- 5. el visor tiene que estar COMPLETO ------------------------------------
// El fallo mas caro (y mas invisible) de todo el montaje: subir al repositorio
// solo PARTE de `src/`. Si falta un modulo cualquiera, el navegador no puede
// cargar el `<script type="module">`, no arranca ni una linea de JavaScript y
// la app se queda para siempre en "Preparando el mundo..." mostrando el HTML de
// escritorio de fondo (barra de navegacion, atajos WASD, el chat suelto).
// El APK compila igual: no hay error de Kotlin ni de Gradle. Solo se ve al
// abrirlo en el movil.
//
// Por eso aqui se recorre el grafo de `import` RELATIVOS de todos los modulos
// copiados y, si alguno apunta a un archivo que no esta, se aborta la
// compilacion con la lista exacta de lo que falta.
function ficherosDe(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) ficherosDe(p, out);
    else out.push(p);
  }
  return out;
}

function modulosQueFaltan() {
  const faltan = new Set();
  for (const f of ficherosDe(OUT, [])) {
    if (!f.endsWith(".js") && !f.endsWith(".mjs")) continue;
    const texto = fs.readFileSync(f, "utf8");
    const specs = [];
    for (const m of texto.matchAll(/\bfrom\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of texto.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) specs.push(m[1]);
    for (const m of texto.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(m[1]);
    for (const s of specs) {
      if (!s.startsWith(".")) continue;                       // esm.sh y demas: no son ficheros
      const destino = path.resolve(path.dirname(f), s);
      if (!fs.existsSync(destino)) {
        faltan.add(path.relative(OUT, destino).split(path.sep).join("/") + "   (lo importa " + path.relative(OUT, f).split(path.sep).join("/") + ")");
      }
    }
  }
  return [...faltan].sort();
}

const rotos = modulosQueFaltan();
if (rotos.length) {
  console.error("");
  console.error("ERROR: el visor esta INCOMPLETO: faltan " + rotos.length + " archivos que otros modulos importan.");
  for (const r of rotos.slice(0, 60)) console.error("   " + r);
  if (rotos.length > 60) console.error("   ... y " + (rotos.length - 60) + " mas");
  console.error("");
  console.error("Esto es lo que deja la app clavada en \"Preparando el mundo...\": sin esos");
  console.error("modulos no se carga el <script type=\"module\"> y no arranca NADA.");
  console.error("Suele significar que en el repositorio no esta la carpeta `src/` entera");
  console.error("(solo algunos archivos sueltos). Sube `src/` COMPLETA y vuelve a lanzar esto.");
  process.exit(1);
}
console.log("grafo de modulos: completo (ningun import relativo apunta a un archivo que falte)");

// --- 6. manifiesto ----------------------------------------------------------
// La lista de los modulos del visor, junto a la pagina. Sirve para que el vigia
// de `env.js` pueda decir EN EL MOVIL que archivos faltan si algun dia la app no
// arranca (en vez de quedarse para siempre en "Preparando el mundo..."): pide
// cada uno de esta lista y canta los que no responden. Las rutas son relativas
// a la raiz de los assets, que es como las pide el visor.
const modulos = ficherosDe(OUT, [])
  .map((p) => path.relative(OUT, p).split(path.sep).join("/"))
  .filter((rel) => rel.endsWith(".js") || rel.endsWith(".mjs"))
  .sort();
fs.writeFileSync(
  path.join(OUT, "manifiesto.json"),
  JSON.stringify({ generado: new Date().toISOString(), total: modulos.length, modulos }, null, 2) + "\n",
  "utf8"
);
console.log("manifiesto.json: " + modulos.length + " modulos listados");

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
