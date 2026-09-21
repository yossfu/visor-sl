// Bones, shape and pose.
//
// Everything an SL avatar does — being tall or short, having wide hips, bending
// its elbows while it walks — is the **skeleton**, and the meshes are rigid
// sheets of geometry that only ever move because a joint moves them. There are
// two joint transforms the viewer reads off the wire (avatar_lad.xml):
//
//   * `<param_skeleton><bone name="mPelvis" scale="0 0 .03"/>`  → a scale delta
//     added to the bone's default scale times the slider's weight
//     (LLPolySkeletalDistortion::apply). This is where Height, Hip Width,
//     Shoulders and Body Thickness come from — the morph targets in the meshes
//     do *not* carry them.
//   * the joint rotations of a keyframe animation (not yet wired up).
//
// A joint's world matrix is
//
//   world(b) = world(parent) · [T(pos_b · scale_parent) · R_b · S_b]
//
// i.e. a parent's rotation rotates its child's offset, and a parent's scale
// *scales* it — which is exactly how scaling the pelvis stretches the whole
// body (LLJoint::updateWorldMatrix). Since every rest rotation in
// avatar_skeleton.xml is identity and every rest scale is 1, the rest pose is a
// pure translation: rest position = the sum of `pos` up the hierarchy, so the
// bind matrix is just `world(b) · T(−restPos_b)`.
//
// Skin weights: the per-vertex float in a `.llm` is a joint coordinate in an
// ordering neither the file's (alphabetical) joint-name list nor the skeleton
// exposes, so instead of guessing it every vertex is bound to the two *nearest*
// joints of the mesh's own joint list and blended by their distances. For the
// head mesh that reproduces the file's intent (92.8% of vertices land on the
// joint the file's weight implies) and, unlike the file's encoding, it is
// defined for every mesh.
import * as THREE from "../../vendor/three.module.min.js";

let indexDone = false;

/** Assigns every bone its index in the file (== a valid parent-before-child order). */
function ensureIndices(skeleton) {
  if (indexDone) return skeleton;
  skeleton.bones.forEach((b, i) => {
    b.index = i;
    b.parentIndex = b.parent ? (skeleton.byName.get(b.parent) || {}).index ?? -1 : -1;
  });
  indexDone = true;
  return skeleton;
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _local = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);

/**
 * Sums the scale (and position) deltas of every skeleton-distorting slider that
 * has a weight. `weights` is the map params.js produces (param name → weight),
 * and `table.skeletonByName` is the union of every declaration of that name, so
 * a slider that shifts several bones accumulates on all of them exactly once —
 * whichever mesh copies of the slider the XML happened to declare it in.
 */
export function boneDeltas(skeleton, table, weights) {
  ensureIndices(skeleton);
  const n = skeleton.bones.length;
  const dScale = new Float32Array(n * 3);
  const dOffset = new Float32Array(n * 3);
  const byName = table && table.skeletonByName;
  if (!byName || !weights || !weights.size) return { scale: dScale, offset: dOffset };
  for (const [name, entries] of byName) {
    const w = weights.get(name);
    if (!w) continue;
    for (const entry of entries) {
      const bone = skeleton.byName.get(entry.bone);
      if (!bone || bone.index === undefined) continue;
      const i = bone.index * 3;
      dScale[i] += entry.scale[0] * w;
      dScale[i + 1] += entry.scale[1] * w;
      dScale[i + 2] += entry.scale[2] * w;
      dOffset[i] += entry.offset[0] * w;
      dOffset[i + 1] += entry.offset[1] * w;
      dOffset[i + 2] += entry.offset[2] * w;
    }
  }
  return { scale: dScale, offset: dOffset };
}

/** Bone scale deltas only (the shape of the body; see `boneDeltas`). */
export function boneScaleDeltas(skeleton, table, weights) {
  return boneDeltas(skeleton, table, weights).scale;
}

// An animation keyframe's quaternion is stored as the *vector* part with w
// recovered as sqrt(1-|v|²). Whether that rotation needs conjugating before it
// drives a three.js bone depends on the matrix convention of whoever consumes
// it; verified against the shipped STAND/WALK assets (with the conjugate the
// stand pose raises the arms over the head — 2.19 m — instead of lowering them
// to the sides, 1.89 m), so it is off by default. `setAnimationConjugate` exists
// so the self-test can show both.
let ANIM_CONJUGATE = false;
export function setAnimationConjugate(on) { ANIM_CONJUGATE = !!on; }
export function getAnimationConjugate() { return ANIM_CONJUGATE; }

const IDENTITY = new THREE.Quaternion();

// The joints whose lowest point is kept on the ground: a taller avatar must not
// sink into the floor (the body scales *downward* from the pelvis, since the
// pelvis is the root of the skeleton).
const GROUND_JOINTS = ["mFootLeft", "mFootRight", "mAnkleLeft", "mAnkleRight"];

