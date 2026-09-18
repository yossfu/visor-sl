// world.js -- los objetos (prims) que viven en la region.
//
// Un prim del mundo es: parametros de forma (`PrimParams`, los mismos campos que
// el build floater de SL) + transformada (posicion, rotacion, escala) + nombre.
// La geometria NO se guarda: se tesela con `llvolume.js` y la cachea
// `PrimMeshFactory` por `VolumeParams.key(lod)`, asi que N copias de un mismo
// cubo comparten un unico buffer en la GPU.
//
// Las coordenadas son las de three.js en metros (X este, Y arriba, Z sur). La
// correspondencia con la region de SL es slX = x + 128, slY = 128 - z.

import * as THREE from "./three.js";
import { PrimParams, SHAPES } from "./prims.js";
import { PrimMeshFactory, geometryBBox, faceInfo } from "./primMesh.js";
import { applyPrimDetail, ENV_INTENSITY } from "./region.js";
import { patternTexture, textureFromUrl } from "./textures.js";
import { emptyFace, faceIsDefault, faceSpec, faceSpecKey, facesToJson, facesFromJson } from "./faces.js";

let nextId = 1;

// Un objeto del mundo.
export class SlPrim {
  constructor(params, o = {}) {
    this.id = o.id || nextId++;
    this.name = o.name || "Prim " + this.id;
    this.params = params || new PrimParams("box");
    this.position = o.position ? o.position.clone() : new THREE.Vector3();
    this.quaternion = o.quaternion ? o.quaternion.clone() : new THREE.Quaternion();
    this.scale = o.scale ? o.scale.clone() : new THREE.Vector3(1, 1, 1);
    this.group = new THREE.Group();
    this.group.name = this.name;
    this.mesh = null;
    this.volume = null;
    this.build = o.build !== false;   // false = no colisiona (decorado)
    this.phantom = !!o.phantom;
    // Link set: en la raiz `links` es la lista de hijos; en un hijo `linkRoot`
    // apunta a la raiz y `local` es su matriz RELATIVA a la raiz.
    this.links = null;
    this.linkRoot = null;
    this.local = null;
    this.group.userData.slPrim = this;
    this.sync();
  }

  sync() {
    this.group.position.copy(this.position);
    this.group.quaternion.copy(this.quaternion);
    this.group.scale.copy(this.scale);
  }

  get isRound() { return !!(SHAPES[this.params.shape] && SHAPES[this.params.shape].round); }
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
export class World {
  constructor(THREE_, opts = {}) {
    this.THREE = THREE_;
    this.lod = opts.lod === undefined ? 3 : opts.lod;
    this.factory = new PrimMeshFactory(THREE_);
    this.group = new THREE.Group();
    this.group.name = "world";
    this.objects = [];
    this.defaultMaterial = new THREE_.MeshStandardMaterial({
      color: 0xb9c2cf, roughness: 0.62, metalness: 0.05, envMapIntensity: ENV_INTENSITY,
    });
    // Superficie con grano: el "blank texture" de SL no es un color plano, tiene
    // materia. Se inyecta en el shader y se muestrea por UV de cara del prim.
    applyPrimDetail(this.defaultMaterial);
    this.selectedMaterial = new THREE_.MeshStandardMaterial({
      color: 0xffd479, roughness: 0.5, metalness: 0.05, emissive: 0x2a1e00, envMapIntensity: ENV_INTENSITY,
    });
    this._tmpMat = new THREE_.Matrix4();
    this._tmpVec = new THREE_.Vector3();
    this._tmpBox = new THREE_.Box3();
    // Material por cara: cache por "spec" (asi 500 caras iguales comparten un
    // unico material) y cache de texturas por clave (receta o URL).
    this.faceMats = new Map();
    this.texByKey = new Map();
    this.texLoading = new Set();
    // Texturas que sirve la region (S.ASSET) por uuid, en vez de una URL. Se
    // piden bajo demanda cuando una cara las necesita (`onAssetNeeded`) y se
    // guardan aqui ya convertidas en `THREE.Texture` (`setAssetTexture`).
    this.assetTex = new Map();
    this.assetWanted = new Set();
    this.onAssetNeeded = null;
    this.onTextureLoaded = null;
  }

