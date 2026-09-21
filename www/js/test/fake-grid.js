// Offline integration harness: a fake simulator + a fake native bridge.
//
// A browser cannot open the UDP socket Second Life needs, so with no Android
// app and no grid account the whole region path (login → capabilities → UDP
// circuit → handshake → terrain → prims → avatars → textures) can never be
// exercised. This module installs `window.VisorNative` implemented in JS and
// answers with real protocol packets built from data/message_template.msg, so
// the viewer can be driven end to end in the editor:
//
//   index.html?test=grid
//
// It is a test rig only: nothing in the shipped viewer imports it except the
// `?test=grid` branch of app.js's boot().
import { LLSD } from "../llsd.js";
import { buildMessage, buildPacket, parsePacket, decodeMessage } from "../udp.js";
import { uuidBytes, uuidString, toBytes, toText } from "../message-template.js";
import { loadMessageTemplate } from "../sl-session.js";
import { installSink } from "../transport.js";
import { LAYER_TYPE_LAND } from "../terrain.js";
import { houseMeshAsset, boxMeshAsset } from "./mesh-fixture.js";

export const FAKE = {
  region: "Harness Cove",
  water: 20,
  // The regions the fake grid's map knows about. `MapNameRequest` is answered
  // from this list, which is what the region search and the map's region names
  // are checked against without a real grid.
  regions: [
    { name: "Ahern", gx: 997, gy: 1002 },
    { name: "Harness Cove", gx: 1000, gy: 1000 },
    { name: "Harness Cove North", gx: 1000, gy: 1001 },
    { name: "Sandbox Cordova", gx: 1004, gy: 1006 },
    { name: "Sandbox Wanderton", gx: 1006, gy: 1004 },
    { name: "London City", gx: 995, gy: 999 },
    { name: "Welcome Island", gx: 1000, gy: 996 },
  ],
  // The ground under the agent: the same formula terrainPatches() uses, sampled
  // at the centre patch, so the avatar stands on the harness terrain.
  agentPos: [128, 128, 0],
  seedUrl: "https://fake.agni.lindenlab.com/CAPS/seed",
  textureUrl: "https://fake.agni.lindenlab.com/CAPS/GetTexture/c0ffee",
  eqUrl: "https://fake.agni.lindenlab.com/CAPS/EventQueueGet/c0ffee",
  meshUrl: "https://fake.agni.lindenlab.com/CAPS/GetMesh/c0ffee",
  // Mesh assets the harness serves: a two-material house and a plain box. A
  // region is mostly mesh in the real grid, so the harness is mostly mesh too.
  meshes: { house: "d0000000-0000-4000-8000-000000000001", box: "d0000000-0000-4000-8000-000000000002" },
};
FAKE.agentPos[2] = terrainH(FAKE.agentPos[0], FAKE.agentPos[1]) + 3;

const AGENT_ID = "11111111-2222-3333-4444-555555555555";
const SESSION_ID = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const NEIGHBOUR_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const NEIGHBOUR_NAME = "Vecina Resident";

