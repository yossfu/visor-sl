// terrainTools.js -- el editor de terreno: el pincel de esculpido de SL.
//
// En SL el "Terrain Editor" (menu World > Region/Estate > Terrain) tiene un
// pincel con tamaño 2/4/8/16/32, fuerza 1-100 y seis herramientas: subir,
// bajar, aplanar, alisar, rugosidad y revertir, mas un rectangulo de seleccion
// ("Apply to selection") que aplica el pincel a toda el area elegida.
//
// Aqui el pincel NO reescribe las alturas: escribe un delta en `terrain.sculpt`
// (ver `region.js`) y actualiza solo los vertices que toca. Eso es lo que hace
// que sea fluido en un movil: un trazo de 8 m toca ~200 vertices de los 16.000
// de la malla, y no hay que recalcular normales de toda la region.
//
// Todo el estado del pincel (herramienta, tamaño, fuerza, rectangulo) es
// independiente del resto del editor, asi que este modulo no sabe nada de prims:
// se comunica con `build.js` por tres sitios: el panel (`ui.panel`), el
// historial (`history.pushTerrain`) y los eventos de puntero.

const TOOLS = [
  { id: "raise", label: "Subir" },
  { id: "lower", label: "Bajar" },
  { id: "flatten", label: "Aplanar" },
  { id: "smooth", label: "Alisar" },
  { id: "rough", label: "Rugosidad" },
  { id: "revert", label: "Revertir" },
];
const SIZES = [2, 4, 8, 16, 32];

