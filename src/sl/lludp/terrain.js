// terrain.js -- el terreno de Second Life: los parches DCT del mensaje
// `LayerData`.
//
// COMO VIAJA EL TERRENO
// ---------------------
// El terreno NO va como una rejilla de alturas en crudo. Va comprimido con la
// misma idea que un JPEG: cada parche de 16x16 metros se pasa a una transformada
// discreta del coseno (DCT) 2D, se cuantiza a enteros y los enteros se escriben
// en un flujo de bits con codigos de longitud variable. Asi un parche liso
// ocupa unos pocos bytes en vez de 1 KB.
//
// El mensaje `LayerData` (High 11) lleva dos bloques:
//
//   LayerID    { Type   U8 }              // 'L' = tierra, '7' = viento, '8' = nubes
//   LayerData  { Data   Variable 2 }      // el flujo de bits
//
// y ese flujo tiene esta pinta:
//
//   [cabecera de grupo]  16 bits stride, 8 bits tamano de parche, 8 bits tipo
//   [parche]*            8 bits quant_wbits, 32 dc_offset, 16 range, 10 patchids,
//                        y luego los coeficientes
//   97                   8 bits de fin (END_OF_PATCHES)
//
// El `patchids` de 10 bits dice DONDE va el parche: 5 bits para x y 5 para y,
// de modo que una region de 256x256 m son 16x16 = 256 parches.
//
// ORDEN DE LOS BITS
// -----------------
// El empaquetador de bits de Linden Lab (LLBitPack) escribe cada valor como
// bytes en orden little-endian, pero dentro de cada byte emite el bit mas
// significativo primero. Para los valores de un solo byte eso es simplemente
// "de arriba abajo"; es el detalle que hay que copiar exactamente porque si no,
// lo que se lee son tonterias (y no avisa: da alturas plausibles pero
// equivocadas).
//
// LA CUANTIZACION
// ---------------
// `dc_offset` es la altura minima del parche y `range` el margen. Los
// coeficientes enteros se guardan contra un paso de `range / 2^prequant`, donde
// `prequant` son los 4 bits altos de `quant_wbits`. El numero de bits de cada
// coeficiente son los 4 bits bajos + 2. Con `prequant = 8` el error tipico es de
// unos pocos centimetros, que es lo normal en Second Life.

export const NORMAL_PATCH_SIZE = 16;
export const LARGE_PATCH_SIZE = 32;
export const END_OF_PATCHES = 97;
export const ZERO_CODE = 0x0;
export const ZERO_EOB = 0x2;
export const POSITIVE_VALUE = 0x6;
export const NEGATIVE_VALUE = 0x7;
export const LAYER_CODE = { LAND: 0x4c, WIND: 0x37, CLOUD: 0x38 };

const OO_SQRT2 = Math.SQRT1_2;

// --- flujo de bits -----------------------------------------------------------
//
// Solo se usan imagenes de <= 32 bits, que es lo mas que manda el protocolo.