// Height of the synthetic terrain patch containing a world position (the same
// formula terrainPatches() packs, so the prims and the avatar stand on it).
function terrainH(x, y) {
  const px = Math.max(0, Math.min(15, Math.floor(x / 16)));
  const py = Math.max(0, Math.min(15, Math.floor(y / 16)));
  return 26 + 6 * Math.sin(px * 0.7) * Math.cos(py * 0.5);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function bitWriter() {
  const out = [];
  return {
    put(v, n) { for (let i = n - 1; i >= 0; i--) out.push((v >>> i) & 1); },
    bytes() {
      const b = new Uint8Array(Math.ceil(out.length / 8));
      out.forEach((bit, i) => { if (bit) b[i >> 3] |= 1 << (7 - (i & 7)); });
      return b;
    },
  };
}

function writer() {
  const out = [];
  const dv = new DataView(new ArrayBuffer(8));
  const w = {
    u8: (v) => { out.push(v & 0xff); return w; },
    u32(v) {
      dv.setUint32(0, v >>> 0, true);
      for (let i = 0; i < 4; i++) out.push(dv.getUint8(i));
      return w;
    },
    u16(v) { out.push(v & 0xff, (v >> 8) & 0xff); return w; },
    f32(v) {
      dv.setFloat32(0, v, true);
      for (let i = 0; i < 4; i++) out.push(dv.getUint8(i));
      return w;
    },
    uuid(id) { for (const b of uuidBytes(id)) out.push(b); return w; },
    raw(arr) { for (const b of arr) out.push(b); return w; },
    bytes: () => new Uint8Array(out),
  };
  return w;
}

/**
 * The LayerData codestream: DCT patches packed in ONE continuous bit stream per
 * datagram (the decoder does not re-align between patches) and terminated by the
 * 97 sentinel. A real simulator also splits a region over several datagrams, so
 * the 256 patches go out in chunks that each end on a patch boundary.
 * `quantWBits` 8 packs wordBits = 10 and q = 2, so scale = range/4 and the DC
 * coefficient contributes coeff * 0.0625 * scale.
 */
function terrainPatches(perChunk = 64) {
  const chunks = [];
  let b = bitWriter();
  const header = () => { b.put(16, 16); b.put(16, 8); b.put(LAYER_TYPE_LAND, 8); };
  header();
  for (let n = 0; n < 256; n++) {
    const px = Math.floor(n / 16), py = n % 16;
    const h = terrainH(px * 16 + 8, py * 16 + 8);
    b.put(8, 8);
    const f = new DataView(new ArrayBuffer(4));
    f.setFloat32(0, h - 2, false);           // DCOffset (big-endian float bits)
    b.put(f.getUint32(0, false), 32);
    b.put(4, 16);                            // Range
    b.put(((px & 31) << 5) | (py & 31), 10); // PatchIDs
    b.put(1, 1); b.put(0, 1);                // "the rest of the coefficients are zero"
    if ((n + 1) % perChunk === 0) {
      b.put(97, 8);
      chunks.push(b.bytes());
      b = bitWriter();
      header();
    }
  }
  b.put(97, 8);
  chunks.push(b.bytes());
  return chunks;
}

const Q16 = (v, min, max) => Math.round(((v - min) / (max - min)) * 65535) & 0xffff;

/**
 * A real TextureEntry: every attribute section is present (default value, then a
 * face bitfield list terminated by 0). Only the default texture id is set here,
 * which is what most prims on the grid look like.
 */
function textureEntry(texId, { rgba = 0xffffffff, repeatU = 1, repeatV = 1, glow = 0, material = 0, faces = null } = {}) {
  const w = writer();
  // A section is: the default value, then a list of (face bitfield, value).
  // A face bitfield is a big-endian 7-bits-per-byte number whose high bit means
  // "another byte of the same field follows", so a face below 8 is one byte with
  // the high bit CLEAR — that is what ends the field. The list ends with a
  // 0x00 bitfield. A mesh has one face per material, which is how each material
  // of an asset gets its own texture and tint.
  const overrides = (map, writeValue) => {
    if (map) {
      for (const key of Object.keys(map).map(Number).sort((a, b) => a - b)) {
        if (!(key >= 0 && key < 8)) continue;
        w.u8(1 << key);
        writeValue(map[key]);
      }
    }
    w.u8(0);
  };
  w.uuid(texId);
  overrides(faces && faces.texture, (v) => w.uuid(v));
  w.u32(rgba);
  overrides(faces && faces.rgba, (v) => w.u32(v));
  w.f32(repeatU).u8(0);
  w.f32(repeatV).u8(0);
  w.u16(0).u8(0);                // offsetU
  w.u16(0).u8(0);                // offsetV
  w.u16(0).u8(0);                // rotation
  w.u8(material).u8(0);
  w.u8(0).u8(0);                 // media
  w.u8(Math.round(glow * 255)).u8(0);
  return w.bytes();
}

/** A texture id whose first byte drives texturePaint(), so each prim differs. */
function primTexture(localID) {
  const n = ((localID * 37) % 256).toString(16).padStart(2, "0");
  return `${n}00000-0000-4000-8000-000000000000`;
}

/**
 * ObjectUpdateCompressed payload. This is the *real* layout the grid uses
 * (llviewerobject.cpp + Lumiya's decompiled `SLObjectInfo.ApplyObjectUpdate`):
 * fixed header, flag-conditional middle, and finally the prim shape (path +
 * profile, 23 bytes) and the TextureEntry right at the end — the two blocks a
 * viewer that stops after the owner UUID never sees.
 */
/**
 * ExtraParams TLV: U8 count, then per entry U16 type, S32 size, payload. A mesh
 * prim carries `PARAMS_MESH` (0x60), whose payload is exactly the sculpt one —
 * a big-endian UUID plus the "sculpt" type byte, where 5 means `SCULPT_TYPE_MESH`
 * (llprimitive.cpp / Lumiya's `PrimVolumeParams.unpackExtraParams`). That is how
 * a mesh prim names its asset on the wire.
 */
function meshExtraParams(uuid, sculptType = 5) {
  const w = writer();
  w.u8(1);                     // one parameter
  w.u16(0x60);                 // PARAMS_MESH
  w.u32(17).raw(uuidBytes(uuid)).u8(sculptType);
  return w.bytes();
}

function compressedObject({ fullID, id, localID, scale, position, rotation, pcode = 9, params, texture, extra, materials }) {
  const P = Object.assign({
    pathCurve: 16, pathBegin: 0, pathEnd: 0, pathScaleX: 100, pathScaleY: 100,
    pathShearX: 0, pathShearY: 0, pathTwist: 0, pathTwistBegin: 0, pathRadiusOffset: 0,
    pathTaperX: 0, pathTaperY: 0, pathRevolutions: 0, pathSkew: 0,
    profileCurve: 1, profileBegin: 0, profileEnd: 0, profileHollow: 0,
  }, params || {});
  const w = writer();
  w.uuid(fullID || id).u32(localID).u8(pcode).u8(0).u32(1).u8(0).u8(0);
  w.f32(scale[0]).f32(scale[1]).f32(scale[2]);
  w.f32(position[0]).f32(position[1]).f32(position[2]);
  const r = rotation || [0, 0, 0];
  w.f32(r[0]).f32(r[1]).f32(r[2]);
  w.u32(0);                       // SpecialCode: no conditional fields
  w.uuid(AGENT_ID);               // Owner — unconditional, NOT flag-driven
  if (extra) w.raw(extra);        // ExtraParams (mesh/sculpt/flexible/...)
  else w.u8(0);                   // no ExtraParams
  w.u8(P.pathCurve).u16(P.pathBegin).u16(P.pathEnd)
    .u8(P.pathScaleX).u8(P.pathScaleY).u8(P.pathShearX).u8(P.pathShearY)
    .u8(P.pathTwist).u8(P.pathTwistBegin).u8(P.pathRadiusOffset)
    .u8(P.pathTaperX).u8(P.pathTaperY).u8(P.pathRevolutions).u8(P.pathSkew)
    .u8(P.profileCurve).u16(P.profileBegin).u16(P.profileEnd).u16(P.profileHollow);
  const te = textureEntry(texture || primTexture(localID), { faces: materials });
  w.u32(te.length).raw(te);       // S32 TextureEntry size, then the entry itself
  return w.bytes();
}

// 60-byte full-precision ObjectData: pos, vel, acc, rotation (3 floats), omega.
function terseFull(position, rotation) {
  const w = writer();
  w.f32(position[0]).f32(position[1]).f32(position[2]);
  w.raw(new Uint8Array(24));
  w.f32(rotation[0]).f32(rotation[1]).f32(rotation[2]);
  w.raw(new Uint8Array(12));
  return w.bytes();
}

// Data blob of ImprovedTerseObjectUpdate: LocalID, State, agent flag, [plane],
// position (floats), velocity/acceleration/rotation/omega quantised.
function terseQuant(localID, position, rotation, opts = {}) {
  const w = writer();
  w.u32(localID).u8(opts.state ?? 0).u8(opts.plane ? 1 : 0);
  if (opts.plane) w.raw(new Uint8Array(16));
  w.f32(position[0]).f32(position[1]).f32(position[2]);
  for (let i = 0; i < 3; i++) w.u16(Q16(0, -128, 128));
  for (let i = 0; i < 3; i++) w.u16(Q16(0, -64, 64));
  for (const c of rotation) w.u16(Q16(c, -1, 1));
  for (let i = 0; i < 3; i++) w.u16(Q16(0, -64, 64));
  return w.bytes();
}

// ---------------------------------------------------------------------------
// fake simulator
// ---------------------------------------------------------------------------
class FakeSim {
  constructor(opts = {}) {
    this.opts = opts;
    this.localID = 1000;
    this.primCount = opts.prims ?? 42;
  }

  async init() {
    const t = await loadMessageTemplate();
    this.defs = t.defs;
    this.index = t.index;
    this.seq = 1000;
    this.regionHandle = 1000n * 256n * 4294967296n + 1000n * 256n;  // region (1000, 1000)
    this.regionName = FAKE.region;
    this.primPositions = new Map();
  }

  /** The name a teleport destination gets, from its region handle. */
  regionNameFor(handle) {
    const h = BigInt(handle);
    const gx = Number(h >> 32n) / 256;
    const gy = Number(h & 0xffffffffn) / 256;
    return `${FAKE.region} (${gx}, ${gy})`;
  }

  packet(name, obj, { reliable = false, acks = null } = {}) {
    const payload = buildMessage(this.defs.get(name), obj);
    return buildPacket({ sequence: ++this.seq, reliable, payload, acks });
  }

  buildPrims() {
    const out = [];
    const cx = FAKE.agentPos[0], cy = FAKE.agentPos[1];
    const shapes = [[6, 6, 0.5], [4, 4, 4], [3, 3, 8], [2, 2, 12], [8, 2, 1], [1.5, 1.5, 5]];
    // Every compressed prim is a different primitive type, so a viewer that
    // fails to read the shape tail shows a field of identical default cubes.
    const types = [
      { pathCurve: 16, profileCurve: 1 },                                   // caja
      { pathCurve: 16, profileCurve: 0 },                                   // cilindro
      { pathCurve: 32, profileCurve: 5 },                                   // esfera
      { pathCurve: 16, profileCurve: 3 },                                   // prisma
      { pathCurve: 32, profileCurve: 0 },                                   // toro
      { pathCurve: 16, profileCurve: 1, pathScaleX: 60, pathScaleY: 150 },  // troncocónico
      { pathCurve: 48, profileCurve: 0 },                                   // tubo
      { pathCurve: 16, profileCurve: 2 },                                   // medio cono
    ];
    let i = 0;
    for (let ring = 0; ring < 3; ring++) {
      const r = 10 + ring * 12;
      const n = 6 + ring * 6;
      for (let k = 0; k < n && i < this.primCount; k++, i++) {
        const a = (k / n) * Math.PI * 2 + ring;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        const s = shapes[i % shapes.length];
        const localID = ++this.localID;
        out.push({
          localID, id: `00000000-0000-4000-8000-${String(localID).padStart(12, "0")}`,
          position: [x, y, terrainH(x, y) + s[2] / 2 + 0.1],
          scale: s, pcode: 9,
          params: types[i % types.length],
          texture: primTexture(localID),
        });
      }
    }
    out.push({ localID: ++this.localID, id: "00000000-0000-4000-8000-00000000aa01", position: [cx + 4, cy - 18, terrainH(cx + 4, cy - 18) + 3.5], scale: [4, 4, 7], pcode: 111 });
    out.push({ localID: ++this.localID, id: "00000000-0000-4000-8000-00000000aa02", position: [cx - 12, cy + 9, terrainH(cx - 12, cy + 9) + 0.5], scale: [6, 6, 1], pcode: 95 });
    return out;
  }

  /** Everything the simulator sends once the agent is in the region. */
  stream() {
    const out = [];
    out.push(this.packet("RegionHandshake", {
      RegionInfo: {
        SimName: toBytes(this.regionName || FAKE.region), SimOwner: uuidBytes(AGENT_ID), IsEstateManager: 0,
        WaterHeight: FAKE.water, BillableFactor: 1, CacheID: uuidBytes(AGENT_ID),
        TerrainStartHeight00: 10, TerrainStartHeight01: 20, TerrainHeightRange00: 50, TerrainHeightRange01: 60,
        SimAccess: 13, RegionFlags: 0,
      },
      RegionInfo2: { RegionID: uuidBytes(SESSION_ID), ProductName: toBytes("Mainland"), ProductSku: 0, RegionFlagsExtended: 0 },
    }));
    out.push(this.packet("AgentMovementComplete", {
      AgentData: { AgentID: uuidBytes(AGENT_ID), SessionID: uuidBytes(SESSION_ID) },
      Data: { Position: this.movementPos || FAKE.agentPos, LookAt: [1, 0, 0], RegionHandle: this.regionHandle, Timestamp: performance.now() },
      SimData: { ChannelVersion: new Uint8Array(0), SimulatorVersion: toBytes("harness") },
    }));
    out.push(this.packet("SimulatorViewerTimeMessage", {
      TimeInfo: { UsecSinceStart: 0.35 * 86400 * 1e6, SecPerDay: 86400, SecPerYear: 31536000, SunDirection: [0.4, 0.3, 0.85], SunPhase: 0.35, Phase: 0.35 },
    }));
    for (const chunk of terrainPatches()) {
      out.push(this.packet("LayerData", { LayerID: { Type: LAYER_TYPE_LAND }, LayerData: { Data: chunk } }));
    }

    const prims = this.buildPrims();
    for (const p of prims) this.primPositions.set(p.localID, p);
    out.push(this.packet("ObjectUpdateCompressed", {
      RegionData: { RegionHandle: this.regionHandle, TimeDilation: 65535 },
      ObjectData: prims.map((p) => ({ UpdateFlags: 0, Data: compressedObject(p) })),
    }));

    // Three full updates with real shape parameters (cylinder, sphere, torus).
    const full = (p, params) => ({
      ID: p.localID, State: 0, FullID: uuidBytes(p.id), CRC: 0, PCode: p.pcode,
      Material: 3, ClickAction: 0, Scale: p.scale, ObjectData: terseFull(p.position, [0, 0, 0]),
      ParentID: 0, UpdateFlags: 0,
      PathCurve: params.pathCurve, ProfileCurve: params.profileCurve, PathBegin: 0, PathEnd: 0,
      PathScaleX: 100, PathScaleY: 100, PathShearX: 0, PathShearY: 0, PathTwist: 0, PathTwistBegin: 0,
      PathRadiusOffset: 0, PathTaperX: 0, PathTaperY: 0, PathRevolutions: 0, PathSkew: 0,
      ProfileBegin: 0, ProfileEnd: 0, ProfileHollow: 0,
      TextureEntry: textureEntry(p.texture), TextureAnim: new Uint8Array(0), NameValue: new Uint8Array(0),
      Data: new Uint8Array(0), Text: toBytes("hola"), TextColor: new Uint8Array([255, 255, 255, 255]),
      MediaURL: new Uint8Array(0), PSBlock: new Uint8Array(0), ExtraParams: new Uint8Array(0),
      Sound: uuidBytes("00000000-0000-0000-0000-000000000000"), OwnerID: uuidBytes(AGENT_ID),
      Gain: 0, Flags: 0, Radius: 0, JointType: 0, JointPivot: [0, 0, 0], JointAxisOrAnchor: [0, 0, 0],
    });
    const [cx, cy, cz] = FAKE.agentPos;
    const at = (dx, dy, h) => [cx + dx, cy + dy, terrainH(cx + dx, cy + dy) + h];
    const cylinder = { localID: ++this.localID, id: "00000000-0000-4000-8000-00000000bb01", position: at(-6, -6, 4.5), scale: [3, 3, 9], pcode: 9, texture: "a1111111-0000-4000-8000-000000000001" };
    const sphere = { localID: ++this.localID, id: "00000000-0000-4000-8000-00000000bb02", position: at(6, -9, 2), scale: [4, 4, 4], pcode: 9, texture: "b2222222-0000-4000-8000-000000000002" };
    const torus = { localID: ++this.localID, id: "00000000-0000-4000-8000-00000000bb03", position: at(0, -10, 3), scale: [3, 3, 3], pcode: 9, texture: "c3333333-0000-4000-8000-000000000003" };
    for (const p of [cylinder, sphere, torus]) this.primPositions.set(p.localID, p);
    out.push(this.packet("ObjectUpdate", {
      RegionData: { RegionHandle: this.regionHandle, TimeDilation: 65535 },
      ObjectData: [
        full(cylinder, { pathCurve: 16, profileCurve: 0 }),
        full(sphere, { pathCurve: 32, profileCurve: 5 }),
        full(torus, { pathCurve: 32, profileCurve: 0 }),
      ],
    }));

    // Mesh objects: the shape comes from an `LLMESH` asset, not from prim
    // parameters, so until the asset's decoder and its download path both work
    // these are simply missing from the world — which is most of it.
    const house = {
      localID: ++this.localID, id: "00000000-0000-4000-8000-00000000cc01",
      position: at(-11, 9, 1.6), scale: [1, 1, 1], pcode: 9,
      texture: "e4444444-0000-4000-8000-000000000004",
      extra: meshExtraParams(FAKE.meshes.house),
      materials: { rgba: { 0: 0xffeeeeee, 1: 0xff3030c0 } },  // pale walls, red roof
    };
    const meshBox = {
      localID: ++this.localID, id: "00000000-0000-4000-8000-00000000cc02",
      position: at(9, 10, 3.9), scale: [2.5, 2.5, 2.5], pcode: 9,
      texture: "f5555555-0000-4000-8000-000000000005",
      extra: meshExtraParams(FAKE.meshes.box),
    };
    for (const p of [house, meshBox]) this.primPositions.set(p.localID, p);
    out.push(this.packet("ObjectUpdateCompressed", {
      RegionData: { RegionHandle: this.regionHandle, TimeDilation: 65535 },
      ObjectData: [house, meshBox].map((p) => ({ UpdateFlags: 0, Data: compressedObject(p) })),
    }));

    // Our own avatar and a neighbour (both through the compressed path).
    this.selfLocalID = ++this.localID;
    this.neighbourLocalID = ++this.localID;
    this.primPositions.set(this.selfLocalID, { localID: this.selfLocalID, id: AGENT_ID, position: FAKE.agentPos, scale: [0.6, 0.6, 1.8], pcode: 47 });
    this.primPositions.set(this.neighbourLocalID, { localID: this.neighbourLocalID, id: NEIGHBOUR_ID, position: [cx + 5, cy + 5, cz], scale: [0.6, 0.6, 1.8], pcode: 47 });
    out.push(this.packet("ObjectUpdateCompressed", {
      RegionData: { RegionHandle: this.regionHandle, TimeDilation: 65535 },
      ObjectData: [
        { UpdateFlags: 0, Data: compressedObject({ fullID: AGENT_ID, localID: this.selfLocalID, scale: [0.6, 0.6, 1.8], position: FAKE.agentPos, pcode: 47 }) },
        { UpdateFlags: 0, Data: compressedObject({ fullID: NEIGHBOUR_ID, localID: this.neighbourLocalID, scale: [0.6, 0.6, 1.8], position: [cx + 5, cy + 5, cz], pcode: 47 }) },
      ],
    }));
    // The neighbour is animating: the same message a real simulator sends when
    // a resident's viewer reports AgentAnimation (AnimID is an animation asset).
    out.push(this.packet("AvatarAnimation", {
      Sender: { ID: uuidBytes(NEIGHBOUR_ID) },
      AnimationList: [
        { AnimID: uuidBytes("2408fe9e-df1d-1d7d-f4ff-1384fa7b350f"), AnimSequenceID: 1 },
        { AnimID: uuidBytes("6ed24bd8-91aa-4b12-ccc7-c97c857ab4e0"), AnimSequenceID: 3 },
      ],
      AnimationSourceList: [{ ObjectID: uuidBytes(NEIGHBOUR_ID) }],
      PhysicalAvatarEventList: [],
    }));
    // Kill the last prim: exercises the KillObject path.
    out.push(this.packet("KillObject", { ObjectData: [{ ID: prims[prims.length - 1].localID }] }));
    return out;
  }

  onInbound(bytes) {
    const packet = parsePacket(bytes);
    const def = this.index.get(packet.messageNumber);
    if (!def) return [];
    const reply = [];
    if (packet.reliable) reply.push(this.packet("PacketAck", { Packets: [{ ID: packet.sequence }] }));
    if (def.name === "UUIDNameRequest") {
      const ids = (decodeMessage(def, packet).data.UUIDNameBlock || []).map((b) => uuidString(b.ID));
      reply.push(this.packet("UUIDNameReply", {
        UUIDNameBlock: ids.map((id) => {
          const [first, last] = (id === NEIGHBOUR_ID ? NEIGHBOUR_NAME : "Tú Resident").split(" ");
          return { ID: uuidBytes(id), FirstName: toBytes(first), LastName: toBytes(last) };
        }),
      }));
    }
    if (def.name === "AgentUpdate") this.agentUpdates = (this.agentUpdates || 0) + 1;
    // A teleport, done the way the real protocol does it: the request is answered
    // on UDP with TeleportStart, and the final TeleportFinish (the destination
    // simulator's address) arrives later on the CAPS event queue — being able to
    // run that whole path without a real grid is the point of the harness.
    if (def.name === "TeleportLocationRequest") {
      const info = decodeMessage(def, packet).data.Info || {};
      const handle = Number(info.RegionHandle) || this.regionHandle;
      this.regionHandle = handle;
      this.movementPos = info.Position || FAKE.agentPos;
      this.regionName = this.regionNameFor(handle);
      this.pendingTeleport = { RegionHandle: handle, Position: this.movementPos };
      reply.push(this.packet("TeleportStart", { Info: { TeleportFlags: 1 } }));
      reply.push(this.packet("TeleportProgress", {
        Info: { TeleportFlags: 1, Message: toBytes("Preparando el destino") },
      }));
    }
    if (def.name === "MapNameRequest" || def.name === "MapBlockRequest") {
      const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
      const isNameQuery = def.name === "MapNameRequest";
      const decoded = decodeMessage(def, packet).data || {};
      const want = isNameQuery && decoded.NameData && decoded.NameData.Name ? norm(toText(decoded.NameData.Name)) : "";
      const pos = decoded.PositionData || {};
      const rows = [];
      for (const r of FAKE.regions) {
        if (isNameQuery) {
          const n = norm(r.name);
          if (!want || !(n === want || n.includes(want))) continue;
        } else if (pos.MinX != null) {
          if (r.gx < pos.MinX || r.gx > pos.MaxX || r.gy < pos.MinY || r.gy > pos.MaxY) continue;
        }
        rows.push({
          X: r.gx, Y: r.gy, Name: toBytes(r.name), Access: 13, RegionFlags: 0,
          WaterHeight: FAKE.water, Agents: 1 + (r.gx % 5), MapImageID: uuidBytes(NEIGHBOUR_ID),
        });
      }
      reply.push(this.packet("MapBlockReply", {
        AgentData: { AgentID: uuidBytes(AGENT_ID), Flags: 0 },
        Data: rows,
      }));
    }
    if (def.name === "ChatFromViewer") {
      const msg = decodeMessage(def, packet).data.ChatData || {};
      reply.push(this.packet("ChatFromSimulator", {
        ChatData: {
          FromName: toBytes("Harness"), SourceID: uuidBytes(NEIGHBOUR_ID), OwnerID: uuidBytes(NEIGHBOUR_ID),
          SourceType: 0, ChatType: 0, Audible: 2, Position: FAKE.agentPos,
          Message: msg.Message || new Uint8Array(0),
        },
      }));
    }
    return reply;
  }

  /** Walks our avatar around a circle with 32-byte terse updates. */
  terseStep(t) {
    const cx = FAKE.agentPos[0], cy = FAKE.agentPos[1];
    const pos = [cx + Math.cos(t) * 8, cy + Math.sin(t) * 8, FAKE.agentPos[2]];
    const known = this.primPositions.get(this.selfLocalID);
    if (known) known.position = pos;
    return this.packet("ImprovedTerseObjectUpdate", {
      RegionData: { RegionHandle: this.regionHandle, TimeDilation: 65535 },
      ObjectData: [{ Data: terseQuant(this.selfLocalID, pos, [0, 0, 0, 1], { state: 1, plane: true }), TextureEntry: new Uint8Array(0) }],
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP answers (login / seed capability / GetTexture / event queue)
// ---------------------------------------------------------------------------
let j2cModule = null;

/**
 * A real JPEG2000 codestream so the vendored OpenJPEG path is exercised.
 *
 * `components` matters: the grid sends most textures as an RGBA codestream
 * (4 components) whose alpha channel is opaque, and that is exactly the shape
 * the reader used to mis-read as interleaved RGBA — which produced colour-cycled
 * stripes with a black bar down the side. Half of the harness's textures are
 * encoded that way, so the fix is exercised by the same wasm decoder the phone
 * uses, and not only by the unit tests.
 */
async function makeJ2C(w, h, paint, components = 3) {
  if (!j2cModule) {
    const url = "https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-openjpeg@1.2.2/dist/openjpegwasm.js";
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = url;
      s.onload = res;
      s.onerror = () => rej(new Error("no se pudo cargar la glue completa de openjpeg"));
      document.head.appendChild(s);
    });
    j2cModule = window.OpenJPEGWASM({
      locateFile: (p) => p.endsWith(".wasm")
        ? "https://cdn.jsdelivr.net/npm/@cornerstonejs/codec-openjpeg@1.2.2/dist/openjpegwasm.wasm"
        : p,
    });
  }
  const mod = await j2cModule;
  const px = new Uint8Array(w * h * components);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * components;
    const c = paint(x / w, y / h);
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
    if (components === 4) px[i + 3] = 255;   // opaque, like a real SL texture
  }
  const enc = new mod.J2KEncoder();
  const dec = enc.getDecodedBuffer({ width: w, height: h, bitsPerSample: 8, componentCount: components, isSigned: false, colorSpace: 0 });
  dec.set(px);
  enc.encode();
  return Uint8Array.from(enc.getEncodedBuffer());
}

function pngBytes(w, h, paint) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const img = c.getContext("2d").createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const col = paint(x / w, y / h);
    img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
  }
  c.getContext("2d").putImageData(img, 0, 0);
  const dataUrl = c.toDataURL("image/png");
  const raw = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return { bytes, type: "image/png" };
}

