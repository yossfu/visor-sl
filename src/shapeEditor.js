// shapeEditor.js -- el editor de FORMA del avatar del mundo.
//
// Es el mismo editor que el del banco de pruebas (`#bodytest/forma`), pero
// colgado del avatar que se esta usando en la region: los mandos son los
// parametros visuales de `avatar_lad.xml` (altura, corpulencia, hombros, cara,
// genero...), resueltos a morphs de las mallas de sistema y a deltas de hueso.
// Mover un mando DEFORMA el cuerpo igual que en el editor de aspecto de Second
// Life, porque son los mismos numeros del mismo XML.
//
// Lo que se elige aqui se guarda (`shapeStore.js`) y es lo que el avatar usara
// la proxima vez que se abra el visor; tambien viaja en el aspecto que se manda
// por la red, asi que los demas ven la misma forma.
//
// El editor necesita que el cuerpo de sistema (`avatarRealBody.js`) haya
// terminado de cargar: hasta entonces ensena un aviso y espera.

import { loadAvatarLad, defaultShapeValues, genderedShapeValues, randomShapeValues, shapeSliders, avatarLadSummary } from "./sl/avatarLad.js";
import { clearStoredShape } from "./sl/shapeStore.js";
import { diag } from "./diag.js";

const PRESETS = [
  { key: "defecto", label: "De fábrica" },
  { key: "femenina", label: "Femenina" },
  { key: "masculina", label: "Masculina" },
  { key: "aleatoria", label: "Aleatoria" },
];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function button(label, cls, onClick) {
  const b = el("button", "bbtn" + (cls ? " " + cls : ""), label);
  b.type = "button";
  b.addEventListener("click", (ev) => { ev.preventDefault(); onClick(); });
  return b;
}

