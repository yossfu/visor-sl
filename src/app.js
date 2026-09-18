// app.js -- arranque del visor: canvas a pantalla completa, bucle de render,
// contador de FPS, enrutado por hash y montaje de la escena correspondiente.
//
// Rutas:
//   #viewer             el mundo (region, avatar, camara) -- ruta por defecto
//   #primtest           galeria de geometria (7 formas + variantes)
//   #primtest/<forma>   una forma sola, girando (banco de pruebas)
//   #primtest/hoja      hoja de contactos cenital de todas las formas
//   #bodytest/<modo>    el avatar REAL (cuerpo de sistema de SL) y sus animaciones

import { createPrimGallery } from "./primGallery.js";
import { createAvatarGallery } from "./avatarGallery.js";
import { createRealAvatarView } from "./realAvatar.js";
import { createMeshGallery } from "./meshGallery.js";
import { createViewer } from "./viewer.js";
import { createBuildTools } from "./build.js";
import { createStore } from "./store.js";
import { createGameHUD } from "./gameHUD.js";
import { createScriptRuntime } from "./lsl/runtime.js";
import { createChatPanel } from "./lslPanel.js";
import { createPeers } from "./peers.js";
import { createNet } from "./net.js";
import { createSession } from "./sl/session.js";
import { getStartPanel } from "./sl/startPanel.js";
import { patternKeys } from "./textures.js";
import diag from "./diag.js";

// La depuracion arranca antes que nada: asi los errores de carga del propio
// visor ya quedan en el anillo y salen en el informe.
diag.install();
diag.registerState("visor", () => ({
  ruta: (location.hash || "#viewer"),
  escena: window.__app && window.__app.route ? window.__app.route.scene : null,
  montado: !!mount,
  dibujando: running,
  fps: Math.round(fps),
  triangulos: mount && mount.renderer ? mount.renderer.info.render.triangles : null,
  peticiones: mount && mount.renderer ? mount.renderer.info.render.calls : null,
  memoria: mount && mount.renderer && mount.renderer.info.memory ? mount.renderer.info.memory : null,
}));
diag.registerState("sesión", () => {
  if (!session) return { estado: net ? "multijugador perchance" : "sin sesión" };
  const st = session.state || {};
  return {
    estado: st.status || st.state || "?",
    region: st.region ? st.region.name : null,
    simulador: !!session.mock,
    jugadores: peers && peers.count ? peers.count() : null,
  };
});
diag.registerState("render", () => {
  if (!mount || !mount.quality) return null;
  const q = mount.quality();
  return { escala: q.scale, densidad: q.dpr, antialias: q.aa, autoCalidad: !!q.auto };
});
diag.info("app", "módulo del visor cargado");

const canvas = document.getElementById("viewCanvas");
const hudTitleEl = document.getElementById("hudTitleEl");
const hudRouteEl = document.getElementById("hudRouteEl");
const hudFpsEl = document.getElementById("hudFpsEl");
const hudTrisEl = document.getElementById("hudTrisEl");
const hudInfoEl = document.getElementById("hudInfoEl");
const viewStatEl = document.getElementById("viewStatEl");
const bootErrorEl = document.getElementById("bootErrorEl");
const loadingEl = document.getElementById("loadingEl");

// --- "esto es un telefono" ---------------------------------------------------
// Se decide UNA vez, aqui, y no dentro del visor: antes la clase `touch` la
// ponia `viewer.js` al montarse, asi que las pantallas que no montan visor
// —sobre todo la de entrada (#sl), que es la que abre la app Android— se
// quedaban sin ella y se pintaban con la maqueta de escritorio (etiquetas al
// lado de los campos, botones diminutos, la barra de enlaces arriba). Toda la
// hoja de estilo tactil cuelga de `body.touch`: sin ella, en el movil se ve la
// interfaz de escritorio.
//
// No basta con `(pointer: coarse)`: algunos WebView no lo anuncian. Se mira
// tambien si hay dedos (`maxTouchPoints`) y, si el visor corre dentro de la app
// Android (`window.__SL_APP__`), se da por hecho.
const TACTIL = (() => {
  try {
    if (window.__SL_APP__ && window.__SL_APP__.android) return true;
    const mm = window.matchMedia ? window.matchMedia.bind(window) : null;
    if (mm && mm("(pointer: coarse)").matches) return true;
    if (navigator.maxTouchPoints > 0 && mm && mm("(hover: none)").matches) return true;
  } catch (e) { /* sin matchMedia: se queda como escritorio */ }
  return false;
})();
if (TACTIL) (document.body || document.documentElement).classList.add("touch");

