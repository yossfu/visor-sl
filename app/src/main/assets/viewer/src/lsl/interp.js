// Interprete del mini-LSL: arbol de sintaxis -> resultado, con presupuesto de
// instrucciones y de tiempo por evento.
//
// El sandbox es "sin red y sin DOM" por construccion: aqui no hay ninguna via
// para llegar a `fetch`, `document` ni `window`; lo unico que un script puede
// tocar del mundo son las funciones integradas (`builtins.js`), que reciben un
// `host` (el prim y el runtime del visor) y nada mas.
//
// Estado de un script, igual que en LSL:
//  - las variables globales persisten entre eventos,
//  - el estado actual (`default`, `state otro`) decide que manejadores existen,
//  - al cambiar de estado se borran los listeners y el timer,
//  - antes del primer evento de un estado corre su `state_entry`.

import {
  Vec, Rot, isVec, isRot, isList, toLslString, toLslInteger, toLslFloat,
  truthy, equal, listInsert, vecNorm, vecLen, cross, dot, rotMul, rotateVec,
  rotFromEuler, rotToEuler, rotAxisAngle, rotAngle, rotAxis, rotBetween, normRot,
  vecWith, vecAt,
} from "./values.js";
import { LslSyntaxError, LslRuntimeError, LslBudgetError } from "./errors.js";

export function defaultValue(type) {
  if (type === "vector") return new Vec(0, 0, 0);
  if (type === "rotation") return new Rot(0, 0, 0, 1);
  if (type === "list") return [];
  if (type === "integer") return 0;
  if (type === "float") return 0;
  return "";
}

export function coerce(value, type, line, col) {
  switch (type) {
    case "integer": return toLslInteger(value);
    case "float": return toLslFloat(value);
    case "string":
    case "key":
      return toLslString(value);
    case "vector": return toVector(value, line, col);
    case "rotation": return toRotation(value, line, col);
    case "list": return isList(value) ? value : listInsert([], value);
    default: return value;
  }
}

export function toVector(v, line, col) {
  if (isVec(v)) return v;
  if (isRot(v)) return new Vec(v.x, v.y, v.z);
  if (typeof v === "string") {
    const nums = parseComponentString(v);
    if (nums && nums.length >= 3) return new Vec(nums[0], nums[1], nums[2]);
    throw new LslRuntimeError("no se puede convertir '" + v + "' a vector", line, col);
  }
  if (isList(v)) {
    if (v.length >= 3 && isVec(v[0])) return v[0];
    if (v.length >= 3) return new Vec(toLslFloat(v[0]), toLslFloat(v[1]), toLslFloat(v[2]));
  }
  throw new LslRuntimeError("no se puede convertir a vector", line, col);
}

export function toRotation(v, line, col) {
  if (isRot(v)) return v;
  if (isVec(v)) return new Rot(v.x, v.y, v.z, 0);
  if (typeof v === "string") {
    const nums = parseComponentString(v);
    if (nums && nums.length >= 4) return new Rot(nums[0], nums[1], nums[2], nums[3]);
    throw new LslRuntimeError("no se puede convertir '" + v + "' a rotation", line, col);
  }
  if (isList(v) && v.length >= 4) return new Rot(toLslFloat(v[0]), toLslFloat(v[1]), toLslFloat(v[2]), toLslFloat(v[3]));
  throw new LslRuntimeError("no se puede convertir a rotation", line, col);
}

function parseComponentString(s) {
  const m = s.match(/^<\s*([^>]*)>$/);
  if (!m) return null;
  const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts;
}

// --- entornos ---------------------------------------------------------------

class Scope {
  constructor(parent) { this.parent = parent; this.vars = Object.create(null); }
  declare(name, value) { this.vars[name] = value; }
  has(name) { return name in this.vars; }
  find(name) {
    let s = this;
    while (s) { if (name in s.vars) return s; s = s.parent; }
    return null;
  }
}

// --- interprete -------------------------------------------------------------

