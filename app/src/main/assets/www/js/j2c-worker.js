// JPEG2000 decoding, off the main thread.
//
// OpenJPEG compiled to wasm takes tens to hundreds of milliseconds per Second
// Life texture on a phone. Doing that on the main thread stalls the render loop
// for the whole decode, which is the difference between a texture popping in and
// the whole world hitching. This worker keeps the same decoder but runs it in
// its own thread and hands back a ready-to-upload ImageBitmap.
//
// It is a CLASSIC worker on purpose: the vendored OpenJPEG glue is a classic
// script that defines a global, so `importScripts` is the only way to load it.
// The viewer falls back to decoding on the main thread if this worker cannot be
// created, so nothing here is load-bearing for correctness.
/* eslint-env worker */

let modulePromise = null;
let ready = false;

function loadModule(glueUrl, wasmUrl, glueText, wasmBinary) {
  if (modulePromise) return modulePromise;
  modulePromise = new Promise((resolve, reject) => {
    try {
      if (glueText) {
        // The glue is evaluated in the worker's global scope. Passing the source
        // in avoids `importScripts` on a cross-origin URL (a worker may only
        // importScripts same-origin or CORS-enabled scripts), which is what the
        // editor preview needs and what a same-origin app does not care about.
        (0, eval)(glueText);
      } else {
        importScripts(glueUrl);
      }
    } catch (e) {
      reject(new Error("no se pudo cargar el decodificador: " + ((e && e.message) || e)));
      return;
    }
    const factory = self.OpenJPEGWASM;
    if (typeof factory !== "function") {
      reject(new Error("OpenJPEGWASM no quedó definido en el worker"));
      return;
    }
    // The wasm binary is handed over ready-made (fetched by the page): the worker
    // then needs no network at all, which is the only way this works when the
    // viewer's files are served from a different origin than the page.
    const config = { locateFile: (p) => (String(p).endsWith(".wasm") ? wasmUrl : p) };
    if (wasmBinary && wasmBinary.byteLength) config.wasmBinary = wasmBinary;
    factory(config).then((mod) => { ready = true; resolve(mod); }, reject);
  });
  return modulePromise;
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

async function decode(bytes, maxSize) {
  const mod = await modulePromise;
  const decoder = new mod.J2KDecoder();
  const encoded = decoder.getEncodedBuffer(bytes.length);
  encoded.set(bytes);
  decoder.decode();
  const info = (decoder.getFrameInfo && decoder.getFrameInfo()) || {};
  const width = info.width || 0;
  const height = info.height || 0;
  if (!width || !height) throw new Error("imagen vacía");
  const decoded = decoder.getDecodedBuffer();
  const components = info.componentCount ||
    (decoded.length === width * height * 3 ? 3 : decoded.length === width * height ? 1 : 4);
  const rgba = toRgba(decoded, width, height, components);
  const image = new ImageData(rgba, width, height);
  const limit = maxSize || 0;
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

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.kind === "init") {
    try {
      await loadModule(msg.glueUrl, msg.wasmUrl, msg.glueText, msg.wasmBinary);
      self.postMessage({ kind: "ready", id: msg.id, ok: true });
    } catch (e) {
      self.postMessage({ kind: "ready", id: msg.id, ok: false, error: (e && e.message) || String(e) });
    }
    return;
  }
  if (msg.kind !== "decode") return;
  try {
    const bitmap = await decode(msg.bytes, msg.maxSize);
    self.postMessage({ kind: "decode", id: msg.id, ok: true, bitmap, width: bitmap.width, height: bitmap.height }, [bitmap]);
  } catch (e) {
    self.postMessage({ kind: "decode", id: msg.id, ok: false, error: (e && e.message) || String(e) });
  }
};