  add(params, o = {}) {
    // El nombre por defecto sale de la posicion en la lista, no del id: en una
    // region compartida los ids vienen de tramos grandes y "Prim 100000" queda
    // raro en el panel.
    if (!o.name) o.name = "Prim " + (this.objects.length + 1);
    const obj = new SlPrim(params, o);
    this.objects.push(obj);
    this.updateObject(obj);
    this.group.add(obj.group);
    if (this.onChange) this.onChange(obj, "add");
    return obj;
  }

  remove(obj) {
    // Un link set se borra entero (la raiz manda); un hijo suelto se quita del
    // conjunto y conserva su transformada de mundo.
    if (obj.links && obj.links.length) {
      for (const c of obj.links.slice()) this.remove(c);
    }
    if (obj.linkRoot) {
      const lr = obj.linkRoot;
      const i = lr.links.indexOf(obj);
      if (i >= 0) lr.links.splice(i, 1);
      obj.linkRoot = null;
      obj.local = null;
    }
    const i = this.objects.indexOf(obj);
    if (i < 0) return;
    this.objects.splice(i, 1);
    this.group.remove(obj.group);
    if (obj.mesh) {
      obj.mesh.material = this.defaultMaterial;
      this.factory.release(obj.volParams, this.lod);
    }
    for (const m of (obj.baseMaterials || [])) {
      if (m !== this.defaultMaterial && m !== this.selectedMaterial) m.dispose();
    }
    obj.baseMaterials = null;
    obj.faces = null;
    if (this.onChange) this.onChange(obj, "remove");
  }

  // Color propio de un objeto: se clonan los materiales para no teñir los de
  // los demas prims (el material por defecto es compartido a proposito). El
  // color del prim es el "color de todas las caras" que no tengan color propio.
  setColor(obj, hex) {
    obj.colorHex = hex === undefined ? null : hex;
    const n = Math.max(1, obj.volume ? obj.volume.faces.length : 1);
    this.buildBaseMaterials(obj, n);
    if (obj.mesh) this.applyFaceMaterials(obj);
    return obj;
  }

  // Materiales "base" (una cara sin apariencia propia): o el compartido, o uno
  // teñido propio del objeto. Se cachean en el objeto para poder liberarlos.
  buildBaseMaterials(obj, n) {
    const old = obj.baseMaterials;
    if (old && obj._baseColor === (obj.colorHex === undefined ? null : obj.colorHex) && old.length === n) return old;
    if (old) {
      for (const m of old) {
        if (m !== this.defaultMaterial && m !== this.selectedMaterial) m.dispose();
      }
    }
    let base;
    if (obj.colorHex === undefined || obj.colorHex === null) {
      base = new Array(n).fill(this.defaultMaterial);
    } else {
      const m = new this.THREE.MeshStandardMaterial({ color: obj.colorHex, roughness: 0.62, metalness: 0.05, envMapIntensity: ENV_INTENSITY });
      applyPrimDetail(m);
      m.userData.colorHex = obj.colorHex;
      base = new Array(n).fill(m);
    }
    obj.baseMaterials = base;
    obj._baseColor = obj.colorHex === undefined ? null : obj.colorHex;
    return base;
  }

  // --- apariencia por cara ---------------------------------------------------

