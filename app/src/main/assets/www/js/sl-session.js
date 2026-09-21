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
import { httpRequest, openUdp, hasUdp, platformInfo } from "./transport.js";
import { parseTextureEntry } from "./texture-entry.js";
import { decodeTerrainLayer } from "./terrain.js";
import {
  decodeTerseObjectData, primParamsFromShape, decodeExtraParams, parseCompressedObjectData,
  PCODE_PRIM, PCODE_AVATAR, PCODE_GRASS, PCODE_TREE, PCODE_NEW_TREE, PCODE_PART_SYS,
} from "./object-update.js";

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

const AGENT_UPDATE_HZ = 10;
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

function loginIp(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array && value.length >= 4) return [...value.slice(0, 4)].join(".");
  return String(value || "");
}

function asUuid(value) {  if (!value) return null;
  if (value instanceof Uint8Array) return value.length >= 16 ? uuidString(value) : null;
  const s = String(value).trim();
  if (/^[0-9a-fA-F-]{32,36}$/.test(s)) return s.length === 32 ? uuidString(Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)))) : s;
  return null;
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
    this.pingID = 0;
    this.stats = { objects: 0, skipped: 0, messages: 0, bytesIn: 0 };
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
    if (!who || !opts.password) {
      throw new Error("Escribe tu usuario (o Nombre Apellido) y la contraseña.");
    }
    this.agentName = who.full;
    this.status(`Iniciando sesión en ${grid.label} como ${who.first} ${who.last}…`);

    const loginReply = await this.sendLogin(grid.login, who, opts.password, {
      token: opts.token,
      mfaHash: opts.mfaHash,
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
    const passHash = "$1$" + md5Hex(password.trim().slice(0, 16));
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

  async loadCapabilities(seedUrl) {
    const res = await this.http({ url: seedUrl, headers: { Accept: "application/llsd+xml" } });
    this.caps = LLSD.parse(res.text) || {};
    const names = Object.keys(this.caps).filter((k) => k !== "seed_capability");
    this.log(`Capacidades: ${names.length} (${names.slice(0, 6).join(", ")}…)`);
    return this.caps;
  }

  // -- circuit -------------------------------------------------------------

  async openCircuit(host, port) {
    if (!host || !port) throw new Error("El login no devolvió simulador (sim_ip/sim_port).");
    if (!hasUdp()) {
      this.status("Este navegador no puede abrir UDP: entra desde la app Android para ver el mundo real.");
      throw new Error("UDP no disponible en el navegador (usa el APK de Visor SL).");
    }
    this.status(`Abriendo circuito UDP con ${host}:${port}…`);
    if (!this.circuitCode) {
      this.log("⚠ El login no devolvió circuit_code: el simulador ignorará los paquetes.");
    }
    this.udp = await openUdp(host, port);
    this.log(`UDP abierto (puerto local ${this.udp.localPort || "?"}).`);
    this.circuit = new Circuit((bytes) => this.udp.send(bytes));
    this.udp.onMessage((bytes) => this.onDatagram(bytes));
    this.udp.onError((e) => this.log("UDP: " + e.message));
    this.udp.onClose(() => this.log("Circuito UDP cerrado."));
    const templateUrl = new URL("../data/message_template.msg", import.meta.url);
    this.template = parseMessageTemplate(await fetch(templateUrl).then((r) => r.text()));
    this.defs = new Map(this.template.map((d) => [d.name, d]));
    this.index = buildIndex(this.template);
    this.log(`Plantilla cargada: ${this.template.length} mensajes.`);
    if (this.app.world) {
      this.app.world.texlib.uuidLoader = (uuid) => {
        if (this.textureCache.has(uuid) || this.pendingTextures.has(uuid)) return;
        this.pendingTextures.add(uuid);
        this.fetchTexture(uuid).catch(() => this.pendingTextures.delete(uuid));
      };
    }
    this.send("UseCircuitCode", {
      CircuitCode: { Code: this.circuitCode, SessionID: this.sessionID, ID: this.agentID },
    });
    this.startHandshakeWatchdog();
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
      this.log(`Sin respuesta del simulador (${c.stats.sent} enviados, ${c.stats.bytesIn} B recibidos, ${c.unacked.size} sin confirmar). Reintento ${tries}/5.`);
      if (tries === 5) {
        this.log("El simulador no contesta por UDP. El login funcionó, así que es la red: muchas redes móviles/wifi de empresa bloquean UDP saliente. Prueba con datos móviles.");
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

  onDatagram(bytes) {
    try {
      const packet = this.circuit.handlePacket(bytes);
      const def = this.index.get(packet.messageNumber);
      this.stats.messages++;
      this.stats.bytesIn += bytes.length;
      if (this.traceIn < 12) {
        this.traceIn++;
        this.log(`← ${bytes.length} B #${packet.messageNumber}${def ? " " + def.name : " (desconocido)"}`);
      }
      if (!def) return;
      let decoded;
      try {
        decoded = decodeMessage(def, packet);
      } catch (e) {
        this.log(`No se pudo leer ${def.name}: ${e.message}`);
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
    if (!url) return;
    let ack = 0;
    const poll = async () => {
      while (this.state === "online") {
        try {
          const res = await this.http({
            url: url + "?ack=" + ack + "&done=false", method: "POST",
            body: LLSD.toXML({ ack, done: false }),
            headers: { "Content-Type": "application/llsd+xml", Accept: "application/llsd+xml" },
            timeout: 70000,
          });
          const data = LLSD.parse(res.text) || {};
          for (const ev of data.events || []) this.handleEventQueueEvent(ev);
          if (typeof data.id === "number") ack = data.id;
        } catch (e) {
          if (this.state !== "online") return;
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
      case "UUIDNameReply": return this.onUUIDNameReply(data);
      case "AgentDataUpdate": return this.onAgentDataUpdate(data);
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
    this.send("RegionHandshakeReply", {
      AgentData: { AgentID: this.agentID, SessionID: this.sessionID },
      RegionInfo: { Flags: 0 },
    });
    this.send("CompleteAgentMovement", {
      AgentData: { AgentID: this.agentID, SessionID: this.sessionID, CircuitCode: this.circuitCode },
    });
    this.sendThrottle();
    this.send("AgentDataUpdateRequest", { AgentData: { AgentID: this.agentID, SessionID: this.sessionID } });
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
    if (d.Position) this.agentPos = d.Position;
    if (this.app.viewer) {
      this.app.viewer.controls.focus(this.agentPos, 12);
      this.app.viewer.controls.groundHeight = (x, y) => this.app.world.heightAt(x, y);
    }
    this.log(`Posición recibida: ${(d.Position || []).map((v) => v.toFixed(1)).join(", ")}`);
  }

  onLayerData(data) {
    const payload = (data.LayerData && data.LayerData.Data) || null;
    if (!payload || !payload.length) return;
    if (data.LayerID && data.LayerID.Type !== 0) return;
    try {
      for (const patch of decodeTerrainLayer(payload)) {
        if (patch.patchId >= 1024) continue;
        this.app.world.terrain.applyPatch(patch);
      }
      this.app.world.terrainDirty = true;
    } catch (e) {
      this.log("terreno: " + e.message);
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
    }, { reliable: false });
  }

  onObjectUpdateCompressed(data) {
    for (const block of data.ObjectData || []) {
      const parsed = parseCompressedObjectData(block.Data);
      if (!parsed) continue;
      const rec = Object.assign({}, parsed, {
        id: parsed.fullID, name: this.names.get(parsed.fullID) || "(objeto)",
        params: { profileCurve: 1, pathCurve: 16 }, textureEntry: null,
      });
      this.storeObject(rec);
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
    if (rec.textureEntry) this.requestTextures(rec.textureEntry);
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
      if (!id || id.startsWith("00000000") || this.textureCache.has(id) || this.pendingTextures.has(id)) continue;
      this.pendingTextures.add(id);
      this.fetchTexture(id).catch(() => this.pendingTextures.delete(id));
    }
  }

  async fetchTexture(uuid) {
    const base = this.caps.GetTexture || this.caps["GetTexture"];
    if (!base) return;
    const url = base + (base.includes("?") ? "&" : "?") + "texture_id=" + uuid;
    const res = await this.http({ url, timeout: 60000 });
    if (!res.ok || !res.bytes.length) throw new Error("textura " + uuid);
    this.pendingTextures.delete(uuid);
    const decoded = await this.decodeImage(res.bytes, res.headers["content-type"] || "");
    if (decoded) {
      this.textureCache.set(uuid, decoded);
      if (this.app.world) this.app.world.applyTexture(uuid, decoded);
    }
  }

  async decodeImage(bytes, contentType) {
    if (contentType.includes("jpeg") || contentType.includes("png") || contentType.includes("webp")) {
      return createImageBitmap(new Blob([bytes], { type: contentType }));
    }
    const { decodeJ2C } = await import("./j2c.js");
    const bitmap = await decodeJ2C(bytes);
    return bitmap;
  }

  onTerseUpdate(data) {
    for (const block of data.ObjectData || []) {
      const terse = decodeTerseObjectData(block.Data || new Uint8Array(0));
      const recID = block.ID;
      const uuid = recID ? this.byLocalID.get(recID) : null;
      if (!uuid) continue;
      const rec = this.objects.get(uuid);
      if (!rec) continue;
      rec.position = terse.position;
      rec.rotation = terse.rotation;
      if (block.TextureEntry && block.TextureEntry.length > 8) {
        try {
          rec.textureEntry = parseTextureEntry(block.TextureEntry, 32);
        } catch (e) { /* keep the previous entry */ }
      }
      if (uuid === this.agentID) this.agentPos = terse.position;
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

  upsertAvatar(rec) {
    const world = this.app.world;
    if (!world) return;
    let av = this.avatars.get(rec.id);
    if (!av) {
      av = world.addAvatar(rec.id, rec.name);
      this.avatars.set(rec.id, av);
    }
    world.updateAvatar(av, rec.position, rec.rotation, this.regionName);
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
    const oldest = this.circuit.unacked.size ? Math.min(...this.circuit.unacked.keys()) : 0;
    this.send("StartPingCheck", { PingID: { PingID: this.pingID, OldestUnacked: oldest } }, { reliable: false });
  }

  sendAgentUpdate() {
    if (this.state !== "online" || !this.circuit) return;
    const viewer = this.app.viewer;
    if (!viewer || !viewer.getCamAxes) return;
    const { center, at, left, up } = viewer.getCamAxes();
    this.send("AgentUpdate", {
      AgentData: {
        AgentID: this.agentID,
        SessionID: this.sessionID,
        BodyRotation: this.agentRot.slice(0, 3),
        HeadRotation: this.agentRot.slice(0, 3),
        State: 0,
        CameraCenter: center,
        CameraAtAxis: at,
        CameraLeftAxis: left,
        CameraUpAxis: up,
        Far: Math.max(32, this.app.world ? this.app.world.drawDistance : 128),
        ControlFlags: this.controls,
        Flags: 0,
      },
    }, { reliable: false });
  }

  setControls(flags) {
    this.controls = flags >>> 0;
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

function randomUuidBytes() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return b;
}
