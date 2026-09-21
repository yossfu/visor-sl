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
import { uuidBytes, uuidString, toBytes } from "../message-template.js";
import { loadMessageTemplate } from "../sl-session.js";
import { installSink } from "../transport.js";

export const FAKE = {
  region: "Harness Cove",
  water: 20,
  // The ground under the agent: the same formula terrainPatches() uses, sampled
  // at the centre patch, so the avatar stands on the harness terrain.
  agentPos: [128, 128, 0],
  seedUrl: "https://fake.agni.lindenlab.com/CAPS/seed",
  textureUrl: "https://fake.agni.lindenlab.com/CAPS/GetTexture/c0ffee",
  eqUrl: "https://fake.agni.lindenlab.com/CAPS/EventQueueGet/c0ffee",
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
function textureEntry(texId, { rgba = 0xffffffff, repeatU = 1, repeatV = 1, glow = 0, material = 0 } = {}) {
  const w = writer();
  w.uuid(texId).u8(0);           // texture id + "no per-face overrides"
  w.u32(rgba).u8(0);
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
function compressedObject({ fullID, id, localID, scale, position, rotation, pcode = 9, params, texture }) {
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
  w.u8(0);                        // no ExtraParams
  w.u8(P.pathCurve).u16(P.pathBegin).u16(P.pathEnd)
    .u8(P.pathScaleX).u8(P.pathScaleY).u8(P.pathShearX).u8(P.pathShearY)
    .u8(P.pathTwist).u8(P.pathTwistBegin).u8(P.pathRadiusOffset)
    .u8(P.pathTaperX).u8(P.pathTaperY).u8(P.pathRevolutions).u8(P.pathSkew)
    .u8(P.profileCurve).u16(P.profileBegin).u16(P.profileEnd).u16(P.profileHollow);
  const te = textureEntry(texture || primTexture(localID));
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
    this.regionHandle = 1000n;
    this.primPositions = new Map();
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
        SimName: toBytes(FAKE.region), SimOwner: uuidBytes(AGENT_ID), IsEstateManager: 0,
        WaterHeight: FAKE.water, BillableFactor: 1, CacheID: uuidBytes(AGENT_ID),
        TerrainStartHeight00: 10, TerrainStartHeight01: 20, TerrainHeightRange00: 50, TerrainHeightRange01: 60,
        SimAccess: 13, RegionFlags: 0,
      },
      RegionInfo2: { RegionID: uuidBytes(SESSION_ID), ProductName: toBytes("Mainland"), ProductSku: 0, RegionFlagsExtended: 0 },
    }));
    out.push(this.packet("AgentMovementComplete", {
      AgentData: { AgentID: uuidBytes(AGENT_ID), SessionID: uuidBytes(SESSION_ID) },
      Data: { Position: FAKE.agentPos, LookAt: [1, 0, 0], RegionHandle: this.regionHandle, Timestamp: performance.now() },
      SimData: { ChannelVersion: new Uint8Array(0), SimulatorVersion: toBytes("harness") },
    }));
    out.push(this.packet("SimulatorViewerTimeMessage", {
      TimeInfo: { UsecSinceStart: 0.35 * 86400 * 1e6, SecPerDay: 86400, SecPerYear: 31536000, SunDirection: [0.4, 0.3, 0.85], SunPhase: 0.35, Phase: 0.35 },
    }));
    for (const chunk of terrainPatches()) {
      out.push(this.packet("LayerData", { LayerID: { Type: 0 }, LayerData: { Data: chunk } }));
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

/** A real JPEG2000 codestream so the vendored OpenJPEG path is exercised. */
async function makeJ2C(w, h, paint) {
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
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    const c = paint(x / w, y / h);
    rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2];
  }
  const enc = new mod.J2KEncoder();
  const dec = enc.getDecodedBuffer({ width: w, height: h, bitsPerSample: 8, componentCount: 3, isSigned: false, colorSpace: 0 });
  dec.set(rgb);
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
        GetDisplayNames: FAKE.textureUrl.replace("GetTexture", "GetDisplayNames"),
      }),
      type: "application/llsd+xml",
    };
  }
  if (url.includes("texture_id=")) {
    const id = url.slice(url.indexOf("texture_id=") + 11);
    const paint = texturePaint(id);
    try {
      return { bytes: await makeJ2C(64, 64, paint), type: "image/x-j2c" };
    } catch (e) {
      return pngBytes(64, 64, paint);
    }
  }
  if (url.includes("EventQueueGet")) {
    await new Promise((r) => setTimeout(r, 20000));
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
  const sim = new FakeSim(opts);
  await sim.init();
  const sockets = new Map();
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
      appVersion: "1.3.0", appBuild: 4, nativeBridge: true, udp: true,
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
  };
  window.VisorNative.__sim = sim;
  return sim;
}

/** Installs the harness and connects the app to it (used by ?test=grid). */
export async function runFakeGrid(app, opts = {}) {  const sim = await installFakeGrid(opts);
  await app.connect({ grid: "agni", name: "Tú Resident", password: "harness", status: (t) => app.ui.log("[harness] " + t) });
  app.ui.log("⚠ MODO PRUEBA (?test=grid): simulador falso en memoria; objetos, terreno y texturas son sintéticos.");
  return sim;
}

// Internals exposed for the self-test / manual probing of this harness.
export const __test = { terrainPatches, compressedObject, terseQuant, terseFull, FakeSim };
