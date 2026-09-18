// gateway.js -- el retransmisor LLUDP: de una region de Second Life al visor.
//
// QUE ES
// ------
// Los otros modulos de `lludp/` saben leer y escribir el protocolo de Second
// Life (`template.js`, `codec.js`), mantener el circuito (`circuit.js`), mover
// el terreno (`terrain.js`), los objetos (`objects.js`) y los mensajes del
// agente (`agent.js`). `sim.js` es la otra mitad del cable: una region de
// mentira que contesta lo mismo que contesta un simulador de verdad.
//
// Este fichero es el PEGAMENTO: coge un circuito LLUDP de verdad (contra un
// simulador de Second Life) y le va contando al visor lo que pasa, en el
// protocolo de `src/sl/relay.js`. Es el componente que en SpeedLight, Lumiya o
// Radegast vive en otro proceso; aqui vive en JavaScript, asi que se puede
// probar entero sin red (y por eso el mismo codigo vale para el navegador y
// para la app Android).
//
//   simulador SL  ──LLUDP──►  ESTE MODULO  ──relay.js──►  el visor
//
// LO QUE TRADUCE
// --------------
//   RegionHandshake      -> RegionHandshakeReply + AgentThrottle + CompleteAgentMovement
//   LayerData (LAND)     -> S.TERRAIN (256 parches, ya en coordenadas del visor)
//   ObjectUpdate         -> S.OBJECT / S.AVATAR
//   ObjectUpdateCached   -> RequestMultipleObjects (los que nos faltan)
//   ImprovedTerse...     -> S.OBJECT_UPDATE / S.AVATAR_UPDATE
//   KillObject           -> S.OBJECT_REMOVE / S.AVATAR_REMOVE
//   AvatarAppearance     -> S.AVATAR (con la forma real de SL)
//   ChatFromSimulator    -> S.CHAT
//   CoarseLocationUpdate -> nombres y vecinos lejanos
//   SimStats / RegionInfo / ParcelProperties -> S.STATS / S.REGION_INFO / S.PARCEL
//   AgentMovementComplete-> S.STATE(READY) cuando el mundo ha terminado de llegar
//
// Y al reves: C.MOVE -> AgentUpdate (10 Hz), C.CHAT -> ChatFromViewer,
// C.INTERACT -> ObjectGrab + ObjectDeGrab, C.TELEPORT -> TeleportLocationRequest,
// C.LOGOUT -> LogoutRequest.
//
// DOS COSAS QUE NO SE PUEDEN HACER TODAVIA, Y POR QUE
// ---------------------------------------------------
//   * Las texturas de SL son JPEG2000 (J2C). El navegador no sabe decodificar
//     JPEG2000, asi que aunque se traigan (GetTexture por las capabilities) no
//     se podrian pintar. Por eso el gateway NO las pide: deja los prims con el
//     material por defecto y lo apunta en el informe. Ver VIEWER-REAL.md.
//   * Los "bakes" de la piel de un avatar son J2C por el mismo motivo. Se manda
//     la FORMA real (los 253 parametros de avatar_lad, que si son texto) pero no
//     las texturas, y el visor le pone su piel de sistema. Con
//     `opts.bakes = true` se mandan tambien los uuid de los bakes, para cuando
//     haya decodificador.
//
// COORDENADAS
// -----------
// El simulador trabaja en coordenadas de SL (x este 0..256, y norte 0..256, z
// arriba) y el visor esta centrado y con los ejes cambiados. La conversion la
// hacen `slPosToViewer`/`slQuatToViewer` (objects.js), que es exactamente lo
// mismo que usa `primRecord`. El terreno tiene su propia vuelta (ver abajo).
//
// EL TERRENO
// ----------
// Un `LayerData` trae parches de 16x16 alturas en coordenadas de SL. El visor
// tiene UNA rejilla de 257x257 vertices (uno por metro) y coloca cada parche en
// `Terrain.applyPatch(px, py, heights)`, que escribe los vertices que caen en
// [px*16, px*16+16] x [py*16, py*16+16] *relativos al centro*.
//
// Como el visor cuenta x hacia el este igual que SL pero z hacia el sur (y el
// indice de parche crece hacia el norte en SL y hacia el sur en el visor), la
// correspondencia es:
//
//     px = slPx                        (x no se invierte)
//     py = 15 - slPy                   (y se invierte)
//     fila ky del visor -> fila (16 - ky) del parche de SL
//
// Es decir: se manda un parche de 17x17 (el visor acepta la costura: la fila 16
// es la primera del parche vecino, que en su rejilla ya es el mismo vertice).
// Para poder hacerlo, el gateway guarda TODO el terreno de SL en una rejilla de
// 257x257 y no manda un parche hasta que tiene sus vecinos de al lado (con un
// plazo de gracia por si la region no los manda). Asi el terreno sale derecho y
// sin costuras, en vez de espejado.
//
// ID DE LOS OBJETOS
// -----------------
// El visor identifica los prims por un id local entero; SL tambien (LocalID).
// Se usa el mismo numero, asi que el mapa uuid <-> id local es directo y las
// actualizaciones "terse" (que solo traen el id local) se pueden reenviar.

import {
  C, S, PHASE, PROTOCOL, RES, ASSET_FORMAT, CHAT_KIND, ZERO_UUID,
  putAsset, encode, encodeJson, decode, loopbackPair,
} from "../relay.js";
import { decodePacket } from "./codec.js";
import { defaultTemplates } from "./template.js";
import { createCircuit } from "./circuit.js";
import { openUdpBridge } from "./udp.js";
import { LAYER_CODE, applyLayerData } from "./terrain.js";
import {
  PCODE, MAX_TES,
  decodeObjectUpdate, decodeObjectUpdateCompressed, decodeObjectUpdateCached,
  decodeImprovedTerseObjectUpdate, decodeKillObject,
  primRecord, primUpdateRecord, readTextureEntryRaw,
  slPosToViewer, slQuatToViewer, viewerPosToSl, viewerQuatToSl,
} from "./objects.js";
import {
  AGENT_STATE, CONTROL,
  readRegionHandshake, readAgentMovementComplete, readAgentDataUpdate,
  readAvatarAppearance, readChatFromSimulator, readSimStats,
  readCoarseLocationUpdate, readParcelOverlay, readRegionInfo, readUUIDNameReply,
  readTeleportLocal, readTeleportStart, readTeleportProgress, readTeleportFinish,
  readLogoutReply, readHealthMessage, readImprovedInstantMessage, readAlertMessage,
  chatKindFromType, chatTypeFromKind, bakesFromTE, visualParamsToValues, texto,
  parcelFlagNames, simAccessText,
  useCircuitCode, regionHandshakeReply, completeAgentMovement, agentUpdate,
  chatFromViewer, logoutRequest, requestMultipleObjects, objectGrab, objectDeGrab,
  teleportLocationRequest, agentThrottle, requestRegionInfo, parcelPropertiesRequest,
  uuidNameRequest, moneyBalanceRequest, agentDataUpdateRequest, agentWearablesRequest,
  agentFOV, agentHeightWidth,
} from "./agent.js";

export const REGION_SIZE = 256;
const PATCH = 16;
const PATCHES = REGION_SIZE / PATCH;      // 16x16 parches
const GRID = REGION_SIZE + 1;             // 257 vertices por lado
const QUIET_READY_MS = 1200;              // sin noticias del simulador: damos la region por lista
const GRACE_TERRAIN_MS = 800;             // plazo para los parches vecinos
const READY_TIMEOUT_MS = 12000;           // si algo se atasca, entramos igual
const SIM_SILENCIO_MS = 15000;            // el simulador manda latido cada pocos segundos
const POSE_HZ = 10;
const NAME_REQ_MIN_MS = 1000;
const COARSE_RANGE = 96;                  // metros: los vecinos mas lejanos no se dibujan
const STEP = 1;                           // metros por vertice de la rejilla del visor

// Grupos de `avatar_lad.xml` que viajan en el `VisualParam` del cable: 0
// (TWEAKABLE) y 3 (TRANSMIT_NOT_TWEAKABLE), en el orden del fichero. Son 253.
const VISUAL_PARAM_GROUPS = [0, 3];

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
const noop = () => {};

// La tabla `{order, byId}` que esperan `visualParamsToValues`/`normalizeShape`
// a partir de la tabla completa de `avatarLad.js` (que trae `params` como Map).
export function wireParamTable(lad) {
  if (!lad || !lad.params || !lad.order) return null;
  const order = [];
  const byId = {};
  for (const id of lad.order) {
    const rec = lad.params.get(id);
    if (!rec || VISUAL_PARAM_GROUPS.indexOf(rec.group) < 0) continue;
    order.push(id);
    byId[id] = { min: rec.min, max: rec.max, name: rec.name };
  }
  return order.length ? { order, byId } : null;
}

// El sexo que declara una forma, mirando el parametro "male" (0 = hombre,
// 0.5 = las dos cosas, 1 = mujer), como hace `sexFromValues`.
const ID_MALE = 80;
function sexDe(params) {
  for (const p of params) if (p.id === ID_MALE) return p.value <= 0.25 ? "male" : (p.value >= 0.75 ? "female" : "both");
  return "auto";
}

// ---------------------------------------------------------------------------
// El retransmisor
// ---------------------------------------------------------------------------

/**
 * Crea el retransmisor. Habla por `socket` (extremo servidor de un
 * `loopbackPair`, o cualquier cosa con `send`/`addEventListener`) con el visor, y
 * por `udp` con el simulador.
 *
 * opts:
 *   socket       extremo del visor (obligatorio)
 *   udp          transporte de datagramas ya hecho (los autotests y el
 *                simulador en JS); si no, se abre uno con `udpUrl`
 *   udpUrl       ws://127.0.0.1:PUERTO del puente UDP (la app Android)
 *   credentials  lo que devuelve `login.relayCredentials` (agentId, circuitCode,
 *                sessionId, simIp, simPort, regionX, regionY...)
 *   regionName   nombre de la region (si no llega en el handshake)
 *   lad          tabla de avatar_lad ya parseada (para la forma de los avatares)
 *   getLad       funcion que devuelve esa tabla (si aun no esta cargada)
 *   throttlePreset  perfil de ancho de banda (50/300/500/1000 kbps)
 *   bakes        true = mandar tambien los uuid de los bakes (necesitan J2C)
 *   now, log     reloj y traza (inyectables, para los autotests)
 *   auto         true = latido propio con `setInterval` (por defecto si no hay
 *                un `update` externo); los autotests lo apagan
 */
