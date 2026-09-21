// SL primitive (prim) geometry generator — faithful port of Lumiya's
// PrimProfile / PrimPath / PrimVolume / PrimVolumeFace (see src/LUMIYA.md).
// Pure JS, no DOM/three dependency, so it runs in workers and tests too.
import { V2, V3, Quat, lerp } from "./math3.js";

export const LL_PCODE_PROFILE_CIRCLE = 0;
export const LL_PCODE_PROFILE_SQUARE = 1;
export const LL_PCODE_PROFILE_ISOTRI = 2;
export const LL_PCODE_PROFILE_EQUALTRI = 3;
export const LL_PCODE_PROFILE_RIGHTTRI = 4;
export const LL_PCODE_PROFILE_CIRCLE_HALF = 5;
export const LL_PCODE_HOLE_SAME = 0;
export const LL_PCODE_HOLE_CIRCLE = 16;
export const LL_PCODE_HOLE_SQUARE = 32;
export const LL_PCODE_HOLE_TRIANGLE = 48;
export const LL_PCODE_PATH_LINE = 16;
export const LL_PCODE_PATH_CIRCLE = 32;
export const LL_PCODE_PATH_CIRCLE2 = 48;
export const LL_PCODE_PATH_TEST = 64;
export const LL_PCODE_PATH_FLEXIBLE = 128;

export const LL_SCULPT_TYPE_NONE = 0;
export const LL_SCULPT_TYPE_SPHERE = 1;
export const LL_SCULPT_TYPE_TORUS = 2;
export const LL_SCULPT_TYPE_PLANE = 3;
export const LL_SCULPT_TYPE_CYLINDER = 4;
export const LL_SCULPT_TYPE_MESH = 5;

export const CUT_QUANTA = 2e-5;
export const SCALE_QUANTA = 0.01;
export const SHEAR_QUANTA = 0.01;
export const TAPER_QUANTA = 0.01;
export const REV_QUANTA = 0.015;

const TABLE_SCALE = [1.0, 1.0, 1.0, 0.5, 0.707107, 0.53, 0.525, 0.5];
const Z_AXIS = new V3(0, 0, 1);
const X_AXIS = new V3(1, 0, 0);

const MIN_DETAIL_FACES = 6;

// ---------------------------------------------------------------------------
// Prim parameters
// ---------------------------------------------------------------------------

// Canonical prim parameters in *raw wire* form (as found in ObjectUpdate /
// PRIM_* script constants / the build floater).
export function defaultPrimParams(o = {}) {
  return Object.assign({
    profileCurve: 1, profileBegin: 0, profileEnd: 0, profileHollow: 0,
    pathCurve: 16, pathBegin: 0, pathEnd: 0,
    pathScaleX: 100, pathScaleY: 100, pathShearX: 0, pathShearY: 0,
    pathTwist: 0, pathTwistBegin: 0, pathTwistEnd: 0,
    pathRadiusOffset: 0, pathTaperX: 0, pathTaperY: 0,
    pathRevolutions: 0, pathSkew: 0,
    sculptType: 0, sculptId: null, sculptTexture: null,
    flexible: null,
  }, o);
}

// U16 cut field is stored as a distance; SL stores profileEnd/pathEnd as
// "distance from 1.0", so End = 1 - raw*quanta.
function cut(v) { return (v >>> 0) * CUT_QUANTA; }
function sByte(v) { return (((v & 0xff) << 24) >> 24) * SCALE_QUANTA; }
function uByte(v) { return (v & 0xff); }

export function toVolumeParams(p) {
  const profile = {
    curveType: p.profileCurve & 0xff,
    begin: cut(p.profileBegin),
    end: 1.0 - cut(p.profileEnd),
    hollow: cut(p.profileHollow),
  };
  const scaleX = (200 - uByte(p.pathScaleX)) * SCALE_QUANTA;
  const scaleY = (200 - uByte(p.pathScaleY)) * SCALE_QUANTA;
  const path = {
    curveType: p.pathCurve & 0xff,
    begin: cut(p.pathBegin),
    end: 1.0 - cut(p.pathEnd),
    scaleX, scaleY,
    shearX: sByte(p.pathShearX),
    shearY: sByte(p.pathShearY),
    twistEnd: sByte(p.pathTwist != null ? p.pathTwist : p.pathTwistEnd),
    twistBegin: sByte(p.pathTwistBegin != null ? p.pathTwistBegin : p.pathTwist),
    radiusOffset: sByte(p.pathRadiusOffset),
    taperX: sByte(p.pathTaperX), taperY: sByte(p.pathTaperY),
    revolutions: uByte(p.pathRevolutions) * REV_QUANTA + 1.0,
    skew: sByte(p.pathSkew),
  };
  path.beginScale = new V2(scaleX > 1.0 ? 2.0 - scaleX : 1.0, scaleY > 1.0 ? 2.0 - scaleY : 1.0);
  path.endScale = new V2(scaleX < 1.0 ? scaleX : 1.0, scaleY < 1.0 ? scaleY : 1.0);
  return {
    profile, path,
    sculptType: p.sculptType & 0xff,
    sculptId: p.sculptId || null,
    flexible: p.flexible || null,
  };
}

