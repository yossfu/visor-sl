// avatarPose.js -- poses y animaciones escritas a mano para el avatar REAL.
//
// `anim.js` reproduce animaciones de SL (ficheros `.anim`), que traen, por cada
// articulación, su rotación **local absoluta** en el marco de la articulación.
// Escribir eso a mano es incómodo: aquí se autora al revés, en el marco del
// visor (Y arriba, el avatar mira a -Z, +X es su derecha) y girando cada
// articulación alrededor de los **ejes del mundo**, medidos sobre la POSE DE
// REPOSO del esqueleto:
//
//   x  eje derecha (rojo)   + gira hacia delante
//   y  eje arriba (verde)   + gira hacia la izquierda del avatar
//   z  eje atrás (azul)     + rueda hacia la derecha del avatar
//
// Los ejes se aplican primero x, luego y, luego z (los tres sobre los ejes
// fijos del mundo). Ese orden importa: en la pose de reposo el cuerpo de SL está
// en **T** (los brazos horizontales, medido sobre `avatar_skeleton.xml`:
// mShoulderLeft y mElbowLeft los dos a y=1.521), así que "bajar los brazos" es
// un giro sobre Z y "mecerlos hacia delante" uno sobre Y:
//
//   piernas (apuntan hacia abajo)   x adelante/atrás · la rodilla se dobla con -x
//   brazos (apuntan hacia los lados en la T)
//     brazo derecho   z baja (-90 = vertical) · y adelante · codo con +y
//     brazo izquierdo z baja (+90 = vertical) · y adelante · codo con -y
//   cuello/cabeza y columna         x asiente · y gira · z ladera
//
// Tres ángulos en grados por fotograma bastan para describir andar, saludar,
// sentarse o respirar, y el resultado es un objeto con la forma que espera
// `Animator.play` (lo mismo que devuelve `parseAnim`). Traducir a SL es cosa de
// `avatarQuatToSl`, y la posición (solo la pelvis) de `avatarVecToSl`.
//
// Este módulo es el sustituto de las animaciones del inventario cuando todavía
// no hay sesión con el retransmisor: con una sesión abierta, las animaciones
// reales llegan como activos `RES.ANIM` y se reproducen tal cual.

import { jointIndex, SL_JOINTS, avatarQuatToSl, avatarVecToSl } from "./skeleton.js";
import { JOINT_PRIORITY, quatMul, quatNormalize } from "./anim.js";

const DEG = Math.PI / 180;

// Cuaternión de un giro de `angle` radianes alrededor de un eje del marco del
// visor (el eje se normaliza).
export function axisAngleQuat(axis, angle) {
  const [ax, ay, az] = axis;
  const len = Math.hypot(ax, ay, az) || 1;
  const h = angle * 0.5;
  const s = Math.sin(h) / len;
  return [ax * s, ay * s, az * s, Math.cos(h)];
}

// Giro compuesto del visor: primero x, luego y, luego z (los tres sobre los ejes
// del mundo). Se premultiplica, así que cada giro se aplica en el marco fijo.
export function eulerQuat(xDeg, yDeg, zDeg) {
  const qx = axisAngleQuat([1, 0, 0], xDeg * DEG);
  const qy = axisAngleQuat([0, 1, 0], yDeg * DEG);
  const qz = axisAngleQuat([0, 0, 1], zDeg * DEG);
  return quatMul(qz, quatMul(qy, qx));
}

// Cuaternión del MUNDO en reposo de cada articulación (se calcula subiendo por
// los padres). La versión 2.0 del esqueleto no tiene rotaciones de reposo, así
// que casi todos salen la identidad, pero el cálculo es general.
function makeRestWorldQuats(binding) {
  const cache = new Map();
  const quatOf = (bone) => (bone.userData && bone.userData.rest ? bone.userData.rest.rot : bone.quaternion.toArray());
  const chain = (bone) => {
    if (!bone) return [0, 0, 0, 1];
    const key = bone.uuid || bone.name;
    if (cache.has(key)) return cache.get(key);
    const local = quatOf(bone);
    const parent = bone.parent && bone.parent.isBone ? chain(bone.parent) : [0, 0, 0, 1];
    const world = quatNormalize(quatMul(parent, local));
    cache.set(key, world);
    return world;
  };
  for (const bone of binding.bones) chain(bone);
  return cache;
}

