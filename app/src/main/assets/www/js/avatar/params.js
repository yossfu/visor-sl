// The shape sliders of a Second Life avatar: avatar_lad.xml, plus the exact rule
// the official viewer uses to read them back out of an AvatarAppearance message.
//
// The message carries no param ids — just one byte per slider, in the order the
// *sender* walked its own visual param table. That table is
// `LLCharacter::mVisualParamIndexMap`, a `std::map<S32, LLVisualParam*>` keyed by
// param id, so the walk is **ascending id** (llcharacter.h:208-221), and the
// sender/receiver both skip every param whose group is not TWEAKABLE(0) or
// TRANSMIT_NOT_TWEAKABLE(3) (llvoavatar.cpp `parseAppearanceMessage`).
// In today's avatar_lad.xml that is exactly 253 params — the same order of
// magnitude as the viewer's own MAX_TRANSMITTED_VISUAL_PARAMS = 255.
//
// The byte maps linearly onto the slider's declared range:
//   weight = value_min + (byte / 255) * (value_max - value_min)
// which is `U8_to_F32(value, getMinWeight(), getMaxWeight())` on the receiving
// side, since LLVisualParamInfo::parseXml stores value_min/value_max straight
// into mMinWeight/mMaxWeight (llvisualparam.cpp).
//
// A param's *name* is also the name of the morph target it drives in the `.llm`
// meshes, so the weight map can be applied to the meshes as-is. Several ids can
// share one name (the male/female variants of a slider, or a param declared in
// two meshes with shared="1"), and each drives its own copy of the morph, so
// weights landing on the same name are summed.
import { loadText } from "./assets.js";

export const GROUP_TWEAKABLE = 0;
export const GROUP_TRANSMIT_NOT_TWEAKABLE = 3;

const PARAM_RE = /<param\b([^>]*?)(\/?)>/g;

function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_]\w*)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function num(v, dflt) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Parses avatar_lad.xml. One entry per distinct param id (a param may be
 * declared once per mesh it morphs, with shared="1").
 */
