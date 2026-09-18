// lslPanel.js -- la interfaz del mini-LSL: el editor de scripts del prim
// seleccionado (dentro del panel de construccion) y la consola/chat local
// (abajo a la izquierda), que es donde se ve lo que dicen los scripts y donde
// se escribe para que los `llListen` lo oigan.
//
// El editor trabaja sobre `prim.script` via el runtime: "Guardar y ejecutar"
// compila y arranca el script (como guardar un script en SL), "Reiniciar" lo
// vuelve a arrancar (borra estado, timer y listeners) y "Borrar" lo quita.

import { EXAMPLE_SCRIPTS } from "./lsl/examples.js";

export function createScriptPanel(opts) {
  const scripts = opts.scripts;
  const el = opts.ui.el;
  const btn = opts.ui.btn;
  const panel = opts.ui.panel;
  const toast = opts.toast || (() => {});
  const getPrim = opts.getPrim;
  const root = document.getElementById(opts.rootId || "buildScriptEl");

  const state = { prim: null, dirty: false, showEditor: false };
  let textarea = null;

  function render() {
    if (!root) return;
    const prim = getPrim ? getPrim() : null;
    // Si cambia el prim seleccionado se recarga el editor (y se pierde el
    // borrador sin guardar: se avisa en la barra de estado).
    if (prim !== state.prim) {
      state.prim = prim;
      state.dirty = false;
    }
    const box = panel(root, "Script (LSL)", "script");
    const info = prim ? scripts.info(prim) : null;

    const bar = el("div", "brow");
    bar.appendChild(btn("▶ Guardar y ejecutar", "on", apply, !prim));
    bar.appendChild(btn("⟲ Reiniciar", "", restart, !prim || !info.running));
    bar.appendChild(btn("🗑 Borrar", "bdanger", clearScript, !prim || !(info.source || info.running)));
    const exSel = el("select", "bsel");
    const o0 = el("option", null, "Ejemplos…");
    o0.value = "";
    exSel.appendChild(o0);
    for (const ex of EXAMPLE_SCRIPTS) {
      const o = el("option", null, ex.label);
      o.value = ex.key;
      exSel.appendChild(o);
    }
    exSel.addEventListener("change", () => {
      const ex = EXAMPLE_SCRIPTS.find((e) => e.key === exSel.value);
      exSel.value = "";
      if (!ex || !prim) return;
      setText(ex.source);
      state.dirty = true;
      toast("Ejemplo cargado: " + ex.label + " (pulsa Guardar y ejecutar)");
      render();
    });
    bar.appendChild(exSel);
    box.appendChild(bar);

    if (!prim) {
      box.appendChild(el("div", "bnote", "Selecciona un prim (clic en modo construcción) para ponerle un script."));
      return;
    }

    // Estado del script en una linea.
    const status = el("div", "bnote");
    if (info.error) {
      status.innerHTML = "<b style=\"color:#ffb3a7\">error</b> línea " + (info.error.line || "?") + ": " + esc(info.error.message);
    } else if (!info.source) {
      status.textContent = "sin script";
    } else {
      status.textContent = (info.running ? "corriendo" : "parado") +
        " · estado " + (info.state || "?") +
        (info.timer > 0 ? " · timer " + info.timer.toFixed(2) + " s" : "") +
        (info.listeners ? " · " + info.listeners + " listener" + (info.listeners > 1 ? "s" : "") : "") +
        (state.dirty ? " · SIN GUARDAR" : "");
    }
    box.appendChild(status);

    // El editor se despliega solo si ya hay script, o si el usuario lo pide: en
    // el movil un textarea grande tapa el resto del panel.
    const hasCode = !!info.source;
    if (!state.showEditor && !hasCode) {
      const toggle = btn("✎ Escribir un script", "", () => { state.showEditor = true; render(); });
      box.appendChild(toggle);
    } else {
      state.showEditor = true;
      const ta = document.createElement("textarea");
      ta.className = "bcode";
      ta.spellcheck = false;
      ta.rows = document.body.classList.contains("touch") ? 9 : 14;
      ta.value = scripts.getSource(prim) || "";
      ta.placeholder = "default\n{\n    state_entry()\n    {\n        llSay(0, \"Hola\");\n    }\n}";
      ta.addEventListener("input", () => {
        if (!state.dirty) { state.dirty = true; refreshStatusOnly(); }
      });
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const s = ta.selectionStart;
          ta.setRangeText("    ", s, ta.selectionEnd, "end");
          state.dirty = true;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); apply(); }
        e.stopPropagation();   // que no se muevan el avatar ni la camara al teclear
      });
      textarea = ta;
      box.appendChild(ta);
      box.appendChild(el("div", "bnote", "Ctrl+Enter guarda · coordenadas de región (128,128 = centro) · sin red · presupuesto por evento"));
    }
  }

  function refreshStatusOnly() {
    // Repinta solo la linea de estado sin tocar el textarea (si no, se perderia
    // el cursor mientras se escribe).
    if (!root) return;
    const lines = root.querySelectorAll(".bnote");
    const last = lines[lines.length - 1];
    if (last && state.dirty && last.textContent.indexOf("SIN GUARDAR") < 0 && last.textContent.indexOf("corriendo") >= 0) {
      last.textContent += " · SIN GUARDAR";
    }
  }

  function setText(src) {
    if (textarea) textarea.value = src;
    else { render(); if (textarea) textarea.value = src; }
  }

  function apply() {
    const prim = state.prim;
    if (!prim) return;
    const src = textarea ? textarea.value : (scripts.getSource(prim) || "");
    const r = scripts.setSource(prim, src);
    state.dirty = false;
    if (r.ok) toast("Script guardado y en marcha");
    else toast("El script tiene errores (línea " + (r.error.line || "?") + ")");
    render();
    if (opts.onChange) opts.onChange();
  }

  function restart() {
    const prim = state.prim;
    if (!prim) return;
    if (state.dirty) return apply();
    scripts.reset(prim);
    toast("Script reiniciado");
    render();
  }

  function clearScript() {
    const prim = state.prim;
    if (!prim) return;
    if (!window.confirm("¿Quitar el script de este prim?")) return;
    scripts.clear(prim);
    state.dirty = false;
    state.showEditor = false;
    toast("Script borrado");
    render();
    if (opts.onChange) opts.onChange();
  }

  return { render, state, focusEditor: () => { state.showEditor = true; render(); } };
}

