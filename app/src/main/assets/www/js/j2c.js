// Second Life textures are JPEG2000 (raw J2C codestreams), which no browser can
// decode natively. We ship OpenJPEG compiled to wasm (vendor/openjpeg/) and load
// it lazily the first time a texture arrives, so the start-up cost is only paid
// by people who actually connect to the grid.
//
// Decoding runs in a worker (j2c-worker.js) because it takes tens to hundreds of
// milliseconds per texture on a phone and would otherwise stall the render loop.
// If the worker cannot start — or the device refuses to transfer an ImageBitmap
// — the exact same decoder runs on the main thread instead, so a texture always
// ends up on screen.
//
// The vendored file is the emscripten glue from @cornerstonejs/codec-openjpeg
// 1.2.2 (MIT), decode-only build: it defines a global `OpenJPEGWASM(moduleConfig)`
// that returns a promise for the wasm module, which exposes `J2KDecoder`
// (getEncodedBuffer/getDecodedBuffer/decode/getFrameInfo) through embind.
// Rebuild/refresh note: vendor/openjpeg/openjpegwasm_decode.{js,wasm} are copied
// verbatim from https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-openjpeg@1.2.2/dist/.
const GLUE = "../vendor/openjpeg/openjpegwasm_decode.js";
const WASM = "../vendor/openjpeg/openjpegwasm_decode.wasm";

let modulePromise = null;
let warned = null;
let loaded = false;
let worker = null;
let workerBroken = false;
let workerReady = null;
let workerSeq = 0;
const workerPending = new Map();

/** Default cap for a decoded texture. Bigger than this is memory and GPU time
 * thrown away: a 1024px texture on a phone screen is indistinguishable from a
 * 512px one at everything but arm's length. */
export let textureMaxSize = 512;

export function setTextureMaxSize(px) {
  textureMaxSize = Math.max(64, Math.min(2048, px | 0));
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("no se pudo cargar " + url));
    document.head.appendChild(s);
  });
}

async function loadModule() {
  if (loaded && window.OpenJPEGWASM) return window.OpenJPEGWASM;
  const glueUrl = new URL(GLUE, import.meta.url).href;
  const wasmUrl = new URL(WASM, import.meta.url).href;
  await loadScript(glueUrl);
  const factory = typeof globalThis !== "undefined" ? globalThis.OpenJPEGWASM : null;
  if (typeof factory !== "function") throw new Error("OpenJPEGWASM no quedó definido");
  // The glue resolves to the emscripten Module (J2KDecoder lives there).
  const mod = await factory({ locateFile: (p) => (p.endsWith(".wasm") ? wasmUrl : p) });
  loaded = true;
  return mod;
}

function getModule() {
  if (!modulePromise) {
    modulePromise = loadModule().catch((e) => {
      modulePromise = null;
      throw e;
    });
  }
  return modulePromise;
}

/** Starts the decode worker; resolves to false (and stays off) if it can't. */
function startWorker() {
  if (workerReady) return workerReady;
  if (workerBroken) return Promise.resolve(false);
  workerReady = new Promise((resolve) => {
    const fail = (e) => {
      workerBroken = true;
      worker = null;
      report(e);
      resolve(false);
    };
    const source = new URL("./j2c-worker.js", import.meta.url).href;
    const glueUrl = new URL(GLUE, import.meta.url).href;
    const wasmUrl = new URL(WASM, import.meta.url).href;
    // The worker is bootstrapped from a Blob: `new Worker(url)` requires the
    // script to be same-origin as the page, and the viewer's own files can be
    // served from another origin (the editor preview does exactly that), while a
    // blob URL always inherits the page's origin. Fetching the source first also
    // means a load failure is a normal promise rejection instead of a silent
    // dead worker. The OpenJPEG glue travels the same way: `importScripts` can
    // only load same-origin (or CORS-enabled) scripts, and passing the source in
    // removes that requirement entirely.
    Promise.all([fetch(source), fetch(glueUrl), fetch(wasmUrl)])
      .then(([workerRes, glueRes, wasmRes]) => {
        if (!workerRes.ok) throw new Error("no se pudo leer el worker: HTTP " + workerRes.status);
        if (!glueRes.ok) throw new Error("no se pudo leer el decodificador: HTTP " + glueRes.status);
        if (!wasmRes.ok) throw new Error("no se pudo leer el wasm: HTTP " + wasmRes.status);
        return Promise.all([workerRes.text(), glueRes.text(), wasmRes.arrayBuffer()]);
      })
      .then(([text, glueText, wasmBinary]) => {
        const w = new Worker(URL.createObjectURL(new Blob([text], { type: "text/javascript" })));
        worker = w;
        let settled = false;
        w.onerror = (e) => { if (!settled) { settled = true; fail(new Error((e && e.message) || "error en el worker de texturas")); } };
        w.onmessage = (ev) => {
          const msg = ev.data || {};
          if (msg.kind === "ready") {
            if (settled) return;
            settled = true;
            if (msg.ok) { loaded = true; resolve(true); } else fail(new Error(msg.error || "el worker no arrancó"));
            return;
          }
          const pending = workerPending.get(msg.id);
          if (!pending) return;
          workerPending.delete(msg.id);
          if (msg.ok) pending.resolve(msg.bitmap);
          else pending.reject(new Error(msg.error || "fallo al decodificar"));
        };
        w.postMessage({ kind: "init", id: 0, glueUrl, wasmUrl, glueText, wasmBinary }, [wasmBinary]);
      })
      .catch(fail);
  });
  return workerReady;
}

