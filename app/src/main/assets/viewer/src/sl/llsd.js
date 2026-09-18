// llsd.js -- LLSD: el formato de datos de Second Life (Linden Lab Structured
// Data). Es lo que hablan el login, las "capabilities" (HTTP) y la cola de
// eventos; sin esto no se puede hablar con un grid de SL.
//
// Se implementan las cuatro formas que hacen falta:
//
//   XML-RPC     el dialecto del login (`<methodCall>`, `<struct>`, `<member>`).
//   LLSD-XML    el dialecto de `<llsd><map><key>` (el de las capabilities).
//   LLSD binario  el del cuerpo de los POST de la cola de eventos.
//   Notacion    texto compacto `{k:v,...}`; llega dentro del login, en el campo
//               `home` (que es una cadena con un mapa en notacion).
//
// Los valores de JS se mapean casi directamente: `undefined` = indefinido,
// boolean, number (entero si es integral, real si no), string, Date, Array y
// Object. Los tipos que JS no tiene se envuelven: Llsd.uuid(), Llsd.uri(),
// Llsd.binary(), Llsd.real() y Llsd.at(). Al leer, el parser devuelve esas
// mismas envolturas, para que un ciclo leer->escribir no pierda el tipo.

// --- envolturas de los tipos que JS no representa ---------------------------

export class LlsdUuid {
  constructor(v) { this.value = String(v).toLowerCase(); }
  toString() { return this.value; }
}
export class LlsdUri {
  constructor(v) { this.value = String(v); }
  toString() { return this.value; }
}
export class LlsdDate {
  // Acepta un Date o segundos desde la epoca.
  constructor(v) { this.date = v instanceof Date ? v : new Date(Number(v) * 1000); }
  toString() { return this.date.toISOString(); }
}
export class LlsdBinary {
  constructor(bytes) { this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); }
}
export class LlsdReal {
  // Fuerza la codificacion como real aunque el numero sea integral.
  constructor(v) { this.value = Number(v); }
}
class LlsdUndef {
  toString() { return "!undefined"; }
}

export const Llsd = {
  uuid: (v) => new LlsdUuid(v),
  uri: (v) => new LlsdUri(v),
  date: (v) => new LlsdDate(v),
  binary: (b) => new LlsdBinary(b),
  real: (v) => new LlsdReal(v),
  undef: () => new LlsdUndef(),
};

const isUndef = (v) => v === undefined || v === null || v instanceof LlsdUndef;
export const isUuid = (v) => v instanceof LlsdUuid;
export const isUri = (v) => v instanceof LlsdUri;
export const isBinary = (v) => v instanceof LlsdBinary;
export const isDate = (v) => v instanceof LlsdDate;

// Los UUID de SL se escriben con guiones; el binario los guarda en crudo.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function uuidToBytes(s) {
  const hex = String(s).replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export function bytesToUuid(b) {
  const h = [];
  for (let i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
  const s = h.join("");
  return s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) + "-" + s.slice(16, 20) + "-" + s.slice(20);
}

// --- texto ------------------------------------------------------------------

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]
  ));
}

