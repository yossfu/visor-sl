// avatar.js -- el avatar y su fisica, imitando las constantes de SL.
//
// La fisica es la de SL: andar 3.2 m/s, correr 5.6 m/s, volar 10 m/s, gravedad
// 9.8 m/s^2, salto de ~1 m (v0 = 4.5 m/s) y altura de escalon 0.5 m. La colision
// contra prims se resuelve contra su caja envolvente orientada (OBB) con el
// algoritmo de "punto mas cercano", que funciona con prims rotados sin tener que
// suponer nada sobre sus caras.
//
// La malla del cuerpo NO esta aqui: la construye `avatarBody.js` a partir de un
// aspecto (parametros 0..1 + ropa), con jerarquia de articulaciones y animacion
// propia. Este modulo solo aporta el movimiento, la fisica y el rumbo, y le pasa
// a la malla el estado (velocidad, fase, volando, en el suelo) para que se pose.

import * as THREE from "./three.js";
import { createAvatarBody } from "./avatarBody.js";
import { createRealAvatarBody } from "./avatarRealBody.js";
import { defaultAppearance, normalizeAppearance, randomAppearance, packAppearance, normalizeShape } from "./avatarParams.js";

export const AVATAR = {
  radius: 0.28,
  height: 1.85,
  eyeHeight: 1.68,
  walkSpeed: 3.2,
  runSpeed: 5.6,
  flySpeed: 10,
  flyVertical: 6.5,
  accel: 26,
  airAccel: 6,
  gravity: 9.8,
  jumpVelocity: 4.5,
  stepHeight: 0.5,
  terminal: 55,
};

export class Avatar {
  constructor(THREE_, o = {}) {
    this.THREE = THREE_;
    this.opts = o;
    this.position = o.position ? o.position.clone() : new THREE_.Vector3(0, 25, 20);
    this.velocity = new THREE_.Vector3();
    this.yaw = o.yaw || 0;
    this.mode = "walk";
    this.flying = false;
    this.grounded = true;
    this.phase = 0;
    this.speed = 0;

    // Aspecto: si no llega uno, se inventa uno estable a partir del nombre (para
    // que los residentes sin aspecto definido no salgan todos clonicos).
    const app = o.appearance
      ? normalizeAppearance(o.appearance)
      : (o.name ? randomAppearance(o.name, o.name) : defaultAppearance(o.name));
    this._build(app);
    this.sync();
  }

  _build(appearance) {
    // Con `realBody` se monta el cuerpo de SISTEMA de Second Life (ver
    // `avatarRealBody.js`), que carga en diferido: hasta que llega se ve el
    // procedural, y el mundo no se bloquea. `avatarBody.js` sigue siendo el
    // respaldo y el que se usa en el banco de pruebas.
    this.bodyMod = this.opts.realBody
      ? createRealAvatarBody(appearance, {
        name: this.opts.name,
        onProgress: this.opts.onBodyProgress,
        // El cuerpo real resuelve los bakes (BoM) por uuid: quien construye el
        // avatar pasa aqui de donde sacarlos (normalmente `world.getAssetTexture`).
        resolveTexture: this.opts.resolveTexture,
        // Sin forma en el aspecto, una derivada de esta semilla (estable).
        autoShape: this.opts.shapeSeed,
      })
      : createAvatarBody(appearance);
    this.group = this.bodyMod.group;
    this.body = this.bodyMod.group;
    this.joints = this.bodyMod.joints;
    this.materials = this.bodyMod.materials;
    this.appearance = this.bodyMod.appearance;
    // Referencias comodas (algunos scripts/paneles las usan).
    const J = this.joints;
    this.arms = [J.shoulderL, J.shoulderR];
    this.legs = [J.hipL, J.hipR];
    this.group.userData.avatar = this;
    // El cuerpo real carga en diferido; `realBodyReady` resuelve cuando ya se
    // ha cambiado (o ha fallado, en cuyo caso se queda el procedural).
    this.realBodyReady = this.bodyMod.load ? this.bodyMod.load() : Promise.resolve(false);
  }

