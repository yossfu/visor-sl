// avatarBody.js -- el cuerpo del avatar: geometria parametrica, cara, pelo y ropa.
//
// POR QUE UN CUERPO PROCEDURAL Y NO UNA MALLA DE SL
// -------------------------------------------------
// El visor oficial de Second Life NO descarga la malla del avatar: la lleva
// dentro (el sistema LLCharacter). Esa malla es un activo de Linden Lab, asi que
// no se puede copiar aqui. Lo que SI se puede replicar --y es lo que define el
// aspecto-- es el *modelo* de SL: un cuerpo cuyos rasgos salen de parametros
// visuales (altura, corpulencia, hombros, tamaño de ojos, ...) y una pila de
// prendas que lo cubren. Este modulo construye un humanoide de verdad a partir
// de ese modelo, y lo hace proceduralmente para que dos clientes con el mismo
// aspecto generen EXACTAMENTE el mismo cuerpo sin intercambiar un vertice.
//
// ESTRUCTURA
// ----------
// El cuerpo es una jerarquia de articulaciones (grupos de three.js). Cada
// articulacion lleva las piezas que giran con ella, de modo que animar es solo
// rotar grupos: no hace falta *skinning*. Las piezas de una misma articulacion y
// material se FUNDEN en una sola geometria (mergeGeometries) al terminar de
// construir, asi que un avatar entero son ~10-14 llamadas de dibujo en vez de
// ~60. Eso importa cuando hay 20 residentes en pantalla.
//
//   root (pies en el suelo)
//   ├─ pelvis (pivote en la cadera)  -- torso, caderas, ropa de arriba, falda
//   │  ├─ neck -> head               -- craneo, cara, pelo, sombrero, gafas
//   │  └─ shoulderL/R -> elbowL/R -> muñeca  -- brazos, manos, mangas
//   └─ hipL/R -> kneeL/R -> tobillo  -- piernas, pantalones, calzado
//
// La cara mira hacia -Z (que es el "adelante" del movimiento en `avatar.js`).
//
// Un cuerpo se reconstruye entero cuando cambia el aspecto (el editor de aspecto
// mueve un deslizador -> se vuelve a generar). Es barato: milisegundos, y solo
// pasa cuando el usuario edita o cuando llega el aspecto de otro residente.

import * as THREE from "./three.js";
import { mergeGeometries } from "./three.js";
import { ENV_INTENSITY } from "./region.js";
import { skinTexture, hairTexture, clothTexture } from "./avatarTextures.js";
import { normalizeAppearance, outfitSlot, hexToInt, HAIR_STYLES } from "./avatarParams.js";

// --- utilidades de color ----------------------------------------------------

