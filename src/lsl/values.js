// Valores del mini-LSL.
//
// LSL tiene exactamente seis tipos: integer, float, string, key, vector,
// rotation y list. Aqui se mapean asi:
//
//   integer, float  -> number de JS
//   string, key     -> string de JS (key se marca con `key: true`? no: una key
//                      es una string con formato de UUID, y en LSL se compara
//                      como string, asi que no hace falta distinguirla)
//   vector          -> Vec  { x, y, z }
//   rotation        -> Rot  { x, y, z, s }   (cuaternion, s = parte escalar)
//   list            -> Array de JS (con las reglas de LSL: nunca anidada)
//
// Las conversiones (`(string)`, `(integer)`, ...), las operaciones (producto
// escalar de vectores con `*`, producto vectorial con `%`, rotacion de un
// vector con `rot * vec`) y el formato de impresion viven aqui, no en el
// interprete, para poder probarlos por separado.

import { LslRuntimeError } from "./errors.js";

export class Vec {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new Vec(this.x, this.y, this.z); }
}

export class Rot {
  constructor(x = 0, y = 0, z = 0, s = 1) { this.x = x; this.y = y; this.z = z; this.s = s; }
  clone() { return new Rot(this.x, this.y, this.z, this.s); }
}

export const isVec = (v) => v instanceof Vec;
export const isRot = (v) => v instanceof Rot;
export const isList = (v) => Array.isArray(v);
export const isNum = (v) => typeof v === "number";
export const isStr = (v) => typeof v === "string";

export const ZERO_VECTOR = () => new Vec(0, 0, 0);
export const ZERO_ROTATION = () => new Rot(0, 0, 0, 1);

// --- conversion a texto ------------------------------------------------------
// LSL imprime los floats con seis decimales (`(string)1.5` == "1.500000") y los
// vectores/rotaciones entre <> con la misma regla. Se respeta: los scripts que
// presumen de formateo cuentan con ello.

export function fmtFloat(n) {
  if (Number.isNaN(n)) return "nan";
  if (n === Infinity) return "inf";
  if (n === -Infinity) return "-inf";
  return n.toFixed(6);
}

export function toLslString(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : fmtFloat(v);
  if (typeof v === "string") return v;
  if (isVec(v)) return "<" + fmtFloat(v.x) + ", " + fmtFloat(v.y) + ", " + fmtFloat(v.z) + ">";
  if (isRot(v)) return "<" + fmtFloat(v.x) + ", " + fmtFloat(v.y) + ", " + fmtFloat(v.z) + ", " + fmtFloat(v.s) + ">";
  if (isList(v)) {
    // En LSL, (string) de una lista es la concatenacion de sus elementos, y las
    // listas dentro de listas no existen (se aplanan al insertarlas).
    let out = "";
    for (const e of v) out += toLslString(e);
    return out;
  }
  if (v === null || v === undefined) return "";
  return String(v);
}

export function toLslInteger(v, line, col) {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isNaN(n) ? 0 : Math.trunc(n);
  }
  if (isVec(v) || isRot(v)) return 0;
  if (isList(v)) return 0;
  return 0;
}

