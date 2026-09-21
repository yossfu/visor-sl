// Builds a renderable Second Life avatar out of the default body meshes.
//
// The `.llm` files ship with the app and are already authored in avatar-local
// space (Z up, origin between the feet): lower body 0.00–1.15 m, upper body
// 1.14–1.63 m, head 1.62–1.87 m — no offsets or scaling are involved, which is
// also why the meshes line up with the SL coordinate system the rest of the
// engine already uses (the scene root adds the Z-up → Y-up rotation).
//
// Baked texture indices come from the viewer's own dictionary
// (llavatarappearancedefines.cpp): head mesh → TEX_HEAD_BAKED (8), upper → 9,
// lower → 10, eyelashes → the head bake, eyeballs → TEX_EYES_BAKED (11).
// A shape slider deforms the mesh through its named morph target (params.js),
// so an avatar is really "these meshes under this set of morph weights",
// wearing the baked textures the grid sends in the AvatarAppearance message.
import * as THREE from "../../vendor/three.module.min.js";
import { loadBytes } from "./assets.js";
import { parseLLM, morphMesh } from "./llm.js";
import { loadSkeleton } from "./skeleton.js";
import { buildSkin, skinMesh, poseSkeleton } from "./skin.js";
import { loadAvatarParams } from "./params.js";

// ETextureIndex (llavatarappearancedefines.h). Baked faces of the avatar's
// TextureEntry: 8..11 and 19..20 (TEX_*_BAKED slots, not the wearable ones).
export const BAKED_HEAD = 8, BAKED_UPPER = 9, BAKED_LOWER = 10,
  BAKED_EYES = 11, BAKED_SKIRT = 19, BAKED_HAIR = 20;

export const AVATAR_PARTS = [
  { key: "head", file: "avatar_head.llm.bin", baked: BAKED_HEAD },
  { key: "upper", file: "avatar_upper_body.llm.bin", baked: BAKED_UPPER },
  { key: "lower", file: "avatar_lower_body.llm.bin", baked: BAKED_LOWER },
  // The eyelashes are part of the head bake and are modelled in place.
  { key: "eyelashes", file: "avatar_eyelashes.llm.bin", baked: BAKED_HEAD, fallback: 0x2b2119 },
  // Eyeballs are modelled at the origin and live on the eye joints. Until the
  // resident's eye bake arrives they are plain off-white spheres, which read as
  // eyes; a dark colour would look like empty sockets.
  { key: "eyeL", file: "avatar_eye.llm.bin", baked: BAKED_EYES, joint: "mEyeLeft", fallback: 0xbdb6ae },
  { key: "eyeR", file: "avatar_eye.llm.bin", baked: BAKED_EYES, joint: "mEyeRight", fallback: 0xbdb6ae },
];

// Default SL skin, used until the baked texture of that body part arrives.
export const SKIN_COLOR = 0xc9a184;

export const AVATAR_HEIGHT = 1.9;

let partsPromise = null;

/** Parses the body meshes once per session (~1.6 MB gzipped together). */
export function loadAvatarParts() {
  if (!partsPromise) {
    partsPromise = (async () => {
      const skeleton = await loadSkeleton();
      const files = new Map();
      const parts = [];
      for (const def of AVATAR_PARTS) {
        let mesh = files.get(def.file);
        if (!mesh) {
          mesh = parseLLM(await loadBytes(def.file));
          files.set(def.file, mesh);
        }
        const joint = def.joint ? skeleton.byName.get(def.joint) : null;
        parts.push({
          key: def.key,
          baked: def.baked,
          fallback: def.fallback || SKIN_COLOR,
          offset: joint ? joint.rest : null,
          file: def.file,
          mesh,
          // The joint→vertex binding depends only on the mesh and the skeleton,
          // so it is computed once here and shared by every avatar built from it.
          skin: joint ? null : buildSkin(mesh, skeleton),
        });
      }
      return parts;
    })().catch((e) => { partsPromise = null; throw e; });
  }
  return partsPromise;
}

