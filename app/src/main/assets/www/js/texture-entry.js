// SL TextureEntry: wire parsing + per-face material properties + UV transform.
// Bit layouts follow the SL viewer / Lumiya decompilation (see src/LUMIYA.md).

export const ATTR_TEXTURE_ID = 1, ATTR_RGBA = 2, ATTR_REPEAT_U = 4, ATTR_REPEAT_V = 8,
  ATTR_OFFSET_U = 16, ATTR_OFFSET_V = 32, ATTR_ROTATION = 64, ATTR_MATERIAL = 128,
  ATTR_MEDIA = 256, ATTR_GLOW = 512;

export const BUMP_NONE = 0, BUMP_BRIGHTNESS = 1, BUMP_DARKNESS = 2, BUMP_BRIGHTNESS2 = 3,
  BUMP_DARKNESS2 = 4, BUMP_BUMPY = 5, BUMP_BUMPY_SHINY = 6, BUMP_BUMPY_INVERSE = 7,
  BUMP_BRIGHT = 8, BUMP_DARK = 9, BUMP_GLOW = 10, BUMP_GLOW2 = 11, BUMP_BRIGHT_WRAP = 12,
  BUMP_DARK_WRAP = 13, BUMP_BRIGHT_WRAP2 = 14, BUMP_DARK_WRAP2 = 15, BUMP_GLOW_WRAP = 16,
  BUMP_GLOW_WRAP2 = 17, BUMP_BRIGHT_GLOW = 18, BUMP_DARK_GLOW = 19, BUMP_BRIGHT_GLOW2 = 20,
  BUMP_DARK_GLOW2 = 21;

export function defaultFace(o = {}) {
  return Object.assign({
    textureID: "00000000-0000-0000-0000-000000000000",
    rgba: [1, 1, 1, 1],
    repeatU: 1, repeatV: 1, offsetU: 0, offsetV: 0, rotation: 0,
    glow: 0, material: 0, media: 0, hasAttr: 0,
  }, o);
}

// A TextureEntry holds a default face plus sparse per-face overrides.
export class TextureEntry {
  constructor(defaultTexture, faces = []) {
    this.defaultTexture = defaultTexture;
    this.faces = faces; // array index = face index; null = use default
  }
  getFace(i) {
    const f = this.faces[i];
    if (!f) return this.defaultTexture;
    const d = this.defaultTexture;
    return {
      textureID: (f.hasAttr & ATTR_TEXTURE_ID) ? f.textureID : d.textureID,
      rgba: (f.hasAttr & ATTR_RGBA) ? f.rgba : d.rgba,
      repeatU: (f.hasAttr & ATTR_REPEAT_U) ? f.repeatU : d.repeatU,
      repeatV: (f.hasAttr & ATTR_REPEAT_V) ? f.repeatV : d.repeatV,
      offsetU: (f.hasAttr & ATTR_OFFSET_U) ? f.offsetU : d.offsetU,
      offsetV: (f.hasAttr & ATTR_OFFSET_V) ? f.offsetV : d.offsetV,
      rotation: (f.hasAttr & ATTR_ROTATION) ? f.rotation : d.rotation,
      glow: (f.hasAttr & ATTR_GLOW) ? f.glow : d.glow,
      material: (f.hasAttr & ATTR_MATERIAL) ? f.material : d.material,
      media: (f.hasAttr & ATTR_MEDIA) ? f.media : d.media,
      hasAttr: f.hasAttr,
    };
  }
  get hasFaces() { return this.faces.some(Boolean); }
}

