// relay.js -- el enlace con el retransmisor: el protocolo y el transporte.
//
// POR QUE HACE FALTA UN RETRANSMISOR
// ----------------------------------
// Un navegador NO puede hablar con un simulador de Second Life. Los
// simuladores hablan LLUDP: UDP en crudo, con su propia cabecera, su numeracion
// de secuencia y su cifrado por XOR. El navegador no tiene sockets UDP (ni
// WebRTC ni WebTransport llegan ahi), y ademas las capabilities de la region
// son HTTP sin cabeceras CORS. Esto no es una limitacion de este proyecto: es
// la razon por la que SpeedLight, Lumiya, Radegast o el visor de Alchemy
// funcionan con un componente que NO esta en el navegador.
//
//   navegador  ──WebSocket──►  retransmisor (maquina propia)  ──LLUDP──►  simulador
//        (esto)                    (lo que hay que levantar)
//
// El retransmisor (gateway) mantiene el circuito UDP: handshake, region
// handshake, caps HTTP, terreno, objetos, avatares, texturas. Al navegador le
// manda exactamente lo que hace falta para dibujar, en el formato de este
// fichero. El retransmisor NO tiene que ser escrito desde cero: el protocolo
// LLUDP esta implementado en Hippolyzer (Python) y en rustmetaverse (Rust); ver
// src/VIEWER-REAL.md, que trae la especificacion de este protocolo lado a lado
// con las tramas de SL.
//
// Este modulo define el protocolo (codificacion de tramas y tipos de mensaje)
// y el transporte (WebSocket con reconexion, latido y medida de ida y vuelta).
// No sabe nada de Second Life: por eso el mismo cliente sirve para el
// retransmisor de verdad y para el simulador de pruebas de src/sl/mockServer.js.
//
// FORMATO DE TRAMA
// ----------------
// Un mensaje de WebSocket = una trama. Empieza por un byte de tipo y sigue el
// cuerpo, en little-endian (src/sl/bin.js). Los cuerpos con muchos campos
// variables (registros de objetos, avatares, inventario) mandan el resto como
// JSON con la longitud delante: asi el protocolo se puede ampliar sin romper
// los clientes viejos.
//
//   [u8 tipo][cuerpo...]

import { Writer, Reader, utf8, fromUtf8 } from "./bin.js";

export const PROTOCOL = 1;

// --- tipos de mensaje -------------------------------------------------------

// Navegador -> retransmisor.
export const C = {
  HELLO: 0x01,       // {protocol, client, version, capabilities[]}
  LOGIN: 0x02,       // {mode:"session"|"credentials", ...}
  CHAT: 0x03,        // kind u8, canal i16, texto
  MOVE: 0x04,        // pos f32x3, giro f32, banderas u8
  INTERACT: 0x05,    // accion u8, uuid del objeto
  TELEPORT: 0x06,    // region(str) + pos f32x3
  REQUEST: 0x07,     // que u8, identificador (str: uuid o nombre de recurso)
  PING: 0x08,        // t f64
  LOGOUT: 0x09,
  OBJECT_EDIT: 0x0a, // uuid + json {position, quaternion, scale, delete, ...}
  PARCEL_EDIT: 0x0b, // json {name, desc, flags, ...}
  INVENTORY: 0x0c,   // que u8 (0=raiz, 1=carpeta, 2=crear, 3=borrar), uuid, json
  GROUP_IM: 0x0d,    // uuid + texto (chat de grupo / mensaje instantaneo)
};

// Retransmisor -> navegador.
export const S = {
  WELCOME: 0x81,        // {protocol, region, regionHandle, ...}
  STATE: 0x82,          // estado u8, progreso u8, texto
  ERROR: 0x83,          // gravedad u8, codigo, texto
  TERRAIN: 0x84,        // parche u8 u8 + 16x16 f32
  OBJECT: 0x85,         // uuid + padre uuid + json del registro
  OBJECT_UPDATE: 0x86,  // uuid + json parcial
  OBJECT_REMOVE: 0x87,  // uuid
  AVATAR: 0x88,         // uuid + json
  AVATAR_UPDATE: 0x89,  // uuid + pos f32x3 + giro f32x4 + banderas u8 (bit0 vuela, bit1 escribe)
  AVATAR_REMOVE: 0x8a,  // uuid
  CHAT: 0x8b,           // de uuid + nombre + tipo u8 + canal i16 + pos f32x3 + texto
  ASSET: 0x8c,          // uuid + clase u8 (+ ancho/alto si RGBA8) + bytes (ver putAsset)
  PARCEL: 0x8f,         // json
  PONG: 0x90,           // t del cliente f64 + t del servidor f64
  STATS: 0x91,          // json {pingMs, packetLoss, kbIn, kbOut, simFps}
  INVENTORY: 0x92,      // json
  CAPS: 0x93,           // json {nombre: url}
  OBJECTS_BEGIN: 0x94,  // cuantos objetos va a mandar el retransmisor
  OBJECTS_END: 0x95,
  REGION_INFO: 0x96,    // json (parcela, agua, tamano, version del simulador)
};