export function parseLadXml(text) {
  const byId = new Map();
  PARAM_RE.lastIndex = 0;
  let m;
  while ((m = PARAM_RE.exec(text))) {
    const a = attrsOf(m[1]);
    if (!a.id || !a.name) continue;
    const rest = text.slice(m.index + m[0].length);
    const cut = rest.indexOf("</param>");
    const inner = cut >= 0 ? rest.slice(0, cut) : "";
    const id = +a.id;
    let p = byId.get(id);
    if (!p) {
      p = {
        id, name: a.name, group: a.group !== undefined ? +a.group : GROUP_TWEAKABLE,
        wearable: a.wearable || "shape",
        min: num(a.value_min, 0), max: num(a.value_max, 1),
        def: a.value_default !== undefined ? num(a.value_default, 0) : 0,
        sex: a.sex || "both",
        label: a.label || a.name, labelMin: a.label_min || "Menos", labelMax: a.label_max || "Más",
        editGroup: a.edit_group || "", order: num(a.edit_group_order, 0),
        kinds: new Set(), shared: false, drivers: [], skeleton: [],
      };
      byId.set(id, p);
    }
    // <param_skeleton><bone name="mPelvis" scale="0 0 .03" offset="0 -.01 0" /></param_skeleton>
    // A slider moves bones *scales*; the magnitude is a delta added to the
    // bone's default scale, multiplied by the slider's own weight
    // (LLPolySkeletalDistortion::apply), so `Height` (range -2.3..2) with a
    // delta of .1 moves one bone's scale by ±0.19. `offset` moves the bone
    // itself, the same way (LLPolySkeletalDistortion::apply's mJointOffsets).
    for (const b of inner.matchAll(/<bone\b([^>]*?)(\/?)>/g)) {
      const ba = attrsOf(b[1]);
      if (!ba.name) continue;
      const s = (ba.scale || "").trim().split(/\s+/).map(Number);
      const o = (ba.offset || "").trim().split(/\s+/).map(Number);
      const scale = [s[0] || 0, s[1] || 0, s[2] || 0];
      const offset = [o[0] || 0, o[1] || 0, o[2] || 0];
      if (!p.skeleton.some((x) => x.bone === ba.name && x.scale[0] === scale[0]
        && x.scale[1] === scale[1] && x.scale[2] === scale[2])) {
        p.skeleton.push({ bone: ba.name, scale, offset });
      }
    }
    // <param_driver><driven id=".." min1=".." max1=".." max2=".." min2=".."/></param_driver>
    // The driven sliders have no value of their own on the wire: each viewer
    // recomputes them from the driver (see LLDriverParam).
    for (const d of inner.matchAll(/<driven\b([^>]*?)(\/?)>/g)) {
      const da = attrsOf(d[1]);
      if (da.id === undefined) continue;
      const range = { id: +da.id };
      // Defaults, exactly as LLDriverParamInfo::parseXml sets them up: the
      // interpolation points default to the *driver's* own weight range.
      const dflMin1 = p.min, dflMax1 = p.max;
      range.min1 = num(da.min1, dflMin1);
      range.max1 = num(da.max1, dflMax1);
      range.max2 = num(da.max2, dflMax1);
      range.min2 = num(da.min2, dflMax1);
      if (!p.drivers.some((x) => x.id === range.id)) p.drivers.push(range);
    }
    if (inner.includes("<param_morph")) p.kinds.add("morph");
    if (inner.includes("<param_skeleton")) p.kinds.add("skeleton");
    if (inner.includes("<param_driver")) p.kinds.add("driver");
    if (inner.includes("<param_color")) p.kinds.add("color");
    if (inner.includes("<param_alpha")) p.kinds.add("alpha");
    if (a.shared) p.shared = true;
  }
  const params = [...byId.values()].sort((a, b) => a.id - b.id);
  // The wire layout: ascending id, groups 0 and 3 only.
  const transmitted = params.filter(
    (p) => p.group === GROUP_TWEAKABLE || p.group === GROUP_TRANSMIT_NOT_TWEAKABLE);
  const byName = new Map();
  for (const p of params) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }
  // avatar_lad.xml declares a slider once per mesh it morphs (a face slider can
  // appear five times, under different ids), and each copy carries its own
  // <param_skeleton> block. The bone deformation of a *name* is therefore the
  // union of the blocks of every declaration with that name, applied once with
  // the slider's weight — not once per declaration.
  const skeletonByName = new Map();
  for (const [name, list] of byName) {
    const merged = new Map();
    for (const p of list) {
      for (const entry of p.skeleton) {
        const prev = merged.get(entry.bone);
        if (!prev) { merged.set(entry.bone, { bone: entry.bone, scale: entry.scale.slice(), offset: entry.offset.slice() }); continue; }
        for (let i = 0; i < 3; i++) {
          if (!prev.scale[i] && entry.scale[i]) prev.scale[i] = entry.scale[i];
          if (!prev.offset[i] && entry.offset[i]) prev.offset[i] = entry.offset[i];
        }
      }
    }
    if (merged.size) skeletonByName.set(name, [...merged.values()]);
  }
  return { params, byId, byName, transmitted, skeletonByName };
}

let ladPromise = null;

/** The parsed slider table (singleton; the file is read once per session). */
export function loadAvatarParams() {
  if (!ladPromise) {
    ladPromise = loadText("avatar_lad.xml.gz")
      .then((t) => parseLadXml(t))
      .catch((e) => { ladPromise = null; throw e; });
  }
  return ladPromise;
}

/** Parses the table straight from text (used by the self-test). */
export function parseLadText(text) { return parseLadXml(text); }

/**
 * AvatarAppearance.VisualParam bytes → morph weights by morph name.
 * `values` is the raw byte list in wire order; anything beyond the length of the
 * transmitted table is ignored (a newer viewer may know more sliders than us).
 */
export function weightsFromVisualParams(values, table) {
  const byId = paramWeightsById(values, table);
  applyDrivers(byId, table);
  const weights = new Map();
  for (const [id, w] of byId) {
    const p = table.byId.get(id);
    if (!p || !p.name || !w) continue;
    weights.set(p.name, (weights.get(p.name) || 0) + w);
  }
  return weights;
}

/**
 * Runs the driver sliders: a driver's weight is interpolated into the weight of
 * every slider it drives (`<param_driver><driven>`), exactly as
 * LLDriverParam::getDrivenWeight does. This is where most of the *visible* body
 * shape comes from — the chest, muscles, fat and butt sliders are not on the
 * wire at all, only the driver they hang off.
 */
