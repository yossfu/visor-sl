// realAvatar.js -- banco de pruebas del AVATAR REAL (ruta #bodytest).
//
// Es el hermano «de verdad» de `avatarGallery.js`: allí se mira el cuerpo
// procedural de `avatarBody.js` (geometría inventada, solo como respaldo); aquí
// se carga el cuerpo de sistema ORIGINAL de Second Life —cabeza, torso, piernas,
// pelo, pestañas, falda y ojos— sobre el esqueleto de 133 huesos, y se le tocan
// animaciones.
//
//   #bodytest             cuerpo entero, quieto, girando despacio
//   #bodytest/cara        primer plano de la cabeza
//   #bodytest/pose        andando
//   #bodytest/correr      corriendo
//   #bodytest/saludar     saludando con la mano (una sola pasada)
//   #bodytest/sentar      sentado
//   #bodytest/huesos      el esqueleto a la vista, dentro del cuerpo
//   #bodytest/morph       morphs exagerados (para comprobar que deforman)
//   #bodytest/forma       EDITOR DE FORMA real (los mandos del editor de SL):
//                         deforma el cuerpo/cara con avatar_lad.xml, igual que
//                         en Second Life
//
// Los ficheros se piden a `characterAssets.js` (fuente pública del visor de SL;
// con una sesión abierta los sirve el retransmisor). Todo lo que se ve aquí es
// geometría y animación REALES: lo único inventado son los colores planos,
// porque las texturas cocidas de verdad llegan por la sesión.

import * as THREE from "./three.js";
import { OrbitControls } from "./three.js";
import { AvatarMesh } from "./sl/avatarMesh.js";
import { fetchSystemBodyFiles, fetchCharacterTextures, SYSTEM_BODY_FILE_BY_PART, SYSTEM_TEXTURE_FILES } from "./sl/characterAssets.js";
import { buildIdleAnim, buildWalkAnim, buildRunAnim, buildWaveAnim, buildSitAnim } from "./sl/avatarPose.js";
import { buildAvatarMaterials } from "./sl/skinTexture.js";
import { SLAppearance } from "./sl/slAppearance.js";
import { loadAvatarLad, randomShapeValues, defaultShapeValues, genderedShapeValues, shapeSliders, avatarLadSummary } from "./sl/avatarLad.js";
import { diag as visorDiag } from "./diag.js";

const MODES = ["cara", "pose", "correr", "saludar", "sentar", "huesos", "morph", "falda", "forma"];

// Orden de los grupos del editor de forma (los que trae el XML, mas los dos
// atajos). "forma" abre con esta lista de presets.
const SHAPE_PRESETS = [
  { key: "defecto", label: "De serie" },
  { key: "femenina", label: "Femenina" },
  { key: "masculina", label: "Masculina" },
  { key: "aleatoria", label: "Aleatoria" },
];