// ---------------------------------------------------------------------------
// PrimProfile
// ---------------------------------------------------------------------------

class Face {
  constructor(index, count, scaleU, faceID, flat, cap) {
    this.index = index; this.count = count; this.scaleU = scaleU;
    this.faceID = faceID; this.flat = flat; this.cap = !!cap;
  }
}

export class PrimProfile {
  constructor() {
    this.points = [];
    this.faces = [];
    this.open = false;
    this.concave = false;
    this.total = 2;
    this.totalOut = 0;
  }

  addCap(id) { const f = new Face(0, this.total, 1.0, id, false, true); this.faces.push(f); return f; }
  addFace(index, count, scaleU, id, flat) { const f = new Face(index, count, scaleU, id, flat, false); this.faces.push(f); return f; }

  genNGon(params, n, startAngle, scaleT, scaleS, lodDetail) {
    const begin = params.begin, end = params.end;
    const step = 1.0 / n;
    const angleStep = 2 * Math.PI * step * scaleS;
    const round = Math.round(n / scaleS);
    const radius = round < 8 ? TABLE_SCALE[round] : 0.5;
    const floor = Math.floor(n * begin) / n;
    let angle = 2 * Math.PI * ((floor * scaleS) + startAngle);
    let cur = new V3(Math.cos(angle) * radius, Math.sin(angle) * radius, floor);
    let nextZ = floor + step;
    let nextAngle = angle + angleStep;
    let next = new V3(Math.cos(nextAngle) * radius, Math.sin(nextAngle) * radius, nextZ);
    const frac = (begin - floor) * n;
    if (frac < 0.9999) this.points.push(V3.lerp(cur, next, frac));
    let a = nextAngle, z = nextZ;
    while (z < end) {
      const p = new V3(Math.cos(a) * radius, Math.sin(a) * radius, z);
      if (this.points.length > 0) {
        const last = this.points[this.points.length - 1];
        for (let i = 0; i < lodDetail; i++) this.points.push(V3.lerp(last, p, (1 / (lodDetail + 1)) * (i + 1)));
      }
      this.points.push(p);
      a += angleStep; z += step;
      cur = p;
    }
    const endP = new V3(Math.cos(a) * radius, Math.sin(a) * radius, z);
    const tail = (end - (z - step)) * n;
    if (tail > 1e-4) {
      const lp = V3.lerp(cur, endP, tail);
      if (this.points.length > 0) {
        const last = this.points[this.points.length - 1];
        for (let i = 0; i < lodDetail; i++) this.points.push(V3.lerp(last, lp, (1 / (lodDetail + 1)) * (i + 1)));
      }
      this.points.push(lp);
    }
    if ((end - begin) * scaleS < 0.99) {
      this.open = true;
      this.concave = (end - begin) * scaleS > 0.5;
      if (params.hollow <= 0.0) this.points.push(new V3(0, 0, 0));
    } else {
      this.open = false;
      this.concave = false;
    }
    this.total = this.points.length;
  }

  addHole(params, flat, n, startAngle, hollowScale, scaleS, lodDetail) {
    this.totalOut = this.total;
    this.genNGon(params, Math.floor(n), startAngle, -1.0, scaleS, lodDetail);
    const face = this.addFace(this.totalOut, this.total - this.totalOut, 0.0, 4, flat);
    const tmp = new Array(this.total);
    for (let i = this.totalOut; i < this.total; i++) tmp[i] = new V3(this.points[i].x * hollowScale, this.points[i].y * hollowScale, this.points[i].z);
    let j = this.total - 1;
    for (let i = this.totalOut; i < this.total; i++) { this.points[i] = tmp[j]; j--; }
    for (const f of this.faces) if (f.cap) f.count *= 2;
    return face;
  }