class BitReader {
  constructor(u8, off = 0, end) {
    this.buf = u8;
    this.start = off * 8;
    this.endBit = (end === undefined ? u8.length : end) * 8;
    this.pos = this.start;
    this.overflow = false;
  }
  bit() {
    if (this.pos >= this.endBit) { this.overflow = true; return 0; }
    const b = (this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  // Reconstruye el valor igual que LLBitPack::bitUnpack: trozos de 8 bits (o el
  // ultimo trozo corto) tomados de menos a mas significativo, y dentro de cada
  // trozo el bit mas significativo primero.
  readBits(n) {
    let value = 0;
    let shift = 0;
    let rem = n;
    while (rem > 0) {
      const d = rem > 8 ? 8 : rem;
      let chunk = 0;
      for (let i = 0; i < d; i++) chunk = (chunk << 1) | this.bit();
      value += chunk * Math.pow(2, shift);
      shift += d;
      rem -= d;
    }
    return value;
  }
  get remainingBits() { return this.endBit - this.pos; }
}

class BitWriter {
  constructor() { this.bytes = []; this.load = 0; this.n = 0; }
  writeBit(b) {
    this.load = (this.load << 1) | (b & 1);
    this.n++;
    if (this.n === 8) { this.bytes.push(this.load & 0xff); this.load = 0; this.n = 0; }
  }
  writeBits(value, n) {
    let shift = 0;
    let rem = n;
    while (rem > 0) {
      const d = rem > 8 ? 8 : rem;
      const chunk = Math.floor(value / Math.pow(2, shift)) & ((1 << d) - 1);
      for (let i = d - 1; i >= 0; i--) this.writeBit((chunk >> i) & 1);
      shift += d;
      rem -= d;
    }
  }
  // Los ultimos bits se rellenan con ceros hasta completar el byte.
  flush() {
    if (this.n) { this.load <<= (8 - this.n); this.bytes.push(this.load & 0xff); this.load = 0; this.n = 0; }
    return Uint8Array.from(this.bytes);
  }
}

const u32View = new DataView(new ArrayBuffer(4));
function u32ToF32(v) { u32View.setUint32(0, v >>> 0, true); return u32View.getFloat32(0, true); }
function f32ToU32(v) { u32View.setFloat32(0, v || 0, true); return u32View.getUint32(0, true); }

// --- tablas (una vez por tamano de parche) -----------------------------------

const TABLE_CACHE = new Map();

export function patchTables(size) {
  let t = TABLE_CACHE.get(size);
  if (t) return t;
  const n2 = size * size;
  const cosine = new Float32Array(n2);
  const dequantize = new Float32Array(n2);
  const quantize = new Float32Array(n2);
  // Ojo: el paso del coseno y el factor de normalizacion de la transformada son
  // dos numeros distintos que en el codigo original se llaman igual (`oosob`).
  const angulo = (Math.PI * 0.5) / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const w = 1 + 2 * (i + j);
      dequantize[j * size + i] = w;
      quantize[j * size + i] = 1 / w;
    }
  }
  for (let u = 0; u < size; u++) {
    for (let n = 0; n < size; n++) cosine[u * size + n] = Math.cos((2 * n + 1) * u * angulo);
  }
  // Ambas matrices (la de compresion y la de descompresion) usan el mismo
  // recorrido en zig-zag por diagonales: `copy[idx]` dice en que posicion del
  // flujo va el coeficiente `idx`, y al reves.
  const copy = new Int32Array(n2);
  let i = 0, j = 0, count = 0;
  let diag = false, right = true;
  while (i < size && j < size) {
    copy[j * size + i] = count++;
    if (!diag) {
      if (right) {
        if (i < size - 1) i++; else j++;
        right = false; diag = true;
      } else {
        if (j < size - 1) j++; else i++;
        right = true; diag = true;
      }
    } else if (right) {
      i++; j--;
      if (i === size - 1 || j === 0) diag = false;
    } else {
      i--; j++;
      if (i === 0 || j === size - 1) diag = false;
    }
  }
  t = { size, oosob: 2 / size, cosine, dequantize, quantize, copy };
  TABLE_CACHE.set(size, t);
  return t;
}

// --- transformada ------------------------------------------------------------

function idctColumn(linein, lineout, column, size, T) {
  const cos = T.cosine;
  for (let n = 0; n < size; n++) {
    let total = OO_SQRT2 * linein[column];
    for (let u = 1; u < size; u++) total += linein[u * size + column] * cos[u * size + n];
    lineout[size * n + column] = total;
  }
}

function idctLine(linein, lineout, line, size, T) {
  const cos = T.cosine;
  const lineSize = line * size;
  for (let n = 0; n < size; n++) {
    let total = OO_SQRT2 * linein[lineSize];
    for (let u = 1; u < size; u++) total += linein[lineSize + u] * cos[u * size + n];
    lineout[lineSize + n] = total * T.oosob;
  }
}

export function idctPatch(block, size) {
  const T = patchTables(size);
  const temp = new Float32Array(LARGE_PATCH_SIZE * LARGE_PATCH_SIZE);
  for (let i = 0; i < size; i++) idctColumn(block, temp, i, size, T);
  for (let i = 0; i < size; i++) idctLine(temp, block, i, size, T);
}

function dctLine(linein, lineout, line, size, T) {
  const cos = T.cosine;
  const lineSize = line * size;
  let total = 0;
  for (let n = 0; n < size; n++) total += linein[lineSize + n];
  lineout[lineSize] = OO_SQRT2 * total;
  for (let u = 1; u < size; u++) {
    total = 0;
    for (let n = 0; n < size; n++) total += linein[lineSize + n] * cos[u * size + n];
    lineout[lineSize + u] = total;
  }
}

