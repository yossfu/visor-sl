// bodyMesh.js -- decodificador del cuerpo/cabeza de SISTEMA de Second Life.
//
// El cuerpo "clasico" (el que llevan los avatares sin malla) no es un activo
// LLMESH: viene en un contenedor propio, «Linden Binary Mesh 1.0», en los
// ficheros `avatar_head.llm`, `avatar_upper_body.llm`, `avatar_lower_body.llm`,
// `avatar_hair.llm`, `avatar_skirt.llm`... El visor los lee con
// `LLPolyMeshSharedData::loadMesh` (llpolymesh.cpp). Aqui esta ese mismo
// formato, mas lo necesario para dibujarlo con three.js:
//
//   [24 bytes] cabecera de texto "Linden Binary Mesh 1.0" rellenada con NUL
//   24  U8  hasWeights
//   25  U8  hasDetailTexCoords
//   26  F32 x3 position           (heredado del conversor OBJ: el visor no lo
//                                  usa para el avatar -- ver nota)
//   38  F32 x3 rotationAngles     (grados "Maya", via mayaQ)
//   50  U8  rotationOrder         (el visor lo FUERZA a 0 = XYZ)
//   51  F32 x3 scale
//   63  si NO es un LOD:
//         U16 numVertices
//         F32 x3 x n   coords        +Z arriba, +X delante, en metros, con el
//                                     avatar de pies en el origen (z~0..1.9)
//         F32 x3 x n   normals
//         F32 x3 x n   binormals
//         F32 x2 x n   texCoords
//         F32 x2 x n   detailTexCoords   (solo si hasDetailTexCoords)
//         F32 x1 x n   weights           (solo si hasWeights)
//       U16 numFaces
//       U16 x3 x numFaces  indices
//   63  si ES un LOD: directamente U16 numFaces + indices (el LOD tira del
//       `reference` que le da `avatar_lad.xml` para las coordenadas)
//
//   si NO es un LOD (continuacion):
//       si hasWeights:  U16 numSkinJoints, y por cada uno 64 bytes de nombre
//                       terminado en NUL
//       morphs:         por cada uno, 64 bytes de nombre, S32 numVertices, y
//                       por vertice: U32 indice + F32x3 coords + F32x3 normals
//                       + F32x3 binormals + F32x2 texCoords. La lista acaba con
//                       un nombre de 64 bytes que vale "End Morphs".
//       remaps:         S32 numRemaps y por cada uno S32 src + S32 dst (tabla de
//                       vertices compartidos entre LODs)
//
// PESOS. El cuerpo clasico no usa mallas de enlace: cada vertice lleva UN
// float `w`, y el visor hace `joint = floor(w)`, `frac = w - joint` y mezcla
// `lerp(mat[joint], mat[joint+1], frac)` (LLViewerJointMesh::updateGeometry).
// `joint` NO indexa `numSkinJoints`: indexa la «paleta» que el visor construye
// recorriendo el esqueleto en profundidad y anotando, por cada articulacion que
// la malla usa, su antepasado de esqueleto base y ella misma
// (LLAvatarJointMesh::setupJoint + getBaseSkeletonAncestor). `bodyPalette`
// reproduce ese recorrido; los indices de las mallas reales caen exactos sobre
// el (comprobado contra avatar_upper_body.llm, _lower_body y _head).
//
// MORPHS. Los morphs son DELTAS que se suman al vertice multiplicadas por su
// peso (`LLPolyMorphTarget::apply`): la posicion tal cual, la normal y la
// binormal con el factor 0.65 (`NORMAL_SOFTEN_FACTOR`) y la UV tal cual. Eso es
// lo que mueve la cara y el cuerpo segun los parametros visuales de
// `avatar_lad.xml`; aqui se decodifican y se aplican por nombre y peso.
//
// NOTA sobre `position`: en los ficheros del cuerpo vale (0, 9, 0) y en el ojo
// (0, 0, 0), y las coordenadas de los vertices YA vienen en el marco de reposo
// del avatar (la cabeza ocupa z 1.62..1.87, el cuerpo bajo z -0.006..1.145). El
// visor hace `setPosition(mMesh->getPosition())` sobre la articulacion de la
// malla, pero aplicar (0, 9, 0) mandaria el avatar nueve metros a un lado, asi
// que ese campo no se usa: se expone tal cual en `position` por si acaso.

import { SL_JOINTS, jointIndex, slVecToAvatar, buildSkeleton } from "./skeleton.js";

export const BODY_MESH_HEADER = "Linden Binary Mesh 1.0";

// Cuanto se deja "suavizar" la normal al aplicar un morph (llpolymorph.cpp).
export const NORMAL_SOFTEN_FACTOR = 0.65;

