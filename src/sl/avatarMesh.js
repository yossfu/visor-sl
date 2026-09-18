// avatarMesh.js -- el avatar REAL de Second Life.
//
// Reune las piezas que el visor ya sabe leer para dibujar a un residente tal
// cual es, en vez del cuerpo procedural de `avatarBody.js` (que se queda como
// respaldo para cuando no hay datos):
//
//   - el cuerpo/cabeza de SISTEMA, del contenedor "Linden Binary Mesh 1.0"
//     (`bodyMesh.js`): cabeza, torso, piernas, pelo, pestañas, falda y ojos;
//   - las mallas ADJUNTAS, activos LLMESH (`llmesh.js`): el cuerpo y la cabeza
//     mesh que lleva puesto, la ropa, el pelo comprado... van atadas al
//     esqueleto de `skeleton.js` y se deforman con el;
//   - los OBJETOS anclados en los puntos de `attachments.js` (una espada en la
//     mano, un sombrero en la cabeza);
//   - las ANIMACIONES reales de SL (`anim.js`), mezcladas sobre el esqueleto.
//
// Nada de esto se puede "descargar": todo llega por el retransmisor
// (`VIEWER-REAL.md`) desde la sesion del propio usuario, que es la unica con
// permiso para pedir esos activos. Este modulo solo los monta y los mueve.
//
// El conjunto se cuelga de `group`, que es lo que se coloca en el mundo (la
// fisica del avatar mueve ese grupo, nunca los huesos).

import { buildSkeleton, jointIndex, slVecToAvatar } from "./skeleton.js";

// El marco del visor cambia los ejes (SL +X -> -Z, +Y -> -X, +Z -> +Y), asi que
// una escala (sx, sy, sz) de SL se convierte en (sy, sz, sx) aqui.
export const SL_BONE_SCALE_PERMUTATION = [1, 2, 0];
import { decodeBodyMesh, buildBodyMesh, bodyBaseArrays, applyBodyMorphs } from "./bodyMesh.js";
import { buildSkinnedMesh, meshStats } from "./llmesh.js";
import { Animator } from "./anim.js";
import { attachToSkeleton, attachmentPoint } from "./attachments.js";

// Las piezas del cuerpo de sistema y de donde cuelgan. Port de
// `LLAvatarAppearance::loadMeshNodes` (llavatarappearance.cpp): la cabeza, las
// pestañas, el torso, las piernas y la falda cuelgan del avatar raiz; el pelo
// de mSkull y cada ojo de su articulacion (el ojo no lleva pesos: viene con
// los vertices centrados en el origen de la articulacion).
export const SYSTEM_BODY_PARTS = {
  head: { file: "avatar_head.llm", parent: null, skin: true },
  eyelashes: { file: "avatar_eyelashes.llm", parent: null, skin: true },
  upperBody: { file: "avatar_upper_body.llm", parent: null, skin: true },
  lowerBody: { file: "avatar_lower_body.llm", parent: null, skin: true },
  skirt: { file: "avatar_skirt.llm", parent: null, skin: true },
  hair: { file: "avatar_hair.llm", parent: "mSkull", skin: true },
  eyeLeft: { file: "avatar_eye.llm", parent: "mEyeLeft", skin: false },
  eyeRight: { file: "avatar_eye.llm", parent: "mEyeRight", skin: false },
};

// Colores de relleno mientras no hay texturas cocidas (bakes): sin la sesion de
// SL no se pueden pedir, asi que el muñeco sale con su tono de piel y poco mas.
const DEFAULT_COLORS = {
  head: 0xd8ab8b, upperBody: 0xd8ab8b, lowerBody: 0xd8ab8b,
  skirt: 0x8d929c, hair: 0x3a2a20, eyelashes: 0x241d16,
  eyeLeft: 0x2b3038, eyeRight: 0x2b3038,
};
const DEFAULT_ROUGHNESS = { hair: 0.9, eyeLeft: 0.25, eyeRight: 0.25, eyelashes: 0.8 };

