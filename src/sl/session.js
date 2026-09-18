// session.js -- la sesion: credenciales + retransmisor + region viva.
//
// Es la pieza que une las tres anteriores:
//
//   src/sl/login.js      habla LLSD/XML-RPC con login.agni.lindenlab.com
//   src/sl/relay.js      el enlace (WebSocket) y el protocolo de tramas
//   src/sl/mockServer.js la otra mitad del protocolo, para probar sin gateway
//
// QUE HACE AQUI
// -------------
// El navegador no puede abrir el socket UDP de un simulador de Second Life (eso
// solo lo sabe hacer un proceso nativo; ver src/VIEWER-REAL.md). Asi que el
// visor habla HTTP/WebSocket con un retransmisor, y este es el lado del
// navegador de esa conversacion: pide el terreno, recibe los prims, coloca a
// los demas residentes, pinta el chat, manda la posicion del avatar y avisa
// cuando tocas algo. Todo lo que cambia el mundo entra por el MISMO camino que
// usa el multijugador de la arena de pruebas (`world.applyRemote`), asi que no
// hay dos mundos distintos: hay uno.
//
// DOS MODOS DE ENTRAR
// -------------------
//   credentials  el retransmisor recibe usuario y contrasena y hace el login
//   session      el login lo hace ESTE visor (src/sl/login.js, via el proxy
//                HTTP) y al retransmisor solo le llega el identificador de
//                sesion, que es lo unico que necesita para abrir el circuito.
//                La contrasena no sale del navegador.
//
// El modo `session` es el interesante: la contrasena nunca se guarda ni viaja
// al retransmisor, que puede estar en una maquina de un tercero.

import {
  createRelay, C, S, PHASE, PHASE_TEXT, RES, ASSET_FORMAT,
  CHAT_KIND, CHAT_KIND_NAME, ZERO_UUID, readAsset,
} from "./relay.js";
import { createMockRelay } from "./mockServer.js";
import { normalizeAppearance, randomAppearance } from "../avatarParams.js";
import diag from "../diag.js";

// Cuanto se aplica por fotograma. El retransmisor manda la region en rafagas
// (cientos de tramas seguidas); aplicarlas todas de golpe congelaria el
// fotograma, asi que se reparten. Con esto la region se ve llenarse en medio
// segundo en vez de dar un tiron.
const TERRAIN_PER_FRAME = 8;
const OBJECTS_PER_FRAME = 24;
const ASSET_REQ_PER_FRAME = 4;
const POSE_HZ = 8;
const POSE_EPS = 0.02;

