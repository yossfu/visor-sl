// objects.js -- los mensajes de OBJETOS de LLUDP (el protocolo real de Second
// Life): ObjectUpdate (12), ObjectUpdateCompressed (13), ObjectUpdateCached
// (14), ImprovedTerseObjectUpdate (15) y KillObject (16).
//
// Aqui vive todo el conocimiento "del cable" que hace falta para convertir un
// objeto de SL en el registro que entiende el visor (`World.applyRemote`):
//
//   * las quanta con las que SL comprime los parametros de volumen
//     (llvolumemessage.cpp): cortes, escala, cizalla, conicidad, revoluciones.
//   * la tabla perfil/camino -> forma del visor (llpanelobject.cpp).
//   * el "TextureEntry": la textura, el color, la transparencia, el brillo y la
//     repeticion de CADA cara (llprimitive.cpp packTEMessage/unpack_TEField).
//   * los "ExtraParams": malla, escultura, luz, material... (TLV).
//   * el bloque binario de posicion/velocidad/rotacion que va dentro de
//     ObjectData (llviewerobject.cpp processUpdateMessage).
//
// Todas las funciones de decodificacion devuelven "objetos de protocolo"
// (`makeObject`), que son la entrada de `primRecord()`. El registro final es
// exactamente el que produce el simulador de pruebas (src/sl/mockServer.js),
// asi que el resto del visor no distingue una region real de una simulada.
//
// Las coordenadas de SL son de region (0..256 en x/y, z hacia arriba) y las del
// visor estan centradas en el origen con la "y" hacia arriba: la conversion esta
// en `slPosToViewer`/`slQuatToViewer` (y sus inversas), que es una rotacion
// propia (no un espejo) para que el mundo no salga reflejado.

import { BufReader, BufWriter, uuidFromBytes, uuidToBytes, utf8FromFixed, fixedFromUtf8, NULL_UUID } from "./codec.js";
import { PrimParams } from "../../prims.js";
import { emptyFace, facesToJson } from "../../faces.js";
import { volumeFaceCount } from "../../llvolume.js";

// --- codigos del protocolo ----------------------------------------------------

export const PCODE = {
  PRIMITIVE: 9,
  AVATAR: 47,
  GRASS: 95,
  NEW_TREE: 110,
  TREE: 111,
};

export const PATH = {
  IGNORE: 0x00,
  LINE: 0x10,
  CIRCLE: 0x20,
  CIRCLE2: 0x30,
  TEST: 0x40,
  FLEXIBLE: 0x80,
};

export const PROFILE = {
  CIRCLE: 0x00,
  SQUARE: 0x01,
  ISOTRI: 0x02,
  EQUALTRI: 0x03,
  RIGHTTRI: 0x04,
  CIRCLE_HALF: 0x05,
};

export const PROFILE_MASK = 0x0f;
export const HOLE_MASK = 0xf0;

export const HOLE = {
  SAME: 0x00,
  CIRCLE: 0x10,
  SQUARE: 0x20,
  TRIANGLE: 0x30,
};

// llvolume.h: las quantas con las que viaja cada parametro.
export const QUANTA = {
  CUT: 0.00002,
  SCALE: 0.01,
  SHEAR: 0.01,
  TAPER: 0.01,
  REV: 0.015,
  HOLLOW: 0.00002,
};

// object_flags.h. `FULL` (1<<31) no es un flag de la region sino del visor.
export const UPDATE_FLAGS = {
  USE_PHYSICS: 1 << 0,
  CREATE_SELECTED: 1 << 1,
  OBJECT_MODIFY: 1 << 2,
  OBJECT_COPY: 1 << 3,
  OBJECT_ANY_OWNER: 1 << 4,
  OBJECT_YOU_OWNER: 1 << 5,
  SCRIPTED: 1 << 6,
  HANDLE_TOUCH: 1 << 7,
  OBJECT_MOVE: 1 << 8,
  TAKES_MONEY: 1 << 9,
  PHANTOM: 1 << 10,
  INVENTORY_EMPTY: 1 << 11,
  AFFECTS_NAVMESH: 1 << 12,
  CHARACTER: 1 << 13,
  VOLUME_DETECT: 1 << 14,
  INCLUDE_IN_SEARCH: 1 << 15,
  ALLOW_INVENTORY_DROP: 1 << 16,
  OBJECT_TRANSFER: 1 << 17,
  OBJECT_GROUP_OWNED: 1 << 18,
  CAMERA_DECOUPLED: 1 << 20,
  ANIM_SOURCE: 1 << 21,
  CAMERA_SOURCE: 1 << 22,
  SERVER_AUTOPILOT: 1 << 24,
  OBJECT_OWNER_MODIFY: 1 << 28,
  TEMPORARY_ON_REZ: 1 << 29,
};

// Los bits del `SpecialCode` del update comprimido (llviewerobject.cpp:1798).
export const COMPRESSED_FLAGS = {
  SCRATCH_PAD: 0x01,
  TREE: 0x02,
  HAS_TEXT: 0x04,
  HAS_PARTICLES: 0x08,
  HAS_SOUND: 0x10,
  HAS_PARENT: 0x20,
  TEXTURE_ANIM: 0x40,
  HAS_ANGULAR_VELOCITY: 0x80,
  HAS_NAME_VALUES: 0x100,
  MEDIA_URL: 0x200,
  HAS_PARTICLES_NEW: 0x400,
};

// llprimitive.cpp / llviewerobject.cpp: el tipo de cada ExtraParam.
export const EXTRA_PARAM = {
  FLEXIBLE: 0x10,
  LIGHT: 0x20,
  SCULPT: 0x30,
  LIGHT_IMAGE: 0x40,
  MESH: 0x60,
  EXTENDED_MESH: 0x70,
  RENDER_MATERIAL: 0x80,
  REFLECTION_PROBE: 0x90,
};

export const EXTRA_PARAM_NAME = Object.fromEntries(
  Object.entries(EXTRA_PARAM).map(([k, v]) => [v, k]));

// El visor centra la region en el origen; SL usa 0..256.
export const SL_REGION_SIZE = 256;
export const SL_REGION_HALF = SL_REGION_SIZE / 2;

// ---------------------------------------------------------------------------
// Quanta de los parametros de volumen (llvolumemessage.cpp unpackPathParams)
// ---------------------------------------------------------------------------

const s8 = (v) => (v > 127 ? v - 256 : v);

export const unpackBeginCut = (w) => w * QUANTA.CUT;
export const unpackEndCut = (w) => (50000 - w) * QUANTA.CUT;
export const packBeginCut = (c) => Math.round(clamp(c, 0, 1) / QUANTA.CUT);
export const packEndCut = (c) => 50000 - Math.round(clamp(c, 0, 1) / QUANTA.CUT);
export const unpackPathScale = (w) => (200 - w) * QUANTA.SCALE;
export const packPathScale = (s) => clamp(Math.round(200 - s / QUANTA.SCALE), 0, 255);
export const unpackPathShear = (b) => s8(b) * QUANTA.SHEAR;
export const packPathShear = (s) => clamp(Math.round(s / QUANTA.SHEAR), -128, 127) & 0xff;
export const unpackPathTwist = (b) => s8(b) * QUANTA.SCALE;
export const packPathTwist = (t) => clamp(Math.round(t / QUANTA.SCALE), -128, 127) & 0xff;
export const unpackPathTaper = (b) => s8(b) * QUANTA.TAPER;
export const packPathTaper = (t) => clamp(Math.round(t / QUANTA.TAPER), -128, 127) & 0xff;
export const unpackPathRevolutions = (w) => w * QUANTA.REV + 1;
export const packPathRevolutions = (r) => clamp(Math.round((r - 1) / QUANTA.REV), 0, 255);
export const unpackProfileHollow = (w) => w * QUANTA.HOLLOW;
export const packProfileHollow = (h) => clamp(Math.round(h / QUANTA.HOLLOW), 0, 65535);

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// ---------------------------------------------------------------------------
// Perfil/camino -> forma del visor
// ---------------------------------------------------------------------------

// La tabla inversa de SHAPES (src/prims.js). El protocolo solo usa estas siete
// combinaciones; cualquier otra cae en la forma mas parecida.
export function shapeFromCurves(pathCurve, profileCurve) {
  const path = pathCurve & 0xf0;
  const profile = profileCurve & PROFILE_MASK;
  if (path === PATH.LINE) {
    if (profile === PROFILE.SQUARE) return "box";
    if (profile === PROFILE.CIRCLE) return "cylinder";
    if (profile === PROFILE.EQUALTRI || profile === PROFILE.ISOTRI || profile === PROFILE.RIGHTTRI) return "prism";
    return "box";
  }
  if (path === PATH.CIRCLE || path === PATH.CIRCLE2) {
    if (profile === PROFILE.CIRCLE_HALF) return "sphere";
    if (profile === PROFILE.SQUARE) return "tube";
    if (profile === PROFILE.EQUALTRI || profile === PROFILE.ISOTRI || profile === PROFILE.RIGHTTRI) return "ring";
    if (profile === PROFILE.CIRCLE) return "torus";
    return "torus";
  }
  // Caminos desconocidos (TEST/FLEXIBLE/IGNORE): se dibuja como caja.
  return "box";
}

export function holeShapeFromCode(code) {
  switch (code & HOLE_MASK) {
    case HOLE.CIRCLE: return "circle";
    case HOLE.SQUARE: return "square";
    case HOLE.TRIANGLE: return "triangle";
    default: return "same";
  }
}

export function holeCodeFromShape(shape) {
  switch (shape) {
    case "circle": return HOLE.CIRCLE;
    case "square": return HOLE.SQUARE;
    case "triangle": return HOLE.TRIANGLE;
    default: return HOLE.SAME;
  }
}

// ---------------------------------------------------------------------------
// Parametros de volumen (el dominio de LLVolumeParams) <-> el dominio del
// editor del visor (PrimParams, el mismo que la pestana "Objeto" de SL)
// ---------------------------------------------------------------------------

