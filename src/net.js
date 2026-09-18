// net.js -- multijugador: region compartida y jugadores por la red.
//
// El servidor (el <script type="text/x-server-plugin"> de index.html) es un
// retransmisor de bytes; toda la logica vive aqui. Resumen del protocolo:
//
//   - Presencia: cada cliente manda su transformada ~10 veces por segundo y su
//     nombre; los demas se dibujan con `Avatar` (src/peers.js) interpolando.
//   - Chat: lo que dice un jugador o el script de un prim suyo viaja a los
//     demas, que lo pintan en el chat local, dibujan la burbuja si tienen ese
//     prim y se lo entregan a sus `llListen` (src/lsl/runtime.js).
//   - Mundo: la region es una secuencia de ediciones numeradas (revisiones).
//     El servidor guarda, ademas del historial corto, una instantanea completa
//     que sube un cliente. Al entrar: si hay instantanea se descarga; si no,
//     se reconstruye reproduciendo el historial; si el mundo esta virgen, se
//     sube el que tengas. Despues, cada cliente manda solo lo que cambia.
//   - Propiedad: cada prim pertenece al jugador que lo creo (`owner`). Solo el
//     dueño difunde por la red lo que dicen los scripts de ese prim, para que
//     un mismo script no hable una vez por cada cliente conectado.
//
// El terreno (esculpido) viaja dentro de la instantanea, pero no se sincroniza
// en vivo: cada cliente tiene su propia capa de terreno hasta la proxima
// instantanea.

const MSG_JOIN = 1;
const MSG_POSE = 2;
const MSG_CHAT = 3;
const MSG_PRIM = 4;
const MSG_SNAP = 5;
const MSG_REQ = 6;
const MSG_NAME = 7;

const S_WELCOME = 0x81;
const S_PEERS = 0x82;
const S_JOIN = 0x83;
const S_LEAVE = 0x84;
const S_POSE = 0x85;
const S_CHAT = 0x86;
const S_PRIM = 0x87;
const S_SNAP = 0x88;
const S_ASK = 0x89;
const S_HOST = 0x8a;
const S_ERR = 0x8b;

const ASK_SNAPSHOT = 0;
const ASK_RELOAD = 2;

const REQ_SNAPSHOT = 0;
const REQ_LOG = 1;
const REQ_REPORT = 3;
const REQ_CHUNK = 4;

const POSE_HZ = 10;
const SYNC_HZ = 3;
const SYNC_MAX_PER_TICK = 40;
const UPLOAD_CHUNK = 48000;
const UPLOAD_PER_SEC = 40;
const SNAP_CAP = 30000000;

const KIND_TO_ID = { say: 1, whisper: 2, shout: 3, region: 4 };
const ID_TO_KIND = ["say", "say", "whisper", "shout", "region"];

const PROFILE_FOLDER = "perfil";
const SHARE_KEY = "compartirMundo";
const PRE_RED_REGION = "pre-red";

const _ab = new ArrayBuffer(8);
const _dv = new DataView(_ab);
const _b = new Uint8Array(_ab);

function putU32(a, o, v) {
  _dv.setUint32(0, v >>> 0, true);
  a[o] = _b[0]; a[o + 1] = _b[1]; a[o + 2] = _b[2]; a[o + 3] = _b[3];
}
function putU16(a, o, v) {
  _dv.setUint16(0, v & 0xffff, true);
  a[o] = _b[0]; a[o + 1] = _b[1];
}
function putF32(a, o, v) {
  _dv.setFloat32(0, v || 0, true);
  a[o] = _b[0]; a[o + 1] = _b[1]; a[o + 2] = _b[2]; a[o + 3] = _b[3];
}
function getU32(a, o) {
  _b[0] = a[o]; _b[1] = a[o + 1]; _b[2] = a[o + 2]; _b[3] = a[o + 3];
  return _dv.getUint32(0, true);
}
function getU16(a, o) {
  _b[0] = a[o]; _b[1] = a[o + 1];
  return _dv.getUint16(0, true);
}
function getI16(a, o) {
  const v = getU16(a, o);
  return v > 32767 ? v - 65536 : v;
}
function getF32(a, o) {
  _b[0] = a[o]; _b[1] = a[o + 1]; _b[2] = a[o + 2]; _b[3] = a[o + 3];
  return _dv.getFloat32(0, true);
}

