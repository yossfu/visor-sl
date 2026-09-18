// llmesh.js -- decodificador de mallas de Second Life (el activo LLMESH, ".llm").
//
// Todo lo que en SL tiene forma de malla -- el cuerpo o la cabeza mesh del
// avatar, su ropa, los objetos mesh -- es un activo con este formato. Es lo que
// pide el retransmisor (RES.MESH) y lo que hay que saber convertir en geometria
// de three.js para poder dibujarlo. El cuerpo de sistema (avatar_*.llm) usa un
// contenedor distinto: este modulo no lo toca (ver bodyMesh.js).
//
// Formato (port de `LLModel::loadModel`, `LLVolume::unpackVolumeFacesInternal`
// y `LLMeshSkinInfo::fromLLSD` del visor de Linden Lab):
//
//   [cabecera]  mapa LLSD binario EN CRUDO (sin cabecera de texto) con:
//                 material_list     nombres de material (solo .slm)
//                 submodel_id       si es un submodelo de otro
//                 skin{offset,size}           bloque de piel (zlib)
//                 physics_convex{offset,size} bloque de colision (zlib)
//                 lowest_lod / low_lod / medium_lod / high_lod / physics_mesh
//                                   {offset,size} cada nivel (zlib)
//   [bloques]   cada uno: LLSD binario comprimido con zlib (deflate).
//               Los `offset` de la cabecera se miden desde el FINAL de la
//               cabecera, y los bloques van en el orden en que se escriben:
//               skin, physics_convex, y luego los cinco niveles.
//
// Cada nivel de detalle es una LISTA de submeshes (uno por material):
//   Position       U16 x3 por vertice, dentro de PositionDomain (Min/Max)
//   Normal         U16 x3 -> [-1, 1]
//   TexCoord0      U16 x2, dentro de TexCoord0Domain
//   TriangleList   U16 x3 por triangulo (indices de vertice)
//   Weights        lista compacta: [hueso][U16 peso] ... 0xFF separa vertices
//   NoGeometry     cara vacia (se conserva el hueco del material)
//
// Los pesos se guardan como LLVector4a: cuatro `hueso + peso` (el hueso es la
// parte entera). El indice de hueso se refiere a `skin.joint_names` (la misma
// convencion que glTF); si el activo viniera con indices del esqueleto entero,
// se detecta y se traduce.

import { parseBinaryAt } from "./llsd.js";
import { SL_JOINTS, jointIndex, slVecToAvatar, buildSkeleton } from "./skeleton.js";

// Indice rapido por nombre, para el autotest (que necesita la posicion de
// reposo de una articulacion sin construir el arbol de three.js).
const SL_JOINTS_BY_NAME = new Map(SL_JOINTS.map((j) => [j.name, j]));

const LOD_NAMES = ["lowest_lod", "low_lod", "medium_lod", "high_lod", "physics_mesh"];

// Los activos usan la misma convencion de nombres que el resto del visor.
export const MESH_LODS = LOD_NAMES;

// --- ayudas de lectura -------------------------------------------------------

// Los reales de LLSD llegan envueltos (LlsdReal) para no perder el tipo al
// volver a escribirlos; aqui solo hacen falta como numeros.
const num = (v) => (v && typeof v === "object" && typeof v.value === "number" ? v.value : Number(v));
const bytesOf = (v) => (v && v.bytes instanceof Uint8Array ? v.bytes : v instanceof Uint8Array ? v : new Uint8Array(0));

// --- zlib --------------------------------------------------------------------

let fflatePromise = null;

// Infla un bloque zlib (el `unzip_llsd` del visor usa `inflateInit`, o sea zlib
// con cabecera, que es justo el formato "deflate" de la API del navegador).
// Si el navegador no tiene DecompressionStream (algunos navegadores dentro de
// apps), se cae a fflate desde esm.sh.
export async function inflateZlib(bytes) {
  if (typeof DecompressionStream === "function") {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      throw new Error("llmesh: bloque zlib corrupto (" + (e && e.message ? e.message : e) + ")");
    }
  }
  if (!fflatePromise) fflatePromise = import("https://esm.sh/fflate@0.8.2");
  const fflate = await fflatePromise;
  return fflate.inflateSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

