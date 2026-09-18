// gameHUD.js -- los mandos de juego del visor: el minimapa de la esquina, el
// carril de menus de la derecha y los cajones que cuelgan de el (inventario,
// armario, mapa, sitios y ajustes).
//
// El minimapa y el mapa grande son el MISMO dibujo (`minimap.js`): aqui solo se
// les dice que trozo de mundo mirar y se les pasa lo que va encima (prims,
// residentes, sitios, el avatar con su rumbo). El mapa grande anade el marcador
// de destino y el boton de ir.
//
// Lo que hay que recordar entre sesiones vive en `kv`: los sitios que guarda el
// usuario y los ajustes de camara/rendimiento.

import { createMinimap } from "./minimap.js";
import { createWardrobe } from "./wardrobe.js";
import { createShapeEditor } from "./shapeEditor.js";
import { SHAPES } from "./prims.js";
import { primToItem } from "./store.js";
import diag from "./diag.js";

const HALF = 128;                 // media region en metros (la region mide 256x256)
const MINI_SPAN = 112;            // metros que abarca el minimapa
const MAP_MIN_SPAN = 22;
const MAP_MAX_SPAN = 420;

const SITE_COLORS = {
  spawn: "rgba(150, 235, 175, 0.95)",
  work: "rgba(255, 214, 120, 0.92)",
  build: "rgba(255, 180, 130, 0.95)",
  water: "rgba(140, 210, 255, 0.95)",
  peak: "rgba(236, 236, 246, 0.95)",
  mine: "rgba(150, 230, 255, 0.98)",
};

// Iconos del carril, en SVG de trazo (heredan el color del boton).
const ICONS = {
  inv: '<path d="M6 8.6h12v10.1a1.3 1.3 0 0 1-1.3 1.3H7.3A1.3 1.3 0 0 1 6 18.7V8.6Z"/><path d="M9 8.6V6.6a3 3 0 0 1 6 0v2"/><path d="M6 12.8h12"/>',
  shirt: '<path d="M9.3 4.2 4.6 6.4l1.7 4.2 2.2-.8V20h7V9.8l2.2.8 1.7-4.2-4.7-2.2Z"/><path d="M9.3 4.2c.5 1.5 4.9 1.5 5.4 0"/>',
  map: '<path d="M9.5 5.2 4 7.6v11.2l5.5-2.4 5 2.4 5.5-2.4V5.2l-5.5 2.4-5-2.4Z"/><path d="M9.5 5.2v11.2M14.5 7.6v11.2"/>',
  pin: '<path d="M12 20.4s5.7-5.9 5.7-9.6a5.7 5.7 0 1 0-11.4 0c0 3.7 5.7 9.6 5.7 9.6Z"/><circle cx="12" cy="10.6" r="2.1"/>',
  box: '<path d="M12 3.5 19.5 7.7v8.6L12 20.5 4.5 16.3V7.7L12 3.5Z"/><path d="M12 12.1 19.5 7.7M12 12.1 4.5 7.7M12 12.1v8.4"/>',
  chat: '<path d="M5 6.9A2.4 2.4 0 0 1 7.4 4.5h9.2A2.4 2.4 0 0 1 19 6.9v5.7a2.4 2.4 0 0 1-2.4 2.4h-6.3L5.8 18.6v-3.6A2.4 2.4 0 0 1 5 12.6V6.9Z"/>',
  gear: '<path d="M5 8h14M5 12h14M5 16h14"/><circle cx="9.5" cy="8" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7.5" cy="16" r="2"/>',
  body: '<circle cx="12" cy="6.2" r="3.1"/><path d="M12 10c-3.3 0-5.5 2-5.5 4.5V17h2.9v5h5.2v-5h2.9v-2.5C17.5 12 15.3 10 12 10Z"/>',
};

const RAIL = [
  { key: "inventario", label: "Inventario", icon: ICONS.inv },
  { key: "armario", label: "Armario", icon: ICONS.shirt },
  { key: "forma", label: "Forma", icon: ICONS.body },
  { key: "mapa", label: "Mapa", icon: ICONS.map },
  { key: "sitios", label: "Sitios", icon: ICONS.pin },
  { key: "construir", label: "Construir", icon: ICONS.box, action: true },
  { key: "chat", label: "Chat", icon: ICONS.chat, action: true },
  { key: "ajustes", label: "Ajustes", icon: ICONS.gear },
];

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined && html !== null) e.innerHTML = html;
  return e;
}

function button(label, cls, onClick) {
  const b = el("button", "bbtn" + (cls ? " " + cls : ""), label);
  b.type = "button";
  if (onClick) b.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
  return b;
}

