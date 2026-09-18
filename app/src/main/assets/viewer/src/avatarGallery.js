// avatarGallery.js -- banco de pruebas del avatar (ruta #avatartest).
//
// No forma parte del visor: es donde se mira el cuerpo a solas para ajustar
// proporciones, cara, pelo y ropa antes de meterlo en el mundo. Sirve una fila
// de avatares con aspectos distintos (presets + aleatorios) sobre un suelo
// neutro, con luz de estudio, y deja la camara orbitando o fija en la cara.
//
//   #avatartest          fila de 8 avatares girando
//   #avatartest/<n>      fila de n avatares (1..24)
//   #avatartest/cara     primer plano de una cara (para ajustar la cara)
//   #avatartest/pose     un avatar caminando, para ver la animacion

import * as THREE from "./three.js";
import { OrbitControls } from "./three.js";
import { createAvatarBody } from "./avatarBody.js";
import {
  defaultAppearance, randomAppearance, normalizeAppearance,
  PARAMS, OUTFIT_SLOTS, HAIR_STYLES, SKIN_TONES, HAIR_COLORS, CLOTH_COLORS,
} from "./avatarParams.js";

function presetAppearance(i, name) {
  const app = defaultAppearance(name);
  const P = app.params;
  const presets = [
    { genero: 1.0, altura: 0.42, corpulencia: 0.30, grasa: 0.30, musculo: 0.25, hombros: 0.30, pecho: 0.65, cintura: 0.55, caderas: 0.62, pelo: "melena", skin: SKIN_TONES[1], hair: HAIR_COLORS[4] },
    { genero: 0.0, altura: 0.78, corpulencia: 0.62, grasa: 0.35, musculo: 0.75, hombros: 0.80, pecho: 0.10, cintura: 0.35, caderas: 0.35, pelo: "corto", skin: SKIN_TONES[4], hair: HAIR_COLORS[0] },
    { genero: 0.75, altura: 0.55, corpulencia: 0.45, grasa: 0.40, musculo: 0.45, hombros: 0.42, pecho: 0.45, cintura: 0.55, caderas: 0.72, pelo: "coleta", skin: SKIN_TONES[3], hair: HAIR_COLORS[7] },
    { genero: 0.35, altura: 0.62, corpulencia: 0.55, grasa: 0.55, musculo: 0.50, hombros: 0.65, pecho: 0.20, cintura: 0.60, caderas: 0.50, pelo: "media melena", skin: SKIN_TONES[6], hair: HAIR_COLORS[2] },
    { genero: 0.9, altura: 0.35, corpulencia: 0.25, grasa: 0.28, musculo: 0.20, hombros: 0.28, pecho: 0.80, cintura: 0.62, caderas: 0.75, pelo: "melena", skin: SKIN_TONES[0], hair: HAIR_COLORS[9] },
    { genero: 0.15, altura: 0.72, corpulencia: 0.40, grasa: 0.30, musculo: 0.65, hombros: 0.70, pecho: 0.10, cintura: 0.40, caderas: 0.45, pelo: "rapado", skin: SKIN_TONES[8], hair: HAIR_COLORS[8] },
    { genero: 0.6, altura: 0.48, corpulencia: 0.70, grasa: 0.75, musculo: 0.30, hombros: 0.50, pecho: 0.40, cintura: 0.75, caderas: 0.70, pelo: "moño", skin: SKIN_TONES[2], hair: HAIR_COLORS[0] },
    { genero: 0.5, altura: 0.5, corpulencia: 0.5, grasa: 0.5, musculo: 0.5, hombros: 0.5, pecho: 0.5, cintura: 0.5, caderas: 0.5, pelo: "afro", skin: SKIN_TONES[5], hair: HAIR_COLORS[1] },
  ];
  const pr = presets[i % presets.length];
  for (const k of Object.keys(pr)) if (k in P) P[k] = pr[k];
  app.skin.color = pr.skin;
  app.outfit.hair.tipo = pr.pelo;
  app.outfit.hair.color = pr.hair;
  app.outfit.top = { tipo: ["camiseta", "blusa", "top", "camisa"][i % 4], color: CLOTH_COLORS[i % CLOTH_COLORS.length], patron: [null, "tela", "cuadros", "lunares"][i % 4] };
  app.outfit.bottom = { tipo: ["pantalon", "pantalon corto", "falda", "falda larga"][i % 4], color: CLOTH_COLORS[(i + 5) % CLOTH_COLORS.length], patron: [null, "denim", "rayas", "lino"][i % 4] };
  app.outfit.shoes = { tipo: ["zapatos", "botas", "deportivas", "sandalias"][i % 4], color: CLOTH_COLORS[(i + 9) % CLOTH_COLORS.length], patron: null };
  app.outfit.outer = { tipo: i % 3 === 0 ? "chaqueta" : "ninguno", color: CLOTH_COLORS[(i + 2) % CLOTH_COLORS.length], patron: null };
  app.outfit.hat = { tipo: i % 5 === 0 ? "gorra" : "ninguno", color: CLOTH_COLORS[(i + 3) % CLOTH_COLORS.length], patron: null };
  app.outfit.glasses = { tipo: i % 4 === 2 ? "gafas de sol" : "ninguna", color: 0x1a1a20, patron: null };
  return app;
}