// El visor escribe con `deflateInit(..., Z_BEST_COMPRESSION)` (zlib); esta es la
// vuelta, que hace falta para el autotest y para reescribir un activo.
export async function deflateZlib(bytes) {
  if (typeof CompressionStream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (!fflatePromise) fflatePromise = import("https://esm.sh/fflate@0.8.2");
  const fflate = await fflatePromise;
  return fflate.deflateSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

// --- submeshes ---------------------------------------------------------------

// Port de `LLVolume::unpackVolumeFacesInternal`. Devuelve una lista con una
// entrada por cara; las caras `NoGeometry` se marcan como vacias para no perder
// la correspondencia con `material_list`.
export function decodeLodFaces(lod) {
  if (!Array.isArray(lod)) throw new Error("llmesh: se esperaba una lista de submeshes");
  const out = [];
  for (let i = 0; i < lod.length; i++) {
    const raw = lod[i];
    if (!raw || raw.NoGeometry) { out.push({ empty: true, materialIndex: i }); continue; }

    const pos = bytesOf(raw.Position);
    const norm = bytesOf(raw.Normal);
    const tc = bytesOf(raw.TexCoord0);
    const idx = bytesOf(raw.TriangleList);

    // Indices: se descarta un resto que no complete triangulo (igual que el
    // visor, que avisa por consola en ese caso).
    const total = Math.floor(idx.length / 2);
    const numIndices = total - (total % 3);
    const indices = new Uint16Array(numIndices);
    const iv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    for (let j = 0; j < numIndices; j++) indices[j] = iv.getUint16(j * 2, true);

    const nverts = Math.floor(pos.length / 6);
    const domain = raw.PositionDomain || {};
    const mn = (domain.Min || [0, 0, 0]).map(num);
    const mx = (domain.Max || [0, 0, 0]).map(num);
    const range = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];

    const pv = new DataView(pos.buffer, pos.byteOffset, pos.byteLength);
    const positions = new Float32Array(nverts * 3);
    for (let j = 0; j < nverts; j++) {
      for (let a = 0; a < 3; a++) {
        positions[j * 3 + a] = pv.getUint16(j * 6 + a * 2, true) / 65535 * range[a] + mn[a];
      }
    }

    const normals = new Float32Array(nverts * 3);
    if (norm.length) {
      const nv = new DataView(norm.buffer, norm.byteOffset, norm.byteLength);
      for (let j = 0; j < nverts; j++) {
        for (let a = 0; a < 3; a++) normals[j * 3 + a] = nv.getUint16(j * 6 + a * 2, true) / 65535 * 2 - 1;
      }
    }

    const uvs = new Float32Array(nverts * 2);
    if (tc.length) {
      const tv = new DataView(tc.buffer, tc.byteOffset, tc.byteLength);
      const tdomain = raw.TexCoord0Domain || {};
      const tmn = (tdomain.Min || [0, 0]).map(num);
      const tmx = (tdomain.Max || [0, 0]).map(num);
      for (let j = 0; j < nverts; j++) {
        for (let a = 0; a < 2; a++) {
          const o = j * 4 + a * 2;
          const q = o + 2 <= tc.length ? tv.getUint16(o, true) : 0;
          uvs[j * 2 + a] = q / 65535 * (tmx[a] - tmn[a]) + tmn[a];
        }
      }
    }

    const weights = raw.Weights ? decodeWeights(bytesOf(raw.Weights), nverts) : null;
    const scale = raw.NormalizedScale ? raw.NormalizedScale.map(num) : [1, 1, 1];

    out.push({
      empty: false, materialIndex: i,
      positions, normals, uvs, indices, weights, normalizedScale: scale,
      vertexCount: nverts, triangleCount: numIndices / 3,
    });
  }
  return out;
}

// Port del bucle de pesos de `unpackVolumeFacesInternal`. Cada vertice empieza
// con un indice de hueso; detras van pares U16 (peso) separados por el
// siguiente indice, y 0xFF cierra la lista de ese vertice. El peso se acota a
// [0.001, 0.999] para que ningun hueso desaparezca por redondeo.
export function decodeWeights(data, numVerts) {
  const weights = new Float32Array(numVerts * 4);
  const END = 0xff;
  let idx = 0;
  let vert = 0;
  while (idx < data.length && vert < numVerts) {
    let joint = data[idx++];
    let n = 0;
    const j4 = [0, 0, 0, 0];
    const w4 = [0, 0, 0, 0];
    while (joint !== END && idx < data.length) {
      const influence = data[idx++] | (data[idx++] << 8);
      w4[n] = Math.min(0.999, Math.max(0.001, influence / 65535));
      j4[n] = joint;
      n++;
      if (n >= 4) joint = END;
      else joint = data[idx++];
    }
    const sum = w4[0] + w4[1] + w4[2] + w4[3];
    if (sum <= 0) { w4[0] = 0.999; w4[1] = 0; w4[2] = 0; w4[3] = 0; }
    for (let k = 0; k < 4; k++) weights[vert * 4 + k] = j4[k] + w4[k];
    vert++;
  }
  return weights;
}

// --- piel --------------------------------------------------------------------

// Port de `LLMeshSkinInfo::fromLLSD`. Las matrices van por filas (16 numeros).
//
// OJO CON LA CONVENCION: el visor guarda estas matrices en el formato de
// `LLMatrix4a`, cuya FILA 3 es la traslacion (indices 12,13,14), o sea que el
// array plano es la TRASPUESTA de la matriz habitual de vector columna. Aqui se
// lee y se traspone al vuelo para que dentro de este modulo todo sea la
// convencion normal (traslacion en los indices 3, 7 y 11), que es la que usan
// `mat4Mul` y `frameMatrix`. El visor hace lo mismo, solo que al reves: su
// `matMul` sobre matrices traspuestas equivale a multiplicar en el orden
// contrario, y por eso `mBindPoseMatrix = mBindShapeMatrix * mInvBindMatrix`
// significa en cuentas normales `inversaDeEnlace . formaDeEnlace`.
function decodeSkin(skin) {
  const names = (skin.joint_names || []).map(String);
  const inv = skin.inverse_bind_matrix || [];
  const inverseBind = new Float32Array(inv.length * 16);
  for (let i = 0; i < inv.length; i++) {
    const flat = inv[i] || [];
    for (let k = 0; k < 16; k++) inverseBind[i * 16 + k] = num(k < flat.length ? flat[k] : 0);
    transpose16InPlace(inverseBind, i * 16);
  }
  // Si no cuadran los recuentos, el visor tira el enlace entero.
  if (names.length !== inv.length) {
    return { jointNames: [], inverseBind: new Float32Array(0), bindShape: identityMatrix(), pelvisOffset: 0, lockScaleIfJointPosition: false, discarded: true };
  }
  const bindShape = new Float32Array(16);
  const bs = skin.bind_shape_matrix;
  if (bs) { for (let k = 0; k < 16; k++) bindShape[k] = num(bs[k]); transpose16InPlace(bindShape, 0); }
  else { bindShape[0] = bindShape[5] = bindShape[10] = bindShape[15] = 1; }
  return {
    jointNames: names,
    inverseBind,
    bindShape,
    pelvisOffset: skin.pelvis_offset === undefined ? 0 : num(skin.pelvis_offset),
    lockScaleIfJointPosition: !!skin.lock_scale_if_joint_position,
    discarded: false,
  };
}

// Traspone en el sitio un bloque de 16 numeros por filas. Con esto se pasa
// entre la convencion del visor (traslacion en la fila 3) y la normal.
function transpose16InPlace(a, base) {
  for (let r = 0; r < 4; r++) {
    for (let c = r + 1; c < 4; c++) {
      const i = base + r * 4 + c;
      const j = base + c * 4 + r;
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
  }
  return a;
}

// Pasa un bloque de 16 numeros por filas (convencion normal, traslacion en la
// columna 3) a la disposicion por columnas que espera `THREE.Matrix4.fromArray`.
function rowToThreeArray(m) {
  const out = Float32Array.from(m);
  return transpose16InPlace(out, 0);
}

function identityMatrix() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// Port de `LLModel::Decomposition::fromLLSD`: la malla de colision. Los vertices
// vienen cuantizados como los de la malla, con su propio dominio Min/Max.
function decodePhysics(decomp) {
  if (!decomp) return null;
  const mn = decomp.Min ? decomp.Min.map(num) : [-0.5, -0.5, -0.5];
  const mx = decomp.Max ? decomp.Max.map(num) : [0.5, 0.5, 0.5];
  const range = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const readPoints = (data, count) => {
    const out = new Float32Array(count * 3);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < count; i++) {
      for (let a = 0; a < 3; a++) out[i * 3 + a] = (dv.getUint16(i * 6 + a * 2, true) / 65535 * range[a]) + mn[a];
    }
    return out;
  };
  const physics = { min: mn, max: mx, hulls: [], baseHull: null };
  const hullList = decomp.HullList ? bytesOf(decomp.HullList) : null;
  const positions = decomp.Positions ? bytesOf(decomp.Positions) : null;
  if (hullList && positions) {
    let offset = 0;
    for (let i = 0; i < hullList.length; i++) {
      const count = hullList[i] === 0 ? 256 : hullList[i];
      const hull = readPoints(positions.subarray(offset * 6, (offset + count) * 6), count);
      offset += count;
      physics.hulls.push(hull);
    }
  }
  const bv = decomp.BoundingVerts ? bytesOf(decomp.BoundingVerts) : null;
  if (bv) physics.baseHull = readPoints(bv, Math.floor(bv.length / 6));
  return physics;
}

// --- activo completo ---------------------------------------------------------

// Decodifica un activo de malla entero. `lod` elige que nivel se decodifica
// (por defecto el alto, que es el que se dibuja de cerca), pero la piel y la
// colision se leen siempre. Es asincrono porque los bloques van comprimidos.
export async function decodeMeshAsset(bytes, opts = {}) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const seen = parseBinaryAt(buf, 0);
  const header = seen.value;
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new Error("llmesh: la cabecera no es un mapa LLSD");
  }
  const base = seen.next;
  const block = async (name) => {
    const entry = header[name];
    if (!entry || entry.offset === undefined) return null;
    const offset = num(entry.offset);
    const size = num(entry.size);
    if (offset < 0 || size <= 0) return null;
    if (base + offset + size > buf.length) throw new Error("llmesh: el bloque " + name + " se sale del activo");
    return parseBinaryAt(await inflateZlib(buf.subarray(base + offset, base + offset + size)), 0).value;
  };

  const mesh = {
    header,
    materialList: (header.material_list || []).map(String),
    submodelId: header.submodel_id === undefined ? 0 : num(header.submodel_id),
    skin: null,
    physics: null,
    lods: {},
    raw: {},
    byteLength: buf.length,
  };

  const skinLlsd = await block("skin");
  if (skinLlsd) { mesh.skin = decodeSkin(skinLlsd); mesh.raw.skin = skinLlsd; }
  const physicsLlsd = await block("physics_convex");
  if (physicsLlsd) { mesh.physics = decodePhysics(physicsLlsd); mesh.raw.physics = physicsLlsd; }

  const wanted = opts.lod ? [opts.lod] : LOD_NAMES;
  for (const name of wanted) {
    const llsd = await block(name);
    if (!llsd) continue;
    mesh.raw[name] = llsd;
    mesh.lods[name] = decodeLodFaces(llsd);
  }
  // El nivel preferido: alto si existe, si no el mejor que haya.
  mesh.preferredLod = ["high_lod", "medium_lod", "low_lod", "lowest_lod"].find((n) => mesh.lods[n]) || null;
  return mesh;
}

