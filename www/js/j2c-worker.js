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

/**
 * The decoded buffer's real geometry (see the twin of this function in j2c.js:
 * the reported component count and the buffer length have to agree, and a
 * reduced frame has to be detected rather than read as if it were full size).
 */
function frameGeometry(decodedLength, width, height, reported) {
  for (const k of [1, 2, 4, 8, 16]) {
    const w = width / k, h = height / k;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) continue;
    for (const c of [reported, 4, 3, 1]) {
      if (c && w * h * c === decodedLength) return { width: w, height: h, components: c, mismatch: false };
    }
  }
  return { width, height, components: reported || 4, mismatch: true };
}

function toRgba(decoded, width, height, components) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (components === 1) {
    for (let i = 0, o = 0; i < width * height; i++, o += 4) {
      const v = decoded[i] || 0;
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    }
  } else if (components >= 4) {
    for (let i = 0, s = 0, o = 0; i < width * height; i++, s += components, o += 4) {
      rgba[o] = decoded[s] || 0; rgba[o + 1] = decoded[s + 1] || 0;
      rgba[o + 2] = decoded[s + 2] || 0; rgba[o + 3] = decoded[s + 3] || 0;
    }
  } else {
    for (let i = 0, s = 0, o = 0; i < width * height; i++, s += components, o += 4) {
      rgba[o] = decoded[s] || 0; rgba[o + 1] = decoded[s + 1] || 0;
      rgba[o + 2] = decoded[s + 2] || 0; rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/**
 * Decodes a codestream and, when asked, also returns a PNG of the decoded
 * pixels. The PNG is what goes into the on-device cache: a phone pays tens to
 * hundreds of milliseconds to decode a J2C, and paying that again for every
 * texture on every login is what keeps a region looking untextured. A PNG is
 * decoded by the browser natively in a millisecond.
 */
async function decode(bytes, maxSize, wantPng) {
  const mod = await modulePromise;
  const decoder = new mod.J2KDecoder();
  const encoded = decoder.getEncodedBuffer(bytes.length);
  encoded.set(bytes);
  decoder.decode();
  const info = (decoder.getFrameInfo && decoder.getFrameInfo()) || {};
  const rw = info.width || 0;
  const rh = info.height || 0;
  if (!rw || !rh) throw new Error("imagen vacía");
  const decoded = decoder.getDecodedBuffer();
  const geo = frameGeometry(decoded.length, rw, rh, info.componentCount);
  const width = geo.width, height = geo.height;
  const rgba = toRgba(decoded, width, height, geo.components);
  const image = new ImageData(rgba, width, height);
  const limit = maxSize || 0;
  const biggest = Math.max(width, height);
  let bitmap;
  if (limit && biggest > limit) {
    const k = limit / biggest;
    bitmap = await createImageBitmap(image, {
      resizeWidth: Math.max(1, Math.round(width * k)),
      resizeHeight: Math.max(1, Math.round(height * k)),
      resizeQuality: "medium",
    });
  } else {
    bitmap = await createImageBitmap(image);
  }
  let png = null;
  if (wantPng && typeof OffscreenCanvas === "function") {
    try {
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = c.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const blob = await c.convertToBlob({ type: "image/png" });
      png = new Uint8Array(await blob.arrayBuffer());
    } catch (e) {
      png = null; // the cache is an optimisation: never fail a decode over it
    }
  }
  return { bitmap, png, width, height, codedWidth: rw, codedHeight: rh, mismatch: geo.mismatch };
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
    const r = await decode(msg.bytes, msg.maxSize, msg.wantPng);
    const transfer = [r.bitmap];
    if (r.png) transfer.push(r.png.buffer);
    self.postMessage(
      { kind: "decode", id: msg.id, ok: true, bitmap: r.bitmap, png: r.png,
        srcWidth: r.codedWidth, srcHeight: r.codedHeight,
        width: r.bitmap.width, height: r.bitmap.height, mismatch: r.mismatch },
      transfer);
  } catch (e) {
    self.postMessage({ kind: "decode", id: msg.id, ok: false, error: (e && e.message) || String(e) });
  }
};