// Rotación local (en el marco de SL, lista para `anim.js`) que hace que la
// articulación quede girada `qWorld` respecto a su orientación de reposo, con el
// giro medido sobre los ejes del MUNDO del avatar.
//
//   M_local = R_padre · R_local        (en reposo)
//   queremos  R_padre · R_local' = qWorld · R_padre · R_local
//   => R_local' = qWorld · R_local    (en el marco del padre)
//   y como se guarda en local:  R_local' = conj(R_padre) · qWorld · R_padre · R_local
export function localRotationFor(binding, jointName, qWorld, restCache) {
  const bone = binding.byName.get(jointName);
  if (!bone) return [0, 0, 0, 1];
  const cache = restCache || makeRestWorldQuats(binding);
  const parentWorld = bone.parent && bone.parent.isBone ? cache.get(bone.parent.uuid || bone.parent.name) || [0, 0, 0, 1] : [0, 0, 0, 1];
  const localRest = bone.userData && bone.userData.rest ? bone.userData.rest.rot : bone.quaternion.toArray();
  const invParent = [-parentWorld[0], -parentWorld[1], -parentWorld[2], parentWorld[3]];
  const q = quatMul(quatMul(invParent, quatMul(qWorld, parentWorld)), localRest);
  return avatarQuatToSl(quatNormalize(q));
}

// Posición local (marco de SL) a partir de la posición que se quiere en el
// marco del avatar. Solo tiene sentido para la pelvis (es la única articulación
// cuyas claves de posición usa el visor).
export function localPositionFor(binding, jointName, avatarPos) {
  return avatarVecToSl(avatarPos);
}

// --- construcción de la animación -------------------------------------------

// Muestrea una función `(t) => {x,y,z}` (grados) en `rate` fotogramas por
// segundo y devuelve la lista de claves.
export function sampleFrames(fn, duration, rate = 24) {
  const n = Math.max(2, Math.round(duration * rate));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * duration;
    const v = fn(t) || {};
    out.push({ time: t, rot: eulerQuat(v.x || 0, v.y || 0, v.z || 0) });
  }
  return out;
}

