export const TYPE_SIZE = {
  U8: 1, S8: 1, U16: 2, S16: 2, U32: 4, S32: 4, U64: 8, S64: 8, F32: 4, F64: 8,
  BOOL: 1, IPADDR: 4, IPPORT: 2, LLUUID: 16, LLVector3: 12, LLVector3d: 24,
  LLVector4: 16, LLQuaternion: 12,
};

export const PRIORITY_BITS = {
  High: 0,
  Medium: 0xff00,
  Low: 0xffff0000,
  Fixed: 0,
};

export const MSG_RELIABLE = 0x40;
export const MSG_RESENT = 0x20;
export const MSG_ZEROCODED = 0x80;
export const MSG_APPENDED_ACKS = 0x10;

const SIGNED = new Set(["S8", "S16", "S32", "S64"]);
const INTEGER = new Set(["U8", "S8", "U16", "S16", "U32", "S32", "U64", "S64", "BOOL", "IPPORT"]);
const FLOAT = new Set(["F32", "F64"]);

function tokenize(text) {
  return text
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/([{}])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
}

function parseFieldGroup(tokens, i) {
  i++;
  const fields = [];
  while (tokens[i] !== "}") {
    const name = tokens[i++];
    const type = tokens[i++];
    let size;
    if (type === "Variable" || type === "Fixed") {
      if (tokens[i] && /^\d+$/.test(tokens[i])) size = parseInt(tokens[i++], 10);
      else size = type === "Variable" ? 1 : 0;
    }
    fields.push({ name, type, size });
  }
  return { fields, next: i + 1 };
}

function parseBlock(tokens, i) {
  i++;
  const name = tokens[i++];
  const countType = tokens[i++];
  let count;
  if (countType === "Single") count = 1;
  else if (countType === "Multiple") count = parseInt(tokens[i++], 10);
  else count = -1;
  const fields = [];
  while (tokens[i] === "{") {
    const g = parseFieldGroup(tokens, i);
    fields.push(...g.fields);
    i = g.next;
  }
  return { block: { name, countType, count, fields }, next: i + 1 };
}

function parseMessage(tokens, i) {
  const save = i;
  i++;
  const name = tokens[i++];
  const priority = tokens[i++];
  const numberTok = tokens[i++];
  if (!name || !priority || numberTok === undefined) return { def: null, next: save + 1 };
  const number = numberTok.startsWith("0x") ? parseInt(numberTok, 16) : parseInt(numberTok, 10);
  const flags = [];
  while (i < tokens.length && tokens[i] !== "{" && tokens[i] !== "}") flags.push(tokens[i++]);
  const blocks = [];
  while (i < tokens.length && tokens[i] === "{") {
    const b = parseBlock(tokens, i);
    blocks.push(b.block);
    i = b.next;
  }
  return { def: { name, priority, number, flags, blocks }, next: i + 1 };
}

export function parseMessageTemplate(text) {
  const tokens = tokenize(text);
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === "{") {
      const r = parseMessage(tokens, i);
      if (r.def) out.push(r.def);
      i = r.next;
    } else i++;
  }
  return out;
}

export function wireNumber(def) {
  if (def.priority === "Fixed") return def.number >>> 0;
  return ((PRIORITY_BITS[def.priority] || 0) + (def.number >>> 0)) >>> 0;
}

export function encodeNumber(value) {
  const v = value >>> 0;
  if (v < 0xff) return [v];
  if (v < 0xffff) return [0xff, v & 0xff];
  return [0xff, 0xff, (v >>> 8) & 0xff, v & 0xff];
}