export function applyDrivers(byId, table, passes = 4) {
  const drivers = table.params.filter((p) => p.drivers && p.drivers.length);
  if (!drivers.length) return byId;
  for (let pass = 0; pass < passes; pass++) {
    let changed = 0;
    for (const driver of drivers) {
      const input = byId.get(driver.id);
      if (input === undefined) continue;
      for (const d of driver.drivers) {
        const target = table.byId.get(d.id);
        if (!target) continue;
        const w = drivenWeight(driver, target, d, input);
        if (byId.get(d.id) !== w) { byId.set(d.id, w); changed++; }
      }
    }
    if (!changed) break;
  }
  return byId;
}

/**
 * The interpolation curve of one `<driven>` entry (LLDriverParam::getDrivenWeight):
 *
 *   driven   ________
 *   ^       /|      |\
 *   |      / |      | \
 *   +-----|--|------|--|----> driver
 *        min1 max1  max2 min2
 */
export function drivenWeight(driver, target, d, input) {
  const drivenMin = target.min;
  const drivenMax = target.max;
  const driverMax = driver.max;
  if (input <= d.min1) {
    if (d.min1 === d.max1 && d.min1 <= driver.min) return drivenMax;
    return drivenMin;
  }
  if (input <= d.max1) {
    const t = (input - d.min1) / (d.max1 - d.min1);
    return drivenMin + t * (drivenMax - drivenMin);
  }
  if (input <= d.max2) return drivenMax;
  if (input <= d.min2) {
    const t = (input - d.max2) / (d.min2 - d.max2);
    return drivenMax + t * (drivenMin - drivenMax);
  }
  if (d.max2 >= driverMax) return drivenMax;
  return drivenMin;
}

/** The same walk, but keeping `id → weight` (the shape editor works with ids). */
export function paramWeightsById(values, table) {
  const out = new Map();
  if (!values || !table) return out;
  const list = table.transmitted;
  const n = Math.min(values.length, list.length);
  for (let i = 0; i < n; i++) {
    const p = list[i];
    out.set(p.id, p.min + (values[i] / 255) * (p.max - p.min));
  }
  return out;
}

/**
 * The shape *editor* primitive: start from every transmitted slider at its
 * default, set the ones named in `overrides` (a param name or id), then run the
 * drivers so the sliders that are not on the wire (the chest, muscles, fat…)
 * follow the ones that are. Returns the same name → weight map that
 * `weightsFromVisualParams` produces, so it feeds `applyShape` directly.
 */
export function weightsFromOverrides(overrides, table) {
  // `values` holds the same 0..255 bytes the grid would send, so the sliders a
  // caller *does* name and the ones it leaves at their default both go through
  // the identical byte → weight mapping. (A slider's value_default is already a
  // weight, and a driven slider is recomputed below from its driver, so its own
  // default byte is irrelevant.)
  const values = table.transmitted.map((p) => byteFromWeight(p, clampWeight(p, p.def)));
  for (const [key, v] of Object.entries(overrides || {})) {
    const p = table.byName.get(key)
      ? table.transmitted.find((t) => t.name === key) || table.byName.get(key)[0]
      : table.byId.get(+key);
    if (!p) continue;
    const i = table.transmitted.indexOf(p);
    if (i < 0) continue;
    values[i] = byteFromWeight(p, clampWeight(p, v));
  }
  const weights = new Map();
  const byId = paramWeightsById(values, table);
  applyDrivers(byId, table);
  for (const [id, w] of byId) {
    const p = table.byId.get(id);
    if (!p || !p.name || !w) continue;
    weights.set(p.name, (weights.get(p.name) || 0) + w);
  }
  return weights;
}

/** Keeps a slider inside its own declared weight range. */
export function clampWeight(p, weight) {
  const w = Number.isFinite(weight) ? weight : 0;
  return Math.max(p.min, Math.min(p.max, w));
}

/** Slider weight → the 0..255 byte the grid would carry (for uploading later). */
export function byteFromWeight(p, weight) {
  const range = p.max - p.min;
  if (!range) return 0;
  return Math.max(0, Math.min(255, Math.round(((weight - p.min) / range) * 255)));
}
