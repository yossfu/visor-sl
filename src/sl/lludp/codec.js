// codec.js -- el cable de LLUDP: datagramas, cabecera, compresion por ceros y
// campos.
//
// UN DATAGRAMA, DE ARRIBA ABAJO
// -----------------------------
// Todo lo que va en MAYUSCULAS (la cabecera y el numero de mensaje) va en
// big-endian; todo lo que va en minusculas (los campos del cuerpo) va en
// little-endian. Esto no es un capricho: es como lo hace el visor de Linden Lab
// desde 2002 y hay que copiarlo tal cual.
//
//   +0  u8   banderas        (0x80 zerocoded, 0x40 fiable, 0x20 reenvio, 0x10 acks)
//   +1  u32  id de paquete   (numeracion del emisor, envuelve a los 2^32)
//   +5  u8   desplazamiento  (bytes "extra" entre el numero y los bloques)
//   +6  ...  cuerpo:  [numero de mensaje][extra][bloques...]
//   ...      y al final, si la bandera de acks esta puesta:
//            u32 ack1, u32 ack2, ..., u8 cuantos     (los acks van al reves)
//
// El numero de mensaje ocupa 1, 2 o 4 bytes segun la frecuencia (ver
// template.js), y los bloques son campos de tamano fijo salvo los de tipo
// `Variable`, que llevan delante su longitud (el ancho del campo de longitud lo
// dice la plantilla: 1, 2 o 4 bytes).
//
// LA COMPRESION POR CEROS
// -----------------------
// No es cifrado: es una codificacion de longitud de rachas para los ceros, que
// es de lo que va sobrado un datagrama (posiciones 0,0,0, cuaterniones con
// ceros, relleno...). Un cero seguido de un byte N significa "N ceros":
//
//   sin comprimir  01 00 00 00 02
//   comprimido     01 00 03 02
//
// El visor solo la usa en los mensajes cuya plantilla dice `Zerocoded`, y la
// bandera 0x80 del datagrama es la que avisa al que lo lee.

import { FREQ, BLOCK, defaultTemplates } from "./template.js";

export const FLAG = { ZEROCODED: 0x80, RELIABLE: 0x40, RESENT: 0x20, ACK: 0x10 };

// --- compresion por ceros ----------------------------------------------------

export function zeroCodeExpand(input) {
  const out = [];
  let inZero = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (out.length > 0x3000) throw new Error("mensaje comprimido por ceros demasiado grande");
    if (c === 0) {
      // Siempre se escribe el cero, por si es el ultimo byte.
      out.push(0);
      // Continuacion (el compresor de Linden Lab no la usa, pero es valida).
      if (inZero) for (let k = 0; k < 255; k++) out.push(0);
      inZero = true;
    } else if (inZero) {
      // Este byte es cuantos ceros hay que escribir (el primero ya esta puesto).
      for (let k = 0; k < c - 1; k++) out.push(0);
      inZero = false;
    } else {
      out.push(c);
    }
  }
  return Uint8Array.from(out);
}

export function zeroCodeCompress(input) {
  const out = [];
  let zeros = 0;
  const flush = () => { if (zeros) { out.push(zeros); zeros = 0; } };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === 0) {
      zeros++;
      if (zeros === 1) out.push(0);
      // El compresor oficial no usa la continuacion de 255 y ningun lector que
      // no sea el de Linden Lab la maneja bien: se corta la racha antes.
      else if (zeros === 255) flush();
    } else {
      flush();
      out.push(c);
    }
  }
  flush();
  return Uint8Array.from(out);
}

// --- identificadores ---------------------------------------------------------

const HEX = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));

export function uuidFromBytes(b, off = 0) {
  let s = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
    s += HEX[b[off + i]];
  }
  return s;
}