export const C_NAME = namesOf(C);
export const S_NAME = namesOf(S);

function namesOf(table) {
  const out = {};
  for (const k of Object.keys(table)) out[table[k]] = k;
  return out;
}

// Tipos de recurso para REQUEST/ASSET.
export const RES = { TEXTURE: 0, MESH: 1, ANIM: 2, SOUND: 3, NOTECARD: 4, INVENTORY: 5 };
// Clases de dato dentro de ASSET.
export const ASSET_FORMAT = { J2C: 0, JPEG: 1, PNG: 2, RGBA8: 3, LLMESH: 4, TEXT: 5, OGG: 6 };

// Tipos de linea de chat (el byte que va en C.CHAT y S.CHAT). Los nombres son
// los mismos que usa el runtime de scripts (`src/lsl/runtime.js`).
export const CHAT_KIND = { say: 0, whisper: 1, shout: 2, region: 3 };
export const CHAT_KIND_NAME = ["say", "whisper", "shout", "region"];

// Disposicion de S.ASSET: uuid + clase u8 + [si es RGBA8: ancho u16, alto u16]
// + bytes del recurso. Los formatos comprimidos (J2C/JPEG/PNG/LLMESH) llevan
// sus propias dimensiones en la cabecera del archivo.
export function putAsset(w, a) {
  w.putUuid(a.uuid || ZERO_UUID).putU8(a.format || 0);
  if ((a.format || 0) === ASSET_FORMAT.RGBA8) w.putU16(a.width || 0).putU16(a.height || 0);
  w.putBytes(a.data || EMPTY_BYTES);
  return w;
}

export function readAsset(r) {
  const uuid = r.getUuid();
  const format = r.getU8();
  let width = 0, height = 0;
  if (format === ASSET_FORMAT.RGBA8) { width = r.getU16(); height = r.getU16(); }
  const data = r.getBytes(r.remaining);
  return { uuid, format, width, height, data };
}

const EMPTY_BYTES = new Uint8Array(0);

// Estados que manda el retransmisor (S.STATE) para que la pantalla de arranque
// pueda contarlos en castellano.
export const PHASE = {
  IDLE: 0,
  HANDSHAKE: 1,      // circuito UDP: UseCircuitCode / RegionHandshake
  LOGIN_REQUEST: 2,  // pidiendo la sesion a Linden Lab
  ENTERING: 3,       // entrando en la region: caps, terreno, objetos
  READY: 4,
  TELEPORT: 5,
  DISCONNECTED: 6,
};
export const PHASE_TEXT = {
  0: "en espera",
  1: "abriendo el circuito con el simulador…",
  2: "iniciando sesion…",
  3: "entrando en la region…",
  4: "en la region",
  5: "teletransportando…",
  6: "desconectado",
};

// --- tramas -----------------------------------------------------------------

export function encode(type, write) {
  const w = new Writer(64);
  w.putU8(type);
  if (typeof write === "function") write(w);
  return w.copy();
}

export function encodeJson(type, obj) {
  return encode(type, (w) => w.putJson(obj));
}

export function decode(u8) {
  const r = new Reader(u8);
  const type = r.getU8();
  return { type, r };
}

export function typeName(type) {
  return C_NAME[type] || S_NAME[type] || ("0x" + type.toString(16));
}

// --- latido y reconexion ----------------------------------------------------

const PING_MS = 8000;         // latido si no hay trafico
const PONG_TIMEOUT_MS = 6000; // sin respuesta: se da la conexion por muerta
const HANDSHAKE_MS = 8000;    // tiempo maximo para HELLO/WELCOME
const PING_TICK_MS = 2000;    // cada cuanto mira el vigilante
const STALL_TICKS = 3;        // latidos sin respuesta antes de dar el enlace por muerto
const FROZEN_TICK_MS = 4000;  // un intervalo mas largo que esto = la pagina estuvo parada

