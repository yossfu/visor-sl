// meshImport.js -- traer una malla 3D de fuera y montarla sobre el esqueleto de
// Second Life.
//
// El visor ya sabe dibujar el cuerpo de SISTEMA de SL (`avatarMesh.js`) y las
// mallas LLMESH que reparte el retransmisor. Este modulo cubre el otro camino: un
// fichero suelto (GLB/GLTF/OBJ) que el usuario descarga o suelta en la pagina y
// quiere ponerse encima. Es lo que hace falta para una CABEZA MESH o un CUERPO
// MESH (Lelutka, Catwa, Maitreya, Legacy, Belleza...), que al final no son mas
// que mallas riggeadas al mismo esqueleto Bento de 133 huesos.
//
// El problema no es leer el fichero -- de eso se encargan los cargadores de
// three.js -- sino que cada exportador cambia el marco (SL mira a +X, Blender
// exporta a Y-arriba), la escala (metros o centimetros), el origen y, sobre todo,
// el nombre y la orientacion de reposo de cada hueso. Aqui se hace:
//
//   1. EMPAREJAR huesos por nombre (los mNombres y los alias historicos de
//      `skeleton.js`, normalizados y sin prefijos de exportador).
//   2. ALINEAR la malla con el esqueleto del visor: con las posiciones de reposo
//      de los huesos emparejados se calcula la rotacion + escala + traslacion
//      (metodo de Horn/Kabsch) que superpone una sobre la otra. Asi una malla
//      descargada aterriza en su sitio aunque venga girada, escalada o con otro
//      origen, sin que el usuario toque nada.
//   3. RETRANSMITIR: cada fotograma se copian las rotaciones del esqueleto del
//      visor a los huesos de la malla. Se copia el giro RELATIVO a la pose de
//      reposo, y se hace pasando por el giro de mundo, asi que funciona aunque la
//      malla use orientaciones de hueso distintas (las que inventa Blender, por
//      ejemplo) o tenga los huesos colgando de nodos que no son huesos.
//
// Lo que NO hace: descargar activos de SL por su cuenta. Eso sigue necesitando
// la sesion del usuario (`VIEWER-REAL.md`); aqui solo se monta lo que el usuario
// ya tenga en un fichero o en una URL publica.

import { SL_JOINTS, SL_JOINT_INDEX, restWorldPositions, buildSkeleton } from "./skeleton.js";

// --- nombres de hueso -------------------------------------------------------

