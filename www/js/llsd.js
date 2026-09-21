// LLSD (Linden Lab Structured Data): XML, Notation and Binary codecs.
// Maps: JS object -> LLSD map, Array -> LLSD array, string -> string (uuid/date/uri
// are auto-detected when serialising), number -> integer or real, boolean, null -> undefined.

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const URI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export const LLSDUndefined = Symbol("llsd.undefined");

function detectHint(s) {
  if (UUID_RE.test(s)) return "uuid";
  if (DATE_RE.test(s)) return "date";
  if (URI_RE.test(s)) return "uri";
  return "string";
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

export function parseLLSDXML(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const root = doc.documentElement;
  if (!root) throw new Error("LLSD: empty XML");
  const first = [...root.children].find(c => c.nodeName !== "parsererror");
  if (!first) return null;
  return fromXmlNode(first);
}

function fromXmlNode(node) {
  switch (node.nodeName) {
    case "map": {
      const out = {};
      for (const member of node.children) {
        if (member.nodeName !== "member") continue;
        const k = member.querySelector(":scope > key");
        const v = [...member.children].find(c => c.nodeName !== "key");
        if (k) out[k.textContent] = v ? fromXmlNode(v) : null;
      }
      return out;
    }
    case "array":
      return [...node.children].map(fromXmlNode);
    case "string": return node.textContent;
    case "integer": return parseInt(node.textContent, 10);
    case "real": return parseFloat(node.textContent);
    case "boolean": return node.textContent.trim() === "1" || node.textContent.trim() === "true";
    case "uuid": return node.textContent.trim();
    case "date": return node.textContent.trim();
    case "uri": return node.textContent.trim();
    case "binary": {
      const b64 = node.textContent.replace(/\s+/g, "");
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return bytes;
    }
    case "undef":
    default: return null;
  }
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function serializeLLSDXML(v) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<llsd>${toXml(v)}</llsd>`;
}
function toXml(v) {
  if (v instanceof Uint8Array) {
    let b64 = "";
    for (const b of v) b64 += String.fromCharCode(b);
    return `<binary>${btoa(b64)}</binary>`;
  }
  if (v === null || v === undefined) return "<undef />";
  if (typeof v === "boolean") return `<boolean>${v ? 1 : 0}</boolean>`;
  if (typeof v === "number") {
    return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  }
  if (typeof v === "string") {
    const hint = detectHint(v);
    return `<${hint}>${esc(v)}</${hint}>`;
  }
  if (Array.isArray(v)) return `<array>${v.map(toXml).join("")}</array>`;
  let s = "<map>";
  for (const k of Object.keys(v)) s += `<key>${esc(k)}</key>${toXml(v[k])}`;
  return s + "</map>";
}

// ---------------------------------------------------------------------------
// XML-RPC (used by the legacy login.cgi endpoint)
// ---------------------------------------------------------------------------

function b64ToBytes(b64) {
  const raw = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromXmlRpcValue(node) {
  const child = [...node.children][0];
  if (!child) return node.textContent.trim();
  switch (child.nodeName) {
    case "struct": {
      const out = {};
      for (const member of child.children) {
        const name = member.querySelector(":scope > name");
        const val = [...member.children].find(c => c.nodeName === "value");
        if (name) out[name.textContent] = val ? fromXmlRpcValue(val) : null;
      }
      return out;
    }
    case "array":
      return [...child.querySelectorAll(":scope > data > value")].map(fromXmlRpcValue);
    case "string": return child.textContent;
    case "int": case "i4": case "i8": return parseInt(child.textContent, 10);
    case "double": return parseFloat(child.textContent);
    case "boolean": return child.textContent.trim() === "1";
    case "base64": return b64ToBytes(child.textContent);
    case "dateTime.iso8601": return child.textContent.trim();
    case "nil": return null;
    default: return child.textContent;
  }
}

export function parseXmlRpc(text) {
  if (/<llsd[\s>]/.test(text.slice(0, 400))) return parseLLSDXML(text);
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const root = doc.documentElement;
  if (!root) throw new Error("XML-RPC: empty response");
  const fault = root.querySelector("fault > value");
  if (fault) {
    const info = fromXmlRpcValue(fault);
    throw new Error("XML-RPC fault: " + JSON.stringify(info));
  }
  const value = root.querySelector("params > param > value");
  return value ? fromXmlRpcValue(value) : null;
}

function xmlRpcValue(v) {
  if (v === null || v === undefined) return "<value><nil/></value>";
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") {
    return Number.isInteger(v) ? `<value><int>${v}</int></value>` : `<value><double>${v}</double></value>`;
  }
  if (v instanceof Uint8Array) return `<value><base64>${bytesToB64(v)}</base64></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(xmlRpcValue).join("")}</data></array></value>`;
  if (typeof v === "object") {
    let s = "<value><struct>";
    for (const k of Object.keys(v)) s += `<member><name>${esc(k)}</name>${xmlRpcValue(v[k])}</member>`;
    return s + "</struct></value>";
  }
  return `<value><string>${esc(v)}</string></value>`;
}

export function buildXmlRpcCall(method, params) {
  return (
    '<?xml version="1.0"?>\n<methodCall>\n<methodName>' +
    esc(method) +
    "</methodName>\n<params>\n" +
    params.map(p => `<param>${xmlRpcValue(p)}</param>`).join("\n") +
    "\n</params>\n</methodCall>\n"
  );
}

// ---------------------------------------------------------------------------
// Notation
// ---------------------------------------------------------------------------

export function parseLLSDNotation(text) {
  let i = 0;
  const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  function parse() {
    skipWs();
    const c = text[i];
    switch (c) {
      case "!": i++; return null;
      case "1": i++; return true;
      case "0": i++; return false;
      case "i": { i++; const s = i; while (i < text.length && /[-+0-9]/.test(text[i])) i++; return parseInt(text.slice(s, i), 10); }
      case "r": { i++; const s = i; while (i < text.length && /[-+.eE0-9]/.test(text[i])) i++; return parseFloat(text.slice(s, i)); }
      case "u": { i++; const s = text.slice(i, i + 36); i += 36; return s; }
      case "d": { i++; const s = i; while (i < text.length && text[i] !== "\n") i++; return text.slice(s, i); }
      case "l": case "s": {
        i++;
        let len = 0;
        while (i < text.length && /[0-9]/.test(text[i])) len = len * 10 + (+text[i++]);
        if (text[i] === ":") i++;
        else if (text[i] === "\n") i++;
        if (text[i] === '"') i++;
        const s = text.substr(i, len);
        i += len;
        return s;
      }
      case "[": {
        i++; const arr = [];
        for (;;) { skipWs(); if (text[i] === "]") { i++; break; } if (i >= text.length) break; arr.push(parse()); skipWs(); if (text[i] === ",") i++; }
        return arr;
      }
      case "{": {
        i++; const map = {};
        for (;;) {
          skipWs(); if (text[i] === "}") { i++; break; } if (i >= text.length) break;
          const k = parse(); skipWs(); if (text[i] === ":") i++;
          map[String(k)] = parse();
          skipWs(); if (text[i] === ",") i++;
        }
        return map;
      }
      default: i++; return null;
    }
  }
  return parse();
}

export function serializeLLSDNotation(v) {
  if (v === null || v === undefined) return "!";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isInteger(v) ? `i${v}` : `r${v}`;
  if (typeof v === "string") {
    const hint = detectHint(v);
    const tag = hint === "uuid" ? "u" : hint === "date" ? "d" : hint === "uri" ? "l" : "s";
    if (tag === "u" || tag === "d" && hint === "date") return tag + v;
    return `${tag}${v.length}:${v}`;
  }
  if (v instanceof Uint8Array) return `b${v.length}:${String.fromCharCode(...v)}`;
  if (Array.isArray(v)) return `[${v.map(serializeLLSDNotation).join(",")}]`;
  return `{${Object.keys(v).map(k => `s${k.length}:${k}:${serializeLLSDNotation(v[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Binary
// ---------------------------------------------------------------------------

class BinReader {
  constructor(bytes) { this.d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; }
  u8() { return this.d.getUint8(this.p++); }
  u16() { const v = this.d.getUint16(this.p, true); this.p += 2; return v; }
  u32() { const v = this.d.getUint32(this.p, true); this.p += 4; return v; }
  u64() { const v = this.d.getBigUint64(this.p, true); this.p += 8; return Number(v); }
  i32() { const v = this.d.getInt32(this.p, true); this.p += 4; return v; }
  f64() { const v = this.d.getFloat64(this.p, true); this.p += 8; return v; }
  str(n) { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(this.d.getUint8(this.p + i)); this.p += n; return s; }
  uuid() { const h = this.str(16); const s = [...h].map(c => c.charCodeAt(0).toString(16).padStart(2, "0")).join(""); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`; }
  bytes(n) { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = this.d.getUint8(this.p + i); this.p += n; return a; }
}

export function parseLLSDBinary(bytes) {
  const r = new BinReader(bytes);
  if (r.str(4) !== "LLSD") throw new Error("LLSD: bad binary magic");
  const type = r.u8();
  if (type !== 1) throw new Error("LLSD: unsupported binary version " + type);
  return readBin(r);
}

function readBin(r) {
  let count, tag;
  switch (r.u8()) {
    case 0x21: return null;
    case 0x31: return r.u8() !== 0;
    case 0x69: return r.i32();
    case 0x72: return r.f64();
    case 0x75: return r.uuid();
    case 0x64: { const n = r.i32(); const s = r.str(n * 8); return s; }
    case 0x6c: case 0x73: { const n = r.i32(); return r.str(n); }
    case 0x62: { const n = r.i32(); return r.bytes(n); }
    case 0x5b: {
      count = r.i32();
      const a = [];
      for (let i = 0; i < count; i++) a.push(readBin(r));
      if (r.u8() !== 0x5d) throw new Error("LLSD binary: array sin cierre");
      return a;
    }
    case 0x7b: {
      const map = {};
      for (;;) {
        tag = r.u8();
        if (tag === 0x6b) { const k = readBin(r); map[k] = readBin(r); }
        else if (tag === 0x7d) break;
        else throw new Error("LLSD binary: bad map token");
      }
      return map;
    }
    default: throw new Error("LLSD binary: unknown type");
  }
}

export function serializeLLSDBinary(v) {
  const out = [];
  const push32 = (n) => { out.push(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255); };
  const pushStr = (s) => { for (const ch of s) out.push(ch.charCodeAt(0) & 255); };
  function write(v) {
    if (v instanceof Uint8Array) { out.push(0x62); push32(v.length); for (const b of v) out.push(b); return; }
    if (v === null || v === undefined) { out.push(0x21); return; }
    if (typeof v === "boolean") { out.push(0x31, v ? 1 : 0); return; }
    if (typeof v === "number") {
      if (Number.isInteger(v)) { out.push(0x69); push32(v); }
      else { out.push(0x72); const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v, true); for (let i = 0; i < 8; i++) out.push(d.getUint8(i)); }
      return;
    }
    if (typeof v === "string") {
      const hint = detectHint(v);
      if (hint === "uuid") { out.push(0x75); pushStr(v.replace(/-/g, "").match(/../g).map(h => String.fromCharCode(parseInt(h, 16))).join("")); return; }
      out.push(0x73); push32(v.length); pushStr(v); return;
    }
    if (Array.isArray(v)) { out.push(0x5b); push32(v.length); for (const it of v) write(it); out.push(0x5d); return; }
    out.push(0x7b);
    for (const k of Object.keys(v)) { out.push(0x6b); write(k); write(v[k]); }
    out.push(0x7d);
  }
  write(v);
  return new Uint8Array([0x4c, 0x4c, 0x53, 0x44, 0x01, ...out]);
}

export const LLSD = {
  parseXML: parseLLSDXML,
  parseNotation: parseLLSDNotation,
  parseBinary: parseLLSDBinary,
  parseXmlRpc,
  xmlRpcCall: buildXmlRpcCall,
  toXML: serializeLLSDXML,
  toNotation: serializeLLSDNotation,
  toBinary: serializeLLSDBinary,
  toXmlRpcValue: xmlRpcValue,
  parse(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b[0] === 0x4c && b[1] === 0x4c && b[2] === 0x53 && b[3] === 0x44) return parseLLSDBinary(b);
    const text = new TextDecoder().decode(b).trim();
    if (text.startsWith("<")) {
      if (/<methodResponse|<methodCall/.test(text.slice(0, 400))) return parseXmlRpc(text);
      return parseLLSDXML(text);
    }
    return parseLLSDNotation(text);
  },
};
