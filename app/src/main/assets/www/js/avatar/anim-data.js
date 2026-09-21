// The grid's animation files (`AnimationData`, the asset behind every animation
// in Second Life) and the 118 built-in ones the app ships.
//
// Format (little-endian; indra/llcharacter/llkeyframemotion.cpp), which is what
// this parser reads:
//
//   S32   unknown (always 1 in the shipped files; the viewer skips it)
//   S32   animPriority      — the animation's own priority (0..5)
//   F32   animLength        — seconds
//   char[] expressionName   — zero-terminated, often empty, sometimes an emote
//   F32   inPoint, outPoint — the loop window
//   S32   loop
//   F32   easeInTime, easeOutTime
//   S32   handPose
//   S32   numJoints
//     per joint:
//       char[] name          — zero-terminated, an avatar_skeleton.xml bone
//       S32    priority      — this joint's priority *within* the animation
//       S32    numRotKeyframes
//         per keyframe: U16 time, U16 x, U16 y, U16 z
//       S32    numPosKeyframes
//         per keyframe: U16 time, U16 x, U16 y, U16 z
//   S32   trailer (unread by the viewer: the shipped files end with 4 zero bytes)
//
// The keyframe U16s are fixed point: time maps onto 0..animLength, a rotation
// component onto -1..1 and a position component onto -5..5 metres. A rotation is
// stored as the *vector* part of a unit quaternion whose w is recovered as
// sqrt(1 - |v|²) (LLQuaternion::unpackFromVector3).
//
// Joint keyframes are grouped by that per-joint priority into "joint sets": one
// animation can drive the hips at priority 3 and the torso/head at priority 0,
// which is how a walk cycle keeps its legs while an upper-body animation takes
// over the arms. Playback (animation.js) blends those sets against the sets of
// the other animations the avatar is playing.
//
// The bundle in data/avatar/anims.gz is every shipped animation in one file:
//
//   "VSL-ANIM" (8) | U32 count | count × { U16 uuid[8] | U32 offset | U32 size } | blobs
//
// (offsets are from the start of the blob section). It is gzipped as a whole:
// 118 animations, ~335 KB raw / ~250 KB on disk.
const MAGIC = "VSL-ANIM";
const U16 = 1 / 65535;

let bundlePromise = null;

/** Parses one animation asset. Exported for the offline self-test. */
export function parseAnimation(bytes) {
  const len = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 4;
  const s32 = () => { const v = view.getInt32(p, true); p += 4; return v; };
  const f32 = () => { const v = view.getFloat32(p, true); p += 4; return v; };
  const u16 = () => { const v = view.getUint16(p, true); p += 2; return v; };
  const cstr = () => {
    let s = "", c;
    while (p < len && (c = bytes[p++])) s += String.fromCharCode(c);
    return s;
  };
  const anim = {
    priority: s32(), length: f32(), name: cstr(),
    inPoint: f32(), outPoint: f32(), loop: s32() !== 0,
    easeInTime: f32(), easeOutTime: f32(), handPose: s32(),
    sets: [], joints: [],
  };
  const numJoints = s32();
  for (let i = 0; i < numJoints; i++) {
    const name = cstr();
    const priority = s32();
    let n = s32();
    if (n < 0 || n > 10000) n = 0;
    const rot = new Array(n);
    for (let k = 0; k < n; k++) {
      const t = (u16() * U16) * anim.length;
      const x = (u16() * U16) * 2 - 1, y = (u16() * U16) * 2 - 1, z = (u16() * U16) * 2 - 1;
      const w2 = 1 - (x * x + y * y + z * z);
      rot[k] = { t, x, y, z, w: w2 > 0 ? Math.sqrt(w2) : 0 };
    }
    let m = s32();
    if (m < 0 || m > 10000) m = 0;
    const pos = new Array(m);
    for (let k = 0; k < m; k++) {
      const t = (u16() * U16) * anim.length;
      pos[k] = {
        t,
        x: (u16() * U16) * 10 - 5,
        y: (u16() * U16) * 10 - 5,
        z: (u16() * U16) * 10 - 5,
      };
    }
    const joint = { name, priority, rot, pos };
    anim.joints.push(joint);
    let set = anim.sets.find((s) => s.priority === priority);
    if (!set) { set = { priority, joints: [] }; anim.sets.push(set); }
    set.joints.push(joint);
  }
  anim.sets.sort((a, b) => a.priority - b.priority);
  return anim;
}