// Arma una animación con la forma de `parseAnim`. `spec`:
//
//   duration      segundos
//   loop          ¿en bucle? (por defecto true)
//   loopIn/Out    puntos de bucle (por defecto 0 y duration)
//   easeIn/Out    duración del arranque/parada (por defecto 0)
//   basePriority  prioridad base (por defecto MEDIUM)
//   rotations     { mJoint: función(t) -> {x,y,z} } o { mJoint: [ {t,x,y,z} ] }
//   positions     { mJoint: función(t) -> {x,y,z} } (metros, absolutos en el
//                 marco del avatar: la pelvis en reposo está en (0, 1.067, 0))
//   rate          fotogramas por segundo al muestrear funciones (24)
//
// Devuelve un objeto listo para `Animator.play`.
export function buildPoseAnim(binding, spec) {
  const duration = spec.duration || 1;
  const restCache = makeRestWorldQuats(binding);
  const joints = [];
  const names = new Set([...Object.keys(spec.rotations || {}), ...Object.keys(spec.positions || {})]);

  for (const name of names) {
    const boneIndex = jointIndex(name);
    if (boneIndex < 0) throw new Error("avatarPose: articulación desconocida «" + name + "»");
    const canonical = SL_JOINTS[boneIndex].name;
    const joint = { name: canonical, sourceName: name, boneIndex, priority: JOINT_PRIORITY.USE_MOTION, rotations: [], positions: [] };

    const rotSpec = spec.rotations ? spec.rotations[name] : null;
    if (rotSpec) {
      const frames = Array.isArray(rotSpec)
        ? rotSpec.map((f) => ({ time: f.t, rot: eulerQuat(f.x || 0, f.y || 0, f.z || 0) }))
        : sampleFrames(rotSpec, duration, spec.rate);
      joint.rotations = frames.map((f) => ({ time: f.time, rot: localRotationFor(binding, canonical, f.rot, restCache) }));
    }

    const posSpec = spec.positions ? spec.positions[name] : null;
    if (posSpec) {
      const base = restAvatarPos(binding, canonical);
      const at = (v) => [base[0] + (v.x || 0), base[1] + (v.y || 0), base[2] + (v.z || 0)];
      if (Array.isArray(posSpec)) {
        joint.positions = posSpec.map((f) => ({ time: f.t, pos: localPositionFor(binding, canonical, at(f)) }));
      } else {
        const rate = spec.rate || 24;
        const n = Math.max(2, Math.round(duration * rate));
        for (let i = 0; i <= n; i++) {
          const t = (i / n) * duration;
          joint.positions.push({ time: t, pos: localPositionFor(binding, canonical, at(posSpec(t) || {})) });
        }
      }
    }

    joints.push(joint);
  }

  return {
    version: 1, subVersion: 0, oldVersion: false,
    basePriority: spec.basePriority === undefined ? JOINT_PRIORITY.MEDIUM : spec.basePriority,
    maxPriority: spec.basePriority === undefined ? JOINT_PRIORITY.MEDIUM : spec.basePriority,
    duration, emoteName: spec.name || "pose",
    loopInPoint: spec.loopIn === undefined ? 0 : spec.loopIn,
    loopOutPoint: spec.loopOut === undefined ? duration : spec.loopOut,
    loop: spec.loop === undefined ? true : !!spec.loop,
    easeInDuration: spec.easeIn || 0, easeOutDuration: spec.easeOut || 0,
    handPose: spec.handPose || 0, joints, constraints: [],
    sintetica: true,
  };
}

// Posición en reposo de una articulación en el marco del avatar (se recalcula
// con los huesos para no depender de la tabla).
function restAvatarPos(binding, jointName) {
  const bone = binding.byName.get(jointName);
  if (!bone) return [0, 0, 0];
  const p = [0, 0, 0];
  let b = bone;
  while (b) {
    const q = b.userData && b.userData.rest ? b.userData.rest.pos : [b.position.x, b.position.y, b.position.z];
    p[0] += q[0]; p[1] += q[1]; p[2] += q[2];
    b = b.parent && b.parent.isBone ? b.parent : null;
  }
  return p;
}

// --- animaciones de serie -----------------------------------------------------

// Respiración: el pecho sube y baja, los brazos se mecen y la pelvis se
// balancea un poco. Se usa cuando el avatar está quieto.
// Cuánto se bajan los brazos desde la T de reposo (90 sería pegados al cuerpo).
const ARM_DOWN = 78;

export function buildIdleAnim(binding, opts = {}) {
  const b = opts.breath === undefined ? 1 : opts.breath;
  const sway = opts.sway === undefined ? 1 : opts.sway;
  const down = (sign, k) => sign * (ARM_DOWN + k);
  return buildPoseAnim(binding, {
    name: "idle", duration: 4.0, loop: true, basePriority: JOINT_PRIORITY.LOW,
    rotations: {
      mChest: (t) => ({ x: -1.5 * b * Math.sin(t * Math.PI), y: 0, z: 0 }),
      mSpine2: (t) => ({ x: -0.8 * b * Math.sin(t * Math.PI - 0.4), y: 0, z: 0 }),
      mHead: (t) => ({ x: -1.2 * Math.sin(t * 0.7 + 1.0), y: 3.5 * Math.sin(t * 0.45), z: 1.0 * Math.sin(t * 0.31) }),
      mNeck: (t) => ({ x: 0.6 * Math.sin(t * 0.7 + 0.6), y: 1.5 * Math.sin(t * 0.45 + 0.3), z: 0 }),
      // Brazos: bajados de la T, con un balanceo pequeñito de respiración.
      mShoulderLeft: (t) => ({ x: 0, y: 1.4 * sway * Math.sin(t * 1.1), z: down(1, 1.5 * Math.sin(t * 1.1)) }),
      mShoulderRight: (t) => ({ x: 0, y: 1.4 * sway * Math.sin(t * 1.1 + 0.7), z: down(-1, 1.5 * Math.sin(t * 1.1 + 0.7)) }),
      mElbowLeft: (t) => ({ x: 0, y: -(9 + 3 * Math.sin(t * 0.9 + 0.4)), z: 0 }),
      mElbowRight: (t) => ({ x: 0, y: 9 + 3 * Math.sin(t * 0.9 + 1.4), z: 0 }),
      mPelvis: (t) => ({ x: 0.5 * Math.sin(t * 0.8), y: 1.2 * Math.sin(t * 0.5), z: 1.4 * sway * Math.sin(t * 0.8) }),
    },
    positions: {
      mPelvis: (t) => ({ x: 0.004 * sway * Math.sin(t * 0.8), y: 0.006 * b * Math.sin(t * Math.PI), z: 0 }),
    },
  });
}