export function uuidToBytes(uuid) {
  const hex = String(uuid || "").replace(/-/g, "").toLowerCase();
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const v = parseInt(hex.substr(i * 2, 2), 16);
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

export const NULL_UUID = "00000000-0000-0000-0000-000000000000";

// Los campos U64/S64 del protocolo se leen como BigInt (ver `BufReader.u64`).
// Estos ayudantes convierten a `number` cuando se sabe que el valor cabe (p. ej.
// un `RegionHandle`, que nunca pasa de 2^48), y trocean/arman pares de 32 bits.
export function u64ToNumber(v) {
  return Number(v === undefined || v === null ? 0 : v);
}

export function u64Parts(v) {
  const b = typeof v === "bigint" ? BigInt.asUintN(64, v) : BigInt(Math.trunc(Number(v) || 0));
  return { hi: Number(BigInt.asUintN(32, b >> 32n)) >>> 0, lo: Number(BigInt.asUintN(32, b)) >>> 0 };
}

export function u64FromParts(hi, lo) {
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

// El `RegionHandle` del protocolo empaqueta la rejilla de la region: 32 bits
// altos = coordenada X, 32 bajos = coordenada Y (ambas en regiones de 256 m).
export function regionHandleXY(handle) {
  const { hi, lo } = u64Parts(handle);
  return { x: hi, y: lo };
}

export function regionHandleFromXY(x, y) {
  return u64FromParts(x >>> 0, y >>> 0);
}

export function utf8FromFixed(u8) {
  let end = u8.length;
  while (end > 0 && u8[end - 1] === 0) end--;
  let s = "";
  try { s = new TextDecoder("utf-8", { fatal: false }).decode(u8.subarray(0, end)); } catch (e) { s = ""; }
  return s;
}

export function fixedFromUtf8(str) {
  const b = new TextEncoder().encode(String(str === undefined || str === null ? "" : str));
  return b;
}

// --- lector / escritor little-endian ----------------------------------------

export class BufReader {
  constructor(u8, off = 0, end = u8.length) { this.buf = u8; this.p = off; this.end = end; }
  get remaining() { return this.end - this.p; }
  need(n) {
    if (this.p + n > this.end) throw new Error("el datagrama se acabo leyendo " + n + " bytes (quedaban " + this.remaining + ")");
  }
  u8() { this.need(1); return this.buf[this.p++]; }
  s8() { const v = this.u8(); return v > 127 ? v - 256 : v; }
  u16() { this.need(2); const v = this.buf[this.p] | (this.buf[this.p + 1] << 8); this.p += 2; return v; }
  s16() { const v = this.u16(); return v > 32767 ? v - 65536 : v; }
  u32() { this.need(4); const b = this.buf, p = this.p; this.p += 4; return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; }
  s32() { this.need(4); const b = this.buf, p = this.p; this.p += 4; return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)); }
  u64() {
    this.need(8);
    const lo = this.u32();
    const hi = this.u32();
    // Los enteros de 64 bits no caben en un `number` de JavaScript sin perder
    // precision (2^53), y en el protocolo hay valores que SI los usan: el
    // `RegionHandle` o los `GroupPowers` con todos los bits puestos, por
    // ejemplo. Se devuelven como BigInt para no corromperlos al reescribir.
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
  s64() {
    const b = this.u64();
    return b >= 9223372036854775808n ? b - 18446744073709551616n : b;
  }
  f32() { this.need(4); const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.p, 4).getFloat32(0, true); this.p += 4; return v; }
  f64() { this.need(8); const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.p, 8).getFloat64(0, true); this.p += 8; return v; }
  bytes(n) { this.need(n); const v = this.buf.subarray(this.p, this.p + n); this.p += n; return v; }
  skip(n) { this.need(n); this.p += n; }
}

export class BufWriter {
  constructor(cap = 128) { this.buf = new Uint8Array(cap); this.n = 0; }
  grow(extra) {
    if (this.n + extra <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }
  u8(v) { this.grow(1); this.buf[this.n++] = v & 0xff; return this; }
  u16(v) { this.grow(2); this.buf[this.n++] = v & 0xff; this.buf[this.n++] = (v >> 8) & 0xff; return this; }
  u32(v) { this.grow(4); const x = v >>> 0; this.buf[this.n++] = x & 0xff; this.buf[this.n++] = (x >>> 8) & 0xff; this.buf[this.n++] = (x >>> 16) & 0xff; this.buf[this.n++] = (x >>> 24) & 0xff; return this; }
  u64(v) {
    const b = typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v) || 0));
    return this.u32(Number(BigInt.asUintN(32, b))).u32(Number(BigInt.asUintN(32, b >> 32n)));
  }
  f32(v) { this.grow(4); new DataView(this.buf.buffer).setFloat32(this.n, v || 0, true); this.n += 4; return this; }
  f64(v) { this.grow(8); new DataView(this.buf.buffer).setFloat64(this.n, v || 0, true); this.n += 8; return this; }
  bytes(b) { this.grow(b.length); this.buf.set(b, this.n); this.n += b.length; return this; }
  build() { return this.buf.slice(0, this.n); }
}

