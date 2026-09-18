// udp.js -- los transportes de datagramas del circuito LLUDP.
//
// El circuito (`circuit.js`) no sabe por donde salen sus bytes: solo pide un
// objeto con `send(u8)` y `setHandler(fn)`. Este modulo fabrica esos objetos,
// que es lo que permite desarrollar y probar el visor entero SIN un simulador y
// SIN un movil:
//
//   * `createLoopbackUdpPair()` -- dos extremos en el mismo hilo, con entrega
//     determinista. Es el transporte de los autotests y del simulador de
//     pruebas en JS (`sim.js`), y permite simular perdida, duplicados y
//     reordenacion sin tocar la red.
//   * `openUdpBridge(url)` -- el puente de verdad: un WebSocket a un proceso
//     local (en la app Android, `UdpBridgeServer.kt`) que abre un socket UDP
//     real y reenvia los datagramas. En el navegador NO hay sockets UDP, asi
//     que este es el unico camino posible hacia un simulador de Second Life.
//   * `createFakeUdp()` -- un doble de pruebas con lista de salida, para
//     comprobar byte a byte lo que manda el circuito.
//
// EL PROTOCOLO DEL PUENTE
// -----------------------
// Un WebSocket no lleva direcciones: el proceso local tiene que saber a que
// host y puerto mandar. Se resuelve con una primera trama de texto:
//
//   -> {"cmd":"connect","host":"1.2.3.4","port":9000}   (el simulador de destino)
//   -> {"cmd":"connect","host":"","port":0}             (cualquier origen: modo
//                                                        escucha, para teletransportes
//                                                        que traen un simulador nuevo)
//   <- {"ok":true,"localPort":51234}
//   <- {"error":"lo que haya pasado"}
//
// A partir de ahi, cada trama BINARIA es un datagrama entero, en los dos
// sentidos. Al cerrar se manda {"cmd":"close"}. Con esto el proceso local no
// tiene que entender LLUDP: es un simple relevador de bytes, y toda la
// inteligencia del protocolo se queda en JavaScript, donde se puede probar.

const noop = () => {};

// --- par de mentira -----------------------------------------------------------

// `opts.loss` (0..1), `opts.duplicate` (0..1) y `opts.reorder` (0..1) usan
// `Math.random`, que en Perchance se puede sustituir por uno con semilla (ver
// el comentario de la seccion de aleatoriedad en la documentacion de la
// plataforma), asi que las pruebas de red son reproducibles.
export function createLoopbackUdpPair(opts = {}) {
  const loss = opts.loss || 0;
  const duplicate = opts.duplicate || 0;
  const reorder = opts.reorder || 0;
  const rnd = opts.random || Math.random;

  const queue = [];          // datagramas en vuelo: {destino, bytes, orden}
  let order = 0;
  let closed = false;

  const st = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, reordered: 0, bytes: 0 };

  function mk(etiqueta) {
    const node = {
      etiqueta,
      handler: null,
      closed: false,
      setHandler(fn) { node.handler = fn; },
      send(u8) {
        if (closed || node.closed) return false;
        st.sent++;
        st.bytes += u8.length;
        const copia = u8.slice();
        if (loss > 0 && rnd() < loss) { st.dropped++; return true; }
        const peer = node.peer;
        if (!peer) return true;
        queue.push({ destino: peer, bytes: copia, orden: order++, rapido: rnd() >= reorder });
        if (duplicate > 0 && rnd() < duplicate) {
          st.duplicated++;
          queue.push({ destino: peer, bytes: copia, orden: order++, rapido: rnd() >= reorder });
        }
        if (opts.auto) flush();
        return true;
      },
      close() {
        node.closed = true;
      },
    };
    return node;
  }

  const a = mk("a");
  const b = mk("b");
  a.peer = b;
  b.peer = a;

  // Entrega lo que haya en vuelo, en orden de salida (salvo lo que se haya
  // marcado como "lento", que se queda para la siguiente vuelta). Es lo que da
  // determinismo: nada llega hasta que el test llama a `flush()`.
  function flush() {
    if (!queue.length) return 0;
    const rapidos = [];
    const lentos = [];
    for (const d of queue) (d.rapido ? rapidos : lentos).push(d);
    queue.length = 0;
    rapidos.sort((x, y) => x.orden - y.orden);
    lentos.sort((x, y) => x.orden - y.orden);
    if (lentos.length) {
      st.reordered++;
      // Los lentos de esta vuelta van despues: se quedan en cola para el
      // siguiente `flush()`, ya detras de los rapidos.
      for (const d of lentos) queue.push(d);
    }
    for (const d of rapidos) {
      if (!d.destino.handler || d.destino.closed) continue;
      st.delivered++;
      d.destino.handler(d.bytes);
    }
    return rapidos.length;
  }

  return {
    a, b, flush,
    get state() { return st; },
    get pending() { return queue.length; },
    setHandler(fn) { a.setHandler(fn); b.setHandler(fn); },
    close() { closed = true; a.close(); b.close(); },
  };
}