export class Interpreter {
  constructor(program, opts = {}) {
    this.program = program;
    this.constants = opts.constants || Object.create(null);
    this.builtins = opts.builtins || Object.create(null);
    // Presupuesto por evento: con `steps` se corta un bucle infinito y con
    // `ms` se corta uno que no avanza pero tarda (p. ej. muchas llamadas).
    this.budgetSteps = opts.budgetSteps || 300000;
    this.budgetMs = opts.budgetMs || 40;
    this.maxCallDepth = opts.maxCallDepth || 64;

    this.funcs = new Map();
    for (const f of program.funcs) {
      if (this.funcs.has(f.name)) throw new LslSyntaxError("la función '" + f.name + "' está definida dos veces", f.line, 1);
      this.funcs.set(f.name, f);
    }
    this.states = new Map();
    for (const s of program.states) {
      if (this.states.has(s.name)) throw new LslSyntaxError("el estado '" + s.name + "' está definido dos veces", s.line, 1);
      const handlers = new Map();
      for (const h of s.handlers) handlers.set(h.name, h);
      this.states.set(s.name, handlers);
    }
    // Los nombres de los estados tienen que existir de verdad, tambien los que
    // solo se usan en un `state x;` (si no, el script arrancaria y fallaria al
    // cambiar de estado sin explicar por que).
    this.stateNames = [...this.states.keys()];
    this.handlerNames = new Set();
    for (const h of this.states.values()) for (const k of h.keys()) this.handlerNames.add(k);
  }

  createInstance(host) {
    const inst = {
      interp: this,
      host,
      state: "default",
      vars: Object.create(null),
      listeners: [],
      nextListenHandle: 1,
      timer: { interval: 0, acc: 0 },
      entered: false,
      started: false,
      switchTo: null,
      guard: 0,
      dead: false,
      steps: 0,
      deadline: 0,
      eventName: null,
      lastError: null,
    };
    for (const g of this.program.globals) {
      for (const n of g.names) {
        inst.vars[n.name] = n.init ? this.evalGlobal(inst, g, n) : defaultValue(g.declType);
      }
    }
    return inst;
  }

  evalGlobal(inst, decl, entry) {
    // Las globales se evaluan con el presupuesto de un evento y sin estado
    // todavia (`state_entry` no existe aun), como hace LSL al compilar.
    inst.steps = 0;
    inst.deadline = now() + this.budgetMs;
    inst.eventName = "<globales>";
    const scope = new Scope(null);
    try {
      return coerce(this.eval(inst, entry.init, scope), decl.declType);
    } catch (e) {
      this.report(inst, e);
      return defaultValue(decl.declType);
    }
  }

  // Arranca el script: corre el `state_entry` del estado inicial.
  start(inst) {
    if (inst.dead) return;
    inst.started = true;
    inst.entered = true;
    this.execHandler(inst, "state_entry", []);
  }

  // Entrega un evento al script (ya con los argumentos convertidos por quien
  // llama). Devuelve true si habia un manejador.
  dispatch(inst, name, args) {
    if (inst.dead) return false;
    if (!inst.started) { inst.started = true; inst.entered = true; this.execHandler(inst, "state_entry", []); }
    if (inst.switchTo) { const t = inst.switchTo; inst.switchTo = null; this.applyState(inst, t); }
    const handlers = this.states.get(inst.state);
    const h = handlers && handlers.get(name);
    if (!h) return false;
    // `touch_start(integer n)` recibe el numero de toques; los demas eventos
    // llevan sus propios argumentos y se adaptan a los parametros declarados.
    this.execHandler(inst, name, args);
    return true;
  }

  applyState(inst, name, depth = 0) {
    const handlers = this.states.get(name);
    if (!handlers) {
      this.report(inst, new LslRuntimeError("estado desconocido: '" + name + "'", 0, 0, inst.eventName));
      return;
    }
    if (depth > 8) {
      this.report(inst, new LslRuntimeError("demasiados cambios de estado seguidos (¿se llaman entre ellos?)", 0, 0, inst.eventName));
      return;
    }
    inst.state = name;
    // LSL limpia listeners y timer al cambiar de estado.
    inst.listeners.length = 0;
    inst.timer.interval = 0;
    inst.timer.acc = 0;
    if (inst.host && inst.host.onStateChanged) inst.host.onStateChanged(name);
    this.execHandler(inst, "state_entry", [], depth);
  }

