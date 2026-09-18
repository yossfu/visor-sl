// build.js -- las herramientas de construccion: el "build floater" de SL.
//
// Que incluye esta fase:
//   - Seleccion por clic (raycast) con resaltado del prim y de la cara bajo el
//     cursor, y lista de caras del prim seleccionado.
//   - Gizmos de mover / rotar / escalar con rejilla de 0.5 m y saltos de 45
//     grados (se pueden desactivar).
//   - Panel de parametros en vivo: los mismos campos del floater de SL
//     (cortes, hueco, twist, taper, shear, slope, skew, vueltas) mas tamano,
//     posicion, color y forma.
//   - Crear / duplicar / borrar / bajar al suelo, con deshacer y rehacer.
//
// El estado del mundo se guarda en `world.serialize()`; deshacer/rehacer son
// fotogramas de ese JSON (con 60 prims son unos pocos KB: es mucho mas robusto
// que invertir cada operacion, y ademas cubre las ediciones del panel, que
// cambian la geometria igual que un movimiento).
//
// Los gizmos usan TransformControls de three.js: es la parte del editor que mas
// se equivoca si se escribe a mano (planos de arrastre, orden de ejes, captura
// de puntero) y ya trae el snapping. Aqui solo se conecta con el mundo.

import * as THREE from "./three.js";
import { TransformControls } from "./three.js";
import { PrimParams, SHAPES, SHAPE_ORDER, HOLE_SHAPES } from "./prims.js";
import { faceInfo, faceToGeometry } from "./primMesh.js";
import { primToItem, itemToAdd, regionToJson, parseRegionJson } from "./store.js";
import { facesFromJson } from "./faces.js";
import { createTerrainTools } from "./terrainTools.js";
import { createAppearance } from "./appearance.js";
import { createScriptPanel } from "./lslPanel.js";

const SELECT_COLOR = 0xffcf5c;
const SEL_FACE_COLOR = 0xffa838;
const HOVER_COLOR = 0x5ad1ff;

const SNAP_MOVE = 0.5;
const SNAP_ROT = Math.PI / 4;
const SNAP_SCALE = 0.125;
const SIZE_MIN = 0.05;
const SIZE_MAX = 64;
const CLICK_SLOP = 6;            // px de arrastre que aun cuentan como clic
const HISTORY_MAX = 60;

// Campos del floater: un unico sitio del que salen los deslizadores del panel.
// `group` coincide con las claves de `PrimParams.visibleGroups()`.
const FIELDS = [
  { group: "cut", key: "pathCutBegin", label: "Corte camino inicial", min: 0, max: 0.98, step: 0.01, dec: 2 },
  { group: "cut", key: "pathCutEnd", label: "Corte camino final", min: 0.02, max: 1, step: 0.01, dec: 2 },
  { group: "cut", key: "profileCutBegin", label: "Corte perfil inicial", min: 0, max: 0.98, step: 0.01, dec: 2 },
  { group: "cut", key: "profileCutEnd", label: "Corte perfil final", min: 0.02, max: 1, step: 0.01, dec: 2 },
  { group: "hollow", key: "hollow", label: "Hueco", min: 0, max: 0.95, step: 0.01, dec: 2 },
  { group: "twist", key: "twistBegin", label: "Twist inicial", min: -360, max: 360, step: 5, dec: 0, unit: "°" },
  { group: "twist", key: "twistEnd", label: "Twist final", min: -360, max: 360, step: 5, dec: 0, unit: "°" },
  { group: "taper", key: "taperX", label: "Taper X", min: -1, max: 1, step: 0.02, dec: 2 },
  { group: "taper", key: "taperY", label: "Taper Y", min: -1, max: 1, step: 0.02, dec: 2 },
  { group: "holes", key: "holeX", label: "Tamaño hueco X", min: 0.05, max: 1, step: 0.01, dec: 2 },
  { group: "holes", key: "holeY", label: "Tamaño hueco Y", min: 0.05, max: 0.5, step: 0.01, dec: 2 },
  { group: "shear", key: "shearX", label: "Shear X", min: -1, max: 1, step: 0.02, dec: 2 },
  { group: "shear", key: "shearY", label: "Shear Y", min: -1, max: 1, step: 0.02, dec: 2 },
  { group: "slope", key: "slope", label: "Inclinación", min: -1, max: 1, step: 0.02, dec: 2 },
  { group: "skew", key: "skew", label: "Skew", min: -1, max: 1, step: 0.02, dec: 2 },
  { group: "revolution", key: "revolution", label: "Vueltas", min: 1, max: 4, step: 1, dec: 0 },
];

const GROUP_TITLES = {
  cut: "Cortes", hollow: "Hueco", twist: "Twist", taper: "Taper",
  holes: "Tamaño del hueco", shear: "Shear", slope: "Inclinación / slope",
  skew: "Skew", revolution: "Vueltas (revolutions)",
};