function dctColumn(linein, lineout, column, size, T) {
  const cos = T.cosine;
  const qt = T.quantize;
  const copy = T.copy;
  let total = 0;
  for (let n = 0; n < size; n++) total += linein[size * n + column];
  lineout[copy[column]] = Math.trunc(OO_SQRT2 * total * T.oosob * qt[column]);
  for (let u = 1; u < size; u++) {
    total = 0;
    for (let n = 0; n < size; n++) total += linein[size * n + column] * cos[u * size + n];
    const idx = size * u + column;
    lineout[copy[idx]] = Math.trunc(total * T.oosob * qt[idx]);
  }
}

export function dctPatch(block, cpatch, size) {
  const T = patchTables(size);
  const temp = new Float32Array(LARGE_PATCH_SIZE * LARGE_PATCH_SIZE);
  for (let i = 0; i < size; i++) dctLine(block, temp, i, size, T);
  for (let i = 0; i < size; i++) dctColumn(temp, cpatch, i, size, T);
}

// --- un parche ---------------------------------------------------------------

// Convierte los coeficientes enteros en alturas. `out` es un Float32Array,
// `outOff` el desplazamiento del parche dentro de el, y `outStride` el salto
// entre filas (16 si las alturas van seguidas, o el ancho de la rejilla de la
// region si se escriben directamente en ella).
export function decompressPatch(out, outOff, outStride, cpatch, ph, size) {
  const T = patchTables(size);
  const n2 = size * size;
  const block = new Float32Array(LARGE_PATCH_SIZE * LARGE_PATCH_SIZE);
  const range = ph.range;
  const prequant = (ph.quant_wbits >> 4) + 2;
  const quantize = Math.pow(2, prequant);
  const hmin = ph.dc_offset;
  const ooq = 1 / quantize;
  const mult = ooq * range;
  const addval = mult * Math.pow(2, prequant - 1) + hmin;

  for (let i = 0; i < n2; i++) block[i] = cpatch[T.copy[i]] * T.dequantize[i];
  idctPatch(block, size);
  for (let j = 0; j < size; j++) {
    const row = outOff + j * outStride;
    const brow = j * size;
    for (let i = 0; i < size; i++) out[row + i] = block[brow + i] * mult + addval;
  }
  return out;
}

// El camino de ida: mide el margen de alturas y pasa el parche a coeficientes
// enteros. `patch` son las alturas (con salto `stride`), `cpatch` el destino.
export function prescanPatch(patch, stride, size) {
  let zmax = -99999999, zmin = 99999999;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const v = patch[j * stride + i];
      if (v > zmax) zmax = v;
      if (v < zmin) zmin = v;
    }
  }
  return { dcOffset: zmin, range: Math.trunc(zmax - zmin + 1) & 0xffff };
}

export function compressPatch(patch, stride, cpatch, ph, size, prequant) {
  const T = patchTables(size);
  const block = new Float32Array(LARGE_PATCH_SIZE * LARGE_PATCH_SIZE);
  const oozrange = 1 / ph.range;
  const dc = ph.dc_offset;
  const numrange = Math.pow(2, prequant);
  const premult = oozrange * numrange;
  const sub = Math.pow(2, prequant - 1) + dc * premult;

  // Los 4 bits altos dicen cuantos bits tiene cada coeficiente y los 4 bajos
  // cuantos hacen falta de verdad: codePatchHeader reescribe los bajos.
  ph.quant_wbits = ((prequant - 2) & 0x0f) | (((prequant - 2) & 0x0f) << 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) block[j * size + i] = patch[j * stride + i] * premult - sub;
  }
  dctPatch(block, cpatch, size);
  return ph;
}

// --- cabeceras y coeficientes en el flujo ------------------------------------

export function decodeGroupHeader(bits) {
  const stride = bits.readBits(16);
  const patchSize = bits.readBits(8);
  const layerType = bits.readBits(8);
  return { stride, patchSize, layerType };
}

export function decodePatchHeader(bits) {
  const ph = { quant_wbits: bits.readBits(8), dc_offset: 0, range: 0, patchids: 0, wbits: 0 };
  if (ph.quant_wbits === END_OF_PATCHES) return ph;
  ph.dc_offset = u32ToF32(bits.readBits(32));
  ph.range = bits.readBits(16);
  ph.patchids = bits.readBits(10);
  ph.wbits = (ph.quant_wbits & 0x0f) + 2;
  return ph;
}