// --- campos ------------------------------------------------------------------
//
// Los vectores se representan como arrays [x, y, z] (y [x, y, z, w] para los de
// cuatro), los cuaterniones como [x, y, z, w] y los uuid como texto. Los campos
// `Variable`/`Fixed` son `Uint8Array` en crudo: `utf8FromFixed()` los pasa a
// texto, porque casi siempre son cadenas terminadas en cero.

function readValue(r, type, size) {
  switch (type) {
    case "U8": return r.u8();
    case "U16": return r.u16();
    case "U32": return r.u32();
    case "U64": return r.u64();
    case "S8": return r.s8();
    case "S16": return r.s16();
    case "S32": return r.s32();
    case "S64": return r.s64();
    case "F32": return r.f32();
    case "F64": return r.f64();
    case "BOOL": return r.u8() !== 0;
    case "IPADDR": { const b = r.bytes(4); return b[0] + "." + b[1] + "." + b[2] + "." + b[3]; }
    // El puerto va en orden de red, como el de un socket (es el unico campo que
    // no es little-endian, por eso el visor lo trata aparte).
    case "IPPORT": { const a = r.u8(), b = r.u8(); return (a << 8) | b; }
    case "LLVector3": return [r.f32(), r.f32(), r.f32()];
    case "LLVector3d": return [r.f64(), r.f64(), r.f64()];
    case "LLVector4": return [r.f32(), r.f32(), r.f32(), r.f32()];
    case "LLQuaternion": {
      const x = r.f32(), y = r.f32(), z = r.f32();
      // En el cable solo viajan tres componentes: la cuarta se deduce. Puede
      // venir de un cuaternion normalizado con w negativa, pero el visor de
      // Linden Lab siempre trabaja con la w positiva.
      const s = 1 - x * x - y * y - z * z;
      return [x, y, z, s > 0 ? Math.sqrt(s) : 0];
    }
    case "LLUUID": { const b = r.bytes(16); return uuidFromBytes(b, 0); }
    default: throw new Error("tipo de campo desconocido: " + type);
  }
}

export function readField(r, v) {
  if (v.type === "Variable") {
    const n = readLength(r, v.size);
    return r.bytes(n);
  }
  if (v.type === "Fixed") return r.bytes(v.size);
  return readValue(r, v.type, v.size);
}

function readLength(r, width) {
  if (width === 1) return r.u8();
  if (width === 2) return r.u16();
  if (width === 4) return r.u32();
  if (width === 8) return r.u64();
  throw new Error("ancho de longitud raro: " + width);
}

function writeLength(w, width, n) {
  if (width === 1) w.u8(n);
  else if (width === 2) w.u16(n);
  else if (width === 4) w.u32(n);
  else if (width === 8) w.u64(n);
  else throw new Error("ancho de longitud raro: " + width);
}

function writeValue(w, value, type) {
  switch (type) {
    case "U8": case "S8": case "BOOL": w.u8(value ? (typeof value === "boolean" ? 1 : value) : 0); break;
    case "U16": case "S16": w.u16(value | 0); break;
    case "U32": case "S32": w.u32(value | 0); break;
    case "U64": case "S64": w.u64(value || 0); break;
    case "F32": w.f32(value || 0); break;
    case "F64": w.f64(value || 0); break;
    case "IPADDR": {
      const p = String(value || "0.0.0.0").split(".").map(Number);
      w.bytes(Uint8Array.of(p[0] || 0, p[1] || 0, p[2] || 0, p[3] || 0));
      break;
    }
    case "IPPORT": { const n = value | 0; w.u8((n >> 8) & 0xff).u8(n & 0xff); break; }
    case "LLVector3": case "LLVector4": case "LLVector3d": {
      const a = value || [];
      const f = type === "LLVector3d" ? "f64" : "f32";
      const n = type === "LLVector4" ? 4 : 3;
      for (let i = 0; i < n; i++) w[f](a[i] || 0);
      break;
    }
    case "LLQuaternion": {
      const q = value || [];
      // Solo tres componentes: el receptor recalcula la cuarta.
      w.f32(q[0] || 0).f32(q[1] || 0).f32(q[2] || 0);
      break;
    }
    case "LLUUID": w.bytes(uuidToBytes(value)); break;
    default: throw new Error("tipo de campo desconocido: " + type);
  }
}