export function createGameHUD(opts = {}) {
  const viewer = opts.viewer;
  const railEl = document.getElementById("gRail");
  const miniCtn = document.getElementById("gMiniCtn");
  const miniCanvas = document.getElementById("gMiniCanvas");
  const miniCoordEl = document.getElementById("gMiniCoordEl");
  const panelCtn = document.getElementById("gPanelCtn");
  if (!viewer || !railEl || !panelCtn) return null;

  const store = opts.store || null;
  const peers = opts.peers || null;
  const bt = opts.bt || null;
  const getSession = typeof opts.session === "function" ? opts.session : () => opts.session || null;
  const onToastExternal = opts.onToast || (() => {});
  const onAppearance = opts.onAppearance || (() => {});

  const kv = (typeof root !== "undefined" && root && root.kv) ? root.kv : null;
  const settingsFolder = kv ? kv.ajustes : null;
  const sitesFolder = kv ? kv.sitios : null;

  const offs = [];
  function on(target, type, fn, o) {
    if (!target) return;
    target.addEventListener(type, fn, o);
    offs.push([target, type, fn, o]);
  }

  // Aviso flotante: el HUD tiene el suyo propio para que los mensajes se vean
  // sin depender de que haya un panel abierto (el del editor de construccion
  // solo se ve dentro de ese editor).
  const toastEl = document.getElementById("gToastEl");
  let toastTimer = null;
  function onToast(text) {
    onToastExternal(text);
    if (!toastEl || !text) return;
    toastEl.textContent = text;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2400);
  }

  // --- almacenamiento: ajustes de camara -------------------------------------
  const settings = { invertY: false, sens: 0.0042, fov: 60, autoQuality: true, quality: 1 };
  let settingsTimer = null;

  function applySettings() {
    if (viewer.setInvertY) viewer.setInvertY(settings.invertY);
    if (viewer.setSensitivity) viewer.setSensitivity(settings.sens);
    if (viewer.setFov) viewer.setFov(settings.fov);
    if (viewer.setAutoQuality) viewer.setAutoQuality(settings.autoQuality);
    if (viewer.setQuality) viewer.setQuality(settings.quality);
  }

  async function loadSettings() {
    if (!settingsFolder) return;
    try {
      const s = await settingsFolder.get("camara");
      if (s && typeof s === "object") {
        if (typeof s.invertY === "boolean") settings.invertY = s.invertY;
        if (isFinite(s.sens)) settings.sens = Math.max(0.0015, Math.min(0.012, s.sens));
        if (isFinite(s.fov)) settings.fov = Math.max(45, Math.min(92, s.fov));
        if (typeof s.autoQuality === "boolean") settings.autoQuality = s.autoQuality;
        if (isFinite(s.quality)) settings.quality = Math.max(0.45, Math.min(1, s.quality));
        applySettings();
      }
    } catch (e) { /* sin ajustes guardados: se queda con los de por defecto */ }
  }

  function saveSettings() {
    if (!settingsFolder) return;
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => { try { settingsFolder.set("camara", settings); } catch (e) { /* noop */ } }, 700);
  }

  // --- sitios: los de la region + los que guarda el usuario ------------------
  let bookmarks = [];
  let bookmarksLoaded = false;

  async function loadBookmarks() {
    if (!sitesFolder) { bookmarksLoaded = true; return; }
    try {
      const ents = await sitesFolder.entries();
      bookmarks = ents
        .map(([name, v]) => ({ name, x: v && v.x, z: v && v.z }))
        .filter((b) => isFinite(b.x) && isFinite(b.z))
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "es"));
    } catch (e) { bookmarks = []; }
    bookmarksLoaded = true;
  }

  function regionSites() {
    const lm = (viewer.sandbox && viewer.sandbox.landmarks) || [];
    return lm.map((l) => ({
      name: l.name, x: l.x, y: l.y, z: l.z, kind: l.kind,
      color: SITE_COLORS[l.kind] || SITE_COLORS.work,
    }));
  }
  function mySites() {
    return bookmarks.map((b) => ({
      name: b.name, x: b.x, y: null, z: b.z, kind: "mine", mine: true,
      color: SITE_COLORS.mine,
    }));
  }
  function allSites() { return regionSites().concat(mySites()); }

  // --- ir a un sitio --------------------------------------------------------
  // La sesion con el retransmisor (si la hay) es la que manda: se le pide el
  // salto y ella mueve el avatar y avisa a la region. Sin sesion se mueve el
  // avatar directamente.
  function goTo(site) {
    const x = site.x, z = site.z;
    let th = 0;
    try { th = viewer.terrain.heightAt(x, z); } catch (e) { th = 0; }
    const y = (site.y === null || site.y === undefined) ? th + 0.4 : Math.max(th, site.y) + 0.5;
    const s = getSession();
    if (s && s.teleport) s.teleport(x, y, z);
    else viewer.teleport(x, y, z);
    onToast("Hacia «" + site.name + "»");
    if (document.body.classList.contains("touch")) closePanel();
  }

  async function saveSite(name, x, z) {
    if (!sitesFolder) { onToast("Sin almacenamiento para los sitios (falta el plugin kv)."); return false; }
    await sitesFolder.set(name, { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, savedAt: Date.now() });
    bookmarksLoaded = false;
    await loadBookmarks();
    onToast("Sitio guardado: " + name);
    return true;
  }

  async function saveHereAsSite(pick) {
    const p = pick || viewer.avatar.position;
    const name = window.prompt("Nombre del sitio:", "Sitio " + (bookmarks.length + 1));
    if (!name) return;
    await saveSite(name, p.x, p.z);
    if (openName === "sitios") renderSites();
  }

  async function deleteSite(site) {
    if (!sitesFolder) return;
    try { await sitesFolder.delete(site.name); } catch (e) { /* noop */ }
    bookmarksLoaded = false;
    await loadBookmarks();
    onToast("Sitio borrado: " + site.name);
    renderSites();
  }

  // --- lienzos ---------------------------------------------------------------
  function sizeCanvas(cv, cssW, cssH) {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const w = Math.max(16, Math.round(cssW * dpr));
    const h = Math.max(16, Math.round(cssH * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  const mini = createMinimap({ terrain: viewer.terrain, res: 256 });
  let miniCtx = null;
  let miniCss = { w: 0, h: 0 };
  const miniCenter = { x: viewer.avatar.position.x, z: viewer.avatar.position.z };

  function drawMini() {
    if (!miniCanvas || !miniCtn || miniCtn.offsetParent === null) return;
    const cssW = miniCanvas.clientWidth || 138;
    const cssH = miniCanvas.clientHeight || 138;
    if (cssW !== miniCss.w || cssH !== miniCss.h || !miniCtx) {
      miniCtx = sizeCanvas(miniCanvas, cssW, cssH);
      miniCss = { w: cssW, h: cssH };
    }
    const a = viewer.avatar.position;
    miniCenter.x += (a.x - miniCenter.x) * 0.14;
    miniCenter.z += (a.z - miniCenter.z) * 0.14;
    mini.draw(miniCtx, {
      w: cssW, h: cssH, view: mini.makeView(miniCenter.x, miniCenter.z, MINI_SPAN),
      objects: viewer.world.objects, world: viewer.world,
      peers: peers ? peers.list() : [],
      avatar: viewer.avatar,
      cameraYaw: viewer.cam ? viewer.cam.yaw : null,
      sites: allSites(), showGrid: true, labels: false,
    });
  }

  // El minimapa no debe quedar debajo de la barra del HUD (que al plegarse en
  // pantallas estrechas cambia de alto): se mide y se coloca debajo.
  function placeMini() {
    const hud = document.getElementById("hudTopCtn");
    if (!miniCtn || !hud) return;
    const b = hud.getBoundingClientRect();
    const top = Math.max(44, Math.min(Math.round(window.innerHeight * 0.42), Math.round(b.bottom) + 6));
    miniCtn.style.top = top + "px";
  }

  // --- cajones ---------------------------------------------------------------
  const panels = new Map();
  let openName = null;
  const railBtns = new Map();
  let diagPanelHandle = null;   // la ventana de depuracion vive dentro de Ajustes

  function addPanel(name, title, onOpen) {
    const p = el("div", "gpanel");
    p.hidden = true;
    const head = el("div", "gHead");
    head.appendChild(el("div", "gTitle", title));
    const close = el("button", "gClose", "&#10005;");
    close.type = "button";
    close.title = "Cerrar";
    close.addEventListener("click", () => closePanel());
    head.appendChild(close);
    const body = el("div", "gBody");
    p.appendChild(head);
    p.appendChild(body);
    panelCtn.appendChild(p);
    const rec = { el: p, body, onOpen };
    panels.set(name, rec);
    return rec;
  }

  function closePanel(silent) {
    if (openName) {
      const p = panels.get(openName);
      if (p) p.el.hidden = true;
    }
    openName = null;
    document.body.classList.remove("gpanel-open");
    if (!silent) paintRail();
  }

  function openPanel(name) {
    if (openName === name) { closePanel(); return; }
    const p = panels.get(name);
    if (!p) return;
    closePanel(true);
    openName = name;
    p.el.hidden = false;
    document.body.classList.add("gpanel-open");
    if (p.onOpen) p.onOpen();
    paintRail();
  }

  function paintRail() {
    for (const [k, b] of railBtns) {
      if (k === "construir") continue;
      b.classList.toggle("on", k === openName);
    }
  }

  // --- carril ---------------------------------------------------------------
  for (const item of RAIL) {
    const b = el("button", "gRailBtn");
    b.type = "button";
    b.title = item.label;
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + item.icon + "</svg>";
    b.appendChild(el("span", "gRailTip", item.label));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (item.action) railAction(item.key);
      else openPanel(item.key);
    });
    railEl.appendChild(b);
    railBtns.set(item.key, b);
  }

  function railAction(key) {
    if (key === "construir") {
      const btn = document.getElementById("buildToggleBtn");
      if (btn) btn.click();
      else onToast("El editor de construcción no está disponible.");
      return;
    }
    if (key === "chat") { openChat(); return; }
  }

  function openChat() {
    const body2 = document.getElementById("chatBodyEl");
    if (body2 && body2.hidden) {
      const head = document.getElementById("chatHeadEl");
      if (head) head.click();
    }
    const inp = document.getElementById("chatInputEl");
    if (inp) { inp.focus(); inp.scrollIntoView({ block: "nearest" }); }
  }

  // --- cajon: inventario ----------------------------------------------------
  async function renderInventory() {
    const p = panels.get("inventario");
    if (!p) return;
    const body = p.body;
    body.innerHTML = "";
    const head = el("div", "gBtns");
    head.appendChild(button("＋ Guardar prim", "gChip", saveSelection));
    head.appendChild(button("↻ Actualizar", "gChip", () => renderInventory()));
    body.appendChild(head);
    body.appendChild(el("div", "gLegend", "Toca un objeto para rezarlo delante de ti, apoyado en el suelo. «Guardar prim» toma el prim que tengas seleccionado en modo construcción."));
    if (!store || !store.available) {
      body.appendChild(el("div", "gLegend", "Sin almacenamiento: falta el plugin kv."));
      return;
    }
    const loading = el("div", "gLegend", "Cargando…");
    body.appendChild(loading);
    const items = await store.listItems();
    loading.remove();
    if (!items.length) {
      body.appendChild(el("div", "gLegend", "Vacío. Selecciona un prim en modo construcción y pulsa «Guardar prim»."));
      return;
    }
    const list = el("div", "gList");
    for (const it of items) {
      const row = el("div", "gRow");
      const main = button("", "gRowMain", () => {
        if (!bt) { onToast("Sin herramientas de construcción."); return; }
        bt.rezItem(it.item);
      });
      main.appendChild(el("span", "gIcon", (SHAPES[it.shape] || {}).icon || "•"));
      const nm = el("span", "gName");
      nm.textContent = it.name;
      main.appendChild(nm);
      row.appendChild(main);
      row.appendChild(button("×", "gRowDel", async () => {
        await store.deleteItem(it.name);
        onToast("Borrado del inventario: " + it.name);
        renderInventory();
      }));
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  async function saveSelection() {
    const sel = bt && bt.selection;
    if (!sel) { onToast("Primero selecciona un prim en modo construcción."); return; }
    if (!store || !store.available) { onToast("Sin almacenamiento."); return; }
    const name = window.prompt("Nombre en el inventario:", sel.name);
    if (!name) return;
    const item = primToItem(sel);
    item.name = name;
    await store.saveItem(name, item);
    onToast("En el inventario: " + name);
    renderInventory();
  }

  // --- cajon: armario -------------------------------------------------------
  let selfTimer = null;
  const wardrobe = createWardrobe({
    viewer, store, onToast,
    net: opts.net || null,
    onChanged: (app) => {
      onAppearance(app);
      if (selfTimer) clearTimeout(selfTimer);
      selfTimer = setTimeout(() => { try { wardrobe.saveSelf(); } catch (e) { /* noop */ } }, 800);
    },
  });

  // --- cajon: mapa ----------------------------------------------------------
  const map = { cx: viewer.avatar.position.x, cz: viewer.avatar.position.z, span: 160, pick: null };
  let mapCanvas = null, mapCtx = null;
  let mapCss = { w: 0, h: 0 };
  let mapInfoEl = null;

  function layoutMap() {
    if (!mapCanvas) return;
    const cssW = mapCanvas.clientWidth || 320;
    const cssH = mapCanvas.clientHeight || 320;
    if (cssW !== mapCss.w || cssH !== mapCss.h || !mapCtx) {
      mapCtx = sizeCanvas(mapCanvas, cssW, cssH);
      mapCss = { w: cssW, h: cssH };
    }
  }

  function drawMap() {
    if (!mapCanvas || !mapCtx) return;
    const w = mapCss.w, h = mapCss.h;
    const v = mini.makeView(map.cx, map.cz, map.span);
    mini.draw(mapCtx, {
      w, h, view: v,
      objects: viewer.world.objects, world: viewer.world,
      peers: peers ? peers.list() : [],
      avatar: viewer.avatar,
      cameraYaw: viewer.cam ? viewer.cam.yaw : null,
      sites: allSites(),
      showGrid: map.span < 330,
      labels: map.span < 260,
    });
    if (map.pick) drawPick(mapCtx, w, h, v);
  }

  function drawPick(ctx, w, h, v) {
    const a = viewer.avatar.position;
    const px = v.sx(map.pick.x, w), py = v.sy(map.pick.z, h);
    const ax = v.sx(a.x, w), ay = v.sy(a.z, h);
    const dist = Math.hypot(map.pick.x - a.x, map.pick.z - a.z);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 212, 121, 0.85)";
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px - 13, py); ctx.lineTo(px + 13, py);
    ctx.moveTo(px, py - 13); ctx.lineTo(px, py + 13);
    ctx.stroke();
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    const label = "destino · " + Math.round(dist) + " m";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(8, 12, 18, 0.85)";
    ctx.strokeText(label, px, py - 14);
    ctx.fillStyle = "#ffd479";
    ctx.fillText(label, px, py - 14);
    ctx.restore();
  }

  function zoomMap(k) {
    map.span = Math.max(MAP_MIN_SPAN, Math.min(MAP_MAX_SPAN, map.span * k));
    drawMap();
  }

  function updateMapInfo() {
    if (!mapInfoEl) return;
    const a = viewer.avatar.position;
    if (!map.pick) {
      mapInfoEl.textContent = "Toca el mapa para marcar un destino (arrastra para moverte por él).";
      return;
    }
    const dx = map.pick.x - a.x, dz = map.pick.z - a.z;
    const d = Math.hypot(dx, dz);
    const rumbo = (Math.atan2(-dx, -dz) * 180 / Math.PI + 360) % 360;
    mapInfoEl.innerHTML = "destino <b>SL " + Math.round(map.pick.x + HALF) + " / " + Math.round(HALF - map.pick.z) +
      "</b> · " + Math.round(d) + " m · rumbo " + Math.round(rumbo) + "°";
  }

  function buildMapPanel(p) {
    const wrap = el("div", "gMapWrap");
    mapCanvas = el("canvas", "gMapCanvas");
    mapCanvas.width = 320;
    mapCanvas.height = 320;
    // El lienzo va despues de los mandos: asi "Ir aquí", el zoom y el marcador
    // quedan siempre a la vista sin tener que desplazar el cajon.
    mapInfoEl = el("div", "gMapInfo");
    wrap.appendChild(mapInfoEl);

    const btns = el("div", "gBtns");
    btns.appendChild(button("Ir aquí", "gChip", () => {
      if (!map.pick) { onToast("Toca el mapa para elegir un destino."); return; }
      goTo({ x: map.pick.x, z: map.pick.z, y: null, name: "el destino marcado" });
    }));
    btns.appendChild(button("Centrar en mí", "gChip", () => {
      map.cx = viewer.avatar.position.x; map.cz = viewer.avatar.position.z; drawMap();
    }));
    btns.appendChild(button("＋", "gChip", () => zoomMap(1 / 1.35)));
    btns.appendChild(button("－", "gChip", () => zoomMap(1.35)));
    btns.appendChild(button("Región", "gChip", () => { map.span = 300; map.cx = 0; map.cz = 0; drawMap(); }));
    btns.appendChild(button("Guardar el destino", "gChip", () => { if (map.pick) saveHereAsSite(map.pick); else onToast("Primero marca un destino."); }));
    wrap.appendChild(btns);
    wrap.appendChild(mapCanvas);

    const legend = el("div", "gMapLegend");
    for (const [kind, txt] of [["spawn", "llegada"], ["work", "pruebas"], ["build", "edificios"], ["water", "agua"], ["peak", "cumbre"], ["mine", "mis sitios"]]) {
      const s = el("span", null);
      const i = el("i");
      i.style.background = SITE_COLORS[kind];
      s.appendChild(i);
      s.appendChild(document.createTextNode(txt));
      legend.appendChild(s);
    }
    wrap.appendChild(legend);
    p.body.appendChild(wrap);

    // Un dedo arrastra el mapa; un toque corto marca el destino.
    let md = null;
    on(mapCanvas, "pointerdown", (e) => {
      md = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
      try { mapCanvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
      e.preventDefault();
    });
    on(mapCanvas, "pointermove", (e) => {
      if (!md || e.pointerId !== md.id) return;
      const dx = e.clientX - md.x, dy = e.clientY - md.y;
      md.x = e.clientX; md.y = e.clientY;
      md.moved += Math.abs(dx) + Math.abs(dy);
      const pxPerM = (mapCss.w || 320) / map.span;
      map.cx -= dx / pxPerM;
      map.cz -= dy / pxPerM;
      drawMap();
      e.preventDefault();
    });
    on(mapCanvas, "pointerup", (e) => {
      if (!md || e.pointerId !== md.id) return;
      const tap = md.moved < 7;
      md = null;
      if (!tap) return;
      const r = mapCanvas.getBoundingClientRect();
      const v = mini.makeView(map.cx, map.cz, map.span);
      const wx = v.mx(e.clientX - r.left, mapCss.w || 320);
      const wz = v.mz(e.clientY - r.top, mapCss.h || 320);
      map.pick = {
        x: Math.max(-HALF, Math.min(HALF, wx)),
        z: Math.max(-HALF, Math.min(HALF, wz)),
      };
      updateMapInfo();
      drawMap();
    });
    on(mapCanvas, "pointercancel", () => { md = null; });
    on(mapCanvas, "wheel", (e) => { e.preventDefault(); zoomMap(e.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
  }

  function openMap() {
    map.cx = viewer.avatar.position.x;
    map.cz = viewer.avatar.position.z;
    layoutMap();
    updateMapInfo();
    drawMap();
  }

  // --- cajon: sitios --------------------------------------------------------
  function siteSection(title, sites, deletable) {
    const sec = el("div", "gSec");
    sec.appendChild(el("div", "gSecHead", title));
    if (!sites.length) {
      sec.appendChild(el("div", "gLegend", deletable
        ? "Todavía no has guardado ninguno. Usa «Guardar aquí»."
        : "—"));
      return sec;
    }
    const list = el("div", "gList");
    for (const s of sites) {
      const row = el("div", "gRow");
      const main = button("", "gRowMain", () => goTo(s));
      const dot = el("span", "gSiteDot");
      dot.style.background = s.color;
      main.appendChild(dot);
      const txt = el("span", "gSiteTxt");
      const nm = el("span", "gSiteName");
      nm.textContent = s.name;
      const co = el("div", "gRowSub");
      co.textContent = "SL " + Math.round(s.x + HALF) + " / " + Math.round(HALF - s.z) +
        (s.y !== null && s.y !== undefined ? " · " + Math.round(s.y) + " m" : "");
      txt.appendChild(nm);
      txt.appendChild(co);
      main.appendChild(txt);
      row.appendChild(main);
      if (deletable) row.appendChild(button("×", "gRowDel", () => deleteSite(s)));
      list.appendChild(row);
    }
    sec.appendChild(list);
    return sec;
  }

  async function renderSites() {
    const p = panels.get("sitios");
    if (!p) return;
    const body = p.body;
    const note = "Toca un sitio para ir. Los de arriba los declara la región; los de abajo son tuyos.";
    if (!bookmarksLoaded) {
      body.innerHTML = "";
      body.appendChild(el("div", "gLegend", "Cargando…"));
      await loadBookmarks();
    }
    body.innerHTML = "";
    const head = el("div", "gBtns");
    head.appendChild(button("＋ Guardar aquí", "gChip", () => saveHereAsSite(null)));
    head.appendChild(button("↻ Actualizar", "gChip", () => { bookmarksLoaded = false; renderSites(); }));
    body.appendChild(head);
    body.appendChild(el("div", "gLegend", note));
    body.appendChild(siteSection("Lugares de la región", regionSites(), false));
    body.appendChild(siteSection("Mis sitios", mySites(), true));
  }

  // --- cajon: ajustes -------------------------------------------------------
  function checkRow(label, checked, onChange) {
    const lab = el("label", "bcheck wrCheck");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!checked;
    cb.addEventListener("change", () => onChange(cb.checked));
    lab.appendChild(cb);
    lab.appendChild(el("span", null, label));
    return lab;
  }

  function rangeRow(label, min, max, step, value, fmt, onInput) {
    const row = el("div", "wrRow");
    const inp = el("input", "wrRange");
    inp.type = "range";
    inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(value);
    const val = el("span", "wrVal", fmt(value));
    inp.addEventListener("input", () => { val.textContent = fmt(parseFloat(inp.value)); onInput(parseFloat(inp.value), false); });
    inp.addEventListener("change", () => { onInput(parseFloat(inp.value), true); });
    row.appendChild(el("span", "wrLab", label));
    row.appendChild(inp);
    row.appendChild(val);
    return { row, input: inp, val };
  }

  function renderSettings() {
    const p = panels.get("ajustes");
    if (!p) return;
    const body = p.body;
    body.innerHTML = "";

    const camSec = el("div", "gSec");
    camSec.appendChild(el("div", "gSecHead", "Cámara"));
    camSec.appendChild(checkRow("Invertir el eje vertical al mirar", settings.invertY, (v) => {
      settings.invertY = v; applySettings(); saveSettings();
    }));
    camSec.appendChild(rangeRow("Sensibilidad", 0.0015, 0.012, 0.0005, settings.sens,
      (v) => Math.round((v / 0.0042) * 100) + " %",
      (v, done) => { settings.sens = v; applySettings(); if (done) saveSettings(); }).row);
    camSec.appendChild(rangeRow("Campo de visión", 45, 92, 1, settings.fov,
      (v) => Math.round(v) + "°",
      (v, done) => { settings.fov = v; applySettings(); if (done) saveSettings(); }).row);
    const camBtns = el("div", "gBtns");
    camBtns.appendChild(button("Recentrar cámara", "gChip", () => { viewer.recenter(); onToast("Cámara detrás del avatar."); }));
    camSec.appendChild(camBtns);
    camSec.appendChild(el("div", "gLegend", "Arrastrar un dedo (o el ratón) gira la cámara: hacia arriba mira arriba y hacia la derecha gira a la derecha. La pinza de dos dedos acerca."));
    body.appendChild(camSec);

    const hourSec = el("div", "gSec");
    hourSec.appendChild(el("div", "gSecHead", "Hora del día"));
    const hb = el("div", "gBtns");
    for (const [label, h] of [["Amanecer", 7], ["Mediodía", 12], ["Atardecer", 19.2], ["Noche", 23.5]]) {
      hb.appendChild(button(label, "gChip", () => { viewer.setTime(h); onToast(label + " (" + h + ":00)"); }));
    }
    hourSec.appendChild(hb);
    body.appendChild(hourSec);

    const qSec = el("div", "gSec");
    qSec.appendChild(el("div", "gSecHead", "Rendimiento"));
    qSec.appendChild(checkRow("Calidad automática (ajusta la resolución sola)", settings.autoQuality, (v) => {
      settings.autoQuality = v; applySettings(); saveSettings(); renderSettings();
    }));
    const qRow = rangeRow("Escala", 0.45, 1, 0.05, settings.quality,
      (v) => Math.round(v * 100) + " %",
      (v, done) => { settings.quality = v; applySettings(); if (done) saveSettings(); });
    qRow.input.disabled = settings.autoQuality;
    if (settings.autoQuality) qRow.row.style.opacity = "0.55";
    qSec.appendChild(qRow.row);
    const q = viewer.quality ? viewer.quality() : null;
    qSec.appendChild(el("div", "gLegend", q
      ? "Ahora: " + Math.round(q.scale * 100) + " % de resolución · " + Math.round(q.dpr * 100) / 100 +
        "× de densidad de píxeles · antialias " + (q.aa ? "sí" : "no")
      : ""));
    qSec.appendChild(el("div", "gBtns")).appendChild(button("Restablecer", "gChip", () => {
      settings.invertY = false; settings.sens = 0.0042; settings.fov = 60;
      settings.autoQuality = true; settings.quality = 1;
      applySettings(); saveSettings(); renderSettings();
      onToast("Ajustes de la vista restablecidos.");
    }));
    body.appendChild(qSec);

    const keySec = el("div", "gSec");
    keySec.appendChild(el("div", "gSecHead", "Controles"));
    keySec.appendChild(el("div", "gLegend",
      "WASD andar · Mayús correr · Espacio saltar · C volar · E/Q subir y bajar · F cámara libre · " +
      "B construir · G rejilla · 1-4 hora · P pausa · H ocultar el HUD."));
    keySec.appendChild(el("div", "gLegend",
      "En el móvil: joystick a la izquierda (el borde corre), arrastrar a la derecha para mirar, botones de Salto/Correr/Volar a la derecha."));
    body.appendChild(keySec);

    // --- depuracion e informes ---------------------------------------------
    // Los mandos viven aqui (y no en un cajon propio) para que el informe se
    // pueda generar sin salir de Ajustes. La ventana se rehace cada vez porque
    // este panel se repinta entero: hay que soltar la anterior antes.
    const dbgSec = el("div", "gSec");
    dbgSec.appendChild(el("div", "gSecHead", "Depuración e informes"));
    dbgSec.appendChild(el("div", "gLegend",
      "Anota lo que va pasando (errores, avisos, estado del visor) y arma un informe de texto. " +
      "Si algo falla en el móvil: reproduce el fallo, abre aquí, guarda o comparte el informe, y tráelo para revisarlo."));
    if (diagPanelHandle) { try { diagPanelHandle.dispose(); } catch (e) { /* noop */ } diagPanelHandle = null; }
    const dgHost = el("div", "dgHost");
    dbgSec.appendChild(dgHost);
    diagPanelHandle = diag.panel({ mount: dgHost, onToast });
    body.appendChild(dbgSec);
  }

  // --- cajon: forma del avatar ---------------------------------------------
  // El editor de forma de SL colgado del avatar de la region (ver shapeEditor.js).
  let shapeEditor = null;
  function renderShape() {
    const p = panels.get("forma");
    if (!p) return;
    if (shapeEditor) { try { shapeEditor.dispose(); } catch (e) { /* noop */ } shapeEditor = null; }
    p.body.innerHTML = "";
    p.body.appendChild(el("div", "gLegend",
      "Los mandos del editor de forma de Second Life: deforman el cuerpo de sistema (morphs y huesos) " +
      "igual que en SL. La forma se guarda sola y es la que verás al volver a entrar."));
    shapeEditor = createShapeEditor({ viewer, mount: p.body, onToast });
  }

  // --- montaje --------------------------------------------------------------
  addPanel("inventario", "Inventario", () => renderInventory());
  addPanel("armario", "Armario", () => { if (wardrobe) wardrobe.render(panels.get("armario").body); });
  addPanel("mapa", "Mapa de la región", () => {
    if (!mapCanvas) buildMapPanel(panels.get("mapa"));
    openMap();
  });
  addPanel("sitios", "Sitios", () => renderSites());
  addPanel("ajustes", "Ajustes", () => renderSettings());
  addPanel("forma", "Forma del avatar", () => renderShape());

  if (miniCanvas) {
    on(miniCanvas, "click", (e) => { e.preventDefault(); openPanel("mapa"); });
  }
  const recenterBtn = document.getElementById("gMiniRecenterBtn");
  if (recenterBtn) {
    on(recenterBtn, "click", (e) => { e.preventDefault(); viewer.recenter(); onToast("Cámara detrás del avatar."); });
  }
  const backdrop = document.getElementById("gBackdropEl");
  if (backdrop) on(backdrop, "click", (e) => { e.preventDefault(); closePanel(); });
  on(window, "keydown", (e) => { if (e.code === "Escape" && openName) closePanel(); });
  on(window, "resize", () => { placeMini(); if (openName === "mapa") { layoutMap(); drawMap(); } });

  placeMini();
  applySettings();
  loadSettings();
  loadBookmarks();

  // En el telefono la franja de datos nace plegada (deja ver el mundo) y se
  // despliega con un toque. Es cosa del HUD, asi que vive aqui y no en app.js.
  const footCtn = document.getElementById("hudFootCtn");
  if (footCtn && document.body.classList.contains("touch")) {
    document.body.classList.add("foot-fold");
    on(footCtn, "click", (e) => {
      if (e.target && e.target.closest("a, button, input, select, textarea")) return;
      document.body.classList.toggle("foot-fold");
      placeMini();
    });
    // El plegado cambia la altura de la barra, pero el navegador no ha vuelto a
    // medirla todavia: hay que esperar un fotograma o el minimapa salta.
    requestAnimationFrame(placeMini);
  }

  // --- bucle ----------------------------------------------------------------
  let acc = 0, coordAcc = 0;
  function update(dt) {
    dt = dt || 0;
    acc += dt;
    if (acc > 0.085) {
      acc = 0;
      drawMini();
      if (openName === "mapa") { layoutMap(); drawMap(); }
    }
    coordAcc += dt;
    if (coordAcc > 0.3) {
      coordAcc = 0;
      if (miniCoordEl) {
        const p = viewer.avatar.position;
        miniCoordEl.textContent = "SL " + Math.round(p.x + HALF) + " / " + Math.round(HALF - p.z);
      }
      placeMini();
    }
    if (bt && railBtns.has("construir")) {
      const b = railBtns.get("construir");
      const active = !!bt.state.active;
      if (b._act !== active) { b._act = active; b.classList.toggle("on", active); }
    }
  }

  function dispose() {
    if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null; }
    if (selfTimer) { clearTimeout(selfTimer); selfTimer = null; }
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (diagPanelHandle) { try { diagPanelHandle.dispose(); } catch (e) { /* noop */ } diagPanelHandle = null; }
    if (shapeEditor) { try { shapeEditor.dispose(); } catch (e) { /* noop */ } shapeEditor = null; }
    if (toastEl) toastEl.hidden = true;
    if (wardrobe) { try { wardrobe.saveSelf(); } catch (e) { /* noop */ } }
    for (const [t, type, fn, o] of offs) { try { t.removeEventListener(type, fn, o); } catch (e) { /* noop */ } }
    offs.length = 0;
    document.body.classList.remove("foot-fold");
    closePanel(true);
    document.body.classList.remove("gpanel-open");
    for (const p of panels.values()) p.el.remove();
    panels.clear();
    for (const b of railBtns.values()) b.remove();
    railBtns.clear();
    openName = null;
  }

  return {
    update, dispose, open: openPanel, close: () => closePanel(),
    isOpen: () => openName, wardrobe,
    settings,
    sites: () => allSites(),
    minimap: mini,
  };
}
