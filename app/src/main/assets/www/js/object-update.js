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
// Decode windows from the official viewer (llviewerobject.cpp, 16-bit terse
// path, and llworld.h): the region is 256 m wide, its floor is at -256 m and
// objects top out at MAX_OBJECT_Z = 4096 m.
//
//   pos.xy  -> U16_to_F32(v, -0.5*width, 1.5*width)   = [-128, 384]
//   pos.z   -> U16_to_F32(v, MIN_HEIGHT, MAX_HEIGHT)  = [-256, 4096]
//   vel/acc/omega -> U16_to_F32(v, -width, width)     = [-256, 256]
//   rotation -> four U16s, each U16_to_F32(v, -1, 1)  (x, y, z, w)
export const POS_XY = [-128, 384];
export const POS_Z = [-256, 4096];
export const VEL_XY = [-256, 256];
export const VEL_Z = [-256, 256];
// Legacy 8-bit quantisation (size 16; the SL servers do not send it any more,
// but Lumiya accepted it and some OpenSim grids still do).
export const U8_POS_XY = [-128, 384];
export const U8_VEL = [-256, 256];

function quantVec(view, off, xy, z) {
  return [
    dequantize(U16_STEP, view.getUint16(off, true), xy[0], xy[1]),
    dequantize(U16_STEP, view.getUint16(off + 2, true), xy[0], xy[1]),
    dequantize(U16_STEP, view.getUint16(off + 4, true), z[0], z[1]),
  ];
}

// All four quaternion components are on the wire in the 16-bit form (the
// official viewer reads four U16s); deriving w from x,y,z loses the sign.
function quantQuat(view, off) {
  const q = [
    dequantize(U16_STEP, view.getUint16(off, true), -1, 1),
    dequantize(U16_STEP, view.getUint16(off + 2, true), -1, 1),
    dequantize(U16_STEP, view.getUint16(off + 4, true), -1, 1),
    dequantize(U16_STEP, view.getUint16(off + 6, true), -1, 1),
  ];
  const m = Math.hypot(q[0], q[1], q[2], q[3]);
  return m > 0 ? [q[0] / m, q[1] / m, q[2] / m, q[3] / m] : [0, 0, 0, 1];
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

// ImprovedTerseObjectUpdate / the Data block of ObjectUpdate. The official
// viewer (llviewerobject.cpp, processUpdateMessage) accepts exactly these
// payloads and nothing else — anything else it logs as "Unexpected ObjectData
// buffer size":
//   16  legacy 8-bit quantised (x,y,z / vel / acc / 3-component rotation)
//   32  terse 16-bit: pos, vel, acc, rotation (4 components!), omega
//   48  same as 32 but preceded by a 16-byte collision plane (avatars)
//   64/80  the "extended" variants of 32/48 (extra trailing data, unused)
//   60  full precision: pos, vel, acc, rotation (3 floats, w derived), omega
//   76  same as 60 preceded by the 16-byte collision plane (avatars)
export function decodeTerseObjectData(bytes) {
  const len = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = { position: [0, 0, 0], velocity: [0, 0, 0], acceleration: [0, 0, 0], rotation: [0, 0, 0, 1], angularVelocity: [0, 0, 0], quantised: true };
  if (len === 16) {
    out.position = [
      dequantize(U8_STEP, bytes[0], U8_POS_XY[0], U8_POS_XY[1]),
      dequantize(U8_STEP, bytes[1], U8_POS_XY[0], U8_POS_XY[1]),
      dequantize(U8_STEP, bytes[2], POS_Z[0], POS_Z[1]),
    ];
    out.velocity = [
      dequantize(U8_STEP, bytes[3], U8_VEL[0], U8_VEL[1]),
      dequantize(U8_STEP, bytes[4], U8_VEL[0], U8_VEL[1]),
      dequantize(U8_STEP, bytes[5], U8_VEL[0], U8_VEL[1]),
    ];
    out.acceleration = [
      dequantize(U8_STEP, bytes[6], U8_VEL[0], U8_VEL[1]),
      dequantize(U8_STEP, bytes[7], U8_VEL[0], U8_VEL[1]),
      dequantize(U8_STEP, bytes[8], U8_VEL[0], U8_VEL[1]),
    ];
    out.rotation = quatFrom3(
      dequantize(U8_STEP, bytes[9], -1, 1),
      dequantize(U8_STEP, bytes[10], -1, 1),
      dequantize(U8_STEP, bytes[11], -1, 1)
    );
  } else if (len >= 32 && len < 60) {
    // Avatars carry a collision plane first (48 = 16 + 32, 80 = 16 + 64).
    const base = (len === 48 || len === 80) ? 16 : 0;
    out.position = quantVec(view, base, POS_XY, POS_Z);
    out.velocity = quantVec(view, base + 6, VEL_XY, VEL_Z);
    out.acceleration = quantVec(view, base + 12, VEL_XY, VEL_Z);
    out.rotation = quantQuat(view, base + 18);
    out.angularVelocity = quantVec(view, base + 26, VEL_XY, VEL_Z);
  } else if (len >= 60) {
    const base = len >= 76 && len < 124 ? 16 : 0;
    out.quantised = false;
    out.position = readF32Vec(view, base);
    out.velocity = readF32Vec(view, base + 12);
    out.acceleration = readF32Vec(view, base + 24);
    out.rotation = readQuat(bytes, view, base + 36, 32);
    if (len >= base + 60) out.angularVelocity = readF32Vec(view, base + 48);
  }
  return out;
}

/**
 * The Data blob of ImprovedTerseObjectUpdate. Unlike ObjectUpdate's ObjectData
 * field, this one carries the object's local ID and state itself, and the viewer
 * (llviewerobject.cpp, OUT_TERSE_IMPROVED with a data packer) reads:
 *
 *   U32 LocalID, U8 State, U8 hasCollisionPlane,
 *   [LLVector4 plane (16) when hasCollisionPlane],
 *   F32 x/y/z position,
 *   U16 velocity x3   (-128, 128)
 *   U16 acceleration x3, U16 rotation x4 (-1, 1), U16 omega x3   (all -64, 64)
 */
export function decodeImprovedTerse(data) {
  const bytes = data || new Uint8Array(0);
  if (bytes.length < 6) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  const localID = view.getUint32(0, true); p += 4;
  const state = bytes[p++];
  const hasPlane = bytes[p++];
  if (hasPlane) p += 16;
  if (p + 12 + 6 + 6 + 8 + 6 > bytes.length) return null;
  const position = [view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true)];
  p += 12;
  const vel = quantVec(view, p, [-128, 128], [-128, 128]); p += 6;
  const acc = quantVec(view, p, [-64, 64], [-64, 64]); p += 6;
  const rotation = quantQuat(view, p); p += 8;
  const omega = quantVec(view, p, [-64, 64], [-64, 64]);
  return {
    localID, state, isAvatar: (state & 1) !== 0, hasPlane: !!hasPlane,
    position, velocity: vel, acceleration: acc, rotation, angularVelocity: omega,
  };
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
  // Layout (see the official viewer's compressed unpacking): FullID (16),
  // LocalID (4), PCode (1), State (1), CRC (4), Material (1), ClickAction (1),
  // Scale (12), Position (12), Rotation (12), CompressedFlags (4),
  // [OwnerID (16) if flag 0x01].
  const out = {
    fullID: s, localID: view.getUint32(16, true), pcode: bytes[20] || PCODE_PRIM,
    scale: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0, 1],
  };
  try {
    let p = 21;
    out.state = bytes[p++];
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