// El inverso de PrimParams.toVolumeParams(). Se hace a mano (y no con una
// clase) porque el decodificador es el unico sitio donde se lee del cable.
export function volumeToPrimParams(v) {
  const shape = shapeFromCurves(v.pathCurve, v.profileCurve);
  const linear = shape === "box" || shape === "cylinder" || shape === "prism";
  const p = new PrimParams(shape);
  p.pathCutBegin = v.begin;
  p.pathCutEnd = v.end;
  p.profileCutBegin = v.profileBegin;
  p.profileCutEnd = v.profileEnd;
  p.hollow = v.hollow;
  p.holeShape = holeShapeFromCode(v.profileCurve);
  const div = linear ? 180 : 360;
  p.twistBegin = v.twistBegin * div;
  p.twistEnd = v.twist * div;
  p.shearX = v.shearX;
  p.shearY = v.shearY;
  p.revolution = v.revolutions;
  if (linear) {
    // En los caminos rectos SL guarda la escala (1 - conicidad) en scaleX/Y.
    p.taperX = 1 - v.scaleX;
    p.taperY = 1 - v.scaleY;
    p.slope = v.radiusOffset;
    p.skew = v.skew;
    p.holeX = 1;
    p.holeY = 1;
  } else if (shape === "sphere") {
    p.taperX = 0; p.taperY = 0; p.slope = 0; p.skew = 0; p.revolution = 1;
    p.holeX = 1; p.holeY = 1;
  } else {
    // Toro/tubo/anillo: scaleX/Y es el hueco (ratio) y hay conicidad propia.
    p.holeX = v.scaleX;
    p.holeY = v.scaleY;
    p.taperX = v.taperX;
    p.taperY = v.taperY;
    p.slope = v.radiusOffset;
    p.skew = v.skew;
  }
  return p;
}

// PrimParams -> LLVolumeParams, reutilizando el mapeo del editor (prims.js) y
// traduciendo despues a los campos del cable.
export function primParamsToVolume(params) {
  const p = params instanceof PrimParams
    ? params
    : Object.assign(new PrimParams(params.shape || "box"), params);
  const v = p.toVolumeParams();
  return {
    pathCurve: v.path.curveType,
    profileCurve: v.profile.curveType,
    begin: v.path.begin,
    end: v.path.end,
    scaleX: v.path.scaleX,
    scaleY: v.path.scaleY,
    shearX: v.path.shearX,
    shearY: v.path.shearY,
    twist: v.path.twistEnd,
    twistBegin: v.path.twistBegin,
    radiusOffset: v.path.radiusOffset,
    taperX: v.path.taperX,
    taperY: v.path.taperY,
    revolutions: v.path.revolutions,
    skew: v.path.skew,
    profileBegin: v.profile.begin,
    profileEnd: v.profile.end,
    hollow: v.profile.hollow,
  };
}

// Los 23 bytes del bloque de parametros de prim del update comprimido. Ojo: el
// orden NO es el de ObjectUpdate (aqui ProfileCurve va despues de PathSkew).
export function writeVolumeFields(w, v) {
  w.u8(v.pathCurve);
  w.u16(packBeginCut(v.begin));
  w.u16(packEndCut(v.end));
  w.u8(packPathScale(v.scaleX));
  w.u8(packPathScale(v.scaleY));
  w.u8(packPathShear(v.shearX));
  w.u8(packPathShear(v.shearY));
  w.u8(packPathTwist(v.twist));
  w.u8(packPathTwist(v.twistBegin));
  w.u8(packPathTwist(v.radiusOffset));
  w.u8(packPathTaper(v.taperX));
  w.u8(packPathTaper(v.taperY));
  w.u8(packPathRevolutions(v.revolutions));
  w.u8(packPathTwist(v.skew));
  w.u8(v.profileCurve);
  w.u16(packBeginCut(v.profileBegin));
  w.u16(packEndCut(v.profileEnd));
  w.u16(packProfileHollow(v.hollow));
  return w;
}

export function readVolumeFieldsCompressed(r) {
  const v = {};
  v.pathCurve = r.u8();
  v.begin = unpackBeginCut(r.u16());
  v.end = unpackEndCut(r.u16());
  v.scaleX = unpackPathScale(r.u8());
  v.scaleY = unpackPathScale(r.u8());
  v.shearX = unpackPathShear(r.u8());
  v.shearY = unpackPathShear(r.u8());
  v.twist = unpackPathTwist(r.u8());
  v.twistBegin = unpackPathTwist(r.u8());
  v.radiusOffset = unpackPathTwist(r.u8());
  v.taperX = unpackPathTaper(r.u8());
  v.taperY = unpackPathTaper(r.u8());
  v.revolutions = unpackPathRevolutions(r.u8());
  v.skew = unpackPathTwist(r.u8());
  v.profileCurve = r.u8();
  v.profileBegin = unpackBeginCut(r.u16());
  v.profileEnd = unpackEndCut(r.u16());
  v.hollow = unpackProfileHollow(r.u16());
  return v;
}

// ---------------------------------------------------------------------------
// TextureEntry
// ---------------------------------------------------------------------------

// llprimitive.cpp: el orden y el tamano de cada campo del "texture entry".
const TE_FIELDS = [
  { key: "image", size: 16 },
  { key: "color", size: 4 },
  { key: "scaleS", size: 4 },
  { key: "scaleT", size: 4 },
  { key: "offsetS", size: 2 },
  { key: "offsetT", size: 2 },
  { key: "rot", size: 2 },
  { key: "bump", size: 1 },
  { key: "media", size: 1 },
  { key: "glow", size: 1 },
  { key: "material", size: 16 },
];

export const MAX_TES = 45;
export const TEXTURE_ROTATION_PACK = 0x8000;

export const TEM = {
  BUMP_MASK: 0x1f,
  FULLBRIGHT_SHIFT: 5,
  SHINY_MASK: 0x03,
  SHINY_SHIFT: 6,
  MEDIA_MASK: 0x01,
};

// Decodifica el blob del TextureEntry tal cual viene en el cable. Devuelve un
// mapa campo -> array por cara (los valores en crudo, en el dominio del cable).
export function readTextureEntryRaw(data, nFaces = MAX_TES) {
  const r = new BufReader(data);
  const out = {};
  for (const f of TE_FIELDS) out[f.key] = new Array(nFaces).fill(null);
  let exhausted = false;
  for (const f of TE_FIELDS) {
    // El ultimo campo (material_id) es opcional: los paquetes reales acaban
    // justo en su valor por defecto, sin el byte separador que sigue a las
    // excepciones (el visor de Linden pierde el material por exigir ese byte de
    // mas; aqui si se lee, que es informacion gratis).
    if (r.remaining < f.size) break;
    const def = readRawValue(r, f.size);
    for (let i = 0; i < nFaces; i++) out[f.key][i] = def;
    while (r.remaining > 0 && !exhausted) {
      let flags = 0;
      let sbit = 0;
      do {
        if (r.remaining <= 0) { exhausted = true; break; }
        sbit = r.u8();
        flags = flags * 128 + (sbit & 0x7f);
      } while (sbit & 0x80);
      if (exhausted) break;
      if (!flags) break;                       // byte 0 = fin del campo
      if (r.remaining < f.size + 1) { exhausted = true; break; }
      const val = readRawValue(r, f.size);
      for (let i = 0; i < nFaces; i++) {
        if (i < 53 && (flags % Math.pow(2, i + 1)) >= Math.pow(2, i)) out[f.key][i] = val;
      }
    }
  }
  return out;
}

function readRawValue(r, size) {
  if (size === 1) return [r.u8()];
  if (size === 2) return [r.u8(), r.u8()];
  if (size === 4) return [r.u8(), r.u8(), r.u8(), r.u8()];
  return Array.from(r.bytes(size));
}

const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32le = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const f32le = (b, i) => new DataView(new Uint8Array(b.slice(i, i + 4)).buffer).getFloat32(0, true);
const s16le = (v) => (v > 32767 ? v - 65536 : v);

export function teRawUuid(b) { return uuidFromBytes(Uint8Array.from(b), 0); }

// Convierte el campo `bump` (los 8 bits de material) a los campos del visor.
function decodeBump(bump) {
  return {
    bumpmap: bump & TEM.BUMP_MASK,
    fullbright: !!(bump & (1 << TEM.FULLBRIGHT_SHIFT)),
    shiny: (bump >> TEM.SHINY_SHIFT) & TEM.SHINY_MASK,
  };
}

// Convierte el TextureEntry crudo a las caras del visor. `primColor` se usa de
// color base del prim: las caras que lo comparten no guardan color propio, asi
// el JSON del registro se queda corto.
export function textureEntryToFaces(te, nFaces, primColor) {
  const faces = [];
  for (let i = 0; i < nFaces; i++) faces.push(emptyFace());
  let color = primColor === undefined || primColor === null ? null : primColor;
  // El "color del prim" es el de la cara 0 (la mas visible en casi todo).
  if (color === null) {
    const c = te.color[0];
    if (c) color = ((255 - c[0]) << 16) | ((255 - c[1]) << 8) | (255 - c[2]);
  }
  for (let i = 0; i < nFaces; i++) {
    const f = faces[i];
    const img = te.image[i];
    if (img) {
      const u = teRawUuid(img);
      if (u !== NULL_UUID) f.tex = { a: u };
    }
    const c = te.color[i];
    if (c) {
      const ci = ((255 - c[0]) << 16) | ((255 - c[1]) << 8) | (255 - c[2]);
      if (ci !== color) f.color = ci;
      f.alpha = (255 - c[3]) / 255;
    }
    const ss = te.scaleS[i], st = te.scaleT[i];
    if (ss && st) {
      const rx = f32le(ss, 0), ry = f32le(st, 0);
      if (rx !== 1 || ry !== 1) f.repeat = [rx, ry];
    }
    const os = te.offsetS[i], ot = te.offsetT[i];
    if (os && ot) {
      const ox = s16le(u16le(os, 0)) / 0x7fff, oy = s16le(u16le(ot, 0)) / 0x7fff;
      if (ox || oy) f.offset = [ox, oy];
    }
    const rt = te.rot[i];
    if (rt) {
      const angle = (s16le(u16le(rt, 0)) / TEXTURE_ROTATION_PACK) * Math.PI * 2;
      if (angle) f.rotation = angle;
    }
    const bp = decodeBump(te.bump[i] ? te.bump[i][0] : 0);
    f.fullbright = bp.fullbright;
    if (bp.shiny) {
      // El "shiny" de SL es un brillo especular: se traduce a rugosidad baja.
      f.rough = Math.max(0.05, 0.62 - bp.shiny * 0.18);
      f.metal = Math.min(1, 0.05 + bp.shiny * 0.18);
    }
    const gl = te.glow[i];
    if (gl) f.glow = gl[0] / 255;
  }
  return { faces, color: color === null ? 0xb9c2cf : color };
}

// --- escritura ---------------------------------------------------------------