function texturePaint(id) {
  const n = parseInt(id.slice(0, 2), 16) || 0;
  const base = [40 + (n * 7) % 200, 60 + (n * 13) % 160, 90 + (n * 29) % 140];
  return (u, v) => [
    (base[0] + u * 120) & 255,
    (base[1] + (1 - v) * 120) & 255,
    (base[2] + v * 60) & 255,
  ];
}

async function httpAnswer(url, method) {
  if (/login\.cgi/.test(url)) {
    const body = '<?xml version="1.0"?><methodResponse><params><param>' +
      LLSD.toXmlRpcValue({
        login: true, message: "Harness: sesión iniciada",
        agent_id: AGENT_ID, session_id: SESSION_ID, circuit_code: 1234567,
        seed_capability: FAKE.seedUrl,
        sim_ip: "127.0.0.1", sim_port: 13005,
        region_x: 1000, region_y: 1000,
        first_name: "Tú", last_name: "Resident",
        look_at: [128, 128, 30], home: "https://fake/", start_location: "last",
      }) + "</param></params></methodResponse>";
    return { text: body, type: "text/xml" };
  }
  if (url.startsWith(FAKE.seedUrl)) {
    return {
      text: LLSD.toXML({
        EventQueueGet: FAKE.eqUrl,
        GetTexture: FAKE.textureUrl,
        ViewerAsset: FAKE.textureUrl,
        GetMesh: FAKE.meshUrl,
        GetDisplayNames: FAKE.textureUrl.replace("GetTexture", "GetDisplayNames"),
      }),
      type: "application/llsd+xml",
    };
  }
  if (url.includes("mesh_id=")) {
    const id = url.slice(url.indexOf("mesh_id=") + 8);
    const bank = httpAnswer._meshes;
    const bytes = bank && bank.get(id);
    if (!bytes) return { text: "not found", type: "text/plain" };
    // The real capability answers with the asset itself; a viewer that guessed
    // the format would be caught by the Content-Type alone.
    return { bytes, type: "application/vnd.ll.mesh" };
  }
  if (url.includes("texture_id=")) {
    const id = url.slice(url.indexOf("texture_id=") + 11);
    const paint = texturePaint(id);
    // Half the textures come back as RGBA codestreams, like the real grid.
    const components = (parseInt(id.slice(0, 2), 16) || 0) % 2 ? 4 : 3;
    try {
      return { bytes: await makeJ2C(64, 64, paint, components), type: "image/x-j2c" };
    } catch (e) {
      return pngBytes(64, 64, paint);
    }
  }
  if (url.includes("EventQueueGet")) {
    // A pending teleport is answered here, on the event queue, exactly like the
    // grid does it: the destination simulator's IP/port and its seed capability.
    const sim = httpAnswer._sim;
    if (sim && sim.pendingTeleport) {
      const t = sim.pendingTeleport;
      sim.pendingTeleport = null;
      return {
        text: LLSD.toXML({
          events: [{
            message: "TeleportFinish",
            body: {
              Info: [{
                AgentID: uuidBytes(AGENT_ID), LocationID: 1, TeleportFlags: 1,
                SimIP: new Uint8Array([127, 0, 0, 1]), SimPort: 13007,
                SeedCapability: FAKE.seedUrl + "/destino", RegionHandle: t.RegionHandle,
              }],
            },
          }],
          id: 1,
        }),
        type: "application/llsd+xml",
      };
    }
    // The real queue holds the request open until something happens; the harness
    // re-polls on a short cycle so the test does not have to wait 20 s for the
    // next event to come down.
    await new Promise((r) => setTimeout(r, 1500));
    return { text: LLSD.toXML({ events: [], id: 0 }), type: "application/llsd+xml" };
  }
  await new Promise((r) => setTimeout(r, 300));
  return { text: LLSD.toXML(null), type: "application/llsd+xml" };
}

