// Decoding of the shape/position data carried by ObjectUpdate,
// ObjectUpdateCached, ObjectUpdateCompressed and ImprovedTerseObjectUpdate.
import { defaultPrimParams } from "./prims.js";

export const PCODE_PRIM = 9;
export const PCODE_AVATAR = 47;
export const PCODE_GRASS = 95;
export const PCODE_TREE = 111;
export const PCODE_PART_SYS = 143;
export const PCODE_NEW_TREE = 255;

export const FLAGS_USE_PHYSICS = 0x00000001;
export const FLAGS_OBJECT_MODIFY = 0x00000004;
export const FLAGS_OBJECT_COPY = 0x00000008;
export const FLAGS_OBJECT_YOU_OWNER = 0x00000020;
export const FLAGS_SCRIPTED = 0x00000040;
export const FLAGS_OBJECT_MOVE = 0x00000100;
export const FLAGS_TAKES_MONEY = 0x00000200;
export const FLAGS_PHANTOM = 0x00000400;
export const FLAGS_OBJECT_TRANSFER = 0x00020000;
export const FLAGS_OBJECT_OWNER_MODIFY = 0x10000000;
export const FLAGS_TEMPORARY_ON_REZ = 0x20000000;
export const FLAGS_TEMPORARY = 0x40000000;

// LLTersePacking: value -> [min,max] quantisation, including the "flush tiny
// values to zero" rule the viewer uses (keeps idle objects perfectly still).
function dequantize(step, value, min, max) {
  const span = max - min;
  const v = value * step * span + min;
  return Math.abs(v) < span * step ? 0 : v;
}

const U8_STEP = 1 / 255;
const U16_STEP = 1 / 65535;
// Region-local decode windows used by the reference viewers.
export const POS_XY = [-128, 384];
export const POS_Z = [-256, 4096];
export const VEL_XY = [-128, 384];
export const VEL_Z = [-256, 4096];

function readU8Vec(data, off, xy, z) {
  return [
    dequantize(U8_STEP, data[off], xy[0], xy[1]),
    dequantize(U8_STEP, data[off + 1], xy[0], xy[1]),
    dequantize(U8_STEP, data[off + 2], z[0], z[1]),
  ];
}

function readU16Vec(view, off, xy, z) {
  return [
    dequantize(U16_STEP, view.getUint16(off, true), xy[0], xy[1]),
    dequantize(U16_STEP, view.getUint16(off + 2, true), xy[0], xy[1]),
    dequantize(U16_STEP, view.getUint16(off + 4, true), z[0], z[1]),
  ];
}

function readF32Vec(view, off) {
  return [view.getFloat32(off, true), view.getFloat32(off + 4, true), view.getFloat32(off + 8, true)];
}

function quatFrom3(x, y, z) {
  const w = 1 - (x * x + y * y + z * z);
  return [x, y, z, w > 0 ? Math.sqrt(w) : 0];
}

function readQuat(data, view, off, quant) {
  if (quant === 8) {
    return quatFrom3(
      dequantize(U8_STEP, data[off], -1, 1),
      dequantize(U8_STEP, data[off + 1], -1, 1),
      dequantize(U8_STEP, data[off + 2], -1, 1)
    );
  }
  if (quant === 16) {
    return quatFrom3(
      dequantize(U16_STEP, view.getUint16(off, true), -1, 1),
      dequantize(U16_STEP, view.getUint16(off + 2, true), -1, 1),
      dequantize(U16_STEP, view.getUint16(off + 4, true), -1, 1)
    );
  }
  return quatFrom3(view.getFloat32(off, true), view.getFloat32(off + 4, true), view.getFloat32(off + 8, true));
}

// Lengths seen on the wire: 16/32/48 (quantised) and 60/76 (floats,
// the 76-byte variant carries a 16-byte collision-plane prefix).
export function decodeTerseObjectData(bytes) {
  const len = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { position: [0, 0, 0], velocity: [0, 0, 0], acceleration: [0, 0, 0], rotation: [0, 0, 0, 1], angularVelocity: [0, 0, 0], quantised: true };
  if (len === 16) {
    out.position = readU8Vec(bytes, 0, POS_XY, POS_Z);
    out.velocity = readU8Vec(bytes, 3, VEL_XY, VEL_Z);
    out.acceleration = readU8Vec(bytes, 6, VEL_XY, VEL_Z);
    out.rotation = readQuat(bytes, view, 9, 8);
  } else if (len === 32) {
    out.position = readU16Vec(view, 0, POS_XY, POS_Z);
    out.velocity = readU16Vec(view, 6, VEL_XY, VEL_Z);
    out.acceleration = readU16Vec(view, 12, VEL_XY, VEL_Z);
    out.rotation = readQuat(bytes, view, 18, 16);
    if (len >= 32) out.angularVelocity = readU16Vec(view, 24, VEL_XY, VEL_Z);
  } else if (len === 48) {
    out.position = readU16Vec(view, 16, POS_XY, POS_Z);
    out.velocity = readU16Vec(view, 22, VEL_XY, VEL_Z);
    out.acceleration = readU16Vec(view, 28, VEL_XY, VEL_Z);
    out.rotation = readQuat(bytes, view, 34, 16);
    out.angularVelocity = readU16Vec(view, 40, VEL_XY, VEL_Z);
  } else if (len >= 60) {
    const base = len >= 76 ? 16 : 0;
    out.quantised = false;
    out.position = readF32Vec(view, base);
    out.velocity = readF32Vec(view, base + 12);
    out.acceleration = readF32Vec(view, base + 24);
    out.rotation = readQuat(bytes, view, base + 36, 32);
    if (len >= base + 60) out.angularVelocity = readF32Vec(view, base + 48);
  }
  return out;
}