  // Textura de un registro `{k}` / `{u}` / `{d}`. Las de URL se cargan en
  // segundo plano: mientras llegan se devuelve el registro vacio (la cara se
  // pinta con el material base) y al terminar se reconstruyen los materiales.
  resolveTexture(def) {
    if (!def) return null;
    if (def.k) {
      const p = patternTexture(def.k);
      // Las recetas son de `textures.js`: ese modulo es el dueno y las cachea,
      // aqui solo se toman prestadas (por eso `owned: false`).
      return p ? { map: p.map, normal: p.normalMap, alpha: p.alpha, key: "p:" + def.k, owned: false } : null;
    }
    // Textura de la region: se pide al retransmisor y se resuelve cuando llegue.
    if (def.a) {
      const key = "a:" + def.a;
      let e = this.assetTex.get(key);
      if (e) return e;
      e = { map: null, normal: null, alpha: true, loading: true, key, owned: false, asset: def.a };
      this.assetTex.set(key, e);
      if (!this.assetWanted.has(def.a)) {
        this.assetWanted.add(def.a);
        if (this.onAssetNeeded) this.onAssetNeeded(def.a);
      }
      return e;
    }
    const url = def.u || def.d;
    if (!url) return null;
    const key = def.id ? "t:" + def.id : "u:" + url;
    let e = this.texByKey.get(key);
    if (e) return e;
    e = { map: null, normal: null, alpha: true, loading: true, key, owned: true };
    this.texByKey.set(key, e);
    this.texLoading.add(key);
    textureFromUrl(url, (t) => {
      e.map = t; e.loading = false;
      this.texLoading.delete(key);
      this.refreshFaceMaterials();
    }, () => {
      e.error = true; e.loading = false;
      this.texLoading.delete(key);
      if (this.onTextureError) this.onTextureError(def, e);
      this.refreshFaceMaterials();
    });
    return e;
  }

  // La region ha servido una textura (S.ASSET). Se guarda en la cache y se
  // rehacen los materiales: las caras que la pedian ya se pintan con ella.
  setAssetTexture(id, texture) {
    const key = "a:" + id;
    let e = this.assetTex.get(key);
    if (!e) {
      e = { map: null, normal: null, alpha: true, key, owned: false, asset: id };
      this.assetTex.set(key, e);
    }
    e.map = texture || null;
    e.loading = false;
    e.error = texture ? null : "sin textura";
    this.refreshFaceMaterials();
    if (this.onTextureLoaded) this.onTextureLoaded(e);
    return e;
  }

  // La textura que ya llego por `setAssetTexture` (o null). La usan los avatares
  // para resolver los "bakes" del BoM, que llegan como uuid.
  getAssetTexture(id) {
    const e = this.assetTex.get("a:" + id);
    return (e && e.map) ? e.map : null;
  }

