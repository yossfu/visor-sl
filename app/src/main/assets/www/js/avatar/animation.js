// Animation playback: what an avatar is playing right now, and how the
// overlapping animations of an avatar are blended into one pose.
//
// The grid tells us which animations a resident is playing (AvatarAnimation, the
// simulator's own list) — never *how* they combine. That part is the viewer's,
// and it is a priority blend:
//
//   * Every animation file groups its joints by a per-joint priority (the
//     "joint sets" of anim-data.js): the walk cycle drives the hips at priority
//     3, the torso at 0. The same animation therefore competes differently for
//     different parts of the body.
//   * All running animations are sorted by that priority (highest first, ties
//     broken by the sequence id the grid assigned, newest first) and then, joint
//     by joint, each one takes as much of the joint as is left: the first claims
//     it, the second fills what remains, and so on. This is exactly
//     AvatarAnimationList/AnimationSkeletonData in Lumiya, and it is why a
//     waving gesture overrides the arms but not the legs of a walk.
//   * Each animation's share is scaled by its own fade: a cubic ease-in when it
//     starts and a cubic ease-out when the grid drops it from the list, so
//     animations never pop in or out.
//
// A "sequence" is one entry of that list: (animation, sequenceID, since-when).
// The grid resends the whole list whenever it changes, so a sequence that is
// still in the list keeps its start time (that is what makes a loop continuous)
// and one that disappeared starts fading out.
import * as THREE from "../../vendor/three.module.min.js";
import { getAnimation, uuidKey } from "./anim-data.js";

const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();

function cubicStep(x) {
  const t = Math.max(0, Math.min(1, x));
  return (3 - 2 * t) * t * t;
}

/** Interpolated transform of one keyframe channel at time `t`. */
function samplePair(list, t, length, out, isQuat) {
  const n = list.length;
  if (n === 0) { out.w = 1; out.x = out.y = out.z = 0; return false; }
  if (n === 1) { copyKf(out, list[0], isQuat); return true; }
  for (let i = 0; i < n; i++) {
    if (t <= list[i].t) {
      if (t === list[i].t || i === 0) { copyKf(out, list[i], isQuat); return true; }
      const a = list[i - 1], b = list[i];
      let at = a.t;
      if (at > b.t) at -= length;
      const span = b.t - at;
      if (span === 0) { copyKf(out, b, isQuat); return true; }
      const u = (t - at) / span;
      const v = 1 - u;
      out.x = a.x * v + b.x * u;
      out.y = a.y * v + b.y * u;
      out.z = a.z * v + b.z * u;
      if (isQuat) out.w = a.w * v + b.w * u;
      return true;
    }
  }
  copyKf(out, list[n - 1], isQuat);
  return true;
}

function copyKf(out, k, isQuat) {
  out.x = k.x; out.y = k.y; out.z = k.z;
  if (isQuat) out.w = k.w;
}

/** The loop window and the ease curves of one animation (AnimationData). */
class Timing {
  constructor(anim) {
    this.anim = anim;
    this.runningTime = 0;
    this.inAnimationTime = 0;
    this.inFactor = 0;
    this.outFactor = 1;
  }

  inAnimationTimeAt(t, stopTime) {
    const a = this.anim;
    if (!a.loop) return Math.min(t, a.length);
    if (t < a.inPoint) return t;
    if (stopTime < 0) {
      return a.outPoint > a.inPoint
        ? a.inPoint + ((t - a.inPoint) % (a.outPoint - a.inPoint))
        : a.inPoint;
    }
    let v;
    if (a.outPoint > a.inPoint) {
      v = ((t - stopTime) - Math.floor((t - stopTime - a.inPoint) / (a.outPoint - a.inPoint))
        * (a.outPoint - a.inPoint)) + stopTime;
    } else {
      v = a.outPoint + stopTime;
    }
    return Math.min(v, a.length);
  }

  inFactorAt(t) {
    const a = this.anim;
    if (t >= a.easeInTime || a.easeInTime < 0.001) return 1;
    return Math.min(1, cubicStep(t / a.easeInTime));
  }

  outFactorOnly(t) {
    if (t < 0) return 1;
    if (this.anim.easeOutTime < 0.001) return 0;
    return Math.max(0, cubicStep(1 - t / this.anim.easeOutTime));
  }

