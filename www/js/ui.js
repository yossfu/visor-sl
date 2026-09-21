// HUD / panels. Plain DOM, no framework.
import { md5Hex } from "./md5.js";
import { prefsAll, prefsSet, storageInfo, storageStatus, requestStorage, pickFolder, saveToDownloads, cacheClear, platformInfo, httpRequest } from "./transport.js";
import { CACHE_REV, cacheMode, setCacheMode, verifyCache, wipeCache } from "./cache.js";
import { PROFILES, profileNames } from "./perf.js";
import { fullReport, bootCheck } from "./diag.js";

// Same value sl-session.js sends as `passwd` (kept local so the login screen
// does not pull the whole session module into the initial bundle).
function passwordHash(password) {
  return "$1$" + md5Hex(String(password || "").trim().slice(0, 16));
}

export function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return n;
}

const PROFILE_NAMES = [
  ["0", "Círculo"], ["1", "Cuadrado"], ["2", "Triángulo isósceles"],
  ["3", "Triángulo equilátero"], ["4", "Triángulo rectángulo"], ["5", "Semicírculo"],
];
const PROFILE_HOLES = [["0", "Mismo"], ["16", "Círculo"], ["32", "Cuadrado"], ["48", "Triángulo"]];
const PATH_NAMES = [["16", "Línea"], ["32", "Círculo"], ["48", "Círculo 2"], ["64", "Resorte"]];
const TEXTURES = [
  ["", "Predeterminada"], ["gen:wood", "Madera"], ["gen:brick", "Ladrillo"],
  ["gen:metal", "Metal"], ["gen:grid", "Rejilla"], ["gen:sign:Visor SL", "Cartel"],
];

// ---------------------------------------------------------------------------
// Lands: the region finder and the teleporter
//
// Nothing here is cached in the device's texture cache: the map tiles change
// constantly and a region lookup is a small HTML page, so they live in this
// little in-memory map for the length of the session.
// ---------------------------------------------------------------------------

const LANDS_TILE_PX = 256;      // map tiles are 256×256
const LANDS_REGION_M = 256;     // and a region is 256×256 m
// The map CDN answers 403 to a request with no User-Agent (the CORS-free proxy
// sends none unless asked), so the tiles are always asked for with one.
const LANDS_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; VisorSL)", Accept: "image/jpeg,text/html,*/*" };
const landsNet = new Map();

/** One request per URL, shared by the tiles and the region lookups. */
function landsGet(url, timeout = 30000) {
  let p = landsNet.get(url);
  if (!p) {
    p = httpRequest({ url, timeout, headers: LANDS_HEADERS });
    p.catch(() => landsNet.delete(url));
    landsNet.set(url, p);
  }
  return p;
}

function landsTile(z, gx, gy) {
  // `gx`/`gy` are the region coordinates of the tile's south-west corner; at
  // zoom 1 one tile is exactly one region (secondlife-maps-cdn tile scheme).
  return `https://map.secondlife.com/map-${z}-${gx}-${gy}-objects.jpg`;
}

async function landsLoadTile(url) {
  const key = "img:" + url;
  let p = landsNet.get(key);
  if (!p) {
    p = landsGet(url).then(async (res) => {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await createImageBitmap(new Blob([res.bytes], { type: "image/jpeg" }));
    });
    p.catch(() => landsNet.delete(key));
    landsNet.set(key, p);
  }
  return p;
}

/**
 * Region name -> grid coordinates, through the public maps site. Its region
 * pages carry `data-region-coords-x/y` for any region that exists (and a
 * `data-region-coords-error` marker for the ones that do not), which is the only
 * name→coordinate lookup that needs no key and no login.
 */
async function landsLookupRegion(name) {
  const url = "https://maps.secondlife.com/secondlife/" + encodeURIComponent(name) + "/128/128/25";
  const res = await landsGet(url);
  const html = res.text || "";
  if (/data-region-coords-error/.test(html)) return null;
  const x = html.match(/data-region-coords-x="(-?\d+)"/);
  const y = html.match(/data-region-coords-y="(-?\d+)"/);
  if (!x || !y) return null;
  const title = html.match(/<title>[^<]*\|\s*([^<]+)<\/title>/i);
  const inJson = html.match(/"region":\{"name":"([^"]+)"/);
  const display = (title && title[1].trim()) || (inJson && inJson[1]) || name;
  return { name: display, gx: +x[1], gy: +y[1] };
}

