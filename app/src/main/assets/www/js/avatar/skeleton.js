// The default avatar skeleton (avatar_skeleton.xml).
//
// 133 bones, and every rest rotation is identity — which is exactly why the
// `.llm` meshes are "already in place" (they are modelled in the rest pose) and
// why the bind pose needs no matrix work at all. llavatarappearance.cpp
// (`setupBone`) is the reference: a joint's local position is the bone's `pos`
// (the `pivot` is the *skin offset*, i.e. the origin bone scaling happens
// around), so a joint's rest position is the sum of `pos` up the hierarchy.
//
// We need the skeleton for two things: placing the eyeballs, which are modelled
// at the origin and positioned by mEyeLeft/mEyeRight (fixed data, never sent by
// the grid), and — later — skinning and the skeletal-distortion shape sliders.
import { loadText } from "./assets.js";

function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_]\w*)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function vec3(s) {
  const p = String(s || "0 0 0").trim().split(/\s+/).map(Number);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
}

const TOKEN_RE = /<(\/?)([a-zA-Z_][\w.]*)\b([^>]*?)(\/?)>/g;

/** Parses the skeleton XML into bones with their accumulated rest positions. */
export function parseSkeletonXml(text) {
  const bones = [];
  const byName = new Map();
  const stack = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    if (m[2] !== "bone") continue;                    // collision volumes etc.
    if (m[1] === "/") { stack.pop(); continue; }       // </bone>
    const selfClosing = m[4] === "/";
    const a = attrsOf(m[3]);
    if (!a.name) { if (!selfClosing) stack.push(null); continue; }
    const parent = stack.length ? stack[stack.length - 1] : null;
    const pos = vec3(a.pos);
    const rest = parent
      ? [parent.rest[0] + pos[0], parent.rest[1] + pos[1], parent.rest[2] + pos[2]]
      : pos.slice();
    // Every rest rotation in avatar_skeleton.xml is identity (which is why the
    // `.llm` meshes need no bind-pose fix-up), and a bone without a `scale`
    // attribute is unscaled — not scaled by zero.
    const bone = {
      name: a.name,
      aliases: (a.aliases || "").split(/\s+/).filter(Boolean),
      parent: parent ? parent.name : null,
      group: a.group || "",
      pos, pivot: vec3(a.pivot), rest,
      end: vec3(a.end),
      scale: a.scale ? vec3(a.scale) : [1, 1, 1],
      localQuat: null,
      depth: stack.length,
    };
    bones.push(bone);
    if (!byName.has(bone.name)) byName.set(bone.name, bone);
    for (const al of bone.aliases) if (!byName.has(al)) byName.set(al, bone);
    if (!selfClosing) stack.push(bone);
  }
  return { bones, byName };
}

let skelPromise = null;

/** The parsed skeleton (singleton). */
export function loadSkeleton() {
  if (!skelPromise) {
    skelPromise = loadText("avatar_skeleton.xml.bin")
      .then(parseSkeletonXml)
      .catch((e) => { skelPromise = null; throw e; });
  }
  return skelPromise;
}

/** Rest-pose position (avatar space, metres) of a joint, or null. */
export function jointRest(skeleton, name) {
  const b = skeleton.byName.get(name);
  return b ? b.rest : null;
}