  execHandler(inst, name, args, depth = 0) {
    if (inst.dead) return null;
    const handlers = this.states.get(inst.state);
    const h = handlers && handlers.get(name);
    if (!h) return null;
    inst.eventName = name;
    inst.switchTo = null;
    inst.steps = 0;
    inst.deadline = now() + this.budgetMs;
    const scope = new Scope(null);
    for (let i = 0; i < h.params.length; i++) {
      scope.declare(h.params[i].name, coerce(args[i] === undefined ? 0 : args[i], h.params[i].ptype));
    }
    try {
      const sig = this.execStmt(inst, h.body, scope);
      if (sig && sig.flow === "state") inst.switchTo = sig.name;
    } catch (e) {
      this.report(inst, e);
      inst.switchTo = null;
    }
    if (inst.switchTo && !inst.dead) {
      const t = inst.switchTo;
      inst.switchTo = null;
      this.applyState(inst, t, depth + 1);
    }
    return true;
  }

  report(inst, e) {
    // Un error de ejecucion NO mata el script (LSL sigue vivo tras un error de
    // runtime), pero queda anotado para el editor y para la consola.
    const err = e instanceof Error ? e : new Error(String(e));
    inst.lastError = { message: err.raw || err.message, line: err.line || 0, event: inst.eventName };
    if (inst.host && inst.host.onError) inst.host.onError(inst.lastError, err);
  }

  tick(inst, what, line, col) {
    inst.steps++;
    if (inst.steps > this.budgetSteps) throw new LslBudgetError(inst.steps);
    if ((inst.steps & 255) === 0 && now() > inst.deadline) {
      throw new LslRuntimeError("el evento '" + inst.eventName + "' tardó demasiado (límite " + this.budgetMs + " ms)", line, col, inst.eventName);
    }
    return what;
  }

  // --- sentencias ------------------------------------------------------------

  execStmt(inst, node, scope) {
    this.tick(inst, null, node.line, 1);
    switch (node.type) {
      case "Empty":
        return null;

      case "Block": {
        const inner = new Scope(scope);
        for (const st of node.body) {
          const sig = this.execStmt(inst, st, inner);
          if (sig) return sig;
        }
        return null;
      }

      case "VarDecl": {
        for (const n of node.names) {
          const v = n.init ? coerce(this.eval(inst, n.init, scope), node.declType, node.line, 1) : defaultValue(node.declType);
          scope.declare(n.name, v);
        }
        return null;
      }

      case "ExprStmt":
        this.eval(inst, node.expr, scope);
        return null;

      case "If": {
        const sig = truthy(this.eval(inst, node.test, scope)) ? this.execStmt(inst, node.cons, scope) : (node.alt ? this.execStmt(inst, node.alt, scope) : null);
        return sig;
      }

      case "While": {
        for (;;) {
          this.tick(inst, null, node.line, 1);
          if (!truthy(this.eval(inst, node.test, scope))) return null;
          const sig = this.execStmt(inst, node.body, scope);
          if (sig) {
            if (sig.flow === "break") return null;
            if (sig.flow === "continue") continue;
            return sig;
          }
        }
      }

      case "DoWhile": {
        for (;;) {
          this.tick(inst, null, node.line, 1);
          const sig = this.execStmt(inst, node.body, scope);
          if (sig) {
            if (sig.flow === "break") return null;
            if (sig.flow !== "continue") return sig;
          }
          if (!truthy(this.eval(inst, node.test, scope))) return null;
        }
      }

      case "For": {
        const loopScope = new Scope(scope);
        if (node.init) { const s = this.execStmt(inst, node.init, loopScope); if (s) return s; }
        for (;;) {
          this.tick(inst, null, node.line, 1);
          if (node.test && !truthy(this.eval(inst, node.test, loopScope))) return null;
          const sig = this.execStmt(inst, node.body, loopScope);
          if (sig) {
            if (sig.flow === "break") return null;
            if (sig.flow !== "continue") return sig;
          }
          if (node.update) this.eval(inst, node.update, loopScope);
        }
      }

      case "Return":
        return { flow: "return", value: node.arg ? this.eval(inst, node.arg, scope) : null };

      case "Break": return { flow: "break" };
      case "Continue": return { flow: "continue" };

      case "StateChange": {
        if (!this.states.has(node.name)) throw new LslRuntimeError("estado desconocido: '" + node.name + "'", node.line, 1, inst.eventName);
        return { flow: "state", name: node.name };
      }

      default:
        throw new LslRuntimeError("sentencia desconocida: " + node.type, node.line, 1, inst.eventName);
    }
  }

  // --- expresiones -----------------------------------------------------------