  outFactorAt(t, stopTime) {
    const a = this.anim;
    if (stopTime < 0) {
      if (a.loop) return 1;
      const d = t - (a.length - a.easeOutTime);
      return d >= 0 ? this.outFactorOnly(d) : 1;
    }
    if (a.loop) {
      if (a.outPoint >= a.length) return this.outFactorOnly(stopTime);
      const base = t - stopTime;
      const wrap = a.outPoint > a.inPoint
        ? Math.floor((base - a.inPoint) / (a.outPoint - a.inPoint)) * (a.outPoint - a.inPoint) + a.inPoint + a.length
        : a.length + base;
      return this.outFactorOnly(t - Math.max(wrap - a.easeOutTime, base));
    }
    let d = stopTime;
    const tail = t - (a.length - a.easeOutTime);
    if (tail > 0) d = Math.max(d, tail);
    return this.outFactorOnly(d);
  }

  /** Recomputes the fade state; returns true when anything moved. */
  update(now, runningSince, stoppingSince, dontEaseIn) {
    const t = (now - runningSince) / 1000;
    const stopTime = (stoppingSince === -1 || now < stoppingSince) ? -1 : (now - stoppingSince) / 1000;
    const inTime = this.inAnimationTimeAt(t, stopTime);
    const inFactor = dontEaseIn ? 1 : this.inFactorAt(t);
    const outFactor = this.outFactorAt(t, stopTime);
    let changed = false;
    this.runningTime = t;
    if (this.inAnimationTime !== inTime) { this.inAnimationTime = inTime; changed = true; }
    if (this.inFactor !== inFactor) { this.inFactor = inFactor; changed = true; }
    if (this.outFactor !== outFactor) { this.outFactor = outFactor; changed = true; }
    return changed;
  }

  get weight() { return this.inFactor * this.outFactor; }
}

/** One entry of the grid's animation list, plus its fade state. */
class Sequence {
  constructor(anim, sequenceID, runningSince, stoppingSince, dontEaseIn) {
    this.anim = anim;
    this.sequenceID = sequenceID;
    this.runningSince = runningSince;
    this.stoppingSince = stoppingSince === undefined ? -1 : stoppingSince;
    this.dontEaseIn = !!dontEaseIn;
    this.timing = new Timing(anim);
  }
  update(now) { return this.timing.update(now, this.runningSince, this.stoppingSince, this.dontEaseIn); }
  get stopped() {
    return this.stoppingSince !== -1 && this.timing.outFactor <= 0.001;
  }
}

/**
 * Everything one avatar is playing. `setList` is fed the grid's AvatarAnimation
 * list; `pose` turns it into per-bone rotations/offsets for the skeleton.
 */
export class AvatarAnimations {
  constructor() {
    this.sequences = new Map();       // "uuid/sequenceID" → Sequence
    this.missing = new Set();         // uuids we do not have an asset for
    this.pose = { rotations: new Map(), offsets: new Map(), weight: new Map() };
    this.dirty = true;
    this.active = false;
    this.changes = 0;
    this.animationsSeen = 0;
    // Bumped whenever the blended pose could have changed; builder.js uses it as
    // the cache key so an idle avatar is never re-skinned.
    this.frameKey = 0;
  }

  /** The grid's list for this avatar: [{ animationID, sequenceID }, …]. */
  async setList(list, now = performance.now()) {
    const next = new Map();
    for (const entry of list || []) {
      const uuid = uuidKey(entry.animationID || entry.animID || entry.id);
      const sequenceID = entry.sequenceID !== undefined ? entry.sequenceID : entry.sequence;
      if (!uuid) continue;
      const key = uuid + "/" + sequenceID;
      const running = this.sequences.get(key);
      if (running) {
        next.set(key, running);
        continue;
      }
      const anim = await getAnimation(uuid);
      if (!anim) { this.missing.add(uuid); continue; }
      next.set(key, new Sequence(anim, sequenceID, now, -1, false));
      this.changes++;
    }
    // Whatever the grid no longer lists fades out (and is dropped when silent).
    for (const [key, seq] of this.sequences) {
      if (next.has(key)) continue;
      if (seq.stoppingSince === -1) seq.stoppingSince = now;
      next.set(key, seq);
    }
    this.sequences = next;
    this.animationsSeen = this.sequences.size;
    this.dirty = true;
    this.frameKey++;
  }

  /** Every animation stops (avatar left, moved out of range…). */
  clear(now = performance.now()) {
    for (const seq of this.sequences.values()) {
      if (seq.stoppingSince === -1) seq.stoppingSince = now;
    }
  }

