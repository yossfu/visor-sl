// wardrobe.js -- el armario: el aspecto del avatar propio (cuerpo, cara, piel,
// pelo y ropa), con la misma idea que el editor de aspecto de Second Life.
//
// El aspecto es un objeto de datos (ver `avatarParams.js`): parametros 0..1 mas
// un conjunto de prendas por ranura. Editarlo aqui solo cambia esos numeros; la
// geometria y las texturas se generan de nuevo a partir de ellos. Se puede
// guardar en `kv` con nombre (como un "outfit" de SL) y recuperarlo de un toque.
//
// Ojo con el cuerpo: el avatar puede llevar el cuerpo de SISTEMA de SL, que trae
// su propia malla y sus propias texturas y NO mira los parametros. Los
// deslizadores solo se ven en el cuerpo parametrico, asi que al tocar cualquier
// control el armario cambia a ese y avisa. El boton de arriba permite volver al
// cuerpo de sistema (que es el que se parece a un residente de verdad).

import {
  PARAMS, PARAM_GROUPS, OUTFIT_SLOTS, HAIR_STYLES, SKIN_TONES, HAIR_COLORS,
  CLOTH_COLORS, CLOTH_PATTERNS, defaultAppearance, randomAppearance, normalizeAppearance,
} from "./avatarParams.js";

function hexOf(n) {
  return "#" + ((n >>> 0) & 0xffffff).toString(16).padStart(6, "0");
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined && html !== null) e.innerHTML = html;
  return e;
}

function button(label, cls, onClick) {
  const b = el("button", "bbtn" + (cls ? " " + cls : ""), label);
  b.type = "button";
  b.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
  return b;
}

// Las tres ranuras que aceptan tela estampada; el pelo, el sombrero y las gafas
// solo llevan color.
const PATTERN_SLOTS = ["top", "bottom", "outer", "shoes"];