const NAME_LEN = 64;
const MORPH_RECORD = 4 + 12 + 12 + 12 + 8;
const END_MORPHS = "End Morphs";

const DEC = new TextDecoder("latin1");

// --- utilidades de lectura ---------------------------------------------------

export function isBodyMesh(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 24) return false;
  return DEC.decode(u8.subarray(0, BODY_MESH_HEADER.length)) === BODY_MESH_HEADER;
}

// Nombre de 64 bytes terminado en NUL (asi los guarda el visor).
function readName64(u8, pos) {
  const lim = Math.min(pos + NAME_LEN, u8.length);
  let end = pos;
  while (end < lim && u8[end] !== 0) end++;
  let s = "";
  for (let i = pos; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
}

function readF32Array(dv, pos, count) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = dv.getFloat32(pos + i * 4, true);
  return out;
}

function readU16Array(dv, pos, count) {
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = dv.getUint16(pos + i * 2, true);
  return out;
}

// --- decodificacion ----------------------------------------------------------

// Decodifica un `avatar_*.llm`. `opts.isLod` (o `lod`) marca los ficheros de
// nivel de detalle, que no traen vertices ni pesos (tiran del `reference`).
// `opts.detailTexCoords` fuerza el flag (el visor lee el del fichero pero luego
// usa el suyo); por defecto se hace caso al fichero.
export function decodeBodyMesh(bytes, opts = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isBodyMesh(u8)) throw new Error("bodyMesh: no es un contenedor «" + BODY_MESH_HEADER + "»");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const isLod = !!(opts.isLod || opts.lod);
  const hasWeights = u8[24] > 0;
  const hasDetailTexCoords = opts.detailTexCoords === undefined ? u8[25] > 0 : !!opts.detailTexCoords;

  const mesh = {
    isLod,
    hasWeights,
    hasDetailTexCoords,
    position: [dv.getFloat32(26, true), dv.getFloat32(30, true), dv.getFloat32(34, true)],
    rotationAngles: [dv.getFloat32(38, true), dv.getFloat32(42, true), dv.getFloat32(46, true)],
    rotationOrder: u8[50],
    scale: [dv.getFloat32(51, true), dv.getFloat32(55, true), dv.getFloat32(59, true)],
    byteLength: u8.length,
    vertexCount: 0,
    faceCount: 0,
    coords: null, normals: null, binormals: null,
    texCoords: null, detailTexCoords: null, weights: null,
    indices: null,
    jointNames: [],
    morphs: [],
    morphMap: new Map(),
    remaps: [],
    sawEndMorphs: false,
    truncated: false,
  };

  let pos = 63;

  if (!isLod) {
    if (pos + 2 > u8.length) throw new Error("bodyMesh: fichero truncado en numVertices");
    const n = dv.getUint16(pos, true); pos += 2;
    mesh.vertexCount = n;
    mesh.coords = readF32Array(dv, pos, n * 3); pos += n * 12;
    mesh.normals = readF32Array(dv, pos, n * 3); pos += n * 12;
    mesh.binormals = readF32Array(dv, pos, n * 3); pos += n * 12;
    mesh.texCoords = readF32Array(dv, pos, n * 2); pos += n * 8;
    if (hasDetailTexCoords) { mesh.detailTexCoords = readF32Array(dv, pos, n * 2); pos += n * 8; }
    if (hasWeights) { mesh.weights = readF32Array(dv, pos, n); pos += n * 4; }
  }

  const numFaces = dv.getUint16(pos, true); pos += 2;
  mesh.faceCount = numFaces;
  mesh.indices = readU16Array(dv, pos, numFaces * 3); pos += numFaces * 6;

  if (isLod) {
    // Un LOD no tiene vertices propios: el visor los toma del `reference` que
    // declara `avatar_lad.xml`, y saca el recuento del mayor indice.
    let max = -1;
    for (let i = 0; i < mesh.indices.length; i++) if (mesh.indices[i] > max) max = mesh.indices[i];
    mesh.vertexCount = max + 1;
    mesh.lodReference = true;
    return mesh;
  }

  if (hasWeights) {
    if (pos + 2 > u8.length) throw new Error("bodyMesh: fichero truncado en numSkinJoints");
    const nj = dv.getUint16(pos, true); pos += 2;
    for (let i = 0; i < nj; i++) { mesh.jointNames.push(readName64(u8, pos)); pos += NAME_LEN; }
  }

  // Morphs: nombre de 64 bytes + S32 recuento + registros, hasta "End Morphs".
  while (pos + NAME_LEN <= u8.length) {
    const name = readName64(u8, pos); pos += NAME_LEN;
    if (name === END_MORPHS) { mesh.sawEndMorphs = true; break; }
    if (!name) { pos -= NAME_LEN; mesh.truncated = true; break; } // relleno inesperado
    if (pos + 4 > u8.length) { mesh.truncated = true; break; }
    const count = dv.getInt32(pos, true); pos += 4;
    if (count < 0 || pos + count * MORPH_RECORD > u8.length) { mesh.truncated = true; break; }
    const morph = {
      name,
      indices: new Uint32Array(count),
      coords: new Float32Array(count * 3),
      normals: new Float32Array(count * 3),
      binormals: new Float32Array(count * 3),
      texCoords: new Float32Array(count * 2),
    };
    for (let v = 0; v < count; v++) {
      morph.indices[v] = dv.getUint32(pos, true); pos += 4;
      for (let a = 0; a < 3; a++) morph.coords[v * 3 + a] = dv.getFloat32(pos + a * 4, true);
      pos += 12;
      for (let a = 0; a < 3; a++) morph.normals[v * 3 + a] = dv.getFloat32(pos + a * 4, true);
      pos += 12;
      for (let a = 0; a < 3; a++) morph.binormals[v * 3 + a] = dv.getFloat32(pos + a * 4, true);
      pos += 12;
      for (let a = 0; a < 2; a++) morph.texCoords[v * 2 + a] = dv.getFloat32(pos + a * 4, true);
      pos += 8;
    }
    mesh.morphs.push(morph);
    mesh.morphMap.set(name, morph);
  }

  if (mesh.sawEndMorphs && pos + 4 <= u8.length) {
    const nRemaps = dv.getInt32(pos, true); pos += 4;
    if (nRemaps >= 0 && pos + nRemaps * 8 <= u8.length) {
      for (let i = 0; i < nRemaps; i++) {
        const src = dv.getInt32(pos, true); pos += 4;
        const dst = dv.getInt32(pos, true); pos += 4;
        mesh.remaps.push([src, dst]);
      }
    } else {
      mesh.truncated = true;
    }
  }

  mesh.parsedBytes = pos;
  mesh.leftover = u8.length - pos;
  return mesh;
}

