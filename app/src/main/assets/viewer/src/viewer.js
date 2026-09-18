// viewer.js -- el visor: escena, camara estilo SL, controles y bucle.
//
// Convencion de coordenadas: three.js en metros (X este, Y arriba, Z sur);
// slX = x + 128, slY = 128 - z. Altura de SL = Y.
//
// Camara (estilo Genshin Impact):
//   - Arrastrar con un dedo (o el boton izquierdo) orbita la camara alrededor
//     del avatar; se puede andar con el joystick y mirar a la vez, porque el
//     joystick vive en la mitad izquierda y el arrastre en el resto.
//   - Arrastrar hacia arriba mira hacia arriba y hacia la derecha gira a la
//     derecha (`pitch` es la inclinacion de la mirada, + arriba, en los dos
//     modos de camara, asi que el gesto nunca cambia de sentido).
//   - Pinza de dos dedos (o rueda del raton): acerca y aleja. Por debajo de
//     0.9 m la camara entra en la cabeza y el avatar se oculta (primera persona).
//   - Tecla F: camara libre (vuela sola con WASD, el avatar se queda quieto).
//
// Teclas: WASD/flechas andar, Mayus correr, Espacio saltar (o subir volando),
// C volar, E/Q subir/bajar volando, F camara libre, P pausar el tiempo,
// 1..4 hora del dia, H ocultar el HUD. En pantalla: joystick analogico (el
// borde corre), botones de Salto/Correr/Volar y, volando, Subir/Bajar.

import * as THREE from "./three.js";
import { Terrain, createWater, createSky, DayCycle, applySky, REGION_SIZE, ENV_INTENSITY } from "./region.js";
import { World } from "./world.js";
import { buildSandbox } from "./sandbox.js";
import { Avatar, AVATAR } from "./avatar.js";
import { loadStoredShape, saveStoredShape } from "./sl/shapeStore.js";

const KEY_MAP = {
  KeyW: "forward", ArrowUp: "forward",
  KeyS: "back", ArrowDown: "back",
  KeyA: "left", ArrowLeft: "left",
  KeyD: "right", ArrowRight: "right",
  Space: "up", KeyE: "up", KeyQ: "down",
};