const navEls = {
  start: document.getElementById("navStartEl"),
  viewer: document.getElementById("navViewerEl"),
  gallery: document.getElementById("navGalleryEl"),
  sheet: document.getElementById("navSheetEl"),
};

let mount = null;
let bt = null;
let store = null;
let rt = null;          // runtime de scripts (mini-LSL) del mundo actual
let chatPanel = null;
let peers = null;       // avatares de los demas jugadores
let net = null;         // multijugador de perchance
let session = null;     // sesion con el retransmisor (region de Second Life)
// El retransmisor LLUDP montado en este navegador (modo "lldp"): el puente UDP
// hacia el simulador. Se guarda para que el informe de depuracion pueda contar
// cuantos datagramas han ido y venido y que mensajes han llegado (y para quien
// venga despues: es lo unico que permite entender un fallo de protocolo sin
// cable USB).
let lldpRelay = null;
let gh = null;          // mandos de juego: minimapa, menus (inventario, armario, mapa, sitios, ajustes)

// Lo que deja la pantalla de inicio (#sl) para que la ruta del visor (#viewer)
// sepa a donde conectarse. Se consume una sola vez.
let pendingSession = null;

// Nombre del residente con el que se ha entrado (lo usan los scripts para
// saber quien habla).
let mySessionName = "";

// Elementos del chip de sesion (lo que pasa con el retransmisor).
const slStatEl = document.getElementById("slStatEl");
const slDotEl = document.getElementById("slDotEl");
const slTextEl = document.getElementById("slTextEl");

// El panel de chat vive en el HTML y no se recrea: cuando se cambia de escena
// (galeria <-> visor) el runtime se destruye y se hace uno nuevo, asi que el
// puente reengancha los suscriptores del chat al runtime de turno. Sin esto, el
// DOM acumularia listeners duplicados cada vez que se vuelve al visor.
const chatSubs = [];
const chatBridge = {
  stats: () => (rt ? rt.stats() : { scripts: 0, listeners: 0 }),
  chat: (text, ch) => { if (rt) rt.chat(text, ch); },
  on: (type, cb) => { chatSubs.push([type, cb]); if (rt) rt.on(type, cb); },
};

function parseRoute() {
  const raw = (location.hash || "").replace(/^#/, "");
  const [name, arg] = raw.split("/");
  if (name === "sl") return { scene: "start", focus: null, mode: "persp" };
  if (name === "primtest") {
    if (!arg) return { scene: "gallery", focus: null, mode: "persp" };
    if (arg === "hoja" || arg === "sheet") return { scene: "gallery", focus: null, mode: "sheet" };
    return { scene: "gallery", focus: arg, mode: "persp" };
  }
  if (name === "avatartest") {
    return { scene: "avatars", focus: arg || null, mode: "persp" };
  }
  if (name === "bodytest") {
    return { scene: "real", focus: arg || null, mode: "persp" };
  }
  if (name === "meshtest") {
    return { scene: "meshtest", focus: arg || null, mode: "persp" };
  }
  return { scene: "viewer", focus: null, mode: "persp" };
}

function resize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  if (mount) {
    mount.resize(w, h);
  }
}

function teardown() {
  // El HUD de juego se va ANTES que el visor: al desmontarse guarda el aspecto
  // propio en `kv` (una escritura asincrona que necesita el avatar vivo para
  // leerlo) y suelta los escuchadores de la capa tactil, que vive en el HTML y
  // no se recrea.
  if (gh) { try { gh.dispose(); } catch (e) { /* noop */ } gh = null; }
  if (session) { try { session.dispose(); } catch (e) { /* noop */ } session = null; }
  if (net) { try { net.dispose(); } catch (e) { /* noop */ } net = null; }
  if (peers) { try { peers.dispose(); } catch (e) { /* noop */ } peers = null; }
  if (bt) { try { bt.dispose(); } catch (e) { /* noop */ } bt = null; }
  if (rt) { try { rt.dispose(); } catch (e) { /* noop */ } rt = null; }
  if (mount) { try { mount.dispose(); } catch (e) { /* noop */ } mount = null; }
}

function setNav(scene) {
  if (navEls.start) navEls.start.classList.toggle("on", scene === "start");
  if (navEls.viewer) navEls.viewer.classList.toggle("on", scene === "viewer");
  if (navEls.gallery) navEls.gallery.classList.toggle("on", scene === "gallery");
  document.body.classList.toggle("in-viewer", scene === "viewer");
}

