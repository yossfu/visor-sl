// World: the region contents (terrain, water level, prims) rendered with three.js.
import * as THREE from "../vendor/three.module.min.js";
import { primToFaces } from "./prims.js";
import { buildTerrainMesh, Terrain, REGION_SIZE, SAMPLES_PER_EDGE } from "./terrain.js";
import { terrainTextures, TextureLibrary } from "./textures.js";
import { faceUVMatrix, defaultFace } from "./texture-entry.js";

export const QUALITY = { low: 2, medium: 3, high: 4, ultra: 5 };

export class World {
  constructor(viewer) {
    this.viewer = viewer;
    this.root = new THREE.Group();
    viewer.slRoot.add(this.root);
    this.texlib = new TextureLibrary();
    this.terrain = new Terrain();
    this.terrainMesh = null;
    this.objects = new Map();   // uuid -> object record
    this.avatars = new Map();   // uuid -> other residents
    this.pickables = [];
    this.quality = this._qualityFromDevice();
    this.selection = null;
    this.onSelect = null;
    this.drawDistance = 260;
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
    const skip = this.quality >= 4 ? 1 : 2;
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
    this.terrainMesh.receiveShadow = true;
    this.terrainMesh.name = "terrain";
    this.root.add(this.terrainMesh);
    this.terrainMesh.userData.isTerrain = true;
  }

  heightAt(x, y) { return this.terrain.bilinear(x, y); }

  // --- prims --------------------------------------------------------------
  resolveTexture(key) {
    return this.texlib.get(key);
  }

