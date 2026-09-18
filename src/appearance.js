// appearance.js -- panel de apariencia por cara (la pestana "Texture" del build
// floater de SL, adaptada al tactil).
//
// Trabaja sobre la cara elegida con el raton/dedo (o sobre todas si se marca
// "todas las caras") y escribe en `obj.faces[i]`, que es lo que `world.js`
// convierte en un material por cara. Nada de estado propio: el modelo vive en
// el prim, y este modulo solo lo lee y lo pinta.
//
// Las texturas disponibles son las recetas procedurales de `textures.js` mas
// las que suba el usuario (foto del telefono, reducida a 384 px) y las de una
// URL externa.

import { emptyFace, faceIsDefault, faceSpec } from "./faces.js";
import { patternThumb, allPatterns } from "./textures.js";

export function createAppearance(opts) {
  const world = opts.world;
  const el = opts.ui.el;
  const panel = opts.ui.panel;
  const toast = opts.toast || (() => {});
  const getTarget = opts.getTarget;
  const onChange = opts.onChange || (() => {});
  const root = document.getElementById(opts.ui.rootId || "buildFaceAppEl");

  // Estado solo de interfaz (no del modelo): si se esta editando una URL, si el
  // bloque de ajustes finos esta desplegado, y que cara "todas" esta activa.
  const ui = { urlOpen: false, urlValue: "", showAdvanced: false, all: false };

  function target() {
    const t = getTarget ? getTarget() : null;
    if (!t || !t.obj || !t.obj.mesh) return null;
    const n = Math.max(1, t.obj.volume ? t.obj.volume.faces.length : 1);
    let faces = t.faces || [];
    if (ui.all) {
      faces = [];
      for (let i = 0; i < n; i++) faces.push(i);
    }
    faces = faces.filter((i) => i >= 0 && i < n);
    return { obj: t.obj, faces, n, index: faces.length === 1 ? faces[0] : null };
  }

  // Rejistro "representativo" del objetivo: si hay varias caras, se usa la
  // primera no vacia para mostrar los controles con algo coherente.
  function sampleFace(tg) {
    if (!tg) return null;
    if (!tg.faces.length) return null;
    const obj = tg.obj;
    for (const i of tg.faces) {
      const f = obj.faces ? obj.faces[i] : null;
      if (f && !faceIsDefault(f)) return { f, i };
    }
    const i = tg.faces[0];
    return { f: (obj.faces && obj.faces[i]) || emptyFace(), i };
  }

  function facesLabel(tg) {
    if (!tg) return "Sin selección";
    if (!tg.faces.length) return "Sin cara elegida";
    if (ui.all) return "Todas las caras (" + tg.faces.length + ")";
    if (tg.faces.length === 1) {
      const info = world.faceInfo(tg.obj)[tg.faces[0]];
      return "Cara " + (tg.faces[0] + 1) + (info && info.label ? " · " + info.label : "");
    }
    return tg.faces.length + " caras";
  }

  function apply(patch) {
    const tg = target();
    if (!tg || !tg.faces.length) { toast("Elige una cara primero"); return false; }
    world.setFace(tg.obj, tg.faces, patch);
    onChange();
    return true;
  }

  // --- widgets --------------------------------------------------------------
  function row() { return el("div", "brow"); }
  function label(text) { return el("span", "blabel", text); }

  function slider(parent, text, min, max, step, value, fmt, onInput) {
    const r = row();
    r.appendChild(label(text));
    const s = el("input", "brange");
    s.type = "range";
    s.min = min; s.max = max; s.step = step;
    s.value = value;
    const v = el("span", "bval", fmt(value));
    s.addEventListener("input", () => {
      v.textContent = fmt(parseFloat(s.value));
      onInput(parseFloat(s.value));
    });
    r.appendChild(s);
    r.appendChild(v);
    parent.appendChild(r);
    return s;
  }

  function check(parent, text, checked, onChange_) {
    const lab = el("label", "bcheck");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!checked;
    cb.addEventListener("change", () => onChange_(cb.checked));
    lab.appendChild(cb);
    lab.appendChild(el("span", null, text));
    parent.appendChild(lab);
    return cb;
  }

  function num(parent, text, value, step, onChange_) {
    const r = row();
    r.appendChild(label(text));
    const inp = el("input", "bnum");
    inp.type = "number";
    inp.step = step;
    inp.value = value;
    inp.addEventListener("change", () => onChange_(parseFloat(inp.value)));
    r.appendChild(inp);
    parent.appendChild(r);
    return inp;
  }

  // --- imagen de usuario ----------------------------------------------------
  // Se reduce a 384 px (una cara de prim se ve como mucho a un par de metros) y
  // se guarda como data URL JPEG: asi viaja con el autoguardado y el JSON de
  // exportacion sin depender de un servicio de subida.
  function shrinkToDataUrl(file, cb) {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 384;
        const s = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
        const w = Math.max(1, Math.round((img.width || max) * s));
        const h = Math.max(1, Math.round((img.height || max) * s));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        cb(c.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => { toast("No se pudo leer la imagen"); };
      img.src = fr.result;
    };
    fr.onerror = () => { toast("No se pudo leer el archivo"); };
    fr.readAsDataURL(file);
  }

  let nextImageId = 1;
  function applyImageData(dataUrl) {
    const tex = { d: dataUrl, id: "u" + nextImageId++ };
    if (apply({ tex })) toast("Textura aplicada");
  }

  // --- panel ----------------------------------------------------------------
  function render() {
    if (!root) return;
    const tg = target();
    const smp = sampleFace(tg);
    const box = panel(root, "Apariencia · " + facesLabel(tg), "faceapp");

    const erow = row();
    check(erow, "A todas las caras", ui.all, (v) => { ui.all = v; render(); });
    box.appendChild(erow);

    if (!tg || !tg.faces.length) {
      box.appendChild(el("div", "bnote", "Toca una cara del prim para elegirla, o marca \"A todas las caras\"."));
      box.appendChild(el("div", "bsub", "Consejo: en modo Mover, toca el prim para seleccionarlo."));
      return;
    }

    // --- texturas procedurales
    const grid = el("div", "btexgrid");
    const none = el("button", "btex" + (!smp || !smp.f.tex ? " on" : ""), "<span>sin<br>textura</span>");
    none.type = "button";
    none.addEventListener("click", (e) => { e.preventDefault(); if (apply({ tex: null })) render(); });
    grid.appendChild(none);
    for (const rec of allPatterns()) {
      const b = el("button", "btex", "");
      b.type = "button";
      b.title = rec.label;
      const url = patternThumb(rec.key);
      if (url) b.style.backgroundImage = "url(" + url + ")";
      const on = smp && smp.f.tex && smp.f.tex.k === rec.key;
      if (on) b.classList.add("on");
      b.addEventListener("click", (e) => {
        e.preventDefault();
        if (apply({ tex: { k: rec.key } })) render();
      });
      grid.appendChild(b);
    }
    box.appendChild(grid);

    // --- foto propia / URL
    const urow = row();
    const file = el("input");
    file.type = "file";
    file.accept = "image/*";
    file.style.display = "none";
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (f) shrinkToDataUrl(f, applyImageData);
      file.value = "";
    });
    const upBtn = el("button", "bbtn", "Subir foto");
    upBtn.type = "button";
    upBtn.addEventListener("click", (e) => { e.preventDefault(); file.click(); });
    urow.appendChild(upBtn);
    const urlBtn = el("button", "bbtn" + (ui.urlOpen ? " on" : ""), "Desde URL");
    urlBtn.type = "button";
    urlBtn.addEventListener("click", (e) => { e.preventDefault(); ui.urlOpen = !ui.urlOpen; render(); });
    urow.appendChild(urlBtn);
    urow.appendChild(file);
    box.appendChild(urow);

    if (ui.urlOpen) {
      const r2 = row();
      const inp = el("input", "btext");
      inp.type = "text";
      inp.placeholder = "https://…/textura.jpg";
      inp.value = ui.urlValue;
      inp.addEventListener("input", () => { ui.urlValue = inp.value; });
      const go = el("button", "bbtn", "Cargar");
      go.type = "button";
      go.addEventListener("click", (e) => {
        e.preventDefault();
        const u = ui.urlValue.trim();
        if (!/^https?:\/\//i.test(u) && !u.startsWith("data:")) { toast("URL no valida"); return; }
        if (apply({ tex: { u } })) render();
      });
      r2.appendChild(inp);
      r2.appendChild(go);
      box.appendChild(r2);
      box.appendChild(el("div", "bnote", "Si la web no deja leer la imagen (CORS), se vera el color plano."));
    }

    // --- color de la cara
    const crow = row();
    crow.appendChild(label("Color"));
    const pick = el("input", "bpick");
    pick.type = "color";
    pick.value = "#" + hex6(smp && smp.f.color !== null && smp.f.color !== undefined ? smp.f.color : specColor(tg));
    pick.addEventListener("input", () => { apply({ color: parseInt(pick.value.slice(1), 16) }); });
    crow.appendChild(pick);
    const primBtn = el("button", "bbtn", "Del prim");
    primBtn.type = "button";
    primBtn.addEventListener("click", (e) => { e.preventDefault(); if (apply({ color: null })) render(); });
    crow.appendChild(primBtn);
    box.appendChild(crow);

    // Paleta rapida (los mismos colores del panel de prims).
    const prow = row();
    prow.classList.add("bswrow");
    for (const hex of PALETTE) {
      const sw = el("button", "bsw" + (smp && smp.f.color === hex ? " on" : ""));
      sw.type = "button";
      sw.style.background = "#" + hex6(hex);
      sw.addEventListener("click", (e) => { e.preventDefault(); apply({ color: hex }); });
      prow.appendChild(sw);
    }
    box.appendChild(prow);

    // --- transparencia / brillo
    slider(box, "Transp.", 0, 100, 1, Math.round(((smp && smp.f.alpha) ?? 1) * 100), (v) => v + "%",
      (v) => apply({ alpha: v / 100 }));
    slider(box, "Brillo", 0, 100, 1, Math.round(((smp && smp.f.glow) || 0) * 100), (v) => v + "%",
      (v) => apply({ glow: v / 100 }));

    const frow = row();
    check(frow, "Fullbright", smp && smp.f.fullbright, (v) => apply({ fullbright: v }));
    check(frow, "Recorte", smp && smp.f.mask, (v) => apply({ mask: v }));
    check(frow, "Doble cara", smp && smp.f.doubleSide, (v) => apply({ doubleSide: v }));
    box.appendChild(frow);

    // --- ajustes finos (repetir / desplazar / rotar / material)
    const av = el("div", "bbody");
    const rrow = row();
    rrow.appendChild(label("Repetir"));
    rrow.appendChild(numInput(rrow, (smp && smp.f.repeat[0]) ?? 1, 0.25, (v) => {
      const f = (smp && smp.f.repeat) || [1, 1];
      apply({ repeat: [clampNum(v, -64, 64), f[1]] });
    }));
    rrow.appendChild(numInput(rrow, (smp && smp.f.repeat[1]) ?? 1, 0.25, (v) => {
      const f = (smp && smp.f.repeat) || [1, 1];
      apply({ repeat: [f[0], clampNum(v, -64, 64)] });
    }));
    av.appendChild(rrow);

    const orow = row();
    orow.appendChild(label("Desplazar"));
    orow.appendChild(numInput(orow, (smp && smp.f.offset[0]) ?? 0, 0.05, (v) => {
      const f = (smp && smp.f.offset) || [0, 0];
      apply({ offset: [clampNum(v, -64, 64), f[1]] });
    }));
    orow.appendChild(numInput(orow, (smp && smp.f.offset[1]) ?? 0, 0.05, (v) => {
      const f = (smp && smp.f.offset) || [0, 0];
      apply({ offset: [f[0], clampNum(v, -64, 64)] });
    }));
    av.appendChild(orow);

    slider(av, "Rotar", 0, 360, 1, Math.round((((smp && smp.f.rotation) || 0) * 180 / Math.PI + 360) % 360), (v) => v + "\u00B0",
      (v) => apply({ rotation: v * Math.PI / 180 }));

    slider(av, "Rugosidad", 0, 100, 1, Math.round((smp ? faceSpec(tg.obj, 0, smp.f).rough : 0.62) * 100), (v) => v + "%",
      (v) => apply({ rough: v / 100 }));
    slider(av, "Metálico", 0, 100, 1, Math.round((smp ? faceSpec(tg.obj, 0, smp.f).metal : 0.05) * 100), (v) => v + "%",
      (v) => apply({ metal: v / 100 }));

    const arow = row();
    const resetBtn = el("button", "bbtn bdanger", "Reiniciar cara");
    resetBtn.type = "button";
    resetBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (apply(Object.assign(emptyFace(), { tex: null, color: null }))) render();
    });
    arow.appendChild(resetBtn);
    const allBtn = el("button", "bbtn", "A todas las caras");
    allBtn.type = "button";
    allBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const t2 = getTarget ? getTarget() : null;
      if (!t2 || !t2.obj) return;
      const n = Math.max(1, t2.obj.volume ? t2.obj.volume.faces.length : 1);
      const all = [];
      for (let i = 0; i < n; i++) all.push(i);
      if (smp) world.setFace(t2.obj, all, { tex: smp.f.tex, color: smp.f.color, alpha: smp.f.alpha, glow: smp.f.glow });
      onChange();
      toast("Aplicado a " + n + " caras");
    });
    arow.appendChild(allBtn);
    av.appendChild(arow);

    av.hidden = !ui.showAdvanced;
    const toggle = el("button", "bbtn bsub2", ui.showAdvanced ? "Ocultar ajustes finos" : "Mostrar ajustes finos");
    toggle.type = "button";
    toggle.addEventListener("click", (e) => { e.preventDefault(); ui.showAdvanced = !ui.showAdvanced; render(); });
    box.appendChild(toggle);
    box.appendChild(av);
  }

  function numInput(parent, value, step, onChange_) {
    const inp = el("input", "bnum");
    inp.type = "number";
    inp.step = step;
    inp.value = value;
    inp.addEventListener("change", () => onChange_(parseFloat(inp.value)));
    parent.appendChild(inp);
    return inp;
  }

  function clampNum(v, a, b) {
    if (!isFinite(v)) return 0;
    return Math.max(a, Math.min(b, v));
  }

  function specColor(tg) {
    const s = faceSpec(tg.obj, 0, (tg.obj.faces && tg.obj.faces[0]) || null);
    return s.color;
  }

  function hex6(n) {
    return ("000000" + (n >>> 0).toString(16)).slice(-6);
  }

  return {
    render,
    setAll(v) { ui.all = !!v; render(); },
    isAll() { return ui.all; },
    apply,
    target,
  };
}

// Los mismos 16 colores de la paleta del panel de prims (build.js).
const PALETTE = [
  0xb9c2cf, 0xffffff, 0xd94f4f, 0xe0913a, 0xefd75a, 0x7fc45c, 0x3fa7a0, 0x4a7fd6,
  0x8a5cd6, 0xd05fa8, 0x7a5230, 0x4a4038, 0x2b2f38, 0x000000, 0x9ad0ff, 0xc9a24a,
];