export function decodeNumber(bytes, offset) {
  const b0 = bytes[offset];
  if (b0 !== 0xff) return { value: b0, size: 1 };
  const b1 = bytes[offset + 1];
  if (b1 !== 0xff) return { value: (0xff00 | b1) >>> 0, size: 2 };
  return { value: (0xffff0000 | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0, size: 4 };
}

export function buildIndex(defs) {
  const map = new Map();
  for (const def of defs) map.set(wireNumber(def), def);
  return map;
}

export function uuidBytes(uuid) {
  if (uuid instanceof Uint8Array) return uuid;
  const hex = String(uuid).replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  return out;
}

export function uuidString(bytes) {
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

export function ipBytes(str) {
  if (str instanceof Uint8Array) return str;
  const parts = String(str).split(".").map((n) => parseInt(n, 10) & 0xff);
  return new Uint8Array([parts[0] || 0, parts[1] || 0, parts[2] || 0, parts[3] || 0]);
}

export function ipString(bytes) {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

export function toBytes(str) {
  return new TextEncoder().encode(String(str) + "\0");
}

export function toText(bytes) {
  if (!bytes || !bytes.length) return "";
  let end = bytes.length;
  if (bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function writeInt(out, value, size) {
  let v = BigInt(Math.trunc(Number(value) || 0));
  if (v < 0n) v += 1n << BigInt(size * 8);
  for (let i = 0; i < size; i++) out.push(Number((v >> BigInt(i * 8)) & 0xffn));
}

function writeF32(out, v) {
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, v || 0, true);
  for (let i = 0; i < 4; i++) out.push(dv.getUint8(i));
}

function writeF64(out, v) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v || 0, true);
  for (let i = 0; i < 8; i++) out.push(dv.getUint8(i));
}

function writeCount(out, n) {
  if (n < 0xff) return void out.push(n);
  if (n < 0xffff) {
    out.push(0xff);
    return void out.push(n & 0xff, (n >>> 8) & 0xff);
  }
  out.push(0xff, 0xff);
  writeInt(out, n, 4);
}

function readCount(bytes, pos) {
  let c = bytes[pos++];
  if (c === 0xff) {
    c = bytes[pos] | (bytes[pos + 1] << 8);
    pos += 2;
    if (c === 0xffff) {
      c = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
      pos += 4;
    }
  }
  return { count: c >>> 0, pos };
}

function encodeField(out, field, value) {
  const t = field.type;
  if (INTEGER.has(t)) return writeInt(out, t === "BOOL" ? (value ? 1 : 0) : value, TYPE_SIZE[t]);
  if (FLOAT.has(t)) return t === "F32" ? writeF32(out, value) : writeF64(out, value);
  if (t === "IPADDR") {
    for (const x of ipBytes(value || "0.0.0.0")) out.push(x);
    return;
  }
  if (t === "LLUUID") {
    for (const x of uuidBytes(value || "00000000-0000-0000-0000-000000000000")) out.push(x);
    return;
  }
  if (t === "LLVector3" || t === "LLVector3d") {
    const src = Array.isArray(value) ? value : [0, 0, 0];
    for (let i = 0; i < 3; i++) (t === "LLVector3" ? writeF32 : writeF64)(out, src[i] || 0);
    return;
  }
  if (t === "LLQuaternion") {
    const src = Array.isArray(value) ? value : [0, 0, 0];
    for (let i = 0; i < 3; i++) writeF32(out, src[i] || 0);
    return;
  }
  if (t === "LLVector4") {
    const src = Array.isArray(value) ? value : [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) writeF32(out, src[i] || 0);
    return;
  }
  if (t === "Fixed") {
    const b = value instanceof Uint8Array ? value : new Uint8Array(field.size || 0);
    for (let i = 0; i < (field.size || b.length); i++) out.push(b[i] || 0);
    return;
  }
  if (t === "Variable") {
    const b = value instanceof Uint8Array ? value : value == null ? new Uint8Array(0) : toBytes(value);
    writeInt(out, b.length, field.size || 1);
    for (const x of b) out.push(x);
    return;
  }
  throw new Error(`tipo de campo no soportado: ${t}`);
}

function decodeField(bytes, pos, field) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const t = field.type;
  if (INTEGER.has(t)) {
    const n = TYPE_SIZE[t];
    if (t === "BOOL") return { value: bytes[pos] !== 0, size: 1 };
    if (n === 8) {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[pos + i]);
      if (SIGNED.has(t) && v >= 1n << 63n) v -= 1n << 64n;
      return { value: Number(v), size: 8 };
    }
    const signed = SIGNED.has(t);
    let v;
    if (n === 1) v = signed ? view.getInt8(pos) : view.getUint8(pos);
    else if (n === 2) v = signed ? view.getInt16(pos, true) : view.getUint16(pos, true);
    else v = signed ? view.getInt32(pos, true) : view.getUint32(pos, true);
    return { value: v, size: n };
  }
  if (FLOAT.has(t)) {
    const n = TYPE_SIZE[t];
    return { value: t === "F32" ? view.getFloat32(pos, true) : view.getFloat64(pos, true), size: n };
  }
  if (t === "IPADDR") return { value: bytes.slice(pos, pos + 4), size: 4 };
  if (t === "LLUUID") return { value: bytes.slice(pos, pos + 16), size: 16 };
  if (t === "LLVector3") {
    return { value: [view.getFloat32(pos, true), view.getFloat32(pos + 4, true), view.getFloat32(pos + 8, true)], size: 12 };
  }
  if (t === "LLVector3d") {
    return { value: [view.getFloat64(pos, true), view.getFloat64(pos + 8, true), view.getFloat64(pos + 16, true)], size: 24 };
  }
  if (t === "LLQuaternion") {
    const x = view.getFloat32(pos, true);
    const y = view.getFloat32(pos + 4, true);
    const z = view.getFloat32(pos + 8, true);
    const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    return { value: [x, y, z, w], size: 12 };
  }
  if (t === "LLVector4") {
    return {
      value: [view.getFloat32(pos, true), view.getFloat32(pos + 4, true), view.getFloat32(pos + 8, true), view.getFloat32(pos + 12, true)],
      size: 16,
    };
  }
  if (t === "Fixed") {
    const n = field.size || 0;
    return { value: bytes.slice(pos, pos + n), size: n };
  }
  if (t === "Variable") {
    let len = 0;
    const n = field.size || 1;
    for (let i = 0; i < n; i++) len |= bytes[pos + i] << (8 * i);
    return { value: bytes.slice(pos + n, pos + n + len), size: n + len };
  }
  throw new Error(`tipo de campo no soportado: ${t}`);
}

