// Second Life textures are JPEG2000 (raw J2C codestreams), which no browser can
// decode natively. We ship OpenJPEG compiled to wasm (vendor/openjpeg/) and load
// it lazily the first time a texture arrives, so the start-up cost is only paid
// by people who actually connect to the grid.
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

/** Decodes a JPEG2000 codestream (J2C/J2K) or a JP2 file into an ImageBitmap. */
export async function decodeJ2C(bytes) {
  const mod = await getModule();
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
  const gray = components === 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * components;
    const o = i * 4;
    if (gray) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = decoded[s];
      rgba[o + 3] = 255;
    } else {
      rgba[o] = decoded[s];
      rgba[o + 1] = decoded[s + 1];
      rgba[o + 2] = decoded[s + 2];
      rgba[o + 3] = components >= 4 ? decoded[s + 3] : 255;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  return createImageBitmap(canvas);
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
    await getModule();
    return true;
  } catch (e) {
    report(e);
    return false;
  }
}

// One line per session is enough: the HUD log is small and the failure is not
// fatal (textures fall back to a flat colour).
export function report(err) {
  if (warned) return;
  warned = String((err && err.message) || err);
  console.warn("[visor] decodificador JPEG2000 no disponible: " + warned);
}