export function toLslFloat(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

// Las listas de LSL nunca estan anidadas: insertar una lista dentro de otra la
// concatena. Esta es la funcion que garantiza esa regla.
export function listInsert(target, value) {
  if (isList(value)) {
    for (const e of value) target.push(e);
  } else {
    target.push(value);
  }
  return target;
}

export function truthy(v) {
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (isVec(v)) return v.x !== 0 || v.y !== 0 || v.z !== 0;
  if (isRot(v)) return v.x !== 0 || v.y !== 0 || v.z !== 0 || v.s !== 0;
  if (isList(v)) return v.length > 0;
  return false;
}

export function equal(a, b) {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (isVec(a) && isVec(b)) return a.x === b.x && a.y === b.y && a.z === b.z;
  if (isRot(a) && isRot(b)) return a.x === b.x && a.y === b.y && a.z === b.z && a.s === b.s;
  if (isList(a) || isList(b)) {
    const la = isList(a) ? a : [a], lb = isList(b) ? b : [b];
    if (la.length !== lb.length) return false;
    for (let i = 0; i < la.length; i++) if (!equal(la[i], lb[i])) return false;
    return true;
  }
  // Cualquier mezcla se compara como texto, que es lo que hace LSL con las
  // conversiones implicitas (comparar un vector con una string compara "<...>").
  return toLslString(a) === toLslString(b);
}

// --- math de vectores y rotaciones ------------------------------------------

export function vecLen(v) { return Math.hypot(v.x, v.y, v.z); }

export function vecNorm(v) {
  const l = vecLen(v);
  if (l === 0) return new Vec(0, 0, 0);
  return new Vec(v.x / l, v.y / l, v.z / l);
}

export function vecDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

// Cuaternion (x,y,z,s) que representa el giro de `a` a `b` (llRotBetween).
export function rotBetween(a, b) {
  const na = vecNorm(a), nb = vecNorm(b);
  if (vecLen(na) === 0 || vecLen(nb) === 0) return new Rot(0, 0, 0, 1);
  const d = na.x * nb.x + na.y * nb.y + na.z * nb.z;
  if (d >= 1) return new Rot(0, 0, 0, 1);
  if (d <= -1) {
    // Opuestos: cualquier eje perpendicular sirve.
    let ax = new Vec(0, 1, 0);
    if (Math.abs(na.y) > 0.9) ax = new Vec(1, 0, 0);
    const c = cross(na, ax);
    return normRot(new Rot(c.x, c.y, c.z, 0));
  }
  const c = cross(na, nb);
  return normRot(new Rot(c.x, c.y, c.z, 1 + d));
}

export function normRot(r) {
  const l = Math.hypot(r.x, r.y, r.z, r.s);
  if (l === 0) return new Rot(0, 0, 0, 1);
  return new Rot(r.x / l, r.y / l, r.z / l, r.s / l);
}

// Producto de cuaterniones de LSL (Hamilton, con el mismo convenio que use el
// visor para three.js: (a*b) aplica primero b y despues a, como en SL).
export function rotMul(a, b) {
  return new Rot(
    a.s * b.x + a.x * b.s + a.y * b.z - a.z * b.y,
    a.s * b.y - a.x * b.z + a.y * b.s + a.z * b.x,
    a.s * b.z + a.x * b.y - a.y * b.x + a.z * b.s,
    a.s * b.s - a.x * b.x - a.y * b.y - a.z * b.z
  );
}

export function rotConj(r) { return new Rot(-r.x, -r.y, -r.z, r.s); }

export function rotateVec(r, v) {
  // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.s * v)
  const q = new Vec(r.x, r.y, r.z);
  const u = cross(q, v);
  const w = new Vec(u.x + r.s * v.x, u.y + r.s * v.y, u.z + r.s * v.z);
  const u2 = cross(q, w);
  return new Vec(v.x + 2 * u2.x, v.y + 2 * u2.y, v.z + 2 * u2.z);
}

export function cross(a, b) {
  return new Vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

export function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

// llEuler2Rot: giro ZYX (primero Z, luego Y, luego X), igual que SL.
export function rotFromEuler(e) {
  const cx = Math.cos(e.x / 2), sx = Math.sin(e.x / 2);
  const cy = Math.cos(e.y / 2), sy = Math.sin(e.y / 2);
  const cz = Math.cos(e.z / 2), sz = Math.sin(e.z / 2);
  return new Rot(
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz
  );
}

export function rotToEuler(r) {
  // Deshace rotFromEuler (orden ZYX).
  const m = rotToMatrix(r);
  const sy = -m[6];
  const out = new Vec(0, 0, 0);
  if (Math.abs(sy) < 0.999999) {
    out.y = Math.asin(sy);
    out.x = Math.atan2(m[7], m[8]);
    out.z = Math.atan2(m[3], m[0]);
  } else {
    out.y = Math.asin(Math.max(-1, Math.min(1, sy)));
    out.x = Math.atan2(-m[5], m[4]);
    out.z = 0;
  }
  return out;
}

export function rotAxisAngle(axis, angle) {
  const a = vecNorm(axis);
  const h = angle / 2;
  const s = Math.sin(h);
  return new Rot(a.x * s, a.y * s, a.z * s, Math.cos(h));
}

export function rotAngle(r) { return 2 * Math.acos(Math.max(-1, Math.min(1, r.s))); }

export function rotAxis(r) {
  const s = Math.sqrt(Math.max(0, 1 - r.s * r.s));
  if (s < 1e-9) return new Vec(1, 0, 0);
  return new Vec(r.x / s, r.y / s, r.z / s);
}

// Matriz 3x3 en orden fila-mayor, la que usa rotToEuler.
export function rotToMatrix(r) {
  const { x, y, z, s } = r;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * s), 2 * (x * z + y * s),
    2 * (x * y + z * s), 1 - 2 * (x * x + z * z), 2 * (y * z - x * s),
    2 * (x * z - y * s), 2 * (y * z + x * s), 1 - 2 * (x * x + y * y),
  ];
}

export function vecAt(v, i) {
  if (i === 0) return v.x;
  if (i === 1) return v.y;
  return v.z;
}

export function vecWith(v, i, n) {
  const out = v.clone();
  if (i === 0) out.x = n; else if (i === 1) out.y = n; else out.z = n;
  return out;
}

export function requireNumber(v, where) {
  if (typeof v !== "number") throw new LslRuntimeError(where + ": se esperaba un número");
  return v;
}