// --- chip de la sesion con el retransmisor ---------------------------------
function paintSessionChip() {
  if (!slStatEl) return;
  const on = !!session;
  slStatEl.hidden = !on;
  if (!on) return;
  const st = session.stats();
  slStatEl.classList.toggle("on", !!st.ready);
  slStatEl.classList.toggle("busy", !st.ready && !st.error);
  slStatEl.classList.toggle("off", !!st.error);
  slStatEl.classList.toggle("mock", !!st.mock);
  if (slTextEl) slTextEl.textContent = session.statusText();
  slStatEl.title = (st.mock ? (st.mockLabel || "Simulador de pruebas (no es Second Life)") : "Sesión con el retransmisor") +
    "\n" + (st.region && st.region.name ? "región: " + st.region.name : "sin región") +
    (st.parcel && st.parcel.name ? "\nparcela: " + st.parcel.name : "") +
    (st.pingMs ? "\n" + st.pingMs + " ms" : "") +
    (st.error ? "\n" + st.error : "");
}

function sessionSpeaker(st) {
  if (!st) return "visor";
  if (st.mock) return "simulador";
  return "relé";
}

// --- dibujo del HUD del visor (posicion, coordenadas de region, hora) --------
let hudAcc = 0;
function paintViewerHud(v) {
  if (!viewStatEl || !v) return;
  const h = v.hud();
  const fmt = (n, d) => n.toFixed(d === undefined ? 1 : d);
  const hour = h.hour;
  const hh = Math.floor(hour);
  const mm = Math.floor((hour - hh) * 60);
  // La linea de datos va partida en dos: lo esencial (donde estas) en
  // `#viewStatEl`, y el resto en `#hudInfoEl`. En el telefono la franja nace
  // plegada y solo se ve la primera parte, asi que el mundo respira y todo lo
  // demas sigue a un toque.
  if (viewStatEl) {
    viewStatEl.innerHTML =
      "posición " + fmt(h.pos[0]) + ", " + fmt(h.pos[1]) + ", " + fmt(h.pos[2]) + " m" +
      " &middot; región " + fmt(h.sl[0]) + " / " + fmt(h.sl[1]) + " / " + fmt(h.sl[2]);
  }
  if (hudInfoEl) {
    hudInfoEl.innerHTML =
      h.mode + " (" + fmt(h.speed) + " m/s)" +
      " &middot; hora " + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") +
      " &middot; " + h.objects + " prims" +
      (h.camMode === "free" ? " &middot; cámara libre" : " &middot; distancia " + fmt(h.camDist) + " m") +
      (h.quality !== undefined && h.quality < 0.995 ? " &middot; calidad " + Math.round(h.quality * 100) + "%" : "");
  }
}