// Indices de hueso ordenados por frecuencia (para LODs y para decidir si un
// hueso merece la pena). Util para diagnosticos y para el visor.
export function meshStats(mesh) {
  const lod = mesh.lods[mesh.preferredLod] || [];
  let verts = 0, tris = 0, faces = 0, skinned = 0;
  const joints = new Map();
  for (const face of lod) {
    if (face.empty) continue;
    faces++;
    verts += face.vertexCount;
    tris += face.triangleCount;
    if (face.weights) {
      skinned++;
      for (let i = 0; i < face.vertexCount; i++) {
        for (let k = 0; k < 4; k++) {
          const w = face.weights[i * 4 + k];
          if (w <= 0) continue;
          const j = Math.floor(w);
          joints.set(j, (joints.get(j) || 0) + 1);
        }
      }
    }
  }
  return {
    lod: mesh.preferredLod, faces, vertices: verts, triangles: tris,
    skinnedFaces: skinned,
    jointNames: mesh.skin ? mesh.skin.jointNames.length : 0,
    usedJoints: [...joints.keys()].sort((a, b) => a - b),
    physicsHulls: mesh.physics ? mesh.physics.hulls.length : 0,
    materialList: mesh.materialList,
    lods: Object.keys(mesh.lods),
  };
}

// --- geometria de three.js ---------------------------------------------------

