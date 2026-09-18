// primGallery.js -- banco de pruebas visual del motor de geometria.
//
// Dibuja las 7 formas de SL y varias filas de variantes de parametros, cada una
// como una malla independiente generada por generateVolume(). Sirve para
// verificar a ojo (y con la herramienta `vision`) que el teselado es correcto:
// un cubo debe tener aristas rectas, un cilindro tapas planas, una esfera debe
// verse lisa, un toro no debe estar retorcido, etc.
//
// Modos:
//   'persp' (por defecto) vista 3/4 orbitable.
//   'sheet'               vista cenital con cada prim etiquetado; es a la vez la
//                         hoja de contactos para verificar y el futuro selector
//                         de forma del editor.
//
// Rutas: #primtest  |  #primtest/<forma> (forma aislada, grande)  |  #primtest/hoja

import * as THREE from "./three.js";
import { OrbitControls } from "./three.js";
import { PrimParams, SHAPES, SHAPE_ORDER, primBaseRow, primVariants, primCase, primCaseList } from "./prims.js";
import { PrimMeshFactory, faceInfo } from "./primMesh.js";

export { primBaseRow, primVariants };

const COL_A = 0x5aa9e6;
const COL_B = 0xe6a15a;

// Las luces de la escena de prueba y de la sonda (compartidas para que la sonda
// ilumine igual que la galeria: si no, las medidas no serian comparables).
function makeLights(THREE_) {
  const hemi = new THREE_.HemisphereLight(0xbfd4ff, 0x232833, 1.2);
  const key = new THREE_.DirectionalLight(0xffffff, 2.6); key.position.set(7, 13, 9);
  const fill = new THREE_.DirectionalLight(0x8fb0ff, 0.9); fill.position.set(-9, 5, -8);
  const rim = new THREE_.DirectionalLight(0xffd9a8, 0.5); rim.position.set(0, -6, 10);
  return [hemi, key, fill, rim];
}