function faceToWire(f, primColor) {
  const color = f.color === null || f.color === undefined ? primColor : f.color;
  const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff;
  const a = Math.round(clamp(f.alpha === undefined ? 1 : f.alpha, 0, 1) * 255);
  const bump = (f.fullbright ? 1 << TEM.FULLBRIGHT_SHIFT : 0) |
    ((f.rough !== null && f.rough !== undefined && f.rough < 0.5 ? 2 : 0) << TEM.SHINY_SHIFT);
  let rot = 0;
  if (f.rotation) rot = Math.round(((f.rotation % (Math.PI * 2)) / (Math.PI * 2)) * TEXTURE_ROTATION_PACK);
  const uuid = f.tex && f.tex.a ? f.tex.a : NULL_UUID;
  const ub = new Uint8Array(16);
  const parsed = uuidToBytes(uuid);
  ub.set(parsed);
  return {
    image: Array.from(ub),
    color: [255 - r, 255 - g, 255 - b, 255 - a],
    scaleS: floatBytes(f.repeat ? f.repeat[0] : 1),
    scaleT: floatBytes(f.repeat ? f.repeat[1] : 1),
    offsetS: intBytes(Math.round(clamp((f.offset ? f.offset[0] : 0), -1, 1) * 0x7fff), 2),
    offsetT: intBytes(Math.round(clamp((f.offset ? f.offset[1] : 0), -1, 1) * 0x7fff), 2),
    rot: intBytes(rot, 2),
    bump: [bump & 0xff],
    media: [0],
    glow: [Math.round(clamp(f.glow || 0, 0, 1) * 255)],
    material: new Array(16).fill(0),
  };
}

function floatBytes(v) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v || 0, true);
  return Array.from(b);
}

function intBytes(v, n) {
  const x = v < 0 ? v + (1 << (8 * n)) : v;
  return Array.from({ length: n }, (_, i) => (x >> (8 * i)) & 0xff);
}

// Escribe el texture entry exactamente como LLPrimitive::packTEField: el valor
// de la ULTIMA cara es el valor por defecto y el resto son "excepciones" con su
// mascara de bits (7 bits por byte, el grupo alto primero).
export function writeTextureEntry(faces, primColor) {
  const n = faces.length;
  if (!n) return new Uint8Array(0);
  const cols = {};
  for (const f of TE_FIELDS) cols[f.key] = new Array(n);
  for (let i = 0; i < n; i++) {
    const w = faceToWire(faces[i], primColor);
    for (const f of TE_FIELDS) cols[f.key][i] = w[f.key];
  }
  const out = new BufWriter(256);
  for (const f of TE_FIELDS) {
    packTEField(out, cols[f.key], f.size);
  }
  return out.build();
}

function packTEField(out, values, size) {
  const last = values.length - 1;
  writeRawValue(out, values[last], size);
  for (let fi = last - 1; fi >= 0; fi--) {
    let already = false;
    for (let i = fi + 1; i <= last; i++) {
      if (bytesEqual(values[fi], values[i])) { already = true; break; }
    }
    if (already) continue;
    let flags = 0;
    for (let i = fi; i >= 0; i--) {
      if (bytesEqual(values[fi], values[i])) flags += Math.pow(2, i);
    }
    writeVarFlags(out, flags);
    writeRawValue(out, values[fi], size);
  }
  out.u8(0);
}

function writeVarFlags(out, flags) {
  const groups = [];
  let v = flags;
  groups.push(v % 128);
  v = Math.floor(v / 128);
  while (v > 0) { groups.push(v % 128); v = Math.floor(v / 128); }
  groups.reverse();
  for (let i = 0; i < groups.length; i++) {
    out.u8((groups[i] & 0x7f) | (i < groups.length - 1 ? 0x80 : 0));
  }
}

function writeRawValue(out, bytes, size) {
  for (let i = 0; i < size; i++) out.u8(bytes[i] || 0);
}

function bytesEqual(a, b) {
  for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return false;
  return a.length === b.length;
}

// ---------------------------------------------------------------------------
// ExtraParams
// ---------------------------------------------------------------------------

// Devuelve cuantos bytes ocupa el bloque TLV que empieza en `off` (incluido el
// byte de cuenta). 0 si no se puede leer.
export function extraParamsLength(data, off = 0) {
  const r = new BufReader(data, off);
  if (r.remaining < 1) return 0;
  const start = r.p;
  const count = r.u8();
  for (let i = 0; i < count; i++) {
    if (r.remaining < 6) return 0;
    r.u16();
    const len = r.u32();
    if (r.remaining < len) return 0;
    r.skip(len);
  }
  return r.p - start;
}

export function readExtraParams(data, off = 0) {
  const out = [];
  const r = new BufReader(data, off);
  if (r.remaining < 1) return out;
  const count = r.u8();
  for (let i = 0; i < count; i++) {
    if (r.remaining < 6) break;
    const type = r.u16();
    const len = r.u32();
    if (r.remaining < len) break;
    const raw = r.bytes(len);
    out.push(decodeExtraParam(type, raw));
  }
  return out;
}

function decodeExtraParam(type, raw) {
  const p = { type, name: EXTRA_PARAM_NAME[type] || ("0x" + type.toString(16)), length: raw.length, raw };
  const r = new BufReader(raw);
  switch (type) {
    case EXTRA_PARAM.MESH:
    case EXTRA_PARAM.SCULPT:
      if (raw.length >= 17) {
        p.meshType = r.u8();
        p.uuid = uuidFromBytes(r.bytes(16), 0);
      }
      break;
    case EXTRA_PARAM.EXTENDED_MESH:
      if (raw.length >= 17) {
        p.meshType = r.u8();
        p.uuid = uuidFromBytes(r.bytes(16), 0);
      }
      break;
    case EXTRA_PARAM.RENDER_MATERIAL:
      if (raw.length >= 16) p.uuid = uuidFromBytes(r.bytes(16), 0);
      break;
    case EXTRA_PARAM.LIGHT:
      if (raw.length >= 4) {
        p.color = [raw[0], raw[1], raw[2], raw[3]];
        p.floats = readFloats(raw, 4);
        p.intensity = p.floats[0];
        p.radius = p.floats[1];
        p.falloff = p.floats[2];
        p.cutoff = p.floats[3];
      }
      break;
    case EXTRA_PARAM.LIGHT_IMAGE:
      if (raw.length >= 16) {
        p.uuid = uuidFromBytes(r.bytes(16), 0);
        p.floats = readFloats(raw, 16);
      }
      break;
    case EXTRA_PARAM.FLEXIBLE:
      p.floats = readFloats(raw, 0);
      break;
    default:
      break;
  }
  return p;
}

function readFloats(raw, off) {
  const out = [];
  for (let i = off; i + 4 <= raw.length; i += 4) {
    out.push(new DataView(new Uint8Array(raw.slice(i, i + 4)).buffer).getFloat32(0, true));
  }
  return out;
}

export function writeExtraParams(list) {
  if (!list || !list.length) return new Uint8Array(0);
  const w = new BufWriter(64);
  w.u8(list.length);
  for (const p of list) {
    const body = p.raw ? Uint8Array.from(p.raw) : encodeExtraParamBody(p);
    w.u16(p.type);
    w.u32(body.length);
    w.bytes(body);
  }
  return w.build();
}

function encodeExtraParamBody(p) {
  const w = new BufWriter(32);
  switch (p.type) {
    case EXTRA_PARAM.MESH:
    case EXTRA_PARAM.SCULPT:
    case EXTRA_PARAM.EXTENDED_MESH:
      w.u8(p.meshType || 0);
      w.bytes(p.uuid ? uuidToBytes(p.uuid) : new Uint8Array(16));
      break;
    case EXTRA_PARAM.RENDER_MATERIAL:
      w.bytes(p.uuid ? uuidToBytes(p.uuid) : new Uint8Array(16));
      break;
    default:
      break;
  }
  return w.build();
}

// ---------------------------------------------------------------------------
// El bloque binario de ObjectData (posicion, velocidad, rotacion, omega)
// ---------------------------------------------------------------------------

// En los updates "completos" el bloque son 3+3+3+3+3 floats, y las variantes de
// avatar (76/140) llevan 16 bytes de plano de colision delante. Las longitudes
// mayores que 60 (124/140) son extensiones futuras: se leen los primeros campos
// y se ignora la cola (llviewerobject.cpp:1386).
export function readFullPrecisionBlock(data) {
  const len = data.length;
  if (len !== 60 && len !== 76 && len !== 124 && len !== 140) return null;
  const r = new BufReader(data);
  const out = {};
  if (len === 76 || len === 140) out.collisionPlane = [r.f32(), r.f32(), r.f32(), r.f32()];
  out.position = [r.f32(), r.f32(), r.f32()];
  out.velocity = [r.f32(), r.f32(), r.f32()];
  out.acceleration = [r.f32(), r.f32(), r.f32()];
  const q = [r.f32(), r.f32(), r.f32()];
  out.quaternion = quatFromVector3(q);
  out.angularVelocity = [r.f32(), r.f32(), r.f32()];
  return out;
}

const U16_TO_F32 = (v, lo, hi) => lo + (v / 65535) * (hi - lo);

// El update "terse": 4+1+1 (+16 de plano si es avatar) + 12 de posicion en
// coma flotante + vel/acc/rot/omega cuantizados a 16 bits. El cuaternion (4 u16
// en [-1,1]) sale siempre unitario: es lo que se comprueba en el autotest.
export function readTerseBlock(data) {
  const r = new BufReader(data);
  if (data.length < 44) return null;
  const out = {};
  out.localId = r.u32();
  out.state = r.u8();
  const isAvatar = r.u8() !== 0;
  out.isAvatar = isAvatar;
  if (isAvatar) out.collisionPlane = [r.f32(), r.f32(), r.f32(), r.f32()];
  out.position = [r.f32(), r.f32(), r.f32()];
  out.velocity = [U16_TO_F32(r.u16(), -128, 128), U16_TO_F32(r.u16(), -128, 128), U16_TO_F32(r.u16(), -128, 128)];
  out.acceleration = [U16_TO_F32(r.u16(), -64, 64), U16_TO_F32(r.u16(), -64, 64), U16_TO_F32(r.u16(), -64, 64)];
  out.quaternion = [
    U16_TO_F32(r.u16(), -1, 1), U16_TO_F32(r.u16(), -1, 1),
    U16_TO_F32(r.u16(), -1, 1), U16_TO_F32(r.u16(), -1, 1),
  ];
  out.angularVelocity = [U16_TO_F32(r.u16(), -64, 64), U16_TO_F32(r.u16(), -64, 64), U16_TO_F32(r.u16(), -64, 64)];
  return out;
}

// ---------------------------------------------------------------------------
// Objetos
// ---------------------------------------------------------------------------

export function makeObject() {
  return {
    localId: 0,
    uuid: NULL_UUID,
    pcode: 0,
    state: 0,
    crc: 0,
    material: 0,
    clickAction: 0,
    scale: [1, 1, 1],
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    acceleration: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    flags: 0,
    owner: NULL_UUID,
    parentId: 0,
    shape: "box",
    params: null,
    color: 0xb9c2cf,
    faces: null,
    name: "",
    desc: "",
    text: "",
    textColor: null,
    mediaUrl: "",
    sound: null,
    gain: 0,
    radius: 0,
    jointType: 0,
    jointPivot: [0, 0, 0],
    jointAxis: [0, 0, 0],
    extraParams: [],
    linkset: 1,
    treeSpecies: 0,
    textureAnim: null,
    compressed: false,
  };
}

