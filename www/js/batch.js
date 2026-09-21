// Static batching: one merged mesh per cell and material.
//
// This is what makes a whole Second Life region affordable. Every prim is drawn
// as up to six faces, so a region with 1200 prims is ~3500 draw calls and a
// phone GPU drops to ~10-20 fps no matter how simple the shaders are. Prims that
// share a material are merged into one buffer per 32 m cell, which turns those
// thousands of calls into a few dozen.
//
// The per-prim meshes stay in the scene graph (hidden) because picking uses
// them, and an object that is selected or moving is excluded from its cell so it
// keeps its own meshes and stays interactive.
import * as THREE from "../vendor/three.module.min.js";

export const CELL_SIZE = 32;

export class PrimBatcher {
  constructor(root, opts = {}) {
    this.root = root;                 // world.root (SL space)
    this.group = new THREE.Group();
    this.group.name = "batches";
    root.add(this.group);
    this.cellSize = opts.cellSize || CELL_SIZE;
    this.cells = new Map();           // key -> cell
    this.dirty = new Set();           // cell keys waiting for a rebuild
    this.budgetMs = opts.budgetMs || 4;
    this.enabled = true;
    this.shadows = !!opts.shadows;
    this.maxPrims = 4000;
    this.drawDistance = 200;
    this.stats = { batches: 0, drawCalls: 0, rebuilds: 0, merged: 0, lastMs: 0 };
    this._normal = new THREE.Matrix3();
    this._center = new THREE.Vector3();
  }

  keyFor(rec) {
    const p = rec.position || [0, 0, 0];
    const s = this.cellSize;
    return Math.floor(p[0] / s) + "," + Math.floor(p[1] / s);
  }

  shouldBatch(rec) {
    return this.enabled && rec && !rec.noBatch && !rec.excluded && rec.group && !rec.isAvatar;
  }

  add(rec) {
    if (!this.shouldBatch(rec)) { this.remove(rec); return; }
    const key = this.keyFor(rec);
    if (rec._cellKey && rec._cellKey !== key) this.remove(rec);
    let cell = this.cells.get(key);
    if (!cell) { cell = { key, recs: new Set(), meshes: [], prims: 0 }; this.cells.set(key, cell); }
    rec._cellKey = key;
    cell.recs.add(rec);
    cell.prims = cell.recs.size;
    this.dirty.add(key);
  }

  remove(rec) {
    if (!rec || !rec._cellKey) return;
    const cell = this.cells.get(rec._cellKey);
    if (cell) {
      cell.recs.delete(rec);
      cell.prims = cell.recs.size;
      this.dirty.add(cell.key);
    }
    rec._cellKey = null;
  }

  /** Marks the cell of a record as needing a rebuild (move, texture, LOD). */
  touch(rec) {
    if (rec && rec._cellKey) this.dirty.add(rec._cellKey);
  }

  /** Excludes/includes a record (selection, a prim that started moving). */
  setExcluded(rec, on) {
    if (!rec) return;
    const was = !!rec.excluded;
    rec.excluded = !!on;
    if (was === !!on) return;
    if (on) this.remove(rec);
    else this.add(rec);
  }

  clear() {
    for (const cell of this.cells.values()) this.disposeCell(cell);
    this.cells.clear();
    this.dirty.clear();
  }

