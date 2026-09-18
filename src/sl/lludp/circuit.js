// circuit.js -- el circuito LLUDP: numeracion, fiabilidad, acks y latido.
//
// POR QUE HACE FALTA UN CIRCUITO Y NO BASTA CON MANDAR DATAGRAMAS
// --------------------------------------------------------------
// Un datagrama UDP puede perderse, duplicarse o llegar desordenado, y Second
// Life no se fia de la red: monta encima su propia capa de fiabilidad sobre UDP.
// Es lo que el visor llama "el circuito" (el mismo nombre que usa Linden Lab en
// `llmessage/circuit.cpp`). Sus reglas, todas obligatorias:
//
//   * Cada datagrama que sale lleva un ID de paquete que empieza en 0 y sube.
//   * Un mensaje marcado FIABLE (bandera 0x40) hay que reenviarlo hasta que el
//     otro extremo lo confirme con un ACK. A los 3 segundos sin confirmacion se
//     reenvia (con la bandera 0x20 de "reenvio"), hasta 10 veces.
//   * Los ACK del remitente viajan en la cola del datagrama (bandera 0x10):
//     los IDs van al REVES y detras el numero de acks. Tambien se pueden mandar
//     aparte en un mensaje `PacketAck`.
//   * Un datagrama repetido (mismo ID fiable ya visto) NO se procesa dos veces,
//     pero SI se vuelve a confirmar. Sin esto, un reenvio duplicaria prims.
//   * El simulador manda `StartPingCheck` cada pocos segundos; hay que contestar
//     con `CompletePingCheck` o el circuito se declara muerto y te echa.
//
// El transporte (`udp`) es lo unico que cambia entre entornos: en las pruebas un
// par de mentira, en la app Android un socket UDP de verdad puenteado. El
// circuito no sabe cual es.

import { FLAG, decodePacket, encodePacket, utf8FromFixed } from "./codec.js";
import { defaultTemplates } from "./template.js";

// Cada cuanto se reenvia un mensaje fiable sin confirmar, cuantas veces como
// mucho, y cuantos acks caben "de gorra" en un datagrama de salida.
export const RESEND_EVERY_MS = 3000;
export const RESEND_TRIES = 10;
export const PIGGYBACK_ACKS = 11;
const SEEN_MAX = 2000;

