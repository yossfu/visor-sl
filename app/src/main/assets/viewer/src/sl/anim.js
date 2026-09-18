// anim.js -- animaciones de Second Life (el activo ".anim").
//
// POR QUE HACE FALTA
// ------------------
// En SL una animacion NO es un fichero de esqueleto ni viene dentro de la malla:
// es un activo aparte que trae, por NOMBRE DE HUESO, una curva de rotaciones y
// otra de posiciones. "Baile 7" gira mHipLeft, mElbowRight o mHandMiddle1Left
// por su nombre, y como el esqueleto de `skeleton.js` tiene exactamente esos
// nombres, la animacion encaja sin traduccion. Todo el baile, el caminar, el
// sentarse o el "hola" de un avatar de SL es una de estas.
//
// El retransmisor pide el activo por su UUID y devuelve los bytes; aqui se
// convierten en rotaciones por hueso y se aplican al arbol de three.js, con el
// mismo reparto por prioridad que hace el visor cuando hay varias animaciones a
// la vez (una de "caminar" y otra de "bailar" en la misma pierna).
//
// FORMATO
// -------
// Port de `LLKeyframeMotion::deserialize` (indra/llcharacter/llkeyframemotion.cpp).
// Todo es little-endian (`LLDataPackerBinaryBuffer`):
//
//   U16 version, U16 subversion, S32 base_priority, F32 duration,
//   cadena terminada en 0 emote_name,
//   F32 loop_in_point, F32 loop_out_point, S32 loop,
//   F32 ease_in_duration, F32 ease_out_duration, U32 hand_pose, U32 num_joints
//   por articulacion:
//     cadena terminada en 0 joint_name, S32 joint_priority, S32 num_rot_keys,
//       por clave: U16 time, U16 x, U16 y, U16 z
//     S32 num_pos_keys,
//       por clave: U16 time, U16 x, U16 y, U16 z
//   S32 num_constraints, y por restriccion:
//     U8 chain_length, U8 constraint_type, 16 bytes source_volume,
//     F32 x3 source_offset, 16 bytes target_volume, F32 x3 target_offset,
//     F32 x3 target_dir, F32 ease_in_start, ease_in_stop, ease_out_start, ease_out_stop
//
// Los U16 se escalan: el tiempo de [0, duration], la posicion de
// [-5, +5] metros (`LL_MAX_PELVIS_OFFSET`), y la rotacion de [-1, 1]. Una
// rotacion se guarda como su vector (x,y,z) y se reconstruye
// `w = sqrt(1 - x^2 - y^2 - z^2)`: se ahorra el componente w porque el
// cuaternion esta normalizado (ver `LLQuaternion::packToVector3`).
//
// Hay una version antigua (0.1) que guarda tiempos y valores como F32 en vez de
// U16; se acepta tambien.
//
// MEZCLA
// ------
// Port de `LLJointStateBlender` (indra/llcharacter/llpose.cpp): por cada hueso
// se acumulan como mucho cuatro estados (uno por animacion), ordenados de mayor
// a menor prioridad; el de mas prioridad manda y los demas entran mezclados por
// su peso. El peso de cada animacion es 1, salvo en los tramos de arranque y
// parada (`ease_in_duration` / `ease_out_duration`), donde rampa de 0 a 1.
//
// LO QUE NO HACE (todavia)
// ------------------------
// Las restricciones ("constraints") de las animaciones son un IK de cadena
// (pies al suelo, manos a un punto) que el visor resuelve con un simulador de
// muelles. Aqui se leen y se guardan, pero no se aplican: sin ellas la pose es
// la del esqueleto puro, que es lo correcto para la mayoria de animaciones de
// cuerpo entero (bailes, poses, gestos). Ver TODO.md, Fase 9.

import { SL_JOINTS, jointIndex, slQuatToAvatar, slVecToAvatar, buildSkeleton } from "./skeleton.js";

export const ANIM_VERSION = 1;
export const ANIM_SUBVERSION = 0;

// Radio maximo del desplazamiento de la pelvis (metros). El visor lo define
// junto a la lectura de las claves de posicion.
export const MAX_PELVIS_OFFSET = 5.0;

// Prioridades (LLJoint::JointPriority, indra/llcharacter/lljoint.h).
export const JOINT_PRIORITY = {
  USE_MOTION: -1,   // usa la prioridad base de la animacion
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  HIGHER: 3,
  HIGHEST: 4,
  ADDITIVE: 7,      // a partir de aqui, se suma en vez de mezclar
};

// Estados que el visor acumula por hueso (JSB_NUM_JOINT_STATES).
export const MAX_STATES_PER_JOINT = 4;

const USE_MOTION_PRIORITY = JOINT_PRIORITY.USE_MOTION;
const ADDITIVE_PRIORITY = JOINT_PRIORITY.ADDITIVE;

// --- cuaterniones (x, y, z, w) ----------------------------------------------

export function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatConj(q) { return [-q[0], -q[1], -q[2], q[3]]; }

export function quatDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; }