// "mHead" -> "mhead", "avatar_mHead" -> "avatarmhead", "mixamorig:Hips" ->
// "mixamorighips". Quita todo lo que no sea letra o digito y baja a minusculas.
export function normalizeBoneName(raw) {
  if (raw === undefined || raw === null) return "";
  return String(raw).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Tabla de normalizado -> indice de articulacion, con los nombres buenos y los
// alias.
const NORMALIZED_JOINT = (() => {
  const m = new Map();
  SL_JOINTS.forEach((j, i) => {
    const put = (k) => { const n = normalizeBoneName(k); if (n && !m.has(n)) m.set(n, i); };
    put(j.name);
    for (const a of j.aliases.split(/\s+/)) put(a);
  });
  return m;
})();

// Prefijos que meten los exportadores delante del nombre del hueso.
const NAME_PREFIXES = ["mixamorig", "armature", "rootnode", "bone", "joint", "jnt", "b", "j"];

// Variantes de un nombre normalizado que merece la pena probar: sin digitos
// finales, en singular, y sin prefijo de exportador.
function nameCandidates(n) {
  const out = [n];
  const noDigits = n.replace(/\d+$/, "");
  if (noDigits !== n) out.push(noDigits);
  const forms = out.slice();
  for (const f of forms) {
    if (f.length > 1 && f.endsWith("s")) out.push(f.slice(0, -1));
  }
  for (const f of out.slice()) {
    for (const p of NAME_PREFIXES) {
      if (f.length > p.length + 1 && f.startsWith(p)) {
        const rest = f.slice(p.length);
        out.push(rest);
        if (rest.length > 1 && rest.endsWith("s")) out.push(rest.slice(0, -1));
      }
    }
  }
  return out;
}

// Indice de articulacion de SL para un nombre de hueso de fuera, o -1.
export function matchJointIndex(rawName) {
  const n = normalizeBoneName(rawName);
  if (!n) return -1;
  for (const c of nameCandidates(n)) {
    const hit = NORMALIZED_JOINT.get(c);
    if (hit !== undefined) return hit;
  }
  return -1;
}

// --- emparejar los huesos de una malla con los del esqueleto -----------------

// Recorre el modelo buscando `Bone`s y los casa por nombre con las
// articulaciones de SL.
//
// Devuelve { pairs, unmatchedModel, unmatchedSl }:
//   pairs          [{ sl: Bone del visor, imp: Bone de la malla, jointIndex }]
//   unmatchedModel nombres de huesos de la malla que no son de SL
//   unmatchedSl    nombres de articulaciones de SL sin hueso en la malla
export function matchModelBones(binding, modelRoot) {
  const impByName = new Map();
  modelRoot.traverse((o) => { if (o.isBone && o.name && !impByName.has(o.name)) impByName.set(o.name, o); });
  const used = new Set();
  const pairs = [];
  const unmatchedModel = [];
  for (const [name, bone] of impByName) {
    const ji = matchJointIndex(name);
    if (ji < 0) { unmatchedModel.push(name); continue; }
    const sl = binding.bones[ji];
    if (!sl || used.has(ji)) { unmatchedModel.push(name); continue; }
    used.add(ji);
    pairs.push({ sl, imp: bone, jointIndex: ji });
  }
  const unmatchedSl = SL_JOINTS.filter((j, i) => !used.has(i)).map((j) => j.name);
  return { pairs, unmatchedModel, unmatchedSl };
}

// --- alineacion (Horn / Kabsch con escala) ----------------------------------

// Eigenvector dominante de una matriz simetrica 4x4 por iteracion de potencia.
function dominantEigenvector4(m, iters = 96) {
  let v = [1, 0, 0, 0];
  for (let it = 0; it < iters; it++) {
    const x = v[0], y = v[1], z = v[2], w = v[3];
    const o = [
      m[0] * x + m[1] * y + m[2] * z + m[3] * w,
      m[4] * x + m[5] * y + m[6] * z + m[7] * w,
      m[8] * x + m[9] * y + m[10] * z + m[11] * w,
      m[12] * x + m[13] * y + m[14] * z + m[15] * w,
    ];
    const len = Math.hypot(o[0], o[1], o[2], o[3]);
    if (!len) return [1, 0, 0, 0];
    v = [o[0] / len, o[1] / len, o[2] / len, o[3] / len];
  }
  return v;
}

function rotateVecByQuat(v, q) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

// Rotacion + escala + traslacion que lleva los puntos `from` sobre `to`. El
// resultado es { quat:[x,y,z,w], scale, pos:[x,y,z], rms }, para usarlo tal cual
// en un Object3D (posicion, cuaternion, escala).
export function rigidAlignment(from, to) {
  const n = Math.min(from.length, to.length);
  if (n < 4) return null;
  const cFrom = [0, 0, 0], cTo = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { cFrom[k] += from[i][k] / n; cTo[k] += to[i][k] / n; }
  // S = suma de b_i a_i^T  (b = from centrado, a = to centrado).
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  let varFrom = 0;
  for (let i = 0; i < n; i++) {
    const b = [from[i][0] - cFrom[0], from[i][1] - cFrom[1], from[i][2] - cFrom[2]];
    const a = [to[i][0] - cTo[0], to[i][1] - cTo[1], to[i][2] - cTo[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += b[r] * a[c];
    varFrom += b[0] * b[0] + b[1] * b[1] + b[2] * b[2];
  }
  if (varFrom <= 0) return null;
  const sxx = S[0], sxy = S[1], sxz = S[2];
  const syx = S[3], syy = S[4], syz = S[5];
  const szx = S[6], szy = S[7], szz = S[8];
  const N = [
    sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
    syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
    szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
    sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
  ];
  const e = dominantEigenvector4(N);
  // Horn da (w,x,y,z); three quiere (x,y,z,w).
  const q1 = [e[1], e[2], e[3], e[0]];
  const q2 = [-e[1], -e[2], -e[3], e[0]];
  const norm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
  const cand = [norm(q1), norm(q2)];
  // La rotacion que buscamos es la que maximiza la proyeccion (Kabsch); se
  // eligen las dos posibles manos y gana la mejor, asi el signo del
  // eigenvector da igual.
  let quat = cand[0], best = -Infinity;
  for (const c of cand) {
    let d = 0;
    for (let i = 0; i < n; i++) {
      const b = [from[i][0] - cFrom[0], from[i][1] - cFrom[1], from[i][2] - cFrom[2]];
      const a = [to[i][0] - cTo[0], to[i][1] - cTo[1], to[i][2] - cTo[2]];
      const rb = rotateVecByQuat(b, c);
      d += a[0] * rb[0] + a[1] * rb[1] + a[2] * rb[2];
    }
    if (d > best) { best = d; quat = c; }
  }
  let dot = 0;
  for (let i = 0; i < n; i++) {
    const b = [from[i][0] - cFrom[0], from[i][1] - cFrom[1], from[i][2] - cFrom[2]];
    const a = [to[i][0] - cTo[0], to[i][1] - cTo[1], to[i][2] - cTo[2]];
    const rb = rotateVecByQuat(b, quat);
    dot += a[0] * rb[0] + a[1] * rb[1] + a[2] * rb[2];
  }
  const scale = dot / varFrom;
  if (!isFinite(scale) || scale <= 1e-6) return null;
  const rb = rotateVecByQuat(cFrom, quat);
  const pos = [cTo[0] - scale * rb[0], cTo[1] - scale * rb[1], cTo[2] - scale * rb[2]];
  let err = 0;
  for (let i = 0; i < n; i++) {
    // Ojo: `pos` esta calculado para el punto ORIGINAL (to = pos + s R from), no
    // para el centrado, asi que aqui se usa from[i] tal cual.
    const r = rotateVecByQuat(from[i], quat);
    const px = pos[0] + scale * r[0], py = pos[1] + scale * r[1], pz = pos[2] + scale * r[2];
    err += (px - to[i][0]) ** 2 + (py - to[i][1]) ** 2 + (pz - to[i][2]) ** 2;
  }
  return { quat, scale, pos, rms: Math.sqrt(err / n) };
}

// --- transformadas relativas dentro de un arbol ------------------------------

// Matriz de `node` en el espacio de `base` (incluyendo el propio transform local
// de `base`): el producto de las matrices locales desde `base` hasta `node`.
// Devuelve null si `node` no cuelga de `base`.
export function relativeMatrix(THREE, node, base) {
  const chain = [];
  let cur = node;
  while (cur) { chain.push(cur); if (cur === base) break; cur = cur.parent; }
  if (chain[chain.length - 1] !== base) return null;
  const m = new THREE.Matrix4();
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].updateMatrix) chain[i].updateMatrix();
    m.multiply(chain[i].matrix);
  }
  return m;
}