function boot() {
  const route = parseRoute();
  diag.info("app", "ruta: " + route.scene + (route.focus ? "/" + route.focus : ""));
  teardown();
  if (loadingEl) loadingEl.hidden = false;
  setNav(route.scene);

  // La pantalla de inicio se queda fuera del canvas: es HTML y CSS, y su
  // trabajo es explicar de donde sale la region antes de gastar un contexto
  // WebGL.
  if (route.scene === "start") {
    const panel = getStartPanel({
      onEnter: (cfg) => {
        pendingSession = cfg;
        location.hash = "#viewer";
      },
    });
    panel.show();
    document.body.dataset.ready = "1";
    if (loadingEl) loadingEl.hidden = true;
    // En la app Android hay un vigia (src/android/env.js) que tapa la pantalla
    // con un diagnostico si el visor no llega a arrancar. Aqui ya ha arrancado:
    // se le dice para que se retire y no estorbe.
    if (window.__visorListo) window.__visorListo();
    running = false;
    window.__app = {
      mount: null, route, rebuild: boot,
      diag,
      get session() { return null; },
      startPanel: panel,
    };
    return;
  }
  if (window.__app && window.__app.startPanel) getStartPanel().hide();

  try {
    if (route.scene === "viewer") {
      mount = createViewer(canvas.parentElement, { canvas });
      store = createStore(mount.world);
      peers = createPeers({
        viewer: mount,
        overlayEl: document.getElementById("lslTextCtn"),
        // Los residentes remotos usan tambien el cuerpo de SISTEMA de SL, con su
        // forma real (derivada de forma estable de su id/nombre) y, si llega, su
        // forma declarada. Los bakes (BoM) se resuelven por uuid.
        realBody: true,
        resolveTexture: (uuid) => mount.world.getAssetTexture(uuid),
      });
      // El runtime de scripts necesita el mundo, y las herramientas de
      // construccion necesitan el runtime (para el editor de scripts), asi que
      // el orden es: visor -> runtime -> herramientas. El multijugador se crea
      // al final (necesita las herramientas) y el runtime lo consulta a traves
      // de estas closures.
      rt = createScriptRuntime({
        viewer: mount,
        overlayEl: document.getElementById("lslTextCtn"),
        patternKeys,
        isBuildMode: () => !!(bt && bt.state.active),
        myName: () => (net ? net.name : (mySessionName || "Dueño")),
        // Con una sesion abierta, los prims que llegan de la region no son
        // nuestros (la region es la que manda: sus scripts se ejecutan alli, y
        // si ademas se reenviasen desde aqui cada linea saldria dos veces). Los
        // prims locales del usuario si se difunden.
        isOwner: (prim) => (net ? net.isOwner(prim) : (session ? !(prim && prim.slUuid) : true)),
      });
      bt = createBuildTools({ viewer: mount, store, scripts: rt, net: () => net });
      if (chatPanel) {
        for (const s of chatSubs) rt.on(s[0], s[1]);
        chatPanel.updateWho();
      } else {
        chatPanel = createChatPanel({
          scripts: chatBridge,
          collapsed: document.body.classList.contains("touch"),
          hint: "Escribe aquí para hablar con los scripts (canal 0). Prueba el ejemplo «Escucha y responde».",
        });
      }
      // El autoguardado se aplica despues (leer IndexedDB es asincrono), pero
      // solo si el usuario no ha tocado nada mientras tanto (si ya ha editado,
      // cargar el guardado encima seria perder su trabajo). Con una sesion
      // abierta no se carga NADA: el mundo lo manda la region, y meterle encima
      // el guardado de la arena de pruebas seria pisarlo.
      const cfg = pendingSession;
      pendingSession = null;
      if (!cfg) {
        store.loadRegion().then((saved) => {
          if (!saved || !bt || bt.state.rev) return;
          bt.loadRegionData(saved, false);
          bt.toast("Región recuperada (" + saved.objects.length + " prims)");
        });
      }

      // Multijugador de perchance. Se crea despues del chat para poder anunciar
      // ahi lo que pasa (entradas y salidas, subidas del mundo, avisos del
      // servidor). Si hay sesion con el retransmisor NO se crea: el mundo lo
      // manda la region, y las dos cosas a la vez se pisarian (ademas de subir
      // una region de Second Life al almacen de perchance, que no es lo suyo).
      if (!cfg) {
        net = createNet({
          viewer: mount, world: mount.world, bt, store, peers, rt,
          onNotice: (text) => { if (chatPanel) chatPanel.line({ kind: "region", speaker: "visor", text }); },
          onStatus: () => { if (bt && bt.state.active) bt.renderRegion(); },
        });
      }
      if (cfg) startRegionSession(cfg);

      // Los mandos de juego (minimapa, carril de menus y sus cajones) se montan
      // al final, cuando ya existen el mundo, las herramientas y la sesion: el
      // panel de sitios y el de inventario los usan, y el mapa manda saltos a
      // traves de `session`.
      gh = createGameHUD({
        viewer: mount, store, peers, bt,
        session: () => session,
        net,
      });
      if (hudTitleEl) hudTitleEl.textContent = cfg ? "Visor de Second Life · sesión" : "Visor de Second Life";
      if (hudRouteEl) {
        hudRouteEl.textContent = cfg
          ? (cfg.mode === "mock" ? "simulador de pruebas" : "región de Second Life")
          : "región 256×256 m";
      }
      if (hudInfoEl) {
        hudInfoEl.textContent = cfg
          ? "sesión con el retransmisor · el terreno, los prims y los residentes llegan de la región · toca un prim para interactuar"
          : "geometría LLVolume · 7 formas de SL · avatar con física · pulsa B para construir y escribir scripts LSL";
      }
    } else if (route.scene === "avatars") {
      mount = createAvatarGallery(canvas.parentElement, {
        canvas, focus: route.focus,
        mode: (route.focus === "cara" || route.focus === "pose") ? route.focus : "persp",
      });
      if (hudTitleEl) hudTitleEl.textContent = "Visor de Second Life · avatares";
      const label = route.focus ? "prueba: " + route.focus : "galería de avatares";
      if (hudRouteEl) hudRouteEl.textContent = label;
      if (hudInfoEl) hudInfoEl.textContent = (mount.diag || []).join(" | ");
      if (viewStatEl) viewStatEl.textContent = "";
      if (hudTrisEl) hudTrisEl.textContent = (mount.items ? mount.items.length : 0) + " avatares";
    } else if (route.scene === "real") {
      mount = createRealAvatarView(canvas.parentElement, {
        canvas, mode: route.focus,
        statusEl: viewStatEl,
        onDiag: () => { if (hudInfoEl && mount) hudInfoEl.textContent = (mount.diag || []).join(" | "); },
      });
      if (hudTitleEl) hudTitleEl.textContent = "Visor de Second Life · avatar real";
      const modeLabel = {
        quieto: "cuerpo de sistema (SL) · quieto",
        cara: "primer plano de la cara",
        pose: "andando",
        correr: "corriendo",
        saludar: "saludando",
        sentar: "sentado",
        huesos: "esqueleto a la vista",
        morph: "morphs exagerados",
        falda: "con la falda de sistema",
        forma: "editor de forma real (SL)",
      }[route.focus || "quieto"] || "avatar real";
      if (hudRouteEl) hudRouteEl.textContent = modeLabel;
      if (hudInfoEl) hudInfoEl.textContent = (mount.diag || []).join(" | ");
      if (hudTrisEl) hudTrisEl.textContent = "";
    } else if (route.scene === "meshtest") {
      mount = createMeshGallery(canvas.parentElement, {
        canvas,
        statusEl: viewStatEl,
        onDiag: () => { if (hudInfoEl && mount) hudInfoEl.textContent = (mount.diag || []).join(" | "); },
      });
      if (hudTitleEl) hudTitleEl.textContent = "Visor de Second Life · mallas de fuera";
      if (hudRouteEl) hudRouteEl.textContent = "traer una cabeza/cuerpo mesh";
      if (hudInfoEl) hudInfoEl.textContent = (mount.diag || []).join(" | ");
      if (hudTrisEl) hudTrisEl.textContent = "";
    } else {
      mount = createPrimGallery(canvas.parentElement, {
        canvas, focus: route.focus, mode: route.mode,
      });
      if (hudTitleEl) hudTitleEl.textContent = "Visor de Second Life · motor de geometría";
      const label = route.focus ? "prueba: " + route.focus
        : (route.mode === "sheet" ? "hoja de formas" : "galería de prims");
      if (hudRouteEl) hudRouteEl.textContent = label;
      if (hudInfoEl) hudInfoEl.textContent = (mount.diag || []).join(" | ");
      if (viewStatEl) viewStatEl.textContent = "";
      const total = mount.stats.reduce((a, s) => a + s.triangles, 0);
      if (hudTrisEl) hudTrisEl.textContent = mount.items.length + " prims, " + total.toLocaleString("es") + " tris";
    }
    resize();
    document.body.dataset.ready = "1";
  } catch (e) {
    showError("No se pudo iniciar el visor: " + (e && e.message ? e.message : e));
    if (loadingEl) loadingEl.hidden = true;
    return;
  }
  if (loadingEl) loadingEl.hidden = true;
  if (window.__visorListo) window.__visorListo();
  window.__app = {
    mount, route, rebuild: boot,
    diag,
    get stats() { return mount && mount.stats; },
    get build() { return bt; },
    get lsl() { return rt; },
    get chat() { return chatPanel; },
    get net() { return net; },
    get peers() { return peers; },
    get session() { return session; },
    get lldp() { return lldpRelay; },
    get gameHud() { return gh; },
    hud: () => mount && mount.hud && mount.hud(),
    probe: (cases, o) => mount && mount.probeCases && mount.probeCases(cases, o),
    viewer: () => (route.scene === "viewer" ? mount : null),
    goto: (hash) => { location.hash = hash; },
  };
  running = true;
  last = performance.now();
}