  generate(params, pathOpen, detail, lodDetail, forceSculpt, sculptT) {
    if (detail < 0) detail = 0;
    this.points.length = 0;
    this.faces.length = 0;
    const begin = params.begin, end = params.end, hollow = params.hollow;
    if (begin > end - 0.01) return false;
    const curve = params.curveType & 15;
    const holeType = params.curveType & 0xf0;
    const z = pathOpen;
    let sideCounter = 0;

    switch (curve) {
      case 0: {
        let n = 6.0 * detail;
        if (hollow !== 0 && holeType === LL_PCODE_HOLE_SQUARE) n = Math.ceil(n / 4) * 4;
        n = Math.floor(n);
        if (forceSculpt) n = sculptT;
        this.genNGon(params, n, 0.0, 0.0, 1.0, 0);
        if (z) this.addCap(1);
        if (this.open && hollow === 0) this.addFace(0, this.total - 1, 0, 32, false);
        else this.addFace(0, this.total, 0, 32, false);
        if (hollow !== 0) {
          if (holeType === LL_PCODE_HOLE_SQUARE) this.addHole(params, true, 4.0, 0.0, hollow, 1.0, lodDetail);
          else if (holeType === LL_PCODE_HOLE_TRIANGLE) this.addHole(params, true, 3.0, 0.0, hollow, 1.0, lodDetail);
          else this.addHole(params, false, n, 0.0, hollow, 1.0, 0);
        }
        break;
      }
      case 1: {
        this.genNGon(params, 4, -0.375, 0.0, 1.0, lodDetail);
        if (z) this.addCap(1);
        let idx = Math.floor(4.0 * begin);
        const endIdx = Math.floor((4.0 * end) + 0.999);
        while (idx < endIdx) {
          this.addFace((lodDetail + 1) * sideCounter, lodDetail + 2, 1.0, (32 << idx) & 0xffff, true);
          idx++; sideCounter++;
        }
        for (const p of this.points) p.z *= 4.0;
        if (hollow !== 0) {
          if (holeType === LL_PCODE_HOLE_CIRCLE) this.addHole(params, false, 6.0 * detail, -0.375, hollow, 1.0, 0);
          else if (holeType === LL_PCODE_HOLE_TRIANGLE) this.addHole(params, true, 3.0, -0.375, hollow, 1.0, lodDetail);
          else this.addHole(params, true, 4.0, -0.375, hollow, 1.0, lodDetail);
        }
        if (z && this.faces.length > 0) this.faces[0].count = this.total;
        break;
      }
      case 2: case 3: case 4: {
        this.genNGon(params, 3, 0.0, 0.0, 1.0, lodDetail);
        for (const p of this.points) p.z *= 3.0;
        if (z) this.addCap(1);
        let idx = Math.floor(3.0 * begin);
        const endIdx = Math.floor((3.0 * end) + 0.999);
        while (idx < endIdx) {
          this.addFace(sideCounter * (lodDetail + 1), lodDetail + 2, 1.0, (32 << idx) & 0xffff, true);
          idx++; sideCounter++;
        }
        if (hollow !== 0) {
          const h = hollow / 2.0;
          if (holeType === LL_PCODE_HOLE_CIRCLE) this.addHole(params, false, 6.0 * detail, 0.0, h, 1.0, 0);
          else if (holeType === LL_PCODE_HOLE_SQUARE) this.addHole(params, true, 4.0, 0.0, h, 1.0, lodDetail);
          else this.addHole(params, true, 3.0, 0.0, h, 1.0, lodDetail);
        }
        break;
      }
      case 5: {
        let n = 6.0 * detail * 0.5;
        if (hollow !== 0 && holeType === LL_PCODE_HOLE_SQUARE) n = Math.ceil(n / 2) * 2;
        this.genNGon(params, Math.floor(n), 0.5, 0.0, 0.5, 0);
        if (z) this.addCap(1);
        if (this.open && hollow === 0) this.addFace(0, this.total - 1, 0, 32, false);
        else this.addFace(0, this.total, 0, 32, false);
        if (hollow !== 0) {
          if (holeType === LL_PCODE_HOLE_SQUARE) this.addHole(params, true, 2.0, 0.5, hollow, 0.5, lodDetail);
          else if (holeType === LL_PCODE_HOLE_TRIANGLE) this.addHole(params, true, 3.0, 0.5, hollow, 0.5, lodDetail);
          else this.addHole(params, false, Math.floor(n), 0.5, hollow, 0.5, 0);
        }
        if (end - begin >= 1.0) {
          if (hollow === 0) {
            this.open = false;
            this.points.push(new V3(this.points[0]));
            this.total++;
          }
        } else {
          this.open = true;
        }
        break;
      }
      default:
        return false;
    }

    if (z) this.addCap(2);
    if (this.open) {
      this.addFace(this.total - 1, 2, 0.5, 8, true);
      if (hollow !== 0) this.addFace(this.totalOut - 1, 2, 0.5, 16, true);
      else this.addFace(this.total - 2, 2, 0.5, 16, true);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// PrimPath
// ---------------------------------------------------------------------------

class PathPoint {
  constructor() { this.pos = new V3(); this.scale = new V2(); this.rot = new Quat(); this.texT = 0; }
}

export class PrimPath {
  constructor() { this.points = []; this.open = true; this.total = 0; this.step = 1; }

  genNGon(params, n, startAngle, scaleT, scaleS) {
    const revolutions = params.revolutions;
    const skew = params.skew, absSkew = Math.abs(skew);
    const scX = params.scaleX * (1.0 - absSkew);
    const scY = params.scaleY;
    const t13 = 1.0 - params.taperX, t14 = 1.0 - params.taperY;
    let eX, bX, eY, bY;
    if (t13 > 1.0) { eX = 1.0; bX = 2.0 - t13; } else { eX = t13; bX = 1.0; }
    if (t14 > 1.0) { eY = 1.0; bY = 2.0 - t14; } else { eY = t14; bY = 1.0; }
    const base = (n < 8 ? TABLE_SCALE[n] : 0.5) * (1.0 - scY);
    let rBegin, rEnd;
    const ro = params.radiusOffset;
    if (ro < 0.0) { rBegin = (ro + 1.0) * base; rEnd = base; }
    else { rBegin = base; rEnd = (1.0 - ro) * base; }
    this.open = (params.end * scaleT - params.begin < 1.0) || absSkew > 0.001 ||
      Math.abs(eX - bX) > 0.001 || Math.abs(eY - bY) > 0.001 ||
      Math.abs(rEnd - rBegin) > 0.001;

    const qTwist = new Quat(), qRev = new Quat();
    const twistBegin = params.twistBegin * scaleS;
    const twistEnd = params.twistEnd * scaleS;
    const step = 1.0 / n;
    const begin = params.begin;

    const mk = (t) => {
      const pt = new PathPoint();
      const ang = 2 * Math.PI * revolutions * t;
      const rad = lerp(rBegin, rEnd, t);
      const s = Math.sin(ang) * rad;
      const c = Math.cos(ang) * rad;
      pt.pos.set(lerp(0.0, params.shearX, s) + lerp(-skew, skew, t) * 0.5,
        c + lerp(0.0, params.shearY, s), s);
      pt.scale.x = lerp(bX, eX, t) * scX;
      pt.scale.y = lerp(bY, eY, t) * scY;
      pt.texT = t;
      qTwist.setAxisAngle(lerp(twistBegin, twistEnd, t) * 2.0 * Math.PI - Math.PI, 0, 0, 1);
      qRev.setAxisAngle(ang, X_AXIS);
      pt.rot.setMul(qTwist, qRev);
      return pt;
    };

    this.points.push(mk(begin));
    for (let t = Math.floor((begin + step) * n) / n; t < params.end; t += step) this.points.push(mk(t));
    this.points.push(mk(params.end));
    this.total = this.points.length;
  }

  generate(params, detail, lodDetail, forceSculpt, sculptS) {
    if (detail < 0) detail = 0;
    this.points.length = 0;
    this.open = true;
    switch (params.curveType & 0xf0) {
      case LL_PCODE_PATH_LINE:
      default: {
        let steps = Math.floor(Math.abs(params.twistBegin - params.twistEnd) * 3.5 * (detail - 0.5)) + 2;
        if (steps < lodDetail + 2) steps = lodDetail + 2;
        this.step = 1.0 / (steps - 1);
        for (let i = 0; i < steps; i++) {
          const t = lerp(params.begin, params.end, i * this.step);
          const pt = new PathPoint();
          pt.pos.set(lerp(0, params.shearX, t), lerp(0, params.shearY, t), t - 0.5);
          pt.rot.setAxisAngle(lerp(params.twistBegin * Math.PI, params.twistEnd * Math.PI, t), 0, 0, 1);
          pt.scale.x = lerp(params.beginScale.x, params.endScale.x, t);
          pt.scale.y = lerp(params.beginScale.y, params.endScale.y, t);
          pt.texT = t;
          this.points.push(pt);
        }
        break;
      }
      case LL_PCODE_PATH_CIRCLE: {
        let n = Math.floor((Math.floor(Math.abs(params.twistBegin - params.twistEnd) * 3.5 * (detail - 0.5)) + 6.0 * detail) * params.revolutions);
        if (forceSculpt) n = sculptS;
        this.genNGon(params, n, 0.0, 1.0, 1.0);
        break;
      }
      case LL_PCODE_PATH_CIRCLE2: {
        if (params.end - params.begin >= 0.99 && params.scaleX >= 0.99) this.open = false;
        this.genNGon(params, Math.floor(6.0 * detail), 0.0, 1.0, 1.0);
        let flip = 0.5;
        for (const pt of this.points) { pt.pos.x = flip; flip = flip === 0.5 ? -0.5 : 0.5; }
        break;
      }
      case LL_PCODE_PATH_TEST: {
        this.step = 1.0 / 4;
        for (let i = 0; i < 5; i++) {
          const t = i * this.step;
          const pt = new PathPoint();
          pt.pos.set(0.0,
            lerp(0.0, -Math.sin(params.twistEnd * Math.PI * t) * 0.5, t),
            lerp(-0.5, Math.cos(params.twistEnd * Math.PI * t) * 0.5, t));
          pt.scale.x = lerp(1.0, params.scaleX, t);
          pt.scale.y = lerp(1.0, params.scaleY, t);
          pt.texT = t;
          pt.rot.setAxisAngle(t * params.twistEnd * Math.PI, 1, 0, 0);
          this.points.push(pt);
        }
        break;
      }
    }
    if (params.twistEnd !== params.twistBegin) this.open = true;
    return true;
  }
}

// ---------------------------------------------------------------------------
// PrimVolume  (extrudes profile along path, then splits into renderable faces)
// ---------------------------------------------------------------------------

const BOTTOM_MASK = 1024, CAP_MASK = 2, END_MASK = 4, FLAT_MASK = 256,
  HOLLOW_MASK = 64, INNER_MASK = 16, OPEN_MASK = 128, OUTER_MASK = 32,
  SIDE_MASK = 8, SINGLE_MASK = 1, TOP_MASK = 512;

// ---------------------------------------------------------------------------
// Sculpt maps
// ---------------------------------------------------------------------------

// llvolume.h: the sculpt type is the low 3 bits, bit 6 inverts and bit 7 mirrors.
export const SCULPT_TYPE_MASK = 0x07;
export const SCULPT_FLAG_INVERT = 0x40;
export const SCULPT_FLAG_MIRROR = 0x80;

const SCULPT_MIN_AREA = 0.002;
const SCULPT_MAX_AREA = 384;
const SCULPT_MIN_AREA_DETAIL = 1;

function sculptSides(detail) {
  if (detail <= 1) return 6;
  if (detail <= 2) return 8;
  if (detail <= 3) return 16;
  return 32;
}

/**
 * How many vertices the path (rows) and the profile (columns) get for a sculpt
 * map of this size — `sculpt_calc_mesh_resolution` in llvolume.cpp: as square as
 * the map while still using every vertex, never more than the LOD allows and
 * never more than the map can carry.
 */
export function sculptMeshResolution(width, height, detail = 4) {
  const maxLod = sculptSides(detail) ** 2;
  const maxMap = Math.trunc((width * height) / 4);
  const vertices = maxMap > 0 ? Math.min(maxLod, maxMap) : maxLod;
  const ratio = (width === 0 || height === 0) ? 1 : width / height;
  let s = Math.trunc(Math.sqrt(vertices / ratio));
  if (s < 4) s = 4;
  let t = Math.trunc(vertices / s);
  if (t < 4) t = 4;
  s = Math.trunc(vertices / t);
  return { s, t };
}

/**
 * Fills the volume's vertex grid straight from the sculpt map: the map's R,G,B
 * are the vertex's X,Y,Z (each 0..255 mapped to -0.5..0.5) — `sculptGenerateMapVertices`
 * in llvolume.cpp. The stitching rules are what make one 2D image describe a
 * sphere (both seams pinch to the middle row/column), a torus (both seams wrap),
 * a cylinder (only the side seam wraps) or a plane (nothing wraps).
 */
function fillSculptMesh(mesh, nPath, nProf, sculptType, map) {
  const stitching = sculptType & SCULPT_TYPE_MASK;
  const invert = (sculptType & SCULPT_FLAG_INVERT) !== 0;
  const mirror = (sculptType & SCULPT_FLAG_MIRROR) !== 0;
  const reverseHorizontal = invert ? !mirror : mirror;
  const w = map.width, h = map.height, comps = map.components;
  const data = map.data;
  const rowDiv = nPath > 1 ? nPath - 1 : 1;
  const colDiv = nProf > 1 ? nProf - 1 : 1;
  for (let s = 0; s < nPath; s++) {
    for (let t = 0; t < nProf; t++) {
      const revT = reverseHorizontal ? nProf - t - 1 : t;
      let x = Math.trunc((revT / colDiv) * w);
      let y = Math.trunc((s / rowDiv) * h);
      if (y === 0) {                                   // top row stitching
        if (stitching === LL_SCULPT_TYPE_SPHERE) x = w >> 1;
      }
      if (y === h) {                                   // bottom row stitching
        y = (stitching === LL_SCULPT_TYPE_TORUS) ? 0 : h - 1;
        if (stitching === LL_SCULPT_TYPE_SPHERE) x = w >> 1;
      }
      if (x === w) {                                   // side stitching
        x = (stitching === LL_SCULPT_TYPE_SPHERE || stitching === LL_SCULPT_TYPE_TORUS ||
          stitching === LL_SCULPT_TYPE_CYLINDER) ? 0 : w - 1;
      }
      if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
      if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
      const i = (y * w + x) * comps;
      const px = data[i] / 255 - 0.5, py = data[i + 1] / 255 - 0.5, pz = data[i + 2] / 255 - 0.5;
      mesh[s * nProf + t] = new V3(mirror ? -px : px, py, pz);
    }
  }
}

/** Total mesh area, used to reject maps that carry no usable shape. */
function sculptSurfaceArea(mesh, nPath, nProf) {
  const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
  const crossLen = (a, b) => Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  let area = 0;
  for (let s = 0; s < nPath - 1; s++) {
    for (let t = 0; t < nProf - 1; t++) {
      const p1 = mesh[s * nProf + t], p2 = mesh[(s + 1) * nProf + t];
      const p3 = mesh[s * nProf + t + 1], p4 = mesh[(s + 1) * nProf + t + 1];
      if (!p1 || !p2 || !p3 || !p4) continue;
      area += (crossLen(sub(p1, p2), sub(p1, p3)) + crossLen(sub(p4, p2), sub(p4, p3))) / 2;
    }
  }
  return area;
}

export function buildVolume(vp, detail = 4, sculpt = null) {
  const profile = new PrimProfile();
  const path = new PrimPath();
  let lodFaces = Math.floor(detail * 0.66);
  const pc = vp.profile.curveType & 15, tc = vp.path.curveType & 0xf0;
  if (tc === LL_PCODE_PATH_LINE && (vp.path.scaleX !== 1.0 || vp.path.scaleY !== 1.0) &&
    (pc === 1 || pc === 2 || pc === 3 || pc === 4)) lodFaces = 0;

  // A sculpt does not extrude the profile along the path at all: the path and
  // the profile are generated only to decide the *topology* (how many rows and
  // columns, which faces exist, where the UVs run) and every vertex is then read
  // straight out of the sculpt map (llvolume.cpp `LLVolume::sculpt`). Asking for
  // the sculpt resolution is what makes the grid dense enough to carry the shape.
  const isSculpt = !!sculpt && (vp.sculptType & 7) !== 0 &&
    sculpt.width > 0 && sculpt.height > 0 && sculpt.components >= 3 && !!sculpt.data;
  let requestedS = 0, requestedT = 0;
  if (isSculpt) {
    const res = sculptMeshResolution(sculpt.width, sculpt.height, detail);
    requestedS = res.s;
    requestedT = res.t;
  }

  const flexiSections = vp.flexible ? Math.max(0, (vp.flexible.numFlexiSections | 0) - 2) : lodFaces;
  path.generate(vp.path, detail, isSculpt ? 0 : flexiSections, isSculpt, requestedS);
  profile.generate(vp.profile, path.open, detail, isSculpt ? 0 : lodFaces, isSculpt, requestedT);

  const key = (x) => Math.round(x * 1e6) / 1e6;
  void key;
  const nPath = path.points.length, nProf = profile.points.length;
  if (!nPath || !nProf) return null;
  const mesh = new Array(nPath * nProf);
  if (isSculpt) {
    fillSculptMesh(mesh, nPath, nProf, vp.sculptType & 0xff, sculpt);
  } else {
    const tmp = new V3(), rotv = new V3();
    for (let t = 0; t < nPath; t++) {
      const pp = path.points[t];
      for (let s = 0; s < nProf; s++) {
        tmp.set(pp.scale.x * profile.points[s].x, profile.points[s].y * pp.scale.y, 0);
        const v = pp.rot.rotate(tmp, rotv);
        mesh[t * nProf + s] = new V3(v.x, v.y, v.z).add(pp.pos);
      }
    }
  }
  let faceMask = 0;
  for (const f of profile.faces) faceMask |= f.faceID;

  // A sculpt map with no usable relief (a flat or blank image) describes no
  // object at all: the official viewer rejects those instead of drawing a
  // collapsed blob, and so do we (the prim is simply not drawn).
  if (isSculpt && detail > SCULPT_MIN_AREA_DETAIL) {
    const area = sculptSurfaceArea(mesh, nPath, nProf);
    if (area < SCULPT_MIN_AREA || area > SCULPT_MAX_AREA) return null;
  }

  const out = [];
  for (let i = 0; i < profile.faces.length; i++) {
    const f = profile.faces[i];
    let typeMask = 0;
    if (vp.profile.hollow > 0.0) typeMask |= HOLLOW_MASK;
    if (profile.open) typeMask |= OPEN_MASK;
    let numS = f.count;
    if (f.cap) {
      typeMask |= CAP_MASK;
      typeMask |= (f.faceID === 1) ? TOP_MASK : BOTTOM_MASK;
    } else if ((f.faceID & 24) !== 0) {
      typeMask |= 260;
    } else {
      typeMask |= SIDE_MASK;
      if (f.flat) typeMask |= FLAT_MASK;
      if ((f.faceID & 4) !== 0) {
        typeMask |= INNER_MASK;
        if (f.flat && numS > 2) numS *= 2;
      } else typeMask |= OUTER_MASK;
    }
    const face = {
      id: i, faceID: f.faceID, typeMask, beginS: f.index, numS, beginT: 0,
      numT: nPath, positions: null, indices: null, uvs: null,
    };
    if (typeMask & CAP_MASK) createCap(face, mesh, profile, vp, nPath);
    else createSide(face, mesh, profile, path, vp, nProf);
    out.push(face);
  }
  return { faces: out, faceMask, profile, path, mesh };
}

function resize(n) { return { positions: new Float32Array(n * 3), uvs: new Float32Array(n * 2), n }; }

function createCap(face, mesh, profile, vp, nPath) {
  const pts = profile.points;
  const size = pts.length;
  const hollow = vp.profile.hollow > 0;
  const open = profile.open;
  const top = (face.typeMask & TOP_MASK) !== 0;
  const useCenter = !hollow && !open;
  const nv = useCenter ? size + 1 : size;
  const buf = resize(nv);
  const size3 = top ? profile.total * (nPath - 1) : face.beginS;
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  let minu = Infinity, minv = Infinity, maxu = -Infinity, maxv = -Infinity;
  for (let i = 0; i < size; i++) {
    const u = 0.5 + pts[i].x, v = top ? pts[i].y + 0.5 : 0.5 - pts[i].y;
    buf.uvs[i * 2] = u; buf.uvs[i * 2 + 1] = v;
    const p = mesh[i + size3];
    buf.positions[i * 3] = p.x; buf.positions[i * 3 + 1] = p.y; buf.positions[i * 3 + 2] = p.z;
    minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
    minz = Math.min(minz, p.z); maxz = Math.max(maxz, p.z);
    minu = Math.min(minu, u); maxu = Math.max(maxu, u);
    minv = Math.min(minv, v); maxv = Math.max(maxv, v);
  }
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
  const cu = (minu + maxu) / 2, cv = (minv + maxv) / 2;
  const v0 = new V3(cx - buf.positions[0], cy - buf.positions[1], cz - buf.positions[2]);
  const v1 = new V3(cx - buf.positions[3], cy - buf.positions[4], cz - buf.positions[5]);
  const nrm = top ? V3.cross(v0, v1) : V3.cross(v1, v0);
  nrm.normVec();
  let n = size;
  if (useCenter) {
    buf.positions[size * 3] = cx; buf.positions[size * 3 + 1] = cy; buf.positions[size * 3 + 2] = cz;
    buf.uvs[size * 2] = cu; buf.uvs[size * 2 + 1] = cv;
    n = size + 1;
  }
  const indices = [];
  const push = (a, b, c) => { indices.push(a, b, c); };
  if (!hollow) {
    for (let i = 0; i < n - 2; i++) {
      if (top) push(n - 1, i, i + 1);
      else push(n - 1, i + 1, i);
    }
  } else {
    let a = 0, b = n - 1;
    while (b - a > 1) {
      const p0 = pts[a], p1 = pts[b], p2 = pts[a + 1], p3 = pts[b - 1];
      const c2 = (p, q, r) => (p.x * q.y - q.x * p.y) + (q.x * r.y - r.x * q.y) + (r.x * p.y - p.x * r.y);
      const f1 = c2(p0, p2, p1), f2v = c2(p0, p3, p1), f3 = c2(p1, p0, p3), f4 = c2(p1, p2, p3);
      const cond1 = f1 >= 0 && f4 >= 0;
      const cond2 = f3 >= 0 && f2v >= 0;
      let useA;
      if (!cond1) useA = false;
      else if (cond2) useA = dist2(p0, p2) < dist2(p1, p3);
      else useA = true;
      if (useA) { if (top) push(a, a + 1, b); else push(a, b, a + 1); a++; }
      else { push(a, b - 1, b); b--; }
    }
  }
  face.positions = buf.positions;
  face.uvs = buf.uvs;
  face.indices = indices;
  face.normal = [nrm.x, nrm.y, nrm.z];
}
function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; }

function createSide(face, mesh, profile, path, vp, nProf) {
  const flat = (face.typeMask & FLAT_MASK) !== 0;
  const st = vp.sculptType & 0xff;
  const b2 = st & 7;
  const z2 = (st & 64) !== 0, z3 = (st & 128) !== 0;
  const flipUV = z2 ? !z3 : z3;
  const pts = profile.points, pth = path.points;
  const totalPts = profile.total;
  const numS = face.numS, numT = face.numT;
  const floorS = Math.floor(pts[face.beginS].z);
  const distinct = ((face.typeMask & INNER_MASK) === 0 || (face.typeMask & FLAT_MASK) === 0 || numS <= 2) ? numS : numS / 2;
  const positions = [], uvs = [], indices = [];
  for (let t = face.beginT; t < face.beginT + numT; t++) {
    const texT = pth[t].texT;
    for (let s = 0; s < distinct; s++) {
      let sv;
      if ((face.typeMask & END_MASK) !== 0 || face.beginS + s >= pts.length) sv = s !== 0 ? 1.0 : 0.0;
      else if (!flat) sv = pts[face.beginS + s].z;
      else sv = pts[face.beginS + s].z - floorS;
      if (flipUV) sv = 1.0 - sv;
      const idx = (face.beginS + s >= totalPts) ? face.beginS + s + (t - 1) * totalPts : face.beginS + s + totalPts * t;
      pushVert(positions, uvs, mesh[idx], sv, texT);
      if ((face.typeMask & INNER_MASK) !== 0 && (face.typeMask & FLAT_MASK) !== 0 && numS > 2 && s > 0) {
        pushVert(positions, uvs, mesh[idx], sv, texT);
      }
    }
    if ((face.typeMask & INNER_MASK) !== 0 && (face.typeMask & FLAT_MASK) !== 0 && numS > 2) {
      const i16 = (face.typeMask & OPEN_MASK) !== 0 ? distinct - 1 : 0;
      const idx = face.beginS + i16 + totalPts * t;
      let sv = (face.beginS + i16 < pts.length) ? pts[i16 + face.beginS].z - floorS : (i16 !== 0 ? 1.0 : 0.0);
      pushVert(positions, uvs, mesh[idx], sv, texT);
    }
  }
  const nv = positions.length / 3;
  for (let t = 0; t < numT - 1; t++) {
    for (let s = 0; s < numS - 1; s++) {
      const a = numS * t + s, b = s + 1 + numS * (t + 1), c = numS * (t + 1) + s, d = s + 1 + numS * t;
      indices.push(a, b, c, a, d, b);
    }
  }
  face.positions = new Float32Array(positions);
  face.uvs = new Float32Array(uvs);
  face.indices = indices;
}
function pushVert(pos, uv, v, s, t) { pos.push(v.x, v.y, v.z); uv.push(s, t); }

// ---------------------------------------------------------------------------
// Geometry helper: compute normals (welded for smooth faces, per-triangle flat)
// ---------------------------------------------------------------------------

export function faceNormals(face) {
  const pos = face.positions, idx = face.indices;
  const n = pos.length / 3;
  const flat = (face.typeMask & FLAT_MASK) !== 0 || (face.typeMask & CAP_MASK) !== 0;
  const normals = new Float32Array(pos.length);
  if (!flat) {
    // weld by rounded position so UV-seam duplicates share a normal
    const map = new Map();
    const weld = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const k = `${pos[i * 3].toFixed(4)}|${pos[i * 3 + 1].toFixed(4)}|${pos[i * 3 + 2].toFixed(4)}`;
      let g = map.get(k);
      if (g === undefined) { g = map.size; map.set(k, g); }
      weld[i] = g;
    }
    const acc = new Map();
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
      const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const vi of [a, b, c]) {
        const g = weld[vi];
        let e = acc.get(g);
        if (!e) { e = [0, 0, 0]; acc.set(g, e); }
        e[0] += nx; e[1] += ny; e[2] += nz;
      }
    }
    for (let i = 0; i < n; i++) {
      const e = acc.get(weld[i]);
      let x = e[0], y = e[1], z = e[2];
      const m = Math.hypot(x, y, z) || 1;
      normals[i * 3] = x / m; normals[i * 3 + 1] = y / m; normals[i * 3 + 2] = z / m;
    }
  } else {
    const tri = [];
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
      const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const m = Math.hypot(nx, ny, nz) || 1; nx /= m; ny /= m; nz /= m;
      tri.push([a, b, c, nx, ny, nz]);
    }
    // rebuild non-indexed for flat shading
    const np = [], nu = [], nn = [], ni = [];
    for (const [a, b, c, nx, ny, nz] of tri) {
      for (const vi of [a, b, c]) {
        np.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        nu.push(face.uvs[vi * 2], face.uvs[vi * 2 + 1]);
        nn.push(nx, ny, nz);
        ni.push(ni.length);
      }
    }
    face.positions = new Float32Array(np);
    face.uvs = new Float32Array(nu);
    face.indices = ni;
    return new Float32Array(nn);
  }
  return normals;
}