// Un paso del vigilante del latido. Devuelve:
//   "vivo"    -> no hay ningun latido esperando respuesta (o lo acabamos de perdonar)
//   "paron"   -> el propio navegador dejo la pagina parada (pestana de fondo,
//                WebView congelado): el hueco NO es culpa del otro extremo, asi
//                que se perdona y se reinicia la cuenta
//   "silencio"-> hay un latido sin contestar, pero aun no son suficientes
//   "muerto"  -> STALL_TICKS ticks con un latido sin contestar: el enlace cayo
//
// Un enlace CALLADO no es un enlace muerto. Esto es importante: el enlace solo
// lleva tramas cuando pasa algo (terreno, objetos, chat, cambios de fase), asi
// que estando ya dentro lo normal es que no llegue nada durante muchos segundos.
// Lo que delata a un extremo muerto es un LATIDO que se queda sin respuesta.
// (La version anterior daba el enlace por muerto solo por silencio: un enlace
// sano y callado se mataba el solo en unos segundos, y el usuario veia "se ha
// perdido el enlace con el retransmisor" / "enlace cerrado (1000)".)
//
// Estar fuera del cierre de `createRelay` deja probarlo sin relojes de verdad.
export function pasoVigilante(st, now, gap) {
  if (gap > FROZEN_TICK_MS) {
    st.frozenTicks = (st.frozenTicks || 0) + 1;
    st.lastPauseMs = Math.round(gap);
    st.lastRecv = Math.max(st.lastRecv, now);
    st.lastPong = Math.max(st.lastPong, now);
    st.pendingPing = 0;   // el latido que hubiera en vuelo se quedo en el paron
    st.missedTicks = 0;
    return "paron";
  }
  const pend = st.pendingPing || 0;
  if (pend > 0 && now - pend > PONG_TIMEOUT_MS) {
    st.missedTicks = (st.missedTicks || 0) + 1;
    if (st.missedTicks < STALL_TICKS) return "silencio";
    st.missedTicks = 0;
    return "muerto";
  }
  st.missedTicks = 0;
  return "vivo";
}

function noop() {}