// ---------------------------------------------------------------------------
// fake native bridge
// ---------------------------------------------------------------------------
export async function installFakeGrid(opts = {}) {
  installSink();
  // The assets the fake GetMesh capability serves. They are built here, with the
  // same encoder the self-test uses against the decoder, so a mismatch between
  // the two shows up as "nothing draws" rather than as a silent wrong shape.
  const meshBank = new Map();
  try {
    const [house, box] = await Promise.all([houseMeshAsset(), boxMeshAsset([3, 1, 3])]);
    meshBank.set(FAKE.meshes.house, house.bytes);
    meshBank.set(FAKE.meshes.box, box.bytes);
  } catch (e) {
    console.warn("[harness] no se pudieron construir las mallas:", (e && e.message) || e);
  }
  httpAnswer._meshes = meshBank;
  const sim = new FakeSim(opts);
  await sim.init();
  const sockets = new Map();
  // In-memory stand-ins for the things the real bridge stores on the device
  // (the texture cache and the preferences), so the harness behaves like the app.
  const cacheStore = new Map();
  const fakePrefs = {};
  const magicOk = (b) => {
    if (!b || b.length < 16) return false;
    const at = (i, ...v) => v.every((x, k) => b[i + k] === x);
    return at(0, 0xff, 0x4f, 0xff, 0x51)      // j2c
      || at(0, 0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50)  // jp2
      || at(0, 0x89, 0x50, 0x4e, 0x47)         // png
      || at(0, 0xff, 0xd8, 0xff)               // jpeg
      || at(0, 0x47, 0x49, 0x46, 0x38)         // gif
      || b[0] === 0x7b                         // LLMESH (binary LLSD map)
      || at(0, 0x3c, 0x3f);                    // LLMESH behind the text tag
  };
  // The harness *replaces* the app's native bridge, which means the viewer can no
  // longer reach the real grid while it runs. Saving the previous bridge lets the
  // diagnostics offer the test as a reversible step ("is it the phone or the
  // grid?") instead of something that requires restarting the app.
  const previousBridge = typeof window !== "undefined" ? window.VisorNative : null;
  sim.restoreBridge = () => {
    try {
      if (previousBridge) window.VisorNative = previousBridge;
      else delete window.VisorNative;
    } catch (_) { /* nothing to restore */ }
  };

  const push = (obj) => {
    if (typeof window.visornative === "function") window.visornative(JSON.stringify(obj));
    else console.warn("[harness] sin sink para", obj.kind);
  };
  const deliver = (chan, bytes) => push({
    id: "rx", kind: "udpBatch",
    batch: [{ chan, data: b64(bytes), from: "127.0.0.1", port: 13005 }],
  });

  async function respondHttp(req) {
    let answer;
    httpAnswer._sim = sim;
    try {
      answer = await httpAnswer(String(req.url), req.method || "GET");
    } catch (e) {
      push({ id: req.id, kind: "http", ok: false, error: "harness: " + ((e && e.message) || e) });
      return;
    }
    const bytes = answer.bytes || new TextEncoder().encode(answer.text || "");
    push({
      id: req.id, kind: "http", ok: true, status: 200,
      headers: { "Content-Type": answer.type || "application/octet-stream", "Content-Length": String(bytes.length) },
      body: b64(bytes),
    });
  }

  function streamRegion(chan) {
    const sock = sockets.get(chan);
    if (!sock || sock.streamed) return;
    sock.streamed = true;
    sim.stream().forEach((bytes, i) => setTimeout(() => deliver(chan, bytes), 40 + i * 40));
    let t = 0;
    sock.walk = setInterval(() => {
      if (!sockets.has(chan)) { clearInterval(sock.walk); return; }
      t += 0.22;
      deliver(chan, sim.terseStep(t));
    }, 150);
    sim.ping = setInterval(() => {
      if (!sockets.has(chan)) { clearInterval(sim.ping); return; }
      deliver(chan, sim.packet("StartPingCheck", { PingID: { PingID: sim.pingID = ((sim.pingID || 0) + 1) & 0xff, OldestUnacked: 0 } }));
    }, 5000);
  }

  window.VisorNative = {
    platform: () => JSON.stringify({
      platform: "android", sdk: 36, model: "harness", manufacturer: "Perchance",
      appVersion: "1.6.0", appBuild: 7, nativeBridge: true, udp: true,
    }),
    netInfo: () => JSON.stringify({ tipo: "wifi (simulada)", validada: true, sinMedir: true, udpOk: true, puertoDePrueba: 40000 }),
    log: (m) => console.log("[harness nativo]", m),
    setModal: () => {},
    http(requestJson) {
      const req = JSON.parse(requestJson);
      const id = req.id;
      setTimeout(() => respondHttp({ ...req, id }), 20);
      return JSON.stringify({ id, ok: true });
    },
    udpOpen(requestJson) {
      const req = JSON.parse(requestJson);
      const chan = req.chan || req.id;
      sockets.set(chan, { opened: performance.now() });
      setTimeout(() => push({ id: req.id, chan, kind: "udpOpen", ok: true, localPort: 46894 }), 40);
      return JSON.stringify({ id: req.id, ok: true });
    },
    udpSend(requestJson) {
      const req = JSON.parse(requestJson);
      const chan = req.chan || req.id;
      const bytes = Uint8Array.from(atob(req.data || ""), (c) => c.charCodeAt(0));
      setTimeout(() => {
        push({ id: req.id, chan, kind: "udpSend", ok: true, sent: bytes.length });
        let replies = [];
        try {
          replies = sim.onInbound(bytes);
        } catch (e) {
          console.warn("[harness] paquete entrante ilegible:", e);
        }
        replies.forEach((r) => deliver(chan, r));
        const def = sim.index.get(parsePacket(bytes).messageNumber);
        if (def && def.name === "CompleteAgentMovement") streamRegion(chan);
      }, 25);
      return JSON.stringify({ id: req.id, ok: true });
    },
    udpClose(requestJson) {
      const req = JSON.parse(requestJson);
      const chan = req.chan || req.id;
      const sock = sockets.get(chan);
      if (sock && sock.walk) clearInterval(sock.walk);
      if (sim.ping) clearInterval(sim.ping);
      sockets.delete(chan);
      return JSON.stringify({ id: req.id, ok: true });
    },
    udpProbe(requestJson) {
      const req = JSON.parse(requestJson);
      setTimeout(() => push({ id: req.id, kind: "udpProbe", ok: true, localPort: 45000, received: 32, from: "127.0.0.1", fromPort: 19302 }), 150);
      return JSON.stringify({ id: req.id, ok: true });
    },
    // The harness keeps its cache in memory, so the store behaves like the app's
    // one (write on download, read on the next request, wipe by revision) and
    // the whole cache path can be exercised without a phone.
    cacheGet(requestJson) {
      const req = JSON.parse(requestJson);
      const bytes = cacheStore.get(req.key);
      setTimeout(() => push(bytes && bytes.length
        ? { id: req.id, kind: "cacheGet", ok: true, key: req.key, data: b64(bytes) }
        : { id: req.id, kind: "cacheGet", ok: false, key: req.key, miss: true }), 5);
      return JSON.stringify({ id: req.id, ok: true });
    },
    cachePut(requestJson) {
      const req = JSON.parse(requestJson);
      const bytes = Uint8Array.from(atob(req.data || ""), (c) => c.charCodeAt(0));
      if (bytes.length) cacheStore.set(req.key, bytes);
      setTimeout(() => push({ id: req.id, kind: "cachePut", ok: true, bytes: bytes.length }), 5);
      return JSON.stringify({ id: req.id, ok: true });
    },
    cacheDelete(requestJson) {
      const req = JSON.parse(requestJson);
      const had = cacheStore.delete(req.key);
      setTimeout(() => push({ id: req.id, kind: "cacheDelete", ok: true, key: req.key, deleted: had ? 1 : 0 }), 5);
      return JSON.stringify({ id: req.id, ok: true });
    },
    cacheClear() {
      const n = cacheStore.size;
      cacheStore.clear();
      return JSON.stringify({ id: "cacheClear", kind: "cacheClear", ok: true, deleted: n });
    },
    cacheVerify(requestJson) {
      const req = JSON.parse(requestJson);
      let bytes = 0, good = 0, bad = 0, empty = 0;
      const examples = [];
      for (const [key, value] of cacheStore) {
        bytes += value.length;
        if (value.length < 16) { empty++; if (examples.length < 6) examples.push(key + " (vacío)"); continue; }
        if (magicOk(value)) good++;
        else { bad++; if (examples.length < 6) examples.push(key); }
      }
      setTimeout(() => push({ id: req.id, kind: "cacheVerify", ok: true, path: "(memoria del arnés)", files: cacheStore.size, bytes, good, bad, empty, examples }), 40);
      return JSON.stringify({ id: req.id, ok: true });
    },
    assetsList(dir) {
      const names = String(dir || "").replace(/\/$/, "") === "data/avatar"
        ? ["avatar_lad.xml.bin", "avatar_skeleton.xml.bin", "avatar_head.llm.bin", "avatar_upper_body.llm.bin",
           "avatar_lower_body.llm.bin", "avatar_eye.llm.bin", "avatar_eyelashes.llm.bin", "anims.bin", "j2c-sample.bin"]
        : [];
      return JSON.stringify({ ok: names.length > 0, dir: "www/" + dir, count: names.length, names });
    },
    assetGet(requestJson) {
      const req = JSON.parse(requestJson);
      setTimeout(() => push({ id: req.id, kind: "assetGet", ok: false, path: req.path, error: "el arnés no tiene assets dentro" }), 5);
      return JSON.stringify({ id: req.id, ok: true });
    },
    prefsAll: () => JSON.stringify(fakePrefs),
    prefsSet(requestJson) {
      const req = JSON.parse(requestJson);
      for (const [k, v] of Object.entries(req.values || {})) {
        if (v == null) delete fakePrefs[k];
        else fakePrefs[k] = String(v);
      }
      return JSON.stringify({ ok: true });
    },
  };
  window.VisorNative.__sim = sim;
  return sim;
}

