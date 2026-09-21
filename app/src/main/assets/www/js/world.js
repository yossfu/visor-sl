// World: the region contents (terrain, water level, prims) rendered with three.js.
import * as THREE from "../vendor/three.module.min.js";
import { primToFaces } from "./prims.js";
import { buildTerrainMesh, Terrain, REGION_SIZE, SAMPLES_PER_EDGE } from "./terrain.js";
import { terrainTextures, TextureLibrary } from "./textures.js";
import { faceUVMatrix, defaultFace } from "./texture-entry.js";
import { createAvatar, disposeAvatar, applyShape, applyPose, applyBakedTextures, bakedNeeded }
  from "./avatar/builder.js";
import { AvatarAnimations } from "./avatar/animation.js";
import { DEFAULT_ANIMS } from "./avatar/anim-data.js";
import { PrimBatcher } from "./batch.js";

export const QUALITY = { low: 2, medium: 3, high: 4, ultra: 5 };

export class World {
  constructor(viewer) {
    this.viewer = viewer;
    this.root = new THREE.Group();
    viewer.slRoot.add(this.root);
    this.texlib = new TextureLibrary();
    // Static batching (see batch.js): without it a region of a thousand prims is
    // thousands of draw calls and no phone can keep up.
    this.batcher = new PrimBatcher(this.root);
    this.terrain = new Terrain();
    this.terrainMesh = null;
    this.terrainKnown = false;  // true once the region has sent real terrain
    this.objects = new Map();   // uuid -> object record
    this.avatars = new Map();   // uuid -> other residents
    this.avatarsWithBody = 0;   // how many of them have the real SL body meshes
    this.avatarError = null;    // why they are still capsules, if they are
    this.avatarAppearances = new Map(); // uuid -> appearance (may arrive first)
    this.pendingAvatarAnimations = new Map(); // uuid -> animation list
    // Residents with nothing else playing stand (the grid's default stand asset).
    this.defaultAnimation = DEFAULT_ANIMS.stand;
    this.pickables = [];
    this._pickSet = new Set();
    this._pickDirty = false;
    this.quality = this._qualityFromDevice();
    this.selection = null;
    this.onSelect = null;
    this.drawDistance = 260;
    this.maxObjects = 4000;
    this.terrainSkip = 2;
    // Sharing one geometry/material between prims that look identical is what
    // keeps a whole region affordable on a phone: a region is mostly a handful
    // of shapes repeated with a handful of textures. The caches are bounded —
    // past the limit a prim simply gets its own copy, which the mesh owns and
    // disposes, so nothing leaks and nothing is disposed while still in use.
    this._geoCache = new Map();
    this._matCache = new Map();
    this._matByTex = new Map(); // texture key -> Set(material) waiting for it
    this._visList = [];
    this._visFar = false;
    this._visTick = 0;
    this._lodQueue = [];
    // The session registers a texture requester here; the avatar code needs it
    // because baked textures arrive through the same GetTexture queue.
    this.onTextureNeeded = null;
    // Sculpt maps, keyed by their texture UUID. A sculpted prim draws nothing
    // until its map has been decoded — drawing the base shape instead is what
    // fills a region with phantom boxes ("geometrías extrañas").
    this.sculptMaps = new Map();
    this.sculptAsked = new Set();   // sculpt ids already requested from the grid
    this.sculptStats = { sculpted: 0, drawn: 0, waiting: 0, degenerate: 0, mesh: 0 };
    // The session registers a sculpt requester here (sculpt maps go through the
    // ordinary texture queue, but the world needs their *pixels*).
    this.onSculptNeeded = null;
  }

  /** True when this prim's shape comes from a map rather than from profile×path. */
  static sculptKind(params) {
    const t = (params && params.sculptType) || 0;
    if ((t & 7) === 0) return "none";
    return (t & 7) === 5 ? "mesh" : "sculpt";
  }