function blockItems(obj, block) {
  const v = obj ? obj[block.name] : null;
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && block.countType !== "Single") return [v];
  return [];
}

// Lists the scalar fields the template expects but the object does not provide
// (they would be encoded as zeros). Catches name mismatches between the code and
// message_template.msg, which are otherwise invisible on the wire.
const SIZE_FIELD_TYPES = new Set(["Fixed", "Variable"]);

export function missingFields(def, obj) {
  const out = [];
  const data = obj || {};
  for (const block of def.blocks) {
    const items = block.countType === "Single" ? [data[block.name] || {}] : blockItems(data, block);
    for (const item of items) {
      for (const f of block.fields) {
        if (SIZE_FIELD_TYPES.has(f.type)) continue;
        if (item[f.name] === undefined || item[f.name] === null) out.push(`${block.name}.${f.name}`);
      }
    }
  }
  return out;
}

export function encodeBody(def, obj) {
  const out = [];
  const data = obj || {};
  for (const block of def.blocks) {
    if (block.countType === "Multiple") writeCount(out, blockItems(data, block).length);
  }
  for (const block of def.blocks) {
    if (block.countType === "Single") {
      const src = data[block.name] || {};
      for (const f of block.fields) encodeField(out, f, src[f.name]);
    } else if (block.countType === "Multiple") {
      for (const item of blockItems(data, block)) {
        for (const f of block.fields) encodeField(out, f, item[f.name]);
      }
    } else {
      const items = blockItems(data, block);
      writeCount(out, items.length);
      for (const item of items) {
        for (const f of block.fields) encodeField(out, f, item[f.name]);
      }
    }
  }
  return new Uint8Array(out);
}

export function decodeBody(def, bytes, offset = 0) {
  const counts = {};
  let pos = offset;
  for (const block of def.blocks) {
    if (block.countType !== "Multiple") continue;
    const r = readCount(bytes, pos);
    counts[block.name] = r.count;
    pos = r.pos;
  }
  const result = {};
  for (const block of def.blocks) {
    if (block.countType === "Single") {
      const rec = {};
      for (const f of block.fields) {
        const r = decodeField(bytes, pos, f);
        rec[f.name] = r.value;
        pos += r.size;
      }
      result[block.name] = rec;
    } else {
      let count = counts[block.name];
      if (block.countType === "Variable") {
        const r = readCount(bytes, pos);
        count = r.count;
        pos = r.pos;
      }
      const arr = [];
      for (let n = 0; n < count; n++) {
        const rec = {};
        for (const f of block.fields) {
          const r = decodeField(bytes, pos, f);
          rec[f.name] = r.value;
          pos += r.size;
        }
        arr.push(rec);
      }
      result[block.name] = arr;
    }
  }
  return { data: result, bytesRead: pos - offset };
}

// Port of zero_code() from Linden's lltemplatemessagebuilder.cpp: a run of N
// zero bytes becomes `00 <N>`, and a run longer than 254 wraps by emitting the
// count again (so 256 zeros == `00 FF 00 01`). The packeted header (6 bytes) is
// copied verbatim before this runs.
export function zeroEncode(src) {
  const out = [];
  let run = 0;
  let marked = false;
  for (const b of src) {
    if (b !== 0) {
      if (run !== 0) {
        out.push(run);
        run = 0;
      }
      marked = false;
      out.push(b);
    } else {
      if (!marked) {
        out.push(0);
        marked = true;
      }
      run++;
      if (run > 254) {
        out.push(run);
        run = 0;
        marked = false;
      }
    }
  }
  if (run !== 0) out.push(run);
  return new Uint8Array(out);
}

export function zeroDecode(src, start = 0, end = src.length) {
  const out = [];
  for (let i = start; i < end; i++) {
    const b = src[i];
    if (b === 0) {
      const n = src[++i] || 0;
      for (let k = 0; k < n; k++) out.push(0);
    } else out.push(b);
  }
  return new Uint8Array(out);
}