function platformRoot() {
  try {
    if (typeof root !== "undefined" && root) return root;
  } catch (e) { /* fuera del motor: se usa window */ }
  return window;
}

export function createNet(opts) {
  const viewer = opts.viewer;
  const world = opts.world;
  const bt = opts.bt;
  const peers = opts.peers;
  const store = opts.store || null;
  const getRt = typeof opts.rt === "function" ? opts.rt : () => opts.rt;
  const onNotice = opts.onNotice || (() => {});
  const onStatus = opts.onStatus || (() => {});
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const chipEl = document.getElementById("netStatEl");
  const dotEl = document.getElementById("netDotEl");
  const textEl = document.getElementById("netTextEl");

  const state = {
    socket: null, connected: false, joined: false,
    myId: 0, myRev: 0, idBase: 0, serverRev: 0, hasSnapshot: false,
    name: "Residente", nameSet: false, share: true,
    status: "", peerCount: 0,
    attempts: 0, retryTimer: null, retryAt: 0, closed: false,
    poseAcc: 0, syncAcc: 0, reportAcc: 0, upAcc: 0,
    lastPose: { x: 0, y: 0, z: 0, yaw: 0 }, poseAt: 0,
    held: new Map(), sentSigs: new Map(), dirtyIds: new Set(),
    awaitingSnap: false, snap: null, snapTotal: 0, snapGot: 0, snapRev: 0,
    uploading: false, uploadBytes: null, uploadPos: 0,
    dirtyUi: false, adopted: false, stashed: false, logReqAt: 0,
  };

  // --- identidad ------------------------------------------------------------

  function randomId() {
    const r = new Uint32Array(1);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(r);
    else r[0] = (Math.random() * 0xffffffff) >>> 0;
    return (r[0] || 1) >>> 0;
  }

  function folder() {
    const rt = platformRoot();
    if (rt && rt.kv && rt.kv[PROFILE_FOLDER]) return rt.kv[PROFILE_FOLDER];
    if (rt && rt.kv && rt.kv.subfolder) return rt.kv.subfolder(PROFILE_FOLDER);
    return null;
  }

  async function loadProfile() {
    const f = folder();
    if (!f) {
      state.myId = randomId();
      state.name = "Residente-" + (state.myId % 1000);
      return;
    }
    try {
      let id = await f.get("userId");
      if (!id) { id = randomId(); await f.set("userId", id); }
      state.myId = Number(id) >>> 0;
      const n = await f.get("nombre");
      if (n) { state.name = String(n).slice(0, 24); state.nameSet = true; }
      else state.name = "Residente-" + (state.myId % 1000);
      const sh = await f.get(SHARE_KEY);
      if (sh === false || sh === "no") state.share = false;
    } catch (e) {
      state.myId = state.myId || randomId();
    }
  }

  function saveProfile(key, value) {
    const f = folder();
    if (!f) return;
    try { f.set(key, value); } catch (e) { /* sin almacenamiento */ }
  }

  function setName(name) {
    const n = String(name || "").trim().slice(0, 24);
    if (!n) return;
    state.name = n;
    state.nameSet = true;
    saveProfile("nombre", n);
    if (state.connected && state.joined) sendName();
    updateChip();
    onNotice("Ahora te llamas " + n + ".");
  }

  // --- conexion -------------------------------------------------------------

  function connect() {
    if (state.socket || state.closed) return;
    const rt = platformRoot();
    if (!rt || typeof rt.createServerSocket !== "function") {
      setStatus("sin servidor");
      return;
    }
    let socket;
    try { socket = rt.createServerSocket(); } catch (e) { setStatus("sin servidor"); return; }
    state.socket = socket;
    try { socket.binaryType = "arraybuffer"; } catch (e) {}
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", () => {});
    setStatus("conectando…");
  }

  function onOpen() {
    state.connected = true;
    state.attempts = 0;
    sendJoin();
  }

  function onClose(ev) {
    const code = ev && ev.code ? ev.code : 0;
    state.connected = false;
    state.joined = false;
    state.socket = null;
    state.uploading = false;
    state.snap = null;
    peers.clear();
    state.peerCount = 0;
    if (code === 4403) {
      // Fuera de perchance.org los sockets no funcionan: es permanente.
      state.closed = true;
      setStatus("sin conexión");
      onNotice("El multijugador solo funciona dentro de perchance.org.");
      return;
    }
    setStatus("reconectando…");
    scheduleRetry(code);
  }

  function scheduleRetry(code) {
    if (state.retryTimer) return;
    const n = Math.min(state.attempts, 6);
    let wait = Math.min(30000, 800 * Math.pow(1.8, n)) * (0.75 + Math.random() * 0.5);
    if (code === 1013 || code === 4429) wait = Math.max(wait, 15000);
    state.attempts++;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      connect();
    }, wait);
  }

  function send(u8) {
    const s = state.socket;
    if (!s || !state.connected) return false;
    try { s.send(u8); return true; } catch (e) { return false; }
  }

  function sendJoin() {
    const nb = enc.encode(state.name);
    const n = Math.min(nb.length, 32);
    const out = new Uint8Array(6 + n);
    out[0] = MSG_JOIN;
    putU32(out, 1, state.myId);
    out[5] = n;
    out.set(nb.subarray(0, n), 6);
    send(out);
    sendReq(REQ_REPORT, state.myRev);
    setStatus("en línea");
  }

  function sendName() {
    const nb = enc.encode(state.name);
    const n = Math.min(nb.length, 32);
    const out = new Uint8Array(2 + n);
    out[0] = MSG_NAME;
    out[1] = n;
    out.set(nb.subarray(0, n), 2);
    send(out);
  }

  function sendReq(what, rev) {
    const out = new Uint8Array(6);
    out[0] = MSG_REQ;
    out[1] = what;
    putU32(out, 2, rev);
    send(out);
  }

  function sendPose() {
    const av = viewer.avatar;
    if (!av) return;
    const out = new Uint8Array(18);
    out[0] = MSG_POSE;
    putF32(out, 1, av.position.x);
    putF32(out, 5, av.position.y);
    putF32(out, 9, av.position.z);
    putF32(out, 13, av.yaw || 0);
    // bit 0: volando · bit 1: la transformada es real (no ceros de recien llegado)
    out[17] = (av.flying ? 1 : 0) | 2;
    send(out);
  }

  // --- entrada --------------------------------------------------------------

  function onMessage(ev) {
    const d = ev.data;
    let u8 = null;
    if (d instanceof ArrayBuffer) u8 = new Uint8Array(d);
    else if (d && d.buffer instanceof ArrayBuffer) u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    else return;
    if (u8.length < 1) return;
    switch (u8[0]) {
      case S_WELCOME: onWelcome(u8); break;
      case S_PEERS: onPeers(u8); break;
      case S_JOIN: onJoin(u8); break;
      case S_LEAVE: onLeave(u8); break;
      case S_POSE: onPose(u8); break;
      case S_CHAT: onChat(u8); break;
      case S_PRIM: onPrim(u8); break;
      case S_SNAP: onSnap(u8); break;
      case S_ASK: onAsk(u8); break;
      case S_HOST: onHost(u8); break;
      case S_ERR: onErr(u8); break;
      default: break;
    }
  }

  function readPose(a, o) {
    const flags = a[o + 16];
    return {
      x: getF32(a, o), y: getF32(a, o + 4), z: getF32(a, o + 8),
      yaw: getF32(a, o + 12),
      flying: !!(flags & 1),
      // El bit 1 marca "ya tengo una transformada de verdad": el que acaba de
      // entrar manda ceros hasta su primer envio, y eso no es una posicion.
      valid: !!(flags & 2),
    };
  }

  function onWelcome(u8) {
    if (u8.length < 15) return;
    state.myId = getU32(u8, 1);
    state.serverRev = getU32(u8, 5);
    state.hasSnapshot = !!u8[9];
    state.idBase = getU32(u8, 10);
    state.joined = true;
    state.held.clear();
    world.reserveIds(state.idBase);
    planJoin();
    // Que los demas nos vean ya, sin esperar al primer envio periodico.
    sendPose();
  }

  // Decide que hacer con el mundo compartido al entrar.
  function planJoin() {
    state.sentSigs.clear();
    state.dirtyIds.clear();
    if (!state.share) {
      seedSigs();
      setStatus("en línea");
      return;
    }
    if (state.hasSnapshot) {
      state.awaitingSnap = true;
      state.snap = null;
      state.snapTotal = 0;
      state.snapGot = 0;
      sendReq(REQ_SNAPSHOT, 0);
      setStatus("descargando el mundo…");
    } else if (state.serverRev > 0) {
      adoptRemote();
      sendReq(REQ_LOG, 0);
      setStatus("reconstruyendo el mundo…");
    } else {
      claimLocal(false);
      seedSigs();
      uploadSnapshot();
    }
  }

  function onPeers(u8) {
    if (u8.length < 2) return;
    const n = u8[1];
    let p = 2;
    for (let i = 0; i < n; i++) {
      if (u8.length < p + 5) return;
      const id = getU32(u8, p); p += 4;
      const nl = u8[p++];
      if (u8.length < p + nl + 17) return;
      const name = dec.decode(u8.subarray(p, p + nl)); p += nl;
      const pose = readPose(u8, p); p += 17;
      if (id !== state.myId) peers.add(id, name, pose);
    }
    updateChip();
  }

  function onJoin(u8) {
    if (u8.length < 6) return;
    const id = getU32(u8, 1);
    const nl = u8[5];
    if (u8.length < 6 + nl + 17) return;
    const name = dec.decode(u8.subarray(6, 6 + nl));
    const pose = readPose(u8, 6 + nl);
    if (id === state.myId) return;
    const known = peers.peers.has(id);
    peers.add(id, name, pose);
    if (!known) onNotice(name + " entró en la región.");
    updateChip();
  }

  function onLeave(u8) {
    if (u8.length < 5) return;
    const id = getU32(u8, 1);
    const rec = peers.peers.get(id);
    if (rec) onNotice(rec.name + " salió de la región.");
    peers.remove(id);
    updateChip();
  }

  function onPose(u8) {
    if (u8.length < 22) return;
    const id = getU32(u8, 1);
    if (id === state.myId) return;
    peers.setPose(id, readPose(u8, 5));
  }

  function onChat(u8) {
    if (u8.length < 5) return;
    const sender = getU32(u8, 1);
    if (sender === state.myId) return;
    const p = u8.subarray(5);
    if (p.length < 23) return;
    const kindId = p[0];
    const channel = getI16(p, 1);
    const primId = getU32(p, 3) | 0;
    const fx = getF32(p, 7);
    const fy = getF32(p, 11);
    const fz = getF32(p, 15);
    const scripted = !!p[19];
    const speakerLen = p[20];
    const q = 21 + speakerLen;
    if (p.length < q + 2) return;
    const textLen = p[q] | (p[q + 1] << 8);
    if (p.length < q + 2 + textLen) return;
    const speaker = dec.decode(p.subarray(21, 21 + speakerLen)) || "alguien";
    const text = dec.decode(p.subarray(q + 2, q + 2 + textLen));
    if (!text) return;
    const rt = getRt();
    if (rt && rt.receiveChat) {
      rt.receiveChat({
        kind: ID_TO_KIND[kindId] || "say",
        channel, primId, scripted, speaker, id: "peer-" + sender, text,
        fromPos: { x: fx, y: fy, z: fz },
      });
    }
  }

  function onSnap(u8) {
    if (u8.length < 18) return;
    const last = u8[1] === 1;
    const rev = getU32(u8, 2);
    const total = getU32(u8, 6);
    const offset = getU32(u8, 10);
    const n = getU32(u8, 14);
    if (total === 0 || total > SNAP_CAP || n > UPLOAD_CHUNK + 8) return;
    if (u8.length < 18 + n) return;
    if (!state.snap || state.snapTotal !== total) {
      if (offset !== 0) return;
      state.snap = new Uint8Array(total);
      state.snapTotal = total;
      state.snapGot = 0;
    }
    if (offset !== state.snapGot) { state.snap = null; state.snapTotal = 0; return; }
    state.snap.set(u8.subarray(18, 18 + n), offset);
    state.snapGot = offset + n;
    state.snapRev = rev;
    if (!last && state.snapGot < total) {
      // Se pide el trozo siguiente (el servidor no manda la cola entera).
      sendReq(REQ_CHUNK, state.snapGot);
      return;
    }
    if (state.snapGot >= total) applySnapshot();
  }

  function applySnapshot() {
    const bytes = state.snap;
    const rev = state.snapRev;
    state.snap = null;
    state.snapTotal = 0;
    state.snapGot = 0;
    state.awaitingSnap = false;
    let data = null;
    try { data = JSON.parse(dec.decode(bytes)); } catch (e) {
      onNotice("La instantánea del mundo llegó ilegible.");
      setStatus("en línea");
      return;
    }
    if (!data || !data.objects) return;
    stashLocal();
    state.adopted = true;
    bt.applyRegionData(data, false, "Mundo compartido");
    state.myRev = rev;
    claimLocal(true);
    seedSigs();
    sendReq(REQ_LOG, rev);
    sendReq(REQ_REPORT, state.myRev);
    drainHeld();
    setStatus("en línea");
  }

  function onPrim(u8) {
    if (u8.length < 14) return;
    const rev = getU32(u8, 1);
    const sender = getU32(u8, 5);
    const op = u8[9];
    const len = getU32(u8, 10);
    if (u8.length < 14 + len) return;
    deliverPrim(rev, sender, op, dec.decode(u8.subarray(14, 14 + len)));
  }

  function deliverPrim(rev, sender, op, json) {
    if (rev <= state.myRev) return;
    if (state.awaitingSnap) { hold(rev, sender, op, json); return; }
    if (rev > state.myRev + 1) {
      hold(rev, sender, op, json);
      requestLog();
      return;
    }
    applyPrim(rev, sender, op, json);
    drainHeld();
  }

  function hold(rev, sender, op, json) {
    if (state.held.size > 600) state.held.clear();
    state.held.set(rev, { sender, op, json });
  }

  function drainHeld() {
    let r = state.myRev + 1;
    while (state.held.has(r)) {
      const m = state.held.get(r);
      state.held.delete(r);
      applyPrim(r, m.sender, m.op, m.json);
      r++;
    }
  }

  // Aplica una edicion venida de la red. Se anota su firma local para no
  // devolverla al servidor como si fuera un cambio nuestro (eco infinito).
  function applyPrim(rev, sender, op, json) {
    state.myRev = rev;
    if (sender === state.myId) return;
    if (!state.share) return;
    if (op === 3) {
      let rec = null;
      try { rec = JSON.parse(json); } catch (e) { return; }
      const id = (rec && typeof rec === "object") ? rec.id : rec;
      world.applyRemote(rec, "remove");
      state.sentSigs.delete(id);
      state.dirtyIds.delete(id);
      if (bt.state.selection && bt.state.selection.id === id) bt.deselect();
      state.dirtyUi = true;
      return;
    }
    let rec = null;
    try { rec = JSON.parse(json); } catch (e) { return; }
    const obj = world.applyRemote(rec, "set");
    if (obj) {
      state.sentSigs.set(obj.id, sig(obj));
      state.dirtyIds.delete(obj.id);
      if (selectedFamily(obj)) state.dirtyUi = true;
    } else {
      state.dirtyUi = true;
    }
  }

  function selectedFamily(obj) {
    const sel = bt.state.selection;
    if (!sel) return false;
    if (sel.id === obj.id) return true;
    if (obj.linkRoot && obj.linkRoot.id === sel.id) return true;
    if (sel.links && sel.links.some((c) => c && c.id === obj.id)) return true;
    return false;
  }

  function requestLog() {
    const now = performance.now();
    if (now - state.logReqAt < 1500) return;
    state.logReqAt = now;
    sendReq(REQ_LOG, state.myRev);
  }

  function onAsk(u8) {
    if (u8.length < 2) return;
    const reason = u8[1];
    if (reason === ASK_SNAPSHOT) {
      if (state.share && state.joined && !state.uploading) uploadSnapshot();
    } else if (reason === ASK_RELOAD) {
      if (!state.share || state.awaitingSnap) return;
      state.awaitingSnap = true;
      state.snap = null;
      state.snapTotal = 0;
      state.snapGot = 0;
      sendReq(REQ_SNAPSHOT, 0);
      setStatus("recargando el mundo…");
    }
  }

  function onHost(u8) {
    if (u8.length < 5) return;
    const id = getU32(u8, 1);
    let n = 0;
    for (const o of world.objects) {
      if (o.owner === id) { o.owner = state.myId; state.dirtyIds.add(o.id); n++; }
    }
    if (n) onNotice("Has heredado " + n + " prim" + (n > 1 ? "s" : "") + " de un jugador que se fue.");
  }

  function onErr(u8) {
    if (u8.length < 3) return;
    const n = u8[1] | (u8[2] << 8);
    let text = "";
    for (let i = 0; i < n && 3 + i < u8.length; i++) text += String.fromCharCode(u8[3 + i]);
    if (text === "no unido") { sendJoin(); return; }
    if (text.indexOf("instantanea") >= 0) {
      // Otro cliente subio el mundo antes que nosotros.
      state.uploading = false;
      if (state.share) {
        state.awaitingSnap = true;
        state.snap = null;
        state.snapTotal = 0;
        state.snapGot = 0;
        sendReq(REQ_SNAPSHOT, 0);
        setStatus("descargando el mundo…");
      }
      return;
    }
    if (text === "espera para subir") return;
    if (text) onNotice("Servidor: " + text);
  }

  // --- mundo ----------------------------------------------------------------

  // Firma de un prim para saber si ha cambiado. Ojo: los prims que giran con
  // `llTargetOmega` (src/lsl/runtime.js) cambian de cuaternion en cada frame,
  // pero ese giro lo reproduce cada cliente por su cuenta, asi que no cuenta
  // como cambio (si no, estariamos mandando la rotacion 3 veces por segundo).
  const OMEGA_ROT = [0, 0, 0, 1];
  function sig(obj) {
    const rec = world.recordOf(obj);
    if (obj.omega) rec.quaternion = OMEGA_ROT;
    return JSON.stringify(rec);
  }

  function seedSigs() {
    state.sentSigs.clear();
    for (const o of world.objects) state.sentSigs.set(o.id, sig(o));
  }

  function claimLocal(forceSend) {
    let n = 0;
    for (const o of world.objects) {
      if (!o.owner) {
        o.owner = state.myId;
        if (forceSend) state.dirtyIds.add(o.id);
        n++;
      }
    }
    return n;
  }

  function stashLocal() {
    if (state.stashed) return;
    state.stashed = true;
    if (!store || !store.available) return;
    try {
      Promise.resolve(store.saveRegion(PRE_RED_REGION, bt.regionState())).catch(() => {});
      onNotice("Tu región anterior se ha guardado como «" + PRE_RED_REGION + "» en este navegador.");
    } catch (e) { /* sin almacenamiento */ }
  }

  function adoptRemote() {
    stashLocal();
    state.adopted = true;
    state.sentSigs.clear();
    state.dirtyIds.clear();
    state.held.clear();
    state.myRev = 0;
    bt.applyRegionData({ objects: [] }, false, "Mundo compartido");
  }

  function sendPrim(op, payload) {
    const pb = enc.encode(typeof payload === "string" ? payload : String(payload));
    if (!pb.length || pb.length > 60000) return false;
    const out = new Uint8Array(6 + pb.length);
    out[0] = MSG_PRIM;
    out[1] = op;
    putU32(out, 2, pb.length);
    out.set(pb, 6);
    return send(out);
  }

  // Compara el mundo con lo ultimo enviado y manda solo las diferencias.
  function syncWorld() {
    let sent = 0;
    for (const o of world.objects) {
      if (sent >= SYNC_MAX_PER_TICK) break;
      if (!o.owner) { o.owner = state.myId; state.dirtyIds.add(o.id); }
      const json = sig(o);
      const prev = state.sentSigs.get(o.id);
      if (state.dirtyIds.has(o.id) || prev !== json) {
        if (sendPrim(prev === undefined ? 1 : 2, json)) {
          state.sentSigs.set(o.id, json);
          state.dirtyIds.delete(o.id);
          sent++;
        }
      }
    }
    for (const id of [...state.sentSigs.keys()]) {
      if (sent >= SYNC_MAX_PER_TICK) break;
      if (!world.findById(id)) {
        if (sendPrim(3, JSON.stringify({ id }))) { state.sentSigs.delete(id); sent++; }
      }
    }
  }

  function uploadSnapshot() {
    if (!state.connected || !state.joined || !state.share || state.uploading) return;
    claimLocal(false);
    const bytes = enc.encode(JSON.stringify(bt.regionState()));
    if (bytes.length > SNAP_CAP) {
      onNotice("La región es demasiado grande para compartirla (" + Math.round(bytes.length / 1048576) + " MB).");
      return;
    }
    state.uploadBytes = bytes;
    state.uploadPos = 0;
    state.uploading = true;
    state.upAcc = 0;
    setStatus("subiendo el mundo…");
  }

  function pumpUpload(dt) {
    if (!state.uploading || !state.uploadBytes) return;
    state.upAcc += dt;
    const step = 1 / UPLOAD_PER_SEC;
    while (state.upAcc >= step && state.uploadPos < state.uploadBytes.length) {
      state.upAcc -= step;
      const total = state.uploadBytes.length;
      const n = Math.min(UPLOAD_CHUNK, total - state.uploadPos);
      const out = new Uint8Array(18 + n);
      out[0] = MSG_SNAP;
      out[1] = 0;
      putU32(out, 2, state.myRev);
      putU32(out, 6, total);
      putU32(out, 10, state.uploadPos);
      putU32(out, 14, n);
      out.set(state.uploadBytes.subarray(state.uploadPos, state.uploadPos + n), 18);
      if (!send(out)) { state.upAcc = 0; return; }
      state.uploadPos += n;
    }
    const total = state.uploadBytes.length;
    if (state.uploadPos >= total) {
      const end = new Uint8Array(18);
      end[0] = MSG_SNAP;
      end[1] = 1;
      putU32(end, 2, state.myRev);
      putU32(end, 6, total);
      putU32(end, 10, total);
      putU32(end, 14, 0);
      send(end);
      state.uploading = false;
      state.uploadBytes = null;
      seedSigs();
      setStatus("en línea");
      onNotice("Has publicado la región compartida (" + Math.round(total / 1024) + " KB).");
    }
  }

  // --- chat -----------------------------------------------------------------

  function onLocalChat(line) {
    if (!line || !line.broadcast) return;
    if (!state.connected || !state.joined) return;
    const prim = line.prim || null;
    const speaker = prim ? (prim.name || "") : state.name;
    const sb = enc.encode(String(speaker));
    const tb = enc.encode(String(line.text).slice(0, 480));
    const sN = Math.min(sb.length, 32);
    const pos = prim ? prim.position : (viewer.avatar ? viewer.avatar.position : { x: 0, y: 0, z: 0 });
    const out = new Uint8Array(24 + sN + tb.length);
    out[0] = MSG_CHAT;
    out[1] = KIND_TO_ID[line.kind] || 1;
    putU16(out, 2, line.channel || 0);
    putU32(out, 4, (prim ? prim.id : 0) >>> 0);
    putF32(out, 8, pos.x);
    putF32(out, 12, pos.y);
    putF32(out, 16, pos.z);
    out[20] = prim ? 1 : 0;
    out[21] = sN;
    out.set(sb.subarray(0, sN), 22);
    putU16(out, 22 + sN, tb.length);
    out.set(tb, 24 + sN);
    send(out);
  }

  // --- estado compartido ----------------------------------------------------

  function shareEnabled() { return state.share; }

  function setShare(v) {
    const on = !!v;
    if (on === state.share) return;
    // Si el servidor ya tiene un mundo y tu region tiene cambios sin compartir,
    // activarlo significa adoptar el de la region: mejor preguntar antes.
    if (on && state.hasSnapshot && state.joined && bt.state.rev > 0) {
      if (!window.confirm("Ya hay un mundo compartido en la región. Se descargará, y tu región actual se guardará como «" + PRE_RED_REGION + "». ¿Continuar?")) return;
    }
    state.share = on;
    saveProfile(SHARE_KEY, on ? "si" : "no");
    if (!on) {
      peers.clear();
      state.sentSigs.clear();
      state.dirtyIds.clear();
      state.held.clear();
      onNotice("Mundo compartido desactivado: sigues viendo a los demás, pero tus prims son solo tuyos.");
      updateChip();
      return;
    }
    onNotice("Mundo compartido activado.");
    if (state.connected && state.joined) planJoin();
    updateChip();
  }

  // El runtime solo deja difundir el chat de los scripts de prims cuyo dueño
  // sea este cliente: asi un script no habla una vez por cada jugador.
  function isOwner(prim) {
    if (!state.share) return false;
    return !!prim && prim.owner === state.myId;
  }

  function updateChip() {
    state.peerCount = peers.count();
    if (textEl) {
      textEl.textContent = state.peerCount > 0 ? (state.peerCount + 1) + " en línea" : "solo";
    }
    if (chipEl) {
      chipEl.classList.toggle("on", state.connected && state.joined);
      chipEl.classList.toggle("busy", state.connected && !state.joined);
      chipEl.classList.toggle("off", !state.connected);
      const names = peers.list().map((p) => p.name);
      chipEl.title = state.connected
        ? (names.length ? "En la región: " + state.name + ", " + names.join(", ") : "Solo tú en la región") +
          "\nClic para cambiar tu nombre"
        : "Sin conexión";
    }
    if (dotEl) dotEl.hidden = false;
  }

  function setStatus(text) {
    state.status = text;
    onStatus(text);
  }

  function statusText() {
    if (!state.connected) return state.closed ? "sin conexión" : "conectando…";
    const n = peers.count();
    return (state.status || "en línea") + (n > 0 ? " · " + n + " más" : "");
  }

  // --- bucle ----------------------------------------------------------------

  function update(dt) {
    if (!state.connected && !state.retryTimer && !state.closed) scheduleRetry(0);
    if (!state.connected) return;

    if (state.uploading) pumpUpload(dt);

    state.poseAcc += dt;
    if (state.poseAcc >= 1 / POSE_HZ && state.joined) {
      state.poseAcc = 0;
      const av = viewer.avatar;
      if (av) {
        const lp = state.lastPose;
        const moved = Math.abs(av.position.x - lp.x) + Math.abs(av.position.y - lp.y) + Math.abs(av.position.z - lp.z);
        const dyaw = Math.abs((av.yaw || 0) - lp.yaw);
        const now = performance.now();
        if (moved > 0.02 || dyaw > 0.03 || now - state.poseAt > 2000) {
          sendPose();
          lp.x = av.position.x; lp.y = av.position.y; lp.z = av.position.z; lp.yaw = av.yaw || 0;
          state.poseAt = now;
        }
      }
    }

    state.syncAcc += dt;
    if (state.syncAcc >= 1 / SYNC_HZ) {
      state.syncAcc = 0;
      state.reportAcc++;
      if (state.reportAcc >= 3 * SYNC_HZ) { state.reportAcc = 0; sendReq(REQ_REPORT, state.myRev); }
      if (state.share && state.joined && !state.awaitingSnap && !state.uploading) syncWorld();
    }

    if (state.held.size > 200 && !state.awaitingSnap) requestLog();

    if (state.dirtyUi) {
      state.dirtyUi = false;
      try {
        bt.refreshSelection();
        bt.refreshStatus();
        if (bt.state.selection) { bt.renderParams(); bt.renderFaces(); }
      } catch (e) { /* el panel se repinta en el siguiente cambio */ }
    }
  }

  function dispose() {
    state.closed = true;
    if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
    const s = state.socket;
    state.socket = null;
    state.connected = false;
    state.joined = false;
    if (s) { try { s.close(1000, "adiós"); } catch (e) {} }
    peers.clear();
  }

  // --- arranque -------------------------------------------------------------

  function initChip() {
    if (!chipEl) return;
    chipEl.addEventListener("click", () => {
      const v = window.prompt("Tu nombre en la región:", state.name);
      if (v) setName(v);
    });
    updateChip();
  }

  async function start() {
    initChip();
    await loadProfile();
    updateChip();
    // El chat del usuario (y el de los scripts de sus prims) se difunde a los
    // demas: sin este enganche, `onLocalChat` nunca se llamaba y lo que
    // escribias se quedaba en tu pantalla.
    const rt = getRt();
    if (rt && rt.on) rt.on("chat", onLocalChat);
    connect();
  }

  start();

  return {
    state, update, dispose, setName, setShare, shareEnabled, statusText, isOwner,
    preRedName: PRE_RED_REGION,
    get name() { return state.name; },
    get myId() { return state.myId; },
    get connected() { return state.connected && state.joined; },
    get peerCount() { return peers.count(); },
    get share() { return state.share; },
    get rev() { return state.myRev; },
    reconnect: () => { state.closed = false; connect(); },
  };
}
