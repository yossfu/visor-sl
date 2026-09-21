// Loader for the avatar assets that ship inside the app (src/web/data/avatar).
//
// The three `.llm` meshes are ~3 MB raw (the head alone is 1.6 MB of morph
// data), so they travel gzipped (~1.6 MB together). Nothing here touches the
// network: these files are part of the APK, which is why the viewer can show a
// real avatar even before a single texture arrives from the grid.
//
// Two things in here were learned the hard way, on a real phone:
//
//  * The files are gzipped but they are NOT named `*.gz`. The WebView's asset
//    server answered **404 for every `.gz` asset** while the plain file in the
//    very same folder (`j2c-sample.bin`) loaded fine, so the extension itself
//    was the only difference left. Under a neutral name the bytes arrive
//    untouched and this loader decides what they are by looking at them: a gzip
//    header (1f 8b) means "inflate me", anything else is used as it came.
//  * If the asset server refuses a name anyway, the same file is read through
//    the native bridge (`assets.open`), which never goes through the WebView.
//    Which path worked is recorded, because a report from the phone has to be
//    able to distinguish "the file is not inside the APK" from "the WebView
//    would not serve it" — two problems with completely different fixes.
import { assetGet } from "../transport.js";

const DIR = new URL("../../data/avatar/", import.meta.url);

const cache = new Map();

/** Where the assets are actually coming from — read by the diagnostics panel. */
export const assetReport = { viaHttp: 0, viaNative: 0, failures: [] };

function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzip(buffer) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("este navegador no puede descomprimir gzip (DecompressionStream)");
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** "https://<host>/www/data/avatar/x.bin" -> "data/avatar/x.bin" (asset path). */
function assetPathOf(url) {
  const i = url.indexOf("/www/");
  return i >= 0 ? url.slice(i + "/www/".length) : null;
}

/** The bytes of one asset, through the asset server or (falling back) the bridge. */
async function readAsset(url) {
  let httpError = "";
  try {
    const res = await fetch(url);
    if (res.ok) {
      assetReport.viaHttp++;
      return new Uint8Array(await res.arrayBuffer());
    }
    httpError = `HTTP ${res.status}`;
  } catch (e) {
    httpError = (e && e.message) || String(e);
  }
  const rel = assetPathOf(url);
  if (rel) {
    const bytes = await assetGet(rel);
    if (bytes && bytes.length) {
      assetReport.viaNative++;
      return bytes;
    }
  }
  throw new Error(`${url} → ${httpError || "no se pudo leer"}`);
}

function get(name) {
  const hit = cache.get(name);
  if (hit) return hit;
  const p = load(name);
  // A failed download must not be cached: the next avatar build should retry.
  p.catch(() => cache.delete(name));
  cache.set(name, p);
  return p;
}

async function load(name) {
  const url = name instanceof URL ? name.href : new URL(name, DIR).href;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await readAsset(url);
      return isGzip(raw) ? await gunzip(raw) : raw;
    } catch (e) {
      lastErr = e;
      // A single failed read is not proof the asset is broken: the WebView's
      // asset server can hiccup while the app is still warming up, and one
      // retry turns "every resident is a capsule" into a non-event. The retries
      // live inside this shared promise, so twenty avatars arriving at once
      // still produce one fetch chain per file, not twenty.
      if (attempt < 3) await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  const text = (lastErr && lastErr.message) || String(lastErr);
  if (assetReport.failures.length < 8 && !assetReport.failures.includes(text)) assetReport.failures.push(text);
  throw lastErr;
}

/** Raw (gunzipped) bytes of an asset that lives next to this module. */
export function loadBytes(name) { return get(name); }

/** The same, decoded as text (used by the skeleton/mesh XML files). */
export async function loadText(name) {
  return new TextDecoder().decode(await get(name));
}

/** One line for the log: which path the assets came through, and any failure. */
export function assetTransportReport() {
  const parts = [`por la red interna ${assetReport.viaHttp}`, `por el puente nativo ${assetReport.viaNative}`];
  if (assetReport.failures.length) parts.push("fallos: " + assetReport.failures.slice(0, 3).join(" | "));
  return parts.join(" · ");
}