  eval(inst, node, scope) {
    this.tick(inst, null, node.line, 1);
    switch (node.type) {
      case "Literal": return node.value;
      case "Str": return node.value;

      case "VectorLit": {
        const c = node.items.map((e) => toLslFloat(this.eval(inst, e, scope)));
        return new Vec(c[0], c[1], c[2]);
      }
      case "RotLit": {
        const c = node.items.map((e) => toLslFloat(this.eval(inst, e, scope)));
        return new Rot(c[0], c[1], c[2], c[3]);
      }
      case "ListLit": {
        const list = [];
        for (const e of node.items) listInsert(list, this.eval(inst, e, scope));
        return list;
      }

      case "Ident": {
        const s = scope.find(node.name);
        if (s) return s.vars[node.name];
        if (node.name in inst.vars) return inst.vars[node.name];
        if (node.name in this.constants) return this.constants[node.name];
        throw new LslRuntimeError("variable no definida: '" + node.name + "'", node.line, 1, inst.eventName);
      }

      case "Member": {
        const obj = this.eval(inst, node.object, scope);
        return this.member(obj, node.name, node);
      }

      case "Index": {
        const obj = this.eval(inst, node.object, scope);
        const idx = toLslInteger(this.eval(inst, node.index, scope));
        if (typeof obj === "string") {
          if (idx < 0 || idx >= obj.length) throw new LslRuntimeError("índice fuera de rango en la cadena", node.line, 1, inst.eventName);
          return obj[idx];
        }
        const list = isList(obj) ? obj : [obj];
        const i = idx < 0 ? list.length + idx : idx;
        if (i < 0 || i >= list.length) throw new LslRuntimeError("índice " + idx + " fuera de rango (lista de " + list.length + ")", node.line, 1, inst.eventName);
        return list[i];
      }

      case "Cast":
        return coerce(this.eval(inst, node.arg, scope), node.to, node.line, 1);

      case "Unary": {
        const v = this.eval(inst, node.arg, scope);
        switch (node.op) {
          case "!": return truthy(v) ? 0 : 1;
          case "-":
            if (isVec(v)) return new Vec(-v.x, -v.y, -v.z);
            if (typeof v === "number") return -v;
            throw new LslRuntimeError("no se puede negar eso", node.line, 1, inst.eventName);
          case "+": return typeof v === "number" ? v : toLslFloat(v);
          case "~": return ~toLslInteger(v);
          default: throw new LslRuntimeError("operador desconocido " + node.op, node.line, 1, inst.eventName);
        }
      }

      case "Postfix": {
        const target = node.arg;
        const old = this.eval(inst, target, scope);
        const nv = (typeof old === "number") ? old + (node.op === "++" ? 1 : -1) : toLslInteger(old) + (node.op === "++" ? 1 : -1);
        this.assign(inst, target, nv, scope);
        return old;
      }

      case "Ternary":
        return truthy(this.eval(inst, node.test, scope)) ? this.eval(inst, node.cons, scope) : this.eval(inst, node.alt, scope);

      case "Logical": {
        const l = truthy(this.eval(inst, node.left, scope));
        if (node.op === "&&") return (l && truthy(this.eval(inst, node.right, scope))) ? 1 : 0;
        return (l || truthy(this.eval(inst, node.right, scope))) ? 1 : 0;
      }

      case "Binary": return this.binary(inst, node, scope);

      case "Assign": {
        let value = this.eval(inst, node.value, scope);
        if (node.op !== "=") {
          const cur = this.eval(inst, node.target, scope);
          const bare = node.op[0];
          value = this.applyOp(inst, bare, cur, value, node);
        }
        this.assign(inst, node.target, value, scope);
        return value;
      }

      case "Call": return this.call(inst, node, scope);

      default:
        throw new LslRuntimeError("expresión desconocida: " + node.type, node.line, 1, inst.eventName);
    }
  }

  member(obj, name, node) {
    if (isVec(obj)) {
      if (name === "x") return obj.x;
      if (name === "y") return obj.y;
      if (name === "z") return obj.z;
    } else if (isRot(obj)) {
      if (name === "x") return obj.x;
      if (name === "y") return obj.y;
      if (name === "z") return obj.z;
      if (name === "s") return obj.s;
    }
    throw new LslRuntimeError("'" + name + "' no es un miembro de ese valor", node.line, 1, null);
  }