function applyVolumeFields(o, v) {
  const params = volumeToPrimParams(v);
  o.shape = params.shape;
  o.params = params;
  o.volParams = params.toVolumeParams();
  o.facesCount = volumeFaceCount(o.volParams, 0) || FACE_FALLBACK[params.shape] || 1;
  return params;
}

// Por si el volumen no se puede construir (parametros degenerados).
const FACE_FALLBACK = { box: 6, cylinder: 3, prism: 5, sphere: 1, torus: 1, tube: 4, ring: 3 };

function applyTextureEntry(o, bytes) {
  // Se guardan los bytes crudos: al reescribir un TextureEntry desde las caras
  // ya parseadas se pierde el reparto exacto entre "valor por defecto" y
  // "excepciones", y el resultado no sale byte a byte. Para reenviar lo que
  // llego (que es lo que hace un retransmisor) hay que conservar el original.
  o.textureEntryRaw = bytes;
  const te = readTextureEntryRaw(bytes);
  const nFaces = Math.max(1, Math.min(MAX_TES, o.facesCount || FACE_FALLBACK[o.shape] || 1));
  const res = textureEntryToFaces(te, nFaces, null);
  o.color = res.color;
  o.faces = facesToJson(res.faces);
  if (o.rawFaces === undefined) o.rawFaces = res.faces;
  return res.faces;
}

function parseNameValue(bytes) {
  const text = utf8FromFixed(bytes);
  const out = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    const i = line.indexOf(" ");
    const key = i < 0 ? line : line.slice(0, i);
    const val = i < 0 ? "" : line.slice(i + 1);
    if (key) out[key] = val;
  }
  return out;
}

function applyNameValue(o, bytes) {
  const nv = parseNameValue(bytes);
  if (nv.Name !== undefined) o.name = nv.Name;
  if (nv.Desc !== undefined) o.desc = nv.Desc;
  if (nv.AttachItemID) o.attachItemId = nv.AttachItemID;
  if (nv.AttachmentOffset) o.attachmentOffset = nv.AttachmentOffset;
  o.nameValues = nv;
  return nv;
}

function isTree(pcode) {
  return pcode === PCODE.TREE || pcode === PCODE.NEW_TREE || pcode === PCODE.GRASS;
}

// ObjectUpdate (0/12 High): la version "sin comprimir", con todos los campos.
export function decodeObjectUpdate(msg) {
  const out = [];
  for (const b of msg.list("ObjectData")) {
    const o = makeObject();
    o.localId = b.ID >>> 0;
    o.uuid = b.FullID;
    o.crc = b.CRC >>> 0;
    o.pcode = b.PCode;
    o.state = b.State;
    o.material = b.Material;
    o.clickAction = b.ClickAction;
    o.scale = b.Scale;
    o.flags = b.UpdateFlags >>> 0;
    o.parentId = b.ParentID >>> 0;
    o.owner = b.OwnerID;
    o.sound = b.Sound;
    o.gain = b.Gain;
    o.radius = b.Radius;
    o.jointType = b.JointType;
    o.jointPivot = b.JointPivot;
    o.jointAxis = b.JointAxisOrAnchor;

    const fp = readFullPrecisionBlock(b.ObjectData);
    o.fullPrecisionRaw = b.ObjectData;
    if (fp) {
      o.position = fp.position;
      o.quaternion = fp.quaternion;
      o.velocity = fp.velocity;
      o.acceleration = fp.acceleration;
      o.angularVelocity = fp.angularVelocity;
      if (fp.collisionPlane) o.collisionPlane = fp.collisionPlane;
    }
    applyVolumeFields(o, {
      pathCurve: b.PathCurve,
      profileCurve: b.ProfileCurve,
      begin: unpackBeginCut(b.PathBegin),
      end: unpackEndCut(b.PathEnd),
      scaleX: unpackPathScale(b.PathScaleX),
      scaleY: unpackPathScale(b.PathScaleY),
      shearX: unpackPathShear(b.PathShearX),
      shearY: unpackPathShear(b.PathShearY),
      twist: unpackPathTwist(b.PathTwist),
      twistBegin: unpackPathTwist(b.PathTwistBegin),
      radiusOffset: unpackPathTwist(b.PathRadiusOffset),
      taperX: unpackPathTaper(b.PathTaperX),
      taperY: unpackPathTaper(b.PathTaperY),
      revolutions: unpackPathRevolutions(b.PathRevolutions),
      skew: unpackPathTwist(b.PathSkew),
      profileBegin: unpackBeginCut(b.ProfileBegin),
      profileEnd: unpackEndCut(b.ProfileEnd),
      hollow: unpackProfileHollow(b.ProfileHollow),
    });
    // Los valores EMPAQUETADOS de volumen, tal cual venian del cable. Al
    // reenviar un objeto (o al reescribir una captura) hay que devolver los
    // mismos bytes, y pasar por las quanta dos veces (desempaquetar y volver a
    // empaquetar) puede no ser exacto en los limites. Guardarlos hace que el
    // reenvio sea literal, que es justo lo que hace un retransmisor.
    o.rawVolume = {
      pathCurve: b.PathCurve,
      profileCurve: b.ProfileCurve,
      pathBegin: b.PathBegin,
      pathEnd: b.PathEnd,
      pathScaleX: b.PathScaleX,
      pathScaleY: b.PathScaleY,
      pathShearX: b.PathShearX,
      pathShearY: b.PathShearY,
      pathTwist: b.PathTwist,
      pathTwistBegin: b.PathTwistBegin,
      pathRadiusOffset: b.PathRadiusOffset,
      pathTaperX: b.PathTaperX,
      pathTaperY: b.PathTaperY,
      pathRevolutions: b.PathRevolutions,
      pathSkew: b.PathSkew,
      profileBegin: b.ProfileBegin,
      profileEnd: b.ProfileEnd,
      profileHollow: b.ProfileHollow,
    };
    o.textureAnimRaw = b.TextureAnim instanceof Uint8Array ? b.TextureAnim : new Uint8Array(0);
    o.nameValueRaw = b.NameValue instanceof Uint8Array ? b.NameValue : new Uint8Array(0);
    o.dataRaw = b.Data instanceof Uint8Array ? b.Data : new Uint8Array(0);
    o.textColorRaw = b.TextColor instanceof Uint8Array ? b.TextColor : new Uint8Array(0);
    o.extraParamsRaw = b.ExtraParams instanceof Uint8Array ? b.ExtraParams : new Uint8Array(0);
    o.textRaw = b.Text instanceof Uint8Array ? b.Text : new Uint8Array(0);
    o.mediaUrlRaw = b.MediaURL instanceof Uint8Array ? b.MediaURL : new Uint8Array(0);
    o.psBlockRaw = b.PSBlock instanceof Uint8Array ? b.PSBlock : new Uint8Array(0);
    if (b.TextureEntry && b.TextureEntry.length) applyTextureEntry(o, b.TextureEntry);
    if (b.TextureAnim && b.TextureAnim.length) o.textureAnim = Uint8Array.from(b.TextureAnim);
    if (b.NameValue && b.NameValue.length) applyNameValue(o, b.NameValue);
    if (b.Text && b.Text.length) {
      o.text = utf8FromFixed(b.Text);
      if (b.TextColor && b.TextColor.length >= 4) {
        o.textColor = [b.TextColor[0], b.TextColor[1], b.TextColor[2], 255 - b.TextColor[3]];
      }
    }
    if (b.MediaURL && b.MediaURL.length) o.mediaUrl = utf8FromFixed(b.MediaURL);
    if (b.Data && b.Data.length) {
      if (isTree(o.pcode)) o.treeSpecies = b.Data[0];
      else o.linkset = b.Data[0] || 1;
    }
    if (b.ExtraParams && b.ExtraParams.length) o.extraParams = readExtraParams(b.ExtraParams);
    out.push(o);
  }
  return out;
}

// ObjectUpdateCompressed (0/13 High): todo el objeto en un blob, con los
// bloques opcionales marcados por `SpecialCode` (llviewerobject.cpp:1700-1970).
export function decodeObjectUpdateCompressed(msg) {
  const out = [];
  for (const b of msg.list("ObjectData")) {
    const o = decodeCompressedBlob(b.Data, b.UpdateFlags >>> 0);
    if (o) out.push(o);
  }
  return out;
}

export function decodeCompressedBlob(data, updateFlags) {
  const r = new BufReader(data);
  const o = makeObject();
  o.compressed = true;
  o.flags = updateFlags >>> 0;
  o.uuid = uuidFromBytes(r.bytes(16), 0);
  o.localId = r.u32();
  o.pcode = r.u8();
  o.state = r.u8();
  o.crc = r.u32();
  o.material = r.u8();
  o.clickAction = r.u8();
  o.scale = [r.f32(), r.f32(), r.f32()];
  o.position = [r.f32(), r.f32(), r.f32()];
  o.quaternion = quatFromVector3([r.f32(), r.f32(), r.f32()]);
  o.acceleration = [0, 0, 0];
  const flags = r.u32();
  o.owner = uuidFromBytes(r.bytes(16), 0);
  if (flags & COMPRESSED_FLAGS.HAS_ANGULAR_VELOCITY) {
    o.angularVelocity = [r.f32(), r.f32(), r.f32()];
  }
  o.parentId = (flags & COMPRESSED_FLAGS.HAS_PARENT) ? r.u32() : 0;
  if (flags & COMPRESSED_FLAGS.TREE) {
    o.treeSpecies = r.u8();
  } else if (flags & COMPRESSED_FLAGS.SCRATCH_PAD) {
    const size = r.u32();
    if (size <= r.remaining) r.skip(size);
    else r.p = r.end;
  }
  if (flags & COMPRESSED_FLAGS.HAS_TEXT) {
    o.text = readCString(r);
    if (r.remaining >= 4) {
      const c = Array.from(r.bytes(4));
      o.textColor = [c[0], c[1], c[2], 255 - c[3]];
    }
  }
  if (flags & COMPRESSED_FLAGS.MEDIA_URL) o.mediaUrl = readCString(r);
  if (flags & COMPRESSED_FLAGS.HAS_PARTICLES) {
    if (r.remaining >= 86) r.skip(86);
    else r.p = r.end;
  }
  let numParams = 0;
  const paramsStart = r.p;
  const len = extraParamsLength(data, paramsStart);
  if (len > 0) {
    o.extraParams = readExtraParams(data, paramsStart);
    numParams = o.extraParams.length;
    r.p = paramsStart + len;
  } else if (r.remaining >= 1) {
    numParams = r.u8();
  }
  if (flags & COMPRESSED_FLAGS.HAS_SOUND) {
    o.sound = uuidFromBytes(r.bytes(16), 0);
    o.gain = r.f32();
    o.soundFlags = r.u8();
    o.radius = r.f32();
  }
  if (flags & COMPRESSED_FLAGS.HAS_NAME_VALUES) applyNameValue(o, readCStringBytes(r));
  o.compressedFlags = flags;
  o.numExtraParams = numParams;

  const v = readVolumeFieldsCompressed(r);
  applyVolumeFields(o, v);
  const teLen = r.u32();
  if (teLen > 0 && teLen <= r.remaining) applyTextureEntry(o, r.bytes(teLen));
  if (flags & COMPRESSED_FLAGS.TEXTURE_ANIM) {
    const animLen = r.u32();
    if (animLen <= r.remaining) o.textureAnim = Uint8Array.from(r.bytes(animLen));
  }
  o.bytesRead = r.p;
  o.bytesTotal = data.length;
  return o;
}