// Full pipeline: raw prim params -> renderable face list. `sculpt` is the
// decoded sculpt map ({width, height, components, data}) when the prim has one.
export function primToFaces(params, detail = 4, sculpt = null) {
  const vp = toVolumeParams(defaultPrimParams(params));
  const vol = buildVolume(vp, detail, sculpt);
  if (!vol) return null;
  for (const f of vol.faces) {
    if (f.normal) {
      const n = f.positions.length / 3, nn = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { nn[i * 3] = f.normal[0]; nn[i * 3 + 1] = f.normal[1]; nn[i * 3 + 2] = f.normal[2]; }
      f.normals = nn;
    } else {
      f.normals = faceNormals(f);
    }
  }
  return vol;
}

export function volumeStats(vol) {
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  let verts = 0, tris = 0;
  for (const f of vol.faces) {
    verts += f.positions.length / 3;
    tris += f.indices.length / 3;
    for (let i = 0; i < f.positions.length; i += 3) {
      minx = Math.min(minx, f.positions[i]); maxx = Math.max(maxx, f.positions[i]);
      miny = Math.min(miny, f.positions[i + 1]); maxy = Math.max(maxy, f.positions[i + 1]);
      minz = Math.min(minz, f.positions[i + 2]); maxz = Math.max(maxz, f.positions[i + 2]);
    }
  }
  return { verts, tris, faces: vol.faces.length, min: [minx, miny, minz], max: [maxx, maxy, maxz] };
}