// Convierte un nivel en UNA `BufferGeometry` con grupos (uno por cara, para que
// cada material pueda tener su textura) y, si hay pesos, los atributos de piel.
// Los vertices se pasan al marco del visor (Y arriba, el avatar mira a -Z).
export function meshToGeometry(THREE, faces, opts = {}) {
  const list = (faces || []).filter((f) => f && !f.empty && f.vertexCount > 0);
  if (!list.length) return null;

  let nv = 0, ni = 0;
  for (const f of list) { nv += f.vertexCount; ni += f.indices.length; }
  const skinned = !!opts.skin && list.some((f) => f.weights);

  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const uvs = new Float32Array(nv * 2);
  const skinIndex = skinned ? new Uint16Array(nv * 4) : null;
  const skinWeight = skinned ? new Float32Array(nv * 4) : null;
  const indices = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  const groups = [];

  let vo = 0, io = 0;
  for (const f of list) {
    for (let j = 0; j < f.vertexCount; j++) {
      const p = slVecToAvatar([f.positions[j * 3], f.positions[j * 3 + 1], f.positions[j * 3 + 2]]);
      positions[(vo + j) * 3] = p[0];
      positions[(vo + j) * 3 + 1] = p[1];
      positions[(vo + j) * 3 + 2] = p[2];
      const n = slVecToAvatar([f.normals[j * 3], f.normals[j * 3 + 1], f.normals[j * 3 + 2]]);
      normals[(vo + j) * 3] = n[0];
      normals[(vo + j) * 3 + 1] = n[1];
      normals[(vo + j) * 3 + 2] = n[2];
      uvs[(vo + j) * 2] = f.uvs[j * 2];
      uvs[(vo + j) * 2 + 1] = f.uvs[j * 2 + 1];
      if (skinned) {
        const w = f.weights;
        for (let k = 0; k < 4; k++) {
          if (!w) { skinIndex[(vo + j) * 4 + k] = 0; skinWeight[(vo + j) * 4 + k] = k === 0 ? 1 : 0; continue; }
          const c = w[j * 4 + k];
          skinIndex[(vo + j) * 4 + k] = Math.floor(c);
          skinWeight[(vo + j) * 4 + k] = c - Math.floor(c);
        }
      }
    }
    for (let k = 0; k < f.indices.length; k++) indices[io + k] = f.indices[k] + vo;
    groups.push({ start: io, count: f.indices.length, materialIndex: f.materialIndex });
    vo += f.vertexCount;
    io += f.indices.length;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  if (skinned) {
    geo.setAttribute("skinIndex", new THREE.BufferAttribute(skinIndex, 4));
    geo.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));
  }
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  for (const g of groups) geo.addGroup(g.start, g.count, g.materialIndex);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.userData.groups = groups;
  return geo;
}

// Rotacion del cambio de marco SL -> visor, como matriz 3x3 por filas.
//   SL +X (delante) -> visor -Z ; SL +Y (izquierda) -> visor -X ; SL +Z -> +Y
const F3 = [[0, -1, 0], [0, 0, 1], [-1, 0, 0]];

// Conjuga una matriz 4x4 de SL al marco del visor: M' = F . M . F^-1. Con eso
// los vertices (que pasan por `slVecToAvatar`) y las matrices de enlace quedan
// en el mismo sistema, y el sombreado de piel de three.js da el mismo resultado
// que el del visor. `m` va por filas, 16 numeros.
export function frameMatrix(m) {
  const out = new Float32Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) s += F3[r][k] * m[k * 4 + l] * F3[c][l];
      out[r * 4 + c] = s;
    }
    let t = 0;
    for (let k = 0; k < 3; k++) t += F3[r][k] * m[k * 4 + 3];
    out[r * 4 + 3] = t;
  }
  out[15] = 1;
  return out;
}

// Multiplica dos matrices por filas: a . b.
export function mat4Mul(a, b) {
  const out = new Float32Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = s;
    }
  }
  return out;
}

// Averigua a que se refieren los indices de hueso de los pesos: lo normal es
// que apunten al array `joint_names` del propio activo (convencion glTF), pero
// se acepta el caso de que apunten al esqueleto entero del avatar.
export function weightIndexMode(mesh) {
  if (!mesh.skin || mesh.skin.discarded) return "none";
  const names = mesh.skin.jointNames.length;
  let max = -1;
  for (const lod of Object.values(mesh.lods)) {
    for (const face of lod) {
      if (face.empty || !face.weights) continue;
      for (let i = 0; i < face.weights.length; i += 4) {
        for (let k = 0; k < 4; k++) {
          const w = face.weights[i + k];
          if (w > 0) max = Math.max(max, Math.floor(w));
        }
      }
    }
  }
  if (max < 0) return "none";
  if (max < names) return "joint_names";
  if (max < 133) return "skeleton";
  return "unknown";
}