// `socketFactory(url)` devuelve algo con la interfaz minima de WebSocket
// (addEventListener, send, close, binaryType). Asi el mismo cliente habla con
// un WebSocket de verdad o con el par de pruebas (loopbackPair).
export function createRelay(opts) {
  const o = opts || {};
  const url = o.url || "";
  const customFactory = !!o.socketFactory;
  const factory = o.socketFactory || ((u) => new WebSocket(u));
  const onMessage = o.onMessage || noop;   // (type, reader, raw)
  const onState = o.onState || noop;       // (estado del enlace)
  const onError = o.onError || noop;       // (texto)
  const onWelcome = o.onWelcome || noop;   // (info de la region)
  const onClose = o.onClose || noop;
  const clientName = o.client || "visor-perchance";
  const version = o.version || "0.1.0";
  const capabilities = o.capabilities || ["terrain", "objects", "avatars", "chat", "assets", "inventory", "parcels"];
  const autoConnect = o.autoConnect !== false;
  const maxBackoff = o.maxBackoff === undefined ? 20000 : o.maxBackoff;

  const st = {
    socket: null, link: "idle",        // idle | connecting | open | ready | closed | error
    protocol: null, attempts: 0, closed: false,
    rtt: 0, rttMin: 0, rttMax: 0, rttSamples: 0,
    lastPong: 0, lastSend: 0, lastRecv: 0,
    phase: PHASE.IDLE, progress: 0, phaseText: PHASE_TEXT[PHASE.IDLE],
    region: null, welcome: null, authModes: [], error: null, mock: false,
    bytesIn: 0, bytesOut: 0, framesIn: 0, framesOut: 0,
    pingTimer: null, retryTimer: null, handshakeTimer: null, pongTimer: null,
    pendingPing: 0, missedTicks: 0, frozenTicks: 0, lastPauseMs: 0,
  };

  function setLink(link) {
    if (st.link === link) return;
    st.link = link;
    onState({ link, phase: st.phase, progress: st.progress, text: st.phaseText, region: st.region, rtt: st.rtt });
  }
  function setPhase(p, progress, text) {
    st.phase = p;
    if (progress !== undefined && progress !== null) st.progress = progress;
    st.phaseText = text || PHASE_TEXT[p] || "";
    onState({ link: st.link, phase: st.phase, progress: st.progress, text: st.phaseText, region: st.region, rtt: st.rtt });
  }

  function connect() {
    if (st.socket || st.closed) return;
    // Con el WebSocket del navegador, una direccion que no sea ws(s) no se
    // puede abrir nunca: se avisa y no se reintenta (reintentar una direccion
    // imposible solo llena la consola y deja la interfaz girando para siempre).
    if (!customFactory && !/^wss?:\/\//i.test(url)) {
      st.error = url ? "la direccion del retransmisor no es un WebSocket: " + url : "no hay direccion de retransmisor";
      setLink("error");
      onError(st.error, { fatal: true });
      return;
    }
    let socket;
    try { socket = factory(url); } catch (e) {
      st.error = "no se pudo abrir el enlace: " + (e && e.message ? e.message : e);
      setLink("error");
      onError(st.error);
      scheduleRetry();
      return;
    }
    st.socket = socket;
    try { socket.binaryType = "arraybuffer"; } catch (e) { /* da igual */ }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessageEv);
    socket.addEventListener("close", onCloseEv);
    socket.addEventListener("error", onErrorEv);
    setLink("connecting");
  }

  function onOpen() {
    st.attempts = 0;
    st.lastRecv = performance.now();
    setLink("open");
    sendJson(C.HELLO, { protocol: PROTOCOL, client: clientName, version, capabilities });
    if (st.handshakeTimer) clearTimeout(st.handshakeTimer);
    st.handshakeTimer = setTimeout(() => {
      if (st.link === "open") {
        st.error = "el retransmisor no responde al saludo";
        onError(st.error);
        try { st.socket.close(); } catch (e) { /* ya cerrado */ }
      }
    }, HANDSHAKE_MS);
    startPing();
  }

  function onMessageEv(ev) {
    const d = ev && ev.data;
    let u8 = null;
    if (d instanceof ArrayBuffer) u8 = new Uint8Array(d);
    else if (d && d.buffer instanceof ArrayBuffer) u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    else return;
    if (u8.length < 1) return;
    st.bytesIn += u8.length;
    st.framesIn++;
    st.lastRecv = performance.now();
    let frame;
    try { frame = decode(u8); } catch (e) {
      onError("trama ilegible: " + (e && e.message ? e.message : e));
      return;
    }
    switch (frame.type) {
      case S.WELCOME: {
        if (st.handshakeTimer) { clearTimeout(st.handshakeTimer); st.handshakeTimer = null; }
        let info = null;
        try { info = frame.r.getJson(); } catch (e) { info = null; }
        info = info || {};
        st.welcome = info;
        st.protocol = info.protocol || null;
        st.region = info.region || null;
        st.authModes = Array.isArray(info.authModes) ? info.authModes : ["session"];
        st.mock = !!info.mock;
        setLink("ready");
        onWelcome(info);
        break;
      }
      case S.STATE: {
        const phase = frame.r.getU8();
        const progress = frame.r.getU8();
        let text = "";
        try { text = frame.r.getStr(); } catch (e) { text = ""; }
        setPhase(phase, progress, text || PHASE_TEXT[phase]);
        break;
      }
      case S.ERROR: {
        const fatal = frame.r.getU8();
        let code = "";
        let text = "";
        try { code = frame.r.getStr(); text = frame.r.getStr(); } catch (e) { /* mensaje corto */ }
        st.error = text || code || "error del retransmisor";
        onError(st.error, { fatal: !!fatal, code });
        break;
      }
      case S.PONG: {
        let t = 0;
        try { t = frame.r.getF64(); } catch (e) { t = st.pendingPing; }
        const now = performance.now();
        if (t > 0) {
          const ms = Math.max(0, Math.round(now - t));
          st.rtt = st.rtt ? Math.round(st.rtt * 0.7 + ms * 0.3) : ms;
          st.rttMin = st.rttMin ? Math.min(st.rttMin, ms) : ms;
          st.rttMax = Math.max(st.rttMax, ms);
          st.rttSamples++;
          st.lastPong = now;
        }
        if (st.pongTimer) { clearTimeout(st.pongTimer); st.pongTimer = null; }
        break;
      }
      default:
        break;
    }
    // Cualquier trama que llegue (no solo un PONG) prueba que el otro extremo
    // sigue ahi, asi que el latido pendiente queda contestado.
    st.pendingPing = 0;
    onMessage(frame.type, frame.r, u8);
  }

  function onCloseEv(ev) {
    const code = ev && ev.code ? ev.code : 0;
    st.socket = null;
    st.protocol = null;
    stopTimers();
    if (st.closed) { setLink("closed"); return; }
    setLink("idle");
    setPhase(PHASE.DISCONNECTED, 0);
    onClose({ code, reason: (ev && ev.reason) || "" });
    scheduleRetry(code);
  }

  function onErrorEv() {
    // El cierre que sigue trae el detalle; aqui solo se anota.
    st.error = st.error || "fallo del enlace";
  }

  function scheduleRetry(code) {
    if (st.retryTimer || st.closed) return;
    const n = Math.min(st.attempts, 6);
    let wait = Math.min(maxBackoff, 700 * Math.pow(1.7, n)) * (0.8 + Math.random() * 0.4);
    if (code === 1011 || code === 1013) wait = Math.max(wait, 8000); // el servidor fallo al arrancar
    st.attempts++;
    setLink("connecting");
    st.retryTimer = setTimeout(() => { st.retryTimer = null; connect(); }, wait);
  }

  // Vigilante del latido. La decision vive en `pasoVigilante` (fuera de este
  // cierre) para poder probarla sin esperar minutos de reloj.
  //
  // Dos cosas que se aprendieron a base de romperlo en el movil:
  //  * la pagina se congela de verdad (pestana en segundo plano, WebView
  //    suspendido, un paron largo montando la region) y al volver
  //    `performance.now()` ha saltado varios segundos: ese hueco NO es culpa del
  //    otro extremo y se perdona.
  //  * un enlace callado no esta muerto. ANTES este bucle solo mandaba el latido
  //    cuando el contador de silencio estaba a cero, asi que un enlace sin nada
  //    que contar (lo normal estando ya dentro) se moria el solo: el usuario
  //    veia "se ha perdido el enlace con el retransmisor" y un "enlace cerrado
  //    (1000)" sin motivo. Ahora el latido se manda siempre que toque, y lo que
  //    mata el enlace es un latido SIN respuesta.
  function startPing() {
    if (st.pingTimer) return;
    let lastTick = performance.now();
    st.missedTicks = 0;
    st.pendingPing = 0;
    st.pingTimer = setInterval(() => {
      if (!st.socket) return;
      const now = performance.now();
      const gap = now - lastTick;
      lastTick = now;
      const paso = pasoVigilante(st, now, gap);
      if (paso === "muerto") {
        st.error = "el retransmisor no contesta";
        onError("el retransmisor no contesta a los latidos (" +
          Math.round((now - (st.lastRecv || now)) / 1000) + " s sin una sola trama)");
        try { st.socket.close(); } catch (e) { /* ya cerrado */ }
        return;
      }
      if (now - st.lastSend > PING_MS) ping();
    }, PING_TICK_MS);
  }

  function stopTimers() {
    if (st.pingTimer) { clearInterval(st.pingTimer); st.pingTimer = null; }
    if (st.handshakeTimer) { clearTimeout(st.handshakeTimer); st.handshakeTimer = null; }
    if (st.pongTimer) { clearTimeout(st.pongTimer); st.pongTimer = null; }
  }

  function raw(u8) {
    const s = st.socket;
    if (!s) return false;
    try { s.send(u8); } catch (e) { return false; }
    st.bytesOut += u8.length;
    st.framesOut++;
    st.lastSend = performance.now();
    return true;
  }

  function send(type, write) { return raw(encode(type, write)); }
  function sendJson(type, obj) { return raw(encodeJson(type, obj)); }

  function ping() {
    const t = performance.now();
    st.pendingPing = t;
    send(C.PING, (w) => w.putF64(t));
    if (st.pongTimer) clearTimeout(st.pongTimer);
    st.pongTimer = setTimeout(() => {
      st.pongTimer = null;
      if (st.rttSamples === 0) st.rtt = 0;
    }, PONG_TIMEOUT_MS);
  }

  // --- mensajes concretos (azucar sobre send/sendJson) ---

  const api = {
    state: st,
    connect,
    close(code) {
      st.closed = true;
      stopTimers();
      if (st.retryTimer) { clearTimeout(st.retryTimer); st.retryTimer = null; }
      const s = st.socket;
      st.socket = null;
      if (s) { try { s.close(code || 1000, "adios"); } catch (e) { /* ya cerrado */ } }
      setLink("closed");
    },
    reconnect() { st.closed = false; st.attempts = 0; connect(); },
    get connected() { return !!st.socket && (st.link === "open" || st.link === "ready"); },
    get ready() { return st.link === "ready"; },
    send, sendJson, ping,
    setName(name) { sendJson(C.HELLO, { protocol: PROTOCOL, client: clientName, version, capabilities, name }); },
    // Inicio de sesion: la sesion ya obtenida por HTTP, o las credenciales para
    // que el retransmisor haga el login (ver VIEWER-REAL.md).
    sendSession(credentials) {
      sendJson(C.LOGIN, Object.assign({ mode: "session" }, credentials));
    },
    sendCredentials(info) {
      sendJson(C.LOGIN, Object.assign({ mode: "credentials" }, info));
    },
    sendChat(kind, channel, text) {
      return send(C.CHAT, (w) => { w.putU8(kind || 0).putI16(channel || 0).putStr32(text || ""); });
    },
    sendMove(pos, yaw, flags) {
      return send(C.MOVE, (w) => {
        w.putF32(pos && pos.x).putF32(pos && pos.y).putF32(pos && pos.z).putF32(yaw || 0).putU8(flags || 0);
      });
    },
    sendInteract(action, uuid) {
      return send(C.INTERACT, (w) => { w.putU8(action || 0).putUuid(uuid || ZERO_UUID); });
    },
    sendTeleport(region, pos) {
      return send(C.TELEPORT, (w) => {
        w.putStr(region || "").putF32(pos && pos.x).putF32(pos && pos.y).putF32(pos && pos.z);
      });
    },
    request(what, id) {
      return send(C.REQUEST, (w) => {
        w.putU8(what || 0);
        w.putStr(id === undefined || id === null ? "" : "" + id);
      });
    },
    editObject(uuid, changes) {
      return send(C.OBJECT_EDIT, (w) => { w.putUuid(uuid || ZERO_UUID).putJson(changes || {}); });
    },
    logout() { send(C.LOGOUT, null); },
    // Texto del estado del enlace para la barra del visor.
    statusText() {
      if (st.link === "ready") {
        const r = st.region && (st.region.name || st.region.handle);
        return "relay" + (r ? " · " + r : "") + (st.rtt ? " · " + st.rtt + " ms" : "");
      }
      if (st.link === "open") return "relay · presentandose";
      if (st.link === "connecting") return "relay · conectando";
      if (st.link === "error") return "relay · error";
      if (st.link === "closed") return "relay · desconectado";
      return "relay · en espera";
    },
  };

  if (autoConnect && url) connect();
  return api;
}