  // Material de una cara concreta (cacheado por spec).
  faceMaterial(obj, i, f) {
    const spec = faceSpec(obj, i, f);
    const key = faceSpecKey(spec);
    let m = this.faceMats.get(key);
    if (m) {
      // Toque LRU: el ultimo usado se va al final del Map.
      this.faceMats.delete(key);
      this.faceMats.set(key, m);
      return m;
    }
    const T = this.THREE;
    m = new T.MeshStandardMaterial({
      color: spec.color, roughness: spec.rough, metalness: spec.metal,
      side: spec.doubleSide ? T.DoubleSide : T.FrontSide,
      envMapIntensity: ENV_INTENSITY,
    });
    const tex = this.resolveTexture(spec.tex);
    if (tex && tex.map) {
      const map = tex.map.clone();
      map.wrapS = map.wrapT = T.RepeatWrapping;
      map.repeat.set(spec.repeat[0], spec.repeat[1]);
      map.offset.set(spec.offset[0], spec.offset[1]);
      map.center.set(0.5, 0.5);
      map.rotation = spec.rotation;
      map.anisotropy = tex.map.anisotropy;
      map.colorSpace = T.SRGBColorSpace;
      map.needsUpdate = true;
      m.map = map;
      if (tex.normal) {
        const nm = tex.normal.clone();
        nm.wrapS = nm.wrapT = T.RepeatWrapping;
        nm.repeat.copy(map.repeat);
        nm.offset.copy(map.offset);
        nm.center.copy(map.center);
        nm.rotation = map.rotation;
        nm.needsUpdate = true;
        m.normalMap = nm;
        m.normalScale.set(0.85, 0.85);
      }
    } else if (!tex || !tex.loading) {
      // Sin textura (o textura que fallo): grano por defecto, como el "blank".
      applyPrimDetail(m, spec.tex ? { relief: 0.25 } : {});
      if (tex && tex.error) m.color.setHex(spec.color);
    } else {
      // Textura de URL aun cargando: se ve el color plano.
      applyPrimDetail(m, { relief: 0.25 });
    }
    // Brillo (glow) y "fullbright" de SL: emision con el mapa como emisivo.
    if (spec.fullbright) {
      m.color.setHex(0x000000);
      if (m.map) m.emissiveMap = m.map;
      m.emissive.setHex(spec.color);
      m.emissiveIntensity = 1;
    } else if (spec.glow > 0) {
      if (m.map) m.emissiveMap = m.map;
      m.emissive.setHex(spec.color);
      m.emissiveIntensity = spec.glow;
    }
    // Transparencia: mezcla normal, o recorte si se pide "mask".
    if (spec.mask) {
      m.alphaTest = 0.5;
    } else if (spec.alpha < 0.999) {
      m.transparent = true;
      m.opacity = spec.alpha;
      m.depthWrite = false;
    }
    this.faceMats.set(key, m);
    if (this.faceMats.size > 480) this.pruneFaceMaterials();
    return m;
  }

  // Un slider (rugosidad, transparencia...) genera un material nuevo por cada
  // valor, asi que la cache tiene tope: se tiran los materiales mas viejos que
  // ya no usa ningun objeto (los que se estan viendo nunca se tocan).
  pruneFaceMaterials(target = 320) {
    const used = new Set();
    for (const o of this.objects) {
      if (!o.materials) continue;
      for (const m of o.materials) used.add(m);
    }
    for (const [k, m] of [...this.faceMats]) {
      if (this.faceMats.size <= target) break;
      if (used.has(m)) continue;
      this.faceMats.delete(k);
      m.dispose();
    }
  }

  // Reparte los materiales de todas las caras de un objeto.
  applyFaceMaterials(obj) {
    if (!obj.mesh) return;
    const n = Math.max(1, obj.volume ? obj.volume.faces.length : 1);
    const base = this.buildBaseMaterials(obj, n);
    const faces = obj.faces;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const f = faces ? faces[i] : null;
      out[i] = f && !faceIsDefault(f) ? this.faceMaterial(obj, i, f) : (base[i] || base[0] || this.defaultMaterial);
    }
    obj.materials = out;
    obj.mesh.material = out.length === 1 ? out[0] : out;
  }

  // Cambia campos de la apariencia de una o varias caras. `patch` es parcial;
  // `repeat`/`offset` se pasan como arrays [u, v].
  setFace(obj, indices, patch) {
    const n = Math.max(1, obj.volume ? obj.volume.faces.length : 1);
    if (!obj.faces || obj.faces.length !== n) {
      obj.faces = facesFromJson(null, n);
    }
    const list = Array.isArray(indices) ? indices : [indices];
    for (const i of list) {
      if (i < 0 || i >= n) continue;
      Object.assign(obj.faces[i], patch);
    }
    this.applyFaceMaterials(obj);
    if (this.onChange) this.onChange(obj, "faces");
    return obj;
  }

  // Aplica a TODAS las caras (el boton "a todas las caras" del panel).
  setFaceAll(obj, patch) {
    const n = Math.max(1, obj.volume ? obj.volume.faces.length : 1);
    const all = [];
    for (let i = 0; i < n; i++) all.push(i);
    return this.setFace(obj, all, patch);
  }