// ---------------------------------------------------------------------------
// Sonda de pixeles -- verificacion automatica de la orientacion de las mallas.
//
// Para que sirve: un triangulo con el vertice girado (winding invertido) no
// rompe el volumen firmado si esta acompanado de otro, pero al descartar caras
// traseras (como hace el visor de SL: FrontSide) deja un agujero por el que se
// ve el fondo. Una normal nula (fallo del suavizado) se ve como una mancha
// negra. Ambos son errores de geometria que ningun test aritmetico detecta con
// tanta certeza como mirar los pixeles.
//
// Metodo: cada malla se renderiza tres veces contra un fondo conocido, desde la
// misma camara, encuadrada por su caja envolvente:
//   1. sombreada DoubleSide sobre negro  -> luminancia (una malla con el winding
//      global invertido sale oscura casi entera: las normales apuntan al reves).
//   2. blanca DoubleSide sobre negro     -> mascara de la silueta.
//   3. sombreada FrontSide sobre magenta -> los pixeles magenta dentro de la
//      silueta son agujeros: triangulos descartados con el winding al reves.
// Se ignoran los pixeles del borde (se exige que los 4 vecinos esten dentro de
// la silueta) para no contar el antialias.
//
// La sonda se valida a si misma con tres casos de calibracion (media malla
// invertida, malla entera invertida, malla colapsada): si la calibracion no da
// lo que tiene que dar, devuelve `calibrated:false` y sus medidas no valen nada.
// ---------------------------------------------------------------------------
export function probeVolumes(THREE_, renderer, volumes, opts = {}) {
  const W = opts.size || 512, H = W;
  const dpr0 = renderer.getPixelRatio();
  const size0 = renderer.getSize(new THREE_.Vector2());
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);

  const scene = new THREE_.Scene();
  for (const l of makeLights(THREE_)) scene.add(l);
  const cam = new THREE_.PerspectiveCamera(42, 1, 0.05, 800);
  const matShaded = new THREE_.MeshStandardMaterial({ color: COL_A, roughness: 0.5, metalness: 0.06, side: THREE_.DoubleSide });
  const matFront = new THREE_.MeshStandardMaterial({ color: COL_A, roughness: 0.5, metalness: 0.06, side: THREE_.FrontSide });
  const matMask = new THREE_.MeshBasicMaterial({ color: 0xffffff, side: THREE_.DoubleSide });
  const bgBlack = new THREE_.Color(0x000000);
  const bgMag = new THREE_.Color(0xff00ff);
  const read = document.createElement("canvas");

  function grab() {
    renderer.render(scene, cam);
    const src = renderer.domElement;
    read.width = src.width; read.height = src.height;
    const ctx = read.getContext("2d");
    ctx.drawImage(src, 0, 0);
    return ctx.getImageData(0, 0, read.width, read.height).data;
  }

  const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

  function measure(v) {
    const p = v.positions;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
      if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    const radius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 0.5;
    const fov = cam.fov * Math.PI / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.18;
    const az = 30 * Math.PI / 180, el = 22 * Math.PI / 180;
    cam.position.set(cx + Math.sin(az) * Math.cos(el) * dist, cy + Math.sin(el) * dist, cz + Math.cos(az) * Math.cos(el) * dist);
    cam.lookAt(cx, cy, cz);
    cam.updateMatrixWorld(true);

    let zeroNormals = 0;
    for (let i = 0; i < v.normals.length; i += 3) {
      const m = Math.hypot(v.normals[i], v.normals[i + 1], v.normals[i + 2]);
      if (!Number.isFinite(m) || m < 1e-6) zeroNormals++;
    }

    const g = new THREE_.BufferGeometry();
    g.setAttribute("position", new THREE_.BufferAttribute(p, 3));
    g.setAttribute("normal", new THREE_.BufferAttribute(v.normals, 3));
    const mesh = new THREE_.Mesh(g, matMask);
    mesh.frustumCulled = false;
    scene.add(mesh);

    scene.background = bgBlack;
    mesh.material = matShaded;
    const dS = grab();
    mesh.material = matMask;
    const dM = grab();
    scene.background = bgMag;
    mesh.material = matFront;
    const dF = grab();

    scene.remove(mesh);
    g.dispose();

    const inside = (x, y) => lum(dM, (y * W + x) * 4) > 128;
    let pixels = 0, interior = 0, dark = 0, holes = 0, sum = 0, minL = 999;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (!inside(x, y)) continue;
        pixels++;
        const i = (y * W + x) * 4;
        const l = lum(dS, i);
        sum += l; if (l < minL) minL = l;
        if (!(inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1))) continue;
        interior++;
        if (l < 12) dark++;
        if (dF[i] > 150 && dF[i + 2] > 150 && dF[i + 1] < 70) holes++;
      }
    }
    return {
      name: v.name,
      triangles: v.numTriangles,
      pixels, interior,
      meanLum: +(sum / Math.max(1, pixels)).toFixed(1),
      minLum: minL === 999 ? null : +minL.toFixed(1),
      zeroNormals,
      darkFrac: +(dark / Math.max(1, interior)).toFixed(5),
      holeFrac: +(holes / Math.max(1, interior)).toFixed(5),
    };
  }

  const results = [];
  for (const v of volumes) {
    const r = measure(v);
    r.ok = r.pixels > 0 && r.holeFrac <= (opts.holeTolerance === undefined ? 0.002 : opts.holeTolerance) && r.zeroNormals === 0;
    r.problems = [];
    if (r.pixels === 0) r.problems.push("no se dibujo nada");
    if (r.holeFrac > (opts.holeTolerance === undefined ? 0.002 : opts.holeTolerance)) r.problems.push("agujeros (triangulos invertidos)");
    if (r.zeroNormals) r.problems.push("normales nulas");
    results.push(r);
  }

  // --- calibracion: la sonda tiene que detectar errores provocados ---
  const calibVol = (name, mut) => {
    const tri = Math.floor((volumes[0] ? volumes[0].numTriangles : 0) / 2) || 1;
    const p = Float32Array.from(volumes[0].positions);
    const n = Float32Array.from(volumes[0].normals);
    mut(p, n, tri);
    return measure({ name, positions: p, normals: n, numTriangles: volumes[0].numTriangles });
  };
  const ref = volumes[0];
  const flip = (arr, from, count) => {
    for (let t = from; t < from + count && t * 9 + 8 < arr.length; t++) {
      const o = t * 9;
      for (let k = 0; k < 3; k++) {
        const tmp = arr[o + 3 + k]; arr[o + 3 + k] = arr[o + 6 + k]; arr[o + 6 + k] = tmp;
      }
    }
  };
  const calibHalf = calibVol("calib mitad invertida", (p) => flip(p, 0, Math.ceil(ref.numTriangles / 2)));
  const calibAll = calibVol("calib todo invertido", (p) => flip(p, 0, ref.numTriangles));
  const calibFlat = calibVol("calib colapsada", (p) => { for (let i = 0; i < p.length; i++) p[i] = 0; });
  const refLum = results[0] ? results[0].meanLum : 1;
  const calibratedOk = calibHalf.holeFrac > 0.05 &&      // los invertidos se ven como agujeros
    calibHalf.zeroNormals === 0 &&
    calibAll.pixels > 0 && calibAll.meanLum < 0.7 * refLum && // el winding global invertido sale oscuro
    calibFlat.pixels === 0;                               // una malla colapsada no dibuja nada

  renderer.setPixelRatio(dpr0);
  renderer.setSize(size0.x, size0.y, false);
  renderer.render(scene, cam);

  return {
    calibrated: calibratedOk,
    calibration: { half: calibHalf, all: calibAll, flat: calibFlat },
    results,
    failures: results.filter((r) => !r.ok),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeLabelSprite(THREE_, text, color) {
  const fs = 46, pad = 12;
  const c = document.createElement("canvas");
  let ctx = c.getContext("2d");
  ctx.font = "600 " + fs + "px system-ui, sans-serif";
  const tw = Math.ceil(ctx.measureText(text).width);
  c.width = tw + pad * 2;
  c.height = fs + pad * 1.4;
  ctx = c.getContext("2d");
  ctx.font = "600 " + fs + "px system-ui, sans-serif";
  ctx.fillStyle = "rgba(9,13,20,0.72)";
  roundRect(ctx, 0, 0, c.width, c.height, 14);
  ctx.fill();
  ctx.fillStyle = color || "#d3e3ff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2 + 2);
  const tex = new THREE_.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  const spr = new THREE_.Sprite(new THREE_.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  spr.renderOrder = 999;
  const h = 0.42;
  spr.scale.set(h * c.width / c.height, h, 1);
  return spr;
}

export function createPrimGallery(container, opts = {}) {
  const THREE_ = opts.THREE || THREE;
  const focus = opts.focus || null;
  const mode = opts.mode || "persp";
  const lod = opts.lod === undefined ? 3 : opts.lod;
  const wantLabels = opts.labels === undefined ? mode === "sheet" : !!opts.labels;
  const factory = new PrimMeshFactory(THREE_);

  const scene = new THREE_.Scene();
  scene.background = new THREE_.Color(0x0d1119);

  const renderer = new THREE_.WebGLRenderer({
    canvas: opts.canvas, antialias: true, preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE_.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const camera = new THREE_.PerspectiveCamera(mode === "sheet" ? 20 : 42, 1, 0.05, 800);

  for (const l of makeLights(THREE_)) scene.add(l);

  const ground = new THREE_.Mesh(
    new THREE_.PlaneGeometry(400, 400),
    new THREE_.MeshStandardMaterial({ color: 0x161c28, roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const grid = new THREE_.GridHelper(160, 160, 0x3d5a86, 0x25304a);
  grid.position.y = 0.003;
  scene.add(grid);

  const items = [];
  const labels = [];
  const diag = [];

  function addItem(caseDef, x, z, color, scaleTo) {
    const volParams = caseDef.params.toVolumeParams();
    const geom = factory.get(volParams, lod);
    const vol = factory.getVolume(volParams, lod);
    const mat = new THREE_.MeshStandardMaterial({
      color, roughness: 0.5, metalness: 0.06, side: THREE_.DoubleSide,
    });
    const mesh = new THREE_.Mesh(geom, mat);
    mesh.position.set(x, 0.65, z);
    mesh.scale.setScalar(scaleTo || 1);
    mesh.userData.caseName = caseDef.name;
    mesh.userData.faces = faceInfo(vol);
    mesh.userData.triangles = vol.numTriangles;
    scene.add(mesh);
    items.push(mesh);
    if (wantLabels) {
      const spr = makeLabelSprite(THREE_, caseDef.name, color === COL_A ? "#cfe0ff" : "#ffe0bd");
      spr.position.set(x, 0.12, z + 0.92);
      scene.add(spr);
      labels.push(spr);
    }
    return mesh;
  }

  // --- reparto en la rejilla ----------------------------------------------
  let camPos = new THREE_.Vector3(0, 13.5, 25);
  let camTarget = new THREE_.Vector3(0, 0.6, 1.6);
  let gridBounds = null;

  if (focus) {
    const def = SHAPES[focus];
    if (!def) throw new Error("forma desconocida: " + focus);
    const mesh = addItem(primCase(def.label, focus), 0, 0, COL_A, 2.6);
    mesh.userData.focus = true;
    camPos = new THREE_.Vector3(3.4, 3.2, 5.4);
    camTarget = new THREE_.Vector3(0, 0.65, 0);
    diag.push("forma aislada: " + focus);
  } else {
    const cases = primBaseRow().concat(primVariants());
    const perRow = 7;
    const sp = mode === "sheet" ? 3.1 : 3.0;
    const rows = Math.ceil(cases.length / perRow);
    const half = (n) => (n - 1) * 0.5;
    const zSpan = (rows - 1) * sp;
    cases.forEach((c, i) => {
      const r = Math.floor(i / perRow), col = i % perRow;
      const count = Math.min(perRow, cases.length - r * perRow);
      const x = (col - half(count)) * sp;
      const z = -zSpan / 2 + r * sp;
      addItem(c, x, z, (r % 2 === 0) ? COL_A : COL_B, r === 0 ? 1.25 : 1.0);
    });
    gridBounds = { halfW: perRow * sp / 2, halfD: zSpan / 2 + sp * 0.75 };
    diag.push("filas=" + rows + " casos=" + cases.length);
    if (mode === "sheet") {
      camPos = new THREE_.Vector3(0, 40, 0.001);
      camTarget = new THREE_.Vector3(0, 0.65, 0);
      scene.fog = null;
      diag.push("hoja cenital");
    } else {
      scene.fog = new THREE_.Fog(0x0d1119, 45, 150);
      camPos = new THREE_.Vector3(0, 13.5, 25);
      camTarget = new THREE_.Vector3(0, 0.6, 1.6);
    }
  }

  camera.position.copy(camPos);
  camera.lookAt(camTarget);

  let controls = null;
  if (mode !== "sheet") {
    try {
      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.copy(camTarget);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.update();
    } catch (e) {
      diag.push("OrbitControls no disponible: " + e.message);
    }
  }

  function setView(az, el, dist, target) {
    if (target) camTarget.set(target[0], target[1], target[2]);
    const a = (az || 0) * Math.PI / 180;
    const e = (el === undefined ? 18 : el) * Math.PI / 180;
    const d = dist || 8;
    camera.position.set(
      camTarget.x + Math.sin(a) * Math.cos(e) * d,
      camTarget.y + Math.sin(e) * d,
      camTarget.z + Math.cos(a) * Math.cos(e) * d
    );
    if (controls) { controls.target.copy(camTarget); controls.update(); }
    else camera.lookAt(camTarget);
  }

  // Encuadre automatico de la rejilla (para la hoja cenital).
  function fitSheet() {
    if (!gridBounds) return;
    const aspect = camera.aspect || 1;
    const halfFov = camera.fov * Math.PI / 360;
    const needD = gridBounds.halfD / Math.tan(halfFov);
    const needW = gridBounds.halfW / (Math.tan(halfFov) * aspect);
    const dist = Math.max(needD, needW) * 1.12 + 6;
    camera.position.set(0, dist, 0.0001);
    camera.lookAt(camTarget);
    if (controls) { controls.target.copy(camTarget); controls.update(); }
  }

  let spin = opts.spin ? 1 : 0;
  const setSpin = (on) => { spin = on ? 1 : 0; };

  // Aisla un prim (por indice de la lista de casos) centrado y encuadrado: es
  // el banco de pruebas de una sola pieza y, mas adelante, la vista previa del
  // selector de formas. El encuadre se calcula a partir de la esfera
  // envolvente, asi que funciona con cualquier fov y cualquier prim.
  function focusCase(i, o = {}) {
    const m = items[i];
    if (!m) return null;
    for (const it of items) it.visible = false;
    for (const s of labels) s.visible = false;
    m.visible = true;
    const home = { pos: m.position.clone(), scale: m.scale.x, rot: m.rotation.y };
    m.position.set(0, 0.65, 0);
    m.scale.setScalar(o.scale || 2.2);
    m.rotation.y = o.rot || 0;
    m.updateMatrixWorld(true);

    camera.fov = o.fov || 35;
    camera.updateProjectionMatrix();
    const sphere = new THREE_.Box3().setFromObject(m).getBoundingSphere(new THREE_.Sphere());
    const vFov = camera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));
    const dist = sphere.radius / Math.sin(Math.min(vFov, hFov) / 2) * (o.margin || 1.3);
    setView(o.az === undefined ? 35 : o.az, o.el === undefined ? 22 : o.el, dist,
      [0, sphere.center.y, 0]);
    return {
      name: m.userData.caseName,
      triangles: m.userData.triangles,
      dist: +dist.toFixed(2),
      radius: +sphere.radius.toFixed(3),
      faces: m.userData.faces.map((f) => f.label),
      restore() {
        m.position.copy(home.pos);
        m.scale.setScalar(home.scale);
        m.rotation.y = home.rot;
        for (const it of items) it.visible = true;
        for (const s of labels) s.visible = true;
      },
    };
  }

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    if (mode === "sheet") fitSheet();
  }

  let angle = 0;
  function update(dt) {
    if (spin) {
      angle += dt * 0.5;
      for (const m of items) m.rotation.y = angle;
    }
    if (controls) controls.update();
  }

  function dispose() {
    for (const s of labels) { s.material.map.dispose(); s.material.dispose(); }
    factory.dispose();
    renderer.dispose();
    if (controls && controls.dispose) controls.dispose();
  }

  return {
    scene, camera, renderer, update, resize, dispose, setView, setSpin, fitSheet,
    focusCase, items, labels, diag, focus, mode, three: THREE_,
    // Instantanea de los pixeles actuales del canvas. Con preserveDrawingBuffer
    // el contenido sobrevive al frame, asi que se puede copiar a un canvas 2D y
    // leer los pixeles (lo usan las comprobaciones visuales automatizadas).
    snapshot() {
      renderer.render(scene, camera);
      const src = renderer.domElement;
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(src, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height);
    },
    get stats() {
      return items.map((m) => ({
        name: m.userData.caseName,
        triangles: m.userData.triangles,
        faces: m.userData.faces.map((f) => f.label),
      }));
    },
    // Sonda de pixeles sobre TODOS los casos del catalogo (o los que se pasen):
    // comprueba que ninguna malla tiene triangulos invertidos ni normales nulas.
    // Es la verificacion visual automatica del motor de geometria; se autovalida
    // con casos de calibracion (ver probeVolumes).
    probeCases(cases, o) {
      const list = cases || primCaseList();
      const volumes = list.map((c) => {
        const vol = factory.getVolume(c.params.toVolumeParams(), lod);
        return { name: c.name, positions: vol.positions, normals: vol.normals, numTriangles: vol.numTriangles };
      });
      return probeVolumes(THREE_, renderer, volumes, o);
    },
  };
}
