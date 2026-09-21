// Second Life session: login, UDP circuit, region handshake, object stream,
// chat and capability (HTTP) traffic. The wire format follows the
// message_template.msg shipped in data/ and was cross-checked against
// Lumiya's decompiled packers.
import { LLSD } from "./llsd.js";
import { md5Hex } from "./md5.js";
import {
  parseMessageTemplate, buildIndex, wireNumber, uuidString, toBytes, toText, missingFields,
} from "./message-template.js";
import { Circuit, buildMessage, decodeMessage } from "./udp.js";
import { httpRequest, openUdp, hasUdp, platformInfo, netInfo, udpProbe, cacheGet, cachePut, sessionService } from "./transport.js";
import { parseTextureEntry } from "./texture-entry.js";
import { decodeTerrainLayer } from "./terrain.js";
import {
  decodeTerseObjectData, decodeImprovedTerse, primParamsFromShape, primParamsFromPacked,
  decodeExtraParams, parseCompressedObjectData,
  PCODE_PRIM, PCODE_AVATAR, PCODE_GRASS, PCODE_TREE, PCODE_NEW_TREE, PCODE_PART_SYS,
} from "./object-update.js";
import { defaultPrimParams } from "./prims.js";

export const GRIDS = {
  agni: { label: "Second Life (agni)", login: "https://login.agni.lindenlab.com/cgi-bin/login.cgi" },
  aditi: { label: "Second Life beta (aditi)", login: "https://login.aditi.lindenlab.com/cgi-bin/login.cgi" },
};

export const CONTROL = {
  AT_POS: 0x1, AT_NEG: 0x2, LEFT_POS: 0x4, LEFT_NEG: 0x8, UP_POS: 0x10, UP_NEG: 0x20,
  PITCH_POS: 0x40, PITCH_NEG: 0x80, YAW_POS: 0x100, YAW_NEG: 0x200,
  FAST_AT: 0x400, FAST_LEFT: 0x800, FAST_UP: 0x1000, FLY: 0x2000, STOP: 0x4000,
  FINISH_ANIM: 0x8000, STAND_UP: 0x10000, SIT_ON_GROUND: 0x20000, MOUSELOOK: 0x40000,
  NUDGE_AT_POS: 0x80000, NUDGE_AT_NEG: 0x100000, NUDGE_LEFT_POS: 0x200000, NUDGE_LEFT_NEG: 0x400000,
  NUDGE_UP_POS: 0x800000, NUDGE_UP_NEG: 0x1000000, TURN_LEFT: 0x2000000, TURN_RIGHT: 0x4000000,
};

// Names taken from the login params the official/Firestorm viewer requests
// (indra/newview/lllogininstance.cpp). We skip the inventory* ones on purpose:
// the viewer does not use inventory yet and they are the bulk of the reply.
const LOGIN_OPTIONS = [
  "display_names", "adult_compliant", "login-flags", "global-textures",
  "event_categories", "event_notifications", "classified_categories",
  "buddy-list", "ui-config", "newuser-config", "tutorial_setting",
  "max-agent-groups", "map-server-url", "advanced-mode",
];

// Capabilities requested from the seed capability. The seed endpoint is a POST
// that takes an LLSD *array* of names and answers with the subset this region
// provides: https://wiki.secondlife.com/wiki/SeedCapability
const CAPABILITY_NAMES = [
  "EventQueueGet", "GetTexture", "GetMesh", "GetMesh2", "GetDisplayNames",
  "GetAgentProfile", "GetObjectPhysicsData", "GetSurfaceInfo", "GetTerrainImage",
  "GetScriptRunning", "GetScriptTaskInfo", "GetGroups", "GetGroupMemberData",
  "GetGroupRoleData", "AgentState", "UpdateAgentLanguage", "AvatarPickerSearch",
  "ChatSessionRequest", "CopyInventoryFromNotecard", "CreateInventoryCategory",
  "DispatchRegionInfo", "Environment", "ExtEnvironment", "EstateChangeInfo",
  "FetchInventoryDescendents2", "FetchLibDescendents2", "FetchBulkInventory",
  "InventoryAPIv3", "LibraryAPIv3", "RequestInventoryAsset", "RemoveInventoryFolder",
  "RemoveInventoryObjects", "MoveInventoryFolder", "UpdateAvatarAppearance",
  "UpdateNotecardAgentInventory", "UpdateScriptAgentInventory",
  "UpdateSettingsAgentInventory", "RequestObjectPropertiesFamily", "ObjectMedia",
  "ObjectMediaNavigate", "ModifyMaterialParams", "ParcelPropertiesUpdate",
  "RemoteParcelRequest", "RegionInfo", "SimulatorFeatures", "MapLayer", "MapLayerGod",
  "HomeLocation", "SearchStatRequest", "ReadOfflineMsgs", "ViewerAsset",
  "ViewerMetrics", "ViewerStartAuction", "VoiceSignalingRequest", "SendPostcard",
];

const AGENT_UPDATE_HZ = 10;
const MAX_TEXTURE_INFLIGHT = 6;
const QUIET_IN = /^(PacketAck|StartPingCheck|CompletePingCheck|ObjectUpdate|ObjectUpdateCached|ImprovedTerseObjectUpdate|CoarseLocationUpdate|SimStats|ViewerStats|ParcelOverlay|ChatFromSimulator|ObjectProperties|AvatarAnimation)$/;
const PING_INTERVAL = 5000;
const RESEND_INTERVAL = 300;
const PRIM_BUDGET = 900;
const RESIDENCY_RADIUS = 320;

function randomMac() {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 12; i++) s += hex[(Math.random() * 16) | 0];
  return s;
}

// Mirrors FSPanelLogin::getFields (indra/newview/fspanellogin.cpp): on a Linden
// grid a single-word name is sent as first=<name>, last="Resident", and legacy
// "firstname.lastname" / "firstname_lastname" spellings are accepted too.
export function splitLoginName(raw) {
  let name = String(raw == null ? "" : raw).trim();
  const at = name.indexOf("@");
  if (at > 0) name = name.slice(0, at).trim();
  if (!name) return null;
  const sep = name.search(/[ ._]/);
  if (sep < 0) return { first: name, last: "Resident", full: name };
  const first = name.slice(0, sep).trim();
  let last = name.slice(sep + 1).trim();
  if (!first) return null;
  if (!last) last = "Resident";
  return { first, last, full: first + " " + last };
}

/**
 * The password hash a viewer sends to the login server: md5 of the first 16
 * characters of the password, prefixed with "$1$". This is what gets stored on
 * the device when the user asks for a quick login - never the plain password
 * (this hash *is* the credential, so it is exactly as sensitive as one).
 */
export function passwordHash(password) {
  return "$1$" + md5Hex(String(password || "").trim().slice(0, 16));
}

function loginIp(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array && value.length >= 4) return [...value.slice(0, 4)].join(".");
  return String(value || "");}

function asUuid(value) {  if (!value) return null;
  if (value instanceof Uint8Array) return value.length >= 16 ? uuidString(value) : null;
  const s = String(value).trim();
  if (/^[0-9a-fA-F-]{32,36}$/.test(s)) return s.length === 32 ? uuidString(Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)))) : s;
  return null;
}

// The message template ships next to the viewer (data/message_template.msg).
export async function loadMessageTemplate() {
  const url = new URL("../data/message_template.msg", import.meta.url);
  const msgs = parseMessageTemplate(await fetch(url).then((r) => r.text()));
  return { msgs, defs: new Map(msgs.map((d) => [d.name, d])), index: buildIndex(msgs) };
}

export class SLSession {
  constructor(app, opts = {}) {
    this.app = app;
    this.onStatus = opts.onStatus || null;
    this.http = opts.http || httpRequest;
    this.state = "offline";
    this.template = null;
    this.defs = null;
    this.index = null;
    this.circuit = null;
    this.udp = null;
    this.caps = {};
    this.agentID = null;
    this.sessionID = null;
    this.circuitCode = 0;
    this.agentName = "";
    this.regionName = "";
    this.agentPos = [128, 128, 30];
    this.agentRot = [0, 0, 0, 1];
    this.controls = 0;
    this.fly = false;
    this.objects = new Map();
    this.byLocalID = new Map();
    this.resident = new Map();
    this.avatars = new Map();
    this.names = new Map();
    this.nameRequests = new Set();
    this.pendingTextures = new Set();
    this.textureCache = new Map();
    this.textureQueue = [];
    this.textureInFlight = 0;
    this.pingID = 0;
    this.stats = { objects: 0, skipped: 0, messages: 0, bytesIn: 0, textures: 0 };
    this.traceIn = 0;
    this.traceOut = 0;
    this.timers = [];
    this.lastStatusAt = 0;
  }