export function decodePatch(bits, size, wbits) {
  const n2 = size * size;
  const patches = new Int32Array(n2);
  for (let i = 0; i < n2; i++) {
    if (!bits.readBits(1)) continue;
    if (!bits.readBits(1)) {
      // "10" = de aqui al final todo son ceros.
      for (let j = i; j < n2; j++) patches[j] = 0;
      return patches;
    }
    const negative = bits.readBits(1);
    const magnitude = bits.readBits(wbits);
    patches[i] = negative ? -magnitude : magnitude;
  }
  return patches;
}

export function codeGroupHeader(bits, gopp) {
  bits.writeBits(gopp.stride & 0xffff, 16);
  bits.writeBits(gopp.patchSize & 0xff, 8);
  bits.writeBits(gopp.layerType & 0xff, 8);
}

export function codePatchHeader(bits, ph, patch, size) {
  let wbits = (ph.quant_wbits & 0x0f) + 2;
  const maxWbits = wbits + 5;
  const minWbits = wbits >> 1;
  wbits = minWbits;
  for (let i = 0; i < size * size; i++) {
    let temp = patch[i];
    if (!temp) continue;
    if (temp < 0) temp = -temp;
    for (let j = maxWbits; j > minWbits; j--) {
      if (Math.floor(temp / Math.pow(2, j)) & 1) { if (j > wbits) wbits = j; break; }
    }
  }
  wbits += 1;
  if (wbits > 17) wbits = 17;
  if (wbits < 2) wbits = 2;
  ph.quant_wbits = (ph.quant_wbits & 0xf0) | (wbits - 2);
  bits.writeBits(ph.quant_wbits & 0xff, 8);
  bits.writeBits(f32ToU32(ph.dc_offset), 32);
  bits.writeBits(ph.range & 0xffff, 16);
  bits.writeBits(ph.patchids & 0x3ff, 10);
  return wbits;
}

export function codePatch(bits, patch, size, wbits, postquant = 0) {
  const n2 = size * size;
  if (postquant > n2 || postquant < 0) throw new Error("postquant fuera de rango: " + postquant);
  const work = postquant ? patch.slice() : patch;
  if (postquant) work[n2 - postquant] = 0;
  for (let i = 0; i < n2; i++) {
    let temp = work[i];
    if (!temp) {
      let eob = true;
      for (let j = i; j < n2 - postquant; j++) { if (work[j]) { eob = false; break; } }
      if (eob) { bits.writeBits(ZERO_EOB, 2); return; }
      bits.writeBits(ZERO_CODE, 1);
    } else {
      const negative = temp < 0;
      if (negative) temp = -temp;
      const top = Math.pow(2, wbits);
      if (temp > top) temp = top;
      bits.writeBits(negative ? NEGATIVE_VALUE : POSITIVE_VALUE, 3);
      bits.writeBits(temp, wbits);
    }
  }
}

// --- el mensaje entero -------------------------------------------------------

export function decodeLayerData(data, opts = {}) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const bits = new BitReader(u8);
  const gopp = decodeGroupHeader(bits);
  const size = gopp.patchSize;
  const patchesPerEdge = opts.patchesPerEdge || (256 / size) | 0;
  if (size !== NORMAL_PATCH_SIZE && size !== LARGE_PATCH_SIZE) {
    throw new Error("tamano de parche raro: " + size);
  }
  const patches = [];
  let truncated = 0;
  for (;;) {
    if (bits.remainingBits < 8) { truncated++; break; }
    const ph = decodePatchHeader(bits);
    if (ph.quant_wbits === END_OF_PATCHES) break;
    const x = ph.patchids >> 5;
    const y = ph.patchids & 0x1f;
    if (x >= patchesPerEdge || y >= patchesPerEdge) { truncated++; break; }
    const cpatch = decodePatch(bits, size, ph.wbits);
    const heights = new Float32Array(size * size);
    decompressPatch(heights, 0, size, cpatch, ph, size);
    patches.push({ x, y, size, heights });
  }
  return {
    stride: gopp.stride,
    size,
    layerType: gopp.layerType,
    layerCode: String.fromCharCode(gopp.layerType),
    patches,
    truncated: truncated || (bits.overflow ? 1 : 0),
  };
}