export function quatNormalize(q) {
  const m = Math.hypot(q[0], q[1], q[2], q[3]);
  if (m < 1e-12) return [0, 0, 0, 1];
  return [q[0] / m, q[1] / m, q[2] / m, q[3] / m];
}

// Interpolacion lineal normalizada. Solo es correcta si `a` y `b` estan en el
// mismo hemisferio (el visor solo la usa en ese caso). Da prioridad a `b` (el
// estado de mas prioridad) cuando `t` es mayor: `lerp(t, a, b)`.
export function quatLerp(t, a, b) {
  return quatNormalize([
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
    a[3] + (b[3] - a[3]) * t,
  ]);
}

export function quatSlerp(t, a, b) {
  let d = quatDot(a, b);
  let bb = b;
  if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) return quatLerp(t, a, bb);
  const theta = Math.acos(Math.min(1, Math.max(-1, d)));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [
    a[0] * wa + bb[0] * wb,
    a[1] * wa + bb[1] * wb,
    a[2] * wa + bb[2] * wb,
    a[3] * wa + bb[3] * wb,
  ];
}

// `nlerp` de SL: si los cuaterniones estan en hemisferios opuestos usa slerp
// (que ya corrige el signo), y si no, una interpolacion lineal normalizada.
export function quatNlerp(t, a, b) {
  return quatDot(a, b) < 0 ? quatSlerp(t, a, b) : quatLerp(t, a, b);
}

// Port de `LLQuaternion::unpackFromVector3`: reconstruye w. No normaliza.
export function quatUnpackFromVec3(v) {
  const t = 1 - (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0], v[1], v[2], t > 0 ? Math.sqrt(t) : 0];
}

// Port de `LLQuaternion::packToVector3`: normaliza los cuatro componentes y, si
// w es negativo, cambia el signo de xyz (el cuaternion y su opuesto son la misma
// rotacion) para forzar w positivo al reconstruir.
export function quatPackToVec3(q) {
  const mag = Math.hypot(q[0], q[1], q[2], q[3]);
  let x = q[0], y = q[1], z = q[2];
  if (mag > 1e-6) { x /= mag; y /= mag; z /= mag; }
  return q[3] >= 0 ? [x, y, z] : [-x, -y, -z];
}

// Port de `mayaQ`: rotacion de Maya a partir de angulos en grados y un orden de
// ejes ("XYZ", "ZYX"...). La usan las animaciones de version antigua y el
// contenedor del cuerpo de sistema.
export function mayaQ(xDeg, yDeg, zDeg, order = "XYZ") {
  const half = (d) => d * Math.PI / 360; // grados -> medio angulo
  const axisQ = (ang, ax) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    return ax === 0 ? [s, 0, 0, c] : ax === 1 ? [0, s, 0, c] : [0, 0, s, c];
  };
  const xQ = axisQ(half(xDeg), 0), yQ = axisQ(half(yDeg), 1), zQ = axisQ(half(zDeg), 2);
  switch (String(order).toUpperCase()) {
    case "YZX": return quatMul(quatMul(yQ, zQ), xQ);
    case "ZXY": return quatMul(quatMul(zQ, xQ), yQ);
    case "XZY": return quatMul(quatMul(xQ, zQ), yQ);
    case "YXZ": return quatMul(quatMul(yQ, xQ), zQ);
    case "ZYX": return quatMul(quatMul(zQ, yQ), xQ);
    default: return quatMul(quatMul(xQ, yQ), zQ);
  }
}

// --- lectura de bytes --------------------------------------------------------

class Reader {
  constructor(bytes) {
    this.b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.dv = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength);
    this.o = 0;
  }
  get left() { return this.b.length - this.o; }
  u8() { return this.dv.getUint8(this.o++); }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  s32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  // Cadena terminada en 0 (el `unpackString` del LLDataPacker binario).
  cstring() {
    let end = this.o;
    while (end < this.b.length && this.b[end] !== 0) end++;
    const s = new TextDecoder("utf-8", { fatal: false }).decode(this.b.subarray(this.o, end));
    this.o = Math.min(this.b.length, end + 1);
    return s;
  }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  fixedString(n) {
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    let end = 0;
    while (end < s.length && s[end] !== 0) end++;
    return new TextDecoder("utf-8", { fatal: false }).decode(s.subarray(0, end));
  }
}

const u16ToF32 = (v, min, max) => min + (max - min) * (v / 65535);
const f32ToU16 = (v, min, max) => {
  if (!isFinite(v)) return 0;
  const q = Math.round((v - min) / (max - min) * 65535);
  return Math.max(0, Math.min(65535, q));
};

// --- decodificacion ----------------------------------------------------------