// Resumen para diagnosticos.
export function bodyMeshInfo(mesh) {
  return {
    isLod: mesh.isLod,
    vertices: mesh.vertexCount,
    faces: mesh.faceCount,
    triangles: mesh.faceCount,
    hasWeights: mesh.hasWeights,
    joints: mesh.jointNames.length,
    jointNames: mesh.jointNames.slice(),
    morphs: mesh.morphs.map((m) => m.name),
    remaps: mesh.remaps.length,
    leftover: mesh.leftover,
  };
}

// --- paleta de articulaciones ------------------------------------------------

// Port de `LLAvatarJointMesh::setupJoint` + `getBaseSkeletonAncestor`. `joints`
// va en orden de documento (el mismo que `SL_JOINTS`, que es un port literal de
// `avatar_skeleton.xml`); el recorrido en profundidad coincide con ese orden,
// asi que basta con filtrarlo y meter delante el antepasado de esqueleto base
// de cada articulacion usada (si no es ya el anterior), que es el "pivote" con
// el que el visor mezcla.
export function bodyPalette(jointNames, joints = SL_JOINTS) {
  const want = new Set(jointNames);
  const byName = new Map(joints.map((j) => [j.name, j]));
  const baseAncestor = (j) => {
    let a = j.parent ? byName.get(j.parent) : null;
    while (a && a.parent && (a.support || "base") !== "base") {
      const next = byName.get(a.parent);
      if (!next) break;
      a = next;
    }
    return a;
  };
  const out = [];
  for (const j of joints) {
    if (!want.has(j.name)) continue;
    const anc = baseAncestor(j);
    const ancName = anc ? anc.name : null;
    if (!(out.length && out[out.length - 1] === ancName)) out.push(ancName);
    out.push(j.name);
  }
  return out;
}