function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(str) {
  const bin = atob(String(str).replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(str) { return new TextEncoder().encode(str); }
function fromUtf8(bytes) { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }

// --- LLSD binario -----------------------------------------------------------
//
// Cada valor empieza por un byte de tipo:
//   !          indefinido
//   0 / 1      falso / verdadero
//   i + i32    entero (big-endian)
//   r + f64    real   (big-endian)
//   u + 16 B   uuid
//   s + i32 + utf8        cadena
//   l + i32 + utf8        uri
//   b + i32 + bytes       binario
//   d + f64    fecha (segundos desde la epoca)
//   [ + i32 + valores + ]          lista
//   { + i32 + (clave, valor)... + }  mapa, con la clave como `k` + i32 + utf8
// El flujo puede empezar por la cabecera `<?llsd/binary?>\n`.

const BIN_HEADER = "<?llsd/binary?>\n";

export function toBinary(value, opts) {
  const withHeader = !opts || opts.header !== false;
  const chunks = [];
  let len = 0;
  const put = (u8) => { chunks.push(u8); len += u8.length; };

  function enc(v) {
    if (isUndef(v)) { put(new Uint8Array([0x21])); return; }                    // !
    if (v instanceof LlsdReal) v = v.value;
    if (typeof v === "boolean") { put(new Uint8Array([v ? 0x31 : 0x30])); return; }
    if (typeof v === "number") {
      if (Number.isInteger(v) && !(v instanceof LlsdReal)) {
        const b = new Uint8Array(5); b[0] = 0x69; new DataView(b.buffer).setInt32(1, v, false); put(b);
      } else {
        const b = new Uint8Array(9); b[0] = 0x72; new DataView(b.buffer).setFloat64(1, v, false); put(b);
      }
      return;
    }
    if (v instanceof LlsdUuid) { const b = new Uint8Array(17); b[0] = 0x75; b.set(uuidToBytes(v.value), 1); put(b); return; }
    if (v instanceof LlsdUri) { put(withLen(0x6c, utf8(v.value))); return; }
    if (v instanceof LlsdDate) {
      const b = new Uint8Array(9); b[0] = 0x64;
      new DataView(b.buffer).setFloat64(1, v.date.getTime() / 1000, false); put(b); return;
    }
    if (v instanceof LlsdBinary) { put(withLen(0x62, v.bytes)); return; }
    if (typeof v === "string") { put(withLen(0x73, utf8(v))); return; }
    if (Array.isArray(v)) {
      put(tagI32(0x5b, v.length));
      for (const item of v) enc(item);
      put(new Uint8Array([0x5d])); return;
    }
    if (v instanceof Uint8Array) { put(withLen(0x62, v)); return; }
    if (typeof v === "object") {
      const keys = Object.keys(v);
      put(tagI32(0x7b, keys.length));
      for (const k of keys) { put(withLen(0x6b, utf8(k))); enc(v[k]); }
      put(new Uint8Array([0x7d])); return;
    }
    throw new Error("llsd: no se puede codificar " + typeof v);
  }

  function withLen(tag, bytes) {
    const b = new Uint8Array(5 + bytes.length);
    b[0] = tag;
    new DataView(b.buffer).setInt32(1, bytes.length, false);
    b.set(bytes, 5);
    return b;
  }
  function tagI32(tag, n) {
    const b = new Uint8Array(5);
    b[0] = tag;
    new DataView(b.buffer).setInt32(1, n, false);
    return b;
  }

  enc(value);
  const body = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { body.set(c, off); off += c.length; }
  if (!withHeader) return body;
  const head = utf8(BIN_HEADER);
  const out = new Uint8Array(head.length + body.length);
  out.set(head); out.set(body, head.length);
  return out;
}

// Cabecera opcional. El visor escribe `<? LLSD/Binary ?>` (con espacios y
// mayusculas) y los bloques comprimidos de dentro de un `.llm` no llevan
// ninguna, asi que se acepta todo: con o sin espacios, con o sin salto de
// linea, y en cualquier combinacion de mayusculas.
const BINARY_HEADER_RE = /^<\?\s*llsd\/binary\s*\?>/i;

// Igual que `parseBinary`, pero devuelve ademas por donde iba el cursor. Hace
// falta para leer contenedores (como un `.llm`) cuyos desplazamientos se miden
// desde el final de la cabecera.
export function parseBinaryAt(data, start = 0) {
  let bytes = data;
  if (typeof bytes === "string") bytes = utf8(bytes);
  let off = start;
  if (bytes[off] === 0x3c) {
    const head = fromUtf8(bytes.subarray(off, Math.min(bytes.length, off + 20)));
    const m = BINARY_HEADER_RE.exec(head);
    if (m) {
      off += m[0].length;
      if (bytes[off] === 0x0d && bytes[off + 1] === 0x0a) off += 2;
      else if (bytes[off] === 0x0a) off += 1;
    }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = (n) => { const v = dv.getUint8(off); off += n; return v; };
  const i32 = () => { const v = dv.getInt32(off, false); off += 4; return v; };
  const f64 = () => { const v = dv.getFloat64(off, false); off += 8; return v; };
  const raw = (n) => { const v = bytes.subarray(off, off + n); off += n; return v; };

  function dec() {
    const tag = dv.getUint8(off); off += 1;
    switch (tag) {
      case 0x21: return Llsd.undef();                                  // !
      case 0x30: return false;
      case 0x31: return true;
      case 0x69: return i32();                                         // i
      case 0x72: return Llsd.real(f64());                              // r
      case 0x75: return new LlsdUuid(bytesToUuid(raw(16)));            // u
      case 0x73: return fromUtf8(raw(i32()));                          // s
      case 0x6c: return new LlsdUri(fromUtf8(raw(i32())));             // l
      case 0x62: return new LlsdBinary(new Uint8Array(raw(i32())));    // b
      case 0x64: return new LlsdDate(f64());                           // d
      case 0x5b: {                                                     // [
        const n = i32(); const out = [];
        for (let i = 0; i < n; i++) out.push(dec());
        if (dv.getUint8(off) === 0x5d) off += 1;
        return out;
      }
      case 0x7b: {                                                     // {
        const n = i32(); const out = {};
        for (let i = 0; i < n; i++) {
          const kt = dv.getUint8(off); off += 1;
          if (kt !== 0x6b) throw new Error("llsd binario: se esperaba una clave en un mapa");
          const key = fromUtf8(raw(i32()));
          out[key] = dec();
        }
        if (dv.getUint8(off) === 0x7d) off += 1;
        return out;
      }
      default: throw new Error("llsd binario: tipo desconocido 0x" + tag.toString(16) + " en el byte " + (off - 1));
    }
  }
  return { value: dec(), next: off };
}

export function parseBinary(data) {
  return parseBinaryAt(data).value;
}

// --- notacion ---------------------------------------------------------------
//
// `{clave:valor, ...}`, `[a, b]`, `s'texto'`, `i5`, `r1.5`, `u<uuid>`, `!`.
// La usa el campo `home` de la respuesta del login (llega como cadena).

export function parseNotation(text) {
  const s = String(text);
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = (msg) => { throw new Error("llsd notacion: " + msg + " (posicion " + i + ")"); };

  function readQuoted() {
    const q = s[i++];
    let out = "";
    while (i < s.length && s[i] !== q) {
      if (s[i] === "\\" && i + 1 < s.length) {
        const c = s[i + 1];
        out += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c;
        i += 2;
      } else out += s[i++];
    }
    if (s[i] !== q) fail("cadena sin cerrar");
    i++;
    return out;
  }
  function readBare() {
    const start = i;
    while (i < s.length && !/[\s,\]\}:]/.test(s[i])) i++;
    return s.slice(start, i);
  }

  function value() {
    ws();
    const c = s[i];
    if (c === undefined) fail("fin inesperado");
    if (c === "!") { i++; return Llsd.undef(); }
    if (c === "[") {
      i++; const out = [];
      ws();
      if (s[i] === "]") { i++; return out; }
      for (;;) {
        out.push(value()); ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return out; }
        fail("se esperaba , o ] en una lista");
      }
    }
    if (c === "{") {
      i++; const out = {};
      ws();
      if (s[i] === "}") { i++; return out; }
      for (;;) {
        ws();
        let key;
        if (s[i] === "'" || s[i] === '"') key = readQuoted();
        else if (/^s['"]/.test(s.slice(i, i + 2))) { i += 1; key = readQuoted(); }
        else key = readBare();
        ws();
        if (s[i] !== ":") fail("se esperaba : tras la clave " + key);
        i++;
        out[key] = value(); ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "}") { i++; return out; }
        fail("se esperaba , o } en un mapa");
      }
    }
    if (c === "'" || c === '"') return readQuoted();
    if (/^s["']/.test(s.slice(i, i + 2))) { i += 1; return readQuoted(); }
    // Con prefijo de tipo.
    const rest = s.slice(i);
    let m;
    if ((m = rest.match(/^undef\b/))) { i += m[0].length; return Llsd.undef(); }
    if ((m = rest.match(/^true\b/))) { i += 4; return true; }
    if ((m = rest.match(/^false\b/))) { i += 5; return false; }
    if ((m = rest.match(/^i(-?\d+)/))) { i += m[0].length; return parseInt(m[1], 10); }
    if ((m = rest.match(/^r(-?[\d.eE+-]+)/))) { i += m[0].length; return Llsd.real(parseFloat(m[1])); }
    if ((m = rest.match(/^u([0-9a-fA-F-]{36})/))) { i += m[0].length; return new LlsdUuid(m[1]); }
    if ((m = rest.match(/^b64["']/))) {
      i += 3; const b64 = readQuoted(); return new LlsdBinary(b64decode(b64));
    }
    if (/^[ld]["']/.test(rest)) { const t = rest[0]; i += 1; const v = readQuoted(); return t === "d" ? new LlsdDate(v) : new LlsdUri(v); }
    // Numero sin prefijo (los hay en algunos mapas).
    if ((m = rest.match(/^(-?\d+)(?![\d.])/))) { i += m[0].length; return parseInt(m[1], 10); }
    if ((m = rest.match(/^(-?\d*\.?\d+(?:[eE][+-]?\d+)?)/))) { i += m[0].length; return Llsd.real(parseFloat(m[1])); }
    return readBare();
  }
  const v = value();
  ws();
  return v;
}

export function toNotation(value) {
  const q = (str) => "'" + String(str).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  function enc(v) {
    if (isUndef(v)) return "!";
    if (v instanceof LlsdReal) v = v.value;
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return Number.isInteger(v) ? "i" + v : "r" + v;
    if (v instanceof LlsdUuid) return "u" + v.value;
    if (v instanceof LlsdUri) return "l" + q(v.value);
    if (v instanceof LlsdDate) return "d" + q(v.date.toISOString());
    if (v instanceof LlsdBinary) return 'b64"' + b64encode(v.bytes) + '"';
    if (typeof v === "string") return "s" + q(v);
    if (Array.isArray(v)) return "[" + v.map(enc).join(",") + "]";
    if (typeof v === "object") return "{" + Object.keys(v).map((k) => q(k) + ":" + enc(v[k])).join(",") + "}";
    return "s" + q(String(v));
  }
  return enc(value);
}

// --- XML ---------------------------------------------------------------------
//
// Dos dialectos, un solo parser:
//   XML-RPC:  <methodCall><params><param><value><struct><member><name>...
//   LLSD-XML: <llsd><map><key>k</key><string>v</string></map></llsd>
// El segundo envuelve los escalares en su propia etiqueta; el primero usa
// <value> como envoltorio universal y <int>/<i4>/<double> en vez de
// <integer>/<real>. Se aceptan los dos porque el login responde en XML-RPC pero
// las capabilities responden en LLSD-XML.

function parseXmlValue(el) {
  if (!el) return undefined;
  const tag = el.nodeType === 1 ? el.tagName.toLowerCase() : "";
  if (tag === "value") {
    // Envuelve cualquier cosa; si esta vacio es la cadena vacia.
    const kids = [...el.children];
    if (kids.length === 0) return el.textContent;
    return parseXmlValue(kids[0]);
  }
  switch (tag) {
    case "undef": case "nil": return Llsd.undef();
    case "boolean": case "bool": return /^(1|true)$/i.test(el.textContent.trim());
    case "integer": case "int": case "i4": case "i8": return parseInt(el.textContent.trim(), 10);
    case "real": case "double": return Llsd.real(parseFloat(el.textContent.trim()));
    case "string": return el.textContent;
    case "uuid": return new LlsdUuid(el.textContent.trim());
    case "uri": return new LlsdUri(el.textContent.trim());
    case "date": return new LlsdDate(el.textContent.trim());
    case "dateTime.iso8601": return new LlsdDate(el.textContent.trim());
    case "binary": case "base64": return new LlsdBinary(b64decode(el.textContent));
    case "array": case "data": {
      const data = el.querySelector(":scope > data") || el;
      const out = [];
      for (const child of data.children) {
        if (child.tagName.toLowerCase() === "value") out.push(parseXmlValue(child));
        else out.push(parseXmlValue(child));
      }
      return out;
    }
    case "struct": case "map": return parseXmlMap(el);
    default: {
      // Etiqueta desconocida: se trata como el contenido de un <value>.
      const kids = [...el.children];
      if (kids.length === 1) return parseXmlValue(kids[0]);
      if (kids.length === 0) return el.textContent;
      return el.textContent;
    }
  }
}

function parseXmlMap(el) {
  const out = {};
  // LLSD-XML: <map><key>k</key><valor/></map>
  const keys = [...el.children].filter((c) => c.tagName.toLowerCase() === "key");
  if (keys.length) {
    for (let i = 0; i < keys.length; i++) {
      const next = keys[i].nextElementSibling;
      out[keys[i].textContent] = parseXmlValue(next);
    }
    return out;
  }
  // XML-RPC: <struct><member><name>k</name><value>v</value></member></struct>
  for (const member of el.children) {
    if (member.tagName.toLowerCase() !== "member") continue;
    let name = null, value = undefined;
    for (const child of member.children) {
      const t = child.tagName.toLowerCase();
      if (t === "name") name = child.textContent;
      else if (t === "value") value = parseXmlValue(child);
    }
    if (name !== null) out[name] = value;
  }
  return out;
}

export function parseXml(text) {
  const doc = new DOMParser().parseFromString(String(text), "text/xml");
  const perr = doc.querySelector("parsererror");
  if (perr) throw new Error("llsd: XML mal formado");
  const root = doc.documentElement;
  const tag = root.tagName.toLowerCase();
  if (tag === "methodresponse") {
    // Puede ser un valor o un <fault>.
    const faultEl = root.querySelector(":scope > fault");
    if (faultEl) {
      const f = parseXmlValue(faultEl.querySelector("value") || faultEl);
      const err = new Error(f && f.faultString ? f.faultString : "fallo XML-RPC");
      err.fault = f;
      throw err;
    }
    const valueEl = root.querySelector("params > param > value");
    return parseXmlValue(valueEl);
  }
  if (tag === "llsd") return parseXmlValue([...root.children][0]);
  // Un documento suelto: se interpreta como el valor de su raiz.
  return parseXmlValue(root);
}

function xmlValue(v, dialect) {
  // dialect: "xmlrpc" | "llsd"
  const wrap = (inner) => (dialect === "xmlrpc" ? "<value>" + inner + "</value>" : inner);
  const typed = (name, content) => wrap("<" + name + ">" + content + "</" + name + ">");
  if (isUndef(v)) return dialect === "xmlrpc" ? "<value><nil/></value>" : "<undef/>";
  if (v instanceof LlsdReal) v = v.value;
  if (typeof v === "boolean") return typed("boolean", v ? "1" : "0");
  if (typeof v === "number") {
    if (Number.isInteger(v)) return typed(dialect === "xmlrpc" ? "int" : "integer", String(v));
    return typed(dialect === "xmlrpc" ? "double" : "real", String(v));
  }
  if (v instanceof LlsdUuid) return typed("uuid", xmlEscape(v.value));
  if (v instanceof LlsdUri) return typed("uri", xmlEscape(v.value));
  if (v instanceof LlsdDate) return typed(dialect === "xmlrpc" ? "dateTime.iso8601" : "date", xmlEscape(v.date.toISOString()));
  if (v instanceof LlsdBinary) return typed("base64", b64encode(v.bytes));
  if (typeof v === "string") return typed("string", xmlEscape(v));
  if (Array.isArray(v)) {
    if (dialect === "xmlrpc") {
      return wrap("<array><data>" + v.map((x) => xmlValue(x, dialect)).join("") + "</data></array>");
    }
    return "<array>" + v.map((x) => xmlValue(x, dialect)).join("") + "</array>";
  }
  if (typeof v === "object") {
    const parts = [];
    for (const k of Object.keys(v)) {
      if (dialect === "xmlrpc") {
        parts.push("<member><name>" + xmlEscape(k) + "</name>" + xmlValue(v[k], dialect) + "</member>");
      } else {
        parts.push("<key>" + xmlEscape(k) + "</key>" + xmlValue(v[k], dialect));
      }
    }
    return wrap("<" + (dialect === "xmlrpc" ? "struct" : "map") + ">" + parts.join("") + "</" + (dialect === "xmlrpc" ? "struct" : "map") + ">");
  }
  return typed("string", xmlEscape(String(v)));
}

// Cuerpo de una llamada XML-RPC: el login de SL usa
// `login_to_simulator` con un unico parametro que es un mapa.
export function toXmlRpc(method, params) {
  return '<?xml version="1.0"?>\n<methodCall><methodName>' + xmlEscape(method) + "</methodName><params>" +
    (params || []).map((p) => "<param>" + xmlValue(p, "xmlrpc") + "</param>").join("") +
    "</params></methodCall>";
}

// Cuerpo LLSD-XML (el alternativo, y el que usan las capabilities).
export function toLlsdXml(value) {
  return '<?xml version="1.0"?>\n<llsd>' + xmlValue(value, "llsd") + "</llsd>";
}

// --- utilidades sobre mapas -------------------------------------------------

// Busca una clave en un mapa LLSD de forma tolerante (los nombres del login
// cambian de mayusculas y a veces faltan).
export function pick(map, ...keys) {
  for (const k of keys) {
    if (map && map[k] !== undefined && map[k] !== null) return map[k];
  }
  return undefined;
}
export function str(map, ...keys) {
  const v = pick(map, ...keys);
  if (v === undefined) return undefined;
  if (v instanceof LlsdUri) return v.value;
  if (v instanceof LlsdUuid) return v.value;
  return String(v);
}
export function num(map, ...keys) {
  const v = pick(map, ...keys);
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : undefined;
}

// --- autotest ---------------------------------------------------------------

export function runLlsdSelfTest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

  // Binario: ida y vuelta con todos los tipos.
  const sample = {
    n: 42, r: Llsd.real(1.5), s: "hola", b: true, u: Llsd.uuid("12345678-90ab-cdef-1234-567890abcdef"),
    bin: Llsd.binary(new Uint8Array([1, 2, 3])), arr: [1, "dos", false], nested: { x: Llsd.uri("http://ejemplo/x") },
  };
  const round = parseBinary(toBinary(sample));
  eq("binario: entero", round.n, 42);
  eq("binario: real", round.r.value, 1.5);
  eq("binario: texto", round.s, "hola");
  eq("binario: booleano", round.b, true);
  eq("binario: uuid", round.u.value, "12345678-90ab-cdef-1234-567890abcdef");
  eq("binario: bytes", [...round.bin.bytes], [1, 2, 3]);
  eq("binario: lista", round.arr, [1, "dos", false]);
  eq("binario: uri anidada", round.nested.x.value, "http://ejemplo/x");
  const withHeader = toBinary({ a: 1 });
  eq("binario: cabecera", new TextDecoder().decode(withHeader.subarray(0, 14)), "<?llsd/binary?");
  eq("binario: sin cabecera", toBinary({ a: 1 }, { header: false })[0], 0x7b);

  // Notacion: la usan campos como `home`.
  const nota = parseNotation("{region_handle:[1000,1000],position:[128.0,64.5,22.1],look_at:[128,64,0]}");
  eq("notacion: entero", nota.region_handle[0], 1000);
  eq("notacion: real", nota.position[1].value, 64.5);
  eq("notacion: anidado", nota.look_at.length, 3);
  eq("notacion: indefinido", isUndef(parseNotation("!")), true);
  eq("notacion: ida y vuelta", parseNotation(toNotation({ a: [1, Llsd.real(2.5)], b: "x" })).b, "x");

  // XML-RPC: cuerpo de la peticion y lectura de la respuesta.
  const req = toXmlRpc("login_to_simulator", [{ first: "Ana", last: "Prueba", agree: true, n: 3 }]);
  eq("xmlrpc: metodo", /<methodName>login_to_simulator<\/methodName>/.test(req), true);
  eq("xmlrpc: struct", /<member><name>first<\/name><value><string>Ana<\/string><\/value><\/member>/.test(req), true);
  eq("xmlrpc: booleano", /<boolean>1<\/boolean>/.test(req), true);
  eq("xmlrpc: entero", /<int>3<\/int>/.test(req), true);
  const reply = '<?xml version="1.0"?><methodResponse><params><param><value><struct>' +
    '<member><name>session_id</name><value><string>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</string></value></member>' +
    '<member><name>circuit_code</name><value><int>12345</int></value></member>' +
    '<member><name>look_at</name><value><string>[128, 64, 22]</string></value></member>' +
    '<member><name>options</name><value><array><data><value><string>uno</string></value><value><int>2</int></value></data></array></value></member>' +
    '</struct></value></param></params></methodResponse>';
  if (typeof DOMParser === "undefined") {
    checks.push({ name: "xml: DOMParser no disponible (worker)", ok: true, got: "omitido", want: "omitido" });
  } else {
    const r = parseXml(reply);
    eq("xml: cadena", r.session_id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    eq("xml: entero", r.circuit_code, 12345);
    eq("xml: lista", r.options, ["uno", 2]);
    const llsdXml = "<llsd><map><key>a</key><integer>7</integer><key>b</key><string>x</string></map></llsd>";
    const r2 = parseXml(llsdXml);
    eq("llsdxml: entero", r2.a, 7);
    eq("llsdxml: texto", r2.b, "x");
    const llsdOut = toLlsdXml({ a: 1, s: "y" });
    eq("llsdxml: escritura", /<llsd><map><key>a<\/key><integer>1<\/integer>/.test(llsdOut), true);
  }

  const fails = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - fails.length, fails };
}