// Ciclo de andar. `stride` en grados, `speed` es solo informativo (la cadencia
// va con la duración).
export function buildWalkAnim(binding, opts = {}) {
  const A = opts.stride === undefined ? 26 : opts.stride;   // cadera
  const B = opts.armSwing === undefined ? 22 : opts.armSwing;
  const K = opts.knee === undefined ? 52 : opts.knee;
  const P = Math.PI * 2;
  return buildPoseAnim(binding, {
    name: "walk", duration: opts.duration || 1.0, loop: true, basePriority: JOINT_PRIORITY.MEDIUM,
    rotations: {
      // Piernas: contrafase. La rodilla se dobla (hacia atrás) cuando la pierna
      // pasa por detrás y el pie se levanta.
      mHipLeft: (t) => ({ x: A * Math.sin(t * P), y: 0, z: 0 }),
      mHipRight: (t) => ({ x: -A * Math.sin(t * P), y: 0, z: 0 }),
      mKneeLeft: (t) => ({ x: -K * (0.5 - 0.5 * Math.cos(t * P + 2.6)), y: 0, z: 0 }),
      mKneeRight: (t) => ({ x: -K * (0.5 - 0.5 * Math.cos(t * P + 2.6 + Math.PI)), y: 0, z: 0 }),
      mAnkleLeft: (t) => ({ x: 8 * Math.sin(t * P + 1.2), y: 0, z: 0 }),
      mAnkleRight: (t) => ({ x: 8 * Math.sin(t * P + 1.2 + Math.PI), y: 0, z: 0 }),
      // Brazos: al revés que la pierna del mismo lado. Con los brazos bajados de
      // la T, mecerlos es girar sobre Y (los dos con el mismo signo, porque los
      // ejes de los dos hombros están espejados).
      mShoulderLeft: (t) => ({ x: 0, y: B * Math.sin(t * P), z: ARM_DOWN + 3 * Math.sin(t * P) }),
      mShoulderRight: (t) => ({ x: 0, y: B * Math.sin(t * P), z: -(ARM_DOWN + 3 * Math.sin(t * P)) }),
      mElbowLeft: (t) => ({ x: 0, y: -(20 + 12 * Math.sin(t * P + 0.5)), z: 0 }),
      mElbowRight: (t) => ({ x: 0, y: 20 + 12 * Math.sin(t * P + 0.5 + Math.PI), z: 0 }),
      // Torso y cabeza: un poco de contra-rotación para que no parezca un robot.
      mPelvis: (t) => ({ x: 1.5, y: 4.5 * Math.sin(t * P), z: 2.6 * Math.sin(t * P + Math.PI / 2) }),
      mTorso: (t) => ({ x: -2.0, y: -4.0 * Math.sin(t * P), z: 0 }),
      mChest: (t) => ({ x: -1.5, y: -2.0 * Math.sin(t * P), z: 0 }),
      mNeck: (t) => ({ x: 0.5, y: 1.5 * Math.sin(t * P), z: 0 }),
      mHead: (t) => ({ x: -1.0, y: 2.5 * Math.sin(t * P), z: 0 }),
    },
    positions: {
      mPelvis: (t) => ({
        x: 0.018 * Math.sin(t * P),
        y: 0.012 * Math.cos(2 * t * P) - 0.012,
        z: 0,
      }),
    },
  });
}

