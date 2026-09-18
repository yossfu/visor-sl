// diag.js -- DEPURACION E INFORMES del visor.
//
// El problema que resuelve: la app se compila en un APK (o se abre en el
// navegador del movil), se prueba donde no hay consola a mano, y cuando algo
// falla lo unico que queda es «no va». Este modulo guarda TODO lo que pasa en
// un anillo de mensajes, resume el estado del visor cuando se lo piden, y
// escribe un INFORME de texto que se puede guardar como fichero, compartir o
// copiar, para traerlo de vuelta y diagnosticar el problema.
//
// Piezas:
//   - `diag.error/aviso/info/detalle(categoria, texto, datos)` -- anotar.
//   - `diag.registerState(nombre, fn)` -- que se sepa describir un subsistema
//     (sesion, red, avatar...) para que el informe lleve una foto del estado.
//   - `diag.report()` -- el informe en texto plano.
//   - `diag.save()` -- guardarlo (fichero nativo en Android, descarga en web).
//   - `diag.install()` -- empezar a capturar errores y avisos de consola.
//   - `diag.panel()` -- la ventana de depuracion de la interfaz (nivel,
//     categorias, registro en vivo, y los botones de informe).
//
// En Android el informe se escribe por el puente `window.VisorDiag`
// (MainActivity.kt): `info()`, `saveReport(nombre, texto)` y
// `shareReport(nombre, texto)`. Si no hay puente, se descarga el fichero.

export const DIAG_VERSION = "1.2";

// Niveles, de mas grave a mas hablado. El nivel activo es un umbral: con
// «aviso» (1) se guardan errores y avisos, y se tira el resto.
export const LEVELS = [
  { key: "error", value: 0, label: "Error", short: "ERR", cls: "dgErr" },
  { key: "aviso", value: 1, label: "Aviso", short: "AVI", cls: "dgWarn" },
  { key: "info", value: 2, label: "Info", short: "INF", cls: "dgInfo" },
  { key: "detalle", value: 3, label: "Detalle", short: "DET", cls: "dgTr" },
];

// Categorias. Cortas a proposito: caben en una linea de informe y se pueden
// filtrar con casillas.
export const CATEGORIES = [
  { key: "app", label: "Arranque" },
  { key: "red", label: "Red y relé" },
  { key: "sesion", label: "Sesión" },
  { key: "asset", label: "Recursos" },
  { key: "mundo", label: "Mundo" },
  { key: "apariencia", label: "Apariencia" },
  { key: "forma", label: "Forma y Bento" },
  { key: "anim", label: "Animación" },
  { key: "lsl", label: "Scripts LSL" },
  { key: "gl", label: "Gráficos" },
  { key: "ui", label: "Interfaz" },
  { key: "error", label: "Errores" },
];

const MAX_ENTRIES = 4000;      // anillo: a partir de aqui se tira lo mas viejo
const DEDUPE_WINDOW_MS = 4000; // dos lineas iguales seguidas se cuentan, no se repiten

const CAT_KEYS = new Set(CATEGORIES.map((c) => c.key));

function pad2(n) { return String(n).padStart(2, "0"); }
function pad3(n) { return String(n).padStart(3, "0"); }

function stamp(ms) {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) + "." + pad3(d.getMilliseconds());
}

function levelOf(key) {
  for (const l of LEVELS) if (l.key === key) return l;
  return LEVELS[2];
}

function shortText(v, max = 240) {
  let s;
  if (v === null || v === undefined) s = String(v);
  else if (typeof v === "string") s = v;
  else if (v instanceof Error) s = v.name + ": " + v.message;
  else { try { s = JSON.stringify(v); } catch (e) { s = String(v); } }
  if (s.length > max) s = s.slice(0, max) + "…(" + (s.length - max) + " más)";
  return s;
}