// Lee un activo de animacion completo. `allowInvalidJoints` (por defecto si) se
// salta las articulaciones cuyo nombre no exista en nuestro esqueleto, igual que
// hace el visor cuando la animacion viene de otro avatar con huesos de mas.
export function parseAnim(bytes, opts = {}) {
  const r = new Reader(bytes);
  const version = r.u16();
  const subVersion = r.u16();
  const oldVersion = version === 0 && subVersion === 1;
  if (!oldVersion && (version !== ANIM_VERSION || subVersion !== ANIM_SUBVERSION)) {
    throw new Error("anim: version no soportada " + version + "." + subVersion);
  }

  let basePriority = r.s32();
  if (basePriority >= ADDITIVE_PRIORITY) basePriority = ADDITIVE_PRIORITY - 1;
  else if (basePriority < USE_MOTION_PRIORITY) throw new Error("anim: prioridad base invalida " + basePriority);

  const duration = r.f32();
  if (!isFinite(duration) || duration < 0) throw new Error("anim: duracion invalida " + duration);

  const emoteName = r.cstring();
  const loopIn = r.f32();
  const loopOut = r.f32();
  const loop = r.s32() !== 0;
  const easeIn = r.f32();
  const easeOut = r.f32();
  const handPose = r.u32();
  const numJoints = r.u32();

  const joints = [];
  let maxPriority = basePriority;
  for (let j = 0; j < numJoints; j++) {
    let name = r.cstring();
    const jointPriority = r.s32();
    if (jointPriority !== USE_MOTION_PRIORITY && jointPriority > maxPriority) maxPriority = jointPriority;

    const rotations = [];
    const numRot = r.s32();
    for (let k = 0; k < numRot; k++) {
      const time = oldVersion ? r.f32() : u16ToF32(r.u16(), 0, duration);
      let rot;
      if (oldVersion) rot = mayaQ(r.f32() * 180 / Math.PI, r.f32() * 180 / Math.PI, r.f32() * 180 / Math.PI, "ZYX");
      else rot = quatUnpackFromVec3([u16ToF32(r.u16(), -1, 1), u16ToF32(r.u16(), -1, 1), u16ToF32(r.u16(), -1, 1)]);
      // Duplicados: el visor los guarda en un mapa por tiempo, o sea que gana
      // la ultima clave leida con ese tiempo.
      if (rotations.length && rotations[rotations.length - 1].time === time) rotations.pop();
      rotations.push({ time, rot });
    }

    const positions = [];
    const numPos = r.s32();
    for (let k = 0; k < numPos; k++) {
      const time = oldVersion ? r.f32() : u16ToF32(r.u16(), 0, duration);
      let pos;
      if (oldVersion) pos = r.vec3().map((v) => Math.max(-MAX_PELVIS_OFFSET, Math.min(MAX_PELVIS_OFFSET, v)));
      else pos = [u16ToF32(r.u16(), -MAX_PELVIS_OFFSET, MAX_PELVIS_OFFSET), u16ToF32(r.u16(), -MAX_PELVIS_OFFSET, MAX_PELVIS_OFFSET), u16ToF32(r.u16(), -MAX_PELVIS_OFFSET, MAX_PELVIS_OFFSET)];
      if (positions.length && positions[positions.length - 1].time === time) positions.pop();
      positions.push({ time, pos });
    }

    // El indice en el esqueleto del visor: -1 si no existe (se ignora).
    const boneIndex = jointIndex(name);
    if (boneIndex < 0 && !opts.allowInvalidJoints) throw new Error("anim: articulacion desconocida " + name);
    const canonical = boneIndex >= 0 ? SL_JOINTS[boneIndex].name : name;
    joints.push({ name: canonical, sourceName: name, boneIndex, priority: jointPriority, rotations, positions });
  }

  const constraints = [];
  const numConstraints = r.s32();
  if (numConstraints > 0 && numConstraints < 64) {
    for (let i = 0; i < numConstraints; i++) {
      const chainLength = r.u8();
      const type = r.u8();
      const sourceVolume = r.fixedString(16);
      const sourceOffset = r.vec3();
      const targetVolume = r.fixedString(16);
      const targetOffset = r.vec3();
      const targetDir = r.vec3();
      const cEaseInStart = r.f32(), cEaseInStop = r.f32();
      const cEaseOutStart = r.f32(), cEaseOutStop = r.f32();
      constraints.push({
        chainLength, type, sourceVolume, sourceOffset, targetVolume,
        targetOffset, targetDir, targetIsGround: targetVolume === "GROUND",
        easeInStart: cEaseInStart, easeInStop: cEaseInStop,
        easeOutStart: cEaseOutStart, easeOutStop: cEaseOutStop,
      });
    }
  } else if (numConstraints !== 0) {
    // Numero absurdo: el visor lo ignora y sigue.
  }

  return {
    version, subVersion, oldVersion, basePriority, maxPriority, duration, emoteName,
    loopInPoint: loopIn, loopOutPoint: loopOut, loop, easeInDuration: easeIn,
    easeOutDuration: easeOut, handPose, joints, constraints,
    bytesRead: r.o, byteLength: r.b.length, leftover: r.left,
  };
}

// --- escritura (para el autotest y para recomprimir) -------------------------