/**
 * One pass over the skeleton: bone world matrices, plus the per-bone scales.
 *
 * The transform of a bone is `world(parent) · T(offset) · R(rot)` — no scale, so
 * it does not compound down the chain — where
 *
 *   offset = restOffset · ownScale(parent) + shapeOffset + animationOffset
 *
 * i.e. a joint sits at its rest offset from its parent, *scaled by the parent's
 * own scale*. That is how a shape stretches the body: scaling the pelvis moves
 * everything above it outwards, and the stretch is uniform rather than
 * multiplicative (SLSkeletonBone::updateGlobalPos). The bone's own scale is
 * applied to the vertices bound to it (see poseSkeleton).
 *
 * `anim` supplies, per bone *name*, the rotation of an animation
 * (`anim.rotations`), the position delta (`anim.offsets`, in avatar space) and how
 * much of that offset to trust (`anim.weight`).
 */
function poseOnce(skeleton, delta, anim, out) {
  const n = skeleton.bones.length;
  const world = out.world;
  const worldPos = out.worldPos;
  const worldQuat = out.worldQuat;
  const worldScale = out.worldScale;
  const rotations = anim && anim.rotations;
  const offsets = anim && anim.offsets;
  const weights = anim && anim.weight;

  for (let i = 0; i < n; i++) {
    const b = skeleton.bones[i];
    const pi = b.parentIndex;
    _s.set(b.scale[0] + delta.scale[i * 3], b.scale[1] + delta.scale[i * 3 + 1], b.scale[2] + delta.scale[i * 3 + 2]);
    worldScale[i * 3] = _s.x; worldScale[i * 3 + 1] = _s.y; worldScale[i * 3 + 2] = _s.z;
    const psx = pi >= 0 ? worldScale[pi * 3] : 1;
    const psy = pi >= 0 ? worldScale[pi * 3 + 1] : 1;
    const psz = pi >= 0 ? worldScale[pi * 3 + 2] : 1;

    const rot = rotations ? rotations.get(b.name) : null;
    if (rot) {
      _q.copy(rot);
      if (ANIM_CONJUGATE) _q.conjugate();
    } else if (b.localQuat) {
      _q.copy(b.localQuat);
    } else {
      _q.copy(IDENTITY);
    }

    let ox = delta.offset[i * 3], oy = delta.offset[i * 3 + 1], oz = delta.offset[i * 3 + 2];
    if (offsets) {
      const a = offsets.get(b.name);
      if (a) {
        const w = weights ? (weights.get(b.name) || 0) : 1;
        ox += a[0] * w; oy += a[1] * w; oz += a[2] * w;
      }
    }
    _v.set(b.pos[0] * psx + ox, b.pos[1] * psy + oy, b.pos[2] * psz + oz);
    _local.compose(_v, _q, ONE);
    if (!world[i]) world[i] = new THREE.Matrix4();
    if (pi >= 0) world[i].copy(world[pi]).multiply(_local);
    else world[i].copy(_local);
    world[i].decompose(_v, _q, _s);
    worldPos[i * 3] = _v.x; worldPos[i * 3 + 1] = _v.y; worldPos[i * 3 + 2] = _v.z;
    worldQuat[i * 4] = _q.x; worldQuat[i * 4 + 1] = _q.y; worldQuat[i * 4 + 2] = _q.z; worldQuat[i * 4 + 3] = _q.w;
  }
}

function newPoseState(n) {
  return {
    world: new Array(n),
    worldPos: new Float32Array(n * 3),
    worldQuat: new Float32Array(n * 4),
    worldScale: new Float32Array(n * 3),
    skin: new Array(n),
    groundShift: 0,
    height: 0,
  };
}

/**
 * Poses the skeleton and returns the per-bone `skin` matrices (see `poseOnce`).
 *
 * The body is also re-planted: since every joint hangs off the pelvis and bones
 * scale *downward* from it, a tall avatar's feet would otherwise sink through the
 * floor. The shift is computed from the shape alone (not from an animation), so
 * a sit or a jump animation can still lift the body off the ground.
 */