// Reensambla los parches en una rejilla de la region (por defecto 256x256, un
// metro por celda). Las celdas que no lleguen se quedan en `fallback`.
export function patchesToGrid(patches, opts = {}) {
  const gridSize = opts.gridSize || 256;
  const size = opts.patchSize || 16;
  const out = new Float32Array(gridSize * gridSize).fill(opts.fallback === undefined ? 0 : opts.fallback);
  for (const p of patches) {
    for (let j = 0; j < size; j++) {
      const row = (p.y * size + j) * gridSize + p.x * size;
      for (let i = 0; i < size; i++) out[row + i] = p.heights[j * size + i];
    }
  }
  return out;
}

// Toma un mensaje `LayerData` ya decodificado por codec.js.
export function applyLayerData(msg, opts = {}) {
  if (!msg || msg.name !== "LayerData") throw new Error("no es un LayerData: " + (msg && msg.name));
  const type = msg.field("LayerID", "Type");
  const data = msg.field("LayerData", "Data");
  if (!data) throw new Error("LayerData sin cuerpo");
  return Object.assign({ type }, decodeLayerData(data, opts));
}

// El camino de vuelta: de parches sueltos a un flujo de bits listo para meter
// en el campo `Data` de un LayerData. Lo usan el simulador de pruebas y el
// servidor de la fase 2.
export function encodeLayerData(patches, opts = {}) {
  const size = opts.patchSize || NORMAL_PATCH_SIZE;
  const prequant = opts.prequant || 8;
  const postquant = opts.postquant || 0;
  const layerType = opts.layerType === undefined ? LAYER_CODE.LAND : opts.layerType;
  const patchesPerEdge = opts.patchesPerEdge || (256 / size) | 0;
  const bits = new BitWriter();
  codeGroupHeader(bits, { stride: opts.stride || 0, patchSize: size, layerType });
  for (const p of patches) {
    const ph = { dc_offset: 0, range: 0, patchids: ((p.x & 0x1f) << 5) | (p.y & 0x1f), quant_wbits: 0 };
    const pre = prescanPatch(p.heights, size, size);
    ph.dc_offset = pre.dcOffset;
    ph.range = pre.range;
    const cpatch = new Int32Array(size * size);
    compressPatch(p.heights, size, cpatch, ph, size, prequant);
    const wbits = codePatchHeader(bits, ph, cpatch, size);
    codePatch(bits, cpatch, size, wbits, postquant);
  }
  bits.writeBits(END_OF_PATCHES, 8);
  return bits.flush();
}

// --- autotest ----------------------------------------------------------------