  // Reemplaza el aspecto entero (reconstruye la malla). Se usa cuando el usuario
  // edita su avatar o cuando llega el aspecto de un residente remoto.
  setAppearance(app) {
    if (!this.bodyMod) return;
    this.bodyMod.setAppearance(app);
    this.appearance = this.bodyMod.appearance;
    this.joints = this.bodyMod.joints;
    this.materials = this.bodyMod.materials;
    const J = this.joints;
    this.arms = [J.shoulderL, J.shoulderR];
    this.legs = [J.hipL, J.hipR];
  }

  // Forma compacta del aspecto (lo que se manda por la red / se guarda en kv).
  packedAppearance() { return packAppearance(this.appearance); }

  // --- forma real de Second Life -------------------------------------------
  // El objeto que resuelve los parametros visuales sobre el cuerpo de sistema
  // (solo si el cuerpo real esta montado). Con el se leen/editan los mandos.
  get slAppearance() {
    return (this.bodyMod && this.bodyMod.slAppearance) ? this.bodyMod.slAppearance : null;
  }
  get shapeReady() { return !!(this.bodyMod && this.bodyMod.shapeReady); }

  // Fija la forma real (un snapshot de `SLAppearance` o un bloque `shape`) y la
  // aplica. Devuelve la forma normalizada.
  setShape(shape) {
    const app = normalizeAppearance(this.appearance);
    const norm = normalizeShape(shape);
    if (!norm || (!norm.visualParams.length && !Object.keys(norm.bakes).length)) return null;
    app.shape = norm;
    this.setAppearance(app);
    return norm;
  }

  // Cambia entre el cuerpo de SISTEMA de Second Life (mallas y texturas
  // oficiales; bonito pero sordo a los parametros del aspecto) y el cuerpo
  // parametrico (el que se genera a partir del aspecto, que es el que edita el
  // armario). Rehace el modulo del cuerpo y lo sustituye en la escena.
  setBodyMode(realBody) {
    const on = !!realBody;
    if (!!this.opts.realBody === on && this.bodyMod) return false;
    const before = this.bodyMod;
    const oldGroup = this.group;
    const parent = oldGroup && oldGroup.parent ? oldGroup.parent : null;
    this.opts.realBody = on;
    this._build(this.appearance);
    if (parent) {
      parent.add(this.group);
      parent.remove(oldGroup);
    }
    if (before && before.dispose) { try { before.dispose(); } catch (e) { /* noop */ } }
    this.sync();
    if (this.bodyMod && this.bodyMod.animate) {
      this.bodyMod.animate({ phase: this.phase, speed: 0, moving: false, flying: !!this.flying, grounded: true, dt: 0 });
    }
    return true;
  }

  setPosition(v) { this.position.copy(v); this.velocity.set(0, 0, 0); this.sync(); }

  sync() {
    this.group.position.copy(this.position);
    this.group.rotation.y = this.yaw;
  }