// Correr: como andar pero con más zancada, más rodilla, el torso inclinado y
// las dos fases de vuelo.
export function buildRunAnim(binding, opts = {}) {
  const A = opts.stride === undefined ? 38 : opts.stride;
  const B = opts.armSwing === undefined ? 42 : opts.armSwing;
  const K = opts.knee === undefined ? 85 : opts.knee;
  const P = Math.PI * 2;
  return buildPoseAnim(binding, {
    name: "run", duration: opts.duration || 0.72, loop: true, basePriority: JOINT_PRIORITY.MEDIUM,
    rotations: {
      mHipLeft: (t) => ({ x: A * Math.sin(t * P) + 6, y: 0, z: 0 }),
      mHipRight: (t) => ({ x: -A * Math.sin(t * P) + 6, y: 0, z: 0 }),
      mKneeLeft: (t) => ({ x: -K * (0.5 - 0.5 * Math.cos(t * P + 2.2)), y: 0, z: 0 }),
      mKneeRight: (t) => ({ x: -K * (0.5 - 0.5 * Math.cos(t * P + 2.2 + Math.PI)), y: 0, z: 0 }),
      mAnkleLeft: (t) => ({ x: 14 * Math.sin(t * P + 1.0), y: 0, z: 0 }),
      mAnkleRight: (t) => ({ x: 14 * Math.sin(t * P + 1.0 + Math.PI), y: 0, z: 0 }),
      mShoulderLeft: (t) => ({ x: 0, y: B * Math.sin(t * P), z: ARM_DOWN - 6 }),
      mShoulderRight: (t) => ({ x: 0, y: B * Math.sin(t * P), z: -(ARM_DOWN - 6) }),
      mElbowLeft: (t) => ({ x: 0, y: -(80 + 18 * Math.sin(t * P)), z: 0 }),
      mElbowRight: (t) => ({ x: 0, y: 80 + 18 * Math.sin(t * P + Math.PI), z: 0 }),
      // Torso inclinado hacia delante: en este marco inclinarse es girar con -x.
      mPelvis: (t) => ({ x: -2, y: 7 * Math.sin(t * P), z: 3 }),
      mSpine2: (t) => ({ x: -3, y: -3 * Math.sin(t * P), z: 0 }),
      mTorso: (t) => ({ x: -5, y: -7 * Math.sin(t * P), z: 0 }),
      mChest: (t) => ({ x: -3, y: -3 * Math.sin(t * P), z: 0 }),
      mNeck: (t) => ({ x: 7, y: 2 * Math.sin(t * P), z: 0 }),
      mHead: (t) => ({ x: 6, y: 3 * Math.sin(t * P), z: 0 }),
    },
    positions: {
      mPelvis: (t) => ({ x: 0.02 * Math.sin(t * P), y: 0.05 * Math.cos(2 * t * P) + 0.01, z: 0 }),
    },
  });
}

// Saludar con la mano derecha. La animación se basta sola: empieza y acaba con
// los brazos bajados, así que se puede solapar con «estar» o «andar» sin saltos
// (usa prioridad alta, o sea que gana mientras dura). Duración 2,6 s.
export function buildWaveAnim(binding, opts = {}) {
  const D = 2.6;
  // Sube el brazo entre 0,3 y ~0,9 s, lo mantiene y lo vuelve a bajar al final.
  const up = (t) => ramp(t, 0.30) * (1 - ramp(t, 2.05));
  // Aleteo de la mano: empieza cuando el brazo ya está arriba.
  const flap = (t) => Math.sin(Math.max(0, t - 0.75) * Math.PI * 3.4);
  return buildPoseAnim(binding, {
    name: "wave", duration: D, loop: false, basePriority: JOINT_PRIORITY.HIGH,
    rotations: {
      // z baja/levanta el brazo desde la T: -ARM_DOWN = colgando, +45 = por
      // encima de la horizontal.
      mShoulderRight: (t) => ({ x: 0, y: 14 * up(t), z: -ARM_DOWN + (ARM_DOWN + 45) * up(t) }),
      mElbowRight: (t) => ({ x: 0, y: 10 * up(t), z: (42 + 20 * flap(t)) * up(t) }),
      mWristRight: (t) => ({ x: 0, y: 0, z: 14 * flap(t) * up(t) }),
      mShoulderLeft: () => ({ x: 0, y: 0, z: ARM_DOWN }),
      mElbowLeft: () => ({ x: 0, y: -10, z: 0 }),
      mTorso: () => ({ x: 0, y: -6, z: 0 }),
      mNeck: () => ({ x: 0, y: -4, z: 0 }),
      mHead: () => ({ x: -3, y: -12, z: 4 }),
    },
  });
}