// Huesos que tocan el suelo. Con la forma aplicada, las piernas se alargan o
// acortan, asi que hay que subir el esqueleto lo justo para que la planta siga
// en el mismo sitio (es lo que hace el visor con `mPelvisToFoot`).
const FOOT_BONES = ["mFootLeft", "mFootRight", "mToeLeft", "mToeRight"];

export class AvatarMesh {
  constructor(THREE, opts = {}) {
    this.THREE = THREE;
    this.binding = buildSkeleton(THREE, { name: opts.skeletonName || "esqueletoSL" });
    // El grupo del avatar: es lo que se mueve por el mundo.
    this.group = new THREE.Group();
    this.group.name = opts.name || "avatar";
    this.group.add(this.binding.root);
    this.animator = new Animator(this.binding);
    this.systemParts = new Map();      // nombre -> { mesh, object, arrays, skinned }
    this.meshAssets = new Map();       // id -> { asset, object, skinned }
    this.attachmentNodes = new Map();  // localizacion -> nodo de anclaje
    this.morphs = new Map();           // nombre de morph -> peso (parametros visuales)
    this.boneRest = new Map();         // nombre de hueso -> { scale, position } de reposo
    this._distortedBones = new Set();  // huesos con distorsion aplicada ahora mismo
    this.time = 0;
    this._nextId = 1;
    this._materials = new Map();
    if (opts.materials) for (const k in opts.materials) this._materials.set(k, opts.materials[k]);
    this.footRestY = this._staticFootY();
  }

  // Altura de la planta (hueso del pie mas bajo) en la pose de reposo SIN
  // animacion, sumando las posiciones locales (que ya llevan la forma). Las
  // rotaciones de reposo son identidad, asi que es exacto.
  _staticFootY() {
    let minY = Infinity;
    for (const name of FOOT_BONES) {
      const bone = this.binding.byName.get(name);
      if (!bone) continue;
      let y = 0;
      for (let node = bone; node && node !== this.binding.root; node = node.parent) y += node.position.y;
      minY = Math.min(minY, y);
    }
    return Number.isFinite(minY) ? minY : 0;
  }

  // Sube o baja el esqueleto dentro del grupo para que la planta quede donde
  // estaba antes de deformar la forma. El grupo (lo que mueve la fisica) no se
  // toca: el ajuste es interno al avatar.
  groundSkeleton() {
    const shift = this.footRestY - this._staticFootY();
    this.binding.root.position.y = shift;
    this.binding.root.updateMatrixWorld(true);
    return shift;
  }

  // Material de una pieza. `opts.materials` permite pisarlos (por ejemplo, con
  // la textura cocida que traiga el retransmisor).
  materialFor(name) {
    if (this._materials.has(name)) return this._materials.get(name);
    const THREE = this.THREE;
    const color = DEFAULT_COLORS[name] === undefined ? 0xcccccc : DEFAULT_COLORS[name];
    const m = new THREE.MeshStandardMaterial({
      color, roughness: DEFAULT_ROUGHNESS[name] === undefined ? 0.85 : DEFAULT_ROUGHNESS[name], metalness: 0.0,
    });
    m.name = "material:" + name;
    this._materials.set(name, m);
    return m;
  }

  // --- cuerpo de sistema -----------------------------------------------------

