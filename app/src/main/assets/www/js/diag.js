// On-device diagnosis.
//
// Everything that can silently fail on a phone is checked here and shown as
// plain text the user can read off the screen or copy in one tap: the GPU the
// WebView really got, whether the browser features the pipeline depends on
// exist, whether every bundled avatar asset loads *and* un-gzips, whether the
// JPEG2000 decoder works, and what the texture/terrain/avatar stages have
// actually done since the session started.
//
// The point is that "no se ven texturas" has half a dozen very different causes
// — the texture never arrived, it arrived but would not decode, the GPU fell
// back to software, the avatar meshes never loaded — and from the screen alone
// they all look identical. This module turns that into a sentence per stage.
import { platformInfo, hasNative, storageInfo, netInfo, assetsList } from "./transport.js";
import { isMobile } from "./perf.js";
import { loadBytes, assetTransportReport } from "./avatar/assets.js";
import { CACHE_REV, cacheMode, verifyCache } from "./cache.js";

const AVATAR_ASSETS = [
  "avatar_lad.xml.bin",
  "avatar_skeleton.xml.bin",
  "avatar_head.llm.bin",
  "avatar_upper_body.llm.bin",
  "avatar_lower_body.llm.bin",
  "avatar_eye.llm.bin",
  "avatar_eyelashes.llm.bin",
  "anims.bin",
];

const rows = [];
function row(name, ok, detail) {
  rows.push({ name, ok: ok === null ? "info" : ok, detail: detail == null ? "" : String(detail) });
  return ok;
}

function hasFeature(name) {
  switch (name) {
    case "DecompressionStream": return typeof DecompressionStream === "function";
    case "createImageBitmap": return typeof createImageBitmap === "function";
    case "OffscreenCanvas": return typeof OffscreenCanvas === "function";
    case "Worker": return typeof Worker === "function";
    case "WebAssembly": return typeof WebAssembly === "object";
    case "WebGL2": return (() => { try { return !!document.createElement("canvas").getContext("webgl2"); } catch (_) { return false; } })();
    case "ImageBitmapTransfer": return typeof ImageBitmap !== "undefined";
    case "SharedArrayBuffer": return typeof SharedArrayBuffer === "function";
    case "WorkerModule": return (() => {
      try { new Worker("data:text/javascript;base64," + btoa("export default 1"), { type: "module" }).terminate(); return true; }
      catch (_) { return false; }
    })();
    default: return false;
  }
}