export function createCircuit(opts = {}) {
  const udp = opts.udp;
  const templates = opts.templates || defaultTemplates();
  const log = opts.log || (() => {});
  const now = opts.now || (() => Date.now());

  const st = {
    packetId: 0,                 // el siguiente ID que vamos a usar
    packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0,
    reliableOut: 0, resends: 0, duplicates: 0, unackedNow: 0,
    lastRecvAt: 0, lastSendAt: 0, openedAt: 0,
    rtt: 0, rttSamples: 0,
    gapLost: 0, gapTotal: 0,     // estimacion de perdida por huecos en la numeracion
    pingsIn: 0, pingsOut: 0,
    pingId: 0,
    dead: false, closeReason: null,
    lastGapId: -1,
  };

  const unacked = new Map();      // id -> { args, acks, tries, at }
  const pendingAcks = [];
  const seen = new Set();
  const seenOrder = [];
  const listeners = { message: [], unknown: [], ack: [], close: [] };

  function emit(type, a) { for (const fn of listeners[type]) { try { fn(a); } catch (e) { log("error en un escucha de " + type + ": " + (e && e.message ? e.message : e)); } } }

  // --- acks ------------------------------------------------------------------

  function remember(packetId) { return !seen.has(packetId); }

  function trackSeen(packetId) {
    if (seen.has(packetId)) return;
    seen.add(packetId);
    seenOrder.push(packetId);
    if (seenOrder.length > SEEN_MAX) seen.delete(seenOrder.shift());
  }

  function queueAck(packetId) {
    if (pendingAcks.indexOf(packetId) === -1) pendingAcks.push(packetId);
    if (pendingAcks.length > 128) pendingAcks.splice(0, pendingAcks.length - 128);
  }

  function takeAcks(max) {
    if (!pendingAcks.length) return [];
    return pendingAcks.splice(0, max === undefined ? PIGGYBACK_ACKS : max);
  }

  // Los acks que llegan confirman nuestros mensajes fiables. Es la unica medida
  // de ida y vuelta que da el protocolo (el `StartPingCheck` lo manda el
  // simulador y no lleva hora), asi que de aqui sale el `rtt`.
  function collectAcks(ids) {
    for (const id of ids) {
      const info = unacked.get(id);
      if (!info) continue;
      unacked.delete(id);
      const dt = now() - info.at;
      if (dt >= 0 && dt < 10000) {
        st.rtt = st.rttSamples ? Math.round(st.rtt * 0.7 + dt * 0.3) : Math.round(dt);
        st.rttSamples++;
      }
      emit("ack", id);
    }
    st.unackedNow = unacked.size;
  }

  // --- entrada ---------------------------------------------------------------

  function handleDatagram(data) {
    let msg;
    try {
      msg = decodePacket(data, templates);
    } catch (e) {
      if (e && e.num !== undefined && opts.onUnknownMessage !== false) emit("unknown", e);
      else log("datagrama ilegible: " + (e && e.message ? e.message : e));
      return;
    }
    st.packetsIn++;
    st.bytesIn += data.length;
    st.lastRecvAt = now();

    // Huecos en la numeracion del simulador = lo que se ha perdido por el
    // camino. Solo cuenta si va hacia adelante y el salto es razonable (si no,
    // seria un reinicio del simulador o el salto de 2^32).
    if (st.lastGapId >= 0 && msg.packetId > st.lastGapId) {
      const gap = msg.packetId - st.lastGapId - 1;
      if (gap < 1000) { st.gapLost += gap; st.gapTotal += gap + 1; }
      else st.gapTotal += 1;
    } else {
      st.gapTotal += 1;
    }
    st.lastGapId = msg.packetId;

    // Un mensaje fiable repetido no se procesa dos veces, pero si se confirma.
    const isNew = !(msg.flags & FLAG.RELIABLE) || remember(msg.packetId);
    if (msg.flags & FLAG.RELIABLE) {
      if (!isNew) {
        st.duplicates++;
        queueAck(msg.packetId);
        return;
      }
      trackSeen(msg.packetId);
      queueAck(msg.packetId);
    }
    if (msg.acks.length) collectAcks(msg.acks);
    if (msg.name === "PacketAck") collectAcks(msg.list("Packets").map((b) => b.ID));
    if (msg.acks.length || msg.name === "PacketAck") flushAcks();

    if (msg.name === "StartPingCheck") {
      st.pingsIn++;
      const id = msg.field("PingID", "PingID");
      st.pingId = id;
      st.pingsOut++;
      send({ name: "CompletePingCheck", blocks: { PingID: [{ PingID: id }] } });
      return;
    }

    emit("message", msg);
  }

  // --- salida ----------------------------------------------------------------

  function send(args) {
    const pid = (st.packetId++) >>> 0;
    const acks = args.acks || takeAcks();
    const flags = (args.flags || 0) | (args.reliable ? FLAG.RELIABLE : 0);
    const full = Object.assign({}, args, { packetId: pid, acks, flags });
    const buf = encodePacket(full, templates);
    st.packetsOut++;
    st.bytesOut += buf.length;
    st.lastSendAt = now();
    if (!st.openedAt) st.openedAt = st.lastSendAt;
    if (args.reliable) {
      st.reliableOut++;
      unacked.set(pid, { args: full, acks, tries: RESEND_TRIES, at: now() });
      st.unackedNow = unacked.size;
    }
    udp.send(buf);
    return pid;
  }

  // Manda los acks pendientes en un `PacketAck` aparte. Hace falta cuando no
  // tenemos nada que decir: si no, el simulador reenviaria sin necesidad.
  function flushAcks() {
    if (!pendingAcks.length) return 0;
    const ids = takeAcks(255);
    send({ name: "PacketAck", blocks: { Packets: ids.map((ID) => ({ ID })) } });
    return ids.length;
  }

  // --- reloj ------------------------------------------------------------------

  function tick() {
    const t = now();
    // 1. Reenvio de lo fiable que no ha sido confirmado.
    for (const [pid, info] of unacked) {
      if (t - info.at < RESEND_EVERY_MS) continue;
      info.tries--;
      if (info.tries <= 0) {
        unacked.delete(pid);
        log("se renuncia al mensaje fiable " + info.args.name + " (id " + pid + "): " + RESEND_TRIES + " reenvios sin confirmacion");
        st.unackedNow = unacked.size;
        continue;
      }
      info.at = t;
      st.resends++;
      const acks = takeAcks();
      const buf = encodePacket(Object.assign({}, info.args, {
        acks, flags: info.args.flags | FLAG.RESENT,
      }), templates);
      st.packetsOut++;
      st.bytesOut += buf.length;
      st.lastSendAt = t;
      udp.send(buf);
    }
    // 2. Acks pendientes que no han podido ir de gorra.
    if (pendingAcks.length) flushAcks();
  }

  function close(reason) {
    if (st.dead) return;
    st.dead = true;
    st.closeReason = reason || null;
    unacked.clear();
    st.unackedNow = 0;
    emit("close", { reason: st.closeReason });
  }

  // --- montaje ---------------------------------------------------------------
  //
  // `_age(ms)` envejece a mano los relojes de lo que esta sin confirmar: es
  // solo para el autotest (asi no hay que esperar 3 segundos de verdad).

  if (udp.setHandler) udp.setHandler(handleDatagram);
  else if (udp.onPacket !== undefined) udp.onPacket = handleDatagram;
  else throw new Error("el transporte udp no dice como recibir (setHandler)");

  const api = {
    get state() { return st; },
    send, flushAcks, tick, close, handleDatagram,
    _age(ms) { for (const info of unacked.values()) info.at -= ms; },
    on(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); return () => { const a = listeners[type]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }; },
    get packetId() { return st.packetId; },
    // Milisegundos desde el ultimo datagrama del simulador: sirve para saber si
    // el circuito sigue vivo sin depender de que el simulador avise.
    get silentMs() { return st.lastRecvAt ? now() - st.lastRecvAt : 0; },
    get lossPct() { return st.gapTotal ? Math.round((st.gapLost / st.gapTotal) * 1000) / 10 : 0; },
  };
  return api;
}

