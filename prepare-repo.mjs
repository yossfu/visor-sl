// prepare-repo.mjs -- arma la carpeta lista para subir a GitHub y compilar el APK.
//
// Este script vive en el proyecto perchance (`src/android/`), donde el visor y
// la app Android estan mezclados: el visor en la raiz (`index.html`, `src/**`)
// y la app Android en `src/android/`. GitHub, en cambio, necesita UN repositorio
// con una sola raiz. Este script junta las dos cosas en una carpeta:
//
//     visor-sl-app/
//       index.html            <- copia del visor (cuerpo de la pagina)
//       env.js                <- la capa de plataforma para Android
//       src/**                <- todos los modulos del visor
//       app/**                <- la app Android (Kotlin)
//       build-viewer.mjs      <- lo que ejecuta GitHub Actions antes de compilar
//       build.gradle.kts, settings.gradle.kts, gradle.properties, gradlew*
//       gradle/wrapper/**
//       .github/workflows/build-apk.yml
//       .gitignore
//       README.md
//
// El script NO duplica nada a mano: copia lo que hay AHORA MISMO en el proyecto,
// asi que la carpeta generada siempre lleva el visor actual (con los modulos
// nuevos incluidos, `src/**` se copia entero).
//
// Uso, desde `src/android/`:
//
//     node prepare-repo.mjs                 -> escribe en ./visor-sl-app
//     node prepare-repo.mjs /ruta/destino   -> escribe donde le digas
//
// Solo usa `node:fs`/`node:path`: no hace falta npm.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));         // .../src/android
const PROJECT = path.resolve(HERE, "..", "..");                    // raiz del proyecto perchance
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, "visor-sl-app");

console.log("proyecto: " + PROJECT);
console.log("destino:  " + OUT);

if (!fs.existsSync(path.join(PROJECT, "index.html"))) {
  console.error("ERROR: no encuentro el visor en " + PROJECT + " (¿es la raiz del proyecto?)");
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// --- 1. el visor -------------------------------------------------------------
fs.copyFileSync(path.join(PROJECT, "index.html"), path.join(OUT, "index.html"));

// `src/**` entero menos `src/android` (que es esta app, no codigo del visor) y
// menos los mapas de assets generados.
fs.cpSync(path.join(PROJECT, "src"), path.join(OUT, "src"), {
  recursive: true,
  filter: (p) => {
    const parts = p.split(path.sep);
    if (parts.includes("android")) return false;
    if (parts[parts.length - 1] === "visor-sl-app") return false;
    return true;
  },
});
console.log("copiado  visor (index.html + src/**)");

// El README del visor va aparte, para que la raiz tenga el de la app.
copyDoc("README.md", "README-VISOR.md");
copyDoc("SPEC.md", "SPEC-VISOR.md");
copyDoc("ANDROID.md", "ANDROID.md");
copyDoc("VIEWER-REAL.md", "VIEWER-REAL.md");
copyDoc("DIAGNOSTICS.md", "DIAGNOSTICS.md");

function copyDoc(from, dest) {
  const p = path.join(PROJECT, "src", from);
  if (!fs.existsSync(p)) return;
  fs.writeFileSync(path.join(OUT, dest), fs.readFileSync(p));
}

// --- 2. la app Android -------------------------------------------------------
function copyFile(name, dest) {
  const from = path.join(HERE, name);
  if (!fs.existsSync(from)) { console.warn("aviso: falta " + name + " (se omite)"); return; }
  const to = path.join(OUT, dest || name);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

for (const f of [
  "build-viewer.mjs", "fetch-character-assets.mjs", "build.gradle.kts", "settings.gradle.kts", "gradle.properties",
  "gradlew", "gradlew.bat", "env.js",
]) copyFile(f);

// Grafo de Gradle (el jar incluido).
fs.cpSync(path.join(HERE, "gradle"), path.join(OUT, "gradle"), { recursive: true });

// El modulo Android, sin lo generado.
fs.cpSync(path.join(HERE, "app"), path.join(OUT, "app"), {
  recursive: true,
  filter: (p) => {
    const parts = p.split(path.sep);
    if (parts.includes("build")) return false;
    return true;
  },
});

// Nombres que no pueden empezar por punto dentro de `src/` del proyecto.
copyFile("gitignore.txt", ".gitignore");
copyFile("workflow-build-apk.yml", path.join(".github", "workflows", "build-apk.yml"));
copyFile("README.md", "README.md");

// Los scripts con `+x` (por si el usuario los ejecuta en Linux/macOS).
for (const s of ["gradlew", "build-viewer.mjs", "prepare-repo.mjs"]) {
  const p = path.join(OUT, s);
  try { if (fs.existsSync(p)) fs.chmodSync(p, 0o755); } catch (e) { /* en Windows da igual */ }
}

// --- 3. recuento -------------------------------------------------------------
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
console.log("listo: " + total.n + " archivos, " + (total.bytes / 1024 / 1024).toFixed(1) + " MiB en " + OUT);
console.log("sube ESA carpeta a GitHub como repositorio; Actions compila el APK.");