// Convierte el float de peso de cada vertice (indice + fraccion en la paleta)
// en atributos de piel de four.js: hasta dos influencias por vertice.
// `rootIndex` es el hueso al que se ata la entrada "nula" de la paleta (el
// avatar raiz, que los ficheros reales nunca usan).
export function bodySkinAttributes(mesh, palette, opts = {}) {
  const n = mesh.vertexCount;
  const rootIndex = opts.rootIndex === undefined ? jointIndex("mPelvis") : opts.rootIndex;
  const paletteBone = new Int16Array(palette.length);
  for (let i = 0; i < palette.length; i++) {
    const name = palette[i];
    const idx = name === null || name === undefined ? rootIndex : jointIndex(name);
    paletteBone[i] = idx < 0 ? rootIndex : idx;
  }
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  if (!mesh.weights) {
    for (let v = 0; v < n; v++) skinWeight[v * 4] = 1;
    return { skinIndex, skinWeight, paletteBone };
  }
  for (let v = 0; v < n; v++) {
    const w = mesh.weights[v];
    let j = Math.floor(w);
    let f = w - j;
    if (!isFinite(w) || j < 0) { j = 0; f = 0; }
    if (j >= palette.length) { j = palette.length - 1; f = 0; }
    const a = paletteBone[j];
    if (f <= 1e-4 || j + 1 >= palette.length) {
      skinIndex[v * 4] = a; skinWeight[v * 4] = 1;
      continue;
    }
    const b = paletteBone[j + 1];
    if (a === b) { skinIndex[v * 4] = a; skinWeight[v * 4] = 1; continue; }
    skinIndex[v * 4] = a; skinWeight[v * 4] = 1 - f;
    skinIndex[v * 4 + 1] = b; skinWeight[v * 4 + 1] = f;
  }
  return { skinIndex, skinWeight, paletteBone };
}

// --- geometria ---------------------------------------------------------------

// Copias de trabajo de los vertices, ya en el marco del visor (Y arriba, el
// avatar mira a -Z). Los morphs se aplican sobre estas.
export function bodyBaseArrays(mesh) {
  const n = mesh.vertexCount;
  const positions = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const binormals = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  for (let v = 0; v < n; v++) {
    const p = slVecToAvatar([mesh.coords[v * 3], mesh.coords[v * 3 + 1], mesh.coords[v * 3 + 2]]);
    positions[v * 3] = p[0]; positions[v * 3 + 1] = p[1]; positions[v * 3 + 2] = p[2];
    const nn = slVecToAvatar([mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]]);
    normals[v * 3] = nn[0]; normals[v * 3 + 1] = nn[1]; normals[v * 3 + 2] = nn[2];
    const bb = slVecToAvatar([mesh.binormals[v * 3], mesh.binormals[v * 3 + 1], mesh.binormals[v * 3 + 2]]);
    binormals[v * 3] = bb[0]; binormals[v * 3 + 1] = bb[1]; binormals[v * 3 + 2] = bb[2];
    uvs[v * 2] = mesh.texCoords[v * 2];
    uvs[v * 2 + 1] = mesh.texCoords[v * 2 + 1];
  }
  return { positions, normals, binormals, uvs };
}

// Aplica morphs (nombre -> peso) sobre las copias. Igual que el visor: la
// posicion y la UV se suman tal cual, y la normal/binormal se acumulan en sus
// versiones "escaladas" con el factor 0.65; al final se normalizan (y las
// binormales se recalculan con productos vectoriales, como en
// `LLPolyMorphTarget::apply`). `dst` puede ser `bodyBaseArrays` recien hecho.
export function applyBodyMorphs(mesh, dst, weights) {
  let touched = false;
  for (const name in weights) {
    const w = weights[name];
    if (!w) continue;
    const morph = mesh.morphMap.get(name);
    if (!morph) continue;
    touched = true;
    const m = morph.indices.length;
    for (let i = 0; i < m; i++) {
      const v = morph.indices[i];
      if (v >= mesh.vertexCount) continue;
      for (let a = 0; a < 3; a++) {
        dst.positions[v * 3 + a] += morph.coords[i * 3 + a] * w;
        dst.normals[v * 3 + a] += morph.normals[i * 3 + a] * w * NORMAL_SOFTEN_FACTOR;
        dst.binormals[v * 3 + a] += morph.binormals[i * 3 + a] * w * NORMAL_SOFTEN_FACTOR;
      }
      dst.uvs[v * 2] += morph.texCoords[i * 2] * w;
      dst.uvs[v * 2 + 1] += morph.texCoords[i * 2 + 1] * w;
    }
  }
  if (!touched) return dst;
  // Normalizar las normales acumuladas (y rehacer las binormales).
  for (let v = 0; v < mesh.vertexCount; v++) {
    let x = dst.normals[v * 3], y = dst.normals[v * 3 + 1], z = dst.normals[v * 3 + 2];
    const len = Math.hypot(x, y, z);
    if (len > 1e-6) { dst.normals[v * 3] = x / len; dst.normals[v * 3 + 1] = y / len; dst.normals[v * 3 + 2] = z / len; }
    x = dst.binormals[v * 3]; y = dst.binormals[v * 3 + 1]; z = dst.binormals[v * 3 + 2];
    const blen = Math.hypot(x, y, z);
    if (blen > 1e-6) { dst.binormals[v * 3] = x / blen; dst.binormals[v * 3 + 1] = y / blen; dst.binormals[v * 3 + 2] = z / blen; }
  }
  return dst;
}

