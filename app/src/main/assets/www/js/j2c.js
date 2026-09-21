// Second Life textures are JPEG2000 (raw J2C codestreams), which browsers
// cannot decode natively. We lazily pull in an OpenJPEG wasm build and adapt
// to whichever API it exposes; if that fails the caller keeps its placeholder.
let decoderPromise = null;
let warned = false;

async function loadOpenJpeg() {
  const candidates = [
    "https://esm.sh/@cornerstonejs/codec-openjpeg@1.2.2?bundle",
    "https://esm.sh/@cornerstonejs/codec-openjpeg@1.2.2",
    "https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-openjpeg@1.2.2/dist/openjpegwasm.js",
  ];
  for (const url of candidates) {
    try {
      const mod = await import(/* @vite-ignore */ url);
      if (mod && (mod.J2KDecoder || mod.default || mod.initializeCodec || mod.decode)) return mod;
    } catch (e) {
      /* try the next candidate */
    }
  }
  return null;
}

function toBitmapFromRgba(rgba, width, height) {
  const img = new ImageData(new Uint8ClampedArray(rgba.buffer ? rgba.buffer : rgba, 0, width * height * 4), width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d").putImageData(img, 0, 0);
  return createImageBitmap(c);
}

async function decodeWithOpenJpeg(mod, bytes) {
  const init = mod.initializeCodec ? await mod.initializeCodec() : mod;
  const Ctor = (init && (init.J2KDecoder || init.J2KRawImage)) || mod.J2KDecoder;
  if (!Ctor) return null;
  const decoder = new Ctor();
  const encoded = decoder.getEncodedBuffer(bytes.length);
  encoded.set(bytes);
  if (decoder.decode) decoder.decode();
  const frame = decoder.getFrameInfo ? decoder.getFrameInfo() : { width: 0, height: 0 };
  const width = frame.width || decoder.getWidth?.() || 0;
  const height = frame.height || decoder.getHeight?.() || 0;
  if (!width || !height) return null;
  const pixels = decoder.getDecodedBuffer ? decoder.getDecodedBuffer() : decoder.getDecodedBufferData?.();
  if (!pixels) return null;
  const channels = pixels.length === width * height * 3 ? 3 : 4;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++) {
    const s = i * channels;
    rgba[j++] = pixels[s];
    rgba[j++] = pixels[s + 1];
    rgba[j++] = pixels[s + 2];
    rgba[j++] = channels === 4 ? pixels[s + 3] : 255;
  }
  return toBitmapFromRgba(rgba, width, height);
}

export async function decodeJ2C(bytes) {
  if (!decoderPromise) decoderPromise = loadOpenJpeg();
  const mod = await decoderPromise;
  if (!mod) {
    if (!warned) {
      warned = true;
      console.warn("[visor] decodificador JPEG2000 no disponible: las texturas del grid usarán un color plano.");
    }
    return null;
  }
  try {
    return await decodeWithOpenJpeg(mod, bytes);
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn("[visor] fallo al decodificar JPEG2000: " + e.message);
    }
    return null;
  }
}

export function jpeg2000Available() {
  return !!decoderPromise;
}