  // Punto mas cercano del OBB de un prim a un punto del mundo.
  closestOnPrim(obj, point, out) {
    const T = this.THREE;
    const q = this._q || (this._q = new T.Quaternion());
    const local = this._lp || (this._lp = new T.Vector3());
    q.copy(obj.quaternion).invert();
    local.copy(point).sub(obj.position).applyQuaternion(q);
    local.x /= obj.scale.x; local.y /= obj.scale.y; local.z /= obj.scale.z;
    const b = obj.localBox || { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
    local.x = Math.max(b.min[0], Math.min(b.max[0], local.x));
    local.y = Math.max(b.min[1], Math.min(b.max[1], local.y));
    local.z = Math.max(b.min[2], Math.min(b.max[2], local.z));
    local.multiply(obj.scale).applyQuaternion(obj.quaternion).add(obj.position);
    return (out || new T.Vector3()).copy(local);
  }

  // Altura del suelo solido en (x,z) mirando hacia abajo desde `fromY`, y si esa
  // superficie es "pisable" (normal casi vertical). Combina el terreno con los
  // prims cercanos: el rayo empieza en `fromY + stepHeight`, asi que cualquier
  // superficie que encuentre esta como mucho un escalon por encima de los pies
  // (subir escalones es automatico) y nunca una pared alta.
  groundAt(x, z, fromY, world, terrain) {
    const T = this.THREE;
    let best = -Infinity, normalY = 1, hitTerrain = false;
    if (terrain) { best = terrain.heightAt(x, z); hitTerrain = true; }
    if (world) {
      const ray = this._ray || (this._ray = new T.Raycaster());
      const origin = this._ro || (this._ro = new T.Vector3());
      origin.set(x, fromY + AVATAR.stepHeight, z);
      ray.set(origin, this._down || (this._down = new T.Vector3(0, -1, 0)));
      ray.far = AVATAR.stepHeight + 0.35 + 2.4;
      ray.near = 0;
      const list = this._nearList || (this._nearList = []);
      world.near({ x, y: fromY, z }, 3, list);
      for (const obj of list) {
        if (!obj.mesh) continue;
        const hits = ray.intersectObject(obj.mesh, false);
        for (const h of hits) {
          const n = h.face ? h.face.normal : null;
          let ny = 1;
          if (n) {
            const wn = this._wn || (this._wn = new T.Vector3());
            wn.copy(n).applyQuaternion(obj.quaternion).normalize();
            ny = wn.y;
          }
          if (ny < 0.5) continue;              // es una pared, no un suelo
          if (h.point.y > best) { best = h.point.y; normalY = ny; hitTerrain = false; }
        }
      }
    }
    return { y: best === -Infinity ? -Infinity : best, normalY, terrain: hitTerrain };
  }

  update(dt, input, env) {
    const terrain = env.terrain, world = env.world;
    dt = Math.max(0, Math.min(dt, 0.05));
    const AV = AVATAR;

    // --- velocidad deseada, relativa al rumbo de la camara ---
    const yaw = input.cameraYaw === undefined ? this.yaw : input.cameraYaw;
    // `moveF`/`moveS` son ejes analogicos (-1..1, con magnitud significativa):
    // los usa el joystick para que empujar poco sea andar despacio. El teclado
    // sigue mandando booleanos, que valen +-1.
    let fwd, side;
    if (input.moveF !== undefined || input.moveS !== undefined) {
      fwd = input.moveF || 0; side = input.moveS || 0;
    } else {
      fwd = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
      side = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    }
    const len = Math.hypot(fwd, side);
    if (len > 1) { fwd /= len; side /= len; }

    const speed = input.run ? AV.runSpeed : AV.walkSpeed;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    // en three.js el "adelante" de la camara con yaw dado es (-sin, 0, -cos)
    const wantX = (-sy * fwd + cy * side) * speed;
    const wantZ = (-cy * fwd - sy * side) * speed;

    const accel = this.grounded || this.flying ? AV.accel : AV.airAccel;
    const k = Math.min(1, accel * dt / Math.max(1, speed));
    let vx = this.velocity.x + (wantX - this.velocity.x) * k;
    let vz = this.velocity.z + (wantZ - this.velocity.z) * k;

    // --- vertical ---
    let vy = this.velocity.y;
    if (this.flying) {
      const up = (input.up ? 1 : 0) - (input.down ? 1 : 0);
      vy += (up * AV.flyVertical - vy) * Math.min(1, 8 * dt);
    } else {
      vy -= AV.gravity * dt;
      if (vy < -AV.terminal) vy = -AV.terminal;
      // El salto llega del boton tactil (`jump`, de un solo uso) o de la tecla
      // de subir (`up`, que en el suelo tambien salta).
      if ((input.jump || input.up) && this.grounded) { vy = AV.jumpVelocity; this.grounded = false; }
    }

    // --- integrar y resolver el suelo ---
    this.position.x += vx * dt;
    this.position.z += vz * dt;
    this.position.y += vy * dt;

    const feet = this.position;
    const g = this.groundAt(feet.x, feet.z, feet.y, world, terrain);
    let grounded = false;
    if (g.y > -Infinity && feet.y <= g.y) {
      feet.y = g.y;
      if (vy < 0) vy = 0;
      grounded = !this.flying;
    }
    // En vuelo no se atraviesa el suelo, pero si se puede rozar.
    if (this.flying && g.y > -Infinity && feet.y < g.y) { feet.y = g.y; if (vy < 0) vy = 0; }

    // --- colision horizontal con prims (capsula contra OBB, 3 alturas) ---
    const r = AV.radius;
    if (world) {
      const near = world.near(feet, 1.5, this._near || (this._near = []));
      const samples = [0.32, 0.95, 1.55];
      const cp = this._cp || (this._cp = new this.THREE.Vector3());
      const push = this._push || (this._push = new this.THREE.Vector3());
      const pt = this._tmpPt || (this._tmpPt = new this.THREE.Vector3());
      const wb = this._wb || (this._wb = new this.THREE.Box3());
      for (const obj of near) {
        // Escalones: si lo mas alto del prim queda a menos de un escalon por
        // encima de los pies, no se empuja en horizontal. El avatar avanza y la
        // consulta de suelo lo sube en cuanto su centro pasa sobre la superficie
        // (si se empujara antes de llegar, se quedaria atascado contra el borde
        // para siempre). Un muro alto si bloquea, porque su techo esta muy arriba.
        world.worldBox(obj, wb);
        if (wb.max.y <= feet.y + AV.stepHeight + 0.02) continue;
        for (const sh of samples) {
          pt.set(feet.x, feet.y + sh, feet.z);
          this.closestOnPrim(obj, pt, cp);
          push.set(pt.x - cp.x, pt.y - cp.y, pt.z - cp.z);
          const d = push.length();
          if (d >= r) continue;
          if (d < 1e-5) continue;
          push.multiplyScalar(1 / d);
          const depth = r - d;
          feet.x += push.x * depth;
          feet.z += push.z * depth;
          if (push.y > 0.6) { if (vy < 0) vy = 0; }
          else if (push.y < -0.6) { if (vy > 0) vy = 0; }
        }
      }
      // Tras empujar horizontalmente, reajustar al suelo (para no quedar
      // flotando al bajar de un escalon).
      const g2 = this.groundAt(feet.x, feet.z, feet.y, world, terrain);
      if (g2.y > -Infinity && feet.y <= g2.y) {
        feet.y = g2.y;
        if (vy < 0) vy = 0;
        grounded = !this.flying;
      }
    }

    this.grounded = grounded;
    this.velocity.set(vx, vy, vz);
    this.speed = Math.hypot(vx, vz);

    // --- animacion: la malla se posa a si misma desde el estado ---
    const moving = this.speed > 0.25;
    this.phase += dt * (moving ? this.speed * 2.1 : 2.0);
    if (this.bodyMod) {
      this.bodyMod.animate({
        phase: this.phase,
        speed: this.speed,
        moving,
        flying: this.flying,
        grounded: this.grounded,
        dt,
      });
    }

    // El avatar gira hacia donde se mueve (como en SL), suavemente.
    if (this.speed > 0.35 && !this.flying) {
      const target = Math.atan2(-vx, -vz);
      let diff = target - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.yaw += diff * Math.min(1, 10 * dt);
    } else if (this.flying) {
      this.yaw += (yaw - this.yaw) * Math.min(1, 6 * dt);
    }

    this.sync();
    return { grounded, speed: this.speed, ground: g };
  }

  dispose() {
    if (this.bodyMod) this.bodyMod.dispose();
  }
}