export function writeField(w, value, v) {
  if (v.type === "Variable") {
    let b = fieldBytes(value);
    // Los campos `Variable` que llevan TEXTO van con su byte NUL al final, y ese
    // NUL CUENTA en la longitud (es lo que hace `LLMessageSystem::addString`, y
    // por eso en las capturas reales el nombre "Izanagi" mide 8 bytes). Los
    // campos que llevan datos binarios (TextureEntry, NameValue, ExtraParams)
    // van tal cual, sin NUL: esa distincion es la que separa `addString` de
    // `addBinaryData` en el visor de Linden Lab. Como aqui el valor llega ya sea
    // como texto o como bytes, el tipo del valor lo dice: la longitud se calcula
    // DESPUES de añadir el terminador, para que cuadre con el simulador.
    if (typeof value === "string") b = conTerminador(b);
    writeLength(w, v.size, b.length);
    w.bytes(b);
    return;
  }
  if (v.type === "Fixed") {
    const b = fieldBytes(value, v.size);
    w.bytes(b);
    return;
  }
  writeValue(w, value, v.type);
}

// Añade el terminador NUL de los campos de texto si no lo traen ya.
function conTerminador(b) {
  if (b.length && b[b.length - 1] === 0) return b;
  const out = new Uint8Array(b.length + 1);
  out.set(b);
  return out;
}

function fieldBytes(value, exact) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const b = fixedFromUtf8(value);
    if (exact === undefined) return b;
    const out = new Uint8Array(exact);
    out.set(b.subarray(0, Math.min(b.length, exact)));
    return out;
  }
  if (Array.isArray(value)) return Uint8Array.from(value);
  const n = exact === undefined ? 0 : exact;
  return new Uint8Array(n);
}

// --- el datagrama ------------------------------------------------------------

export function readMsgNum(body) {
  let nff = 0;
  while (nff < 3 && body[nff] === 0xff) nff++;
  let num, len;
  switch (nff) {
    case 0: num = body[0]; len = 1; break;
    case 1: num = body[1]; len = 2; break;
    case 2: num = (body[2] << 8) | body[3]; len = 4; break;
    default: num = (0xffffff00 | body[3]) >>> 0; len = 4; break;
  }
  return { freq: nff, num, len };
}