  buildPrimGeometry(params, detail) {
    const vol = primToFaces(params, detail);
    if (!vol) return null;
    return vol;
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
      rec.group.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          this.pickables = this.pickables.filter((p) => p !== o);
        }
      });
    }
    this.objects.delete(id);
    if (!silent && this.selection === rec) this.select(null);
  }

  updatePrim(id, patch) {
    const rec = this.objects.get(id);
    if (!rec) return;
    if (patch.params) rec.params = Object.assign({}, rec.params, patch.params);
    for (const k of ["position", "rotation", "scale", "texture", "textureEntry", "name"])
      if (patch[k] !== undefined) rec[k] = patch[k];
    this.rebuildPrim(rec);
  }

  rebuildPrim(rec) {
    if (rec.group) {
      this.root.remove(rec.group);
      rec.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); this.pickables = this.pickables.filter((p) => p !== o); } });
    }
    const group = new THREE.Group();
    rec.group = group;
    rec.detail = rec.detail || this.detailFor(rec);
    const vol = this.buildPrimGeometry(rec.params, rec.detail);
    rec.vol = vol;
    if (vol) {
      const scale = rec.scale || [1, 1, 1];
      for (const face of vol.faces) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(face.positions, 3));
        geo.setAttribute("normal", new THREE.BufferAttribute(face.normals, 3));
        const uvs = bakeFaceUV(face, rec, vol);
        geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
        geo.setIndex(new THREE.BufferAttribute(
          face.indices instanceof Uint32Array ? face.indices : new Uint32Array(face.indices), 1));
        geo.computeBoundingSphere();
        const f = this.faceProps(rec, face.id);
        const key = f.texture || (rec.texture ? (rec.texture[face.id] ?? rec.texture.all) : null);
        const map = key ? this.resolveTexture(key) : this.texlib.default;
        const params = {
          map, color: new THREE.Color(f.rgba[0], f.rgba[1], f.rgba[2]),
          side: THREE.FrontSide,
        };
        const alpha = f.rgba[3] < 0.999;
        let mat;
        if (alpha) {
          mat = new THREE.MeshLambertMaterial(Object.assign({}, params));
          mat.transparent = true; mat.depthWrite = false;
        } else if (f.fullbright) {
          mat = new THREE.MeshBasicMaterial({ map, color: new THREE.Color(f.rgba[0], f.rgba[1], f.rgba[2]) });
          if (f.glow > 0.02) mat.color.multiplyScalar(1 + f.glow * 0.35);
        } else if (f.specular > 0.2) {
          mat = new THREE.MeshPhongMaterial(Object.assign({}, params, {
            emissive: new THREE.Color(f.rgba[0], f.rgba[1], f.rgba[2]).multiplyScalar(f.glow * 0.28),
            specular: new THREE.Color(0.6, 0.6, 0.62), shininess: 40 + f.specular * 120,
          }));
        } else {
          mat = new THREE.MeshLambertMaterial(Object.assign({}, params, {
            emissive: new THREE.Color(f.rgba[0], f.rgba[1], f.rgba[2]).multiplyScalar(f.glow * 0.28),
          }));
        }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = !alpha;
        mesh.receiveShadow = !alpha;
        mesh.userData.objectId = rec.id;
        mesh.userData.faceId = face.id;
        mesh.userData.texKey = key;
        group.add(mesh);
        this.pickables.push(mesh);
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
      const p = rec.position || [128, 128, 30];
      const wp = new THREE.Vector3(p[0], p[2], -p[1]);
      const dist = wp.distanceTo(cameraPos);
      const sc = rec.scale || [1, 1, 1];
      const radius = Math.max(sc[0], sc[1], sc[2]) * 0.5;
      const ratio = (radius * this.viewer.canvas.clientHeight) / Math.max(dist, 0.001);
      let want = ratio > 220 ? 4 : ratio > 90 ? 3 : ratio > 30 ? 2 : 1;
      want = Math.min(want, this.quality);
      if (want !== rec.detail) { rec.detail = want; this.rebuildPrim(rec); done++; }
    }
  }

  setDrawDistance(d) { this.drawDistance = d; }

  updateVisibility(cameraPos) {
    const cx = cameraPos.x, cz = -cameraPos.z;
    for (const rec of this.objects.values()) {
      const p = rec.position;
      if (!p) continue;
      const d = Math.hypot(p[0] - cx, p[1] - cz);
      const vis = d < this.drawDistance;
      if (rec.group && rec.group.visible !== vis) rec.group.visible = vis;
    }
  }

  // --- picking ------------------------------------------------------------
  raycast(ndc) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.viewer.camera);
    const hits = ray.intersectObjects(this.pickables, false);
    return hits;
  }

  select(rec) {
    if (this.selection && this.selection.group) this.setHighlight(this.selection, false);
    this.selection = rec;
    if (rec && rec.group) this.setHighlight(rec, true);
    if (this.onSelect) this.onSelect(rec);
  }

  setHighlight(rec, on) {
    rec.group.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissive) {
        if (on) {
          o.userData._em = o.material.emissive.clone();
          o.material.emissive.setRGB(0.25, 0.35, 0.6);
        } else if (o.userData._em) {
          o.material.emissive.copy(o.userData._em);
        }
      }
    });
  }

  // Swap in a texture that finished downloading from the grid.
  applyTexture(uuid, source) {
    this.texlib.install(uuid, source.isTexture ? source : new THREE.Texture(source));
    let touched = 0;
    for (const rec of this.objects.values()) {
      if (!rec.group) continue;
      rec.group.traverse((o) => {
        if (!o.isMesh || o.userData.texKey !== uuid) return;
        const tex = this.texlib.get(uuid);
        if (tex) {
          o.material.map = tex;
          o.material.needsUpdate = true;
          touched++;
        }
      });
    }
    return touched;
  }

  // Other residents are drawn as a capsule + billboarded name tag. Creating an
  // avatar that already exists updates its name instead of duplicating it (the
  // simulator sends our own avatar through the same path as everyone else).
  addAvatar(id, name) {
    const known = this.avatars.get(id);
    if (known) {
      if (name && name !== known.name && !/^\(.*\)$/.test(name)) {
        known.name = name;
        known.sprite.material.map.dispose();
        known.sprite.material.map = nameTexture(name);
        known.sprite.material.needsUpdate = true;
      }
      return known;
    }
    const group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, 1.1, 6, 12),
      new THREE.MeshLambertMaterial({ color: 0x7fa8d8 })
    );
    body.position.y = 0.85;
    body.castShadow = true;
    group.add(body);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      // Name tags always draw on top, like the SL viewer does: it is how you
      // find your own avatar and other residents behind geometry.
      map: nameTexture(name || "residente"), transparent: true, depthTest: false, depthWrite: false,
    }));
    sprite.scale.set(2.4, 0.6, 1);
    sprite.position.y = 2.1;
    group.add(sprite);
    this.root.add(group);
    const av = { id, name, group, body, sprite };
    this.avatars.set(id, av);
    return av;
  }

  updateAvatar(av, pos, rot) {
    if (!av || !pos) return;
    av.group.position.set(pos[0], pos[1], pos[2]);
    if (rot && rot.length >= 4) av.group.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
    av.lastPosition = pos;
  }

  removeAvatar(av) {
    if (!av) return;
    this.root.remove(av.group);
    av.group.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
      if (o.isSprite && o.material.map) o.material.map.dispose();
    });
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
    this.objects.clear();
    this.avatars.clear();
    this.resident = this.resident || new Map();
    this.resident.clear();
    this._lodQueue = [];
    this.selection = null;
    const t = terrain || new Terrain();
    for (let i = 0; i < t.samples.length; i++) t.samples[i] = 0;
    this.setTerrain(t);
  }

  dispose() {
    for (const id of [...this.objects.keys()]) this.removePrim(id, true);
    if (this.avatars) for (const av of [...this.avatars.values()]) this.removeAvatar(av);
    if (this.terrainMesh) { this.root.remove(this.terrainMesh); this.terrainMesh.geometry.dispose(); }
  }
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