const MIN_H = -12;              // metros: por debajo del fondo del mar no aporta
const MAX_H = 220;
const HINT = "Arrastra sobre el terreno para pintar. Desactiva «Pintar» si quieres mover la cámara.";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function createTerrainTools(opts = {}) {
  const T = opts.T;
  const terrain = opts.terrain;
  const terrainMesh = opts.terrainMesh;
  const water = opts.water || null;
  const camera = opts.camera;
  const canvas = opts.canvas;
  const scene = opts.scene;
  const cam = opts.cam || null;
  const ui = opts.ui;                 // { el, btn, panel }
  const history = opts.history || null;
  const toast = opts.toast || (() => {});
  const onChange = opts.onChange || (() => {});   // para el autoguardado
  const el = ui.el, btn = ui.btn;

  const state = {
    enabled: false,
    tool: "raise",
    radius: 8,
    strength: 0.5,
    paint: true,           // arrastrar pinta (si no, arrastrar mueve la camara)
    marquee: false,        // arrastrar define un rectangulo de seleccion
    sel: null,             // { x0, x1, z0, z1 } en metros
    selDraft: null,
    hover: null,
    painting: false,
    strokes: 0,
    lastWater: 0,
  };

  const els = { terrain: document.getElementById("buildTerrainEl") };

  // --- raycast contra el terreno --------------------------------------------
  // NO se usa `Raycaster` contra la malla del terreno: son 33.000 triangulos y
  // three.js los prueba todos, lo que en un movil es un tiron de 10-30 ms por
  // cada evento de puntero. En su lugar se avanza el rayo por la rejilla de
  // alturas (unos cientos de pasos de `heightAt`, que es bilineal y barato) y se
  // afina por biseccion. Es ademas mas robusto: no depende de la malla.
  const ray = new T.Raycaster();
  const ndc = new T.Vector2();
  let rectCache = null, rectKey = "", rectTime = 0;

  function marchTerrain(org, dir) {
    const half = terrain.size / 2;
    const dx = dir.x, dz = dir.z;
    let tmin = 0, tmax = 3000;
    if (Math.abs(dx) > 1e-6) {
      const a = (-half - org.x) / dx, b = (half - org.x) / dx;
      tmin = Math.max(tmin, Math.min(a, b));
      tmax = Math.min(tmax, Math.max(a, b));
    } else if (org.x < -half || org.x > half) return null;
    if (Math.abs(dz) > 1e-6) {
      const a = (-half - org.z) / dz, b = (half - org.z) / dz;
      tmin = Math.max(tmin, Math.min(a, b));
      tmax = Math.min(tmax, Math.max(a, b));
    } else if (org.z < -half || org.z > half) return null;
    if (tmax <= tmin) return null;

    const step = Math.max(0.35, terrain.step * 0.6);
    const at = (t) => org.y + dir.y * t - terrain.heightAt(org.x + dx * t, org.z + dz * t);
    let t = tmin, d = at(t);
    if (d < 0) return null;                     // la camara esta bajo el terreno
    // Si el rayo va hacia arriba y ya esta por encima del pico, no va a bajar
    // nunca: no tiene sentido seguir marchando (mirando al cielo).
    const peak = terrain.peak === undefined ? Infinity : terrain.peak;
    for (let i = 0; i < 4000; i++) {
      if (dir.y >= 0 && org.y + dir.y * t > peak) return null;
      const nt = t + step;
      if (nt > tmax) return null;
      const nd = at(nt);
      if (nd <= 0) {
        // Biseccion: 14 iteraciones dejan el punto a menos de un milimetro.
        let lo = t, hi = nt;
        for (let k = 0; k < 14; k++) {
          const mid = (lo + hi) / 2;
          if (at(mid) > 0) lo = mid; else hi = mid;
        }
        const tt = (lo + hi) / 2;
        return new T.Vector3(org.x + dx * tt, org.y + dir.y * tt, org.z + dz * tt);
      }
      t = nt; d = nd;
    }
    return null;
  }

  function canvasRect() {
    // `getBoundingClientRect` fuerza un recalculo de layout: llamarlo en cada
    // evento de puntero costaba mas que todo el raycast. La caja del canvas solo
    // cambia al redimensionar, asi que se cachea con una caducidad corta.
    const key = window.innerWidth + "x" + window.innerHeight;
    const now = performance.now();
    if (!rectCache || rectKey !== key || now - rectTime > 500) {
      rectCache = canvas.getBoundingClientRect();
      rectKey = key;
      rectTime = now;
    }
    return rectCache;
  }

  function terrainPoint(clientX, clientY) {
    if (!canvas.getBoundingClientRect) return null;
    const r = canvasRect();
    if (!r.width || !r.height) return null;
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const org = ray.ray.origin, dir = ray.ray.direction;
    let p = marchTerrain(org, dir);
    if (!p) {
      // Fuera de la region (o mirando al cielo): se corta con el plano del nivel
      // del mar para que el pincel siga teniendo una posicion sensata.
      if (Math.abs(dir.y) < 1e-4) return null;
      const t = (terrain.waterLevel - org.y) / dir.y;
      if (t <= 0) return null;
      p = org.clone().addScaledVector(dir, t);
    }
    const lim = terrain.size / 2 - terrain.step;
    p.x = clamp(p.x, -lim, lim);
    p.z = clamp(p.z, -lim, lim);
    p.y = terrain.heightAt(p.x, p.z);
    return p;
  }

  // --- pincel ---------------------------------------------------------------
  // Perfil del pincel: nucleo duro y borde suave (el de SL tambien es redondeado
  // y no un cono perfecto).
  function profile(d, R) { return 1 - smoothstep(R * 0.55, R, d); }

  // Escribe un "toque" del pincel centrado en (cx, cz) y devuelve los limites de
  // vertices tocados. `dt` son segundos de pintado (para que la fuerza sea una
  // velocidad y no dependa de la tasa de refresco).
  function dab(cx, cz, dt, out) {
    const R = state.radius;
    const rng = terrain.vertexRange(cx - R, cx + R, cz - R, cz + R);
    const sc = terrain.ensureSculpt(), h = terrain.heights, n = terrain.n;
    const s = state.strength;
    const tool = state.tool;
    const target = state._flattenAt === undefined ? terrain.heightAt(cx, cz) : state._flattenAt;
    const rate = s * (0.9 + R * 0.16);                    // m/s al subir/bajar
    const kFlat = clamp(s * 5 * dt, 0, 1);
    const kSmooth = clamp(s * 4.5 * dt, 0, 1);
    const kRough = s * 1.6 * (0.6 + R * 0.1) * dt;
    const kRev = clamp(s * 5 * dt, 0, 1);
    for (let j = rng.j0; j <= rng.j1; j++) {
      const wz = terrain.vertexZ(j);
      const dz = wz - cz;
      for (let i = rng.i0; i <= rng.i1; i++) {
        const wx = terrain.vertexX(i);
        const d = Math.hypot(wx - cx, dz);
        if (d > R) continue;
        const w = profile(d, R);
        if (w <= 0.001) continue;
        const k = j * n + i;
        const cur = h[k];
        let delta = 0;
        if (tool === "raise") delta = rate * dt * w;
        else if (tool === "lower") delta = -rate * dt * w;
        else if (tool === "flatten") delta = (target - cur) * kFlat * w;
        else if (tool === "smooth") {
          let sum = 0, cnt = 0;
          for (let jj = j - 1; jj <= j + 1; jj++) {
            if (jj < 0 || jj >= n) continue;
            for (let ii = i - 1; ii <= i + 1; ii++) {
              if (ii < 0 || ii >= n || (ii === i && jj === j)) continue;
              sum += h[jj * n + ii]; cnt++;
            }
          }
          if (cnt) delta = (sum / cnt - cur) * kSmooth * w;
        } else if (tool === "rough") {
          delta = (Math.random() * 2 - 1) * kRough * w;
        } else if (tool === "revert") {
          delta = -sc[k] * kRev * w;
        }
        if (!delta) continue;
        const next = clamp(cur + delta, MIN_H, MAX_H);
        delta = next - cur;
        if (!delta) continue;
        sc[k] += delta;
        h[k] = next;
        if (out) {
          if (i < out.i0) out.i0 = i;
          if (i > out.i1) out.i1 = i;
          if (j < out.j0) out.j0 = j;
          if (j > out.j1) out.j1 = j;
        }
      }
    }
  }

  // Un trazo puede saltar varios metros entre dos eventos de puntero; se pinta
  // a lo largo del segmento con toques solapados para que no queden huecos.
  function stroke(ax, az, bx, bz, dt) {
    const dist = Math.hypot(bx - ax, bz - az);
    const spacing = Math.max(0.25, state.radius * 0.35);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    const sub = dt / steps;
    const out = { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity };
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      dab(ax + (bx - ax) * t, az + (bz - az) * t, sub, out);
    }
    return out;
  }

  function union(R, r) {
    if (!r || r.i0 > r.i1) return;
    if (r.i0 < R.i0) R.i0 = r.i0;
    if (r.i1 > R.i1) R.i1 = r.i1;
    if (r.j0 < R.j0) R.j0 = r.j0;
    if (r.j1 > R.j1) R.j1 = r.j1;
  }

  function refreshAfter(rect) {
    if (!rect || rect.i0 > rect.i1) return;
    terrain.refreshRegion(rect.i0, rect.i1, rect.j0, rect.j1);
    // El agua guarda el fondo en una textura: se actualiza con retardo mientras
    // se pinta (subir 133 KB de textura en cada evento de puntero se nota en un
    // movil) y siempre al soltar.
    const now = performance.now();
    if (water && now - state.lastWater > 200) { water.syncTerrain(rect); state.lastWater = now; }
  }

  // --- historial ------------------------------------------------------------
  // El "antes" es una copia del campo entero (264 KB, ~0,1 ms) y el "despues" se
  // recorta al rectangulo tocado: el trazo tipico guarda unas pocas decenas de
  // flotantes, no los 66.000.
  let before = null;
  let strokeRect = null;

  function subCopy(arr, r) {
    const n = terrain.n;
    const i0 = clamp(r.i0, 0, n - 1), i1 = clamp(r.i1, 0, n - 1);
    const j0 = clamp(r.j0, 0, n - 1), j1 = clamp(r.j1, 0, n - 1);
    const out = new Float32Array((i1 - i0 + 1) * (j1 - j0 + 1));
    let p = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out[p++] = arr[j * n + i];
    return out;
  }

  function beginStroke() {
    before = terrain.ensureSculpt().slice();
    strokeRect = null;
  }

  function endStroke(label) {
    if (!before) return null;
    const b = before;
    before = null;
    const r = strokeRect;
    strokeRect = null;
    if (!r || r.i0 > r.i1) return null;
    const rec = {
      i0: clamp(r.i0, 0, terrain.n - 1), i1: clamp(r.i1, 0, terrain.n - 1),
      j0: clamp(r.j0, 0, terrain.n - 1), j1: clamp(r.j1, 0, terrain.n - 1),
      before: subCopy(b, r), after: subCopy(terrain.ensureSculpt(), r),
    };
    let same = true;
    for (let i = 0; i < rec.before.length; i++) { if (rec.before[i] !== rec.after[i]) { same = false; break; } }
    if (same) return null;
    if (history) history.pushTerrain(label || "Terreno", rec);
    onChange();
    if (water) water.syncTerrain(rec);
    state.strokes++;
    return rec;
  }

  // Aplica un registro del historial ("before" al deshacer, "after" al rehacer)
  // sin recalcular la region: el delta va directo a las alturas.
  function applyEntry(rec, key) {
    if (!rec) return false;
    const n = terrain.n;
    const src = rec[key];
    if (!src) return false;
    const sc = terrain.ensureSculpt(), h = terrain.heights;
    let p = 0;
    for (let j = rec.j0; j <= rec.j1; j++) {
      for (let i = rec.i0; i <= rec.i1; i++) {
        const k = j * n + i;
        const v = src[p++];
        h[k] += v - sc[k];
        sc[k] = v;
      }
    }
    terrain.refreshRegion(rec.i0, rec.i1, rec.j0, rec.j1);
    if (water) water.syncTerrain(rec);
    onChange();
    return true;
  }

  // --- seleccion rectangular ------------------------------------------------
  function selRect() {
    if (state.selDraft) return state.selDraft;
    return state.sel;
  }

  function applyToSelection() {
    const s = selRect();
    if (!s) { toast("Marca antes un rectángulo"); return false; }
    const R = state.radius;
    const rng = terrain.vertexRange(s.x0, s.x1, s.z0, s.z1);
    beginStroke();
    if (state.tool === "revert") {
      // Revertir a lo largo de una seleccion es "deshacer lo esculpido ahi".
      const sc = terrain.ensureSculpt(), n = terrain.n;
      for (let j = rng.j0; j <= rng.j1; j++) {
        for (let i = rng.i0; i <= rng.i1; i++) {
          const k = j * n + i;
          terrain.heights[k] -= sc[k];
          sc[k] = 0;
        }
      }
      strokeRect = rng;
    } else {
      // Se pasa el pincel por TODOS los vertices del rectangulo; el peso no
      // depende de la distancia a un centro, sino a los bordes del rectangulo
      // (interior = peso pleno), que es lo que hace el "Apply to selection".
      const sc = terrain.ensureSculpt(), h = terrain.heights, n = terrain.n;
      const s0 = state.strength;
      const flat = terrain.heightAt((s.x0 + s.x1) / 2, (s.z0 + s.z1) / 2);
      const step = terrain.step;
      for (let j = rng.j0; j <= rng.j1; j++) {
        const wz = terrain.vertexZ(j);
        if (wz < s.z0 - step || wz > s.z1 + step) continue;
        const dz = Math.min(wz - s.z0, s.z1 - wz);
        for (let i = rng.i0; i <= rng.i1; i++) {
          const wx = terrain.vertexX(i);
          if (wx < s.x0 - step || wx > s.x1 + step) continue;
          const dx = Math.min(wx - s.x0, s.x1 - wx);
          const w = profile(Math.min(dx, dz), R);
          if (w <= 0.001) continue;
          const k = j * n + i;
          const cur = h[k];
          let delta = 0;
          if (state.tool === "raise") delta = s0 * (0.9 + R * 0.16) * 0.5 * w;
          else if (state.tool === "lower") delta = -s0 * (0.9 + R * 0.16) * 0.5 * w;
          else if (state.tool === "flatten") delta = (flat - cur) * clamp(s0 * 0.9, 0, 1) * w;
          else if (state.tool === "rough") delta = (Math.random() * 2 - 1) * s0 * 1.6 * w;
          else if (state.tool === "smooth") {
            let sum = 0, cnt = 0;
            for (let jj = j - 1; jj <= j + 1; jj++) {
              if (jj < 0 || jj >= n) continue;
              for (let ii = i - 1; ii <= i + 1; ii++) {
                if (ii < 0 || ii >= n || (ii === i && jj === j)) continue;
                sum += h[jj * n + ii]; cnt++;
              }
            }
            if (cnt) delta = (sum / cnt - cur) * clamp(s0 * 0.85, 0, 1) * w;
          }
          if (!delta) continue;
          const next = clamp(cur + delta, MIN_H, MAX_H);
          delta = next - cur;
          if (!delta) continue;
          sc[k] += delta;
          h[k] = next;
        }
      }
      strokeRect = rng;
    }
    const rec = endStroke("Terreno: " + toolLabel() + " (selección)");
    if (rec) toast("Aplicado a " + (s.x1 - s.x0).toFixed(0) + " × " + (s.z1 - s.z0).toFixed(0) + " m");
    return !!rec;
  }

  function clearSel() {
    state.sel = null;
    state.selDraft = null;
    updateSelLine();
    renderPanel();
  }

  function revertAll() {
    if (!window.confirm("¿Revertir todo el terreno esculpido?")) return;
    beginStroke();
    const sc = terrain.ensureSculpt();
    for (let i = 0; i < sc.length; i++) { terrain.heights[i] -= sc[i]; sc[i] = 0; }
    strokeRect = { i0: 0, i1: terrain.n - 1, j0: 0, j1: terrain.n - 1 };
    const rec = endStroke("Terreno: revertir todo");
    terrain.refreshMesh();
    if (water) water.syncTerrain();
    if (rec) toast("Terreno revertido");
  }

  function toolLabel() { return (TOOLS.find((t) => t.id === state.tool) || {}).label || state.tool; }

  // --- dibujo del pincel ----------------------------------------------------
  const SEG = 56;
  const ringGeo = new T.BufferGeometry();
  ringGeo.setAttribute("position", new T.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
  const ring = new T.Line(ringGeo, new T.LineBasicMaterial({
    color: 0xffe27a, depthTest: false, transparent: true, opacity: 0.95, linewidth: 1,
  }));
  ring.renderOrder = 8;
  ring.frustumCulled = false;
  ring.visible = false;
  scene.add(ring);

  const SEL_N = 4;                  // filas/columnas de la malla del rectangulo
  const selGeo = new T.BufferGeometry();
  selGeo.setAttribute("position", new T.BufferAttribute(new Float32Array((SEL_N + 1) * (SEL_N + 1) * 3), 3));
  const selIdx = [];
  for (let j = 0; j < SEL_N; j++) {
    for (let i = 0; i < SEL_N; i++) {
      const a = j * (SEL_N + 1) + i, b = a + 1, c = a + SEL_N + 1, d = c + 1;
      selIdx.push(a, c, b, b, c, d);
    }
  }
  selGeo.setIndex(selIdx);
  const selMesh = new T.Mesh(selGeo, new T.MeshBasicMaterial({
    color: 0xffe27a, transparent: true, opacity: 0.16, depthWrite: false, side: T.DoubleSide,
  }));
  selMesh.renderOrder = 7;
  selMesh.frustumCulled = false;
  selMesh.visible = false;
  scene.add(selMesh);

  const selLineGeo = new T.BufferGeometry();
  selLineGeo.setAttribute("position", new T.BufferAttribute(new Float32Array(5 * 3), 3));
  const selLine = new T.Line(selLineGeo, new T.LineBasicMaterial({
    color: 0xffd23c, depthTest: false, transparent: true, opacity: 0.95,
  }));
  selLine.renderOrder = 8;
  selLine.frustumCulled = false;
  selLine.visible = false;
  scene.add(selLine);

  function ringAt(cx, cz) {
    const pos = ringGeo.attributes.position.array;
    const R = state.radius;
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      const x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
      pos[i * 3] = x;
      pos[i * 3 + 1] = terrain.heightAt(x, z) + 0.06;
      pos[i * 3 + 2] = z;
    }
    ringGeo.attributes.position.needsUpdate = true;
    ringGeo.computeBoundingSphere();
  }

  function updateSelLine() {
    const s = selRect();
    if (!s) { selMesh.visible = false; selLine.visible = false; return; }
    const pos = selGeo.attributes.position.array;
    let p = 0;
    for (let j = 0; j <= SEL_N; j++) {
      const z = s.z0 + ((s.z1 - s.z0) * j) / SEL_N;
      for (let i = 0; i <= SEL_N; i++) {
        const x = s.x0 + ((s.x1 - s.x0) * i) / SEL_N;
        pos[p++] = x; pos[p++] = terrain.heightAt(x, z) + 0.18; pos[p++] = z;
      }
    }
    selGeo.attributes.position.needsUpdate = true;
    selGeo.computeBoundingSphere();
    const lp = selLineGeo.attributes.position.array;
    const corners = [[s.x0, s.z0], [s.x1, s.z0], [s.x1, s.z1], [s.x0, s.z1], [s.x0, s.z0]];
    corners.forEach((c, i) => {
      lp[i * 3] = c[0]; lp[i * 3 + 1] = terrain.heightAt(c[0], c[1]) + 0.2; lp[i * 3 + 2] = c[1];
    });
    selLineGeo.attributes.position.needsUpdate = true;
    selLineGeo.computeBoundingSphere();
    const on = state.enabled;
    selMesh.visible = on;
    selLine.visible = on;
  }

  // --- puntero --------------------------------------------------------------
  const ptr = { down: false, x: 0, z: 0, id: null, moved: 0, t: 0 };

  function onPointerDown(e) {
    if (!state.enabled) return false;
    const p = terrainPoint(e.clientX, e.clientY);
    if (!p) return false;
    if (state.marquee) {
      state.selDraft = { x0: p.x, x1: p.x, z0: p.z, z1: p.z, anchorX: p.x, anchorZ: p.z };
      ptr.down = true; ptr.id = e.pointerId; ptr.x = p.x; ptr.z = p.z; ptr.moved = 0;
      if (cam) cam.locked = true;
      updateSelLine();
      return true;
    }
    if (!state.paint) return false;
    ptr.down = true; ptr.id = e.pointerId; ptr.x = p.x; ptr.z = p.z;
    ptr.moved = 0; ptr.t = performance.now();
    if (cam) cam.locked = true;
    state._flattenAt = terrain.heightAt(p.x, p.z);
    beginStroke();
    state.painting = true;
    ringAt(p.x, p.z);
    return true;
  }

  function onPointerMove(e) {
    if (!state.enabled) return false;
    const p = terrainPoint(e.clientX, e.clientY);
    if (p) {
      state.hover = p;
      ringAt(p.x, p.z);
      ring.visible = state.paint && !state.marquee;
    } else {
      ring.visible = false;
    }
    if (!ptr.down || e.pointerId !== ptr.id) return !!p;
    if (!p) return true;
    if (state.marquee) {
      const s = state.selDraft;
      s.x0 = Math.min(s.anchorX, p.x); s.x1 = Math.max(s.anchorX, p.x);
      s.z0 = Math.min(s.anchorZ, p.z); s.z1 = Math.max(s.anchorZ, p.z);
      updateSelLine();
      return true;
    }
    const now = performance.now();
    const dt = clamp((now - ptr.t) / 1000, 0.004, 0.05);
    ptr.t = now;
    ptr.moved += Math.hypot(p.x - ptr.x, p.z - ptr.z);
    const r = stroke(ptr.x, ptr.z, p.x, p.z, dt);
    union(strokeRect || (strokeRect = { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity }), r);
    ptr.x = p.x; ptr.z = p.z;
    refreshAfter(strokeRect);
    return true;
  }

  function onPointerUp(e) {
    if (!state.enabled) return false;
    if (!ptr.down || e.pointerId !== ptr.id) return false;
    ptr.down = false;
    if (cam) cam.locked = false;
    if (state.marquee) {
      const s = state.selDraft;
      state.selDraft = null;
      if (Math.abs(s.x1 - s.x0) > 1 && Math.abs(s.z1 - s.z0) > 1) state.sel = s;
      updateSelLine();
      renderPanel();
      return true;
    }
    state.painting = false;
    state._flattenAt = undefined;
    const rec = endStroke("Terreno: " + toolLabel());
    if (rec) refreshAfter(rec);
    return true;
  }

  // --- panel ----------------------------------------------------------------
  function renderPanel() {
    if (!els.terrain) return;
    const box = ui.panel(els.terrain, "Terreno (pincel)", "terrain");

    const trow = el("div", "brow");
    trow.appendChild(el("span", "blabel", "Pincel"));
    for (const t of TOOLS) {
      trow.appendChild(btn(t.label, state.tool === t.id ? "on" : "", () => { state.tool = t.id; renderPanel(); }));
    }
    box.appendChild(trow);

    const srow = el("div", "brow");
    srow.appendChild(el("span", "blabel", "Tamaño"));
    for (const r of SIZES) {
      srow.appendChild(btn(r + " m", state.radius === r ? "on" : "", () => {
        state.radius = r; renderPanel(); if (state.hover) ringAt(state.hover.x, state.hover.z);
      }));
    }
    box.appendChild(srow);

    const frow = el("div", "brow bfield");
    frow.appendChild(el("span", "blabel", "Fuerza"));
    const range = el("input", "brange");
    range.type = "range"; range.min = "10"; range.max = "100"; range.step = "5";
    range.value = String(Math.round(state.strength * 100));
    const val = el("span", "bval", Math.round(state.strength * 100) + "%");
    range.addEventListener("input", () => {
      state.strength = parseFloat(range.value) / 100;
      val.textContent = Math.round(state.strength * 100) + "%";
    });
    frow.appendChild(range);
    frow.appendChild(val);
    box.appendChild(frow);

    const mrow = el("div", "brow");
    const pLab = el("label", "bcheck");
    const pCb = el("input");
    pCb.type = "checkbox"; pCb.checked = state.paint;
    pCb.addEventListener("change", () => {
      state.paint = pCb.checked;
      if (state.paint) { state.marquee = false; renderPanel(); }
      ring.visible = false;
    });
    pLab.appendChild(pCb);
    pLab.appendChild(el("span", null, "Pintar"));
    mrow.appendChild(pLab);
    const rLab = el("label", "bcheck");
    const rCb = el("input");
    rCb.type = "checkbox"; rCb.checked = state.marquee;
    rCb.addEventListener("change", () => {
      state.marquee = rCb.checked;
      if (state.marquee) { state.paint = false; }
      ring.visible = false;
      renderPanel();
    });
    rLab.appendChild(rCb);
    rLab.appendChild(el("span", null, state.selDraft ? "…" : "Rectángulo"));
    mrow.appendChild(rLab);
    box.appendChild(mrow);

    const arow = el("div", "brow");
    const applyBtn = btn("Aplicar a la selección", selRect() ? "on" : "", () => { applyToSelection(); renderPanel(); });
    applyBtn.disabled = !selRect();
    arow.appendChild(applyBtn);
    const clr = btn("Quitar selección", "", () => clearSel());
    clr.disabled = !selRect();
    arow.appendChild(clr);
    arow.appendChild(btn("Revertir todo", "bdanger", revertAll));
    box.appendChild(arow);

    const s = selRect();
    box.appendChild(el("div", "bnote", s
      ? "Selección: " + (s.x1 - s.x0).toFixed(0) + " × " + (s.z1 - s.z0).toFixed(0) + " m. «Aplicar» esculpe toda el área de una vez."
      : HINT));
  }

  // --- ciclo de vida --------------------------------------------------------
  function setEnabled(on) {
    state.enabled = !!on;
    if (!state.enabled) {
      ring.visible = false;
      selMesh.visible = false;
      selLine.visible = false;
      ptr.down = false;
      state.hover = null;
      if (state.painting) { state.painting = false; endStroke("Terreno"); }
    } else {
      updateSelLine();
    }
  }

  function dispose() {
    setEnabled(false);
    for (const m of [ring, selMesh, selLine]) {
      scene.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
  }

  return {
    state, setEnabled, renderPanel, dispose,
    onPointerDown, onPointerMove, onPointerUp,
    terrainPoint, applyEntry, applyToSelection, clearSel, revertAll, toolLabel,
    isPainting: () => ptr.down && !state.marquee,
  };
}
