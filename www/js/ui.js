// HUD / panels. Plain DOM, no framework.
import { md5Hex } from "./md5.js";
import { prefsAll, prefsSet, storageInfo, saveToDownloads, cacheClear, platformInfo } from "./transport.js";

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

export class UI {
  constructor(app) {    this.app = app;
    this.root = document.getElementById("hud");
    this.build();
    this.log("Visor SL listo. Inicia sesión con tu cuenta de Second Life.");
    const gpu = app.viewer && app.viewer.gpu;
    if (gpu) {
      this.gpu = gpu;
      this.log(`GPU: ${gpu.renderer || gpu.vendor || "desconocida"} · ${gpu.webgl} · texturas hasta ${gpu.maxTexture}px · ${gpu.extensions} extensiones` +
        (gpu.software ? " ⚠ renderizado por software (sin GPU): bajará la fluidez." : ""));
    }
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
      b("Diagnóstico de red y UDP", () => this.app.diagnoseUdp().catch((e) => this.error(e.message))),
      el("h3", { text: "Datos en el dispositivo" }),
      b("Guardar registro en Descargas", () => this.saveLog()),
      b("Borrar caché de texturas", async () => {
        const res = await cacheClear();
        this.log(res ? `Caché de texturas borrada (${res.deleted || 0} archivos).` : "No hay caché que borrar (hace falta la app Android).");
      }),
      b("Dónde se guardan los datos", () => {
        const s = storageInfo();
        this.log(`Almacenamiento: ${s.platform === "web" ? "navegador" : s.cacheDir || "?"} · caché ${((s.cacheBytes || 0) / 1048576).toFixed(1)} MB en ${s.cacheFiles || 0} archivos · libre ${(((s.freeBytes || 0)) / 1073741824).toFixed(1)} GB` +
          (s.needsPermission === false ? " · no hace falta permiso de almacenamiento (carpeta propia de la app)" : ""));
      }),
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