// ---------------------------------------------------------------------------
// Chat local: lo que dicen los scripts y lo que escribe el usuario.
// ---------------------------------------------------------------------------

const KIND_CLASS = {
  user: "k-user", say: "k-say", whisper: "k-whisper", shout: "k-shout",
  owner: "k-owner", region: "k-region", debug: "k-debug", im: "k-owner",
  peer: "k-peer",
};
const KIND_TAG = { whisper: "susurra", say: "dice", shout: "grita", region: "difunde", owner: "te dice", im: "te susurra", debug: "avisa", peer: "" };

export function createChatPanel(opts) {
  const scripts = opts.scripts;
  const logEl = document.getElementById(opts.logId || "chatLogEl");
  const inputEl = document.getElementById(opts.inputId || "chatInputEl");
  const chanEl = document.getElementById(opts.channelId || "chatChannelEl");
  const whoEl = document.getElementById(opts.whoId || "chatWhoEl");
  const root = document.getElementById(opts.rootId || "chatCtn");
  const toggleEl = document.getElementById(opts.toggleId || "chatToggleEl");
  const bodyEl = document.getElementById(opts.bodyId || "chatBodyEl");
  let collapsed = opts.collapsed === true;

  function setCollapsed(v) {
    collapsed = v;
    if (bodyEl) bodyEl.hidden = collapsed;
    if (toggleEl) toggleEl.textContent = collapsed ? "▸" : "▾";
    if (root) root.classList.toggle("collapsed", collapsed);
  }
  if (toggleEl) toggleEl.addEventListener("click", () => setCollapsed(!collapsed));
  setCollapsed(collapsed);

  function line(entry) {
    if (!logEl) return;
    const row = document.createElement("div");
    row.className = "chatLine " + (KIND_CLASS[entry.kind] || "k-say") + (entry.outOfRange ? " out" : "");
    const who = document.createElement("span");
    who.className = "chatWho";
    who.textContent = entry.speaker + (KIND_TAG[entry.kind] ? " " + KIND_TAG[entry.kind] : "") + ":";
    const txt = document.createElement("span");
    txt.textContent = " " + entry.text;
    row.appendChild(who);
    row.appendChild(txt);
    if (entry.outOfRange) {
      const far = document.createElement("span");
      far.className = "chatFar";
      far.textContent = " (" + Math.round(entry.dist) + " m, fuera de alcance)";
      row.appendChild(far);
    }
    if (entry.channel) {
      const ch = document.createElement("span");
      ch.className = "chatFar";
      ch.textContent = " [" + entry.channel + "]";
      row.appendChild(ch);
    }
    logEl.appendChild(row);
    while (logEl.children.length > 160) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
    updateWho();
  }

  function updateWho() {
    if (!whoEl) return;
    const s = scripts.stats();
    whoEl.textContent = s.scripts === 0
      ? "ningún prim tiene script"
      : s.scripts + " script" + (s.scripts > 1 ? "s" : "") + " · " + s.listeners + " escuchando";
  }

  function send() {
    if (!inputEl) return;
    const text = inputEl.value;
    if (!text.trim()) return;
    inputEl.value = "";
    const ch = chanEl ? parseInt(chanEl.value, 10) : 0;
    scripts.chat(text, Number.isFinite(ch) ? ch : 0);
  }

  if (inputEl) {
    inputEl.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); send(); }
    });
  }
  const sendBtn = document.getElementById(opts.sendId || "chatSendBtn");
  if (sendBtn) sendBtn.addEventListener("click", send);

  scripts.on("chat", line);
  scripts.on("change", updateWho);
  scripts.on("log", (entry) => {
    if (entry.kind === "warn") line({ kind: "debug", speaker: entry.prim ? entry.prim.name : "visor", text: entry.text });
    else if (entry.kind === "state") line({ kind: "region", speaker: entry.prim ? entry.prim.name : "visor", text: entry.text });
    else if (entry.kind === "reset") line({ kind: "region", speaker: entry.prim ? entry.prim.name : "visor", text: entry.text });
  });
  scripts.on("error", (payload) => {
    const e = payload.error || {};
    line({ kind: "debug", speaker: payload.prim ? payload.prim.name : "visor", text: "error en " + (e.event || payload.phase) + (e.line ? " (línea " + e.line + ")" : "") + ": " + e.message });
  });

  updateWho();
  if (opts.hint) line({ kind: "region", speaker: "visor", text: opts.hint });

  return { line, setCollapsed, updateWho, element: root };
}

function esc(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