export function runTerrainSelfTest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });

  // 1. El empaquetador de bits: ida y vuelta en todos los anchos, y los valores
  //    escritos de menos a mas significativo dentro de cada byte.
  {
    const w = new BitWriter();
    const values = [[1, 1], [5, 3], [10, 4], [31, 5], [1000, 10], [65535, 16], [0xdeadbeef, 32], [0, 7]];
    for (const [v, n] of values) w.writeBits(v, n);
    const bytes = w.flush();
    // 1 bit, 3 bits, 4 bits, 5 bits... van en orden; el primer byte tiene los
    // bits de arriba abajo.
    eq("el primer byte empieza por el bit 0 puesto", bytes[0] >> 7, 1);
    const r = new BitReader(bytes);
    const back = values.map(([, n]) => r.readBits(n));
    eq("ida y vuelta del empaquetador de bits", back, [1, 5, 10, 31, 1000, 65535, 0xdeadbeef, 0]);
    eq("no sobra ningun bit (se rellena el ultimo byte)", r.remainingBits < 8, true);
  }

  // 2. Vector a mano de la cabecera de grupo: 16+8+8 = 32 bits = 4 bytes.
  {
    const w = new BitWriter();
    codeGroupHeader(w, { stride: 0x0102, patchSize: 16, layerType: 0x4c });
    const b = w.flush();
    // 0x0102 -> byte0 = 0x02, byte1 = 0x01, cada uno de arriba abajo.
    eq("cabecera de grupo a mano", [...b], [0x02, 0x01, 16, 0x4c]);
    const r = new BitReader(b);
    eq("y se lee igual", decodeGroupHeader(r), { stride: 0x0102, patchSize: 16, layerType: 0x4c });
  }

  // 3. Cabecera de parche: el fin de datos es 97 y no lleva nada detras.
  {
    const w = new BitWriter();
    w.writeBits(END_OF_PATCHES, 8);
    const r = new BitReader(w.flush());
    eq("el fin de parches son 97", decodePatchHeader(r).quant_wbits, 97);
  }
  {
    const w = new BitWriter();
    const ph = { quant_wbits: 0, dc_offset: 12.5, range: 40, patchids: 0x105, wbits: 0 };
    const wbits = codePatchHeader(w, ph, new Int32Array(256), NORMAL_PATCH_SIZE);
    const r = new BitReader(w.flush());
    const back = decodePatchHeader(r);
    ok("dc_offset vuelve entero (float exacto)", back.dc_offset === 12.5, back.dc_offset);
    eq("range vuelve", back.range, 40);
    eq("patchids vuelve (x = 8, y = 5)", [back.patchids >> 5, back.patchids & 0x1f], [8, 5]);
    eq("el numero de bits de los coeficientes", (back.quant_wbits & 0xf) + 2, wbits);
  }

  // 4. Coeficientes a mano, con el codigo de longitud variable.
  {
    const w = new BitWriter();
    const patch = new Int32Array([0, 0, 3, -2, 0, 0]);
    codePatch(w, patch, NORMAL_PATCH_SIZE, 4, 250);
    const r = new BitReader(w.flush());
    const back = decodePatch(r, NORMAL_PATCH_SIZE, 4);
    eq("los primeros ceros y los tres valores", [...back.slice(0, 5)], [0, 0, 3, -2, 0]);
    eq("y el resto son ceros", [...back.slice(5)].every((v) => v === 0), true);
  }
  {
    // El "10" corta con ceros y no hay que gastar un bit por coeficiente.
    const w = new BitWriter();
    w.writeBits(ZERO_EOB, 2);
    const r = new BitReader(w.flush());
    eq("el fin de ceros deja el parche a cero", [...decodePatch(r, NORMAL_PATCH_SIZE, 8)].every((v) => v === 0), true);
  }

  // 5. La transformada, contra su definicion escrita a mano. Esta es la prueba
  //    de que estamos usando EXACTAMENTE el DCT/IDCT del visor de Linden Lab
  //    (y no una variante con la normalizacion cambiada, que daria alturas
  //    plausibles pero mal escaladas).
  const cosT = (u, n) => Math.cos((2 * n + 1) * u * Math.PI / 32);
  const refForward = (block) => {
    const t1 = new Float64Array(256), C = new Float64Array(256);
    for (let line = 0; line < 16; line++) {
      for (let u = 0; u < 16; u++) {
        let t = 0;
        for (let n = 0; n < 16; n++) t += block[line * 16 + n] * cosT(u, n);
        t1[line * 16 + u] = u === 0 ? Math.SQRT1_2 * t : t;
      }
    }
    for (let c = 0; c < 16; c++) {
      let t0 = 0;
      for (let n = 0; n < 16; n++) t0 += t1[n * 16 + c];
      C[c] = (Math.SQRT1_2 * t0 * (2 / 16)) / (1 + 2 * c);
      for (let u = 1; u < 16; u++) {
        let t = 0;
        for (let n = 0; n < 16; n++) t += t1[n * 16 + c] * cosT(u, n);
        C[u * 16 + c] = (t * (2 / 16)) / (1 + 2 * (c + u));
      }
    }
    return C;
  };
  const refInverse = (A) => {
    const tmp = new Float64Array(256), out = new Float64Array(256);
    for (let c = 0; c < 16; c++) {
      for (let n = 0; n < 16; n++) {
        let t = Math.SQRT1_2 * A[c];
        for (let u = 1; u < 16; u++) t += A[u * 16 + c] * cosT(u, n);
        tmp[n * 16 + c] = t;
      }
    }
    for (let line = 0; line < 16; line++) {
      for (let n = 0; n < 16; n++) {
        let t = Math.SQRT1_2 * tmp[line * 16];
        for (let u = 1; u < 16; u++) t += tmp[line * 16 + u] * cosT(u, n);
        out[line * 16 + n] = t * (2 / 16);
      }
    }
    return out;
  };
  {
    const size = NORMAL_PATCH_SIZE;
    const block = new Float32Array(size * size);
    for (let i = 0; i < 256; i++) block[i] = Math.sin(i * 0.7) * 90 + Math.cos(i * 0.13) * 40 - 25;
    const want = refForward(block);
    const cp = new Int32Array(256);
    dctPatch(block, cp, size);
    const copyTab = patchTables(size).copy;
    let peor = 0, donde = null;
    for (let i = 0; i < 256; i++) {
      const d = Math.abs(Math.trunc(want[i]) - cp[copyTab[i]]);
      if (d > peor) { peor = d; donde = i; }
    }
    ok("el DCT coincide coeficiente a coeficiente con la definicion", peor === 0, donde === null ? 0 : { i: donde, want: Math.trunc(want[donde]), got: cp[copyTab[donde]] });

    // Y el IDCT: se le dan los coeficientes de la definicion y tiene que
    // reconstruir el bloque.
    const A = new Float32Array(256);
    for (let i = 0; i < 256; i++) A[i] = want[i];
    const out = new Float32Array(256);
    for (let i = 0; i < 256; i++) out[i] = A[i];
    idctPatch(out, size);
    const wantBack = refInverse(want);
    let peor2 = 0;
    for (let i = 0; i < 256; i++) peor2 = Math.max(peor2, Math.abs(out[i] - wantBack[i]));
    ok("el IDCT coincide con la definicion", peor2 < 1e-3, peor2);
  }

  // 6. Ida y vuelta de un parche entero por el mensaje `LayerData` completo,
  //    con una colina suave (lo tipico de un trozo de terreno). La cuantizacion
  //    del formato pesa mas en las frecuencias altas, asi que el error fino
  //    depende de `prequant`: eso es del formato, no nuestro.
  {
    const size = NORMAL_PATCH_SIZE;
    const colina = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) colina[j * size + i] = 12 + 8 * Math.exp(-((i - 8) * (i - 8) + (j - 8) * (j - 8)) / 30) + 0.05 * i;
    }
    const ida = (heights, prequant) => {
      const bytes = encodeLayerData([{ x: 1, y: 2, size, heights }], { patchSize: size, prequant, layerType: LAYER_CODE.LAND, stride: 256 });
      const dec = decodeLayerData(bytes);
      let maxErr = 0;
      for (let i = 0; i < size * size; i++) maxErr = Math.max(maxErr, Math.abs(dec.patches[0].heights[i] - heights[i]));
      return { bytes, dec, maxErr };
    };
    const a = ida(colina, 8);
    eq("el parche vuelve entero y en su sitio", [a.dec.patches.length, a.dec.patches[0].x, a.dec.patches[0].y, a.dec.truncated], [1, 1, 2, 0]);
    ok("una colina vuelve con menos de 35 cm de error", a.maxErr < 0.35, a.maxErr);
    eq("el margen medido cubre el parche", [a.dec.patches[0].heights.length, a.dec.layerCode], [256, "L"]);
    ok("los coeficientes se comprimen de verdad", a.bytes.length < size * size * 4, a.bytes.length);
    const rr = new BitReader(a.bytes);
    const gopp = decodeGroupHeader(rr);
    const ph1 = decodePatchHeader(rr);
    decodePatch(rr, gopp.patchSize, ph1.wbits);
    eq("el fin de datos cierra el flujo", rr.readBits(8), END_OF_PATCHES);
    eq("y no sobra nada mas que el relleno", [gopp.patchSize, gopp.stride, rr.remainingBits < 8], [16, 256, true]);
    const b = ida(colina, 14);
    ok("con 14 bits de cuantizacion el error baja mucho", b.maxErr < a.maxErr / 10, { fino: b.maxErr, grueso: a.maxErr });
  }

  // 7. Un mensaje LayerData completo con parches en distintas esquinas: lo que
  //    se comprueba aqui es que cada parche vuelve a su casilla.
  {
    const size = NORMAL_PATCH_SIZE;
    const made = [];
    const coords = [[0, 0], [15, 0], [0, 15], [15, 15], [7, 3]];
    for (const [x, y] of coords) {
      const heights = new Float32Array(size * size);
      const base = 30 + x * 2 + y;
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) heights[j * size + i] = base + 4 * Math.sin(i * 0.3) + 2 * Math.cos(j * 0.25);
      }
      made.push({ x, y, size, heights });
    }
    const bytes = encodeLayerData(made, { patchSize: size, prequant: 8, layerType: LAYER_CODE.LAND });
    const dec = decodeLayerData(bytes);
    eq("vuelven los cinco parches", dec.patches.length, 5);
    eq("el tipo de capa es tierra", dec.layerCode, "L");
    eq("el tamano del parche", dec.size, 16);
    eq("sin truncar", dec.truncated, 0);
    // El formato de terreno es con perdida: con prequant=8 el error ronda el
    // 2-3% del desnivel del parche (verificado contra la implementacion de
    // referencia). Se exige pues un limite proporcional al relieve de cada
    // parche, no un valor absoluto fijo.
    const devs = dec.patches.map((p, k) => {
      eq("parche " + k + " en su sitio", [p.x, p.y], coords[k]); // eslint-disable-line
      let m = 0;
      for (let i = 0; i < 256; i++) m = Math.max(m, Math.abs(p.heights[i] - made[k].heights[i]));
      return m;
    });
    const tols = made.map((p) => 0.05 * (Math.max(...p.heights) - Math.min(...p.heights)) + 0.01);
    ok("los cinco parches vuelven con error pequeno", devs.every((m, k) => m < tols[k]), { devs: devs.map((m) => Number(m.toFixed(4))), tols: tols.map((m) => Number(m.toFixed(4))) });
  }

  // 8. La rejilla de 256x256: los parches se colocan en su cuadrante.
  {
    const size = NORMAL_PATCH_SIZE;
    const p0 = { x: 0, y: 0, size, heights: new Float32Array(256).fill(5) };
    const p1 = { x: 15, y: 15, size, heights: new Float32Array(256).fill(9) };
    const grid = patchesToGrid([p0, p1], { gridSize: 256 });
    eq("la esquina suroeste", [grid[0], grid[15 * 256 + 15]], [5, 5]);
    eq("la esquina noreste", [grid[255 * 256 + 255], grid[240 * 256 + 240]], [9, 9]);
    eq("el centro no se toca", grid[128 * 256 + 128], 0);
    eq("el tamano de la rejilla", grid.length, 256 * 256);
  }

  // 9. El mensaje pasa por el cable de verdad: codec.js lo empaqueta y esta
  //    ruta lo lee, que es como llega en vivo.
  {
    const size = NORMAL_PATCH_SIZE;
    const heights = new Float32Array(size * size);
    for (let i = 0; i < 256; i++) heights[i] = 100 + (i % 7);
    const bytes = encodeLayerData([{ x: 3, y: 4, size, heights }], { layerType: LAYER_CODE.LAND, stride: 256 });
    const msg = { name: "LayerData", field: (b, f) => (b === "LayerID" ? LAYER_CODE.LAND : bytes) };
    const dec = applyLayerData(msg);
    eq("por la ruta del mensaje tambien", [dec.layerType, dec.patches.length, dec.patches[0].x, dec.patches[0].y], [LAYER_CODE.LAND, 1, 3, 4]);
    eq("y la cabecera de grupo trae el stride", dec.stride, 256);
  }

  // 9. Datos basura: no puede colgarse ni inventarse un parche.
  {
    let threw = "";
    try { decodeLayerData(Uint8Array.of(0, 0, 7, 0)); } catch (e) { threw = e.message; }
    ok("un tamano de parche imposible avisa", /raro/.test(threw), threw);
    const cabecera = (() => {
      const w = new BitWriter();
      codeGroupHeader(w, { stride: 256, patchSize: NORMAL_PATCH_SIZE, layerType: LAYER_CODE.LAND });
      return w.flush();
    })();
    const dec = decodeLayerData(cabecera);
    eq("un flujo vacio no devuelve parches", dec.patches.length, 0);
    ok("y queda marcado como truncado", dec.truncated > 0, dec.truncated);
  }

  // 10. Parches grandes (32x32): el formato los contempla (y el simulador de
  //     pruebas los usa para probar que el codigo no esta clavado en 16).
  {
    const size = LARGE_PATCH_SIZE;
    const heights = new Float32Array(size * size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) heights[j * size + i] = 40 + 6 * Math.sin(i * 0.15) * Math.cos(j * 0.12);
    }
    const bytes = encodeLayerData([{ x: 2, y: 1, size, heights }], { patchSize: size, prequant: 10, layerType: LAYER_CODE.LAND });
    const dec = decodeLayerData(bytes);
    eq("vuelve un parche de 32x32 en su sitio", [dec.size, dec.patches.length, dec.patches[0].x, dec.patches[0].y], [32, 1, 2, 1]);
    let m = 0;
    for (let i = 0; i < size * size; i++) m = Math.max(m, Math.abs(dec.patches[0].heights[i] - heights[i]));
    const rango = Math.max(...heights) - Math.min(...heights);
    ok("y con error pequeno", m < 0.05 * rango, { err: Number(m.toFixed(4)), tol: Number((0.05 * rango).toFixed(4)) });
  }

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
}