  assign(inst, target, value, scope) {
    if (target.type === "Ident") {
      const s = scope.find(target.name);
      if (s) { s.vars[target.name] = value; return; }
      if (target.name in inst.vars) { inst.vars[target.name] = value; return; }
      throw new LslRuntimeError("variable no definida: '" + target.name + "'", target.line, 1, inst.eventName);
    }
    if (target.type === "Member") {
      const obj = this.eval(inst, target.object, scope);
      const n = toLslFloat(value);
      let nv;
      if (isVec(obj)) {
        nv = obj.clone();
        if (target.name === "x") nv.x = n; else if (target.name === "y") nv.y = n; else if (target.name === "z") nv.z = n;
        else throw new LslRuntimeError("'" + target.name + "' no es una componente del vector", target.line, 1, inst.eventName);
      } else if (isRot(obj)) {
        nv = obj.clone();
        if (target.name === "x") nv.x = n; else if (target.name === "y") nv.y = n;
        else if (target.name === "z") nv.z = n; else if (target.name === "s") nv.s = n;
        else throw new LslRuntimeError("'" + target.name + "' no es una componente de la rotación", target.line, 1, inst.eventName);
      } else {
        throw new LslRuntimeError("no se puede escribir en ese miembro", target.line, 1, inst.eventName);
      }
      this.assign(inst, target.object, nv, scope);
      return;
    }
    if (target.type === "Index") {
      const obj = this.eval(inst, target.object, scope);
      const idx = toLslInteger(this.eval(inst, target.index, scope));
      if (isList(obj)) {
        const i = idx < 0 ? obj.length + idx : idx;
        if (i < 0 || i >= obj.length) throw new LslRuntimeError("índice fuera de rango al escribir", target.line, 1, inst.eventName);
        obj[i] = value;
        return;
      }
      throw new LslRuntimeError("solo se puede escribir en una lista", target.line, 1, inst.eventName);
    }
    throw new LslRuntimeError("destino de asignación no válido", target.line, 1, inst.eventName);
  }

  binary(inst, node, scope) {
    const a = this.eval(inst, node.left, scope);
    const b = this.eval(inst, node.right, scope);
    return this.applyOp(inst, node.op, a, b, node);
  }

  applyOp(inst, op, a, b, node) {
    const l = node.line;
    switch (op) {
      case "+": return this.add(inst, a, b, l);
      case "-": return this.sub(inst, a, b, l);
      case "*": return this.mul(inst, a, b, l);
      case "/": return this.div(inst, a, b, l);
      case "%": return this.mod(inst, a, b, l);
      case "==": return equal(a, b) ? 1 : 0;
      case "!=": return equal(a, b) ? 0 : 1;
      case "<": return this.cmp(a, b, l) < 0 ? 1 : 0;
      case ">": return this.cmp(a, b, l) > 0 ? 1 : 0;
      case "<=": return this.cmp(a, b, l) <= 0 ? 1 : 0;
      case ">=": return this.cmp(a, b, l) >= 0 ? 1 : 0;
      case "&": return toLslInteger(a) & toLslInteger(b);
      case "|": return toLslInteger(a) | toLslInteger(b);
      case "^": return toLslInteger(a) ^ toLslInteger(b);
      case "<<": return toLslInteger(a) << toLslInteger(b);
      case ">>": return toLslInteger(a) >> toLslInteger(b);
      default:
        throw new LslRuntimeError("operador desconocido '" + op + "'", l, 1, inst.eventName);
    }
  }

  add(inst, a, b, l) {
    if (typeof a === "string" || typeof b === "string") return toLslString(a) + toLslString(b);
    if (isList(a)) { const out = a.slice(); return listInsert(out, b); }
    if (isList(b)) { const out = listInsert([], a); return out.concat(b); }
    if (isVec(a) && isVec(b)) return new Vec(a.x + b.x, a.y + b.y, a.z + b.z);
    if (isRot(a) && isRot(b)) return rotMul(a, b);
    if (typeof a === "number" && typeof b === "number") return a + b;
    throw new LslRuntimeError("no se pueden sumar esos valores", l, 1, inst.eventName);
  }

  sub(inst, a, b, l) {
    if (isVec(a) && isVec(b)) return new Vec(a.x - b.x, a.y - b.y, a.z - b.z);
    if (isVec(a) && typeof b === "number") return new Vec(a.x - b, a.y - b, a.z - b);
    if (typeof a === "number" && typeof b === "number") return a - b;
    throw new LslRuntimeError("no se pueden restar esos valores", l, 1, inst.eventName);
  }