// --- el montaje --------------------------------------------------------------

// Monta un modelo importado sobre un esqueleto de SL y devuelve el util para
// animarlo.
//
//   const rig = createImportedRig({ THREE, binding, modelRoot });
//   avatar.group.add(rig.model);
//   // en el bucle, despues de avatar.update(dt):
//   rig.sync();
//
// `binding` es lo que devuelve `buildSkeleton`. `modelRoot` es la raiz del
// modelo cargado (p. ej. `gltf.scene`). El modelo se cuelga de un envoltorio
// (`rig.model`) con la alineacion aplicada: añade ESE envoltorio al grupo del
// avatar, no la raiz del modelo. Conviene llamar a este constructor con el
// modelo aun sin padre (o sera su transform el que se tenga en cuenta).
export function createImportedRig({ THREE, binding, modelRoot, align = true, name = "modeloImportado" }) {
  const matched = matchModelBones(binding, modelRoot);

  // Las medidas se hacen en el espacio del padre del modelo, que es el mismo en
  // el que quedara el envoltorio (el modelo se re-cuelga de el): asi el
  // transform del modelo se conserva y da igual que tuviera antepasados.
  const modelMatrix = (node) => relativeMatrix(THREE, node, modelRoot);

  // Rotacion pura de una matriz, aunque tenga escala (o no sea uniforme).
  const _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const quatOf = (m) => { const q = new THREE.Quaternion(); m.decompose(_p, q, _s); return q; };

  // Puntos de reposo emparejados, para la alineacion. El lado del visor sale de
  // la definicion del esqueleto (`restWorldPositions`), no de los huesos vivos:
  // asi se puede montar una malla en cualquier momento, aunque el esqueleto este
  // a mitad de una animacion.
  const restSlPositions = restWorldPositions();
  const slRestPoint = (ji) => [restSlPositions[ji * 3], restSlPositions[ji * 3 + 1], restSlPositions[ji * 3 + 2]];
  // En la version 2.0 del esqueleto no hay rotaciones de reposo, asi que el giro
  // de mundo de reposo de cualquier articulacion es la identidad. Si eso
  // cambiara, habria que componer aqui las rotaciones de SL_JOINTS.
  const fromPts = [], toPts = [];
  const pairs = matched.pairs.map((p) => {
    const mImp = modelMatrix(p.imp);
    const from = mImp ? [mImp.elements[12], mImp.elements[13], mImp.elements[14]] : [0, 0, 0];
    const to = slRestPoint(p.jointIndex);
    if (mImp) { fromPts.push(from); toPts.push(to); }
    return { ...p, from, to, depth: 0, restTo: to };
  });

  let alignment = null;
  if (align && fromPts.length >= 4) {
    alignment = rigidAlignment(fromPts, toPts);
    if (alignment && (!isFinite(alignment.scale) || alignment.scale < 0.02 || alignment.scale > 60 || !isFinite(alignment.rms))) alignment = null;
  }

  const wrapper = new THREE.Group();
  wrapper.name = name;
  const alignQuat = alignment ? new THREE.Quaternion(alignment.quat[0], alignment.quat[1], alignment.quat[2], alignment.quat[3]) : new THREE.Quaternion();
  const alignPos = alignment ? new THREE.Vector3(alignment.pos[0], alignment.pos[1], alignment.pos[2]) : new THREE.Vector3();
  if (alignment) {
    wrapper.quaternion.copy(alignQuat);
    wrapper.scale.setScalar(alignment.scale);
    wrapper.position.copy(alignPos);
  }
  wrapper.add(modelRoot);

  // Ademas de las rotaciones se pueden retransmitir las TRASLACIONES: hay
  // animaciones de SL que mueven la pelvis (el balanceo al andar, agacharse al
  // sentarse) y sin esto la malla se queda "clavada" mientras el esqueleto del
  // visor sube y baja. Solo se hace si la alineacion salio buena (la malla
  // comparte el esqueleto de SL); si el encaje tiene mucho error, mover los
  // huesos deformaria la malla.
  const retargetPos = align && !!alignment && alignment.rms < 0.03;
  const alignInvQuat = alignQuat.clone().invert();

  // Estado por hueso emparejado.
  const jointParentIndex = SL_JOINTS.map((j) => (j.parent ? SL_JOINT_INDEX.get(j.parent) : -1));
  const items = pairs.map((p) => {
    let depth = 0, cur = p.imp;
    while (cur && cur !== modelRoot) { depth++; cur = cur.parent; }
    const mImp = modelMatrix(p.imp);
    const mPar = modelMatrix(p.imp.parent || modelRoot);
    const restImp = quatOf(mImp).premultiply(alignQuat);
    const restPar = mPar ? quatOf(mPar).premultiply(alignQuat) : alignQuat.clone();
    // Giro de reposo del visor: identidad (ver nota de arriba).
    const restSl = new THREE.Quaternion();
    return {
      sl: p.sl, imp: p.imp, jointIndex: p.jointIndex, depth,
      parent: p.imp.parent || null,
      restTo: p.restTo,
      restImp, restPar, restSl,
      offset: restImp.clone().multiply(restSl.clone().invert()),
    };
  });
  items.sort((a, b) => a.depth - b.depth);
  const itemByBone = new Map(items.map((it) => [it.imp, it]));

  // --- retransmision ---------------------------------------------------------
  const slWorld = new Array(binding.bones.length).fill(null).map(() => new THREE.Quaternion());
  const slPosWorld = new Array(binding.bones.length).fill(null).map(() => new THREE.Vector3());
  const targets = new Map();
  const posTargets = new Map();
  const tmpA = new THREE.Quaternion();
  const tmpB = new THREE.Quaternion();
  const tmpP = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();

  // Matriz (en el espacio del envoltorio) del padre de un hueso de la malla:
  // el producto de las matrices locales desde `modelRoot` hasta ese padre.
  function parentSpaceMatrix(it) {
    const par = it.imp.parent;
    if (!par) return tmpM.identity();
    const m = relativeMatrix(THREE, par, modelRoot);
    return m ? tmpM.copy(m) : tmpM.identity();
  }

  function sync() {
    // Posicion y giro del visor en el marco del grupo, de padre a hijo.
    for (let i = 0; i < binding.bones.length; i++) {
      const b = binding.bones[i];
      const pi = jointParentIndex[i];
      if (pi < 0) {
        slWorld[i].copy(b.quaternion);
        slPosWorld[i].copy(b.position);
      } else {
        slWorld[i].copy(slWorld[pi]).multiply(b.quaternion);
        slPosWorld[i].copy(b.position).applyQuaternion(slWorld[pi]).add(slPosWorld[pi]);
      }
    }
    // Giro y posicion de mundo que le tocan a cada hueso de la malla (en el
    // espacio del envoltorio: la alineacion lleva el punto del visor a la malla).
    for (const it of items) {
      tmpA.copy(it.offset).multiply(slWorld[it.jointIndex]);
      targets.set(it.imp, tmpA.clone());
      if (retargetPos) {
        // El envoltorio aplica `align` (pos + escala*giro) a la malla, asi que
        // para que un hueso caiga en el punto del visor hay que meterle la
        // inversa de `align`.
        tmpP.copy(slPosWorld[it.jointIndex]).sub(alignPos).applyQuaternion(alignInvQuat).multiplyScalar(1 / alignment.scale);
        posTargets.set(it.imp, tmpP.clone());
      }
    }
    // Local de cada hueso, de padre a hijo.
    for (const it of items) {
      const par = it.parent;
      const parItem = par ? itemByBone.get(par) : null;
      const parW = parItem ? targets.get(par) : it.restPar;
      tmpB.copy(parW).invert().multiply(targets.get(it.imp));
      it.imp.quaternion.copy(tmpB);
      if (retargetPos) {
        // M * posLocal = destino  =>  posLocal = M^-1 * destino
        tmpM.copy(parentSpaceMatrix(it)).invert();
        it.imp.position.copy(posTargets.get(it.imp)).applyMatrix4(tmpM);
        it.imp.updateMatrix();
      }
    }
  }

  // Error de encaje: distancia, en reposo, entre cada hueso emparejado y su
  // articulacion. Sirve para avisar si la malla no encaja (rig desconocido).
  function jointErrors() {
    const out = [];
    for (const it of items) {
      const mImp = modelMatrix(it.imp);
      if (!mImp) continue;
      const p = [mImp.elements[12], mImp.elements[13], mImp.elements[14]];
      const r = alignment ? rotateVecByQuat(p, alignment.quat) : p;
      const s = alignment ? alignment.scale : 1;
      const pp = alignment ? [alignment.pos[0] + s * r[0], alignment.pos[1] + s * r[1], alignment.pos[2] + s * r[2]] : p;
      const t = it.restTo;
      out.push({ name: it.sl.name, jointIndex: it.jointIndex, error: Math.hypot(pp[0] - t[0], pp[1] - t[1], pp[2] - t[2]) });
    }
    return out;
  }

  function dispose() {
    if (wrapper.parent) wrapper.parent.remove(wrapper);
    wrapper.traverse((o) => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m.dispose) m.dispose();
    });
  }

  return {
    model: wrapper,
    alignment,
    sync,
    jointErrors,
    dispose,
    matched: items.map((it) => it.sl.name),
    unmatchedModel: matched.unmatchedModel,
    unmatchedSl: matched.unmatchedSl,
    itemByBone,
    stats: () => ({
      matched: items.length,
      totalJoints: SL_JOINTS.length,
      modelBones: items.length + matched.unmatchedModel.length,
      unmatchedModel: matched.unmatchedModel.length,
      unmatchedSl: matched.unmatchedSl.length,
      alignment: alignment ? { scale: alignment.scale, rms: alignment.rms } : null,
      positionRetarget: retargetPos,
    }),
  };
}