// `BufferGeometry` del cuerpo, con indices y (si la malla trae pesos) los
// atributos de piel ya traducidos al esqueleto de `skeleton.js`.
export function buildBodyGeometry(THREE, mesh, opts = {}) {
  const arrays = opts.arrays || bodyBaseArrays(mesh);
  const n = mesh.vertexCount;
  const geo = new THREE.BufferGeometry();
  // Los atributos se quedan con SU PROPIA copia: `arrays` sigue siendo la base
  // intacta sobre la que `applyBodyMorphs` recalcula los vertices cada vez.
  geo.setAttribute("position", new THREE.BufferAttribute(arrays.positions.slice(), 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(arrays.normals.slice(), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(arrays.uvs.slice(), 2));
  const indices = n > 65535 ? new Uint32Array(mesh.indices) : new Uint16Array(mesh.indices);
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  if (opts.skin && mesh.weights) {
    const palette = opts.palette || bodyPalette(mesh.jointNames);
    const { skinIndex, skinWeight, paletteBone } = bodySkinAttributes(mesh, palette, opts);
    geo.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndex, 4));
    geo.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));
    geo.userData.palette = palette;
    geo.userData.paletteBone = paletteBone;
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// Arma el `SkinnedMesh` del cuerpo contra el esqueleto de `buildSkeleton`.
//
// La matematica del visor para el cuerpo clasico (matriz de la articulacion
// desplazada por -posicionDeReposo, o sea `M_mundo . T(-p_reposo)`) es
// exactamente la del sombreado de piel estandar con matrices inversas de
// enlace iguales a la inversa de la matriz de reposo. Como en reposo el
// esqueleto no tiene rotacion, basta con invertir `bone.matrixWorld` en
// reposo, igual que hace `llmesh.js` para los huesos sin enlace propio.
export function buildBodyMesh(THREE, mesh, binding, opts = {}) {
  const geo = buildBodyGeometry(THREE, mesh, { skin: true, palette: opts.palette, arrays: opts.arrays });
  binding.root.updateMatrixWorld(true);
  const inverses = binding.bones.map((b) => new THREE.Matrix4().copy(b.matrixWorld).invert());
  const skeleton = new THREE.Skeleton(binding.bones, inverses);
  const material = opts.material || new THREE.MeshStandardMaterial({
    color: 0xbba894, roughness: 0.85, metalness: 0.0, side: opts.side || THREE.FrontSide,
  });
  const out = new THREE.SkinnedMesh(geo, material);
  out.bind(skeleton, new THREE.Matrix4());
  out.frustumCulled = false;
  out.name = opts.name || "cuerpo-sistema";
  out.userData.bodyMesh = mesh;
  out.userData.palette = geo.userData.palette || null;
  return out;
}

// --- escritor (para el autotest) ---------------------------------------------