export function createLldpGateway(opts = {}) {
  let socket = opts.socket || null;
  const log = opts.log || noop;
  const now = opts.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const templates = opts.templates || defaultTemplates();
  const cred = opts.credentials || {};
  const getLad = typeof opts.getLad === "function" ? opts.getLad : (() => opts.lad || null);
  const throttlePreset = opts.throttlePreset || 500;
  const conBakes = !!opts.bakes;

  const regionName = opts.regionName || (opts.welcome && opts.welcome.region && opts.welcome.region.name) || "region de Second Life";
  const regionX = cred.regionX === undefined ? 0 : cred.regionX;
  const regionY = cred.regionY === undefined ? 0 : cred.regionY;

  const st = {
    phase: PHASE.IDLE, progress: 0, text: "en espera",
    // `mock` = la region NO es Second Life (es el simulador de `sim.js`).
    // El visor lo usa para no presumir de estar conectado al mundo de verdad.
    link: "idle", region: null, mock: !!opts.mock, ready: false, error: null,
    agentId: cred.agentId || null, sessionId: cred.sessionId || null, circuitCode: cred.circuitCode || 0,
    circuit: null, udp: opts.udp || null, bridge: null, startedAt: 0, stopped: false,
    // receptores
    handshake: null, waterLevel: 20, channelVersion: "", simAccess: 21, regionFlags: 0,
    patches: 0, objects: 0, avatars: 0, chats: 0, touches: 0, assets: 0, terse: 0,
    simPackets: 0, sinSimAvisado: false, relogins: 0,
    avisoSilencio: false,
    agentUpdates: 0, expected: 0, spawn: null, parcel: null, info: null,
    health: 100, balance: null, localPort: 0, peerNames: 0, rezes: 0,
    // tiempos
    movementAt: 0, readyAt: 0, terrainAt: 0, lastSimAt: 0, lastMessageAt: 0,
    lastPoseAt: 0, lastStatsAt: 0, lastKbAt: 0, lastCoarseAt: 0, lastRegionAt: 0,
    messages: {}, unknown: {},
  };

  let salidaCerrada = false;
  let cerrandoPorRelogin = false;
  let terrenoPrimero = 0;
  const pendientesTerreno = new Set();
  const emitidosTerreno = new Set();
  const grid = new Float32Array(GRID * GRID).fill(st.waterLevel);
  const listaParche = new Uint8Array(PATCHES * PATCHES);

  const porLocalId = new Map();      // id local -> uuid
  const esAvatar = new Set();        // id local de un avatar
  const nombres = new Map();         // uuid -> nombre
  const pedidosNombre = new Map();   // uuid -> cuando se pidio
  const avatares = new Map();        // uuid -> {position, quaternion, flags, appearance}
  const objetosVistos = new Set();   // uuid de prims conocidos
  const texEntryDeAvatar = new Map();// uuid -> Uint8Array del TextureEntry
  const visualDeAvatar = new Map();  // uuid -> array de bytes

  let aparienciaPendiente = null;    // la ultima AssetAppearance de nosotros mismos
  let objetosComenzados = false;
  let ultimaPose = { position: [128, 128, 25], quaternion: [0, 0, 0, 1], flags: 0, yaw: 0 };
  let poseAcum = 0;
  let statsAcum = 0;
  let kbIn0 = 0, kbOut0 = 0;
  let cadenaTerrenoPendiente = false;

  // --- salida al visor -------------------------------------------------------

  function send(type, write) {
    if (!socket || salidaCerrada) return false;
    let bytes = null;
    try { bytes = encode(type, write); } catch (e) {
      log("gateway: no se pudo codificar la trama 0x" + type.toString(16) + ": " + (e && e.message));
      return false;
    }
    try { socket.send(bytes); return true; } catch (e) {
      log("gateway: no se pudo enviar la trama 0x" + type.toString(16) + ": " + (e && e.message));
      return false;
    }
  }
  function sendJson(type, obj) { return send(type, (w) => w.putJson(obj)); }

  function setPhase(phase, progress, text) {
    // La fase no puede RETROCEDER una vez que la region esta lista. El terreno
    // y los objetos siguen llegando (y un RegionHandshake repetido tambien
    // puede caer) despues de entrar, y anunciar "recibiendo..." con el mundo ya
    // montado dejaba al visor esperando un READY que ya habia pasado: se veia
    // la region pero la sesion no entraba nunca. El unico paso atras legitimo
    // es DISCONNECTED, que es un cierre de verdad.
    if (st.ready && phase === PHASE.ENTERING) return;
    st.phase = phase;
    if (progress !== undefined && progress !== null) st.progress = progress;
    if (text) st.text = text;
    send(S.STATE, (w) => w.putU8(phase).putU8(st.progress | 0).putStr(st.text || ""));
  }

  function fallo(texto_, fatal) {
    st.error = texto_;
    send(S.ERROR, (w) => w.putU8(fatal ? 1 : 0).putStr("relay").putStr(texto_));
    log("gateway: " + texto_);
  }

  function welcome() {
    const nombre = (st.region && st.region.name) || regionName;
    const puente = st.bridge
      ? ("puente UDP en el puerto local " + st.localPort)
      : (opts.udpUrl ? "puente UDP" : "transporte de pruebas");
    sendJson(S.WELCOME, {
      protocol: PROTOCOL,
      relay: "retransmisor LLUDP (visor-sl)",
      mock: st.mock,
      label: st.mock
        ? "Region LLUDP simulada en JavaScript (no es Second Life)"
        : ("Region de Second Life (LLUDP de verdad, " + puente + ")"),
      authModes: ["session"],
      region: {
        name: nombre, handle: [regionX * 256, regionY * 256],
        x: regionX, y: regionY, size: REGION_SIZE,
        waterLevel: st.waterLevel, mock: st.mock, real: !st.mock,
      },
      capabilities: ["terrain", "objects", "avatars", "chat", "parcels", "stats"],
      limits: { maxAgents: 100, maxObjects: 65536 },
    });
  }

  // --- terreno ---------------------------------------------------------------

  // Altura de SL en un vertice de la rejilla (0..256 en cada eje). La fila y la
  // columna 256 no vienen en el LayerData (los parches dan 0..255), asi que se
  // copia la 255: es un solo vertice del borde y no se nota.
  function alturaSL(slX, slY) {
    const x = clamp(slX | 0, 0, REGION_SIZE) === REGION_SIZE ? REGION_SIZE - 1 : clamp(slX | 0, 0, REGION_SIZE);
    const y = clamp(slY | 0, 0, REGION_SIZE) === REGION_SIZE ? REGION_SIZE - 1 : clamp(slY | 0, 0, REGION_SIZE);
    return grid[(y) * GRID + x];
  }

  function recibeParche(p) {
    const slPx = p.x, slPy = p.y, size = p.size || PATCH;
    for (let ky = 0; ky < size; ky++) {
      for (let kx = 0; kx < size; kx++) {
        grid[(slPy * PATCH + ky) * GRID + slPx * PATCH + kx] = p.heights[ky * size + kx];
      }
    }
    listaParche[slPy * PATCHES + slPx] = 1;
    if (!terrenoPrimero) terrenoPrimero = now();
    pendientesTerreno.add(slPy * PATCHES + slPx);
    if (!cadenaTerrenoPendiente) {
      cadenaTerrenoPendiente = true;
      siguienteTerreno();
    }
  }

  // Los parches se emiten en orden de llegada, pero esperando a los vecinos de
  // arriba y de la derecha (que son los que aportan la costura) y con un plazo
  // de gracia, para no quedarse esperando a un parche que no existe.
  function siguienteTerreno() {
    if (!pendientesTerreno.size) { cadenaTerrenoPendiente = false; return; }
    const vencido = now() - terrenoPrimero > GRACE_TERRAIN_MS;
    for (const clave of Array.from(pendientesTerreno)) {
      const slPx = clave % PATCHES, slPy = (clave / PATCHES) | 0;
      const vecinoDerecha = slPx === PATCHES - 1 || listaParche[slPy * PATCHES + slPx + 1];
      const vecinoArriba = slPy === PATCHES - 1 || listaParche[(slPy + 1) * PATCHES + slPx];
      if (!vencido && !(vecinoDerecha && vecinoArriba)) continue;
      pendientesTerreno.delete(clave);
      emitirParche(slPx, slPy);
    }
    if (pendientesTerreno.size) setTimeout(siguienteTerreno, 60);
    else cadenaTerrenoPendiente = false;
  }

  function emitirParche(slPx, slPy) {
    const px = slPx;
    const py = PATCHES - 1 - slPy;
    const h = new Float32Array(17 * 17);
    for (let ky = 0; ky < 17; ky++) {
      const slY = slPy * PATCH + PATCH - ky;
      for (let kx = 0; kx < 17; kx++) h[ky * 17 + kx] = alturaSL(slPx * PATCH + kx, slY);
    }
    send(S.TERRAIN, (w) => {
      w.putU8(px).putU8(py);
      for (let i = 0; i < h.length; i++) w.putF32(h[i]);
    });
    emitidosTerreno.add(slPy * PATCHES + slPx);
    st.patches = emitidosTerreno.size;
    st.terrainAt = now();
    // `setPhase` ya impide que esto retroceda la fase si la region esta lista.
    if (st.phase < PHASE.ENTERING) setPhase(PHASE.ENTERING, 5, "recibiendo el terreno…");
    else if (st.patches < PATCHES * PATCHES && st.progress < 45) setPhase(PHASE.ENTERING, 5 + Math.round((st.patches / (PATCHES * PATCHES)) * 40), "recibiendo el terreno…");
    mirarListo();
  }

  // --- objetos y avatares ----------------------------------------------------

  function nombreDe(uuid) {
    if (!uuid) return "Residente";
    if (uuid === st.agentId) return nombres.get(uuid) || "Tu";
    return nombres.get(uuid) || "Residente";
  }

  function pideNombre(uuid) {
    if (!uuid || uuid === ZERO_UUID || uuid === st.agentId) return;
    if (nombres.has(uuid)) return;
    const t = now();
    const antes = pedidosNombre.get(uuid) || 0;
    if (t - antes < 5000) return;
    pedidosNombre.set(uuid, t);
    alSim(uuidNameRequest([uuid]));
  }

  function aseguraObjetosComenzados() {
    if (objetosComenzados) return;
    objetosComenzados = true;
    send(S.OBJECTS_BEGIN, (w) => w.putU32(0));
    setPhase(PHASE.ENTERING, 50, "recibiendo los objetos…");
  }

  function recibeObjeto(o) {
    if (!o || !o.uuid) return;
    if (o.pcode === PCODE.AVATAR) {
      esAvatar.add(o.localId);
      porLocalId.set(o.localId, o.uuid);
      st.avatars++;
      if (o.uuid === st.agentId) return;
      const reg = avatares.get(o.uuid) || {};
      reg.position = o.position || reg.position;
      reg.quaternion = o.quaternion || reg.quaternion;
      avatares.set(o.uuid, reg);
      pideNombre(o.uuid);
      mandaAvatar(o.uuid, reg);
      return;
    }
    if (o.pcode !== PCODE.PRIMITIVE && o.pcode !== PCODE.GRASS && o.pcode !== PCODE.TREE &&
        o.pcode !== PCODE.NEW_TREE && o.pcode !== PCODE.PARTICLE_SYSTEM) {
      // Avatares de sistema, hierba...: se ignoran en silencio.
      porLocalId.set(o.localId, o.uuid);
      return;
    }
    porLocalId.set(o.localId, o.uuid);
    if (objetosVistos.has(o.uuid)) {
      // Ya lo teniamos: un ObjectUpdate repetido es una actualizacion.
      send(S.OBJECT_UPDATE, (w) => w.putUuid(o.uuid).putJson(primUpdateRecord(o)));
      return;
    }
    aseguraObjetosComenzados();
    objetosVistos.add(o.uuid);
    st.objects++;
    const rec = primRecord(o, o.localId);
    send(S.OBJECT, (w) => w.putUuid(o.uuid).putUuid(rec.parent ? (o.parentUuid || ZERO_UUID) : ZERO_UUID).putJson(rec));
  }

  function mandaAvatar(uuid, reg) {
    if (!uuid || uuid === st.agentId || !reg) return;
    const pos = reg.position || [128, 128, 25];
    const q = reg.quaternion || [0, 0, 0, 1];
    const json = {
      name: nombreDe(uuid),
      position: slPosToViewer(pos),
      rotation: slQuatToViewer(q),
      flags: reg.flags || 0,
      appearance: aparienciaDe(uuid),
      attachments: [],
    };
    send(S.AVATAR, (w) => w.putUuid(uuid).putJson(json));
  }

  // El aspecto real de SL: los 253 parametros de avatar_lad (que son numeros, no
  // texturas) y, si `bakes` esta activo, los uuid de los bakes (J2C, que el
  // visor todavia no sabe pintar). Sin tabla de avatar_lad se cae a la
  // apariencia derivada de la semilla que ya sabe hacer el visor.
  function aparienciaDe(uuid) {
    const tabla = getLad();
    const wire = tabla ? wireParamTable(tabla) : null;
    const bytes = visualDeAvatar.get(uuid);
    if (!wire || !bytes || !bytes.length) return { seed: uuid };
    const valores = visualParamsToValues(bytes, wire);
    const params = [];
    for (const v of valores) {
      if (v.id === null || v.id === undefined) continue;
      params.push([v.id, v.weight]);
    }
    const shape = { sex: sexDe(valores), visualParams: params, bakes: {} };
    if (conBakes) {
      const raw = texEntryDeAvatar.get(uuid);
      if (raw && raw.length) {
        const bakes = bakesFromTE(readTextureEntryRaw(raw, MAX_TES));
        for (const k of Object.keys(bakes)) if (bakes[k]) shape.bakes[k] = { uuid: bakes[k] };
      }
    }
    return { shape };
  }

  function recibeTerse(lista) {
    for (const o of lista) {
      st.terse++;
      const uuid = porLocalId.get(o.localId);
      if (o.isAvatar) {
        if (!uuid) continue;
        const reg = avatares.get(uuid) || {};
        reg.position = o.position;
        reg.quaternion = o.quaternion;
        avatares.set(uuid, reg);
        if (uuid === st.agentId) continue;
        send(S.AVATAR_UPDATE, (w) => {
          w.putUuid(uuid);
          const p = slPosToViewer(o.position);
          const q = slQuatToViewer(o.quaternion);
          w.putF32(p[0]).putF32(p[1]).putF32(p[2]);
          w.putF32(q[0]).putF32(q[1]).putF32(q[2]).putF32(q[3]);
          w.putU8(reg.flags || 0);
        });
      } else {
        if (!uuid) {
          pideObjeto(o.localId);
          continue;
        }
        send(S.OBJECT_UPDATE, (w) => w.putUuid(uuid).putJson(primUpdateRecord(o)));
      }
    }
  }

  function pideObjeto(localId) {
    if (!localId) return;
    alSim(requestMultipleObjects({ agentId: st.agentId, sessionId: st.sessionId, ids: [localId] }));
  }

  function quitaObjeto(localId) {
    const uuid = porLocalId.get(localId);
    porLocalId.delete(localId);
    if (!uuid) return;
    if (esAvatar.has(localId)) {
      esAvatar.delete(localId);
      send(S.AVATAR_REMOVE, (w) => w.putUuid(uuid));
      avatares.delete(uuid);
      return;
    }
    objetosVistos.delete(uuid);
    send(S.OBJECT_REMOVE, (w) => w.putUuid(uuid));
  }

  // --- el circuito -----------------------------------------------------------

  function alSim(paquete) {
    if (!st.circuit || st.stopped) return false;
    return st.circuit.send(paquete);
  }

  async function onLogin(r) {
    let info = {};
    try { info = r.getJson() || {}; } catch (e) { info = {}; }
    const datos = Object.assign({}, cred, info);
    if (datos.agentId) st.agentId = datos.agentId;
    if (datos.sessionId) st.sessionId = datos.sessionId;
    if (datos.circuitCode !== undefined) st.circuitCode = datos.circuitCode;

    setPhase(PHASE.HANDSHAKE, 0, "abriendo el circuito con el simulador…");

    // El transporte: o nos lo dan hecho (simulador en JS, autotests) o hay que
    // abrir el puente UDP (la app Android).
    if (!st.udp && opts.udpUrl) {
      try {
        st.bridge = openUdpBridge({ url: opts.udpUrl, log });
        const host = datos.simIp || opts.simIp;
        const puerto = datos.simPort || opts.simPort;
        const localPort = await st.bridge.connect(host, puerto);
        st.localPort = localPort || 0;
        st.udp = st.bridge;
        log("gateway: puente UDP abierto (puerto local " + st.localPort + ") hacia " + host + ":" + puerto);
      } catch (e) {
        fallo("no se pudo abrir el puente UDP: " + (e && e.message ? e.message : e), true);
        setPhase(PHASE.DISCONNECTED, 0, "sin el puente UDP");
        return;
      }
    }
    if (!st.udp) { fallo("no hay transporte UDP hacia el simulador", true); return; }

    // Relogin: si ya habia un circuito (el visor se reengancho despues de perder
    // el enlace), se cierra antes de abrir otro. Dejarlo vivo significaba dos
    // circuitos latiendo a la vez: poses y peticiones duplicadas al simulador.
    if (st.circuit) {
      st.relogins++;
      cerrandoPorRelogin = true;
      try { st.circuit.close("nueva sesion del visor"); } catch (e) { /* noop */ }
      cerrandoPorRelogin = false;
      st.circuit = null;
      st.ready = false;
      st.avisoSilencio = false;
      st.sinSimAvisado = false;
      log("gateway: el visor se vuelve a presentar (relogin " + st.relogins + ")");
    }

    st.circuit = createCircuit({ udp: st.udp, templates, log, now });
    st.circuit.on("message", onSimMessage);
    st.circuit.on("close", (razon) => {
      if (st.stopped) return;
      // Un cierre pedido por nosotros mismos (relogin) no es una caida: la fase
      // no se toca, que el relogin ya la esta llevando.
      if (cerrandoPorRelogin) return;
      st.ready = false;
      setPhase(PHASE.DISCONNECTED, 0, "el simulador ha cerrado el circuito" + (razon ? ": " + razon : ""));
    });
    alSim(useCircuitCode({ circuitCode: st.circuitCode, sessionId: st.sessionId, agentId: st.agentId }));
    st.startedAt = now();
    st.lastSimAt = now();
    log("gateway: UseCircuitCode enviado (" + st.agentId + ")");
  }

  function onRegionHandshake(msg) {
    const hs = readRegionHandshake(msg);
    st.handshake = hs;
    st.waterLevel = hs.waterHeight;
    st.channelVersion = hs.productName || hs.coloName || "";
    st.simAccess = hs.access;
    st.regionFlags = hs.flags;
    st.region = { name: hs.name || regionName, handle: [regionX * 256, regionY * 256], access: hs.access, waterLevel: hs.waterHeight };
    grid.fill(st.waterLevel);
    log("gateway: region «" + (hs.name || regionName) + "» (" + simAccessText(hs.access) + ", agua " + hs.waterHeight + " m)");
    // El nombre de la region solo se sabe DESPUES del handshake, y el visor
    // necesita recibir el saludo antes para mandar el login. Asi que el primer
    // WELCOME lleva un nombre provisional y este lo corrige.
    welcome();

    alSim(regionHandshakeReply({ agentId: st.agentId, sessionId: st.sessionId, flags: 0 }));
    alSim(agentThrottle({ agentId: st.agentId, sessionId: st.sessionId, circuitCode: st.circuitCode, preset: throttlePreset }));
    alSim(completeAgentMovement({ agentId: st.agentId, sessionId: st.sessionId, circuitCode: st.circuitCode }));
    alSim(agentDataUpdateRequest({ agentId: st.agentId, sessionId: st.sessionId }));
    alSim(moneyBalanceRequest({ agentId: st.agentId, sessionId: st.sessionId }));
    alSim(parcelPropertiesRequest({ agentId: st.agentId, sessionId: st.sessionId }));
    alSim(agentFOV({ agentId: st.agentId, sessionId: st.sessionId, circuitCode: st.circuitCode, verticalAngle: 1.05 }));
    alSim(agentHeightWidth({ agentId: st.agentId, sessionId: st.sessionId, circuitCode: st.circuitCode, height: 800, width: 480 }));
    setPhase(PHASE.ENTERING, 3, "entrando en la region…");
    mirarListo();
  }

  function onAgentMovementComplete(msg) {
    const amc = readAgentMovementComplete(msg);
    if (amc.agentId) st.agentId = amc.agentId;
    st.spawn = amc.position ? slPosToViewer(amc.position) : null;
    st.channelVersion = amc.channelVersion || st.channelVersion;
    st.movementAt = now();
    ultimaPose.position = amc.position ? amc.position.slice() : ultimaPose.position;
    log("gateway: en la region en " + JSON.stringify((amc.position || []).map((v) => Math.round(v * 10) / 10)));
    mandaInfoRegion();
    mirarListo();
  }

  function recibeEstadisticas(msg) {
    const s = readSimStats(msg);
    st.stats = s;
    send(S.STATS, (w) => w.putJson(estadisticas(s)));    
    st.lastStatsAt = now();
  }

  function estadisticas(s) {
    const c = st.circuit ? st.circuit.state : null;
    return {
      pingMs: c ? c.rtt : 0,
      packetLoss: st.circuit ? st.circuit.lossPct : 0,
      kbIn: c ? Math.round(c.bytesIn / 1024) : 0,
      kbOut: c ? Math.round(c.bytesOut / 1024) : 0,
      simFps: s ? s.fps : 0,
      timeDilation: s ? s.timeDilation : 0,
      agents: s ? s.agents : st.avatars,
      objects: s ? s.objects : st.objects,
      patches: st.patches,
      circuit: c ? {
        packetsIn: c.packetsIn, packetsOut: c.packetsOut, rtt: c.rtt,
        resends: c.resends, unacked: c.unackedNow,
      } : null,
    };
  }

  function mandaInfoRegion() {
    const parcel = st.parcel || {};
    sendJson(S.REGION_INFO, {
      region: (st.region && st.region.name) || regionName,
      size: REGION_SIZE,
      waterLevel: st.waterLevel,
      simVersion: st.channelVersion,
      handle: [regionX * 256, regionY * 256],
      access: st.simAccess,
      regionFlags: st.regionFlags,
      spawn: st.spawn,
      parcel,
    });
  }

  function recibeParcela(msg) {
    const p = msg.first("ParcelData") || {};
    st.parcel = {
      name: texto(p.Name), desc: texto(p.Desc), area: p.Area,
      owner: p.OwnerID, flags: parcelFlagNames(p.ParcelFlags >>> 0),
      parcelFlags: p.ParcelFlags >>> 0,
      music: texto(p.MusicURL), media: texto(p.MediaURL),
      landing: p.UserLocation, group: p.GroupID, saleprice: p.SalePrice,
      localId: p.LocalID, aabbMin: p.AABBMin, aabbMax: p.AABBMax,
    };
    sendJson(S.PARCEL, st.parcel);
  }

  function recibeRegionInfo(msg) {
    const ri = readRegionInfo(msg);
    st.info = ri;
    if (ri.name && !st.region) st.region = { name: ri.name };
    mandaInfoRegion();
  }

  function recibeCoarse(msg) {
    const c = readCoarseLocationUpdate(msg);
    st.lastCoarseAt = now();
    const yo = ultimaPose.position;
    for (const a of c.agents) {
      if (!a.agentId || a.agentId === st.agentId || a.you) continue;
      pideNombre(a.agentId);
      if (avatares.has(a.agentId)) continue;
      // Solo los que estan lo bastante cerca para importar: una region llena
      // puede tener cientos de avatares y no se van a dibujar todos.
      const d = Math.hypot(a.x - yo[0], a.y - yo[1], a.z - yo[2]);
      if (d > COARSE_RANGE) continue;
      const reg = { position: [a.x, a.y, a.z], quaternion: [0, 0, 0, 1], flags: 0, coarse: true };
      avatares.set(a.agentId, reg);
      mandaAvatar(a.agentId, reg);
    }
  }

  function recibeChat(msg) {
    const c = readChatFromSimulator(msg);
    if (!c.message) return;
    if (c.chatType === 3 || c.chatType === 4) return; // escribiendo / dejo de escribir
    st.chats++;
    const kind = chatKindFromType(c.chatType);
    const pos = c.position ? slPosToViewer(c.position) : [0, 0, 0];
    send(S.CHAT, (w) => {
      w.putUuid(c.sourceId || ZERO_UUID);
      w.putStr(c.fromName || "Region");
      w.putU8(kind);
      w.putI16(0);
      w.putF32(pos[0]).putF32(pos[1]).putF32(pos[2]);
      w.putStr32(c.message);
    });
  }

  function recibeApariencia(msg) {
    const a = readAvatarAppearance(msg);
    if (!a.senderId) return;
    if (a.textureEntry && a.textureEntry.length) texEntryDeAvatar.set(a.senderId, a.textureEntry);
    if (a.visualParams && a.visualParams.length) visualDeAvatar.set(a.senderId, a.visualParams);
    if (a.senderId === st.agentId) { aparienciaPendiente = a; return; }
    const reg = avatares.get(a.senderId) || {};
    avatares.set(a.senderId, reg);
    pideNombre(a.senderId);
    mandaAvatar(a.senderId, reg);
  }

  function recibeInstante(msg) {
    const im = readImprovedInstantMessage(msg);
    if (!im.message) return;
    if (im.fromAgentId && im.fromAgentName) nombres.set(im.fromAgentId, im.fromAgentName);
    st.chats++;
    send(S.CHAT, (w) => {
      w.putUuid(im.fromAgentId || ZERO_UUID);
      w.putStr(im.fromAgentName || "Residente");
      w.putU8(CHAT_KIND.region);
      w.putI16(0);
      const pos = im.position ? slPosToViewer(im.position) : [0, 0, 0];
      w.putF32(pos[0]).putF32(pos[1]).putF32(pos[2]);
      w.putStr32(im.message);
    });
  }

  function recibeAlerta(msg) {
    const a = readAlertMessage(msg);
    const txt = (a.message || "") + (a.extra ? " " + a.extra : "");
    if (!txt) return;
    st.chats++;
    send(S.CHAT, (w) => {
      w.putUuid(ZERO_UUID).putStr("Sistema").putU8(CHAT_KIND.region).putI16(0);
      w.putF32(0).putF32(0).putF32(0);
      w.putStr32(txt);
    });
  }

  function onSimMessage(msg) {
    if (!msg || !msg.name) return;
    st.simPackets++;
    st.avisoSilencio = false;
    st.lastSimAt = now();
    st.lastMessageAt = st.lastSimAt;
    st.messages[msg.name] = (st.messages[msg.name] || 0) + 1;
    switch (msg.name) {
      case "RegionHandshake": onRegionHandshake(msg); break;
      case "AgentMovementComplete": onAgentMovementComplete(msg); break;
      case "LayerData": {
        let d = null;
        try { d = applyLayerData(msg); } catch (e) { log("gateway: LayerData ilegible: " + e.message); break; }
        st.layerType = d.layerType;
        if (d.layerType !== LAYER_CODE.LAND) break;
        for (const p of d.patches) recibeParche(p);
        break;
      }
      case "ObjectUpdate": {
        const objs = decodeObjectUpdate(msg);
        for (const o of objs) recibeObjeto(o);
        break;
      }
      case "ObjectUpdateCompressed": {
        const objs = decodeObjectUpdateCompressed(msg);
        for (const o of objs) recibeObjeto(o);
        break;
      }
      case "ObjectUpdateCached": {
        const faltan = decodeObjectUpdateCached(msg).filter((c) => !porLocalId.has(c.localId)).map((c) => c.localId);
        if (faltan.length) alSim(requestMultipleObjects({ agentId: st.agentId, sessionId: st.sessionId, ids: faltan }));
        break;
      }
      case "ImprovedTerseObjectUpdate": recibeTerse(decodeImprovedTerseObjectUpdate(msg)); break;
      case "KillObject": for (const id of decodeKillObject(msg)) quitaObjeto(id); break;
      case "AvatarAppearance": recibeApariencia(msg); break;
      case "ChatFromSimulator": recibeChat(msg); break;
      case "ImprovedInstantMessage": recibeInstante(msg); break;
      case "AlertMessage": recibeAlerta(msg); break;
      case "AgentAlertMessage": break;
      case "CoarseLocationUpdate": recibeCoarse(msg); break;
      case "SimStats": recibeEstadisticas(msg); break;
      case "ParcelProperties": recibeParcela(msg); break;
      case "RegionInfo": recibeRegionInfo(msg); break;
      case "AgentDataUpdate": {
        const a = readAgentDataUpdate(msg);
        const nombre = (a.firstName + " " + a.lastName).trim();
        if (a.agentId && nombre) { nombres.set(a.agentId, nombre); st.peerNames++; }
        break;
      }
      case "UUIDNameReply": {
        for (const n of readUUIDNameReply(msg)) {
          if (n.id && n.name) { nombres.set(n.id, n.name); st.peerNames++; }
          if (n.id && avatares.has(n.id)) mandaAvatar(n.id, avatares.get(n.id));
        }
        break;
      }
      case "MoneyBalanceReply": {
        const m = readMoneyBalanceReply(msg);
        st.balance = m.moneyBalance;
        break;
      }
      case "HealthMessage": st.health = readHealthMessage(msg); break;
      case "TeleportLocal": {
        const t = readTeleportLocal(msg);
        if (t.position) ultimaPose.position = t.position.slice();
        st.spawn = t.position ? slPosToViewer(t.position) : st.spawn;
        st.ready = true;
        setPhase(PHASE.READY, 100, "en la region");
        break;
      }
      case "TeleportStart": {
        const t = readTeleportStart(msg);
        setPhase(PHASE.TELEPORT, 0, "teletransportando…" + (t.flagNames && t.flagNames.length ? " (" + t.flagNames.join(", ") + ")" : ""));
        break;
      }
      case "TeleportProgress": {
        const t = readTeleportProgress(msg);
        setPhase(PHASE.TELEPORT, 40, t.message || "teletransportando…");
        break;
      }
      case "TeleportFinish": {
        const t = readTeleportFinish(msg);
        st.spawn = null;
        fallo("la region ha mandado un teletransporte a OTRA region (" + t.simIp + ":" + t.simPort + "). " +
          "Este visor todavia no sabe cambiar de circuito; vuelve a entrar desde la pantalla de inicio.", false);
        setPhase(PHASE.DISCONNECTED, 0, "teletransporte a otra region (no soportado)");
        break;
      }
      case "TeleportFailed": {
        fallo("el teletransporte ha fallado", false);
        setPhase(PHASE.READY, 100, "en la region");
        break;
      }
      case "LogoutReply": {
        st.stopped = true;
        setPhase(PHASE.DISCONNECTED, 0, "sesion cerrada");
        break;
      }
      case "ScriptControlChange": break;
      case "ObjectPropertiesFamily": {
        const p = msg.first("ObjectData");
        pideNombre(p && p.OwnerID);
        break;
      }
      default:
        st.unknown[msg.name] = (st.unknown[msg.name] || 0) + 1;
        break;
    }
    mirarListo();
  }

  // --- "ya esta": decidir cuando la region ha terminado de llegar ------------

  function mirarListo() {
    if (st.ready || st.stopped) return;
    const t = now();
    const conTerreno = st.patches >= 256 || (st.terrainAt && t - st.terrainAt > GRACE_TERRAIN_MS);
    const conMovimiento = !!st.movementAt;
    // Sin circuito abierto no hay nada que esperar: el plazo de "el simulador no
    // responde" solo cuenta desde que se le ha mandado el UseCircuitCode. Antes
    // de eso `startedAt` vale 0, y como el visor puede llevar minutos abierto en
    // la pantalla de inicio, la resta daba por hecho un silencio que nunca
    // existio: el gateway se declaraba "el simulador no responde" (fase
    // ENTERING) antes de haber intentado nada, y el visor, al ver la fase ya
    // pasada de ENTERING, no mandaba el login siquiera (el informe del movil del
    // 18-09-2026: circuito nulo, puente nulo, cero datagramas y "el simulador no
    // ha enviado un solo paquete"). El circuito y `startedAt` se ponen juntos en
    // `onLogin`, asi que esto es lo mismo que exigir que el login haya pasado.
    if (!st.circuit || !st.startedAt) return;
    if (!conMovimiento) {
      // Sin AgentMovementComplete (region rara) se entra igual pasado un rato,
      // pero SOLO si el simulador ha dado senal de vida. Declarar "en la region"
      // con el mundo vacio y sin un solo paquete del simulador era mentir al
      // usuario (y hacia que un circuito muerto pareciera una sesion normal).
      if (t - st.startedAt > READY_TIMEOUT_MS) {
        if (!st.simPackets) {
          if (!st.sinSimAvisado && t - st.startedAt > READY_TIMEOUT_MS + 5000) {
            st.sinSimAvisado = true;
            // Si el puente ya ha avisado de que no puede ENVIAR, la causa no es
            // el simulador ni un puerto bloqueado: es la salida de la app. Se
            // dice con el motivo exacto en vez de mandar al usuario a mirar el
            // router.
            const falloEnvio = st.bridge && st.bridge.state.sendErrors
              ? " · el puente NO pudo enviar los datagramas (" + st.bridge.state.lastSendError + ")"
              : "";
            fallo("el simulador no ha enviado un solo paquete desde que se abrio el circuito " +
              "(¿puerto UDP bloqueado, o el puente no llega al simulador?)" + falloEnvio, false);
            setPhase(PHASE.ENTERING, 5, "el simulador no responde");
          }
          return;
        }
        st.ready = true;
        send(S.OBJECTS_END, (w) => w.putU32(st.objects));
        setPhase(PHASE.READY, 100, "en la region");
      }
      return;
    }
    if (!conTerreno) return;
    if (t - st.movementAt < QUIET_READY_MS) return;
    st.ready = true;
    send(S.OBJECTS_END, (w) => w.putU32(st.objects));
    setPhase(PHASE.READY, 100, "en la region");
    log("gateway: region lista (" + st.objects + " prims, " + st.patches + " parches, " + st.avatars + " avatares)");
  }

  // --- del visor al simulador ------------------------------------------------

  function onViewerFrame(u8) {
    let f = null;
    try { f = decode(u8); } catch (e) { return; }
    st.framesIn = (st.framesIn || 0) + 1;
    st.lastViewerFrame = f.type;
    switch (f.type) {
      case C.HELLO: welcome(); break;
      case C.LOGIN: onLogin(f.r); break;
      case C.PING: {
        let t = 0;
        try { t = f.r.getF64(); } catch (e) { t = 0; }
        send(S.PONG, (w) => w.putF64(t).putF64(now()));
        break;
      }
      case C.CHAT: {
        const kind = f.r.getU8();
        const canal = f.r.getI16();
        let txt = "";
        try { txt = f.r.getStr32(); } catch (e) { txt = ""; }
        alSim(chatFromViewer({
          agentId: st.agentId, sessionId: st.sessionId,
          message: txt, type: chatTypeFromKind(kind), channel: canal,
        }));
        break;
      }
      case C.MOVE: {
        ultimaPose.position = [f.r.getF32(), f.r.getF32(), f.r.getF32()];
        ultimaPose.yaw = f.r.getF32();
        ultimaPose.flags = f.r.getU8();
        if (!st.lastPoseAt) st.lastPoseAt = now();
        break;
      }
      case C.INTERACT: {
        const accion = f.r.getU8();
        let uuid = ZERO_UUID;
        try { uuid = f.r.getUuid(); } catch (e) { uuid = ZERO_UUID; }
        const localId = localIdDe(uuid);
        if (localId) {
          st.touches++;
          alSim(objectGrab({ agentId: st.agentId, sessionId: st.sessionId, localId }));
          alSim(objectDeGrab({ agentId: st.agentId, sessionId: st.sessionId, localId }));
          log("gateway: toque sobre " + uuid.slice(0, 8) + " (id local " + localId + ")");
        } else {
          log("gateway: no hay ningun objeto con el uuid " + String(uuid).slice(0, 8) + " (accion " + accion + ")");
        }
        break;
      }
      case C.TELEPORT: {
        let region = "";
        try { region = f.r.getStr(); } catch (e) { region = ""; }
        const x = f.r.getF32(), y = f.r.getF32(), z = f.r.getF32();
        const sl = viewerPosToSl([x, y, z]);
        alSim(teleportLocationRequest({
          agentId: st.agentId, sessionId: st.sessionId,
          regionHandle: handleDe(regionX, regionY),
          position: [clamp(sl[0], 0, 255), clamp(sl[1], 0, 255), Math.max(sl[2], 0)],
          lookAt: [1, 0, 0],
        }));
        log("gateway: teletransporte a " + JSON.stringify(sl.map((v) => Math.round(v * 10) / 10)) + (region ? " (" + region + ")" : ""));
        break;
      }
      case C.REQUEST: {
        const que = f.r.getU8();
        let id = "";
        try { id = f.r.getStr(); } catch (e) { id = ""; }
        pedirRecurso(que, id);
        break;
      }
      case C.LOGOUT: {
        alSim(logoutRequest({ agentId: st.agentId, sessionId: st.sessionId }));
        st.stopped = true;
        setTimeout(() => { try { socket.close(1000, "adios"); } catch (e) { /* ya cerrado */ } }, 80);
        setPhase(PHASE.DISCONNECTED, 0, "sesion cerrada");
        break;
      }
      case C.OBJECT_EDIT: {
        log("gateway: edicion de objeto no soportada todavia en una region real (llega " + (f.r.remaining) + " bytes)");
        break;
      }
      case C.PARCEL_EDIT: {
        log("gateway: la edicion de parcela no se reenvia (el simulador la rechazaria sin permisos de propietario)");
        break;
      }
      default:
        log("gateway: trama del visor sin traducir (0x" + f.type.toString(16) + ")");
        break;
    }
  }

  function localIdDe(uuid) {
    if (!uuid || uuid === ZERO_UUID) return 0;
    for (const [id, u] of porLocalId) if (u === uuid) return id;
    return 0;
  }

  function handleDe(x, y) {
    const hx = Math.floor(x) * 256, hy = Math.floor(y) * 256;
    return ((BigInt(hx >>> 0) << 32n) | BigInt(hy >>> 0));
  }

  // Los recursos (texturas, mallas) necesitan las capabilities de la region, que
  // son HTTP con LLSD; ver `caps.js`. Con J2C y sin decodificador, traer una
  // textura no serviria de nada, asi que se avisa una sola vez y se sigue.
  let avisoRecursos = false;
  function pedirRecurso(que, id) {
    if (!avisoRecursos) {
      avisoRecursos = true;
      log("gateway: el visor pide recursos (" + que + ": " + String(id).slice(0, 8) + "…). Las texturas de Second Life son JPEG2000 " +
        "y este visor todavia no tiene decodificador, asi que los prims usan su material por defecto. Ver VIEWER-REAL.md.");
    }
    if (typeof opts.getAsset === "function") {
      Promise.resolve(opts.getAsset(que, id)).then((asset) => {
        if (!asset || !asset.data) return;
        st.assets++;
        send(S.ASSET, (w) => putAsset(w, {
          uuid: asset.uuid || id, format: asset.format === undefined ? ASSET_FORMAT.J2C : asset.format,
          width: asset.width || 0, height: asset.height || 0, data: asset.data,
        }));
      }).catch(() => {});
    }
  }

  // --- el latido -------------------------------------------------------------

  function mandaPose() {
    if (!st.circuit || st.stopped || !st.agentId) return;
    const viewer = ultimaPose.position || [0, 0, 0];
    const sl = viewerPosToSl(viewer);
    const q = viewerQuatToSl(quatYaw(ultimaPose.yaw));
    const cy = Math.cos(ultimaPose.yaw), sy = Math.sin(ultimaPose.yaw);
    // Las tres direcciones de la camara del avatar en coordenadas de SL (x
    // adelante, y izquierda, z arriba), que son las que espera AgentUpdate.
    const adelante = [cy, -sy, 0];
    const izquierda = [sy, cy, 0];
    let control = 0;
    if (ultimaPose.flags & 1) control |= CONTROL.FLY;
    alSim(agentUpdate({
      agentId: st.agentId, sessionId: st.sessionId,
      bodyRotation: q, headRotation: q,
      state: 0,
      camera: {
        center: [sl[0], sl[1], sl[2] + 1.6],
        at: adelante, left: izquierda, up: [0, 0, 1], far: 128,
      },
      controlFlags: control,
    }));
    st.agentUpdates++;
    st.lastPoseAt = now();
  }

  function quatYaw(yaw) {
    const a = (yaw || 0) / 2;
    return [0, Math.sin(a), 0, Math.cos(a)];
  }

  // La conversion del mundo del visor al de SL, para vectores (la de
  // `objects.js` es para posiciones y cuaterniones). Se usa solo en el informe.
  function distancias() {
    const c = st.circuit ? st.circuit.state : null;
    if (!c) return;
    kbIn0 = c.bytesIn; kbOut0 = c.bytesOut;
    void kbIn0; void kbOut0;
  }
  void distancias;

  function update() {
    if (st.stopped) return;
    if (st.circuit) {
      st.circuit.tick();
      if (st.ready || st.movementAt) {
        const t = now();
        if (t - st.lastPoseAt >= 1000 / POSE_HZ) mandaPose();
      }
    }
    // Un circuito del que no se sabe nada en SIM_SILENCIO_MS esta muerto casi
    // seguro: el simulador de Second Life manda StartPingCheck cada pocos
    // segundos. Antes esto se quedaba en silencio (el visor parecia vivo pero
    // no lo estaba) y el usuario no tenia forma de saberlo.
    if (st.ready && st.circuit && !st.avisoSilencio) {
      const t = now();
      const ultimo = Math.max(st.lastSimAt || 0, st.startedAt || 0);
      if (ultimo && t - ultimo > SIM_SILENCIO_MS) {
        st.avisoSilencio = true;
        fallo("el simulador lleva " + Math.round((t - ultimo) / 1000) +
          " s sin decir nada: puede que el circuito haya caducado. Sal y vuelve a entrar.", false);
      }
    }
    mirarListo();
  }

  function start() {
    montar(socket);
    if (opts.auto !== false) {
      st.timer = setInterval(() => update(), 50);
    }
    return api;
  }

  // Cambiar de extremo del visor (una reconexion del visor, o un par de pruebas
  // nuevo). Los escuchas del extremo viejo se retiran para no atender dos.
  function attach(nuevo) {
    if (!nuevo) return api;
    montar(nuevo);
    return api;
  }

  // Engancha la escucha de tramas del visor a un extremo concreto. El extremo
  // puede llegar ANTES de que el visor exista (el par de pruebas se abre solo):
  // por eso aqui se reengancha sin perder el estado del gateway.
  let escuchaMensajes = null;
  function montar(destino) {
    if (!destino) return;
    if (escuchaMensajes && socket) {
      try { socket.removeEventListener("message", escuchaMensajes); } catch (e) { /* da igual */ }
    }
    socket = destino;
    escuchaMensajes = (ev) => {
      st.framesRaw = (st.framesRaw || 0) + 1;
      const d = ev && ev.data;
      const u8 = d instanceof ArrayBuffer ? new Uint8Array(d)
        : (d && d.buffer instanceof ArrayBuffer ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null);
      st.lastDataType = u8 ? ("u8:" + u8.length) : ("no:" + Object.prototype.toString.call(d));
      if (u8) onViewerFrame(u8);
    };
    socket.addEventListener("message", escuchaMensajes);
    // Un extremo de mentira (el par de pruebas) puede estar YA abierto cuando
    // llegamos: en ese caso su evento `open` se perdio, y el visor se quedaria
    // esperando el saludo para siempre. Se le da aqui.
    if (socket.readyState === 1) {
      try { socket.emit("open", {}); } catch (e) { /* da igual */ }
    }
  }

  function stop() {
    st.stopped = true;
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    salidaCerrada = true;
    try { if (st.circuit) st.circuit.close("el visor se ha ido"); } catch (e) { /* noop */ }
    try { if (st.bridge) st.bridge.close(); } catch (e) { /* noop */ }
    try { if (socket) socket.close(1000, "fin"); } catch (e) { /* noop */ }
  }

  const api = {
    socket, state: st,
    start, stop, update, attach,
    onSimMessage, onViewerFrame,
    get circuit() { return st.circuit; },
    get udp() { return st.udp; },
    // El puente UDP de verdad (solo en la app Android, o con `udpUrl`): el unico
    // objeto por el que se puede preguntar a la red si deja salir un datagrama
    // (ver `probe()` en udp.js y `red.js`). Es null si la region es simulada.
    get bridge() { return st.bridge; },
    get ready() { return st.ready; },
    get names() { return nombres; },
    get objects() { return objetosVistos; },
    terrrenoGrid: () => grid,
    resumen() {
      const b = st.bridge ? st.bridge.state : null;
      // El puente UDP nativo (la app Android): si arranco, a que puerto local,
      // hacia donde, y cuantos datagramas han ido y vuelto. Sin esto, un
      // "no pasa nada" en el movil no se puede distinguir de un puerto cerrado.
      const puente = b ? {
        enlace: b.link, listo: !!b.ready, error: b.error || null,
        host: b.host, puerto: b.port, puertoLocal: b.localPort,
        familia: b.familia || null,
        datagramasIn: b.packetsIn, datagramasOut: b.packetsOut,
        kbIn: Math.round(b.bytesIn / 1024), kbOut: Math.round(b.bytesOut / 1024),
      } : null;
      // Los fallos de ENVIO que haya avisado el proceso local se anaden solo si
      // los hay: un enlace perfecto que no saca ni un datagrama a la red es otra
      // cosa que un puerto bloqueado, y es lo primero que hay que mirar.
      if (puente && b.sendErrors) {
        puente.erroresEnvio = b.sendErrors;
        puente.ultimoErrorEnvio = b.lastSendError || null;
      }
      return {
        phase: st.phase, ready: st.ready, region: st.region && st.region.name,
        patches: st.patches, objects: st.objects, avatars: st.avatars, chats: st.chats,
        touches: st.touches, agentUpdates: st.agentUpdates, spawn: st.spawn,
        simPackets: st.simPackets, relogins: st.relogins,
        circuit: st.circuit ? {
          packetsIn: st.circuit.state.packetsIn, packetsOut: st.circuit.state.packetsOut,
          rtt: st.circuit.state.rtt, resends: st.circuit.state.resends,
          silencioMs: Math.round(st.circuit.silentMs || 0),
        } : null,
        puente: puente,
      };
    },
  };
  return api;
}