  // Reconstruye todos los materiales por cara (cuando una textura de URL
  // termina de cargar). Los materiales viejos se liberan solo si ya nadie los
  // usa, para no dejar texturas colgando.
  refreshFaceMaterials() {
    const old = [...this.faceMats.values()];
    this.faceMats.clear();
    for (const o of this.objects) {
      if (o.mesh) this.applyFaceMaterials(o);
    }
    const keep = new Set(this.faceMats.values());
    for (const m of old) if (!keep.has(m)) m.dispose();
  }

  // (Re)genera la geometria y los materiales por cara del objeto.
  updateObject(obj) {
    const vp = obj.params.toVolumeParams();
    const changed = !obj.volParams || obj.volParams.key(this.lod) !== vp.key(this.lod);
    obj.volParams = vp;
    if (!obj.mesh) {
      const geom = this.factory.get(vp, this.lod);
      obj.volume = this.factory.getVolume(vp, this.lod);
      const nFaces = obj.volume.faces.length;
      obj.faces = obj.faces && obj.faces.length === nFaces ? obj.faces : facesFromJson(null, nFaces);
      obj.baseMaterials = new Array(Math.max(1, nFaces)).fill(this.defaultMaterial);
      obj._baseColor = undefined;
      obj.materials = obj.baseMaterials.slice();
      const mesh = new this.THREE.Mesh(geom, obj.materials.length === 1 ? obj.materials[0] : obj.materials);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.slPrim = obj;
      obj.mesh = mesh;
      obj.group.add(mesh);
    } else if (changed) {
      const geom = this.factory.get(vp, this.lod);
      obj.mesh.geometry = geom;
      obj.volume = this.factory.getVolume(vp, this.lod);
      const nFaces = obj.volume.faces.length;
      obj.faces = obj.faces && obj.faces.length === nFaces ? obj.faces : facesFromJson(null, nFaces);
      this.buildBaseMaterials(obj, nFaces);
    }
    this.applyFaceMaterials(obj);
    obj.localBox = geometryBBox(obj.volume);
    const lb = obj.localBox;
    obj.boundRadius = 0.5 * Math.hypot(lb.max[0] - lb.min[0], lb.max[1] - lb.min[1], lb.max[2] - lb.min[2])
      * Math.max(Math.abs(obj.scale.x), Math.abs(obj.scale.y), Math.abs(obj.scale.z));
    obj.sync();
    // Si es la raiz de un link set, sus hijos se recolocan con ella.
    if (obj.links && obj.links.length) this.applyLinkRoot(obj);
    if (this.onChange) this.onChange(obj, "update");
    return obj;
  }

  faceInfo(obj) { return obj.volume ? faceInfo(obj.volume) : []; }

