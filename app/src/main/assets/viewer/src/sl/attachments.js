// attachments.js -- los puntos de anclaje (attachment points) del avatar.
//
// Port literal de los 55 <attachment_point> de avatar_lad.xml (version 2.0).
// Cada uno dice a que articulacion del esqueleto se cuelga un objeto, con que
// desplazamiento y giro locales (en SL: grados "Maya", milimetros -> metros) y
// a que "grupo" pertenece (de ahi salen los menus de anclaje del visor).
// Un objeto colgado de ATTACH_RHAND, por ejemplo, va con la mano derecha.
//
// `attachToSkeleton` crea el nodo intermedio: el hueso -> nodo de anclaje ->
// objeto, ya en el marco del visor, para que al animar el esqueleto el adjunto
// siga a la articulacion sin mas trabajo.

import { jointIndex, slVecToAvatar, slQuatToAvatar, buildSkeleton } from "./skeleton.js";
import { mayaQ } from "./anim.js";

// Respaldo para las articulaciones que el visor crea y no estan en
// avatar_skeleton.xml (mRoot, mScreen): se cuelgan del tronco, que es lo mas
// parecido al centro del avatar.
const FALLBACK_JOINT = "mPelvis";

export const SL_ATTACHMENT_POINTS = [
  { id: 1, location: "ATTACH_CHEST", name: "Chest", joint: "mChest", position: [0.15, 0, -0.1], rotation: [0, 90, 90], group: 6, pieSlice: 2, firstPerson: true },
  { id: 2, location: "ATTACH_HEAD", name: "Skull", joint: "mHead", position: [0, 0, 0.15], rotation: [0, 0, 90], group: 2, pieSlice: 2, firstPerson: false },
  { id: 3, location: "ATTACH_LSHOULDER", name: "Left Shoulder", joint: "mCollarLeft", position: [0, 0, 0.08], rotation: [0, 0, 0], group: 3, pieSlice: 3, firstPerson: true },
  { id: 4, location: "ATTACH_RSHOULDER", name: "Right Shoulder", joint: "mCollarRight", position: [0, 0, 0.08], rotation: [0, 0, 0], group: 1, pieSlice: 1, firstPerson: true },
  { id: 5, location: "ATTACH_LHAND", name: "Left Hand", joint: "mWristLeft", position: [0, 0.08, -0.02], rotation: [0, 0, 0], group: 4, pieSlice: 0, firstPerson: true, maxOffset: 1.5 },
  { id: 6, location: "ATTACH_RHAND", name: "Right Hand", joint: "mWristRight", position: [0, -0.08, -0.02], rotation: [0, 0, 0], group: 0, pieSlice: 0, firstPerson: true, maxOffset: 1.5 },
  { id: 7, location: "ATTACH_LFOOT", name: "Left Foot", joint: "mFootLeft", position: [0, 0, 0], rotation: [0, 0, 0], group: 5, pieSlice: 6, firstPerson: true },
  { id: 8, location: "ATTACH_RFOOT", name: "Right Foot", joint: "mFootRight", position: [0, 0, 0], rotation: [0, 0, 0], group: 7, pieSlice: 6, firstPerson: true },
  { id: 9, location: "ATTACH_BACK", name: "Spine", joint: "mChest", position: [-0.15, 0, -0.1], rotation: [0, -90, 90], group: 6, pieSlice: 7, firstPerson: true },
  { id: 10, location: "ATTACH_PELVIS", name: "Pelvis", joint: "mPelvis", position: [0, 0, -0.15], rotation: [0, 0, 0], group: 6, pieSlice: 6, firstPerson: true },
  { id: 11, location: "ATTACH_MOUTH", name: "Mouth", joint: "mHead", position: [0.12, 0, 0.001], rotation: [0, 0, 0], group: 2, pieSlice: 6, firstPerson: false },
  { id: 12, location: "ATTACH_CHIN", name: "Chin", joint: "mHead", position: [0.12, 0, -0.04], rotation: [0, 0, 0], group: 2, pieSlice: 7, firstPerson: false },
  { id: 13, location: "ATTACH_LEAR", name: "Left Ear", joint: "mHead", position: [0.015, 0.08, 0.017], rotation: [0, 0, 0], group: 2, pieSlice: 4, firstPerson: false },
  { id: 14, location: "ATTACH_REAR", name: "Right Ear", joint: "mHead", position: [0.015, -0.08, 0.017], rotation: [0, 0, 0], group: 2, pieSlice: 0, firstPerson: false },
  { id: 15, location: "ATTACH_LEYE", name: "Left Eyeball", joint: "mEyeLeft", position: [0, 0, 0], rotation: [0, 0, 0], group: 2, pieSlice: 3, firstPerson: false },
  { id: 16, location: "ATTACH_REYE", name: "Right Eyeball", joint: "mEyeRight", position: [0, 0, 0], rotation: [0, 0, 0], group: 2, pieSlice: 1, firstPerson: false },
  { id: 17, location: "ATTACH_NOSE", name: "Nose", joint: "mHead", position: [0.1, 0, 0.05], rotation: [0, 0, 0], group: 2, pieSlice: 5, firstPerson: false },
  { id: 18, location: "ATTACH_RUARM", name: "R Upper Arm", joint: "mShoulderRight", position: [0.01, -0.13, 0.01], rotation: [0, 0, 0], group: 1, pieSlice: 0, firstPerson: true },
  { id: 19, location: "ATTACH_RLARM", name: "R Forearm", joint: "mElbowRight", position: [0, -0.12, 0], rotation: [0, 0, 0], group: 1, pieSlice: 7, firstPerson: true },
  { id: 20, location: "ATTACH_LUARM", name: "L Upper Arm", joint: "mShoulderLeft", position: [0.01, 0.15, -0.01], rotation: [0, 0, 0], group: 3, pieSlice: 4, firstPerson: true },
  { id: 21, location: "ATTACH_LLARM", name: "L Forearm", joint: "mElbowLeft", position: [0, 0.113, 0], rotation: [0, 0, 0], group: 3, pieSlice: 5, firstPerson: true },
  { id: 22, location: "ATTACH_RHIP", name: "Right Hip", joint: "mHipRight", position: [0, 0, 0], rotation: [0, 0, 0], group: 7, pieSlice: 1, firstPerson: true },
  { id: 23, location: "ATTACH_RULEG", name: "R Upper Leg", joint: "mHipRight", position: [-0.017, 0.041, -0.31], rotation: [0, 0, 0], group: 7, pieSlice: 0, firstPerson: true },
  { id: 24, location: "ATTACH_RLLEG", name: "R Lower Leg", joint: "mKneeRight", position: [-0.044, -0.007, -0.262], rotation: [0, 0, 0], group: 7, pieSlice: 7, firstPerson: true },
  { id: 25, location: "ATTACH_LHIP", name: "Left Hip", joint: "mHipLeft", position: [0, 0, 0], rotation: [0, 0, 0], group: 5, pieSlice: 3, firstPerson: true },
  { id: 26, location: "ATTACH_LULEG", name: "L Upper Leg", joint: "mHipLeft", position: [-0.019, -0.034, -0.31], rotation: [0, 0, 0], group: 5, pieSlice: 4, firstPerson: true },
  { id: 27, location: "ATTACH_LLLEG", name: "L Lower Leg", joint: "mKneeLeft", position: [-0.044, -0.007, -0.261], rotation: [0, 0, 0], group: 5, pieSlice: 5, firstPerson: true },
  { id: 28, location: "ATTACH_BELLY", name: "Stomach", joint: "mPelvis", position: [0.092, 0, 0.088], rotation: [0, 0, 0], group: 6, pieSlice: 5, firstPerson: true },
  { id: 29, location: "ATTACH_LEFT_PEC", name: "Left Pec", joint: "mTorso", position: [0.104, 0.082, 0.247], rotation: [0, 0, 0], group: 6, pieSlice: 3, firstPerson: true },
  { id: 30, location: "ATTACH_RIGHT_PEC", name: "Right Pec", joint: "mTorso", position: [0.104, -0.082, 0.247], rotation: [0, 0, 0], group: 6, pieSlice: 1, firstPerson: true },
  { id: 31, location: "ATTACH_HUD_CENTER_2", name: "Center 2", joint: "mScreen", position: [0, 0, 0], rotation: [0, 0, 0], group: 9, pieSlice: 0, firstPerson: true, maxOffset: 2 },
  { id: 32, location: "ATTACH_HUD_TOP_RIGHT", name: "Top Right", joint: "mScreen", position: [0, -0.5, 0.5], rotation: [0, 0, 0], group: 9, pieSlice: 0, firstPerson: true, maxOffset: 2 },
  { id: 33, location: "ATTACH_HUD_TOP_CENTER", name: "Top", joint: "mScreen", position: [0, 0, 0.5], rotation: [0, 0, 0], group: 9, pieSlice: 0, firstPerson: true, maxOffset: 2 },
  { id: 34, location: "ATTACH_HUD_TOP_LEFT", name: "Top Left", joint: "mScreen", position: [0, 0.5, 0.5], rotation: [0, 0, 0], group: 9, pieSlice: 0, firstPerson: true, maxOffset: 2 },
  { id: 35, location: "ATTACH_HUD_CENTER_1", name: "Center", joint: "mScreen", position: [0, 0, 0], rotation: [0, 0, 0], group: 9, pieSlice: 0, firstPerson: true, maxOffset: 2 },
  { id: 36, location: "ATTACH_HUD_BOTTOM_LEFT", name: "Bottom Left", joint: "mScreen", position: [0, 0.5, -0.5], rotation: [0, 0, 0], group: 9, pieSlice: 0, firstPerson: true, maxOffset: 2 },
  { id: 37, location: "ATTACH_HUD_BOTTOM", name: "Bottom", joint: "mScreen", position: [0, 0, -0.5], rotation: [0, 0, 0], group: 9, pieSlice: 0, firstPerson: true, maxOffset: 2 },
  { id: 38, location: "ATTACH_HUD_BOTTOM_RIGHT", name: "Bottom Right", joint: "mScreen", position: [0, -0.5, -0.5], rotation: [0, 0, 0], group: 9, pieSlice: 0, firstPerson: true, maxOffset: 2 },
  { id: 39, location: "ATTACH_NECK", name: "Neck", joint: "mNeck", position: [0, 0, 0], rotation: [0, 0, 0], group: 6, pieSlice: 1, firstPerson: true },
  { id: 40, location: "ATTACH_AVATAR_CENTER", name: "Avatar Center", joint: "mRoot", position: [0, 0, 0], rotation: [0, 0, 0], group: 6, pieSlice: 2, firstPerson: true },
  { id: 41, location: "ATTACH_LHAND_RING1", name: "Left Ring Finger", joint: "mHandRing1Left", position: [-0.006, 0.019, -0.002], rotation: [0, 0, 0], group: 8, pieSlice: 0, firstPerson: true },
  { id: 42, location: "ATTACH_RHAND_RING1", name: "Right Ring Finger", joint: "mHandRing1Right", position: [-0.006, -0.019, -0.002], rotation: [0, 0, 0], group: 8, pieSlice: 1, firstPerson: true },
  { id: 43, location: "ATTACH_TAIL_BASE", name: "Tail Base", joint: "mTail1", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 2, firstPerson: true },
  { id: 44, location: "ATTACH_TAIL_TIP", name: "Tail Tip", joint: "mTail6", position: [-0.025, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 3, firstPerson: true },
  { id: 45, location: "ATTACH_LWING", name: "Left Wing", joint: "mWing4Left", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 4, firstPerson: true },
  { id: 46, location: "ATTACH_RWING", name: "Right Wing", joint: "mWing4Right", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 5, firstPerson: true },
  { id: 47, location: "ATTACH_FACE_JAW", name: "Jaw", joint: "mFaceJaw", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 6, firstPerson: false },
  { id: 48, location: "ATTACH_FACE_LEAR", name: "Alt Left Ear", joint: "mFaceEar1Left", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 7, firstPerson: false },
  { id: 49, location: "ATTACH_FACE_REAR", name: "Alt Right Ear", joint: "mFaceEar1Right", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 8, firstPerson: false },
  { id: 50, location: "ATTACH_FACE_LEYE", name: "Alt Left Eye", joint: "mFaceEyeAltLeft", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 9, firstPerson: false },
  { id: 51, location: "ATTACH_FACE_REYE", name: "Alt Right Eye", joint: "mFaceEyeAltRight", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 10, firstPerson: false },
  { id: 52, location: "ATTACH_FACE_TONGUE", name: "Tongue", joint: "mFaceTongueTip", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 11, firstPerson: false },
  { id: 53, location: "ATTACH_GROIN", name: "Groin", joint: "mGroin", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 12, firstPerson: true },
  { id: 54, location: "ATTACH_HIND_LFOOT", name: "Left Hind Foot", joint: "mHindLimb4Left", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 13, firstPerson: true },
  { id: 55, location: "ATTACH_HIND_RFOOT", name: "Right Hind Foot", joint: "mHindLimb4Right", position: [0, 0, 0], rotation: [0, 0, 0], group: 8, pieSlice: 14, firstPerson: true },
];

export const ATTACHMENT_BY_LOCATION = new Map(SL_ATTACHMENT_POINTS.map((p) => [p.location, p]));
export const ATTACHMENT_BY_ID = new Map(SL_ATTACHMENT_POINTS.map((p) => [p.id, p]));
export const ATTACHMENT_BY_NAME = new Map(SL_ATTACHMENT_POINTS.map((p) => [p.name, p]));

// Nombres de los grupos de anclaje (los usa el visor para los menus).
export const ATTACHMENT_GROUP_NAMES = {
  0: "Mano derecha", 1: "Brazo derecho", 2: "Cabeza", 3: "Brazo izquierdo",
  4: "Mano izquierda", 5: "Pierna izquierda", 6: "Torso", 7: "Pierna derecha",
  8: "Extras", 9: "HUD",
};

// Busca un punto por localizacion ("ATTACH_HEAD"), por id (2) o por nombre
// ("Skull").
export function attachmentPoint(ref) {
  if (ref === null || ref === undefined) return null;
  if (typeof ref === "number") return ATTACHMENT_BY_ID.get(ref) || null;
  const s = String(ref);
  return ATTACHMENT_BY_LOCATION.get(s) || ATTACHMENT_BY_LOCATION.get("ATTACH_" + s.toUpperCase())
    || ATTACHMENT_BY_NAME.get(s) || null;
}

// Articulacion que de verdad usa un punto de anclaje (con respaldo para las que
// no estan en el esqueleto base).
export function attachmentJoint(point, joints) {
  const has = joints ? joints.has(point.joint) : jointIndex(point.joint) >= 0;
  return has ? point.joint : FALLBACK_JOINT;
}

// Desplazamiento y giro del anclaje, ya en el marco del visor, listos para un
// THREE.Object3D hijo del hueso.
export function attachmentLocalTransform(point) {
  return {
    position: slVecToAvatar(point.position),
    quaternion: slQuatToAvatar(mayaQ(point.rotation[0], point.rotation[1], point.rotation[2], "XYZ")),
  };
}

// Cuelga `object` (o devuelve el nodo vacio) del punto de anclaje `ref` del
// esqueleto `binding` (lo que devuelve buildSkeleton).
export function attachToSkeleton(THREE, binding, ref, object, opts = {}) {
  const point = typeof ref === "object" && ref !== null ? ref : attachmentPoint(ref);
  if (!point) return null;
  const jointName = attachmentJoint(point, binding.byName);
  const bone = binding.byName.get(jointName);
  if (!bone) return null;
  const local = attachmentLocalTransform(point);
  const holder = new THREE.Group();
  holder.name = "anclaje:" + point.location;
  holder.position.fromArray(local.position);
  holder.quaternion.fromArray(local.quaternion);
  if (opts.scale) holder.scale.fromArray(opts.scale);
  bone.add(holder);
  if (object) holder.add(object);
  holder.userData.attachmentPoint = point;
  return holder;
}

// Tabla legible (para el autotest y para depurar).
export function attachmentTable() {
  return SL_ATTACHMENT_POINTS.map((p) => p.id + " " + p.location + " -> " + p.joint + " (" + p.name + ")");
}

// --- autotest -----------------------------------------------------------------

export function runAttachmentSelfTest(THREE) {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });

  ok("55 puntos de anclaje", SL_ATTACHMENT_POINTS.length === 55, SL_ATTACHMENT_POINTS.length);
  ok("ids unicos", new Set(SL_ATTACHMENT_POINTS.map((p) => p.id)).size === 55);
  ok("localizaciones unicas", new Set(SL_ATTACHMENT_POINTS.map((p) => p.location)).size === 55);
  ok("todas tienen articulacion", SL_ATTACHMENT_POINTS.every((p) => !!p.joint));

  const head = attachmentPoint("ATTACH_HEAD");
  ok("busca por localizacion", !!head && head.joint === "mHead" && head.name === "Skull");
  ok("busca por id", attachmentPoint(5).location === "ATTACH_LHAND");
  ok("busca por nombre", attachmentPoint("Skull").id === 2);
  ok("busca sin prefijo", attachmentPoint("rhand").location === "ATTACH_RHAND");
  ok("no inventa", attachmentPoint("ATTACH_NOPE") === null);

  ok("mano derecha: hueso y desplazamiento",
    attachmentPoint("ATTACH_RHAND").joint === "mWristRight" &&
    attachmentPoint("ATTACH_RHAND").position.join(",") === "0,-0.08,-0.02");
  ok("brazo izquierdo: cuelga del codo",
    attachmentPoint("ATTACH_LLARM").joint === "mElbowLeft");

  // Las unicas que no estan en avatar_skeleton.xml (las crea el visor) son mRoot
  // y mScreen; el resto tiene que existir.
  const missing = SL_ATTACHMENT_POINTS.filter((p) => jointIndex(p.joint) < 0).map((p) => p.joint);
  ok("solo faltan mRoot y mScreen", missing.every((n) => n === "mRoot" || n === "mScreen"), missing.join(","));
  ok("respaldo para mRoot (centro del avatar)",
    attachmentJoint(attachmentPoint("ATTACH_AVATAR_CENTER")) === "mPelvis");
  ok("la mayoria resuelve a un hueso real",
    SL_ATTACHMENT_POINTS.filter((p) => jointIndex(p.joint) >= 0).length >= 45);

  // El anclaje tiene que ser un desplazamiento local finito y con la rotacion
  // pedida (90 grados en el eje Z de SL = 90 en el eje vertical del visor).
  const t = attachmentLocalTransform(attachmentPoint("ATTACH_HEAD"));
  ok("transformada local finita", t.position.every(Number.isFinite) && t.quaternion.every(Number.isFinite));
  ok("cabeza: el anclaje sube 0.15 m", Math.abs(t.position[1] - 0.15) < 1e-6, t.position.join(","));
  ok("cuaternion normalizado", Math.abs(Math.hypot(...t.quaternion) - 1) < 1e-5);

  if (THREE) {
    const binding = buildSkeleton(THREE);
    const holder = attachToSkeleton(THREE, binding, "ATTACH_RHAND", null);
    ok("three: crea el nodo de anclaje", !!holder && holder.parent === binding.byName.get("mWristRight"));
    binding.root.updateMatrixWorld(true);
    const wp = new THREE.Vector3();
    holder.getWorldPosition(wp);
    const wrist = new THREE.Vector3();
    binding.byName.get("mWristRight").getWorldPosition(wrist);
    ok("three: el anclaje cae junto a la muneca (< 0.25 m)", wp.distanceTo(wrist) < 0.25, wp.distanceTo(wrist).toFixed(4));
    ok("three: el anclaje esta a la altura de la mano (y>0.9)", wp.y > 0.9, wp.y.toFixed(3));

    const before = wp.clone();
    binding.byName.get("mWristRight").rotation.z += 0.6;
    binding.root.updateMatrixWorld(true);
    const wp2 = new THREE.Vector3();
    holder.getWorldPosition(wp2);
    ok("three: al girar la muneca el anclaje se mueve", wp2.distanceTo(before) > 0.02, wp2.distanceTo(before).toFixed(4));
  } else {
    ok("three: sin THREE se salta la parte de dibujo", true);
  }

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "attachments selftest: all " + checks.length + " checks passed"
      : "attachments selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
