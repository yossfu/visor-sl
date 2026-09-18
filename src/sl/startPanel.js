// startPanel.js -- la pantalla de inicio de sesion (#sl).
//
// Es lo primero que ve el usuario, y su trabajo es decir la verdad de un modo
// util: que este visor habla con un retransmisor (porque el navegador no puede
// abrir el socket UDP de Second Life), que el retransmisor puede estar en la
// maquina de uno mismo, y que mientras no haya ninguno se puede recorrer el
// simulador de pruebas para ver y manejar el visor completo.
//
// Tres formas de entrar:
//
//   1. "Entrar": el login lo hace ESTA pagina (src/sl/login.js) hablando
//      directamente con Linden Lab. Al retransmisor solo le llega el
//      identificador de sesion, que es lo unico que necesita para abrir el
//      circuito. La contrasena no sale del navegador.
//   2. "Entrar dejando el login al retransmisor": la contrasena va al
//      retransmisor que el usuario haya escrito. Util si el navegador no puede
//      llegar a los servidores de login de Linden Lab pero el retransmisor si.
//   3. "Simulador de pruebas": una region inventada, dentro de la propia
//      pagina. No es Second Life; sirve para ver el visor entero funcionando.
//
// Nada de esto se guarda en disco salvo el nombre, la cuadricula y la direccion
// del retransmisor.

import * as login from "./login.js";

const KV_FOLDER = "visor";
const KV_KEYS = { grid: "cuadricula", name: "nombre", relay: "retransmisor" };

let singleton = null;

function platformRoot() {
  try {
    if (typeof root !== "undefined" && root) return root;
  } catch (e) { /* fuera del motor */ }
  return window;
}

function kvFolder() {
  const rt = platformRoot();
  if (rt && rt.kv && rt.kv[KV_FOLDER]) return rt.kv[KV_FOLDER];
  if (rt && rt.kv && typeof rt.kv.subfolder === "function") return rt.kv.subfolder(KV_FOLDER);
  return null;
}

export function getStartPanel(opts = {}) {
  if (!singleton) singleton = create(opts);
  else if (opts.onEnter) singleton.setOnEnter(opts.onEnter);
  return singleton;
}