export function encodeAnim(motion) {
  const chunks = [];
  let len = 0;
  const put = (bytes) => { chunks.push(bytes); len += bytes.length; };
  const u8 = (v) => put(new Uint8Array([v & 0xff]));
  const u16 = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff, true); put(b); };
  const s32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v | 0, true); put(b); };
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); put(b); };
  const f32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); put(b); };
  const cstr = (s) => { put(new TextEncoder().encode(String(s))); u8(0); };
  const vec3 = (v) => { f32(v[0]); f32(v[1]); f32(v[2]); };
  const fixed = (s) => {
    const b = new Uint8Array(16);
    const t = new TextEncoder().encode(String(s)).subarray(0, 15);
    b.set(t, 0);
    put(b);
  };

  u16(ANIM_VERSION); u16(ANIM_SUBVERSION);
  s32(motion.basePriority | 0);
  f32(motion.duration);
  cstr(motion.emoteName || "");
  f32(motion.loopInPoint || 0);
  f32(motion.loopOutPoint || 0);
  s32(motion.loop ? 1 : 0);
  f32(motion.easeInDuration || 0);
  f32(motion.easeOutDuration || 0);
  u32(motion.handPose || 0);
  u32(motion.joints.length);

  for (const j of motion.joints) {
    cstr(j.name);
    s32(j.priority | 0);
    s32(j.rotations.length);
    for (const k of j.rotations) {
      u16(f32ToU16(k.time, 0, motion.duration));
      const v = quatPackToVec3(k.rot);
      u16(f32ToU16(Math.max(-1, Math.min(1, v[0])), -1, 1));
      u16(f32ToU16(Math.max(-1, Math.min(1, v[1])), -1, 1));
      u16(f32ToU16(Math.max(-1, Math.min(1, v[2])), -1, 1));
    }
    s32(j.positions.length);
    for (const k of j.positions) {
      u16(f32ToU16(k.time, 0, motion.duration));
      u16(f32ToU16(k.pos[0], -MAX_PELVIS_OFFSET, MAX_PELVIS_OFFSET));
      u16(f32ToU16(k.pos[1], -MAX_PELVIS_OFFSET, MAX_PELVIS_OFFSET));
      u16(f32ToU16(k.pos[2], -MAX_PELVIS_OFFSET, MAX_PELVIS_OFFSET));
    }
  }

  const cons = motion.constraints || [];
  s32(cons.length);
  for (const c of cons) {
    u8(c.chainLength || 0);
    u8(c.type || 0);
    fixed(c.sourceVolume || "");
    vec3(c.sourceOffset || [0, 0, 0]);
    fixed(c.targetVolume || "");
    vec3(c.targetOffset || [0, 0, 0]);
    vec3(c.targetDir || [0, 0, 0]);
    f32(c.easeInStart || 0); f32(c.easeInStop || 0);
    f32(c.easeOutStart || 0); f32(c.easeOutStop || 0);
  }

  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

// --- curvas ------------------------------------------------------------------

// Port de `RotationCurve::getValue`. Las claves van ordenadas por tiempo y hay
// al menos una. Si el tiempo cae entre dos, se interpola (nlerp).
export function sampleRotation(keys, time, duration) {
  if (!keys.length) return [0, 0, 0, 1];
  let right = 0;
  while (right < keys.length && keys[right].time < time) right++;
  if (right >= keys.length) return keys[keys.length - 1].rot;
  if (right === 0 || keys[right].time === time) return keys[right].rot;
  const before = keys[right - 1], after = keys[right];
  const span = after.time - before.time;
  if (span <= 0) return after.rot;
  return quatNlerp((time - before.time) / span, before.rot, after.rot);
}

export function samplePosition(keys, time) {
  if (!keys.length) return [0, 0, 0];
  let right = 0;
  while (right < keys.length && keys[right].time < time) right++;
  if (right >= keys.length) return keys[keys.length - 1].pos;
  if (right === 0 || keys[right].time === time) return keys[right].pos;
  const before = keys[right - 1], after = keys[right];
  const span = after.time - before.time;
  if (span <= 0) return after.pos;
  const u = (time - before.time) / span;
  return [
    before.pos[0] + (after.pos[0] - before.pos[0]) * u,
    before.pos[1] + (after.pos[1] - before.pos[1]) * u,
    before.pos[2] + (after.pos[2] - before.pos[2]) * u,
  ];
}

// --- reproduccion ------------------------------------------------------------

// Una animacion sonando. `time` va en segundos desde el arranque; `weight` es el
// peso con el que entra en la mezcla (0..1), modulado por los tramos de ease.
export class AnimInstance {
  constructor(parsed, opts = {}) {
    this.parsed = parsed;
    this.startTime = opts.startTime === undefined ? 0 : opts.startTime;
    this.timeScale = opts.timeScale === undefined ? 1 : opts.timeScale;
    this.priority = opts.priority === undefined ? parsed.basePriority : opts.priority;
    this.gain = opts.gain === undefined ? 1 : opts.gain;
    this.playing = true;
    this.stopping = false;
    this.stopAt = null;
    this.finished = false;
    this.time = 0;        // tiempo local ya con el bucle aplicado
    this.weight = 0;      // peso efectivo (con arranque/parada)
  }