async function loadBundle() {
  if (!bundlePromise) {
    bundlePromise = (async () => {
      const { loadBytes } = await import("./assets.js");
      const bytes = await loadBytes("anims.gz");
      if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]) !== MAGIC) {
        throw new Error("data/avatar/anims.gz no es un paquete de animaciones");
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = view.getUint32(8, true);
      let p = 12;
      const table = new Array(count);
      for (let i = 0; i < count; i++) {
        let uuid = "";
        for (let k = 0; k < 16; k++) uuid += bytes[p + k].toString(16).padStart(2, "0");
        p += 16;
        const off = view.getUint32(p, true); p += 4;
        const size = view.getUint32(p, true); p += 4;
        table[i] = { uuid, off, size };
      }
      const dataStart = p;
      const map = new Map();
      for (const e of table) {
        map.set(e.uuid, bytes.subarray(dataStart + e.off, dataStart + e.off + e.size));
      }
      return map;
    })().catch((e) => { bundlePromise = null; throw e; });
  }
  return bundlePromise;
}

export function uuidKey(uuid) {
  if (!uuid) return "";
  return String(uuid).replace(/[{}-]/g, "").toLowerCase();
}

/** How many animations the app ships (loads and indexes the bundle). */
export async function shippedAnimationCount() {
  return (await loadBundle()).size;
}

/**
 * A parsed animation by UUID, or null when it is not one of the shipped ones —
 * a resident wearing a custom animation, which has to be downloaded from the
 * grid through the asset system (sl-session requests it and stores it in the
 * cache; until it arrives the animation simply is not played).
 */
export async function getAnimation(uuid) {
  const key = uuidKey(uuid);
  if (!key) return null;
  const map = await loadBundle();
  const bytes = map.get(key);
  if (!bytes) return null;
  const cached = parsed.get(key);
  if (cached) return cached;
  const anim = parseAnimation(bytes);
  parsed.set(key, anim);
  return anim;
}

const parsed = new Map();

// The animations every resident plays by default, with the names Lumiya uses for
// them (SLAvatarControl's animUUID_* constants) — the rest of the 118 ship too,
// and whatever else a resident plays arrives by UUID in AvatarAnimation.
export const DEFAULT_ANIMS = {
  stand: "2408fe9e-df1d-1d7d-f4ff-1384fa7b350f",
  walk: "6ed24bd8-91aa-4b12-ccc7-c97c857ab4e0",
  run: "05ddbff8-aaa9-92a1-2b74-8fe77a29b445",
  fly: "aec4610c-757f-bc4e-c092-c6e9caf18daf",
  hover: "4ae8016b-31b9-03bb-c401-b1ea941db41d",
  falldown: "666307d9-a860-572d-6fd4-c3ab8865c094",
  land: "7a17b059-12b2-41b1-570a-186368b6aa6f",
  prejump: "7a4e87fe-de39-6fcb-6223-024b00893244",
  softland: "f4f00d6e-b9fe-9292-f4cb-0ae06ea58d57",
  standup: "3da1d753-028a-5446-24f3-9c9b856d9422",
};

/** The shipped animations as a list of { uuid, name, length, priority, loop }. */
export async function listAnimations() {
  const map = await loadBundle();
  const named = new Map(Object.entries(DEFAULT_ANIMS).map(([k, v]) => [uuidKey(v), k]));
  const out = [];
  for (const [uuid, bytes] of map) {
    const anim = parsed.get(uuid) || parseAnimation(bytes);
    parsed.set(uuid, anim);
    out.push({ uuid, name: named.get(uuid) || anim.name || "", length: anim.length, priority: anim.priority, loop: anim.loop });
  }
  return out;
}