export function poseSkeleton(skeleton, table, weights, anim = null) {
  ensureIndices(skeleton);
  const n = skeleton.bones.length;
  const delta = boneDeltas(skeleton, table, weights);
  const state = skeleton._pose && skeleton._pose.world.length === n
    ? skeleton._pose : (skeleton._pose = newPoseState(n));
  const shapeOnly = skeleton._shapePose && skeleton._shapePose.world.length === n
    ? skeleton._shapePose : (skeleton._shapePose = newPoseState(n));

  poseOnce(skeleton, delta, anim, state);
  poseOnce(skeleton, delta, null, shapeOnly);

  let shift = 0;
  let any = false;
  for (const name of GROUND_JOINTS) {
    const b = skeleton.byName.get(name);
    if (!b || b.index === undefined) continue;
    const dz = shapeOnly.worldPos[b.index * 3 + 2] - b.rest[2];
    if (!any || dz < shift) shift = dz;
    any = true;
  }
  shift = any ? -shift : 0;

  const shiftM = skeleton._shiftM || (skeleton._shiftM = new THREE.Matrix4());
  shiftM.makeTranslation(0, 0, shift);
  const scaleM = skeleton._scaleM || (skeleton._scaleM = new THREE.Matrix4());
  for (let i = 0; i < n; i++) {
    const b = skeleton.bones[i];
    _inv.makeTranslation(-b.rest[0], -b.rest[1], -b.rest[2]);
    if (!state.skin[i]) state.skin[i] = new THREE.Matrix4();
    // A bone's own scale is applied to the vertices bound to it (after its
    // rotation, so the stretch follows the limb), and the re-planting is a plain
    // translation in avatar space on top.
    scaleM.makeScale(state.worldScale[i * 3], state.worldScale[i * 3 + 1], state.worldScale[i * 3 + 2]);
    state.skin[i].copy(state.world[i]).multiply(scaleM).multiply(_inv);
    if (shift) state.skin[i].premultiply(shiftM);
    state.worldPos[i * 3 + 2] += shift;
  }

  // Height of the posed body (pelvis to the top of the head), for the camera.
  const skull = skeleton.byName.get("mSkull");
  const pelvis = skeleton.byName.get("mPelvis");
  state.height = skull && pelvis
    ? (state.worldPos[skull.index * 3 + 2] - state.worldPos[pelvis.index * 3 + 2]) * 1.08 + 0.35
    : 1.9;
  state.groundShift = shift;
  state.dirty = delta.scale;
  state.offset = delta.offset;
  return state;
}

/**
 * Binds every vertex of a mesh to its two nearest joints (of the mesh's own
 * joint list) with a distance blend, computed once per mesh.
 */
export function buildSkin(mesh, skeleton) {
  ensureIndices(skeleton);
  const joints = [];
  for (const name of mesh.jointNames || []) {
    const b = skeleton.byName.get(name);
    if (b && b.index !== undefined) joints.push(b);
  }
  if (!joints.length) return null;
  const n = mesh.numVertices;
  const first = new Int16Array(n);
  const second = new Int16Array(n);
  const blend = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = mesh.coords[i * 3], y = mesh.coords[i * 3 + 1], z = mesh.coords[i * 3 + 2];
    let i1 = 0, d1 = Infinity, i2 = 0, d2 = Infinity;
    for (let j = 0; j < joints.length; j++) {
      const r = joints[j].rest;
      const d = Math.hypot(x - r[0], y - r[1], z - r[2]);
      if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = j; }
      else if (d < d2) { d2 = d; i2 = j; }
    }
    first[i] = joints[i1].index;
    second[i] = joints[i2].index;
    blend[i] = d1 + d2 > 0 ? d1 / (d1 + d2) : 0;
  }
  return { first, second, blend, bones: joints.map((b) => b.name) };
}

const _m = new Float32Array(16);

/**
 * Writes the skinned positions (and rotated normals) of a rest-pose mesh.
 * Two influences per vertex, blended element-wise like the official viewer
 * blends two joint matrices, so a joint rotation bends the mesh instead of
 * tearing it.
 */
export function skinMesh(src, skinData, pose, outCoords, outNormals) {
  const n = src.numVertices;
  const { first, second, blend } = skinData;
  const coords = src.coords, normals = src.normals;
  const skin = pose.skin;
  for (let i = 0; i < n; i++) {
    const ma = skin[first[i]].elements, mb = skin[second[i]].elements, t = blend[i];
    for (let k = 0; k < 16; k++) _m[k] = ma[k] + (mb[k] - ma[k]) * t;
    const x = coords[i * 3], y = coords[i * 3 + 1], z = coords[i * 3 + 2];
    outCoords[i * 3] = _m[0] * x + _m[4] * y + _m[8] * z + _m[12];
    outCoords[i * 3 + 1] = _m[1] * x + _m[5] * y + _m[9] * z + _m[13];
    outCoords[i * 3 + 2] = _m[2] * x + _m[6] * y + _m[10] * z + _m[14];
    if (!outNormals) continue;
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    let nX = _m[0] * nx + _m[4] * ny + _m[8] * nz;
    let nY = _m[1] * nx + _m[5] * ny + _m[9] * nz;
    let nZ = _m[2] * nx + _m[6] * ny + _m[10] * nz;
    const l = Math.hypot(nX, nY, nZ) || 1;
    outNormals[i * 3] = nX / l; outNormals[i * 3 + 1] = nY / l; outNormals[i * 3 + 2] = nZ / l;
  }
}