/** Installs the harness and connects the app to it (used by ?test=grid). */
export async function runFakeGrid(app, opts = {}) {
  const sim = await installFakeGrid(opts);
  await app.connect({ grid: "agni", name: "Tú Resident", password: "harness", status: (t) => app.ui.log("[harness] " + t) });
  app.ui.hideModal();
  app.ui.log("⚠ MODO PRUEBA (?test=grid): simulador falso en memoria; objetos, terreno y texturas son sintéticos.");
  // `?test=grid&tp=1004,1006` runs a real teleport through the harness once the
  // first region has finished streaming, so the whole path (request -> UDP
  // TeleportStart -> event-queue TeleportFinish -> new circuit) is exercised in
  // the preview instead of for the first time on a phone.
  const want = String(location.search).match(/[?&]tp=(-?\d+),(-?\d+)/);
  if (want) {
    const gx = +want[1], gy = +want[2];
    app.ui.log(`[harness] teletransporte de prueba a (${gx}, ${gy})…`);
    setTimeout(async () => {
      const ok = app.session && app.session.teleportToRegion(gx, gy, [96, 96, 25]);
      app.ui.log(`[harness] petición de teletransporte ${ok ? "enviada" : "no enviada"}.`);
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = app.session;
        if (s && s.regionName && s.regionName.includes(`(${gx}, ${gy})`)) {
          app.ui.log(`[harness] teletransporte completado: ${s.regionName}, posición ${(s.agentPos || []).map((v) => Math.round(v)).join(", ")}.`);
          return;
        }
        if (!s || s.state === "offline") { app.ui.log("[harness] la sesión se cerró durante el teletransporte."); return; }
      }
      app.ui.log("[harness] el teletransporte no llegó a completarse en 30 s.");
    }, 9000);
  }
  return sim;
}

// Internals exposed for the self-test / manual probing of this harness.
export const __test = { terrainPatches, compressedObject, terseQuant, terseFull, FakeSim };