export function createDiag(opts = {}) {
  const name = opts.name || "visor-sl";
  const startedAt = Date.now();
  const levelKey = opts.level || "info";

  const entries = [];            // {ms, level, cat, text, data, count, session}
  const counters = new Map();    // clave -> {level, cat, count, firstMs, lastMs, text}
  const states = new Map();      // nombre -> fn
  const listeners = new Set();   // fn(entry) / fn()
  const consoleHooked = { error: false, warn: false };
  let levelValue = levelOf(levelKey).value;
  let paused = false;
  let maxEntries = opts.maxEntries || MAX_ENTRIES;
  let _env = null;
  let _envFull = null;
  let _installed = false;
  let _bridgeChecked = false;
  let _bridge = null;
  let _sessionKey = opts.session || "s1";
  const _onceKeys = new Set();

  // --- puente nativo (Android) -----------------------------------------------
  // El APK expone `window.VisorDiag` (MainActivity.kt, @JavascriptInterface).
  // Es OPCIONAL: todo funciona igual sin el (descarga/copia).
  function bridge() {
    if (_bridgeChecked) return _bridge;
    _bridgeChecked = true;
    _bridge = (typeof window !== "undefined" && window.VisorDiag && typeof window.VisorDiag.saveReport === "function")
      ? window.VisorDiag : null;
    return _bridge;
  }

  function nativeInfo() {
    const b = bridge();
    if (!b || typeof b.info !== "function") return null;
    try { return JSON.parse(b.info() || "null"); } catch (e) { return { error: shortText(e) }; }
  }

  // --- anillo de mensajes ----------------------------------------------------

  function entry(levelKey, cat, text, data) {
    const l = levelOf(levelKey);
    if (l.value > levelValue) return null;
    if (paused) return null;
    const key = (CAT_KEYS.has(cat) ? cat : "app") + "|" + l.key + "|" + text;
    const now = Date.now();
    const last = entries[entries.length - 1];
    // La misma linea repetida (un error por fotograma, por ejemplo) no llena el
    // anillo: se cuenta.
    if (last && last.key === key && now - last.ms < DEDUPE_WINDOW_MS) {
      last.count++;
      last.ms = now;
      const c = counters.get(key);
      if (c) { c.count++; c.lastMs = now; }
      notify(last);
      return last;
    }
    const e = { ms: now, level: l.key, levelValue: l.value, cat: CAT_KEYS.has(cat) ? cat : "app", text, data, count: 1, key, session: _sessionKey };
    entries.push(e);
    const c = counters.get(key);
    if (c) { c.count++; c.lastMs = now; }
    else counters.set(key, { level: l.key, cat: e.cat, count: 1, firstMs: now, lastMs: now, text });
    if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
    notify(e);
    return e;
  }

  function notify(e) {
    for (const fn of listeners) {
      try { fn(e); } catch (err) { /* la depuracion nunca puede romper la app */ }
    }
  }

  // --- API de anotacion ------------------------------------------------------

  const diag = {
    name,
    version: DIAG_VERSION,

    get entries() { return entries; },
    get level() { return LEVELS.find((l) => l.value === levelValue) || LEVELS[2]; },
    get startedAt() { return startedAt; },

    error(cat, text, data) { return entry("error", cat, text, data); },
    aviso(cat, text, data) { return entry("aviso", cat, text, data); },
    info(cat, text, data) { return entry("info", cat, text, data); },
    detalle(cat, text, data) { return entry("detalle", cat, text, data); },

    // Alias en ingles, por si el codigo que anota viene de fuera.
    warn(cat, text, data) { return entry("aviso", cat, text, data); },
    log(cat, text, data) { return entry("info", cat, text, data); },
    debug(cat, text, data) { return entry("detalle", cat, text, data); },

    // Solo la primera vez con esa clave (para no repetir avisos de arranque).
    once(key, levelKey_, cat, text, data) {
      if (_onceKeys.has(key)) return null;
      _onceKeys.add(key);
      return entry(levelKey_, cat, text, data);
    },

    setLevel(key) {
      const l = levelOf(key);
      levelValue = l.value;
      entry("info", "ui", "nivel de depuración: " + l.label);
      return diag;
    },

    clear() {
      entries.length = 0;
      counters.clear();
      notify(null);
      return diag;
    },

    pause(v = true) { paused = !!v; return diag; },
    get paused() { return paused; },

    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    // Un subsistema se apunta aqui para que el informe lleve su estado actual.
    registerState(nombre, fn) { states.set(nombre, fn); return diag; },

    // --- entorno -------------------------------------------------------------

    // Lo justo para un informe corto (sin pedir un contexto WebGL).
    env() {
      if (_env) return _env;
      const n = navigator || {};
      const s = (typeof screen !== "undefined" && screen) || {};
      _env = {
        pagina: (typeof window !== "undefined" && window.generatorName) || n.title || "?",
        idPublico: (typeof window !== "undefined" && window.generatorPublicId) || null,
        url: (typeof location !== "undefined" && location.href) || null,
        agente: (n.userAgent || "").slice(0, 220),
        plataforma: n.platform || null,
        idioma: n.language || null,
        zona: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; } })(),
        nucleos: n.hardwareConcurrency || null,
        memoriaGB: n.deviceMemory || null,
        pantalla: s.width ? s.width + "x" + s.height + " @" + (window.devicePixelRatio || 1) + "x" : null,
        ventana: (typeof window !== "undefined") ? window.innerWidth + "x" + window.innerHeight : null,
        tactil: (n.maxTouchPoints || 0),
        despierto: (typeof document !== "undefined") ? document.visibilityState : null,
        enLinea: n.onLine === undefined ? null : !!n.onLine,
        conexion: (() => {
          const c = n.connection || n.mozConnection || n.webkitConnection;
          return c ? [c.effectiveType, c.downlink ? c.downlink + "Mbps" : null, c.rtt ? c.rtt + "ms" : null].filter(Boolean).join(" ") : null;
        })(),
        servicioWebWorker: (typeof navigator !== "undefined" && "serviceWorker" in navigator),
        nativo: nativeInfo(),
      };
      return _env;
    },

    // El entorno completo, con lo que solo se puede saber con un contexto
    // WebGL (se crea uno de usar y tirar: no cuesta casi nada).
    envFull() {
      if (_envFull) return _envFull;
      const e = { ...diag.env() };
      try {
        const cv = document.createElement("canvas");
        const gl = cv.getContext("webgl2") || cv.getContext("webgl") || cv.getContext("experimental-webgl");
        if (gl) {
          const dbg = gl.getExtension("WEBGL_debug_renderer_info");
          const par = (p) => { try { return gl.getParameter(p); } catch (err) { return null; } };
          e.gl = {
            api: gl instanceof WebGL2RenderingContext ? "WebGL2" : "WebGL1",
            proveedor: dbg ? par(dbg.UNMASKED_VENDOR_WEBGL) : par(gl.VENDOR),
            tarjeta: dbg ? par(dbg.UNMASKED_RENDERER_WEBGL) : par(gl.RENDERER),
            version: par(gl.VERSION),
            glsl: par(gl.SHADING_LANGUAGE_VERSION),
            maxTextura: par(gl.MAX_TEXTURE_SIZE),
            maxVerticesAtrib: par(gl.MAX_VERTEX_ATTRIBS),
            maxTexturasUnidad: par(gl.MAX_TEXTURE_IMAGE_UNITS),
            maxHuesos: par(gl.MAX_VERTEX_UNIFORM_VECTORS),
            maxMuestras: par(gl.MAX_SAMPLES),
            perdidas: gl.isContextLost ? gl.isContextLost() : null,
          };
          if (gl.getExtension("WEBGL_lose_context")) { try { gl.getExtension("WEBGL_lose_context").loseContext(); } catch (err) { /* noop */ } }
        } else {
          e.gl = { error: "no hay contexto WebGL" };
        }
      } catch (err) { e.gl = { error: shortText(err) }; }
      _envFull = e;
      return e;
    },

    // --- informe -------------------------------------------------------------

    // Foto del estado ahora mismo: lo que los subsistemas sepan decir de si.
    stateSnapshot() {
      const out = {};
      for (const [nombre, fn] of states) {
        try {
          const v = fn();
          out[nombre] = v === undefined || v === null ? null : v;
        } catch (e) { out[nombre] = "«" + nombre + "» falló: " + shortText(e); }
      }
      return out;
    },

    json() {
      return {
        informe: { nombre: name, version: DIAG_VERSION, generado: new Date().toISOString(), arranque: new Date(startedAt).toISOString(), segundos: Math.round((Date.now() - startedAt) / 1000), nivel: diag.level.key },
        entorno: diag.envFull(),
        estado: diag.stateSnapshot(),
        contadores: [...counters.values()].sort((a, b) => b.count - a.count).map((c) => ({ nivel: c.level, categoria: c.cat, veces: c.count, texto: c.text })),
        registro: entries.map((e) => ({ t: stamp(e.ms), nivel: e.level, categoria: e.cat, veces: e.count, texto: e.text, datos: e.data === undefined ? null : shortText(e.data, 400) })),
      };
    },

    // El informe de texto: pensado para pegarlo en un chat o mandarlo por
    // correo. Cabecera -> entorno y estado -> contadores -> registro.
    report(o = {}) {
      const L = [];
      const env = o.full ? diag.envFull() : diag.env();
      const seg = Math.round((Date.now() - startedAt) / 1000);
      const mins = Math.floor(seg / 60);
      L.push("INFORME DEL VISOR DE SECOND LIFE");
      L.push("generado: " + new Date().toISOString() + " · abierto hace " + (mins ? mins + " min " : "") + (seg % 60) + " s");
      L.push("página: " + env.pagina + (env.idPublico ? " (" + env.idPublico.slice(0, 8) + ")" : "") + " · nivel: " + diag.level.label);
      L.push("");
      L.push("=== ENTORNO ===");
      for (const k of ["agente", "plataforma", "idioma", "zona", "pantalla", "ventana", "nucleos", "memoriaGB", "tactil", "conexion", "enLinea", "url"]) {
        if (env[k] !== null && env[k] !== undefined && env[k] !== "") L.push("  " + k + ": " + env[k]);
      }
      if (env.nativo) {
        L.push("  app nativa: " + (env.nativo.app || "?") + " · android " + (env.nativo.android || "?") + " · sdk " + (env.nativo.sdk || "?"));
        L.push("  dispositivo: " + (env.nativo.modelo || "?") + " · " + (env.nativo.fabricante || "?"));
        if (env.nativo.pantalla) L.push("  pantalla nativa: " + env.nativo.pantalla);
        if (env.nativo.informes) L.push("  carpeta de informes: " + env.nativo.informes);
        if (env.nativo.registro) {
          L.push("  registro nativo (últimas líneas):");
          for (const linea of String(env.nativo.registro).split("\n")) L.push("    " + linea);
        }
      } else {
        L.push("  app nativa: no (navegador)");
      }
      if (env.gl) {
        if (env.gl.error) L.push("  WebGL: " + env.gl.error);
        else L.push("  WebGL: " + env.gl.api + " · " + glLine(env.gl));
      }
      L.push("");
      const st = diag.stateSnapshot();
      const stKeys = Object.keys(st);
      if (stKeys.length) {
        L.push("=== ESTADO AHORA ===");
        for (const k of stKeys) {
          const v = st[k];
          if (v && typeof v === "object") {
            L.push("  " + k + ":");
            for (const kk in v) L.push("    " + kk + ": " + shortText(v[kk], 300));
          } else {
            L.push("  " + k + ": " + shortText(v, 300));
          }
        }
        L.push("");
      }
      const conts = [...counters.values()].sort((a, b) => b.count - a.count);
      if (conts.length) {
        L.push("=== RESUMEN (mensajes agrupados) ===");
        const byCat = new Map();
        for (const c of conts) byCat.set(c.cat, (byCat.get(c.cat) || 0) + c.count);
        L.push("  por categoría: " + [...byCat.entries()].map(([c, n]) => c + "=" + n).join(", "));
        for (const c of conts.slice(0, o.top || 24)) {
          L.push("  [" + c.level + "] " + c.cat + " ×" + c.count + ": " + shortText(c.text, 200));
        }
        L.push("");
      }
      const tail = o.tail === undefined ? entries.length : o.tail;
      const lines = tail > 0 ? entries.slice(-tail) : [];
      L.push("=== REGISTRO (" + lines.length + " de " + entries.length + ") ===");
      for (const e of lines) {
        L.push("  " + stamp(e.ms) + " " + levelOf(e.level).short + " " + e.cat.padEnd(10)
          + (e.count > 1 ? "×" + e.count + " " : "") + e.text
          + (e.data !== undefined ? " | " + shortText(e.data, 240) : ""));
      }
      if (!lines.length) L.push("  (vacío)");
      L.push("");
      L.push("FIN DEL INFORME · " + name + " v" + DIAG_VERSION);
      return L.join("\n");
    },

    // --- guardar / compartir -------------------------------------------------

    fileName(ext = "txt") {
      const d = new Date();
      const s = (n) => pad2(n);
      return name + "-informe-" + d.getFullYear() + s(d.getMonth() + 1) + s(d.getDate())
        + "-" + s(d.getHours()) + s(d.getMinutes()) + s(d.getSeconds()) + "." + ext;
    },

    // Guarda el informe. Devuelve `{ ok, via, ruta|nombre, error }`.
    save(o = {}) {
      const texto = o.text || diag.report(o);
      const fichero = o.fileName || diag.fileName("txt");
      const b = bridge();
      if (b && typeof b.saveReport === "function") {
        try {
          const r = b.saveReport(fichero, texto);
          diag.info("ui", "informe guardado por la app nativa", fichero);
          return { ok: true, via: "nativo", ruta: r || null, fileName: fichero, texto };
        } catch (e) {
          diag.aviso("ui", "la app nativa no pudo guardar el informe: " + shortText(e));
        }
      }
      if (typeof document === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
        return { ok: false, via: "ninguna", error: "sin forma de guardar", texto };
      }
      try {
        const blob = new Blob([texto], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fichero;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
        diag.info("ui", "informe descargado", fichero);
        return { ok: true, via: "descarga", fileName: fichero, texto };
      } catch (e) {
        return { ok: false, via: "descarga", error: shortText(e), texto };
      }
    },

    // Comparte el informe (hoja de compartir de Android; en web, copia).
    async share(o = {}) {
      const texto = o.text || diag.report(o);
      const fichero = o.fileName || diag.fileName("txt");
      const b = bridge();
      if (b && typeof b.shareReport === "function") {
        try { b.shareReport(fichero, texto); return { ok: true, via: "nativo" }; } catch (e) { /* se intenta lo demas */ }
      }
      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share({ title: "Informe del visor", text: texto });
          return { ok: true, via: "compartir" };
        } catch (e) { /* el usuario cancelo o no se puede */ }
      }
      const copiado = await diag.copy(texto);
      return { ok: copiado, via: "portapapeles" };
    },

    async copy(texto) {
      const t = texto === undefined ? diag.report() : texto;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(t);
          return true;
        }
      } catch (e) { /* sigue el metodo clasico */ }
      try {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed"; ta.style.left = "-2000px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand("copy");
        ta.remove();
        return !!ok;
      } catch (e) { return false; }
    },

    // --- captura automatica --------------------------------------------------

    // Empieza a escuchar: errores sin capturar, promesas rechazadas y los
    // `console.error/warn` de todo el visor. Es idempotente.
    install(o = {}) {
      if (_installed) return diag;
      _installed = true;
      if (o.console !== false && typeof console !== "undefined") {
        const wrap = (metodo, nivel) => {
          const orig = console[metodo];
          if (typeof orig !== "function" || consoleHooked[metodo]) return;
          consoleHooked[metodo] = true;
          console[metodo] = function (...args) {
            try {
              const texto = args.map((a) => (typeof a === "string" ? a : shortText(a, 160))).join(" ");
              // No se registra el propio registro (evita bucles).
              if (!/^\[diag\]/.test(texto)) entry(nivel, nivel === "error" ? "error" : "app", "consola: " + texto);
            } catch (e) { /* noop */ }
            return orig.apply(console, args);
          };
        };
        wrap("error", "error");
        wrap("warn", "aviso");
      }
      if (typeof window !== "undefined") {
        window.addEventListener("error", (ev) => {
          if (ev && ev.message !== undefined) {
            const donde = (ev.filename || "") ? (String(ev.filename).split("/").pop() + ":" + ev.lineno + ":" + ev.colno) : "";
            entry("error", "error", "sin capturar: " + (ev.message || "error") + (donde ? " @ " + donde : ""),
              ev.error && ev.error.stack ? String(ev.error.stack).split("\n").slice(0, 4).join(" ⏎ ") : undefined);
          }
        });
        window.addEventListener("unhandledrejection", (ev) => {
          const r = ev && ev.reason;
          entry("error", "error", "promesa rechazada: " + shortText(r),
            r && r.stack ? String(r.stack).split("\n").slice(0, 4).join(" ⏎ ") : undefined);
        });
        if (!window.visorDiag) window.visorDiag = diag;
      }
      diag.info("app", "depuración lista (nivel " + diag.level.label + ")");
      return diag;
    },

    // Una linea resumen del estado del anillo (para la barra de la interfaz).
    summaryLine() {
      const errs = entries.reduce((n, e) => n + (e.level === "error" ? e.count : 0), 0);
      const warn = entries.reduce((n, e) => n + (e.level === "aviso" ? e.count : 0), 0);
      return entries.length + " líneas · " + errs + " errores · " + warn + " avisos";
    },

    // --- ventana de depuracion ----------------------------------------------

    // Pinta la ventana de depuracion. Devuelve `{ el, refresh, dispose }`.
    // `opts.mount` es el contenedor; `opts.onToast` para los avisos de la app.
    panel(o = {}) {
      const host = o.mount || document.body;
      const toast = o.onToast || (() => {});
      const filtro = { level: "detalle", cats: new Set(CATEGORIES.map((c) => c.key)), texto: "" };
      const root = document.createElement("div");
      root.className = "dgPanel";

      const head = document.createElement("div");
      head.className = "dgHead";
      const title = document.createElement("div");
      title.className = "dgTitle";
      title.textContent = "Depuración e informes";
      head.appendChild(title);
      const close = document.createElement("button");
      close.type = "button"; close.className = "bbtn"; close.textContent = "Cerrar";
      close.addEventListener("click", () => { root.hidden = true; });
      head.appendChild(close);
      root.appendChild(head);

      const bar = document.createElement("div");
      bar.className = "dgBar";
      const lvl = document.createElement("select");
      for (const l of LEVELS) {
        const op = document.createElement("option");
        op.value = l.key; op.textContent = "Nivel: " + l.label;
        lvl.appendChild(op);
      }
      lvl.value = diag.level.key;
      lvl.addEventListener("change", () => { diag.setLevel(lvl.value); refresh(); });
      bar.appendChild(lvl);
      const buscar = document.createElement("input");
      buscar.type = "search"; buscar.placeholder = "filtrar texto…";
      buscar.addEventListener("input", () => { filtro.texto = buscar.value.toLowerCase(); refresh(); });
      bar.appendChild(buscar);
      root.appendChild(bar);

      const cats = document.createElement("div");
      cats.className = "dgCats";
      for (const c of CATEGORIES) {
        const lab = document.createElement("label");
        lab.className = "dgCat";
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.checked = true;
        cb.addEventListener("change", () => { if (cb.checked) filtro.cats.add(c.key); else filtro.cats.delete(c.key); refresh(); });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(c.label));
        cats.appendChild(lab);
      }
      root.appendChild(cats);

      const info = document.createElement("div");
      info.className = "dgInfo";
      root.appendChild(info);

      const log = document.createElement("div");
      log.className = "dgLog";
      root.appendChild(log);

      const btns = document.createElement("div");
      btns.className = "dgBtns";
      const mk = (label, cls, fn) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "bbtn" + (cls ? " " + cls : ""); b.textContent = label;
        b.addEventListener("click", (ev) => { ev.preventDefault(); fn(); });
        btns.appendChild(b);
        return b;
      };
      mk("Ver informe", "", () => verInforme());
      mk("Guardar", "", () => {
        const r = diag.save();
        toast(r.ok ? "Informe guardado (" + r.via + ")" + (r.ruta ? ": " + r.ruta : ".") : "No se pudo guardar: " + r.error);
        refresh();
      });
      mk("Compartir", "", async () => {
        const r = await diag.share();
        toast(r.ok ? "Informe compartido (" + r.via + ")." : "No se pudo compartir.");
      });
      mk("Copiar", "", async () => {
        const ok = await diag.copy();
        toast(ok ? "Informe copiado al portapapeles." : "No se pudo copiar.");
      });
      mk("Probar error", "", () => {
        diag.error("error", "error de prueba (a propósito)");
        try { null.oops; } catch (e) { diag.error("error", "prueba de excepción capturada", String(e.message)); }
        refresh();
        toast("Anotados dos errores de prueba. Pulsa «Ver informe».");
      });
      mk("Limpiar", "", () => { diag.clear(); refresh(); toast("Registro vaciado."); });
      root.appendChild(btns);

      const viewer = document.createElement("div");
      viewer.className = "dgViewer";
      viewer.hidden = true;
      const vHead = document.createElement("div");
      vHead.className = "dgViewerHead";
      const vTitle = document.createElement("span");
      vTitle.textContent = "Informe";
      vHead.appendChild(vTitle);
      const vClose = document.createElement("button");
      vClose.type = "button"; vClose.className = "bbtn"; vClose.textContent = "Volver";
      vClose.addEventListener("click", () => { viewer.hidden = true; log.hidden = false; info.hidden = false; cats.hidden = false; });
      vHead.appendChild(vClose);
      const vSave = document.createElement("button");
      vSave.type = "button"; vSave.className = "bbtn"; vSave.textContent = "Guardar";
      vSave.addEventListener("click", () => { const r = diag.save(); toast(r.ok ? "Guardado (" + r.via + ")." : "No se pudo guardar."); });
      vHead.appendChild(vSave);
      const vCopy = document.createElement("button");
      vCopy.type = "button"; vCopy.className = "bbtn"; vCopy.textContent = "Copiar";
      vCopy.addEventListener("click", async () => { toast((await diag.copy(vText.value)) ? "Copiado." : "No se pudo copiar."); });
      vHead.appendChild(vCopy);
      viewer.appendChild(vHead);
      const vText = document.createElement("textarea");
      vText.className = "dgReport";
      vText.spellcheck = false;
      vText.setAttribute("readonly", "readonly");
      viewer.appendChild(vText);
      root.appendChild(viewer);

      function verInforme() {
        vText.value = diag.report({ full: true });
        viewer.hidden = false;
        log.hidden = true; info.hidden = true; cats.hidden = true;
      }

      function visible() {
        const out = [];
        for (let i = entries.length - 1; i >= 0 && out.length < 400; i--) {
          const e = entries[i];
          if (e.levelValue > levelOf(filtro.level).value) continue;
          if (!filtro.cats.has(e.cat)) continue;
          if (filtro.texto && (e.text + " " + (e.cat || "")).toLowerCase().indexOf(filtro.texto) < 0) continue;
          out.push(e);
        }
        return out.reverse();
      }

      function refresh() {
        info.textContent = envLine() + " · " + diag.summaryLine();
        const rows = visible();
        log.textContent = "";
        for (const e of rows) {
          const row = document.createElement("div");
          row.className = "dgRow " + levelOf(e.level).cls;
          const t = document.createElement("span");
          t.className = "dgTime"; t.textContent = stamp(e.ms);
          const c = document.createElement("span");
          c.className = "dgCatTag"; c.textContent = e.cat;
          const x = document.createElement("span");
          x.className = "dgText"; x.textContent = (e.count > 1 ? "×" + e.count + " " : "") + e.text;
          row.appendChild(t); row.appendChild(c); row.appendChild(x);
          if (e.data !== undefined) {
            const d = document.createElement("div");
            d.className = "dgData"; d.textContent = shortText(e.data, 300);
            row.appendChild(d);
          }
          log.appendChild(row);
        }
        if (!rows.length) log.textContent = "(nada que mostrar con estos filtros)";
        log.scrollTop = log.scrollHeight;
      }

      function envLine() {
        const e = diag.env();
        const n = e.nativo;
        return (n ? (n.modelo || "Android") + " · Android " + (n.android || "?") : "navegador") + " · " + (e.ventana || "");
      }

      host.appendChild(root);
      const off = diag.on(() => { if (!root.hidden && !log.hidden) refresh(); });
      refresh();

      return {
        el: root,
        refresh,
        verInforme,
        show() { root.hidden = false; refresh(); },
        get hidden() { return root.hidden; },
        dispose() { off(); root.remove(); },
      };
    },
  };

  return diag;
}

// Una linea con lo mas util del contexto WebGL, para el informe de texto.
function glLine(g) {
  const partes = [];
  if (g.tarjeta) partes.push(String(g.tarjeta).slice(0, 90));
  if (g.version) partes.push(String(g.version).slice(0, 40));
  if (g.maxTextura) partes.push("tex " + g.maxTextura);
  if (g.maxHuesos) partes.push("unif " + g.maxHuesos);
  return partes.join(" · ");
}

// Instancia unica del visor. Los modulos importan esto y anotan directamente.
export const diag = createDiag({ name: "visor-sl" });

export default diag;