function create(opts) {
  const root_ = document.getElementById("startPanelCtn");
  const cardEl = document.getElementById("startPanel");
  const gridEl = document.getElementById("slGridEl");
  const nameEl = document.getElementById("slNameEl");
  const passEl = document.getElementById("slPassEl");
  const tokenEl = document.getElementById("slTokenEl");
  const relayEl = document.getElementById("slRelayEl");
  const relayNoteEl = document.getElementById("slRelayNoteEl");
  const noticeEl = document.getElementById("startNoticeEl");
  const logEl = document.getElementById("slLogEl");
  const statusEl = document.getElementById("slStatusEl");
  const spinnerEl = document.getElementById("slSpinnerEl");
  const enterLocalBtn = document.getElementById("slEnterLocalBtn");
  const enterRelayBtn = document.getElementById("slEnterRelayBtn");
  const mockBtn = document.getElementById("slMockBtn");
  const mockNoteEl = document.getElementById("slMockNoteEl");

  let onEnter = opts.onEnter || (() => {});
  let busy = false;

  // --- pintado --------------------------------------------------------------

  function log(text, cls) {
    if (!logEl || !text) return;
    const row = document.createElement("div");
    if (cls) row.className = cls;
    row.textContent = text;
    logEl.appendChild(row);
    while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function status(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function spin(on) {
    if (spinnerEl) spinnerEl.hidden = !on;
  }

  function setBusy(on) {
    busy = !!on;
    for (const b of [enterLocalBtn, enterRelayBtn, mockBtn]) {
      if (b) b.disabled = busy;
    }
    spin(busy);
  }

  function notice(text) {
    if (!noticeEl) return;
    noticeEl.hidden = !text;
    noticeEl.textContent = text || "";
  }

  function relayUrl() {
    return (relayEl && relayEl.value ? relayEl.value : "").trim();
  }

  // --- el puente UDP --------------------------------------------------------
  // Un navegador no puede abrir un socket UDP, y sin UDP no se puede hablar
  // LLUDP con un simulador de Second Life. El puente lo trae la app Android
  // (`?udp=ws://127.0.0.1:PUERTO`, el `UdpBridgeServer` nativo) o, para poder
  // recorrer el camino LLUDP entero sin movil, `?udp=sim`, que monta una region
  // de prueba en JavaScript con el MISMO protocolo. Sin puente, el visor
  // necesita un retransmisor (wss://) como antes.
  function puenteUdp() {
    let v = "";
    try { if (window.__SL_APP__ && window.__SL_APP__.udpUrl) v = window.__SL_APP__.udpUrl; } catch (e) { /* nada */ }
    if (!v) {
      try { v = new URLSearchParams(location.search || "").get("udp") || ""; } catch (e) { /* nada */ }
    }
    if (!v) { try { v = window.__visorPuente || ""; } catch (e) { /* nada */ } }
    v = String(v).trim();
    if (/^(sim|demo|prueba|1|si|true)$/i.test(v)) return "sim";
    return v;
  }

  function esPuenteWebSocket(v) {
    if (!/^wss?:\/\//i.test(v)) return false;
    if (/^ws:\/\//i.test(v) && location.protocol === "https:") return false;
    return true;
  }

  // Monta el retransmisor LLUDP local (`src/sl/lludp/gateway.js`). Se carga
  // aqui y no al arrancar porque `templates.js` son 68 KB de plantillas del
  // protocolo: quien no use el puente no paga por ellas.
  async function montarPuente(puente, credentials, session) {
    const mod = await import("./lludp/gateway.js");
    const opts = {
      credentials,
      regionName: (session && session.start && session.start.region) || "",
      onLog: (t) => log(t),
    };
    if (puente === "sim") {
      const simMod = await import("./lludp/sim.js");
      const sim = simMod.createRegionSim({ seed: (Date.now() >>> 0) % 100000, log: () => {} });
      sim.start();
      opts.udp = sim.pair.a;
      opts.sim = sim;
      opts.mock = true;
    } else {
      opts.udpUrl = puente;
    }
    return mod.createLldpRelay(opts);
  }

  function describeRelay() {
    const puente = puenteUdp();
    if (puente) {
      if (relayNoteEl) {
        relayNoteEl.textContent = puente === "sim"
          ? "Región LLUDP de prueba en JavaScript: el visor habla el protocolo de Second Life por el mismo camino que el mundo real, pero la región es simulada. No es Second Life."
          : "Puente UDP detectado (" + puente + "). No hace falta retransmisor: el visor abrirá el circuito UDP con el simulador de Second Life a través de él.";
      }
      return true;
    }
    const url = relayUrl();
    if (!url) {
      if (relayNoteEl) {
        relayNoteEl.textContent = "Sin direccion de retransmisor: no se puede entrar en el mundo real de Second Life. " +
          "Hay que ejecutar el retransmisor (el que habla UDP con el simulador) en algún servidor y escribir aquí su wss://. " +
          "Mientras tanto, el simulador de pruebas permite ver y manejar el visor entero.";
      }
      return false;
    }
    if (/^https?:/i.test(url)) {
      if (relayNoteEl) relayNoteEl.textContent = "Esa direccion es http(s), y el enlace del visor es un WebSocket: tiene que empezar por wss:// (o ws:// solo si esta pagina se sirve por http).";
      return false;
    }
    if (!/^wss?:\/\//i.test(url)) {
      if (relayNoteEl) relayNoteEl.textContent = "Esa direccion no es un WebSocket. Escribe algo como wss://tu-servidor:9443/visor.";
      return false;
    }
    if (/^ws:\/\//i.test(url) && location.protocol === "https:") {
      if (relayNoteEl) relayNoteEl.textContent = "Con ws:// el navegador bloquea el enlace desde una página https. Usa wss://.";
      return false;
    }
    if (relayNoteEl) relayNoteEl.textContent = "Se intentará abrir el enlace con " + url + ".";
    return true;
  }

  function persist() {
    const f = kvFolder();
    if (!f) return;
    try {
      f.set(KV_KEYS.grid, gridEl ? gridEl.value : "agni");
      f.set(KV_KEYS.name, nameEl ? nameEl.value.trim() : "");
      f.set(KV_KEYS.relay, relayUrl());
    } catch (e) { /* sin almacenamiento */ }
  }

  // --- credenciales ---------------------------------------------------------

  function readForm() {
    const name = (nameEl && nameEl.value ? nameEl.value : "").trim();
    const password = passEl ? passEl.value : "";
    const token = tokenEl && tokenEl.value ? tokenEl.value.trim() : "";
    const grid = gridEl ? gridEl.value : "agni";
    if (!name) { log("Escribe tu nombre de Second Life.", "err"); status("Falta el nombre."); nameEl && nameEl.focus(); return null; }
    if (!password) { log("Escribe tu contrasena.", "err"); status("Falta la contrasena."); passEl && passEl.focus(); return null; }
    persist();
    return { grid, name, password, token, start: "last" };
  }

  function reset() {
    if (logEl) logEl.textContent = "";
    status("Sin sesión.");
    notice("");
    setBusy(false);
    describeRelay();
  }

  function fail(result) {
    setBusy(false);
    const title = (result && result.title) || "No se pudo iniciar sesion";
    const hint = (result && result.hint) || "";
    const detalle = (result && result.message) || "";
    log(title + (hint ? " — " + hint : ""), "err");
    if (detalle) log(detalle, "err");
    status(title);
    // El detalle tambien va a la vista (y no solo al registro): en el movil el
    // registro no se lee comodo, y sin el, un "Failed to fetch" no explica nada.
    notice(title + (hint ? " " + hint : "") + (detalle ? " — " + detalle : ""));
  }

  // Comprueba que hay retransmisor antes de gastar un login. Devuelve false si
  // el usuario decide seguir sin el.
  function requireRelay() {
    const url = relayUrl();
    if (describeRelay()) return true;
    notice(url
      ? "Esa dirección no sirve como enlace: el visor habla por WebSocket, así que tiene que empezar por wss:// (o ws:// si la página se sirve por http). Corrige el campo «Retransmisor» o usa el simulador de pruebas."
      : "Falta la dirección del retransmisor. Sin él no hay forma de abrir el circuito UDP con un simulador de Second Life " +
        "desde el navegador. Escribe una wss:// válida en «Retransmisor», o usa el simulador de pruebas para ver el visor funcionando.");
    log(url ? "La direccion no es un WebSocket valido: no se puede entrar en Second Life." : "No hay direccion de retransmisor: no se puede entrar en Second Life.", "warn");
    status(url ? "Retransmisor inválido." : "Falta el retransmisor.");
    return false;
  }

  // --- los tres caminos -----------------------------------------------------

  async function enterLocal() {
    if (busy) return;
    const form = readForm();
    if (!form) return;
    const puente = puenteUdp();
    if (!puente && !requireRelay()) return;
    if (puente && puente !== "sim" && !esPuenteWebSocket(puente)) {
      fail({ title: "El puente UDP no sirve",
        hint: "Tiene que ser ws://… (el puente de la app Android) o «sim» (región LLUDP de prueba en JavaScript).",
        message: puente });
      return;
    }
    setBusy(true);
    notice("");
    log("Iniciando sesion con " + (login.GRIDS[form.grid] ? login.GRIDS[form.grid].name : form.grid) + "…");
    status("Contactando con Linden Lab…");
    const rt = platformRoot();
    const fetchImpl = rt && rt.superFetch ? rt.superFetch : null;
    if (!fetchImpl) {
      setBusy(false);
      fail({ title: "No hay forma de hacer la petición de login", hint: "El plugin super-fetch no está disponible en esta página." });
      return;
    }
    let result = null;
    try {
      result = await login.login(form, {
        fetch: fetchImpl,
        onStatus: (t) => { log(t); status(t); },
      });
    } catch (e) {
      setBusy(false);
      fail({ title: "Fallo al iniciar sesion", message: String((e && e.message) || e) });
      return;
    }
    if (!result || !result.ok) { fail(result); return; }
    const s = result.session;
    log("Sesion abierta: " + s.displayName + " (" + s.agentId + ")", "ok");
    if (s.start && s.start.region) log("Region de destino: " + s.start.region);
    log("La contrasena se queda aqui: al retransmisor solo le llega el identificador de sesion.", "ok");
    status("Sesión iniciada. Abriendo la región…");
    setBusy(false);
    const credentials = login.relayCredentials(s);
    credentials.displayName = s.displayName;
    credentials.start = form.start;

    // Con puente UDP no hay retransmisor externo: el propio visor monta el
    // circuito LLUDP (gateway.js) y le cuelga el puente.
    if (puente) {
      status("Preparando el circuito LLUDP…");
      log(puente === "sim"
        ? "Puente UDP: región LLUDP simulada en JavaScript (no es Second Life)."
        : "Puente UDP: " + puente + ". El circuito UDP lo abrirá la app.");
      let lldp = null;
      try {
        lldp = await montarPuente(puente, credentials, s);
      } catch (e) {
        fail({ title: "No se pudo preparar el circuito LLUDP", message: String((e && e.message) || e) });
        return;
      }
      setBusy(false);
      onEnter({
        mode: "lldp",
        relay: { url: lldp.url, socketFactory: lldp.socketFactory },
        lldp,
        credentials,
        displayName: s.displayName,
        grid: s.grid,
      });
      return;
    }

    onEnter({
      mode: "session",
      relay: { url: relayUrl() },
      credentials,
      displayName: s.displayName,
      grid: s.grid,
    });
  }

  function enterViaRelay() {
    if (busy) return;
    const form = readForm();
    if (!form) return;
    if (!requireRelay()) return;
    notice("");
    log("Se enviaran las credenciales al retransmisor " + relayUrl() + ".", "warn");
    log("Ese servidor hara el login con Linden Lab y abrira el circuito UDP; el visor solo recibe la region.");
    status("Enviando las credenciales al retransmisor…");
    onEnter({
      mode: "credentials",
      relay: { url: relayUrl() },
      credentials: {
        grid: form.grid, name: form.name, password: form.password,
        token: form.token, start: form.start,
      },
      displayName: form.name,
      grid: form.grid,
    });
  }

  function enterMock() {
    if (busy) return;
    notice("");
    log("Abriendo el simulador de pruebas: region inventada, servida desde esta misma pagina.", "ok");
    log("No es Second Life, pero el terreno, los prims, los residentes, el chat y el toque funcionan igual.", "ok");
    onEnter({ mode: "mock", relay: null, credentials: null, displayName: "Visitante", grid: "mock" });
  }

  // --- enlaces --------------------------------------------------------------

  if (enterLocalBtn) enterLocalBtn.addEventListener("click", () => { enterLocal(); });
  if (enterRelayBtn) enterRelayBtn.addEventListener("click", enterViaRelay);
  if (mockBtn) mockBtn.addEventListener("click", enterMock);
  if (relayEl) relayEl.addEventListener("change", () => { persist(); describeRelay(); });
  if (nameEl) nameEl.addEventListener("change", persist);
  if (gridEl) gridEl.addEventListener("change", persist);
  if (passEl) passEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); enterLocal(); } });
  if (tokenEl) tokenEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); enterLocal(); } });
  if (nameEl) nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (passEl) passEl.focus(); } });
  if (cardEl) cardEl.addEventListener("keydown", (e) => e.stopPropagation());

  // --- carga de lo guardado -------------------------------------------------

  async function load() {
    const f = kvFolder();
    if (f) {
      try {
        const grid = await f.get(KV_KEYS.grid);
        if (grid && gridEl) gridEl.value = grid;
        const name = await f.get(KV_KEYS.name);
        if (name && nameEl) nameEl.value = name;
        const relay = await f.get(KV_KEYS.relay);
        if (relay && relayEl) relayEl.value = relay;
      } catch (e) { /* primera vez */ }
    }
    describeRelay();
    if (!relayUrl()) {
      notice("Este visor necesita un retransmisor para entrar en el mundo real de Second Life: el navegador no puede abrir " +
        "el socket UDP de un simulador. Con el simulador de pruebas puedes ver el visor entero ahora mismo.");
    }
  }

  function show(result) {
    if (root_) root_.hidden = false;
    document.body.classList.add("start");
    reset();
    if (result && result.text) {
      log(result.text, result.cls || "warn");
      if (result.notice) notice(result.notice);
    }
    load();
  }

  function hide() {
    if (root_) root_.hidden = true;
    document.body.classList.remove("start");
  }

  function setOnEnter(fn) { if (fn) onEnter = fn; }

  if (mockNoteEl) mockNoteEl.hidden = false;

  return { show, hide, log, status, reset, setOnEnter, describeRelay, get busy() { return busy; }, setBusy };
}