  // Tiempo local (segundos dentro de [0, duration]), con el bucle del visor:
  // al pasar `loop_out_point` vuelve a `loop_in_point`.
  localTime(rawSeconds) {
    const p = this.parsed;
    let t = Math.max(0, rawSeconds - this.startTime) * this.timeScale;
    if (!p.loop) {
      if (this.stopAt !== null && t > this.stopAt) t = this.stopAt;
      return Math.min(t, p.duration);
    }
    const inP = p.loopInPoint, outP = p.loopOutPoint;
    if (p.duration === 0) return 0;
    if (t > outP) {
      const span = outP - inP;
      t = span === 0 ? outP : inP + ((t - outP) % span);
    }
    return t;
  }

  // Port del peso: entra de 0 a 1 durante `ease_in_duration` (solo al arrancar,
  // aunque la animacion sea en bucle) y sale de 1 a 0 durante
  // `ease_out_duration` antes del final (solo si no es en bucle, porque en un
  // bucle no hay "final"). `finished` avisa de que una animacion de una sola
  // pasada ya llego al final: el visor se queda en la ultima pose hasta que la
  // aplicacion la para, que es lo que hace `llStopAnimation`.
  update(rawSeconds) {
    if (!this.playing) return;
    this.time = this.localTime(rawSeconds);
    const p = this.parsed;
    const elapsed = Math.max(0, rawSeconds - this.startTime) * this.timeScale;
    if (!p.loop && elapsed >= p.duration) this.finished = true;
    let w = this.gain;
    if (p.easeInDuration > 0 && elapsed < p.easeInDuration) w *= elapsed / p.easeInDuration;
    const outStart = p.duration - p.easeOutDuration;
    if (!p.loop && p.easeOutDuration > 0 && this.time > outStart) {
      w *= Math.max(0, (p.duration - this.time) / p.easeOutDuration);
    }
    this.weight = Math.max(0, Math.min(1, w));
  }
}

// Port de `LLJointStateBlender`: mezcla los estados de un hueso. `rest` es la
// pose de reposo (a la que se vuelve cuando nadie anima ese hueso).
export function blendJointStates(states, rest) {
  let pos = rest.pos ? rest.pos.slice() : [0, 0, 0];
  let rot = rest.rot ? rest.rot.slice() : [0, 0, 0, 1];
  let posWeight = 0, rotWeight = 0;
  let hasPos = false, hasRot = false;
  let addedPos = [0, 0, 0];
  let addedRot = [0, 0, 0, 1];

  for (const st of states) {
    const w = st.weight;
    if (w === 0) continue;
    if (st.additive) {
      if (st.pos) {
        const nw = Math.min(1, w + posWeight);
        addedPos = [addedPos[0] + st.pos[0] * (nw - posWeight), addedPos[1] + st.pos[1] * (nw - posWeight), addedPos[2] + st.pos[2] * (nw - posWeight)];
        posWeight = nw;
      }
      if (st.rot) {
        const nw = Math.min(1, w + rotWeight);
        addedRot = quatMul(quatNlerp(nw - rotWeight, [0, 0, 0, 1], st.rot), addedRot);
        rotWeight = nw;
      }
      continue;
    }
    if (st.pos) {
      if (hasPos) {
        const nw = Math.min(1, w + posWeight);
        const u = posWeight / nw;
        pos = [st.pos[0] + (pos[0] - st.pos[0]) * u, st.pos[1] + (pos[1] - st.pos[1]) * u, st.pos[2] + (pos[2] - st.pos[2]) * u];
        posWeight = nw;
      } else {
        pos = st.pos.slice();
        posWeight = w;
        hasPos = true;
      }
    }
    if (st.rot) {
      if (hasRot) {
        const nw = Math.min(1, w + rotWeight);
        rot = quatNlerp(rotWeight / nw, st.rot, rot);
        rotWeight = nw;
      } else {
        rot = st.rot.slice();
        rotWeight = w;
        hasRot = true;
      }
    }
  }
  return {
    pos: [pos[0] + addedPos[0], pos[1] + addedPos[1], pos[2] + addedPos[2]],
    rot: quatMul(addedRot, rot),
    hasPos, hasRot,
  };
}

// Toca un conjunto de animaciones sobre un esqueleto. Cada fotograma:
//
//   1. se calcula el tiempo local y el peso de cada animacion;
//   2. se agrupan los estados por hueso (rotacion / posicion);
//   3. se mezclan por prioridad con el mismo algoritmo que el visor.
//
// `binding` es lo que devuelve `buildSkeleton`. Mover el contenedor del avatar
// (no las animaciones) es cosa de la fisica del avatar.
export class Animator {
  constructor(binding) {
    this.binding = binding;
    this.instances = [];
    this._ensureRest();
    // Por hueso, la lista de (instancia, curva) que lo anima. Se rehace cuando
    // cambia el conjunto de animaciones.
    this._index = new Map();
    this._indexDirty = true;
  }

