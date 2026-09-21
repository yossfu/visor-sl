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
 * Works out the real geometry of a decoded buffer. Two things can go wrong and
 * both used to be silent: the reported component count can disagree with the
 * buffer the decoder actually produced (a 3-component codestream reported as 4
 * makes every pixel read its alpha from the neighbour's red), and the decoder
 * can hand back a REDUCED frame (a quarter of the resolution) while still
 * reporting the full width/height. Reading either as if it were the other
 * produces a texture that is subtly wrong — or black — with nothing in the log.
 *
 * Returns `{ width, height, components, mismatch }`; `mismatch: true` means
 * nothing added up and the caller is about to make a best effort.
 */
export function frameGeometry(decodedLength, width, height, reported) {
  for (const k of [1, 2, 4, 8, 16]) {
    const w = width / k, h = height / k;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) continue;
    for (const c of [reported, 4, 3, 1]) {
      if (c && w * h * c === decodedLength) {
        return { width: w, height: h, components: c, mismatch: false };
      }
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
  const geo = frameGeometry(decoded.length, rw, rh, info.componentCount);
  const width = geo.width, height = geo.height;
  const rgba = toRgba(decoded, width, height, geo.components);
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
  return { bitmap, png, width: bitmap.width, height: bitmap.height, srcWidth: width, srcHeight: height };
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