// Indice de hueso del peso -> indice de hueso del esqueleto de `skeleton.js`
// (que es el mismo orden que `SL_JOINTS`, y el mismo que el de `buildSkeleton`).
export function resolveWeightJoint(mesh, mode, rawIndex) {
  if (mode === "skeleton") return rawIndex;
  const name = mesh.skin && mesh.skin.jointNames[rawIndex];
  if (name === undefined) return -1;
  return jointIndex(name);
}

// Construye el `SkinnedMesh` (o `Mesh`, si no hay piel) de un nivel de detalle.
//
// `binding` es lo que devuelve `buildSkeleton`: { root, bones, byName }. El
// resultado se cuelga del grupo del avatar; `root` es lo que se mueve.
//
// La matematica de SL es: p' = huesoMundo . invBind . bindShape . p. El visor
// aplica `bind_shape_matrix` a los vertices de la malla y luego la inversa de
// enlace (ver `LLModelPreview::genBuffers`, que hace exactamente
// `mBindShapeMatrix.affineTransform(v)`) . El sombreado de piel de three.js
// calcula p' = bindMatrixInverse . (huesoMundo . boneInverse) . bindMatrix . p,
// asi que con `bindMatrix = I` basta con `boneInverse = invBind . bindShape`.
// Aqui se pasa todo al marco del visor.
export function buildSkinnedMesh(THREE, mesh, binding, opts = {}) {
  const lodName = opts.lod || mesh.preferredLod;
  const faces = mesh.lods[lodName];
  if (!faces) return null;
  const hasSkin = !!(mesh.skin && !mesh.skin.discarded && mesh.skin.jointNames.length);
  const geo = meshToGeometry(THREE, faces, { skin: hasSkin });
  if (!geo) return null;
  // Puede haber `skin` en el activo pero sin pesos en este nivel (los LOD bajos
  // suelen perderlos): ahi no se puede atar a un esqueleto, se dibuja normal.
  const useSkin = hasSkin && !!geo.getAttribute("skinIndex");

  let out;
  let mode = "none";
  if (useSkin) {
    mode = weightIndexMode(mesh);
    const skin = mesh.skin;
    // Las matrices de mundo del esqueleto solo son correctas si estan al dia;
    // `bind` las refresca la primera vez que se dibuja, asi que aqui se fuerzan
    // antes de leerlas.
    binding.root.updateMatrixWorld(true);
    // boneInverses, en el orden de `bones`. Los huesos que la malla no usa se
    // quedan con la inversa de su matriz en reposo (equivale a no deformar).
    const inverses = binding.bones.map((b) => new THREE.Matrix4().copy(b.matrixWorld).invert());
    for (let i = 0; i < skin.jointNames.length; i++) {
      const invBind = skin.inverseBind.subarray(i * 16, i * 16 + 16);
      // bindPose = invBind . bindShape, ya en el marco del visor.
      const bindPose = rowToThreeArray(frameMatrix(mat4Mul(invBind, skin.bindShape)));
      const boneIdx = resolveWeightJoint(mesh, mode, i);
      if (boneIdx < 0 || boneIdx >= inverses.length) continue;
      inverses[boneIdx] = new THREE.Matrix4().fromArray(bindPose);
    }
    // Los atributos de piel guardan el indice de hueso del activo; hay que
    // traducirlo al del esqueleto del visor.
    const skinIndex = geo.getAttribute("skinIndex");
    const skinWeight = geo.getAttribute("skinWeight");
    if (mode === "joint_names") {
      for (let v = 0; v < skinIndex.count; v++) {
        let total = 0;
        for (let k = 0; k < 4; k++) {
          const raw = skinIndex.getComponent(v, k);
          const w = skinWeight.getComponent(v, k);
          const mapped = w > 0 ? resolveWeightJoint(mesh, mode, raw) : -1;
          if (mapped < 0) { skinIndex.setComponent(v, k, 0); skinWeight.setComponent(v, k, 0); }
          else { skinIndex.setComponent(v, k, mapped); total += w; }
        }
        if (total <= 0) { skinIndex.setComponent(v, 0, 0); skinWeight.setComponent(v, 0, 1); }
        else if (Math.abs(total - 1) > 0.001) {
          for (let k = 0; k < 4; k++) skinWeight.setComponent(v, k, skinWeight.getComponent(v, k) / total);
        }
      }
      skinIndex.needsUpdate = true;
      skinWeight.needsUpdate = true;
    }

    const skeleton = new THREE.Skeleton(binding.bones, inverses);
    out = new THREE.SkinnedMesh(geo, opts.material || new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.8, metalness: 0.0, side: opts.side || THREE.FrontSide }));
    out.bind(skeleton, new THREE.Matrix4());
    out.frustumCulled = false;
  } else {
    out = new THREE.Mesh(geo, opts.material || new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.8, metalness: 0.0, side: opts.side || THREE.FrontSide }));
  }
  out.name = opts.name || ("malla:" + lodName);
  out.userData.mesh = mesh;
  out.userData.lod = lodName;
  out.userData.weightIndexMode = mode;
  return out;
}

// --- autotest -----------------------------------------------------------------

