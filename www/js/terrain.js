// SL terrain: bit-packed/DCT patch decode (port of Lumiya's TerrainPatch) plus
// region heightmap assembly, procedural generation and mesh building.

export const PATCH_SIZE = 16;
export const PATCHES_PER_EDGE = 16;
export const REGION_SIZE = 256;      // metres
export const SAMPLES_PER_EDGE = PATCHES_PER_EDGE * PATCH_SIZE + 1; // 257

class BitBuffer {
  constructor(bytes) { this.b = bytes; this.bitPos = 0; }
  getBits(n) {
    // A truncated (or corrupt) LayerData stream used to read zeros forever and
    // hang the render loop; the decoder must bail out instead.
    if (this.bitPos + n > this.b.length * 8) throw new Error("flujo de bits agotado");
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.bitPos >> 3] || 0;
      const bit = (byte >> (7 - (this.bitPos & 7))) & 1;
      v = (v << 1) | bit;
      this.bitPos++;
    }
    return n === 32 ? v >>> 0 : v;
  }
  getFloat() {
    const v = new DataView(new ArrayBuffer(4));
    v.setUint32(0, this.getBits(32), false);
    return v.getFloat32(0, false);
  }
}

const OO_SQRT2 = 0.70710677;
const DequantizeTable16 = new Float32Array(256);
const CosineTable16 = new Float32Array(256);
const CopyMatrix16 = new Int32Array(256);
(function initTables() {
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      DequantizeTable16[i * 16 + j] = (j + i) * 2 + 1;
      CosineTable16[i * 16 + j] = Math.cos(((j * 2 + 1) * i) * 0.09817477);
    }
  }
  let i = 0, x = 0, y = 0, flip = true, diag = false;
  while (x < 16 && y < 16) {
    CopyMatrix16[y * 16 + x] = i++;
    if (diag) {
      if (flip) { x++; y--; if (x === 15 || y === 0) diag = false; }
      else { x--; y++; if (y === 15 || x === 0) diag = false; }
    } else if (flip) { if (x < 15) x++; else y++; flip = false; diag = true; }
    else { if (y < 15) y++; else x++; flip = true; diag = true; }
  }
})();

function idctColumn16(src, dst, col) {
  for (let y = 0; y < 16; y++) {
    let sum = src[col] * OO_SQRT2;
    for (let k = 1; k < 16; k++) sum += CosineTable16[k * 16 + y] * src[k * 16 + col];
    dst[y * 16 + col] = sum;
  }
}
function idctLine16(src, dst, row) {
  const off = row * 16;
  for (let x = 0; x < 16; x++) {
    let sum = src[off] * OO_SQRT2;
    for (let k = 1; k < 16; k++) sum += src[off + k] * CosineTable16[k * 16 + x];
    dst[off + x] = sum * 0.125;
  }
}

/**
 * The LayerID.Type byte of the LayerData message. The simulator does *not* use
 * 0 for the ground: it sends the terrain patches as type 76 (0x4c, "land") and a
 * second stream of type 55 (0x37, "water") that only carries the water plane
 * heights. A viewer that reads only type 0 therefore never sees a single patch
 * and keeps its placeholder terrain forever — which is exactly what Lumiya's
 * `SLAgentCircuit.HandleLayerData` avoids with `if (Type != 76) return;`.
 * (`LayerData.Java`, `TerrainData.ProcessLayerData`.)
 */
export const LAYER_TYPE_LAND = 76;
export const LAYER_TYPE_WATER = 55;

/**
 * Decodes one LayerData datagram. The payload is a 4-byte header followed by a
 * single continuous bit stream of DCT-compressed patches (no re-alignment
 * between them):
 *
 *   stride U16, patchSize U8, type U8, then patch… patch… 0x61 (END_OF_PATCHES)
 *
 * Returns `{ header, patches }` where each patch is `{ patchId, x, y, heightMap }`.
 * A datagram that ends mid-patch (the stream is not aligned to the message) stops
 * the loop instead of reading zeros forever.
 */