// --- sesion con el retransmisor (region de Second Life) ----------------------

// Crea la sesion que pidio la pantalla de inicio. El retransmisor es el que
// tiene la region; aqui solo se abre el enlace y se le entregan las
// credenciales (o el identificador de sesion, si el login lo hizo la propia
// pagina).
function startRegionSession(cfg) {
  if (session) { try { session.dispose(); } catch (e) { /* noop */ } session = null; }
  mySessionName = cfg.displayName || "";
  session = createSession({
    viewer: mount, peers, getRt: () => rt, store, bt,
    isBuildMode: () => !!(bt && bt.state.active),
    mock: cfg.mode === "mock",
    url: cfg.relay ? cfg.relay.url : "",
    socketFactory: cfg.relay ? cfg.relay.socketFactory : null,
    spawn: cfg.spawn || null,
    onStatus: () => paintSessionChip(),
    onLog: (text, cls) => {
      if (!chatPanel) return;
      chatPanel.line({ kind: cls === "error" ? "debug" : "region", speaker: sessionSpeaker(session && session.state), text });
    },
    onReady: () => {
      paintSessionChip();
      if (hudRouteEl && session && session.state.region) hudRouteEl.textContent = session.state.region.name || hudRouteEl.textContent;
    },
    onAvatar: () => paintSessionChip(),
  });
  if (cfg.mode === "session" || cfg.mode === "lldp") {
    session.setCredentials({ mode: "session", session: cfg.credentials });
  } else if (cfg.mode === "credentials") {
    session.setCredentials(Object.assign({ mode: "credentials" }, cfg.credentials));
  } else {
    // Simulador de pruebas: el "login" es un aviso para el servidor de mentira.
    session.setCredentials({ mode: "mock", displayName: cfg.displayName || "Visitante" });
  }
  session.connect();
  paintSessionChip();
  lldpRelay = cfg.lldp || null;
  if (chatPanel) {
    let texto;
    if (cfg.mode === "mock") {
      texto = "Conectando con el simulador de pruebas (región inventada, no es Second Life)…";
    } else if (cfg.mode === "lldp") {
      const r = (session.state.region && session.state.region.name) || "";
      texto = "Conectando por LLUDP con " + (r ? "la región «" + r + "»" : "la región de Second Life") +
        (cfg.relay && cfg.relay.mock ? " (región simulada en JavaScript, no es Second Life)" : "") + "…";
    } else {
      texto = "Conectando con el retransmisor " + (cfg.relay ? cfg.relay.url : "") + "…";
    }
    chatPanel.line({ kind: "region", speaker: "visor", text: texto });
  }
}

