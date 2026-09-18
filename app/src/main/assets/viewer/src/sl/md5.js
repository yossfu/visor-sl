// md5.js -- MD5 segun RFC 1321.
//
// Hace falta porque el inicio de sesion de Second Life no acepta la contrasena
// en claro: el campo `passwd` del login va como "$1$" + MD5(contrasena) en
// hexadecimal. El navegador no trae MD5 (`crypto.subtle` solo tiene SHA-1/2),
// asi que se implementa aqui. Son ~60 lineas y esta verificado contra los
// vectores de prueba del RFC (`runMd5SelfTest`).

// Tabla de constantes: parte entera de 2^32 * abs(sin(i)), i = 1..64.
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

// Desplazamientos por ronda (RFC 1321).
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

// Convierte una cadena UTF-8 a bytes.
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  return out;
}

// MD5 de un array de bytes -> Uint8Array de 16 bytes.
export function md5Bytes(bytes) {
  const len = bytes.length;
  // Relleno: un 1, ceros, y la longitud en bits al final (little-endian).
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bitLenLo = (len << 3) >>> 0;
  const bitLenHi = Math.floor(len / 536870912) >>> 0;   // len * 8 / 2^32
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLenLo, true);
  dv.setUint32(withPad.length - 4, bitLenHi, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (B & C) | (~B & D); g = i; }
      else if (i < 32) { f = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { f = C ^ (B | ~D); g = (7 * i) & 15; }
      f = (f + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl(f, S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
  return out;
}

const HEX = "0123456789abcdef";
export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}

// MD5 de una cadena (UTF-8) en hexadecimal minusculas.
export function md5Hex(str) { return toHex(md5Bytes(utf8Bytes(str))); }

// El campo `passwd` del login de SL: "$1$" + MD5(contrasena) en hex.
export function slPasswordHash(password) { return "$1$" + md5Hex(password); }

// Vectores del RFC 1321. Se ejecuta desde la consola del visor
// (`window.__sl.md5SelfTest()`) o en un worker.
export function runMd5SelfTest() {
  const cases = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"],
  ];
  let pass = 0;
  const fails = [];
  for (const [input, want] of cases) {
    const got = md5Hex(input);
    if (got === want) pass++; else fails.push({ input, want, got });
  }
  return { checks: cases.length, passed: pass, fails };
}