  _ensureRest() {
    for (const bone of this.binding.bones) {
      if (!bone.userData.rest) {
        bone.userData.rest = {
          pos: [bone.position.x, bone.position.y, bone.position.z],
          rot: [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
        };
      }
    }
  }

  play(parsed, opts) {
    const inst = parsed instanceof AnimInstance ? parsed : new AnimInstance(parsed, opts);
    this.instances.push(inst);
    this._indexDirty = true;
    return inst;
  }

  stop(inst) {
    const i = this.instances.indexOf(inst);
    if (i >= 0) { this.instances.splice(i, 1); this._indexDirty = true; }
  }

  stopAll() {
    this.instances.length = 0;
    this._indexDirty = true;
  }

  _rebuildIndex() {
    this._index = new Map();
    for (const inst of this.instances) {
      for (const j of inst.parsed.joints) {
        if (j.boneIndex < 0) continue;
        let list = this._index.get(j.boneIndex);
        if (!list) { list = []; this._index.set(j.boneIndex, list); }
        list.push({ inst, joint: j });
      }
    }
    this._indexDirty = false;
  }

  // Aplica la mezcla. `nowSeconds` es el reloj del visor (segundos).
  apply(nowSeconds) {
    if (this._indexDirty) this._rebuildIndex();
    for (const inst of this.instances) inst.update(nowSeconds);

    for (const bone of this.binding.bones) {
      const rest = bone.userData.rest;
      const entries = this._index.get(bone.userData.jointIndex);
      if (!entries || !entries.length) {
        this._setPos(bone, rest.pos[0], rest.pos[1], rest.pos[2]);
        bone.quaternion.set(rest.rot[0], rest.rot[1], rest.rot[2], rest.rot[3]);
        continue;
      }
      const states = [];
      for (const { inst, joint } of entries) {
        if (!inst.playing || inst.weight <= 0) continue;
        const effPriority = joint.priority === USE_MOTION_PRIORITY ? inst.priority : joint.priority;
        const st = { priority: effPriority, weight: inst.weight, additive: effPriority >= ADDITIVE_PRIORITY };
        if (joint.rotations.length) st.rot = slQuatToAvatar(sampleRotation(joint.rotations, inst.time, inst.parsed.duration));
        if (joint.positions.length) {
          const p = samplePosition(joint.positions, inst.time);
          st.pos = slVecToAvatar(p);
        }
        // Solo interesan los que traen algo.
        if (st.rot || st.pos) states.push(st);
      }
      if (!states.length) {
        this._setPos(bone, rest.pos[0], rest.pos[1], rest.pos[2]);
        bone.quaternion.set(rest.rot[0], rest.rot[1], rest.rot[2], rest.rot[3]);
        continue;
      }
      // Orden estable por prioridad descendente (el visor guarda el de mas
      // prioridad en el slot 0 y, a igualdad, deja delante el primero que llego).
      states.sort((a, b) => b.priority - a.priority);
      const blended = blendJointStates(states.slice(0, MAX_STATES_PER_JOINT), rest);
      bone.quaternion.set(blended.rot[0], blended.rot[1], blended.rot[2], blended.rot[3]);
      // Las claves de posicion dan la traslacion LOCAL del hueso, en absoluto
      // (no un desplazamiento sobre la de reposo): asi es como el visor sienta a
      // un avatar -- la animacion de sentarse baja la pelvis por debajo de su
      // altura de reposo (1.067 m) -- y como mueve la pelvis al caminar.
      this._setPos(bone, blended.pos[0], blended.pos[1], blended.pos[2]);
    }
  }

  // Coloca un hueso anadiendo el desplazamiento que le haya puesto la forma del
  // avatar (`avatarMesh.applyBoneDeltas`). Asi una animacion no borra la
  // deformacion de los huesos de la cara.
  _setPos(bone, x, y, z) {
    const off = bone.userData.shapeOffset;
    if (off) bone.position.set(x + off[0], y + off[1], z + off[2]);
    else bone.position.set(x, y, z);
  }
}

// --- autotest -----------------------------------------------------------------

// Comprueba el decodificador de punta a punta y sin red: monta una animacion
// con `encodeAnim`, la vuelve a leer, contrasta todos los campos y las curvas,
// y la toca sobre un esqueleto de verdad para ver que el hueso gira y que la
// mezcla por prioridad se comporta como la del visor.
export function runAnimSelfTest(THREE) {
  const checks = [];
  const ok = (name, cond, extra) => checks.push({ name, pass: !!cond, extra });
  const deg = (d) => d * Math.PI / 180;
  const axisQuat = (ang, ax) => {
    const s = Math.sin(ang / 2), c = Math.cos(ang / 2);
    return ax === 0 ? [s, 0, 0, c] : ax === 1 ? [0, s, 0, c] : [0, 0, s, c];
  };
  const quatClose = (a, b, eps = 1e-3) => {
    const d1 = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
    const d2 = Math.hypot(a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]);
    return Math.min(d1, d2) < eps;
  };

  // 1) Cuaterniones.
  const qx = axisQuat(deg(40), 0);
  ok("unpack/pack conserva la rotacion", quatClose(quatUnpackFromVec3(quatPackToVec3(qx)), qx));
  const qNeg = [-qx[0], -qx[1], -qx[2], -qx[3]];
  ok("pack corrige el signo (w negativo)", quatClose(quatUnpackFromVec3(quatPackToVec3(qNeg)), qx));
  ok("mayaQ(90,0,0) = 90 grados en X", quatClose(mayaQ(90, 0, 0, "XYZ"), axisQuat(deg(90), 0)));
  ok("nlerp a mitad de camino", quatClose(quatNlerp(0.5, [0, 0, 0, 1], axisQuat(deg(90), 0)), axisQuat(deg(45), 0)));