class Reader {
  constructor(bytes) { this.b = bytes; this.p = 0; }
  // Past the end reads as 0 rather than `undefined`: a truncated TextureEntry
  // (which real sims do send) used to throw on `undefined.toString` and take the
  // whole prim down with it.
  u8() { return this.p < this.b.length ? this.b[this.p++] : 0; }
  s16() { const v = (this.b[this.p] | (this.b[this.p + 1] << 8)); this.p += 2; return (v << 16) >> 16; }
  u32() { const v = (this.b[this.p] | (this.b[this.p + 1] << 8) | (this.b[this.p + 2] << 16) | (this.b[this.p + 3] << 24)) >>> 0; this.p += 4; return v; }
  f32() {
    if (this.p + 4 > this.b.length) { this.p = this.b.length; return 0; }
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true);
    this.p += 4;
    return v;
  }
  uuid() {
    if (this.p + 16 > this.b.length) {
      this.p = this.b.length;
      return "00000000-0000-0000-0000-000000000000";
    }
    const h = [];
    for (let i = 0; i < 16; i++) h.push(this.b[this.p + i].toString(16).padStart(2, "0"));
    this.p += 16;
    const s = h.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
  rgba() {
    return [this.b[this.p] / 255, this.b[this.p + 1] / 255, this.b[this.p + 2] / 255, this.b[this.p + 3] / 255];
  }
  /**
   * The variable-length face bitfield. The groups are BIG-endian: each byte
   * carries the next 7 bits (bit 6..0) of the value, most significant group
   * first, and the high bit means "another byte follows"
   * (`unpack_TEField` in the official viewer's llprimitive.cpp, and Lumiya's
   * SLTextureEntry.ReadFaceBitfield). Reading them little-endian — which this
   * did — only agrees for a single-byte field, i.e. for prims with 7 faces or
   * fewer, and silently mis-assigns the texture on everything else.
   */
  readFaceBitfield() {
    let value = 0, bits = 0, byte;
    do {
      if (this.p >= this.b.length) return { value: 0, bits: 0 };
      byte = this.b[this.p++];
      value = ((value << 7) | (byte & 0x7f)) >>> 0;
      bits += 7;
    } while (byte & 0x80);
    return { value: value >>> 0, bits };
  }
}

export function parseTextureEntry(bytes, numFaces = 32) {
  const r = new Reader(bytes);
  if (bytes.length < 16) return new TextureEntry(defaultFace());
  const def = defaultFace();
  const faceCount = Math.min(numFaces, 45);
  const faces = new Array(faceCount).fill(null);
  const section = (readValue, setter) => {
    const v = readValue();
    for (;;) {
      const bf = r.readFaceBitfield();
      if (bf.value === 0) break;
      const fv = readValue();
      for (let i = 0; i < Math.min(bf.bits, faceCount); i++) {
        if (bf.value & (1 << i)) {
          if (!faces[i]) faces[i] = defaultFace({ hasAttr: 0 });
          setter(faces[i], fv);
        }
      }
    }
    return v;
  };
  const readUUID = () => r.uuid();
  const readRGBA = () => {
    const v = r.u32();
    return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255].map(x => x / 255);
  };
  const readF32 = () => r.f32();
  const readOffset = () => r.s16() / 32767;
  const readRot = () => (r.s16() / 32767) * Math.PI * 2;
  const readByte = () => r.u8();
  const readGlow = () => r.u8() / 255;

  def.textureID = section(readUUID, (f, v) => { f.textureID = v; f.hasAttr |= ATTR_TEXTURE_ID; });
  def.rgba = section(readRGBA, (f, v) => { f.rgba = v; f.hasAttr |= ATTR_RGBA; });
  def.repeatU = section(readF32, (f, v) => { f.repeatU = v; f.hasAttr |= ATTR_REPEAT_U; });
  def.repeatV = section(readF32, (f, v) => { f.repeatV = v; f.hasAttr |= ATTR_REPEAT_V; });
  def.offsetU = section(readOffset, (f, v) => { f.offsetU = v; f.hasAttr |= ATTR_OFFSET_U; });
  def.offsetV = section(readOffset, (f, v) => { f.offsetV = v; f.hasAttr |= ATTR_OFFSET_V; });
  def.rotation = section(readRot, (f, v) => { f.rotation = v; f.hasAttr |= ATTR_ROTATION; });
  def.material = section(readByte, (f, v) => { f.material = v; f.hasAttr |= ATTR_MATERIAL; });
  def.media = section(readByte, (f, v) => { f.media = v; f.hasAttr |= ATTR_MEDIA; });
  def.glow = section(readGlow, (f, v) => { f.glow = v; f.hasAttr |= ATTR_GLOW; });
  return new TextureEntry(def, faces);
}

// Build the SL texture UV transform (rotate about the UV bbox centre, then repeat+offset).
export function faceUVMatrix(face) {
  const c = Math.cos(face.rotation), s = Math.sin(face.rotation);
  return {
    apply(u, v) {
      const x = (u - 0.5) * face.repeatU;
      const y = (v - 0.5) * face.repeatV;
      const rx = x * c - y * s;
      const ry = x * s + y * c;
      return [rx + 0.5 + face.offsetU, ry + 0.5 + face.offsetV];
    },
  };
}

export function bumpToRoughness(bump) {
  // crude PBR mapping of SL's legacy bump codes
  if (bump === BUMP_BUMPY || bump === BUMP_BUMPY_SHINY || bump === BUMP_BUMPY_INVERSE) return 0.9;
  if (bump === BUMP_NONE) return 0.6;
  return 0.4;
}
export function isShiny(materialByte) { return (materialByte & 0x03) !== 0; }