export function createSession(opts = {}) {
  const viewer = opts.viewer;
  const world = viewer.world;
  const terrain = viewer.terrain;
  const peers = opts.peers || null;
  const getRt = typeof opts.getRt === "function" ? opts.getRt : () => opts.rt;
  const onStatus = opts.onStatus || (() => {});
  const onLogRaw = opts.onLog || (() => {});
  // Todo lo que la sesion cuenta por `onLog` acaba tambien en el anillo de
  // depuracion: en el movil no hay consola, y el informe es el unico rastro.
  function onLog(text, cls) {
    try { onLogRaw(text, cls); } catch (e) { /* noop */ }
    if (cls === "error") diag.error("sesion", text);
    else if (cls === "warn") diag.aviso("sesion", text);
    else diag.info("sesion", text);
  }
  const onPhase = opts.onPhase || (() => {});
  const onReady = opts.onReady || (() => {});
  const onAvatar = opts.onAvatar || (() => {});
  const isBuildMode = typeof opts.isBuildMode === "function" ? opts.isBuildMode : () => false;
  const store = opts.store || null;
  const bt = opts.bt || null;
  const replaceWorld = opts.replaceWorld !== false;
  const stashName = opts.stashName || "antes-del-relay";
  const spawn = opts.spawn || null;

  const state = {
    link: "idle", phase: PHASE.IDLE, progress: 0, text: PHASE_TEXT[PHASE.IDLE],
    region: null, mock: false, ready: false, error: null,
    expected: 0, patches: 0, objects: 0, avatars: 0, assets: 0, chats: 0,
    poseSent: 0, interacts: 0, teleports: 0,
    kbIn: 0, kbOut: 0, pingMs: 0, simFps: 0, agents: 0, parcel: null,
    info: null, caps: null, inventory: null, spawn: spawn || null,
    mockLabel: null, mockServer: null, textures: 0, missing: 0, elapsed: 0,
  };

  // Colas de entrada. Se llenan en `onMessage` y se vacian en `update`.
  const tq = [];          // parches de terreno
  const oq = [];          // objetos {rec, uuid, parent}
  const aq = [];          // texturas pedidas por una cara del mundo
  const linkQ = [];       // {obj, parent} resoluciones de enlace por uuid
  let relay = null;
  let disposed = false;
  let poseAcc = 0;
  let assetAcc = 0;
  let lastPose = { x: 0, y: 0, z: 0, yaw: 0 };
  let poseAt = 0;
  const index = new Map();     // uuid -> id local del prim
  const assetTex = new Map();  // uuid -> THREE.Texture (dueña: la sesion)
  const reqAt = new Map();     // uuid -> cuando se pidio (para no pedirlo 50 veces)

  // --- salida ---------------------------------------------------------------

  function relayState() { return relay ? relay.state : null; }

  function syncState() {
    const rs = relayState();
    if (!rs) return;
    state.link = rs.link;
    state.region = rs.region || state.region;
    state.mock = rs.mock;
    state.pingMs = rs.rtt || 0;
    state.kbIn = Math.round(rs.bytesIn / 1024);
    state.kbOut = Math.round(rs.bytesOut / 1024);
  }

  function setPhase(p, progress, text) {
    state.phase = p;
    if (progress !== undefined && progress !== null) state.progress = progress;
    state.text = text || PHASE_TEXT[p] || "";
    onPhase(state);
    onStatus(state);
  }

  // --- credenciales ---------------------------------------------------------

  // Lo que se manda al retransmisor. Con `credentials` va el usuario y la
  // contrasena (el retransmisor hace el login). Con `session` va el
  // identificador de sesion: la contrasena se queda en el navegador.
  let pending = null;

  // El login se manda UNA vez por enlace. Sin esta bandera, cada mensaje de
  // estado del retransmisor (S.STATE) vuelve a disparar el login, porque el
  // estado del enlace tambien pasa por `onLinkState` mientras la fase es
  // anterior a ENTERING: el retransmisor recibia un LOGIN detras de otro y
  // contestaba mandando la region entera otra vez (terreno sin fin).
  let loginSent = false;

  function sendLogin() {
    if (!pending || !relay || loginSent) return;
    loginSent = true;
    if (pending.mode === "credentials") {
      relay.sendCredentials({
        grid: pending.grid || "agni",
        name: pending.displayName || pending.name || "",
        firstName: pending.firstName || "",
        lastName: pending.lastName || "",
        password: pending.password || "",
        passwordHash: pending.passwordHash || "",
        token: pending.token || "",
        start: pending.start || "last",
      });
      return;
    }
    // `session` (el login lo hizo este navegador) y `mock` (simulador de
    // pruebas) viajan igual: un identificador y nada mas.
    relay.sendSession(Object.assign({}, pending.session || {}, { mode: pending.mode || "session" }));
  }

  // --- entradas del mundo ---------------------------------------------------

  function prepareWorld() {
    if (!replaceWorld) return;
    stash();
    world.clear();
    index.clear();
  }

  // La region de la arena de pruebas se guarda antes de que llegue la del
  // retransmisor: nada de perder el trabajo de uno por entrar en una region.
  function stash() {
    if (!store || !store.available || !bt || !bt.regionState) return;
    if (!world.objects.length) return;
    try {
      Promise.resolve(store.saveRegion(stashName, bt.regionState())).catch(() => {});
      onLog("Tu region anterior se ha guardado como «" + stashName + "» en este navegador.", "region");
    } catch (e) { /* sin almacenamiento */ }
  }

  function applyObject(rec, uuid, parent) {
    if (!rec || typeof rec !== "object") return;
    const op = rec.remove ? "remove" : (rec.op === "remove" ? "remove" : "set");
    if (op === "remove") { dropUuid(uuid || rec.slUuid); return; }
    const obj = world.applyRemote(rec, "set");
    if (!obj) return;
    if (uuid) { obj.slUuid = uuid; index.set(uuid, obj.id); }
    if (parent && parent !== ZERO_UUID) linkQ.push({ obj, parent });
    state.objects = world.objects.length;
  }

  // Enlaces por uuid: en SL un objeto enlazado manda el uuid de su raiz. Se
  // resuelven al final del lote, cuando ya existen todos los prims.
  function resolveLinks() {
    while (linkQ.length) {
      const { obj, parent } = linkQ.shift();
      const rootId = index.get(parent);
      if (rootId === undefined) continue;
      const root = world.findById(rootId);
      if (!root || root === obj) continue;
      world.linkRecord(obj, { parent: rootId });
    }
  }

  function dropUuid(uuid) {
    if (!uuid) return;
    const id = index.get(uuid);
    index.delete(uuid);
    if (id === undefined) return;
    world.removeRemote(id);
    state.objects = world.objects.length;
  }

  function patchObject(uuid, patch) {
    if (!uuid) return;
    const id = index.get(uuid);
    if (id === undefined) {
      // Un objeto que aun no ha llegado: no se inventa, se pide la region.
      state.missing++;
      return;
    }
    const obj = world.findById(id);
    if (!obj) return;
    const rec = Object.assign({}, world.recordOf(obj), patch, { id });
    world.applyRemote(rec, "set");
  }

  function poseOfJson(json) {
    if (!json || typeof json !== "object") return null;
    const p = json.position || [];
    const q = json.rotation || [];
    return {
      x: p[0] || 0, y: p[1] || 0, z: p[2] || 0,
      yaw: yawOf(q[0] || 0, q[1] || 0, q[2] || 0, q[3] === undefined ? 1 : q[3]),
      flying: !!(json.flags & 1),
      valid: p.length >= 3,
    };
  }

  // Giro alrededor del eje vertical a partir de un cuaternion (x, y, z, w): es
  // el inverso exacto de como lo construye el otro lado (ver mockServer.js).
  function yawOf(qx, qy, qz, qw) {
    return 2 * Math.atan2(qy, qw);
  }

  function addAvatar(uuid, json) {
    if (!peers || !uuid) return;
    const pose = poseOfJson(json);
    const app = appearanceOfJson(json, uuid);
    peers.add(uuid, (json && json.name) || "Residente", pose, app);
    state.avatars++;
    onAvatar({ uuid, name: (json && json.name) || "Residente", json });
  }

  // El aspecto puede llegar de dos formas: completo (objeto con `params`, tal
  // como lo manda otro cliente de este visor) o como la pista antigua del
  // simulador/protocolo `{seed, height, bodyType}`. En el segundo caso se deriva
  // un aspecto estable de la semilla, de modo que todos los clientes que reciban
  // la misma semilla dibujen el mismo residente.
  function appearanceOfJson(json, uuid) {
    const a = json && json.appearance;
    if (a && typeof a === "object") {
      // Aspecto completo (parametros, y/o forma real de SL con sus bakes).
      if (a.params || a.shape || a.visualParams) {
        const app = normalizeAppearance(a);
        if (app.shape) {
          diag.detalle("apariencia", "residente con forma real de SL", shapeDescription(app.shape));
        }
        return app;
      }
      const seed = a.seed !== undefined ? a.seed : uuid;
      const app = randomAppearance(seed, (json && json.name) || "Residente");
      if (typeof a.height === "number") {
        app.params.altura = Math.max(0, Math.min(1, (a.height - 1.45) / 0.75));
      }
      diag.detalle("apariencia", "residente con apariencia derivada de semilla", { semilla: String(seed).slice(0, 12) });
      return app;
    }
    return null;
  }

  // Una linea con lo que trae la forma (para el informe).
  function shapeDescription(shape) {
    const n = shape && shape.visualParams ? shape.visualParams.length : 0;
    const b = shape && shape.bakes ? Object.keys(shape.bakes).length : 0;
    return { sexo: shape && shape.sex, parametros: n, bakes: b };
  }

  function updateAvatar(uuid, x, y, z, qx, qy, qz, qw, flags) {
    if (!peers || !uuid) return;
    peers.setPose(uuid, {
      x, y, z, yaw: yawOf(qx, qy, qz, qw),
      flying: !!(flags & 1), typing: !!(flags & 2), valid: true,
    });
  }

  function receiveChat(uuid, name, kindId, channel, x, y, z, text) {
    if (!text) return;
    state.chats++;
    const rt = getRt();
    if (rt && rt.receiveChat) {
      rt.receiveChat({
        kind: CHAT_KIND_NAME[kindId] || "say",
        channel, scripted: false,
        speaker: name || "Residente",
        id: "sl-" + (uuid || ZERO_UUID),
        text,
        fromPos: { x, y, z },
      });
    } else {
      onLog((name || "Residente") + ": " + text, "peer");
    }
  }

  // --- texturas -------------------------------------------------------------

  function requestAsset(uuid) {
    if (!uuid) return;
    const now = performance.now();
    if (reqAt.has(uuid) && now - reqAt.get(uuid) < 4000) return;
    reqAt.set(uuid, now);
    aq.push(uuid);
  }

  function makeTexture(asset) {
    const T = world.THREE;
    const tex = new T.DataTexture(asset.data, asset.width, asset.height, T.RGBAFormat);
    tex.needsUpdate = true;
    tex.colorSpace = T.SRGBColorSpace !== undefined ? T.SRGBColorSpace : undefined;
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.minFilter = T.LinearMipmapLinearFilter;
    tex.magFilter = T.LinearFilter;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.name = "region:" + asset.uuid;
    return tex;
  }

  function onAsset(asset) {
    state.assets++;
    // Los formatos comprimidos (J2C, el que usa SL de verdad) necesitan un
    // decodificador aparte: ver VIEWER-REAL.md. Aqui de momento solo RGBA8 y
    // los formatos que el navegador ya sabe leer.
    if (asset.format === ASSET_FORMAT.RGBA8) {
      const tex = makeTexture(asset);
      assetTex.set(asset.uuid, tex);
      world.setAssetTexture(asset.uuid, tex);
      return;
    }
    if (asset.format === ASSET_FORMAT.PNG || asset.format === ASSET_FORMAT.JPEG) {
      const blob = new Blob([asset.data], { type: asset.format === ASSET_FORMAT.PNG ? "image/png" : "image/jpeg" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const T = world.THREE;
        const tex = new T.Texture(img);
        tex.needsUpdate = true;
        tex.colorSpace = T.SRGBColorSpace !== undefined ? T.SRGBColorSpace : undefined;
        assetTex.set(asset.uuid, tex);
        world.setAssetTexture(asset.uuid, tex);
        URL.revokeObjectURL(url);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        world.setAssetTexture(asset.uuid, null);
        diag.aviso("asset", "no se pudo decodificar el recurso (uuid " + asset.uuid.slice(0, 8) + "…)");
      };
      img.src = url;
      return;
    }
    onLog("Recurso " + asset.format + " sin decodificador (uuid " + asset.uuid.slice(0, 8) + "…)", "warn");
    world.setAssetTexture(asset.uuid, null);
  }

  // --- respuesta a las tramas ----------------------------------------------

  function onMessage(type, r) {
    switch (type) {
      case S.TERRAIN: {
        const px = r.getU8(), py = r.getU8();
        const n = r.remaining >> 2;
        const heights = new Float32Array(n);
        for (let i = 0; i < n; i++) heights[i] = r.getF32();
        tq.push({ px, py, heights });
        break;
      }
      case S.OBJECTS_BEGIN:
        state.expected = r.getU32();
        if (replaceWorld && oq.length === 0 && !state.ready) prepareWorld();
        break;
      case S.OBJECT: {
        const uuid = r.getUuid();
        const parent = r.getUuid();
        let rec = null;
        try { rec = r.getJson(); } catch (e) { rec = null; }
        if (rec) oq.push({ rec, uuid, parent });
        break;
      }
      case S.OBJECTS_END:
        state.expected = r.getU32() || state.expected;
        break;
      case S.OBJECT_UPDATE: {
        const uuid = r.getUuid();
        let patch = null;
        try { patch = r.getJson(); } catch (e) { patch = null; }
        if (patch) patchObject(uuid, patch);
        break;
      }
      case S.OBJECT_REMOVE: dropUuid(r.getUuid()); break;
      case S.AVATAR: {
        const uuid = r.getUuid();
        let json = null;
        try { json = r.getJson(); } catch (e) { json = null; }
        addAvatar(uuid, json);
        break;
      }
      case S.AVATAR_UPDATE:
        updateAvatar(
          r.getUuid(),
          r.getF32(), r.getF32(), r.getF32(),
          r.getF32(), r.getF32(), r.getF32(), r.getF32(),
          r.getU8(),
        );
        break;
      case S.AVATAR_REMOVE: {
        const uuid = r.getUuid();
        if (peers) peers.remove(uuid);
        state.avatars = Math.max(0, state.avatars - 1);
        break;
      }
      case S.CHAT: {
        const uuid = r.getUuid();
        const name = r.getStr();
        const kindId = r.getU8();
        const channel = r.getI16();
        const x = r.getF32(), y = r.getF32(), z = r.getF32();
        let text = "";
        try { text = r.getStr32(); } catch (e) { text = ""; }
        receiveChat(uuid, name, kindId, channel, x, y, z, text);
        break;
      }
      case S.ASSET: {
        let asset = null;
        try { asset = readAsset(r); } catch (e) { asset = null; }
        if (asset) onAsset(asset);
        break;
      }
      case S.PARCEL: {
        try { state.parcel = r.getJson(); } catch (e) { /* opcional */ }
        break;
      }
      case S.REGION_INFO: {
        let info = null;
        try { info = r.getJson(); } catch (e) { info = null; }
        if (!info) break;
        state.info = info;
        if (info.parcel && !state.parcel) state.parcel = info.parcel;
        if (Array.isArray(info.spawn)) state.spawn = info.spawn;
        // El agua se anuncia DESPUES del terreno: si aqui se volviese a entrar
        // en modo exterior, `useExternalTerrain` rellenaria las alturas con su
        // base plana y borraria los 256 parches que acaban de llegar (el mundo
        // salia flotando sobre una llanura). Solo se cambia el nivel del agua.
        if (info.waterLevel !== undefined && terrain.useExternalTerrain && !terrain.external) {
          terrain.useExternalTerrain({ waterLevel: info.waterLevel, base: info.waterLevel - 4 });
        }
        break;
      }
      case S.STATS: {
        let st = null;
        try { st = r.getJson(); } catch (e) { st = null; }
        if (st) {
          state.simFps = st.simFps || 0;
          state.agents = st.agents || 0;
        }
        break;
      }
      case S.CAPS: { try { state.caps = r.getJson(); } catch (e) { /* opcional */ } break; }
      case S.INVENTORY: { try { state.inventory = r.getJson(); } catch (e) { /* opcional */ } break; }
      default: break;
    }
  }

  function onLinkState(s) {
    state.link = s.link;
    if (s.region) state.region = s.region;
    if (s.phase !== undefined && s.phase !== state.phase) setPhase(s.phase, s.progress, s.text);
    if (s.link === "ready" && !state.ready && state.phase < PHASE.ENTERING) {
      // Enlace listo: ahora las credenciales.
      setPhase(PHASE.LOGIN_REQUEST, 1, "iniciando sesion…");
      sendLogin();
    }
    if (s.link === "closed" || s.link === "idle") {
      // Enlace perdido: cuando vuelva, hay que volver a presentarse.
      loginSent = false;
      if (state.ready) {
        state.ready = false;
        state.error = "se ha perdido el enlace con el retransmisor";
        onLog(state.error, "warn");
      }
    }
    onStatus(state);
  }

  // La region ha terminado de llegar: se coloca al avatar dentro.
  function becomeReady() {
    if (state.ready) return;
    state.ready = true;
    welcome();
    onReady(state);
    onLog("En la region «" + ((state.region && state.region.name) || "?") + "».", "region");
  }

  function welcome() {
    const sp = state.spawn || [0, 0, 0];
    let y = 0;
    try {
      y = terrain.heightAt(sp[0], sp[2]) + 1.2;
    } catch (e) { y = (sp[1] || 0) + 1.2; }
    viewer.teleport(sp[0], Math.max(y, (sp[1] || 0) + 0.5), sp[2]);
  }

  // Salto pedido desde el mapa o desde el panel de sitios. Es un movimiento
  // DENTRO de la region (no un teletransporte a otra region), asi que se mueve
  // el avatar aqui y se manda una pose en el acto para que la region lo vea ya
  // en vez de esperar al siguiente fotograma de pose.
  function teleport(x, y, z) {
    if (!viewer) return null;
    const ty = (y === undefined || y === null) ? terrain.heightAt(x, z) + 0.4 : y;
    viewer.teleport(x, ty, z);
    state.teleports = (state.teleports || 0) + 1;
    if (state.ready) sendPose();
    return true;
  }

  // --- salida del avatar ----------------------------------------------------

  function sendPose() {
    if (!relay || !state.ready) return;
    const av = viewer.avatar;
    if (!av) return;
    relay.sendMove({ x: av.position.x, y: av.position.y, z: av.position.z }, av.yaw || 0,
      (av.flying ? 1 : 0) | 2);
    state.poseSent++;
    lastPose = { x: av.position.x, y: av.position.y, z: av.position.z, yaw: av.yaw || 0 };
    poseAt = performance.now();
  }

  // Chat del usuario (o de los scripts de sus prims): viaja al retransmisor.
  function onLocalChat(line) {
    if (!line || !line.broadcast) return;
    if (!relay || !state.ready) return;
    const kind = line.kind === "shout" ? CHAT_KIND.shout : (line.kind === "whisper" ? CHAT_KIND.whisper : CHAT_KIND.say);
    relay.sendChat(kind, line.channel || 0, String(line.text || "").slice(0, 480));
  }

  // Tocar un prim: se manda su uuid, que es lo que entiende un simulador de SL.
  function touchAt(clientX, clientY) {
    if (!relay || !state.ready) return null;
    const T = world.THREE;
    const rect = viewer.canvas.getBoundingClientRect();
    const ndc = new T.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const rc = new T.Raycaster();
    rc.setFromCamera(ndc, viewer.camera);
    const hits = world.raycast(rc);
    const hit = hits && hits.length ? hits[0] : null;
    const obj = hit && (hit.object ? hit.object.userData.slPrim : hit.prim);
    const uuid = obj && (obj.slUuid || null);
    relay.sendInteract(0, uuid || ZERO_UUID);
    state.interacts++;
    onLog(uuid ? ("tocas " + (obj.name || "un prim")) : "no hay nada que tocar ahi", "region");
    return obj || null;
  }

  // --- enlace de pantalla ---------------------------------------------------

  let pointerStart = null;
  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    pointerStart = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  }
  function onPointerUp(e) {
    const s = pointerStart;
    pointerStart = null;
    if (!s || s.id !== e.pointerId) return;
    if (Math.abs(e.clientX - s.x) > 6 || Math.abs(e.clientY - s.y) > 6) return;
    if (performance.now() - s.t > 600) return;
    if (isBuildMode()) return;
    try { touchAt(e.clientX, e.clientY); } catch (err) { /* sin mundo que tocar */ }
  }

  // --- arranque -------------------------------------------------------------

  function makeRelay() {
    if (opts.mock) {
      const m = createMockRelay({ seed: opts.seed, residents: opts.residents });
      // El servidor de pruebas necesita una vuelta del bucle para existir antes
      // de que el cliente salude: el par de pruebas ya lo tiene todo montado.
      return { relay: null, mock: m };
    }
    return {
      mock: null,
      relay: createRelay({
        url: opts.url || "",
        socketFactory: opts.socketFactory,
        client: "visor-perchance",
        onMessage,
        onState: onLinkState,
        onError: (text, extra) => {
          state.error = text;
          onLog(text + (extra && extra.fatal ? " (fatal)" : ""), "error");
        },
        onClose: (ev) => {
          if (disposed) return;
          if (ev && ev.code) onLog("enlace cerrado (" + ev.code + ")", "warn");
        },
      }),
    };
  }

  function connect() {
    if (disposed) return;
    const built = makeRelay();
    loginSent = false;
    diag.info("sesion", "conectando" + (built.mock ? " con el simulador de pruebas" : (opts.url ? " con " + opts.url : "")));
    // Abrir una sesion = el terreno y los prims los manda la region, no la
    // arena de pruebas. Se pasa a terreno exterior YA (antes de que llegue el
    // primer parche), para que mientras se entra no se vea el terreno generado
    // debajo del que esta en camino.
    if (replaceWorld) {
      try { terrain.useExternalTerrain(); } catch (e) { /* terreno sin capa exterior */ }
    }
    if (built.mock) {
      const m = built.mock;
      relay = createRelay({
        url: m.url, socketFactory: m.socketFactory,
        onMessage, onState: onLinkState,
        onError: (text) => { state.error = text; onLog(text, "error"); },
      });
      state.mock = true;
      state.mockLabel = m.label;
      state.mockServer = m.server;
    } else {
      relay = built.relay;
    }
    world.onAssetNeeded = requestAsset;
    const rt = getRt();
    if (rt && rt.on) rt.on("chat", onLocalChat);
    viewer.canvas.addEventListener("pointerdown", onPointerDown);
    viewer.canvas.addEventListener("pointerup", onPointerUp);
    setPhase(PHASE.HANDSHAKE, 0, PHASE_TEXT[PHASE.HANDSHAKE]);
  }

  function disconnect() {
    if (relay) { try { relay.close(); } catch (e) { /* ya cerrado */ } }
    relay = null;
    state.ready = false;
    diag.info("sesion", "sesión cerrada");
    setPhase(PHASE.DISCONNECTED, 0, PHASE_TEXT[PHASE.DISCONNECTED]);
  }

  function update(dt) {
    syncState();
    state.elapsed += dt || 0;

    if (tq.length) {
      const list = tq.splice(0, TERRAIN_PER_FRAME);
      try { terrain.applyPatches(list); } catch (e) { /* parche raro: se ignora */ }
      state.patches += list.length;
      if (!state.ready && state.phase < PHASE.ENTERING) setPhase(PHASE.ENTERING, 5, "recibiendo el terreno…");
    }

    if (oq.length) {
      const batch = oq.splice(0, OBJECTS_PER_FRAME);
      for (const o of batch) applyObject(o.rec, o.uuid, o.parent);
      resolveLinks();
      if (!state.ready && state.phase < PHASE.ENTERING) setPhase(PHASE.ENTERING, 55, "recibiendo los objetos…");
    }

    if (aq.length) {
      assetAcc += dt || 0;
      for (let i = 0; i < ASSET_REQ_PER_FRAME && aq.length; i++) {
        if (!relay || !state.ready) break;
        relay.request(RES.TEXTURE, aq.shift());
      }
    }

    if (state.ready) {
      poseAcc += dt || 0;
      if (poseAcc >= 1 / POSE_HZ) {
        poseAcc = 0;
        const av = viewer.avatar;
        if (av) {
          const moved = Math.abs(av.position.x - lastPose.x) + Math.abs(av.position.y - lastPose.y) + Math.abs(av.position.z - lastPose.z);
          const dyaw = Math.abs((av.yaw || 0) - lastPose.yaw);
          if (moved > POSE_EPS || dyaw > 0.03 || performance.now() - poseAt > 2000) sendPose();
        }
      }
    }

    // Se entra cuando el rele dice READY *y* ya se ha vaciado lo que venia en
    // camino: si se entra antes, el avatar aparece sobre un mundo a medias y se
    // cae al vacio mientras el terreno sigue llegando.
    if (!state.ready && state.phase === PHASE.READY && state.link === "ready" && !tq.length && !oq.length) becomeReady();
  }

  function dispose() {
    disposed = true;
    if (relay) { try { relay.close(); } catch (e) { /* ya cerrado */ } }
    relay = null;
    if (viewer && viewer.canvas) {
      viewer.canvas.removeEventListener("pointerdown", onPointerDown);
      viewer.canvas.removeEventListener("pointerup", onPointerUp);
    }
    for (const tex of assetTex.values()) if (tex && tex.dispose) tex.dispose();
    assetTex.clear();
    world.onAssetNeeded = null;
  }

  // --- informacion ----------------------------------------------------------

  function statusText() {
    if (state.error) return state.error;
    const r = state.region && (state.region.name || state.region.handle);
    const bits = [];
    if (r) bits.push(r);
    if (state.ready) bits.push(state.objects + " prims");
    else if (state.phase !== PHASE.IDLE) bits.push(state.text);
    if (state.pingMs) bits.push(state.pingMs + " ms");
    return bits.join(" · ") || state.text || "sin sesion";
  }

  function stats() {
    return {
      link: state.link, phase: state.phase, text: state.text, ready: state.ready,
      region: state.region, mock: state.mock, error: state.error,
      patches: state.patches, objects: state.objects, avatars: state.avatars,
      assets: state.assets, chats: state.chats, poseSent: state.poseSent,
      interacts: state.interacts, kbIn: state.kbIn, kbOut: state.kbOut,
      pingMs: state.pingMs, simFps: state.simFps, agents: state.agents,
      parcel: state.parcel, missing: state.missing,
      pending: { terrain: tq.length, objects: oq.length, assets: aq.length },
      peers: peers ? peers.count() : 0,
      elapsed: Math.round(state.elapsed * 10) / 10,
    };
  }

  return {
    state, stats, statusText, update, connect, disconnect, dispose,
    sendLogin, sendPose, touchAt, requestAsset, teleport,
    // Utiles para la pantalla de arranque y para las pruebas en vivo.
    get relay() { return relay; },
    get mockServer() { return state.mockServer || null; },
    setCredentials(c) { pending = c; return pending; },
    get credentials() { return pending; },
    // Atajos de teclado de la arena de pruebas: en una region de verdad el
    // mundo lo manda el retransmisor, no el panel de construccion.
    get remote() { return true; },
  };
}