/** True once the meshes are in memory (the HUD uses it to say what is loading). */
export function avatarMeshesReady() { return !!partsPromise; }

/**
 * Geometry for one body part. The coordinates start at the mesh's rest pose and
 * are overwritten in place by `applyPose` — an animated avatar rewrites its
 * vertices every frame, so nothing here may be allocated per frame.
 */
function createPartGeometry(src) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(src.coords), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(src.normals), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(src.texCoords.slice(), 2));
  geo.setIndex(new THREE.BufferAttribute(src.faces.slice(), 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The morph-only ("rest") coordinates of a part, cached per shape: morphing is
 * the expensive half of building a body and a shape only changes when the grid
 * says so, while an animation changes every frame.
 */
function restFor(p, weights, key) {
  if (p.rest && p.restKey === key) return p.rest;
  const src = p.source.mesh;
  const morphed = weights && weights.size ? morphMesh(src, weights) : null;
  p.rest = {
    coords: morphed ? morphed.coords : src.coords,
    normals: morphed ? morphed.normals : src.normals,
  };
  p.restKey = key;
  return p.rest;
}

/** Poses the vertices of one part into its live geometry buffers. */
function writePartGeometry(p, rest, skin, pose) {
  const geo = p.mesh.geometry;
  const pos = geo.attributes.position.array;
  const nrm = geo.attributes.normal.array;
  if (pose && skin) {
    skinMesh({ numVertices: p.source.mesh.numVertices, coords: rest.coords, normals: rest.normals },
      skin, pose, pos, nrm);
  } else {
    pos.set(rest.coords);
    nrm.set(rest.normals);
  }
  geo.attributes.position.needsUpdate = true;
  geo.attributes.normal.needsUpdate = true;
}

function partMaterial(color) {
  // Baked textures carry alpha for hair/eyelash fringes, so the meshes are
  // alpha-tested cut-outs: no sorting artefacts, and they still depth-write.
  return new THREE.MeshLambertMaterial({
    color, transparent: true, alphaTest: 0.25, side: THREE.FrontSide,
  });
}

/** A body group with no shape applied yet — `applyShape` fills it in. */
export async function createAvatar(weights = null) {
  const [parts, skeleton, table] = await Promise.all([
    loadAvatarParts(), loadSkeleton(), loadAvatarParams().catch(() => null),
  ]);
  const group = new THREE.Group();
  group.userData.kind = "avatar";
  group.userData.parts = [];
  group.userData.morphNames = new Set();
  for (const part of parts) {
    const geo = createPartGeometry(part.mesh);
    const mat = partMaterial(part.fallback);
    const mesh = new THREE.Mesh(geo, mat);
    // Eyeballs have no skin data: they are rigid meshes pinned to the eye
    // joints, so they follow the head instead of being deformed by it.
    const skin = part.skin || null;
    if (part.offset) mesh.position.set(part.offset[0], part.offset[1], part.offset[2]);
    mesh.castShadow = part.key !== "eyeL" && part.key !== "eyeR";
    mesh.receiveShadow = true;
    mesh.userData.avatarPart = part.key;
    mesh.userData.bakedIndex = part.baked;
    mesh.userData.bakedUUID = null;
    group.add(mesh);
    group.userData.parts.push({
      key: part.key, baked: part.baked, fallback: part.fallback, joint: part.joint || null,
      offset: part.offset, mesh, material: mat, source: part, skin,
      rest: null, restKey: null,
    });
    for (const name of part.mesh.morphs.keys()) group.userData.morphNames.add(name);
  }
  group.userData.skeleton = skeleton;
  group.userData.table = table;
  group.userData.skinnedVerts = group.userData.parts
    .reduce((n, p) => n + (p.skin ? p.source.mesh.numVertices : 0), 0);
  group.userData.shapeKey = "";
  group.userData.weightKey = "";
  if (weights && weights.size) applyShape(group, weights);
  return group;
}

/**
 * Re-morphs every body part. `weights` maps a morph name (a slider name) to the
 * weight the grid reported; names a mesh has no target for are ignored, which is
 * exactly how the viewer distributes one slider over several meshes.
 */
export function applyShape(group, weights) {
  return applyPose(group, weights, null, 0);
}

/**
 * Morphs the meshes *and* poses the skeleton. `anim` is an AvatarAnimations
 * (animation.js) whose blended rotations/offsets are applied on top of the shape;
 * with none, the body is drawn in its rest pose under the shape the grid
 * reported, which is still a different body for every resident (Height, Hip
 * Width, Shoulders, Body Thickness…).
 */
export function applyPose(group, weights, anim = null, now = 0) {
  if (!group || !group.userData.parts) return 0;
  const skeleton = group.userData.skeleton;
  const table = group.userData.table;
  const shapeKey = weights ? weightsSignature(weights) : "";
  // The animation's own frame counter is part of the key: while nothing moves,
  // an idle body is not re-skinned at all.
  const key = shapeKey + "|" + (anim ? anim.frameKey : "");
  const reshaped = group.userData.shapeKey !== shapeKey;
  if (!reshaped && group.userData.weightKey === key) return group.userData.appliedMorphs || 0;
  group.userData.weightKey = key;

  const animPose = anim && skeleton ? anim.build(skeleton, now) : null;
  const pose = skeleton ? poseSkeleton(skeleton, table, weights, animPose) : null;
  let applied = 0;
  const names = weights ? [...weights.keys()] : [];
  for (const p of group.userData.parts) {
    const rest = restFor(p, weights, shapeKey);
    if (p.joint && pose && skeleton) {
      const b = skeleton.byName.get(p.joint);
      if (b) {
        p.mesh.position.set(pose.worldPos[b.index * 3], pose.worldPos[b.index * 3 + 1], pose.worldPos[b.index * 3 + 2]);
        p.mesh.quaternion.set(pose.worldQuat[b.index * 4], pose.worldQuat[b.index * 4 + 1],
          pose.worldQuat[b.index * 4 + 2], pose.worldQuat[b.index * 4 + 3]);
      }
      continue;
    }
    writePartGeometry(p, rest, p.skin, pose);
    if (reshaped) for (const name of names) if (p.source.mesh.morphs.has(name)) applied++;
  }
  if (reshaped) group.userData.shapeKey = shapeKey;
  group.userData.weights = weights;
  group.userData.pose = pose;
  group.userData.anim = anim || null;
  group.userData.height = pose ? pose.height : 1.9;
  if (reshaped) group.userData.appliedMorphs = applied;
  return group.userData.appliedMorphs || 0;
}

function weightsSignature(weights) {
  if (!weights || !weights.size) return "";
  const names = [...weights.keys()].sort();
  let s = "";
  for (const n of names) s += n + ":" + (Math.round(weights.get(n) * 1000) / 1000) + ";";
  return s;
}

/**
 * Applies the avatar's baked textures (TextureEntry faces 8..11/19/20 of the
 * AvatarAppearance message). `resolve(uuid)` returns a three.Texture or null; a
 * part without a texture keeps its default colour so the avatar never turns into
 * a white silhouette.
 */
export function applyBakedTextures(group, baked, resolve) {
  let applied = 0;
  group.userData.baked = baked || null;
  for (const p of group.userData.parts) {
    const uuid = baked && baked[p.baked] ? baked[p.baked] : null;
    p.mesh.userData.bakedUUID = uuid;
    const tex = uuid && resolve ? resolve(uuid) : null;
    p.material.map = tex || null;
    p.material.color.set(tex ? 0xffffff : p.fallback);
    p.material.needsUpdate = true;
    if (tex) applied++;
  }
  group.userData.bakedApplied = applied;
  return applied;
}

/** Baked texture ids this body still needs from the grid. */
export function bakedNeeded(baked) {
  const out = [];
  if (!baked) return out;
  for (const p of AVATAR_PARTS) {
    const u = baked[p.baked];
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

export function disposeAvatar(group) {
  if (!group) return;
  for (const p of group.userData.parts || []) {
    p.mesh.geometry.dispose();
    p.material.dispose();
  }
}