// --- bucle de render con FPS suavizados -------------------------------------
let running = false;
let last = performance.now();
let acc = 0, frames = 0, fps = 0;

function frame(now) {
  requestAnimationFrame(frame);
  if (!running || !mount) return;
  // Ojo: el primer frame puede llegar con un `now` anterior a `last` (el motor
  // de perchance reinyecta los scripts y el reloj de rAF no tiene por que ser
  // monotono respecto a performance.now()). Un dt negativo daria gravedad
  // negativa y lanzaria al avatar al cielo, asi que se recorta por abajo.
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  try {
    if (bt) bt.update();
    if (rt) rt.update(dt);
    if (mount.update) mount.update(dt);
    if (peers) peers.update(dt);
    if (net) net.update(dt);
    if (session) session.update(dt);
    if (gh) gh.update(dt);
    mount.renderer.render(mount.scene, mount.camera);
  } catch (e) {
    running = false;
    showError("Error al dibujar: " + e.message);
    return;
  }
  acc += dt; frames++;
  if (acc >= 0.45) {
    fps = frames / acc;
    if (hudFpsEl) hudFpsEl.textContent = fps.toFixed(0) + " fps";
    acc = 0; frames = 0;
    if (mount.setFps) mount.setFps(fps);
    const tris = mount.renderer.info.render.triangles;
    if (mount.setTris) mount.setTris(tris);
    if (hudTrisEl) hudTrisEl.textContent = tris.toLocaleString("es") + " tris";
  }
  if (mount.hud) {
    hudAcc += dt;
    if (hudAcc > 0.2) { hudAcc = 0; paintViewerHud(mount); if (session) paintSessionChip(); }
  }
}

function showError(msg) {
  diag.error("error", msg);
  // En la app Android, si esto pasa durante el arranque, el vigia de
  // src/android/env.js enseña el mensaje (y comprueba si faltan archivos). Si
  // ya habia arrancado, el vigia se ignora solo y queda el aviso de siempre.
  if (window.__visorFallo) window.__visorFallo(msg);
  if (!bootErrorEl) return;
  bootErrorEl.hidden = false;
  bootErrorEl.textContent = msg;
  running = false;
}

window.addEventListener("resize", resize);
window.addEventListener("hashchange", boot);

try {
  boot();
  requestAnimationFrame(frame);
} catch (e) {
  showError("No se pudo iniciar el visor: " + (e && e.message ? e.message : e));
}
