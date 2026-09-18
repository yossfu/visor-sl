// runtime.js -- el puente entre el mini-LSL y el visor.
//
// Aqui vive todo lo que un script PUEDE tocar: la transformada del prim, sus
// caras, el chat, el texto flotante, los timers, los listeners y los sensores.
// El interprete (lsl/interp.js) es puro; esto es lo que le da manos.
//
// Modelo, igual que en SL:
//  - cada prim puede tener un script (el "contenido de la prim");
//  - guardar el script lo compila y lo arranca de cero (`state_entry`);
//  - el script sobrevive a la region (viaja en el guardado/exportacion);
//  - tocar un prim con el puntero (fuera del modo construccion) dispara
//    touch_start / touch_end;
//  - escribir en el chat local dispara `listen` en los scripts que escuchan.

import { compile } from "./index.js";
import { Vec, Rot, toLslString, rotMul, rotConj, rotateVec } from "./values.js";
import * as THREE from "../three.js";
import { LslSyntaxError, LslRuntimeError } from "./errors.js";

// Coordenadas: el mundo de three.js tiene el origen en el centro de la region y
// Y hacia arriba; SL tiene el origen en la esquina (0,0,0) y Z hacia arriba. La
// conversion es la misma que usa el HUD del visor (viewer.js).
export function slToThree(p) {
  return { x: p.x - 128, y: p.z, z: 128 - p.y };
}
export function threeToSl(x, y, z) {
  return { x: x + 128, y: 128 - z, z: y };
}
// Giro de -90 grados sobre X: la base que relaciona las dos orientaciones.
const X90 = new Rot(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const X90I = rotConj(X90);
export function slRotToThree(r) { return rotMul(rotMul(X90, r), X90I); }
export function threeRotToSl(q) { return rotMul(rotMul(X90I, q), X90); }
export function slDirToThree(v) { return rotateVec(X90, v); }

const RANGES = { whisper: 10, say: 20, shout: 100, region: Infinity, owner: Infinity, im: Infinity, debug: Infinity };
const KIND_LABEL = { whisper: "susurra", say: "dice", shout: "grita", region: "difunde", owner: "te dice", im: "te susurra", debug: "avisa" };

export function keyForId(id) {
  return "00000000-0000-0000-0000-" + String(id).padStart(12, "0").slice(-12);
}

export function createScriptRuntime(opts) {
  const viewer = opts.viewer;
  const world = viewer.world;
  const avatar = viewer.avatar;
  const canvas = viewer.canvas;
  const camera = viewer.camera;
  const overlayEl = opts.overlayEl || null;
  // Nombre visible del usuario local (en multijugador lo pone la capa de red).
  const myName = () => (opts.myName ? String(opts.myName()) : "Dueño");
  // ¿Este prim es "mio" a efectos de chat? Sin red todo es mio (monojugador);
  // con red, solo los prims cuyo dueño es este cliente transmiten lo que dicen
  // (los demas clientes ya lo reciben por la red: si no, saldria duplicado).
  const isOwnerFn = opts.isOwner || null;
  const listeners = { chat: [], error: [], log: [], change: [] };
  const chatLog = [];
  const MAX_CHAT = 200;
  let clock = 0;
  let userKey = null;

  // El objeto publico se monta al final (las funciones se izan, pero las
  // declaraciones `let`/`const` del cuerpo no: devolverlo antes de tiempo las
  // dejaria en su zona muerta temporal y los listeners nunca se engancharian).
  let rt = null;

  // --- eventos ---------------------------------------------------------------

  function on(type, cb) { (listeners[type] || (listeners[type] = [])).push(cb); return () => off(type, cb); }
  function off(type, cb) { const l = listeners[type]; if (l) { const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); } }
  function emit(type, payload) {
    for (const cb of listeners[type] || []) {
      try { cb(payload); } catch (e) { console.warn("[lsl] fallo en un suscriptor", type, e); }
    }
  }

  // --- identidad del dueño ---------------------------------------------------
  function ownerKey() {
    if (!userKey) {
      const id = (typeof window !== "undefined" && window.generatorPublicId) || "0123456789abcdef0123456789abcdef";
      const h = id.replace(/[^0-9a-f]/gi, "").padEnd(32, "0").toLowerCase();
      userKey = h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32);
    }
    return userKey;
  }

  // --- instancias ------------------------------------------------------------

  function sourceOf(prim) { return prim && prim.script ? prim.script : null; }

  function getSource(prim) {
    if (!prim) return null;
    const rec = prim.lsl;
    if (rec && rec.draft !== undefined) return rec.draft;
    return sourceOf(prim);
  }

  // Guarda la fuente en el prim y la pone a correr (compilando de cero).
  function setSource(prim, source) {
    if (!prim) return { ok: false, error: null };
    const src = String(source === null || source === undefined ? "" : source);
    if (!src.trim()) return clear(prim);
    prim.script = src;
    return start(prim, src);
  }

  function start(prim, src) {
    prim.omega = null;          // el codigo nuevo decide si gira otra vez
    const old = prim.lsl;
    const rec = old || { draft: src };
    rec.source = src;
    rec.draft = src;
    if (rec.inst) rec.inst.dead = true;
    rec.inst = null;
    rec.error = null;
    rec.warnings = [];
    prim.lsl = rec;
    try {
      const interp = compile(src);
      rec.interp = interp;
      rec.inst = interp.createInstance(makeHost(prim));
      rec.startedAt = clock;
      rec.inst.scriptTime = { start: clock, reset: 0 };
      try {
        interp.start(rec.inst);
      } catch (e) {
        reportInstanceError(rec.inst, e);
      }
    } catch (e) {
      rec.error = e instanceof LslSyntaxError || e instanceof LslRuntimeError
        ? { message: e.raw || e.message, line: e.line || 0 }
        : { message: e && e.message ? e.message : String(e), line: 0 };
      emit("error", { prim, error: rec.error, phase: "compilar" });
    }
    emit("change", prim);
    return { ok: !rec.error, error: rec.error };
  }

  function clear(prim) {
    if (!prim) return { ok: true, error: null };
    if (prim.lsl && prim.lsl.inst) prim.lsl.inst.dead = true;
    prim.lsl = null;
    prim.script = null;
    prim.omega = null;          // un script borrado deja de girar
    emit("change", prim);
    return { ok: true, error: null };
  }

  function reset(prim) {
    if (!prim || !prim.script) return { ok: false, error: null };
    // Reiniciar = volver a arrancar el mismo codigo (borra estado, timer y
    // listeners, que es exactamente lo que hace "Reset Scripts" en SL).
    emit("log", { kind: "reset", text: "script reiniciado", prim });
    return start(prim, prim.script);
  }

  function info(prim) {
    const rec = prim && prim.lsl;
    const inst = rec && rec.inst;
    return {
      source: getSource(prim),
      running: !!(inst && !inst.dead),
      state: inst ? inst.state : null,
      listeners: inst ? inst.listeners.filter((l) => l.active).length : 0,
      timer: inst ? inst.timer.interval : 0,
      error: rec ? rec.error : null,
      lastError: inst ? inst.lastError : null,
    };
  }

  // Reconcilia el mundo con las instancias: arranca los prims que tienen fuente
  // y todavia no corren, y para los que ya no tienen. Se llama en cada frame
  // (es un recorrido barato) para que cosas como "rezar un prim del inventario"
  // o "cargar la region" no necesiten avisar a mano.
  let known = 0;
  function syncWorld() {
    const objs = world.objects;
    if (objs.length !== known) known = objs.length;
    for (const o of objs) {
      if (o.script) {
        if (!o.lsl || !o.lsl.inst || o.lsl.source !== o.script) start(o, o.script);
      } else if (o.lsl) {
        if (o.lsl.inst) o.lsl.inst.dead = true;
        o.lsl = null;
        o.omega = null;
      }
    }
  }

  function reportInstanceError(inst, e) {
    const err = {
      message: (e && (e.raw || e.message)) || String(e),
      line: (e && e.line) || 0,
      event: inst ? inst.eventName : null,
    };
    if (inst && inst.prim) inst.prim.lslError = err;
    emit("error", { prim: inst && inst.prim, error: err, phase: "ejecutar" });
    return err;
  }

  // --- update (timers + overlay) ---------------------------------------------

  function update(dt) {
    clock += dt;
    syncWorld();
    const objs = world.objects;
    for (const o of objs) {
      const rec = o.lsl;
      if (!rec || !rec.inst || rec.inst.dead) continue;
      const inst = rec.inst;
      if (inst.timer.interval > 0) {
        inst.timer.acc += dt;
        let guard = 0;
        while (inst.timer.acc >= inst.timer.interval && guard++ < 32) {
          inst.timer.acc -= inst.timer.interval;
          rec.interp.dispatch(inst, "timer", []);
          if (inst.dead) break;
        }
        if (guard >= 32) inst.timer.acc = 0;   // el timer iba mas rapido que el frame
      }
      if (inst.timer.interval > 0 && rec.interp.states.get(inst.state) && !rec.interp.states.get(inst.state).has("timer")) {
        // Un timer sin manejador no tiene sentido: se apaga solo (como en SL).
        inst.timer.interval = 0;
      }
    }
    // Los giros de `llTargetOmega` los aplica el visor frame a frame.
    for (const o of objs) if (o.omega) applyOmega(o, dt);
    updateOverlay();
  }

  const _omegaQ = new THREE.Quaternion();
  function applyOmega(o, dt) {
    _omegaQ.setFromAxisAngle(o.omega.axis, o.omega.rate * dt);
    o.quaternion.premultiply(_omegaQ).normalize();
    o.sync();
    if (o.links && o.links.length) world.applyLinkRoot(o);
    if (o.linkRoot) world.refreshLinkLocals(o.linkRoot);
  }

  // --- host ------------------------------------------------------------------

  function makeHost(prim) {
    const host = {
      prim,
      warn(msg) { emit("log", { kind: "warn", text: msg, prim }); },
      say(kind, channel, message) { sayFrom(prim, kind, channel, message); },

      setText(text, color, alpha, linkTarget) {
        for (const p of resolveTarget(prim, linkTarget)) {
          if (!text) p.lslText = null;
          else p.lslText = { text, color: [color.x, color.y, color.z], alpha: alpha === undefined ? 1 : alpha, setAt: clock };
        }
      },
      getText(linkTarget) {
        const p = resolveTarget(prim, linkTarget)[0] || prim;
        const t = p.lslText;
        return { text: t ? t.text : "", color: t ? new Vec(t.color[0], t.color[1], t.color[2]) : new Vec(1, 1, 1), alpha: t ? t.alpha : 1 };
      },

      getPos(linkTarget) { const p = targetPrim(prim, linkTarget); return worldPos(p); },
      setPos(v, linkTarget) { moveTo(targetPrim(prim, linkTarget), v, "region"); },
      getLocalPos(linkTarget) { const p = targetPrim(prim, linkTarget); return localPos(p); },
      setLocalPos(v, linkTarget) { moveTo(targetPrim(prim, linkTarget), v, "local"); },
      getRot(linkTarget) { const p = targetPrim(prim, linkTarget); return threeRotToSl({ x: p.quaternion.x, y: p.quaternion.y, z: p.quaternion.z, s: p.quaternion.w }); },
      setRot(r, linkTarget) { setRotation(targetPrim(prim, linkTarget), r, "region"); },
      getLocalRot(linkTarget) { const p = targetPrim(prim, linkTarget); const q = localQuat(p); return threeRotToSl(q); },
      setLocalRot(r, linkTarget) { setRotation(targetPrim(prim, linkTarget), r, "local"); },
      getScale(linkTarget) { const p = targetPrim(prim, linkTarget); return new Vec(p.scale.x, p.scale.y, p.scale.z); },
      setScale(v, linkTarget) {
        for (const p of resolveTarget(prim, linkTarget)) {
          p.scale.set(Math.abs(v.x) || 0.01, Math.abs(v.y) || 0.01, Math.abs(v.z) || 0.01);
          world.updateObject(p);
        }
      },
      // Giro continuo: se guarda el eje y la velocidad y el bucle lo aplica por
      // frame (es lo que hace el visor de SL, que no manda nada al servidor).
      targetOmega(axis, rate, gain, linkTarget) {
        const p = targetPrim(prim, linkTarget);
        const s = (Number.isFinite(rate) ? rate : 0) * (Number.isFinite(gain) && gain !== 0 ? gain : 1);
        if (!s || (!axis.x && !axis.y && !axis.z)) { p.omega = null; return; }
        const a = slDirToThree(axis);
        p.omega = { axis: new THREE.Vector3(a.x, a.y, a.z).normalize(), rate: s };
      },

      faceCount(linkTarget) {
        const p = targetPrim(prim, linkTarget);
        return p && p.volume ? p.volume.faces.length : 1;
      },
      setFace(face, patch, linkTarget) {
        for (const p of resolveTarget(prim, linkTarget)) setFacePatch(p, face, patch);
      },
      getFaceColor(linkTarget, face) {
        const p = targetPrim(prim, linkTarget);
        const n = host.faceCount(linkTarget);
        const i = face < 0 ? 0 : Math.max(0, Math.min(n - 1, face));
        const hex = (p.faces && p.faces[i] && p.faces[i].color !== null && p.faces[i].color !== undefined)
          ? p.faces[i].color
          : (p.colorHex === undefined || p.colorHex === null ? 0xb9c2cf : p.colorHex);
        return new Vec(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);
      },

      getObjectName(linkTarget) { const p = targetPrim(prim, linkTarget); return p.name; },
      setObjectName(name, linkTarget) { for (const p of resolveTarget(prim, linkTarget)) { p.name = name; p.group.name = name; } },
      getObjectDesc(linkTarget) { const p = targetPrim(prim, linkTarget); return p.desc || ""; },
      setObjectDesc(text, linkTarget) { for (const p of resolveTarget(prim, linkTarget)) p.desc = text; },
      setPhantom(on, linkTarget) { for (const p of resolveTarget(prim, linkTarget)) p.phantom = !!on; },
      setPhysics(on, linkTarget) { for (const p of resolveTarget(prim, linkTarget)) p.build = !!on; },
      setMaterial(id, linkTarget) {
        const mats = [
          { rough: 0.72, metal: 0.02 }, { rough: 0.28, metal: 0.85 }, { rough: 0.06, metal: 0.12 },
          { rough: 0.68, metal: 0.02 }, { rough: 0.55, metal: 0.02 }, { rough: 0.38, metal: 0.02 },
          { rough: 0.82, metal: 0.02 }, { rough: 0.9, metal: 0.0, glow: 0.55 },
        ];
        const m = mats[Math.max(0, Math.min(mats.length - 1, id | 0))];
        for (const p of resolveTarget(prim, linkTarget)) {
          const n = p.volume ? p.volume.faces.length : 1;
          for (let i = 0; i < n; i++) setFacePatch(p, i, { rough: m.rough, metal: m.metal, glow: m.glow });
        }
      },

      primKey() { return keyForId(prim.id); },
      ownerKey,
      linkSet() { return world.linkSetOf(prim); },
      linkNumber() {
        const set = world.linkSetOf(prim);
        if (set.length < 2) return 0;
        return set.indexOf(prim) + 1;
      },
      linkKey(n) {
        const set = world.linkSetOf(prim);
        const i = n === -4 ? set.indexOf(prim) : n === 1 ? 0 : n;
        const p = set[Math.max(0, Math.min(set.length - 1, i))];
        return p ? keyForId(p.id) : "";
      },
      linkName(n) {
        const set = world.linkSetOf(prim);
        const i = n === -4 ? set.indexOf(prim) : n === 1 ? 0 : n;
        const p = set[Math.max(0, Math.min(set.length - 1, i))];
        return p ? p.name : "";
      },

      time() { return clock - (prim.lslTimeStart === undefined ? clock : prim.lslTimeStart); },
      resetTime() { prim.lslTimeStart = clock; },
      onTimerChanged() { emit("change", prim); },
      onListenersChanged() { emit("change", prim); },
      onStateChanged(state) { emit("change", prim); emit("log", { kind: "state", text: "estado → " + state, prim }); },

      resetScript() {
        prim.lslRestart = true;
        setTimeout(() => { if (prim.lslRestart) { prim.lslRestart = false; reset(prim); } }, 0);
      },

      detected(i, what) {
        const inst = prim.lsl && prim.lsl.inst;
        const d = (inst && inst.detectedList) || [];
        const e = d[i];
        if (!e) return what === "pos" ? new Vec(0, 0, 0) : (what === "type" || what === "link" ? 0 : "");
        if (what === "key") return e.key;
        if (what === "name") return e.name;
        if (what === "pos") return e.pos;
        if (what === "type") return e.type;
        if (what === "link") return e.link;
        if (what === "owner") return e.owner || ownerKey();
        return "";
      },
      sensor(name, type, radius, arc) {
        runSensor(prim, name, type, radius, arc);
      },
    };
    return host;
  }

  // --- transformadas ---------------------------------------------------------

  function targetPrim(prim, linkTarget) {
    const set = world.linkSetOf(prim);
    if (linkTarget === null || linkTarget === undefined) return prim;
    if (linkTarget === -4) return prim;
    if (linkTarget === 1 || linkTarget === -1 || linkTarget === -2 || linkTarget === -3) return set[0] || prim;
    return set[Math.max(0, Math.min(set.length - 1, linkTarget))] || prim;
  }

  function resolveTarget(prim, linkTarget) {
    const set = world.linkSetOf(prim);
    if (linkTarget === null || linkTarget === undefined || linkTarget === -4) return [prim];
    if (linkTarget === -1) return set.slice();
    if (linkTarget === -2) return set.filter((p) => p !== prim);
    if (linkTarget === -3) return set.filter((p) => p !== (set[0] || null));
    if (linkTarget === 1) return [set[0] || prim];
    return [set[Math.max(0, Math.min(set.length - 1, linkTarget))] || prim];
  }

  function worldPos(p) {
    return new Vec(p.position.x + 128, 128 - p.position.z, p.position.y);
  }

  function localPos(p) {
    // En un link set, la posicion local es relativa a la raiz y en su espacio.
    const root = world.linkRootFor(p);
    if (!root || !p.local) return worldPos(p);
    const v = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    p.local.decompose(v, q, s);
    return new Vec(v.x, v.z, -v.y);
  }

  function localQuat(p) {
    const root = world.linkRootFor(p);
    if (!root || !p.local) {
      return { x: p.quaternion.x, y: p.quaternion.y, z: p.quaternion.z, s: p.quaternion.w };
    }
    const v = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    p.local.decompose(v, q, s);
    return { x: q.x, y: q.y, z: q.z, s: q.w };
  }

  function setRotation(p, r, mode) {
    const three = slRotToThree(r);
    const target = (world.linkRootFor(p) && mode === "local") ? quatFromLocal(p, three) : three;
    p.quaternion.set(target.x, target.y, target.z, target.s).normalize();
    p.sync();
    if (p.links && p.links.length) world.applyLinkRoot(p);
    if (p.linkRoot) world.refreshLinkLocals(p.linkRoot);
  }

  function quatFromLocal(p, localThree) {
    const root = world.linkRootFor(p);
    if (!root) return localThree;
    const rq = root.quaternion;
    // q_mundo = q_raiz * q_local
    const a = { x: rq.x, y: rq.y, z: rq.z, s: rq.w };
    return rotMul(a, localThree);
  }

  function moveTo(p, v, mode) {
    if (mode === "local" && p.linkRoot && p.local) {
      const m = p.local.clone();
      m.elements[12] = v.x;
      m.elements[13] = v.z;    // SL (x,y,z) -> three (x, z, -y)
      m.elements[14] = -v.y;
      applyLocalMatrix(p, m);
      return;
    }
    const three = slToThree(v);
    p.position.set(three.x, three.y, three.z);
    p.sync();
    if (p.links && p.links.length) world.applyLinkRoot(p);
    if (p.linkRoot) world.refreshLinkLocals(p.linkRoot);
  }

  function applyLocalMatrix(p, m) {
    const root = world.linkRootFor(p);
    if (!root) return;
    const parentM = new THREE.Matrix4().compose(root.position, root.quaternion, root.scale);
    const out = new THREE.Matrix4().multiplyMatrices(parentM, m);
    out.decompose(p.position, p.quaternion, p.scale);
    p.local = m;
    p.sync();
    world.refreshLinkLocals(root);
  }

  function setFacePatch(p, face, patch) {
    if (!p.faces) return;
    const n = p.volume ? p.volume.faces.length : 1;
    const idx = [];
    if (face === -1 || face === null || face === undefined) { for (let i = 0; i < n; i++) idx.push(i); }
    else idx.push(Math.max(0, Math.min(n - 1, face)));
    for (const i of idx) {
      const f = p.faces[i];
      if (!f) continue;
      if (patch.color !== undefined) f.color = vecToHex(patch.color);
      if (patch.alpha !== undefined) f.alpha = Math.max(0, Math.min(1, patch.alpha));
      if (patch.glow !== undefined) f.glow = Math.max(0, Math.min(1, patch.glow));
      if (patch.fullbright !== undefined) f.fullbright = !!patch.fullbright;
      if (patch.mask !== undefined) f.mask = !!patch.mask;
      if (patch.pattern !== undefined) f.tex = patch.pattern ? { k: patternKey(patch.pattern) } : null;
      if (patch.repeat) f.repeat = [patch.repeat[0], patch.repeat[1]];
      if (patch.offset) f.offset = [patch.offset[0], patch.offset[1]];
      if (patch.rotate !== undefined) f.rotation = patch.rotate;
      if (patch.rough !== undefined) f.rough = patch.rough;
      if (patch.metal !== undefined) f.metal = patch.metal;
    }
    world.applyFaceMaterials(p);
  }

  function vecToHex(v) {
    const c = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
    return (c(v.x) << 16) | (c(v.y) << 8) | c(v.z);
  }

  // Los nombres de textura que acepta un script son las claves de la biblioteca
  // procedural ("oro", "ladrillo", ...) o su etiqueta, para que sea comodo.
  function patternKey(name) {
    const s = toLslString(name).toLowerCase();
    const keys = (opts.patternKeys && opts.patternKeys()) || [];
    for (const k of keys) if (k.toLowerCase() === s) return k;
    return s;
  }

  // --- chat ------------------------------------------------------------------

  function sayFrom(prim, kind, channel, message) {
    const text = String(message);
    if (prim && sayBudget(prim)) return;   // habla demasiado rapido: se descarta
    const range = RANGES[kind] === undefined ? 20 : RANGES[kind];
    let dist = 0;
    if (avatar && prim) {
      const dx = avatar.position.x - prim.position.x;
      const dy = avatar.position.y - prim.position.y;
      const dz = avatar.position.z - prim.position.z;
      dist = Math.hypot(dx, dy, dz);
    }
    const inRange = kind === "owner" || kind === "im" || kind === "debug" || dist <= range;
    const line = {
      kind, channel, text, dist,
      speaker: prim ? prim.name : "objeto",
      prim: prim || null,
      outOfRange: !inRange,
      // Lo que dicen los scripts de mis prims se transmite a los demas clientes.
      broadcast: (!isOwnerFn || isOwnerFn(prim)) && (kind === "say" || kind === "whisper" || kind === "shout" || kind === "region"),
      ts: Date.now(),
    };
    pushChat(line);
    if (kind === "debug") emit("log", { kind: "warn", text, prim });
    // Globo de texto sobre el prim (como los viewers con "burbujas de chat").
    if (prim && (kind === "say" || kind === "whisper" || kind === "shout") && inRange) {
      prim.lslBubble = { text, until: clock + Math.min(9, 2.5 + text.length * 0.05), at: clock };
    }
    // Y entrega a los listeners (los demas scripts, y el propio).
    deliverListen(prim, channel, prim ? prim.name : "", prim ? keyForId(prim.id) : "", text);
  }

  function pushChat(line) {
    chatLog.push(line);
    if (chatLog.length > MAX_CHAT) chatLog.shift();
    emit("chat", line);
  }

  // Dos frenos para el clasico bucle de SL "un script que escucha lo que el
  // mismo dice": (1) un presupuesto de lineas por segundo y prim, y (2) una
  // profundidad maxima de la cadena decir -> oir -> decir. En SL real el bucle
  // simplemente se realimenta sin fin; aqui se corta y se avisa, que es lo util.
  const SAY_BUDGET = 20;       // lineas por segundo y prim
  const SAY_WINDOW = 1.0;
  const MAX_SAY_CHAIN = 12;
  let sayChain = 0;
  let sayChainWarned = false;

  function sayBudget(prim) {
    const rec = prim.lsl;
    if (!rec) return false;
    if (clock - (rec.sayT === undefined ? -SAY_WINDOW : rec.sayT) >= SAY_WINDOW) {
      rec.sayT = clock; rec.sayN = 0; rec.sayWarned = false;
    }
    rec.sayN = (rec.sayN || 0) + 1;
    if (rec.sayN <= SAY_BUDGET) return false;
    if (!rec.sayWarned) {
      rec.sayWarned = true;
      emit("log", { kind: "warn", prim, text: "llSay: demasiados mensajes seguidos, se descartan los demás" });
    }
    return true;
  }

  function deliverListen(fromPrim, channel, name, id, message) {
    if (sayChain >= MAX_SAY_CHAIN) {
      if (!sayChainWarned) {
        sayChainWarned = true;
        emit("log", { kind: "warn", prim: fromPrim, text: "cadena de chat demasiado larga (posible bucle de llListen); se corta" });
      }
      return;
    }
    if (sayChain === 0) sayChainWarned = false;
    for (const o of world.objects) {
      const rec = o.lsl;
      if (!rec || !rec.inst || rec.inst.dead) continue;
      const inst = rec.inst;
      if (!inst.listeners.length) continue;
      let ok = false;
      for (const l of inst.listeners) {
        if (!l.active) continue;
        if (l.channel !== channel) continue;
        if (l.name && name.toLowerCase().indexOf(l.name) < 0) continue;
        if (l.id && l.id !== "" && l.id !== "00000000-0000-0000-0000-000000000000" && l.id !== id) continue;
        if (l.message && message.toLowerCase().indexOf(l.message) < 0) continue;
        ok = true;
        break;
      }
      if (!ok) continue;
      sayChain++;
      try { rec.interp.dispatch(inst, "listen", [channel, name, id, message]); }
      finally { sayChain--; }
    }
  }

  // El usuario escribe en el chat local: eso es lo que oyen los `llListen` del
  // canal 0 (o del canal que se elija en el panel).
  function chat(text, channel = 0) {
    const t = String(text || "");
    if (!t) return;
    pushChat({ kind: "user", channel, text: t, speaker: "tú", dist: 0, broadcast: true, ts: Date.now() });
    // El nombre que ve un `listen` es el de quien habla: el del avatar local.
    deliverListen(null, channel, myName(), ownerKey(), t);
  }

  // Chat que llega de otro cliente: se pinta en el log local (con el nombre de
  // quien hablo), se dibuja la burbuja si el prim existe aqui, y se entrega a
  // los `llListen` locales, igual que si lo hubiera dicho un script propio.
  function receiveChat(msg) {
    if (!msg || !msg.text) return;
    const kind = msg.kind || "say";
    const channel = msg.channel || 0;
    const range = RANGES[kind] === undefined ? 20 : RANGES[kind];
    let dist = 0;
    if (avatar && msg.fromPos) {
      dist = Math.hypot(
        avatar.position.x - msg.fromPos.x,
        avatar.position.y - msg.fromPos.y,
        avatar.position.z - msg.fromPos.z,
      );
    }
    const inRange = !isFinite(range) || dist <= range;
    const prim = msg.primId ? world.findById(msg.primId) : null;
    const speaker = msg.speaker || "alguien";
    pushChat({
      kind: (prim || msg.scripted) ? kind : "peer",
      channel, text: String(msg.text), dist, speaker, prim,
      outOfRange: !inRange, broadcast: false, remote: true, ts: Date.now(),
    });
    if (prim && (kind === "say" || kind === "whisper" || kind === "shout") && inRange) {
      prim.lslBubble = { text: String(msg.text), until: clock + Math.min(9, 2.5 + String(msg.text).length * 0.05), at: clock };
    }
    deliverListen(prim, channel, speaker, msg.id || "", String(msg.text));
  }

  function log() { return chatLog.slice(); }

  // --- tocar ----------------------------------------------------------------

  function touch(prim, phase, faceIndex, agent) {
    if (!prim) return 0;
    const rec = prim.lsl;
    if (!rec || !rec.inst || rec.inst.dead) return 0;
    const inst = rec.inst;
    const a = agent || {
      key: ownerKey(), name: "Dueño", type: 1,
      pos: avatar ? new Vec(avatar.position.x + 128, 128 - avatar.position.z, avatar.position.y) : new Vec(0, 0, 0),
      owner: ownerKey(),
    };
    const link = prim.lsl ? (touchLinkNumber(prim)) : 1;
    inst.detectedList = [
      a,
      {
        key: keyForId(prim.id), name: prim.name, type: 8 | 16, link,
        pos: worldPos(prim), owner: ownerKey(),
      },
    ];
    if (phase === "start") return rec.interp.dispatch(inst, "touch_start", [1]) ? 1 : 0;
    if (phase === "end") return rec.interp.dispatch(inst, "touch_end", [1]) ? 1 : 0;
    return rec.interp.dispatch(inst, "touch", [1]) ? 1 : 0;
  }

  function touchLinkNumber(prim) {
    const set = world.linkSetOf(prim);
    if (set.length < 2) return 1;
    return set.indexOf(prim) + 1;
  }

  // --- sensores --------------------------------------------------------------

  function runSensor(prim, nameFilter, type, radius, arc) {
    const rec = prim.lsl;
    if (!rec || !rec.inst || rec.inst.dead) return;
    const inst = rec.inst;
    const found = [];
    const wantAgent = !(type & 0) || (type & 1) !== 0 || (type & 4) !== 0;
    if (avatar && wantAgent) {
      const d = Math.hypot(avatar.position.x - prim.position.x, avatar.position.y - prim.position.y, avatar.position.z - prim.position.z);
      if (d <= radius) {
        const nm = "Dueño";
        if (!nameFilter || nm.toLowerCase().indexOf(nameFilter.toLowerCase()) >= 0) {
          found.push({ key: ownerKey(), name: nm, type: 1, link: 0, pos: new Vec(avatar.position.x + 128, 128 - avatar.position.z, avatar.position.y), owner: ownerKey() });
        }
      }
    }
    for (const p of world.objects) {
      if (p === prim) continue;
      const d = Math.hypot(p.position.x - prim.position.x, p.position.y - prim.position.y, p.position.z - prim.position.z);
      if (d > radius) continue;
      if (nameFilter && p.name.toLowerCase().indexOf(nameFilter.toLowerCase()) < 0) continue;
      found.push({ key: keyForId(p.id), name: p.name, type: 16, link: touchLinkNumber(p), pos: worldPos(p), owner: ownerKey() });
    }
    inst.detectedList = found;
    rec.interp.dispatch(inst, "sensor", [found.length]);
    emit("change", prim);
  }

  // --- texto flotante y burbujas --------------------------------------------

  const labelPool = [];

  function updateOverlay() {
    if (!overlayEl) return;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    let used = 0;
    const camPos = camera.position;
    const v = new (camera.position.constructor)();
    const inView = new (camera.position.constructor)();
    for (const o of world.objects) {
      const text = o.lslText && o.lslText.text;
      const bubble = o.lslBubble && o.lslBubble.until > clock ? o.lslBubble : null;
      if (!text && !bubble) { if (o.lslBubble && o.lslBubble.until <= clock) o.lslBubble = null; continue; }
      const top = o.position.y + (o.boundRadius || 1) * 0.6 + (bubble ? 0.55 : 0.25);
      v.set(o.position.x, top, o.position.z);
      const dist = camPos.distanceTo(v);
      // Detras de la camara `project` devuelve coordenadas espejadas, asi que el
      // corte se hace mirando la profundidad en el espacio de la camara.
      inView.copy(v).applyMatrix4(camera.matrixWorldInverse);
      if (inView.z > -0.6 || dist > 220) continue;
      v.project(camera);
      if (v.z > 1) continue;
      const el = labelPool[used++] || createLabel();
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      el.style.transform = "translate(-50%, -100%) translate(" + Math.round(sx) + "px," + Math.round(sy) + "px)";
      el.style.fontSize = Math.max(9, Math.min(22, 260 / Math.max(4, dist))) + "px";
      el.hidden = false;
      if (bubble) {
        el.className = "lslLabel lslBubble";
        el.textContent = bubble.text;
        el.style.opacity = String(Math.max(0.15, Math.min(1, (bubble.until - clock) / 1.2)));
      } else {
        el.className = "lslLabel";
        el.textContent = text;
        const c = o.lslText.color;
        el.style.color = "rgb(" + Math.round(c[0] * 255) + "," + Math.round(c[1] * 255) + "," + Math.round(c[2] * 255) + ")";
        el.style.opacity = String(o.lslText.alpha);
        el.style.textShadow = "0 1px 2px rgba(0,0,0,0.85)";
      }
    }
    for (let i = used; i < labelPool.length; i++) labelPool[i].hidden = true;
  }

  function createLabel() {
    const el = document.createElement("div");
    el.className = "lslLabel";
    overlayEl.appendChild(el);
    labelPool.push(el);
    return el;
  }

  // --- tocar con el puntero (fuera del modo construccion) -------------------

  let down = null;
  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, prim: null, id: e.pointerId };
  }
  function onUp(e) {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 6) return;
    if (typeof opts.isBuildMode === "function" && opts.isBuildMode()) return;
    const hit = pickPrim(e.clientX, e.clientY);
    if (!hit) return;
    const before = hit.lsl ? touch(hit, "start", null, null) : 0;
    touch(hit, "end", null, null);
    if (!before) {
      // Un prim sin script tocado "no hace nada": se avisa solo en el log si
      // tiene un script con error, que es lo util de verdad.
      if (hit.lsl && hit.lsl.error) emit("log", { kind: "warn", text: "ese prim tiene un script con errores", prim: hit });
    }
  }

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pickPrim(cx, cy) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = world.raycast(ray);
    return hit ? hit.prim : null;
  }

  if (canvas) {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
  }

  function instances() {
    const out = [];
    for (const o of world.objects) if (o.lsl && o.lsl.inst) out.push({ prim: o, inst: o.lsl.inst });
    return out;
  }

  function stats() {
    const all = instances();
    return {
      scripts: all.length,
      prims: world.objects.length,
      listeners: all.reduce((a, x) => a + x.inst.listeners.length, 0),
      timers: all.reduce((a, x) => a + (x.inst.timer.interval > 0 ? 1 : 0), 0),
      states: all.map((x) => x.inst.state),
    };
  }

  function dispose() {
    for (const o of world.objects) {
      if (o.lsl && o.lsl.inst) o.lsl.inst.dead = true;
      o.omega = null;
      o.lslText = null;
      o.lslBubble = null;
    }
    for (const el of labelPool) el.remove();
    labelPool.length = 0;
    if (canvas) {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
    }
  }

  rt = {
    update, syncWorld, getSource, setSource, clear, reset, info, chat, receiveChat, log,
    touch, on, emit, instances, stats, dispose, world, patterns: null,
    ranges: RANGES,
  };
  return rt;
}