const PALETTE = [
  0xb9c2cf, 0xf2f2f2, 0x2b2f36, 0xcfc3ae, 0x8a7258, 0x6b4f36,
  0xc2554a, 0xd8724a, 0xe0b44a, 0x7fae6a, 0x4f8f7a, 0x5f8fbf,
  0x6f6fbf, 0x9a6fb0, 0xb06f8f, 0x3f6b3a,
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function createBuildTools(opts = {}) {
  const viewer = opts.viewer;
  const T = THREE;
  const world = viewer.world;
  const scene = viewer.scene;
  const camera = viewer.camera;
  const canvas = viewer.canvas;
  const terrain = viewer.terrain;
  const terrainMesh = viewer.terrainMesh;
  const cam = viewer.cam;
  const avatar = viewer.avatar;
  const store = opts.store || null;
  // Acceso al multijugador (src/net.js), que se crea despues de las
  // herramientas: el panel de region necesita poder preguntar su estado.
  const net = opts.net || (() => null);

  const els = {
    root: document.getElementById("buildCtn"),
    tools: document.getElementById("buildToolsEl"),
    params: document.getElementById("buildParamsEl"),
    faces: document.getElementById("buildFacesEl"),
    terrain: document.getElementById("buildTerrainEl"),
    faceApp: document.getElementById("buildFaceAppEl"),
    script: document.getElementById("buildScriptEl"),
    inv: document.getElementById("buildInvEl"),
    region: document.getElementById("buildRegionEl"),
    msg: document.getElementById("buildMsgEl"),
    status: document.getElementById("buildStatusEl"),
    toggle: document.getElementById("buildToggleBtn"),
    chat: document.getElementById("chatCtn"),
  };

  const state = {
    active: false,
    mode: "translate",     // select | translate | rotate | scale | create
    space: "world",
    snap: true,
    shape: "box",
    selection: null,
    extra: [],             // el resto de la seleccion multiple
    multi: false,          // modo "añadir a la seleccion" (para el tactil)
    faceIndex: null,
    hover: null,
    history: 0,
    // Contador de ediciones que NO baja al deshacer: sirve para saber si el
    // usuario ya ha tocado el mundo (y entonces no cargarle el autoguardado).
    rev: 0,
    // Que secciones del panel estan plegadas (en el telefono, "Caras" empieza
    // plegada: el panel entero no cabe de otra forma).
    folded: null,
  };

  // --- resaltados del editor ------------------------------------------------
  const flatMat = (color, opacity) => new T.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false,
    side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const hoverMesh = new T.Mesh(new T.BufferGeometry(), flatMat(HOVER_COLOR, 0.42));
  const selFaceMesh = new T.Mesh(new T.BufferGeometry(), flatMat(SEL_FACE_COLOR, 0.55));
  for (const m of [hoverMesh, selFaceMesh]) {
    m.matrixAutoUpdate = false;
    m.renderOrder = 4;
    m.frustumCulled = false;
    m.visible = false;
    m.raycast = () => {};
    scene.add(m);
  }
  const selBox = new T.Box3Helper(new T.Box3(), SELECT_COLOR);
  selBox.material.depthTest = false;     // el marco se ve a traves de los prims, como en SL
  selBox.material.transparent = true;
  selBox.renderOrder = 6;
  selBox.visible = false;
  scene.add(selBox);

  function placeFaceMesh(mesh, prim, faceIndex) {
    if (!prim || faceIndex === null || faceIndex === undefined || !prim.volume) {
      mesh.visible = false;
      return;
    }
    const key = prim.volParams.key(world.lod) + "#" + faceIndex;
    if (mesh.userData.key !== key) {
      const g = faceToGeometry(prim.volume, faceIndex, T);
      if (!g) { mesh.visible = false; return; }
      if (mesh.geometry) mesh.geometry.dispose();
      mesh.geometry = g;
      mesh.userData.key = key;
    }
    prim.group.updateMatrixWorld(true);
    mesh.matrix.copy(prim.group.matrixWorld);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.visible = true;
  }

  // --- gizmo ----------------------------------------------------------------
  const gizmo = new TransformControls(camera, canvas);
  const gizmoObj = gizmo.isObject3D ? gizmo : (gizmo.getHelper ? gizmo.getHelper() : gizmo);
  gizmo.size = 0.9;
  gizmo.enabled = false;
  gizmoObj.visible = false;
  if (gizmoObj !== gizmo) scene.add(gizmoObj); else scene.add(gizmo);

  gizmo.addEventListener("dragging-changed", (e) => {
    cam.locked = !!e.value;
    if (e.value) {
      beginTx();
      // Base del arrastre: la transformada del prim activo y la de los demas
      // seleccionados, para poder aplicarles el mismo desplazamiento (los hijos
      // del link set no, que ya siguen a la raiz solos).
      dragBase = {
        o: state.selection,
        pos: state.selection.position.clone(),
        quat: state.selection.quaternion.clone(),
        scale: state.selection.scale.clone(),
        others: state.extra.filter((m) => world.linkRootFor(m) !== state.selection).map((m) => ({
          o: m, pos: m.position.clone(), quat: m.quaternion.clone(), scale: m.scale.clone(),
        })),
      };
    } else {
      dragBase = null;
      commitTx(state.mode === "rotate" ? (state.extra.length ? "Rotar conjunto" : "Rotar")
        : (state.mode === "scale" ? (state.extra.length ? "Escalar conjunto" : "Escalar")
          : (state.extra.length ? "Mover conjunto" : "Mover")));
    }
  });
  let dragBase = null;

  // Mueve/rota/escala los demas prims seleccionados con el mismo delta que el
  // activo (el gizmo solo arrastra a uno: los demas se calculan de aqui).
  function applyDragToOthers() {
    if (!dragBase || !dragBase.others.length) return;
    const o = dragBase.o;
    const dPos = new T.Vector3().subVectors(o.position, dragBase.pos);
    const dQuat = new T.Quaternion().copy(o.quaternion).multiply(new T.Quaternion().copy(dragBase.quat).invert());
    const dScale = new T.Vector3(
      dragBase.scale.x ? o.scale.x / dragBase.scale.x : 1,
      dragBase.scale.y ? o.scale.y / dragBase.scale.y : 1,
      dragBase.scale.z ? o.scale.z / dragBase.scale.z : 1,
    );
    const v = new T.Vector3();
    for (const rec of dragBase.others) {
      const m = rec.o;
      v.copy(rec.pos).sub(dragBase.pos).applyQuaternion(dQuat).add(o.position);
      m.position.copy(v);
      m.quaternion.copy(dQuat).multiply(rec.quat);
      m.scale.set(rec.scale.x * dScale.x, rec.scale.y * dScale.y, rec.scale.z * dScale.z);
      world.updateObject(m);
    }
  }

  gizmo.addEventListener("objectChange", () => {
    const o = state.selection;
    if (!o) return;
    o.position.copy(o.group.position);
    o.quaternion.copy(o.group.quaternion);
    o.scale.copy(o.group.scale);
    if (state.mode === "scale") {
      // TransformControls no impide cruzar el cero: un tamano negativo deja el
      // prim del reves (y la fisica y el raycast se vuelven locos).
      o.scale.set(clamp(o.scale.x, SIZE_MIN, SIZE_MAX), clamp(o.scale.y, SIZE_MIN, SIZE_MAX), clamp(o.scale.z, SIZE_MIN, SIZE_MAX));
      o.group.scale.copy(o.scale);
    }
    world.updateObject(o);
    restoreColor(o);
    applyDragToOthers();
    refreshStatus();
  });

  function applySnap() {
    gizmo.setTranslationSnap(state.snap ? SNAP_MOVE : null);
    gizmo.setRotationSnap(state.snap ? SNAP_ROT : null);
    gizmo.setScaleSnap(state.snap ? SNAP_SCALE : null);
  }
  applySnap();

  function refreshGizmo() {
    const movable = state.active && state.selection &&
      (state.mode === "translate" || state.mode === "rotate" || state.mode === "scale");
    gizmo.enabled = !!movable;
    gizmoObj.visible = !!movable;
    if (movable) {
      if (gizmo.object !== state.selection.group) gizmo.attach(state.selection.group);
      gizmo.setMode(state.mode);
      gizmo.setSpace(state.mode === "rotate" ? state.space : state.space);
    } else {
      gizmo.detach();
    }
  }

  // --- historial ------------------------------------------------------------
  let undoStack = [];
  let redoStack = [];
  let txBefore = null;

  // Estado COMPLETO de la region para guardar (prims + capa de terreno). El
  // historial de prims no lo usa: meter 170 KB de terreno en cada fotograma de
  // deshacer multiplicaria la memoria por 60 sin necesidad (las ediciones de
  // terreno tienen sus propias entradas, con solo el trozo tocado).
  function regionState() {
    const d = world.serialize();
    const t = (terrain && terrain.encodeSculpt) ? terrain.encodeSculpt() : null;
    if (t) d.terrain = t;
    return d;
  }

  function snapshot() {
    return JSON.stringify({ w: world.serialize(), sel: state.selection ? state.selection.id : null, face: state.faceIndex });
  }
  function beginTx() { if (!txBefore) txBefore = snapshot(); }
  function commitTx(label) {
    if (!txBefore) return;
    const before = txBefore;
    txBefore = null;
    pushHistory(label, before);
  }
  function pushHistory(label, before) {
    const after = snapshot();
    if (after === before) return;
    pushEntry({ label, before, after });
  }
  // Cualquier entrada del historial: de prims (`before`/`after` son fotogramas
  // del mundo) o de terreno (`terrain` con el trozo tocado).
  function pushEntry(entry) {
    undoStack.push(entry);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
    state.history = undoStack.length;
    state.rev++;
    refreshStatus();
  }
  function restore(json) {
    const s = JSON.parse(json);
    world.deserialize(s.w);
    state.selection = s.sel === null || s.sel === undefined ? null : (world.objects.find((o) => o.id === s.sel) || null);
    // Los prims del fotograma son nuevos objetos: la seleccion multiple se
    // rehace desde el link set (si el prim activo es la raiz de uno).
    state.extra = state.selection && world.isRoot(state.selection) ? state.selection.links.slice() : [];
    state.faceIndex = state.selection ? clamp(s.face === null || s.face === undefined ? 0 : s.face, 0, state.selection.volume.faces.length - 1) : null;
    refreshSelection();
    renderParams();
    renderFaces();
    refreshStatus();
  }
  function undo() {
    const e = undoStack.pop();
    if (!e) return false;
    redoStack.push(e);
    state.history = undoStack.length;
    if (e.terrain) { terrainTools.applyEntry(e.terrain, "before"); refreshStatus(); return true; }
    restore(e.before);
    return true;
  }
  function redo() {
    const e = redoStack.pop();
    if (!e) return false;
    undoStack.push(e);
    state.history = undoStack.length;
    if (e.terrain) { terrainTools.applyEntry(e.terrain, "after"); refreshStatus(); return true; }
    restore(e.after);
    return true;
  }

  // --- terreno --------------------------------------------------------------
  // El pincel de esculpido vive en su propio modulo (`terrainTools.js`) porque no
  // comparte nada con la edicion de prims salvo el panel, el historial y los
  // eventos de puntero.
  const terrainTools = createTerrainTools({
    T, terrain, terrainMesh, water: viewer.water, camera, canvas, scene, cam,
    ui: { el, btn, panel },
    history: { pushTerrain: (label, rec) => pushEntry({ label, terrain: rec }) },
    toast: (m) => toast(m),
    onChange: () => refreshStatus(),
  });

  // --- apariencia por cara ---------------------------------------------------
  // La apariencia vive en `obj.faces[i]` (ver `faces.js`): aqui solo se le dice
  // que cara esta elegida y se le pide que se repinte cuando cambia algo.
  function targetFaceIndices() {
    if (state.faceIndex === null || state.faceIndex === undefined) return [];
    return [state.faceIndex];
  }
  const appearance = createAppearance({
    world,
    ui: { el, btn, panel, rootId: "buildFaceAppEl" },
    toast: (m) => toast(m),
    getTarget: () => ({ obj: state.selection, faces: targetFaceIndices() }),
    onChange: () => { refreshSelection(); renderFaces(); refreshStatus(); },
  });

  // --- scripts (mini-LSL) ---------------------------------------------------
  // El editor escribe en `prim.script` a traves del runtime (`src/lsl/`), que es
  // quien compila, arranca y mantiene las instancias. Aqui solo se le da el prim
  // elegido y se le pide que se repinte; el runtime reconcilia el mundo solo.
  const scriptPanel = createScriptPanel({
    scripts: opts.scripts,
    ui: { el, btn, panel, rootId: "buildScriptEl" },
    toast: (m) => toast(m),
    getPrim: () => state.selection,
    onChange: () => { refreshStatus(); },
  });

  // --- seleccion ------------------------------------------------------------
  const ray = new T.Raycaster();
  const ndc = new T.Vector2();

  function faceOfTriangle(prim, tri) {
    if (!prim || !prim.volume || tri === undefined || tri === null) return null;
    const fs = prim.volume.faces;
    for (let i = 0; i < fs.length; i++) if (tri >= fs[i].start && tri < fs[i].start + fs[i].count) return i;
    return fs.length ? fs.length - 1 : null;
  }

  // Devuelve el impacto bajo el puntero: `{kind, prim, faceIndex, point, normal,
  // distance}`. El terreno participa (para crear y para saber donde esta el
  // suelo), el agua no (crear sobre el agua es crear en el fondo, como en SL).
  function pick(clientX, clientY) {
    if (!canvas.getBoundingClientRect) return null;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    let best = null;
    const h = world.raycast(ray);
    if (h) {
      const n = new T.Vector3(0, 1, 0);
      if (h.face && h.face.normal) n.copy(h.face.normal).applyQuaternion(h.prim.quaternion).normalize();
      best = {
        kind: "prim", prim: h.prim, faceIndex: faceOfTriangle(h.prim, h.faceIndex),
        point: h.point.clone(), normal: n, distance: h.distance,
      };
    }
    if (terrainMesh) {
      const th = ray.intersectObject(terrainMesh, false);
      if (th.length && (!best || th[0].distance < best.distance)) {
        const p = th[0].point;
        best = { kind: "terrain", prim: null, faceIndex: null, point: p.clone(), normal: terrainNormal(p.x, p.z), distance: th[0].distance };
      }
    }
    return best;
  }

  // Normal del terreno por diferencias (la malla del terreno no guarda normales
  // suaves y la sonda de deposito solo necesita saber "hacia arriba").
  // Ojo: `heightAt` es un metodo del terreno, asi que hay que llamarlo sobre la
  // instancia (desligarlo lo deja sin `this` y revienta).
  const _tn = new T.Vector3();
  function terrainNormal(x, z) {
    const d = 0.6;
    const h = (a, b) => terrain.heightAt(a, b);
    _tn.set(h(x - d, z) - h(x + d, z), 2 * d, h(x, z - d) - h(x, z + d)).normalize();
    return _tn.clone();
  }

  function select(prim, faceIndex) {
    // Si el prim pertenece a un link set, se selecciona el CONJUNTO (como hace
    // SL cuando "editar enlazados" esta desactivado, que es lo normal).
    let root = prim ? world.linkRootFor(prim) : null;
    state.selection = root || prim || null;
    state.extra = root ? root.links.slice().filter((c) => c !== state.selection) : [];
    if (prim) {
      if (faceIndex !== undefined && faceIndex !== null) state.faceIndex = faceIndex;
      else if (state.faceIndex === null || state.faceIndex === undefined || state.faceIndex >= prim.volume.faces.length) state.faceIndex = 0;
    } else {
      state.faceIndex = null;
    }
    refreshSelection();
    autoFold();
    renderParams();
    renderFaces();
    appearance.render();
    scriptPanel.render();
    // En el tactil, elegir un prim que lleva script trae su editor arriba del
    // todo: si no, el editor queda enterrado bajo las otras secciones.
    if (selectionHasScript()) revealScript();
    refreshStatus();
  }
  function deselect() { select(null); }

  // ¿La seleccion (o algun prim del conjunto enlazado) lleva script?
  function selectionHasScript() {
    const o = state.selection;
    if (!o) return false;
    if (o.script) return true;
    return (o.links || []).some((c) => c && c.script);
  }

  // Añadir/quitar un prim de la seleccion multiple (Shift+clic o modo multi).
  function selectAdd(prim) {
    if (!prim) return;
    const root = world.linkRootFor(prim);
    const members = root ? [root].concat(root.links) : [prim];
    const held = selectionSet();
    const already = members.every((m) => held.indexOf(m) >= 0);
    if (already) {
      state.extra = state.extra.filter((o) => members.indexOf(o) < 0);
      refreshSelection(); refreshStatus();
      return;
    }
    if (!state.selection) { select(prim); return; }
    for (const m of members) {
      if (m === state.selection || state.extra.indexOf(m) >= 0) continue;
      state.extra.push(m);
    }
    refreshSelection(); refreshStatus();
  }

  // Todos los prims seleccionados (el activo el primero).
  function selectionSet() {
    if (!state.selection) return [];
    return [state.selection].concat(state.extra || []);
  }

  function refreshSelection() {
    const o = state.selection;
    if (!o) {
      selBox.visible = false;
      selFaceMesh.visible = false;
      refreshGizmo();
      return;
    }
    if (!state.active) hoverMesh.visible = false;
    world.setBox(o, selBox.box);
    const hideBox = state.mode === "terrain";
    selBox.visible = state.active && !hideBox;
    placeFaceMesh(selFaceMesh, o, state.faceIndex);
    selFaceMesh.visible = state.active && !hideBox && selFaceMesh.visible;
    refreshGizmo();
  }

  // --- color ----------------------------------------------------------------
  function restoreColor(o) {
    if (!o || o.colorHex === undefined || o.colorHex === null) return;
    world.setColor(o, o.colorHex);
  }

  function setColor(hex) {
    const o = state.selection;
    if (!o) return;
    beginTx();
    for (const m of targetsForEdit()) world.setColor(m, hex);
    commitTx("Color");
    renderParams();
  }

  // --- creacion -------------------------------------------------------------
  // Punto donde se deposita un prim nuevo: delante del avatar, sobre el suelo.
  function placePoint() {
    const fwd = new T.Vector3(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
    const p = avatar.position.clone().addScaledVector(fwd, 3.2);
    p.y = terrain.heightAt(p.x, p.z) + 0.5;
    return p;
  }

  function restOnSurface(obj, point, normal) {
    const n = normal || new T.Vector3(0, 1, 0);
    const b = obj.localBox || { min: [0, -0.5, 0] };
    obj.position.copy(point).addScaledVector(n, -b.min[1] * obj.scale.y + 0.01);
    obj.sync();
    return obj;
  }

  function create(shape, at) {
    const before = snapshot();
    const p = new PrimParams(shape || state.shape);
    const obj = world.add(p, { position: at ? at.clone() : placePoint() });
    obj.colorHex = null;
    state.mode = "translate";
    select(obj);
    pushHistory("Crear " + (SHAPES[obj.params.shape] || {}).label, before);
    renderTools();
    return obj;
  }

  function createAtPoint(point, normal) {
    const before = snapshot();
    const obj = world.add(new PrimParams(state.shape), { position: point.clone() });
    restOnSurface(obj, point, normal);
    select(obj);
    pushHistory("Crear " + (SHAPES[obj.params.shape] || {}).label, before);
    return obj;
  }

  // Copia la apariencia por cara de un prim a otro: duplicar (o guardar y
  // rezar) tiene que llevarse las texturas, no solo la forma.
  function copyFaces(from, to) {
    if (!from || !to || !from.faces || !to.faces) return;
    const n = Math.min(from.faces.length, to.faces.length);
    for (let i = 0; i < n; i++) {
      const src = from.faces[i];
      if (!src) continue;
      const f = to.faces[i];
      f.tex = src.tex ? Object.assign({}, src.tex) : null;
      f.color = src.color;
      f.alpha = src.alpha;
      f.glow = src.glow;
      f.fullbright = src.fullbright;
      f.mask = src.mask;
      f.repeat = [src.repeat[0], src.repeat[1]];
      f.offset = [src.offset[0], src.offset[1]];
      f.rotation = src.rotation;
      f.rough = src.rough;
      f.metal = src.metal;
      f.doubleSide = src.doubleSide;
    }
    world.applyFaceMaterials(to);
  }

  // Aplica un `facesToJson` guardado (inventario) a un prim recien rezado.
  function restoreFaces(obj, json) {
    if (!obj || !obj.faces || !json) return;
    obj.faces = facesFromJson(json, obj.faces.length);
    world.applyFaceMaterials(obj);
  }

  function duplicate() {
    const o = state.selection;
    if (!o) return null;
    const before = snapshot();
    const shift = new T.Vector3(0.5, 0, 0);
    const copies = [];
    for (const m of targetsForEdit()) {
      const c = world.add(m.params.copy(), {
        name: m.name + " copia",
        position: m.position.clone().add(shift),
        quaternion: m.quaternion.clone(),
        scale: m.scale.clone(),
        build: m.build,
        phantom: m.phantom,
      });
      if (m.colorHex !== undefined && m.colorHex !== null) world.setColor(c, m.colorHex);
      copyFaces(m, c);
      // El contenido tambien se duplica: en SL copiar un objeto con script se
      // lleva el script (y arranca una instancia nueva, independiente).
      if (m.script) c.script = m.script;
      copies.push(c);
    }
    const copy = copies[0];
    // Si se duplico un conjunto, la copia tambien es un conjunto.
    if (copies.length > 1 && world.isRoot(o)) world.link(copies, copy);
    select(copy);
    pushHistory(copies.length > 1 ? "Duplicar conjunto" : "Duplicar", before);
    return copy;
  }

  function removeSelected() {
    const o = state.selection;
    if (!o) return false;
    const before = snapshot();
    const targets = targetsForEdit();
    const name = targets.length > 1 ? ("conjunto de " + targets.length) : o.name;
    // Los conjuntos se borran enteros: borrar la raiz ya se lleva a los hijos.
    for (const m of targets.slice()) if (world.objects.indexOf(m) >= 0) world.remove(m);
    state.selection = null;
    state.extra = [];
    state.faceIndex = null;
    hoverMesh.visible = false;
    refreshSelection();
    renderParams();
    renderFaces();
    scriptPanel.render();
    pushHistory("Borrar " + name, before);
    return true;
  }

  // Apoyar el prim en el suelo (terreno) sin moverlo en horizontal.
  function dropToGround() {
    const o = state.selection;
    if (!o) return;
    beginTx();
    const targets = targetsForEdit();
    if (world.isRoot(o)) {
      // Un conjunto baja entero: se calcula cuanto le falta al miembro mas bajo
      // y se desplazan todos lo mismo (asi no se deforma).
      let need = -Infinity;
      for (const m of targets) {
        const g = terrain.heightAt(m.position.x, m.position.z);
        const b = m.localBox || { min: [0, -0.5, 0] };
        need = Math.max(need, g - b.min[1] * m.scale.y + 0.01 - m.position.y);
      }
      for (const m of targets) { m.position.y += need; m.sync(); }
      world.updateObject(o);
    } else {
      for (const m of targets) {
        const g = terrain.heightAt(m.position.x, m.position.z);
        const b = m.localBox || { min: [0, -0.5, 0] };
        m.position.y = g - b.min[1] * m.scale.y + 0.01;
        world.updateObject(m);
      }
    }
    commitTx("Bajar al suelo");
    renderParams();
  }

  function resetShape() {
    const o = state.selection;
    if (!o) return;
    beginTx();
    for (const m of targetsForEdit()) {
      Object.assign(m.params, new PrimParams(m.params.shape));
      world.updateObject(m);
    }
    commitTx("Reiniciar forma");
    renderParams();
    renderFaces();
  }

  function centerOnPlayer() {
    const o = state.selection;
    if (!o) return;
    beginTx();
    const p = placePoint();
    if (world.isRoot(o)) {
      o.position.set(p.x, avatar.position.y + 1.2, p.z);
      world.updateObject(o);
    } else {
      const delta = new T.Vector3(p.x - o.position.x, avatar.position.y + 1.2 - o.position.y, p.z - o.position.z);
      for (const m of targetsForEdit()) {
        m.position.add(delta);
        world.updateObject(m);
      }
    }
    commitTx("Traer al avatar");
    renderParams();
  }

  // --- parametros -----------------------------------------------------------
  // Un prim de un link set se edita como conjunto: en SL, con un conjunto
  // seleccionado el floater de edicion aplica los parametros a todos los prims.
  function targetsForEdit() {
    const o = state.selection;
    if (!o) return [];
    return world.isRoot(o) ? [o].concat(o.links) : [o];
  }

  // --- enlazar / desenlazar -------------------------------------------------
  // Un "link set" de SL: varios prims que se mueven como uno. El seleccionado
  // activo hace de raiz (es el que lleva los gizmos) y los demas lo siguen.
  function linkSelection() {
    const targets = selectionSet();
    if (targets.length < 2) { toast("Shift+clic para seleccionar dos o más prims"); return false; }
    if (world.isRoot(state.selection)) { toast("Ya forman un conjunto"); return false; }
    const before = snapshot();
    world.link(targets, state.selection);
    pushHistory("Enlazar " + targets.length + " prims", before);
    select(state.selection);
    toast("Conjunto de " + targets.length + " prims");
    return true;
  }

  function unlinkSelection() {
    const o = state.selection;
    if (!o || !world.linkRootFor(o)) { toast("Ese prim no está enlazado"); return false; }
    const before = snapshot();
    const n = world.linkSetOf(o).length;
    world.unlink(o);
    pushHistory("Desenlazar " + n + " prims", before);
    select(state.selection);
    toast("Desenlazado");
    return true;
  }

  function applyParam(key, value) {
    if (!state.selection) return;
    for (const o of targetsForEdit()) {
      if (key === "shape") o.params.setShape(value);
      else o.params[key] = value;
      world.updateObject(o);
      restoreColor(o);
    }
    if (state.mode === "translate" || state.mode === "rotate" || state.mode === "scale") refreshSelection();
    refreshStatus();
  }

  // Deslizador en vivo: aplica ya, pero el historial se cierra al soltar (si no
  // cada pixel de arrastre seria un paso de deshacer).
  function liveParam(key, value) { beginTx(); applyParam(key, value); }
  function commitParam(label) { commitTx(label); renderFaces(); }

  function setScaleAxis(i, value) {
    const o = state.selection;
    if (!o) return;
    beginTx();
    const v = clamp(value, SIZE_MIN, SIZE_MAX);
    const targets = targetsForEdit();
    if (world.isRoot(o)) {
      // Estirar un conjunto = el "stretch" de SL: la raiz cambia de tamano en
      // ese eje y los demas se alejan/crecen en la misma proporcion.
      const base = i === 0 ? o.scale.x : i === 1 ? o.scale.y : o.scale.z;
      const f = base ? v / base : 1;
      for (const m of targets) {
        const rel = m.position.clone().sub(o.position);
        rel.setComponent(i, rel.getComponent(i) * f);
        m.position.copy(o.position).add(rel);
        const s = m.scale.clone();
        s.setComponent(i, clamp(s.getComponent(i) * f, SIZE_MIN, SIZE_MAX));
        m.scale.copy(s);
      }
      world.refreshLinkLocals(o);
      for (const m of targets) world.updateObject(m);
    } else {
      for (const m of targets) {
        const s = m.scale.clone();
        s.setComponent(i, v);
        m.scale.copy(s);
        world.updateObject(m);
      }
    }
    commitParam("Tamaño");
    renderParams();
  }

  function setPositionAxis(i, value) {
    const o = state.selection;
    if (!o) return;
    beginTx();
    if (world.isRoot(o)) {
      // Mover la raiz ya arrastra a los hijos.
      const p = o.position.clone();
      p.setComponent(i, value);
      o.position.copy(p);
      world.updateObject(o);
    } else {
      const delta = value - o.position.getComponent(i);
      for (const m of targetsForEdit()) {
        const p = m.position.clone();
        p.setComponent(i, p.getComponent(i) + delta);
        m.position.copy(p);
        world.updateObject(m);
      }
    }
    commitParam("Posición");
    renderParams();
  }

  // --- panel ----------------------------------------------------------------
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }
  function btn(label, cls, onClick, disabled) {
    const b = el("button", "bbtn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    if (disabled) b.disabled = true;
    b.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
    return b;
  }

  // Cada panel es una seccion plegable: se toca la cabecera y el cuerpo se
  // oculta. En el telefono eso es lo que hace que quepan parametros y caras.
  function panel(root, title, key) {
    root.innerHTML = "";
    const folded = !!state.folded[key];
    const head = el("div", "bhead bheadbtn");
    head.appendChild(el("span", null, title));
    const mark = el("span", "bfold", folded ? "\u25B8" : "\u25BE");
    head.appendChild(mark);
    const body = el("div", "bbody");
    body.hidden = folded;
    head.addEventListener("click", () => {
      const f = !state.folded[key];
      state.folded[key] = f;
      body.hidden = f;
      mark.textContent = f ? "\u25B8" : "\u25BE";
      // En el telefono, desplegar una seccion la trae arriba del todo: si no,
      // hay que desplazar el panel entero para ver lo que acabas de abrir.
      if (!f) { scrollPanelTo(root); placeChat(); }
    });
    root.appendChild(head);
    root.appendChild(body);
    return body;
  }

  function renderTools() {
    if (!els.tools) return;
    const box = panel(els.tools, "Herramientas", "tools");

    const modes = [["select", "Seleccionar"], ["translate", "Mover"], ["rotate", "Rotar"], ["scale", "Escalar"], ["terrain", "Terreno"]];
    const row = el("div", "brow");
    for (const [id, label] of modes) {
      row.appendChild(btn(label, state.mode === id ? "on" : "", () => setMode(id)));
    }
    box.appendChild(row);

    const crow = el("div", "brow");
    crow.appendChild(el("span", "blabel", "Crear"));
    for (const s of SHAPE_ORDER) {
      const b = btn(SHAPES[s].icon + " " + SHAPES[s].label, (state.mode === "create" && state.shape === s) ? "on" : "", () => {
        state.shape = s;
        setMode("create");
      });
      crow.appendChild(b);
    }
    box.appendChild(crow);

    const arow = el("div", "brow");
    arow.appendChild(btn("＋ Delante", "", () => create()));
    arow.appendChild(btn("Duplicar", "", duplicate));
    arow.appendChild(btn("Borrar", "", removeSelected));
    arow.appendChild(btn("Al suelo", "", dropToGround));
    arow.appendChild(btn("Al avatar", "", centerOnPlayer));
    arow.appendChild(btn("Reiniciar", "", resetShape));
    box.appendChild(arow);

    // Enlazar prims: en el tactil no hay Shift, asi que ademas del boton hay un
    // modo "seleccion multiple" que hace que cada clic sume a la seleccion.
    const lrow = el("div", "brow");
    lrow.appendChild(btn("Enlazar", "", linkSelection));
    lrow.appendChild(btn("Desenlazar", "", unlinkSelection));
    const multiLab = el("label", "bcheck");
    const multiCb = el("input");
    multiCb.type = "checkbox";
    multiCb.checked = state.multi;
    multiCb.addEventListener("change", () => { state.multi = multiCb.checked; });
    multiLab.appendChild(multiCb);
    multiLab.appendChild(el("span", null, "Selección múltiple"));
    lrow.appendChild(multiLab);
    box.appendChild(lrow);

    const hrow = el("div", "brow");
    hrow.appendChild(btn("↶ Deshacer", "", undo));
    hrow.appendChild(btn("↷ Rehacer", "", redo));
    const snapLab = el("label", "bcheck");
    const snapCb = el("input");
    snapCb.type = "checkbox";
    snapCb.checked = state.snap;
    snapCb.addEventListener("change", () => { state.snap = snapCb.checked; applySnap(); });
    snapLab.appendChild(snapCb);
    snapLab.appendChild(el("span", null, "Rejilla 0,5 m / 45°"));
    hrow.appendChild(snapLab);
    const spaceLab = el("label", "bcheck");
    const spaceCb = el("input");
    spaceCb.type = "checkbox";
    spaceCb.checked = state.space === "local";
    spaceCb.addEventListener("change", () => { state.space = spaceCb.checked ? "local" : "world"; refreshGizmo(); });
    spaceLab.appendChild(spaceCb);
    spaceLab.appendChild(el("span", null, "Ejes locales"));
    hrow.appendChild(spaceLab);
    box.appendChild(hrow);
  }

  function fieldRow(f, params) {
    const row = el("div", "brow bfield");
    row.appendChild(el("span", "blabel", f.label));
    const range = el("input", "brange");
    range.type = "range";
    range.min = String(f.min); range.max = String(f.max); range.step = String(f.step);
    range.value = String(params[f.key]);
    const val = el("span", "bval", Number(params[f.key]).toFixed(f.dec) + (f.unit || ""));
    const live = () => {
      const v = parseFloat(range.value);
      val.textContent = v.toFixed(f.dec) + (f.unit || "");
      liveParam(f.key, v);
    };
    range.addEventListener("input", live);
    range.addEventListener("change", () => commitParam(f.label));
    row.appendChild(range);
    row.appendChild(val);
    return row;
  }

  function numRow(label, values, min, max, onChange) {
    const row = el("div", "brow bnums");
    row.appendChild(el("span", "blabel", label));
    const inputs = [];
    for (let i = 0; i < 3; i++) {
      const inp = el("input", "bnum");
      inp.type = "number";
      inp.step = "0.05";
      inp.min = String(min); inp.max = String(max);
      inp.value = Number(values[i]).toFixed(2);
      inp.addEventListener("change", () => onChange(i, parseFloat(inp.value)));
      inputs.push(inp);
      row.appendChild(inp);
    }
    return { row, inputs };
  }

  function updateNums() {
    const o = state.selection;
    if (!o || !numRefs) return;
    const s = [o.scale.x, o.scale.y, o.scale.z];
    for (let i = 0; i < 3; i++) {
      if (document.activeElement !== numRefs.size.inputs[i]) numRefs.size.inputs[i].value = s[i].toFixed(2);
      const p = o.position;
      if (document.activeElement !== numRefs.pos.inputs[i]) numRefs.pos.inputs[i].value = (i === 0 ? p.x : i === 1 ? p.y : p.z).toFixed(2);
    }
  }
  let numRefs = null;

  function renderParams() {
    if (!els.params) return;
    const o = state.selection;
    const box = panel(els.params, o ? "Prim seleccionado" : "Sin selección", "params");
    if (!o) {
      box.appendChild(el("div", "bnote", "Haz clic en un prim para editarlo, o crea uno con las formas de arriba."));
      numRefs = null;
      return;
    }

    const setN = 1 + (state.extra || []).length;
    box.appendChild(el("div", "bsub", o.name + " · id " + o.id + " · " + o.volume.faces.length + " caras · " + o.volume.numTriangles + " triángulos" +
      (setN > 1 ? " · conjunto de " + setN + " prims" : (world.isRoot(o) ? " · raíz de " + (o.links.length + 1) + " prims" : ""))));

    const srow = el("div", "brow");
    for (const s of SHAPE_ORDER) {
      srow.appendChild(btn(SHAPES[s].label, o.params.shape === s ? "on" : "", () => {
        beginTx();
        applyParam("shape", s);
        commitParam("Forma");
        renderParams();
        renderFaces();
      }));
    }
    box.appendChild(srow);

    const size = numRow("Tamaño", [o.scale.x, o.scale.y, o.scale.z], SIZE_MIN, SIZE_MAX, setScaleAxis);
    const pos = numRow("Posición", [o.position.x, o.position.y, o.position.z], -4096, 4096, setPositionAxis);
    numRefs = { size, pos };
    box.appendChild(size.row);
    box.appendChild(pos.row);
    const reg = el("div", "bnote");
    reg.textContent = "región " + (o.position.x + 128).toFixed(1) + " / " + (128 - o.position.z).toFixed(1) + " / " + o.position.y.toFixed(1);
    box.appendChild(reg);

    // color
    const crow = el("div", "brow bswatches");
    crow.appendChild(el("span", "blabel", "Color"));
    for (const hex of PALETTE) {
      const sw = el("button", "bsw" + (o.colorHex === hex ? " on" : ""));
      sw.type = "button";
      sw.style.background = "#" + hex.toString(16).padStart(6, "0");
      sw.addEventListener("click", () => setColor(hex));
      crow.appendChild(sw);
    }
    const picker = el("input", "bpick");
    picker.type = "color";
    picker.value = "#" + ((o.colorHex === undefined || o.colorHex === null ? 0xb9c2cf : o.colorHex) >>> 0).toString(16).padStart(6, "0");
    picker.addEventListener("change", () => setColor(parseInt(picker.value.slice(1), 16)));
    crow.appendChild(picker);
    box.appendChild(crow);

    // parametros de forma, agrupados y solo los que aplican a esta forma
    const groups = o.params.visibleGroups();
    for (const key of Object.keys(GROUP_TITLES)) {
      if (!groups[key]) continue;
      const fs = FIELDS.filter((f) => f.group === key);
      if (!fs.length) continue;
      box.appendChild(el("div", "bsub", GROUP_TITLES[key]));
      for (const f of fs) box.appendChild(fieldRow(f, o.params));
      if (key === "hollow") {
        const hrow = el("div", "brow bfield");
        hrow.appendChild(el("span", "blabel", "Forma del hueco"));
        const sel = el("select", "bsel");
        for (const h of HOLE_SHAPES) {
          const op = el("option", null, h.label);
          op.value = h.id;
          if (o.params.holeShape === h.id) op.selected = true;
          sel.appendChild(op);
        }
        sel.addEventListener("change", () => {
          beginTx();
          applyParam("holeShape", sel.value);
          commitParam("Forma del hueco");
        });
        hrow.appendChild(sel);
        box.appendChild(hrow);
      }
    }
  }

  function renderFaces() {
    if (!els.faces) return;
    const o = state.selection;
    els.faces.hidden = !o;
    const box = panel(els.faces, "Caras", "faces");
    if (!o) {
      box.appendChild(el("div", "bnote", "—"));
      return;
    }
    const info = faceInfo(o.volume);
    const wrap = el("div", "brow bfaces");
    info.forEach((f, i) => {
      const b = btn((i + 1) + ". " + f.label.replace("Cara ", ""), state.faceIndex === i ? "on" : "", () => select(o, i));
      b.classList.add("bfacesbtn");
      wrap.appendChild(b);
    });
    box.appendChild(wrap);
  }

  // --- region: guardar / cargar / exportar -----------------------------------
  function applyRegionData(data, undoable, label) {
    if (!data || !data.objects) return false;
    const before = snapshot();
    world.deserialize(data);
    // La capa de terreno va con la region: si el guardado no trae ninguna, se
    // vuelve al terreno de fabrica (es lo que espera "Recargar").
    if (terrain && terrain.decodeSculpt) {
      if (data.terrain) terrain.decodeSculpt(data.terrain); else terrain.clearSculpt();
      if (viewer.water) viewer.water.syncTerrain();
    }
    state.selection = null;
    state.extra = [];
    state.faceIndex = null;
    hoverMesh.visible = false;
    refreshSelection();
    renderParams();
    renderFaces();
    renderInventory();
    appearance.render();
    scriptPanel.render();
    if (undoable) pushHistory(label || "Cargar region", before);
    else {
      undoStack.length = 0;
      redoStack.length = 0;
      state.history = 0;
      refreshStatus();
    }
    return true;
  }
  function loadRegionData(data, undoable) { return applyRegionData(data, undoable, "Cargar región"); }

  function exportRegion() {
    const payload = regionToJson(regionState(), { generator: window.generatorName || null });
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = (window.generatorName || "region") + "-region.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("Región exportada (" + world.objects.length + " prims)");
  }

  let fileInput = null;
  function importRegion() {
    if (!fileInput) {
      fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".json,application/json";
      fileInput.style.display = "none";
      fileInput.addEventListener("change", () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
          try {
            const data = parseRegionJson(String(fr.result));
            applyRegionData(data, true, "Importar región");
            toast("Región importada (" + data.objects.length + " prims)");
          } catch (e) {
            toast("No se pudo importar: " + e.message);
          }
        };
        fr.readAsText(f);
      });
      document.body.appendChild(fileInput);
    }
    fileInput.click();
  }

  async function resetRegion() {
    if (!window.confirm("¿Borrar la región guardada y volver al mundo de ejemplo?")) return;
    if (store && store.available) await store.deleteRegion(store.autosaveName);
    location.reload();
  }

  function renderRegion() {
    if (!els.region) return;
    const box = panel(els.region, "Región", "region");
    if (!store || !store.available) {
      box.appendChild(el("div", "bnote", "Sin almacenamiento: falta el plugin kv."));
      return;
    }
    const row = el("div", "brow");
    row.appendChild(btn("Guardar", "", async () => {
      await store.flush();
      await store.saveRegion(store.autosaveName, regionState());
      toast("Región guardada");
    }));
    row.appendChild(btn("Recargar", "", async () => {
      const d = await store.loadRegion(store.autosaveName);
      if (d) { applyRegionData(d, true, "Recargar región"); toast("Región recargada"); }
      else toast("Todavía no hay nada guardado");
    }));
    row.appendChild(btn("Exportar", "", exportRegion));
    row.appendChild(btn("Importar", "", importRegion));
    row.appendChild(btn("Volver al ejemplo", "bdanger", resetRegion));
    box.appendChild(row);
    box.appendChild(el("div", "bnote", "Lo que construyes se guarda solo en este navegador."));

    // Multijugador: compartir la region con quien entre a la vez.
    const n = net();
    if (n) {
      const row2 = el("div", "brow");
      const label = el("label", "bcheck");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!n.shareEnabled();
      cb.addEventListener("change", () => { n.setShare(cb.checked); renderRegion(); });
      label.appendChild(cb);
      label.appendChild(document.createTextNode("Mundo compartido"));
      row2.appendChild(label);
      row2.appendChild(btn("↩ Mi región anterior", "", async () => {
        const d = await store.loadRegion(n.preRedName);
        if (!d) { toast("No hay ninguna región guardada como «" + n.preRedName + "»"); return; }
        applyRegionData(d, true, "Mi región anterior");
        toast("Región anterior recuperada (" + d.objects.length + " prims)");
      }));
      box.appendChild(row2);
      const otros = n.peerCount;
      box.appendChild(el("div", "bnote", (otros ? otros + " jugador" + (otros > 1 ? "es" : "") + " más" : "solo tú") + " · " + n.statusText()));
    }
  }

  // --- inventario ------------------------------------------------------------
  let invItems = null;

  function toast(msg) {
    if (!els.msg || !msg) return;
    els.msg.hidden = false;
    els.msg.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.msg.hidden = true; }, 2400);
  }
  let toastTimer = null;

  function renderInventory() {
    if (!els.inv) return;
    const box = panel(els.inv, "Inventario", "inv");
    const row = el("div", "brow");
    row.appendChild(btn("＋ Guardar prim", "", saveSelectionToInv));
    const refresh = btn("↻", "", () => { invItems = null; renderInventory(); });
    refresh.title = "Actualizar la lista";
    row.appendChild(refresh);
    box.appendChild(row);
    if (!store || !store.available) {
      box.appendChild(el("div", "bnote", "Sin almacenamiento: falta el plugin kv."));
      return;
    }
    if (invItems === null) {
      box.appendChild(el("div", "bnote", "Cargando…"));
      store.listItems().then((items) => { invItems = items; renderInventory(); });
      return;
    }
    if (!invItems.length) {
      box.appendChild(el("div", "bnote", "Vacío. Elige un prim y pulsa «Guardar prim»."));
      return;
    }
    const list = el("div", "binvlist");
    for (const it of invItems) {
      const r = el("div", "brow");
      const open = btn(((SHAPES[it.shape] || {}).icon || "•") + " " + it.name, "", () => rezItem(it.item));
      open.classList.add("binvbtn");
      r.appendChild(open);
      r.appendChild(btn("×", "binvdel", () => deleteInvItem(it.name)));
      list.appendChild(r);
    }
    box.appendChild(list);
  }

  async function saveSelectionToInv() {
    const o = state.selection;
    if (!o) { toast("Primero selecciona un prim"); return; }
    if (!store || !store.available) { toast("Sin almacenamiento"); return; }
    const name = window.prompt("Nombre en el inventario:", o.name);
    if (!name) return;
    const item = primToItem(o);
    item.name = name;
    await store.saveItem(name, item);
    invItems = null;
    renderInventory();
    toast("En el inventario: " + name);
  }

  async function deleteInvItem(name) {
    if (!store || !store.available) return;
    await store.deleteItem(name);
    invItems = null;
    renderInventory();
    toast("Borrado del inventario: " + name);
  }

  // "Rezar" un prim del inventario: aparece delante del avatar, apoyado en el
  // suelo, con la forma, tamano, rotacion y color con los que se guardo.
  function rezItem(item) {
    if (!item) return null;
    const before = snapshot();
    const p = new PrimParams(item.shape);
    Object.assign(p, item.params || {});
    const at = placePoint();
    at.y = terrain.heightAt(at.x, at.z);   // apoyado en el suelo, no flotando
    const obj = world.add(p, itemToAdd(item));
    restOnSurface(obj, at, null);
    if (item.color !== null && item.color !== undefined) world.setColor(obj, item.color);
    restoreFaces(obj, item.faces);
    if (item.script) obj.script = item.script;   // el runtime lo arranca solo
    state.mode = "translate";
    select(obj);
    pushHistory("Rezar " + (item.name || p.shape), before);
    renderTools();
    toast("Rezado: " + (item.name || p.shape));
    return obj;
  }

  function refreshStatus() {
    if (!els.status) return;
    const o = state.selection;
    const modeNames = { select: "seleccionar", translate: "mover", rotate: "rotar", scale: "escalar", create: "crear " + (SHAPES[state.shape] || {}).label, terrain: "terreno" };
    const pincel = state.mode === "terrain" && terrainTools ? terrainTools.state : null;
    els.status.textContent =
      world.objects.length + " prims · " + (modeNames[state.mode] || state.mode) +
      (pincel ? " · pincel " + terrainTools.toolLabel().toLowerCase() + " " + pincel.radius + " m (" + Math.round(pincel.strength * 100) + "%)"
        : (!o ? " · nada seleccionado"
          : state.extra.length ? " · conjunto de " + (state.extra.length + 1) + " prims"
            : " · " + o.name + " (" + o.scale.x.toFixed(2) + " × " + o.scale.y.toFixed(2) + " × " + o.scale.z.toFixed(2) + " m)")) +
      (undoStack.length ? " · deshacer: " + undoStack.length : "");
    // Editar pasa por aqui (pushHistory, el gizmo y el panel llaman a este
    // metodo), asi que es el sitio natural para el autoguardado con retardo.
    if (store && store.available) store.schedule(() => regionState());
  }

  // --- modo -----------------------------------------------------------------
  function setMode(mode) {
    state.mode = mode;
    refreshGizmo();
    if (terrainTools) terrainTools.setEnabled(state.active && mode === "terrain");
    autoFold();
    renderTools();
    renderParams();
    renderFaces();
    if (terrainTools) terrainTools.renderPanel();
    appearance.render();
    scriptPanel.render();
    scrollPanelTo(state.mode === "terrain" && terrainTools ? els.terrain : els.tools);
    placeChat();
    refreshStatus();
  }

  // En el telefono el panel no cabe entero: al cambiar de modo se pliega la
  // seccion que no toca (el pincel al editar prims y los prims al esculpir), asi
  // que siempre se ve lo que se puede usar en ese momento. En escritorio no se
  // toca nada: sobra sitio.
  function autoFold() {
    const touch = document.body.classList.contains("touch");
    if (!touch) return;
    const terr = state.mode === "terrain";
    state.folded.terrain = !terr;
    // Al esculpir no se tocan prims y al reves: en el telefono se pliega la
    // seccion que no toca para que la que se usa quepa sin desplazar el panel.
    if (terr) { state.folded.params = true; state.folded.faces = true; state.folded.tools = true; state.folded.script = true; }
    else { state.folded.params = false; state.folded.tools = false; state.folded.script = !selectionHasScript(); }
  }
  // En el telefono el panel no cabe entero: ademas de plegar lo que no toca, la
  // seccion que se esta usando se pone la primera (debajo del estado) y el panel
  // vuelve arriba, asi que siempre se ve entera sin desplazar nada a mano.
  function scrollPanelTo(el2) {
    if (!els.root || !document.body.classList.contains("touch")) return;
    const target = el2 || els.tools;
    const anchor = els.status ? els.status.nextSibling : els.root.firstChild;
    if (target && target.parentNode === els.root && target !== anchor) {
      els.root.insertBefore(target, anchor);
    }
    els.root.scrollTop = 0;
  }

  // Tocar una cara de un prim ya elegido significa "quiero texturizar esta
  // cara": en el telefono se despliega el panel de apariencia y se trae arriba
  // del todo, porque si no queda enterrado bajo las otras secciones.
  function revealAppearance() {
    if (!document.body.classList.contains("touch")) return;
    if (state.folded.faceapp) { state.folded.faceapp = false; appearance.render(); }
    scrollPanelTo(document.getElementById("buildFaceAppEl"));
  }

  // Lo mismo para el editor de scripts: se despliega y se trae arriba (el chat
  // se coloca antes para que quede justo debajo del codigo).
  function revealScript() {
    if (!document.body.classList.contains("touch")) return;
    if (state.folded.script) { state.folded.script = false; scriptPanel.render(); }
    placeChat();
    scrollPanelTo(els.script);
  }

  // En el tactil el chat se muda dentro del panel de construccion (y vuelve a
  // flotar al salir): el panel ya ocupa la franja de abajo y, metido dentro,
  // sigue el desplazamiento de las secciones, asi que el editor de scripts y la
  // salida de los scripts se leen juntos.
  function placeChat() {
    const c = els.chat;
    if (!c) return;
    const inPanel = document.body.classList.contains("touch") && state.active;
    if (inPanel) {
      els.root.insertBefore(c, els.status ? els.status.nextSibling : els.root.firstChild);
    } else if (c.parentNode !== document.body) {
      document.body.appendChild(c);
    }
  }

  function setActive(on) {
    state.active = !!on;
    if (els.root) els.root.hidden = !state.active;
    document.body.classList.toggle("build", state.active);
    placeChat();
    if (els.toggle) els.toggle.classList.toggle("on", state.active);
    if (!state.active) {
      gizmo.detach();
      selBox.visible = false;
      selFaceMesh.visible = false;
      hoverMesh.visible = false;
      state.hover = null;
    } else {
      refreshSelection();
      if (!state.selection) {
        const first = world.objects[0];
        if (first) select(first);
      }
    }
    refreshGizmo();
    if (terrainTools) terrainTools.setEnabled(state.active && state.mode === "terrain");
    refreshStatus();
  }

  // --- puntero --------------------------------------------------------------
  const ptr = { down: false, moved: 0, x: 0, y: 0, downX: 0, downY: 0, id: null };

  function onPointerDown(e) {
    if (state.active && state.mode === "terrain" && terrainTools.onPointerDown(e)) return;
    ptr.x = e.clientX; ptr.y = e.clientY;
    ptr.downX = e.clientX; ptr.downY = e.clientY;
    ptr.down = true; ptr.moved = 0; ptr.id = e.pointerId;
    if (!state.active) return;
    // Si el puntero esta encima de un eje del gizmo, el arrastre es del gizmo:
    // se bloquea la orbita de la camara desde el primer pixel (TransformControls
    // avisa de `dragging` un poco mas tarde, cuando ya se ha movido).
    if (gizmo.enabled && gizmo.axis) cam.locked = true;
  }
  function onPointerMove(e) {
    if (state.active && state.mode === "terrain") { terrainTools.onPointerMove(e); return; }
    ptr.x = e.clientX; ptr.y = e.clientY;
    if (ptr.down) ptr.moved = Math.hypot(e.clientX - ptr.downX, e.clientY - ptr.downY);
    if (!state.active) return;
    updateHover(e.clientX, e.clientY);
  }
  function onPointerUp(e) {
    if (state.active && state.mode === "terrain") { terrainTools.onPointerUp(e); return; }
    ptr.down = false;
    if (!state.active) return;
    if (gizmo.axis || gizmo.dragging) return;         // el clic era del gizmo
    if (ptr.moved > CLICK_SLOP) return;
    onClick(e.clientX, e.clientY, e);
  }
  function onClick(cx, cy, e) {
    if (state.mode === "terrain") return;              // el pincel manda
    const hit = pick(cx, cy);
    if (state.mode === "create") {
      if (!hit) return;
      createAtPoint(hit.point, hit.normal);
      renderTools();
      refreshStatus();
      return;
    }
    if (!hit) { deselect(); return; }
    if (hit.kind === "prim") {
      // Shift/Ctrl+clic (o el modo multiple) suma a la seleccion en vez de
      // reemplazarla: asi se juntan varios prims para enlazarlos.
      const add = state.multi || (e && (e.shiftKey || e.ctrlKey || e.metaKey));
      if (add) selectAdd(hit.prim);
      else {
        const root0 = world.linkRootFor(hit.prim) || hit.prim;
        const samePrim = state.selection === root0;
        const sameFace = state.faceIndex === hit.faceIndex;
        select(hit.prim, hit.faceIndex);
        if (samePrim && !sameFace) revealAppearance();
      }
      return;
    }
    deselect();
  }

  let hoverAcc = 0;
  function updateHover(cx, cy) {
    if (state.mode === "terrain") { hoverMesh.visible = false; state.hover = null; return; }
    const hit = pick(cx, cy);
    state.hover = hit;
    if (!state.active || !hit || hit.kind !== "prim") {
      hoverMesh.visible = false;
      return;
    }
    if (state.selection === hit.prim && state.faceIndex === hit.faceIndex) {
      hoverMesh.visible = false;
      return;
    }
    placeFaceMesh(hoverMesh, hit.prim, hit.faceIndex);
  }

  function onDblClick(e) {
    if (!state.active) return;
    const hit = pick(e.clientX, e.clientY);
    if (hit && hit.kind === "prim") {
      select(hit.prim, hit.faceIndex);
      // doble clic = acercar la camara al prim (como el "zoom" de SL)
      const c = new T.Vector3();
      world.setBox(hit.prim, selBox.box);
      selBox.box.getCenter(c);
      const d = Math.max(2, hit.prim.boundRadius * 2.6);
      cam.mode = "follow";
      cam.dist = clamp(d, cam.min, cam.max);
      // Ojo con el signo: `pitch` es la inclinacion de la MIRADA (+ arriba), asi
      // que para dejar la camara por encima hay que pedir un cabeceo negativo;
      // y el rumbo se calcula desde el avatar HACIA el prim.
      cam.pitch = -0.2;
      cam.yaw = Math.atan2(avatar.position.x - hit.prim.position.x, avatar.position.z - hit.prim.position.z);
    }
  }

  function onKeyDown(e) {
    if (e.target && /input|textarea|select/i.test(e.target.tagName || "")) return;
    if (e.code === "KeyB") { setActive(!state.active); e.preventDefault(); return; }
    if (!state.active) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === "KeyZ") { undo(); e.preventDefault(); return; }
    if (ctrl && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) { redo(); e.preventDefault(); return; }
    if (ctrl && e.code === "KeyD") { duplicate(); e.preventDefault(); return; }
    if (ctrl && e.code === "KeyL") { if (e.shiftKey) unlinkSelection(); else linkSelection(); e.preventDefault(); return; }
    if (e.code === "Delete" || e.code === "Backspace") { removeSelected(); e.preventDefault(); return; }
    if (e.code === "Escape") { deselect(); return; }
    if (e.code === "KeyG") { state.snap = !state.snap; applySnap(); renderTools(); return; }
    if (e.code === "KeyY") { dropToGround(); return; }
  }

  if (canvas) {
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("dblclick", onDblClick);
  }
  window.addEventListener("keydown", onKeyDown);
  // Al salir de la pagina se vuelca el autoguardado pendiente sin esperar al
  // retardo (si el usuario cierra la pestaña justo despues de mover algo).
  function onPageHide() { if (store && store.available) store.flush(); }
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && store && store.available) store.flush();
  });
  if (els.toggle) {
    els.toggle.addEventListener("click", (e) => { e.preventDefault(); setActive(!state.active); });
  }

  // --- bucle ----------------------------------------------------------------
  function update() {
    if (!state.active) return;
    updateNums();
    if (state.selection && state.mode !== "terrain") {
      world.setBox(state.selection, selBox.box);
      selBox.visible = true;
      placeFaceMesh(selFaceMesh, state.selection, state.faceIndex);
    }
  }

  function dispose() {
    if (canvas) {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("dblclick", onDblClick);
    }
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("pagehide", onPageHide);
    if (terrainTools) terrainTools.dispose();
    if (els.chat && els.chat.parentNode !== document.body) document.body.appendChild(els.chat);
    document.body.classList.remove("build");
    try { gizmo.dispose(); scene.remove(gizmoObj); } catch (e) { /* noop */ }
    for (const m of [hoverMesh, selFaceMesh]) { scene.remove(m); if (m.geometry) m.geometry.dispose(); m.material.dispose(); }
    scene.remove(selBox);
    selBox.geometry.dispose();
    selBox.material.dispose();
    cam.locked = false;
  }

  const coarsePointer = document.body.classList.contains("touch") ||
    (window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  state.folded = { tools: false, params: false, faces: !!coarsePointer, terrain: !!coarsePointer, script: !!coarsePointer, inv: false, region: false };

  renderTools();
  renderParams();
  renderFaces();
  terrainTools.renderPanel();
  appearance.render();
  scriptPanel.render();
  renderRegion();
  renderInventory();
  refreshStatus();
  setActive(false);

  return {
    state, gizmo, select, deselect, create, createAtPoint, duplicate, removeSelected,
    dropToGround, centerOnPlayer, resetShape, setColor, setMode, setActive, undo, redo,
    pick, liveParam, commitParam, setParam: applyParam, setScaleAxis, setPositionAxis,
    refreshSelection, renderParams, renderFaces, refreshStatus, update, dispose,
    toast, renderRegion, renderInventory, applyRegionData, loadRegionData, rezItem,
    selectAdd, linkSelection, unlinkSelection, selectionSet, targetsForEdit,
    terrainTools, appearance, scriptPanel, regionState,
    get selection() { return state.selection; },
    setSelection: select,
    faces: () => (state.selection ? faceInfo(state.selection.volume) : []),
    history: () => ({ undo: undoStack.length, redo: redoStack.length }),
  };
}
