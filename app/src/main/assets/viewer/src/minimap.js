// minimap.js -- el plano de la region (el minimapa de la esquina y el mapa
// grande del panel de mapa comparten este mismo dibujo).
//
// El fondo (terreno + agua) se cuece UNA vez a un lienzo aparte: se muestrea la
// altura en una rejilla, se colorea con la MISMA paleta que usa el terreno 3D
// (`terrain.colorAt`) y se sombrea con una luz rasante desde el noroeste, que es
// lo que hace que un mapa de alturas se lea como relieve en vez de como manchas.
//
// Encima, cada vez que se pinta, van los prims (su caja envolvente proyectada),
// los demas residentes, los sitios y el avatar con su rumbo y su cono de vision.
// Pintar cuesta unos cientos de trazos y no vuelve a tocar el terreno.
//
// Coordenadas: las del mundo (X este, Z sur). En el mapa, +X va a la derecha y
// +Z hacia abajo, asi que el norte (-Z) queda arriba, como en cualquier mapa.
// Un punto del mundo se convierte en pixel con la misma regla que usa la region
// para nombrar sitios: slX = x + 128, slY = 128 - z.

import * as THREE from "./three.js";

// three.js interpreta los colores hexadecimales en sRGB y los pasa al espacio
// lineal de trabajo, asi que `colorAt()` devuelve componentes lineales. El
// lienzo de 2D espera bytes en sRGB: sin esta vuelta atras, el mapa saldria
// oscuro y apagado.
function toSRGB(v) {
  v = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

const SKY_BLANK = "#0b0f16";
const GRID_COLOR = "rgba(190, 215, 255, 0.10)";
const EDGE_COLOR = "rgba(190, 215, 255, 0.28)";
const PRIM_COLOR = "rgba(158, 178, 205, 0.42)";
const PRIM_ROOT_COLOR = "rgba(196, 214, 240, 0.55)";

export function createMinimap(opts = {}) {
  const terrain = opts.terrain || null;
  const size = terrain ? terrain.size : 256;
  const half = size / 2;
  const waterLevel = terrain ? terrain.waterLevel : 0;
  const res = Math.max(64, Math.min(512, Math.round(opts.res || 256)));
  const step = size / res;

  const bake = document.createElement("canvas");
  bake.width = res;
  bake.height = res;

  const _c = new THREE.Color();
  const _box = new THREE.Box3();

  // --- fondo: alturas, agua y sombreado --------------------------------------
  function bakeTerrain() {
    const ctx = bake.getContext("2d");
    const img = ctx.createImageData(res, res);
    const data = img.data;
    // Una muestra de mas por lado para poder tomar diferencias sin salirse.
    const n = res + 1;
    const hs = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const z = -half + j * step;
      const row = j * n;
      for (let i = 0; i < n; i++) hs[row + i] = terrain ? terrain.heightAt(-half + i * step, z) : 0;
    }
    // Luz rasante desde el noroeste y por encima: N·L con la normal del terreno.
    const lx = -0.62, ly = 0.66, lz = -0.42;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const k = j * n + i;
        const h = hs[k];
        const hx = (hs[k + 1] - hs[k]) / step;
        const hz = (hs[k + n] - hs[k]) / step;
        const grad = Math.hypot(hx, hz);
        const slope = grad > 1 ? 1 : grad;
        terrain ? terrain.colorAt(h, slope, _c) : _c.setHex(0x5f7a45);
        let r = toSRGB(_c.r), g = toSRGB(_c.g), b = toSRGB(_c.b);
        if (h < waterLevel) {
          // Agua: cuanto mas hondo, mas oscura y mas azul.
          const d = Math.min(1, (waterLevel - h) / 9);
          const wr = 0.16 + 0.10 * (1 - d), wg = 0.36 + 0.16 * (1 - d), wb = 0.50 + 0.20 * (1 - d);
          r = wr; g = wg; b = wb;
        } else {
          // Sombreado solo en tierra: el agua ya lleva su propio tono.
          const inv = 1 / Math.sqrt(hx * hx + hz * hz + 1);
          const dot = (-hx * lx + ly - hz * lz) * inv;
          const shade = 0.42 + 0.78 * (dot < 0 ? 0 : dot);
          r *= shade; g *= shade; b *= shade;
        }
        const o = (j * res + i) * 4;
        data[o] = Math.min(255, r * 255 + 0.5);
        data[o + 1] = Math.min(255, g * 255 + 0.5);
        data[o + 2] = Math.min(255, b * 255 + 0.5);
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  bakeTerrain();

  // --- proyeccion ------------------------------------------------------------
  // `view` = { cx, cz, span }: el trozo de mundo que se ve, en metros.
  function makeView(cx, cz, span) {
    const s = span <= 0 ? size : span;
    return {
      cx, cz, span: s,
      toX: (x) => ((x - (cx - s / 2)) / s) * 1,
      toY: (z) => ((z - (cz - s / 2)) / s) * 1,
      sx: (x, w) => ((x - (cx - s / 2)) / s) * w,
      sy: (z, h) => ((z - (cz - s / 2)) / s) * h,
      mx: (px, w) => cx - s / 2 + (px / w) * s,
      mz: (py, h) => cz - s / 2 + (py / h) * s,
      pxPerM: (w) => w / s,
    };
  }

  // --- dibujo ----------------------------------------------------------------
  // `o` = { w, h, view, objects, peers, avatar, cameraYaw, sites, showGrid,
  //         labels, sitesOnly }
  function draw(ctx, o) {
    const w = o.w, h = o.h;
    const v = o.view || makeView(0, 0, size);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = SKY_BLANK;
    ctx.fillRect(0, 0, w, h);

    // Fondo del terreno, recortado al trozo visible.
    const bx = ((v.cx - v.span / 2) + half) / size * res;
    const by = ((v.cz - v.span / 2) + half) / size * res;
    const bw = (v.span / size) * res;
    const bh = (v.span / size) * res;
    if (bw > 0 && bh > 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(bake, bx, by, bw, bh, 0, 0, w, h);
    }

    // Rejilla de 32 m (4x4 en una region de 256): da escala sin ensuciar.
    if (o.showGrid !== false) {
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let g = -half; g <= half; g += 32) {
        const x = Math.round(v.sx(g, w)) + 0.5;
        const y = Math.round(v.sy(g, h)) + 0.5;
        ctx.moveTo(x, 0); ctx.lineTo(x, h);
        ctx.moveTo(0, y); ctx.lineTo(w, y);
      }
      ctx.stroke();
    }

    // Prims: su caja envolvente proyectada (rotacion incluida).
    const objs = o.objects || [];
    if (objs.length && !o.sitesOnly) {
      ctx.fillStyle = PRIM_COLOR;
      ctx.strokeStyle = "rgba(20, 28, 40, 0.45)";
      ctx.lineWidth = Math.max(1, v.pxPerM(w) * 0.06);
      for (const obj of objs) {
        if (!obj || !obj.position) continue;
        const b = o.world ? o.world.worldBox(obj, _box) : null;
        let x0, z0, x1, z1;
        if (b) { x0 = b.min.x; z0 = b.min.z; x1 = b.max.x; z1 = b.max.z; }
        else { x0 = obj.position.x - 0.5; z0 = obj.position.z - 0.5; x1 = obj.position.x + 0.5; z1 = obj.position.z + 0.5; }
        const px = v.sx(x0, w), py = v.sy(z0, h), pw = v.sx(x1, w) - px, ph = v.sy(z1, h) - py;
        ctx.fillStyle = obj.links && obj.links.length ? PRIM_ROOT_COLOR : (obj.linkRoot ? PRIM_COLOR : PRIM_COLOR);
        ctx.fillRect(px, py, Math.max(1.2, pw), Math.max(1.2, ph));
        if (ctx.lineWidth > 1.05) ctx.strokeRect(px, py, Math.max(1.2, pw), Math.max(1.2, ph));
      }
    }

    // Sitios (marcadores): rombo con relleno. Se dibujan grandes o pequenos
    // segun el zoom para que sigan siendo visibles en el mapa grandote.
    const sites = o.sites || [];
    const pxm = v.pxPerM(w);
    const markR = Math.max(3.5, Math.min(7, pxm * 3));
    for (const s of sites) {
      const x = v.sx(s.x, w), y = v.sy(s.z, h);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      ctx.beginPath();
      ctx.moveTo(x, y - markR); ctx.lineTo(x + markR, y);
      ctx.lineTo(x, y + markR); ctx.lineTo(x - markR, y);
      ctx.closePath();
      ctx.fillStyle = s.color || "rgba(255, 214, 120, 0.92)";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(20, 24, 32, 0.7)";
      ctx.stroke();
      if (o.labels !== false && s.name) {
        ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const tx = x + markR + 3;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(8, 12, 18, 0.85)";
        ctx.strokeText(s.name, tx, y);
        ctx.fillStyle = "#f2e7c8";
        ctx.fillText(s.name, tx, y);
      }
    }

    // Otros residentes: punto verde con su nombre.
    const peers = o.peers || [];
    for (const p of peers) {
      const x = v.sx(p.position[0], w), y = v.sy(p.position[2], h);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(2.5, Math.min(5, pxm * 1.6)), 0, Math.PI * 2);
      ctx.fillStyle = "#7ee0a0";
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = "rgba(12, 20, 16, 0.75)";
      ctx.stroke();
      if (o.labels !== false && p.name) {
        ctx.font = "600 10px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(220, 255, 232, 0.9)";
        ctx.fillText(p.name, x + 6, y);
      }
    }

    // El avatar: flecha con su rumbo y, delante, el cono de vision de la camara.
    const a = o.avatar;
    if (a && a.position) {
      const x = v.sx(a.position.x, w), y = v.sy(a.position.z, h);
      const yaw = a.yaw || 0;
      // El avatar mira hacia (-sin, -cos) en (x, z); en pantalla, +z es abajo.
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      if (o.cameraYaw !== undefined && o.cameraYaw !== null) {
        const cx2 = -Math.sin(o.cameraYaw), cz2 = -Math.cos(o.cameraYaw);
        const ang = Math.atan2(cz2, cx2);
        const cone = 0.62;
        const rad = Math.max(14, pxm * 14);
        const grd = ctx.createRadialGradient(x, y, 2, x, y, rad);
        grd.addColorStop(0, "rgba(170, 210, 255, 0.30)");
        grd.addColorStop(1, "rgba(170, 210, 255, 0)");
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.arc(x, y, rad, ang - cone, ang + cone);
        ctx.closePath();
        ctx.fillStyle = grd;
        ctx.fill();
      }
      const r = Math.max(5, Math.min(9, pxm * 3.4));
      ctx.beginPath();
      ctx.moveTo(x + fx * r * 1.25, y + fz * r * 1.25);
      ctx.lineTo(x - fx * r * 0.55 - fz * r * 0.72, y - fz * r * 0.55 + fx * r * 0.72);
      ctx.lineTo(x - fx * r * 0.55 + fz * r * 0.72, y - fz * r * 0.55 - fx * r * 0.72);
      ctx.closePath();
      ctx.fillStyle = "#ffd479";
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "rgba(30, 22, 6, 0.85)";
      ctx.stroke();
    }

    // Marco de la region (lo que no es region se ve oscuro y sin detalle).
    ctx.strokeStyle = EDGE_COLOR;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(v.sx(-half, w), v.sy(-half, h), v.sx(half, w) - v.sx(-half, w), v.sy(half, h) - v.sy(-half, h));
  }

  return { canvas: bake, res, size, half, waterLevel, makeView, draw, bakeTerrain };
}