// --- cargadores -------------------------------------------------------------

// Los cargadores de three.js se piden solo cuando hacen falta (pesan, y no todo
// el mundo va a importar una malla).
const THREE_BASE = "https://esm.sh/three@0.160.0";

export async function parseGltfBuffer(THREE, arrayBuffer, opts = {}) {
  const { GLTFLoader } = await import(THREE_BASE + "/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  return await new Promise((resolve, reject) => loader.parse(arrayBuffer, opts.path || "", resolve, reject));
}

export async function loadGltfUrl(url) {
  const { GLTFLoader } = await import(THREE_BASE + "/examples/jsm/loaders/GLTFLoader.js");
  const loader = new GLTFLoader();
  return await new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

export async function parseObjText(text) {
  const { OBJLoader } = await import(THREE_BASE + "/examples/jsm/loaders/OBJLoader.js");
  return new OBJLoader().parse(text);
}

// Adivina el formato por la extension o por los primeros bytes (glTF binario
// empieza por "glTF").
export function guessFormat(name, bytes) {
  const n = String(name || "").toLowerCase();
  if (n.endsWith(".glb") || n.endsWith(".gltf")) return "gltf";
  if (n.endsWith(".obj")) return "obj";
  if (bytes && bytes.length >= 4) {
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic === "glTF") return "gltf";
    if (magic.trim().startsWith("{")) return "gltf";
  }
  return "gltf";
}

// Lee unos datos (ArrayBuffer/TypedArray o texto) y devuelve la raiz del modelo.
export async function parseModel(THREE, data, opts = {}) {
  const bytes = data instanceof Uint8Array ? data : null;
  const fmt = opts.format || guessFormat(opts.name, bytes);
  if (fmt === "obj" || typeof data === "string") {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    return await parseObjText(text);
  }
  let buf = data;
  if (data instanceof Uint8Array) buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const gltf = await parseGltfBuffer(THREE, buf, opts);
  return gltf.scene || gltf.scenes[0];
}

// --- autotest ---------------------------------------------------------------

// Prueba la parte dificil sin red y sin ficheros: coge el esqueleto del visor,
// hace con el una copia "importada" girada + escalada + desplazada y con los
// nombres cambiados (como los deja un exportador), y comprueba que
// `createImportedRig` la vuelve a poner en su sitio y que los huesos siguen al
// esqueleto al animar.
export function runMeshImportSelfTest(THREE) {
  const checks = [];
  const ok = (name, cond, extra) => checks.push({ name, pass: !!cond, extra });

  ok("normaliza nombres", normalizeBoneName("mixamorig:mHead_01") === "mixamorigmhead01");
  ok("casa el nombre bueno", matchJointIndex("mHead") >= 0);
  ok("casa un alias", matchJointIndex("lShldr") === matchJointIndex("mShoulderLeft"));
  ok("casa con prefijo de exportador", matchJointIndex("mixamorig_mHead") === matchJointIndex("mHead"));
  ok("casa en plural", matchJointIndex("mixamorig_Hips") === SL_JOINT_INDEX.get("mPelvis"));
  ok("no casa basura", matchJointIndex("NoSuchBone") < 0);

  // Copia "importada": mismo arbol, transformado y renombrado.
  const binding = buildSkeleton(THREE, { name: "visor" });
  const imported = buildSkeleton(THREE, { name: "importado" });
  const modelRoot = new THREE.Group();
  modelRoot.name = "modelo";
  modelRoot.add(imported.root);
  modelRoot.position.set(0.4, -1.2, 2.5);
  modelRoot.quaternion.setFromEuler(new THREE.Euler(-1.2, 0.4, 0.9));
  modelRoot.scale.setScalar(2.5);
  const rename = { mPelvis: "mixamorig_Hips", mHead: "mixamorig:Head" };
  for (const b of imported.bones) b.name = rename[b.name] || ("mixamorig_" + b.name);
  modelRoot.updateMatrixWorld(true);

  const rig = createImportedRig({ THREE, binding, modelRoot });
  ok("empareja los 133 huesos", rig.stats().matched === 133, rig.stats().matched + " de 133");
  ok("alineacion calculada", !!rig.alignment);
  if (rig.alignment) {
    // El envoltorio tiene que DESHACER el transform del modelo (escala 2.5,
    // giro y traslacion), asi que la escala recuperada es 1/2.5.
    ok("escala recuperada ~1/2.5", Math.abs(rig.alignment.scale - 1 / 2.5) < 0.01, rig.alignment.scale.toFixed(4));
    ok("encaje en reposo (rms < 3 mm)", rig.alignment.rms < 0.003, (rig.alignment.rms * 1000).toFixed(2) + " mm");
  }

  // Un contenedor neutro donde colgar el envoltorio, para comparar posiciones
  // de mundo con las del esqueleto del visor.
  const holder = new THREE.Group();
  holder.add(rig.model);

  function maxJointError() {
    binding.root.updateMatrixWorld(true);
    holder.updateMatrixWorld(true);
    let max = 0;
    for (const boneName of ["mHead", "mShoulderLeft", "mWristLeft", "mHandIndex3Right", "mHipLeft", "mFootLeft", "mPelvis"]) {
      const ji = SL_JOINT_INDEX.get(boneName);
      const item = rig.itemByBone.get(imported.bones[ji]);
      if (!item) continue;
      const a = new THREE.Vector3().setFromMatrixPosition(binding.bones[ji].matrixWorld);
      const b = new THREE.Vector3().setFromMatrixPosition(imported.bones[ji].matrixWorld);
      max = Math.max(max, a.distanceTo(b));
    }
    return max;
  }

  rig.sync();
  const restErr = maxJointError();
  ok("huesos coinciden en reposo (< 5 mm)", restErr < 0.005, (restErr * 1000).toFixed(2) + " mm");

  // Y al animar, deben seguirle.
  binding.bones[SL_JOINT_INDEX.get("mShoulderLeft")].quaternion.setFromEuler(new THREE.Euler(0, 0, -0.9));
  binding.bones[SL_JOINT_INDEX.get("mShoulderRight")].quaternion.setFromEuler(new THREE.Euler(0, 0, 0.9));
  binding.bones[SL_JOINT_INDEX.get("mHipLeft")].quaternion.setFromEuler(new THREE.Euler(0.7, 0, 0));
  binding.bones[SL_JOINT_INDEX.get("mHead")].quaternion.setFromEuler(new THREE.Euler(0, 0.6, 0));
  binding.bones[SL_JOINT_INDEX.get("mElbowLeft")].quaternion.setFromEuler(new THREE.Euler(0, 0, -1.1));
  rig.sync();
  const animErr = maxJointError();
  ok("huesos siguen al animar (< 8 mm)", animErr < 0.008, (animErr * 1000).toFixed(2) + " mm");

  // Y si el esqueleto del visor desplaza la pelvis (el balanceo al andar), la
  // malla tiene que acompanarla: solo con rotaciones se quedaria clavada.
  const pelvis = binding.bones[SL_JOINT_INDEX.get("mPelvis")];
  const pelvisY = pelvis.position.y;
  pelvis.position.y = pelvisY + 0.12;
  rig.sync();
  const bobErr = maxJointError();
  ok("la malla sigue el balanceo de la pelvis (< 10 mm)", bobErr < 0.01, (bobErr * 1000).toFixed(2) + " mm");
  pelvis.position.y = pelvisY;
  rig.sync();

  // Una malla sin huesos no rompe: se queda sin emparejar.
  const plain = new THREE.Group();
  plain.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
  const plainRig = createImportedRig({ THREE, binding, modelRoot: plain });
  ok("una malla sin huesos no empareja nada", plainRig.stats().matched === 0);
  ok("sin huesos no hay alineacion", plainRig.alignment === null);
  ok("sin huesos no retransmite traslaciones", plainRig.stats().positionRetarget === false);
  plainRig.dispose();

  ok("retransmite traslaciones con encaje bueno", rig.stats().positionRetarget === true);

  rig.dispose();
  return { checks, passed: checks.filter((c) => c.pass).length, total: checks.length };
}