function decoderReady() {
  return workerBroken ? getModule() : startWorker().then((ok) => (ok ? null : getModule()));
}

/** Decodes through the worker; rejects if the worker is not available. */
function decodeInWorker(bytes, maxSize) {
  return new Promise((resolve, reject) => {
    if (!worker || workerBroken) { reject(new Error("sin worker")); return; }
    const id = ++workerSeq;
    workerPending.set(id, { resolve, reject });
    // The codestream is copied before transfer: the caller keeps using its own
    // buffer (it writes the texture to the on-device cache right afterwards), and
    // the copy costs nothing next to the decode itself.
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    try {
      worker.postMessage({ kind: "decode", id, bytes: owned, maxSize }, [owned.buffer]);
    } catch (e) {
      workerPending.delete(id);
      reject(e);
    }
  });
}

function toRgba(decoded, width, height, components) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (components === 1) {
    for (let i = 0, o = 0; i < width * height; i++, o += 4) {
      const v = decoded[i];
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    }
  } else if (components >= 4) {
    for (let i = 0, s = 0, o = 0; i < width * height; i++, s += components, o += 4) {
      rgba[o] = decoded[s]; rgba[o + 1] = decoded[s + 1]; rgba[o + 2] = decoded[s + 2]; rgba[o + 3] = decoded[s + 3];
    }
  } else {
    for (let i = 0, s = 0, o = 0; i < width * height; i++, s += components, o += 4) {
      rgba[o] = decoded[s]; rgba[o + 1] = decoded[s + 1]; rgba[o + 2] = decoded[s + 2]; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/**
 * Decodes a JPEG2000 codestream (J2C/J2K) or a JP2 file into an ImageBitmap,
 * never larger than `maxSize` in its largest dimension (default 512 px, which is
 * what the render profiles ask for on a phone).
 */
export async function decodeJ2C(bytes, maxSize) {
  const limit = maxSize || textureMaxSize;
  const ready = await decoderReady();
  if (!workerBroken && worker) {
    try {
      return await decodeInWorker(bytes, limit);
    } catch (e) {
      report(e);
    }
  }
  const mod = ready || (await getModule());
  const decoder = new mod.J2KDecoder();
  const encoded = decoder.getEncodedBuffer(bytes.length);
  encoded.set(bytes);
  decoder.decode();
  const info = decoder.getFrameInfo ? decoder.getFrameInfo() : {};
  const width = info.width || 0;
  const height = info.height || 0;
  if (!width || !height) throw new Error("imagen vacía");
  const decoded = decoder.getDecodedBuffer();
  const components = info.componentCount || (decoded.length === width * height * 3 ? 3 :
    decoded.length === width * height ? 1 : 4);
  const rgba = toRgba(decoded, width, height, components);
  const image = new ImageData(rgba, width, height);
  const biggest = Math.max(width, height);
  if (limit && biggest > limit) {
    const k = limit / biggest;
    return createImageBitmap(image, {
      resizeWidth: Math.max(1, Math.round(width * k)),
      resizeHeight: Math.max(1, Math.round(height * k)),
      resizeQuality: "medium",
    });
  }
  return createImageBitmap(image);
}

/** The emscripten module itself (diagnostics / tests). */
export async function decoderModule() {
  return getModule();
}

/** True once the wasm decoder loaded; false while it is still failing. */
export function jpeg2000Available() {
  return loaded;
}

/** Warm the decoder up in the background (optional; decodeJ2C loads it anyway). */
export async function warmUp() {
  try {
    await decoderReady();
    return true;
  } catch (e) {
    report(e);
    return false;
  }
}

/** Whether decoding is running off the main thread (shown in the diagnostics). */
export function decodingInWorker() {
  return !!worker && !workerBroken;
}

// One line per session is enough: the HUD log is small and the failure is not
// fatal (textures fall back to a flat colour).
export function report(err) {
  if (warned) return;
  warned = String((err && err.message) || err);
  console.warn("[visor] decodificador JPEG2000 no disponible: " + warned);
}
