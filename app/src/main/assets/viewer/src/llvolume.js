// llvolume.js
// ---------------------------------------------------------------------------
// Faithful JavaScript port of Linden Lab's LLVolume primitive tessellator
// (Second Life viewer: indra/llmath/llvolume.cpp, LGPL 2.1). This is the code
// that turns Second Life "prim" parameters into a mesh. Porting it (rather than
// faking shapes with three.js primitives) is what makes our prims behave and
// look exactly like SL prims: identical profile/path parametrisation, identical
// path-cut / profile-cut / hollow / twist / taper / shear / skew / revolution /
// hole-size semantics, identical face numbering and UV layout.
//
// Terminology (matches SL's build floater "Object" tab):
//   "Path Cut B/E"    -> path.begin / path.end
//   "Profile Cut B/E" -> profile.begin / profile.end       (a.k.a. dimple)
//   "Hollow"          -> profile.hollow  (+ hollow shape: circle/square/triangle)
//   "Twist B/E"       -> path.twistBegin / path.twistEnd   (degrees)
//   "Taper X/Y"       -> box/cylinder/prism: path.scaleX/Y = 1-taper
//                        torus/tube/ring:    path.taperX/Y
//   "Holes Size X/Y"  -> torus/tube/ring/sphere: path.scaleX/Y
//   "Slope"           -> path.radiusOffset      "Shear X/Y" -> path.shearX/Y
//   "Skew"            -> path.skew (torus)      "Revolution" -> path.revolutions
//   "Hollow shape"    -> high nibble of profile.curveType (HOLE_*)
//
// Paths and profiles are "p-codes" like in LL: the low nibble of the profile
// curve type is the profile shape, the high nibble is the hollow's shape.
// ---------------------------------------------------------------------------

export const PATH_LINE = 0x10;
export const PATH_CIRCLE = 0x20;
export const PATH_CIRCLE2 = 0x30;

export const PROFILE_CIRCLE = 0x00;
export const PROFILE_SQUARE = 0x01;
export const PROFILE_ISOTRI = 0x02;
export const PROFILE_EQUALTRI = 0x03;
export const PROFILE_RIGHTTRI = 0x04;
export const PROFILE_CIRCLE_HALF = 0x05;

export const HOLE_SAME = 0x00;
export const HOLE_CIRCLE = 0x10;
export const HOLE_SQUARE = 0x20;
export const HOLE_TRIANGLE = 0x30;

export const FACE_PATH_BEGIN = 1 << 0;
export const FACE_PATH_END = 1 << 1;
export const FACE_INNER_SIDE = 1 << 2;
export const FACE_PROFILE_BEGIN = 1 << 3;
export const FACE_PROFILE_END = 1 << 4;
export const FACE_OUTER_SIDE_0 = 1 << 5;

const MIN_DETAIL_FACES = 6;
export const LOD_DETAIL = [1, 1.5, 2.5, 4];
const TABLE_SCALE = [1, 1, 1, 0.5, 0.707107, 0.53, 0.525, 0.5];
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// parameter objects
// ---------------------------------------------------------------------------

export class ProfileParams {
  constructor(curveType = PROFILE_SQUARE, begin = 0, end = 1, hollow = 0) {
    this.curveType = curveType;
    this.begin = begin;
    this.end = end;
    this.hollow = hollow;
  }
  get baseCurve() { return this.curveType & 0x0f; }
  get holeType() { return this.hollow > 0 ? (this.curveType & 0xf0) : 0; }
  copy() { return new ProfileParams(this.curveType, this.begin, this.end, this.hollow); }
}

export class PathParams {
  constructor(curveType = PATH_LINE) {
    this.curveType = curveType;
    this.begin = 0;
    this.end = 1;
    this.scaleX = 1;        // "ratio" x  (holes size / taper, see header)
    this.scaleY = 1;        // "ratio" y
    this.shearX = 0;
    this.shearY = 0;
    this.twistBegin = 0;    // in revolutions: 1 == 360deg on circle paths
    this.twistEnd = 0;
    this.radiusOffset = 0;
    this.taperX = 0;
    this.taperY = 0;
    this.revolutions = 1;
    this.skew = 0;
  }
  copy() { return Object.assign(new PathParams(this.curveType), this); }
}

export class VolumeParams {
  constructor(profile = new ProfileParams(), path = new PathParams()) {
    this.profile = profile;
    this.path = path;
  }
  copy() { return new VolumeParams(this.profile.copy(), this.path.copy()); }
  key(lod = 3) {
    const p = this.profile, a = this.path;
    const r = (v) => Math.round((v || 0) * 20000) / 20000;
    return [lod, p.curveType, r(p.begin), r(p.end), r(p.hollow), a.curveType,
      r(a.begin), r(a.end), r(a.scaleX), r(a.scaleY), r(a.shearX), r(a.shearY),
      r(a.twistBegin), r(a.twistEnd), r(a.radiusOffset), r(a.taperX), r(a.taperY),
      r(a.revolutions), r(a.skew)].join(',');
  }
}

// ---------------------------------------------------------------------------
// math helpers
// ---------------------------------------------------------------------------

function angAxisQuat(angle, x, y, z) {
  const half = angle * 0.5;
  const s = Math.sin(half);
  const len = Math.hypot(x, y, z) || 1;
  return [x / len * s, y / len * s, z / len * s, Math.cos(half)];
}

function quatMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatRotate(q, v) {
  const [qx, qy, qz, qw] = q, [vx, vy, vz] = v;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// LLProfile
// ---------------------------------------------------------------------------

function ptLerp(p1, p2, f) {
  return { x: lerp(p1.x, p2.x, f), y: lerp(p1.y, p2.y, f), t: lerp(p1.t, p2.t, f) };
}

// LLProfile::genNGon -- appends an n-gon contour to `out`.
// Returns true if the contour was left open (a cut slice).
function genNGon(params, sides, offset, angScale, split, out) {
  const begin = params.begin;
  const end = params.end;
  const tStep = 1 / sides;
  const angStep = 2 * Math.PI * tStep * angScale;

  let scale = 0.5;
  const totalSides = Math.round(sides / angScale);
  if (totalSides < 8 && totalSides >= 0) scale = TABLE_SCALE[Math.min(totalSides, 7)];

  const tFirst = Math.floor(begin * sides) / sides;

  let t = tFirst;
  let ang = 2 * Math.PI * (t * angScale + offset);
  let pt1 = { x: Math.cos(ang) * scale, y: Math.sin(ang) * scale, t };

  t += tStep;
  ang += angStep;
  let pt2 = { x: Math.cos(ang) * scale, y: Math.sin(ang) * scale, t };

  const tFraction = (begin - tFirst) * sides;
  if (tFraction < 0.9999) out.push(ptLerp(pt1, pt2, tFraction));

  while (t < end) {
    pt1 = { x: Math.cos(ang) * scale, y: Math.sin(ang) * scale, t };
    if (out.length > 0) {
      const p = out[out.length - 1];
      for (let i = 0; i < split; i++) out.push(ptLerp(p, pt1, (1 / (split + 1)) * (i + 1)));
    }
    out.push(pt1);
    t += tStep;
    ang += angStep;
  }

  pt2 = { x: Math.cos(ang) * scale, y: Math.sin(ang) * scale, t };
  const endFraction = (end - (t - tStep)) * sides;
  if (endFraction > 0.0001) {
    const newPt = ptLerp(pt1, pt2, endFraction);
    if (out.length > 0) {
      const p = out[out.length - 1];
      for (let i = 0; i < split; i++) out.push(ptLerp(p, newPt, (1 / (split + 1)) * (i + 1)));
    }
    out.push(newPt);
  }

  let open = false;
  if ((end - begin) * angScale < 0.99) {
    open = true;
    if (params.hollow <= 0) out.push({ x: 0, y: 0, t: 0 });
  }
  return open;
}

// LLProfile::generate -- returns { points, faces, open, totalOut }
function generateProfile(params, pathOpen, detail, split) {
  const points = [];
  const faces = [];
  const begin = params.begin;
  const end = params.end;
  const hollow = params.hollow;
  const curve = params.baseCurve;
  const holeType = params.holeType;

  let open = false;
  let totalOut = 0;

  const addFace = (index, count, scaleU, faceID, flat) =>
    faces.push({ index, count, scaleU, faceID, flat, cap: false });
  const addCap = (faceID) =>
    faces.push({ index: 0, count: points.length, scaleU: 1, faceID, flat: false, cap: true });

  // LLProfile::addHole -- adds the inner (hollow) contour, reversed, scaled.
  const addHole = (flat, sides, offset, boxHollow, angScale, holeSplit = 0) => {
    totalOut = points.length;
    genNGon(params, sides, offset, angScale, holeSplit, points);
    addFace(totalOut, points.length - totalOut, 0, FACE_INNER_SIDE, flat);
    const inner = points.slice(totalOut).map((p) => ({
      x: p.x * boxHollow, y: p.y * boxHollow, t: p.t * boxHollow,
    }));
    inner.reverse();
    points.length = totalOut;
    for (const p of inner) points.push(p);
    for (const f of faces) if (f.cap) f.count *= 2;
  };

  switch (curve) {
    case PROFILE_SQUARE: {
      // LL's genNGon sets the profile's mOpen as a side effect (and addHole's
      // genNGon call leaves it at the same value, since begin/end are shared).
      // Dropping this return value left a cut square profile marked closed, so
      // its FACE_PROFILE_BEGIN/END wedges were never emitted: the cut stayed
      // open (the diagonal wall of a half box was missing, and the shape lost
      // the wedge's volume -- 0.44444 instead of 0.5).
      open = genNGon(params, 4, -0.375, 1, split, points);
      if (pathOpen) addCap(FACE_PATH_BEGIN);
      let faceNum = 0;
      for (let i = Math.floor(begin * 4); i < Math.floor(end * 4 + 0.999); i++) {
        addFace(faceNum++ * (split + 1), split + 2, 1, FACE_OUTER_SIDE_0 << i, true);
      }
      for (const p of points) p.t *= 4;
      if (hollow) {
        switch (holeType) {
          case HOLE_TRIANGLE: addHole(true, 3, -0.375, hollow, 1, split); break;
          case HOLE_CIRCLE: addHole(false, Math.floor(MIN_DETAIL_FACES * detail), -0.375, hollow, 1); break;
          default: addHole(true, 4, -0.375, hollow, 1, split); break;
        }
      }
      if (pathOpen && faces.length) faces[0].count = points.length;
      break;
    }
    case PROFILE_ISOTRI:
    case PROFILE_RIGHTTRI:
    case PROFILE_EQUALTRI: {
      open = genNGon(params, 3, 0, 1, split, points);
      for (const p of points) p.t *= 3;
      if (pathOpen) addCap(FACE_PATH_BEGIN);
      let faceNum = 0;
      for (let i = Math.floor(begin * 3); i < Math.floor(end * 3 + 0.999); i++) {
        addFace(faceNum++ * (split + 1), split + 2, 1, FACE_OUTER_SIDE_0 << i, true);
      }
      if (hollow) {
        const triHollow = hollow / 2;
        switch (holeType) {
          case HOLE_CIRCLE: addHole(false, Math.floor(MIN_DETAIL_FACES * detail), 0, triHollow, 1); break;
          case HOLE_SQUARE: addHole(true, 4, 0, triHollow, 1, split); break;
          default: addHole(true, 3, 0, triHollow, 1, split); break;
        }
      }
      break;
    }
    case PROFILE_CIRCLE: {
      let circleDetail = MIN_DETAIL_FACES * detail;
      if (hollow && holeType === HOLE_SQUARE) circleDetail = Math.ceil(circleDetail / 4) * 4;
      open = genNGon(params, Math.floor(circleDetail), 0, 1, 0, points);
      if (pathOpen) addCap(FACE_PATH_BEGIN);
      if (open && !hollow) addFace(0, points.length - 1, 0, FACE_OUTER_SIDE_0, false);
      else addFace(0, points.length, 0, FACE_OUTER_SIDE_0, false);
      if (hollow) {
        switch (holeType) {
          case HOLE_SQUARE: addHole(true, 4, 0, hollow, 1, split); break;
          case HOLE_TRIANGLE: addHole(true, 3, 0, hollow, 1, split); break;
          default: addHole(false, Math.floor(circleDetail), 0, hollow, 1); break;
        }
      }
      break;
    }
    case PROFILE_CIRCLE_HALF: {
      let circleDetail = MIN_DETAIL_FACES * detail * 0.5;
      if (hollow && holeType === HOLE_SQUARE) circleDetail = Math.ceil(circleDetail / 2) * 2;
      open = genNGon(params, Math.floor(circleDetail), 0.5, 0.5, 0, points);
      if (pathOpen) addCap(FACE_PATH_BEGIN);
      if (open && !hollow) addFace(0, points.length - 1, 0, FACE_OUTER_SIDE_0, false);
      else addFace(0, points.length, 0, FACE_OUTER_SIDE_0, false);
      if (hollow) {
        switch (holeType) {
          case HOLE_SQUARE: addHole(true, 2, 0.5, hollow, 0.5, split); break;
          case HOLE_TRIANGLE: addHole(true, 3, 0.5, hollow, 0.5, split); break;
          default: addHole(false, Math.floor(circleDetail), 0.5, hollow, 0.5); break;
        }
      }
      if ((end - begin) < 1) open = true;
      else if (!hollow) { open = false; points.push({ ...points[0] }); }
      break;
    }
  }

  if (pathOpen) addCap(FACE_PATH_END);

  if (open) {
    const n = points.length;
    addFace(n - 1, 2, 0.5, FACE_PROFILE_BEGIN, true);
    if (hollow) addFace(totalOut - 1, 2, 0.5, FACE_PROFILE_END, true);
    else addFace(n - 2, 2, 0.5, FACE_PROFILE_END, true);
  }

  return { points, faces, open, totalOut, hollow };
}

// ---------------------------------------------------------------------------
// LLPath
// ---------------------------------------------------------------------------

function genNGonPath(params, sides, out) {
  const revolutions = params.revolutions;
  const skew = params.skew;
  const skewMag = Math.abs(skew);
  const holeX = params.scaleX * (1 - skewMag);
  const holeY = params.scaleY;

  let taperXBegin = 1, taperXEnd = 1 - params.taperX;
  let taperYBegin = 1, taperYEnd = 1 - params.taperY;
  if (taperXEnd > 1) { taperXBegin = 2 - taperXEnd; taperXEnd = 1; }
  if (taperYEnd > 1) { taperYBegin = 2 - taperYEnd; taperYEnd = 1; }

  let radiusStart = sides < 8 ? TABLE_SCALE[Math.min(sides, 7)] : 0.5;
  radiusStart *= 1 - holeY;
  let radiusEnd = radiusStart;
  const radiusOffset = params.radiusOffset;
  if (radiusOffset < 0) radiusStart *= 1 + radiusOffset;
  else radiusEnd *= 1 - radiusOffset;

  const open = (params.end - params.begin < 1) || skewMag > 0.001 ||
    Math.abs(taperXEnd - taperXBegin) > 0.001 ||
    Math.abs(taperYEnd - taperYBegin) > 0.001 ||
    Math.abs(radiusEnd - radiusStart) > 0.001;

  const pushPt = (t) => {
    const ang = 2 * Math.PI * revolutions * t;
    const rr = lerp(radiusStart, radiusEnd, t);
    const c = Math.cos(ang) * rr;
    const s = Math.sin(ang) * rr;
    const twist = angAxisQuat(lerp(params.twistBegin, params.twistEnd, t) * 2 * Math.PI - Math.PI, 0, 0, 1);
    const qang = angAxisQuat(ang, 1, 0, 0);
    out.push({
      px: lerp(0, params.shearX, s) + lerp(-skew, skew, t) * 0.5,
      py: c + lerp(0, params.shearY, s),
      pz: s,
      q: quatMul(qang, twist),
      sx: holeX * lerp(taperXBegin, taperXEnd, t),
      sy: holeY * lerp(taperYBegin, taperYEnd, t),
      texT: t,
    });
  };

  const step = 1 / sides;
  let t = params.begin;
  pushPt(t);
  t += step;
  t = Math.floor(t * sides) / sides;
  while (t < params.end) { pushPt(t); t += step; }
  pushPt(params.end);
  return open;
}

function generatePath(params, detail, split) {
  const out = [];
  let open = true;
  const curve = params.curveType & 0xf0;

  if (curve === PATH_CIRCLE) {
    const twistMag = Math.abs(params.twistBegin - params.twistEnd);
    const sides = Math.floor(
      Math.floor(MIN_DETAIL_FACES * detail + twistMag * 3.5 * (detail - 0.5)) * params.revolutions);
    if (sides > 0) open = genNGonPath(params, sides, out);
  } else if (curve === PATH_CIRCLE2) {
    if (params.end - params.begin >= 0.99 && params.scaleX >= 0.99) open = false;
    genNGonPath(params, Math.floor(MIN_DETAIL_FACES * detail), out);
    let toggle = 0.5;
    for (const p of out) { p.px = toggle; toggle = toggle === 0.5 ? -0.5 : 0.5; }
  } else {
    const twistMag = Math.abs(params.twistBegin - params.twistEnd);
    let np = Math.floor(twistMag * 3.5 * (detail - 0.5)) + 2;
    if (np < split + 2) np = split + 2;
    const step = 1 / (np - 1);
    const beginScale = [
      params.scaleX > 1 ? 2 - params.scaleX : 1,
      params.scaleY > 1 ? 2 - params.scaleY : 1,
    ];
    const endScale = [
      params.scaleX < 1 ? params.scaleX : 1,
      params.scaleY < 1 ? params.scaleY : 1,
    ];
    for (let i = 0; i < np; i++) {
      const t = lerp(params.begin, params.end, i * step);
      out.push({
        px: lerp(0, params.shearX, t),
        py: lerp(0, params.shearY, t),
        pz: t - 0.5,
        q: angAxisQuat(lerp(Math.PI * params.twistBegin, Math.PI * params.twistEnd, t), 0, 0, 1),
        sx: lerp(beginScale[0], endScale[0], t),
        sy: lerp(beginScale[1], endScale[1], t),
        texT: t,
      });
    }
  }

  if (params.twistEnd !== params.twistBegin) open = true;
  return { path: out, open };
}

// ---------------------------------------------------------------------------
// LLVolume::generate + LLVolumeFace::create*
// ---------------------------------------------------------------------------

// A vertex is {p:[x,y,z], uv:[u,v], r:[x,y,z]} where `r` is the analytic
// reference direction the surface should face (see buildSide/cellRef).
function emitTri(out, a, b, c) {
  out.pos.push(a.p[0], a.p[1], a.p[2], b.p[0], b.p[1], b.p[2], c.p[0], c.p[1], c.p[2]);
  out.uv.push(a.uv[0], a.uv[1], b.uv[0], b.uv[1], c.uv[0], c.uv[1]);
  out.ref.push(a.r[0], a.r[1], a.r[2], b.r[0], b.r[1], b.r[2], c.r[0], c.r[1], c.r[2]);
  out.tris++;
}

// LL's index order is not winding-consistent: the emitted normal flips sign
// wherever the profile contour runs through the "far" half of a circular path
// (that is why SL renders prims two-sided and never needed the winding to be
// right). Rewriting each triangle against the analytic outward reference gives
// canonical, outward-facing geometry, which the renderer can then backface-cull,
// light, shadow and collide against properly.
function orientOutward(out) {
  const P = out.pos, U = out.uv, R = out.ref;
  for (let i = 0; i < out.tris; i++) {
    const po = i * 9, uo = i * 6;
    const ux = P[po + 3] - P[po], uy = P[po + 4] - P[po + 1], uz = P[po + 5] - P[po + 2];
    const vx = P[po + 6] - P[po], vy = P[po + 7] - P[po + 1], vz = P[po + 8] - P[po + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const rx = R[po] + R[po + 3] + R[po + 6];
    const ry = R[po + 1] + R[po + 4] + R[po + 7];
    const rz = R[po + 2] + R[po + 5] + R[po + 8];
    if (nx * rx + ny * ry + nz * rz >= 0) continue;
    for (let k = 0; k < 3; k++) {
      let t = P[po + 3 + k]; P[po + 3 + k] = P[po + 6 + k]; P[po + 6 + k] = t;
      t = R[po + 3 + k]; R[po + 3 + k] = R[po + 6 + k]; R[po + 6 + k] = t;
    }
    for (let k = 0; k < 2; k++) {
      const t = U[uo + 2 + k]; U[uo + 2 + k] = U[uo + 4 + k]; U[uo + 4 + k] = t;
    }
  }
}

// LL keeps a few zero-area triangles (they fall out of its duplicated contour
// points and of the profile-begin/end wedges). They are invisible, and the
// renderer, the crease-angle normal pass and the raycaster all skip a zero-area
// triangle, so the only thing to decide is which of them can be *removed*.
//
// A triangle with two coincident corners contributes only a doubled edge plus a
// zero-length one, so dropping it cannot change any edge's parity: it is always
// safe, and those are the ones that go.
//
// A *collinear* one (three distinct corners on a line) is a seam: its three
// edges are each shared with a real neighbour, so removing it punches a hole.
// (Measured: dropping the hollow cube's cap seam left 6 unmatched boundary
// edges, and its cap lost area -- 0.6875 instead of 0.75.) Those are kept; the
// mesh stays a closed manifold, and the selftest's robust watertightness check
// verifies it. The retained count is reported as `seams`.
//
// "Degenerate" is judged *relatively* -- the triangle's area against the square
// of its longest edge, `area <= eps * L^2`, so it is scale-free (the thin
// ring's real slivers come out at ~0.2, a cube's triangles at 0.5) and it
// catches both ways a triangle can collapse:
//   * two corners coincident -> one edge is ~0 and so is the area;
//   * three distinct but collinear corners -> the area is ~0.
// Measured spread across all 21 catalogue cases (10 724 triangles): the thinnest
// *legitimate* triangle comes out at 0.012 and the worst collapsed one at
// 1.5e-8, so 1e-6 sits ~6 orders of magnitude clear of both. A triangle whose
// three corners are within NEAR_COINCIDENT_EPS of each other can be *removed*
// safely (its contribution to every edge's parity cancels); a merely collinear
// one must be kept (it is a seam shared with real neighbours).
export const DEGENERATE_RATIO_EPS = 1e-6;

// Absolute (prim space, which LL keeps in [-0.5, 0.5]) tolerance for "the same
// point". The numerically duplicated contour/closing points of a swept volume
// differ by ~1e-15 (the transforms are computed in double and only rounded to
// float32 at the end), while real distinct vertices are >=1e-3 apart even at
// the finest LOD, so this is far from both.
export const NEAR_COINCIDENT_EPS = 1e-9;

function triangleMetrics(P, o) {
  const ax = P[o], ay = P[o + 1], az = P[o + 2];
  const ux = P[o + 3] - ax, uy = P[o + 4] - ay, uz = P[o + 5] - az;
  const vx = P[o + 6] - ax, vy = P[o + 7] - ay, vz = P[o + 8] - az;
  const l1 = Math.hypot(ux, uy, uz);
  const l2 = Math.hypot(vx, vy, vz);
  const l3 = Math.hypot(P[o + 6] - P[o + 3], P[o + 7] - P[o + 4], P[o + 8] - P[o + 5]);
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  const L = Math.max(l1, l2, l3);
  return { l1, l2, l3, L, area: 0.5 * Math.hypot(cx, cy, cz) };
}

export function isDegenerateTriangle(P, o, eps = DEGENERATE_RATIO_EPS) {
  const t = triangleMetrics(P, o);
  return !(t.area > eps * t.L * t.L);
}

export function hasCoincidentCorners(P, o, eps = NEAR_COINCIDENT_EPS) {
  const t = triangleMetrics(P, o);
  return Math.min(t.l1, t.l2, t.l3) <= eps;
}

function dropDegenerate(out, faceRanges) {
  const P = out.pos, U = out.uv, R = out.ref;
  const keep = new Uint8Array(out.tris);
  let kept = 0, seams = 0;
  for (let i = 0; i < out.tris; i++) {
    const o = i * 9;
    if (!isDegenerateTriangle(P, o)) { keep[i] = 1; kept++; continue; }
    if (hasCoincidentCorners(P, o)) continue;
    keep[i] = 1; kept++; seams++;
  }
  if (kept === out.tris) { out.seams = seams; return; }
  const pos = new Array(kept * 9), uv = new Array(kept * 6), ref = new Array(kept * 9);
  let w = 0;
  for (const f of faceRanges) {
    let count = 0;
    for (let i = f.start; i < f.start + f.count; i++) {
      if (!keep[i]) continue;
      const o = i * 9, uo = i * 6, wo = w * 9, wu = w * 6;
      for (let k = 0; k < 9; k++) { pos[wo + k] = P[o + k]; ref[wo + k] = R[o + k]; }
      for (let k = 0; k < 6; k++) uv[wu + k] = U[uo + k];
      w++; count++;
    }
    f.start = w - count;
    f.count = count;
  }
  out.pos = pos; out.uv = uv; out.ref = ref; out.tris = w;
  for (let i = faceRanges.length - 1; i >= 0; i--) if (faceRanges[i].count === 0) faceRanges.splice(i, 1);
  faceRanges.forEach((f, i) => { f.id = i; });
  out.seams = seams;
}

export function generateVolume(volParams, lod = 3) {
  const detail = LOD_DETAIL[Math.max(0, Math.min(3, lod | 0))];
  const pp = volParams.profile;
  const pa = volParams.path;

  let split = Math.floor(detail * 0.66);
  const base = pp.baseCurve;
  if (pa.curveType === PATH_LINE && (pa.scaleX !== 1 || pa.scaleY !== 1) &&
      (base === PROFILE_SQUARE || base === PROFILE_ISOTRI ||
       base === PROFILE_EQUALTRI || base === PROFILE_RIGHTTRI)) {
    split = 0;
  }

  const path = generatePath(pa, detail, split);
  const prof = generateProfile(pp, path.open, detail, split);
  const sizeS = path.path.length;
  const sizeT = prof.points.length;

  const mesh = new Float32Array(sizeS * sizeT * 3);
  const meshRef = new Float32Array(sizeS * sizeT * 3);
  for (let s = 0; s < sizeS; s++) {
    const pt = path.path[s];
    for (let t = 0; t < sizeT; t++) {
      const p = prof.points[t];
      // NOTE: LL builds a (scale * rot) matrix here, but the only reading that
      // produces a real sphere/torus is scale-then-rotate: the profile's z lane
      // carries the texture parameter (not geometry) and must be annihilated by
      // the path's zero z-scale *before* the rotation, or it leaks into Y.
      const v = quatRotate(pt.q, [p.x * pt.sx, p.y * pt.sy, 0]);
      const i = (s * sizeT + t) * 3;
      mesh[i] = v[0] + pt.px;
      mesh[i + 1] = v[1] + pt.py;
      mesh[i + 2] = v[2] + pt.pz;
      meshRef[i] = v[0];
      meshRef[i + 1] = v[1];
      meshRef[i + 2] = v[2];
    }
  }
  const meshFlat = (n) => {
    const i = n * 3;
    return [mesh[i], mesh[i + 1], mesh[i + 2]];
  };
  const meshRefFlat = (n) => {
    const i = n * 3;
    return [meshRef[i], meshRef[i + 1], meshRef[i + 2]];
  };

  const out = { pos: [], uv: [], ref: [], tris: 0 };
  const faceRanges = [];
  const pathOpen = path.open;
  const hollow = pp.hollow;

  for (let fi = 0; fi < prof.faces.length; fi++) {
    const face = prof.faces[fi];
    const start = out.tris;
    if (face.cap) {
      buildCap(face, prof, pa, path, meshFlat, sizeS, sizeT, out);
    } else {
      buildSide(face, prof, path, meshFlat, meshRefFlat, sizeS, sizeT, pathOpen, out);
    }
    faceRanges.push({
      id: fi, start, count: out.tris - start, faceID: face.faceID,
      cap: face.cap, flat: face.flat, sides: face.count,
    });
  }

  orientOutward(out);
  dropDegenerate(out, faceRanges);
  const positions = new Float32Array(out.pos);
  const normals = new Float32Array(out.pos.length);
  computeNormals(positions, normals);
  return {
    positions, uvs: new Float32Array(out.uv), normals,
    faces: faceRanges, numTriangles: out.tris, numVertices: positions.length / 3,
    seams: out.seams || 0,
  };
}

// LLVolumeFace::createSide -- sweeps the profile range along the whole path.
function buildSide(face, prof, path, meshFlat, meshRefFlat, sizeS, sizeT, pathOpen, out) {
  const beginS = face.index;
  const numS = face.count;
  const flat = face.flat;
  const inner = !!(face.faceID & FACE_INNER_SIDE);
  const endMask = !!(face.faceID & (FACE_PROFILE_BEGIN | FACE_PROFILE_END));
  const openMask = !!prof.open;
  const isInnerFlat = inner && flat && numS > 2;
  // LLVolume::createVolumeFaces doubles mNumS for flat inner faces, which
  // cancels createSide's `mNumS/2` -- so the column count is always the face's
  // own count, and the doubled row width comes from duplicating s>0 plus the
  // trailing wrap column below.
  const num_s = numS;
  const pts = prof.points;
  const nPts = pts.length;
  const beginStex = Math.floor(pts[beginS] ? pts[beginS].t : 0);

  // Outward reference for a profile column: the contour's 2D edge normal
  // (dy,-dx), which for the counter-clockwise outer contour points away from the
  // profile, and for addHole's reversed (clockwise) inner contour points back
  // into the hole -- exactly the direction each surface should face. It is then
  // rotated by the path sample's quaternion, same as the geometry itself.
  //
  // The columns are addressed by their offset within the FACE (0..numS-1), not
  // by their index in the contour, because a face may span the contour's seam:
  // the profile-cut wedges (LL_FACE_PROFILE_BEGIN is `addFace(total-1, 2, ...)`,
  // so its second column is one past the end and wraps to the first point) sweep
  // the closing edge, and that edge is only visible if the lookup is allowed to
  // wrap. Reading outside the face's span is what must be avoided: the column
  // before the first one (or after the last) belongs to the neighbouring face --
  // or, for a sliced profile, to the synthetic centre point LL appends -- and its
  // normal points the wrong way. (Measured earlier: reading "the next point" at a
  // face's last column flipped a whole column of the cut box's +Y wall, costing
  // it 1/18 of its volume, and the same bug hit the hollow box's closing column.
  // The opposite failure: the wedge faces could not see the wrap-around edge at
  // all, fell back to the radial direction -- which is perpendicular to the flat
  // disc they are -- and had their sign decided by float noise: 19 and 33
  // inconsistently-wound edges on the cut sphere and the cut torus.)
  //
  // A column takes the AVERAGE of both adjacent in-face edges. For a split
  // (collinear) column the two are parallel, so this changes nothing, but at a
  // contour CORNER the two walls meeting there have different normals and their
  // average is the bisector -- the one direction that is outward for both walls.
  // Keeping just the next edge leaves a corner column holding the next wall's
  // normal, and the flat hollow face (a single face spanning the whole reversed
  // hole contour, corners included) then handed a corner triangle a reference
  // that averaged out ~perpendicular to its own normal: the sign test compared
  // two near-orthogonal vectors, the dot came out ~0, and the triangle's winding
  // was flipped -- or not -- on float noise. (Measured: the hollow cube's
  // triangular bore came out with 15 inconsistently-wound edges because of it.)
  const pointAt = (j) => {
    const k = beginS + j;
    return pts[k < nPts ? k : k % nPts];
  };
  const colNormal = (j) => {
    let nx = 0, ny = 0, any = false;
    if (j > 0) {
      const a = pointAt(j - 1), b = pointAt(j);
      if (a && b) {
        const ex = b.y - a.y, ey = -(b.x - a.x);
        if (ex !== 0 || ey !== 0) { nx += ex; ny += ey; any = true; }
      }
    }
    if (j < numS - 1) {
      const a = pointAt(j), b = pointAt(j + 1);
      if (a && b) {
        const ex = b.y - a.y, ey = -(b.x - a.x);
        if (ex !== 0 || ey !== 0) { nx += ex; ny += ey; any = true; }
      }
    }
    return any ? [nx, ny] : null;
  };
  const wedgeRef = endMask ? colNormal(0) : null;

  const cellRef = (t, index, flatIdx) => {
    const n2 = endMask ? wedgeRef : colNormal(index - beginS);
    if (n2 && (n2[0] !== 0 || n2[1] !== 0)) {
      return quatRotate(path.path[t].q, [n2[0], n2[1], 0]);
    }
    // Degenerate edge (duplicated/flat-inner columns, or the closing wrap):
    // fall back to the radial direction, negated for the inner (hollow) side.
    const r = meshRefFlat(flatIdx);
    const sgn = inner ? -1 : 1;
    return [r[0] * sgn, r[1] * sgn, r[2] * sgn];
  };

  // Build the face's own vertex grid exactly like LL does (one row per path
  // sample, `numS` columns), then index it row-major.
  const grid = [];
  for (let t = 0; t < sizeS; t++) {
    const tt = path.path[t].texT;
    const row = [];
    for (let s = 0; s < num_s; s++) {
      let ss;
      const index = beginS + s;
      if (endMask) ss = s ? 1 : 0;
      else if (index >= nPts) ss = flat ? 1 - beginStex : 1;
      else ss = flat ? pts[index].t - beginStex : pts[index].t;

      let flatIdx;
      if (index >= sizeT) flatIdx = index + sizeT * (t - 1);
      else flatIdx = index + sizeT * t;
      const cell = { p: meshFlat(flatIdx), uv: [ss, tt], r: cellRef(t, index, flatIdx) };
      row.push(cell);
      if (isInnerFlat && s > 0) row.push(cell);
    }
    if (isInnerFlat) {
      const s = openMask ? num_s - 1 : 0;
      const index = beginS + s;
      let flatIdx;
      if (index >= sizeT) flatIdx = index + sizeT * (t - 1);
      else flatIdx = index + sizeT * t;
      const ss = flat ? (pts[index] ? pts[index].t - beginStex : 0) : 0;
      row.push({ p: meshFlat(flatIdx), uv: [ss, tt], r: cellRef(t, index, flatIdx) });
    }
    grid.push(row);
  }
  const W = grid[0].length;
  for (const row of grid) while (row.length < W) row.push(row[row.length - 1]);

  for (let t = 0; t < sizeS - 1; t++) {
    for (let s = 0; s < W - 1; s++) {
      const a = grid[t][s], b = grid[t + 1][s + 1], c = grid[t + 1][s];
      const d = grid[t][s + 1];
      emitTri(out, a, b, c);
      emitTri(out, a, d, b);
    }
  }
}

// LLVolumeFace::createCap / createUnCutCubeCap
function buildCap(face, prof, pa, pathData, meshFlat, sizeS, sizeT, out) {
  const points = prof.points;
  const isTop = face.faceID === FACE_PATH_BEGIN;
  const hollow = prof.hollow > 0;
  const open = !!prof.open;
  const offset = 0;

  // A cap is a flat polygon lying in one path sample's plane. That plane is the
  // profile plane carried by the path sample's quaternion, so its normal is
  // exactly quatRotate(q, [0,0,1]) -- true for every path (linear, twisted,
  // sheared, tapered, rotated) and, unlike a difference of two path POSITIONS,
  // it does not collapse when the path is a pure rotation: the sphere's path has
  // zero radius, so all of its path samples sit on top of each other.
  const pth = pathData.path;
  const nSeg = pth.length;
  const base = isTop ? sizeS - 1 : 0;

  // Only the SIGN is left to decide: the cap must face away from the volume, so
  // the exact normal is dotted against the direction in which the surface
  // actually sweeps away from the cap's row, averaged over the contour. Note
  // that mean contour displacement is used for its sign ONLY -- the reference
  // itself stays the exact plane normal -- so a taper or a shear (which tilts
  // the sweep out of the cap's plane, up to nearly perpendicular) cannot degrade
  // the reference the way using the sweep direction directly would.
  //
  // Measured failure this replaces: a difference of path positions gave (0,0,1)
  // for the cut sphere, whose two caps lie in the y=0 plane -- i.e. perpendicular
  // to that reference -- so the sign test degenerated into a coin flip on float
  // noise and roughly half of each cap's triangles stayed wound inward (28
  // inconsistently-wound edges). A path-position difference is kept as the
  // fallback for a shape whose sweep genuinely cancels (an axisymmetric profile
  // on a zero-radius path -- LL's legacy double-covered sphere), and a plain
  // +normal is the last resort, so no triangle can ever be flipped at random.
  let capRef = [0, 0, 1];
  {
    const q = nSeg ? pth[base].q : null;
    const nq = q ? quatRotate(q, [0, 0, 1]) : [0, 0, 1];
    let sx = 0, sy = 0, sz = 0;
    if (nSeg >= 2) {
      const adj = isTop ? sizeS - 2 : 1;
      for (let i = 0; i < points.length; i++) {
        const c = meshFlat(base * sizeT + i), a = meshFlat(adj * sizeT + i);
        sx += c[0] - a[0]; sy += c[1] - a[1]; sz += c[2] - a[2];
      }
    }
    let d = sx * nq[0] + sy * nq[1] + sz * nq[2];
    if (d === 0 && nSeg >= 2) {
      const a = isTop ? pth[nSeg - 2] : pth[0];
      const b = isTop ? pth[nSeg - 1] : pth[1];
      const sgn = isTop ? 1 : -1;
      const dx = (b.px - a.px) * sgn, dy = (b.py - a.py) * sgn, dz = (b.pz - a.pz) * sgn;
      d = dx * nq[0] + dy * nq[1] + dz * nq[2];
    }
    const sgn = d < 0 ? -1 : 1;
    capRef = [nq[0] * sgn, nq[1] * sgn, nq[2] * sgn];
    if (!(Math.hypot(capRef[0], capRef[1], capRef[2]) > 0)) capRef = [0, 0, 1];
  }
  const ref = capRef;

  // Un-cut cube cap (fast path in LL): interpolated grid between profile corners
  if (!hollow && !open && prof.baseCurve === PROFILE_SQUARE &&
      pa.curveType === PATH_LINE && pa.begin === 0 && pa.end === 1) {
    const gridSize = Math.floor((points.length - 1) / 4);
    if (gridSize >= 1) {
      const corners = [];
      const capBase = isTop ? sizeS - 1 : 0;
      for (let t = 0; t < 4; t++) {
        const p = points[gridSize * t];
        corners.push({
          p: meshFlat(capBase * sizeT + gridSize * t),
          uv: [p.x + 0.5, 0.5 - p.y],
          r: ref,
        });
      }
      if (isTop) {
        const s0 = corners[0].uv.slice(), s3 = corners[3].uv.slice();
        corners[0].uv = s3; corners[3].uv = s0;
        const s1 = corners[1].uv.slice(), s2 = corners[2].uv.slice();
        corners[1].uv = s2; corners[2].uv = s1;
      }
      const grid = [];
      for (let gx = 0; gx <= gridSize; gx++) {
        for (let gy = 0; gy <= gridSize; gy++) {
          const fx = gx / gridSize, fy = gy / gridSize;
          const p = [0, 1, 2].map((k) =>
            corners[0].p[k] + (corners[1].p[k] - corners[0].p[k]) * fx +
            (corners[3].p[k] - corners[0].p[k]) * fy);
          const uv = [0, 1].map((k) => corners[0].uv[k] +
            (corners[1].uv[k] - corners[0].uv[k]) * fx +
            (corners[3].uv[k] - corners[0].uv[k]) * fy);
          grid.push({ p, uv, r: ref });
        }
      }
      const W = gridSize + 1;
      const idx = (gx, gy) => gx * W + gy;
      for (let gx = 0; gx < gridSize; gx++) {
        for (let gy = 0; gy < gridSize; gy++) {
          const a = grid[idx(gx, gy)], b = grid[idx(gx + 1, gy)];
          const c = grid[idx(gx + 1, gy + 1)], d = grid[idx(gx, gy + 1)];
          if (isTop) {
            emitTri(out, a, d, c);
            emitTri(out, a, c, b);
          } else {
            emitTri(out, a, b, c);
            emitTri(out, a, c, d);
          }
        }
      }
      return;
    }
  }

  const verts = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    verts.push({
      p: meshFlat(base * sizeT + i),
      uv: isTop ? [p.x + 0.5, p.y + 0.5] : [p.x + 0.5, 0.5 - p.y],
      r: ref,
    });
  }
  const nv = verts.length;

  if (!hollow) {
    // LL's triangle fan. A closed contour gets a centre vertex (LL's mCenter:
    // the face's bounding-box centre); an open/cut contour gets none, and LL
    // pivots the fan on the contour's LAST vertex instead. LL loops to
    // num_vertices-2, so the wrap quad (last -> first) is intentionally absent:
    // for a closed contour its last point duplicates its first.
    let pivot;
    let count;
    if (open) {
      pivot = verts[nv - 1];
      count = nv - 2;
    } else {
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      const minP = [Infinity, Infinity, Infinity], maxP = [-Infinity, -Infinity, -Infinity];
      for (const v of verts) {
        minU = Math.min(minU, v.uv[0]); maxU = Math.max(maxU, v.uv[0]);
        minV = Math.min(minV, v.uv[1]); maxV = Math.max(maxV, v.uv[1]);
        for (let k = 0; k < 3; k++) {
          minP[k] = Math.min(minP[k], v.p[k]);
          maxP[k] = Math.max(maxP[k], v.p[k]);
        }
      }
      pivot = {
        p: [0, 1, 2].map((k) => (minP[k] + maxP[k]) * 0.5),
        uv: [(minU + maxU) * 0.5, (minV + maxV) * 0.5],
        r: ref,
      };
      count = nv - 1;
    }
    for (let i = 0; i < count; i++) {
      if (isTop) emitTri(out, pivot, verts[i], verts[i + 1]);
      else emitTri(out, pivot, verts[i + 1], verts[i]);
    }
    void offset; void pathData;
    return;
  }

  // Hollow: LL's "walk in from both ends" ear clipper over the profile contour
  // (the outer ring followed by addHole's reversed inner ring).
  //
  // The contour is used VERBATIM, duplicate closing points included: the clipper
  // depends on them. De-duplicating the rings (an apparently harmless tidy-up)
  // shifts the walk and loses real surface -- it costs 0.0625 of the hollow
  // cube's cap area -- so LL's exact input is restored here. The walk's output
  // contains one zero-area (collinear) triangle per hollow cap; that triangle is
  // the cap's seam against the wall's subdivided rows, so dropDegenerate keeps
  // it (dropping it would puncture the cap -- the selftest's watertightness
  // check is what caught this).
  const area = (i, j, k) => {
    const p1 = points[i], p2 = points[j], p3 = points[k];
    return (p1.x * p2.y - p2.x * p1.y) + (p2.x * p3.y - p3.x * p2.y) + (p3.x * p1.y - p1.x * p3.y);
  };
  const segLen2 = (i, j) => {
    const a = points[i], b = points[j];
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  };
  let pt1 = 0, pt2 = nv - 1;
  while (pt2 - pt1 > 1) {
    const area1a2 = area(pt1, pt1 + 1, pt2);
    const area1ba = area(pt1, pt2 - 1, pt1 + 1);
    const area21b = area(pt2, pt1, pt2 - 1);
    const area2ab = area(pt2, pt1 + 1, pt2 - 1);
    const tri1a2 = area1a2 >= 0 && area2ab >= 0;
    const tri21b = area21b >= 0 && area1ba >= 0;
    let useTri1a2;
    if (!tri1a2) useTri1a2 = false;
    else if (!tri21b) useTri1a2 = true;
    else useTri1a2 = segLen2(pt1, pt1 + 1) < segLen2(pt2, pt2 - 1);
    const A = verts[pt1], B = verts[pt2];
    const C = verts[pt1 + 1], D = verts[pt2 - 1];
    if (isTop) {
      if (useTri1a2) { emitTri(out, A, C, B); pt1++; }
      else { emitTri(out, A, D, B); pt2--; }
    } else {
      if (useTri1a2) { emitTri(out, A, B, C); pt1++; }
      else { emitTri(out, A, B, D); pt2--; }
    }
  }
  void offset; void pathData;
}

// ---------------------------------------------------------------------------
// normals -- crease-angle smoothing (equivalent to, but more robust than, LL's
// normal merging step: flat faces stay crisp, curved surfaces stay smooth).
// ---------------------------------------------------------------------------

function computeNormals(positions, normals) {
  const nTris = positions.length / 9;
  const triN = new Float32Array(nTris * 3);
  const areaW = new Float32Array(nTris);
  for (let i = 0; i < nTris; i++) {
    const o = i * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
    triN[i * 3] = nx; triN[i * 3 + 1] = ny; triN[i * 3 + 2] = nz;
    areaW[i] = len * 0.5;
  }
  const COS_CREASE = Math.cos(32 * DEG);
  const q = (v) => Math.round(v * 16384) / 16384;
  const map = new Map();
  for (let i = 0; i < nTris; i++) {
    for (let v = 0; v < 3; v++) {
      const o = i * 9 + v * 3;
      const k = q(positions[o]) + '_' + q(positions[o + 1]) + '_' + q(positions[o + 2]);
      let list = map.get(k);
      if (!list) { list = []; map.set(k, list); }
      list.push(i);
    }
  }
  for (let i = 0; i < nTris; i++) {
    for (let v = 0; v < 3; v++) {
      const o = i * 9 + v * 3;
      const k = q(positions[o]) + '_' + q(positions[o + 1]) + '_' + q(positions[o + 2]);
      const list = map.get(k);
      const rx = triN[i * 3], ry = triN[i * 3 + 1], rz = triN[i * 3 + 2];
      let nx = 0, ny = 0, nz = 0;
      for (let j = 0; j < list.length; j++) {
        const ti = list[j];
        const tx = triN[ti * 3], ty = triN[ti * 3 + 1], tz = triN[ti * 3 + 2];
        if (tx * rx + ty * ry + tz * rz < COS_CREASE) continue;
        const w = areaW[ti] || 1e-6;
        nx += tx * w; ny += ty * w; nz += tz * w;
      }
      if (nx === 0 && ny === 0 && nz === 0) {
        // La referencia era un triangulo colapsado (direccion nula), asi que
        // el filtro por angulo descarto a todos los vecinos. Promediar sin
        // filtro da el valor suave correcto para esa posicion.
        for (let j = 0; j < list.length; j++) {
          const ti = list[j];
          const w = areaW[ti] || 1e-6;
          nx += triN[ti * 3] * w; ny += triN[ti * 3 + 1] * w; nz += triN[ti * 3 + 2] * w;
        }
      }
      let len = Math.hypot(nx, ny, nz);
      if (!(len > 0)) {
        // La posicion solo pertenece a triangulos nulos (invisibles): una
        // normal cero volveria la superficie negra, asi que se usa la radial.
        nx = positions[o]; ny = positions[o + 1]; nz = positions[o + 2];
        len = Math.hypot(nx, ny, nz);
        if (!(len > 0)) { nx = 0; ny = 1; nz = 0; len = 1; }
      }
      normals[o] = nx / len; normals[o + 1] = ny / len; normals[o + 2] = nz / len;
    }
  }
}

// Exposed for src/llvolume.selftest.js so profile/path-level invariants can be
// checked without going through a full swept volume.
export const _internal = { genNGon, generateProfile, generatePath, quatRotate, quatMul, angAxisQuat };