export function createWardrobe(opts = {}) {
  const viewer = opts.viewer;
  const store = opts.store || null;
  const onToast = opts.onToast || (() => {});
  const onChanged = opts.onChanged || (() => {});
  const getNet = opts.net || (() => null);

  let root = null;
  let folded = {};
  let applyTimer = 0;
  let lastApply = 0;
  let savedList = null;

  const avatar = () => viewer.avatar;
  const pack = () => (avatar() ? avatar().appearance : null);

  // --- aplicar cambios -------------------------------------------------------
  // Rehacer la malla parametrica cuesta varios milisegundos, asi que mientras se
  // arrastra un deslizador se aplica como mucho cada 90 ms, y al soltar (o al
  // tocar un color) se aplica en el acto.
  function apply(immediate) {
    const wantNow = () => performance.now() - lastApply > 90;
    if (applyTimer) { clearTimeout(applyTimer); applyTimer = 0; }
    const run = () => {
      applyTimer = 0;
      lastApply = performance.now();
      const av = avatar();
      if (!av) return;
      // Los parametros solo tienen efecto en el cuerpo parametrico.
      if (av.opts && av.opts.realBody) {
        av.setBodyMode(false);
        onToast("Cuerpo editable activado (el de sistema no usa los parámetros).");
      }
      av.setAppearance(pack());
      onChanged(pack());
    };
    if (immediate || wantNow()) run();
    else applyTimer = setTimeout(run, 90);
  }

  function mutate(fn, immediate) {
    const app = pack();
    if (!app) return;
    fn(app);
    apply(immediate);
  }

  // --- controles -------------------------------------------------------------
  function slider(parent, label, min, max, step, value, fmt, onInput) {
    const row = el("div", "wrRow");
    const lab = el("span", "wrLab", label);
    const val = el("span", "wrVal", fmt(value));
    const inp = el("input", "wrRange");
    inp.type = "range";
    inp.min = String(min); inp.max = String(max); inp.step = String(step);
    inp.value = String(value);
    inp.addEventListener("input", () => { val.textContent = fmt(parseFloat(inp.value)); onInput(parseFloat(inp.value), false); });
    inp.addEventListener("change", () => { val.textContent = fmt(parseFloat(inp.value)); onInput(parseFloat(inp.value), true); });
    row.appendChild(lab);
    row.appendChild(inp);
    row.appendChild(val);
    parent.appendChild(row);
    return inp;
  }

  function swatches(parent, colors, value, onPick, cls) {
    const row = el("div", "wrSwatches" + (cls ? " " + cls : ""));
    for (const c of colors) {
      const b = el("button", "wrSwatch" + (c === value ? " on" : ""));
      b.type = "button";
      b.style.background = hexOf(c);
      b.title = hexOf(c);
      b.addEventListener("click", (e) => { e.preventDefault(); onPick(c); });
      row.appendChild(b);
    }
    parent.appendChild(row);
    return row;
  }

  function chips(parent, values, value, onPick, labelOf) {
    const row = el("div", "wrChips");
    for (const v of values) {
      const b = button(labelOf ? labelOf(v) : (v === null ? "lisa" : v), "wrChip" + (v === value ? " on" : ""), () => onPick(v));
      row.appendChild(b);
    }
    parent.appendChild(row);
    return row;
  }

  function check(parent, label, checked, onChange) {
    const lab = el("label", "bcheck wrCheck");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!checked;
    cb.addEventListener("change", () => onChange(cb.checked));
    lab.appendChild(cb);
    lab.appendChild(el("span", null, label));
    parent.appendChild(lab);
    return cb;
  }

  function section(parent, title, key, render) {
    const isFolded = !!folded[key];
    const box = el("div", "wrSec");
    const head = el("div", "wrHead");
    head.appendChild(el("span", null, title));
    const mark = el("span", "bfold", isFolded ? "\u25B8" : "\u25BE");
    head.appendChild(mark);
    const body = el("div", "wrBody");
    body.hidden = isFolded;
    head.addEventListener("click", () => {
      folded[key] = !folded[key];
      body.hidden = folded[key];
      mark.textContent = folded[key] ? "\u25B8" : "\u25BE";
    });
    box.appendChild(head);
    box.appendChild(body);
    parent.appendChild(box);
    render(body);
    return body;
  }

  // --- secciones -------------------------------------------------------------
  function renderBody(root2) {
    const p = pack();
    if (!p) return;
    const bodyMode = el("div", "wrRow wrMode");
    bodyMode.appendChild(el("span", "wrLab", "Cuerpo"));
    const av = avatar();
    const isReal = !!(av.opts && av.opts.realBody);
    const row = el("div", "wrChips");
    row.appendChild(button("De sistema (SL)", "wrChip" + (isReal ? " on" : ""), () => {
      if (av.setBodyMode(true)) onToast("Cuerpo de sistema de Second Life.");
      refresh();
    }));
    row.appendChild(button("Editable", "wrChip" + (!isReal ? " on" : ""), () => {
      if (av.setBodyMode(false)) onToast("Cuerpo paramétrico (el que sigue al armario).");
      refresh();
    }));
    bodyMode.appendChild(row);
    root2.appendChild(bodyMode);
    root2.appendChild(el("div", "wrNote", isReal
      ? "El cuerpo de sistema usa su propia malla y no sigue a los deslizadores. Toca cualquier control y el armario cambia solo al editable."
      : "El cuerpo editable se genera con estos parámetros: es el que responde a todo lo de abajo."));

    for (const g of PARAM_GROUPS) {
      if (g === "Piel" || g === "Pelo") continue;
      section(root2, g, "g_" + g, (b) => {
        for (const pdef of PARAMS.filter((x) => x.group === g)) {
          const cur = p.params[pdef.key] === undefined ? pdef.def : p.params[pdef.key];
          slider(b, pdef.label, 0, 1, 0.01, cur,
            (v) => (pdef.real ? pdef.real(v) : Math.round(v * 100) + " %"),
            (v, done) => mutate((a) => { a.params[pdef.key] = v; }, done));
        }
      });
    }

    section(root2, "Piel", "g_Piel", (b) => {
      slider(b, "Brillo", 0, 1, 0.01, p.params.brillo, (v) => Math.round(v * 100) + " %",
        (v, done) => mutate((a) => { a.params.brillo = v; }, done));
      b.appendChild(el("div", "wrLabel", "Tono"));
      swatches(b, SKIN_TONES, p.skin.color, (c) => mutate((a) => { a.skin.color = c; }, true));
    });

    section(root2, "Pelo", "g_Pelo", (b) => {
      slider(b, "Largo", 0, 1, 0.01, p.params.peloLargo, (v) => Math.round(v * 100) + " %",
        (v, done) => mutate((a) => { a.params.peloLargo = v; }, done));
      slider(b, "Volumen", 0, 1, 0.01, p.params.peloVolumen, (v) => Math.round(v * 100) + " %",
        (v, done) => mutate((a) => { a.params.peloVolumen = v; }, done));
      b.appendChild(el("div", "wrLabel", "Estilo"));
      const hair = p.outfit.hair || {};
      chips(b, HAIR_STYLES, hair.tipo, (t) => mutate((a) => { a.outfit.hair.tipo = t; }, true));
      b.appendChild(el("div", "wrLabel", "Color"));
      swatches(b, HAIR_COLORS, hair.color, (c) => mutate((a) => { a.outfit.hair.color = c; }, true));
    });

    section(root2, "Ropa", "g_Ropa", (b) => {
      for (const slot of OUTFIT_SLOTS) {
        const o = p.outfit[slot.key] || {};
        const box = el("div", "wrSlot");
        box.appendChild(el("div", "wrLabel", slot.label));
        chips(box, slot.types, o.tipo, (t) => mutate((a) => { a.outfit[slot.key].tipo = t; }, true));
        if (slot.key !== "hair") {
          swatches(box, CLOTH_COLORS, o.color, (c) => mutate((a) => { a.outfit[slot.key].color = c; }, true), "small");
        }
        if (PATTERN_SLOTS.indexOf(slot.key) >= 0) {
          chips(box, CLOTH_PATTERNS, o.patron === undefined ? null : o.patron,
            (pt) => mutate((a) => { a.outfit[slot.key].patron = pt; }, true));
        }
        b.appendChild(box);
      }
    });
  }

  function renderOutfits(root2) {
    const box = el("div", "wrSec");
    box.appendChild(el("div", "wrLabel", "Conjuntos guardados"));
    const saveRow = el("div", "brow");
    const nameInput = el("input", "btext wrName");
    nameInput.type = "text";
    nameInput.placeholder = "nombre del conjunto";
    nameInput.value = (pack() && pack().name) || "Mi aspecto";
    saveRow.appendChild(nameInput);
    saveRow.appendChild(button("Guardar", "", async () => {
      if (!store || !store.available) { onToast("Sin almacenamiento (falta el plugin kv)."); return; }
      const name = (nameInput.value || "aspecto").slice(0, 40);
      await store.saveAppearance(name, pack());
      savedList = null;
      onToast("Conjunto guardado: " + name);
      refresh();
    }));
    box.appendChild(saveRow);

    const row = el("div", "brow");
    row.appendChild(button("Aleatorio", "", () => {
      const name = (pack() && pack().name) || "Residente";
      avatar().setAppearance(randomAppearance(Math.floor(Math.random() * 1e9), name));
      apply(true);
      refresh();
    }));
    row.appendChild(button("Por defecto", "", () => {
      const name = (pack() && pack().name) || "Residente";
      avatar().setAppearance(defaultAppearance(name));
      apply(true);
      refresh();
    }));
    box.appendChild(row);

    if (!store || !store.available) {
      box.appendChild(el("div", "wrNote", "Sin almacenamiento: falta el plugin kv."));
      return;
    }
    if (savedList === null) {
      box.appendChild(el("div", "wrNote", "Cargando…"));
      store.listAppearances().then((list) => { savedList = list || []; refresh(); });
      return;
    }
    if (!savedList.length) {
      box.appendChild(el("div", "wrNote", "Todavía no hay conjuntos guardados."));
      return;
    }
    const list = el("div", "wrSaved");
    for (const it of savedList) {
      const r = el("div", "brow");
      const b = button("\uD83D\uDC55 " + it.name, "wrSavedBtn", async () => {
        const saved = await store.loadAppearance(it.name);
        if (!saved) { onToast("No se pudo leer " + it.name); return; }
        avatar().setAppearance(normalizeAppearance(saved));
        apply(true);
        refresh();
        onToast("Puesto: " + it.name);
      });
      r.appendChild(b);
      r.appendChild(button("×", "binvdel", async () => {
        await store.deleteAppearance(it.name);
        savedList = null;
        onToast("Borrado: " + it.name);
        refresh();
      }));
      list.appendChild(r);
    }
    box.appendChild(list);
  }

  function render(rootEl) {
    root = rootEl || root;
    if (!root) return;
    root.innerHTML = "";
    const p = pack();
    if (!p) {
      root.appendChild(el("div", "wrNote", "El armario solo está disponible dentro de una escena con avatar."));
      return;
    }
    renderBody(root);
    renderOutfits(root);
  }

  function refresh() { if (root) render(root); }

  // Carga el aspecto guardado como propio ("self"). Se llama al arrancar el
  // visor, antes o despues de montar el mundo, y solo pisa el aspecto si hay
  // algo guardado.
  async function loadSelf() {
    if (!store || !store.available) return false;
    try {
      const saved = await store.loadAppearance("self");
      if (!saved || !avatar()) return false;
      avatar().setAppearance(normalizeAppearance(saved));
      return true;
    } catch (e) { return false; }
  }

  // Guarda el aspecto propio sin preguntar (lo hace el visor al salir, para no
  // perder el look entre sesiones).
  async function saveSelf() {
    if (!store || !store.available || !avatar()) return false;
    try { return await store.saveAppearance("self", pack()); } catch (e) { return false; }
  }

  return { render, refresh, loadSelf, saveSelf, current: pack, setBodyModeEditable: () => apply(true) };
}