  log(msg) {
    if (this.app.ui && this.app.ui.log) this.app.ui.log(msg);
    else console.log("[visor]", msg);
  }

  status(msg) {
    this.lastStatus = msg;
    if (this.onStatus) this.onStatus(msg);
    this.log(msg);
  }

  // -- login ---------------------------------------------------------------

  async login(opts = {}) {
    const grid = GRIDS[opts.grid] || GRIDS.agni;
    const who = splitLoginName(opts.name);
    if (!who || (!opts.password && !opts.passwordHash)) {
      throw new Error("Escribe tu usuario (o Nombre Apellido) y la contraseña.");
    }
    this.agentName = who.full;
    this.status(`Iniciando sesión en ${grid.label} como ${who.first} ${who.last}…`);

    const loginReply = await this.sendLogin(grid.login, who, opts.password, {
      token: opts.token,
      mfaHash: opts.mfaHash,
      passHash: opts.passwordHash,
    });
    if (!loginReply || loginReply.login === false || loginReply.login === "false") {
      throw new Error("Login fallido: " + ((loginReply && loginReply.message) || "respuesta rechazada"));
    }
    this.agentID = asUuid(loginReply.agent_id);
    this.sessionID = asUuid(loginReply.session_id);
    this.circuitCode = Number(loginReply.circuit_code) || 0;
    this.seedCap = loginReply.seed_capability || null;
    this.mfaHash = loginReply.mfa_hash || this.mfaHash || "";
    this.regionName = `${loginReply["region_x"] || "?"}, ${loginReply["region_y"] || "?"}`;
    this.status(`Sesión iniciada como ${this.agentName} (circuito ${this.circuitCode}).`);
    if (loginReply.message) this.log("SL: " + String(loginReply.message).split("\n")[0]);

    if (this.seedCap) await this.loadCapabilities(this.seedCap).catch((e) => this.log("Caps: " + e.message));
    await this.openCircuit(loginIp(loginReply.sim_ip), Number(loginReply.sim_port) || 0);
    this.state = "online";
    this.startLoops();
    this.startEventQueue();
    return loginReply;
  }

  async sendLogin(url, who, password, opts = {}) {
    const info = platformInfo();
    const passHash = opts.passHash || passwordHash(password);
    const body = LLSD.xmlRpcCall("login_to_simulator", [{
      first: who.first,
      last: who.last,
      passwd: passHash,
      start: "last",
      channel: "Visor SL",
      version: "1.0.0",
      platform: info.platform === "android" ? "Android" : "Web",
      platform_string: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      platform_version: info.platform === "android" ? `Android ${info.sdk || ""}` : "web",
      address_size: 64,
      mac: randomMac(),
      host_id: md5Hex("visor-sl"),
      id0: md5Hex(who.full),
      agree_to_tos: 1,
      read_critical: 1,
      viewer_digest: "00000000000000000000000000000000",
      extended_errors: 1,
      token: opts.token || "",
      mfa_hash: opts.mfaHash || "",
      options: LOGIN_OPTIONS,
    }]);
    const res = await this.http({
      url, method: "POST", body,
      headers: { "Content-Type": "text/xml", "Accept": "text/xml" },
    });
    const parsed = LLSD.parse(res.text);
    const ok = !!parsed && (parsed.login === true || parsed.login === "true");
    if (!ok) {
      const reason = (parsed && parsed.reason) || "";
      const message = (parsed && parsed.message) || "el servidor rechazó el login";
      this.log("Login: " + String(message).split("\n")[0] + (reason ? ` [reason: ${reason}]` : ""));
      if (parsed && parsed.message_id) {
        this.log(`message_id: ${parsed.message_id} ${JSON.stringify(parsed.message_args || {})}`);
      }
      if (!parsed) this.log("Respuesta del servidor: " + String(res.text || "").slice(0, 400));
      const err = new Error("Login fallido: " + message);
      err.reason = reason;
      err.messageId = (parsed && parsed.message_id) || "";
      err.messageArgs = (parsed && parsed.message_args) || null;
      err.mfaHash = (parsed && parsed.mfa_hash) || opts.mfaHash || "";
      err.mfaChallenge = reason === "mfa_challenge";
      throw err;
    }
    if (parsed.mfa_hash) this.mfaHash = parsed.mfa_hash;
    return parsed;
  }

  /**
   * The seed capability is a **POST** carrying an LLSD array of capability names
   * (Linden's `LLHTTPNode::get()` default answers 405 "Method Not Allowed", which
   * is exactly what a GET gets you); the reply is an LLSD map name -> URL.
   * https://wiki.secondlife.com/wiki/SeedCapability
   */
  async loadCapabilities(seedUrl) {
    const url = String(seedUrl);
    const safe = url.replace(/[0-9a-f-]{16,}/gi, "<uuid>");
    const body = LLSD.toXML(CAPABILITY_NAMES);
    const res = await this.http({
      url, method: "POST", body,
      headers: { "Content-Type": "application/llsd+xml", Accept: "application/llsd+xml, application/llsd+binary" },
    });
    const raw = res.text || "";
    let caps = null;
    try {
      caps = LLSD.parse(res.bytes && res.bytes.length ? res.bytes : raw);
    } catch (e) {
      this.log("Caps: no se pudo interpretar la respuesta: " + e.message);
    }
    if (!caps || typeof caps !== "object" || Array.isArray(caps) || caps instanceof Uint8Array) {
      const head = String(raw).replace(/\s+/g, " ").slice(0, 140);
      this.log(`⚠ Capacidades ilegibles (POST ${safe} → HTTP ${res.status}, ${raw.length} B): ${head}`);
      this.caps = {};
      return this.caps;
    }
    this.caps = caps;
    const names = Object.keys(caps).filter((k) => k !== "seed_capability");
    const key = ["EventQueueGet", "GetTexture", "ViewerAsset", "GetMesh", "GetDisplayNames"].filter((k) => caps[k]);
    this.log(`Capacidades: ${names.length}/${CAPABILITY_NAMES.length}${key.length ? " · " + key.join(", ") : ""}`);
    if (!caps.GetTexture && !caps.ViewerAsset) {
      this.log("⚠ La región no ofrece GetTexture ni ViewerAsset: los prims se verán con color plano (por UUID).");
    } else if (!caps.GetTexture && caps.ViewerAsset) {
      this.log("Las texturas se piden por ViewerAsset (la región no ofrece GetTexture).");
    }
    return this.caps;
  }

  // -- circuit -------------------------------------------------------------