export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// --- par de pruebas ---------------------------------------------------------
//
// Un WebSocket de mentira, en el mismo hilo: lo que se manda por un lado llega
// al otro con el mismo formato (ArrayBuffer), y el orden se respeta. Es lo que
// usa el simulador de pruebas (src/sl/mockServer.js) y los autotests, para
// poder desarrollar la mitad del navegador sin levantar el retransmisor.

export function loopbackPair() {
  const mk = () => {
    const listeners = { open: [], message: [], close: [], error: [] };
    const s = {
      binaryType: "arraybuffer",
      readyState: 0,
      peer: null,
      addEventListener(t, fn) { (listeners[t] || (listeners[t] = [])).push(fn); },
      removeEventListener(t, fn) {
        const a = listeners[t];
        if (!a) return;
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      },
      send(data) {
        const peer = s.peer;
        if (!peer || peer.readyState !== 1) return;
        let payload;
        if (data instanceof Uint8Array) payload = data.slice().buffer;
        else if (data instanceof ArrayBuffer) payload = data.slice(0);
        else payload = utf8(String(data)).buffer;
        setTimeout(() => { if (peer.readyState === 1) peer.emit("message", { data: payload }); }, 0);
      },
      close(code, reason) {
        if (s.readyState === 3) return;
        s.readyState = 3;
        const peer = s.peer;
        setTimeout(() => {
          s.emit("close", { code: code || 1000, reason: reason || "" });
          if (peer && peer.readyState === 1) { peer.readyState = 3; peer.emit("close", { code: 1006, reason: "el otro extremo cerro" }); }
        }, 0);
      },
      emit(type, ev) { for (const fn of (listeners[type] || []).slice()) { try { fn(ev); } catch (e) { /* el que escucha se apaña */ } } },
    };
    return s;
  };
  const a = mk();
  const b = mk();
  a.peer = b;
  b.peer = a;
  const open = () => {
    if (a.readyState === 1) return;
    a.readyState = 1;
    b.readyState = 1;
    a.emit("open", {});
    b.emit("open", {});
  };
  setTimeout(open, 0);
  return { client: a, server: b, open, side: { a, b } };
}

