// primMesh.js -- puente entre el teselador (src/llvolume.js) y three.js.
//
// `generateVolume` devuelve arrays planos (posiciones/UV/normales) mas una lista
// de caras con los mismos rangos que usa SL (`faceID`, tapa/lateral/interior).
// Aqui eso se convierte en una BufferGeometry con un *grupo* por cara, de forma
// que cada cara pueda llevar su propio material/textura (igual que el editor de
// caras de SL), y en una cache por `VolumeParams.key(lod)` para no re-teselar
// prims identicos.
//
// three.js se pasa como parametro (no se importa) para que este modulo se pueda
// probar sin navegador y para no atar el proyecto a una version concreta.

import { generateVolume, FACE_PATH_BEGIN, FACE_PATH_END, FACE_INNER_SIDE, FACE_PROFILE_BEGIN, FACE_PROFILE_END } from "./llvolume.js";

// Etiqueta legible (para el panel de caras) a partir de los flags de SL.
export function describeFace(face) {
  const id = face.faceID;
  if (id === FACE_PATH_BEGIN) return "Tapa inferior";
  if (id === FACE_PATH_END) return "Tapa superior";
  if (id & FACE_INNER_SIDE) return "Interior del hueco";
  if (id & (FACE_PROFILE_BEGIN | FACE_PROFILE_END)) return "Canto del corte";
  return "Lado";
}

// Ejes locales de SL: X adelante (rojo), Y izquierda (verde), Z arriba (azul).
const AXES = [
  [1, 0, 0, "Cara +X (adelante)"], [-1, 0, 0, "Cara -X (atrás)"],
  [0, 1, 0, "Cara +Y (izquierda)"], [0, -1, 0, "Cara -Y (derecha)"],
  [0, 0, 1, "Tapa +Z (arriba)"], [0, 0, -1, "Tapa -Z (abajo)"],
];

function axisName(nx, ny, nz) {
  let best = AXES[4], bestDot = -2;
  for (const a of AXES) {
    const d = nx * a[0] + ny * a[1] + nz * a[2];
    if (d > bestDot) { bestDot = d; best = a; }
  }
  return best[3];
}

// Nombre por cara segun su normal media: es lo que ve el usuario en el editor
// de caras (permite decir "pon esta textura en la cara +X" sin ambiguedad).
export function faceLabels(vol) {
  const p = vol.positions;
  return vol.faces.map((f) => {
    let nx = 0, ny = 0, nz = 0;
    for (let t = f.start; t < f.start + f.count; t++) {
      const o = t * 9;
      const ux = p[o + 3] - p[o], uy = p[o + 4] - p[o + 1], uz = p[o + 5] - p[o + 2];
      const vx = p[o + 6] - p[o], vy = p[o + 7] - p[o + 1], vz = p[o + 8] - p[o + 2];
      nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    const inner = !!(f.faceID & FACE_INNER_SIDE);
    const label = axisName(nx / len, ny / len, nz / len);
    return inner ? label + " (interior)" : label;
  });
}

export function faceInfo(vol) {
  const labels = faceLabels(vol);
  return vol.faces.map((f, i) => ({
    index: i, faceID: f.faceID, cap: f.cap, flat: f.flat,
    triangles: f.count, label: labels[i],
  }));
}

// --- conversion de marco --------------------------------------------------
// `llvolume.js` genera en el marco local de SL (X adelante, Y izquierda,
// Z arriba), que es el que comparan los numeros con `llvolume.cpp`. El mundo
// del visor (terreno, avatar, gravedad) es el de three.js (Y arriba), asi que
// aqui se convierte con la rotacion estandar de Z-arriba a Y-arriba:
//   (x, y, z)_SL -> (x, z, -y)
// Es una rotacion propia (determinante +1): no cambia el winding, ni el
// volumen firmado, ni las UV. Solo el marco. De este modo un cilindro con
// tamano [1, 4, 1] es un cilindro de 4 m de alto y no una lente tumbada, y el
// eje "arriba" de un prim coincide con el del mundo.
export function slToWorld(v, out) {
  const o = out || [0, 0, 0];
  o[0] = v[0]; o[1] = v[2]; o[2] = -v[1];
  return o;
}

// La malla de SL tiene los grupos en el mismo orden que `faces`, asi que el
// indice de grupo ES el indice de cara (el "slot" de textura).
export function volumeToGeometry(vol, THREE) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(vol.positions.slice(), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(vol.uvs, 2));
  g.setAttribute("normal", new THREE.BufferAttribute(vol.normals.slice(), 3));
  for (const f of vol.faces) g.addGroup(f.start * 3, f.count * 3, f.id);
  g.rotateX(-Math.PI / 2);      // marco de SL -> marco del mundo
  g.computeBoundingSphere();
  g.computeBoundingBox();
  g.userData.faces = vol.faces;
  g.userData.numTriangles = vol.numTriangles;
  return g;
}