function shade(hex, f) {
  const r = Math.max(0, Math.min(255, Math.round(((hex >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((hex >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((hex & 255) * f)));
  return (r << 16) | (g << 8) | b;
}

function mixHex(a, b, t) {
  const r = Math.round(((a >> 16) & 255) * (1 - t) + ((b >> 16) & 255) * t);
  const g = Math.round(((a >> 8) & 255) * (1 - t) + ((b >> 8) & 255) * t);
  const bl = Math.round((a & 255) * (1 - t) + (b & 255) * t);
  return (r << 16) | (g << 8) | bl;
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// smoothstep que tambien funciona "al reves" (a > b), que es lo comodo para
// decir "esto vale 1 por debajo de b y 0 por encima de a".
function sstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// Campana suave centrada en `c` con semiancho `w` (1 en el centro, 0 fuera).
function bell(x, c, w) {
  const t = (x - c) / w;
  return t * t < 1 ? 1 - t * t : 0;
}

const IRIS_COLORS = [0x4a3420, 0x3a2a18, 0x5a4630, 0x2e4a6a, 0x3a6a5a, 0x556070, 0x6a4a2a];

// --- metrica del cuerpo -----------------------------------------------------
//
// Todo sale de la altura total `h` (1.45..2.20 m) y de los parametros 0..1. Se
// reparte la altura entre cabeza, cuello, torso y piernas y despues se sacan los
// anchos. Los numeros son de proporciones humanas estandar (la cabeza cabe ~7,4
// veces en la altura, la pierna es ~0,47 de la altura), ajustados por los
// parametros. Estan elegidos para que el defecto (todo a 0,5) de un cuerpo
// creible, no un muñeco cabezon.
export function bodyMetrics(app) {
  const P = normalizeAppearance(app).params;
  const fem = P.genero;                 // 1 = femenino
  const h = 1.45 + P.altura * 0.75;

  const headH = h * 0.132 * (0.86 + P.cabeza * 0.30);
  const neckLen = h * 0.038 * (0.7 + P.cuello * 0.55);
  const torsoH = h * 0.300 * (0.94 + (P.piernas - 0.5) * 0.10 + (P.brazos - 0.5) * 0.04);
  const legLen = h - headH - neckLen - torsoH - h * 0.012;
  const hipY = legLen;
  const neckBaseY = hipY + torsoH;
  const headY = neckBaseY + neckLen;

  const shoulderHalf = h * (0.100 + P.hombros * 0.058) * (0.90 + (1 - fem) * 0.14);
  const hipHalf = h * (0.082 + P.caderas * 0.034) * (0.94 + fem * 0.10);
  const waistHalf = h * (0.068 + P.cintura * 0.026) * (0.98 + P.corpulencia * 0.06);
  const chestHalf = h * (0.082 + P.corpulencia * 0.034) * (0.96 + (1 - fem) * 0.06);
  const torsoDepth = h * (0.052 + P.corpulencia * 0.032);
  const belly = -(h * (0.004 + P.barriga * 0.040)) * (1 - fem * 0.30);
  const breast = fem * (h * 0.014 + P.pecho * h * 0.040);

  const upperArmR = h * (0.024 + P.musculo * 0.010 + P.grasa * 0.009);
  const forearmR = upperArmR * 0.82;
  const wristR = upperArmR * 0.60;
  const thighR = h * (0.036 + P.musculo * 0.011 + P.grasa * 0.018);
  const calfR = thighR * 0.80;
  const ankleR = thighR * 0.52;

  const armLen = h * (0.330 + (P.brazos - 0.5) * 0.11);
  const upperArmLen = armLen * 0.53, foreArmLen = armLen * 0.47;
  const footH = h * 0.032;
  const legTravel = hipY - footH;
  const thighLen = legTravel * 0.52, calfLen = legTravel * 0.48;
  const footLen = h * (0.130 + P.pies * 0.036);
  const footW = h * (0.042 + P.pies * 0.012);
  const handLen = h * (0.095 + P.manos * 0.030);
  const handW = h * (0.045 + P.manos * 0.014);

  return {
    h, fem, headH, neckLen, torsoH, legLen, hipY, neckBaseY, headY,
    shoulderHalf, hipHalf, waistHalf, chestHalf, torsoDepth, belly, breast,
    upperArmR, forearmR, wristR, thighR, calfR, ankleR,
    armLen, upperArmLen, foreArmLen, footH, thighLen, calfLen, footLen, footW, handLen, handW,
    skinColor: hexToInt(app.skin && app.skin.color !== undefined ? app.skin.color : 0xd8a984),
  };
}

// --- geometria --------------------------------------------------------------

// Una seccion de tubo: centro en (0, y, cz) y radios rx (X) y rz (Z).
function ringVerts(sec, radial, out) {
  for (let i = 0; i < radial; i++) {
    const a = (i / radial) * Math.PI * 2;
    out.push(Math.cos(a) * sec.rx, sec.y, Math.sin(a) * sec.rz + (sec.cz || 0));
  }
}

// Loft de secciones elipticas. Devuelve una BufferGeometry con UV. El sentido de
// los triangulos da normales hacia fuera (probado con un cilindro: en el angulo
// 0 la normal sale en +X). `capStart`/`capEnd` cierran los extremos.
function loft(sections, radial, opts = {}) {
  // Las secciones se ordenan de abajo hacia arriba: el sentido de los
  // triangulos (y por tanto la normal) depende de ello. Sin ordenar, cualquier
  // tubo construido de arriba abajo sale del reves (se ve hueco por delante).
  sections = sections.slice().sort((a, b) => a.y - b.y);
  const pos = [], uv = [];
  ringVerts(sections[0], radial, pos);
  for (const s of sections) ringVerts(s, radial, pos);
  // (la primera se repite y se salta: asi los indices son simples)
  pos.splice(0, radial * 3);
  const n = sections.length;
  const idx = [];
  for (let k = 0; k < n - 1; k++) {
    const a0 = k * radial, b0 = (k + 1) * radial;
    for (let i = 0; i < radial; i++) {
      const i2 = (i + 1) % radial;
      idx.push(a0 + i, b0 + i, b0 + i2, a0 + i, b0 + i2, a0 + i2);
    }
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < radial; i++) uv.push(i / radial, k / (n - 1));

  const pushCap = (sec, dir) => {
    const cIdx = pos.length / 3;
    pos.push(0, sec.y, sec.cz || 0); uv.push(0.5, 0.5);
    const base = pos.length / 3;
    ringVerts(sec, radial, pos);
    for (let i = 0; i < radial; i++) uv.push(0.5 + Math.cos((i / radial) * Math.PI * 2) * 0.5, 0.5 + Math.sin((i / radial) * Math.PI * 2) * 0.5);
    for (let i = 0; i < radial; i++) {
      const i2 = (i + 1) % radial;
      if (dir > 0) idx.push(cIdx, base + i2, base + i);
      else idx.push(cIdx, base + i, base + i2);
    }
  };
  if (opts.capStart) pushCap(sections[0], Math.sign(sections[0].y - sections[1].y) || 1);
  if (opts.capEnd) pushCap(sections[n - 1], Math.sign(sections[n - 1].y - sections[n - 2].y) || -1);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Ayuda para colocar esferas/elipsoides.
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

function xform(x, y, z, sx, sy, sz, rx, ry, rz) {
  _p.set(x, y, z);
  _s.set(sx, sy === undefined ? sx : sy, sz === undefined ? sx : sz);
  _e.set(rx || 0, ry || 0, rz || 0);
  _q.setFromEuler(_e);
  return _m4.compose(_p, _q, _s).clone();
}

// --- cabeza -----------------------------------------------------------------
//
// El craneo NO es una esfera deformada: una esfera acaba en punta en los polos, y
// eso da una cabeza "de huevo" sin mandibula. Aqui la cabeza es un barrido de
// secciones horizontales (como un loft) desde la barbilla hasta la coronilla,
// con una tabla de perfiles que reproduce las proporciones humanas:
//
//   v=0,00  barbilla (estrecha y adelantada)
//   v=0,14  angulo de la mandibula
//   v=0,34  boca
//   v=0,44  pomulos
//   v=0,54  ojos
//   v=0,64  ceja / frente
//   v=0,84  boveda
//   v=1,00  coronilla
//
// Encima de ese perfil se aplican unos desplazamientos locales (arco superciliar,
// cuencas de los ojos, pomulos, sienes) para que la cara no sea un tubo liso. La
// misma funcion que genera la malla (`headPoint`) sirve para COLOCAR los rasgos:
// asi los ojos, la nariz, las cejas o la boca se pegan a la superficie real y no
// quedan enterrados ni flotando.
const HEAD_ROWS = [
  // v,    rx,   rz,   cz
  [0.000, 0.16, 0.22, -0.30],
  [0.060, 0.36, 0.44, -0.24],
  [0.140, 0.54, 0.62, -0.15],
  [0.240, 0.70, 0.78, -0.09],
  [0.340, 0.82, 0.87, -0.05],
  [0.440, 0.91, 0.94, -0.02],
  [0.540, 0.96, 0.98, 0.00],
  [0.640, 0.985, 1.00, 0.00],
  [0.740, 0.97, 1.00, 0.01],
  [0.840, 0.90, 0.95, 0.02],
  [0.920, 0.72, 0.78, 0.03],
  [0.970, 0.46, 0.50, 0.03],
  [1.000, 0.14, 0.16, 0.03],
];

function headProfile(v) {
  const rows = HEAD_ROWS;
  if (v <= rows[0][0]) return { rx: rows[0][1], rz: rows[0][2], cz: rows[0][3] };
  for (let i = 1; i < rows.length; i++) {
    if (v <= rows[i][0]) {
      const a = rows[i - 1], b = rows[i];
      const t = (v - a[0]) / (b[0] - a[0]);
      return { rx: a[1] + (b[1] - a[1]) * t, rz: a[2] + (b[2] - a[2]) * t, cz: a[3] + (b[3] - a[3]) * t };
    }
  }
  const l = rows[rows.length - 1];
  return { rx: l[1], rz: l[2], cz: l[3] };
}

// Punto de la superficie de la cabeza. `v` (0 barbilla, 1 coronilla) y `a` (0
// delante; + a la derecha, hasta +-PI detras). `W`, `Hh` y `D` son los radios
// maximos y la altura. El resultado incluye los desplazamientos de los rasgos.
function headPoint(v, a, W, Hh, D, P) {
  const { rx, rz, cz } = headProfile(v);
  // Superelipse: la cara es mas plana que un cilindro (n>2 la "cuadra" un poco).
  const n = 2.35;
  const sa = Math.sin(a), ca = Math.cos(a);
  const sx = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / n);
  const sz = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / n);
  let x = rx * W * sx;
  const y = v * Hh;
  let z = cz * D - rz * D * sz;
  const front = Math.max(0, ca);
  const aa = a > Math.PI ? a - Math.PI * 2 : a;

  // Arco superciliar: la frente avanza un poco sobre los ojos.
  const browE = bell(v, 0.60, 0.10) * Math.max(0, 1 - Math.abs(aa) / 0.95) * front;
  z -= 0.030 * D * browE * (0.7 + P.cejas * 0.7);
  // Cuencas de los ojos.
  const eyeA = 0.60 + P.ojosSep * 0.16;
  for (const s of [-1, 1]) {
    const dv = (v - 0.535) / 0.085, da = (aa - s * eyeA) / 0.40;
    const d = dv * dv + da * da;
    if (d < 1) z += 0.052 * D * (1 - d) * front;
  }
  // Pomulos.
  for (const s of [-1, 1]) {
    const c = bell(v, 0.44, 0.13) * bell(aa, s * 0.90, 0.40) * front;
    x += s * 0.032 * W * c;
    z -= 0.010 * D * c;
  }
  // Sienes: entran un poco, para que la frente no sea un tubo.
  for (const s of [-1, 1]) {
    x -= s * 0.030 * W * bell(v, 0.68, 0.14) * bell(aa, s * 1.30, 0.32);
  }
  return { x, y, z };
}

function headGeometry(W, Hh, D, P, cols = 44, rows = 30) {
  const pos = [], uv = [], idx = [];
  for (let j = 0; j < rows; j++) {
    const v = j / (rows - 1);
    for (let i = 0; i < cols; i++) {
      const a = (i / cols) * Math.PI * 2;
      const p = headPoint(v, a, W, Hh, D, P);
      pos.push(p.x, p.y, p.z);
      uv.push(i / cols, v);
    }
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols; i++) {
      const i2 = (i + 1) % cols;
      const a0 = j * cols, b0 = (j + 1) * cols;
      idx.push(a0 + i, b0 + i, b0 + i2, a0 + i, b0 + i2, a0 + i2);
    }
  }
  // Tapa de la coronilla (la barbilla se cierra con la tapa inferior, que queda
  // dentro del cuello).
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Acumula geometrias por material y las funde al hacer flush.
function createBuilder(parent) {
  const buckets = new Map();
  return {
    add(geom, mat, m4) {
      if (m4) geom.applyMatrix4(m4);
      geom.clearGroups();
      let arr = buckets.get(mat);
      if (!arr) { arr = []; buckets.set(mat, arr); }
      arr.push(geom);
    },
    flush() {
      for (const [mat, geoms] of buckets) {
        let merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
        if (!merged) {
          for (const g of geoms) {
            const mesh = new THREE.Mesh(g, mat);
            mesh.castShadow = true; mesh.receiveShadow = false;
            parent.add(mesh);
          }
          continue;
        }
        if (geoms.length > 1) for (const g of geoms) g.dispose();
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true; mesh.receiveShadow = false;
        parent.add(mesh);
      }
      buckets.clear();
    },
  };
}

function std(color, rough, metal) {
  return new THREE.MeshStandardMaterial({
    color: color, roughness: rough === undefined ? 0.7 : rough,
    metalness: metal === undefined ? 0.0 : metal, envMapIntensity: ENV_INTENSITY,
  });
}

// Piel: el color manda, pero con poro (mapa de color + mapa de normales) y una
// rugosidad variable que simula la grasa natural. `brillo` (0..1) baja la
// rugosidad media, y el `roughnessMap` la modula punto a punto.
function skinMaterial(color, brillo, seed) {
  const t = skinTexture(seed);
  const m = new THREE.MeshStandardMaterial({
    color: color,
    roughness: 0.72 - brillo * 0.34,
    metalness: 0.0, envMapIntensity: ENV_INTENSITY,
    map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap,
  });
  m.normalScale.set(0.55, 0.55);
  return m;
}

function hairMaterial(color, seed) {
  const t = hairTexture(seed);
  const m = new THREE.MeshStandardMaterial({
    color: color, roughness: 0.62, metalness: 0.0, envMapIntensity: ENV_INTENSITY,
    map: t.map, normalMap: t.normalMap,
  });
  m.normalScale.set(0.8, 0.8);
  return m;
}

function clothMaterial(color, patron) {
  const entry = patron ? clothTexture(patron) : null;
  const m = new THREE.MeshStandardMaterial({
    color: color,
    roughness: entry ? entry.roughness : 0.82,
    metalness: 0.0, envMapIntensity: ENV_INTENSITY,
  });
  if (entry) {
    m.map = entry.map;
    m.normalMap = entry.normalMap;
    if (entry.alpha) { m.transparent = true; m.alphaTest = 0.45; m.depthWrite = true; }
  }
  return m;
}

// --- construccion -----------------------------------------------------------

export function createAvatarBody(appearance) {
  const root = new THREE.Group();
  root.name = "avatar";

  let app = normalizeAppearance(appearance);
  let M = bodyMetrics(app);
  let joints = {};
  let materials = {};
  const ownedMats = [];
  const ownedGeos = [];
  let disposed = false;

  // Estado de animacion (para que el cuerpo mantenga la pose entre frames).
  const anim = { phase: 0, speed: 0, moving: false, flying: false, grounded: true, breathe: 0 };

  function disposeGroup(g) {
    g.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
      }
    });
  }

  function clear() {
    while (root.children.length) {
      const c = root.children[root.children.length - 1];
      root.remove(c);
      disposeGroup(c);
    }
    for (const m of ownedMats) m.dispose();
    ownedMats.length = 0;
    ownedGeos.length = 0;
    joints = {};
    materials = {};
  }

  function build() {
    clear();
    const P = app.params;
    const T = THREE;
    const h = M.h;

    // --- materiales ---
    const skinCol = M.skinColor;
    const iris = IRIS_COLORS[hashStr(app.name + "|eyes") % IRIS_COLORS.length];
    const hairSlot = outfitSlot(app, "hair");
    const hairCol = hairSlot.color;
    const lipCol = mixHex(skinCol, 0x9a4a48, 0.42);

    materials = {
      skin: skinMaterial(skinCol, P.brillo, hashStr(app.name + "|skin") & 0xffff),
      skinDark: skinMaterial(shade(skinCol, 0.82), P.brillo * 0.6, hashStr(app.name + "|skin2") & 0xffff),
      hair: hairMaterial(hairCol, hashStr(app.name + "|hair") & 0xffff),
      brow: std(shade(hairCol, 0.72), 0.78, 0.0),
      lash: std(0x18120f, 0.55, 0.0),
      eyeWhite: std(0xf3f0ec, 0.30, 0.0),
      iris: std(iris, 0.18, 0.0),
      pupil: std(0x0b0b10, 0.14, 0.0),
      lip: std(lipCol, 0.45, 0.0),
      mouth: std(shade(lipCol, 0.42), 0.5, 0.0),
    };
    for (const k of Object.keys(materials)) ownedMats.push(materials[k]);

    // Ropa: un material por ranura (null = prenda apagada).
    const gTop = outfitSlot(app, "top"), gBottom = outfitSlot(app, "bottom");
    const gOuter = outfitSlot(app, "outer"), gShoes = outfitSlot(app, "shoes");
    const gHat = outfitSlot(app, "hat"), gGlasses = outfitSlot(app, "glasses");
    const garment = (slot, info) => {
      if (!info || info.tipo === "ninguna" || info.tipo === "ninguno") return null;
      const m = clothMaterial(info.color, info.patron);
      m.userData.slot = slot;
      ownedMats.push(m);
      return m;
    };
    materials.top = garment("top", gTop);
    materials.bottom = garment("bottom", gBottom);
    materials.outer = garment("outer", gOuter);
    materials.shoes = garment("shoes", gShoes);
    materials.hat = garment("hat", gHat);
    materials.glasses = garment("glasses", gGlasses);
    if (materials.glasses) materials.glasses.metalness = 0.0;

    // --- pelvis / torso ---
    const pelvis = new T.Group(); pelvis.position.set(0, M.hipY, 0); root.add(pelvis);
    joints.pelvis = pelvis;
    {
      const b = createBuilder(pelvis);
      const secs = [
        { y: 0.0, rx: M.hipHalf * 0.80, rz: M.torsoDepth * 0.92, cz: 0 },
        { y: M.torsoH * 0.08, rx: M.hipHalf * 0.98, rz: M.torsoDepth * 1.0, cz: 0 },
        { y: M.torsoH * 0.18, rx: M.hipHalf * 0.92, rz: M.torsoDepth * 0.92, cz: M.belly * 0.4 },
        { y: M.torsoH * 0.30, rx: M.waistHalf, rz: M.torsoDepth * 0.84, cz: M.belly * 0.8 },
        { y: M.torsoH * 0.46, rx: (M.waistHalf + M.chestHalf) * 0.52, rz: M.torsoDepth * 0.98, cz: M.belly },
        { y: M.torsoH * 0.62, rx: M.chestHalf, rz: M.torsoDepth * 1.06, cz: M.belly * 0.6 },
        { y: M.torsoH * 0.78, rx: M.chestHalf * 0.92, rz: M.torsoDepth * 0.98, cz: 0 },
        { y: M.torsoH * 0.90, rx: M.shoulderHalf * 0.86, rz: M.torsoDepth * 0.90, cz: 0 },
        { y: M.torsoH * 1.00, rx: M.shoulderHalf * 0.60, rz: M.torsoDepth * 0.72, cz: 0 },
      ];
      b.add(loft(secs, 18, { capStart: true, capEnd: false }), materials.skin);
      // pechos (solo si el genero tira a femenino y hay talla)
      if (M.breast > 0.001) {
        const by = M.torsoH * 0.64, bz = -M.torsoDepth * 0.92;
        const br = M.breast;
        b.add(new T.SphereGeometry(br, 14, 12), materials.skin, xform(-M.chestHalf * 0.42, by, bz, 1, 0.95, 1));
        b.add(new T.SphereGeometry(br, 14, 12), materials.skin, xform(M.chestHalf * 0.42, by, bz, 1, 0.95, 1));
      }
      // gluteos
      b.add(new T.SphereGeometry(M.hipHalf * 0.52, 14, 12), materials.skin,
        xform(-M.hipHalf * 0.45, M.torsoH * 0.06, M.torsoDepth * 0.55, 1, 0.9, 0.8));
      b.add(new T.SphereGeometry(M.hipHalf * 0.52, 14, 12), materials.skin,
        xform(M.hipHalf * 0.45, M.torsoH * 0.06, M.torsoDepth * 0.55, 1, 0.9, 0.8));

      // ropa de arriba: casquillo sobre el torso
      if (materials.top) {
        const o = 0.014;
        const topName = gTop.tipo;
        const startFrac = topName === "top" ? 0.42 : 0.10;
        const cs = [];
        for (const s of secs) {
          if (s.y < M.torsoH * startFrac - 1e-6) continue;
          cs.push({ y: s.y, rx: s.rx + o, rz: s.rz + o, cz: s.cz || 0 });
        }
        if (cs.length < 2) cs.push({ y: M.torsoH * startFrac, rx: M.waistHalf + o, rz: M.torsoDepth * 0.86 + o, cz: M.belly * 0.5 });
        b.add(loft(cs, 18, { capStart: false, capEnd: false }), materials.top);
        if (M.breast > 0.001) {
          const by = M.torsoH * 0.64, bz = -M.torsoDepth * 0.92, br = M.breast + o;
          b.add(new T.SphereGeometry(br, 14, 12), materials.top, xform(-M.chestHalf * 0.42, by, bz, 1, 0.95, 1));
          b.add(new T.SphereGeometry(br, 14, 12), materials.top, xform(M.chestHalf * 0.42, by, bz, 1, 0.95, 1));
        }
      }
      // falda
      if (materials.bottom && (gBottom.tipo === "falda" || gBottom.tipo === "falda larga")) {
        const long = gBottom.tipo === "falda larga";
        const yBot = long ? M.hipY - M.thighLen - M.calfLen * 0.55 : M.hipY - M.thighLen * 0.9;
        const flare = long ? M.hipHalf * 1.9 : M.hipHalf * 1.5;
        b.add(loft([
          { y: M.torsoH * 0.02, rx: M.hipHalf * 1.02, rz: M.torsoDepth * 1.05, cz: 0 },
          { y: -0.10, rx: M.hipHalf * 1.25, rz: M.torsoDepth * 1.15, cz: 0 },
          { y: yBot, rx: flare, rz: flare * 1.1, cz: 0 },
        ], 20, { capStart: false, capEnd: true }), materials.bottom);
      }
      // parte de abajo tipo pantalon: casquillo de cadera (las piernas van aparte)
      if (materials.bottom && (gBottom.tipo === "pantalon" || gBottom.tipo === "pantalon corto")) {
        const o = 0.012;
        b.add(loft([
          { y: M.torsoH * 0.20, rx: M.waistHalf + o, rz: M.torsoDepth * 0.86 + o, cz: M.belly * 0.6 },
          { y: M.torsoH * 0.08, rx: M.hipHalf * 0.99 + o, rz: M.torsoDepth + o, cz: 0 },
          { y: -0.02, rx: M.hipHalf * 0.86 + o, rz: M.torsoDepth * 0.95 + o, cz: 0 },
        ], 18, { capStart: false, capEnd: false }), materials.bottom);
      }
      // abrigo (por encima de la ropa de arriba)
      if (materials.outer) {
        const long = gOuter.tipo === "abrigo";
        const o = 0.026;
        const cs = [];
        for (const s of secs) {
          if (s.y < M.torsoH * (long ? -0.10 : 0.06)) continue;
          cs.push({ y: s.y, rx: s.rx + o, rz: s.rz + o, cz: s.cz || 0 });
        }
        if (cs.length >= 2) b.add(loft(cs, 18, { capStart: false, capEnd: false }), materials.outer);
      }
      b.flush();
    }

    // --- cuello y cabeza ---
    const neck = new T.Group(); neck.position.set(0, M.torsoH, 0); pelvis.add(neck);
    joints.neck = neck;
    {
      const b = createBuilder(neck);
      b.add(loft([
        { y: 0.0, rx: h * 0.032 + P.cuello * h * 0.008, rz: h * 0.033 + P.cuello * h * 0.008, cz: 0 },
        { y: M.neckLen, rx: h * 0.028 + P.cuello * h * 0.006, rz: h * 0.030 + P.cuello * h * 0.006, cz: h * 0.004 },
      ], 12, { capStart: false, capEnd: false }), materials.skin);
      b.flush();
    }

    const head = new T.Group(); head.position.set(0, M.neckLen, 0); neck.add(head);
    joints.head = head;
    buildHead(head, M, app, materials);

    // --- brazos ---
    for (const side of [-1, 1]) {
      const key = side < 0 ? "L" : "R";
      const shoulder = new T.Group();
      shoulder.position.set(side * M.shoulderHalf * 0.92, M.torsoH * 0.88, 0);
      pelvis.add(shoulder);
      joints["shoulder" + key] = shoulder;
      const eb = createBuilder(shoulder);
      // deltoides + brazo
      eb.add(loft([
        { y: 0.03, rx: M.upperArmR * 1.05, rz: M.upperArmR * 1.05, cz: 0 },
        { y: -M.upperArmLen * 0.45, rx: M.upperArmR, rz: M.upperArmR, cz: 0 },
        { y: -M.upperArmLen, rx: M.upperArmR * 0.84, rz: M.upperArmR * 0.84, cz: 0 },
      ], 12, { capStart: true, capEnd: true }), materials.skin);
      // manga corta
      if (materials.top && (gTop.tipo === "camiseta" || gTop.tipo === "camisa" || gTop.tipo === "blusa")) {
        const o = 0.012;
        const sleeveEnd = gTop.tipo === "camiseta" ? -M.upperArmLen * 0.55 : -M.upperArmLen * 1.02;
        const cs = [{ y: 0.04, rx: M.upperArmR * 1.05 + o, rz: M.upperArmR * 1.05 + o }];
        if (sleeveEnd < -M.upperArmLen) cs.push({ y: -M.upperArmLen, rx: M.upperArmR + o, rz: M.upperArmR + o });
        cs.push({ y: sleeveEnd, rx: M.upperArmR * (sleeveEnd < -M.upperArmLen ? 0.86 : 0.94) + o, rz: M.upperArmR * (sleeveEnd < -M.upperArmLen ? 0.86 : 0.94) + o });
        eb.add(loft(cs, 12, { capStart: false, capEnd: false }), materials.top);
      }
      // manga de abrigo
      if (materials.outer) {
        const o = 0.024;
        eb.add(loft([
          { y: 0.05, rx: M.upperArmR * 1.05 + o, rz: M.upperArmR * 1.05 + o },
          { y: -M.upperArmLen, rx: M.upperArmR + o, rz: M.upperArmR + o },
        ], 12, { capStart: false, capEnd: false }), materials.outer);
      }
      eb.flush();

      const elbow = new T.Group(); elbow.position.set(0, -M.upperArmLen, 0); shoulder.add(elbow);
      joints["elbow" + key] = elbow;
      const fb = createBuilder(elbow);
      fb.add(loft([
        { y: 0.0, rx: M.forearmR, rz: M.forearmR, cz: 0 },
        { y: -M.foreArmLen * 0.6, rx: M.forearmR * 0.86, rz: M.forearmR * 0.86, cz: 0 },
        { y: -M.foreArmLen, rx: M.wristR, rz: M.wristR, cz: 0 },
      ], 10, { capStart: false, capEnd: true }), materials.skin);
      // manga larga
      if (materials.top && (gTop.tipo === "camisa" || gTop.tipo === "blusa")) {
        const o = 0.012;
        fb.add(loft([
          { y: 0.02, rx: M.forearmR + o, rz: M.forearmR + o },
          { y: -M.foreArmLen * 0.92, rx: M.wristR + o, rz: M.wristR + o },
        ], 10, { capStart: false, capEnd: false }), materials.top);
      }
      if (materials.outer) {
        const o = 0.024;
        fb.add(loft([
          { y: 0.02, rx: M.forearmR + o, rz: M.forearmR + o },
          { y: -M.foreArmLen * 0.95, rx: M.wristR + o, rz: M.wristR + o },
        ], 10, { capStart: false, capEnd: false }), materials.outer);
      }
      fb.flush();

      const wrist = new T.Group(); wrist.position.set(0, -M.foreArmLen, 0); elbow.add(wrist);
      joints["wrist" + key] = wrist;
      buildHand(wrist, M, materials, side);
    }

    // --- piernas ---
    for (const side of [-1, 1]) {
      const key = side < 0 ? "L" : "R";
      const hip = new T.Group();
      hip.position.set(side * M.hipHalf * 0.52, M.hipY, 0); root.add(hip);
      joints["hip" + key] = hip;
      const tb = createBuilder(hip);
      tb.add(loft([
        { y: 0.04, rx: M.thighR * 1.08, rz: M.thighR * 1.08, cz: 0 },
        { y: -M.thighLen * 0.5, rx: M.thighR * 0.92, rz: M.thighR * 0.94, cz: 0 },
        { y: -M.thighLen, rx: M.thighR * 0.72, rz: M.thighR * 0.74, cz: 0 },
      ], 12, { capStart: true, capEnd: true }), materials.skin);
      if (materials.bottom && (gBottom.tipo === "pantalon" || gBottom.tipo === "pantalon corto")) {
        const o = 0.012;
        const short = gBottom.tipo === "pantalon corto";
        const end = short ? -M.thighLen * 0.55 : -M.thighLen;
        tb.add(loft([
          { y: 0.06, rx: M.thighR * 1.08 + o, rz: M.thighR * 1.08 + o },
          { y: end, rx: (short ? M.thighR * 0.95 : M.thighR * 0.74) + o, rz: (short ? M.thighR * 0.97 : M.thighR * 0.76) + o },
        ], 12, { capStart: false, capEnd: false }), materials.bottom);
      }
      tb.flush();

      const knee = new T.Group(); knee.position.set(0, -M.thighLen, 0); hip.add(knee);
      joints["knee" + key] = knee;
      const cb = createBuilder(knee);
      cb.add(loft([
        { y: 0.02, rx: M.calfR, rz: M.calfR * 1.04, cz: 0 },
        { y: -M.calfLen * 0.35, rx: M.calfR * 0.9, rz: M.calfR * 0.98, cz: 0 },
        { y: -M.calfLen, rx: M.ankleR, rz: M.ankleR, cz: 0 },
      ], 10, { capStart: true, capEnd: true }), materials.skin);
      if (materials.bottom && gBottom.tipo === "pantalon") {
        const o = 0.012;
        cb.add(loft([
          { y: 0.0, rx: M.calfR + o, rz: M.calfR + o },
          { y: -M.calfLen * 0.96, rx: M.ankleR + o * 0.6, rz: M.ankleR + o * 0.6 },
        ], 10, { capStart: false, capEnd: false }), materials.bottom);
      }
      cb.flush();

      const ankle = new T.Group(); ankle.position.set(0, -M.calfLen, 0); knee.add(ankle);
      joints["ankle" + key] = ankle;
      buildFoot(ankle, M, materials, side);
    }

    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    root.userData.avatar = true;
  }

  // --- cabeza, cara y pelo ------------------------------------------------
  // --- cabeza, cara y pelo ------------------------------------------------
  //
  // La cabeza se mide con tres numeros -- `W` medio ancho, `Hh` alto (barbilla a
  // coronilla) y `D` medio fondo -- y con una funcion de superficie `surf` que
  // devuelve el punto del craneo para una altura `v` (0 = barbilla, 1 =
  // coronilla) y un angulo `af` en vueltas (0 delante, 0,25 derecha, 0,5 detras,
  // 0,75 izquierda). TODOS los rasgos se colocan con `surf`, asi que se pegan a
  // la superficie real en vez de quedar enterrados o flotando.
  function buildHead(headGroup, M, app, materials) {
    const T = THREE;
    const P = app.params;
    const h = M.h;
    const hh = M.headH;
    const b = createBuilder(headGroup);
    const Hh = hh * 1.04;
    const W = hh * (0.315 + P.formaCabeza * 0.030);
    const D = hh * (0.400 + P.formaCabeza * 0.030);
    const surf = (v, af) => headPoint(v, af * Math.PI * 2, W, Hh, D, P);

    // craneo (ya trae mandibula, menton, cuencas, pomulos y sienes)
    b.add(headGeometry(W, Hh, D, P), materials.skin);

    // cuello: mas estrecho arriba (queda dentro de la mandibula) y ancho abajo.
    // Sin el, la cabeza quedaria flotando con un hueco visible en la nuca.
    b.add(loft([
      { y: -hh * 0.62, rx: h * 0.032, rz: h * 0.034, cz: h * 0.004 },
      { y: -hh * 0.20, rx: h * 0.027, rz: h * 0.029, cz: h * 0.004 },
      { y: hh * 0.14, rx: h * 0.023, rz: h * 0.025, cz: h * 0.002 },
    ], 14, { capStart: false, capEnd: false }), materials.skin);

    // --- orejas ---
    const earS = 0.85 + P.orejas * 0.5;
    for (const s of [-1, 1]) {
      const ep = surf(0.50, s * 0.235);
      b.add(new T.SphereGeometry(1, 12, 10), materials.skin,
        xform(ep.x + s * W * 0.02, ep.y + Hh * 0.02, ep.z + D * 0.10,
          W * 0.050, Hh * 0.115 * earS, D * 0.115 * earS, 0, 0, s * 0.10));
      b.add(new T.SphereGeometry(1, 10, 8), materials.skinDark,
        xform(ep.x + s * W * 0.03, ep.y + Hh * 0.02, ep.z + D * 0.09,
          W * 0.026, Hh * 0.065 * earS, D * 0.075 * earS));
    }

    // --- ojos ---
    // El globo se hunde en la cuenca (solo asoma el casquete delantero) y los
    // parpados, dos cascos de piel algo mayores, dejan entre ellos la abertura.
    const eyeA = 0.40 + P.ojosSep * 0.16;          // radianes a cada lado del frente
    const eyeV = 0.535;
    const eyeR = W * (0.185 + P.ojosTam * 0.045);
    const open = P.ojosApertura;
    const lidUp = 0.52 + (1 - open) * 0.46;
    const lidLo = 2.58 - open * 0.26;
    const lidR = eyeR * 1.08;
    for (const s of [-1, 1]) {
      const ep = surf(eyeV, s * (eyeA / (Math.PI * 2)));
      const ex = ep.x, ey = ep.y, ez = ep.z + eyeR * 0.62;
      b.add(new T.SphereGeometry(eyeR, 20, 16), materials.eyeWhite, xform(ex, ey, ez, 1, 1, 1));
      const irisR = eyeR * 0.55;
      b.add(new T.SphereGeometry(irisR, 16, 12), materials.iris, xform(ex, ey, ez - eyeR * 0.84, 1, 1, 0.35));
      b.add(new T.SphereGeometry(irisR * 0.45, 12, 10), materials.pupil, xform(ex, ey, ez - eyeR * 0.96, 1, 1, 0.30));
      // brillo especular: sin el, la mirada parece muerta
      b.add(new T.SphereGeometry(eyeR * 0.11, 8, 6), materials.eyeWhite,
        xform(ex - s * eyeR * 0.22, ey + eyeR * 0.24, ez - eyeR * 1.00, 1, 1, 0.6));
      b.add(new T.SphereGeometry(lidR, 20, 12, 0, Math.PI * 2, 0, lidUp), materials.skin,
        xform(ex, ey, ez, 1, 1.04, 1.06));
      b.add(new T.SphereGeometry(lidR, 20, 10, 0, Math.PI * 2, lidLo, Math.PI - lidLo), materials.skin,
        xform(ex, ey, ez, 1, 1.02, 1.04));
      // linea de pestañas: un tubo fino pegado al borde del parpado superior
      const lash = [];
      const n = 9;
      for (let i = 0; i <= n; i++) {
        const phi = Math.PI + 0.30 + (i / n) * (Math.PI - 0.60);
        lash.push(new T.Vector3(
          ex + lidR * 0.995 * Math.sin(lidUp) * Math.cos(phi),
          ey + lidR * 0.995 * Math.cos(lidUp),
          ez + lidR * 0.995 * Math.sin(lidUp) * Math.sin(phi) * 0.92));
      }
      b.add(new T.TubeGeometry(new T.CatmullRomCurve3(lash), 12, eyeR * 0.055, 5, false), materials.lash);
    }

    // --- cejas ---
    // Un tubo que sigue la superficie del arco superciliar: los extremos se
    // apoyan en la frente curvada en vez de quedar al aire.
    const browR = W * (0.045 + P.cejas * 0.025);
    for (const s of [-1, 1]) {
      const pts = [];
      const n = 7;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const a = eyeA - 0.20 + t * 0.66;
        const v = 0.600 + 0.020 * t - Math.sin(t * Math.PI) * 0.012;
        const p = surf(v, s * (a / (Math.PI * 2)));
        pts.push(new T.Vector3(p.x, p.y, p.z + 0.002 * Hh));
      }
      b.add(new T.TubeGeometry(new T.CatmullRomCurve3(pts), 12, browR, 6, false), materials.brow);
    }

    // --- nariz: un barrido del caballete a la punta, pegado a la cara ---
    const nose = [
      { v: 0.640, w: 0.055, prot: 0.010 },
      { v: 0.580, w: 0.075, prot: 0.024 },
      { v: 0.520, w: 0.095, prot: 0.036 },
      { v: 0.470, w: 0.115, prot: 0.044 },
      { v: 0.435, w: 0.135, prot: 0.046 },
      { v: 0.408, w: 0.120, prot: 0.030 },
    ];
    const noseScale = 0.7 + P.nariz * 0.6;
    b.add(loft(nose.map((s) => {
      const p = surf(s.v, 0);
      const prot = s.prot * noseScale * D;
      return { y: p.y, rx: s.w * W, rz: prot * 0.62, cz: p.z - prot * 0.52 };
    }), 10, { capStart: true, capEnd: true }), materials.skin);
    // alas y orificios
    const noseTip = surf(0.425, 0);
    for (const s of [-1, 1]) {
      b.add(new T.SphereGeometry(1, 12, 10), materials.skin,
        xform(s * 0.130 * W * noseScale, noseTip.y - Hh * 0.012, noseTip.z - D * 0.055,
          W * 0.075, Hh * 0.030, D * 0.055));
      b.add(new T.SphereGeometry(1, 8, 6), materials.skinDark,
        xform(s * 0.085 * W * noseScale, noseTip.y - Hh * 0.020, noseTip.z - D * 0.095,
          W * 0.032, Hh * 0.014, D * 0.028));
    }

    // --- boca: labio superior, inferior y la linea de los labios ---
    const mp = surf(0.335, 0);
    const mouthW = W * (0.44 + P.boca * 0.18);
    const lipT = Hh * (0.026 + P.labios * 0.022);
    b.add(new T.SphereGeometry(1, 18, 12), materials.lip,
      xform(0, mp.y + lipT * 0.62, mp.z - lipT * 0.30, mouthW, lipT * 0.78, lipT * 0.55));
    b.add(new T.SphereGeometry(1, 18, 12), materials.lip,
      xform(0, mp.y - lipT * 0.58, mp.z - lipT * 0.26, mouthW * 0.94, lipT, lipT * 0.62));
    b.add(new T.SphereGeometry(1, 16, 8), materials.mouth,
      xform(0, mp.y, mp.z - lipT * 0.60, mouthW * 0.92, lipT * 0.18, lipT * 0.30));
    b.flush();

    // pelo, sombrero y gafas van en su propio grupo para poder reemplazarlos
    const hairGroup = new T.Group(); headGroup.add(hairGroup);
    buildHair(hairGroup, M, app, materials, W, Hh, D);
    if (materials.hat) buildHat(headGroup, M, materials, W, Hh, D);
    if (materials.glasses) buildGlasses(headGroup, M, materials, W, Hh, D);
  }

  // --- pelo -----------------------------------------------------------------
  // El pelo es un casquete que sigue la superficie del craneo: la linea del pelo
  // es alta en el centro de la frente y baja en las sienes y la nuca, de modo que
  // no parece un casco. El grosor crece de cero (en la linea del pelo) al volumen
  // maximo (arriba), asi que el borde se apoya en la piel y no se ve el canto.
  function buildHair(g, M, app, materials, W, Hh, D) {
    const T = THREE;
    const P = app.params;
    const style = outfitSlot(app, "hair").tipo || HAIR_STYLES[1];
    const mat = materials.hair;
    const vol = 0.8 + P.peloVolumen * 0.8;
    const longF = P.peloLargo;

    const vStart = (aa) => {
      const front = Math.cos(aa);                          // 1 delante, -1 detras
      let v = 0.665 + 0.070 * front - 0.035 * Math.abs(Math.sin(aa));
      const back = Math.max(0, -front);
      const nape = style === "melena" ? 0.30 + longF * 0.45
        : style === "media melena" ? 0.16 + longF * 0.30
          : style === "coleta" ? 0.12
            : 0;
      v -= nape * Math.pow(back, 0.75);
      return v;
    };

    const thin = style === "rapado";
    const base = Hh * (thin ? 0.012 : 0.030 + 0.105 * P.peloVolumen);

    // casquete
    const cols = 40, rows = 12;
    const pos = [], uv = [], idx = [];
    const cx = 0, cyc = 0.58 * Hh, czc = 0.05 * D;
    for (let j = 0; j < rows; j++) {
      const t = j / (rows - 1);
      for (let i = 0; i < cols; i++) {
        const a = (i / cols) * Math.PI * 2;
        const aa = a > Math.PI ? a - Math.PI * 2 : a;
        const v0 = vStart(aa);
        const v = v0 + (1 - v0) * t;
        const p = headPoint(v, a, W, Hh, D, P);
        let dx = p.x - cx, dy = p.y - cyc, dz = p.z - czc;
        const L = Math.hypot(dx, dy, dz) || 1;
        // grosor: 0 en la linea del pelo, completo a partir de 1/3 del recorrido
        const th = base * Math.min(1, t * 3) * (0.55 + 0.45 * t);
        pos.push(p.x + dx / L * th, p.y + dy / L * th, p.z + dz / L * th);
        uv.push(i / cols, t);
      }
    }
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols; i++) {
        const i2 = (i + 1) % cols;
        const a0 = j * cols, b0 = (j + 1) * cols;
        idx.push(a0 + i, b0 + i, b0 + i2, a0 + i, b0 + i2, a0 + i2);
      }
    }
    const cap = new T.BufferGeometry();
    cap.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    cap.setAttribute("uv", new T.Float32BufferAttribute(uv, 2));
    cap.setIndex(idx);
    cap.computeVertexNormals();
    g.add(new T.Mesh(cap, mat));

    // melenas y coletas: una masa que cae por detras
    const backLen = style === "melena" ? 0.55 + longF * 0.75
      : style === "media melena" ? 0.26 + longF * 0.38
        : style === "coleta" ? 0.30 + longF * 0.55
          : 0;
    if (backLen > 0.01) {
      const yTop = 0.52 * Hh, yBot = yTop - backLen * Hh;
      const secs = [];
      const k = 5;
      for (let i = 0; i <= k; i++) {
        const t = i / k;
        secs.push({
          y: yTop - (yTop - yBot) * t,
          rx: W * (0.90 - t * 0.18),
          rz: D * (0.42 - t * 0.08),
          cz: D * (0.78 + t * 0.10),
        });
      }
      g.add(new T.Mesh(loft(secs, 16, { capStart: true, capEnd: true }), mat));
    }
    if (style === "coleta") {
      const pl = 0.35 + longF * 0.65;
      g.add(mk(new T.SphereGeometry(1, 12, 10), mat, W * 0.30, pl * Hh * 0.5, D * 0.30, 0, Hh * 0.62, D * 0.95));
      g.add(mk(new T.SphereGeometry(1, 12, 10), mat, W * 0.26, pl * Hh * 0.5, D * 0.26, 0, Hh * 0.62 - pl * Hh * 0.55, D * 1.15));
    }
    if (style === "moño") {
      g.add(mk(new T.SphereGeometry(1, 16, 14), mat, W * 0.55, Hh * 0.28, D * 0.55, 0, Hh * 1.02, D * 0.35));
    }
    if (style === "afro") {
      g.add(mk(new T.SphereGeometry(1, 20, 16), mat, W * 1.42 * vol, Hh * 0.60 * vol, D * 1.38 * vol, 0, Hh * 0.78, D * 0.06));
    }
    // flequillo: un mechon sobre la frente, por encima de las cejas
    if (!thin && (style === "corto" || style === "media melena" || style === "melena")) {
      g.add(mk(new T.SphereGeometry(1, 16, 12), mat, W * 0.62, Hh * 0.09, D * 0.28, 0, Hh * 0.715, -D * 0.72));
    }
  }

  // mk: coloca una geometria ya escalada (para el pelo, que se construye por
  // partes sueltas y no usa el builder con fusión).
  function mk(geom, mat, rx, ry, rz, x, y, z) {
    const mesh = new THREE.Mesh(geom, mat);
    mesh.scale.set(rx, ry, rz);
    mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = false;
    return mesh;
  }

  function buildHat(g, M, materials, W, Hh, D) {
    const T = THREE;
    const tipo = outfitSlot(app, "hat").tipo;
    if (tipo === "gorra") {
      g.add(mk(new T.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55), materials.hat,
        W * 1.14, Hh * 0.50, D * 1.12, 0, Hh * 0.70, 0));
      g.add(mk(new T.CylinderGeometry(W * 1.05, W * 1.15, Hh * 0.035, 18, 1, false, 0, Math.PI), materials.hat,
        1, 1, 1, 0, Hh * 0.735, -D * 0.78));
    } else {
      g.add(mk(new T.CylinderGeometry(W * 1.02, W * 1.10, Hh * 0.26, 20), materials.hat, 1, 1, 1, 0, Hh * 0.96, 0));
      g.add(mk(new T.CylinderGeometry(W * 2.05, W * 2.05, Hh * 0.028, 24), materials.hat, 1, 1, 1, 0, Hh * 0.845, 0));
    }
  }

  function buildGlasses(g, M, materials, W, Hh, D) {
    const T = THREE;
    const tint = materials.glasses;
    const P = app.params;
    const eyeA = 0.40 + P.ojosSep * 0.16;
    const eyeR = W * (0.185 + P.ojosTam * 0.045);
    const r = eyeR * 1.35;
    let cxp = 0, cyp = 0, czp = 0;
    for (const s of [-1, 1]) {
      const p = headPoint(0.535, s * eyeA, W, Hh, D, P);
      cxp += p.x * 0.5; cyp += p.y * 0.5; czp += p.z * 0.5;
      g.add(mk(new T.TorusGeometry(r, W * 0.035, 8, 20), tint, 1, 1, 1, p.x, p.y, p.z - W * 0.03));
    }
    // puente
    g.add(mk(new T.BoxGeometry(W * 0.30, W * 0.05, W * 0.05), tint, 1, 1, 1,
      cxp, cyp + W * 0.02, czp - W * 0.03));
  }

  function buildHand(wrist, M, materials, side) {
    const T = THREE;
    const b = createBuilder(wrist);
    const hl = M.handLen, hw = M.handW;
    // palma
    b.add(new T.SphereGeometry(1, 12, 10), materials.skin, xform(0, -hl * 0.30, 0, hw * 0.55, hl * 0.42, hw * 0.28));
    // 4 dedos
    for (let i = 0; i < 4; i++) {
      const fx = (i - 1.5) * hw * 0.30;
      const curl = 0.10 + i * 0.02;
      b.add(new T.CapsuleGeometry(hw * 0.11, hl * (0.42 - i * 0.05), 4, 8), materials.skin,
        xform(fx, -hl * 0.72, -hl * 0.02, 1, 1, 1, curl, 0, 0));
    }
    // pulgar
    b.add(new T.CapsuleGeometry(hw * 0.13, hl * 0.34, 4, 8), materials.skin,
      xform(side * hw * 0.52, -hl * 0.42, -hl * 0.12, 1, 1, 1, 0.4, 0, side * 0.7));
    b.flush();
  }

  function buildFoot(ankle, M, materials, side) {
    const T = THREE;
    const b = createBuilder(ankle);
    const fl = M.footLen, fw = M.footW, fh = M.footH;
    // pie: talon + empeine + puntera
    b.add(new T.SphereGeometry(1, 12, 10), materials.skin, xform(0, -fh * 0.55, -fl * 0.16, fw * 0.55, fh * 0.5, fl * 0.34));
    b.add(new T.SphereGeometry(1, 12, 10), materials.skin, xform(0, -fh * 0.4, -fl * 0.42, fw * 0.55, fh * 0.4, fl * 0.26));
    b.add(new T.SphereGeometry(1, 10, 8), materials.skin, xform(0, -fh * 0.62, fl * 0.06, fw * 0.48, fh * 0.46, fl * 0.22));
    if (materials.shoes) {
      const o = 0.012;
      const tipo = outfitSlot(app, "shoes").tipo;
      const boot = tipo === "botas";
      b.add(new T.SphereGeometry(1, 12, 10), materials.shoes, xform(0, -fh * 0.40, -fl * 0.30, fw * 0.60 + o, fh * 0.52 + o, fl * 0.52 + o));
      b.add(new T.SphereGeometry(1, 12, 10), materials.shoes, xform(0, -fh * 0.5, -fl * 0.45, fw * 0.58 + o, fh * 0.46, fl * 0.30 + o));
      if (boot) {
        b.add(new T.SphereGeometry(1, 12, 10), materials.shoes, xform(0, -fh * 1.5, 0, fw * 0.55 + o, M.ankleR * 1.5, M.ankleR * 1.4 + o));
      }
    }
    b.flush();
  }

  // --- animacion ------------------------------------------------------------
  //
  // La pose se reconstruye entera cada frame desde cero (las rotaciones se
  // asignan, no se acumulan), asi que no hay deriva. `phase` lo lleva quien
  // llama (el avatar local por su velocidad; un residente remoto, por la suya).

  function animate(st) {
    st = st || {};
    if (st.phase !== undefined) anim.phase = st.phase;
    if (st.speed !== undefined) anim.speed = st.speed;
    anim.moving = !!st.moving;
    anim.flying = !!st.flying;
    anim.grounded = st.grounded === undefined ? true : !!st.grounded;
    anim.breathe += (st.dt || 0);
    const J = joints;
    if (!J.pelvis) return;
    const p = anim.phase;
    const sw = Math.sin(p);
    const fly = anim.flying;
    const moving = anim.moving;

    if (fly) {
      const t = anim.breathe;
      if (J.hipL) J.hipL.rotation.x = 0.12 + Math.sin(t * 0.8) * 0.04;
      if (J.hipR) J.hipR.rotation.x = 0.12 + Math.sin(t * 0.8 + 1) * 0.04;
      if (J.kneeL) J.kneeL.rotation.x = -0.18;
      if (J.kneeR) J.kneeR.rotation.x = -0.18;
      if (J.shoulderL) { J.shoulderL.rotation.z = 0.95; J.shoulderL.rotation.x = Math.sin(t * 1.2) * 0.06; }
      if (J.shoulderR) { J.shoulderR.rotation.z = -0.95; J.shoulderR.rotation.x = Math.sin(t * 1.2 + 1) * 0.06; }
      if (J.elbowL) J.elbowL.rotation.x = -0.25;
      if (J.elbowR) J.elbowR.rotation.x = -0.25;
      if (J.neck) J.neck.rotation.x = 0.18;
      J.pelvis.position.y = M.hipY;
      J.pelvis.rotation.z = 0;
      J.pelvis.rotation.y = 0;
      return;
    }

    if (moving) {
      const amp = Math.min(0.80, anim.speed * 0.15);
      if (J.hipL) J.hipL.rotation.x = sw * amp;
      if (J.hipR) J.hipR.rotation.x = -sw * amp;
      // la rodilla solo se dobla hacia atras (el gemelo va hacia +Z)
      if (J.kneeL) J.kneeL.rotation.x = -Math.max(0, Math.sin(p + 0.9)) * amp * 1.5;
      if (J.kneeR) J.kneeR.rotation.x = -Math.max(0, Math.sin(p + 0.9 + Math.PI)) * amp * 1.5;
      if (J.shoulderL) { J.shoulderL.rotation.x = -sw * amp * 0.75; J.shoulderL.rotation.z = 0.06; }
      if (J.shoulderR) { J.shoulderR.rotation.x = sw * amp * 0.75; J.shoulderR.rotation.z = -0.06; }
      if (J.elbowL) J.elbowL.rotation.x = -0.25 - Math.max(0, sw) * 0.35;
      if (J.elbowR) J.elbowR.rotation.x = -0.25 - Math.max(0, -sw) * 0.35;
      if (J.neck) J.neck.rotation.x = 0.05;
      J.pelvis.position.y = M.hipY + Math.abs(Math.sin(p)) * 0.018;
      J.pelvis.rotation.y = sw * 0.08;
      J.pelvis.rotation.z = sw * 0.03;
    } else if (anim.grounded) {
      // reposo: respiracion y micro-balanceo
      const t = anim.breathe;
      const idle = Math.sin(t * 1.1);
      if (J.hipL) J.hipL.rotation.x = 0.02 + idle * 0.01;
      if (J.hipR) J.hipR.rotation.x = 0.02 - idle * 0.01;
      if (J.kneeL) J.kneeL.rotation.x = -0.02;
      if (J.kneeR) J.kneeR.rotation.x = -0.02;
      if (J.shoulderL) { J.shoulderL.rotation.x = idle * 0.03; J.shoulderL.rotation.z = 0.05 + idle * 0.01; }
      if (J.shoulderR) { J.shoulderR.rotation.x = -idle * 0.03; J.shoulderR.rotation.z = -0.05 - idle * 0.01; }
      if (J.elbowL) J.elbowL.rotation.x = -0.18;
      if (J.elbowR) J.elbowR.rotation.x = -0.18;
      if (J.neck) J.neck.rotation.x = 0;
      J.pelvis.position.y = M.hipY + idle * 0.006;
      J.pelvis.rotation.y = idle * 0.02;
      J.pelvis.rotation.z = 0;
    } else {
      // en el aire: piernas algo recogidas, brazos abiertos
      if (J.hipL) J.hipL.rotation.x = 0.25;
      if (J.hipR) J.hipR.rotation.x = -0.1;
      if (J.kneeL) J.kneeL.rotation.x = -0.7;
      if (J.kneeR) J.kneeR.rotation.x = -0.3;
      if (J.shoulderL) { J.shoulderL.rotation.x = -0.4; J.shoulderL.rotation.z = 0.35; }
      if (J.shoulderR) { J.shoulderR.rotation.x = -0.4; J.shoulderR.rotation.z = -0.35; }
      if (J.elbowL) J.elbowL.rotation.x = -0.5;
      if (J.elbowR) J.elbowR.rotation.x = -0.5;
      J.pelvis.position.y = M.hipY;
      J.pelvis.rotation.y = 0;
      J.pelvis.rotation.z = 0;
    }
  }

  build();

  return {
    group: root,
    joints,
    get appearance() { return app; },
    get metrics() { return M; },
    get materials() { return materials; },
    setAppearance(next) {
      if (disposed) return;
      app = normalizeAppearance(next);
      M = bodyMetrics(app);
      build();
      animate(anim);
    },
    animate,
    height() { return M.h; },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