// --- sonda ------------------------------------------------------------------
//
// Comprueba si en una direccion hay un retransmisor vivo y que version habla.
// Devuelve {ok, protocol, region, mock, authModes, latencyMs} o {ok:false, error}.

export function probe(url, opts) {
  const o = opts || {};
  const timeout = o.timeout === undefined ? 7000 : o.timeout;
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    let relay = null;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { if (relay) relay.close(); } catch (e) { /* ya cerrado */ }
      resolve(v);
    };
    const timer = setTimeout(() => done({ ok: false, error: "sin respuesta del retransmisor (tiempo agotado)" }), timeout);
    try {
      relay = createRelay({
        url,
        socketFactory: o.socketFactory,
        autoConnect: false,
        onWelcome(info) {
          clearTimeout(timer);
          done({
            ok: true, protocol: info.protocol || null, region: info.region || null,
            mock: !!info.mock, authModes: info.authModes || ["session"],
            relayName: info.relay || null, latencyMs: Math.round(performance.now() - t0),
          });
        },
        onError(text) { clearTimeout(timer); done({ ok: false, error: text }); },
        onClose() { clearTimeout(timer); done({ ok: false, error: "el retransmisor cerro el enlace" }); },
      });
      relay.connect();
    } catch (e) {
      clearTimeout(timer);
      done({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

// --- autotest ---------------------------------------------------------------

export function runRelaySelfTest() {
  return new Promise((resolve) => {
    const checks = [];
    const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
    const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });

    // 1. ida y vuelta de tramas, una por una, por el par de pruebas.
    const chat = encode(C.CHAT, (w) => w.putU8(3).putI16(7).putStr32("hola mundo"));
    let d = decode(chat);
    eq("trama: tipo", d.type, C.CHAT);
    eq("trama: chat", [d.r.getU8(), d.r.getI16(), d.r.getStr32()], [3, 7, "hola mundo"]);
    eq("trama: consumida", d.r.eof, true);

    const obj = encode(S.OBJECT, (w) => {
      w.putUuid("11111111-2222-3333-4444-555555555555");
      w.putUuid(ZERO_UUID);
      w.putJson({ id: 3, name: "Cubo", position: [1, 2, 3], params: { shape: "box", cut: 0.5 } });
    });
    d = decode(obj);
    eq("trama: objeto uuid", d.r.getUuid(), "11111111-2222-3333-4444-555555555555");
    eq("trama: objeto padre", d.r.getUuid(), ZERO_UUID);
    const rec = d.r.getJson();
    eq("trama: objeto json", [rec.id, rec.name, rec.position[1], rec.params.cut], [3, "Cubo", 2, 0.5]);

    const av = encode(S.AVATAR_UPDATE, (w) => {
      w.putUuid(ZERO_UUID).putF32(10.5).putF32(-2).putF32(21).putF32(0).putF32(0.7).putF32(0).putF32(0.7).putU8(3);
    });
    d = decode(av);
    d.r.getUuid();
    eq("trama: avatar", [d.r.getF32(), d.r.getF32(), d.r.getF32(), d.r.getF32()], [10.5, -2, 21, 0]);
    eq("trama: giro del avatar", [d.r.getF32(), d.r.getF32(), d.r.getF32()].map((x) => Math.round(x * 1000) / 1000), [0.7, 0, 0.7]);
    eq("trama: banderas del avatar", d.r.getU8(), 3);

    const ter = encode(S.TERRAIN, (w) => {
      w.putU8(2).putU8(5);
      for (let i = 0; i < 256; i++) w.putF32(i * 0.25);
    });
    d = decode(ter);
    eq("trama: parche", [d.r.getU8(), d.r.getU8()], [2, 5]);
    const heights = [];
    for (let i = 0; i < 256; i++) heights.push(d.r.getF32());
    eq("trama: alturas", [heights.length, heights[0], heights[255]], [256, 0, 63.75]);

    // Se codifica y descodifica con las MISMAS funciones que usa el visor
    // (`putAsset`/`readAsset`), que es lo que garantiza que las dos mitades
    // (src/sl/session.js y el retransmisor) coincidan.
    const asset = encode(S.ASSET, (w) => putAsset(w, {
      uuid: "99999999-8888-7777-6666-555555555555", format: ASSET_FORMAT.RGBA8,
      width: 2, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    }));
    d = decode(asset);
    const a = readAsset(d.r);
    eq("trama: recurso", [a.uuid, a.format, a.width, a.height, [...a.data]], [
      "99999999-8888-7777-6666-555555555555", ASSET_FORMAT.RGBA8, 2, 2,
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    ]);

    // 2. Un mensaje truncado tiene que protestar, no devolver basura.
    let threw = false;
    try { const t = decode(chat); t.r.getStr32(); } catch (e) { threw = true; }
    eq("trama truncada: avisa", threw, true);

    // 3. Cadenas con acentos y emoji (el protocolo es UTF-8).
    const uni = encode(C.CHAT, (w) => w.putU8(0).putI16(0).putStr32("cañón 🛰️ ñ"));
    d = decode(uni);
    d.r.getU8(); d.r.getI16();
    eq("trama: UTF-8", d.r.getStr32(), "cañón 🛰️ ñ");

    // 3b. El vigilante del latido. Ni un paron de la propia pagina (pestana de
    // fondo, WebView congelado) ni un enlace simplemente CALLADO pueden matar el
    // enlace: era la causa del "enlace cerrado (1000)" que veia el usuario en el
    // movil. Lo que mata el enlace es un latido SIN respuesta.
    const tl = 100000;
    const lat = { lastRecv: tl, lastPong: tl, lastSend: tl, pendingPing: 0, missedTicks: 0, frozenTicks: 0, lastPauseMs: 0 };
    eq("latido: con trafico reciente sigue vivo", pasoVigilante(lat, tl + 2000, 2000), "vivo");
    eq("latido: un paron de 9 s de la pagina se perdona", pasoVigilante(lat, tl + 11000, 9000), "paron");
    ok("latido: y queda contado para el informe", lat.frozenTicks === 1 && lat.lastPauseMs === 9000,
      lat.frozenTicks + "/" + lat.lastPauseMs);
    eq("latido: 20 s de silencio sin latido pendiente no lo matan",
      pasoVigilante(lat, tl + 31100, 2000), "vivo");
    lat.pendingPing = tl + 32000;                     // se manda un latido
    eq("latido: el latido reciente todavia no es una caida", pasoVigilante(lat, tl + 34000, 2000), "vivo");
    eq("latido: pasados 6 s sin respuesta, avisa", pasoVigilante(lat, tl + 38100, 2000), "silencio");
    eq("latido: ni el segundo tick", pasoVigilante(lat, tl + 40100, 2000), "silencio");
    eq("latido: al tercer tick sin respuesta, si", pasoVigilante(lat, tl + 42100, 2000), "muerto");
    pasoVigilante(lat, tl + 44100, 2000);             // otro tick sin respuesta
    lat.lastRecv = tl + 45000;                        // y llega una trama cualquiera
    lat.pendingPing = 0;
    eq("latido: una trama reinicia la cuenta", pasoVigilante(lat, tl + 46100, 2000), "vivo");
    eq("latido: la cuenta vuelve a cero", lat.missedTicks, 0);

    // 4. El transporte completo contra un servidor de mentira.
    const pair = loopbackPair();
    const chain = [];
    const relay = createRelay({
      url: "loopback://prueba",
      socketFactory: () => pair.client,
      autoConnect: false,
      onWelcome: (info) => chain.push("welcome:" + info.region.name),
      onState: (s) => chain.push("link:" + s.link),
      onError: (t) => chain.push("error:" + t),
      onMessage: (type) => {
        if (type === S.CHAT) chain.push("chat");
        if (type === S.PONG) chain.push("pong");
      },
    });

    pair.server.addEventListener("message", (ev) => {
      const f = decode(new Uint8Array(ev.data));
      if (f.type === C.HELLO) {
        pair.server.send(encodeJson(S.WELCOME, { protocol: PROTOCOL, region: { name: "Prueba", handle: [256, 512] }, mock: true, authModes: ["credentials"] }));
        pair.server.send(encode(S.STATE, (w) => w.putU8(PHASE.ENTERING).putU8(42).putStr("entrando")));
      } else if (f.type === C.PING) {
        const t = f.r.getF64();
        pair.server.send(encode(S.PONG, (w) => w.putF64(t).putF64(performance.now())));
      } else if (f.type === C.CHAT) {
        pair.server.send(encode(S.CHAT, (w) => { w.putUuid(ZERO_UUID).putStr("Bot").putU8(0).putI16(0).putF32(1).putF32(2).putF32(3).putStr32("recibido"); }));
      }
    });

    relay.connect();
    setTimeout(() => {
      ok("enlace: listo", relay.ready, relay.state.link);
      eq("region anunciada", relay.state.region && relay.state.region.name, "Prueba");
      eq("fase recibida", relay.state.phase, PHASE.ENTERING);
      eq("progreso recibido", relay.state.progress, 42);
      eq("modos de login", relay.state.authModes, ["credentials"]);
      ok("es simulador de pruebas", relay.state.mock === true, relay.state.mock);
      relay.ping();
      relay.sendChat(1, 0, "buenas");
      setTimeout(() => {
        ok("pong recibido", chain.indexOf("pong") >= 0, chain.join(","));
        ok("chat recibido", chain.indexOf("chat") >= 0, chain.join(","));
        ok("ida y vuelta medida", relay.state.rtt >= 0 && relay.state.rttSamples >= 1, relay.state.rtt);
        ok("bytes contados", relay.state.bytesIn > 0 && relay.state.bytesOut > 0, relay.state.bytesIn + "/" + relay.state.bytesOut);
        ok("texto de estado", /Prueba/.test(relay.statusText()), relay.statusText());
        relay.close();
        setTimeout(() => {
          eq("cierre", relay.state.link, "closed");
          const failed = checks.filter((c) => !c.ok);
          resolve({ checks: checks.length, passed: checks.length - failed.length, fails: failed, chain });
        }, 30);
      }, 60);
    }, 60);
  });
}