// Sentarse: la pelvis baja y se va atrás, los muslos van hacia delante y las
// rodillas se doblan. La altura de sentado de SL es ~1.067 - 0.45.
export function buildSitAnim(binding, opts = {}) {
  const hip = opts.hip === undefined ? 84 : opts.hip;
  const knee = opts.knee === undefined ? 88 : opts.knee;
  return buildPoseAnim(binding, {
    name: "sit", duration: 1.2, loop: false, basePriority: JOINT_PRIORITY.HIGH, easeIn: 0.4, easeOut: 0.4,
    rotations: {
      mHipLeft: () => ({ x: hip, y: 0, z: 5 }),
      mHipRight: () => ({ x: hip, y: 0, z: -5 }),
      mKneeLeft: () => ({ x: -knee, y: 0, z: 0 }),
      mKneeRight: () => ({ x: -knee, y: 0, z: 0 }),
      mAnkleLeft: () => ({ x: 12, y: 0, z: 0 }),
      mAnkleRight: () => ({ x: 12, y: 0, z: 0 }),
      mSpine2: () => ({ x: -3, y: 0, z: 0 }),
      mTorso: () => ({ x: -2, y: 0, z: 0 }),
      mShoulderLeft: () => ({ x: 0, y: 12, z: ARM_DOWN }),
      mShoulderRight: () => ({ x: 0, y: 12, z: -ARM_DOWN }),
      mElbowLeft: () => ({ x: 0, y: -55, z: 0 }),
      mElbowRight: () => ({ x: 0, y: 55, z: 0 }),
    },
    positions: {
      mPelvis: () => ({ x: 0, y: -0.45, z: -0.16 }),
    },
  });
}

// Una rampa suave que empieza en `from` y llega a 1.
function ramp(t, from) {
  if (t <= from) return 0;
  const u = Math.min(1, (t - from) / 0.45);
  return u * u * (3 - 2 * u);
}

// --- autotest -----------------------------------------------------------------

export function runAvatarPoseSelfTest() {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });

  ok("giro de 90 grados sobre X", Math.abs(axisAngleQuat([1, 0, 0], Math.PI / 2)[0] - Math.SQRT1_2) < 1e-9);
  ok("giro de 180 grados", Math.abs(axisAngleQuat([0, 1, 0], Math.PI)[3]) < 1e-9);
  const q = eulerQuat(0, 0, 0);
  ok("euler cero es la identidad", q[0] === 0 && q[1] === 0 && q[2] === 0 && q[3] === 1);
  ok("euler x de 90 gira sobre X", Math.abs(eulerQuat(90, 0, 0)[0] - Math.SQRT1_2) < 1e-9);
  ok("el orden es z·y·x", (() => {
    const a = eulerQuat(30, 60, 90);
    const e = quatMul(axisAngleQuat([0, 0, 1], Math.PI / 2), quatMul(axisAngleQuat([0, 1, 0], Math.PI / 3), axisAngleQuat([1, 0, 0], Math.PI / 6)));
    return a.every((v, i) => Math.abs(v - e[i]) < 1e-12);
  })());

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "avatarPose selftest: all " + checks.length + " checks passed"
      : "avatarPose selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