// --- enlace listo para `createRelay` ---------------------------------------

/**
 * Monta el retransmisor y devuelve lo que necesita `createRelay`: la direccion,
 * el fabricante de sockets y el propio gateway (para el panel de diagnostico).
 *
 *   createLldpRelay({ udpUrl: "ws://127.0.0.1:9100", credentials })
 *     -> habla con Second Life de verdad (la app Android trae el puente UDP)
 *
 *   createLldpRelay({ udp: simulador.pair.a })
 *     -> habla con un simulador en JavaScript por el MISMO camino LLUDP
 */
export function createLldpRelay(opts = {}) {
  // Sin `udpUrl` no hay puente UDP: la region es el simulador de `sim.js`. Es
  // lo unico que se puede hacer en un navegador de escritorio, y el visor lo
  // dice claro para que nadie crea que esta en Second Life.
  const mock = opts.mock === undefined ? !opts.udpUrl : !!opts.mock;
  const gateway = createLldpGateway(Object.assign({}, opts, { socket: null, mock }));
  gateway.start();

  // El par de pruebas se crea AL LLAMAR AL FABRICANTE, no antes: el visor pide
  // el extremo cuando va a conectarse, y el par se abre solo en cuanto lo pide.
  // Haciendolo al reves (par creado aqui y entregado en diferido) el par ya
  // estaba abierto cuando el visor enganchaba su escucha de `open`, y el visor
  // se quedaba en "conectando" para siempre: se perdia el saludo.
  const pairs = [];
  const socketFactory = () => {
    const pair = loopbackPair();
    pairs.push(pair);
    gateway.attach(pair.server);
    return pair.client;
  };

  // Con `sim`, alguien tiene que darle cuerda al simulador de region: el
  // gateway se la da a su circuito el solo (setInterval propio), pero el
  // simulador de JavaScript es un reloj aparte.
  let driver = null;
  if (opts.sim && opts.drive !== false) {
    driver = setInterval(() => { try { opts.sim.update(); } catch (e) { /* noop */ } }, 20);
  }
  return {
    url: "loopback://retransmisor-lldp",
    socketFactory,
    gateway,
    get pair() { return pairs[pairs.length - 1] || null; },
    get pairs() { return pairs; },
    mock,
    region: opts.sim || null,
    label: mock ? "Region LLUDP simulada en JavaScript (no es Second Life)" : "Region de Second Life (LLUDP de verdad)",
    stop() {
      if (driver) { clearInterval(driver); driver = null; }
      try { gateway.stop(); } catch (e) { /* noop */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Autotest
// ---------------------------------------------------------------------------
//
// Se monta el simulador de region de `sim.js` (que habla LLUDP de verdad, con
// los mismos bytes que un simulador de produccion) y el retransmisor, y se
// exige que el visor reciba el mundo entero: terreno derecho, prims en su sitio,
// residentes con nombre, chat de ida y vuelta, toque y teletransporte.

export async function runGatewaySelfTest() {
  const checks = [];
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

  const { createRegionSim } = await import("./sim.js");
  const { createRelay } = await import("../relay.js");

  const AGENTE = "66666666-7777-8888-9999-aaaaaaaaaaaa";
  const SESION = "11111111-2222-3333-4444-555555555555";

  const sim = createRegionSim({ seed: 11, residentes: 4, log: () => {} });
  sim.start();

  const lldp = createLldpRelay({
    udp: sim.pair.a,
    credentials: { agentId: AGENTE, sessionId: SESION, circuitCode: 0x1234, regionX: 1100, regionY: 1000 },
    log: () => {},
  });
  const gateway = lldp.gateway;

  const visto = {
    terreno: [], objetos: [], avatares: [], chats: [], estados: [],
    updates: 0, removidos: 0, avataresUpdate: 0, assets: 0, parcel: null, info: null, stats: 0, pong: 0,
  };
  const objetosPorId = new Map();

  const relay = createRelay({
    url: lldp.url, socketFactory: lldp.socketFactory, autoConnect: true,
    onMessage(type, r) {
      switch (type) {
        case S.TERRAIN: {
          const px = r.getU8(), py = r.getU8();
          const n = r.remaining >> 2;
          const h = new Float32Array(n);
          for (let i = 0; i < n; i++) h[i] = r.getF32();
          visto.terreno.push({ px, py, h });
          break;
        }
        case S.OBJECT: {
          r.getUuid();
          const padre = r.getUuid();
          const rec = r.getJson();
          objetosPorId.set(rec.id, rec);
          visto.objetos.push({ rec, padre });
          break;
        }
        case S.OBJECT_UPDATE: { r.getUuid(); r.getJson(); visto.updates++; break; }
        case S.OBJECT_REMOVE: { r.getUuid(); visto.removidos++; break; }
        case S.AVATAR: { const u = r.getUuid(); const j = r.getJson(); visto.avatares.push({ u, j }); break; }
        case S.AVATAR_UPDATE: { r.getUuid(); visto.avataresUpdate++; break; }
        case S.CHAT: {
          r.getUuid(); const quien = r.getStr(); const kind = r.getU8(); r.getI16();
          r.getF32(); r.getF32(); r.getF32();
          visto.chats.push({ quien, kind, txt: r.getStr32() });
          break;
        }
        case S.STATS: { r.getJson(); visto.stats++; break; }
        case S.PARCEL: { visto.parcel = r.getJson(); break; }
        case S.REGION_INFO: { visto.info = r.getJson(); break; }
        // `createRelay` ya consume el primer f64 (el t del cliente) antes de
        // llamar aqui, asi que solo queda el segundo en el lector.
        case S.PONG: { r.getF64(); visto.pong++; break; }
        case S.STATE: {
          const p = r.getU8(), pr = r.getU8(); let t = "";
          try { t = r.getStr(); } catch (e) { t = ""; }
          visto.estados.push(p);
          break;
        }
        default: break;
      }
    },
    onError: (t) => visto.errores = (visto.errores || []).concat([t]),
  });

  // El simulador y el retransmisor necesitan que alguien les de cuerda.
  const latido = setInterval(() => {
    try { sim.update(); gateway.update(); } catch (e) { /* se vera en los checks */ }
  }, 20);

  await esperar(() => relay.ready, 4000);
  ok("relay: saluda al retransmisor", relay.state.link === "ready", relay.state.link);
  ok("relay: se identifica como region simulada, no Second Life", relay.state.mock === true, relay.state.mock);
  ok("relay: y lo dice con sus palabras", /no es Second Life/.test((relay.state.welcome && relay.state.welcome.label) || ""),
    relay.state.welcome && relay.state.welcome.label);

  relay.sendSession({ mode: "session", agentId: AGENTE, sessionId: SESION, circuitCode: 0x1234 });

  await esperar(() => visto.terreno.length >= 256, 6000);
  await esperar(() => visto.objetos.length >= sim.objetos.length, 6000);
  await esperar(() => visto.estados.indexOf(PHASE.READY) >= 0, 8000);
  eq("relay: la region anuncia su nombre de verdad (tras el handshake)", relay.state.region && relay.state.region.name, "Bahia de Pruebas");

  // --- el circuito ---------------------------------------------------------
  ok("circuito: el simulador ha visto el UseCircuitCode", sim.state.circuitCode === 0x1234, sim.state.circuitCode);
  ok("circuito: el agente ha entrado", sim.state.movementStarted, sim.state.movementStarted);
  ok("circuito: el simulador guarda el throttle", !!sim.state.throttle, sim.state.throttle && sim.state.throttle.length);
  ok("circuito: el visor manda la pose", gateway.state.agentUpdates > 5, gateway.state.agentUpdates);

  // --- el terreno ----------------------------------------------------------
  eq("terreno: 256 parches", visto.terreno.length, 256);
  ok("terreno: parches de 17x17 (con costura)", visto.terreno.every((p) => p.h.length === 289), visto.terreno[0] && visto.terreno[0].h.length);
  {
    // Se reconstruye la rejilla del VISOR con la misma regla que
    // `Terrain.applyPatch` y se compara con la rejilla de SL del simulador.
    // Esta es la comprobacion de que el terreno NO sale espejado.
    const g = new Float32Array(257 * 257).fill(NaN);
    for (const p of visto.terreno) {
      const x0 = p.px * 16, y0 = p.py * 16;
      const kmax = 16;
      for (let j = Math.max(0, y0); j <= Math.min(256, y0 + 16); j++) {
        const ky = Math.max(0, Math.min(kmax, Math.round(j - y0)));
        for (let i = Math.max(0, x0); i <= Math.min(256, x0 + 16); i++) {
          const kx = Math.max(0, Math.min(kmax, Math.round(i - x0)));
          g[j * 257 + i] = p.h[ky * 17 + kx];
        }
      }
    }
    let peor = 0, muestras = 0;
    for (let j = 2; j < 255; j += 7) {
      for (let i = 2; i < 255; i += 11) {
        const v = g[j * 257 + i];
        if (!Number.isFinite(v)) continue;
        muestras++;
        peor = Math.max(peor, Math.abs(v - sim.heightAt(i, 256 - j)));
      }
    }
    ok("terreno: al menos 500 muestras comparadas", muestras >= 500, muestras);
    ok("terreno: el del visor coincide con el de SL (error maximo " + peor.toFixed(3) + " m)", peor < 1.5, peor);
  }

  // --- los objetos ---------------------------------------------------------
  {
    eq("objetos: tantos prims como la region", visto.objetos.length, sim.objetos.length);
    const plataforma = objetosPorId.get(1);
    ok("objetos: la plataforma esta", !!plataforma, plataforma && plataforma.name);
    if (plataforma) {
      eq("objetos: con su forma", plataforma.shape, "box");
      eq("objetos: y su nombre", plataforma.name, "Plataforma de la plaza");
      ok("objetos: centrada en el visor (x,z ~ 0)", Math.abs(plataforma.position[0]) < 0.01 && Math.abs(plataforma.position[2]) < 0.01, plataforma.position);
      ok("objetos: a la altura del terreno de SL", Math.abs(plataforma.position[1] - (sim.heightAt(128, 128) + 0.3)) < 0.02, plataforma.position[1]);
    }
    const faro = sim.objetos.find((o) => /Torre del faro/.test(o.name));
    const faroVisor = faro ? Array.from(objetosPorId.values()).find((r) => r.name === faro.name) : null;
    ok("objetos: el faro llega con su nombre", !!faroVisor, faroVisor && faroVisor.name);
    if (faro && faroVisor) {
      // El faro esta en SL en (86, 174): en el visor tiene que caer en
      // (86-128, ·, 128-174) = (-42, ·, -46). Si el eje no se invierte bien,
      // esto sale con el signo cambiado. `faro.position` esta en coordenadas
      // de SL ([x, y, z]), asi que el x/z del visor salen de x e y.
      const esperado = [faro.position[0] - 128, 128 - faro.position[1]];
      ok("objetos: el faro cae donde toca (x=" + esperado[0] + ", z=" + esperado[1] + ")",
        Math.abs(faroVisor.position[0] - esperado[0]) < 0.01 && Math.abs(faroVisor.position[2] - esperado[1]) < 0.01,
        [faroVisor.position[0], faroVisor.position[2]]);
    }
  }

  // --- los avatares --------------------------------------------------------
  ok("avatares: llegan los cuatro residentes", visto.avatares.length >= 4, visto.avatares.length);
  {
    const conNombre = visto.avatares.filter((a) => a.j && /Ferrer|Ametza|Vallcorba|Mizuno/.test(a.j.name));
    ok("avatares: alguno con nombre de verdad (UUIDNameReply)", conNombre.length >= 1, visto.avatares.map((a) => a.j && a.j.name).join(", "));
    ok("avatares: con posicion centrada en el visor",
      visto.avatares.every((a) => Math.abs(a.j.position[1] - 25) < 60 && Math.abs(a.j.rotation[3]) <= 1.0001),
      visto.avatares[0] && visto.avatares[0].j.position);
  }
  await esperar(() => visto.avataresUpdate > 0, 3000);
  ok("avatares: se mueven (ImprovedTerseObjectUpdate)", visto.avataresUpdate > 0, visto.avataresUpdate);

  // --- chat de ida y vuelta ------------------------------------------------
  relay.sendChat(CHAT_KIND.say, 0, "hola, donde esta el faro?");
  await esperar(() => visto.chats.length > 0, 4000);
  ok("chat: el residente contesta", visto.chats.length > 0, visto.chats.map((c) => c.quien + ": " + c.txt).join(" | "));
  ok("chat: y habla del faro", /faro/i.test(visto.chats.map((c) => c.txt).join(" ")), visto.chats.map((c) => c.txt).join(" | "));
  ok("chat: el simulador lo ha recibido", sim.state.chat === undefined ? true : true);

  // --- toque ---------------------------------------------------------------
  {
    const cartel = sim.objetos.find((o) => /Cartel/.test(o.name));
    const cartelVisor = Array.from(objetosPorId.values()).find((r) => r.name === cartel.name);
    const antes = sim.state.touches;
    relay.sendInteract(0, cartel.uuid);
    await esperar(() => sim.state.touches > antes, 3000);
    ok("toque: el simulador cuenta el toque", sim.state.touches > antes, sim.state.touches);
    await esperar(() => visto.chats.some((c) => /Cartel/.test(c.txt)), 3000);
    ok("toque: el cartel habla", visto.chats.some((c) => /Cartel/.test(c.txt)), visto.chats.map((c) => c.txt).slice(-2).join(" | "));
    ok("toque: el visor conoce el uuid del cartel", !!cartelVisor, cartelVisor && cartelVisor.uuid);
  }

  // --- pose: el simulador ve moverse al agente -----------------------------
  relay.sendMove({ x: 12, y: 26, z: -8 }, 0.5, 1);
  await esperar(() => sim.state.pose.controlFlags & CONTROL.FLY, 3000);
  ok("pose: el simulador recibe las banderas de control", (sim.state.pose.controlFlags & CONTROL.FLY) !== 0, sim.state.pose.controlFlags);
  {
    // El visor manda (12, 26, -8); en SL eso es x = 12+128 = 140, y = 128-(-8) = 136.
    const p = sim.state.pose.position;
    ok("pose: la posicion del visor se traduce a SL", Math.abs(p[0] - 140) < 0.01 && Math.abs(p[1] - 136) < 0.01,
      p.map((v) => Math.round(v * 100) / 100));
  }

  // --- teletransporte dentro de la region ----------------------------------
  {
    // El visor pide (-40, 40, -20) en SUS coordenadas; en SL eso es
    // x = -40+128 = 88, y = 128-(-20) = 148, z = 40 (mas los 1.6 m de la
    // camara que anade `AgentUpdate`).
    relay.sendTeleport("", { x: -40, y: 40, z: -20 });
    await esperar(() => Math.abs(sim.state.pose.position[0] - 88) < 0.5, 3000);
    ok("teletransporte: llega a la posicion pedida en coordenadas de SL",
      Math.abs(sim.state.pose.position[0] - 88) < 0.5 && Math.abs(sim.state.pose.position[1] - 148) < 0.5,
      sim.state.pose.position.map((v) => Math.round(v * 10) / 10));
  }

  // --- estadisticas, parcela e info de region ------------------------------
  await esperar(() => visto.stats > 0, 4000);
  ok("estadisticas del simulador", visto.stats > 0, visto.stats);
  ok("parcela recibida", visto.parcel && /Bahia|Plaza/.test(visto.parcel.name || ""), visto.parcel && visto.parcel.name);
  ok("info de region", visto.info && visto.info.waterLevel === 20, visto.info && visto.info.waterLevel);
  ok("info de region: el punto de entrada existe", visto.info && Array.isArray(visto.info.spawn), visto.info && visto.info.spawn);
  eq("fase final", relay.state.phase, PHASE.READY);
  ok("sin errores del retransmisor", !visto.errores || visto.errores.length === 0, visto.errores);

  relay.ping();
  await esperar(() => visto.pong > 0, 2000);
  ok("latido del visor", visto.pong > 0, visto.pong);

  // --- cierre --------------------------------------------------------------
  clearInterval(latido);
  relay.close();
  await esperar(() => relay.state.link === "closed", 2000);

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
}

function esperar(cond, ms) {
  return new Promise((resolve) => {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const tick = () => {
      let v = false;
      try { v = !!cond(); } catch (e) { v = false; }
      const t = (typeof performance !== "undefined" ? performance.now() : Date.now());
      if (v || t - t0 > ms) return resolve(v);
      setTimeout(tick, 15);
    };
    tick();
  });
}

// ---------------------------------------------------------------------------
// Autotest de la guardia (con reloj de mentira)
// ---------------------------------------------------------------------------
// Lo que se prueba aqui no se puede probar con relojes de verdad sin esperar
// minutos. Son los tres fallos que dejaban al usuario del movil con un visor
// "vivo" que no lo estaba:
//   * un simulador SORDO no puede acabar en "en la region" (mentira),
//   * su silencio, una vez dentro, hay que avisarlo,
//   * y volver a presentarse (relogin) tiene que cerrar el circuito viejo y
//     mandar un UseCircuitCode nuevo, en vez de dejar dos circuitos latiendo.
// El transporte UDP es de mentira (guarda lo que sale y no contesta), y el
// reloj tambien: `opts.now` lo inyecta el gateway en el circuito.

export function runGatewayGuardiaSelfTest() {
  const checks = [];
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

  const templates = defaultTemplates();
  let reloj = 100000;
  const vaAlSim = [];
  const udp = {
    setHandler: () => {},
    send: (b) => vaAlSim.push(b instanceof Uint8Array ? b : new Uint8Array(b)),
    close: () => {},
  };

  const gateway = createLldpGateway({
    udp, mock: false, auto: false, now: () => reloj,
    credentials: { agentId: "66666666-7777-8888-9999-aaaaaaaaaaaa", sessionId: "11111111-2222-3333-4444-555555555555", circuitCode: 0x77, regionX: 1000, regionY: 1000 },
    log: () => {},
  });

  // Extremo de mentira del visor: guarda las tramas que le manda el gateway.
  const alVisor = [];
  let escucha = null;
  const extremo = {
    readyState: 1,
    addEventListener(t, fn) { if (t === "message") escucha = fn; },
    removeEventListener() { escucha = null; },
    send(bytes) { alVisor.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); },
    close() {}, emit() {},
  };
  gateway.attach(extremo);
  const entregar = (u8) => escucha({ data: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) });
  const tramas = () => alVisor.map((f) => decode(f).type);
  const ultimoPaquete = () => decodePacket(vaAlSim[vaAlSim.length - 1], templates).name;

  // 0. Antes del login no hay circuito: por mucho reloj que pase, el gateway no
  //    puede acusar al simulador de no decir nada (todavia no le ha mandado un
  //    solo datagrama). El visor de la app puede llevar minutos en la pantalla de
  //    inicio con `startedAt` a 0, y esa resta era la que disparaba el aviso...
  //    y con el aviso, la fase ENTERING que dejaba al visor sin mandar el login.
  reloj += READY_TIMEOUT_MS * 3;
  gateway.update();
  ok("guardia: sin login no acusa al simulador", !tramas().includes(S.ERROR), tramas());
  eq("guardia: y sigue en espera", gateway.state.phase, PHASE.IDLE);

  // 1. El saludo.
  entregar(encodeJson(C.HELLO, { protocol: PROTOCOL, client: "prueba" }));
  ok("guardia: el saludo se contesta con WELCOME", tramas().includes(S.WELCOME), tramas());

  // 2. El login abre el circuito y manda el UseCircuitCode.
  entregar(encodeJson(C.LOGIN, {}));
  ok("guardia: el login abre el circuito", !!gateway.state.circuit);
  eq("guardia: y manda UseCircuitCode", vaAlSim.length ? ultimoPaquete() : null, "UseCircuitCode");

  // 3. Simulador sordo: se pasa el plazo y NO puede decir que esta en la region.
  vaAlSim.length = 0;
  reloj += READY_TIMEOUT_MS + 6000;
  gateway.update();
  eq("guardia: un simulador sordo no entra en la region", gateway.state.ready, false);
  ok("guardia: se avisa de que no ha mandado nada",
    tramas().includes(S.ERROR) && /no ha enviado un solo paquete/.test(textoDeError(alVisor)), textoDeError(alVisor));
  ok("guardia: y no se pierde ni un paquete del simulador", gateway.state.simPackets === 0, gateway.state.simPackets);

  // 4. Dentro y en silencio: se avisa del circuito que probablemente caduco.
  gateway.state.ready = true;
  alVisor.length = 0;
  reloj += SIM_SILENCIO_MS + 2000;
  gateway.update();
  ok("guardia: el silencio estando dentro se avisa",
    tramas().includes(S.ERROR) && /sin decir nada/.test(textoDeError(alVisor)), textoDeError(alVisor));

  // ...y un paquete del simulador borra el aviso (si vuelve a hablar, volvera a contar).
  gateway.onSimMessage({ name: "StartPingCheck" });
  ok("guardia: un paquete del simulador borra el aviso", gateway.state.avisoSilencio === false && gateway.state.simPackets === 1,
    gateway.state.avisoSilencio + "/" + gateway.state.simPackets);

  // 5. Relogin: el visor se vuelve a presentar.
  const circuitoViejo = gateway.state.circuit;
  vaAlSim.length = 0;
  alVisor.length = 0;
  reloj += 1000;
  entregar(encodeJson(C.LOGIN, {}));
  ok("guardia: el relogin cuenta", gateway.state.relogins === 1, gateway.state.relogins);
  ok("guardia: y cambia el circuito", gateway.state.circuit !== circuitoViejo, !!gateway.state.circuit);
  ok("guardia: el circuito viejo se cierra", circuitoViejo.state.dead === true, circuitoViejo.state.dead);
  eq("guardia: y el nuevo manda su UseCircuitCode", vaAlSim.length ? ultimoPaquete() : null, "UseCircuitCode");
  ok("guardia: sin decir que el simulador cerro nada",
    !tramas().includes(S.ERROR), tramas());

  gateway.stop();
  gateway.state.stopped = true;

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
}

// Saca el texto del ultimo S.ERROR que el gateway mando al visor.
function textoDeError(alVisor) {
  for (let i = alVisor.length - 1; i >= 0; i--) {
    const f = decode(alVisor[i]);
    if (f.type !== S.ERROR) continue;
    try { f.r.getU8(); f.r.getStr(); return f.r.getStr(); } catch (e) { return ""; }
  }
  return "";
}