  // 2) Una animacion de prueba: mPelvis se desplaza y gira, mTorso y mHead giran.
  const q40 = quatPackToVec3(axisQuat(deg(40), 2));
  const q80 = quatPackToVec3(axisQuat(deg(80), 2));
  const motion = {
    version: ANIM_VERSION, subVersion: ANIM_SUBVERSION,
    basePriority: JOINT_PRIORITY.MEDIUM, duration: 2.0, emoteName: "wave",
    loopInPoint: 0.25, loopOutPoint: 1.75, loop: true,
    easeInDuration: 0.2, easeOutDuration: 0.3, handPose: 1,
    joints: [
      {
        name: "mPelvis", priority: USE_MOTION_PRIORITY,
        rotations: [{ time: 0, rot: [0, 0, 0, 1] }, { time: 1, rot: quatUnpackFromVec3(q40) }, { time: 2, rot: [0, 0, 0, 1] }],
        positions: [{ time: 0, pos: [0, 0, 0] }, { time: 1, pos: [0, 0, 1.0] }, { time: 2, pos: [0, 0, 0] }],
      },
      {
        name: "mTorso", priority: JOINT_PRIORITY.HIGH,
        rotations: [{ time: 0, rot: [0, 0, 0, 1] }, { time: 2, rot: quatUnpackFromVec3(q80) }],
        positions: [],
      },
      { name: "mHead", priority: USE_MOTION_PRIORITY, rotations: [{ time: 0, rot: axisQuat(deg(-20), 0) }], positions: [] },
    ],
  };

  const bytes = encodeAnim(motion);
  ok("animacion: bytes escritos", bytes.length > 0, bytes.length + " B");

  const p = parseAnim(bytes);
  ok("cabecera: version", p.version === ANIM_VERSION && p.subVersion === ANIM_SUBVERSION);
  ok("cabecera: no es version antigua", p.oldVersion === false);
  ok("cabecera: prioridad base", p.basePriority === JOINT_PRIORITY.MEDIUM, p.basePriority);
  ok("cabecera: duracion", Math.abs(p.duration - 2) < 1e-6, p.duration);
  ok("cabecera: emote", p.emoteName === "wave", p.emoteName);
  ok("cabecera: bucle", p.loop === true && Math.abs(p.loopInPoint - 0.25) < 1e-4 && Math.abs(p.loopOutPoint - 1.75) < 1e-4);
  ok("cabecera: ease", Math.abs(p.easeInDuration - 0.2) < 1e-4 && Math.abs(p.easeOutDuration - 0.3) < 1e-4);
  ok("cabecera: pose de mano", p.handPose === 1);
  ok("cabecera: se leyo todo", p.leftover === 0, p.leftover);
  ok("articulaciones: 3", p.joints.length === 3, p.joints.length);

  const pelvis = p.joints[0], torso = p.joints[1], head = p.joints[2];
  ok("articulaciones: indices del esqueleto", pelvis.boneIndex === jointIndex("mPelvis") && torso.boneIndex === jointIndex("mTorso") && head.boneIndex === jointIndex("mHead"));
  ok("prioridad por articulacion", pelvis.priority === USE_MOTION_PRIORITY && torso.priority === JOINT_PRIORITY.HIGH);
  ok("claves de rotacion", pelvis.rotations.length === 3 && torso.rotations.length === 2 && head.rotations.length === 1);
  ok("claves de posicion", pelvis.positions.length === 3 && torso.positions.length === 0);
  ok("rotacion de clave (40 grados)", quatClose(pelvis.rotations[1].rot, quatUnpackFromVec3(q40), 2e-3));
  ok("tiempo de clave", Math.abs(pelvis.rotations[1].time - 1) < 1e-3, pelvis.rotations[1].time);
  ok("posicion de clave", Math.abs(pelvis.positions[1].pos[2] - 1.0) < 2e-3, pelvis.positions[1].pos.join(","));

  // 3) Curvas.
  ok("muestreo: en una clave", quatClose(sampleRotation(pelvis.rotations, 1, 2), quatUnpackFromVec3(q40)));
  ok("muestreo: interpolado a mitad", quatClose(sampleRotation(pelvis.rotations, 0.5, 2), quatUnpackFromVec3(quatPackToVec3(axisQuat(deg(20), 2))), 5e-3));
  ok("muestreo: antes de la primera clave", quatClose(sampleRotation(pelvis.rotations, -1, 2), [0, 0, 0, 1]));
  ok("muestreo: despues de la ultima", quatClose(sampleRotation(pelvis.rotations, 9, 2), [0, 0, 0, 1]));
  const posMid = samplePosition(pelvis.positions, 0.5);
  ok("posicion: interpolada a mitad", Math.abs(posMid[2] - 0.5) < 1e-3, posMid[2]);
  ok("curva vacia -> identidad", quatClose(sampleRotation([], 0, 1), [0, 0, 0, 1]));