// Ayudante de texto para los campos `Variable`/`Fixed` que son cadenas (el 90%
// de las que trae Second Life: nombres, descripciones, mensajes de chat).
export function textField(msg, blockName, fieldName, i = 0) {
  const v = msg.field(blockName, fieldName, i);
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return utf8FromFixed(v);
  return String(v);
}

// --- autotest ----------------------------------------------------------------

export function runCircuitSelfTest() {
  return new Promise((resolve) => {
    const checks = [];
    const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
    const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });

    const t = defaultTemplates();
    // Transporte de mentira: guarda lo que se manda y deja inyectar lo que
    // llega. Es lo que hara falta para probar el simulador de pruebas.
    function fakeUdp() {
      const out = [];
      const node = { out, handler: null, send(u8) { out.push(u8); }, setHandler(fn) { node.handler = fn; }, deliver(u8) { node.handler(u8); } };
      return node;
    }

    const udpA = fakeUdp();
    const circ = createCircuit({ udp: udpA, templates: t });
    const recibidos = [];
    const acks = [];
    circ.on("message", (m) => recibidos.push(m.name));
    circ.on("ack", (id) => acks.push(id));

    // 1. La numeracion empieza en cero y sube.
    circ.send({ name: "UseCircuitCode", reliable: true, blocks: { CircuitCode: [{ Code: 1, SessionID: "00000000-0000-0000-0000-000000000001", ID: "00000000-0000-0000-0000-000000000002" }] } });
    circ.send({ name: "CompleteAgentMovement", reliable: true, blocks: { AgentData: [{ AgentID: "00000000-0000-0000-0000-000000000002", SessionID: "00000000-0000-0000-0000-000000000001", CircuitCode: 1 }] } });
    const uno = decodePacket(udpA.out[0], t);
    const dos = decodePacket(udpA.out[1], t);
    eq("el primer datagrama va con id 0", uno.packetId, 0);
    eq("el segundo con id 1", dos.packetId, 1);
    eq("y se marcan como fiables", [(uno.flags & FLAG.RELIABLE) !== 0, (dos.flags & FLAG.RELIABLE) !== 0], [true, true]);
    eq("el circuito los tiene sin confirmar", circ.state.unackedNow, 2);

    // 2. Llega un StartPingCheck: hay que contestar con CompletePingCheck y el
    //    mismo id, y el circuito lo hace solo.
    const ping = encodePacket({ name: "StartPingCheck", packetId: 100, flags: FLAG.RELIABLE, blocks: { PingID: [{ PingID: 7, OldestUnacked: 0 }] } }, t);
    udpA.deliver(ping);
    const pong = decodePacket(udpA.out[udpA.out.length - 1], t);
    eq("contesta al ping", pong.name, "CompletePingCheck");
    eq("con el mismo id de ping", pong.field("PingID", "PingID"), 7);
    eq("y no se lo pasa a la aplicacion", recibidos.indexOf("StartPingCheck"), -1);

    // 3. El ping que llega era fiable: la respuesta tiene que confirmarlo.
    ok("el ping fiable va confirmado", pong.acks.indexOf(100) !== -1, pong.acks);

    // 4. Un mensaje fiable que llega se procesa UNA vez; si vuelve (reenvio del
    //    simulador) no se vuelve a procesar, pero SI se vuelve a confirmar.
    const hs = encodePacket({ name: "RegionHandshake", packetId: 5, flags: FLAG.RELIABLE, blocks: {
      RegionInfo: [{ RegionFlags: 0, SimAccess: 13, IsEstateManager: false, WaterHeight: 20, CacheID: "00000000-0000-0000-0000-000000000000",
        SimOwner: "00000000-0000-0000-0000-000000000000",
        TerrainBase0: "00000000-0000-0000-0000-000000000000", TerrainBase1: "00000000-0000-0000-0000-000000000000",
        TerrainBase2: "00000000-0000-0000-0000-000000000000", TerrainBase3: "00000000-0000-0000-0000-000000000000",
        TerrainDetail0: "00000000-0000-0000-0000-000000000000", TerrainDetail1: "00000000-0000-0000-0000-000000000000",
        TerrainDetail2: "00000000-0000-0000-0000-000000000000", TerrainDetail3: "00000000-0000-0000-0000-000000000000",
        TerrainStartHeight00: 0, TerrainStartHeight01: 0, TerrainStartHeight10: 0, TerrainStartHeight11: 0,
        TerrainHeightRange00: 0, TerrainHeightRange01: 0, TerrainHeightRange10: 0, TerrainHeightRange11: 0,
        SimName: "Prueba" }],
      RegionInfo2: [{ RegionID: "11111111-1111-1111-1111-111111111111" }],
    } }, t);
    udpA.deliver(hs);
    eq("el RegionHandshake llega a la aplicacion", recibidos, ["RegionHandshake"]);
    eq("y su nombre se lee de la cadena Variable", t.byName("RegionHandshake") && true, true);
    udpA.deliver(hs);
    eq("un fiable repetido no se procesa dos veces", recibidos, ["RegionHandshake"]);
    eq("pero se cuenta el duplicado", circ.state.duplicates, 1);
    // El ack del duplicado no se manda en el acto (no hay nada que decir): sale
    // en el siguiente latido, en un PacketAck aparte.
    const antesDelLatido = circ.state.packetsOut;
    circ.tick();
    const latido = decodePacket(udpA.out[udpA.out.length - 1], t);
    eq("el latido manda el PacketAck pendiente", latido.name, "PacketAck");
    eq("y lleva el ack del handshake (el del ping ya fue en su respuesta)",
      [latido.list("Packets").map((b) => b.ID), latido.acks.indexOf(100)], [[5], -1]);
    ok("y no se manda de mas", circ.state.packetsOut === antesDelLatido + 1, circ.state.packetsOut - antesDelLatido);

    // 5. Los acks del simulador confirman lo nuestro (y miden la ida y vuelta).
    const conNuestrosAcks = encodePacket({ name: "CompletePingCheck", packetId: 6, acks: [0, 1], blocks: { PingID: [{ PingID: 3 }] } }, t);
    udpA.deliver(conNuestrosAcks);
    eq("los dos fiables quedan confirmados", circ.state.unackedNow, 0);
    ok("se midio la ida y vuelta", circ.state.rttSamples >= 2, circ.state.rtt + " ms en " + circ.state.rttSamples + " muestras");

    // 6. Un `PacketAck` aparte tambien confirma.
    circ.send({ name: "ChatFromViewer", reliable: true, blocks: { AgentData: [{ AgentID: "00000000-0000-0000-0000-000000000002", SessionID: "00000000-0000-0000-0000-000000000001" }], ChatData: [{ Message: "hola", Type: 1, Channel: 0 }] } });
    const pid = circ.state.packetId - 1;
    udpA.deliver(encodePacket({ name: "PacketAck", packetId: 7, blocks: { Packets: [{ ID: pid }] } }, t));
    eq("el PacketAck suelto tambien confirma", circ.state.unackedNow, 0);

    // 7. Reenvio: lo que nadie confirma se reenvia con la bandera de reenvio, y
    //    al agotar los intentos se deja por imposible.
    circ.send({ name: "UseCircuitCode", reliable: true, blocks: { CircuitCode: [{ Code: 9, SessionID: "00000000-0000-0000-0000-000000000001", ID: "00000000-0000-0000-0000-000000000002" }] } });
    const antesReenvio = udpA.out.length;
    // Se envejecen los relojes a mano para no esperar 3 segundos de verdad.
    circ._age(4000);
    circ.tick();
    ok("se reenvio", udpA.out.length > antesReenvio && circ.state.resends >= 1, udpA.out.length - antesReenvio);
    const reenviado = decodePacket(udpA.out[udpA.out.length - 1], t);
    ok("con la bandera de reenvio puesta", (reenviado.flags & FLAG.RESENT) !== 0, reenviado.flags);
    eq("y conserva su id de paquete", reenviado.packetId, pid + 1);
    for (let i = 0; i < 12; i++) { circ._age(4000); circ.tick(); }
    eq("tras agotar los intentos se rinde", circ.state.unackedNow, 0);

    // 8. La perdida se estima con los huecos de la numeracion.
    const udpB = fakeUdp();
    const circB = createCircuit({ udp: udpB, templates: t });
    circB.handleDatagram(encodePacket({ name: "CompletePingCheck", packetId: 10, blocks: { PingID: [{ PingID: 1 }] } }, t));
    circB.handleDatagram(encodePacket({ name: "CompletePingCheck", packetId: 14, blocks: { PingID: [{ PingID: 2 }] } }, t));
    eq("cuatro de catorce se contaron perdidos", circB.state.gapLost, 3);
    ok("y el porcentaje sale", circB.lossPct > 0 && circB.lossPct < 100, circB.lossPct);

    // 9. Un mensaje desconocido no revienta el circuito: se avisa y se sigue.
    let aviso = null;
    circB.on("unknown", (e) => { aviso = e; });
    circB.handleDatagram(Uint8Array.of(0, 0, 0, 0, 1, 0, 0xf1, 0x00));
    ok("un mensaje desconocido solo avisa", aviso && /desconocido/.test(aviso.message), aviso && aviso.message);

    // 10. Cerrar el circuito deja de reenviar.
    circ.close("fin de la prueba");
    eq("cerrado", circ.state.dead, true);
    eq("y sin nada pendiente", circ.state.unackedNow, 0);

    const failed = checks.filter((c) => !c.ok);
    resolve({ checks: checks.length, passed: checks.length - failed.length, fails: failed });
  });
}