  mul(inst, a, b, l) {
    if (typeof a === "number" && typeof b === "number") return a * b;
    if (isVec(a) && typeof b === "number") return new Vec(a.x * b, a.y * b, a.z * b);
    if (typeof a === "number" && isVec(b)) return new Vec(b.x * a, b.y * a, b.z * a);
    if (isVec(a) && isVec(b)) return dot(a, b);                 // producto escalar
    if (isRot(a) && isRot(b)) return rotMul(a, b);
    if (isRot(a) && isVec(b)) return rotateVec(a, b);
    if (isVec(a) && isRot(b)) return rotateVec(b, a);
    if (isVec(a) && typeof b === "number") return new Vec(a.x * b, a.y * b, a.z * b);
    throw new LslRuntimeError("no se pueden multiplicar esos valores", l, 1, inst.eventName);
  }

  div(inst, a, b, l) {
    if (typeof a === "number" && typeof b === "number") {
      // LSL: entero entre entero es division ENTERA; en cuanto uno es float, no.
      if (Number.isInteger(a) && Number.isInteger(b)) {
        if (b === 0) throw new LslRuntimeError("división por cero", l, 1, inst.eventName);
        return Math.trunc(a / b);
      }
      return a / b;
    }
    if (isVec(a) && typeof b === "number") { if (b === 0) throw new LslRuntimeError("división por cero", l, 1, inst.eventName); return new Vec(a.x / b, a.y / b, a.z / b); }
    if (isVec(a) && isVec(b)) return new Vec(a.x / b.x, a.y / b.y, a.z / b.z);
    throw new LslRuntimeError("no se pueden dividir esos valores", l, 1, inst.eventName);
  }

  mod(inst, a, b, l) {
    if (isVec(a) && isVec(b)) return cross(a, b);               // producto vectorial
    if (typeof a === "number" && typeof b === "number") {
      if (b === 0) throw new LslRuntimeError("módulo por cero", l, 1, inst.eventName);
      return a % b;
    }
    throw new LslRuntimeError("no se puede aplicar '%' a esos valores", l, 1, inst.eventName);
  }

  cmp(a, b, l) {
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
    if (isVec(a) && isVec(b)) { const d = vecLen(a) - vecLen(b); return d < 0 ? -1 : d > 0 ? 1 : 0; }
    throw new LslRuntimeError("no se pueden comparar esos valores", l, 1, inst.eventName);
  }

  call(inst, node, scope) {
    const fn = this.funcs.get(node.name);
    const args = node.args.map((a) => this.eval(inst, a, scope));
    if (fn) return this.callUser(inst, fn, args, node);

    const bi = this.builtins[node.name];
    if (bi) {
      if (inst.depth === undefined) inst.depth = 0;
      inst.depth++;
      try {
        if (inst.depth > this.maxCallDepth) throw new LslRuntimeError("demasiadas llamadas anidadas", node.line, 1, inst.eventName);
        const out = bi(inst, args, node);
        return out === undefined ? 0 : out;
      } finally { inst.depth--; }
    }

    // ¿Es una constante usada como función? Error claro.
    if (node.name in this.constants) throw new LslRuntimeError("'" + node.name + "' es una constante, no una función", node.line, 1, inst.eventName);
    throw new LslRuntimeError("función no definida: '" + node.name + "'", node.line, 1, inst.eventName);
  }

  callUser(inst, fn, args, node) {
    if (inst.depth === undefined) inst.depth = 0;
    if (inst.depth > this.maxCallDepth) throw new LslRuntimeError("recursión demasiado profunda en '" + fn.name + "'", node.line, 1, inst.eventName);
    inst.depth++;
    try {
      const scope = new Scope(null);        // LSL: una funcion no ve las locales de quien la llama
      for (let i = 0; i < fn.params.length; i++) {
        scope.declare(fn.params[i].name, coerce(args[i] === undefined ? 0 : args[i], fn.params[i].ptype));
      }
      const sig = this.execStmt(inst, fn.body, scope);
      if (sig && sig.flow === "return") return coerce(sig.value === null ? 0 : sig.value, fn.ret, node.line, 1);
      if (sig && sig.flow === "state") throw new LslRuntimeError("no se puede cambiar de estado dentro de una función", node.line, 1, inst.eventName);
      return defaultValue(fn.ret);
    } finally { inst.depth--; }
  }
}

function now() {
  return (typeof performance !== "undefined" ? performance.now() : Date.now());
}