export function createAvatarGallery(container, opts = {}) {
  const mode = opts.mode || "persp";
  const count = mode === "sheet" ? Math.max(1, opts.focus ? parseInt(opts.focus, 10) || 8 : 8) : (parseInt(opts.focus, 10) || 8);
  const sel = document.createElement("div");
  sel.className = "agHint";

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x11151d);

  const renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (renderer.domElement !== opts.canvas) container.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
  const height = 1.8;
  camera.position.set(0, height * 1.05, mode === "cara" ? -0.62 : -4.2);

  // Luces de estudio: una clave, un relleno y un hemisferio para que la piel no
  // salga plana ni negra por detras. OJO: el avatar mira hacia -Z, asi que la
  // luz clave tiene que estar DELANTE (z negativa); si se pone detras, la cara
  // sale a contraluz y plano, y los rasgos no se leen.
  const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
  key.position.set(2.6, 4.6, -4.0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 20;
  key.shadow.camera.left = -5; key.shadow.camera.right = 5; key.shadow.camera.top = 5; key.shadow.camera.bottom = -5;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.75);
  fill.position.set(-4.0, 2.6, -2.2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffe0c0, 0.7);
  rim.position.set(-0.8, 3.2, 5.0);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3228, 0.5));

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 48),
    new THREE.MeshStandardMaterial({ color: 0x3a414c, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const grid = new THREE.GridHelper(40, 40, 0x2a2f38, 0x22262e);
  grid.position.y = 0.001;
  scene.add(grid);

  // Una luz de cara para el primer plano (si no, el pelo ensombrece la cara).
  if (mode === "cara") {
    const face = new THREE.PointLight(0xfff4e8, 1.6, 8);
    face.position.set(0.5, height * 1.0, -1.1);
    scene.add(face);
  }

  // --- avatares ---
  const items = [];
  const spacing = 1.0;
  const bodies = [];
  function makeAvatar(i, app) {
    const body = createAvatarBody(app);
    bodies.push(body);
    scene.add(body.group);
    return body;
  }
  if (mode === "cara" || mode === "pose") {
    const app = presetAppearance(opts.focus === "pose" ? 1 : 0, "Avatar");
    if (mode === "pose") {
      app.outfit.outer.tipo = "ninguno";
      app.outfit.bottom.tipo = "pantalon";
      app.outfit.top.tipo = "camiseta";
    }
    const body = makeAvatar(0, app);
    body.group.position.set(0, 0, 0);
    items.push({ name: mode === "cara" ? "cara" : "pose", app, body });
  } else {
    const n = Math.max(1, Math.min(24, count));
    for (let i = 0; i < n; i++) {
      const name = ["Ana", "Bruno", "Carla", "Diego", "Elena", "Fabio", "Gala", "Hugo"][i % 8] + " " + (i + 1);
      const app = i < 8 ? presetAppearance(i, name) : normalizeAppearance(randomAppearance(1000 + i, name));
      const body = makeAvatar(i, app);
      body.group.position.set((i - (n - 1) / 2) * spacing, 0, 0);
      items.push({ name, app, body });
    }
  }

  let controls = null;
  if (mode !== "sheet") {
    controls = new OrbitControls(camera, renderer.domElement);
    const M0 = items[0] ? items[0].body.metrics : null;
    const bodyH = M0 ? M0.h : height;
    const headCenter = M0 ? M0.headY + M0.headH * 0.52 : height * 0.93;
    controls.target.set(0, mode === "cara" ? headCenter : bodyH * 0.5, 0);
    if (mode === "cara") {
      camera.position.set(0, headCenter + (M0 ? M0.headH * 0.10 : 0), -Math.max(0.42, bodyH * 0.34));
      controls.minDistance = 0.3; controls.maxDistance = 3; controls.enablePan = false;
    }
    if (mode !== "cara" && mode !== "pose") {
      const span = Math.max(1, items.length) * spacing;
      const dist = Math.max(3.6, span * 0.72 + 3.2);
      camera.position.set(0, bodyH * 0.62, -dist);
      controls.minDistance = 1.5;
      controls.maxDistance = dist * 2.2;
    }
    if (mode === "pose") {
      camera.position.set(-bodyH * 0.9, bodyH * 0.55, -bodyH * 1.5);
    }
    controls.update();
  }

  let t = 0;
  let spin = mode !== "cara";

  function update(dt) {
    t += dt;
    if (spin && mode !== "cara" && !controls) for (const it of items) it.body.group.rotation.y = t * 0.5;
    // Posear los cuerpos: en la galeria normal, todos "respiran"; en modo pose,
    // uno camina para ver el ciclo.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (mode === "pose") {
        const phase = t * 6.5;
        it.body.group.position.z = Math.sin(t * 0.7) * 0.0;
        it.body.animate({ speed: 3.2, moving: true, grounded: true, phase, dt });
      } else if (mode === "cara") {
        it.body.animate({ speed: 0, moving: false, grounded: true, phase: 0, dt });
      } else {
        it.body.animate({ speed: 0, moving: false, grounded: true, phase: 0, dt });
      }
    }
    if (controls) controls.update();
    if (mode === "cara") {
      // mirar la cara de frente
      const M0 = items[0] ? items[0].body.metrics : null;
      const headCenter = M0 ? M0.headY + M0.headH * 0.52 : height * 0.93;
      camera.lookAt(0, headCenter, 0);
    }
  }

  function resize(w, h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function dispose() {
    for (const it of items) it.body.dispose();
    scene.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.isMesh && o.material) { /* los materiales del cuerpo los libera el body */ }
    });
    renderer.dispose();
    sel.remove();
  }

  const stats = items.map((it) => ({ name: it.name, triangles: 0 }));
  const diag = [
    "banco de pruebas del avatar · " + items.length + " cuerpos",
    "arrastra para orbitar · rueda para acercar",
  ];

  if (mode === "cara") {
    const box = document.createElement("div");
    box.className = "agHint";
    box.style.cssText = "position:absolute;left:8px;bottom:8px;padding:6px 10px;background:rgba(10,12,16,.7);color:#dfe6ef;font:12px system-ui;border-radius:8px;z-index:5";
    box.textContent = "primer plano de la cara · arrastra para girar · rueda para acercar";
    container.appendChild(box);
  }

  return {
    scene, camera, renderer, update, resize, dispose, stats, diag,
    items, setSpin: (v) => { spin = !!v; },
    get bodies() { return bodies; },
    setAppearanceOf: (i, app) => { if (items[i]) items[i].body.setAppearance(app); },
  };
}