  async openCircuit(host, port) {
    if (!host || !port) throw new Error("El login no devolvió simulador (sim_ip/sim_port).");
    this.simHost = host;
    this.simPort = port;
    if (!hasUdp()) {
      this.status("Este navegador no puede abrir UDP: entra desde la app Android para ver el mundo real.");
      throw new Error("UDP no disponible en el navegador (usa el APK de Visor SL).");
    }
    this.status(`Abriendo circuito UDP con ${host}:${port}…`);
    if (!this.circuitCode) {
      this.log("⚠ El login no devolvió circuit_code: el simulador ignorará los paquetes.");
    }
    this.log("App: " + JSON.stringify(platformInfo()) + " · Red: " + JSON.stringify(netInfo()));
    if (!this.defs) {
      try {
        const t = await loadMessageTemplate();
        this.template = t.msgs;
        this.defs = t.defs;
        this.index = t.index;
        this.log(`Plantilla cargada: ${this.template.length} mensajes.`);
      } catch (e) {
        this.log("⚠ No se pudo cargar la plantilla de mensajes: " + (e && e.message ? e.message : e));
      }
    }
    let lastError = null;
    for (let attempt = 1; attempt <= 3 && !this.udp; attempt++) {
      if (attempt > 1) this.log(`Intento ${attempt}/3 de abrir el socket UDP…`);
      try {
        this.udp = await openUdp(host, port);
      } catch (e) {
        lastError = e;
        this.log(`⚠ Intento ${attempt}/3 de abrir el socket UDP: ${e && e.message ? e.message : e}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 700));
      }
    }
    if (!this.udp) {
      const detail = lastError && lastError.message ? lastError.message : String(lastError);
      this.log("No se pudo abrir el socket UDP. Detalle: " + detail);
      throw new Error("Abrir UDP falló: " + detail);
    }
    this.log(`UDP abierto (puerto local ${this.udp.localPort || "?"}).`);
    this.circuit = new Circuit((bytes) => this.udp.send(bytes));
    this.udp.onMessage((bytes) => this.onDatagram(bytes));
    this.udp.onError((e) => this.log("UDP: " + e.message));
    this.udp.onClose(() => this.log("Circuito UDP cerrado."));
    if (this.app.world) {
      this.app.world.texlib.uuidLoader = (uuid) => this.requestTexture(uuid);
      // Baked textures of the residents go through the same GetTexture queue;
      // the world asks for them, the session owns the queue.
      this.app.world.onTextureNeeded = (uuid) => this.requestTexture(uuid);
    }
    this.send("UseCircuitCode", {
      CircuitCode: { Code: this.circuitCode, SessionID: this.sessionID, ID: this.agentID },
    });
    this.useCircuitSeq = this.circuit.lastSeq;
    this.movementSent = false;
    this.movementComplete = false;
    this.inCounts = new Map();
    this.startHandshakeWatchdog();
    this.startMovementWatchdog();
  }

  /**
   * CompleteAgentMovement is what actually puts the avatar inside the region —
   * the official viewer sends it as soon as the UseCircuitCode *ack* arrives and
   * only then does the simulator start the region stream (RegionHandshake,
   * AgentMovementComplete, LayerData, ObjectUpdate…). Waiting for the handshake
   * first (as this viewer used to) means the simulator never gets it and the
   * world never arrives: the circuit answers pings and acks but stays empty.
   */
  sendCompleteAgentMovement(reason = "") {
    if (this.movementSent) return;
    this.movementSent = true;
    this.send("CompleteAgentMovement", {
      AgentData: { AgentID: this.agentID, SessionID: this.sessionID, CircuitCode: this.circuitCode },
    });
    this.sendThrottle();
    this.send("AgentDataUpdateRequest", { AgentData: { AgentID: this.agentID, SessionID: this.sessionID } });
    this.log("CompleteAgentMovement enviado" + (reason ? ` (${reason})` : "") + ": el simulador ya puede meterte en la región.");
  }

  startMovementWatchdog() {
    let retries = 0;
    const timer = setInterval(() => {
      if (this.state === "offline") {
        clearInterval(timer);
        return;
      }
      if (this.movementComplete) {
        clearInterval(timer);
        return;
      }
      if (!this.movementSent) {
        // No ack matched the UseCircuitCode (or it never came): as soon as the
        // circuit proves it is alive, go ahead anyway.
        if (this.circuit && this.circuit.stats.received > 0) {
          this.sendCompleteAgentMovement("el circuito responde pero no llegó el acuse");
        }
        return;
      }
      retries++;
      if (retries > 3) {
        this.log("El simulador no confirma AgentMovementComplete (4 intentos). La región puede haber rechazado la entrada.");
        clearInterval(timer);
        return;
      }
      this.log(`Reintento ${retries}/3 de CompleteAgentMovement…`);
      this.send("CompleteAgentMovement", {
        AgentData: { AgentID: this.agentID, SessionID: this.sessionID, CircuitCode: this.circuitCode },
      });
    }, 4000);
    this.timers.push(timer);
  }

  // Retries the first handshake message while nothing has come back from the
  // simulator, so a lost datagram (or a sim that ignores the first one) does
  // not leave the viewer stuck on "Abriendo circuito UDP…" forever.
  startHandshakeWatchdog() {
    let tries = 0;
    const timer = setInterval(() => {
      const c = this.circuit;
      if (!c || c.stats.received > 0 || tries >= 5) {
        clearInterval(timer);
        return;
      }
      tries++;
      const sock = this.udp && this.udp.stats ? this.udp.stats : { in: 0, bytesIn: 0 };
      this.log(
        `Sin respuesta del simulador (${c.stats.sent} enviados, socket: ${sock.in} datagramas/${sock.bytesIn} B, ` +
        `circuito: ${c.stats.received} leídos, ${c.unacked.size} sin confirmar). Reintento ${tries}/5.`
      );
      if (tries === 5) {
        this.log("El simulador no contesta por UDP. Compruebo si la red deja salir UDP…");
        this.runUdpDiagnosis().catch((e) => this.log("Diagnóstico: " + (e && e.message ? e.message : e)));
        return;
      }
      try {
        this.send("UseCircuitCode", {
          CircuitCode: { Code: this.circuitCode, SessionID: this.sessionID, ID: this.agentID },
        });
      } catch (_) { /* ignore */ }
    }, 5000);
    this.timers.push(timer);
  }

  /**
   * Sends one datagram to a public STUN server (a known-good UDP echo) and one
   * real UseCircuitCode to the simulator, from throwaway sockets, and says which
   * of the two came back. That separates "this network blocks outgoing UDP" from
   * "the simulator ignored our packet".
   */
  async runUdpDiagnosis(opts = {}) {
    if (!hasUdp()) {
      this.log("Diagnóstico: sin puente nativo, aquí no hay UDP.");
      return;
    }
    const net = netInfo();
    if (net) this.log("Red: " + JSON.stringify(net));
    this.log("App: " + JSON.stringify(platformInfo()));
    const stun = Uint8Array.from([
      0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42,
      0x76, 0x69, 0x73, 0x6f, 0x72, 0x73, 0x6c, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38,
    ]);
    let control = null;
    try {
      const r = await udpProbe("stun.l.google.com", 19302, stun, 4000);
      if (!r.ok) {
        this.log("Prueba de control (STUN de Google): FALLÓ al enviar: " + r.error);
      } else if (r.received) {
        control = true;
        this.log(`Prueba de control (STUN de Google): OK, respuesta de ${r.from}:${r.fromPort} (${r.received} B).`);
      } else {
        control = false;
        this.log(`Prueba de control (STUN de Google): enviado desde el puerto ${r.localPort} y SIN respuesta.`);
      }
    } catch (e) {
      this.log("Prueba de control (STUN): " + (e && e.message ? e.message : e));
    }
    const circuitBusy = !!(this.circuit && this.circuit.stats.received > 0);
    if (this.simHost && this.simPort && this.circuitCode && !circuitBusy && !opts.skipSim) {
      try {
        const pkt = this.buildUseCircuitCodePacket();
        const r = await udpProbe(this.simHost, this.simPort, pkt, 6000);
        if (!r.ok) {
          this.log(`Simulador ${this.simHost}:${this.simPort}: FALLÓ al enviar: ${r.error}`);
        } else if (r.received) {
          this.log(`Simulador ${this.simHost}:${this.simPort}: respondió ${r.received} B desde ${r.from}:${r.fromPort}.`);
        } else {
          this.log(`Simulador ${this.simHost}:${this.simPort}: paquete UseCircuitCode de ${pkt.length} B enviado desde el puerto ${r.localPort} y SIN respuesta.`);
        }
      } catch (e) {
        this.log("Simulador: " + (e && e.message ? e.message : e));
      }
    } else if (circuitBusy) {
      this.log("El circuito ya está recibiendo datos: no mando la prueba por otro socket (rompería el circuito).");
    }
    if (control === false) {
      this.log("Veredicto: esta red no deja salir UDP (ni Google responde). Prueba con datos móviles u otra wifi.");
    } else if (control === true) {
      this.log("Veredicto: UDP sale bien (Google responde desde este móvil), así que el problema es del paquete o del simulador, no de la red.");
    }
  }

  buildUseCircuitCodePacket() {
    const def = this.def("UseCircuitCode");
    const probe = new Circuit(() => {});
    return probe.sendMessage(def, {
      CircuitCode: { Code: this.circuitCode, SessionID: this.sessionID, ID: this.agentID },
    });
  }

  def(name) {
    const d = this.defs.get(name);
    if (!d) throw new Error("mensaje desconocido: " + name);
    return d;
  }

  send(name, body, opts) {
    const def = this.def(name);
    if (!this.fieldChecked) this.fieldChecked = new Set();
    if (!this.fieldChecked.has(name)) {
      this.fieldChecked.add(name);
      const miss = missingFields(def, body || {});
      if (miss.length) this.log(`⚠ ${name}: el código no rellena ${miss.join(", ")} (se envían a cero).`);
    }
    const packet = this.circuit.sendMessage(def, body, opts);
    if (this.traceOut < 10) {
      this.traceOut++;
      if (this.traceOut <= 2) {
        const hex = [...packet].map((b) => b.toString(16).padStart(2, "0")).join(" ");
        this.log(`→ ${name} (${packet.length} B): ${hex}`);
      } else {
        this.log(`→ ${name} (${packet.length} B)`);
      }
    }
    return packet;
  }

  // PacketAck / pings / the per-frame object stream would flood the log; one
  // line for those, a few for everything else, with a running count.
  countInbound(name) {
    if (!this.inCounts) this.inCounts = new Map();
    const n = (this.inCounts.get(name) || 0) + 1;
    this.inCounts.set(name, n);
    const quiet = QUIET_IN.test(name);
    if (n <= (quiet ? 1 : 3) || n % 200 === 0) {
      this.log(`← ${name}${n > 1 ? ` (×${n})` : ""}`);
    }
  }

  onDatagram(bytes) {
    try {
      const packet = this.circuit.handlePacket(bytes);
      const def = this.index.get(packet.messageNumber);
      this.stats.messages++;
      this.stats.bytesIn += bytes.length;
      this.countInbound(def ? def.name : "#" + packet.messageNumber);
      if (!this.movementSent && this.useCircuitSeq && packet.acks.includes(this.useCircuitSeq)) {
        this.sendCompleteAgentMovement("el simulador confirmó UseCircuitCode");
      }
      if (!def) return;
      let decoded;
      try {
        decoded = decodeMessage(def, packet);
      } catch (e) {
        if (!this.decodeFails) this.decodeFails = new Map();
        const n = (this.decodeFails.get(def.name) || 0) + 1;
        this.decodeFails.set(def.name, n);
        if (n <= 3 || n % 100 === 0) {
          this.log(`No se pudo leer ${def.name}: ${e.message} · ${packet.payload.length} B, ` +
            `cabecera: ${hexHead(packet.payload, 16)}${n > 3 ? ` (×${n})` : ""}`);
        }
        return;
      }
      try {
        this.handle(def.name, decoded.data, packet);
      } catch (e) {
        this.log(`Error procesando ${def.name}: ${e.message}`);
      }
    } catch (e) {
      this.log("Datagrama ilegible: " + e.message);
    }
  }

  startLoops() {
    const every = (ms, fn) => {
      const id = setInterval(() => {
        try {
          fn();
        } catch (e) {
          this.log("loop: " + e.message);
        }
      }, ms);
      this.timers.push(id);
      return id;
    };
    every(1000 / AGENT_UPDATE_HZ, () => this.sendAgentUpdate());
    every(PING_INTERVAL, () => this.sendPing());
    every(RESEND_INTERVAL, () => {
      for (const r of this.circuit.pendingResends()) this.udp.send(r.packet);
      this.circuit.dropExpired();
    });
    every(2000, () => this.updateResidency());
    every(1000, () => {
      const c = this.circuit;
      this.app.setNetStatus?.({
        queued: this.objects.size, resident: this.resident.size,
        sent: c.stats.sent, recv: c.stats.received, resends: c.stats.resends,
        kbIn: Math.round(c.stats.bytesIn / 1024), kbOut: Math.round(c.stats.bytesOut / 1024),
      });
    });
  }

  startEventQueue() {
    const url = this.caps.EventQueueGet;
    if (!url) {
      this.log("Sin EventQueueGet: no habrá teletransporte ni mensajes en vivo.");
      return;
    }
    let ack = 0;
    let failures = 0;
    const poll = async () => {
      while (this.state === "online") {
        try {
          const res = await this.http({
            url, method: "POST",
            body: LLSD.toXML({ ack, done: false }),
            headers: { "Content-Type": "application/llsd+xml", Accept: "application/llsd+xml, application/llsd+binary" },
            timeout: 70000,
          });
          const data = LLSD.parse(res.bytes && res.bytes.length ? res.bytes : res.text) || {};
          failures = 0;
          for (const ev of data.events || []) this.handleEventQueueEvent(ev);
          if (typeof data.id === "number") ack = data.id;
        } catch (e) {
          if (this.state !== "online") return;
          failures++;
          if (failures === 1 || failures % 10 === 0) {
            this.log(`EventQueue: fallo ${failures} (${(e && e.message) || e}).`);
          }
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    };
    poll();
  }

  handleEventQueueEvent(ev) {
    const body = ev.body || {};
    switch (ev.message) {
      case "TeleportFinish":
        this.status("Teletransporte completado: " + (body.SimName || body.RegionName || ""));
        if (body.SimIP) this.openCircuit(body.SimIP, body.SimPort).catch((e) => this.log(e.message));
        break;
      case "CrossedRegion":
        this.status("Cruzando a otra región…");
        break;
      default:
        break;
    }
  }

  // -- message handlers ----------------------------------------------------

  handle(name, data, packet) {
    switch (name) {
      case "RegionHandshake": return this.onRegionHandshake(data);
      case "AgentMovementComplete": return this.onMovementComplete(data);
      case "LayerData": return this.onLayerData(data);
      case "EdgeDataPacket": return;
      case "ObjectUpdate": return this.onObjectUpdate(data);
      case "ObjectUpdateCached": return this.onObjectUpdateCached(data);
      case "ObjectUpdateCompressed": return this.onObjectUpdateCompressed(data);
      case "ImprovedTerseObjectUpdate": return this.onTerseUpdate(data);
      case "KillObject": return this.onKillObject(data);
      case "ChatFromSimulator": return this.onChat(data);
      case "ImprovedInstantMessage": return this.onInstantMessage(data);
      case "CoarseLocationUpdate": return this.onCoarseLocation(data);
      case "StartPingCheck": return this.onStartPing(data);
      case "PacketAck": return this.onPacketAck(data);
      case "SimulatorViewerTimeMessage": return this.onTimeSync(data);
      case "UUIDNameReply": return this.onUUIDNameReply(data);
      case "AgentDataUpdate": return this.onAgentDataUpdate(data);
      case "AvatarAppearance": return this.onAvatarAppearance(data);
      case "AvatarAnimation": return this.onAvatarAnimation(data);
      case "DisableSimulator": return this.log("El simulador cerró el circuito.");
      default: return;
    }
  }

  onRegionHandshake(data) {
    const info = data.RegionInfo || {};
    this.regionName = toText(info.SimName) || this.regionName;
    if (data.RegionInfo2 && data.RegionInfo2.RegionID) this.regionUUID = uuidString(data.RegionInfo2.RegionID);
    if (this.app.ui && this.app.ui.regionEl) this.app.ui.regionEl.textContent = this.regionName;
    if (this.app.world) {
      const t = this.app.world.terrain;
      t.waterHeight = info.WaterHeight ?? t.waterHeight;
      t.heights = {
        lowStart: info.TerrainStartHeight00 ?? t.heights.lowStart,
        lowEnd: info.TerrainStartHeight01 ?? t.heights.lowEnd,
        highStart: info.TerrainHeightRange00 ?? t.heights.highStart,
        highEnd: info.TerrainHeightRange01 ?? t.heights.highEnd,
      };
      this.app.viewer.water.setLevel(t.waterHeight);
    }
    // The four terrain textures this region paints its ground with (SL blends
    // them by height/slope; they are ordinary GetTexture textures).
    const detail = ["TerrainDetail0", "TerrainDetail1", "TerrainDetail2", "TerrainDetail3"]
      .map((k) => (info[k] ? uuidString(info[k]) : null));
    if (detail.some((d) => d && !d.startsWith("00000000"))) {
      this.terrainDetail = detail;
      if (this.app.world) this.app.world.setTerrainTextures(detail);
      for (const d of detail) this.requestTexture(d);
      this.log(`Texturas del terreno pedidas: ${detail.map((d) => (d ? d.slice(0, 8) : "—")).join(", ")}.`);
    }
    this.log(`RegionHandshake: «${this.regionName}»${this.regionUUID ? " " + this.regionUUID : ""}, agua a ${info.WaterHeight ?? "?"} m.`);
    // Flags (llviewerregion.h): 0x4 = supports self appearance, 0x2 = our object
    // cache is empty so the simulator should send the objects themselves instead
    // of CRC probes (we have no cache to compare against).
    this.send("RegionHandshakeReply", {
      AgentData: { AgentID: this.agentID, SessionID: this.sessionID },
      RegionInfo: { Flags: 0x6 },
    });
    // The handshake usually arrives *after* CompleteAgentMovement (which is what
    // asks the simulator to put us in the region); send it here too in case this
    // simulator does it the other way round.
    this.sendCompleteAgentMovement("handshake recibido");
    this.status(`Región: ${this.regionName} (agua a ${info.WaterHeight ?? "?"} m).`);
  }

  sendThrottle() {
    const total = 1500000 / 8;
    const parts = [0.1, 0.18, 0.08, 0.04, 0.18, 0.32, 0.1];
    const throttles = new Uint8Array(7 * 4);
    const view = new DataView(throttles.buffer);
    parts.forEach((p, i) => view.setFloat32(i * 4, total * p, true));
    this.send("AgentThrottle", {
      AgentData: { AgentID: this.agentID, SessionID: this.sessionID, CircuitCode: this.circuitCode },
      Throttle: { GenCounter: 0, Throttles: throttles },
    });
  }

  onMovementComplete(data) {
    const d = data.Data || {};
    this.movementComplete = true;
    if (d.Position) this.agentPos = d.Position;
    if (this.app.viewer) {
      this.app.viewer.controls.focus(this.agentPos, 12);
      this.app.viewer.controls.groundHeight = (x, y) => this.app.world.heightAt(x, y);
    }
    this.log(`AgentMovementComplete: estás en ${(d.Position || []).map((v) => Number(v).toFixed(1)).join(", ")} — el mundo debería empezar a llegar.`);
    // We are really in-world now: keep the session alive in the background and
    // schedule the automatic texture/terrain report (on a real region "white
    // prims" is either "nothing arrived" or "it arrived but did not decode", and
    // only this report can tell them apart).
    sessionService("start", { region: this.regionName || "Second Life", agent: this.agentName || "" });
    if (!this.reportTimer) {
      this.reportTimer = setTimeout(() => {
        this.log(this.textureReport());
        this.log(`Terreno del grid: ${this.terrainPatches || 0} parches · objetos ${this.objects.size} · avatares renderizados ${this.app.world ? this.app.world.avatars.size : 0}`);
      }, 25000);
    }
  }

  onLayerData(data) {
    const payload = (data.LayerData && data.LayerData.Data) || null;
    if (!payload || !payload.length) return;
    if (data.LayerID && data.LayerID.Type !== 0) return;
    try {
      let n = 0;
      for (const patch of decodeTerrainLayer(payload)) {
        if (patch.patchId >= 1024) continue;
        this.app.world.terrain.applyPatch(patch);
        n++;
      }
      this.app.world.terrainDirty = true;
      const before = this.terrainPatches || 0;
      this.terrainPatches = before + n;
      if (n && (before === 0 || Math.floor(this.terrainPatches / 256) > Math.floor(before / 256))) {
        const t = this.app.world.terrain;
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < t.samples.length; i += 37) { lo = Math.min(lo, t.samples[i]); hi = Math.max(hi, t.samples[i]); }
        this.log(`Terreno del grid: ${this.terrainPatches} parches aplicados (alturas ${lo.toFixed(1)} … ${hi.toFixed(1)} m, agua a ${t.waterHeight} m).`);
      }
    } catch (e) {
      this.log("terreno: " + e.message + ` (parche de ${payload.length} B, primeros bytes: ${hexHead(payload)})`);
    }
  }

  onObjectUpdate(data) {
    for (const block of data.ObjectData || []) this.applyObjectBlock(block);
  }

  // The sim only sent the CRC: ask for the full block so the object shows up.
  onObjectUpdateCached(data) {
    const wanted = [];
    for (const block of data.ObjectData || []) {
      if (this.byLocalID.has(block.ID)) continue;
      wanted.push({ CacheMissType: 0, ID: block.ID });
    }
    if (!wanted.length) return;
    this.send("RequestMultipleObjects", {
      AgentData: { AgentID: this.agentID, SessionID: this.sessionID },
      ObjectData: wanted,
    });
  }

  onObjectUpdateCompressed(data) {
    for (const block of data.ObjectData || []) {
      const parsed = parseCompressedObjectData(block.Data);
      if (!parsed) { this.compressedBad = (this.compressedBad || 0) + 1; continue; }
      this.compressedSeen = (this.compressedSeen || 0) + 1;
      const known = this.objects.get(parsed.fullID);
      // Every compressed block carries the prim shape and the TextureEntry at
      // the end (after the flag-conditional fields) — an earlier full update is
      // *not* needed, and on a fresh region there usually is none.
      let textureEntry = null;
      if (parsed.textureEntryBytes && parsed.textureEntryBytes.length > 8) {
        try {
          textureEntry = parseTextureEntry(parsed.textureEntryBytes, 32);
        } catch (e) {
          textureEntry = null;
        }
      }
      if (!textureEntry && known) textureEntry = known.textureEntry;
      const rec = Object.assign({}, parsed, {
        id: parsed.fullID,
        name: (known && known.name) || this.names.get(parsed.fullID) || "(objeto)",
        params: parsed.shape
          ? primParamsFromPacked(parsed.shape, parsed.extra)
          : (known && known.params) || defaultPrimParams(),
        textureEntry,
        terse: parsed.tailOk ? false : true,
        updateFlags: block.UpdateFlags,
      });
      if (!parsed.tailOk) {
        this.compressedTailMisses = (this.compressedTailMisses || 0) + 1;
        if (!this.firstTailMissLogged) {
          this.firstTailMissLogged = true;
          this.log(`Aviso: no pude localizar forma/textura en un ObjectUpdateCompressed ` +
            `(${block.Data.length} B, flags 0x${parsed.compFlags.toString(16)}) — uso posición y escala igualmente.`);
        }
      }
      this.storeObject(rec);
      if (rec.pcode === PCODE_AVATAR) this.requestName(rec.id);
    }
  }

  applyObjectBlock(block) {
    const fullID = uuidString(block.FullID);
    const pcode = block.PCode;
    const terse = decodeTerseObjectData(block.ObjectData || new Uint8Array(0));
    const extra = block.ExtraParams && block.ExtraParams.length ? decodeExtraParams(block.ExtraParams) : null;
    const cached = this.objects.get(fullID);
    let textureEntry = null;
    if (block.TextureEntry && block.TextureEntry.length > 8) {
      try {
        textureEntry = parseTextureEntry(block.TextureEntry, 32);
      } catch (e) {
        textureEntry = null;
      }
    } else if (cached && cached.textureEntry) {
      textureEntry = cached.textureEntry;
    }
    const rec = {
      id: fullID,
      localID: block.ID,
      pcode,
      name: this.names.get(fullID) || (pcode === PCODE_AVATAR ? "(residente)" : cached?.name || "(objeto)"),
      params: primParamsFromShape(block, extra),
      scale: block.Scale,
      position: terse.position,
      rotation: terse.rotation,
      textureEntry,
      ownerID: uuidString(block.OwnerID || new Uint8Array(16)),
      clickAction: block.ClickAction,
      updateFlags: block.UpdateFlags,
      text: block.Text ? toText(block.Text) : "",
      fullbright: false,
    };
    if (textureEntry) rec.fullbright = false;
    this.storeObject(rec);
    if (pcode === PCODE_AVATAR) this.requestName(fullID);
  }

  storeObject(rec) {
    if (!rec || !rec.id) return;
    const isAvatar = rec.pcode === PCODE_AVATAR;
    const known = this.objects.get(rec.id);
    if (known) Object.assign(known, rec);
    else this.objects.set(rec.id, rec);
    if (rec.localID) this.byLocalID.set(rec.localID, rec.id);
    if (!this.firstObjectLogged) {
      this.firstObjectLogged = true;
      const p = rec.position || [];
      this.log(`Primer objeto del simulador: pcode ${rec.pcode} en ${p.map((v) => Number(v).toFixed(1)).join(", ")} ` +
        `· escala ${(rec.scale || []).map((v) => Number(v).toFixed(1)).join("×")}` +
        `${rec.textureEntry ? " · con texturas" : ""}`);
    }
    if (isAvatar) {
      this.upsertAvatar(this.objects.get(rec.id));
      return;
    }
    const near = this.distanceToAgent(rec.position) < RESIDENCY_RADIUS;
    if (!this.resident.has(rec.id) && near && this.resident.size < PRIM_BUDGET) {
      this.buildResident(rec.id);
    } else if (!near) {
      this.stats.skipped++;
    }
  }

  buildResident(id) {
    const rec = this.objects.get(id);
    if (!rec || this.resident.has(id) || !this.app.world) return false;
    const world = this.app.world;
    const stored = world.addPrim({
      id: rec.id,
      name: rec.name,
      params: rec.params,
      scale: rec.scale,
      position: rec.position,
      rotation: rec.rotation,
      textureEntry: rec.textureEntry,
      textureByFace: this.textureKeysFor(rec),
      localID: rec.localID,
      text: rec.text,
    });
    this.resident.set(id, stored);
    this.builtPrims = (this.builtPrims || 0) + 1;
    if (this.textureKeysFor(rec)) this.builtTextured = (this.builtTextured || 0) + 1;
    else this.builtUntextured = (this.builtUntextured || 0) + 1;
    if (rec.textureEntry) this.requestTextures(rec.textureEntry);
    if (!this.firstPrimLogged) {
      this.firstPrimLogged = true;
      const p = rec.position || [];
      this.log(`Primer prim dibujado: «${rec.name}» pcode ${rec.pcode} en ` +
        `${p.map((v) => Number(v).toFixed(1)).join(", ")} · escala ${(rec.scale || []).map((v) => Number(v).toFixed(1)).join("×")} · ` +
        `${this.resident.size} en pantalla`);
    }
    return true;
  }

  textureKeysFor(rec) {
    if (!rec.textureEntry || !rec.textureEntry.getFace) return null;
    const out = {};
    for (let i = 0; i < 32; i++) {
      const f = rec.textureEntry.getFace(i);
      if (f && f.textureID && !f.textureID.startsWith("00000000")) out[i] = f.textureID;
    }
    return Object.keys(out).length ? out : null;
  }

  requestTextures(textureEntry) {
    for (let i = 0; i < 32; i++) {
      const f = textureEntry.getFace(i);
      const id = f && f.textureID;
      if (id) this.requestTexture(id);
    }
  }

  // Textures are fetched through the GetTexture capability. A region can ask for
  // hundreds at once, so they are queued with a small in-flight limit (a mobile
  // link must not open a hundred sockets at the same time).
  requestTexture(uuid) {
    if (!uuid || uuid.startsWith("00000000") || !this.textureCap()) return;
    if (this.textureCache.has(uuid) || this.pendingTextures.has(uuid)) return;
    this.requests = (this.requests || 0) + 1;
    this.pendingTextures.add(uuid);
    this.textureQueue.push(uuid);
    this.pumpTextures();
  }

  pumpTextures() {
    while (this.textureInFlight < MAX_TEXTURE_INFLIGHT && this.textureQueue.length) {
      const uuid = this.textureQueue.shift();
      this.textureInFlight++;
      // The uuid leaves `pendingTextures` either way: on success it is in
      // textureCache (which is what stops a re-request), on failure it must be
      // free to be asked for again after a reconnect.
      this.fetchTexture(uuid)
        .catch(() => {})
        .then(() => {
          this.pendingTextures.delete(uuid);
          this.textureInFlight--;
          this.pumpTextures();
        });
    }
  }

  async fetchTexture(uuid) {
    const base = this.textureCap();
    if (!base) return;
    const url = String(base).replace(/\/+$/, "") + "/?texture_id=" + uuid;
    // Textures are immutable: the same UUID always has the same pixels, so a
    // copy on the device is always valid. This is what makes re-entering a
    // region fast and saves the user's mobile data.
    let bytes = await cacheGet("tex_" + uuid);
    let type = "";
    let fromCache = !!bytes;
    if (!bytes) {
      const res = await this.http({ url, timeout: 60000 });
      type = header(res.headers, "content-type");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.bytes.length) throw new Error("respuesta vacía");
      bytes = res.bytes;
    }
    const decoded = await this.decodeImage(bytes, type);
    if (decoded) {
      this.textureCache.set(uuid, decoded);
      if (this.app.world) this.app.world.applyTexture(uuid, decoded);
      this.stats.textures++;
      if (!fromCache) cachePut("tex_" + uuid, bytes);
    } else {
      this.stats.textureFailures = (this.stats.textureFailures || 0) + 1;
      this.textureProblems = this.textureProblems || [];
      if (this.textureProblems.length < 6) {
        this.textureProblems.push(`${uuid.slice(0, 8)}: ${bytes.length} B, tipo "${type || "?"}"${this.lastDecodeError ? " → " + this.lastDecodeError : ""}`);
      }
    }
    const first = this.stats.textures + (this.stats.textureFailures || 0);
    if (first === 1 || (first === 6 && !this.stats.textures)) {
      this.log(`Texturas del grid: primera respuesta de GetTexture — ${bytes.length} B, tipo "${type || (fromCache ? "caché" : "sin tipo")}", ${decoded ? "decodificada" : "NO decodificada"}` +
        `${this.lastDecodeError ? " (" + this.lastDecodeError + ")" : ""} · primeros bytes: ${hexHead(bytes, 12)}`);
    }
    if (this.textureProblems && this.textureProblems.length === 6 && !this.textureProblemsLogged) {
      this.textureProblemsLogged = true;
      this.log("Texturas: 6 fallos. Ejemplos: " + this.textureProblems.join(" | "));
    }
  }

  /**
   * One-line texture report. It goes into the log (and the copyable trace) on
   * purpose: without it a report from a real region cannot tell "no textures
   * arrived" apart from "textures arrived but would not decode" — the two look
   * exactly the same on screen (untextured white prims).
   */
  /**
   * AvatarAnimation: the simulator telling every viewer which animations an
   * avatar is playing (`Sender.ID` = the avatar, each AnimationList entry an
   * animation *asset* UUID plus a sequence number — higher sequences win when
   * two animations drive the same joint).
   *
   * The message always carries the *complete* list, so it is handed straight to
   * the world: sequences that are still listed keep running, the ones that
   * vanished fade out, and the animation itself comes from the 118 built-in
   * assets the app ships (avatar/animation.js).
   */
  onAvatarAnimation(data) {
    const src = data.Sender && data.Sender.ID ? uuidString(data.Sender.ID) : null;
    const list = (data.AnimationList || []).map((a) => ({
      animationID: a.AnimID ? uuidString(a.AnimID) : null,
      sequenceID: a.AnimSequenceID,
    })).filter((a) => a.animationID);
    this.animationMessages = (this.animationMessages || 0) + 1;
    this.lastAnimationList = list;
    if (src) {
      if (!this.avatarAnims) this.avatarAnims = new Map();
      this.avatarAnims.set(src, list);
      const world = this.app.world;
      if (world) world.setAvatarAnimations(src, list);
    }
    this.animationsSeen = (this.animationsSeen || 0) + list.length;
    if (this.animationMessages === 1) {
      const mine = src === this.agentID ? " (nuestro avatar)" : "";
      this.log(`AvatarAnimation: ${list.length} animación(es)${mine} — ` +
        `${list.slice(0, 3).map((a) => a.animationID.slice(0, 8) + " seq " + a.sequenceID).join(", ") || "sin lista"}.`);
    }
  }

  textureReport() {
    const ok = this.stats.textures || 0;
    const bad = this.stats.textureFailures || 0;
    const pending = this.pendingTextures ? this.pendingTextures.size : 0;
    let line = `TEXTURAS: pedidas ${this.requests || this.stats.textures + bad + pending}, decodificadas ${ok}, fallidas ${bad}, en cola ${pending}`;
    if (bad && this.textureProblems && this.textureProblems.length) {
      line += ` · ejemplos: ${this.textureProblems.slice(0, 3).join(" | ")}`;
    }
    line += ` · terreno: ${this.terrainDetail ? this.terrainDetail.map((d) => (d ? d.slice(0, 8) : "—")).join(",") : "sin datos"}, aplicadas ${this.app.world ? this.app.world.terrainTexturesApplied || 0 : 0}/4`;
    const world = this.app.world;
    if (world) {
      const avs = world.avatars.size;
      const bodies = [...world.avatars.values()].filter((a) => a.bodyGroup).length;
      const info = this.appearanceInfo;
      line += ` · prims: ${this.builtPrims || 0} dibujados de ${this.objects.size} objetos` +
        ` (${this.builtTextured || 0} con textura real, ${this.builtUntextured || 0} sin textura)`;
      line += ` · comprimidos: ${this.compressedSeen || 0} leídos` +
        (this.compressedTailMisses ? ` (⚠ ${this.compressedTailMisses} sin forma/textura)` : " (todos con forma y textura)");
      line += ` · avatares: ${avs} (con cuerpo ${bodies})` +
        (info ? `, apariencia ${info.count}/${info.expected} parámetros, ${info.weights} con peso, ${info.baked} baked` : ", sin apariencia recibida") +
        `, texturas de avatar pedidas ${world.avatarTextureRequests || 0}` +
        (world.avatarError ? `, error de malla: ${world.avatarError}` : "");
      const withAnim = [...world.avatars.values()].filter((a) => a.anim && a.anim.sequences.size).length;
      const running = [...world.avatars.values()].filter((a) => a.anim && a.anim.active).length;
      const bones = [...world.avatars.values()].reduce((n, a) => n + (a.anim && a.anim.active ? a.anim.pose.count : 0), 0);
      line += ` · animaciones: ${this.animationMessages || 0} mensajes, ${withAnim} avatares con lista, ${running} reproduciendo, ${bones} huesos movidos` +
        (world.avatarsAnimated ? `, ${world.avatarsAnimated} re-posados/fotograma` : "") +
        (this.lastAnimationList && this.lastAnimationList.length ? ` (última: ${this.lastAnimationList.length})` : "");
    }
    return line;
  }

  // GetTexture is the classic capability; newer regions only advertise
  // ViewerAsset, which serves the same requests.
  textureCap() {
    return this.caps.GetTexture || this.caps.ViewerAsset || null;
  }

  async decodeImage(bytes, contentType) {
    const type = String(contentType || "").toLowerCase().split(";")[0].trim();
    try {
      if (/^(image\/(jpeg|png|webp|bmp|gif|avif))$/.test(type) || type === "image/jpg") {
        return await createImageBitmap(new Blob([bytes], { type }));
      }
      const { decodeJ2C } = await import("./j2c.js");
      return await decodeJ2C(bytes);
    } catch (e) {
      this.lastDecodeError = (e && e.message) || String(e);
      return null;
    }
  }

  onTerseUpdate(data) {
    for (const block of data.ObjectData || []) {
      // The Data blob carries the local ID and state itself (see
      // decodeImprovedTerse / the official viewer's OUT_TERSE_IMPROVED path).
      const terse = decodeImprovedTerse(block.Data);
      if (!terse) continue;
      const uuid = this.byLocalID.get(terse.localID);
      if (!uuid) {
        this.unknownTerse = (this.unknownTerse || 0) + 1;
        continue;
      }
      const rec = this.objects.get(uuid);
      if (!rec) continue;
      rec.position = terse.position;
      rec.rotation = terse.rotation;
      if (!this.terseLogged) {
        this.terseLogged = (block.Data || []).length;
        this.log(`ImprovedTerseObjectUpdate: ${this.terseLogged} B por objeto (localID ${terse.localID}) · ejemplo ` +
          `${uuid.slice(0, 8)} → ${terse.position.map((v) => v.toFixed(1)).join(", ")}`);
      }
      if (block.TextureEntry && block.TextureEntry.length > 8) {
        try {
          rec.textureEntry = parseTextureEntry(block.TextureEntry, 32);
        } catch (e) { /* keep the previous entry */ }
      }
      if (uuid === this.agentID) {
        this.agentPos = terse.position;
        this.agentRot = terse.rotation;
      }
      if (rec.pcode === PCODE_AVATAR) {
        this.upsertAvatar(rec);
      } else if (this.resident.has(uuid) && this.app.world) {
        const stored = this.app.world.objects.get(uuid);
        if (stored) {
          stored.position = terse.position;
          stored.rotation = terse.rotation;
          this.app.world.rebuildPrim(stored);
        }
      }
    }
  }

  onKillObject(data) {
    for (const block of data.ObjectData || []) {
      const uuid = this.byLocalID.get(block.ID);
      if (!uuid) continue;
      this.objects.delete(uuid);
      this.resident.delete(uuid);
      this.byLocalID.delete(block.ID);
      if (this.app.world) this.app.world.removePrim(uuid, true);
    }
  }

  onChat(data) {
    const d = data.ChatData || {};
    const name = toText(d.FromName) || "?";
    const msg = toText(d.Message) || "";
    const kind = d.ChatType === 0 ? "susurra" : d.ChatType === 2 ? "grita" : "";
    this.log(`${name}${kind ? ` ${kind}` : ""}: ${msg}`);
  }

  onInstantMessage(data) {
    const m = data.MessageBlock || {};
    const name = toText(m.FromAgentName) || "?";
    const msg = toText(m.Message) || "";
    this.log(`[IM] ${name}: ${msg}`);
    if (m.Dialog === 0 && m.ID) this.sendInstantMessageReply(m);
  }

  sendInstantMessageReply(m) {
    const agent = data_agentBlock(this);
    this.send("ImprovedInstantMessage", {
      AgentData: agent,
      MessageBlock: {
        FromGroup: 0, ToAgentID: m.ID, ParentEstateID: 0, RegionID: this.regionUUID || new Uint8Array(16),
        Position: this.agentPos, Offline: 0, Dialog: 1, ID: randomUuidBytes(),
        Timestamp: Math.floor(Date.now() / 1000), FromAgentName: toBytes(this.agentName),
        Message: toBytes(""), BinaryBucket: new Uint8Array(0),
      },
      EstateBlock: { EstateID: 0 },
      MetaData: [],
    });
  }

  onCoarseLocation(data) {
    const locs = data.Location || [];
    const ids = data.AgentData || [];
    for (let i = 0; i < ids.length && i < locs.length; i++) {
      const uuid = uuidString(ids[i].AgentID);
      if (uuid === this.agentID) continue;
      const L = locs[i];
      const pos = [L.X * 4, L.Y * 4, ((L.Z << 24) >> 24) * 4];
      const rec = this.objects.get(uuid) || { id: uuid, pcode: PCODE_AVATAR, params: {}, scale: [0.6, 0.6, 1.8], rotation: [0, 0, 0, 1] };
      rec.position = pos;
      rec.name = this.names.get(uuid) || rec.name || "(residente)";
      this.objects.set(uuid, rec);
      this.upsertAvatar(rec);
      this.requestName(uuid);
    }
  }

  onStartPing(data) {
    const d = data.PingID || {};
    this.send("CompletePingCheck", { PingID: { PingID: d.PingID } }, { reliable: false });
  }

  // The simulator acknowledges our reliable packets with standalone PacketAck
  // messages (not only with the appended-ack trailer). Missing these left every
  // reliable packet "unacked" forever, so the resend loop retried it forever.
  onPacketAck(data) {
    const seqs = [];
    for (const block of data.Packets || []) {
      const id = Number(block && block.ID);
      if (Number.isFinite(id)) seqs.push(id >>> 0);
    }
    if (!seqs.length) return;
    for (const s of seqs) this.circuit.ack(s);
    if (!this.movementSent && this.useCircuitSeq && seqs.includes(this.useCircuitSeq >>> 0)) {
      this.sendCompleteAgentMovement("el simulador confirmó UseCircuitCode");
    }
  }

  // Real region time: SL sends the sun direction in region coordinates
  // (x east, y north, z up), which drives the sky/lighting.
  onTimeSync(data) {
    const t = data.TimeInfo || {};
    this.worldTime = { usec: t.UsecSinceStart, secPerDay: t.SecPerDay, secPerYear: t.SecPerYear, phase: t.SunPhase };
    const s = t.SunDirection;
    if (Array.isArray(s) && s.length >= 3 && this.app.viewer) {
      const len = Math.hypot(s[0], s[1], s[2]) || 1;
      const elevation = Math.asin(Math.max(-1, Math.min(1, s[2] / len)));
      const azimuth = Math.atan2(s[1], s[0]);
      this.app.viewer.setSun(elevation, azimuth);
    }
  }

  onUUIDNameReply(data) {
    for (const block of data.UUIDNameBlock || []) {
      const uuid = uuidString(block.ID);
      const name = block.Name ? toText(block.Name)
        : [toText(block.FirstName), toText(block.LastName)].filter(Boolean).join(" ");
      if (!name) continue;
      this.names.set(uuid, name);
      const rec = this.objects.get(uuid);
      if (rec) {
        rec.name = name;
        const stored = this.app.world && this.app.world.objects.get(uuid);
        if (stored) stored.name = name;
        if (rec.pcode === PCODE_AVATAR) this.upsertAvatar(rec);
      }
      if (uuid === this.agentID) this.agentName = name;
    }
  }

  onAgentDataUpdate(data) {
    const a = data.AgentData || {};
    if (a.FirstName) {
      const n = [toText(a.FirstName), toText(a.LastName)].filter(Boolean).join(" ");
      if (n) {
        this.agentName = n;
        this.names.set(this.agentID, n);
      }
    }
  }

  requestName(uuid) {
    if (!uuid || this.names.has(uuid) || this.nameRequests.has(uuid)) return;
    this.nameRequests.add(uuid);
    this.send("UUIDNameRequest", { UUIDNameBlock: [{ ID: uuid }] });
  }

  // -- avatars -------------------------------------------------------------

  /**
   * The shape-slider table (avatar_lad.xml, shipped inside the app). Loaded on
   * demand: it is only needed once an avatar actually shows up.
   */
  avatarParamModule() {
    if (!this._avatarParams) {
      this._avatarParams = import("./avatar/params.js").catch((e) => {
        this._avatarParams = null;
        this.log("No se pudo leer la tabla de parámetros del avatar: " + ((e && e.message) || e));
        throw e;
      });
    }
    return this._avatarParams;
  }

  /**
   * AvatarAppearance: the resident's shape (one byte per visual param, in the
   * order the sender walked its param table — see avatar/params.js) and the
   * baked textures it is wearing (TextureEntry faces 8..20).
   *
   * This is the message that turns a capsule into *that* person.
   */
  onAvatarAppearance(data) {
    const sender = data.Sender && data.Sender.ID ? uuidString(data.Sender.ID) : null;
    if (!sender) return;
    let baked = null;
    const te = data.ObjectData && data.ObjectData.TextureEntry;
    if (te && te.length > 8) {
      try {
        const entry = parseTextureEntry(te, 24);
        baked = [];
        for (let i = 0; i < 24; i++) {
          const f = entry.getFace(i);
          const id = f && f.textureID;
          baked[i] = id && !id.startsWith("00000000") ? id : null;
        }
        // The baked faces (8..11, 19, 20) are what the body meshes wear.
        for (const u of baked) if (u) this.requestTexture(u);
      } catch (e) {
        baked = null;
      }
    }
    const values = Uint8Array.from((data.VisualParam || []).map((v) => (v.ParamValue | 0)));
    const rec = this.objects.get(sender);
    if (rec) rec.appearance = null;   // filled in below, once the table is read
    this.avatarParamModule()
      .then((mod) => mod.loadAvatarParams().then((table) => ({ mod, table })))
      .then(({ mod, table }) => {
        const weights = mod.weightsFromVisualParams(values, table);
        const appearance = { weights, baked, values, count: values.length, expected: table.transmitted.length };
        if (rec) rec.appearance = appearance;
        const world = this.app.world;
        if (world) world.setAvatarAppearance(sender, appearance);
        if (!this.appearanceLogged) {
          this.appearanceLogged = true;
          this.appearanceInfo = {
            count: values.length, expected: table.transmitted.length,
            weights: weights.size, baked: baked ? baked.filter(Boolean).length : 0,
          };
          this.log(`AvatarAppearance: ${values.length} parámetros de forma (la tabla del visor tiene ` +
            `${table.transmitted.length}) · ${weights.size} con peso · ` +
            `${baked ? baked.filter(Boolean).length : 0} texturas baked`);
          if (values.length !== table.transmitted.length) {
            this.log("⚠ La apariencia que envía el grid no tiene el mismo número de parámetros que el " +
              "avatar_lad.xml: la forma puede salir descolocada.");
          }
        }
      })
      .catch(() => {});
  }

  upsertAvatar(rec) {
    const world = this.app.world;
    if (!world) return;
    // addAvatar is idempotent and renames in place, so the name tag picks up the
    // name as soon as UUIDNameReply/AgentDataUpdate supplies it.
    const av = world.addAvatar(rec.id, rec.name);
    this.avatars.set(rec.id, av);
    world.updateAvatar(av, rec.position, rec.rotation, this.regionName);
    if (rec.appearance) world.setAvatarAppearance(rec.id, rec.appearance);
  }

  // -- text ----------------------------------------------------------------

  say(text) {
    if (this.state !== "online") {
      this.log("(sin conexión) el mensaje no se envió.");
      return;
    }
    this.send("ChatFromViewer", {
      AgentData: { AgentID: this.agentID, SessionID: this.sessionID },
      ChatData: { Message: toBytes(text), Type: 1, Channel: 0 },
    });
  }

  // -- outgoing state ------------------------------------------------------

  sendPing() {
    this.pingID = (this.pingID + 1) & 0xff;
    let oldest = 0;
    for (const seq of this.circuit.unacked.keys()) {
      if (oldest === 0 || seq < oldest) oldest = seq;
    }
    this.send("StartPingCheck", { PingID: { PingID: this.pingID, OldestUnacked: oldest } }, { reliable: false });
  }

  sendAgentUpdate() {
    if (this.state !== "online" || !this.circuit) return;
    const viewer = this.app.viewer;
    if (!viewer || !viewer.getCamAxes) return;
    const { center, at, left, up } = viewer.getCamAxes();
    const bodyRot = this.bodyRot || this.agentRot;
    const flags = ((this.controls | (this.pulse || 0)) >>> 0);
    this.pulse = 0;
    this.send("AgentUpdate", {
      AgentData: {
        AgentID: this.agentID,
        SessionID: this.sessionID,
        BodyRotation: bodyRot.slice(0, 3),
        HeadRotation: bodyRot.slice(0, 3),
        State: 0,
        CameraCenter: center,
        CameraAtAxis: at,
        CameraLeftAxis: left,
        CameraUpAxis: up,
        Far: Math.max(32, this.app.world ? this.app.world.drawDistance : 128),
        ControlFlags: flags,
        Flags: 0,
      },
    }, { reliable: false });
  }

  setControls(flags) {
    this.controls = flags >>> 0;
  }

  /** One-shot control bits (a jump, a sit) that must go out in the next update. */
  pulseControls(flags) {
    this.pulse = (this.pulse || 0) | (flags >>> 0);
  }

  distanceToAgent(pos) {
    if (!pos) return 1e9;
    return Math.hypot(pos[0] - this.agentPos[0], pos[1] - this.agentPos[1], pos[2] - this.agentPos[2]);
  }

  // Keeps the number of tessellated prims bounded: only the closest
  // PRIM_BUDGET objects inside RESIDENCY_RADIUS keep real geometry.
  updateResidency() {
    const world = this.app.world;
    if (!world) return;
    const candidates = [...this.objects.values()]
      .filter((r) => r.pcode !== PCODE_AVATAR && r.position)
      .map((r) => ({ r, d: this.distanceToAgent(r.position) }))
      .sort((a, b) => a.d - b.d);
    const want = new Set();
    for (const c of candidates) {
      if (want.size >= PRIM_BUDGET || c.d > RESIDENCY_RADIUS) break;
      want.add(c.r.id);
    }
    for (const id of [...this.resident.keys()]) {
      if (!want.has(id)) {
        world.removePrim(id, true);
        this.resident.delete(id);
      }
    }
    for (const id of want) {
      if (!this.resident.has(id)) this.buildResident(id);
    }
  }

  async disconnect() {
    this.state = "offline";
    for (const id of this.timers) clearInterval(id);
    this.timers = [];
    if (this.reportTimer) { clearTimeout(this.reportTimer); this.reportTimer = null; }
    sessionService("stop");
    try {
      if (this.circuit && this.defs.has("LogoutRequest")) {
        this.send("LogoutRequest", { AgentData: { AgentID: this.agentID, SessionID: this.sessionID } });
      }
    } catch (e) { /* ignore */ }
    if (this.udp) this.udp.close();
    for (const id of [...this.resident.keys()]) this.app.world?.removePrim(id, true);
    for (const id of [...this.avatars.keys()]) this.app.world?.removeAvatar(this.avatars.get(id));
    this.resident.clear();
    this.avatars.clear();
    this.objects.clear();
    this.log("Desconectado.");
  }
}

function data_agentBlock(session) {
  return { AgentID: session.agentID, SessionID: session.sessionID };
}

// HTTP header names arrive in whatever case the server (or the native bridge)
// used; a plain res.headers["content-type"] silently missed "Content-Type",
// which is why every texture was logged as "sin tipo".
function header(headers, name) {
  if (!headers) return "";
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return String(headers[k]);
  }
  return "";
}

function hexHead(bytes, n = 12) {
  return [...bytes.slice(0, n)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function randomUuidBytes() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}