export function decodeTerrainLayer(bytes) {
  const patches = [];
  if (!bytes || bytes.length < 5) return { header: null, patches };
  const bb = new BitBuffer(bytes);
  const header = { stride: bb.getBits(16), patchSize: bb.getBits(8), type: bb.getBits(8) };
  const size = header.patchSize === 32 ? 32 : 16;
  const nCells = size * size;
  try {
    for (;;) {
      const quantWBits = bb.getBits(8);
      if (quantWBits === 97) break;
      const dcOffset = bb.getFloat();
      const range = bb.getBits(16);
      const patchIds = bb.getBits(10);
      const wordBits = (quantWBits & 15) + 2;
      const coeffs = new Int32Array(nCells);
      for (let i = 0; i < nCells;) {
        if (bb.getBits(1) === 0) { coeffs[i] = 0; i++; }
        else if (bb.getBits(1) === 0) { while (i < nCells) coeffs[i++] = 0; }
        else if (bb.getBits(1) !== 0) { coeffs[i] = -bb.getBits(wordBits); i++; }
        else { coeffs[i] = bb.getBits(wordBits); i++; }
      }
      const tmp = new Float32Array(nCells);
      const ordered = new Float32Array(nCells);
      for (let i = 0; i < nCells; i++) ordered[i] = coeffs[CopyMatrix16[i]] * DequantizeTable16[i];
      const mid = new Float32Array(nCells);
      for (let c = 0; c < size; c++) idctColumn16(ordered, mid, c);
      for (let r = 0; r < size; r++) idctLine16(mid, tmp, r);
      const q = (quantWBits >> 4) + 2;
      const scale = (1.0 / (1 << q)) * range;
      const base = dcOffset + (1 << (q - 1)) * scale;
      const heightMap = new Float32Array(nCells);
      for (let i = 0; i < nCells; i++) heightMap[i] = tmp[i] * scale + base;
      patches.push({ patchId: patchIds, x: (patchIds >> 5) & 31, y: patchIds & 31, size, heightMap });
    }
  } catch (e) {
    // Truncated datagram: keep whatever decoded cleanly and drop the rest.
  }
  return { header, patches };
}

export function serializeTerrainPatches(patches, header = {}) {
  // inverse of the coeff packer — used by tests/offline tools
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(header.stride ?? 16, 16);
  put(header.patchSize ?? 16, 8);
  put(header.type ?? LAYER_TYPE_LAND, 8);
  for (const p of patches) {
    put(p.quantWBits & 0xff, 8);
    const f = new DataView(new ArrayBuffer(4));
    f.setFloat32(0, p.dcOffset, false);
    put(f.getUint32(0, false), 32);
    put(p.range & 0xffff, 16);
    put(p.patchId & 1023, 10);
    const wordBits = (p.quantWBits & 15) + 2;
    const zz = p.coeffs;
    for (let i = 0; i < 256;) {
      const v = zz[i];
      if (v === 0) {
        let run = 0;
        while (i + run < 256 && zz[i + run] === 0) run++;
        if (run >= 2) {
          let r = run;
          while (r > 0) {
            const chunk = Math.min(r, (1 << 28));
            bits.push(0, 1); // zero then end-of-run marker
            r -= chunk;
            i += chunk;
          }
          bits.push(0);
          continue;
        }
        bits.push(0); i++;
        continue;
      }
      bits.push(1, 1, v > 0 ? 0 : 1);
      put(Math.abs(v), wordBits);
      i++;
    }
  }
  put(97, 8);
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (7 - (i & 7)); });
  return bytes;
}

// ---------------------------------------------------------------------------
// Terrain container
// ---------------------------------------------------------------------------