export function createViewer(container, opts = {}) {
  const T = THREE;
  const canvas = opts.canvas;

  // --- render ---
  // Antialias solo cuando la pantalla no es de alta densidad: en moviles (dpr
  // alto) el MSAA cuesta mucho relleno y no hace falta, porque los pixeles ya
  // son diminutos. Ahi lo que compensa es poder subir la resolucion interna.
  const rawDpr = window.devicePixelRatio || 1;
  const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  // Presupuesto de pixeles: el visor es limitado por relleno, asi que ni un
  // movil con pantalla enorme ni un escritorio 4K deben renderizar mas de la
  // cuenta. En un movil (puntero grueso) el liston baja mucho mas.
  const PIXEL_BUDGET = coarse ? 2.2e6 : 9e6;
  let baseDpr = 1;
  const fitBaseDpr = () => Math.min(rawDpr, 2, Math.sqrt(PIXEL_BUDGET / Math.max(1, window.innerWidth * window.innerHeight)));
  baseDpr = fitBaseDpr();
  const useAA = opts.antialias === undefined ? rawDpr < 1.75 : !!opts.antialias;
  // `captura` (en la URL o en el hash) mantiene el buffer de dibujo despues de
  // presentar el fotograma: es lo que permite capturar el canvas con
  // `toDataURL()` desde fuera del fotograma (informes de depuracion). Cuesta un
  // poco de rendimiento, asi que solo se activa a mano.
  const preserveBuffer = opts.preserveDrawingBuffer !== undefined
    ? !!opts.preserveDrawingBuffer
    : /(?:^|[?&#/])captura/.test(location.search + location.hash);
  const renderer = new T.WebGLRenderer({ canvas, antialias: useAA, preserveDrawingBuffer: preserveBuffer, powerPreference: "high-performance" });
  renderer.setPixelRatio(baseDpr);
  renderer.shadowMap.enabled = opts.shadows !== false;
  renderer.shadowMap.type = T.PCFShadowMap;
  // El mapa de sombras no se re-renderiza en cada frame: cuesta ~25% del frame
  // y en una escena casi estatica no cambia. Se marca sucio cuando el sol o el
  // avatar se mueven, y hay un refresco de seguridad de 5 Hz para no perder
  // sombras de prims que mueven sus scripts (ver el refresco en update()).
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new T.Scene();
  scene.background = new T.Color(0xbcd2ef);
  scene.fog = new T.Fog(0xbcd2ef, 120, 560);

  const camera = new T.PerspectiveCamera(60, 1, 0.08, 6000);

  // --- luces ---
  const sun = new T.DirectionalLight(0xfff0c9, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1536, 1536);
  const sc = sun.shadow.camera;
  sc.near = 1; sc.far = 320; sc.left = -44; sc.right = 44; sc.top = 44; sc.bottom = -44;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.022;
  // Resolucion del mapa de sombras segun la calidad: en una GPU modesta con la
  // pantalla grande, 1536² de sombras cuesta mas que el propio render.
  const SHADOW_RES = [512, 1024, 1536];
  function setShadowRes(n) {
    if (sun.shadow.mapSize.x === n) return;
    sun.shadow.mapSize.set(n, n);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    renderer.shadowMap.needsUpdate = true;
  }
  setShadowRes(SHADOW_RES[2]);
  // El alcance de las sombras tambien sigue a la calidad: un frustum pequeno con
  // el mapa pequeno mantiene la densidad de texeles (y las sombras cercanas al
  // avatar, que es donde se miran) en vez de emborronar 88 m.
  function setShadowFrustum(half) {
    if (sc.right === half) return;
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
    sc.far = Math.max(120, half * 6);
    sc.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = true;
  }
  scene.add(sun);
  scene.add(sun.target);
  const hemi = new T.HemisphereLight(0xbcd2ef, 0x20242c, 1.0);
  scene.add(hemi);

  // --- cielo, agua, terreno ---
  const sky = createSky({ radius: 3000 });
  scene.add(sky.mesh);

  const terrainCells = opts.terrainCells || (window.devicePixelRatio > 2 || window.innerWidth < 520 ? 128 : 256);
  const terrain = new Terrain({ seed: opts.seed === undefined ? 20260917 : opts.seed, cells: terrainCells, waterLevel: 20 });

  const water = createWater({ size: REGION_SIZE * 6, level: terrain.waterLevel, terrain });
  scene.add(water.mesh);

  const cycle = new DayCycle({ hour: opts.hour === undefined ? 10.2 : opts.hour, minutesPerDay: opts.minutesPerDay === undefined ? 26 : opts.minutesPerDay });
  const env = { scene, sun, hemi, water };
  applySky(sky, cycle, env);

  // --- luz de entorno reflejada (PMREM) ---
  // Un material metalico sin mapa de entorno no tiene nada que reflejar y sale
  // negro. Horneamos el cielo a un PMREM y lo ponemos como scene.environment:
  // los metales reflejan el cielo, el agua cobra brillo y todo gana fisica.
  // El horneado cuesta, asi que se limita a cuando el sol ha cambiado bastante.
  // El peso del entorno (ENV_INTENSITY) llega de region.js; aqui solo se
  // hornea y se reparte.
  let pmrem = null;
  try { pmrem = new T.PMREMGenerator(renderer); } catch (e) { pmrem = null; }
  const envScene = new T.Scene();
  const envSkyMesh = new T.Mesh(sky.mesh.geometry, sky.mesh.material);
  envScene.add(envSkyMesh);
  let envRT = null, envBakedElev = -999, envBakedAt = -99, envReady = false;

  function setEnvIntensity(root) {
    root.traverse((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : null;
      if (!mats) return;
      for (const m of mats) if (m && m.isMeshStandardMaterial) m.envMapIntensity = ENV_INTENSITY;
    });
  }

  function bakeEnvironment(force) {
    if (!pmrem) return;
    const elevKey = Math.round(cycle.sunElev * 6);
    if (!force) {
      if (envReady && elevKey === envBakedElev) return;
      if (envReady && elapsed - envBakedAt < 3) return;
    }
    try {
      const rt = pmrem.fromScene(envScene, 0, 0.1, 5000);
      const old = envRT;
      scene.environment = rt.texture;
      envRT = rt;
      envBakedElev = elevKey;
      envBakedAt = elapsed;
      // El cielo ya ilumina: se rebaja la hemisferica para no doblar ambiente.
      env.ambientFactor = 0.34;
      setEnvIntensity(scene);
      envReady = true;
      if (old && old !== rt) old.dispose();
    } catch (e) { /* sin entorno: los metales vuelven a salir planos, no rompe nada */ }
  }

  // --- mundo ---
  const world = new World(T, { lod: 3 });
  scene.add(world.group);
  // El sandbox puede aplanar terreno (solares) antes de que se construya la
  // malla, asi que primero se rellena el mundo y despues se mallan las alturas.
  const sandbox = buildSandbox(world, terrain);
  const terrainMesh = terrain.build();
  scene.add(terrainMesh);
  // Ahora que los solares esculpidos ya cambiaron las alturas, el agua puede
  // leer el fondo real y aclararse en las orillas.
  water.syncTerrain();

  // --- avatar ---
  // `realBody` monta el cuerpo de sistema de Second Life (carga en diferido;
  // hasta que llega se ve el procedural). Se puede apagar con `?body=proc` o
  // desde `opts.realBody` para comparar o ahorrar ancho de banda.
  const realBody = opts.realBody === undefined
    ? !/[?&]body=proc\b/.test(location.search)
    : !!opts.realBody;
  const avatar = new Avatar(T, {
    position: sandbox.spawn.clone(), realBody,
    // Los bakes (BoM) llegan como uuid: de aqui salen sus texturas.
    resolveTexture: (uuid) => world.getAssetTexture(uuid),
    shapeSeed: opts.shapeSeed,
  });
  scene.add(avatar.group);

  // La forma real guardada (la del editor de forma, `#bodytest/forma`) se aplica
  // al avatar del mundo en cuanto llega: asi el residente se ve deformado igual
  // que en Second Life. Es asincrono a proposito: no bloquea el arranque.
  loadStoredShape().then((shape) => {
    if (shape && avatar.setShape) avatar.setShape(shape);
  }).catch((e) => { /* sin forma guardada: se queda la de fabrica */ });

  // --- camara / entrada ---
  const input = {
    forward: false, back: false, left: false, right: false,
    up: false, down: false, run: false, jump: false,
  };
  // La camara, como en Genshin: el arrastre orbita alrededor del avatar y el
  // joystick lo mueve A LA VEZ (cada pulgar manda en su mitad de la pantalla).
  // `pitch` es la inclinacion de la MIRADA en los dos modos, positivo hacia
  // arriba, asi que el mismo gesto hace lo mismo siempre:
  //   arrastrar hacia arriba     -> mirar hacia arriba (antes iba al reves)
  //   arrastrar hacia la derecha -> girar a la derecha
  // Con `pitch` negativo (por defecto) la camara queda por encima y detras del
  // avatar, mirando un poco hacia abajo, que es el plano de Genshin.
  const cam = {
    yaw: 0, pitch: -0.14, dist: 4.6, min: 0.35, max: 26, locked: false,
    sens: 0.0042, invertY: false, fov: 60,
    mode: "follow", pos: new T.Vector3(), target: new T.Vector3(), freeSpeed: 12,
  };
  // Buffer del salto: pulsar un pelin antes de tocar el suelo tambien salta.
  let jumpBuffer = 0;
  const JUMP_BUFFER = 0.16;
  const DEAD_ZONE = 0.16;
  const state = { paused: false, timeScale: 1, hudHidden: false, fps: 0, tris: 0, flying: false, quality: 1, autoQuality: true };

  const el = container || (canvas && canvas.parentElement) || document.body;
  const touch = {
    pad: document.getElementById("joyPad"),
    base: document.getElementById("joyBase"),
    knob: document.getElementById("joyKnob"),
    jump: document.getElementById("actJumpBtn"),
    run: document.getElementById("actRunBtn"),
    fly: document.getElementById("actFlyBtn"),
    upBtn: document.getElementById("actUpBtn"),
    downBtn: document.getElementById("actDownBtn"),
    vec: { x: 0, y: 0 }, active: false, id: null,
    runLock: false, cx: 0, cy: 0, rad: 58,
    _flying: false, _run: false,
  };

  function setKey(code, down) {
    const a = KEY_MAP[code];
    if (a) { input[a] = down; return true; }
    return false;
  }

  function onKeyDown(e) {
    if (e.target && /input|textarea/i.test(e.target.tagName || "")) return;
    if (setKey(e.code, true)) {
      if (e.code === "Space") { jumpBuffer = JUMP_BUFFER; e.preventDefault(); }
      return;
    }
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") input.run = true;
    else if (e.code === "KeyC") toggleFly();
    else if (e.code === "KeyF") {
      if (cam.mode === "follow") {
        cam.mode = "free";
        cam.pos.set(avatar.position.x, avatar.position.y + AVATAR.eyeHeight, avatar.position.z);
      } else {
        cam.mode = "follow";
      }
    }
    else if (e.code === "KeyP") state.paused = !state.paused;
    else if (e.code === "KeyH") { state.hudHidden = !state.hudHidden; document.body.classList.toggle("hud-off", state.hudHidden); }
    else if (e.code === "Digit1") cycle.setHour(7);
    else if (e.code === "Digit2") cycle.setHour(12);
    else if (e.code === "Digit3") cycle.setHour(19.2);
    else if (e.code === "Digit4") cycle.setHour(23.5);
  }
  function onKeyUp(e) {
    if (setKey(e.code, false)) return;
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") input.run = false;
  }

  // --- puntero: un dedo mira, dos dedos acercan ----------------------------
  // Los dos pulgares cuentan por separado: el joystick vive en su propio
  // elemento (mitad izquierda) y el arrastre de camara empieza en el canvas
  // (mitad derecha), asi que se puede andar y mirar a la vez. Un dedo gira la
  // camara; dos la acercan o la alejan (como la pinza de Genshin).
  const drag = { active: false, id: null, x: 0, y: 0, moved: 0 };
  const pointers = new Map();
  let pinchSpan = 0;

  function pointerSpan() {
    const p = [...pointers.values()];
    return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
  }

  function onPointerDown(e) {
    if (cam.locked) return;             // el gizmo del editor se ha quedado con el arrastre
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      drag.active = true; drag.id = e.pointerId; drag.x = e.clientX; drag.y = e.clientY; drag.moved = 0;
    } else {
      // Con dos dedos manda la pinza: el arrastre se suelta y no vuelve hasta
      // que se levanten los dos (si no, al soltar un dedo habria un tiron).
      drag.active = false;
      if (pointers.size === 2) pinchSpan = pointerSpan();
    }
    // La captura del puntero puede fallar si el id no esta activo (eventos
    // sinteticos) y no es imprescindible: el arrastre sigue funcionando.
    try { canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
  }
  function onPointerMove(e) {
    if (cam.locked) return;
    const p = pointers.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
    if (pointers.size >= 2) {
      const d = pointerSpan();
      if (pinchSpan > 0 && d > 0) {
        const k = pinchSpan / d;
        if (cam.mode === "free") cam.freeSpeed = Math.max(2, Math.min(90, cam.freeSpeed * k));
        else cam.dist = Math.max(cam.min, Math.min(cam.max, cam.dist * k));
      }
      pinchSpan = d;
      return;
    }
    if (!drag.active || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
    cam.yaw -= dx * cam.sens;
    cam.pitch += (cam.invertY ? dy : -dy) * cam.sens;
    cam.pitch = Math.max(-1.28, Math.min(1.28, cam.pitch));
  }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchSpan = 0;
    if (e.pointerId === drag.id) { drag.active = false; drag.id = null; }
  }
  function onWheel(e) {
    e.preventDefault();
    if (cam.mode === "free") cam.freeSpeed = Math.max(2, Math.min(90, cam.freeSpeed * (e.deltaY > 0 ? 0.88 : 1.14)));
    else cam.dist = Math.max(cam.min, Math.min(cam.max, cam.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
  }

  // --- joystick de la mitad izquierda ---------------------------------------
  // Flota: la base se pone debajo del dedo alli donde se apoye dentro de su
  // zona, y al soltar vuelve a su sitio. Es lo que hace Genshin, y evita tener
  // que apuntar a un circulo fijo que no siempre cae comodo.
  function stickRadius() {
    if (touch.base && touch.base.offsetWidth) touch.rad = touch.base.offsetWidth / 2;
    return touch.rad;
  }
  function placeStick(cx, cy) {
    touch.cx = cx; touch.cy = cy;
    if (touch.base) { touch.base.style.left = cx + "px"; touch.base.style.top = cy + "px"; }
  }
  function parkStick() {
    if (!touch.pad || !touch.base) return;
    const r = touch.pad.getBoundingClientRect();
    if (r.width < 10) return;              // la capa tactil esta oculta: nada que colocar
    const rad = stickRadius(), m = 14;
    placeStick(r.left + rad + m, r.bottom - rad - m);
  }
  function stickFrom(e) {
    const rad = stickRadius();
    let dx = (e.clientX - touch.cx) / rad, dy = (e.clientY - touch.cy) / rad;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    touch.vec.x = dx; touch.vec.y = dy;
    if (touch.knob) touch.knob.style.transform = "translate(" + (dx * rad * 0.62) + "px," + (dy * rad * 0.62) + "px)";
  }
  function onStickDown(e) {
    if (!touch.pad || touch.active) return;
    touch.active = true; touch.id = e.pointerId;
    const rad = stickRadius(), m = 8;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    // La base se centra donde ha caido el dedo (como en Genshin) y solo se
    // corrige para que el anillo entero quepa en la pantalla; si se recortara
    // contra el recuadro del joystick, un toque cerca del borde daria un vector
    // de golpe en vez de partir del centro.
    placeStick(cl(e.clientX, rad + m, window.innerWidth - rad - m),
      cl(e.clientY, rad + m, window.innerHeight - rad - m));
    touch.vec.x = 0; touch.vec.y = 0;
    if (touch.knob) touch.knob.style.transform = "translate(0px,0px)";
    try { touch.pad.setPointerCapture && touch.pad.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    document.body.classList.add("joy");
    e.preventDefault();
  }
  function onStickMove(e) { if (touch.active && e.pointerId === touch.id) { stickFrom(e); e.preventDefault(); } }
  function onStickUp(e) {
    if (e.pointerId !== touch.id) return;
    touch.active = false; touch.id = null; touch.vec.x = 0; touch.vec.y = 0;
    if (touch.knob) touch.knob.style.transform = "translate(0px,0px)";
    document.body.classList.remove("joy");
    parkStick();
  }

  // Boton que se mantiene pulsado (subir/bajar volando).
  function holdBtn(el2, onDown, onUp) {
    if (!el2) return;
    on(el2, "pointerdown", (e) => { onDown(); e.preventDefault(); });
    on(el2, "pointerup", (e) => { onUp(); e.preventDefault(); });
    on(el2, "pointercancel", () => onUp());
    on(el2, "pointerleave", () => onUp());
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  const onContextMenu = (e) => e.preventDefault();
  canvas.addEventListener("contextmenu", onContextMenu);
  // La capa tactil vive en el HTML y NO se recrea al cambiar de escena, asi que
  // sus escuchadores hay que quitarlos al desmontar; si se acumularan, el boton
  // de correr (que es un interruptor) se activaria y desactivaria a la vez.
  const touchOff = [];
  const on = (target, type, fn) => {
    if (!target) return;
    target.addEventListener(type, fn);
    touchOff.push([target, type, fn]);
  };
  on(touch.pad, "pointerdown", onStickDown);
  on(touch.pad, "pointermove", onStickMove);
  on(touch.pad, "pointerup", onStickUp);
  on(touch.pad, "pointercancel", onStickUp);
  on(touch.pad, "lostpointercapture", onStickUp);
  on(touch.jump, "pointerdown", (e) => { jumpBuffer = JUMP_BUFFER; e.preventDefault(); });
  // Correr es un interruptor (no hay que mantenerlo) y empujar el joystick
  // hasta el borde tambien corre, asi que el boton es para cuando quieres
  // correr sin llevar el pulgar al tope.
  on(touch.run, "pointerdown", (e) => { touch.runLock = !touch.runLock; e.preventDefault(); });
  on(touch.fly, "pointerdown", (e) => { toggleFly(); e.preventDefault(); });
  holdBtn(touch.upBtn, () => { input.up = true; }, () => { input.up = false; });
  holdBtn(touch.downBtn, () => { input.down = true; }, () => { input.down = false; });
  if (coarse) document.body.classList.add("touch");
  requestAnimationFrame(parkStick);

  function resize(w, h) {
    cssW = Math.max(1, w); cssH = Math.max(1, h);
    baseDpr = fitBaseDpr();
    renderer.setPixelRatio(baseDpr * state.quality);
    renderer.setSize(cssW, cssH, false);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();
    parkStick();
  }

  // --- calidad adaptativa ----------------------------------------------------
  // El visor es limitado por relleno (los triangulos y las llamadas de dibujo son
  // pocos), asi que la palanca es la resolucion interna: si el fps cae, se baja
  // el factor de resolucion, y si sobra, se vuelve a subir. Asi el visor se
  // mantiene fluido en un movil modesto sin renunciar a nitidez en uno potente.
  let cssW = 1, cssH = 1;
  let adaptTimer = 0;
  const QUALITY_MIN = 0.45;
  function applyQuality() {
    renderer.setPixelRatio(baseDpr * state.quality);
    renderer.setSize(cssW, cssH, false);
    // A mas calidad de imagen, mas resolucion (y mas alcance) de sombras.
    if (state.quality >= 0.8) { setShadowRes(SHADOW_RES[2]); setShadowFrustum(44); }
    else if (state.quality >= 0.5) { setShadowRes(SHADOW_RES[1]); setShadowFrustum(36); }
    else { setShadowRes(SHADOW_RES[0]); setShadowFrustum(30); }
  }
  function adapt(dt, fps) {
    if (!state.autoQuality) return;
    adaptTimer -= dt;
    if (adaptTimer > 0) return;
    let q = state.quality;
    // El paso es proporcional a lo lejos que esta el fps del objetivo, asi que
    // una caida grande (pantalla grande en GPU modesta) se corrige en un par de
    // ajustes en vez de ir bajando un 12% por vez durante varios segundos.
    if (fps < 50 && q > QUALITY_MIN) {
      const step = Math.max(0.68, Math.min(0.96, Math.sqrt(fps / 58)));
      q = Math.max(QUALITY_MIN, q * step);
    } else if (fps > 58 && q < 1) q = Math.min(1, q * 1.06);
    if (Math.abs(q - state.quality) > 0.005) {
      state.quality = q;
      applyQuality();
      adaptTimer = 1.2;          // dejar que el fps se estabilice antes de decidir
    } else {
      adaptTimer = 0.5;
    }
  }

  function cameraTarget(out) {
    return (out || cam.target).set(avatar.position.x, avatar.position.y + AVATAR.eyeHeight * 0.95, avatar.position.z);
  }

  const _dir = new T.Vector3();
  const _want = new T.Vector3();
  let elapsed = 0;
  // Estado del mapa de sombras (ver `renderer.shadowMap.autoUpdate` arriba).
  let shadowAcc = 0;
  let shadowLastElev = 99;
  const _shadowLastAv = new T.Vector3(1e9, 1e9, 1e9);

  function update(dt) {
    dt = Math.max(0, Math.min(dt, 0.05));
    if (!state.paused) { cycle.advance(dt * state.timeScale); elapsed += dt; }
    water.update(elapsed);
    env.time = elapsed;
    applySky(sky, cycle, env);
    bakeEnvironment(false);

    // --- entrada del jugador (teclado + joystick) ---
    // El joystick es analogico: la magnitud manda la velocidad (empujar poco es
    // andar despacio) y empujarlo hasta el borde hace correr, como en Genshin.
    // El teclado suma +-1 a los mismos ejes.
    jumpBuffer = Math.max(0, jumpBuffer - dt);
    const jx = touch.vec.x, jy = touch.vec.y;
    const jmag = Math.min(1, Math.hypot(jx, jy));
    let sf = 0, ss = 0;
    if (jmag > DEAD_ZONE) {
      const k = (jmag - DEAD_ZONE) / (1 - DEAD_ZONE);
      sf = (-jy / jmag) * k;
      ss = (jx / jmag) * k;
    }
    const moveF = ((input.forward ? 1 : 0) - (input.back ? 1 : 0)) + sf;
    const moveS = ((input.right ? 1 : 0) - (input.left ? 1 : 0)) + ss;
    const running = !!(input.run || touch.runLock || jmag > 0.92);
    const moveIn = {
      moveF, moveS,
      forward: moveF > 0.25, back: moveF < -0.25,
      left: moveS < -0.25, right: moveS > 0.25,
      up: input.up, down: input.down, run: running,
      jump: jumpBuffer > 0,
      cameraYaw: cam.yaw,
    };

    if (cam.mode === "follow") {
      avatar.update(dt, moveIn, { terrain, world });
      // El salto se gasta al despegar; si no, el buffer caduca solo.
      if (jumpBuffer > 0 && avatar.grounded) jumpBuffer = 0;
    } else {
      avatar.update(dt, { forward: false, back: false, left: false, right: false, up: false, down: false, run: false, cameraYaw: cam.yaw }, { terrain, world });
      // camara libre: vuela mirando hacia donde apunta
      const sp = cam.freeSpeed * (running ? 2.4 : 1);
      const cp = Math.cos(cam.pitch), sp2 = Math.sin(cam.pitch);
      const fx = -Math.sin(cam.yaw) * cp, fy = sp2, fz = -Math.cos(cam.yaw) * cp;
      const rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
      const vUp = (input.up ? 1 : 0) - (input.down ? 1 : 0);
      _want.set(fx * moveF + rx * moveS, fy * moveF + vUp, fz * moveF + rz * moveS);
      if (_want.lengthSq() > 1e-6) _want.normalize().multiplyScalar(sp);
      cam.pos.addScaledVector(_want, dt);
      const minY = terrain.heightAt(cam.pos.x, cam.pos.z) + 0.25;
      if (cam.pos.y < minY) cam.pos.y = minY;
    }
    paintControls(running);

    // --- camara ---
    cameraTarget(cam.target);
    if (cam.mode === "follow") {
      const cp = Math.cos(cam.pitch);
      // Direccion de la MIRADA (positivo = arriba) y la camara detras, a lo
      // largo de -mirada: con el cabeceo por defecto (un poco hacia abajo) la
      // camara queda por encima y detras del avatar, que es el plano de Genshin.
      _dir.set(-Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp);
      _want.copy(cam.target).addScaledVector(_dir, -cam.dist);
      const gy = terrain.heightAt(_want.x, _want.z) + 0.35;
      if (_want.y < gy) _want.y = gy;
      if (cam._init !== true) { cam.pos.copy(_want); cam._init = true; }
      cam.pos.lerp(_want, Math.min(1, 14 * dt));
      camera.position.copy(cam.pos);
      camera.lookAt(cam.target);
      // Por debajo de 0,9 m la camara esta dentro de la cabeza: primera persona.
      avatar.group.visible = cam.dist > 0.9;
    } else {
      const cp = Math.cos(cam.pitch);
      _dir.set(-Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp);
      camera.position.copy(cam.pos);
      camera.lookAt(cam.pos.x + _dir.x, cam.pos.y + _dir.y, cam.pos.z + _dir.z);
      avatar.group.visible = true;
    }

    // la sombra sigue al avatar (para tener resolucion util cerca de el)
    const ld = cycle.lightDirection || cycle.sunDirection;
    sun.position.set(avatar.position.x + ld.x * 110,
      avatar.position.y + ld.y * 110,
      avatar.position.z + ld.z * 110);
    sun.target.position.copy(avatar.position);
    sun.target.updateMatrixWorld();

    // --- refresco del mapa de sombras ---
    // El sol sigue al avatar, asi que la camara de sombras solo se traslada:
    // mientras el avatar se mueva menos de 20 cm, el mapa sigue valiendo. Se
    // rehace cuando el sol cambia de direccion, cuando el avatar camina, y cada
    // 200 ms por si algo (scripts, construccion) cambio sin avisar.
    shadowAcc += dt;
    const elev = cycle.sunElev;
    const moved = _shadowLastAv.distanceToSquared(avatar.position) > 0.04;
    if (moved || shadowAcc > 0.2 || Math.abs(elev - shadowLastElev) > 0.004) {
      renderer.shadowMap.needsUpdate = true;
      shadowAcc = 0;
      shadowLastElev = elev;
      _shadowLastAv.copy(avatar.position);
    }

    adapt(dt, state.fps);

    return state;
  }

  // El estado real (volando, corriendo) se refleja en los botones tactiles y en
  // el <body> solo cuando cambia: asi el CSS puede esconder "Correr" y sacar
  // "Subir/Bajar" al volar sin tocar el DOM en cada fotograma.
  function paintControls(running) {
    if (touch._flying !== !!avatar.flying) {
      touch._flying = !!avatar.flying;
      document.body.classList.toggle("avatar-flying", !!avatar.flying);
      if (touch.fly) touch.fly.classList.toggle("on", !!avatar.flying);
    }
    const run = running === undefined ? !!touch._run : !!running;
    if (touch._run !== run) {
      touch._run = run;
      if (touch.run) touch.run.classList.toggle("on", run);
    }
  }

  function setTime(h) { return cycle.setHour(h); }
  function toggleFly() {
    avatar.flying = !avatar.flying;
    if (avatar.flying) { avatar.velocity.y = 0; input.up = false; input.down = false; }
    paintControls();
    return avatar.flying;
  }
  function togglePause() { state.paused = !state.paused; return state.paused; }
  function setTimeScale(s) { state.timeScale = s; return s; }
  function teleport(x, y, z) { avatar.setPosition(new T.Vector3(x, y, z)); cam._init = false; }
  // Recentrar: la camara vuelve detras del avatar mirandole a la espalda (util
  // despues de mirar alrededor y perder el norte).
  function recenter() { cam.yaw = avatar.yaw; cam.pitch = -0.14; cam._init = false; return true; }
  function spawnOnTerrain() {
    const s = sandbox.spawn;
    avatar.setPosition(new T.Vector3(s.x, terrain.heightAt(s.x, s.z) + 1.2, s.z));
    cam._init = false;
  }

  function dispose() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    for (const [t, type, fn] of touchOff) t.removeEventListener(type, fn);
    touchOff.length = 0;
    touch.vec.x = 0; touch.vec.y = 0; touch.active = false; touch.id = null;
    document.body.classList.remove("joy", "avatar-flying");
    try { world.dispose(); terrainMesh.geometry.dispose(); terrainMesh.material.dispose(); water.mesh.geometry.dispose(); water.mesh.material.dispose(); sky.mesh.geometry.dispose(); sky.mesh.material.dispose(); } catch (e) { /* noop */ }
    try { if (envRT) envRT.dispose(); if (pmrem) pmrem.dispose(); } catch (e) { /* noop */ }
    renderer.dispose();
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const hud = () => {
    const p = avatar.position;
    return {
      pos: [p.x, p.y, p.z],
      sl: [p.x + 128, 128 - p.z, p.y],
      mode: avatar.flying ? "volar" : (avatar.grounded ? "andar" : "cayendo"),
      speed: avatar.speed,
      hour: cycle.hour,
      sunElev: cycle.sunElev,
      camMode: cam.mode,
      camDist: cam.dist,
      focused: cam.mode === "free" ? cam.pos.toArray() : null,
      objects: world.objects.length,
      triangles: state.tris,
      fps: state.fps,
      quality: state.quality,
    };
  };

  return {
    scene, camera, renderer, canvas, terrain, terrainMesh, water, sky, world, avatar, sandbox, cycle, state, cam, input, touch,
    update, resize, dispose, hud, setTime, toggleFly, togglePause, setTimeScale, teleport, spawnOnTerrain, recenter,
    // Ajustes de la camara que el panel de ajustes guarda en `kv`.
    setInvertY: (v) => { cam.invertY = !!v; return cam.invertY; },
    setSensitivity: (v) => { cam.sens = Math.max(0.0008, Math.min(0.02, Number(v) || cam.sens)); return cam.sens; },
    setFov: (v) => {
      cam.fov = Math.max(35, Math.min(95, Number(v) || cam.fov));
      camera.fov = cam.fov;
      camera.updateProjectionMatrix();
      return cam.fov;
    },
    cameraSettings: () => ({ invertY: cam.invertY, sens: cam.sens, fov: cam.fov, dist: cam.dist, mode: cam.mode, touch: coarse }),
    setFps: (v) => { state.fps = v; },
    bakeEnvironment: (force) => bakeEnvironment(force !== false),
    setTris: (v) => { state.tris = v; },
    setAutoQuality: (v) => { state.autoQuality = !!v; },
    setQuality: (q) => { state.quality = Math.max(QUALITY_MIN, Math.min(1, q)); applyQuality(); },
    quality: () => ({ scale: state.quality, dpr: baseDpr * state.quality, auto: state.autoQuality, aa: useAA }),
    // --- forma real del residente (editor de forma de SL) -------------------
    // `setShape` aplica la forma al avatar del mundo Y la guarda para la proxima
    // vez; `shape()` devuelve la forma actual (formato de `SLAppearance`).
    setShape: (shape) => { const norm = avatar.setShape(shape); if (norm) saveStoredShape(norm); return norm; },
    shape: () => (avatar.slAppearance ? avatar.slAppearance.snapshot() : ((avatar.appearance && avatar.appearance.shape) || null)),
    saveShape: () => {
      const s = (avatar.appearance && avatar.appearance.shape) || (avatar.slAppearance && avatar.slAppearance.snapshot());
      if (s) saveStoredShape(s);
      return s || null;
    },
    get slAppearance() { return avatar.slAppearance; },
  };
}