// Escribe un contenedor «Linden Binary Mesh 1.0». Lo contrario de
// `decodeBodyMesh`; se usa en el autotest y sirve para recomprimir o construir
// un fichero a mano.
export function encodeBodyMesh(spec) {
  const isLod = !!spec.isLod;
  const hasWeights = !!spec.hasWeights;
  const hasDetail = !!spec.hasDetailTexCoords;
  const n = isLod ? 0 : (spec.coords ? spec.coords.length / 3 : 0);
  const faces = spec.indices ? spec.indices.length / 3 : 0;
  const morphs = spec.morphs || [];
  const joints = spec.jointNames || [];
  const remaps = spec.remaps || [];

  let size = 63;
  if (!isLod) {
    size += 2 + n * 12 * 3 + n * 8 + (hasDetail ? n * 8 : 0) + (hasWeights ? n * 4 : 0);
  }
  size += 2 + faces * 6;
  if (!isLod) {
    if (hasWeights) size += 2 + joints.length * NAME_LEN;
    for (const m of morphs) size += NAME_LEN + 4 + m.indices.length * MORPH_RECORD;
    size += NAME_LEN;
    size += 4 + remaps.length * 8;
  }

  const u8 = new Uint8Array(size);
  const dv = new DataView(u8.buffer);
  for (let i = 0; i < BODY_MESH_HEADER.length; i++) u8[i] = BODY_MESH_HEADER.charCodeAt(i);
  u8[24] = hasWeights ? 1 : 0;
  u8[25] = hasDetail ? 1 : 0;
  const pos3 = (at, v) => { dv.setFloat32(at, v[0], true); dv.setFloat32(at + 4, v[1], true); dv.setFloat32(at + 8, v[2], true); };
  pos3(26, spec.position || [0, 0, 0]);
  pos3(38, spec.rotationAngles || [0, 0, 0]);
  u8[50] = spec.rotationOrder || 0;
  pos3(51, spec.scale || [1, 1, 1]);
  let p = 63;
  const putF32 = (arr, count) => { for (let i = 0; i < count; i++) dv.setFloat32(p + i * 4, arr[i], true); p += count * 4; };
  if (!isLod) {
    dv.setUint16(p, n, true); p += 2;
    putF32(spec.coords, n * 3);
    putF32(spec.normals || new Float32Array(n * 3), n * 3);
    putF32(spec.binormals || new Float32Array(n * 3), n * 3);
    putF32(spec.texCoords || new Float32Array(n * 2), n * 2);
    if (hasDetail) putF32(spec.detailTexCoords || new Float32Array(n * 2), n * 2);
    if (hasWeights) putF32(spec.weights || new Float32Array(n), n);
  }
  dv.setUint16(p, faces, true); p += 2;
  for (let i = 0; i < faces * 3; i++) { dv.setUint16(p, spec.indices[i], true); p += 2; }
  const putName = (s) => { for (let i = 0; i < NAME_LEN; i++) u8[p + i] = i < s.length ? s.charCodeAt(i) : 0; p += NAME_LEN; };
  if (!isLod) {
    if (hasWeights) {
      dv.setUint16(p, joints.length, true); p += 2;
      for (const jn of joints) putName(jn);
    }
    for (const m of morphs) {
      putName(m.name);
      dv.setInt32(p, m.indices.length, true); p += 4;
      for (let v = 0; v < m.indices.length; v++) {
        dv.setUint32(p, m.indices[v], true); p += 4;
        for (let a = 0; a < 3; a++) { dv.setFloat32(p, m.coords[v * 3 + a], true); p += 4; }
        for (let a = 0; a < 3; a++) { dv.setFloat32(p, m.normals[v * 3 + a], true); p += 4; }
        for (let a = 0; a < 3; a++) { dv.setFloat32(p, m.binormals[v * 3 + a], true); p += 4; }
        for (let a = 0; a < 2; a++) { dv.setFloat32(p, m.texCoords[v * 2 + a], true); p += 4; }
      }
    }
    putName(END_MORPHS);
    dv.setInt32(p, remaps.length, true); p += 4;
    for (const r of remaps) { dv.setInt32(p, r[0], true); p += 4; dv.setInt32(p, r[1], true); p += 4; }
  }
  return u8.subarray(0, p);
}

// --- autotest -----------------------------------------------------------------

