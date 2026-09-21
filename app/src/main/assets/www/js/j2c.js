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
let workers = [];            // decode pool (see startPool)
let poolPending = [];        // in-flight decodes per worker
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

/**
 * How many decoders to run at once. A J2C decode is a pure-CPU job inside the
 * wasm module, so one worker is one core — and one core is what limited a
 * region to ~12 textures a second, i.e. minutes of "white prims" while a
 * thousand faces wait in the queue. Each worker loads its own copy of the wasm
 * module, so this stays deliberately modest (2-3 on a phone).
 */
function poolSize() {
  let hw = 4;
  try {
    const n = navigator.hardwareConcurrency || 0;
    if (n > 0) hw = n;
  } catch (e) { /* no navigator (worker-only use): assume 4 */ }
  return Math.max(1, Math.min(3, Math.floor(hw / 3)));
}

/**
 * Starts the decode pool; resolves to false (and stays off) if a worker cannot
 * be created at all — the caller then falls back to the main-thread module.
 */
function startPool() {
  if (workerReady) return workerReady;
  if (workerBroken) return Promise.resolve(false);
  workerReady = new Promise((resolve) => {
    const fail = (e) => {
      workerBroken = true;
      workers = [];
      poolPending = [];
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
        const n = poolSize();
        let pendingReady = n;
        const spawn = () => {
          const w = new Worker(URL.createObjectURL(new Blob([text], { type: "text/javascript" })));
          let settled = false;
          w.onerror = (e) => { if (!settled) { settled = true; fail(new Error((e && e.message) || "error en el worker de texturas")); } };
          w.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.kind === "ready") {
              if (settled) return;
              settled = true;
              if (!msg.ok) { fail(new Error(msg.error || "el worker no arrancó")); return; }
              // Every worker needs its own copy of the wasm binary: a transfer
              // would detach the buffer for the next one.
              workers.push({ w, busy: 0 });
              poolPending.push(0);
              pendingReady--;
              if (pendingReady === 0) { loaded = true; resolve(true); }
              return;
            }
            const pending = workerPending.get(msg.id);
            if (!pending) return;
            workerPending.delete(msg.id);
            const slot = workers.indexOf(pending.slot);
            if (slot >= 0 && poolPending[slot] > 0) poolPending[slot]--;
            if (msg.ok) pending.resolve(msg);
            else pending.reject(new Error(msg.error || "fallo al decodificar"));
          };
          const binary = wasmBinary.slice(0); // per-worker copy (see above)
          w.postMessage({ kind: "init", id: 0, glueUrl, wasmUrl, glueText, wasmBinary: binary }, [binary]);
        };
        for (let i = 0; i < n; i++) spawn();
      })
      .catch(fail);
  });
  return workerReady;
}

function decoderReady() {
  return workerBroken ? getModule() : startPool().then((ok) => (ok ? null : getModule()));
}

/** Decodes through the least busy worker; rejects if the pool is not available. */
function decodeInWorker(bytes, maxSize, wantPng) {
  return new Promise((resolve, reject) => {
    if (!workers.length || workerBroken) { reject(new Error("sin worker")); return; }
    let slot = 0;
    for (let i = 1; i < workers.length; i++) if (poolPending[i] < poolPending[slot]) slot = i;
    const slotRef = workers[slot];
    slotRef.busy = poolPending[slot] + 1;
    poolPending[slot]++;
    const id = ++workerSeq;
    workerPending.set(id, { resolve, reject, slot: slotRef });
    // The codestream is copied before transfer: the caller keeps using its own
    // buffer (it writes the texture to the on-device cache right afterwards), and
    // the copy costs nothing next to the decode itself.
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    try {
      slotRef.w.postMessage({ kind: "decode", id, bytes: owned, maxSize, wantPng: !!wantPng }, [owned.buffer]);
    } catch (e) {
      workerPending.delete(id);
      poolPending[slot] = Math.max(0, poolPending[slot] - 1);
      reject(e);
    }
  });
}

/**
 * The real layout of the decoder's output buffer.
 *
 * This is the piece that made every Second Life texture look like "stripes and
 * black bars" on the phone. The decoder (@cornerstonejs/codec-openjpeg, see its
 * `J2KDecoder.hpp`) sizes its output buffer from the *reported* frame —
 * `width * height * componentCount * bytesPerSample` — but it does not fill it
 * the way that arithmetic suggests:
 *
 *   componentCount == 1   ->  width*height samples, `bytes` each (8 or 16 bit)
 *   componentCount >= 3   ->  RGB *triples* written at `x*3` inside rows whose
 *                             pitch is `componentCount` bytes per pixel
 *
 * There is no code path that writes a 4th channel. So for a 4-component (RGBA)
 * codestream — which is what the grid sends for every texture that carries
 * alpha, and a large fraction of a region's textures do — the decoder writes
 * 3 bytes at a 3-byte stride into rows that are 4 bytes per pixel wide, and the
 * last `width` bytes of every row are left at zero.
 *
 * Reading such a buffer as interleaved RGBA (which this viewer did, taking the
 * reported component count at face value) walks the data 4 bytes at a time over
 * 3-byte-strided pixels: the colour phase rotates one channel per pixel, so the
 * texture turns into thin colour-cycled stripes, and everything past three
 * quarters of each row is the untouched zero tail — a solid black bar down the
 * right-hand side. That is precisely what the phone showed in its decoded
 * texture grid, and it is why the world had "no logical textures".
 *
 * `written` is how many samples per pixel the decoder actually produced, and
 * `empty` marks the combination it cannot produce at all (more than one
 * component with more than 8 bits per sample: that branch is compiled out).
 */