// --- doble de pruebas con lista de salida ------------------------------------
//
// Guarda todo lo que se manda y deja inyectar lo que llega, sin ninguna cola ni
// retardo. Es lo que usan los autotests del circuito.

export function createFakeUdp() {
  const out = [];
  const st = { in: 0, out: 0 };
  const node = {
    out,
    state: st,
    handler: null,
    send(u8) { out.push(u8.slice()); st.out++; },
    setHandler(fn) { node.handler = fn; },
    deliver(u8) { st.in++; if (node.handler) node.handler(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8)); },
    last() { return out.length ? out[out.length - 1] : null; },
    clear() { const n = out.length; out.length = 0; return n; },
  };
  return node;
}

// --- el puente a un socket UDP de verdad -------------------------------------

export const BRIDGE_CMD = {
  CONNECT: "connect",
  CLOSE: "close",
  STATUS: "status",
};

// `url` = ws://127.0.0.1:PUERTO (la app Android) o wss://... (un retransmisor
// propio). `opts.WebSocketClass` permite inyectar el WebSocket en las pruebas.
export function openUdpBridge(opts = {}) {
  const url = opts.url || "";
  const WS = opts.WebSocketClass || (typeof WebSocket !== "undefined" ? WebSocket : null);
  const log = opts.log || noop;
  const timeout = opts.timeout === undefined ? 6000 : opts.timeout;

  const listeners = { open: [], close: [], error: [], datagram: [], state: [] };
  const st = {
    link: "idle", ready: false, error: null,
    host: null, port: 0, localPort: 0,
    packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0,
    lastRecvAt: 0, lastSendAt: 0, closedAt: 0, opens: 0,
  };

  let socket = null;
  let handler = null;
  let esperandoConnect = null;    // {resolve, reject, timer}
  // Un cierre pedido por nosotros mismos tiene que poder decir si el puente
  // estaba vivo: para cuando llega el evento `close` de verdad, el enlace ya se
  // ha marcado como inactivo, asi que el dato se guarda antes.
  let cierreVoluntarioListo = false;

  function emit(type, a) { for (const fn of listeners[type] || []) { try { fn(a); } catch (e) { log("error en un escucha del puente: " + (e && e.message ? e.message : e)); } } }
  function setLink(link, error) {
    if (st.link === link && st.error === (error || null)) return;
    st.link = link;
    st.error = error || null;
    st.ready = link === "open";
    emit("state", { link, ready: st.ready, error: st.error, host: st.host, port: st.port });
  }

  function onMessage(ev) {
    const d = ev && ev.data;
    if (typeof d === "string") return onText(d);
    let u8 = null;
    if (d instanceof ArrayBuffer) u8 = new Uint8Array(d);
    else if (d && d.buffer instanceof ArrayBuffer) u8 = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    else return;
    st.packetsIn++;
    st.bytesIn += u8.length;
    st.lastRecvAt = now();
    emit("datagram", u8);
    if (handler) handler(u8);
  }

  function onText(text) {
    let m = null;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m) return;
    if (m.error) {
      const t = String(m.error);
      const pend = esperandoConnect;
      esperandoConnect = null;
      if (pend) { clearTimeout(pend.timer); pend.reject(new Error(t)); }
      st.error = t;
      setLink(socket ? "error" : "idle", t);
      emit("error", t);
      return;
    }
    if (m.status) { log("puente: " + m.status); return; }
    if (m.ok) {
      st.localPort = m.localPort || 0;
      const pend = esperandoConnect;
      esperandoConnect = null;
      if (pend) { clearTimeout(pend.timer); pend.resolve(st.localPort); }
      setLink("open", null);
    }
  }

  function now() { return (typeof performance !== "undefined" ? performance.now() : Date.now()); }

  function connect(host, port) {
    const p = new Promise((resolve, reject) => {
      if (!WS) { reject(new Error("no hay WebSocket en este entorno")); return; }
      if (!/^wss?:\/\//i.test(url)) { reject(new Error("la direccion del puente no es un WebSocket: " + (url || "(vacia)"))); return; }
      st.host = host || ""; st.port = port || 0;
      esperandoConnect = {
        resolve, reject,
        timer: setTimeout(() => {
          esperandoConnect = null;
          reject(new Error("el puente no confirmo la conexion en " + timeout + " ms"));
        }, timeout),
      };
      if (socket) { enviarConnect(); return; }
      try { socket = new WS(url); }
      catch (e) { esperandoConnect = null; clearTimeout(0); reject(new Error("no se pudo abrir el puente: " + (e && e.message ? e.message : e))); return; }
      try { socket.binaryType = "arraybuffer"; } catch (e) { /* da igual */ }
      st.opens++;
      socket.addEventListener("open", () => { emit("open", { url }); enviarConnect(); });
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", (ev) => {
        socket = null;
        const eraReady = cierreVoluntarioListo || st.ready;
        cierreVoluntarioListo = false;
        st.closedAt = now();
        setLink("idle", null);
        emit("close", { code: (ev && ev.code) || 0, reason: (ev && ev.reason) || "", wasReady: eraReady });
      });
      socket.addEventListener("error", () => {
        st.error = st.error || "fallo del puente";
        emit("error", st.error);
      });
    });
    return p;
  }

  function enviarConnect() {
    if (!socket || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify({ cmd: BRIDGE_CMD.CONNECT, host: st.host || "", port: st.port || 0 }));
    } catch (e) {
      const pend = esperandoConnect;
      esperandoConnect = null;
      if (pend) { clearTimeout(pend.timer); pend.reject(new Error("no se pudo pedir la conexion: " + (e && e.message ? e.message : e))); }
    }
  }

  const api = {
    get state() { return st; },
    get ready() { return st.ready; },
    get handler() { return handler; },
    setHandler(fn) { handler = fn; },
    on(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); return () => { const a = listeners[type]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }; },
    /**
     * Conecta el puente y deja claro a que simulador apunta. Devuelve una
     * promesa que se resuelve cuando el proceso local confirma su socket UDP
     * (con el numero de puerto local, que es util en el informe de depuracion).
     */
    connect,
    /** Reapunta el puente a otro simulador (un teletransporte cambia de IP). */
    reconnect(host, port) { return connect(host, port); },
    send(u8) {
      if (!socket || socket.readyState !== 1) return false;
      const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
      try { socket.send(bytes); } catch (e) { return false; }
      st.packetsOut++;
      st.bytesOut += bytes.length;
      st.lastSendAt = now();
      return true;
    },
    close() {
      cierreVoluntarioListo = st.ready;
      if (socket && socket.readyState === 1) {
        try { socket.send(JSON.stringify({ cmd: BRIDGE_CMD.CLOSE })); } catch (e) { /* da igual */ }
        try { socket.close(1000, "adios"); } catch (e) { /* ya cerrado */ }
      }
      socket = null;
      setLink("idle", null);
    },
    get silentMs() { return st.lastRecvAt ? now() - st.lastRecvAt : 0; },
  };

  if (opts.autoConnect) connect(opts.host, opts.port).catch((e) => { st.error = e.message; });
  return api;
}