  // Caja envolvente en coordenadas de mundo (para colisiones y encuadres).
  worldBox(obj, target) {
    const b = obj.localBox || { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
    const box = target || new this.THREE.Box3();
    box.makeEmpty();
    const p = this._tmpVec;
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]);
      p.multiply(obj.scale).applyQuaternion(obj.quaternion).add(obj.position);
      box.expandByPoint(p);
    }
    return box;
  }

  // --- link sets -------------------------------------------------------------
  //
  // En SL un link set es un prim raiz con hijos, y transformar la raiz mueve
  // todo el conjunto. Aqui NO se cuelgan los grupos de three.js unos de otros:
  // eso dejaria `obj.position` como una transformada local y romperia el
  // raycast, las colisiones del avatar y las cajas envolventes, que leen
  // coordenadas de MUNDO. En su lugar cada hijo guarda su matriz relativa a la
  // raiz (`obj.local`) y, cuando la raiz se mueve, se recalcula la transformada
  // de mundo de cada hijo. Todo el resto del visor sigue igual.

  matrixOf(obj, target) {
    return (target || new this.THREE.Matrix4()).compose(obj.position, obj.quaternion, obj.scale);
  }

  // La raiz del link set al que pertenece `obj` (o null si no esta en ninguno).
  linkRootFor(obj) {
    if (!obj) return null;
    if (obj.linkRoot) return obj.linkRoot;
    return (obj.links && obj.links.length) ? obj : null;
  }

  // Todos los prims del link set al que pertenece `obj`, empezando por la raiz.
  linkSetOf(obj) {
    const r = this.linkRootFor(obj);
    if (!r) return obj ? [obj] : [];
    return [r].concat(r.links);
  }

  isRoot(obj) { return !!(obj && obj.links && obj.links.length); }

  // Enlaza `prims` con `root` como raiz (si no se dice, el ultimo seleccionado,
  // como hace SL). Los hijos guardan su transformada relativa en ese momento.
  link(prims, root) {
    const list = (prims || []).slice();
    const r = root || list[list.length - 1];
    if (!r || list.length < 2) return null;
    const inside = (o) => list.indexOf(o) >= 0;
    // Cada prim que estuviera en un conjunto que NO entra entero en la nueva
    // lista se suelta antes (asi nadie se queda con hijos huerfanos).
    for (const p of list) {
      const lr = this.linkRootFor(p);
      if (lr && !inside(lr)) this.unlink(lr);
    }
    if (r.links) for (const c of r.links.slice()) { if (!inside(c)) { c.linkRoot = null; c.local = null; } }
    r.linkRoot = null;
    r.links = [];
    const inv = this.matrixOf(r, new this.THREE.Matrix4()).invert();
    for (const p of list) {
      if (p === r) continue;
      p.linkRoot = r;
      p.local = new this.THREE.Matrix4().multiplyMatrices(inv, this.matrixOf(p));
      r.links.push(p);
    }
    this.refreshLinkLocals(r);
    if (this.onChange) this.onChange(r, "link");
    return r;
  }

  // Suelta el conjunto: los hijos conservan su transformada de mundo.
  unlink(root) {
    const r = this.linkRootFor(root);
    if (!r) return null;
    const members = [r].concat(r.links || []);
    for (const c of (r.links || [])) { c.linkRoot = null; c.local = null; }
    r.links = null;
    r.linkRoot = null;
    if (this.onChange) this.onChange(r, "unlink");
    return members;
  }

  // Recoloca a los hijos a partir de la raiz (tras mover/rotar/escalar la raiz).
  applyLinkRoot(root) {
    const r = root;
    if (!r || !r.links || !r.links.length) return;
    const rm = this.matrixOf(r, this._linkM || (this._linkM = new this.THREE.Matrix4()));
    const m = this._linkM2 || (this._linkM2 = new this.THREE.Matrix4());
    for (const c of r.links) {
      if (!c.local) c.local = new this.THREE.Matrix4().multiplyMatrices(this.matrixOf(r, new this.THREE.Matrix4()).invert(), this.matrixOf(c));
      m.multiplyMatrices(rm, c.local);
      m.decompose(c.position, c.quaternion, c.scale);
      c.sync();
    }
  }

  // Recalcula las matrices locales a partir de las transformadas de mundo (se
  // usa cuando se han tocado los miembros a mano, p. ej. al estirar el conjunto).
  refreshLinkLocals(root) {
    const r = this.linkRootFor(root);
    if (!r || !r.links) return;
    const inv = this.matrixOf(r, new this.THREE.Matrix4()).invert();
    for (const c of r.links) {
      c.linkRoot = r;
      c.local = new this.THREE.Matrix4().multiplyMatrices(inv, this.matrixOf(c));
    }
  }

  // Caja envolvente de un conjunto entero (un solo prim tambien vale).
  setBox(obj, target) {
    const set = this.linkSetOf(obj);
    const box = target || new this.THREE.Box3();
    box.makeEmpty();
    const tmp = new this.THREE.Box3();
    for (const m of set) box.union(this.worldBox(m, tmp));
    return box;
  }

  // Matriz mundo->local de un prim (para resolver colisiones en su espacio).
  localMatrix(obj, target) {
    const m = target || new this.THREE.Matrix4();
    const inv = new this.THREE.Matrix4().compose(obj.position, obj.quaternion, obj.scale).invert();
    return m.copy(inv);
  }

  raycast(raycaster) {
    const hits = raycaster.intersectObjects(this.group.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.slPrim) o = o.parent;
      if (o) { h.prim = o.userData.slPrim; return h; }
    }
    return null;
  }

  // Vecinos cuyo volumen (no solo su centro) puede estar dentro de `radius` de
  // `position`: se suma el radio envolvente de cada prim, si no un embarcadero
  // de 26 m de largo se quedaria fuera y el avatar lo atravesaria.
  near(position, radius, out = []) {
    out.length = 0;
    for (const obj of this.objects) {
      if (!obj.build || obj.phantom) continue;
      const dx = obj.position.x - position.x;
      const dy = obj.position.y - position.y;
      const dz = obj.position.z - position.z;
      const reach = radius + (obj.boundRadius || 1);
      if (dx * dx + dy * dy + dz * dz <= reach * reach) out.push(obj);
    }
    return out;
  }

  findById(id) {
    for (const o of this.objects) if (o.id === id) return o;
    return null;
  }

  // Reserva un tramo de ids para este cliente (en multijugador cada cliente
  // crea sus prims en su propio tramo, asi no hay dos prims con el mismo id).
  reserveIds(base) {
    if (base > nextId) nextId = base;
    return nextId;
  }

  // Crea un prim a partir de un registro serializado (el mismo formato que
  // exporta `serialize`) sin borrar el resto del mundo.
  recordToPrim(rec) {
    const p = new PrimParams(rec.shape);
    Object.assign(p, rec.params || {});
    const obj = this.add(p, {
      id: rec.id, name: rec.name,
      position: new this.THREE.Vector3().fromArray(rec.position),
      quaternion: new this.THREE.Quaternion().fromArray(rec.quaternion),
      scale: new this.THREE.Vector3().fromArray(rec.scale),
      build: rec.build !== false,
      phantom: !!rec.phantom,
    });
    // El color no es una propiedad de la forma: es un material propio del
    // objeto, asi que se aplica despues de crearlo.
    if (rec.color !== null && rec.color !== undefined) this.setColor(obj, rec.color);
    if (rec.script) obj.script = rec.script;
    if (rec.desc) obj.desc = rec.desc;
    obj.owner = rec.owner === undefined ? null : rec.owner;
    if (rec.faces && rec.faces.length) {
      const n = Math.max(1, obj.volume ? obj.volume.faces.length : 1);
      obj.faces = facesFromJson(rec.faces, n);
      this.applyFaceMaterials(obj);
    }
    return obj;
  }

  // Enlaza un prim con su raiz (segunda pasada: la raiz tiene que existir ya).
  linkRecord(obj, rec) {
    if (!rec || !rec.parent) return obj;
    const root = this.findById(rec.parent);
    if (!root) return obj;
    obj.linkRoot = root;
    obj.local = rec.local && rec.local.length === 16
      ? new this.THREE.Matrix4().fromArray(rec.local)
      : this.matrixOf(root, new this.THREE.Matrix4()).invert().multiply(this.matrixOf(obj));
    if (!root.links) root.links = [];
    if (root.links.indexOf(obj) < 0) root.links.push(obj);
    return obj;
  }

  // Cambia in situ un prim que ya existe (una edicion de otro cliente).
  updateFromRecord(obj, rec) {
    obj.name = rec.name || obj.name;
    obj.params.setShape(rec.shape);
    for (const k of Object.keys(rec.params || {})) {
      if (k === "shape") continue;
      const v = rec.params[k];
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(obj.params[k], v);
      else obj.params[k] = v;
    }
    obj.position.fromArray(rec.position);
    obj.quaternion.fromArray(rec.quaternion);
    obj.scale.fromArray(rec.scale);
    obj.build = rec.build !== false;
    obj.phantom = !!rec.phantom;
    const color = rec.color === undefined ? null : rec.color;
    this.setColor(obj, color);
    obj.script = rec.script || null;
    obj.desc = rec.desc || null;
    if (rec.owner !== undefined) obj.owner = rec.owner;
    this.updateObject(obj);
    const n = Math.max(1, obj.volume ? obj.volume.faces.length : 1);
    obj.faces = rec.faces && rec.faces.length ? facesFromJson(rec.faces, n) : facesFromJson(null, n);
    this.applyFaceMaterials(obj);
    this.applyLinkRoot && this.applyLinkRoot(obj);
    return obj;
  }

  // Aplica la edicion de otro cliente: crea, actualiza o borra por id.
  applyRemote(rec, op) {
    if (!rec && op !== "remove") return null;
    if (op === "remove") return this.removeRemote(typeof rec === "object" ? rec.id : rec);
    const existing = this.findById(rec.id);
    if (existing) return this.updateFromRecord(existing, rec);
    const obj = this.recordToPrim(rec);
    if (obj.id >= nextId) nextId = obj.id + 1;
    this.linkRecord(obj, rec);
    return obj;
  }

  removeRemote(id) {
    const obj = id && id.id !== undefined ? this.findById(id.id) : this.findById(id);
    if (!obj) return null;
    this.remove(obj);
    return obj;
  }

  // Registro serializable de un prim. Es tambien el formato que viaja por la
  // red en multijugador (src/net.js lo manda tal cual), asi que hay un unico
  // sitio donde se decide que campos definen un prim.
  recordOf(o) {
    return {
      id: o.id, name: o.name, shape: o.params.shape,
      params: Object.assign({}, o.params),
      position: o.position.toArray(),
      quaternion: o.quaternion.toArray(),
      scale: o.scale.toArray(),
      color: o.colorHex === undefined ? null : o.colorHex,
      faces: facesToJson(o.faces),
      // El script del prim (contenido, como en SL) viaja con la region.
      script: o.script || null,
      desc: o.desc || null,
      build: o.build !== false,
      phantom: !!o.phantom,
      // Quien es el dueño (id de jugador). Solo el dueño difunde por la red lo
      // que dicen los scripts de sus prims, para que no hable cada cliente.
      owner: o.owner === undefined ? null : o.owner,
      parent: o.linkRoot ? o.linkRoot.id : null,
      local: o.local ? o.local.toArray() : null,
    };
  }

  serialize() {
    return {
      objects: this.objects.map((o) => this.recordOf(o)),
      nextId,
    };
  }

  deserialize(data) {
    this.clear();
    if (data && data.nextId) nextId = Math.max(nextId, data.nextId);
    for (const o of (data && data.objects) || []) this.recordToPrim(o);
    // Los link sets se rehacen despues de crear todos los prims (y sin tocar las
    // transformadas: ya vienen en coordenadas de mundo).
    for (const rec of (data && data.objects) || []) {
      const child = this.findById(rec.id);
      if (child) this.linkRecord(child, rec);
    }
    return this;
  }

  clear() {
    for (const o of this.objects.slice()) this.remove(o);
    return this;
  }

  dispose() {
    this.clear();
    this.factory.dispose();
    for (const m of this.faceMats.values()) m.dispose();
    this.faceMats.clear();
    for (const e of this.texByKey.values()) {
      if (!e.owned) continue;
      if (e.map) e.map.dispose();
      if (e.normal) e.normal.dispose();
    }
    this.texByKey.clear();
    this.texLoading.clear();
    // Las texturas de la region las crea y libera la sesion (`src/sl/session.js`),
    // que es su dueña: aqui solo se sueltan las referencias.
    this.assetTex.clear();
    this.assetWanted.clear();
    this.defaultMaterial.dispose();
    this.selectedMaterial.dispose();
  }
}