export function decodeLayout(info, decodedLength) {
  const rawW = Math.max(0, info.width | 0);
  const rawH = Math.max(0, info.height | 0);
  const components = Math.max(1, info.componentCount | 0);
  const bits = (info.bitsPerSample | 0) || 8;
  const bytes = bits > 8 ? 2 : 1;
  const written = components === 1 ? 1 : 3;
  // With more than one component and more than 8 bits per sample the library's
  // writer is compiled out entirely: the buffer comes back all zeros. That has
  // to be reported, not drawn as a black box, and it does not depend on whether
  // the reported frame matches the buffer.
  const empty = written > 1 && bytes > 1;
  for (const k of [1, 2, 4, 8, 16]) {
    const width = rawW / k, height = rawH / k;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) continue;
    if (width * height * components * bytes === decodedLength) {
      return { width, height, components, bits, bytes, written, empty, mismatch: k !== 1 };
    }
  }
  // The reported frame did not agree with the buffer at all: keep the most
  // useful guess and let the caller record it instead of drawing noise.
  return { width: rawW || 1, height: rawH || 1, components, bits, bytes, written, empty, mismatch: true };
}

export function toRgba(decoded, layout) {
  const { width, height, components, bytes, written } = layout;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const rowStride = width * components * bytes;   // the decoder's own row pitch
  const pxStride = written * bytes;               // what it writes per pixel
  if (written === 1) {
    for (let i = 0, o = 0; i < width * height; i++, o += 4) {
      const v = bytes === 2 ? (decoded[i * 2] | (decoded[i * 2 + 1] << 8)) >>> 8 : decoded[i] || 0;
      rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
    }
    return rgba;
  }
  for (let y = 0; y < height; y++) {
    let s = y * rowStride;
    let o = y * width * 4;
    for (let x = 0; x < width; x++, s += pxStride, o += 4) {
      rgba[o] = decoded[s] || 0;
      rgba[o + 1] = decoded[s + 1] || 0;
      rgba[o + 2] = decoded[s + 2] || 0;
      // The library never decodes the 4th plane, so an alpha texture stays
      // opaque. That is a known, visible limitation (foliage, glass); it is
      // still infinitely better than the stripes it used to draw.
      rgba[o + 3] = 255;
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
  return (await decodeJ2CEx(bytes, maxSize, false)).bitmap;
}

/**
 * Same decode, but also hands back a PNG of the result (and the codestream's own
 * dimensions) when `wantPng` is set. The PNG is what goes into the on-device
 * cache: decoding a stored J2C again costs the same as downloading it, which is
 * why a second visit to a region used to look exactly as untextured as the
 * first. Returns `{ bitmap, png, width, height, srcWidth, srcHeight }`.
 */
export async function decodeJ2CEx(bytes, maxSize, wantPng) {
  const limit = maxSize || textureMaxSize;
  const ready = await decoderReady();
  if (!workerBroken && workers.length) {
    try {
      const res = await decodeInWorker(bytes, limit, wantPng);
      return {
        bitmap: res.bitmap, png: res.png || null,
        width: res.width, height: res.height,
        srcWidth: res.srcWidth || res.width, srcHeight: res.srcHeight || res.height,
        components: res.components || 0, bits: res.bits || 0, mismatch: !!res.mismatch,
      };
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
  const rw = info.width || 0;
  const rh = info.height || 0;
  if (!rw || !rh) throw new Error("imagen vacía");
  const decoded = decoder.getDecodedBuffer();
  const layout = decodeLayout(info, decoded.length);
  if (layout.empty) {
    throw new Error(`el codestream no se puede decodificar en esta librería (${layout.bits} bits × ` +
      `${layout.components} componentes: esa rama no está implementada)`);
  }
  const width = layout.width, height = layout.height;
  const rgba = toRgba(decoded, layout);
  const image = new ImageData(rgba, width, height);
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
  if (wantPng) {
    try {
      const c = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(bitmap.width, bitmap.height) : null;
      if (c) {
        c.getContext("2d").drawImage(bitmap, 0, 0);
        const blob = await c.convertToBlob({ type: "image/png" });
        png = new Uint8Array(await blob.arrayBuffer());
      }
    } catch (e) {
      png = null;
    }
  }
  return {
    bitmap, png, width: bitmap.width, height: bitmap.height, srcWidth: width, srcHeight: height,
    components: layout.components, bits: layout.bits, mismatch: layout.mismatch,
  };
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
  return workers.length > 0 && !workerBroken;
}

/** How many decode workers are running (diagnostics). */
export function decoderWorkers() {
  return workers.length;
}

// One line per session is enough: the HUD log is small and the failure is not
// fatal (textures fall back to a flat colour).
export function report(err) {
  if (warned) return;
  warned = String((err && err.message) || err);
  console.warn("[visor] decodificador JPEG2000 no disponible: " + warned);
}