// Comprueba el decodificador entero sin red: escribe contenedores, los vuelve
// a leer, contrasta vertices, indices, morfos, remaps y -- lo mas importante --
// que la paleta que reconstruimos coincide con la que el visor deduce del
// esqueleto (se contrasta con los nombres de articulacion reales de las mallas
// del cuerpo), y que al atar el cuerpo al esqueleto de verdad en reposo las
// posiciones deformadas son las de partida.
export function runBodyMeshSelfTest(THREE) {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });

  // 1) Cabecera.
  ok("cabecera: reconoce el contenedor", isBodyMesh(encodeBodyMesh({ coords: new Float32Array(3), indices: new Uint16Array(3) })));
  ok("cabecera: rechaza otra cosa", !isBodyMesh(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24])));

  // 2) Ida y vuelta de la geometria.
  const n = 8;
  const coords = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const texCoords = new Float32Array(n * 2);
  const weights = new Float32Array(n);
  const upperJoints = ["mChest", "mCollarLeft", "mCollarRight", "mElbowLeft", "mElbowRight", "mNeck", "mPelvis", "mShoulderLeft", "mShoulderRight", "mTorso", "mWristLeft", "mWristRight"];
  for (let v = 0; v < n; v++) {
    coords[v * 3] = v * 0.1; coords[v * 3 + 1] = -v * 0.05; coords[v * 3 + 2] = 1.2 + v * 0.01;
    normals[v * 3] = 0; normals[v * 3 + 1] = 1; normals[v * 3 + 2] = 0;
    texCoords[v * 2] = v / n; texCoords[v * 2 + 1] = 1 - v / n;
    weights[v] = v; // indices 0..7 de la paleta (sin fraccion)
  }
  const indices = new Uint16Array([0, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 0]);
  const morph = {
    name: "Test_Morph",
    indices: new Uint32Array([0, 3]),
    coords: new Float32Array([0.1, 0, 0, 0, 0.2, 0]),
    normals: new Float32Array([1, 0, 0, 0, 0, 1]),
    binormals: new Float32Array(6),
    texCoords: new Float32Array([0.5, 0, 0, 0.25]),
  };
  const file = encodeBodyMesh({
    hasWeights: true, coords, normals, texCoords, weights, indices,
    jointNames: upperJoints, morphs: [morph], remaps: [[2, 1], [5, 3]],
  });
  const mesh = decodeBodyMesh(file);
  ok("cabecera leida", mesh.hasWeights === true && mesh.hasDetailTexCoords === false);
  ok("34 vertices", mesh.vertexCount === n, mesh.vertexCount);
  ok("4 caras", mesh.faceCount === 4, mesh.faceCount);
  let posOk = true;
  for (let i = 0; i < n * 3; i++) if (mesh.coords[i] !== coords[i]) posOk = false;
  ok("coordenadas exactas", posOk);
  let idxOk = true;
  for (let i = 0; i < indices.length; i++) if (mesh.indices[i] !== indices[i]) idxOk = false;
  ok("indices exactos", idxOk);
  ok("12 articulaciones con nombre", mesh.jointNames.length === 12 && mesh.jointNames[0] === "mChest", mesh.jointNames.join(","));
  ok("terminador de morfos", mesh.sawEndMorphs === true);
  ok("1 morfo, nombre y recuento", mesh.morphs.length === 1 && mesh.morphs[0].name === "Test_Morph" && mesh.morphs[0].indices.length === 2);
  ok("morfo: coordenadas de la delta", Math.abs(mesh.morphs[0].coords[0] - 0.1) < 1e-6 && Math.abs(mesh.morphs[0].coords[4] - 0.2) < 1e-6);
  ok("morfo: uv de la delta", mesh.morphs[0].texCoords[0] === 0.5 && mesh.morphs[0].texCoords[3] === 0.25);
  ok("remaps", mesh.remaps.length === 2 && mesh.remaps[1][0] === 5 && mesh.remaps[1][1] === 3);
  ok("sin bytes sobrantes", mesh.leftover === 0, mesh.leftover);

  // 3) Aplicacion de morphs: delta exacta y factor 0.65 en la normal.
  const arrays = bodyBaseArrays(mesh);
  const before = arrays.positions[0];
  applyBodyMorphs(mesh, arrays, { Test_Morph: 0.5 });
  ok("morfo: posicion = delta * peso", Math.abs(arrays.positions[0] - before - 0.05) < 1e-6, arrays.positions[0] - before);
  ok("morfo: la normal se renormaliza", Math.abs(Math.hypot(arrays.normals[0], arrays.normals[1], arrays.normals[2]) - 1) < 1e-5);
  const untouched = bodyBaseArrays(mesh);
  applyBodyMorphs(mesh, untouched, { No_Existe: 1 });
  ok("morfo: un nombre desconocido no toca nada", untouched.positions[0] === bodyBaseArrays(mesh).positions[0]);

  // 4) Paletas: la reconstruccion tiene que dar EXACTAMENTE la que el visor
  //    deduce del esqueleto. Los valores esperados se comprobaron contra los
  //    indices reales de avatar_upper_body.llm / _lower_body.llm / _head.llm,
  //    que caen todos dentro de su paleta. La entrada "nula" (el avatar raiz)
  //    sale como cadena vacia al unir.
  const palUpper = bodyPalette(upperJoints);
  ok("paleta del torso: 15 entradas", palUpper.length === 15, palUpper.length);
  ok("paleta del torso: orden",
    palUpper.join("|") === "|mPelvis|mTorso|mChest|mNeck|mChest|mCollarLeft|mShoulderLeft|mElbowLeft|mWristLeft|mChest|mCollarRight|mShoulderRight|mElbowRight|mWristRight",
    palUpper.join("|"));
  const palLower = bodyPalette(["mAnkleLeft", "mAnkleRight", "mHipLeft", "mHipRight", "mKneeLeft", "mKneeRight", "mPelvis"]);
  ok("paleta de las piernas: orden",
    palLower.join("|") === "|mPelvis|mHipRight|mKneeRight|mAnkleRight|mPelvis|mHipLeft|mKneeLeft|mAnkleLeft",
    palLower.join("|"));
  const palHead = bodyPalette(["mHead", "mNeck"]);
  ok("paleta de la cabeza: orden", palHead.join("|") === "mChest|mNeck|mHead", palHead.join("|"));
  ok("paleta: toda entrada resuelve a un hueso",
    palUpper.every((nm) => nm === null || jointIndex(nm) >= 0));
  ok("paleta: el pivote mChest no es articulacion de la malla pero si del esqueleto", jointIndex("mChest") >= 0);

  // 5) Pesos -> atributos de piel.
  const skin = bodySkinAttributes(mesh, palUpper);
  ok("piel: el vertice 0 va a la paleta 0 (mPelvis)", skin.skinIndex[0] === jointIndex("mPelvis"), skin.skinIndex[0] + " vs " + jointIndex("mPelvis"));
  ok("piel: el vertice 4 va a la paleta 4 (mNeck)", skin.skinIndex[16] === jointIndex("mNeck"), skin.skinIndex[16]);
  const frac = decodeBodyMesh(encodeBodyMesh({
    hasWeights: true, coords, normals, texCoords,
    weights: Float32Array.from([0, 0, 0, 0, 3.25, 0, 0, 0]), indices, jointNames: upperJoints,
  }));
  const skin2 = bodySkinAttributes(frac, palUpper);
  // La paleta 3 es mChest y la 4 mNeck: una fraccion de 0.25 reparte 0.75/0.25.
  ok("piel: una fraccion reparte entre dos huesos",
    skin2.skinIndex[16] === jointIndex("mChest") && Math.abs(skin2.skinWeight[16] - 0.75) < 1e-6 &&
    skin2.skinIndex[17] === jointIndex("mNeck") && Math.abs(skin2.skinWeight[17] - 0.25) < 1e-6,
    skin2.skinIndex[16] + "/" + skin2.skinWeight[16] + " + " + skin2.skinIndex[17] + "/" + skin2.skinWeight[17]);

  // 6) Un LOD: sin vertices propios, recuento sacado del mayor indice.
  const lod = decodeBodyMesh(encodeBodyMesh({ isLod: true, indices: new Uint16Array([0, 1, 2, 2, 3, 5]) }), { isLod: true });
  ok("lod: 6 vertices por el mayor indice", lod.vertexCount === 6, lod.vertexCount);
  ok("lod: sin coordenadas ni morfos", lod.coords === null && lod.morphs.length === 0);

  // 7) three.js: geometria, atributos y piel en reposo.
  if (THREE) {
    const geo = buildBodyGeometry(THREE, mesh, { skin: true, palette: palUpper });
    const pa = geo.getAttribute("position");
    ok("three: atributos", !!pa && !!geo.getAttribute("normal") && !!geo.getAttribute("uv") && !!geo.getAttribute("skinIndex"));
    ok("three: indices", geo.index.count === indices.length, geo.index.count);
    // Vértice 0 = (0, 0, 1.2) en SL -> (0, 1.2, 0) en el visor.
    // Vértice 1 = (0.1, -0.05, 1.21) -> (0.05, 1.21, -0.1).
    ok("three: la posicion pasa al marco del visor",
      Math.abs(pa.getX(0)) < 1e-6 && Math.abs(pa.getY(0) - 1.2) < 1e-5 && Math.abs(pa.getZ(0)) < 1e-6 &&
      Math.abs(pa.getX(1) - 0.05) < 1e-6 && Math.abs(pa.getZ(1) + 0.1) < 1e-6,
      [pa.getX(0), pa.getY(0), pa.getZ(0), pa.getX(1), pa.getZ(1)].join(","));

    const binding = buildSkeleton(THREE);
    const skinned = buildBodyMesh(THREE, mesh, binding, { palette: palUpper });
    ok("three: SkinnedMesh", !!skinned && skinned.isSkinnedMesh === true);
    binding.root.updateMatrixWorld(true);
    skinned.skeleton.update();
    const gp = skinned.geometry.getAttribute("position");
    const si = skinned.geometry.getAttribute("skinIndex");
    const sw = skinned.geometry.getAttribute("skinWeight");
    const deform = (v) => {
      const p = new THREE.Vector3(gp.getX(v), gp.getY(v), gp.getZ(v));
      const acc = new THREE.Vector3();
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k);
        if (w <= 0) continue;
        const m = new THREE.Matrix4().fromArray(skinned.skeleton.boneMatrices, si.getComponent(v, k) * 16);
        acc.addScaledVector(p.clone().applyMatrix4(m), w);
      }
      return { p, acc };
    };
    let worst = 0;
    for (let v = 0; v < gp.count; v++) worst = Math.max(worst, deform(v).acc.distanceTo(deform(v).p));
    ok("three: en reposo la piel no mueve nada (< 1 mm)", worst < 0.001, worst.toExponential(2));

    // Y con una articulacion girada, el vertice que le toca tiene que moverse.
    // El vertice 7 esta atado a la paleta 7 = mShoulderLeft.
    const shoulder = binding.byName.get("mShoulderLeft");
    const before7 = deform(7).acc.clone();
    shoulder.rotation.z += 0.5;
    binding.root.updateMatrixWorld(true);
    skinned.skeleton.update();
    ok("three: al girar mShoulderLeft el vertice 7 se mueve", deform(7).acc.distanceTo(before7) > 1e-3, deform(7).acc.distanceTo(before7).toExponential(2));
    shoulder.rotation.z -= 0.5;
  } else {
    ok("three: sin THREE se salta la parte de dibujo", true);
  }

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "bodyMesh selftest: all " + checks.length + " checks passed"
      : "bodyMesh selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
