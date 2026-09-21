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
  const p = (async () => {
    const url = name instanceof URL ? name.href : new URL(name, DIR).href;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return gunzip(await res.arrayBuffer());
  })();
  // A failed download must not be cached: the next avatar build should retry.
  p.catch(() => cache.delete(name));
  cache.set(name, p);
  return p;
}

/** Raw (gunzipped) bytes of an asset that lives next to this module. */
export function loadBytes(name) { return get(name); }

/** The same, decoded as text (used by the skeleton/mesh XML files). */
export async function loadText(name) {
  return new TextDecoder().decode(await get(name));
}