export function createShapeEditor(opts = {}) {
  const viewer = opts.viewer;
  const host = opts.mount;
  const onToast = opts.onToast || (() => {});
  const root = el("div", "raShape raInPanel");
  if (host) host.appendChild(root);

  let table = null;
  let groupKey = null;
  let disposed = false;
  let saveTimer = null;
  let waitTimer = null;
  const rows = [];          // { id, input, val, showVal, slider }

  if (!viewer || !host) {
    root.appendChild(el("div", "raHint", "El editor de forma necesita el visor."));
    return { el: root, refresh: () => {}, dispose: () => root.remove() };
  }

  function sl() { return viewer.slAppearance; }

  function countText() {
    const a = sl();
    if (!a || !a.resolved) return "sin resolver";
    const r = a.resolved;
    return r.counts.morphs + " morphs · " + r.counts.bones + " huesos · " + r.counts.volumes + " volúmenes · "
      + a.describeSex() + "\n" + avatarLadSummary(table);
  }

  function refreshCount() {
    const c = root.querySelector(".raCount");
    if (c) c.textContent = countText();
  }

  // Guarda el cambio en el aspecto del avatar (y por tanto en kv) sin hacerlo en
  // cada fotograma del arrastre: se espera a que el dedo pare.
  function commitSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const a = sl();
      if (!a) return;
      viewer.setShape(a.snapshot());
    }, 450);
  }

  function refreshSliders() {
    const a = sl();
    for (const r of rows) {
      if (!a) break;
      const v = a.getValue(r.id, r.slider.def);
      r.input.value = String(v);
      r.showVal();
    }
    refreshCount();
  }

  function applyPreset(key) {
    const a = sl();
    if (!a || !table) return;
    a.setSex("auto");
    if (key === "defecto") a.setValues(defaultShapeValues(table));
    else if (key === "femenina") a.setValues(genderedShapeValues(table, "female", { seed: "visor" }));
    else if (key === "masculina") a.setValues(genderedShapeValues(table, "male", { seed: "visor" }));
    else if (key === "aleatoria") a.setValues(randomShapeValues(table, "aleatoria:" + Math.round(performance.now()), { amount: 0.6 }));
    a.applyShape();
    refreshSliders();
    viewer.setShape(a.snapshot());
    onToast("Forma «" + key + "» aplicada.");
    diag.info("forma", "preset «" + key + "» aplicado al avatar del mundo: " + a.describe());
  }

  function build() {
    root.textContent = "";

    const tabs = el("div", "raTabs");
    for (const p of PRESETS) tabs.appendChild(button(p.label, "gChip", () => applyPreset(p.key)));
    root.appendChild(tabs);

    const sel = document.createElement("select");
    for (const g of shapeSliders(table)) {
      const o = document.createElement("option");
      o.value = g.key;
      o.textContent = g.label + " (" + g.sliders.length + ")";
      sel.appendChild(o);
    }
    if (!groupKey) groupKey = shapeSliders(table)[0].key;
    sel.value = groupKey;
    sel.addEventListener("change", () => { groupKey = sel.value; renderGroup(); });
    root.appendChild(sel);

    const list = el("div", "raSliders");
    list.dataset.role = "sliders";
    root.appendChild(list);

    root.appendChild(el("div", "raCount", ""));
    root.appendChild(el("div", "raHint",
      "Son los mandos del editor de forma de SL: mueven morphs y huesos reales del cuerpo de sistema. " +
      "La forma se guarda sola y se aplica tambien al avatar de la región."));

    const btns = el("div", "gBtns");
    btns.appendChild(button("Guardar ahora", "gChip", () => {
      const a = sl();
      if (!a) return;
      viewer.setShape(a.snapshot());
      onToast("Forma guardada.");
    }));
    btns.appendChild(button("Olvidar la guardada", "gChip", async () => {
      await clearStoredShape();
      onToast("Forma olvidada: se usará la de fábrica al volver a entrar.");
    }));
    root.appendChild(btns);

    renderGroup();
    refreshCount();
  }

  function renderGroup() {
    const list = root.querySelector('[data-role="sliders"]');
    if (!list) return;
    list.textContent = "";
    rows.length = 0;
    const a = sl();
    if (!a || !table) return;
    const groups = shapeSliders(table);
    const group = groups.find((g) => g.key === groupKey) || groups[0];
    if (!group) return;
    for (const s of group.sliders) {
      const row = el("div", "raSlider" + (s.gender ? " raGender" : ""));
      const lab = el("div", "raLab");
      lab.appendChild(el("span", null, s.label));
      const val = el("span", "raVal", "");
      lab.appendChild(val);
      const input = document.createElement("input");
      input.type = "range";
      input.min = s.min; input.max = s.max; input.step = (s.max - s.min) / 200 || 0.01;
      input.value = String(a.getValue(s.id, s.def));
      const showVal = () => {
        val.textContent = s.gender ? (Number(input.value) > 0.5 ? "masculino" : "femenino") : Number(input.value).toFixed(2);
      };
      showVal();
      input.addEventListener("input", () => {
        showVal();
        const av = sl();
        if (!av) return;
        // El mando de género manda: el sexo se vuelve a derivar de él, como en
        // el editor de forma del visor de SL.
        if (s.gender) av.setSex("auto");
        av.setValue(s.id, parseFloat(input.value));
        av.applyShape();
        refreshCount();
        commitSoon();
      });
      row.appendChild(lab);
      row.appendChild(input);
      if (s.gender) {
        const ends = el("div", "raEnds");
        ends.appendChild(el("span", null, s.labelMin || ""));
        ends.appendChild(el("span", null, s.labelMax || ""));
        row.appendChild(ends);
      }
      list.appendChild(row);
      rows.push({ id: s.id, input, val, showVal, slider: s });
    }
  }

  // Espera a que el cuerpo de sistema este listo y a que exista el SLAppearance.
  function waitForAvatar() {
    if (disposed) return;
    const a = sl();
    if (!a) {
      root.textContent = "";
      root.appendChild(el("div", "raHint", "Cargando el cuerpo de sistema de Second Life… el editor de forma aparecerá en un momento."));
      waitTimer = setTimeout(waitForAvatar, 400);
      return;
    }
    root.textContent = "";
    root.appendChild(el("div", "raHint", "Cargando la tabla de forma de SL…"));
    loadAvatarLad().then((t) => {
      if (disposed) return;
      table = t;
      build();
    }).catch((e) => {
      if (disposed) return;
      root.textContent = "";
      root.appendChild(el("div", "raHint", "No se pudo cargar avatar_lad.xml: " + (e && e.message ? e.message : e)));
    });
  }

  waitForAvatar();

  return {
    el: root,
    refresh: () => { refreshSliders(); },
    get ready() { return !!table; },
    dispose() {
      disposed = true;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
      root.remove();
    },
  };
}