// Caja envolvente de la malla (ya en el marco del mundo) sin escalar. El
// volumen base cabe en [-0.5, 0.5]^3 salvo por skew/shear; las formas que no
// estan centradas (toro, anillo, tubo) tienen su caja propia. Es la caja que
// usan las colisiones, el encuadre de camara y la rejilla del editor, asi que
// tiene que ser la de la malla tal como se dibuja.
export function geometryBBox(vol) {
  const p = vol.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  // la misma rotacion (x,y,z)->(x,z,-y) aplicada a la caja
  return { min: [min[0], min[2], -max[1]], max: [max[0], max[2], -min[1]] };
}

// Geometria de UNA cara del prim (para el resaltado del editor de caras):
// los mismos vertices que la malla grande, ya en el marco del mundo. Se usa
// como malla hija del prim, asi que solo hace falta la posicion: el material
// del resaltado es plano (sin luces ni normales).
export function faceToGeometry(vol, faceIndex, THREE) {
  const f = vol.faces[faceIndex];
  if (!f || !f.count) return null;
  const a = f.start * 9, b = (f.start + f.count) * 9;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(vol.positions.slice(a, b), 3));
  g.rotateX(-Math.PI / 2);
  g.computeBoundingSphere();
  return g;
}

export function volumeStats(vol) {
  const b = geometryBBox(vol);
  return {
    triangles: vol.numTriangles,
    vertices: vol.numVertices,
    faces: vol.faces.length,
    min: b.min,
    max: b.max,
  };
}

// ---------------------------------------------------------------------------
// Cache de geometrias. `factory.get(volumeParams, lod)` devuelve la MISMA
// BufferGeometry para parametros iguales, de modo que N copias de un cubo
// comparten un solo buffer en la GPU (three.js deduplica por geometria). La
// geometria se libera cuando su ultima referencia desaparece.
// ---------------------------------------------------------------------------
export class PrimMeshFactory {
  constructor(THREE, { maxEntries = 512 } = {}) {
    this.THREE = THREE;
    this.maxEntries = maxEntries;
    this.cache = new Map(); // key -> { geometry, refs, lastUse, volume }
    this.tick = 0;
  }

  get(volParams, lod = 3) {
    const key = volParams.key(lod);
    let entry = this.cache.get(key);
    if (!entry) {
      const vol = generateVolume(volParams, lod);
      entry = { key, geometry: volumeToGeometry(vol, this.THREE), refs: 0, lastUse: 0, volume: vol };
      this.cache.set(key, entry);
      this._evictIfNeeded();
    }
    entry.refs++;
    entry.lastUse = ++this.tick;
    return entry.geometry;
  }

  // Volumen ya teselado (para consultar caras, bbox, etc.) sin tocar refs.
  getVolume(volParams, lod = 3) {
    const key = volParams.key(lod);
    let entry = this.cache.get(key);
    if (!entry) {
      const vol = generateVolume(volParams, lod);
      entry = { key, geometry: volumeToGeometry(vol, this.THREE), refs: 0, lastUse: ++this.tick, volume: vol };
      this.cache.set(key, entry);
      this._evictIfNeeded();
    }
    return entry.volume;
  }

  release(volParams, lod = 3) {
    const entry = this.cache.get(volParams.key(lod));
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      entry.geometry.dispose();
      this.cache.delete(entry.key);
    }
  }

  _evictIfNeeded() {
    while (this.cache.size > this.maxEntries) {
      let oldest = null;
      for (const e of this.cache.values()) {
        if (e.refs > 0) continue; // en uso: no se puede liberar
        if (!oldest || e.lastUse < oldest.lastUse) oldest = e;
      }
      if (!oldest) return; // todo en uso; se podara en la proxima release()
      oldest.geometry.dispose();
      this.cache.delete(oldest.key);
    }
  }

  dispose() {
    for (const e of this.cache.values()) e.geometry.dispose();
    this.cache.clear();
  }
}