  /** Turns an ImageBitmap of a sculpt map into the raw RGB the mesh needs. */
  setSculptMap(uuid, bitmap) {
    if (!uuid || !bitmap || !bitmap.width || !bitmap.height) return false;
    try {
      const w = bitmap.width, h = bitmap.height;
      const canvas = (typeof OffscreenCanvas !== "undefined")
        ? new OffscreenCanvas(w, h) : document.createElement("canvas");
      if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const px = ctx.getImageData(0, 0, w, h).data;
      // The mesh only ever reads R,G,B, so keep just those three per texel.
      const rgb = new Uint8Array(w * h * 3);
      for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
        rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2];
      }
      this.sculptMaps.set(uuid, { width: w, height: h, components: 3, data: rgb });
      // Rebuild everything that was waiting for exactly this map.
      for (const rec of this.objects.values()) {
        if (rec.params && rec.params.sculptId === uuid) this.rebuildPrim(rec);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Applies a device profile (see perf.js): how far to draw, how many objects to
   * keep meshed, how coarse the terrain grid is and how much detail the prims
   * get. Called with a whole profile object, so switching quality is one call.
   */
  applyProfile(p) {
    if (!p) return;
    this.profile = p;
    this.drawDistance = p.drawDistance || this.drawDistance;
    this.maxObjects = p.maxObjects || this.maxObjects;
    this.terrainSkip = p.terrainSkip || 1;
    this.quality = p.name === "bajo" ? 2 : p.name === "medio" ? 3 : 4;
    this.shadows = !!p.shadows;
    if (this.batcher) {
      this.batcher.drawDistance = this.drawDistance;
      this.batcher.enabled = p.batching !== false;
      this.batcher.shadows = this.shadows;
    }
    if (p.textureBudgetMB) this.texlib.setBudget(p.textureBudgetMB);
    // The decoded texture size is the other half of the texture cost: a 1024px
    // texture is four times the memory and upload time of a 512px one.
    if (typeof p.texMax === "number") {
      import("./j2c.js").then((m) => m.setTextureMaxSize(p.texMax)).catch(() => {});
    }
    if (this.terrainMesh) this.rebuildTerrain();
    // Water follows the terrain's existence (see setTerrainKnown) as well as the
    // profile: on the lowest profile the plane is skipped entirely.
    this.applyWaterVisibility();
    // A quality change re-LODs gradually; the per-frame budget keeps it smooth.
    this._lodQueue = [];
  }

  _qualityFromDevice() {
    const mem = navigator.deviceMemory || 4;
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    if (mobile && mem <= 4) return 2;
    if (mobile) return 3;
    return 4;
  }

  setQuality(opts) {
    this.quality = opts.objects ?? this.quality;
    if (this.terrainMesh) this.rebuildTerrain();
  }

  // --- terrain ------------------------------------------------------------
  setTerrain(terrain) {
    this.terrain = terrain;
    this.viewer.water.setLevel(terrain.waterHeight);
    this.rebuildTerrain();
  }

  rebuildTerrain() {
    if (this.terrainMesh) {
      this.root.remove(this.terrainMesh);
      this.terrainMesh.geometry.dispose();
      this.terrainMesh = null;
    }
    const skip = this.terrainSkip || (this.quality >= 4 ? 1 : 2);
    const mesh = buildTerrainMesh(this.terrain, { skip });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    geo.computeBoundingSphere();

    const tex = terrainTextures();
    const heights = this.terrain.heights;
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const uniforms = {
      uT0: { value: tex.sand }, uT1: { value: tex.grass },
      uT2: { value: tex.rock }, uT3: { value: tex.snow },
      uH: { value: new THREE.Vector4(heights.lowStart, heights.lowEnd, heights.highStart, heights.highEnd) },
      uTile: { value: 1 / 8 },
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vSlPos;\nvarying vec3 vSlNormal;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSlPos = transformed;\nvSlNormal = normal;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          varying vec3 vSlPos; varying vec3 vSlNormal;
          uniform sampler2D uT0, uT1, uT2, uT3; uniform vec4 uH; uniform float uTile;`)
        .replace("#include <map_fragment>", `
          vec2 tuv = vSlPos.xy * uTile;
          float hgt = vSlPos.z;
          float slope = 1.0 - clamp(normalize(vSlNormal).z, 0.0, 1.0);
          vec3 c0 = texture2D(uT0, tuv).rgb;
          vec3 c1 = texture2D(uT1, tuv).rgb;
          vec3 c2 = texture2D(uT2, tuv * 0.5).rgb;
          vec3 c3 = texture2D(uT3, tuv).rgb;
          float b01 = smoothstep(uH.x, uH.y, hgt);
          float b23 = smoothstep(uH.z, uH.w, hgt);
          vec3 tcol = mix(c0, c1, b01);
          tcol = mix(tcol, c2, b23);
          tcol = mix(tcol, c3, smoothstep(uH.w, uH.w + 12.0, hgt));
          tcol = mix(tcol, c2, clamp(slope * 2.6, 0.0, 1.0) * 0.85);
          diffuseColor.rgb *= tcol;
        `);
    };
    this.terrainMesh = new THREE.Mesh(geo, mat);
    this.terrainMesh.receiveShadow = !!this.shadows;
    this.terrainMesh.name = "terrain";
    this.root.add(this.terrainMesh);
    this.terrainMesh.userData.isTerrain = true;
    this.terrainUniforms = uniforms;
    if (this.terrainTexIds) this.applyTerrainTextures();
  }

  /**
   * The four TerrainDetail textures the region announces in its RegionHandshake.
   * Until they arrive the terrain keeps the procedural stand-ins.
   */
  setTerrainTextures(ids) {
    this.terrainTexIds = ids && ids.length ? ids.slice(0, 4) : null;
    this.applyTerrainTextures();
  }

  applyTerrainTextures() {
    const u = this.terrainUniforms;
    if (!u || !this.terrainTexIds) return 0;
    const slots = [u.uT0, u.uT1, u.uT2, u.uT3];
    let applied = 0;
    for (let i = 0; i < 4; i++) {
      const id = this.terrainTexIds[i];
      if (!id || /^0+$/.test(id.replace(/-/g, ""))) continue;
      if (this.texlib.cache.has(id)) { slots[i].value = this.texlib.get(id); applied++; }
    }
    this.terrainTexturesApplied = applied;
    return applied;
  }

  heightAt(x, y) { return this.terrain.bilinear(x, y); }

  /**
   * Marks that real terrain has arrived from the region. Until it does, the
   * region is a flat placeholder at 0 m and the water plane (which sits at the
   * region's sea level, typically 20 m) would cover the whole view like a dark
   * transparent sea with everything drowned under it — which reads exactly like
   * "no hay terreno y se ven cuadros negros". Keeping the water out of the way
   * until there is terrain to flood is both honest and much easier to look at.
   */
  setTerrainKnown(on) {
    const next = !!on;
    if (next === this.terrainKnown) return;
    this.terrainKnown = next;
    this.applyWaterVisibility();
  }

  applyWaterVisibility() {
    const w = this.viewer.water;
    if (!w || !w.mesh) return;
    const allowed = !this.profile || this.profile.water !== false;
    w.mesh.visible = allowed && this.terrainKnown === true;
  }

  // --- prims --------------------------------------------------------------
  resolveTexture(key) {
    return this.texlib.get(key);
  }

  buildPrimGeometry(params, detail, sculpt) {
    const vol = primToFaces(params, detail, sculpt);
    if (!vol) return null;
    return vol;
  }

  /**
   * How many objects are currently sculpted, drawn, waiting for their map,
   * rejected and mesh — recomputed on demand so the diagnostics panel and the
   * phone report always agree with the scene.
   */
  refreshSculptStats() {
    const s = { sculpted: 0, drawn: 0, waiting: 0, degenerate: 0, mesh: 0 };
    for (const rec of this.objects.values()) {
      const kind = rec.shapeKind || World.sculptKind(rec.params);
      if (kind === "mesh") { s.mesh++; continue; }
      if (kind !== "sculpt") continue;
      s.sculpted++;
      if (rec.vol) s.drawn++;
      else {
        const id = rec.params && rec.params.sculptId;
        if (id && this.sculptMaps.has(id)) s.degenerate++;
        else s.waiting++;
      }
    }
    this.sculptStats = s;
    return s;
  }

  addPrim(obj) {
    this.removePrim(obj.id, true);
    const rec = Object.assign({ params: {}, faces: [] }, obj);
    this.objects.set(rec.id, rec);
    this.rebuildPrim(rec);
    return rec;
  }

  removePrim(id, silent) {
    const rec = this.objects.get(id);
    if (!rec) return;
    if (rec.group) {
      this.root.remove(rec.group);
      rec.group.traverse((o) => { if (o.isMesh) this._releaseMesh(o); });
    }
    this.batcher.remove(rec);
    this.objects.delete(id);
    if (!silent && this.selection === rec) this.select(null);
  }

  /** Drops a mesh from the picking set and frees only what the mesh owns. */
  _releaseMesh(o) {
    this._pickSet.delete(o);
    this._pickDirty = true;
    if (!o.userData.sharedGeo && o.geometry) o.geometry.dispose();
  }

  /** The scene-graph objects the pointer can hit (rebuilt only when it changed). */
  pickList() {
    if (this._pickDirty) {
      this.pickables = [...this._pickSet];
      this._pickDirty = false;
    }
    return this.pickables;
  }

  updatePrim(id, patch) {
    const rec = this.objects.get(id);
    if (!rec) return;
    if (patch.params) rec.params = Object.assign({}, rec.params, patch.params);
    for (const k of ["position", "rotation", "scale", "texture", "textureEntry", "name"])
      if (patch[k] !== undefined) rec[k] = patch[k];
    if (patch.params) rec._shapeSig = null;
    this.rebuildPrim(rec);
  }

  /**
   * A prim the simulator moved. Prims that move repeatedly are kept out of the
   * static batches: a moving prim would force a rebuild of its whole cell every
   * frame, which costs more than drawing it on its own.
   */
  movePrim(rec, position, rotation) {
    if (!rec) return;
    if (position) rec.position = position;
    if (rotation) rec.rotation = rotation;
    rec.moves = (rec.moves || 0) + 1;
    if (rec.moves === 3) this.batcher.setExcluded(rec, true);
    this.rebuildPrim(rec);
  }

  rebuildPrim(rec) {
    if (rec.group) {
      this.root.remove(rec.group);
      rec.group.traverse((o) => { if (o.isMesh) this._releaseMesh(o); });
    }
    const group = new THREE.Group();
    rec.group = group;
    rec.detail = rec.detail || this.detailFor(rec);
    // Sculpted prims: the geometry comes from the sculpt map (a texture), so the
    // prim cannot be drawn until that map has been decoded. Mesh prims carry a
    // mesh asset instead of a shape, which this viewer does not decode yet —
    // drawing either one as its base cube is exactly what "un sinfín de
    // geometrías extrañas" looks like, so neither is drawn.
    const kind = World.sculptKind(rec.params);
    rec.shapeKind = kind;
    let vol = null;
    if (kind === "none") {
      vol = this.buildPrimGeometry(rec.params, rec.detail, null);
    } else if (kind === "sculpt") {
      const id = rec.params.sculptId;
      const map = id ? this.sculptMaps.get(id) : null;
      if (map) vol = this.buildPrimGeometry(rec.params, rec.detail, map);
      else if (id && this.onSculptNeeded && !this.sculptAsked.has(id)) {
        // Ask once per map: a prim is rebuilt on every LOD change and every move,
        // and re-asking each time would flood the texture queue with a map that
        // is already on its way (or already known to be missing).
        this.sculptAsked.add(id);
        this.onSculptNeeded(id);
      }
    }
    rec.vol = vol;
    if (vol) {
      const shapeSig = rec._shapeSig || (rec._shapeSig = stableKey(rec.params));
      const shadows = !!this.shadows;
      for (const face of vol.faces) {
        const geo = this._faceGeometry(rec, shapeSig, face);
        const f = this.faceProps(rec, face.id);
        const key = f.texture || (rec.texture ? (rec.texture[face.id] ?? rec.texture.all) : null);
        const mat = this._faceMaterial(f, key);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = shadows && f.rgba[3] >= 0.999;
        mesh.receiveShadow = shadows;
        mesh.userData.objectId = rec.id;
        mesh.userData.faceId = face.id;
        mesh.userData.texKey = key;
        mesh.userData.sharedGeo = !!geo.userData.shared;
        this._pickSet.add(mesh);
        this._pickDirty = true;
        group.add(mesh);
      }
    }
    const pos = rec.position || [128, 128, 30];
    const rot = rec.rotation || [0, 0, 0, 1];
    const sc = rec.scale || [1, 1, 1];
    group.position.set(pos[0], pos[1], pos[2]);
    group.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
    group.scale.set(sc[0], sc[1], sc[2]);
    group.name = rec.name || rec.id;
    this.root.add(group);
    // Hand it to the static batcher; if it is batched its own meshes are hidden
    // and the merged cell mesh draws it instead.
    this.batcher.add(rec);
    if (rec.batched || rec.overBudget) group.visible = false;
  }

  /** Rebuilds the static batches that changed, nearest to the camera first. */
  updateBatches(cameraPos, budget) {
    this.batcher.update(cameraPos, budget || this.maxObjects);
  }

  /**
   * Geometry for one face, shared between every prim with the same shape, LOD
   * and texture repeat/offset. UVs are baked per prim, so the transform is part
   * of the key — prims with an untouched texture entry (the vast majority) hit.
   */
  _faceGeometry(rec, shapeSig, face) {
    const f = rec.textureEntry && rec.textureEntry.getFace ? rec.textureEntry.getFace(face.id) : defaultFace();
    const rep = rec.repeat ? `${rec.repeat[0]}x${rec.repeat[1]}` : "";
    const uvSig = `${f.repeatU},${f.repeatV},${f.offsetU},${f.offsetV},${f.rotation}`;
    const key = `${shapeSig}|${rec.detail}|${face.id}|${uvSig}|${rep}`;
    const hit = this._geoCache.get(key);
    if (hit) return hit;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(face.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(face.normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(bakeFaceUV(face, rec), 2));
    geo.setIndex(new THREE.BufferAttribute(
      face.indices instanceof Uint32Array ? face.indices : new Uint32Array(face.indices), 1));
    geo.computeBoundingSphere();
    if (this._geoCache.size < GEO_CACHE_MAX) {
      geo.userData.shared = true;
      this._geoCache.set(key, geo);
    }
    return geo;
  }

  /**
   * Material for one face, shared by every prim whose face looks the same
   * (same texture, same tint, same transparency/fullbright/specular). Sharing
   * is what lets three.js sort and batch the draw calls instead of switching
   * state for every face of every prim.
   */
  _faceMaterial(f, key) {
    const rgba = f.rgba;
    const alpha = rgba[3] < 0.999;
    const kind = alpha ? "a" : f.fullbright ? "f" : f.specular > 0.2 ? "s" : "d";
    const matKey = `${key || ""}|${rgba[0].toFixed(3)},${rgba[1].toFixed(3)},${rgba[2].toFixed(3)},${rgba[3].toFixed(3)}|${kind}|${(f.glow || 0).toFixed(2)}|${f.specular}`;
    const hit = this._matCache.get(matKey);
    if (hit) return hit;

    const map = key ? this.resolveTexture(key) : this.texlib.default;
    let mat;
    if (alpha) {
      mat = new THREE.MeshLambertMaterial({ map, color: new THREE.Color(rgba[0], rgba[1], rgba[2]) });
      mat.transparent = true;
      mat.depthWrite = false;
    } else if (f.fullbright) {
      mat = new THREE.MeshBasicMaterial({ map, color: new THREE.Color(rgba[0], rgba[1], rgba[2]) });
      if (f.glow > 0.02) mat.color.multiplyScalar(1 + f.glow * 0.35);
    } else if (f.specular > 0.2) {
      mat = new THREE.MeshPhongMaterial({
        map, color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
        emissive: new THREE.Color(rgba[0], rgba[1], rgba[2]).multiplyScalar(f.glow * 0.28),
        specular: new THREE.Color(0.6, 0.6, 0.62), shininess: 40 + f.specular * 120,
      });
    } else {
      mat = new THREE.MeshLambertMaterial({
        map, color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
        emissive: new THREE.Color(rgba[0], rgba[1], rgba[2]).multiplyScalar(f.glow * 0.28),
      });
    }
    if (key) this.registerMaterial(key, mat);
    if (this._matCache.size < MAT_CACHE_MAX) this._matCache.set(matKey, mat);
    return mat;
  }

  /** Keeps a material on the list that gets its map when the texture arrives. */
  registerMaterial(key, mat) {
    if (!key) return;
    let set = this._matByTex.get(key);
    if (!set) { set = new Set(); this._matByTex.set(key, set); }
    set.add(mat);
  }

  faceProps(rec, faceIndex) {
    const base = defaultFace();
    let f = base;
    if (rec.textureEntry && rec.textureEntry.getFace) f = rec.textureEntry.getFace(faceIndex);
    const objRgba = rec.rgba || null;
    const out = {
      rgba: objRgba ? [objRgba[0], objRgba[1], objRgba[2], objRgba[3] ?? 1] : [f.rgba[0], f.rgba[1], f.rgba[2], f.rgba[3]],
      glow: Math.max(f.glow, rec.glow || 0),
      fullbright: !!rec.fullbright || !!(((f.material ?? 0) >> 5) & 1),
      specular: ((f.material ?? 0) >> 6) & 3,
      repeatU: f.repeatU, repeatV: f.repeatV,
      offsetU: f.offsetU, offsetV: f.offsetV, rotation: f.rotation,
      texture: null,
    };
    if (rec.textureByFace && rec.textureByFace[faceIndex]) out.texture = rec.textureByFace[faceIndex];
    return out;
  }

  detailFor(rec) {
    const sc = rec.scale || [1, 1, 1];
    const s = Math.max(sc[0], sc[1], sc[2]);
    const q = this.quality;
    if (s > 12) return Math.min(4, q);
    if (s > 4) return Math.min(3, q);
    if (s > 1.2) return Math.min(3, q);
    return Math.max(1, Math.min(2, q));
  }

  // Re-LOD a few objects per frame based on camera distance (SL-style).
  updateLOD(cameraPos, budget = 2) {
    let done = 0;
    for (const rec of this.objects.values()) {
      if (done >= budget) break;
      // The visibility pass already measured this; no vector allocation here.
      let d2 = rec._d2;
      if (d2 === undefined) {
        const p = rec.position;
        if (!p) continue;
        const dx = p[0] - cameraPos.x, dz = p[1] + cameraPos.z;
        d2 = rec._d2 = dx * dx + dz * dz;
      }
      if (rec.group && rec.group.visible === false) continue;
      const dist = Math.sqrt(d2);
      const sc = rec.scale || [1, 1, 1];
      const radius = Math.max(sc[0], sc[1], sc[2]) * 0.5;
      const ratio = (radius * this.viewer.canvas.clientHeight) / Math.max(dist, 0.001);
      let want = ratio > 220 ? 4 : ratio > 90 ? 3 : ratio > 30 ? 2 : 1;
      want = Math.min(want, this.quality);
      if (want !== rec.detail) { rec.detail = want; this.rebuildPrim(rec); done++; }
    }
  }

  setDrawDistance(d) { this.drawDistance = d; }

  /**
   * Distance test for every object, plus a hard cap on how many are meshed at
   * once. Regions routinely hold several thousand prims; a phone cannot draw
   * them all, so past `maxObjects` the farthest ones are dropped even when they
   * are inside the draw distance. The expensive nearest-N pass runs rarely —
   * the cheap distance test runs every pass and is allocation-free.
   */
  updateVisibility(cameraPos) {
    const cx = cameraPos.x, cz = -cameraPos.z;
    const maxD2 = this.drawDistance * this.drawDistance;
    const list = this._visList;
    list.length = 0;
    for (const rec of this.objects.values()) {
      const p = rec.position;
      if (!p) continue;
      const dx = p[0] - cx, dz = p[1] - cz;
      const d2 = dx * dx + dz * dz;
      rec._d2 = d2;
      if (d2 < maxD2) list.push(rec);
    }
    this._visTick++;
    if (list.length > this.maxObjects && (this._visTick % 8 === 0 || this._visFar !== true)) {
      list.sort((a, b) => a._d2 - b._d2);
      this._visFar = true;
    } else if (list.length <= this.maxObjects) {
      this._visFar = false;
    }
    const keep = this._visFar ? Math.min(list.length, this.maxObjects) : list.length;
    const keepSet = this._keepSet || (this._keepSet = new Set());
    if (this._visFar) {
      keepSet.clear();
      for (let i = 0; i < keep; i++) keepSet.add(list[i]);
    }
    for (const rec of this.objects.values()) {
      if (!rec.group || rec.batched) continue; // batched cells are the batcher's job
      const d2 = rec._d2;
      const vis = !rec.overBudget && d2 !== undefined && d2 < maxD2 && (!this._visFar || keepSet.has(rec));
      if (rec.group.visible !== vis) rec.group.visible = vis;
    }
    this.visibleObjects = keep;
  }

  // --- picking ------------------------------------------------------------
  raycast(ndc) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.viewer.camera);
    return ray.intersectObjects(this.pickList(), false);
  }

  select(rec) {
    if (this.selection && this.selection.group) this.setHighlight(this.selection, false);
    // The selected prim comes out of the static batch so it can be highlighted
    // and edited; the merged mesh would swallow any per-object change.
    if (this.selection && this.selection !== rec) this.batcher.setExcluded(this.selection, false);
    this.selection = rec;
    if (rec && rec.group) this.setHighlight(rec, true);
    if (rec) this.batcher.setExcluded(rec, true);
    if (this.onSelect) this.onSelect(rec);
  }

  /**
   * Highlights one prim. Materials are shared between prims now, so the
   * selection clones the ones it touches — otherwise selecting a single box
   * would light up every identical box in the region.
   */
  setHighlight(rec, on) {
    if (!rec.group) return;
    rec.group.traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.emissive) return;
      if (on) {
        if (!o.userData._cloned) {
          o.material = o.material.clone();
          o.userData._cloned = true;
          this.registerMaterial(o.userData.texKey, o.material);
        }
        o.userData._em = o.material.emissive.clone();
        o.material.emissive.setRGB(0.25, 0.35, 0.6);
      } else if (o.userData._em) {
        o.material.emissive.copy(o.userData._em);
      }
    });
  }

  // Swap in a texture that finished downloading from the grid.
  applyTexture(uuid, source) {
    this.texlib.install(uuid, source.isTexture ? source : new THREE.Texture(source));
    let touched = 0;
    // Every prim that wants this texture shares one material, so the swap is a
    // single pass over the materials built for that key — not over the region.
    const tex = this.texlib.get(uuid);
    const mats = this._matByTex.get(uuid);
    if (tex && mats) {
      for (const mat of mats) {
        mat.map = tex;
        mat.needsUpdate = true;
        touched++;
      }
    }
    // Terrain textures are announced in the RegionHandshake and arrive through
    // the same GetTexture queue.
    if (this.terrainTexIds && this.terrainTexIds.includes(uuid)) touched += this.applyTerrainTextures();
    // Baked textures of the residents (skin, clothes) come through the same
    // queue: swap them in on every body part that was waiting for this uuid.
    for (const av of this.avatars.values()) {
      const group = av.bodyGroup;
      if (!group) continue;
      for (const p of group.userData.parts) {
        if (p.mesh.userData.bakedUUID !== uuid) continue;
        p.material.map = this.texlib.get(uuid);
        p.material.color.set(0xffffff);
        p.material.needsUpdate = true;
        touched++;
      }
    }
    return touched;
  }

  // Other residents are drawn with the real SL body meshes (builder.js) plus a
  // billboarded name tag. Creating an avatar that already exists updates its name
  // instead of duplicating it (the simulator sends our own avatar through the
  // same path as everyone else).
  //
  // While the meshes are being read off the disk the avatar is a capsule, so a
  // resident never flickers in as nothing.
  addAvatar(id, name) {
    const known = this.avatars.get(id);
    if (known) {
      if (name && name !== known.name && !/^\(.*\)$/.test(name)) {
        known.name = name;
        if (known.sprite.material.map) known.sprite.material.map.dispose();
        known.sprite.material.map = nameTexture(name);
        known.sprite.material.needsUpdate = true;
      }
      return known;
    }
    const group = new THREE.Group();
    // The whole world is Z-up inside viewer.slRoot, so the capsule has to be
    // turned onto the Z axis (it is modelled around Y).
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, 1.1, 6, 12),
      new THREE.MeshLambertMaterial({ color: 0x7fa8d8 })
    );
    body.rotation.x = Math.PI / 2;
    body.position.z = 0.85;
    body.castShadow = true;
    group.add(body);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      // Name tags always draw on top, like the SL viewer does: it is how you
      // find your own avatar and other residents behind geometry.
      map: nameTexture(name || "residente"), transparent: true, depthTest: false, depthWrite: false,
    }));
    sprite.scale.set(2.4, 0.6, 1);
    sprite.position.set(0, 0, 2.15);
    group.add(sprite);
    this.root.add(group);
    const av = {
      id, name, group, body, sprite,
      bodyGroup: null, bodyPromise: null, appearance: null, weights: null,
      anim: new AvatarAnimations(), animations: null, animationCount: 0,
    };
    this.avatars.set(id, av);
    const pending = this.avatarAppearances.get(id);
    if (pending) av.appearance = pending;
    const pendingAnim = this.pendingAvatarAnimations.get(id);
    if (pendingAnim) {
      this.pendingAvatarAnimations.delete(id);
      this.setAvatarAnimations(id, pendingAnim);
    } else if (this.defaultAnimation) {
      // Every resident plays the default stand animation until the simulator
      // says otherwise, which is what makes a freshly-arrived avatar look alive
      // instead of frozen in its bind pose.
      av.anim.setList([{ animationID: this.defaultAnimation, sequenceID: 1 }], performance.now()).catch(() => {});
    }
    this.provideAvatarBody(av);
    return av;
  }

  /**
   * Loads the body meshes (once per session) and swaps them in for the capsule.
   * The simulator can report an appearance before the object update, so the
   * stored appearance is applied as soon as the body exists.
   */
  provideAvatarBody(av) {
    if (av.bodyPromise) return av.bodyPromise;
    av.bodyPromise = createAvatar(av.weights)
      .then((group) => {
        if (av.removed) { disposeAvatar(group); return null; }
        if (av.body) {
          av.group.remove(av.body);
          av.body.geometry.dispose();
          av.body.material.dispose();
          av.body = null;
        }
        group.name = "cuerpo";
        av.group.add(group);
        av.bodyGroup = group;
        if (av.appearance) this.applyAvatarAppearance(av);
        this.avatarsWithBody = (this.avatarsWithBody || 0) + 1;
        if (this.onAvatarBuilt) this.onAvatarBuilt(av);
        return group;
      })
      .catch((e) => {
        av.bodyPromise = null;
        av.bodyTries = (av.bodyTries || 0) + 1;
        this.avatarError = (e && e.message) || String(e);
        console.warn("[visor] no se pudo construir el avatar: " + this.avatarError, e);
        if (this.onAvatarBuiltError) this.onAvatarBuiltError(av, e);
        // One delayed retry per avatar: if the asset server was still warming up,
        // this is what turns a capsule back into a body without a reload.
        if (av.bodyTries < 2 && !av.removed) {
          setTimeout(() => { if (!av.removed) this.provideAvatarBody(av); }, 2500);
          return null;
        }
        // The capsule is supposed to be a placeholder for a second, not the
        // permanent look of every resident: if the bundled body meshes cannot be
        // read, the user must be told why instead of only seeing capsules and a
        // line in a console they cannot open. Reported once per session.
        if (!this._avatarErrorReported) {
          this._avatarErrorReported = true;
          if (this.onAvatarError) this.onAvatarError(this.avatarError);
        }
        return null;
      });
    return av.bodyPromise;
  }

  /**
   * The grid's version of a resident: the shape sliders (morph weights) and the
   * baked textures (skin, clothes) that the resident is wearing. May arrive
   * before the body meshes have been read, in which case it is queued.
   */
  setAvatarAppearance(id, appearance) {
    if (!id || !appearance) return;
    this.avatarAppearances.set(id, appearance);
    const av = this.avatars.get(id);
    if (!av) return;
    av.appearance = appearance;
    if (!av.bodyGroup) { this.provideAvatarBody(av); return; }
    this.applyAvatarAppearance(av);
  }

  applyAvatarAppearance(av) {
    const app = av.appearance;
    const group = av.bodyGroup;
    if (!app || !group) return 0;
    av.weights = app.weights || null;
    const applied = applyPose(group, av.weights, av.anim, performance.now());
    this.applyAvatarTextures(group, app.baked);
    this.updateNameTagHeight(av);
    return applied;
  }

  /** The floating name stays above the head, whatever the body's height. */
  updateNameTagHeight(av) {
    if (!av || !av.sprite || !av.bodyGroup) return;
    const h = av.bodyGroup.userData.height || 1.9;
    av.sprite.position.set(0, 0, h + 0.28);
  }

  /**
   * The animations a resident is playing, straight out of the simulator's
   * AvatarAnimation message. The whole list arrives every time it changes, so
   * sequences that are still listed keep running and the ones that vanished fade
   * out (avatar-animation.js).
   */
  setAvatarAnimations(id, list) {
    if (!id) return;
    const av = this.avatars.get(id);
    if (!av) {
      // The list can arrive before the object update that creates the avatar.
      this.pendingAvatarAnimations.set(id, list || []);
      return;
    }
    av.animations = list || [];
    av.animationCount = av.animations.length;
    av.anim.setList(av.animations, performance.now())
      .then(() => {
        // The list may reference animations the app does not ship (a resident's
        // own uploads): those need an asset transfer, and until it exists they
        // are simply not played.
        const missing = [...av.anim.missing];
        if (missing.length && this.onAnimationMissing) this.onAnimationMissing(missing);
      })
      .catch(() => {});
  }

  /**
   * Advances every resident's animation clocks and re-skins the ones that moved.
   * Called once per frame from the render loop; an avatar with nothing running
   * costs a Map iteration and nothing else.
   */
  animateAvatars(now) {
    let posed = 0;
    for (const av of this.avatars.values()) {
      const anim = av.anim;
      if (!anim || !av.bodyGroup) continue;
      if (!anim.active && anim.sequences.size === 0) continue;
      anim.update(now);
      if (!anim.active && anim.sequences.size === 0) {
        // Everything stopped: put the body back in its shaped rest pose.
        applyPose(av.bodyGroup, av.weights, null, now);
        this.updateNameTagHeight(av);
        posed++;
        continue;
      }
      applyPose(av.bodyGroup, av.weights, anim, now);
      this.updateNameTagHeight(av);
      posed++;
    }
    this.avatarsAnimated = posed;
    return posed;
  }

  /**
   * Baked textures for a body part. A texture that has not been downloaded yet
   * is requested through the session's GetTexture queue (the same one prims use)
   * and swapped in by applyTexture() when it arrives.
   */
  applyAvatarTextures(group, baked) {
    if (!group) return 0;
    const resolve = (uuid) => (this.texlib.installed.has(uuid) ? this.texlib.get(uuid) : null);
    const applied = applyBakedTextures(group, baked, resolve);
    for (const uuid of bakedNeeded(baked)) {
      if (!this.texlib.installed.has(uuid) && this.onTextureNeeded) {
        this.onTextureNeeded(uuid);
        this.avatarTextureRequests = (this.avatarTextureRequests || 0) + 1;
      }
    }
    return applied;
  }

  updateAvatar(av, pos, rot) {
    if (!av || !pos) return;
    av.group.position.set(pos[0], pos[1], pos[2]);
    if (rot && rot.length >= 4) av.group.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
    av.lastPosition = pos;
  }

  removeAvatar(av) {
    if (!av) return;
    av.removed = true;
    this.root.remove(av.group);
    av.group.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
      if (o.isSprite && o.material.map) o.material.map.dispose();
    });
    if (av.bodyGroup) {
      disposeAvatar(av.bodyGroup);
      av.body = null;
      this.avatarsWithBody = Math.max(0, (this.avatarsWithBody || 0) - 1);
    }
    if (this.avatars) this.avatars.delete(av.id);
  }

  get objectCount() { return this.objects.size; }

  /**
   * Empties the world: no prims, no avatars and a flat region floor. Connecting
   * to the grid uses this so the procedural demo island cannot survive behind
   * the real region (it used to bury every prim and the avatar inside it).
   */
  reset(terrain) {
    for (const id of [...this.objects.keys()]) this.removePrim(id, true);
    for (const av of [...this.avatars.values()]) this.removeAvatar(av);
    if (this.batcher) this.batcher.clear();
    this.objects.clear();
    this.avatars.clear();
    this.terrainKnown = false;
    this.avatarsWithBody = 0;
    this.avatarError = null;
    this._avatarErrorReported = false;
    this.resident = this.resident || new Map();
    this.resident.clear();
    // Sculpt maps of the previous region are kept (they are immutable assets and
    // re-using one costs nothing), but "already asked for" is reset so a map that
    // never arrived gets another chance in the region we are entering.
    if (this.sculptAsked) this.sculptAsked.clear();
    if (this.avatarAppearances) this.avatarAppearances.clear();
    this._lodQueue = [];
    this.selection = null;
    const t = terrain || new Terrain();
    for (let i = 0; i < t.samples.length; i++) t.samples[i] = 0;
    this.setTerrain(t);
    this.applyWaterVisibility();
  }

  dispose() {
    for (const id of [...this.objects.keys()]) this.removePrim(id, true);
    if (this.avatars) for (const av of [...this.avatars.values()]) this.removeAvatar(av);
    if (this.batcher) this.batcher.dispose();
    if (this.terrainMesh) { this.root.remove(this.terrainMesh); this.terrainMesh.geometry.dispose(); }
  }
}

// Geometry/material caches are bounded on purpose: past these counts a prim
// gets its own copy, which keeps a pathological region from growing without
// limit while still covering every normal one.
const GEO_CACHE_MAX = 3000;
const MAT_CACHE_MAX = 1200;

/**
 * Deterministic key for a prim's shape parameters. Key order in the object is
 * whatever the decoder produced, so it cannot be trusted: sorting the keys is
 * what makes two identical prims share one geometry.
 */
function stableKey(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return "[" + value.map(stableKey).join(",") + "]";
  const keys = Object.keys(value).sort();
  let out = "{";
  for (const k of keys) out += k + "=" + stableKey(value[k]) + ";";
  return out + "}";
}

function nameTexture(text) {
  const w = 256, h = 64;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(10,14,20,0.72)";
  ctx.fillRect(0, h - 34, w, 30);
  ctx.font = "bold 20px system-ui, sans-serif";
  ctx.fillStyle = "#dff1ff";
  ctx.textAlign = "center";
  ctx.fillText(String(text).slice(0, 24), w / 2, h - 12);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function bakeFaceUV(face, rec, vol) {
  const props = { repeatU: 1, repeatV: 1, offsetU: 0, offsetV: 0, rotation: 0 };
  const f = rec.textureEntry && rec.textureEntry.getFace ? rec.textureEntry.getFace(face.id) : defaultFace();
  props.repeatU = f.repeatU; props.repeatV = f.repeatV;
  props.offsetU = f.offsetU; props.offsetV = f.offsetV; props.rotation = f.rotation;
  if (rec.repeat) { props.repeatU *= rec.repeat[0]; props.repeatV *= rec.repeat[1]; }
  const m = faceUVMatrix(props);
  const src = face.uvs, out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 2) {
    const [u, v] = m.apply(src[i], src[i + 1]);
    out[i] = u; out[i + 1] = v;
  }
  return out;
}