// --- autotest -----------------------------------------------------------------

export function runUdpSelfTest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });

  // 1. El par de pruebas entrega en orden y solo cuando se pide.
  const par = createLoopbackUdpPair();
  const visto = [];
  par.b.setHandler((u8) => visto.push(Array.from(u8)));
  par.a.send(Uint8Array.of(1, 2, 3));
  par.a.send(Uint8Array.of(4, 5));
  eq("par: nada llega hasta flush", visto.length, 0);
  eq("par: hay dos en vuelo", par.pending, 2);
  par.flush();
  eq("par: llega todo, en orden", visto, [[1, 2, 3], [4, 5]]);
  eq("par: contadores", [par.state.sent, par.state.delivered, par.state.dropped], [2, 2, 0]);

  // 2. Lo que se manda es una COPIA: el emisor no puede cambiar el contenido en
  //    vuelo (si no, un buffer reutilizado corromperia los datagramas en cola).
  const par2 = createLoopbackUdpPair();
  const visto2 = [];
  par2.b.setHandler((u8) => visto2.push(u8[0]));
  const buf = Uint8Array.of(9, 9, 9);
  par2.a.send(buf);
  buf[0] = 1;
  par2.flush();
  eq("par: se copia al vuelo", visto2, [9]);

  // 3. El puente a un WebSocket: handshake, datagramas en los dos sentidos y
  //    aviso de error. Se usa un WebSocket de mentira en el mismo hilo.
  return new Promise((resolve) => {
    const servidor = [];
    let serverSocketHandler = null;
    class WSFalso {
      constructor(u) {
        this.url = u; this.readyState = 0; this.binaryType = "blob";
        this.listeners = {};
        setTimeout(() => { this.readyState = 1; this.emit("open", {}); }, 0);
      }
      addEventListener(t, fn) { (this.listeners[t] || (this.listeners[t] = [])).push(fn); }
      emit(t, ev) { for (const fn of (this.listeners[t] || []).slice()) fn(ev); }
      send(d) {
        if (this.readyState !== 1) throw new Error("cerrado");
        servidor.push(d);
        if (typeof d === "string") {
          const m = JSON.parse(d);
          if (m.cmd === "connect") {
            setTimeout(() => { serverSocketHandler = true; this.emit("message", { data: JSON.stringify({ ok: true, localPort: 40000 }) }); }, 0);
          }
          return;
        }
        // Un datagrama del cliente: el servidor contesta con otro.
        setTimeout(() => this.emit("message", { data: Uint8Array.of(0xaa, 0xbb).buffer }), 0);
        return;
      }
      close() { this.readyState = 3; setTimeout(() => this.emit("close", { code: 1000, reason: "adios" }), 0); }
    }

    const puente = openUdpBridge({ url: "ws://127.0.0.1:9999", WebSocketClass: WSFalso, timeout: 500 });
    const recibidos = [];
    const estados = [];
    puente.setHandler((u8) => recibidos.push(Array.from(u8)));
    puente.on("state", (s) => estados.push(s.link));

    ok("puente: todavia sin conectar", !puente.ready, puente.state.link);
    puente.connect("1.2.3.4", 9000).then((puerto) => {
      eq("puente: confirmado con su puerto local", puerto, 40000);
      ok("puente: listo", puente.ready, puente.state.link);
      eq("puente: se mando el connect", JSON.parse(servidor[0]), { cmd: "connect", host: "1.2.3.4", port: 9000 });
      ok("puente: el estado paso por abierto", estados.indexOf("open") >= 0, estados);

      puente.send(Uint8Array.of(1, 2, 3, 4));
      eq("puente: el datagrama salio como bytes", Array.from(servidor[1]), [1, 2, 3, 4]);
      eq("puente: contador de salida", puente.state.packetsOut, 1);

      setTimeout(() => {
        eq("puente: el datagrama de vuelta llego al circuito", recibidos, [[0xaa, 0xbb]]);
        eq("puente: contadores de entrada", [puente.state.packetsIn, puente.state.bytesIn], [1, 2]);
        ok("puente: se sabe cuando fue el ultimo paquete", puente.silentMs >= 0, puente.silentMs);

        const cerrado = [];
        puente.on("close", (e) => cerrado.push(e.wasReady));
        puente.close();
        setTimeout(() => {
          ok("puente: el cierre avisa de que estaba vivo", cerrado[0] === true, cerrado);
          ok("puente: queda sin enlace", !puente.ready, puente.state.link);

          // 4. Un puente a una direccion que no es WebSocket falla en el acto y
          //    con un motivo legible, no dejando la interfaz girando.
          const malo = openUdpBridge({ url: "http://ejemplo.com/udp", WebSocketClass: WSFalso, timeout: 100 });
          malo.connect("1.1.1.1", 1).then(
            () => { eq("puente: rechaza http", "resolvio", "un error"); terminar(); },
            (e) => { ok("puente: rechaza http con motivo", /no es un WebSocket/.test(e.message), e.message); terminar(); },
          );
        }, 10);
      }, 10);
    }, (e) => {
      checks.push({ name: "puente: no conecto", ok: false, got: e.message });
      terminar();
    });

    function terminar() {
      const failed = checks.filter((c) => !c.ok);
      resolve({ checks: checks.length, passed: checks.length - failed.length, fails: failed });
    }
  });
}