// Lee un datagrama entero. `templates` es opcional (por defecto, la tabla real).
export function decodePacket(data, templates) {
  const t = templates || defaultTemplates();
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < 7) throw new Error("datagrama demasiado corto (" + u8.length + " bytes)");

  const flags = u8[0];
  const packetId = ((u8[1] << 24) | (u8[2] << 16) | (u8[3] << 8) | u8[4]) >>> 0;
  const offset = u8[5];

  let end = u8.length;
  const acks = [];
  if (flags & FLAG.ACK) {
    if (end < 1) throw new Error("datagrama con acks pero sin cola");
    const n = u8[end - 1];
    const start = end - 1 - n * 4;
    if (start < 6) throw new Error("los acks se salen del datagrama");
    for (let i = 0; i < n; i++) {
      const p = start + i * 4;
      acks.unshift(((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0);
    }
    end = start;
  }

  let body = u8.subarray(6, end);
  if (flags & FLAG.ZEROCODED) body = zeroCodeExpand(body);

  const mn = readMsgNum(body);
  const msg = new LludpMessage(t.byPair(mn.freq, mn.num), flags, packetId, acks);
  if (!msg.template) {
    const err = new Error("mensaje desconocido en el cable: frecuencia " + mn.freq + " numero " + mn.num);
    err.freq = mn.freq;
    err.num = mn.num;
    err.flags = flags;
    throw err;
  }
  parseBody(msg, body, mn.len + offset, templates);
  return msg;
}

class LludpMessage {
  constructor(template, flags, packetId, acks) {
    this.template = template;
    this.name = template ? template.name : null;
    this.freq = template ? template.freq : -1;
    this.num = template ? template.num : -1;
    this.flags = flags;
    this.packetId = packetId;
    this.acks = acks || [];
    this.blocks = {};
    this.order = [];
  }
  // Crea la lista de un bloque (o la devuelve si ya existe) y anade un bloque
  // vacio, en el orden del cable.
  add(blockName, vars) {
    const list = this.blocks[blockName] || (this.blocks[blockName] = []);
    const b = Object.assign({}, vars || {});
    list.push(b);
    this.order.push({ name: blockName, block: b });
    return b;
  }
  list(blockName) { return this.blocks[blockName] || []; }
  count(blockName) { return this.list(blockName).length; }
  has(blockName) { return this.count(blockName) > 0; }
  first(blockName) { return this.list(blockName)[0] || null; }
  field(blockName, fieldName, i = 0) {
    const b = this.list(blockName)[i];
    return b ? b[fieldName] : undefined;
  }
  // Atajo para el unico bloque de un mensaje sencillo.
  only(blockName) { return this.first(blockName || (this.template && this.template.blocks[0].name)); }
}

function parseBody(msg, body, start, templates) {
  const r = new BufReader(body, 0, body.length);
  r.skip(start);
  for (const tb of msg.template.blocks) {
    // Puede acabarse antes de un bloque: hay bloques Single que son opcionales
    // (el EstateBlock de ImprovedInstantMessage, por ejemplo).
    if (r.remaining === 0) break;
    let repeat;
    if (tb.type === BLOCK.SINGLE) repeat = 1;
    else if (tb.type === BLOCK.MULTIPLE) repeat = tb.count;
    else repeat = r.u8();
    for (let i = 0; i < repeat; i++) {
      const b = msg.add(tb.name);
      let ranOff = false;
      for (const v of tb.vars) {
        try {
          b[v.name] = readField(r, v);
        } catch (e) {
          // Se acabo el datagrama a mitad de un bloque: se quita el bloque a
          // medias para que no quede un bloque fantasma.
          msg.blocks[tb.name].pop();
          if (!msg.blocks[tb.name].length) delete msg.blocks[tb.name];
          const k = msg.order.lastIndexOf(b);
          if (k >= 0) msg.order.splice(k, 1);
          ranOff = true;
          break;
        }
      }
      if (ranOff) break;
    }
  }
  msg.trailing = r.remaining;
  return msg;
}

// Escribe un datagrama. `args` = { name, blocks, flags, packetId, acks, extra,
// zerocoded }.
export function encodePacket(args, templates) {
  const t = templates || defaultTemplates();
  const tpl = t.byName(args.name);
  if (!tpl) throw new Error("mensaje desconocido al escribir: " + args.name);
  const acks = args.acks || [];
  const zerocoded = args.zerocoded === undefined ? tpl.zerocoded : !!args.zerocoded;
  let flags = args.flags || 0;
  if (zerocoded) flags |= FLAG.ZEROCODED;
  if (acks.length) flags |= FLAG.ACK;

  const extra = args.extra instanceof Uint8Array ? args.extra : new Uint8Array(0);
  const body = new BufWriter(256);
  body.bytes(tpl.numBytes);
  body.bytes(extra);

  const blocks = args.blocks || {};
  // Los bloques que van DESPUES del ultimo que lleva datos no se escriben. El
  // simulador de Linden Lab omite los bloques `Variable` vacios del final, y las
  // capturas reales lo confirman: ImprovedInstantMessage no lleva su bloque
  // MetaData y AvatarAppearance no lleva AttachmentBlock. El receptor corta en
  // cuanto se le acaba el datagrama (`parseBody`), asi que omitirlos reproduce
  // el cable byte a byte.
  let ultimo = -1;
  for (let i = 0; i < tpl.blocks.length; i++) {
    const l = blocks[tpl.blocks[i].name];
    if (l && l.length) ultimo = i;
  }
  for (let bi = 0; bi <= ultimo; bi++) {
    const tb = tpl.blocks[bi];
    const list = blocks[tb.name] || [];
    if (tb.type === BLOCK.MULTIPLE && list.length && list.length !== tb.count) {
      throw new Error(tpl.name + ": " + tb.name + " espera " + tb.count + " bloques y hay " + list.length);
    }
    const n = tb.type === BLOCK.SINGLE ? 1 : tb.type === BLOCK.MULTIPLE ? tb.count : list.length;
    if (tb.type === BLOCK.VARIABLE) body.u8(list.length);
    // Un bloque fijo (`Single`/`Multiple`) que falte se escribe en ceros: el
    // visor de Linden Lab vuelca siempre los bloques fijos, aunque nadie los
    // haya rellenado (la memoria va a cero).
    for (let i = 0; i < n; i++) {
      const b = list[i] || {};
      for (const v of tb.vars) writeField(body, b[v.name], v);
    }
  }

  let payload = body.build();
  if (zerocoded) payload = zeroCodeCompress(payload);

  const out = new BufWriter(payload.length + 16);
  out.u8(flags);
  // La cabecera (banderas, id de paquete, desplazamiento) va en big-endian.
  const pid = (args.packetId || 0) >>> 0;
  out.u8((pid >>> 24) & 0xff).u8((pid >>> 16) & 0xff).u8((pid >>> 8) & 0xff).u8(pid & 0xff);
  out.u8(extra.length);
  out.bytes(payload);
  if (acks.length) {
    for (let i = acks.length - 1; i >= 0; i--) {
      const a = acks[i] >>> 0;
      out.u8((a >>> 24) & 0xff).u8((a >>> 16) & 0xff).u8((a >>> 8) & 0xff).u8(a & 0xff);
    }
    out.u8(acks.length & 0xff);
  }
  return out.build();
}

// --- autotest ----------------------------------------------------------------

export function runCodecSelfTest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });
  const t = defaultTemplates();

  // 1. Compresion por ceros: vector a mano y ida y vuelta.
  eq("comprimir ceros: vector a mano", [...zeroCodeCompress(Uint8Array.of(1, 0, 0, 0, 2))], [1, 0, 3, 2]);
  eq("expandir ceros: vector a mano", [...zeroCodeExpand(Uint8Array.of(1, 0, 3, 2))], [1, 0, 0, 0, 2]);
  eq("comprimir sin ceros", [...zeroCodeCompress(Uint8Array.of(9, 8, 7))], [9, 8, 7]);
  eq("expandir sin ceros", [...zeroCodeExpand(Uint8Array.of(9, 8, 7))], [9, 8, 7]);
  const larga = new Uint8Array(700);
  for (let i = 0; i < larga.length; i++) larga[i] = i % 3 === 0 ? 0 : (i & 0x7f) + 1;
  eq("ida y vuelta con una racha de mas de 255 ceros",
    [...zeroCodeExpand(zeroCodeCompress(larga))], [...larga]);
  const muchosCeros = new Uint8Array(600);
  ok("600 ceros comprimen bien y vuelven enteros",
    [...zeroCodeExpand(zeroCodeCompress(muchosCeros))].length === 600);

  // 2. Un mensaje sencillo: RegionHandshakeReply (Low 149). Su plantilla dice
  //    `Zerocoded`, asi que se escribe sin comprimir a proposito para poder
  //    mirar el numero crudo en el cable: con compresion, el cero de 0xFFFF0095
  //    se colapsa con el cero siguiente y el numero no se ve tal cual (que es
  //    justo lo que tiene que pasar).
  const agent = "11111111-2222-3333-4444-555555555555";
  const sesion = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const raw = encodePacket({
    name: "RegionHandshakeReply", packetId: 7, zerocoded: false,
    blocks: { AgentData: [{ AgentID: agent, SessionID: sesion }], RegionInfo: [{ Flags: 0x20 }] },
  });
  eq("el numero va despues de la cabecera", [...raw.subarray(6, 10)], [0xff, 0xff, 0x00, 0x95]);
  const rawComprimido = encodePacket({
    name: "RegionHandshakeReply", packetId: 8,
    blocks: { AgentData: [{ AgentID: agent, SessionID: sesion }], RegionInfo: [{ Flags: 0x20 }] },
  });
  eq("comprimido, el cero del numero se colapsa",
    [...rawComprimido.subarray(6, 11)], [0xff, 0xff, 0x00, 0x01, 0x95]);
  eq("el desplazamiento es cero", raw[5], 0);
  const d = decodePacket(raw);
  eq("se lee el nombre", d.name, "RegionHandshakeReply");
  eq("se lee el id de paquete", d.packetId, 7);
  eq("se lee el agente", d.field("AgentData", "AgentID"), agent);
  eq("se lee la sesion", d.field("AgentData", "SessionID"), sesion);
  eq("se leen las banderas", d.field("RegionInfo", "Flags"), 0x20);
  eq("no queda nada por leer", [d.trailing, d.acks], [0, []]);

  // 3. Acks: van al final, al reves, con la cuenta detras.
  const conAcks = encodePacket({
    name: "CompletePingCheck", packetId: 3, acks: [10, 11],
    blocks: { PingID: [{ PingID: 5 }] },
  });
  const da = decodePacket(conAcks);
  eq("los acks llegan", da.acks, [10, 11]);
  eq("y el cuerpo llega igual", da.field("PingID", "PingID"), 5);
  eq("la bandera de acks esta puesta", (da.flags & FLAG.ACK) !== 0, true);
  const conUno = decodePacket(encodePacket({ name: "CompletePingCheck", packetId: 4, acks: [0xdeadbeef], blocks: { PingID: [{ PingID: 1 }] } }));
  eq("un ack grande no se confunde con el cuerpo", conUno.acks, [0xdeadbeef]);

  // 4. Cadenas: los campos `Variable` llevan su longitud delante.
  const chat = encodePacket({
    name: "ChatFromViewer", packetId: 9,
    blocks: {
      AgentData: [{ AgentID: agent, SessionID: sesion }],
      ChatData: [{ Message: "cañón 🛰️", Type: 1, Channel: 0 }],
    },
  });
  const dc = decodePacket(chat);
  eq("el mensaje de chat vuelve entero", utf8FromFixed(dc.field("ChatData", "Message")), "cañón 🛰️");
  eq("y el canal", dc.field("ChatData", "Channel"), 0);
  eq("ChatFromViewer va comprimido (lo dice su plantilla)", (dc.flags & FLAG.ZEROCODED) !== 0, true);
  eq("el chat comprimido ocupa menos que a pelo", chat.length < 34 + 40, true);

  // 5. Cuaterniones y vectores: la cuarta componente se recalcula.
  const s = Math.sqrt(0.5);
  const au = encodePacket({
    name: "AgentUpdate", packetId: 12,
    blocks: {
      AgentData: [{
        AgentID: agent, SessionID: sesion,
        BodyRotation: [0, s, 0, s], HeadRotation: [0, 0, 0, 1],
        State: 0, CameraCenter: [1, 2, 3], CameraAtAxis: [1, 0, 0], CameraLeftAxis: [0, 1, 0],
        CameraUpAxis: [0, 0, 1], Far: 128, ControlFlags: 0, Flags: 0,
      }],
    },
  });
  const dau = decodePacket(au);
  const q = dau.field("AgentData", "BodyRotation");
  ok("el cuaternion vuelve con la w recalculada",
    Math.abs(q[0]) < 1e-6 && Math.abs(q[1] - s) < 1e-6 && Math.abs(q[2]) < 1e-6 && Math.abs(q[3] - s) < 1e-6, q);
  eq("el vector de la camara", dau.field("AgentData", "CameraCenter"), [1, 2, 3]);
  eq("la distancia de dibujado", dau.field("AgentData", "Far"), 128);

  // 6. Bloques variables (PacketAck lleva una lista de u32) y frecuencia Fixed.
  const ackMsg = encodePacket({
    name: "PacketAck", packetId: 20,
    blocks: { Packets: [{ ID: 1 }, { ID: 2 }, { ID: 0xfffffffe }] },
  });
  eq("PacketAck lleva su numero Fixed", [...ackMsg.subarray(6, 10)], [0xff, 0xff, 0xff, 0xfb]);
  const dack = decodePacket(ackMsg);
  eq("se leen los tres acks", dack.list("Packets").map((b) => b.ID), [1, 2, 0xfffffffe]);
  eq("PacketAck no va comprimido", (dack.flags & FLAG.ZEROCODED) !== 0, false);

  // 7. Un mensaje de muchas formas: UseCircuitCode (Low, uuid + codigo).
  const ucc = encodePacket({
    name: "UseCircuitCode", packetId: 1,
    blocks: { CircuitCode: [{ Code: 123456, SessionID: sesion, ID: agent }] },
  });
  eq("UseCircuitCode en el cable", [...ucc.subarray(0, 8)], [0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0xff, 0xff]);
  const ducc = decodePacket(ucc);
  eq("el codigo del circuito", ducc.field("CircuitCode", "Code"), 123456);
  eq("uuid = 16 bytes", ucc.length - (6 + 4), 4 + 16 + 16);

  // 8. Un datagrama sin bandera de compresion pero con ceros tiene que leerse
  //    igual: la compresion la decide la bandera, no el contenido.
  const sinFlag = encodePacket({
    name: "RegionHandshakeReply", packetId: 2, zerocoded: false,
    blocks: { AgentData: [{ AgentID: NULL_UUID, SessionID: NULL_UUID }], RegionInfo: [{ Flags: 0 }] },
  });
  const dsf = decodePacket(sinFlag);
  eq("sin comprimir tambien se lee", [dsf.field("AgentData", "AgentID"), dsf.field("RegionInfo", "Flags")], [NULL_UUID, 0]);

  // 9. Y al reves: comprimido de verdad (la mayoria de ceros son un tercio del
  //    tamano).
  const sinComprimir = encodePacket({ name: "RegionHandshakeReply", packetId: 2, zerocoded: false,
    blocks: { AgentData: [{ AgentID: NULL_UUID, SessionID: NULL_UUID }], RegionInfo: [{ Flags: 0 }] } });
  const comprimido = encodePacket({ name: "RegionHandshakeReply", packetId: 2, zerocoded: true,
    blocks: { AgentData: [{ AgentID: NULL_UUID, SessionID: NULL_UUID }], RegionInfo: [{ Flags: 0 }] } });
  ok("un cuerpo lleno de ceros encoge al comprimirlo", comprimido.length < sinComprimir.length, comprimido.length + " < " + sinComprimir.length);
  eq("y se lee igual", decodePacket(comprimido).field("AgentData", "SessionID"), NULL_UUID);

  // 10. Errores: ni basura silenciosa ni cuelgues.
  let threw = "";
  try { decodePacket(Uint8Array.of(1, 2, 3)); } catch (e) { threw = e.message; }
  ok("un datagrama corto avisa", /demasiado corto/.test(threw), threw);
  threw = "";
  try { decodePacket(Uint8Array.of(0, 0, 0, 0, 1, 0, 0xf1, 0x00)); } catch (e) { threw = e.message; }
  ok("un mensaje que no existe avisa", /desconocido/.test(threw), threw);
  threw = "";
  try { encodePacket({ name: "NoExiste", blocks: {} }); } catch (e) { threw = e.message; }
  ok("escribir un mensaje que no existe avisa", /desconocido/.test(threw), threw);
  threw = "";
  try {
    encodePacket({ name: "TestMessage", blocks: { TestBlock1: [{ Test1: 1 }], NeighborBlock: [{ Test0: 1 }] } });
  } catch (e) { threw = e.message; }
  ok("un bloque Multiple con menos bloques de los que toca avisa", /espera 4 bloques/.test(threw), threw);

  // 11. Todos los mensajes de la plantilla se pueden escribir y leer con todos
  //     sus campos: es la prueba de que la tabla y el codigo estan de acuerdo.
  let probados = 0;
  const fallos = [];
  for (const m of t.messages) {
    if (!m.blocks.length) continue;
    const blocks = {};
    for (const b of m.blocks) {
      const n = b.type === BLOCK.MULTIPLE ? b.count : 1;
      blocks[b.name] = [];
      for (let i = 0; i < n; i++) {
        const o = {};
        for (const v of b.vars) o[v.name] = valorDePrueba(v);
        blocks[b.name].push(o);
      }
    }
    try {
      const enc = encodePacket({ name: m.name, packetId: 1, blocks });
      const dec = decodePacket(enc);
      if (dec.name !== m.name) throw new Error("volvio como " + dec.name);
      probados++;
    } catch (e) {
      fallos.push(m.name + ": " + e.message);
    }
  }
  ok("se escriben y se leen los 475 mensajes con datos", probados >= 475, probados);
  eq("sin fallos en ningun mensaje", fallos.slice(0, 6), []);

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
}

// Un valor valido y no nulo para cada tipo: sirve para la prueba de todos los
// mensajes (y para el simulador de pruebas).
export function valorDePrueba(v) {
  switch (v.type) {
    case "U8": return 7;
    case "U16": return 300;
    case "U32": return 70000;
    case "U64": return 4294967296;
    case "S8": return -7;
    case "S16": return -300;
    case "S32": return -70000;
    case "S64": return -4294967296;
    case "F32": return 1.5;
    case "F64": return -2.25;
    case "BOOL": return true;
    case "IPADDR": return "203.0.113.10";
    case "IPPORT": return 13000;
    case "LLVector3": case "LLVector3d": return [1, -2, 3];
    case "LLVector4": return [1, -2, 3, 4];
    case "LLQuaternion": return [0, 0, 0, 1];
    case "LLUUID": return "12345678-9abc-def0-1234-56789abcdef0";
    case "Variable": case "Fixed": return v.size === 4 ? "abc" : "hola";
    default: return 0;
  }
}