export class Terrain {
  constructor() {
    this.samples = new Float32Array(SAMPLES_PER_EDGE * SAMPLES_PER_EDGE);
    this.textures = [];
    this.heights = { lowStart: 10, lowEnd: 20, highStart: 50, highEnd: 60 };
    this.waterHeight = 20;
    this.version = 0;
  }
  at(x, y) {
    x = Math.max(0, Math.min(SAMPLES_PER_EDGE - 1, x | 0));
    y = Math.max(0, Math.min(SAMPLES_PER_EDGE - 1, y | 0));
    return this.samples[y * SAMPLES_PER_EDGE + x];
  }
  bilinear(fx, fy) {
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const a = this.at(x0, y0), b = this.at(x0 + 1, y0), c = this.at(x0, y0 + 1), d = this.at(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  applyPatch(patch) {
    const px = patch.x * PATCH_SIZE, py = patch.y * PATCH_SIZE;
    const size = patch.size || PATCH_SIZE;
    // A 32x32 patch (some grids) is subsampled onto the 16x16 patch grid.
    const step = Math.max(1, Math.round(size / PATCH_SIZE));
    for (let j = 0; j < PATCH_SIZE; j++) {
      for (let i = 0; i < PATCH_SIZE; i++) {
        const sx = px + i, sy = py + j;
        if (sx < SAMPLES_PER_EDGE && sy < SAMPLES_PER_EDGE) {
          this.samples[sy * SAMPLES_PER_EDGE + sx] = patch.heightMap[(j * step) * size + i * step];
        }
      }
    }
    this.version++;
  }
}

// value-noise fbm (deterministic per seed)
function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function noise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export function proceduralTerrain(seed = 1337, opts = {}) {
  const t = new Terrain();
  const island = opts.island !== false;
  const octaves = 5;
  const octaveOpts = opts.octaves || octaves;
  for (let y = 0; y < SAMPLES_PER_EDGE; y++) {
    for (let x = 0; x < SAMPLES_PER_EDGE; x++) {
      let h = 0, amp = 1, freq = 1 / 64, norm = 0;
      for (let o = 0; o < octaveOpts; o++) {
        h += noise2(x * freq, y * freq, seed + o * 71) * amp;
        norm += amp; amp *= 0.5; freq *= 2.1;
      }
      h /= norm;
      const hilly = 46 + (h - 0.5) * 62;
      let v = hilly;
      if (island) {
        const cx = x - SAMPLES_PER_EDGE / 2, cy = y - SAMPLES_PER_EDGE / 2;
        const d = Math.hypot(cx, cy) / (SAMPLES_PER_EDGE / 2);
        const falloff = Math.max(0, Math.min(1, (1.02 - d) / 0.62));
        v = 3 + (hilly - 3) * Math.pow(falloff, 1.5);
      }
      t.samples[y * SAMPLES_PER_EDGE + x] = v;
    }
  }
  return t;
}

export function buildTerrainMesh(terrain, opts = {}) {
  const { startX = 0, startY = 0, size = SAMPLES_PER_EDGE, skip = 1 } = opts;
  const n = Math.floor((size - 1) / skip) + 1;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const indices = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const sx = startX + i * skip, sy = startY + j * skip;
      const h = terrain.at(sx, sy);
      const k = j * n + i;
      positions[k * 3] = sx * (REGION_SIZE / (SAMPLES_PER_EDGE - 1));
      positions[k * 3 + 1] = sy * (REGION_SIZE / (SAMPLES_PER_EDGE - 1));
      positions[k * 3 + 2] = h;
      uvs[k * 2] = sx / (SAMPLES_PER_EDGE - 1);
      uvs[k * 2 + 1] = sy / (SAMPLES_PER_EDGE - 1);
    }
  }
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  // analytic-ish normals from height differences
  const step = REGION_SIZE / (SAMPLES_PER_EDGE - 1) * skip;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const hL = positions[Math.max(0, (j * n + Math.max(0, i - 1))) * 3 + 2];
      const hR = positions[(j * n + Math.min(n - 1, i + 1)) * 3 + 2];
      const hD = positions[Math.max(0, (Math.max(0, j - 1) * n + i)) * 3 + 2];
      const hU = positions[(Math.min(n - 1, j + 1) * n + i) * 3 + 2];
      let nx = (hL - hR), ny = (hD - hU), nz = 2 * step;
      const m = Math.hypot(nx, ny, nz);
      normals[k * 3] = nx / m; normals[k * 3 + 1] = ny / m; normals[k * 3 + 2] = nz / m;
    }
  }
  return { positions, normals, uvs, indices: new Uint32Array(indices), count: n };
}