  // Anade una pieza del cuerpo de sistema ya decodificada con
  // `bodyMesh.decodeBodyMesh`. Devuelve el objeto de three.js.
  addSystemPart(name, mesh, opts = {}) {
    const THREE = this.THREE;
    const spec = SYSTEM_BODY_PARTS[name];
    if (!spec) throw new Error("avatarMesh: pieza desconocida «" + name + "»");
    const material = opts.material || this.materialFor(name);
    const arrays = bodyBaseArrays(mesh);
    const skinned = spec.skin && mesh.hasWeights && !!mesh.weights;
    let object;
    if (skinned) {
      object = buildBodyMesh(THREE, mesh, this.binding, { palette: opts.palette, arrays, material });
    } else {
      const geo = this.geometryFromArrays(mesh, arrays);
      object = new THREE.Mesh(geo, material);
      object.name = "sistema:" + name;
      const parentName = spec.parent && jointIndex(spec.parent) >= 0 ? spec.parent : null;
      const parent = parentName ? this.binding.byName.get(parentName) : this.group;
      (parent || this.group).add(object);
    }
    if (skinned) this.group.add(object);
    object.userData.systemPart = name;
    this.systemParts.set(name, { mesh, object, arrays, skinned });
    if (this.morphs.size) this._refreshPartMorphs(this.systemParts.get(name));
    return object;
  }