  // 4) Bucle y pesos.
  const inst = new AnimInstance(p, { startTime: 0 });
  ok("bucle: dentro del tramo", Math.abs(inst.localTime(1.0) - 1.0) < 1e-9);
  ok("bucle: al pasar loop_out vuelve a loop_in", Math.abs(inst.localTime(1.75 + 0.5) - (0.25 + 0.5)) < 1e-9, inst.localTime(2.25));
  inst.update(0.1);
  ok("peso: rampa de arranque a mitad", Math.abs(inst.weight - 0.5) < 1e-6, inst.weight);
  inst.update(1.0);
  ok("peso: ya establecido", Math.abs(inst.weight - 1) < 1e-6, inst.weight);
  const once = new AnimInstance(parseAnim(encodeAnim({ ...motion, loop: false, loopInPoint: 0, loopOutPoint: 0 })), { startTime: 0 });
  once.update(1.95);
  ok("peso: rampa de parada", Math.abs(once.weight - (0.05 / 0.3)) < 1e-3, once.weight);
  once.update(3);
  ok("una sola pasada: marcada como terminada", once.finished === true);

  // 5) Mezcla por prioridad: dos animaciones en mTorso, gana la de mas prioridad.
  const low = parseAnim(encodeAnim({
    basePriority: JOINT_PRIORITY.LOW, duration: 1, joints: [{ name: "mTorso", priority: USE_MOTION_PRIORITY, rotations: [{ time: 0, rot: axisQuat(deg(90), 2) }], positions: [] }],
  }));
  const high = parseAnim(encodeAnim({
    basePriority: JOINT_PRIORITY.HIGHEST, duration: 1, joints: [{ name: "mTorso", priority: USE_MOTION_PRIORITY, rotations: [{ time: 0, rot: axisQuat(deg(-45), 2) }], positions: [] }],
  }));
  const blended = blendJointStates([
    { priority: high.basePriority, weight: 1, rot: slQuatToAvatar(axisQuat(deg(-45), 2)) },
    { priority: low.basePriority, weight: 1, rot: slQuatToAvatar(axisQuat(deg(90), 2)) },
  ], { rot: [0, 0, 0, 1] });
  ok("mezcla: gana la prioridad mas alta", quatClose(blended.rot, slQuatToAvatar(axisQuat(deg(-45), 2))), blended.rot.join(","));

  // 6) Sobre un esqueleto real.
  if (THREE) {
    const binding = buildSkeleton(THREE);
    const animator = new Animator(binding);
    const torsoBone = binding.byName.get("mTorso");
    const chestBone = binding.byName.get("mChest");
    const restChest = new THREE.Vector3();
    binding.root.updateMatrixWorld(true);
    chestBone.getWorldPosition(restChest);

    animator.play(high, { startTime: 0 });
    animator.apply(0.5);
    binding.root.updateMatrixWorld(true);
    ok("esqueleto: mTorso gira", quatClose(
      [torsoBone.quaternion.x, torsoBone.quaternion.y, torsoBone.quaternion.z, torsoBone.quaternion.w],
      slQuatToAvatar(axisQuat(deg(-45), 2)), 2e-3), [torsoBone.quaternion.x, torsoBone.quaternion.y, torsoBone.quaternion.z, torsoBone.quaternion.w].join(","));
    const nowChest = new THREE.Vector3();
    chestBone.getWorldPosition(nowChest);
    ok("esqueleto: el hijo se mueve con el hueso", nowChest.distanceTo(restChest) > 0.01, nowChest.distanceTo(restChest).toFixed(4));

    // Al parar, vuelve a la pose de reposo.
    animator.stopAll();
    animator.apply(1.0);
    ok("esqueleto: al parar vuelve al reposo", quatClose([torsoBone.quaternion.x, torsoBone.quaternion.y, torsoBone.quaternion.z, torsoBone.quaternion.w], [0, 0, 0, 1], 1e-6));

    // Posicion de la pelvis: la clave mueve el hueso.
    animator.play(p, { startTime: 0 });
    animator.apply(1.0);
    const pelvisBone = binding.byName.get("mPelvis");
    ok("esqueleto: la pelvis se desplaza (posicion absoluta)", Math.abs(pelvisBone.position.y - 1.0) < 2e-3, pelvisBone.position.y.toFixed(4));
  } else {
    ok("esqueleto: sin THREE se salta la parte de dibujo", true);
  }

  // 7) Una articulacion desconocida se puede tolerar.
  const extra = encodeAnim({
    basePriority: 1, duration: 1,
    joints: [{ name: "mHuesoInventado", priority: -1, rotations: [{ time: 0, rot: [0, 0, 0, 1] }], positions: [] }],
  });
  let threw = false;
  try { parseAnim(extra); } catch (e) { threw = true; }
  ok("articulacion desconocida: avisa", threw === true);
  const tolerant = parseAnim(extra, { allowInvalidJoints: true });
  ok("articulacion desconocida: se puede ignorar", tolerant.joints.length === 1 && tolerant.joints[0].boneIndex === -1);

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "anim selftest: all " + checks.length + " checks passed"
      : "anim selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