  /** Advances the clocks; returns true when the pose needs recomputing. */
  update(now) {
    let moved = false;
    for (const [key, seq] of [...this.sequences]) {
      if (seq.update(now)) moved = true;
      if (seq.stopped) { this.sequences.delete(key); moved = true; }
    }
    this.active = this.sequences.size > 0;
    if (moved) { this.dirty = true; this.frameKey++; }
    return moved;
  }

  /**
   * Blends the running animations into one rotation (and position) per bone.
   * Returns the pose object; the same object is reused between callers, so read
   * it before the next call.
   */
  build(skeleton, now) {
    if (!skeleton) return null;
    const n = skeleton.bones.length;
    const rotW = this._rotW && this._rotW.length === n ? this._rotW : (this._rotW = new Float32Array(n));
    const posW = this._posW && this._posW.length === n ? this._posW : (this._posW = new Float32Array(n));
    const quats = this._quats || (this._quats = new Array(n));
    const poss = this._poss || (this._poss = new Array(n));
    rotW.fill(1); posW.fill(1);
    for (let i = 0; i < n; i++) {
      if (!quats[i]) { quats[i] = { x: 0, y: 0, z: 0, w: 0 }; poss[i] = { x: 0, y: 0, z: 0 }; }
      else { quats[i].x = quats[i].y = quats[i].z = quats[i].w = 0; poss[i].x = poss[i].y = poss[i].z = 0; }
    }

    // Highest per-joint priority first, then the newest sequence: the same order
    // the official viewer and Lumiya use.
    const runs = [];
    for (const seq of this.sequences.values()) {
      const w = seq.timing.weight;
      if (w <= 0.001) continue;
      for (const set of seq.anim.sets) runs.push({ seq, set, w });
    }
    runs.sort((a, b) => (b.set.priority - a.set.priority) || (b.seq.sequenceID - a.seq.sequenceID));

    for (const run of runs) {
      const { seq, set, w } = run;
      const time = seq.timing.inAnimationTime;
      const length = seq.anim.length;
      for (const joint of set.joints) {
        const bone = skeleton.byName.get(joint.name);
        if (!bone) continue;
        const i = bone.index;
        if (joint.pos.length) {
          const share = posW[i] * w;
          if (share > 0.0001) {
            if (samplePair(joint.pos, time, length, _q, false)) {
              poss[i].x += _q.x * share;
              poss[i].y += _q.y * share;
              poss[i].z += _q.z * share;
            }
            posW[i] -= share;
          }
        }
        if (joint.rot.length) {
          const share = rotW[i] * w;
          if (share > 0.0001) {
            if (samplePair(joint.rot, time, length, _qa, true)) {
              quats[i].x += _qa.x * share;
              quats[i].y += _qa.y * share;
              quats[i].z += _qa.z * share;
              quats[i].w += _qa.w * share;
            }
            rotW[i] -= share;
          }
        }
      }
    }

    const rotations = this.pose.rotations;
    const offsets = this.pose.offsets;
    const weights = this.pose.weight;
    rotations.clear(); offsets.clear(); weights.clear();
    const pool = this._qpool || (this._qpool = new Array(n));
    let used = 0;
    for (let i = 0; i < n; i++) {
      const total = 1 - rotW[i];
      const q = quats[i];
      if (total > 0.02) {
        const s = total < 1 ? 1 / total : 1;
        const w = q.w * s;
        let len = Math.hypot(q.x * s, q.y * s, q.z * s, w) || 1;
        if (!pool[i]) pool[i] = new THREE.Quaternion();
        pool[i].set(q.x * s / len, q.y * s / len, q.z * s / len, w / len);
        rotations.set(skeleton.bones[i].name, pool[i]);
        used++;
      }
      const pw = 1 - posW[i];
      if (pw > 0.001) {
        offsets.set(skeleton.bones[i].name, [poss[i].x, poss[i].y, poss[i].z]);
        weights.set(skeleton.bones[i].name, pw);
      }
    }
    this.pose.count = used;
    return this.pose;
  }
}

/** Bone rotations for one animation at a fixed time (used by the self-test). */
export function sampleAnimation(anim, skeleton, time) {
  const rotations = new Map();
  for (const joint of anim.joints) {
    const bone = skeleton.byName.get(joint.name);
    if (!bone || !joint.rot.length) continue;
    if (samplePair(joint.rot, time, anim.length, _q, true)) {
      rotations.set(joint.name, _q.clone());
    }
  }
  return rotations;
}