/** Everything the page can answer instantly (no network, no loading). */
export function quickReport(app) {
  const out = [];
  const info = platformInfo();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || "";
  out.push(["plataforma", info.platform === "android" ? "Android (app)" : "navegador web"]);
  if (info.platform === "android") {
    out.push(["app", `${info.appVersion || "?"} (build ${info.appBuild || "?"}) · Android SDK ${info.sdk || "?"}`]);
    out.push(["dispositivo", `${info.manufacturer || ""} ${info.model || ""}`.trim()]);
  }
  out.push(["navegador", (chrome ? "Chrome/WebView " + chrome : ua.slice(0, 60))]);
  out.push(["pantalla", `${window.innerWidth}x${window.innerHeight} @${(window.devicePixelRatio || 1).toFixed(2)}x`]);
  out.push(["núcleos / RAM", `${navigator.hardwareConcurrency || "?"} núcleos · ${navigator.deviceMemory || "?"} GB`]);
  if (app && app.viewer && app.viewer.gpu) {
    const g = app.viewer.gpu;
    out.push(["GPU", `${g.renderer || "?"} · ${g.webgl} · máx ${g.maxTexture}px · ${g.extensions} ext.${g.error ? " · " + g.error : ""}`]);
    out.push(["GPU (software)", g.software ? "SÍ — el WebView no usa la GPU" : "no"]);
  }
  const feats = ["WebGL2", "DecompressionStream", "createImageBitmap", "OffscreenCanvas", "Worker", "WorkerModule", "WebAssembly"];
  out.push(["navegador soporta", feats.filter(hasFeature).join(", ")]);
  const missing = feats.filter((f) => !hasFeature(f));
  if (missing.length) out.push(["FALTA en este navegador", missing.join(", ")]);
  if (app && app.viewer && app.viewer.stats) {
    const s = app.viewer.stats;
    out.push(["render", `${s.fps ? s.fps.toFixed(0) : "?"} fps · ${s.drawCalls || 0} llamadas · ${((s.tris || 0) / 1000).toFixed(0)}k triángulos · escala ${(app.viewer.renderScale || 1).toFixed(2)}`]);
    out.push(["memoria GPU", `${s.geometries || 0} geometrías · ${s.textures || 0} texturas · ${s.programs || 0} programas`]);
  }
  if (app && app.world) {
    const w = app.world;
    out.push(["región", `${app.world.objects.size} prims · ${app.world.avatars.size} avatares · visibles ${w.visibleObjects ?? "?"} de ${w.maxObjects} · alcance ${w.drawDistance} m`]);
    out.push(["cuerpos de avatar", w.avatarError
      ? `FALLA: ${w.avatarError}`
      : `${w.avatarsWithBody || 0} de ${w.avatars.size} con cuerpo real (el resto, cápsulas mientras cargan)`]);
    const layerInfo = app.session && app.session.layerMessages
      ? ` · LayerData: ${app.session.layerMessages} mensajes` +
        (app.session.layerTypes ? ` (tipos ${Object.entries(app.session.layerTypes).map(([k, v]) => `${k}×${v}`).join(", ")})` : "")
      : "";
    out.push(["terreno", (!w.terrainMesh
      ? "SIN MALLA (no llegaron parches de terreno)"
      : (w.terrainKnown
        ? `malla real (${w.terrainMesh.geometry.attributes.position.count} vértices) · ${w.terrainTexturesApplied || 0}/4 texturas reales`
        : "PLACEHOLDER PLANO — no ha llegado ningún parche de terreno del sim (el agua se mantiene oculta hasta que llegue)")) + layerInfo]);
  }
  const sess = app && app.session;
  if (sess) {
    out.push(["texturas (grid)", sess.textureReport ? sess.textureReport() : `${sess.stats.textures || 0} ok, ${sess.stats.textureFailures || 0} fallos`]);
    if (sess.textureProblems && sess.textureProblems.length) out.push(["fallos de textura (ejemplos)", sess.textureProblems.join(" | ")]);
    if (sess.lastDecodeError) out.push(["último error de decodificación", sess.lastDecodeError]);
  } else {
    out.push(["texturas (grid)", "sin sesión"]);
  }
  const st = storageInfo();
  if (st && !st.error) {
    out.push(["almacenamiento", st.platform === "web"
      ? "navegador (localStorage/IndexedDB)"
      : `${st.cacheDir || "?"} · caché ${((st.cacheBytes || 0) / 1048576).toFixed(1)} MB en ${st.cacheFiles || 0} archivos · libre ${((st.freeBytes || 0) / 1073741824).toFixed(1)} GB`]);
  }
  const net = netInfo();
  if (net) out.push(["red", `${net.tipo || "?"}${net.validada ? " (validada)" : ""}${net.udpOk === false ? " · UDP no disponible" : ""}`]);
  return out;
}

/** Downloads every bundled avatar asset through the REAL loader (un-gzipped). */
export async function assetCheck() {
  const out = [];
  // First, what the AssetManager itself sees inside the installed APK. This is
  // the difference between "the file is not in the APK" and "the WebView will
  // not serve a file that is there" — and the two need different fixes.
  const listing = assetsList("data/avatar");
  if (listing) {
    const names = listing.names || [];
    out.push(["(APK) carpeta data/avatar", names.length > 0,
      names.length ? `${names.length} archivos: ${names.join(", ")}` : `el APK no tiene «${listing.dir || "data/avatar"}» (o está vacía)`]);
  }
  for (const name of AVATAR_ASSETS) {
    try {
      const bytes = await loadBytes(name);
      out.push([name, bytes && bytes.length > 0, `${(bytes.length / 1024).toFixed(0)} KB listos`]);
    } catch (e) {
      out.push([name, false, (e && e.message) || String(e)]);
    }
  }
  if (hasNative()) out.push(["transporte de los archivos de avatar", true, assetTransportReport()]);
  return out;
}

/**
 * End-to-end check of the JPEG2000 path without needing the grid: a small
 * codestream ships with the app (data/avatar/j2c-sample.bin, four known colour
 * quadrants) and is decoded exactly the way a grid texture will be. A decoder
 * that loads but produces garbage looks identical on screen to one that never
 * loaded, and only comparing the pixels tells them apart.
 */
