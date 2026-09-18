// bin.js -- lectura y escritura de datos binarios para el protocolo con el
// retransmisor (src/sl/relay.js).
//
// Todo va en little-endian, como en src/net.js. `Writer` crece sola, `Reader`
// lleva su propia posicion y comprueba los limites: si un mensaje viene
// truncado lanza, en vez de devolver basura.
//
// Los UUID se mandan como 16 bytes en crudo (no como texto de 36): en un
// mensaje de objetos hay muchos y el texto casi triplica el tamano.

import { uuidToBytes, bytesToUuid } from "./llsd.js";

export class Writer {
  constructor(capacity = 64) {
    this.buf = new Uint8Array(capacity);
    this.dv = new DataView(this.buf.buffer);
    this.len = 0;
  }

  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length || 16;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }

  putU8(v) { this.ensure(1); this.buf[this.len++] = v & 0xff; return this; }
  putI8(v) { return this.putU8(v < 0 ? v + 256 : v); }
  putU16(v) { this.ensure(2); this.dv.setUint16(this.len, v & 0xffff, true); this.len += 2; return this; }
  putI16(v) { this.ensure(2); this.dv.setInt16(this.len, v | 0, true); this.len += 2; return this; }
  putU32(v) { this.ensure(4); this.dv.setUint32(this.len, v >>> 0, true); this.len += 4; return this; }
  putI32(v) { this.ensure(4); this.dv.setInt32(this.len, v | 0, true); this.len += 4; return this; }
  putF32(v) { this.ensure(4); this.dv.setFloat32(this.len, Number(v) || 0, true); this.len += 4; return this; }
  putF64(v) { this.ensure(8); this.dv.setFloat64(this.len, Number(v) || 0, true); this.len += 8; return this; }
  putBytes(b) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; return this; }
  putUuid(s) { return this.putBytes(uuidToBytes(s)); }
  // Cadena corta con la longitud en un byte (nombres, textos de chat).
  putStr(s) {
    const b = ENC.encode(String(s === undefined || s === null ? "" : s));
    const n = Math.min(b.length, 255);
    this.putU8(n).putBytes(b.subarray(0, n));
    return this;
  }
  // Cadena con la longitud en dos bytes (JSON de un objeto, textos largos).
  putStr32(s) {
    const b = ENC.encode(String(s === undefined || s === null ? "" : s));
    this.putU32(b.length).putBytes(b);
    return this;
  }
  putJson(v) { return this.putStr32(JSON.stringify(v === undefined ? null : v)); }

  bytes() { return this.buf.subarray(0, this.len); }
  copy() { return this.buf.slice(0, this.len); }
  get length() { return this.len; }
}

export class Reader {
  constructor(u8) {
    this.u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.u8.length) throw new Error("mensaje truncado (faltan " + (this.pos + n - this.u8.length) + " bytes)");
  }
  getU8() { this.need(1); return this.u8[this.pos++]; }
  getI8() { const v = this.getU8(); return v > 127 ? v - 256 : v; }
  getU16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  getI16() { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  getU32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  getI32() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  getF32() { this.need(4); const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  getF64() { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  getBytes(n) { this.need(n); const b = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  getUuid() { return bytesToUuid(this.getBytes(16)); }
  getStr() { const n = this.getU8(); return DEC.decode(this.getBytes(n)); }
  getStr32() { const n = this.getU32(); return DEC.decode(this.getBytes(n)); }
  getJson() {
    const t = this.getStr32();
    try { return JSON.parse(t); } catch (e) { throw new Error("JSON ilegible en el mensaje: " + t.slice(0, 80)); }
  }
  // Vector de 3 float32 (posiciones, escalas, rotaciones sin el w aparte).
  getVec3() { return [this.getF32(), this.getF32(), this.getF32()]; }
  get remaining() { return this.u8.length - this.pos; }
  get eof() { return this.pos >= this.u8.length; }
}

const ENC = new TextEncoder();
const DEC = new TextDecoder("utf-8", { fatal: false });

export function utf8(str) { return ENC.encode(String(str)); }
export function fromUtf8(bytes) { return DEC.decode(bytes); }
