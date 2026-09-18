// peers.js -- los demas avatares de la region (multijugador).
//
// Cada cliente manda su transformada ~10 veces por segundo; aqui se guardan los
// demas como "objetivos" y se interpolan en cada frame, que es lo que hace que
// se muevan suaves aunque la red llegue a trozos. El cuerpo es el mismo cuerpo
// parametrico del visor (`avatarBody.js`), construido a partir del aspecto que
// manda cada jugador (parametros + ropa, unos cientos de bytes), y encima lleva
// una etiqueta con el nombre proyectada igual que el texto de los prims
// (src/lsl/runtime.js).

import * as THREE from "./three.js";
import { Avatar } from "./avatar.js";

export function createPeers(opts) {
  const viewer = opts.viewer;
  const scene = viewer.scene;
  const camera = viewer.camera;
  const overlayEl = opts.overlayEl || null;
  const labelPrefix = opts.labelPrefix === undefined ? "peer" : opts.labelPrefix;

  const peers = new Map();   // id -> registro
  const labelPool = [];

  function createLabel() {
    const el = document.createElement("div");
    el.className = "peerLabel";
    if (overlayEl) overlayEl.appendChild(el);
    labelPool.push(el);
    return el;
  }

  function add(id, name, pose, appearance) {
    if (id === undefined || id === null) return null;
    let rec = peers.get(id);
    if (!rec) {
      // Sin aspecto declarado, se deriva uno estable del id/nombre: asi cada
      // jugador tiene cara propia aunque sea la primera vez que se le ve.
      const seed = (name || "") + "|" + id;
      const avatar = new Avatar(THREE, {
        position: new THREE.Vector3(0, -500, 0), yaw: 0,
        appearance: appearance || undefined,
        name: appearance ? undefined : seed,
        // Todos los residentes comparten el cuerpo de SISTEMA de SL (mallas y
        // texturas reales), y con `shapeSeed` cada uno recibe una FORMA real
        // (parametros de avatar_lad) distinta y estable: se ven como avatares de
        // Second Life, no como clones del cuerpo por defecto.
        realBody: opts.realBody === undefined ? true : !!opts.realBody,
        resolveTexture: opts.resolveTexture,
        onBodyProgress: opts.onBodyProgress,
        shapeSeed: (appearance && appearance.shape) ? undefined : seed,
      });
      scene.add(avatar.group);
      rec = {
        id, name: name || "Residente", avatar,
        target: new THREE.Vector3(0, -500, 0),
        targetYaw: 0, yaw: 0, speed: 0, last: 0, seen: performance.now(),
        phase: 0, flying: false,
        // Hasta que el otro jugador no manda su primera transformada no se
        // dibuja: asi no aparece un avatar fantasma en el origen del mundo.
        valid: false,
      };
      peers.set(id, rec);
      applyPose(rec, pose);
      rec.avatar.position.copy(rec.target);
      rec.avatar.yaw = rec.yaw = rec.targetYaw;
      rec.avatar.sync();
      rec.avatar.group.visible = rec.valid;
    } else {
      if (name) rec.name = name;
      if (appearance) rec.avatar.setAppearance(appearance);
      applyPose(rec, pose);
    }
    rec.seen = performance.now();
    return rec;
  }

  // Cambia el aspecto de un residente (llega en un mensaje aparte, o al entrar).
  function setAppearance(id, appearance) {
    const rec = peers.get(id);
    if (!rec || !appearance) return;
    rec.avatar.setAppearance(appearance);
  }

  function applyPose(rec, pose) {
    if (!pose) return;
    const p = rec.target;
    const nx = pose.x, ny = pose.y, nz = pose.z;
    const moved = Math.hypot(nx - p.x, ny - p.y, nz - p.z);
    if (rec.last && moved > 0.001) {
      // Suavizado: la velocidad se estima con el salto y el tiempo transcurrido.
      const dt = Math.max(0.05, (performance.now() - rec.last) / 1000);
      rec.speed = Math.min(12, moved / dt);
    } else {
      rec.speed *= 0.6;
    }
    p.set(nx, ny, nz);
    rec.targetYaw = pose.yaw || 0;
    rec.last = performance.now();
    rec.flying = !!pose.flying;
    if (pose.valid !== undefined) rec.valid = !!pose.valid;
    if (rec.valid) rec.avatar.group.visible = true;
  }

  function setPose(id, pose) {
    const rec = peers.get(id);
    if (!rec) return;
    applyPose(rec, pose);
  }

  function remove(id) {
    const rec = peers.get(id);
    if (!rec) return;
    scene.remove(rec.avatar.group);
    if (rec.avatar.dispose) rec.avatar.dispose();
    peers.delete(id);
  }

  function clear() {
    for (const id of [...peers.keys()]) remove(id);
  }

  function list() {
    const out = [];
    for (const rec of peers.values()) out.push({ id: rec.id, name: rec.name, position: rec.avatar.position.toArray(), yaw: rec.yaw });
    return out;
  }

  function count() { return peers.size; }

  // Cada frame: acercar la pose interpolada al objetivo y animar brazos/piernas.
  function update(dt) {
    const now = performance.now();
    const camPos = camera.position;
    const w = viewer.canvas.clientWidth || window.innerWidth;
    const h = viewer.canvas.clientHeight || window.innerHeight;
    let used = 0;
    for (const rec of peers.values()) {
      const a = rec.avatar;
      const k = 1 - Math.pow(0.0015, dt);        // interpolacion exponencial
      a.position.lerp(rec.target, k);
      let d = rec.targetYaw - rec.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      rec.yaw += d * k;
      a.yaw = rec.yaw;
      a.sync();
      // La malla se posa a si misma desde el estado (marcha, respiracion, vuelo).
      rec.phase = (rec.phase || 0) + dt * (3 + rec.speed * 1.6);
      if (a.bodyMod) {
        a.bodyMod.animate({
          phase: rec.phase,
          speed: rec.speed,
          moving: rec.speed > 0.25,
          flying: !!rec.flying,
          grounded: true,
          dt,
        });
      }
      if (dt > 0) rec.speed *= Math.pow(0.05, dt);   // sin novedades, se para
      rec.phase = rec.phase % (Math.PI * 2);

      if (!labelPrefix || !rec.valid) continue;
      const v = rec._v || (rec._v = new THREE.Vector3());
      v.copy(a.position);
      v.y += 2.05;
      const dist = camPos.distanceTo(v);
      const inView = rec._c || (rec._c = new THREE.Vector3());
      inView.copy(v).applyMatrix4(camera.matrixWorldInverse);
      if (inView.z > -0.6 || dist > 220) continue;
      v.project(camera);
      if (v.z > 1) continue;
      const el = labelPool[used++] || createLabel();
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      el.style.transform = "translate(-50%, -100%) translate(" + Math.round(sx) + "px," + Math.round(sy) + "px)";
      el.style.fontSize = Math.max(10, Math.min(20, 300 / Math.max(4, dist))) + "px";
      el.textContent = rec.name;
      el.hidden = false;
    }
    for (let i = used; i < labelPool.length; i++) labelPool[i].hidden = true;
    void now;
  }

  function dispose() {
    clear();
    for (const el of labelPool) el.remove();
    labelPool.length = 0;
  }

  return { add, setPose, setAppearance, remove, clear, list, count, update, dispose, peers };
}