// Escribe un activo de malla desde cero (lo contrario de `decodeMeshAsset`).
// Se usa en el autotest y como utilidad: sirve para construir un `.llm` a mano
// o para recomprimir uno decodificado.
export async function encodeMeshAsset(spec) {
  const out = {};
  if (spec.skin) out.skin = spec.skin;
  if (spec.physics) out.physics_convex = spec.physics;
  if (spec.materialList) out.material_list = spec.materialList;
  if (spec.submodelId) out.submodel_id = spec.submodelId;
  for (const name of LOD_NAMES) if (spec.lods && spec.lods[name]) out[name] = spec.lods[name];

  const { toBinary } = await import("./llsd.js");
  const blocks = [];
  const header = {};
  let offset = 0;
  const order = [];
  if (out.skin) order.push(["skin", out.skin]);
  if (out.physics_convex) order.push(["physics_convex", out.physics_convex]);
  for (const name of LOD_NAMES) if (out[name]) order.push([name, out[name]]);
  for (const [name, value] of order) {
    const deflated = await deflateZlib(toBinary(value, { header: false }));
    header[name] = { offset, size: deflated.length };
    offset += deflated.length;
    blocks.push(deflated);
  }
  if (out.material_list) header.material_list = out.material_list;
  if (out.submodel_id) header.submodel_id = out.submodel_id;

  const head = toBinary(header, { header: false });
  let total = head.length;
  for (const b of blocks) total += b.length;
  const file = new Uint8Array(total);
  file.set(head, 0);
  let at = head.length;
  for (const b of blocks) { file.set(b, at); at += b.length; }
  return file;
}

// Codifica un submesh en el formato del activo: los vertices se cuantizan a U16
// dentro del dominio, igual que hace el exportador de SL.
export function encodeSubmesh(positions, indices, opts = {}) {
  const n = positions.length / 3;
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let j = 0; j < n; j++) for (let a = 0; a < 3; a++) {
    const v = positions[j * 3 + a];
    if (v < mn[a]) mn[a] = v;
    if (v > mx[a]) mx[a] = v;
  }
  const range = [mx[0] - mn[0] || 1, mx[1] - mn[1] || 1, mx[2] - mn[2] || 1];
  const pos = new Uint8Array(n * 6);
  const pv = new DataView(pos.buffer);
  const normals = opts.normals || null;
  const norm = normals ? new Uint8Array(n * 6) : null;
  const nv = norm ? new DataView(norm.buffer) : null;
  const uvs = opts.uvs || null;
  const tc = uvs ? new Uint8Array(n * 4) : null;
  const tv = tc ? new DataView(tc.buffer) : null;
  // El dominio tambien se calcula, como el de las posiciones: asi la ida y
  // vuelta es exacta aunque las UV se salgan de [0,1] (baldosas repetidas).
  const tmn = [Infinity, Infinity];
  const tmx = [-Infinity, -Infinity];
  if (uvs) {
    for (let j = 0; j < n; j++) for (let a = 0; a < 2; a++) {
      const v = uvs[j * 2 + a];
      if (v < tmn[a]) tmn[a] = v;
      if (v > tmx[a]) tmx[a] = v;
    }
    for (let a = 0; a < 2; a++) if (tmx[a] <= tmn[a]) tmx[a] = tmn[a] + 1;
  }
  for (let j = 0; j < n; j++) {
    for (let a = 0; a < 3; a++) {
      const q = Math.max(0, Math.min(65535, Math.round((positions[j * 3 + a] - mn[a]) / range[a] * 65535)));
      pv.setUint16(j * 6 + a * 2, q, true);
      if (norm) {
        const qn = Math.max(0, Math.min(65535, Math.round((normals[j * 3 + a] + 1) / 2 * 65535)));
        nv.setUint16(j * 6 + a * 2, qn, true);
      }
    }
    if (tc) for (let a = 0; a < 2; a++) {
      const q = Math.max(0, Math.min(65535, Math.round((uvs[j * 2 + a] - tmn[a]) / (tmx[a] - tmn[a]) * 65535)));
      tv.setUint16(j * 4 + a * 2, q, true);
    }
  }
  const idx = new Uint8Array(indices.length * 2);
  const iv = new DataView(idx.buffer);
  for (let i = 0; i < indices.length; i++) iv.setUint16(i * 2, indices[i], true);

  const face = { Position: pos, TriangleList: idx, PositionDomain: { Min: mn, Max: mx } };
  if (norm) face.Normal = norm;
  if (tc) { face.TexCoord0 = tc; face.TexCoord0Domain = { Min: tmn, Max: tmx }; }
  if (opts.weights) face.Weights = encodeWeightBlob(opts.weights, opts.weightCount);
  return face;
}

