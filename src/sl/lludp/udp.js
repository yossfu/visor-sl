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
//   <- {"sendError":"sendto failed: EINVAL …","host":"1.2.3.4","port":9000,"localPort":51234}
//        el proceso local no pudo sacar ESE datagrama a la red. No es un fallo
//        del enlace (sigue abierto), es la salida a internet, y el visor lo
//        apunta para poder decirlo en su informe en vez de culpar al simulador.
//
// Y una orden de un solo uso, la sonda de red:
//
//   -> {"cmd":"probe","host":"stun.l.google.com","port":19302,"datos":[0,1,...]}
//   <- {"probe":{"ok":true,"ms":123,"local":"0.0.0.0:53100","familia":"IPv4",
//                "de":"1.2.3.4:19302","datos":[...]}}
//   <- {"probe":{"ok":false,"ms":2505,"local":"…","familia":"…","error":"…"}}
//        manda esos bytes a ese destino desde un socket UDP local y devuelve lo
//        primero que llegue. El visor le da una peticion STUN (`red.js`) para
//        averiguar si esta red deja salir UDP; el puente no entiende el
//        contenido, solo mueve bytes.
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
  // La sonda de red: manda bytes a un destino y devuelve lo primero que llegue.
  // Ver `probe()` y `red.js` (la peticion STUN que se le da).
  PROBE: "probe",
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
    // La familia del socket local que abrio el proceso nativo ("IPv4"/"IPv6").
    // Es el dato que decide si un simulador de Second Life puede contestar.
    familia: null,
    packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0,
    lastRecvAt: 0, lastSendAt: 0, closedAt: 0, opens: 0,
    // Fallos de ENVIO que avisa el proceso local ({"sendError":...}). Son otra
    // cosa que `error`: el enlace puede estar perfecto y aun asi no salir ni un
    // datagrama (un socket atado a la interfaz equivocada, por ejemplo). Sin
    // esto, el visor solo puede decir "mando paquetes y no vuelve nada", que es
    // exactamente lo que parece un puerto bloqueado.
    sendErrors: 0, lastSendError: null,
  };

  let socket = null;
  let handler = null;
  let esperandoConnect = null;    // {resolve, reject, timer}
  // Una sonda en vuelo: {resolve, reject, timer}. Como el puente nativo manda
  // la respuesta por la misma conexion, basta con una a la vez (y el visor solo
  // lanza una al arrancar y otra si el usuario pulsa el boton).
  let esperandoSonda = null;
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
    if (m.sendError) {
      // El proceso local no pudo meter el datagrama en la red. El enlace sigue
      // en pie (por eso NO se toca `link`): lo que falla es la salida a la red.
      st.sendErrors++;
      st.lastSendError = String(m.sendError) +
        (m.host ? " (" + m.host + ":" + m.port + " desde el puerto local " + (m.localPort || 0) + ")" : "");
      log("puente: no se pudo enviar el datagrama: " + st.lastSendError);
      emit("error", st.lastSendError);
      return;
    }
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
    if (m.probe) {
      // La respuesta de la sonda de red (ver `probe()`). Los bytes van en un
      // array de numeros 0..255 en JSON; se devuelven como Uint8Array.
      const pr = m.probe;
      const pend = esperandoSonda;
      esperandoSonda = null;
      const salida = Object.assign({}, pr, {
        ok: !!pr.ok,
        datos: (pr.datos || []).map((x) => x & 255),
        // El puerto local que uso la sonda (lo ultimo tras el ultimo ":", que
        // en IPv6 hay varios).
        localPort: String(pr.local || "").replace(/^.*:/, ""),
      });
      if (pend) {
        clearTimeout(pend.timer);
        if (pr.ok) pend.resolve(salida); else pend.reject(new Error(pr.error || "la sonda no recibio respuesta"));
      } else {
        log("puente: llego una sonda que nadie esperaba");
      }
      emit("probe", salida);
      return;
    }
    if (m.ok) {
      st.localPort = m.localPort || 0;
      if (m.familia) st.familia = String(m.familia);
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
        const pendSonda = esperandoSonda;
        esperandoSonda = null;
        if (pendSonda) { clearTimeout(pendSonda.timer); pendSonda.reject(new Error("el puente se cerro durante la sonda")); }
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
    /**
     * La sonda de red: manda `bytes` a `host:puerto` por un socket UDP del
     * proceso local y devuelve lo primero que llegue (o rechaza con el motivo).
     * Solo tiene sentido con un puente de verdad; el visor la usa para saber si
     * ESTE movil, en ESTA red, puede sacar un datagrama UDP y recibir la
     * respuesta. Devuelve `{ok, ms, local, familia, de, datos, localPort}`.
     */
    probe(host, port, bytes, opts = {}) {
      const limite = opts.timeout === undefined ? 5000 : opts.timeout;
      return new Promise((resolve, reject) => {
        if (!socket || socket.readyState !== 1) { reject(new Error("el puente no esta abierto")); return; }
        if (esperandoSonda) { reject(new Error("ya hay una sonda en vuelo")); return; }
        esperandoSonda = {
          resolve, reject,
          timer: setTimeout(() => {
            esperandoSonda = null;
            reject(new Error("la sonda no obtuvo respuesta en " + limite + " ms"));
          }, limite),
        };
        const datos = Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b & 255);
        try {
          socket.send(JSON.stringify({ cmd: BRIDGE_CMD.PROBE, host: host || "", port: port || 0, datos }));
        } catch (e) {
          const pend = esperandoSonda;
          esperandoSonda = null;
          if (pend) { clearTimeout(pend.timer); pend.reject(new Error("no se pudo pedir la sonda: " + (e && e.message ? e.message : e))); }
        }
      });
    },
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
      // Una sonda en vuelo se queda sin respuesta posible: se rechaza ya en vez
      // de dejar al visor esperando el tiempo limite.
      const pendSonda = esperandoSonda;
      esperandoSonda = null;
      if (pendSonda) { clearTimeout(pendSonda.timer); pendSonda.reject(new Error("el puente se cerro durante la sonda")); }
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
    // Cuantas sondas de red ha contestado el servidor de mentira: la segunda se
    // deja sin respuesta a proposito (para probar el tiempo limite).
    let sondasServidas = 0;
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
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
            setTimeout(() => { serverSocketHandler = true; this.emit("message", { data: JSON.stringify({ ok: true, localPort: 40000, familia: "IPv4" }) }); }, 0);
          } else if (m.cmd === "probe" && sondasServidas === 0) {
            // La sonda de red contestada como un STUN: devuelve la direccion de
            // origen. La segunda sonda se deja a proposito sin respuesta.
            sondasServidas++;
            setTimeout(() => {
              this.emit("message", {
                data: JSON.stringify({
                  probe: { ok: true, ms: 12, local: "0.0.0.0:53100", familia: "IPv4", de: "1.2.3.4:19302", datos: [1, 2, 255] },
                }),
              });
            }, 0);
          }
          return;
        }
        // Un datagrama del cliente: el servidor contesta con otro y ademas
        // avisa de que ese envio no pudo salir (lo que hace el puente nativo
        // cuando `sendto` falla). El visor tiene que enterarse de las dos cosas
        // sin que el aviso tumbe el enlace.
        setTimeout(() => {
          this.emit("message", { data: Uint8Array.of(0xaa, 0xbb).buffer });
          this.emit("message", {
            data: JSON.stringify({
              sendError: "sendto failed: EINVAL (Invalid argument)",
              host: "54.188.100.243", port: 13027, localPort: 40000,
            }),
          });
        }, 0);
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
    puente.connect("1.2.3.4", 9000).then(async (puerto) => {
      eq("puente: confirmado con su puerto local", puerto, 40000);
      ok("puente: listo", puente.ready, puente.state.link);
      eq("puente: se mando el connect", JSON.parse(servidor[0]), { cmd: "connect", host: "1.2.3.4", port: 9000 });
      ok("puente: el estado paso por abierto", estados.indexOf("open") >= 0, estados);
      eq("puente: apunta la familia del socket local", puente.state.familia, "IPv4");

      puente.send(Uint8Array.of(1, 2, 3, 4));
      eq("puente: el datagrama salio como bytes", Array.from(servidor[1]), [1, 2, 3, 4]);
      eq("puente: contador de salida", puente.state.packetsOut, 1);

      await espera(10);
      eq("puente: el datagrama de vuelta llego al circuito", recibidos, [[0xaa, 0xbb]]);
      eq("puente: contadores de entrada", [puente.state.packetsIn, puente.state.bytesIn], [1, 2]);
      ok("puente: se sabe cuando fue el ultimo paquete", puente.silentMs >= 0, puente.silentMs);

      // 3b. El aviso de que un envio no pudo salir: se apunta con su motivo y
      //     su destino, se distingue del estado del enlace y no lo tumba.
      eq("puente: se cuenta el fallo de envio", puente.state.sendErrors, 1);
      ok("puente: el fallo de envio guarda motivo y destino",
        /EINVAL/.test(puente.state.lastSendError || "") && /54\.188\.100\.243:13027/.test(puente.state.lastSendError || ""),
        puente.state.lastSendError);
      ok("puente: el enlace sigue en pie tras el fallo de envio", puente.ready, puente.state.link);

      // 3c. La sonda de red: pide su destino y sus bytes, y devuelve de vuelta
      //     lo que llegue, con la familia del socket que la saco.
      const sonda = puente.probe("stun.l.google.com", 19302, Uint8Array.of(0, 1, 0, 0));
      await espera(0);
      const orden = servidor.map((x) => (typeof x === "string" ? JSON.parse(x) : null)).filter((m) => m && m.cmd === "probe")[0];
      eq("puente: la sonda pide destino y bytes", orden && [orden.host, orden.port, orden.datos], ["stun.l.google.com", 19302, [0, 1, 0, 0]]);
      const r = await sonda;
      eq("puente: la sonda devuelve los bytes de vuelta", r.datos, [1, 2, 255]);
      eq("puente: la sonda dice ok, familia y puerto local", [r.ok, r.familia, r.localPort], [true, "IPv4", "53100"]);

      // 3d. Una sonda sin respuesta se rechaza con su motivo (no cuelga).
      let motivo = "";
      await puente.probe("nadie.example", 1, Uint8Array.of(0), { timeout: 30 }).then(
        () => { motivo = "(resolvio)"; },
        (e) => { motivo = e.message; },
      );
      ok("puente: una sonda sin respuesta se rechaza con motivo", /no obtuvo respuesta/.test(motivo), motivo);

      const cerrado = [];
      puente.on("close", (e) => cerrado.push(e.wasReady));
      puente.close();
      await espera(10);
      ok("puente: el cierre avisa de que estaba vivo", cerrado[0] === true, cerrado);
      ok("puente: queda sin enlace", !puente.ready, puente.state.link);

      // 4. Un puente a una direccion que no es WebSocket falla en el acto y
      //    con un motivo legible, no dejando la interfaz girando.
      const malo = openUdpBridge({ url: "http://ejemplo.com/udp", WebSocketClass: WSFalso, timeout: 100 });
      try {
        await malo.connect("1.1.1.1", 1);
        eq("puente: rechaza http", "resolvio", "un error");
      } catch (e) {
        ok("puente: rechaza http con motivo", /no es un WebSocket/.test(e.message), e.message);
      }
      terminar();
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