/** Accepts a region name, a `secondlife://` or maps.secondlife.com SLURL, or "x, y". */
async function landsResolve(query) {
  const text = String(query || "").trim().replace(/^["']|["']$/g, "");
  if (!text) return null;
  let m = text.match(/^secondlife:\/\/([^/\s]+)(?:\/([\d.]+))?(?:\/([\d.]+))?(?:\/([\d.]+))?/i)
    || text.match(/^https?:\/\/(?:www\.)?maps\.secondlife\.com\/secondlife\/([^/\s?]+)(?:\/([\d.]+))?(?:\/([\d.]+))?(?:\/([\d.]+))?/i)
    || text.match(/^([A-Za-z0-9' ._+-]+?)[\s/]+([\d.]+)[\s/]+([\d.]+)(?:[\s/]+([\d.]+))?$/);
  if (m) {
    const name = decodeURIComponent(m[1]).replace(/[+_]/g, " ").trim();
    const local = [Number(m[2]) || 128, Number(m[3]) || 128, Number(m[4]) || 25];
    const found = await landsLookupRegion(name);
    if (!found) return { error: `No encuentro la región «${name}» en el grid.` };
    return Object.assign(found, { local });
  }
  m = text.match(/^(-?\d{1,5})\s*[,;\s]\s*(-?\d{1,5})$/);
  if (m) return { name: `Región ${m[1]}, ${m[2]}`, gx: +m[1], gy: +m[2], local: [128, 128, 25] };
  const found = await landsLookupRegion(text);
  return found || { error: `No encuentro la región «${text}» en el grid.` };
}

export class UI {
  constructor(app) {    this.app = app;
    this.localTest = null;   // the in-memory simulator, while the local test runs
    this.root = document.getElementById("hud");
    this.build();
    this.log("Visor SL listo. Inicia sesión con tu cuenta de Second Life.");
    const gpu = app.viewer && app.viewer.gpu;
    if (gpu) {
      this.gpu = gpu;
      this.log(`GPU: ${gpu.renderer || gpu.vendor || "desconocida"} · ${gpu.webgl} · texturas hasta ${gpu.maxTexture}px · ${gpu.extensions} extensiones` +
        (gpu.software ? " ⚠ renderizado por software (sin GPU): bajará la fluidez." : ""));
    }
    // Which quality the device got, on the same line-of-sight as the GPU: if a
    // report says "va lento", this says what the viewer thought the device could
    // afford, and whether it changed its mind later ("Rendimiento insuficiente").
    if (app.profile) {
      this.log(`Calidad: ${app.profile.name} (${app.profile.label}) · alcance ${app.profile.drawDistance} m · hasta ${app.profile.maxObjects} prims · texturas ≤${app.profile.texMax}px · sombras ${app.profile.shadows ? "sí" : "no"}`);
    }
    // Self-check of the things that fail silently on a phone (bundled assets,
    // browser features, software rendering). It says nothing when all is well.
    Promise.resolve()
      .then(() => bootCheck(app, (m) => this.log(m)))
      .catch(() => {});
  }

  build() {
    const r = this.root;

    // --- top bar ---
    this.fpsEl = el("span", { class: "stat", text: "0 fps" });
    this.trisEl = el("span", { class: "stat", text: "0 tris" });
    this.objEl = el("span", { class: "stat", text: "0 prims" });
    this.regionEl = el("span", { class: "stat wide", text: "Demo Sandbox" });
    this.netEl = el("span", { class: "stat net", text: "sin conexión" });
    const top = el("div", { class: "bar top" }, [
      el("b", { class: "brand", text: "Visor SL" }),
      this.regionEl, this.fpsEl, this.trisEl, this.objEl, this.netEl,
      el("span", { class: "spacer" }),
      el("button", { class: "btn", onclick: () => this.toggleFly(), id: "flyBtn", text: "Volar (F)" }),
      el("button", { class: "btn", onclick: () => this.showLands(), text: "Lands" }),
      el("button", { class: "btn", onclick: () => this.cycleQuality(), text: "Calidad" }),
      el("button", { class: "btn", onclick: () => this.togglePanel("inspector"), text: "Inspector" }),
      el("button", { class: "btn accent", onclick: () => this.showLogin(), text: "Conectar a SL" }),
      el("button", { class: "btn", onclick: () => this.togglePanel("menu"), text: "☰" }),
    ]);
    r.appendChild(top);

    // --- side panel ---
    this.panel = el("div", { class: "panel right", id: "sidePanel" });
    r.appendChild(this.panel);

    this.panelInspector = this.buildInspector();
    this.panelMenu = this.buildMenu();
    this.panel.appendChild(this.panelMenu);
    this.panel.appendChild(this.panelInspector);

    // --- bottom log/chat ---
    this.logEl = el("div", { class: "log", id: "log" });
    const chatInput = el("input", { class: "chatinput", placeholder: "Escribe un mensaje…", id: "chatInput" });
    this.chatEl = chatInput;
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && chatInput.value.trim()) {
        this.log("Tú: " + chatInput.value.trim());
        this.app.onChat(chatInput.value.trim());
        chatInput.value = "";
      }
    });
    const bottom = el("div", { class: "bar bottom" }, [
      this.logEl,
      el("div", { class: "row" }, [
        chatInput,
        el("button", {
          class: "btn", title: "Mostrar u ocultar el registro",
          onclick: (e) => {
            this.logEl.classList.toggle("open");
            e.currentTarget.classList.toggle("active");
          },
          text: "▤",
        }),
        el("button", { class: "btn", title: "Copiar el registro al portapapeles", onclick: () => this.copyLog(), text: "⧉" }),
      ]),
    ]);
    r.appendChild(bottom);

    // --- login modal ---
    this.modalHost = el("div", { class: "modal-host hidden", id: "modalHost" });
    r.appendChild(this.modalHost);
  }

  buildMenu() {
    const b = (label, fn) => el("button", { class: "btn wide", onclick: fn, text: label });
    return el("div", { class: "section" }, [
      el("h3", { text: "Sesión" }),
      b("Conectar a Second Life", () => this.showLogin()),
      b("Desconectar", () => this.app.disconnect()),
      el("h3", { text: "Mundos" }),
      b("Buscar tierras y teletransportarse", () => this.showLands()),
      el("div", { class: "hint", text: "Busca una región por nombre o SLURL y teletranspórtate a un punto exacto dentro de ella. Para probar el teletransporte, cualquier región pública (por ejemplo «Ahern» o «Sandbox Cordova») sirve." }),
      el("h3", { text: "Crear prim" }),
      el("div", { class: "row wrap" }, [
        b("Cubo", () => this.app.spawn({ profileCurve: 1, pathCurve: 16 })),
        b("Cilindro", () => this.app.spawn({ profileCurve: 0, pathCurve: 16 })),
        b("Esfera", () => this.app.spawn({ profileCurve: 5, pathCurve: 32 })),
        b("Toro", () => this.app.spawn({ profileCurve: 0, pathCurve: 32, pathScaleY: 40 })),
        b("Tubo", () => this.app.spawn({ profileCurve: 16, pathCurve: 16, profileHollow: 9000 })),
        b("Prisma", () => this.app.spawn({ profileCurve: 3, pathCurve: 16 })),
        b("Cono", () => this.app.spawn({ profileCurve: 0, pathCurve: 16, pathScaleX: 0 })),
        b("Anillo", () => this.app.spawn({ profileCurve: 0, pathCurve: 32, profileEnd: 15000 })),
      ]),
      el("h3", { text: "Sol" }),
      this.slider("Ángulo", 0, 100, 42, (v) => this.app.viewer.setSun(v / 100 * 1.5, this.app.viewer.sunAzimuth)),
      el("h3", { text: "Diagnóstico" }),
      b("Diagnóstico completo (GPU, archivos, texturas)", () => this.showDiagnostics()),
      b("Diagnóstico de red y UDP", () => this.app.diagnoseUdp().catch((e) => this.error(e.message))),
      (this.localTestBtn = b("Prueba de vista con simulador local", () => this.runLocalTest())),
      el("div", { class: "hint", text: "La prueba local conecta el visor a un simulador en memoria: si el mundo se ve bien aquí, el móvil y el motor están bien y el problema está en el grid; si también se ve mal, el problema es el dispositivo (mira el diagnóstico). Se sale pulsando el mismo botón." }),
      el("h3", { text: "Rendimiento" }),
      this.select("Perfil de render", profileNames().map((n) => [n, PROFILES[n].label + (this.app.profile && this.app.profile.name === n ? " — actual" : "")]), this.app.profile && this.app.profile.name || "alto", (v) => {
        const p = this.app.setProfile(v);
        prefsSet({ "visor.profile": v });
        this.log(`Perfil de render: ${p.label} (alcance ${p.drawDistance} m, ${p.shadows ? "con" : "sin"} sombras, hasta ${p.maxObjects} prims).`);
      }),
      el("div", { class: "hint", text: "El visor baja la resolución solo cuando los fotogramas se atascan (gobernador de fps). El perfil «bajo» es el que conviene en un móvil modesto." }),
      el("h3", { text: "Datos en el dispositivo" }),
      b("Guardar registro en Descargas", () => this.saveLog()),
      b("Caché y verificación", () => this.showCache()),
      b("Ver las texturas decodificadas", () => this.showTextures()),
      b("Borrar caché de texturas", async () => {
        const res = await cacheClear();
        this.log(res ? `Caché de texturas borrada (${res.deleted || 0} archivos).` : "No hay caché que borrar (hace falta la app Android).");
      }),
      b("Dónde se guardan los datos", () => {
        const s = storageInfo();
        this.log(`Almacenamiento: ${s.platform === "web" ? "navegador" : s.cacheDir || "?"} · caché ${((s.cacheBytes || 0) / 1048576).toFixed(1)} MB en ${s.cacheFiles || 0} archivos · libre ${(((s.freeBytes || 0)) / 1073741824).toFixed(1)} GB` +
          (s.needsPermission === false ? " · no hace falta permiso de almacenamiento (carpeta propia de la app)" : ""));
      }),
      b("Permiso y carpeta de almacenamiento", () => this.showStorage()),
      el("h3", { text: "Texturas" }),
      b("Informe de texturas/terreno", () => {
        if (this.app.session && this.app.session.textureReport) this.log(this.app.session.textureReport());
        else this.log("Sin sesión activa.");
      }),
      el("div", { class: "hint", text: "El grid entrega texturas JPEG2000; se decodifican con OpenJPEG y se guardan en el dispositivo para no volver a descargarlas." }),
      el("div", { class: "hint", text: "Conecta con tu cuenta de Second Life para entrar al mundo real (necesita el APK con el puente nativo para UDP)." }),
    ]);
  }

  buildInspector() {
    const wrap = el("div", { class: "section inspector" });
    wrap.appendChild(el("h3", { text: "Inspector" }));
    this.inspectorBody = el("div", { class: "inspbody" }, [
      el("div", { class: "hint", text: "Haz clic en un prim para editarlo." }),
    ]);
    wrap.appendChild(this.inspectorBody);
    return wrap;
  }

  slider(label, min, max, value, onInput, step = 1) {
    const out = el("span", { class: "val", text: String(value) });
    const input = el("input", {
      type: "range", min, max, step, value,
      oninput: (e) => { out.textContent = e.target.value; onInput(parseFloat(e.target.value)); },
    });
    return el("label", { class: "slider" }, [el("span", { class: "lab", text: label }), input, out]);
  }
  number(label, value, onInput, opts = {}) {
    const input = el("input", {
      class: "num", type: "number", value,
      min: opts.min, max: opts.max, step: opts.step || 0.1,
      oninput: (e) => onInput(parseFloat(e.target.value)),
    });
    return el("label", { class: "slider" }, [el("span", { class: "lab", text: label }), input]);
  }
  select(label, options, value, onChange) {
    const sel = el("select", { onchange: (e) => onChange(e.target.value) },
      options.map(([v, t]) => el("option", { value: v, selected: String(value) === String(v) ? "" : undefined, text: t })));
    return el("label", { class: "slider" }, [el("span", { class: "lab", text: label }), sel]);
  }

  showInspector(rec) {
    this.inspectorBody.innerHTML = "";
    if (!rec) {
      this.inspectorBody.appendChild(el("div", { class: "hint", text: "Haz clic en un prim para editarlo." }));
      return;
    }
    const p = rec.params;
    const upd = (patch) => this.app.updateSelected(patch);
    const scale = rec.scale || [1, 1, 1];
    const pos = rec.position || [0, 0, 0];
    const faceCount = rec.vol ? rec.vol.faces.length : 0;
    this.inspectorBody.appendChild(el("div", { class: "name", text: rec.name || rec.id }));
    this.inspectorBody.appendChild(el("div", { class: "hint", text: `${faceCount} caras · detalle LOD ${rec.detail}` }));

    this.inspectorBody.appendChild(this.select("Perfil", PROFILE_NAMES, p.profileCurve & 15, (v) => upd({ profileCurve: (+v) | (p.profileCurve & 0xf0) })));
    this.inspectorBody.appendChild(this.select("Agujero", PROFILE_HOLES, p.profileCurve & 0xf0, (v) => upd({ profileCurve: (p.profileCurve & 15) | (+v) })));
    this.inspectorBody.appendChild(this.select("Trayectoria", PATH_NAMES, p.pathCurve & 0xf0, (v) => upd({ pathCurve: +v })));
    this.inspectorBody.appendChild(this.slider("Corte perfil ini", 0, 49000, p.profileBegin | 0, (v) => upd({ profileBegin: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Corte perfil fin", 0, 49000, p.profileEnd | 0, (v) => upd({ profileEnd: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Hueco", 0, 47500, p.profileHollow | 0, (v) => upd({ profileHollow: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Corte camino ini", 0, 49000, p.pathBegin | 0, (v) => upd({ pathBegin: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Corte camino fin", 0, 49000, p.pathEnd | 0, (v) => upd({ pathEnd: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Escala camino X", 0, 200, p.pathScaleX ?? 100, (v) => upd({ pathScaleX: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Escala camino Y", 0, 200, p.pathScaleY ?? 100, (v) => upd({ pathScaleY: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Torsión", -100, 100, p.pathTwist | 0, (v) => upd({ pathTwist: v | 0, pathTwistBegin: 0 })));
    this.inspectorBody.appendChild(this.slider("Torsión inicial", -100, 100, p.pathTwistBegin | 0, (v) => upd({ pathTwistBegin: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Estrechamiento X", -100, 100, p.pathTaperX | 0, (v) => upd({ pathTaperX: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Estrechamiento Y", -100, 100, p.pathTaperY | 0, (v) => upd({ pathTaperY: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Inclinación X", -100, 100, p.pathShearX | 0, (v) => upd({ pathShearX: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Inclinación Y", -100, 100, p.pathShearY | 0, (v) => upd({ pathShearY: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Desplaz. radio", -100, 100, p.pathRadiusOffset | 0, (v) => upd({ pathRadiusOffset: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Sesgo", -100, 100, p.pathSkew | 0, (v) => upd({ pathSkew: v | 0 })));
    this.inspectorBody.appendChild(this.slider("Revoluciones", 0, 255, p.pathRevolutions | 0, (v) => upd({ pathRevolutions: v | 0 })));

    this.inspectorBody.appendChild(el("h4", { text: "Transformación" }));
    for (let i = 0; i < 3; i++) {
      this.inspectorBody.appendChild(this.number(["Tamaño X", "Tamaño Y", "Tamaño Z"][i], scale[i], (v) => {
        const s = [...scale]; s[i] = Math.max(0.01, v); this.app.setSelectedTransform({ scale: s });
      }, { min: 0.01, max: 64, step: 0.05 }));
    }
    for (let i = 0; i < 3; i++) {
      this.inspectorBody.appendChild(this.number(["Pos X", "Pos Y", "Pos Z"][i], pos[i], (v) => {
        const p2 = [...pos]; p2[i] = v; this.app.setSelectedTransform({ position: p2 });
      }, { step: 0.5 }));
    }
    this.inspectorBody.appendChild(this.slider("Giro (yaw)", 0, 360, 0, (v) => {
      const a = v * Math.PI / 180;
      this.app.setSelectedTransform({ rotation: [0, 0, Math.sin(a / 2), Math.cos(a / 2)] });
    }));

    this.inspectorBody.appendChild(el("h4", { text: "Apariencia" }));
    this.inspectorBody.appendChild(this.select("Textura", TEXTURES, rec.texture ? rec.texture.all : "", (v) => this.app.setSelectedTexture(v)));
    const rgba = rec.rgba || [1, 1, 1, 1];
    this.inspectorBody.appendChild(this.slider("Rojo", 0, 100, Math.round(rgba[0] * 100), (v) => { const c = [...rgba]; c[0] = v / 100; this.app.setSelectedStyle({ rgba: c }); }));
    this.inspectorBody.appendChild(this.slider("Verde", 0, 100, Math.round(rgba[1] * 100), (v) => { const c = [...rgba]; c[1] = v / 100; this.app.setSelectedStyle({ rgba: c }); }));
    this.inspectorBody.appendChild(this.slider("Azul", 0, 100, Math.round(rgba[2] * 100), (v) => { const c = [...rgba]; c[2] = v / 100; this.app.setSelectedStyle({ rgba: c }); }));
  }

  toggleFly() {
    const v = this.app.viewer;
    v.controls.setFly(!v.controls.flying);
    document.getElementById("flyBtn").classList.toggle("active", v.controls.flying);
  }
  cycleQuality() {
    const q = this.app.world.quality;
    const next = q >= 4 ? 2 : q + 1;
    this.app.world.setQuality({ objects: next });
    this.log(`Calidad de objetos: ${next}`);
  }
  togglePanel(which) {
    if (which === "inspector") {
      this.panelInspector.classList.toggle("hidden");
    } else {
      this.panel.classList.toggle("open");
    }
  }

  log(msg) {
    const line = el("div", { class: "line", text: msg });
    this.logEl.appendChild(line);
    while (this.logEl.children.length > 60) this.logEl.removeChild(this.logEl.firstChild);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Logs a failure and remembers it so the ⧉ button always carries it. */
  error(msg) {
    const text = String(msg == null ? "" : msg);
    this.lastError = text;
    this.log("⚠ " + text);
  }

  copyLog() {
    const text = this.logText();
    const done = (ok) => this.log(ok ? "Registro copiado. Pégalo en el chat si algo falla." : "No se pudo copiar el registro.");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      return;
    }
    const ta = el("textarea", {});
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    done(ok);
  }

  /**
   * Runs the whole pipeline against the in-memory simulator, on the device. It
   * answers the question the user cannot answer from a screenshot — "is this the
   * phone or the grid?" — without needing a second APK: if the world looks right
   * here, the GPU, the renderer and the bundled avatar assets are fine and the
   * problem is out on the grid; if it also looks wrong, the problem is the
   * device, and the diagnostics panel says which part.
   *
   * The harness replaces the native bridge while it runs, so it is reversible:
   * pressing the same button tears it down and restores the real bridge.
   */
  async runLocalTest() {
    if (this.localTest) return this.stopLocalTest();
    this.localTestBtn.textContent = "Preparando la prueba…";
    try {
      if (this.app.session) {
        try { await this.app.session.disconnect(); } catch (_) {}
        this.app.session = null;
      }
      this.app.returnToLogin();
      const mod = await import("./test/fake-grid.js");
      const sim = await mod.runFakeGrid(this.app);
      this.localTest = sim;
      this.localTestBtn.textContent = "Salir de la prueba local";
      this.log("⚠ PRUEBA LOCAL: el visor está conectado a un simulador en memoria, no al grid. El terreno, los prims y las texturas que veas son sintéticos a propósito (es lo que permite distinguir un fallo del móvil de un fallo de la conexión).");
    } catch (e) {
      this.localTestBtn.textContent = "Prueba de vista con simulador local";
      this.log("La prueba local no se pudo ejecutar: " + ((e && e.message) || e));
    }
  }

  /** Undoes runLocalTest: real bridge back, session closed, login screen. */
  async stopLocalTest() {
    const sim = this.localTest;
    this.localTest = null;
    if (this.localTestBtn) this.localTestBtn.textContent = "Prueba de vista con simulador local";
    try { if (this.app.session) await this.app.session.disconnect(); } catch (_) {}
    this.app.session = null;
    try { if (sim && sim.restoreBridge) sim.restoreBridge(); } catch (_) {}
    this.app.returnToLogin();
    this.log("Prueba local terminada: de vuelta a la pantalla de inicio de sesión.");
  }

  /**
   * Full on-device report in a modal: GPU, browser features, every bundled
   * avatar asset, the JPEG2000 decoder, the live texture/terrain/avatar
   * counters and the storage paths. It is the answer to "why do I see no
   * textures?", which cannot be guessed from the screen.
   */
  async showDiagnostics() {
    const m = this.modalHost;
    m.innerHTML = "";
    m.classList.remove("hidden");
    const close = () => { m.classList.add("hidden"); m.innerHTML = ""; };
    const body = el("div", { class: "diagbody" }, [el("div", { class: "hint", text: "Comprobando GPU, archivos y decodificador…" })]);
    const status = el("div", { class: "hint", text: "" });
    const setText = () => {
      this.diagText = (this.diagRows || []).map((r) =>
        `${r.ok === true ? "OK   " : r.ok === false ? "FALLA" : "·    "} ${r.name}: ${r.detail}`).join("\n");
    };
    const copyBtn = el("button", { class: "btn", text: "⧉ Copiar", onclick: () => {
      setText();
      const text = this.diagText || "";
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => this.log("Diagnóstico copiado."), () => this.log("No se pudo copiar."));
      } else this.log("Copia no disponible.");
    } });
    const saveBtn = el("button", { class: "btn", text: "Guardar en Descargas", onclick: async () => {
      setText();
      const res = await saveToDownloads("visor-sl-diagnostico.txt", new TextEncoder().encode(this.diagText || ""), "text/plain");
      this.log(res && res.ok ? "Diagnóstico guardado en Descargas." : "Guardar necesita la app Android.");
    } });
    m.appendChild(el("div", { class: "modal wide" }, [
      el("h2", { text: "Diagnóstico del visor" }),
      body,
      status,
      el("div", { class: "row wrap" }, [copyBtn, saveBtn, el("button", { class: "btn", text: "Cerrar", onclick: close })]),
    ]));

    let rows;
    try {
      rows = await fullReport(this.app);
    } catch (e) {
      status.textContent = "No se pudo completar: " + ((e && e.message) || e);
      return;
    }
    this.diagRows = rows;
    setText();
    body.innerHTML = "";
    for (const r of rows) {
      body.appendChild(el("div", { class: "diagrow " + (r.ok === true ? "ok" : r.ok === false ? "bad" : "info") }, [
        el("span", { class: "tag", text: r.ok === true ? "OK" : r.ok === false ? "FALLA" : "·" }),
        el("span", { class: "name", text: r.name + ": " }),
        el("span", { class: "detail", text: r.detail }),
      ]));
    }
    const bad = rows.filter((r) => r.ok === false);
    status.textContent = bad.length ? `${bad.length} problema(s) detectado(s).` : "Todo correcto.";
    status.className = "hint " + (bad.length ? "warn" : "");
  }

  /**
   * Storage panel: where the data lives, plus the two actions Android offers —
   * the (legacy) storage permission dialog and the system folder picker. This
   * exists because "the app never asked for storage permission" looks like a
   * bug, while in fact the app's own folders need none; the panel says so and
   * still lets the user grant it on the versions that have it.
   */
  async showStorage() {
    const m = this.modalHost;
    m.innerHTML = "";
    m.classList.remove("hidden");
    const close = () => { m.classList.add("hidden"); m.innerHTML = ""; };
    const info = el("div", { class: "hint", text: "Leyendo…" });
    const status = el("div", { class: "hint", text: "" });
    const info2 = storageInfo();
    const st = storageStatus();
    const lines = [];
    if (info2.platform === "web") {
      lines.push("Estás en el navegador: los datos van a localStorage/IndexedDB del navegador.");
    } else {
      lines.push(`Carpeta de la app: ${info2.cacheDir || "?"}`);
      if (info2.externalDir) lines.push(`Carpeta externa propia: ${info2.externalDir}`);
      lines.push(`Caché de texturas: ${((info2.cacheBytes || 0) / 1048576).toFixed(1)} MB en ${info2.cacheFiles || 0} archivos` +
        (info2.cacheLimit ? ` (límite ${(info2.cacheLimit / 1048576).toFixed(0)} MB, se recorta sola)` : ""));
      lines.push(`Espacio libre: ${((info2.freeBytes || 0) / 1073741824).toFixed(1)} GB`);
    }
    if (st) {
      lines.push(`Carpeta elegida por ti: ${st.folder || "ninguna (se usa la de la app)"}`);
      lines.push(`Permiso de almacenamiento: ${st.permission === "granted" ? "concedido" : st.permission === "not_needed" ? "no existe en esta versión de Android (Android 10+)" : "no concedido"}`);
    }
    info.textContent = "";
    for (const l of lines) info.appendChild(el("div", { text: "· " + l }));
    const ask = el("button", { class: "btn", text: "Pedir permiso de almacenamiento", onclick: async () => {
      const res = await requestStorage();
      if (res.unsupported) status.textContent = "Esta app no expone el permiso (hace falta un APK nuevo).";
      else if (res.notNeeded) status.textContent = "Android 10+ ya no tiene ese permiso: la app guarda en su propia carpeta y exporta por MediaStore.";
      else status.textContent = res.granted ? "Permiso de almacenamiento concedido." : "Permiso denegado.";
      this.log("Almacenamiento: " + status.textContent);
    } });
    const pick = el("button", { class: "btn", text: "Elegir carpeta en el teléfono", onclick: async () => {
      status.textContent = "Esperando a que elijas la carpeta…";
      const res = await pickFolder();
      status.textContent = res.ok ? `Carpeta elegida: ${res.folder}` : (res.cancelled ? "No se eligió ninguna carpeta." : "No se pudo abrir el selector.");
      this.log("Almacenamiento: " + status.textContent);
    } });
    const clear = el("button", { class: "btn", text: "Borrar caché de texturas", onclick: async () => {
      const res = await cacheClear();
      status.textContent = res ? `Caché borrada (${res.deleted || 0} archivos).` : "No hay caché que borrar aquí.";
      this.log("Almacenamiento: " + status.textContent);
    } });
    m.appendChild(el("div", { class: "modal wide" }, [
      el("h2", { text: "Datos en el dispositivo" }),
      info,
      status,
      el("div", { class: "row wrap" }, [ask, pick, clear, el("button", { class: "btn", text: "Cerrar", onclick: close })]),
      el("div", { class: "hint", text: "El visor guarda las texturas del grid y la sesión en la carpeta propia de la app: ahí Android no pide ningún permiso. La carpeta elegida se usa además para exportar el registro y las capturas." }),
    ]));
  }

  /**
   * Cache panel. It answers the question that "los prims siguen igual" always
   * raises: is what I am looking at the current code, or a copy from two builds
   * ago? Three things make that answerable — the revision (stored copies are
   * addressed by it and it is wiped when it changes), a check of what is stored,
   * and a switch to stop using the store altogether while testing.
   */
  async showCache() {
    const m = this.modalHost;
    m.innerHTML = "";
    m.classList.remove("hidden");
    const close = () => { m.classList.add("hidden"); m.innerHTML = ""; };
    const info = el("div", { class: "hint" });
    const status = el("div", { class: "hint", text: "" });
    const modeBtn = el("button", { class: "btn" });
    const paint = () => {
      const s = storageInfo();
      info.innerHTML = "";
      const lines = [
        `Revisión de la caché: ${CACHE_REV} — al cambiar de revisión, lo guardado se borra al arrancar.`,
        `Estado: ${cacheMode() === "off" ? "DESACTIVADA — cada textura se pide al grid otra vez (modo de prueba)" : "activada — las texturas se guardan para no volver a descargarlas"}`,
        s.platform === "web"
          ? "En el navegador no hay caché de texturas en disco."
          : `Guardado ahora: ${((s.cacheBytes || 0) / 1048576).toFixed(1)} MB en ${s.cacheFiles || 0} archivos · libre ${((s.freeBytes || 0) / 1073741824).toFixed(1)} GB`,
      ];
      for (const l of lines) info.appendChild(el("div", { text: "· " + l }));
      modeBtn.textContent = cacheMode() === "off" ? "Activar caché" : "Modo sin caché (probar)";
    };
    paint();
    const verify = el("button", { class: "btn", text: "Verificar lo guardado", onclick: async () => {
      status.textContent = "Leyendo la cabecera de cada archivo…";
      const r = await verifyCache();
      if (!r) { status.textContent = "Dentro del navegador no hay archivos que verificar (hace falta la app Android)."; return; }
      const clean = (r.bad || 0) === 0 && (r.empty || 0) === 0;
      status.textContent = clean
        ? `Todo correcto: ${r.files} archivos, ${((r.bytes || 0) / 1048576).toFixed(1)} MB, ${r.good} con cabecera de imagen válida.`
        : `${r.bad} archivos sin cabecera de imagen y ${r.empty} vacíos de ${r.files} — ejemplos: ${(r.examples || []).join(", ")}. Bórralos con «Borrar caché».`;
      this.log("Caché: " + status.textContent);
    } });
    const clear = el("button", { class: "btn", text: "Borrar caché ahora", onclick: async () => {
      const r = await wipeCache();
      status.textContent = r ? `Borrados ${r.deleted || 0} archivos: las texturas se volverán a pedir al grid.` : "No hay caché que borrar aquí.";
      paint();
      this.log("Caché: " + status.textContent);
    } });
    modeBtn.addEventListener("click", () => {
      setCacheMode(cacheMode() !== "off");
      status.textContent = cacheMode() === "off"
        ? "Caché desactivada: a partir de ahora todo se pide al grid de nuevo (lo ya guardado no se borra, solo se ignora)."
        : "Caché activada otra vez: las texturas nuevas se guardarán.";
      paint();
      this.log("Caché: " + status.textContent);
    });
    m.appendChild(el("div", { class: "modal wide" }, [
      el("h2", { text: "Caché de texturas" }),
      info,
      status,
      el("div", { class: "row wrap" }, [verify, clear, modeBtn, el("button", { class: "btn", text: "Cerrar", onclick: close })]),
      el("div", { class: "hint", text: "Las texturas del grid son inmutables, así que una copia buena sirve para siempre y ahorra datos. El problema es que una copia mala (o vieja) también sirve para siempre y disimula los arreglos: por eso cada revisión del visor borra lo guardado, cada copia se comprueba antes de usarla, y este panel permite desactivar la caché del todo para comprobar que un cambio se nota de verdad." }),
    ]));
  }

  /**
   * The textures the viewer actually decoded, drawn on screen. "Los prims salen
   * negros" can mean three very different things — the decoder produced black
   * pixels, the texture never got applied, or the material is wrong — and from
   * the world alone they look identical. These are the real decoded pixels, so a
   * screenshot of this panel is evidence, not a theory.
   */
  showTextures() {
    const m = this.modalHost;
    m.innerHTML = "";
    m.classList.remove("hidden");
    const close = () => { m.classList.add("hidden"); m.innerHTML = ""; };
    const sess = this.app.session;
    const cache = sess && sess.textureCache;
    const ids = cache ? [...cache.keys()] : [];
    const status = el("div", { class: "hint" });
    const grid = el("div", { class: "texgrid" });
    const shown = ids.slice(0, 24);
    for (const uuid of shown) {
      const bmp = cache.get(uuid);
      const c = document.createElement("canvas");
      c.width = 128;
      c.height = 128;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#101820";
      ctx.fillRect(0, 0, 128, 128);
      let drew = false;
      try { ctx.drawImage(bmp, 0, 0, 128, 128); drew = true; } catch (e) { /* not drawable */ }
      grid.appendChild(el("div", { class: "texcell", title: uuid }, [
        c,
        el("div", { class: "hint", text: `${uuid.slice(0, 8)} ${bmp && bmp.width ? bmp.width + "×" + bmp.height : ""}${drew ? "" : " (no dibujable)"}` }),
      ]));
    }
    const untextured = (sess && sess.builtUntextured) || 0;
    status.textContent = ids.length
      ? `${ids.length} texturas decodificadas (se muestran ${shown.length}). Si aquí salen bien y en el mundo no, el problema no es la decodificación.` +
        (untextured ? ` En este momento ${untextured} prims visibles no tienen ninguna textura aplicada.` : "")
      : "Todavía no hay texturas decodificadas: conéctate a una región y espera unos segundos.";
    m.appendChild(el("div", { class: "modal wide" }, [
      el("h2", { text: "Texturas decodificadas" }),
      status,
      grid,
      el("div", { class: "row wrap" }, [el("button", { class: "btn", text: "Cerrar", onclick: close })]),
      el("div", { class: "hint", text: "Son los píxeles que el visor tiene en memoria, tal cual los devolvió el decodificador JPEG2000. Una captura de esta pantalla dice de un vistazo si las texturas del grid llegan bien." }),
    ]));
  }

  /**
   * The region name and the place inside it, straight from the session. The
   * top bar shows it, and the Lands panel uses it to answer "where am I?" and to
   * offer a one-click teleport to the region we are already in.
   */
  setRegionInfo(here) {
    this.region = here || null;
    if (this.regionEl && here && here.region) {
      const coords = Number.isFinite(here.gridX) && Number.isFinite(here.gridY) ? ` (${here.gridX}, ${here.gridY})` : "";
      this.regionEl.textContent = here.region + coords;
    }
    if (this.landsHereEl) this.landsHereEl.textContent = this.hereText();
  }

  hereText() {
    const s = this.app.session;
    const here = this.region || (s && s.locationInfo ? s.locationInfo() : null);
    if (!here || !here.region || here.region === "?") return "Sin región: conéctate para poder teletransportarte.";
    const p = here.local || [0, 0, 0];
    return `Estás en ${here.region} (${here.gridX}, ${here.gridY}) · posición ${p.map((v) => Math.round(v)).join(", ")}`;
  }

  /** Region search + grid map + teleport. */
  showLands() {
    const m = this.modalHost;
    m.innerHTML = "";
    m.classList.remove("hidden");
    const close = () => { m.classList.add("hidden"); m.innerHTML = ""; this.landsHereEl = null; };
    const sess = this.app.session;
    const startHere = this.region || (sess && sess.locationInfo ? sess.locationInfo() : null);
    const state = {
      z: 2,
      gx: startHere && Number.isFinite(startHere.gridX) ? startHere.gridX : 1000,
      gy: startHere && Number.isFinite(startHere.gridY) ? startHere.gridY : 1000,
      target: null,
    };

    const W = LANDS_TILE_PX * 3;
    const view = el("canvas", { class: "landsmap", width: W, height: W });
    const octx = view.getContext("2d");
    const tileLayer = document.createElement("canvas");
    tileLayer.width = W;
    tileLayer.height = W;
    const tctx = tileLayer.getContext("2d");

    const search = el("input", { class: "num wide", placeholder: "Nombre de la región o SLURL (p. ej. Sandbox Cordova)" });
    const status = el("div", { class: "hint", text: "Busca una región, o toca el mapa para elegir el punto exacto." });
    const targetEl = el("div", { class: "hint", text: "Ninguna región seleccionada." });
    const hereEl = el("div", { class: "hint", text: this.hereText() });
    this.landsHereEl = hereEl;
    const lx = el("input", { class: "num", type: "number", min: 0, max: 256, step: 1, value: 128 });
    const ly = el("input", { class: "num", type: "number", min: 0, max: 256, step: 1, value: 128 });
    const lz = el("input", { class: "num", type: "number", min: 0, max: 4096, step: 1, value: 25 });
    const tpBtn = el("button", { class: "btn accent", text: "Teletransportar" });
    const zoomOut = el("button", { class: "btn", text: "−" });
    const zoomIn = el("button", { class: "btn", text: "+" });
    const zoomLabel = el("span", { class: "hint" });
    const hereBtn = el("button", { class: "btn", text: "Centrar en mí" });

    const span = () => 1 << (state.z - 1);
    // The map is three tiles across and three down, with the tile that holds the
    // current region in the middle. Rows run north (top) to south (bottom): in a
    // map tile the highest region coordinate is the top row, and y grows north.
    const origin = () => ({ tx: Math.floor(state.gx / span()) - 1, ty: Math.floor(state.gy / span()) + 1 });
    const box = () => {
      const s = span(), o = origin();
      return { s, left: o.tx * s * LANDS_REGION_M, top: (o.ty + 1) * s * LANDS_REGION_M };
    };
    const canvasToWorld = (cx, cy) => {
      const { s, left, top } = box();
      const wx = left + cx * s;
      const wy = top - cy * s - 0.5;
      const gx = Math.floor(wx / LANDS_REGION_M);
      const gy = Math.floor(wy / LANDS_REGION_M);
      return { gx, gy, x: Math.round(wx - gx * LANDS_REGION_M), y: Math.round(wy - gy * LANDS_REGION_M) };
    };
    const worldToCanvas = (gx, gy, x = 128, y = 128) => {
      const { s, left, top } = box();
      return {
        cx: (gx * LANDS_REGION_M + x - left) / s,
        cy: (top - (gy * LANDS_REGION_M + y)) / s,
      };
    };

    let drawGen = 0;
    const drawTiles = async () => {
      const gen = ++drawGen;
      const s = span(), o = origin();
      tctx.fillStyle = "#0d1319";
      tctx.fillRect(0, 0, W, W);
      compose();
      const jobs = [];
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          const gx = o.tx + i, gy = o.ty - j;
          if (gx < 0 || gy < 0) continue;
          jobs.push(landsLoadTile(landsTile(state.z, gx * s, gy * s)).then((bmp) => {
            if (gen !== drawGen) return;
            tctx.drawImage(bmp, i * LANDS_TILE_PX, j * LANDS_TILE_PX, LANDS_TILE_PX, LANDS_TILE_PX);
            compose();
          }).catch(() => { /* a tile with no image (empty region) stays dark */ }));
        }
      }
      await Promise.all(jobs);
    };

    const compose = () => {
      const s = span(), o = origin();
      const cell = LANDS_TILE_PX / s;
      octx.clearRect(0, 0, W, W);
      octx.drawImage(tileLayer, 0, 0);
      // The region grid: without it a tile of empty water looks like the end of
      // the world, when it is really "no region here yet".
      octx.strokeStyle = "rgba(255,255,255,.18)";
      octx.lineWidth = 1;
      for (let k = 0; k <= 3 * s; k++) {
        const p = Math.round(k * cell) + 0.5;
        octx.beginPath(); octx.moveTo(p, 0); octx.lineTo(p, W); octx.stroke();
        octx.beginPath(); octx.moveTo(0, p); octx.lineTo(W, p); octx.stroke();
      }
      if (cell >= 44) {
        octx.font = "11px system-ui, sans-serif";
        octx.textAlign = "center";
        octx.textBaseline = "middle";
        for (let col = 0; col < 3 * s; col++) {
          for (let row = 0; row < 3 * s; row++) {
            const gx = o.tx * s + col;
            const gy = o.ty * s + s - 1 - row;
            if (gx < 0 || gy < 0) continue;
            octx.fillStyle = "rgba(255,255,255,.55)";
            octx.fillText(`${gx},${gy}`, (col + 0.5) * cell, (row + 0.5) * cell);
          }
        }
      }
      if (state.target) {
        const t = state.target;
        const cellCol = t.gx - o.tx * s, cellRow = (o.ty * s + s - 1) - t.gy;
        octx.strokeStyle = "#35e39b";
        octx.lineWidth = 3;
        octx.strokeRect(cellCol * cell + 1, cellRow * cell + 1, cell - 2, cell - 2);
        const p = worldToCanvas(t.gx, t.gy, Number(lx.value) || 128, Number(ly.value) || 128);
        octx.beginPath();
        octx.arc(p.cx, p.cy, 6, 0, Math.PI * 2);
        octx.fillStyle = "#35e39b";
        octx.fill();
        octx.lineWidth = 2;
        octx.strokeStyle = "#04130c";
        octx.stroke();
      }
      const here = this.region || (this.app.session && this.app.session.locationInfo ? this.app.session.locationInfo() : null);
      if (here && Number.isFinite(here.gridX) && here.region && here.region !== "?") {
        const p = worldToCanvas(here.gridX, here.gridY, (here.local && here.local[0]) || 128, (here.local && here.local[1]) || 128);
        if (p.cx >= -10 && p.cx <= W + 10 && p.cy >= -10 && p.cy <= W + 10) {
          octx.beginPath();
          octx.arc(p.cx, p.cy, 7, 0, Math.PI * 2);
          octx.lineWidth = 3;
          octx.strokeStyle = "#ffd34d";
          octx.stroke();
          octx.beginPath();
          octx.arc(p.cx, p.cy, 2.5, 0, Math.PI * 2);
          octx.fillStyle = "#ffd34d";
          octx.fill();
        }
      }
    };

    const setTarget = (gx, gy, local) => {
      state.target = { gx, gy, name: state.target && state.target.gx === gx && state.target.gy === gy ? state.target.name : null };
      if (local) {
        lx.value = Math.round(local[0]);
        ly.value = Math.round(local[1]);
        if (local[2] != null) lz.value = Math.round(local[2]);
      }
      refreshTarget();
      compose();
    };
    const refreshTarget = () => {
      const t = state.target;
      if (!t) return;
      const local = [Number(lx.value) || 0, Number(ly.value) || 0, Number(lz.value) || 0];
      targetEl.textContent = `Destino: ${t.name || "región"} (${t.gx}, ${t.gy}) · punto ${local.map((v) => Math.round(v)).join(", ")} dentro de la región.`;
    };

    const updateZoom = () => { zoomLabel.textContent = `zoom ${state.z}`; };

    const goTo = (gx, gy, local, name) => {
      state.gx = Math.max(0, Math.round(gx));
      state.gy = Math.max(0, Math.round(gy));
      state.target = { gx: state.gx, gy: state.gy, name: name || null };
      if (local) {
        lx.value = Math.round(local[0]);
        ly.value = Math.round(local[1]);
        if (local[2] != null) lz.value = Math.round(local[2]);
      } else {
        lx.value = 128; ly.value = 128;
        if (lz.value === "" || lz.value == null) lz.value = 25;
      }
      refreshTarget();
      drawTiles();
      compose();
    };

    const doSearch = async () => {
      const q = search.value;
      if (!String(q || "").trim()) return;
      status.textContent = "Buscando…";
      try {
        const found = await landsResolve(q);
        if (!found) { status.textContent = "No encuentro esa región."; return; }
        if (found.error) { status.textContent = found.error; return; }
        goTo(found.gx, found.gy, found.local, found.name);
        status.textContent = `${found.name} está en (${found.gx}, ${found.gy}). Toca el mapa para afinar el punto y pulsa Teletransportar.`;
      } catch (e) {
        status.textContent = "La búsqueda falló: " + ((e && e.message) || e);
      }
    };

    search.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    view.addEventListener("click", (e) => {
      const r = view.getBoundingClientRect();
      const cx = (e.clientX - r.left) * (W / r.width);
      const cy = (e.clientY - r.top) * (W / r.height);
      const w = canvasToWorld(cx, cy);
      if (w.gx < 0 || w.gy < 0) return;
      setTarget(w.gx, w.gy, [w.x, w.y, Number(lz.value) || 25]);
      status.textContent = `Punto elegido en (${w.gx}, ${w.gy}) a ${w.x}, ${w.y} m dentro de la región.`;
    });
    zoomOut.addEventListener("click", () => { if (state.z > 1) { state.z--; updateZoom(); drawTiles(); } });
    zoomIn.addEventListener("click", () => { if (state.z < 5) { state.z++; updateZoom(); drawTiles(); } });
    hereBtn.addEventListener("click", () => {
      const here = this.region || (this.app.session && this.app.session.locationInfo ? this.app.session.locationInfo() : null);
      if (!here || !Number.isFinite(here.gridX) || here.region === "?") { status.textContent = "Todavía no sé en qué región estás."; return; }
      goTo(here.gridX, here.gridY, here.local, here.region);
      status.textContent = `Centrado en ${here.region}.`;
    });
    for (const inp of [lx, ly, lz]) inp.addEventListener("input", refreshTarget);
    tpBtn.addEventListener("click", () => {
      const t = state.target;
      if (!t) { status.textContent = "Elige primero una región en el mapa o búscala por nombre."; return; }
      const s = this.app.session;
      if (!s || s.state !== "online") { status.textContent = "Sin sesión activa: conéctate para teletransportarte."; return; }
      const point = [
        Math.max(0, Math.min(256, Number(lx.value) || 128)),
        Math.max(0, Math.min(256, Number(ly.value) || 128)),
        Math.max(0, Number(lz.value) || 25),
      ];
      if (s.teleportToRegion(t.gx, t.gy, point)) {
        status.textContent = `Teletransportando a ${t.name || `${t.gx}, ${t.gy}`}…`;
        this.log(`Teletransporte a ${t.name || "región"} (${t.gx}, ${t.gy}) en ${point.map((v) => Math.round(v)).join(", ")}.`);
      } else {
        status.textContent = "No se pudo enviar la petición de teletransporte.";
      }
    });

    const inputs = (label, input) => el("label", { class: "slider" }, [el("span", { class: "lab", text: label }), input]);
    // Quick picks from the generator's own config list (main.pjs), so the test
    // regions live where the user can edit them without touching the viewer.
    const picks = [];
    try {
      const list = (typeof root !== "undefined" && root && root.regionesDePrueba) ? root.regionesDePrueba.selectAll : [];
      for (const item of list) {
        const name = String(item.evaluateItem || "").trim();
        if (!name) continue;
        picks.push(el("button", {
          class: "btn", text: name,
          onclick: () => { search.value = name; doSearch(); },
        }));
      }
    } catch (_) { /* the generator may not define the list */ }
    m.appendChild(el("div", { class: "modal wide lands" }, [
      el("h2", { text: "Buscar tierras y teletransportarse" }),
      el("div", { class: "row" }, [search, el("button", { class: "btn", text: "Buscar", onclick: doSearch })]),
      status,
      el("div", { class: "landspicks" }, [
        el("div", { class: "hint", text: "Regiones de prueba (se pueden editar en main.pjs):" }),
        el("div", { class: "row wrap" }, picks),
      ]),
      el("div", { class: "landsbody" }, [
        el("div", { class: "landsleft" }, [
          hereEl,
          el("div", { class: "row landszoom" }, [zoomOut, zoomLabel, zoomIn, el("span", { class: "spacer" }), hereBtn]),
          view,
        ]),
        el("div", { class: "landsright" }, [
          targetEl,
          el("div", { class: "row wrap" }, [inputs("X", lx), inputs("Y", ly), inputs("Z", lz)]),
          el("div", { class: "row" }, [tpBtn, el("button", { class: "btn", text: "Cerrar", onclick: close })]),
          el("div", { class: "hint", text: "El mapa es el del grid (map.secondlife.com). El recuadro verde marca la región y el punto, el lugar exacto; el círculo amarillo eres tú. Tocar el mapa elige región y posición dentro de ella." }),
        ]),
      ]),
    ]));

    zoomLabel.textContent = "zoom " + state.z;
    updateZoom();
    drawTiles();
  }

  logText() {
    const lines = [...(this.logEl ? this.logEl.children : [])].map((c) => c.textContent.trim()).filter(Boolean);
    const head = [];
    const gpu = this.gpu;
    let app = "";
    try { app = (platformInfo() || {}).appVersion || ""; } catch (_) {}
    head.push(`appVersion ${app || "web"} · ${new Date().toISOString()}`);
    if (gpu) {
      head.push(`GPU: ${gpu.renderer || gpu.vendor || "?"} · ${gpu.webgl} · maxTexture ${gpu.maxTexture} · ${gpu.extensions} extensiones${gpu.software ? " · SOFTWARE (sin GPU)" : ""}`);
    }
    if (navigator.userAgent) head.push(`UA: ${navigator.userAgent}`);
    let text = head.join("\n") + "\n" + lines.join("\n");
    if (this.lastError && !text.includes(this.lastError)) text += "\nÚLTIMO ERROR: " + this.lastError;
    return text;
  }

  /** Writes the log to the phone's Downloads folder (no permission needed on Android 10+). */
  async saveLog() {
    const info = storageInfo();
    const name = `visor-sl-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    const res = await saveToDownloads(name, new TextEncoder().encode(this.logText()), "text/plain");
    if (!res) {
      this.log("Guardar en Descargas necesita la app Android. Registro copiable con ⧉.");
      return;
    }
    if (res.ok) this.log(`Registro guardado en Descargas como ${name}${info.cacheBytes ? ` (caché de texturas: ${(info.cacheBytes / 1048576).toFixed(1)} MB)` : ""}.`);
    else this.error("No se pudo guardar el registro: " + (res.error || "?"));
  }

  updateStats(s) {
    this.fpsEl.textContent = `${s.fps.toFixed(0)} fps`;
    this.trisEl.textContent = `${(s.tris / 1000).toFixed(1)}k tris`;
    this.objEl.textContent = `${s.objects} prims`;
  }

  showLogin() {
    const m = this.modalHost;
    m.innerHTML = "";
    m.classList.remove("hidden");
    const saved = prefsAll();
    const grid = el("select", {}, [
      el("option", { value: "agni", text: "Second Life (agni)" }),
      el("option", { value: "aditi", text: "Beta grid (aditi)" }),
    ]);
    if (saved["visor.last.grid"] === "aditi") grid.value = "aditi";
    const user = el("input", { class: "num wide", placeholder: "Usuario o Nombre Apellido", value: saved["visor.last.name"] || "" });
    const pass = el("input", { class: "num wide", type: "password", placeholder: "Contraseña" });
    const token = el("input", { class: "num wide", placeholder: "Código MFA de 6 dígitos (si lo pide)", autocomplete: "one-time-code" });
    const remember = el("input", { type: "checkbox", id: "rememberChk" });
    const rememberLabel = el("label", { class: "check" }, [
      remember,
      el("span", { text: " Guardar el acceso en este dispositivo (entrar sin escribir la contraseña)" }),
    ]);
    const status = el("div", { class: "hint", text: "" });
    const deviceHint = el("div", { class: "hint", text: "" });
    const close = () => { m.classList.add("hidden"); m.innerHTML = ""; };
    const key = (name) => grid.value + "." + String(name || "").trim().toLowerCase();
    const hashKey = (name) => "visor.hash." + key(name);
    const mfaKey = (name) => "visor.mfa." + key(name);
    let mfaHash = "";
    let savedHash = "";
    const reloadDevice = () => {
      const s = prefsAll();
      mfaHash = s[mfaKey(user.value)] || "";
      savedHash = s[hashKey(user.value)] || "";
      remember.checked = !!savedHash;
      deviceHint.textContent = mfaHash
        ? "Este móvil ya está verificado (MFA recordado): no necesitas código."
        : (savedHash
          ? "Acceso guardado: pulsa Entrar (no hace falta escribir la contraseña)."
          : "Si tu cuenta tiene verificación en dos pasos, escribe aquí el código de 6 dígitos.");
      pass.placeholder = savedHash ? "Contraseña (ya guardada — déjala vacía)" : "Contraseña";
    };
    user.addEventListener("input", reloadDevice);
    grid.addEventListener("change", reloadDevice);
    reloadDevice();
    const go = async (useSaved) => {
      status.textContent = "Conectando…";
      const code = token.value.replace(/\s+/g, "");
      const pw = pass.value;
      if (useSaved && !savedHash) { status.textContent = "No hay acceso guardado para ese usuario."; return; }
      if (!useSaved && !pw) { status.textContent = "Escribe la contraseña."; return; }
      try {
        const reply = await this.app.connect({
          grid: grid.value,
          name: user.value,
          password: pw,
          passwordHash: useSaved ? savedHash : (pw ? passwordHash(pw) : ""),
          token: code,
          mfaHash,
          status: (t) => status.textContent = t,
        });
        const returned = (reply && reply.mfa_hash) || "";
        if (returned) mfaHash = returned;
        const updates = {
          "visor.last.grid": grid.value,
          "visor.last.name": user.value.trim(),
          [mfaKey(user.value)]: mfaHash || null,
          [hashKey(user.value)]: (remember.checked || useSaved) ? (useSaved ? savedHash : passwordHash(pw)) : null,
        };
        prefsSet(updates);
        if (updates[hashKey(user.value)]) savedHash = updates[hashKey(user.value)];
        close();
        return;
      } catch (e) {
        const text = (e && e.message) || String(e);
        if (e && e.mfaHash) mfaHash = e.mfaHash;
        if (e && e.mfaChallenge) {
          status.textContent = "Escribe el código de verificación MFA y vuelve a pulsar Entrar.";
          token.value = "";
          token.focus();
          return;
        }
        status.textContent = "Error: " + text;
        this.error("Error al conectar: " + text);
        // Leave a full trace of the failure in the log panel (the modal can't be
        // copied) and check whether this network lets UDP out at all.
        try {
          await this.app.diagnoseUdp();
        } catch (err) {
          this.error("Diagnóstico: " + ((err && err.message) || err));
        }
      }
    };
    m.appendChild(el("div", { class: "modal" }, [
      el("h2", { text: "Conectar a Second Life" }),
      el("div", { class: "hint", text: "Tu contraseña sólo se envía al servidor de login de Linden Lab (como hash $1$ + md5, igual que cualquier visor)." }),
      grid, user, pass, token, deviceHint, rememberLabel, status,
      el("div", { class: "row" }, [
        el("button", { class: "btn accent", onclick: () => go(false), text: "Entrar" }),
        el("button", { class: "btn", onclick: () => go(true), text: "Entrar (acceso guardado)" }),
        el("button", { class: "btn", onclick: close, text: "Cancelar" }),
      ]),
      el("div", { class: "hint", text: "Sirve tanto el usuario de una sola palabra (cuentas nuevas) como «Nombre Apellido». Si el login falla, el motivo exacto que devuelve el servidor queda en el registro de abajo." }),
    ]));
  }

  hideModal() { this.modalHost.classList.add("hidden"); this.modalHost.innerHTML = ""; }

  /** Shows/hides the on-screen touch pad (only meaningful in the grid). */
  setTouchVisible(on) {
    if (this.app.touch) this.app.touch.setVisible(on);
  }
}
