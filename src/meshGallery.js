// meshGallery.js -- banco de pruebas para TRAER MALLAS DE FUERA (ruta
// #meshtest).
//
// Es la pieza que responde a «poder usar cabezas mesh o cuerpos mesh de SL»: se
// coge un fichero 3D (GLB/GLTF/OBJ) --descargado, o soltado en la pagina, o de
// una URL-- y se monta sobre el esqueleto real de Second Life, de modo que se
// mueve con las animaciones de verdad. El trabajo fino lo hace `sl/meshImport.js`
// (emparejar huesos por nombre, alinear y retransmitir las rotaciones); aqui esta
// la escena, los controles y el diagnostico.
//
// Al lado se dibuja, translucido, el cuerpo de SISTEMA de SL como referencia:
// sirve para ver de un vistazo si la malla encaja (que es justo lo que hay que
// comprobar cuando se trae una cabeza o un cuerpo que no son del visor).
//
//   #meshtest     la escena (suelta el fichero encima)
//
// Lo que este banco NO puede hacer: bajar tus activos de Second Life por su
// cuenta. Un cuerpo/cabeza mesh que tengas en tu inventario solo se puede pedir
// con tu sesion abierta (ver `VIEWER-REAL.md`); si el creador lo permite, el
// fichero exportado se carga aqui igual que cualquier otro.

import * as THREE from "./three.js";
import { OrbitControls } from "./three.js";
import { AvatarMesh } from "./sl/avatarMesh.js";
import { fetchSystemBodyFiles, SYSTEM_BODY_FILE_BY_PART } from "./sl/characterAssets.js";
import { buildIdleAnim, buildWalkAnim, buildRunAnim, buildWaveAnim, buildSitAnim } from "./sl/avatarPose.js";
import { createImportedRig, parseModel, loadGltfUrl, guessFormat } from "./sl/meshImport.js";
import { decodeMeshAsset, meshStats } from "./sl/llmesh.js";
import { parseAnim } from "./sl/anim.js";