  disposeCell(cell) {
    for (const m of cell.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    cell.meshes = [];
  }

  /**
   * Rebuilds the dirty cells that are in range, within a per-frame time budget,
   * and toggles each cell's batch against its prims. `cameraPos` is in three.js
   * world space; object positions are in SL space, so the axes are swapped.
   */
  update(cameraPos, budget = this.maxPrims) {
    if (!this.enabled) return;
    this.maxPrims = budget;
    const camX = cameraPos.x, camZ = -cameraPos.z; // SL x/y from three x/z
    const range = this.drawDistance + this.cellSize;
    const t0 = performance.now();

    // Nearest cells first: when there are more prims than the budget allows, the
    // ones close to the camera are the ones worth meshing.
    const order = [];
    for (const cell of this.cells.values()) {
      cell.dist = cellDistance(cell, camX, camZ, this.cellSize);
      order.push(cell);
    }
    order.sort((a, b) => a.dist - b.dist);

    let used = 0;
    const active = new Set();
    for (const cell of order) {
      const inRange = cell.dist < range;
      const fits = used + cell.prims <= budget || used === 0;
      if (inRange && fits && cell.prims) {
        active.add(cell.key);
        used += cell.prims;
      }
    }

    let rebuilt = 0;
    for (const cell of this.cells.values()) {
      const want = active.has(cell.key);
      if (!want) {
        if (cell.meshes.length) this.disposeCell(cell);
        // Out of range: the prims keep their own meshes and the ordinary distance
        // test in world.updateVisibility hides them. In range but over the object
        // budget: they are marked so the same test keeps them out of the frame —
        // that is what makes the budget a real ceiling instead of a suggestion.
        const overBudget = cell.dist < range;
        for (const rec of cell.recs) {
          rec.batched = false;
          rec.overBudget = overBudget;
        }
        continue;
      }
      if (this.dirty.has(cell.key)) {
        if (performance.now() - t0 > this.budgetMs && rebuilt > 0) continue;
        this.rebuild(cell);
        this.dirty.delete(cell.key);
        rebuilt++;
      }
      // The merged meshes carry the cell in range; the prims themselves are kept
      // only for picking (an invisible mesh is still raycast by three.js).
      this.setPrimsVisible(cell, false);
    }
    this.stats.rebuilds = rebuilt;
    this.stats.lastMs = performance.now() - t0;
  }

  setPrimsVisible(cell, visible) {
    for (const rec of cell.recs) {
      if (rec.group) rec.group.visible = visible;
      rec.batched = !visible;
      rec.overBudget = false;
    }
  }

  rebuild(cell) {
    this.disposeCell(cell);
    const buckets = new Map(); // material -> { geos: [], matrices: [], count, indexCount }
    for (const rec of cell.recs) {
      if (!this.shouldBatch(rec) || !rec.group) continue;
      rec.group.updateMatrix();
      const matrix = rec.group.matrix;
      const normal = this._normal.getNormalMatrix(matrix);
      for (const mesh of rec.group.children) {
        if (!mesh.isMesh || !mesh.geometry) continue;
        let bucket = buckets.get(mesh.material);
        if (!bucket) { bucket = { geos: [], matrices: [], normals: [], verts: 0, indices: 0 }; buckets.set(mesh.material, bucket); }
        const pos = mesh.geometry.getAttribute("position");
        const idx = mesh.geometry.getIndex();
        if (!pos) continue;
        bucket.geos.push(mesh.geometry);
        bucket.matrices.push(matrix, normal);
        bucket.verts += pos.count;
        bucket.indices += idx ? idx.count : pos.count;
      }
    }
    if (!buckets.size) return;
    this.stats.merged += cell.recs.size;
    for (const [material, bucket] of buckets) {
      const geo = mergeBucket(bucket);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, material);
      // A merged cell has no per-prim transparency information any more, so the
      // material's own flags decide: opaque materials cast, see-through ones do
      // not (a shadow from an invisible surface is the classic artefact here).
      mesh.castShadow = this.shadows && !material.transparent;
      mesh.receiveShadow = this.shadows;
      mesh.matrixAutoUpdate = false;
      mesh.name = "batch:" + cell.key;
      this.group.add(mesh);
      cell.meshes.push(mesh);
    }
    this.stats.batches = this.countBatches();
  }

  countBatches() {
    let n = 0;
    for (const cell of this.cells.values()) n += cell.meshes.length;
    return n;
  }

  dispose() {
    this.clear();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

function cellDistance(cell, camX, camZ, size) {
  const [cx, cy] = cell.key.split(",");
  const x0 = Number(cx) * size, y0 = Number(cy) * size;
  const x1 = x0 + size, y1 = y0 + size;
  const dx = camX < x0 ? x0 - camX : camX > x1 ? camX - x1 : 0;
  const dy = camZ < y0 ? y0 - camZ : camZ > y1 ? camZ - y1 : 0;
  return Math.hypot(dx, dy);
}

/**
 * Concatenates a bucket's geometries with their own transforms baked in. Two
 * passes: one to size the buffers, one to fill them, so nothing is reallocated.
 */
function mergeBucket(bucket) {
  const verts = bucket.verts;
  if (!verts) return null;
  const positions = new Float32Array(verts * 3);
  const normals = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  const indices = new Uint32Array(bucket.indices);
  let v = 0;
  let i = 0;
  for (let g = 0; g < bucket.geos.length; g++) {
    const geo = bucket.geos[g];
    const matrix = bucket.matrices[g * 2];
    const normal = bucket.matrices[g * 2 + 1];
    const pos = geo.getAttribute("position");
    const nor = geo.getAttribute("normal");
    const uv = geo.getAttribute("uv");
    const idx = geo.getIndex();
    const n = pos.count;
    const vec = new THREE.Vector3();
    for (let k = 0; k < n; k++) {
      vec.set(pos.getX(k), pos.getY(k), pos.getZ(k)).applyMatrix4(matrix);
      positions[(v + k) * 3] = vec.x;
      positions[(v + k) * 3 + 1] = vec.y;
      positions[(v + k) * 3 + 2] = vec.z;
      if (nor) {
        vec.set(nor.getX(k), nor.getY(k), nor.getZ(k)).applyMatrix3(normal).normalize();
        normals[(v + k) * 3] = vec.x;
        normals[(v + k) * 3 + 1] = vec.y;
        normals[(v + k) * 3 + 2] = vec.z;
      }
      if (uv) {
        uvs[(v + k) * 2] = uv.getX(k);
        uvs[(v + k) * 2 + 1] = uv.getY(k);
      }
    }
    if (idx) {
      for (let k = 0; k < idx.count; k++) indices[i + k] = idx.getX(k) + v;
      i += idx.count;
    } else {
      for (let k = 0; k < n; k++) indices[i + k] = v + k;
      i += n;
    }
    v += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeBoundingSphere();
  return out;
}