function readCString(r) {
  return utf8FromFixed(readCStringBytes(r));
}

function readCStringBytes(r) {
  const start = r.p;
  while (r.p < r.end && r.buf[r.p] !== 0) r.p++;
  const bytes = r.buf.subarray(start, r.p);
  if (r.p < r.end) r.p++;
  return bytes;
}

// ObjectUpdateCached (0/14 High): solo el id, el CRC y los flags. Si el objeto
// no esta en cache hay que pedirlo con RequestMultipleObjects.
export function decodeObjectUpdateCached(msg) {
  return msg.list("ObjectData").map((b) => ({
    localId: b.ID >>> 0,
    crc: b.CRC >>> 0,
    flags: b.UpdateFlags >>> 0,
  }));
}

// ImprovedTerseObjectUpdate (0/15 High): posicion + rotacion de un objeto que ya
// conocemos. Lleva el TextureEntry en un bloque aparte con 4 bytes de longitud
// delante (que se saltan, igual que hace el visor).
export function decodeImprovedTerseObjectUpdate(msg) {
  const out = [];
  for (const b of msg.list("ObjectData")) {
    const t = readTerseBlock(b.Data);
    if (!t) continue;
    const o = makeObject();
    o.terse = true;
    o.isAvatar = !!t.isAvatar;
    o.localId = t.localId;
    o.state = t.state;
    o.position = t.position;
    o.quaternion = t.quaternion;
    o.velocity = t.velocity;
    o.acceleration = t.acceleration;
    o.angularVelocity = t.angularVelocity;
    if (t.collisionPlane) o.collisionPlane = t.collisionPlane;
    const te = b.TextureEntry;
    if (te && te.length > 4) applyTextureEntry(o, te.subarray(4));
    out.push(o);
  }
  return out;
}

// KillObject (0/16 High).
export function decodeKillObject(msg) {
  return msg.list("ObjectData").map((b) => b.ID >>> 0);
}

// ---------------------------------------------------------------------------
// Escritura de objetos
// ---------------------------------------------------------------------------
//
// El camino de vuelta: de un registro del visor a los bytes del cable. Hace
// falta para dos cosas: para que el simulador de pruebas (`sim.js`) pueda
// mandar prims de verdad, y para poder comprobar el decodificador al reves
// (descodificar una captura real, reescribirla y exigir que salga identica).
//
// Los campos opcionales (TextureAnim, NameValue, Data, Text, MediaURL, PSBlock,
// ExtraParams) van SIEMPRE en el cable, con longitud 0 cuando no hay nada: van
// en medio del mensaje y saltarselos desalinearia todo lo que viene detras.

// U16 -> F32 con el mismo rango que usa el update "terse".
function f32ToU16(v, lo, hi) {
  const t = (clamp(v, lo, hi) - lo) / (hi - lo);
  return clamp(Math.round(t * 65535), 0, 65535);
}

// El bloque de 60/76 bytes del ObjectUpdate completo: posicion, velocidad,
// aceleracion, rotacion (tres componentes) y velocidad angular.
export function encodeFullPrecisionBlock(o, opts = {}) {
  const w = new BufWriter(76);
  if (opts.collisionPlane) for (let i = 0; i < 4; i++) w.f32(opts.collisionPlane[i] || 0);
  vec(o.position, w);
  vec(o.velocity, w);
  vec(o.acceleration, w);
  const q = o.quaternion || [0, 0, 0, 1];
  w.f32(q[0] || 0).f32(q[1] || 0).f32(q[2] || 0);
  vec(o.angularVelocity, w);
  return w.build();
}

// El bloque de 44 bytes (48 en avatares) del ImprovedTerseObjectUpdate.
export function encodeTerseBlock(o, isAvatar) {
  const w = new BufWriter(48);
  w.u32(o.localId >>> 0).u8(o.state || 0).u8(isAvatar ? 1 : 0);
  if (isAvatar) for (let i = 0; i < 4; i++) w.f32((o.collisionPlane && o.collisionPlane[i]) || 0);
  vec(o.position, w);
  const v = o.velocity || [0, 0, 0];
  w.u16(f32ToU16(v[0], -128, 128)).u16(f32ToU16(v[1], -128, 128)).u16(f32ToU16(v[2], -128, 128));
  const a = o.acceleration || [0, 0, 0];
  w.u16(f32ToU16(a[0], -64, 64)).u16(f32ToU16(a[1], -64, 64)).u16(f32ToU16(a[2], -64, 64));
  const q = o.quaternion || [0, 0, 0, 1];
  for (let i = 0; i < 4; i++) w.u16(f32ToU16(q[i], -1, 1));
  const om = o.angularVelocity || [0, 0, 0];
  w.u16(f32ToU16(om[0], -64, 64)).u16(f32ToU16(om[1], -64, 64)).u16(f32ToU16(om[2], -64, 64));
  return w.build();
}

function vec(v, w) {
  const a = v || [0, 0, 0];
  return w.f32(a[0] || 0).f32(a[1] || 0).f32(a[2] || 0);
}

// Los pares nombre/valor de un prim ("Name Caja\nDesc ...\n"). El simulador los
// manda como binario, SIN el NUL final que llevan los campos de texto.
export function encodeNameValueBytes(o) {
  let s = "";
  if (o.name) s += "Name " + o.name + "\n";
  if (o.desc) s += "Desc " + o.desc + "\n";
  if (o.attachItemId) s += "AttachItemID " + o.attachItemId + "\n";
  if (o.attachmentOffset) s += "AttachmentOffset " + o.attachmentOffset + "\n";
  if (o.nameValues) {
    for (const k of Object.keys(o.nameValues)) {
      if (k === "Name" || k === "Desc") continue;
      s += k + " " + o.nameValues[k] + "\n";
    }
  }
  return fixedFromUtf8(s);
}

// Un registro de objeto -> el item del bloque `ObjectData` del ObjectUpdate.
export function encodeObjectUpdateEntry(o, opts = {}) {
  const v = o.volParams || primParamsToVolume(o.params || { shape: o.shape || "box" });
  const nFaces = Math.max(1, Math.min(MAX_TES, opts.faces || o.facesCount || FACE_FALLBACK[o.shape] || 1));
  const te = o.textureEntryRaw && opts.keepRaw ? o.textureEntryRaw
    : writeTextureEntry(facesFromRecord(o, nFaces), o.color === undefined ? null : o.color);
  const teOut = te.slice();
  // El visor de Linden Lab manda un byte de mas al final del TextureEntry
  // (`packTEMessage` escribe el terminador y lo cuenta). Se conserva para que
  // el receptor corte donde corta el de verdad.
  if (!(o.textureEntryRaw && opts.keepRaw)) teOut[teOut.length] = 0;
  const raw = opts.keepRaw && o.rawVolume ? o.rawVolume : null;
  return {
    ID: o.localId >>> 0,
    State: o.state || 0,
    FullID: o.uuid,
    CRC: o.crc >>> 0,
    PCode: o.pcode || PCODE.PRIMITIVE,
    Material: o.material || 0,
    ClickAction: o.clickAction || 0,
    Scale: o.scale || [1, 1, 1],
    ObjectData: o.fullPrecisionRaw && opts.keepRaw
      ? o.fullPrecisionRaw
      : encodeFullPrecisionBlock(o, opts),
    ParentID: o.parentId >>> 0,
    UpdateFlags: (o.flags || 0) >>> 0,
    PathCurve: raw ? raw.pathCurve : v.pathCurve,
    ProfileCurve: raw ? raw.profileCurve : v.profileCurve,
    PathBegin: raw ? raw.pathBegin : packBeginCut(v.begin),
    PathEnd: raw ? raw.pathEnd : packEndCut(v.end),
    PathScaleX: raw ? raw.pathScaleX : packPathScale(v.scaleX),
    PathScaleY: raw ? raw.pathScaleY : packPathScale(v.scaleY),
    PathShearX: raw ? raw.pathShearX : packPathShear(v.shearX),
    PathShearY: raw ? raw.pathShearY : packPathShear(v.shearY),
    PathTwist: raw ? raw.pathTwist : packPathTwist(v.twist),
    PathTwistBegin: raw ? raw.pathTwistBegin : packPathTwist(v.twistBegin),
    PathRadiusOffset: raw ? raw.pathRadiusOffset : packPathTwist(v.radiusOffset),
    PathTaperX: raw ? raw.pathTaperX : packPathTaper(v.taperX),
    PathTaperY: raw ? raw.pathTaperY : packPathTaper(v.taperY),
    PathRevolutions: raw ? raw.pathRevolutions : packPathRevolutions(v.revolutions),
    PathSkew: raw ? raw.pathSkew : packPathTwist(v.skew),
    ProfileBegin: raw ? raw.profileBegin : packBeginCut(v.profileBegin),
    ProfileEnd: raw ? raw.profileEnd : packEndCut(v.profileEnd),
    ProfileHollow: raw ? raw.profileHollow : packProfileHollow(v.hollow),
    TextureEntry: teOut,
    TextureAnim: opts.keepRaw && o.textureAnimRaw ? o.textureAnimRaw : (o.textureAnim || new Uint8Array(0)),
    NameValue: opts.keepRaw && o.nameValueRaw ? o.nameValueRaw : encodeNameValueBytes(o),
    Data: opts.keepRaw && o.dataRaw ? o.dataRaw : encodeObjectDataByte(o),
    // Un campo `Variable` con un string recibe el terminador NUL (es lo que hace
    // `LLMessageSystem::addString`); los datos binarios van tal cual. Por eso un
    // texto vacio se manda como bytes (0 de longitud) y no como cadena "".
    Text: opts.keepRaw && o.textRaw ? o.textRaw : (o.text ? o.text : new Uint8Array(0)),
    TextColor: opts.keepRaw && o.textColorRaw ? o.textColorRaw : textColorBytes(o.textColor),
    MediaURL: opts.keepRaw && o.mediaUrlRaw ? o.mediaUrlRaw : (o.mediaUrl ? o.mediaUrl : new Uint8Array(0)),
    PSBlock: opts.keepRaw && o.psBlockRaw ? o.psBlockRaw : (o.psBlock || new Uint8Array(0)),
    ExtraParams: o.extraParamsRaw && opts.keepRaw
      ? o.extraParamsRaw
      : (o.extraParams && o.extraParams.length ? writeExtraParams(o.extraParams) : new Uint8Array(0)),
    Sound: o.sound || NULL_UUID,
    OwnerID: o.owner || NULL_UUID,
    Gain: o.gain || 0,
    Flags: o.soundFlags || 0,
    Radius: o.radius || 0,
    JointType: o.jointType || 0,
    JointPivot: o.jointPivot || [0, 0, 0],
    JointAxisOrAnchor: o.jointAxis || [0, 0, 0],
  };
}