export function createMeshGallery(container, opts = {}) {
  const statusEl = opts.statusEl || null;
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; if (opts.onStatus) opts.onStatus(t); };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x121722);
  const renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (renderer.domElement !== opts.canvas) container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 200);
  camera.position.set(0.9, 1.5, -2.6);

  const key = new THREE.DirectionalLight(0xfff2e2, 2.3);
  key.position.set(2.2, 4.2, -3.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 18;
  key.shadow.camera.left = -2.5; key.shadow.camera.right = 2.5;
  key.shadow.camera.top = 2.5; key.shadow.camera.bottom = -2.5;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.85);
  fill.position.set(-3.4, 2.2, -1.8);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffe0c0, 0.85);
  rim.position.set(-0.6, 3.0, 4.4);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 0.5));

  const ground = new THREE.Mesh(new THREE.CircleGeometry(14, 48), new THREE.MeshStandardMaterial({ color: 0x3c434e, roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(28, 28, 0x2b3038, 0x232830);
  grid.position.y = 0.001;
  scene.add(grid);

  // --- avatar de referencia (cuerpo de sistema) ------------------------------
  const avatar = new AvatarMesh(THREE, { name: "referencia" });
  scene.add(avatar.group);
  let avatarReady = false;
  let bodyBytes = null;

  const anims = {};
  function buildAnims() {
    anims.idle = buildIdleAnim(avatar.binding);
    anims.walk = buildWalkAnim(avatar.binding);
    anims.run = buildRunAnim(avatar.binding);
    anims.wave = buildWaveAnim(avatar.binding);
    anims.sit = buildSitAnim(avatar.binding);
  }
  let playing = "idle";
  let waveInst = null;
  let animBtns = null;
  function paintAnimButtons() {
    if (!animBtns) return;
    for (const [key, b] of animBtns) b.classList.toggle("on", key === playing);
  }
  function play(name) {
    if (!anims[name]) return;
    avatar.stopAll();
    waveInst = null;
    const inst = avatar.play(anims[name], { gain: 1 });
    if (name === "wave") waveInst = inst;
    playing = name;
    paintAnimButtons();
  }
  buildAnims();
  play("idle");

  // Esqueleto a la vista (puntos + varillas).
  const boneViz = (() => {
    const group = new THREE.Group();
    group.name = "huesos";
    const mat = new THREE.MeshBasicMaterial({ color: 0x6fe3ff });
    const dot = new THREE.SphereGeometry(0.012, 8, 6);
    const linkMat = new THREE.LineBasicMaterial({ color: 0x3aa0c8 });
    const nodes = [];
    for (const bone of avatar.binding.bones) {
      const s = new THREE.Mesh(dot, mat);
      s.frustumCulled = false;
      group.add(s);
      let line = null;
      if (bone.parent && bone.parent.isBone) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
        line = new THREE.Line(g, linkMat);
        line.frustumCulled = false;
        group.add(line);
      }
      nodes.push({ bone, sphere: s, line });
    }
    group.visible = false;
    scene.add(group);
    return { group, nodes };
  })();

  function updateBoneViz() {
    for (const n of boneViz.nodes) {
      n.sphere.position.setFromMatrixPosition(n.bone.matrixWorld);
      if (n.line) {
        const a = n.line.geometry.getAttribute("position");
        a.setXYZ(0, n.sphere.position.x, n.sphere.position.y, n.sphere.position.z);
        const p = new THREE.Vector3().setFromMatrixPosition(n.bone.parent.matrixWorld);
        a.setXYZ(1, p.x, p.y, p.z);
        a.needsUpdate = true;
      }
    }
  }

  // --- controles ------------------------------------------------------------
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.25;
  controls.maxDistance = 10;
  controls.target.set(0, 1.0, 0);
  controls.update();
  let userTouched = false;
  const markTouched = () => { userTouched = true; };
  renderer.domElement.addEventListener("pointerdown", markTouched);
  renderer.domElement.addEventListener("wheel", markTouched, { passive: true });

  // --- malla importada ------------------------------------------------------
  let rig = null;
  let rigLabel = "";
  const report = { lines: [] };

  // Piezas del cuerpo de sistema que solo tienen sentido CON su textura con
  // alfa: la falda de sistema es un cono que, sin la textura, tapa las piernas,
  // y las pestanas son planos opacos sobre los ojos. En este banco de pruebas
  // (sin texturas) se ocultan para poder comparar de verdad la malla de fuera.
  const ALPHA_PARTS = ["skirt", "eyelashes"];
  function hideAlphaParts(mesh) {
    for (const name of ALPHA_PARTS) {
      const p = mesh.systemParts.get(name);
      if (p) p.object.visible = false;
    }
  }

  function setReferenceOpacity(on) {
    for (const p of avatar.systemParts.values()) {
      const m = p.object.material;
      if (!m) continue;
      m.transparent = !!on;
      m.opacity = on ? 0.2 : 1;
      m.depthWrite = !on;
      if (on) m.side = THREE.DoubleSide;
      m.needsUpdate = true;
    }
  }
  let refOn = true;

  function describeRig() {
    const st = rig.stats();
    const errs = rig.jointErrors();
    let worst = null;
    for (const e of errs) if (!worst || e.error > worst.error) worst = e;
    const lines = [];
    lines.push("malla: " + rigLabel);
    lines.push("huesos reconocidos: " + st.matched + " de " + st.totalJoints +
      " (la malla trae " + st.modelBones + ")");
    if (rig.alignment) {
      lines.push("encaje: escala " + rig.alignment.scale.toFixed(4) +
        " · error medio " + (rig.alignment.rms * 1000).toFixed(1) + " mm");
    } else {
      lines.push("encaje: sin alinear (pocos huesos reconocidos)");
    }
    if (worst) lines.push("peor articulacion: " + worst.name + " a " + (worst.error * 1000).toFixed(0) + " mm");
    if (st.matched === 0) lines.push("esta malla no tiene huesos de Second Life: se muestra tal cual (objeto suelto)");
    if (st.unmatchedModel) lines.push("huesos de la malla sin pareja: " + rig.unmatchedModel.slice(0, 10).join(", ") + (st.unmatchedModel > 10 ? "…" : ""));
    report.lines = lines;
    paintInfo();
  }

  function setModel(modelRoot, label) {
    if (rig) { rig.dispose(); rig = null; }
    rigLabel = label || "malla";
    if (!modelRoot) { describeRig(); return; }
    rig = createImportedRig({ THREE, binding: avatar.binding, modelRoot });
    avatar.group.add(rig.model);
    describeRig();
    setStatus("malla montada: " + rig.stats().matched + " huesos reconocidos");
  }

  // Que viene en el fichero: una animacion de SL (.anim), una malla de SL
  // (.llm, LLMESH) o un modelo generico (glTF/OBJ).
  function kindOf(name) {
    const n = String(name || "").toLowerCase();
    if (n.endsWith(".anim")) return "anim";
    if (n.endsWith(".llm")) return "llm";
    return "model";
  }

  // Registra una animacion real de SL en la fila de botones: al pulsarla se
  // reproduce sobre el esqueleto con `Animator` (mezcla por prioridad), igual
  // que una animacion del inventario.
  function registerAnim(name, parsed) {
    const key = "anim:" + name;
    anims[key] = parsed;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "bbtn";
    b.textContent = name.replace(/\.anim$/i, "");
    b.title = parsed.joints.length + " articulaciones · " + parsed.duration.toFixed(1) + " s · prioridad " + parsed.basePriority + (parsed.loop ? " · en bucle" : "");
    b.addEventListener("click", () => play(key));
    animsRow.appendChild(b);
    animBtns.set(key, b);
    return key;
  }

  function registerMesh(name, asset, object, st) {
    const chip = document.createElement("span");
    chip.className = "mgChip";
    chip.textContent = name + " · " + st.triangles.toLocaleString("es") + " tris · " + st.jointNames + " huesos";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "bbtn mgChipX";
    x.textContent = "×";
    const entry = { id: null, name, stats: st, chip };
    x.addEventListener("click", () => {
      if (entry.id !== null) avatar.removeMeshAsset(entry.id);
      chip.remove();
      const i = importedMeshes.indexOf(entry);
      if (i >= 0) importedMeshes.splice(i, 1);
    });
    chip.appendChild(x);
    filesRow.appendChild(chip);
    importedMeshes.push(entry);
    entry.object = object;
    return entry;
  }

  // Coloca unos bytes: decide por el nombre y hace lo que toque.
  async function placeBytes(bytes, name) {
    const kind = kindOf(name);
    if (kind === "anim") {
      const parsed = parseAnim(bytes, { allowInvalidJoints: true });
      const key = registerAnim(name, parsed);
      play(key);
      describeAnim(name, parsed);
      setStatus("animacion de SL: " + name + " · " + parsed.joints.length + " articulaciones · " + parsed.duration.toFixed(1) + " s");
      return;
    }
    if (kind === "llm") {
      const asset = await decodeMeshAsset(bytes);
      const st = meshStats(asset);
      const object = avatar.addMeshAsset(asset, { name, lod: 0 });
      if (!object) throw new Error("la malla .llm no trae pesos ni punto de anclaje");
      let id = null;
      for (const [k, v] of avatar.meshAssets) if (v.object === object) { id = k; break; }
      registerMesh(name, asset, object, st).id = id;
      report.lines = [
        "malla de SL (.llm): " + name,
        "nivel de detalle: " + (st.lod || "-") + " · caras " + st.faces + " · vértices " + st.vertices.toLocaleString("es") + " · triángulos " + st.triangles.toLocaleString("es"),
        "huesos del SkinInfo: " + st.jointNames + " · caras con pesos " + st.skinnedFaces + " de " + st.faces,
        "convex hulls de física: " + st.physicsHulls + " · materiales: " + (st.materialList.join(", ") || "-"),
      ];
      paintInfo();
      setStatus("malla de SL montada: " + st.triangles.toLocaleString("es") + " tris en " + st.jointNames + " huesos");
      return;
    }
    if (/\.[a-z]+$/i.test(name) && /\.obj$/i.test(name)) {
      const text = new TextDecoder().decode(bytes);
      setModel(await parseModel(THREE, text, { format: "obj", name }), name + " (" + Math.round(bytes.byteLength / 1024) + " KB)");
      return;
    }
    const modelRoot = await parseModel(THREE, bytes, { name });
    setModel(modelRoot, name + " (" + Math.round(bytes.byteLength / 1024) + " KB)");
  }

  function describeAnim(name, parsed) {
    const unknown = parsed.joints.filter((j) => j.boneIndex < 0).map((j) => j.sourceName);
    const lines = [
      "animación de SL (.anim): " + name,
      "duración " + parsed.duration.toFixed(2) + " s · " + parsed.joints.length + " articulaciones" + (parsed.loop ? " · en bucle" : ""),
      "prioridad base " + parsed.basePriority + " · máxima " + parsed.maxPriority +
        " · ease in/out " + parsed.easeInDuration + "/" + parsed.easeOutDuration + " s",
      unknown.length ? "articulaciones fuera del esqueleto (ignoradas): " + unknown.slice(0, 12).join(", ") : "todas las articulaciones están en el esqueleto",
    ];
    report.lines = lines;
    paintInfo();
  }

  async function loadFromUrl(url) {
    if (!url) return;
    const clean = url.split("?")[0].split("#")[0];
    const name = clean.split("/").pop() || "malla";
    setStatus("descargando " + name + "…");
    try {
      if (kindOf(name) === "model" && !/\.obj$/i.test(clean) && !/\.glb$/i.test(clean) && !/\.gltf$/i.test(clean)) {
        // Sin extension util: se prueba como glTF.
        const gltf = await loadGltfUrl(url);
        setModel(gltf.scene || gltf.scenes[0], name);
        return;
      }
      const buf = await fetchBytes(url);
      await placeBytes(new Uint8Array(buf), name);
    } catch (e) {
      setStatus("no se pudo cargar: " + (e && e.message ? e.message : e));
      report.lines = ["error al cargar " + name + ": " + (e && e.message ? e.message : e)];
      paintInfo();
    }
  }

  async function fetchBytes(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.arrayBuffer();
  }

  async function loadFromFile(file) {
    if (!file) return;
    setStatus("leyendo " + file.name + "…");
    try {
      const buf = await file.arrayBuffer();
      await placeBytes(new Uint8Array(buf), file.name);
    } catch (e) {
      setStatus("no se pudo leer el fichero: " + (e && e.message ? e.message : e));
      report.lines = ["error con " + file.name + ": " + (e && e.message ? e.message : e)];
      paintInfo();
    }
  }

  // Cuerpo de sistema -> GLB -> otra vez dentro. Es a la vez una autoprueba del
  // importador (pasa por GLTFLoader de verdad) y una herramienta util: deja el
  // avatar de sistema en un fichero que se puede abrir en Blender.
  async function demoModel() {
    if (!bodyBytes) { setStatus("el cuerpo de referencia aun se esta cargando…"); return; }
    setStatus("exportando el cuerpo de sistema a GLB…");
    try {
      const tmp = new AvatarMesh(THREE, { name: "export" });
      tmp.loadSystemBody(bodyBytes);
      hideAlphaParts(tmp);
      tmp.update(0);
      const buf = await exportGlb(tmp.group);
      tmp.dispose();
      setStatus("reimportando el GLB (" + Math.round(buf.byteLength / 1024) + " KB)…");
      const modelRoot = await parseModel(THREE, new Uint8Array(buf), { name: "cuerpo-sistema.glb" });
      setModel(modelRoot, "cuerpo de sistema exportado a GLB (autoprueba)");
    } catch (e) {
      setStatus("la autoprueba fallo: " + (e && e.message ? e.message : e));
    }
  }

  async function exportGlb(object) {
    const { GLTFExporter } = await import("https://esm.sh/three@0.160.0/examples/jsm/exporters/GLTFExporter.js");
    const exporter = new GLTFExporter();
    return await new Promise((res, rej) => exporter.parse(object, res, rej, { binary: true }));
  }

  // --- panel ----------------------------------------------------------------
  const panel = document.createElement("div");
  panel.className = "hud mgPanel";
  panel.innerHTML = [
    "<div class=\"bhead\">Traer activos de Second Life</div>",
    "<div class=\"bnote\">Suelta un fichero y se coloca solo:<br>· <b>.llm</b> (LLMESH): cuerpo o cabeza mesh, ropa riggeada… se ata al esqueleto de SL.<br>· <b>.anim</b> (LLKeyframeMotion): una animacion real de SL, que se reproduce sobre el esqueleto.<br>· <b>.glb / .gltf / .obj</b>: cualquier malla riggeada a los huesos de SL (mHead, mPelvis…).</div>",
    "<div class=\"mgRow\"><input class=\"btext\" type=\"text\" placeholder=\"https://…/cabeza.glb  o  …/andar.anim\"><button type=\"button\" class=\"bbtn mgLoad\">Cargar URL</button></div>",
    "<div class=\"mgRow\"><label class=\"bbtn mgFileBtn\">Abrir fichero…<input type=\"file\" hidden accept=\".llm,.anim,.glb,.gltf,.obj\"></label><button type=\"button\" class=\"bbtn mgDemo\" title=\"Exporta el cuerpo de sistema a GLB y lo vuelve a importar\">Autoprueba</button><button type=\"button\" class=\"bbtn mgClear\">Quitar todo</button></div>",
    "<div class=\"mgDrop\">Suelta aqui un .llm / .anim / .glb / .gltf / .obj</div>",
    "<div class=\"mgRow mgAnims\"><span class=\"blabel\">Animacion</span></div>",
    "<div class=\"mgRow mgFiles\"></div>",
    "<div class=\"mgRow\">",
    "  <label class=\"bcheck\"><input type=\"checkbox\" class=\"mgRef\" checked> cuerpo de referencia</label>",
    "  <label class=\"bcheck\"><input type=\"checkbox\" class=\"mgBones\"> esqueleto</label>",
    "  <label class=\"bcheck\"><input type=\"checkbox\" class=\"mgSpin\" checked> girar</label>",
    "</div>",
    "<div class=\"mgInfo\"></div>",
  ].join("");
  container.appendChild(panel);
  const urlInput = panel.querySelector("input[type=text]");
  const infoEl = panel.querySelector(".mgInfo");
  const dropEl = panel.querySelector(".mgDrop");
  const animsRow = panel.querySelector(".mgAnims");
  const filesRow = panel.querySelector(".mgFiles");
  const importedMeshes = [];   // { id, name, stats, chip }

  const animNames = [["idle", "Quieto"], ["walk", "Andar"], ["run", "Correr"], ["wave", "Saludar"], ["sit", "Sentado"]];
  animBtns = new Map();
  for (const [key, label] of animNames) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "bbtn";
    b.textContent = label;
    b.addEventListener("click", () => play(key));
    animsRow.appendChild(b);
    animBtns.set(key, b);
  }
  paintAnimButtons();
  function paintInfo() { infoEl.textContent = report.lines.join("\n"); }

  panel.querySelector(".mgLoad").addEventListener("click", () => loadFromUrl(urlInput.value.trim()));
  urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadFromUrl(urlInput.value.trim()); });
  const fileInput = panel.querySelector("input[type=file]");
  fileInput.addEventListener("change", () => { if (fileInput.files && fileInput.files[0]) loadFromFile(fileInput.files[0]); });
  panel.querySelector(".mgDemo").addEventListener("click", demoModel);
  panel.querySelector(".mgClear").addEventListener("click", () => {
    if (rig) { rig.dispose(); rig = null; rigLabel = ""; }
    for (const m of importedMeshes.slice()) {
      if (m.id !== null) avatar.removeMeshAsset(m.id);
      m.chip.remove();
    }
    importedMeshes.length = 0;
    report.lines = ["sin nada importado · el banco espera un .llm, un .anim o una malla"];
    paintInfo();
    setStatus("quitado todo");
  });
  panel.querySelector(".mgRef").addEventListener("change", (e) => { refOn = e.target.checked; setReferenceOpacity(refOn); });
  panel.querySelector(".mgBones").addEventListener("change", (e) => { boneViz.group.visible = e.target.checked; });
  let spin = true;
  panel.querySelector(".mgSpin").addEventListener("change", (e) => { spin = e.target.checked; if (!spin) avatar.group.rotation.y = 0; });

  // Suelta de ficheros, en el panel y en toda la pagina.
  const onDragOver = (e) => { e.preventDefault(); dropEl.classList.add("hot"); };
  const onDragLeave = () => dropEl.classList.remove("hot");
  const onDrop = (e) => {
    e.preventDefault();
    dropEl.classList.remove("hot");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFromFile(f);
  };
  panel.addEventListener("dragover", onDragOver);
  panel.addEventListener("dragleave", onDragLeave);
  panel.addEventListener("drop", onDrop);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);

  // --- carga del cuerpo de referencia ---------------------------------------
  let ready = false;
  const diag = ["malla de fuera · pidiendo el cuerpo de sistema de referencia…"];
  if (opts.onDiag) opts.onDiag();
  (async () => {
    try {
      const total = Object.keys(SYSTEM_BODY_FILE_BY_PART).length;
      bodyBytes = await fetchSystemBodyFiles({
        onProgress: (done) => setStatus("cuerpo de referencia (" + done + "/" + total + ")…"),
      });
      avatar.loadSystemBody(bodyBytes);
      hideAlphaParts(avatar);
      setReferenceOpacity(refOn);
      avatarReady = true;
      diag.length = 0;
      diag.push("malla de fuera · cuerpo de sistema de referencia cargado");
      diag.push("suelta un .glb/.gltf/.obj o pega una URL · animacion: " + playing);
      if (opts.onDiag) opts.onDiag();
      ready = true;
    } catch (e) {
      diag.length = 0;
      diag.push("no se pudo cargar el cuerpo de referencia: " + (e && e.message ? e.message : e) + " (el importador de mallas sigue funcionando)");
      if (opts.onDiag) opts.onDiag();
      ready = true;
    }
  })();

  report.lines = ["sin malla importada · el importador funciona con o sin el cuerpo de referencia"];
  paintInfo();

  // --- bucle ----------------------------------------------------------------
  let t = 0;
  let statusAcc = 0;
  function update(dt) {
    t += dt;
    avatar.update(dt);
    if (rig) rig.sync();
    if (waveInst && waveInst.finished) {
      avatar.stop(waveInst);
      waveInst = avatar.play(anims.wave, { gain: 1 });
    }
    if (spin && !userTouched) avatar.group.rotation.y = t * 0.35;
    if (boneViz.group.visible) updateBoneViz();
    controls.update();
    statusAcc += dt;
    if (statusAcc > 0.5 && ready) {
      statusAcc = 0;
      const tris = renderer.info.render.triangles;
      setStatus("malla de fuera · " + tris.toLocaleString("es") + " tris · animacion «" + playing + "»" + (rig ? " · " + rig.stats().matched + "/133 huesos" : ""));
    }
  }

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function dispose() {
    renderer.domElement.removeEventListener("pointerdown", markTouched);
    renderer.domElement.removeEventListener("wheel", markTouched);
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
    controls.dispose();
    if (rig) rig.dispose();
    avatar.dispose();
    panel.remove();
    renderer.dispose();
  }

  return {
    scene, camera, renderer, update, resize, dispose, diag,
    setModel, loadFromUrl, loadFromFile, play, setAnim: play,
    get ready() { return ready; },
    get avatar() { return avatar; },
    get rig() { return rig; },
    get report() { return report.lines; },
    stats: () => ({
      avatar: avatar.stats(),
      imported: rig ? rig.stats() : null,
      playing,
    }),
  };
}