  // Geometria simple (sin piel) a partir de las copias de trabajo.
  geometryFromArrays(mesh, arrays) {
    const THREE = this.THREE;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(arrays.positions.slice(), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(arrays.normals.slice(), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(arrays.uvs.slice(), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(mesh.indices), 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  // Carga varias piezas de golpe a partir de los bytes crudos.
  // `bytesByName` = { head: Uint8Array, upperBody: ..., ... }.
  loadSystemBody(bytesByName, opts = {}) {
    const added = {};
    for (const name in bytesByName) {
      const bytes = bytesByName[name];
      if (!bytes) continue;
      const mesh = bytes.__decodedBodyMesh ? bytes : decodeBodyMesh(bytes, opts.decode);
      added[name] = this.addSystemPart(name, mesh, opts.parts && opts.parts[name]);
    }
    return added;
  }

  // --- mallas adjuntas (LLMESH) ---------------------------------------------

  // Anade una malla de las que reparte el retransmisor. Si trae pesos se ata al
  // esqueleto (cuerpo/cabeza mesh, ropa riggeada); si no, se cuelga del punto de
  // anclaje que se pida (un accesorio). `asset` es lo que devuelve
  // `llmesh.decodeMeshAsset`.
  addMeshAsset(asset, opts = {}) {
    const THREE = this.THREE;
    const hasSkin = !!(asset.skin && !asset.skin.discarded && asset.skin.jointNames.length);
    const material = opts.material || this.materialFor(opts.name || "mesh");
    let object;
    if (hasSkin) {
      object = buildSkinnedMesh(THREE, asset, this.binding, { lod: opts.lod, material });
      if (object) this.group.add(object);
    } else if (opts.attach) {
      const holder = this.attachmentNode(opts.attach);
      object = opts.build ? opts.build(THREE) : null;
      if (holder && object) holder.add(object);
    }
    if (!object) return null;
    const id = opts.id === undefined ? this._nextId++ : opts.id;
    object.name = opts.name || ("malla:" + id);
    this.meshAssets.set(id, { asset, object, skinned: !!hasSkin, attach: opts.attach || null });
    return object;
  }

  // Quita una malla adjunta (al desprenderse de una ropa u objeto).
  removeMeshAsset(id) {
    const entry = this.meshAssets.get(id);
    if (!entry) return false;
    if (entry.object.parent) entry.object.parent.remove(entry.object);
    if (entry.object.geometry) entry.object.geometry.dispose();
    this.meshAssets.delete(id);
    return true;
  }

  // --- puntos de anclaje ----------------------------------------------------

  // Nodo del punto de anclaje (se crea la primera vez).
  attachmentNode(ref) {
    const point = typeof ref === "object" && ref !== null ? ref : attachmentPoint(ref);
    if (!point) return null;
    if (!this.attachmentNodes.has(point.location)) {
      const holder = attachToSkeleton(this.THREE, this.binding, point, null);
      if (holder) this.attachmentNodes.set(point.location, holder);
    }
    return this.attachmentNodes.get(point.location) || null;
  }

  // Cuelga un objeto cualquiera de three.js en un punto de anclaje.
  attachObject(ref, object) {
    const holder = this.attachmentNode(ref);
    if (!holder) return null;
    if (object) holder.add(object);
    return object || holder;
  }

  // Cambia el material de una pieza ya montada. Es el gancho con el que se le
  // pone encima la piel compuesta en `skinTexture.js` cuando termina de
  // cocerse (o el `bake` que traiga el retransmisor).
  setPartMaterial(name, material) {
    const part = this.systemParts.get(name);
    if (!part || !material) return false;
    const previous = part.object.material;
    part.object.material = material;
    this._materials.set(name, material);
    // El material plano que se crea por defecto se tira; uno que haya puesto
    // quien llama no se toca.
    if (previous && previous !== material && typeof previous.name === "string"
      && previous.name.indexOf("material:") === 0 && previous.dispose) previous.dispose();
    return true;
  }

  // Muestra u oculta una pieza del cuerpo de sistema. La falda solo se ve
  // cuando el residente lleva una falda puesta (su textura por defecto es
  // transparente), así que por defecto va oculta.
  setPartVisible(name, visible) {
    const part = this.systemParts.get(name);
    if (!part) return false;
    part.object.visible = !!visible;
    return true;
  }

  // --- parametros visuales (morphs del cuerpo de sistema) -------------------

  // Aplica pesos de morph (nombre -> 0..1). Los nombres son los de
  // `avatar_lad.xml` y los de las propias mallas: "Big_Belly_Torso",
  // "Breast_Gravity", "Blink_Left", "Big_Ears"...
  setMorphs(weights) {
    for (const name in weights) {
      const w = weights[name];
      if (w) this.morphs.set(name, w);
      else this.morphs.delete(name);
    }
    for (const part of this.systemParts.values()) this._refreshPartMorphs(part);
    return this;
  }

  morphNames() {
    const names = new Set();
    for (const part of this.systemParts.values()) for (const m of part.mesh.morphs) names.add(m.name);
    return [...names];
  }

  // Recalcula los vertices de una pieza desde su base + los morphs activos y
  // los sube a la GPU.
  _refreshPartMorphs(part) {
    const mesh = part.mesh;
    if (!mesh.morphs.length) return;
    const dst = {
      positions: part.arrays.positions.slice(),
      normals: part.arrays.normals.slice(),
      binormals: part.arrays.binormals.slice(),
      uvs: part.arrays.uvs.slice(),
    };
    applyBodyMorphs(mesh, dst, Object.fromEntries(this.morphs));
    const g = part.object.geometry;
    const set = (attr, arr) => {
      const a = g.getAttribute(attr);
      if (!a || a.array.length !== arr.length) { g.setAttribute(attr, new this.THREE.BufferAttribute(arr.slice(), attr === "uv" ? 2 : 3)); return; }
      a.array.set(arr);
      a.needsUpdate = true;
    };
    set("position", dst.positions);
    set("normal", dst.normals);
    set("uv", dst.uvs);
    g.computeBoundingBox();
    g.computeBoundingSphere();
  }

  // --- distorsion del esqueleto (parametros visuales tipo `param_skeleton`) ---

  // Guarda la escala y la posicion de reposo de un hueso la primera vez que se
  // toca, para poder volver a ellas sin acumular error.
  _restOf(name) {
    const bone = this.binding.byName.get(name);
    if (!bone) return null;
    let rest = this.boneRest.get(name);
    if (!rest) {
      rest = { scale: bone.scale.clone(), position: bone.position.clone() };
      this.boneRest.set(name, rest);
    }
    return rest;
  }

  // Aplica una lista de deltas de hueso EN EL MARCO DE SECOND LIFE, tal como
  // los devuelve `avatarLad.resolveAppearance`. Cada delta es una escala que se
  // SUMA a la de reposo (y, opcionalmente, un desplazamiento). El visor oficial
  // hace lo mismo en `LLPolySkeletalDistortion::apply`:
  //   newScale = rest + peso * delta   (se acumula sobre la pose de reposo).
  // Los hijos heredan la escala sola colision (los volumenes de colision, que
  // aqui no se dibujan), asi que no hay que propagar nada.
  applyBoneDeltas(deltas) {
    this.resetBoneDistortions();
    if (!deltas || !deltas.length) return 0;
    const perm = SL_BONE_SCALE_PERMUTATION;
    let applied = 0;
    for (const d of deltas) {
      const rest = this._restOf(d.name);
      if (!rest) continue;
      const bone = this.binding.byName.get(d.name);
      const s = d.scale || [0, 0, 0];
      const next = [
        rest.scale.x + s[perm[0]],
        rest.scale.y + s[perm[1]],
        rest.scale.z + s[perm[2]],
      ];
      // Una escala de 0 o negativa colapsa o invierte el hueso: se acota por
      // seguridad (el visor tambien ignora escalas degeneradas al dibujar).
      bone.scale.set(
        Math.abs(next[0]) < 1e-6 ? 1e-6 : next[0],
        Math.abs(next[1]) < 1e-6 ? 1e-6 : next[1],
        Math.abs(next[2]) < 1e-6 ? 1e-6 : next[2],
      );
      if (d.pos) {
        const p = slVecToAvatar(d.pos);
        bone.position.set(rest.position.x + p[0], rest.position.y + p[1], rest.position.z + p[2]);
        bone.userData.shapeOffset = p;
      } else {
        bone.userData.shapeOffset = [0, 0, 0];
      }
      this._distortedBones.add(d.name);
      applied++;
    }
    this.binding.root.updateMatrixWorld(true);
    return applied;
  }

  // Devuelve todos los huesos distorsionados a la pose de reposo.
  resetBoneDistortions() {
    for (const name of this._distortedBones) {
      const rest = this.boneRest.get(name);
      const bone = this.binding.byName.get(name);
      if (!rest || !bone) continue;
      bone.scale.copy(rest.scale);
      bone.position.copy(rest.position);
      bone.userData.shapeOffset = [0, 0, 0];
    }
    this._distortedBones.clear();
    return this;
  }

  // Cuantos huesos estan deformados ahora mismo (para el HUD/diagnostico).
  boneDistortionCount() { return this._distortedBones.size; }

  // --- animaciones ----------------------------------------------------------

  // Reproduce una animacion ya decodificada (`anim.parseAnim`). `opts` va tal
  // cual a `AnimInstance`: gain, timeScale, priority...
  play(parsed, opts) { return this.animator.play(parsed, opts); }
  stop(instance) { this.animator.stop(instance); }
  stopAll() { this.animator.stopAll(); }

  // Avanza el reloj del avatar y aplica la mezcla al esqueleto.
  update(dt) {
    this.time += dt;
    this.animator.apply(this.time);
    this.binding.root.updateMatrixWorld(true);
  }

  // --- diagnostico ----------------------------------------------------------

  stats() {
    let tris = 0, verts = 0;
    for (const p of this.systemParts.values()) { verts += p.mesh.vertexCount; tris += p.mesh.faceCount; }
    const meshes = [];
    for (const [id, e] of this.meshAssets) {
      const s = e.asset ? meshStats(e.asset) : null;
      meshes.push({ id, name: e.object.name, skinned: e.skinned, attach: e.attach, triangles: s ? s.triangles : 0, joints: s ? s.jointNames : 0 });
    }
    return {
      systemParts: [...this.systemParts.keys()],
      systemVertices: verts, systemTriangles: tris,
      meshAssets: meshes,
      attachmentPoints: [...this.attachmentNodes.keys()],
      morphs: Object.fromEntries(this.morphs),
      boneDistortions: [...this._distortedBones],
      animations: this.animator.instances.length,
      bones: this.binding.bones.length,
    };
  }

  // Suelta geometrias y materiales.
  dispose() {
    const kill = (o) => {
      if (!o) return;
      if (o.geometry) o.geometry.dispose();
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      for (const c of o.children) kill(c);
    };
    kill(this.group);
    this._materials.clear();
    this.systemParts.clear();
    this.meshAssets.clear();
    this.attachmentNodes.clear();
  }
}

export function createAvatarMesh(THREE, opts) { return new AvatarMesh(THREE, opts); }

// --- autotest -----------------------------------------------------------------

// Monta un avatar completo con piezas SINTETICAS (un cuerpo de sistema escrito
// con `encodeBodyMesh`, una malla LLMESH escrita con `encodeMeshAsset`, un
// objeto anclado y una animacion) y comprueba que todo queda en su sitio, que
// los morphs mueven los vertices, que el anclaje sigue a la muneca y que la
// animacion gira el hueso. Es asincrono porque los activos LLMESH se comprimen.
export async function runAvatarMeshSelfTest(THREE) {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });
  if (!THREE) {
    return { checks: [{ name: "sin THREE no hay nada que montar", pass: false }], total: 1, failed: 1, summary: "avatarMesh selftest: se necesita THREE" };
  }

  const { encodeBodyMesh } = await import("./bodyMesh.js");
  const { encodeMeshAsset, encodeSubmesh } = await import("./llmesh.js");
  const { encodeAnim, parseAnim } = await import("./anim.js");

  // Cabeza sintetica: 4 vertices, atados a mHead, con un morph que la estira.
  const headJoints = ["mHead", "mNeck"];
  const n = 4;
  const coords = new Float32Array([0, 0, 1.70, 0.05, 0, 1.72, 0.05, 0.05, 1.74, 0, 0.05, 1.76]);
  const normals = new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const weights = new Float32Array([1, 2, 2, 1]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const headBytes = encodeBodyMesh({
    hasWeights: true, coords, normals, texCoords: uvs, weights, indices, jointNames: headJoints,
    morphs: [{
      name: "Test_Head_Squash",
      indices: new Uint32Array([0, 3]),
      coords: new Float32Array([0.1, 0, 0, 0, 0, 0.2]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0]),
      binormals: new Float32Array(6),
      texCoords: new Float32Array(4),
    }],
  });

  const avatar = new AvatarMesh(THREE, { name: "prueba" });
  ok("monta el esqueleto", avatar.binding.bones.length === 133);
  ok("el grupo contiene el esqueleto", avatar.group.children.includes(avatar.binding.root));

  const headObj = avatar.addSystemPart("head", decodeBodyMesh(headBytes));
  ok("cabeza anadida como SkinnedMesh", !!headObj && headObj.isSkinnedMesh === true);
  ok("cabeza: 4 vertices", headObj.geometry.getAttribute("position").count === 4);
  ok("cabeza atada al esqueleto del avatar",
    headObj.skeleton.bones.length === avatar.binding.bones.length
    && headObj.skeleton.bones.every((b, i) => b === avatar.binding.bones[i]));
  ok("la cabeza cuelga del grupo (no de un hueso)", headObj.parent === avatar.group);

  // El ojo va SIN pesos: es hijo directo de mEyeLeft.
  const eye = decodeBodyMesh(encodeBodyMesh({
    hasWeights: false, coords: new Float32Array([0, -0.02, -0.02, 0.02, 0, 0, 0, 0.02, 0.02, 0.02, 0, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  }));
  const eyeObj = avatar.addSystemPart("eyeLeft", eye);
  ok("el ojo es un Mesh normal", !!eyeObj && eyeObj.isMesh === true && !eyeObj.isSkinnedMesh);
  ok("el ojo cuelga de mEyeLeft", eyeObj.parent === avatar.binding.byName.get("mEyeLeft"));

  // Malla LLMESH sintetica: una caja atada a mTorso y mPelvis.
  const boxPos = new Float32Array(8 * 3);
  const center = [0, 1.35, 0];
  let bi = 0;
  for (const dx of [-0.1, 0.1]) for (const dy of [-0.1, 0.1]) for (const dz of [-0.1, 0.1]) {
    boxPos[bi * 3] = center[0] + dx; boxPos[bi * 3 + 1] = center[1] + dy; boxPos[bi * 3 + 2] = center[2] + dz;
    bi++;
  }
  const boxIdx = new Uint16Array([
    0, 1, 3, 0, 3, 2, // -X
    4, 6, 7, 4, 7, 5, // +X
    0, 4, 5, 0, 5, 1, // -Y
    2, 3, 7, 2, 7, 6, // +Y
    0, 2, 6, 0, 6, 4, // -Z
    1, 5, 7, 1, 7, 3, // +Z
  ]);
  const boxWeights = new Float32Array(8 * 4);
  for (let v = 0; v < 8; v++) { boxWeights[v * 4] = 0.75; boxWeights[v * 4 + 1] = 1 + 0.25; }
  const torso = [0, 0, 1.319];
  const invBind = (t) => { const m = new Array(16).fill(0); m[0] = m[5] = m[10] = m[15] = 1; m[12] = -t[0]; m[13] = -t[1]; m[14] = -t[2]; return m; };
  const ident = () => { const m = new Array(16).fill(0); m[0] = m[5] = m[10] = m[15] = 1; return m; };
  const meshAssetBytes = await encodeMeshAsset({
    skin: { joint_names: ["mTorso", "mPelvis"], inverse_bind_matrix: [invBind(torso), invBind([0, 0, 1.067])], bind_shape_matrix: ident() },
    lods: { high_lod: [encodeSubmesh(boxPos, boxIdx, { normals: new Float32Array(boxPos.length), uvs: new Float32Array(16), weights: boxWeights, weightCount: 8 })] },
  });
  const { decodeMeshAsset } = await import("./llmesh.js");
  const asset = await decodeMeshAsset(meshAssetBytes);
  const meshObj = avatar.addMeshAsset(asset, { name: "cuerpo-mesh", id: "torso-mesh" });
  ok("malla adjunta atada al esqueleto", !!meshObj && meshObj.isSkinnedMesh === true);
  ok("malla adjunta en el grupo", meshObj.parent === avatar.group);
  ok("se puede quitar la malla adjunta", avatar.removeMeshAsset("torso-mesh") === true && avatar.meshAssets.size === 0);

  // Objeto anclado en la mano derecha.
  const sword = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.4), new THREE.MeshBasicMaterial());
  avatar.attachObject("ATTACH_RHAND", sword);
  avatar.binding.root.updateMatrixWorld(true);
  const holder = avatar.attachmentNodes.get("ATTACH_RHAND");
  ok("anclaje creado en la mano derecha", !!holder && holder.parent === avatar.binding.byName.get("mWristRight"));
  const swordWorld = new THREE.Vector3();
  const holderWorld = new THREE.Vector3();
  holder.getWorldPosition(holderWorld);
  sword.getWorldPosition(swordWorld);
  // En el marco del visor la mano derecha esta en +X (SL -Y).
  ok("la espada esta junto a la mano derecha (x>0.1)", holderWorld.x > 0.1, holderWorld.x.toFixed(3));
  ok("la espada cuelga del nodo del anclaje", swordWorld.distanceTo(holderWorld) < 0.05, swordWorld.distanceTo(holderWorld).toFixed(4));
  ok("attachObject devuelve el nodo del anclaje", avatar.attachObject("ATTACH_RHAND", null) === holder);

  // Morphs: mover la cabeza.
  const posAttr = headObj.geometry.getAttribute("position");
  const beforeMorph = posAttr.getX(0);
  avatar.setMorphs({ Test_Head_Squash: 1 });
  ok("el morph mueve el vertice 0", Math.abs(posAttr.getX(0) - beforeMorph - 0.1) < 1e-6, posAttr.getX(0) - beforeMorph);
  avatar.setMorphs({ Test_Head_Squash: 0 });
  ok("al quitar el morph vuelve a su sitio", Math.abs(posAttr.getX(0) - beforeMorph) < 1e-5, posAttr.getX(0) - beforeMorph);
  ok("morphNames lista el morph", avatar.morphNames().includes("Test_Head_Squash"));

  // Distorsion del esqueleto: escala un hueso y comprueba que se puede volver.
  const neckBone = avatar.binding.byName.get("mNeck");
  const neckRest = neckBone.scale.toArray();
  avatar.applyBoneDeltas([{ name: "mNeck", scale: [0, 0.2, 0], pos: null }]);
  ok("applyBoneDeltas escala el hueso (marco SL -> marco del visor)",
    Math.abs(neckBone.scale.x - (neckRest[0] + 0.2)) < 1e-6 && Math.abs(neckBone.scale.y - neckRest[1]) < 1e-6,
    neckBone.scale.toArray().join(","));
  ok("cuenta el hueso deformado", avatar.boneDistortionCount() === 1);
  ok("los huesos que no existen se ignoran", avatar.applyBoneDeltas([{ name: "mNoExiste", scale: [1, 1, 1] }]) === 0);
  avatar.resetBoneDistortions();
  ok("resetBoneDistortions devuelve la escala de reposo", neckBone.scale.toArray().every((v, i) => Math.abs(v - neckRest[i]) < 1e-6));
  const neckPosBefore = neckBone.position.toArray();
  avatar.applyBoneDeltas([{ name: "mNeck", scale: [0, 0, 0], pos: [0.05, 0, 0] }]);
  ok("el desplazamiento de hueso se convierte de marco",
    Math.abs(neckBone.position.x - neckPosBefore[0]) < 1e-6 && Math.abs(neckBone.position.z - (neckPosBefore[2] - 0.05)) < 1e-6,
    neckBone.position.toArray().join(","));
  ok("guarda el desplazamiento para las animaciones",
    neckBone.userData.shapeOffset && Math.abs(neckBone.userData.shapeOffset[2] + 0.05) < 1e-6,
    JSON.stringify(neckBone.userData.shapeOffset));
  avatar.resetBoneDistortions();
  ok("reset tambien limpia el desplazamiento", neckBone.userData.shapeOffset.every((v) => v === 0));

  // Animacion: girar mHead 90 grados y ver que el hueso se mueve.
  const anim = parseAnim(encodeAnim({
    basePriority: 2, duration: 1.0, emoteName: "test", loop: true, loopInPoint: 0, loopOutPoint: 1,
    easeInDuration: 0, easeOutDuration: 0, handPose: 0,
    joints: [{ name: "mHead", priority: -1, rotations: [{ time: 0, rot: [0, 0, 0, 1] }, { time: 1, rot: [0, 0.70710678, 0, 0.70710678] }], positions: [] }],
    constraints: [],
  }));
  const headBone = avatar.binding.byName.get("mHead");
  const restQuat = headBone.quaternion.toArray();
  avatar.play(anim, { gain: 1 });
  avatar.update(0.5);
  // La animacion gira mHead 90 grados: el angulo del cuaternion tiene que ser
  // grande. Se mide el angulo (no un componente) porque el cambio de marco de
  // SL al del visor reparte el giro entre los ejes.
  const angle = 2 * Math.acos(Math.min(1, Math.abs(headBone.quaternion.w)));
  ok("la animacion gira mHead", angle > 0.5, angle.toFixed(3));
  avatar.stopAll();
  avatar.update(0.01);
  const back = headBone.quaternion.toArray().every((v, i) => Math.abs(v - restQuat[i]) < 1e-5);
  ok("al parar vuelve a la pose de reposo", back, headBone.quaternion.toArray().map((v) => v.toFixed(4)).join(","));

  const st = avatar.stats();
  ok("stats: 2 piezas de sistema y 1 anclaje", st.systemParts.length === 2 && st.attachmentPoints.length === 1, JSON.stringify(st.systemParts));

  avatar.dispose();
  ok("dispose vacia las piezas", avatar.systemParts.size === 0 && avatar._materials.size === 0);

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "avatarMesh selftest: all " + checks.length + " checks passed"
      : "avatarMesh selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