function encodeObjectDataByte(o) {
  if (isTree(o.pcode)) return Uint8Array.of((o.treeSpecies || 0) & 0xff);
  const n = Math.max(0, Math.min(255, o.linkset === undefined ? 1 : o.linkset));
  return o.linkset === 0 ? new Uint8Array(0) : Uint8Array.of(n);
}

function textColorBytes(c) {
  const a = c || [0, 0, 0];
  return Uint8Array.of(a[0] || 0, a[1] || 0, a[2] || 0, 255 - (a[3] === undefined ? 255 : a[3]));
}

// Las caras del registro (formato del visor) o, si no hay, todas del color base.
function facesFromRecord(o, nFaces) {
  if (o.rawFaces && o.rawFaces.length) return o.rawFaces;
  const out = [];
  for (let i = 0; i < nFaces; i++) out.push(emptyFace());
  if (o.faces) {
    for (let i = 0; i < nFaces && i < o.faces.length; i++) Object.assign(out[i], o.faces[i]);
  }
  return out;
}

// Los bloques listos para `encodePacket({name:"ObjectUpdate", ...})`.
export function encodeObjectUpdateBlocks(list, regionHandle, timeDilation) {
  return {
    RegionData: [{ RegionHandle: regionHandle || 0, TimeDilation: timeDilation === undefined ? 65535 : timeDilation }],
    ObjectData: list.map((o) => encodeObjectUpdateEntry(o)),
  };
}

export function encodeTerseObjectUpdateBlocks(list, regionHandle, timeDilation) {
  return {
    RegionData: [{ RegionHandle: regionHandle || 0, TimeDilation: timeDilation === undefined ? 65535 : timeDilation }],
    ObjectData: list.map((o) => ({
      Data: encodeTerseBlock(o, !!o.isAvatar),
      // El TextureEntry del terse lleva una longitud de 4 bytes delante que hay
      // que saltar al leer: aqui se deja vacio (0) porque el update terse no
      // cambia texturas.
      TextureEntry: new Uint8Array(4),
    })),
  };
}

// ---------------------------------------------------------------------------
// Cuaterniones y coordenadas
// ---------------------------------------------------------------------------

// LLQuaternion::unpackFromVector3: en el cable viajan x,y,z; la w se deduce (y
// puede salir 0 si los datos no eran unitarios, cosa que pasa con los updates
// "vacios" del simulador).
export function quatFromVector3(v) {
  const s = 1 - v[0] * v[0] - v[1] * v[1] - v[2] * v[2];
  return [v[0], v[1], v[2], s > 0 ? Math.sqrt(s) : 0];
}

export function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatNormalize(q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n < 1e-9) return [0, 0, 0, 1];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatEqualish(a, b, eps = 1e-4) {
  const d1 = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);
  const d2 = Math.abs(a[0] + b[0]) + Math.abs(a[1] + b[1]) + Math.abs(a[2] + b[2]) + Math.abs(a[3] + b[3]);
  return Math.min(d1, d2) < eps;
}

// SL (x hacia el este, y hacia el norte, z hacia arriba) -> visor (x, y arriba,
// z). Es una rotacion de -90 grados sobre el eje x, asi que se aplica igual a
// las posiciones y (conjugada) a las rotaciones: el mundo no sale reflejado.
const R_VIEW = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];        // rotacion de -90 grados en x
const R_SL = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];           // su inversa

export function slPosToViewer(p) {
  return [p[0] - SL_REGION_HALF, p[2], SL_REGION_HALF - p[1]];
}

export function viewerPosToSl(p) {
  return [p[0] + SL_REGION_HALF, SL_REGION_HALF - p[2], p[1]];
}

export function slQuatToViewer(q) {
  return quatNormalize(quatMul(quatMul(R_VIEW, q), R_SL));
}

export function viewerQuatToSl(q) {
  return quatNormalize(quatMul(quatMul(R_SL, q), R_VIEW));
}

// ---------------------------------------------------------------------------
// Registro para el visor
// ---------------------------------------------------------------------------

// Convierte un objeto de protocolo en el registro que viaja por el cable del
// retransmisor (el mismo formato que src/sl/mockServer.js `recordFor`).
export function primRecord(o, viewerId) {
  const params = o.params instanceof PrimParams
    ? Object.assign({}, o.params)
    : Object.assign({ shape: o.shape }, o.params || {});
  params.shape = o.shape;
  const rec = {
    id: viewerId === undefined ? o.localId : viewerId,
    uuid: o.uuid,
    name: o.name || ("Objeto " + o.localId),
    shape: o.shape,
    params,
    position: slPosToViewer(o.position),
    quaternion: slQuatToViewer(o.quaternion),
    scale: o.scale,
    color: o.color,
    faces: o.faces,
    script: null,
    desc: o.desc || null,
    build: true,
    phantom: !!(o.flags & UPDATE_FLAGS.PHANTOM),
    owner: null,
    parent: o.parentId || null,
    local: null,
    tag: null,
    slUuid: o.uuid,
    slLocalId: o.localId,
    slParentId: o.parentId || 0,
    slCRC: o.crc,
    slFlags: o.flags,
    slPcode: o.pcode,
    slOwner: o.owner,
    slScale: o.scale,
    slPos: o.position,
    slRot: o.quaternion,
    slState: o.state,
    text: o.text || "",
    textColor: o.textColor || null,
    mediaUrl: o.mediaUrl || "",
    linkset: o.linkset || 1,
  };
  return rec;
}

// Update "parcial" para S.OBJECT_UPDATE: solo lo que cambio. El visor lo aplica
// con `World.updateFromRecord`.
export function primUpdateRecord(o) {
  const rec = { id: o.localId };
  if (o.position) rec.position = slPosToViewer(o.position);
  if (o.quaternion) rec.quaternion = slQuatToViewer(o.quaternion);
  if (o.scale) rec.scale = o.scale;
  if (o.faces) rec.faces = o.faces;
  if (o.color !== undefined) rec.color = o.color;
  if (o.name) rec.name = o.name;
  if (o.desc !== undefined && o.desc !== null) rec.desc = o.desc;
  if (o.flags !== undefined) rec.phantom = !!(o.flags & UPDATE_FLAGS.PHANTOM);
  if (o.text !== undefined) rec.text = o.text;
  if (o.mediaUrl !== undefined) rec.mediaUrl = o.mediaUrl;
  rec.slCRC = o.crc;
  return rec;
}

// ---------------------------------------------------------------------------
// Autotest
// ---------------------------------------------------------------------------