// Empaqueta pesos en el formato del activo: por vertice, la lista de huesos
// seguidos de sus pesos (U16), con 0xFF delante del siguiente vertice.
export function encodeWeightBlob(weights, numVerts) {
  const out = [];
  for (let v = 0; v < numVerts; v++) {
    const pairs = [];
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k];
      if (w > 0) pairs.push([Math.floor(w), w - Math.floor(w)]);
    }
    if (!pairs.length) pairs.push([0, 1]);
    if (v > 0) out.push(0xff);
    for (let i = 0; i < pairs.length; i++) {
      if (i > 0) out.push(pairs[i][0]);
      else out.push(pairs[0][0]);
      const q = Math.max(1, Math.min(65535, Math.round(pairs[i][1] * 65535)));
      out.push(q & 0xff, (q >> 8) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// Comprueba el decodificador de punta a punta, sin red: monta un activo con
// cabecera + bloques zlib, lo vuelve a leer y contrasta geometria, indices,
// normales, UV, pesos, piel, colision y -- lo mas importante -- que al atar la
// malla a un esqueleto de verdad y ponerlo en la pose de enlace, las posiciones
// coinciden con las originales. Devuelve el resumen en texto.
export async function runLlmMeshSelfTest(THREE) {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });

  // Un "paralelepipedo" alrededor de mTorso y mPelvis, en coordenadas de SL.
  // Los pivotes se suman en SL (sin pasar por el marco del visor) para que la
  // comprobacion final sea independiente del cambio de marco del modulo.
  const pivotWorldSL = (name) => {
    let x = 0, y = 0, z = 0;
    let cur = name;
    while (cur) {
      const j = SL_JOINTS_BY_NAME.get(cur);
      if (!j) break;
      x += j.pos[0]; y += j.pos[1]; z += j.pos[2];
      cur = j.parent;
    }
    return [x, y, z];
  };
  const torso = pivotWorldSL("mTorso");
  const pelvis = pivotWorldSL("mPelvis");

  const verts = [];
  const addBox = (c, r) => {
    for (const dx of [-r, r]) for (const dy of [-r, r]) for (const dz of [-r, r]) verts.push([c[0] + dx, c[1] + dy, c[2] + dz]);
  };
  addBox(torso, 0.2);
  addBox(pelvis, 0.15);
  const positions = new Float32Array(verts.flat());
  const tris = [];
  for (let b = 0; b < 2; b++) {
    const o = b * 8;
    const q = (a, bb, c, d) => tris.push(o + a, o + bb, o + c, o + a, o + c, o + d);
    q(0, 1, 3, 2); q(4, 6, 7, 5); q(0, 4, 5, 1); q(2, 3, 7, 6); q(0, 2, 6, 4); q(1, 5, 7, 3);
  }
  const indices = new Uint16Array(tris);
  const normals = new Float32Array(positions.length);
  for (let j = 0; j < normals.length; j += 3) {
    const l = Math.hypot(positions[j] - torso[0], positions[j + 1] - torso[1], positions[j + 2] - torso[2]) <
      Math.hypot(positions[j] - pelvis[0], positions[j + 1] - pelvis[1], positions[j + 2] - pelvis[2]) ? 1 : -1;
    normals[j] = l; normals[j + 1] = 0; normals[j + 2] = 0;
  }
  const uvs = new Float32Array(16 * 2);
  for (let j = 0; j < 16; j++) { uvs[j * 2] = (j % 4) / 3; uvs[j * 2 + 1] = Math.floor(j / 4) / 3; }

  // Pesos: la caja del torso a mTorso con un poco de mPelvis; la otra al reves.
  // El formato guardado es "hueso + peso" (parte entera = indice de hueso).
  const weights = new Float32Array(16 * 4);
  for (let j = 0; j < 16; j++) {
    const first = j < 8;
    weights[j * 4] = first ? 0.75 : 0.25;          // mTorso (hueso 0)
    weights[j * 4 + 1] = 1 + (first ? 0.25 : 0.75); // mPelvis (hueso 1)
  }

  const skin = {
    joint_names: ["mTorso", "mPelvis"],
    inverse_bind_matrix: [],
    bind_shape_matrix: (() => { const m = new Array(16).fill(0); m[0] = m[5] = m[10] = m[15] = 1; return m; })(),
    pelvis_offset: 0,
  };
  // invBind = inverso de la matriz de mundo de la articulacion en reposo. Como
  // en reposo solo hay traslaciones, es trasladar por -t. OJO: el archivo guarda
  // la traspuesta (traslacion en la fila 3 -> indices 12,13,14), que es lo que
  // espera `decodeSkin`.
  const invOf = (t) => { const m = new Array(16).fill(0); m[0] = m[5] = m[10] = m[15] = 1; m[12] = -t[0]; m[13] = -t[1]; m[14] = -t[2]; return m; };
  skin.inverse_bind_matrix.push(invOf(torso));
  skin.inverse_bind_matrix.push(invOf(pelvis));

  const face = encodeSubmesh(positions, indices, { normals, uvs, weights, weightCount: 16 });
  const asset = await encodeMeshAsset({ skin, lods: { high_lod: [face], low_lod: [encodeSubmesh(positions, indices)] } });

  // 1) Cabecera y bloques.
  ok("activo: no vacio", asset.length > 0, asset.length + " bytes");
  const mesh = await decodeMeshAsset(asset);
  ok("cabecera: mapa con bloques", !!mesh.header && !!mesh.header.high_lod);
  ok("lod alto decodificado", !!mesh.lods.high_lod && mesh.lods.high_lod.length === 1);
  ok("lod bajo decodificado", !!mesh.lods.low_lod);

  // 2) Geometria.
  const f = mesh.lods.high_lod[0];
  ok("vertices", f.vertexCount === 16, f.vertexCount);
  ok("triangulos", f.triangleCount === 24, f.triangleCount);
  let maxErr = 0;
  for (let j = 0; j < 16; j++) for (let a = 0; a < 3; a++) {
    const err = Math.abs(f.positions[j * 3 + a] - positions[j * 3 + a]);
    if (err > maxErr) maxErr = err;
  }
  ok("posiciones (error de cuantizacion < 0.5 mm)", maxErr < 0.0005, maxErr.toExponential(2));
  let idxOk = true;
  for (let i = 0; i < indices.length; i++) if (f.indices[i] !== indices[i]) idxOk = false;
  ok("indices exactos", idxOk);
  let normOk = true;
  for (let j = 0; j < normals.length; j++) if (Math.abs(f.normals[j] - normals[j]) > 2 / 65535) normOk = false;
  ok("normales (±1/32767)", normOk);
  let uvMax = 0;
  for (let j = 0; j < uvs.length; j++) uvMax = Math.max(uvMax, Math.abs(f.uvs[j] - uvs[j]));
  ok("coordenadas de textura", uvMax < 1 / 65535, uvMax.toExponential(2));

  // 3) Pesos y piel.
  let wOk = true;
  for (let j = 0; j < 16; j++) {
    for (let k = 0; k < 4; k++) {
      const a = weights[j * 4 + k];
      const b = f.weights[j * 4 + k];
      if (!a && !b) continue;
      if (Math.abs(Math.floor(a) - Math.floor(b)) > 0 || Math.abs((a % 1) - (b % 1)) > 0.001) wOk = false;
    }
  }
  ok("pesos (hueso + peso)", wOk);
  ok("piel: 2 articulaciones", mesh.skin && mesh.skin.jointNames.length === 2);
  ok("piel: matrices inversas", mesh.skin.inverseBind.length === 32);
  ok("modo de indices de hueso", weightIndexMode(mesh) === "joint_names", weightIndexMode(mesh));
  ok("traduccion hueso->esqueleto", resolveWeightJoint(mesh, "joint_names", 0) === jointIndex("mTorso") && resolveWeightJoint(mesh, "joint_names", 1) === jointIndex("mPelvis"));
  ok("resumen: cuenta huesos usados", meshStats(mesh).usedJoints.length === 2);

  // 4) Colision.
  const withPhysics = await encodeMeshAsset({
    skin, lods: { high_lod: [face] },
    physics: { Min: [-1, -1, -1], Max: [1, 1, 1], Positions: new Uint8Array(6 * 4).fill(255), HullList: new Uint8Array([4]) },
  });
  const pm = await decodeMeshAsset(withPhysics);
  ok("colision: un casco de 4 puntos", pm.physics && pm.physics.hulls.length === 1 && pm.physics.hulls[0].length === 12);

  // 5) geometria de three.js
  if (THREE) {
    const geo = meshToGeometry(THREE, mesh.lods.high_lod, { skin: true });
    ok("three: atributos", !!geo.getAttribute("position") && !!geo.getAttribute("skinIndex") && !!geo.getAttribute("uv"));
    ok("three: indices", geo.index.count === indices.length);
    ok("three: grupos por material", geo.groups.length === 1 && geo.groups[0].count === indices.length);

    // El nucleo: atar la malla al esqueleto real y comprobar que en la pose de
    // enlace las posiciones deformadas son las de partida (pasadas al marco del
    // visor). Si el orden o el cambio de marco estuvieran mal, esto se rompe.
    const binding = buildSkeleton(THREE);
    const skinned = buildSkinnedMesh(THREE, mesh, binding, { material: null });
    ok("three: SkinnedMesh", !!skinned && skinned.isSkinnedMesh === true);
    binding.root.updateMatrixWorld(true);
    skinned.skeleton.update();
    // OJO: se leen los atributos de la malla ya atada (no de `geo`), porque el
    // indice de hueso se traduce de `joint_names` al del esqueleto dentro de
    // `buildSkinnedMesh`; comprobar sobre `geo` no probaria esa traduccion.
    const geoPos = skinned.geometry.getAttribute("position");
    const skinIdx = skinned.geometry.getAttribute("skinIndex");
    const skinW = skinned.geometry.getAttribute("skinWeight");
    let worst = 0;
    for (let v = 0; v < geoPos.count; v++) {
      const p = new THREE.Vector3(geoPos.getX(v), geoPos.getY(v), geoPos.getZ(v));
      const acc = new THREE.Vector3();
      for (let k = 0; k < 4; k++) {
        const w = skinW.getComponent(v, k);
        if (w <= 0) continue;
        const bi = skinIdx.getComponent(v, k);
        const m = new THREE.Matrix4().fromArray(skinned.skeleton.boneMatrices, bi * 16);
        acc.addScaledVector(p.clone().applyMatrix4(m), w);
      }
      worst = Math.max(worst, acc.distanceTo(p));
    }
    ok("three: la piel reproduce la pose de enlace (< 1 mm)", worst < 0.001, worst.toExponential(2));

    // La traduccion de indice de hueso: el vertice 0 va mayormente a mTorso, que
    // en el esqueleto del visor es la articulacion 3 (no la 0 del activo).
    ok("three: indice de hueso traducido a mTorso",
      skinIdx.getComponent(0, 0) === jointIndex("mTorso"),
      skinIdx.getComponent(0, 0) + " vs " + jointIndex("mTorso"));

    // Y ahora con una articulacion girada: el vertice debe moverse, y el hueso
    // del torso no debe tocar la caja de la pelvis.
    const torsoBone = binding.byName.get("mTorso");
    torsoBone.rotation.z += 0.4;
    binding.root.updateMatrixWorld(true);
    skinned.skeleton.update();
    const m0 = new THREE.Matrix4().fromArray(skinned.skeleton.boneMatrices, skinIdx.getComponent(0, 0) * 16);
    const moved = new THREE.Vector3(geoPos.getX(0), geoPos.getY(0), geoPos.getZ(0)).applyMatrix4(m0);
    const before = new THREE.Vector3(geoPos.getX(0), geoPos.getY(0), geoPos.getZ(0));
    ok("three: al girar mTorso la malla se deforma", moved.distanceTo(before) > 0.01, moved.distanceTo(before).toFixed(4));
    torsoBone.rotation.z -= 0.4;
  } else {
    ok("three: sin THREE se salta la parte de dibujo", true);
  }

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "llmesh selftest: all " + checks.length + " checks passed"
      : "llmesh selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