export async function j2cCheck() {
  let decodeJ2C = null;
  let inWorker = false;
  try {
    const mod = await import("./j2c.js");
    decodeJ2C = mod.decodeJ2C;
    await mod.warmUp();
    inWorker = mod.decodingInWorker();
  } catch (e) {
    return [["decodificador JPEG2000", false, "no se pudo cargar el wasm: " + ((e && e.message) || e)]];
  }
  const out = [["decodificador JPEG2000", true, inWorker ? "wasm cargado y decodificando en un hilo aparte" : "wasm cargado (decodifica en el hilo principal)"]];
  try {
    const res = await fetch(new URL("../data/avatar/j2c-sample.bin", import.meta.url).href);
    if (!res.ok) { out.push(["prueba de decodificación", null, "no hay muestra incluida"]); return out; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const t0 = performance.now();
    const bmp = await decodeJ2C(bytes, 256);
    const ms = performance.now() - t0;
    if (!bmp || !bmp.width) { out.push(["prueba de decodificación", false, "el decodificador devolvió una imagen vacía"]); return out; }
    const probe = pixelProbe(bmp);
    const near = (a, b) => Math.abs(a[0] - b[0]) < 32 && Math.abs(a[1] - b[1]) < 32 && Math.abs(a[2] - b[2]) < 32;
    const ok = bmp.width === 64 && bmp.height === 64 &&
      near(probe.red, [255, 0, 0]) && near(probe.green, [0, 255, 0]) &&
      near(probe.blue, [0, 0, 255]) && near(probe.white, [255, 255, 255]);
    out.push(["prueba de decodificación", ok,
      `${bmp.width}x${bmp.height} en ${ms.toFixed(0)} ms · colores ${ok ? "correctos" : "MAL: " + JSON.stringify(probe)}`]);
  } catch (e) {
    out.push(["prueba de decodificación", false, (e && e.message) || String(e)]);
  }
  return out;
}

/** The four quadrant colours of a decoded sample, on the main thread. */
function pixelProbe(bitmap) {
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const q = (x, y) => Array.from(ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data).slice(0, 3);
  const dx = bitmap.width >> 2, dy = bitmap.height >> 2;
  return {
    red: q(dx, dy),
    green: q(bitmap.width - 1 - dx, dy),
    blue: q(dx, bitmap.height - 1 - dy),
    white: q(bitmap.width - 1 - dx, bitmap.height - 1 - dy),
  };
}

/** Full report: instant checks first, then the ones that need work. */
export async function fullReport(app, opts = {}) {
  rows.length = 0;
  for (const [n, ok, d] of quickReport(app)) row(n, ok === true ? true : null, ok === null ? d : Array.isArray(d) ? d : ok);
  const assets = await assetCheck();
  for (const [name, ok, detail] of assets) row(name, ok, detail);
  const badAssets = assets.filter((a) => a[1] === false && a[0].endsWith(".bin"));
  if (!badAssets.length) row("archivos de avatar", true, `${assets.filter((a) => a[0].endsWith(".bin")).length} cargados y descomprimidos`);
  const cache = await verifyCache();
  row("caché del dispositivo", null, `revisión ${CACHE_REV} · ${cacheMode() === "off" ? "DESACTIVADA (todo se pide al grid)" : "activada"}` +
    (cache && cache.ok ? ` · ${cache.files} archivos, ${((cache.bytes || 0) / 1048576).toFixed(1)} MB` : ""));
  if (cache && cache.ok) {
    const clean = (cache.bad || 0) === 0 && (cache.empty || 0) === 0;
    row("caché: copias inservibles", clean,
      clean ? `ninguna (${cache.good || 0} copias con cabecera válida)`
            : `${cache.bad || 0} sin cabecera de imagen y ${cache.empty || 0} vacías de ${cache.files} · ${(cache.examples || []).join(", ")}`);
  }
  const jp = await j2cCheck();
  for (const [name, ok, detail] of jp) row(name, ok, detail);
  return rows.slice();
}

/** One-line verdict the log panel can print at boot. */
export function summary(list) {
  const bad = list.filter((r) => r.ok === false);
  if (!bad.length) return "Diagnóstico: todo correcto.";
  return `Diagnóstico: ${bad.length} problema(s) — ` + bad.slice(0, 4).map((r) => `${r.name}: ${r.detail}`).join(" · ");
}

/** Failures only — what the boot path logs without being asked. */
export async function bootCheck(app, log) {
  const problem = [];
  const info = platformInfo();
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const chrome = Number((ua.match(/Chrome\/(\d+)/) || [])[1] || 0);
  if (chrome && chrome < 90) problem.push(`El WebView es antiguo (Chrome ${chrome}); actualiza "Android System WebView" en Play Store.`);
  if (!hasFeature("DecompressionStream")) problem.push("Falta DecompressionStream: los archivos del avatar no se podrán descomprimir.");
  if (!hasFeature("WebGL2")) problem.push("No hay WebGL2: el motor 3D no funcionará.");
  if (app && app.viewer && app.viewer.gpu && app.viewer.gpu.software) {
    problem.push(`El WebView está renderizando por SOFTWARE (${app.viewer.gpu.renderer}): todo irá muy lento.`);
  }
  if (hasNative() && isMobile() && app) {
    const r = await assetCheck();
    for (const [name, ok, detail] of r) if (!ok) problem.push(`${name}: ${detail}`);
  }
  if (log) for (const p of problem) log("⚠ " + p);
  return problem;
}