export function runObjectsSelfTest() {
  const checks = [];
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const near = (name, got, want, eps = 1e-4) => checks.push({ name, ok: Math.abs(got - want) <= eps, got, want });
  const nearArr = (name, got, want, eps = 1e-4) => {
    const good = got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= eps);
    checks.push({ name, ok: good, got, want });
  };
  const throws = (name, fn, re) => {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    checks.push({ name, ok: err && (!re || re.test(err.message)), got: err ? err.message : "no lanzo" });
  };

  // --- quantas --------------------------------------------------------------
  eq("beginCut ida y vuelta", packBeginCut(unpackBeginCut(12345)), 12345);
  eq("endCut ida y vuelta", packEndCut(unpackEndCut(23456)), 23456);
  near("endCut(0) = 1", unpackEndCut(0), 1);
  eq("pathScale ida y vuelta", packPathScale(unpackPathScale(150)), 150);
  eq("pathShear ida y vuelta", packPathShear(unpackPathShear(0x9c)), 0x9c);
  near("pathShear signo", unpackPathShear(0x9c), -1.0, 1e-9);
  eq("revolutions ida y vuelta", packPathRevolutions(unpackPathRevolutions(20)), 20);
  near("revolutions 0 = 1", unpackPathRevolutions(0), 1);

  // --- formas --------------------------------------------------------------
  eq("box", shapeFromCurves(PATH.LINE, PROFILE.SQUARE), "box");
  eq("cylinder", shapeFromCurves(PATH.LINE, PROFILE.CIRCLE), "cylinder");
  eq("prism", shapeFromCurves(PATH.LINE, PROFILE.EQUALTRI), "prism");
  eq("sphere", shapeFromCurves(PATH.CIRCLE, PROFILE.CIRCLE_HALF), "sphere");
  eq("torus", shapeFromCurves(PATH.CIRCLE, PROFILE.CIRCLE), "torus");
  eq("tube", shapeFromCurves(PATH.CIRCLE, PROFILE.SQUARE), "tube");
  eq("ring", shapeFromCurves(PATH.CIRCLE2, PROFILE.EQUALTRI), "ring");
  eq("hueco cuadrado", holeShapeFromCode(HOLE.SQUARE), "square");

  // --- ida y vuelta de los parametros de volumen ---------------------------
  const shapeCases = [
    ["box", {}],
    ["cylinder", { pathCutBegin: 0.1, pathCutEnd: 0.8, hollow: 0.4, holeShape: "circle" }],
    ["prism", { taperX: 0.4, taperY: -0.2, shearX: 0.3, skew: 0.2 }],
    ["sphere", { profileCutBegin: 0.1, profileCutEnd: 0.6, twistEnd: 90 }],
    ["torus", { holeX: 0.3, holeY: 0.2, twistBegin: 30, twistEnd: 120, revolution: 2, slope: 0.4 }],
    ["tube", { holeX: 1.0, holeY: 0.4, taperX: 0.1 }],
    ["ring", { holeX: 0.1, holeY: 0.3, hollow: 0.2, holeShape: "triangle" }],
  ];
  for (const [shape, over] of shapeCases) {
    const p = new PrimParams(shape);
    Object.assign(p, over);
    const v = primParamsToVolume(p);
    const back = volumeToPrimParams(v);
    ok("volumen " + shape + " conserva la forma", back.shape === shape, back.shape);
    let worst = 0;
    for (const k of ["pathCutBegin", "pathCutEnd", "profileCutBegin", "profileCutEnd", "hollow",
      "twistBegin", "twistEnd", "taperX", "taperY", "shearX", "shearY", "slope", "skew", "revolution",
      "holeX", "holeY"]) {
      const a = p[k], b = back[k];
      if (typeof a !== "number") continue;
      // Los giros viajan en quantas de 0.01 radianes (0.01 * 180 = 1.8 grados
      // de error como mucho); el resto de parametros son mucho mas finos.
      const tol = k === "twistBegin" || k === "twistEnd" ? 2 : 0.02;
      worst = Math.max(worst, Math.abs(a - b) / tol);
    }
    ok("volumen " + shape + " ida y vuelta (err " + worst.toFixed(4) + " tolerancias)", worst <= 1, worst);
    if (over.holeShape) eq("volumen " + shape + " conserva el hueco", back.holeShape, over.holeShape);
  }

  // --- ida y vuelta binaria de los parametros de volumen -------------------
  for (const [shape, over] of shapeCases) {
    const p = new PrimParams(shape);
    Object.assign(p, over);
    const v = primParamsToVolume(p);
    const w = new BufWriter(32);
    writeVolumeFields(w, v);
    const bytes = w.build();
    eq("bloque de volumen " + shape + " = 23 bytes", bytes.length, 23);
    const back = readVolumeFieldsCompressed(new BufReader(bytes));
    const near2 = ["begin", "end", "scaleX", "scaleY", "twist", "twistBegin", "radiusOffset",
      "taperX", "taperY", "revolutions", "skew", "profileBegin", "profileEnd", "hollow"];
    let worst = 0;
    for (const k of near2) worst = Math.max(worst, Math.abs(v[k] - back[k]));
    ok("bloque de volumen " + shape + " ida y vuelta (err " + worst.toFixed(5) + ")", worst < 0.02, worst);
    eq("bloque de volumen " + shape + " conserva la curva", [back.pathCurve, back.profileCurve], [v.pathCurve, v.profileCurve]);
  }

  // --- texture entry: el del paquete real de ObjectUpdate -----------------
  // ObjectUpdateMessageZL: 6 caras, texto naranja por defecto y amarillo en las
  // caras 0-4, fullbright y glow 13/255.
  const teReal = Uint8Array.from([
  222, 129, 166, 142, 198, 119, 46, 206, 173, 227, 19, 159, 122, 152, 158, 222,
  31, 137, 85, 103, 71, 36, 203, 67, 237, 146, 11, 71, 202, 237, 21, 70,
  95, 0, 0, 127, 255, 0, 31, 0, 0, 0, 255, 0, 0, 0, 128, 63,
  0, 0, 0, 128, 63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32,
  31, 0, 0, 0, 0, 13, 31, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
]);
  const te = readTextureEntryRaw(teReal);
  eq("TE real: uuid por defecto", teRawUuid(te.image[5]), "de81a68e-c677-2ece-ade3-139f7a989ede");
  eq("TE real: uuid de la cara 0", teRawUuid(te.image[0]), "89556747-24cb-43ed-920b-47caed15465f");
  eq("TE real: uuid de la cara 4", teRawUuid(te.image[4]), "89556747-24cb-43ed-920b-47caed15465f");
  eq("TE real: color por defecto", Array.from(te.color[5]), [0, 127, 255, 0]);
  eq("TE real: color cara 0 (transparente)", Array.from(te.color[0]), [0, 0, 0, 255]);
  eq("TE real: escala", f32le(te.scaleS[0], 0), 1);
  eq("TE real: bump de la cara 0", te.bump[0][0], 0);
  eq("TE real: bump por defecto", te.bump[5][0], 0x20);
  eq("TE real: glow por defecto", te.glow[5][0], 13);
  const faceRes = textureEntryToFaces(te, 6, null);
  // Las caras 0-4 van con alfa 0 (invisibles) y comparten la textura de la cara
  // 0; la cara 5 es la naranja, opaca y con fullbright.
  eq("TE real: color del prim = blanco (cara 0)", faceRes.color, 0xffffff);
  eq("TE real: cara 0 usa el color del prim", faceRes.faces[0].color, null);
  eq("TE real: cara 0 invisible", faceRes.faces[0].alpha, 0);
  eq("TE real: cara 5 naranja", faceRes.faces[5].color, 0xff8000);
  ok("TE real: fullbright por defecto", faceRes.faces[5].fullbright === true, faceRes.faces[5].fullbright);
  near("TE real: glow 0.051", faceRes.faces[5].glow, 13 / 255, 1e-6);

  // --- texture entry: el del paquete comprimido (97 bytes) ----------------
  const teComp = Uint8Array.from([
  87, 72, 222, 204, 246, 41, 70, 28, 154, 54, 163, 90, 34, 31, 226, 31,
  2, 90, 49, 120, 178, 167, 197, 173, 66, 250, 235, 237, 139, 40, 150, 4,
  167, 1, 17, 229, 45, 74, 40, 159, 182, 40, 146, 157, 81, 150, 24, 246,
  165, 210, 0, 0, 0, 0, 0, 0, 0, 0, 128, 63, 0, 0, 0, 128,
  63, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0,
]);
  const tc = readTextureEntryRaw(teComp);
  eq("TE comprimido: uuid por defecto", teRawUuid(tc.image[5]), "5748decc-f629-461c-9a36-a35a221fe21f");
  eq("TE comprimido: uuid cara 1", teRawUuid(tc.image[1]), "5a3178b2-a7c5-ad42-faeb-ed8b289604a7");
  eq("TE comprimido: uuid cara 0", teRawUuid(tc.image[0]), "11e52d4a-289f-b628-929d-519618f6a5d2");
  eq("TE comprimido: color blanco", [tc.color[0][0], tc.color[0][1], tc.color[0][2], tc.color[0][3]], [0, 0, 0, 0]);
  near("TE comprimido: escala S", f32le(tc.scaleS[0], 0), 1, 1e-6);
  near("TE comprimido: escala T", f32le(tc.scaleT[0], 0), 1, 1e-6);
  eq("TE comprimido: material nulo", teRawUuid(tc.material[0]), NULL_UUID);

  // --- texture entry: ida y vuelta ---------------------------------------
  {
    const faces = [];
    for (let i = 0; i < 6; i++) faces.push(emptyFace());
    faces[0].tex = { a: "11111111-2222-3333-4444-555555555555" };
    faces[0].color = 0x336699;
    faces[0].alpha = 0.5;
    faces[0].glow = 0.25;
    faces[0].fullbright = true;
    faces[0].repeat = [2, 3];
    faces[0].offset = [0.25, -0.5];
    faces[0].rotation = Math.PI / 3;
    faces[2].repeat = [4, 1];
    const bytes = writeTextureEntry(faces, 0xffffff);
    const back = textureEntryToFaces(readTextureEntryRaw(bytes), 6, null);
    eq("TE ida y vuelta: uuid", back.faces[0].tex.a, faces[0].tex.a);
    eq("TE ida y vuelta: color", back.color, faces[0].color);
    eq("TE ida y vuelta: cara 0 hereda el color", back.faces[0].color, null);
    near("TE ida y vuelta: alfa", back.faces[0].alpha, 0.5, 1 / 255);
    near("TE ida y vuelta: glow", back.faces[0].glow, 0.25, 1 / 255);
    eq("TE ida y vuelta: fullbright", back.faces[0].fullbright, true);
    nearArr("TE ida y vuelta: repeticion", back.faces[0].repeat, [2, 3], 1e-6);
    nearArr("TE ida y vuelta: desplazamiento", back.faces[0].offset, [0.25, -0.5], 1 / 0x7fff + 1e-6);
    near("TE ida y vuelta: rotacion", back.faces[0].rotation, Math.PI / 3, 1e-3);
    nearArr("TE ida y vuelta: cara 2", back.faces[2].repeat, [4, 1], 1e-6);
    eq("TE ida y vuelta: cara 1 por defecto", back.faces[1].tex, null);
    ok("TE ida y vuelta: 6 caras", back.faces.length === 6, back.faces.length);
  }

  // --- ExtraParams: el del paquete real (luz + mapa de luz) ---------------
  const epReal = Uint8Array.from([
    2, 32, 0, 16, 0, 0, 0, 255, 128, 0, 255, 0, 0, 32, 65, 0, 0, 0, 0, 0, 0, 128, 63,
    64, 0, 28, 0, 0, 0, 222, 129, 166, 142, 198, 119, 46, 206, 173, 227, 19, 159,
    122, 152, 158, 222, 0, 0, 192, 63, 0, 0, 128, 63, 0, 0, 0, 0,
  ]);
  eq("ExtraParams: longitud", extraParamsLength(epReal, 0), epReal.length);
  const eps = readExtraParams(epReal);
  eq("ExtraParams: dos parametros", eps.length, 2);
  eq("ExtraParams: el primero es LIGHT", eps[0].name, "LIGHT");
  eq("ExtraParams: longitud de la luz", eps[0].length, 16);
  near("ExtraParams: intensidad", eps[0].intensity, 10, 1e-6);
  eq("ExtraParams: color de la luz", eps[0].color, [255, 128, 0, 255]);
  eq("ExtraParams: el segundo es LIGHT_IMAGE", eps[1].name, "LIGHT_IMAGE");
  eq("ExtraParams: uuid del mapa de luz", eps[1].uuid, "de81a68e-c677-2ece-ade3-139f7a989ede");
  {
    const bytes = writeExtraParams([
      { type: EXTRA_PARAM.SCULPT, meshType: 5, uuid: "11111111-2222-3333-4444-555555555555" },
      { type: EXTRA_PARAM.LIGHT, raw: eps[0].raw },
    ]);
    const back = readExtraParams(bytes);
    eq("ExtraParams ida y vuelta: cuenta", back.length, 2);
    eq("ExtraParams ida y vuelta: escultura", [back[0].name, back[0].meshType, back[0].uuid],
      ["SCULPT", 5, "11111111-2222-3333-4444-555555555555"]);
    near("ExtraParams ida y vuelta: luz", back[1].intensity, 10, 1e-6);
  }
  ok("ExtraParams: una lista vacia ocupa 0", writeExtraParams([]).length === 0);

  // --- bloque de 60 bytes (posicion/velocidad/rotacion/omega) -------------
  {
    const bytes = Uint8Array.from([
      248, 167, 252, 192, 85, 47, 39, 192, 250, 255, 177, 192,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      160, 196, 28, 63, 166, 196, 28, 191, 47, 4, 181, 190,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const fp = readFullPrecisionBlock(bytes);
    nearArr("bloque 60: posicion", fp.position, [-7.8956, -2.6123, -5.5625], 1e-3);
    nearArr("bloque 60: velocidad", fp.velocity, [0, 0, 0], 1e-9);
    near("bloque 60: cuaternion unitario", Math.hypot(...fp.quaternion), 1, 1e-4);
    ok("bloque 60: longitud desconocida -> null", readFullPrecisionBlock(new Uint8Array(50)) === null);
  }

  // --- bloque terse de 44 bytes (el del paquete real) --------------------
  {
    const bytes = Uint8Array.from([
      80, 177, 0, 38, 0, 0,
      154, 192, 98, 67, 141, 24, 98, 67, 90, 30, 255, 66,
      255, 127, 255, 127, 255, 127,
      255, 127, 255, 127, 255, 127,
      255, 127, 255, 127, 190, 9, 251, 176,
      255, 127, 255, 127, 255, 127,
    ]);
    const t = readTerseBlock(bytes.subarray(0, 44));
    eq("terse: id local", t.localId, 0x2600b150);
    eq("terse: estado", t.state, 0);
    nearArr("terse: posicion", t.position, [226.7522, 226.0959, 127.5586], 1e-2);
    near("terse: cuaternion unitario", Math.hypot(...t.quaternion), 1, 1e-4);
    // Los 12 bloques del paquete real dan cuaterniones unitarios y omega cero:
    // es la comprobacion que fija el orden de los campos.
    ok("terse: omega cero", Math.abs(t.angularVelocity[0]) < 0.01, t.angularVelocity);
  }

  // --- coordenadas --------------------------------------------------------
  nearArr("SL->visor", slPosToViewer([128, 128, 25]), [0, 25, 0], 1e-9);
  nearArr("visor->SL", viewerPosToSl([0, 25, 0]), [128, 128, 25], 1e-9);
  {
    const q = quatNormalize([0.2, 0.3, 0.4, 0.5]);
    ok("cuaternion SL->visor->SL", quatEqualish(viewerQuatToSl(slQuatToViewer(q)), q, 1e-6), slQuatToViewer(q));
  }
  ok("cuaternion identidad SL->visor unitario", Math.hypot(...slQuatToViewer([0, 0, 0, 1])) > 0.99, slQuatToViewer([0, 0, 0, 1]));

  // --- registro -----------------------------------------------------------
  {
    const o = makeObject();
    o.localId = 42;
    o.uuid = "11111111-2222-3333-4444-555555555555";
    o.pcode = PCODE.PRIMITIVE;
    o.params = new PrimParams("cylinder");
    o.shape = "cylinder";
    o.position = [128, 128, 20];
    o.scale = [1, 2, 1];
    o.quaternion = [0, 0, 0, 1];
    o.color = 0x808080;
    o.faces = facesToJson([emptyFace()]);
    const rec = primRecord(o);
    eq("registro: id", rec.id, 42);
    nearArr("registro: posicion centrada", rec.position, [0, 20, 0], 1e-9);
    eq("registro: forma", rec.shape, "cylinder");
    eq("registro: uuid de SL", rec.slUuid, o.uuid);
    eq("registro: sin padre", rec.parent, null);
    ok("registro: params con forma", rec.params.shape === "cylinder", rec.params);
  }

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
}

// ---------------------------------------------------------------------------
// Autotest del camino de ESCRITURA
//
// El autotest de arriba comprueba que los bytes que llegan se entienden. Este
// comprueba lo contrario: que un objeto se puede volver a poner en el cable.
// La prueba fuerte es reescribir una captura REAL y exigir los MISMOS bytes:
// eso es lo que hace el simulador de pruebas (`sim.js`) y lo que tendra que
// hacer el reenvio contra una region de verdad.
// ---------------------------------------------------------------------------
export async function runObjectWritesSelfTest() {
  const checks = [];
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const near = (name, got, want, eps = 1e-4) => checks.push({ name, ok: Math.abs(got - want) <= eps, got, want });
  const nearArr = (name, got, want, eps = 1e-4) => {
    const good = !!got && got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= eps);
    checks.push({ name, ok: good, got, want });
  };
  const firstDiff = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : Math.min(a.length, b.length);
  };

  // Import dinamico para no crear un ciclo al cargar el modulo (recapturas
  // importa el codec, que es de donde vienen estas funciones).
  const { decodePacket, encodePacket, FLAG } = await import("./codec.js");
  const { defaultTemplates } = await import("./template.js");
  const { bytesDeRecaptura } = await import("./recapturas.js");
  const t = defaultTemplates();

  // --- A) una captura REAL, reescrita con los bytes crudos, sale identica ----
  {
    const original = bytesDeRecaptura("ObjectUpdateMessageZL");
    const msg = decodePacket(original, t);
    eq("escritura: la captura se decodifica entera", msg.trailing, 0);
    const objs = decodeObjectUpdate(msg);
    ok("escritura: la captura trae objetos", objs.length > 0, objs.length);
    const rd = msg.first("RegionData");
    const again = encodePacket({
      name: "ObjectUpdate",
      packetId: msg.packetId,
      flags: msg.flags,
      acks: msg.acks,
      zerocoded: !!(msg.flags & FLAG.ZEROCODED),
      blocks: {
        RegionData: [{ RegionHandle: rd.RegionHandle, TimeDilation: rd.TimeDilation }],
        ObjectData: objs.map((o) => encodeObjectUpdateEntry(o, { keepRaw: true })),
      },
    }, t);
    const d = firstDiff(original, again);
    ok(
      "escritura: reescritura byte a byte de la captura real" +
        (d < 0 ? "" : " (primer byte distinto en " + d + ": " + original.length + " vs " + again.length + " bytes)"),
      d < 0,
      d,
    );
  }

  // --- B) sin conservar los bytes crudos, los datos sobreviven la vuelta ----
  {
    const msg = decodePacket(bytesDeRecaptura("ObjectUpdateMessageZL"), t);
    const o0 = decodeObjectUpdate(msg)[0];
    const entry = encodeObjectUpdateEntry(o0, { faces: o0.facesCount || 1 });
    const round = encodePacket({
      name: "ObjectUpdate",
      packetId: 1,
      zerocoded: true,
      blocks: { RegionData: [{ RegionHandle: 0, TimeDilation: 65535 }], ObjectData: [entry] },
    }, t);
    eq("escritura: la vuelta se decodifica entera", decodePacket(round, t).trailing, 0);
    const b = decodeObjectUpdate(decodePacket(round, t))[0];
    eq("escritura: id local sobrevive", b.localId, o0.localId);
    eq("escritura: uuid sobrevive", b.uuid, o0.uuid);
    eq("escritura: crc sobrevive", b.crc, o0.crc);
    eq("escritura: pcode sobrevive", b.pcode, o0.pcode);
    eq("escritura: forma sobrevive", b.shape, o0.shape);
    eq("escritura: flags sobrevive", b.flags, o0.flags);
    nearArr("escritura: posicion sobrevive", b.position, o0.position, 1e-4);
    nearArr("escritura: escala sobrevive", b.scale, o0.scale, 1e-6);
    ok("escritura: cuaternion sobrevive", quatEqualish(b.quaternion, o0.quaternion, 1e-4), b.quaternion);
  }

  // --- C) una caja fabricada a mano da la vuelta entera ---------------------
  {
    const o = makeObject();
    o.localId = 7;
    o.uuid = "c458d09b-41c7-4091-9422-09def816fac5";
    o.crc = 0x1234abcd;
    o.pcode = PCODE.PRIMITIVE;
    o.params = new PrimParams("box");
    o.shape = "box";
    o.position = [100.5, 90.25, 22.75];
    o.scale = [2, 1, 3];
    o.quaternion = quatNormalize([0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]);
    o.color = 0xff8800;
    o.name = "Caja de pruebas";
    o.desc = "una descripcion";
    o.text = "hola";
    o.textColor = [255, 0, 0, 255];
    o.linkset = 1;
    o.flags = UPDATE_FLAGS.OBJECT_MODIFY | UPDATE_FLAGS.OBJECT_COPY;
    // Una cara con datos propios (transparencia) para probar que el reparto
    // "valor por defecto / excepciones" del TextureEntry sobrevive.
    o.faces = [{ alpha: 0.5 }];

    const pkt = encodePacket({
      name: "ObjectUpdate",
      packetId: 99,
      zerocoded: true,
      blocks: { RegionData: [{ RegionHandle: 0, TimeDilation: 65535 }], ObjectData: [encodeObjectUpdateEntry(o, { faces: 6 })] },
    }, t);
    const b = decodeObjectUpdate(decodePacket(pkt, t))[0];
    eq("caja: id local", b.localId, 7);
    eq("caja: uuid", b.uuid, o.uuid);
    eq("caja: pcode", b.pcode, PCODE.PRIMITIVE);
    eq("caja: forma", b.shape, "box");
    eq("caja: nombre", b.name, "Caja de pruebas");
    eq("caja: descripcion", b.desc, "una descripcion");
    eq("caja: texto", b.text, "hola");
    eq("caja: color del texto", b.textColor, [255, 0, 0, 255]);
    eq("caja: color", b.color, 0xff8800);
    eq("caja: linkset", b.linkset, 1);
    eq("caja: flags", b.flags, UPDATE_FLAGS.OBJECT_MODIFY | UPDATE_FLAGS.OBJECT_COPY);
    nearArr("caja: posicion", b.position, o.position, 1e-5);
    nearArr("caja: escala", b.scale, o.scale, 1e-6);
    ok("caja: cuaternion", quatEqualish(b.quaternion, o.quaternion, 1e-4), b.quaternion);
    ok("caja: la cara 0 vuelve con su transparencia", b.faces && b.faces.length === 1 && b.faces[0].i === 0 && Math.abs(b.faces[0].alpha - 0.5) < 0.01, b.faces);
  }

  // --- D) el bloque terse tambien vuelve entero -----------------------------
  {
    const o = makeObject();
    o.localId = 4242;
    o.position = [12.5, 200.25, 33.125];
    o.velocity = [0, 0, -2.5];
    o.acceleration = [0, 0, 0];
    o.quaternion = [0, 0, 0.7071068, 0.7071068];
    o.angularVelocity = [0, 0, 0];
    const b = readTerseBlock(encodeTerseBlock(o, false));
    eq("terse escrito: id local", b.localId, 4242);
    nearArr("terse escrito: posicion exacta", b.position, o.position, 1e-6);
    ok("terse escrito: cuaternion", quatEqualish(b.quaternion, o.quaternion, 1e-4), b.quaternion);
    near("terse escrito: velocidad", b.velocity[2], -2.5, 0.01);
    // 44 bytes sin avatar (lo que miden las 12 entradas de la captura real) y
    // 60 con avatar, que anade el plano de colision de 16 bytes.
    eq("terse escrito: 44 bytes sin avatar", encodeTerseBlock(o, false).length, 44);
    eq("terse escrito: 60 bytes con avatar", encodeTerseBlock(o, true).length, 60);
    const av = readTerseBlock(encodeTerseBlock(Object.assign({}, o, { isAvatar: true }), true));
    eq("terse escrito: el avatar se marca", av.isAvatar, true);
    nearArr("terse escrito: posicion del avatar", av.position, o.position, 1e-6);
  }

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
}