export function createRealAvatarView(container, opts = {}) {
  const mode = MODES.includes(opts.mode) ? opts.mode : "quieto";
  const statusEl = opts.statusEl || null;
  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text;
    if (opts.onStatus) opts.onStatus(text);
  };

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

  // Luces de estudio. El avatar mira a -Z, así que la luz clave va DELANTE
  // (z negativa); si se pone detrás, la cara sale a contraluz.
  const key = new THREE.DirectionalLight(0xfff2e2, 2.4);
  key.position.set(2.2, 4.2, -3.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 18;
  key.shadow.camera.left = -2.5; key.shadow.camera.right = 2.5;
  key.shadow.camera.top = 2.5; key.shadow.camera.bottom = -2.5;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.8);
  fill.position.set(-3.4, 2.2, -1.8);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffe0c0, 0.8);
  rim.position.set(-0.6, 3.0, 4.4);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 0.55));

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(12, 48),
    new THREE.MeshStandardMaterial({ color: 0x3c434e, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(24, 24, 0x2b3038, 0x232830);
  grid.position.y = 0.001;
  scene.add(grid);

  // Capa de carga (los ficheros son ~400 KB y tardan un momento).
  const overlay = document.createElement("div");
  overlay.className = "raOverlay";
  overlay.innerHTML = "<span class=\"spin\"></span><span class=\"raText\">Cargando el cuerpo de sistema…</span>";
  container.appendChild(overlay);
  const overlayText = overlay.querySelector(".raText");

  const diag = ["avatar real · cargando el cuerpo de sistema…"];
  const paintDiag = () => { if (opts.onDiag) opts.onDiag(); };

  // --- el avatar -------------------------------------------------------------
  let avatar = null;
  let ready = false;
  let error = null;
  let skin = null;

  // Modo «huesos»: esferitas en cada articulación y una varilla al padre.
  let boneViz = null;
  function buildBoneViz(a) {
    const group = new THREE.Group();
    group.name = "huesos";
    const mat = new THREE.MeshBasicMaterial({ color: 0x6fe3ff });
    const dot = new THREE.SphereGeometry(0.012, 8, 6);
    const link = new THREE.LineBasicMaterial({ color: 0x3aa0c8 });
    const nodes = [];
    for (const bone of a.binding.bones) {
      const s = new THREE.Mesh(dot, mat);
      s.frustumCulled = false;
      group.add(s);
      let line = null;
      if (bone.parent && bone.parent.isBone) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
        line = new THREE.Line(g, link);
        line.frustumCulled = false;
        group.add(line);
      }
      nodes.push({ bone, sphere: s, line });
    }
    scene.add(group);
    return { group, nodes };
  }

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

  // --- animaciones -----------------------------------------------------------
  const anims = {};
  function buildAnims(a) {
    anims.idle = buildIdleAnim(a.binding);
    anims.walk = buildWalkAnim(a.binding);
    anims.run = buildRunAnim(a.binding);
    anims.wave = buildWaveAnim(a.binding);
    anims.sit = buildSitAnim(a.binding);
  }

  let playing = null;
  let waveInst = null;
  function play(name) {
    if (!avatar || !anims[name]) return;
    avatar.stopAll();
    waveInst = null;
    const inst = avatar.play(anims[name], { gain: 1 });
    if (name === "wave") waveInst = inst;
    playing = name;
  }

  // --- editor de forma (modo "forma") ----------------------------------------
  // Es el editor de forma de Second Life de verdad: los mandos salen de
  // avatar_lad.xml y escriben en el cuerpo/cara por morphs y huesos, no por
  // geometria inventada. Lo que se ve al mover un mando es lo que se veria en
  // el visor oficial.
  let shape = null;          // SLAppearance
  let shapePanel = null;     // nodo del panel
  let shapeGroupKey = "shape_body";
  let shapeTable = null;

  // Semilla fija: los presets «Femenina»/«Masculina» dan siempre el mismo
  // cuerpo, para poder comparar. «Aleatoria» le añade el reloj.
  const SHAPE_KEY = "visor-sl/forma";
  let shapeSliderEls = [];

  function mkEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function shapeCounts() {
    if (!shape) return "";
    const r = shape.resolved;
    return (r ? (r.counts.morphs + " morphs · " + r.counts.bones + " huesos · " + r.counts.volumes + " volúmenes") : "sin resolver")
      + " · " + shape.describeSex()
      + "\n" + avatarLadSummary(shapeTable);
  }

  function refreshCount() {
    if (!shapePanel) return;
    const c = shapePanel.querySelector(".raCount");
    if (c) c.textContent = shapeCounts();
  }

  function setShapePreset(key) {
    if (!shape || !shapeTable) return;
    shape.setSex("auto");
    if (key === "defecto") shape.setValues(defaultShapeValues(shapeTable));
    else if (key === "femenina") shape.setValues(genderedShapeValues(shapeTable, "female", { seed: SHAPE_KEY }));
    else if (key === "masculina") shape.setValues(genderedShapeValues(shapeTable, "male", { seed: SHAPE_KEY }));
    else if (key === "aleatoria") shape.setValues(randomShapeValues(shapeTable, SHAPE_KEY + ":" + Math.round(performance.now()), { amount: 0.6 }));
    shape.applyShape();
    renderShapeSliders();
    refreshCount();
    const st = shape.resolved;
    diag[diag.length - 1] = "forma " + shape.describeSex() + ": " + st.counts.morphs + " morphs, " + st.counts.bones + " huesos"
      + " · " + avatar.stats().systemVertices.toLocaleString("es") + " vértices";
    visorDiag.info("forma", "preset «" + key + "» · " + shape.describeSex() + " · " + st.counts.morphs + " morphs, " + st.counts.bones + " huesos, " + st.counts.volumes + " volúmenes");
    paintDiag();
  }

  function renderShapeSliders() {
    if (!shapePanel || !shapeTable) return;
    const host = shapePanel.querySelector(".raSliders");
    if (!host) return;
    host.textContent = "";
    shapeSliderEls = [];
    const group = shapeSliders(shapeTable).find((g) => g.key === shapeGroupKey) || shapeSliders(shapeTable)[0];
    if (!group) return;
    for (const s of group.sliders) {
      const row = mkEl("div", "raSlider" + (s.gender ? " raGender" : ""));
      const lab = mkEl("div", "raLab");
      lab.appendChild(mkEl("span", null, s.label));
      const val = mkEl("span", "raVal", "");
      lab.appendChild(val);
      const input = document.createElement("input");
      input.type = "range";
      input.min = s.min; input.max = s.max; input.step = (s.max - s.min) / 200 || 0.01;
      input.value = shape.getValue(s.id, s.def);
      const showVal = () => { val.textContent = s.gender ? (Number(input.value) > 0.5 ? "masculino" : "femenino") : Number(input.value).toFixed(2); };
      showVal();
      input.addEventListener("input", () => {
        showVal();
        if (s.gender) shape.setSex("auto");
        shape.setValue(s.id, parseFloat(input.value));
        shape.applyShape();
        refreshCount();
        visorDiag.detalle("forma", "mando «" + s.label + "» = " + Number(input.value).toFixed(3));
      });
      row.appendChild(lab);
      row.appendChild(input);
      if (s.gender) {
        const ends = mkEl("div", "raEnds");
        ends.appendChild(mkEl("span", null, s.labelMin || ""));
        ends.appendChild(mkEl("span", null, s.labelMax || ""));
        row.appendChild(ends);
      }
      host.appendChild(row);
      shapeSliderEls.push({ id: s.id, input, val, showVal });
    }
  }

  function buildShapePanel() {
    if (shapePanel) return;
    shapePanel = mkEl("div", "raShape");
    const tabs = mkEl("div", "raTabs");
    for (const p of SHAPE_PRESETS) {
      const b = mkEl("button", "bbtn", p.label);
      b.type = "button";
      b.addEventListener("click", (e) => { e.preventDefault(); setShapePreset(p.key); });
      tabs.appendChild(b);
    }
    const hide = mkEl("button", "bbtn", "Ocultar");
    hide.type = "button";
    hide.addEventListener("click", (e) => {
      e.preventDefault();
      shapePanel.hidden = !shapePanel.hidden;
      hide.textContent = shapePanel.hidden ? "Forma" : "Ocultar";
    });
    tabs.appendChild(hide);
    shapePanel.appendChild(tabs);

    const sel = document.createElement("select");
    for (const g of shapeSliders(shapeTable)) {
      const o = document.createElement("option");
      o.value = g.key;
      o.textContent = g.label + " (" + g.sliders.length + ")";
      sel.appendChild(o);
    }
    sel.value = shapeGroupKey;
    sel.addEventListener("change", () => { shapeGroupKey = sel.value; renderShapeSliders(); });
    shapePanel.appendChild(sel);

    shapePanel.appendChild(mkEl("div", "raSliders"));
    shapePanel.appendChild(mkEl("div", "raCount", ""));
    shapePanel.appendChild(mkEl("div", "raHint", "Estos mandos son los del editor de forma de SL: mueven morphs y huesos reales."));
    container.appendChild(shapePanel);
    renderShapeSliders();
    refreshCount();
  }

  async function initShape() {
    shapeTable = await loadAvatarLad();
    shape = new SLAppearance(avatar, { table: shapeTable });
    shape.setValues(genderedShapeValues(shapeTable, "female", { seed: SHAPE_KEY }));
    shape.applyShape();
    buildShapePanel();
    diag.push("editor de forma: " + shapeTable.editable.length + " mandos en " + shapeTable.groups.length + " grupos");
    visorDiag.info("forma", "editor de forma cargado: " + shapeTable.editable.length + " mandos en " + shapeTable.groups.length + " grupos · " + shape.describeSex());
    paintDiag();
  }


  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.6;
  controls.maxDistance = 8;
  controls.target.set(0, 1.0, 0);
  controls.update();
  let userTouched = false;
  const markTouched = () => { userTouched = true; };
  renderer.domElement.addEventListener("pointerdown", markTouched);
  renderer.domElement.addEventListener("wheel", markTouched, { passive: true });

  // --- carga ------------------------------------------------------------------
  (async () => {
    try {
      const total = Object.keys(SYSTEM_BODY_FILE_BY_PART).length;
      setStatus("Pidiendo el cuerpo de sistema (0/" + total + ")…");
      const bytes = await fetchSystemBodyFiles({
        onProgress: (done) => {
          setStatus("Pidiendo el cuerpo de sistema (" + done + "/" + total + ")…");
          if (overlayText) overlayText.textContent = "Cargando el cuerpo de sistema (" + done + "/" + total + ")…";
        },
      });
      avatar = new AvatarMesh(THREE, { name: "residente" });
      scene.add(avatar.group);
      avatar.loadSystemBody(bytes);

      // Piel, ojos y pelo: se piden las capas originales del visor y se
      // componen aqui (ver `skinTexture.js`). Si algo falla, el avatar se queda
      // con los colores planos de siempre en vez de quedarse a medias.
      try {
        const texTotal = SYSTEM_TEXTURE_FILES.length;
        if (overlayText) overlayText.textContent = "Pidiendo la piel (0/" + texTotal + ")…";
        setStatus("Pidiendo la piel (0/" + texTotal + ")…");
        const images = await fetchCharacterTextures(SYSTEM_TEXTURE_FILES, {
          onProgress: (done) => {
            const t = "Pidiendo la piel (" + done + "/" + texTotal + ")…";
            setStatus(t);
            if (overlayText) overlayText.textContent = t;
          },
        });
        const built = buildAvatarMaterials(THREE, images, {
          look: opts.look || undefined,
          amounts: opts.amounts || undefined,
          eye: { mesh: avatar.systemParts.get("eyeLeft").mesh },
          anisotropy: renderer.capabilities.getMaxAnisotropy ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4,
        });
        for (const name in built.materials) avatar.setPartMaterial(name, built.materials[name]);
        skin = { ...built, skinColor: built.skinColor, hairColor: built.hairColor };
      } catch (e) {
        diag.push("piel: no se pudo componer (" + (e && e.message ? e.message : e) + "), se usa color plano");
      }

      // La falda del cuerpo de sistema solo se dibuja cuando se lleva una falda
      // (su textura por defecto es transparente). Sin bakes que lo digan, se
      // oculta: si no, taparía las piernas con un tubo opaco.
      avatar.setPartVisible("skirt", mode === "falda");
      buildAnims(avatar);

      if (mode === "correr") play("run");
      else if (mode === "pose") play("walk");
      else if (mode === "saludar") play("wave");
      else if (mode === "sentar") play("sit");
      else play("idle");

      if (mode === "morph") {
        avatar.setMorphs({
          Big_Belly_Torso: 1, Big_Belly_Legs: 1, Breast_Gravity: 1, Big_Butt_Legs: 1,
          Big_Ears: 1, Pointy_Ears: 0.8, Squash_Stretch_Head: 1, Fat_Head: 1,
          Wide_Nose: 1, Bug_Eyed_Head: 1, Foot_Size: 1,
        });
      }

      if (mode === "forma") {
        setStatus("Pidiendo la tabla de forma de SL…");
        try {
          await initShape();
        } catch (e) {
          diag.push("forma: no se pudo cargar avatar_lad.xml (" + (e && e.message ? e.message : e) + ")");
          visorDiag.error("forma", "no se pudo cargar avatar_lad.xml: " + (e && e.message ? e.message : e));
          paintDiag();
        }
      }

      if (mode === "huesos") {
        boneViz = buildBoneViz(avatar);
        for (const p of avatar.systemParts.values()) {
          const m = p.object.material;
          if (m) { m.transparent = true; m.opacity = 0.14; m.depthWrite = false; m.side = THREE.DoubleSide; }
        }
      }

      // Encuadre
      camera.position.set(0.9, 1.55, -2.5);
      controls.target.set(0, 1.0, 0);
      if (mode === "cara") {
        controls.target.set(0, 1.68, 0);
        camera.position.set(0.12, 1.72, -0.55);
        controls.minDistance = 0.2; controls.maxDistance = 2.0; controls.enablePan = false;
      } else if (mode === "saludar") {
        camera.position.set(1.5, 1.5, -2.4);
      } else if (mode === "forma") {
        controls.target.set(0, 1.05, 0);
        camera.position.set(0.12, 1.25, -3.1);
        controls.minDistance = 0.5; controls.maxDistance = 8;
      }
      controls.update();

      const st = avatar.stats();
      const tri = st.systemTriangles;
      diag.length = 0;
      diag.push("cuerpo de sistema real · " + st.systemParts.length + " piezas · " + st.systemVertices.toLocaleString("es") + " vértices · " + tri.toLocaleString("es") + " triángulos");
      diag.push(st.bones + " huesos · animación «" + playing + "» · " + (mode === "huesos" ? "esqueleto a la vista" : "arrastra para orbitar"));
      diag.push("modos: " + ["#bodytest", "#bodytest/cara", "#bodytest/pose", "#bodytest/correr", "#bodytest/saludar", "#bodytest/sentar", "#bodytest/huesos", "#bodytest/forma"].join(" · "));
      paintDiag();
      setStatus("cuerpo de sistema real · " + st.systemVertices.toLocaleString("es") + " vértices, " + tri.toLocaleString("es") + " triángulos");
      overlay.remove();
      ready = true;
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      diag.length = 0;
      diag.push("no se pudo cargar el cuerpo de sistema: " + error);
      diag.push("¿red bloqueada hacia raw.githubusercontent.com? Con una sesión abierta esto lo sirve el retransmisor.");
      visorDiag.error("apariencia", "no se pudo cargar el cuerpo de sistema: " + error);
      paintDiag();
      setStatus("error al cargar el avatar real");
      if (overlayText) overlayText.textContent = "No se pudo cargar: " + error;
      overlay.querySelector(".spin").style.display = "none";
    }
  })();

  // --- bucle ------------------------------------------------------------------
  let t = 0;
  let spin = mode === "quieto" || mode === "huesos";
  let statusAcc = 0;

  function update(dt) {
    t += dt;
    if (avatar) {
      avatar.update(dt);
      // El saludo es de una sola pasada: al terminar se vuelve a empezar, para
      // que se pueda mirar sin esperar a recargar la página.
      if (waveInst && waveInst.finished) {
        avatar.stop(waveInst);
        waveInst = avatar.play(anims.wave, { gain: 1 });
      }
      if (spin && !userTouched) avatar.group.rotation.y = t * 0.35;
      if (boneViz) updateBoneViz();
    }
    controls.update();
    statusAcc += dt;
    if (statusAcc > 0.5 && ready) {
      statusAcc = 0;
      const tris = renderer.info.render.triangles;
      setStatus("avatar real · " + tris.toLocaleString("es") + " tris · animación «" + playing + "» · " + mode);
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
    controls.dispose();
    if (shapePanel) { shapePanel.remove(); shapePanel = null; shape = null; }
    if (avatar) avatar.dispose();
    scene.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.isLine && o.geometry && o.geometry.dispose) o.geometry.dispose();
    });
    renderer.dispose();
    overlay.remove();
  }

  return {
    scene, camera, renderer, update, resize, dispose, diag,
    mode,
    get avatar() { return avatar; },
    get ready() { return ready; },
    get error() { return error; },
    get skin() { return skin; },
    get playing() { return playing; },
    play,
    /** Reproduce una animación de las de serie por nombre. */
    setMode: (m) => { if (anims[m]) play(m); },
    /** Para el giro del plato giratorio (útil para mirar de frente). */
    setSpin: (v) => { spin = !!v; if (!v && avatar) avatar.group.rotation.y = 0; },
    /** El objeto de apariencia real (solo en el modo «forma»). */
    get appearance() { return shape; },
    /** Aplica un preset de forma: "defecto" | "femenina" | "masculina" | "aleatoria". */
    setShapePreset: (key) => setShapePreset(key),
    /** Los mandos de forma que hay ahora mismo (para depuración). */
    get shapeTable() { return shapeTable; },
    stats: () => (avatar ? avatar.stats() : null),
  };
}
