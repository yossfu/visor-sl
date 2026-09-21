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

export function uuidHex(bytes, off = 0) {
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += (bytes[off + i] || 0).toString(16).padStart(2, "0");
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

/**
 * One extra-parameter entry. The payload formats are the `LLNetworkData`
 * subclasses' `unpack` (indra/llprimitive/llprimitive.cpp), *not* the
 * PRIM_* script constants:
 *
 *   Flexible (0x10): U8 tension, U8 drag, U8 gravity, U8 wind, [F32 force x/y/z]
 *   Light    (0x20): LLColor4U color (4×U8), F32 radius, F32 cutoff, F32 falloff
 *   Sculpt   (0x30): LLUUID texture, U8 type            (also sent as 0x60)
 */
export function decodeParameterEntry(type, body) {
  if (!body || !body.length) return null;
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (type === EXTRA_FLEXIBLE && body.length >= 4) {
    return {
      kind: "flexible",
      value: {
        tension: (body[0] & 0x7f) / 10,
        drag: (body[1] & 0x7f) / 10,
        gravity: body[2] / 10 - 10,
        wind: body[3] / 10,
        simulateLOD: ((body[0] >> 6) & 2) | ((body[1] >> 7) & 1),
        force: body.length >= 16
          ? [v.getFloat32(4, true), v.getFloat32(8, true), v.getFloat32(12, true)]
          : [0, 0, 0],
      },
    };
  }
  if (type === EXTRA_LIGHT && body.length >= 16) {
    return {
      kind: "light",
      value: {
        color: [body[0] / 255, body[1] / 255, body[2] / 255],
        alpha: body[3] / 255,
        radius: v.getFloat32(4, true),
        cutoff: v.getFloat32(8, true),
        falloff: v.getFloat32(12, true),
      },
    };
  }
  if ((type === EXTRA_SCULPT || type === EXTRA_RENDER_MATERIAL) && body.length >= 17) {
    return { kind: "sculpt", value: { texture: uuidHex(body, 0), type: body[16] } };
  }
  return null;
}

/**
 * ExtraParams of *both* ObjectUpdate and ObjectUpdateCompressed: a TLV list
 *   U8 count, then per entry U16 type, S32 size, payload
 * (llviewerobject.cpp, `unpackU8(num_params)` / `unpackU16(param_type)` /
 * `unpackBinaryData(param_block, ..., param_size, "param_data")`).
 */
export function decodeExtraParams(bytes) {
  const out = { sculpt: null, flexible: null, light: null, raw: [], count: 0 };
  if (!bytes || !bytes.length) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes[0];
  out.count = count;
  let p = 1;
  for (let i = 0; i < count; i++) {
    if (p + 6 > bytes.length) break;
    const type = view.getUint16(p, true); p += 2;
    const size = view.getInt32(p, true); p += 4;
    if (size < 0 || p + size > bytes.length) break;
    out.raw.push({ type, size });
    const entry = decodeParameterEntry(type, bytes.subarray(p, p + size));
    if (entry) out[entry.kind] = entry.value;
    p += size;
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

// The "SpecialCode" of ObjectUpdateCompressed. Note 0x01 is the *scratchpad*,
// not "has owner": the owner UUID is unconditional
// (llviewerobject.cpp `LLViewerObject::initObjectDataMap`).
export const COMPRESSED_SCRATCHPAD = 0x01;
export const COMPRESSED_TREE = 0x02;
export const COMPRESSED_TEXT = 0x04;
export const COMPRESSED_PARTICLES = 0x08;
export const COMPRESSED_SOUND = 0x10;
export const COMPRESSED_PARENT = 0x20;
export const COMPRESSED_OMEGA = 0x80;
export const COMPRESSED_NAME_VALUES = 0x100;
export const COMPRESSED_MEDIA = 0x200;
export const COMPRESSED_PARTICLE_SYSTEM = 0x400;

/** NUL-terminated string (the binary datapacker's `unpackString`). */
function readCString(bytes, p) {
  let end = p;
  while (end < bytes.length && bytes[end] !== 0) end++;
  let s = "";
  for (let i = p; i < end; i++) s += String.fromCharCode(bytes[i]);
  return { value: s, end: end + 1 };
}

/**
 * Walks the flag-conditional middle of the compressed blob and then the two
 * fixed blocks that close it: the prim shape (path + profile, the same values
 * ObjectUpdate carries) and, last, the TextureEntry.
 *
 * Only the *scratchpad* block is ambiguous between implementations (the
 * official viewer reads a U32 size then a length-prefixed binary blob, Lumiya
 * a single U8 size); both are tried and the caller keeps whichever one lands
 * exactly on the end of the buffer.
 */
function walkCompressed(bytes, view, flags, scratchpadMode) {
  const out = {
    omega: [0, 0, 0], parentID: 0, text: "", textColor: null, mediaURL: "",
    nameValue: "", treeData: null, extra: null, shape: null, textureEntryBytes: null,
  };
  let p = 84;
  if (flags & COMPRESSED_OMEGA) { out.omega = readF32Vec(view, p); p += 12; }
  if (flags & COMPRESSED_PARENT) { out.parentID = view.getUint32(p, true); p += 4; }
  if (flags & COMPRESSED_TREE) {
    out.treeData = bytes[p];
    p += 1;
  } else if (flags & COMPRESSED_SCRATCHPAD) {
    if (scratchpadMode === "lumiya") {
      const n = bytes[p];
      p += 1 + n;
    } else {
      p += 4;
      const n = view.getInt32(p, true);
      p += 4 + n;
    }
  }
  if (p > bytes.length) return null;
  if (flags & COMPRESSED_TEXT) {
    const s = readCString(bytes, p);
    out.text = s.value;
    p = s.end + 4; // LLColor4U, with the alpha byte flipped by the sender
  }
  if (p > bytes.length) return null;
  if (flags & COMPRESSED_MEDIA) {
    const s = readCString(bytes, p);
    out.mediaURL = s.value;
    p = s.end;
  }
  if (p > bytes.length) return null;
  if (flags & COMPRESSED_PARTICLES) p += 0x56; // legacy LLPartSysData
  if (p >= bytes.length) return null;
  const count = bytes[p];
  p += 1;
  const extra = { sculpt: null, flexible: null, light: null, raw: [], count };
  for (let i = 0; i < count; i++) {
    if (p + 6 > bytes.length) return null;
    const type = view.getUint16(p, true); p += 2;
    const size = view.getInt32(p, true); p += 4;
    if (size < 0 || p + size > bytes.length) return null;
    extra.raw.push({ type, size });
    const entry = decodeParameterEntry(type, bytes.subarray(p, p + size));
    if (entry) extra[entry.kind] = entry.value;
    p += size;
  }
  out.extra = extra;
  if (flags & COMPRESSED_SOUND) p += 16 + 4 + 1 + 4; // UUID, gain, flags, radius
  if (p > bytes.length) return null;
  if (flags & COMPRESSED_NAME_VALUES) {
    const s = readCString(bytes, p);
    out.nameValue = s.value;
    p = s.end;
  }
  if (p > bytes.length) return null;
  // PathCurve..PathSkew (16 bytes), then ProfileCurve..ProfileHollow (7).
  if (p + 23 + 4 > bytes.length) return null;
  const q = p;
  out.shape = {
    pathCurve: bytes[q],
    pathBegin: view.getUint16(q + 1, true),
    pathEnd: view.getUint16(q + 3, true),
    pathScaleX: bytes[q + 5],
    pathScaleY: bytes[q + 6],
    pathShearX: bytes[q + 7],
    pathShearY: bytes[q + 8],
    pathTwist: bytes[q + 9],
    pathTwistBegin: bytes[q + 10],
    pathRadiusOffset: bytes[q + 11],
    pathTaperX: bytes[q + 12],
    pathTaperY: bytes[q + 13],
    pathRevolutions: bytes[q + 14],
    pathSkew: bytes[q + 15],
    profileCurve: bytes[q + 16],
    profileBegin: view.getUint16(q + 17, true),
    profileEnd: view.getUint16(q + 19, true),
    profileHollow: view.getUint16(q + 21, true),
  };
  p = q + 23;
  const teSize = view.getInt32(p, true);
  p += 4;
  if (teSize < 0 || p + teSize !== bytes.length) return null;
  out.textureEntryBytes = bytes.subarray(p, p + teSize);
  out.tailBytes = teSize;
  return out;
}

/**
 * The Data block of ObjectUpdateCompressed. Fixed header (see
 * `LLViewerObject::initObjectDataMap`), then a flag-conditional middle, then the
 * prim shape and the TextureEntry *at the end* — which is why a viewer that
 * stops after the owner UUID sees every compressed prim as an untextured cube.
 * Returns null if the header itself is short; `tailOk: false` if the shape /
 * texture tail could not be located (position and rotation are still usable).
 */
export function parseCompressedObjectData(bytes) {
  if (!bytes || bytes.length < 85) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {
    fullID: uuidHex(bytes, 0),
    localID: view.getUint32(16, true),
    pcode: bytes[20] || PCODE_PRIM,
    state: bytes[21],
    crc: view.getUint32(22, true),
    material: bytes[26],
    clickAction: bytes[27],
    scale: readF32Vec(view, 28),
    position: readF32Vec(view, 40),
    rotation: quatFrom3(
      view.getFloat32(52, true), view.getFloat32(56, true), view.getFloat32(60, true)),
    compFlags: view.getUint32(64, true),
    ownerID: uuidHex(bytes, 68),
    omega: [0, 0, 0], parentID: 0, text: "", mediaURL: "", nameValue: "",
    shape: null, textureEntryBytes: null, extra: null, tailOk: false,
  };
  const flags = out.compFlags;
  for (const mode of ["lumiya", "ll"]) {
    const tail = walkCompressed(bytes, view, flags, mode);
    if (tail) {
      Object.assign(out, tail);
      out.tailOk = true;
      out.scratchpadMode = mode;
      break;
    }
    if (!(flags & COMPRESSED_SCRATCHPAD)) break; // both modes are identical
  }
  return out;
}

/** Same shape as `primParamsFromShape`, fed from a compressed blob's tail. */
export function primParamsFromPacked(shape, extra) {
  const p = defaultPrimParams(Object.assign({}, shape));
  const fromExtra = extra ? paramsFromExtra(extra.sculpt) : null;
  if (fromExtra) Object.assign(p, fromExtra);
  if (extra && extra.flexible) p.flexible = extra.flexible;
  if (extra && extra.light) p.light = extra.light;
  return p;
}
