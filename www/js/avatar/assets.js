// Loader for the avatar assets that ship inside the app (src/web/data/avatar).
//
// The three `.llm` meshes are ~3 MB raw (the head alone is 1.6 MB of morph
// data), so they travel gzipped (~1.6 MB together) and are expanded with the
// browser's own DecompressionStream("gzip") — native in the Android WebView and
// in every desktop browser we target. Nothing here touches the network: these
// files are part of the APK, which is why the viewer can show a real avatar even
// before a single texture arrives from the grid.
const DIR = new URL("../../data/avatar/", import.meta.url);

const cache = new Map();

async function gunzip(buffer) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("este navegador no puede descomprimir gzip (DecompressionStream)");
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      return await gunzip(await res.arrayBuffer());
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
  throw lastErr;
}

/** Raw (gunzipped) bytes of an asset that lives next to this module. */
export function loadBytes(name) { return get(name); }

/** The same, decoded as text (used by the skeleton/mesh XML files). */
export async function loadText(name) {
  return new TextDecoder().decode(await get(name));
}