export const EXTRA_FLEXIBLE = 0x10;
export const EXTRA_LIGHT = 0x20;
export const EXTRA_SCULPT = 0x30;
export const EXTRA_LIGHT_IMAGE = 0x40;
export const EXTRA_RENDER_MATERIAL = 0x60;
export const EXTRA_REFLECTION_PROBE = 0x80;

function paramsFromExtra(sculpt) {
  if (!sculpt) return null;
  return { sculptType: sculpt.type, sculptId: sculpt.texture, sculptTexture: null };
}

// ExtraParams is a TLV list: [type U8][size U8][payload...].
export function decodeExtraParams(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { sculpt: null, flexible: null, light: null, raw: [] };
  let p = 0;
  while (p + 2 <= bytes.length) {
    const type = bytes[p];
    const size = bytes[p + 1];
    const body = bytes.subarray(p + 2, p + 2 + size);
    if (body.length < size) break;
    out.raw.push({ type, size });
    if (type === EXTRA_SCULPT && size >= 17) {
      let s = "";
      for (let i = 0; i < 16; i++) {
        s += body[i].toString(16).padStart(2, "0");
        if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
      }
      out.sculpt = { texture: s, type: body[16] };
    } else if (type === EXTRA_FLEXIBLE && size >= 28) {
      const f = new DataView(body.buffer, body.byteOffset, body.byteLength);
      out.flexible = {
        softness: f.getUint8(0), gravity: f.getFloat32(1, true), drag: f.getFloat32(5, true),
        wind: f.getFloat32(9, true), forceX: f.getFloat32(13, true), forceY: f.getFloat32(17, true),
        forceZ: f.getFloat32(21, true), tension: f.getFloat32(25, true),
      };
    } else if (type === EXTRA_LIGHT && size >= 16) {
      const f = new DataView(body.buffer, body.byteOffset, body.byteLength);
      out.light = {
        color: [f.getFloat32(0, true), f.getFloat32(4, true), f.getFloat32(8, true)],
        intensity: f.getFloat32(12, true), radius: f.getFloat32(16, true), falloff: f.getFloat32(20, true),
      };
    }
    p += 2 + size;
  }
  return out;
}

// The 23 shape bytes of ObjectUpdate are the same PathCurve/ProfileCurve/...
// fields the prim engine already consumes, so they map straight across.
export function primParamsFromShape(shape, extra) {
  const p = defaultPrimParams({
    pathCurve: shape.PathCurve ?? 16,
    profileCurve: shape.ProfileCurve ?? 1,
    pathBegin: shape.PathBegin ?? 0,
    pathEnd: shape.PathEnd ?? 0,
    pathScaleX: shape.PathScaleX ?? 100,
    pathScaleY: shape.PathScaleY ?? 100,
    pathShearX: shape.PathShearX ?? 0,
    pathShearY: shape.PathShearY ?? 0,
    pathTwist: shape.PathTwist ?? 0,
    pathTwistBegin: shape.PathTwistBegin ?? 0,
    pathRadiusOffset: shape.PathRadiusOffset ?? 0,
    pathTaperX: shape.PathTaperX ?? 0,
    pathTaperY: shape.PathTaperY ?? 0,
    pathRevolutions: shape.PathRevolutions ?? 0,
    pathSkew: shape.PathSkew ?? 0,
    profileBegin: shape.ProfileBegin ?? 0,
    profileEnd: shape.ProfileEnd ?? 0,
    profileHollow: shape.ProfileHollow ?? 0,
  });
  const fromExtra = extra ? paramsFromExtra(extra.sculpt) : null;
  if (fromExtra) Object.assign(p, fromExtra);
  if (extra && extra.flexible) p.flexible = extra.flexible;
  if (extra && extra.light) p.light = extra.light;
  return p;
}

// ObjectUpdateCompressed carries the same fields but at fixed offsets inside a
// zlib-less "compressed" blob; the first 16 bytes are the object UUID.
export const COMPRESSED_UPDATE_HAS_OWNER = 0x01;
export const COMPRESSED_UPDATE_HAS_TEXTURE_ENTRY = 0x02;

export function parseCompressedObjectData(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 + 4 + 1) return null;
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  const out = { fullID: s, localID: view.getUint32(16, true), pcode: 9, scale: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0, 1] };
  try {
    let p = 20;
    p += 1;
    const state = bytes[p++];
    out.state = state;
    p += 4;
    out.material = bytes[p++];
    out.clickAction = bytes[p++];
    out.scale = readF32Vec(view, p); p += 12;
    out.position = readF32Vec(view, p); p += 12;
    out.rotation = readQuat(bytes, view, p, 32); p += 12;
    const compFlags = view.getUint32(p, true); p += 4;
    if (compFlags & COMPRESSED_UPDATE_HAS_OWNER) p += 16;
    return out;
  } catch (e) {
    return out;
  }
}
