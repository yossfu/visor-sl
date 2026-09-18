// sim.js -- un SIMULADOR DE REGION que habla LLUDP de verdad.
//
// QUE ES Y POR QUE EXISTE
// ----------------------
// Los otros modulos de `lludp/` saben leer y escribir el protocolo; este lo
// PONE EN MARCHA. Es la otra mitad del cable: un simulador de Second Life de
// mentira que contesta con los mismos mensajes, en el mismo orden y con los
// mismos bytes que contesta una region de produccion.
//
// Sirve para tres cosas, y las tres importan:
//
//   1. Verificar el camino COMPLETO sin cuenta de Second Life y sin movil:
//      UseCircuitCode -> RegionHandshake -> RegionHandshakeReply -> LayerData ->
//      AgentMovementComplete -> ObjectUpdate -> avatares -> chat -> terse. Si
//      esto funciona en un par de mentira (`udp.js`), el mismo codigo funciona
//      contra una region real, porque el transporte es lo unico que cambia.
//   2. Probar el RETRANSMISOR (`gateway.js`) contra un simulador que respeta el
//      protocolo: la prueba `sim <-> gateway <-> visor` recorre el camino
//      entero (incluidas la conversion de coordenadas y de formas) sin red.
//   3. Dar una region "de protocolo real" al visor en el navegador, para poder
//      trabajar en la mitad del visor sin depender de nadie.
//
// NO ES SECOND LIFE. La region la inventa este fichero. Pero TODO lo que sale
// por el cable esta construido con los codificadores reales de `objects.js`,
// `terrain.js` y `agent.js`, asi que un error de formato salta aqui y no en
// produccion.
//
// COORDENADAS
// -----------
// El simulador trabaja en coordenadas de SL (x hacia el este 0..256, y hacia el
// norte 0..256, z hacia arriba), como una region de verdad. El visor trabaja
// centrado, y esa conversion es cosa del retransmisor (`objects.js:slPosToViewer`),
// NO de este fichero: aqui no se centra nada. Eso es justo lo que hace que la
// prueba del retransmisor valga para algo.
//
// EL TERRENO
// ----------
// Una rejilla de 257x257 vertices (uno por metro) y parches de 16x16, como el
// `LayerData` de SL. El parche (px, py) cubre los metros [px*16, px*16+16) y
// lleva 16x16 alturas DC sin la costura: el visor la rellena con el vertice del
// parche vecino, que es exactamente como lo hace Linden Lab.

import { createCircuit } from "./circuit.js";
import { createLoopbackUdpPair } from "./udp.js";
import { encodeLayerData, LAYER_CODE } from "./terrain.js";
import {
  PCODE, makeObject, encodeObjectUpdateEntry, encodeTerseBlock, primRecord,
} from "./objects.js";
import { texto, TE_AVATAR_POR_DEFECTO } from "./agent.js";
import { PrimParams } from "../../prims.js";
import { makeRng, fbmP, REGION_SIZE, DEFAULT_WATER_LEVEL } from "../../region.js";

export const SIM_VERSION = "Simulador LLUDP (visor-sl)";
const CHANNEL_VERSION = "Second Life Server (simulador del visor)";
const PATCH = 16;
const PATCHES = REGION_SIZE / PATCH;        // 16x16 parches por capa
const PATCHES_PER_LAYERDATA = 16;           // rafagas, como el simulador real
const TICK_MS = 200;                        // 5 Hz: movimiento de los residentes
const PING_EVERY_MS = 6000;
const STATS_EVERY_MS = 1000;
const COARSE_EVERY_MS = 2000;
const TERRAIN_STRIDE = 264;                 // el del LayerData real (16*16+8)
const REGION_FLAGS = 0x14127a76;

const RESIDENTES = [
  "Nadia Ferrer", "Kikoro Ametza", "Bruno Vallcorba", "Sakura Mizuno",
  "Emil Ostrov", "Rita Bellver", "Tomas Kirchner", "Luna Peralta",
];

const RESPUESTA_TOQUE = {
  cartel: "Cartel: bienvenido. Esto llega por LLUDP, el protocolo de Second Life.",
  fuente: "Fuente: el agua esta fresca hoy.",
  farola: "Farola: se enciende sola al anochecer.",
  estatua: "Estatua: la piedra esta fria al tacto.",
  defecto: "El objeto no responde.",
};

const CHARLA_AMBIENTE = [
  "Que buena luz hace hoy.",
  "Esto ya me llega por el cable de verdad.",
  "Estoy probando el visor desde el movil.",
  "Se me ha ido el sombrero con el viento.",
  "Nos vemos en la plaza.",
  "He rezado una fuente nueva junto al faro.",
];

// --- utilidades ---------------------------------------------------------------

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// UUID estable a partir de un numero (objetos y residentes inventados).
function uuidDe(n, grupo) {
  const hex = (n >>> 0).toString(16).padStart(8, "0");
  return hex + "-0000-4" + (grupo & 0xf).toString(16) + "00-8000-" + hex.padStart(12, "0");
}

// Bytes que ocupa una entrada de ObjectUpdate en el cable, para trocear las
// actualizaciones sin pasarse del tamano de un datagrama (Linden Lab corta sobre
// 1200 bytes; aqui se deja margen porque el circuito anade cabecera).
function bytesDeEntrada(e) {
  const len = (b) => (b && b.length) || 0;
  return 4 + 1 + 16 + 4 + 1 + 1 + 1 + 12 + len(e.ObjectData) + 4 + 4 +
    1 + 1 + 2 + 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 2 + 2 + 2 +
    len(e.TextureEntry) + len(e.TextureAnim) + len(e.NameValue) + len(e.Data) + len(e.Text) + 4 +
    len(e.MediaURL) + len(e.PSBlock) + len(e.ExtraParams) + 16 + 16 + 4 + 1 + 4 + 1 + 12 + 12;
}

function trocear(entradas, maxBytes) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const e of entradas) {
    const b = bytesDeEntrada(e);
    if (cur.length && n + b > maxBytes) { out.push(cur); cur = []; n = 0; }
    cur.push(e);
    n += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

// --- la region inventada ------------------------------------------------------

// Rejilla de alturas en coordenadas de SL: `h[y * n + x]`, con x al este e y al
// norte. La plaza queda llana y los bordes se hunden bajo el agua.
function construirTerreno(seed, agua) {
  const n = REGION_SIZE + 1;
  const h = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / REGION_SIZE, v = y / REGION_SIZE;
      const grande = fbmP(u, v, seed, 4, 4);
      const media = fbmP(u, v, seed + 7, 4, 16);
      const fina = fbmP(u, v, seed + 13, 3, 64);
      let hh = agua + 2 + (grande - 0.5) * 34 + (media - 0.5) * 9 + (fina - 0.5) * 2;
      const r = Math.hypot(x - 128, y - 128);
      const plaza = 1 - clamp01((r - 26) / 30);
      hh = hh * (1 - plaza) + (agua + 6) * plaza;
      const borde = clamp01((Math.max(Math.abs(x - 128), Math.abs(y - 128)) - 118) / 10);
      hh = hh * (1 - borde) + (agua - 3) * borde;
      h[y * n + x] = hh;
    }
  }
  return h;
}

function heightAtSl(h, x, y) {
  const n = REGION_SIZE + 1;
  const fx = Math.max(0, Math.min(n - 1.001, x));
  const fy = Math.max(0, Math.min(n - 1.001, y));
  const i = Math.floor(fx), j = Math.floor(fy);
  const tx = fx - i, ty = fy - j;
  const h00 = h[j * n + i], h10 = h[j * n + i + 1];
  const h01 = h[(j + 1) * n + i], h11 = h[(j + 1) * n + i + 1];
  return (h00 + (h10 - h00) * tx) * (1 - ty) + (h01 + (h11 - h01) * tx) * ty;
}

function parcheDeTerreno(h, px, py) {
  const n = REGION_SIZE + 1;
  const out = new Float32Array(PATCH * PATCH);
  for (let ky = 0; ky < PATCH; ky++) {
    for (let kx = 0; kx < PATCH; kx++) {
      out[ky * PATCH + kx] = h[(py * PATCH + ky) * n + px * PATCH + kx];
    }
  }
  return out;
}

// El mobiliario, en coordenadas de SL y apoyado en el terreno. Se describe con
// `PrimParams` (los mismos parametros de prim del visor) y se convierte a objeto
// de protocolo con `makeObject` + `primParamsToVolume` dentro del codificador.
function construirObjetos(h, rng) {
  const lista = [];
  let next = 1;
  const add = (o) => {
    const ob = makeObject();
    ob.localId = next++;
    ob.uuid = uuidDe(ob.localId, 1);
    ob.pcode = PCODE.PRIMITIVE;
    ob.params = new PrimParams(o.shape);
    ob.shape = o.shape;
    if (o.params) Object.assign(ob.params, o.params);
    ob.scale = o.scale;
    ob.position = [o.x, o.y, heightAtSl(h, o.x, o.y) + (o.dz || 0)];
    const yaw = o.yaw || 0;
    ob.quaternion = [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
    ob.color = o.color === undefined ? 0xaaaaaa : o.color;
    ob.name = o.name;
    ob.desc = o.desc || null;
    ob.text = o.text || "";
    ob.flags = o.flags || 0;
    ob.linkset = o.linkset || 1;
    ob.crc = (0x1000 + ob.localId) >>> 0;
    ob.velocity = [0, 0, 0];
    ob.acceleration = [0, 0, 0];
    ob.angularVelocity = [0, 0, 0];
    ob.tag = o.tag || null;
    lista.push(ob);
    return ob;
  };

  // Plaza: plataforma, losas y columnas.
  add({ name: "Plataforma de la plaza", shape: "box", x: 128, y: 128, dz: 0.3, scale: [24, 0.6, 24], color: 0x8d8577 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    add({
      name: "Losa " + (i + 1), shape: "cylinder",
      x: 128 + Math.cos(a) * 14, y: 128 + Math.sin(a) * 14, dz: 0.35, scale: [3.4, 0.7, 3.4],
      color: i % 2 ? 0xa29a8c : 0xb3aa9a,
    });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const x = 128 + Math.cos(a) * 19, y = 128 + Math.sin(a) * 19;
    add({ name: "Columna " + (i + 1), shape: "cylinder", x, y, dz: 3.6, scale: [1.2, 7.2, 1.2], color: 0xcfc7b6 });
    add({ name: "Capite " + (i + 1), shape: "box", x, y, dz: 7.5, scale: [2.2, 0.6, 2.2], color: 0xbdb4a2 });
  }
  add({ name: "Anillo de la plaza", shape: "torus", x: 128, y: 128, dz: 9.4, scale: [16, 1.1, 16], color: 0xc9a227, params: { holeX: 0.3, holeY: 0.3, profileCutEnd: 0.5 } });

  // Farolas.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.8;
    const x = 128 + Math.cos(a) * 11, y = 128 + Math.sin(a) * 11;
    add({ name: "Poste de farola " + (i + 1), shape: "cylinder", x, y, dz: 2, scale: [0.28, 4, 0.28], color: 0x33302b });
    add({ name: "Farola " + (i + 1), shape: "sphere", x, y, dz: 4.3, scale: [1.1, 1.1, 1.1], color: 0xffe9b0, tag: "farola", params: { profileCutEnd: 0.55 } });
  }

  // La casa.
  const hx = 162, hy = 110;
  add({ name: "Muro norte", shape: "box", x: hx, y: hy - 5, dz: 1.5, scale: [12, 3, 0.5], color: 0xc8b58f });
  add({ name: "Muro sur (con puerta)", shape: "box", x: hx + 3, y: hy + 5, dz: 1.5, scale: [6, 3, 0.5], color: 0xc8b58f });
  add({ name: "Muro sur (lado)", shape: "box", x: hx - 4.5, y: hy + 5, dz: 1.5, scale: [3, 3, 0.5], color: 0xc8b58f });
  add({ name: "Dintel", shape: "box", x: hx + 3, y: hy + 5, dz: 3.3, scale: [6, 0.6, 0.5], color: 0xbfa87f });
  add({ name: "Muro este", shape: "box", x: hx + 6, y: hy, dz: 1.5, scale: [0.5, 3, 10], color: 0xc8b58f });
  add({ name: "Muro oeste", shape: "box", x: hx - 6, y: hy, dz: 1.5, scale: [0.5, 3, 10], color: 0xc8b58f });
  add({ name: "Tejado", shape: "prism", x: hx, y: hy, dz: 3.6, scale: [6.6, 4.4, 11.4], color: 0x8a4a3a, params: { profileCutEnd: 1 } });
  add({ name: "Chimenea", shape: "cylinder", x: hx + 4, y: hy - 3, dz: 4.9, scale: [0.8, 2.4, 0.8], color: 0x7d4a3c });
  add({ name: "Puerta", shape: "box", x: hx + 3, y: hy + 4.8, dz: 1.5, scale: [3.4, 3, 0.24], color: 0x6b4a2f });

  // El faro.
  const fx = 86, fy = 174;
  add({ name: "Torre del faro", shape: "cylinder", x: fx, y: fy, dz: 9, scale: [5.4, 18, 5.4], color: 0xe6e0d4, params: { hollow: 0.35 } });
  add({ name: "Barandilla", shape: "tube", x: fx, y: fy, dz: 18.4, scale: [7.4, 0.3, 7.4], color: 0x3b3b3b, params: { holeX: 1, holeY: 0.2 } });
  add({ name: "Linterna", shape: "cylinder", x: fx, y: fy, dz: 20, scale: [3.2, 3, 3.2], color: 0xffe27a });
  add({ name: "Cupula", shape: "sphere", x: fx, y: fy, dz: 21.7, scale: [3.3, 2.6, 3.3], color: 0xb03a2e, params: { profileCutEnd: 0.5 } });
  add({ name: "Remate del faro", shape: "prism", x: fx, y: fy, dz: 23.4, scale: [0.6, 2.2, 0.6], color: 0x33302b });

  // La fuente.
  const wx = 108, wy = 98;
  add({ name: "Brocal de la fuente", shape: "cylinder", x: wx, y: wy, dz: 0.5, scale: [7, 1, 7], color: 0x9aa0a6, params: { hollow: 0.8 }, tag: "fuente" });
  add({ name: "Agua de la fuente", shape: "cylinder", x: wx, y: wy, dz: 0.85, scale: [6.4, 0.2, 6.4], color: 0x2f7fb5 });
  add({ name: "Columna de la fuente", shape: "tube", x: wx, y: wy, dz: 1.9, scale: [1.6, 2.8, 1.6], color: 0xb9b3a8, params: { holeX: 1, holeY: 0.35 } });
  add({ name: "Fuente", shape: "sphere", x: wx, y: wy, dz: 3.4, scale: [2, 1.4, 2], color: 0x8fd3f4, params: { hollow: 0.2, profileCutEnd: 0.55 } });

  // Arboles.
  for (let i = 0; i < 14; i++) {
    const x = 20 + rng() * 216, y = 20 + rng() * 216;
    if (Math.hypot(x - 128, y - 128) < 26) continue;
    if (heightAtSl(h, x, y) < DEFAULT_WATER_LEVEL + 1.2) continue;
    const t = 1 + rng() * 0.8;
    add({ name: "Tronco " + (i + 1), shape: "cylinder", x, y, dz: 1.6 * t, scale: [0.5 * t, 3.2 * t, 0.5 * t], color: 0x5b4634 });
    add({
      name: "Copa " + (i + 1), shape: "sphere", x, y, dz: 4 * t, scale: [3.4 * t, 3 * t, 3.4 * t],
      color: i % 2 ? 0x3f7a3a : 0x356b34,
      params: { profileCutBegin: i % 3 === 0 ? 0.25 : 0, profileCutEnd: i % 3 === 0 ? 0.75 : 1 },
    });
  }

  // El cartel y la estatua.
  add({ name: "Poste del cartel", shape: "cylinder", x: 136, y: 146, dz: 1, scale: [0.24, 2, 0.24], color: 0x4a4038 });
  add({ name: "Cartel", shape: "box", x: 136, y: 146, dz: 2.4, scale: [4.4, 1.6, 0.2], color: 0xd8cfa6, tag: "cartel", text: "Toca el cartel" });
  add({ name: "Pedestal", shape: "box", x: 122, y: 162, dz: 1.2, scale: [4, 2.4, 4], color: 0xa9a196 });
  add({ name: "Estatua", shape: "cylinder", x: 122, y: 162, dz: 4, scale: [1.6, 4, 1.6], color: 0x7f8c8d, params: { hollow: 0.4, pathCutEnd: 0.6 }, tag: "estatua" });
  add({ name: "Estatua (cabeza)", shape: "sphere", x: 122, y: 162, dz: 6.4, scale: [1.7, 1.7, 1.7], color: 0x8d99a0 });

  return lista;
}

// El handle de region de SL: la esquina en METROS dentro de un entero de 64 bits.
export function regionHandleDe(x, y) {
  return (BigInt((x * 256) >>> 0) << 32n) | BigInt((y * 256) >>> 0);
}

// --- el simulador -------------------------------------------------------------

/**
 * Crea un simulador de region que habla LLUDP.
 *
 * opts:
 *   udp        transporte de datagramas (si falta, se fabrica un par de mentira
 *              y se expone en `pair`)
 *   seed       semilla de la region inventada
 *   log, now   traza y reloj (el reloj se inyecta para los autotests)
 *   circuitCode, agentId, sessionId   lo que espera el circuito (llega por UseCircuitCode)
 *   regionName, regionHandle, regionX, regionY, waterLevel, residentes, auto
 */
export function createRegionSim(opts = {}) {
  const log = opts.log || (() => {});
  const now = opts.now || (() => Date.now());
  const seed = opts.seed === undefined ? 20260918 : opts.seed;
  const rng = makeRng(seed);
  const agua = opts.waterLevel === undefined ? DEFAULT_WATER_LEVEL : opts.waterLevel;
  const regionName = opts.regionName || "Bahia de Pruebas";
  const regionX = opts.regionX === undefined ? 1100 : opts.regionX;
  const regionY = opts.regionY === undefined ? 1000 : opts.regionY;
  const regionHandle = opts.regionHandle === undefined ? regionHandleDe(regionX, regionY) : opts.regionHandle;

  const pair = opts.udp ? null : createLoopbackUdpPair({ auto: opts.auto !== false });
  const udp = opts.udp || pair.b;

  const terrain = construirTerreno(seed, agua);
  const objetos = construirObjetos(terrain, rng);
  const porLocalId = new Map();
  const porUuid = new Map();
  for (const o of objetos) { porLocalId.set(o.localId, o); porUuid.set(o.uuid, o); }

  const residentes = RESIDENTES.slice(0, opts.residentes === undefined ? 6 : opts.residentes).map((nombre, i) => {
    const o = makeObject();
    o.localId = 2000 + i;
    o.uuid = uuidDe(1000 + i, 2);
    o.pcode = PCODE.AVATAR;
    o.params = new PrimParams("box");
    o.shape = "box";
    o.facesCount = 1;
    o.name = nombre;
    o.position = [128 + Math.cos((i / 6) * Math.PI * 2) * 10, 128 + Math.sin((i / 6) * Math.PI * 2) * 10, 26];
    o.quaternion = [0, 0, 0, 1];
    o.scale = [0.45, 1.75, 0.45];
    o.velocity = [0, 0, 0];
    o.acceleration = [0, 0, 0];
    o.angularVelocity = [0, 0, 0];
    o.crc = 0;
    o.flags = 0;
    porLocalId.set(o.localId, o);
    porUuid.set(o.uuid, o);
    return {
      objeto: o, nombre,
      fase: (i / 6) * Math.PI * 2, radio: 8 + (i % 4) * 5,
      velocidad: 0.06 + (i % 3) * 0.02, zig: i % 2 ? 1 : -1,
      escribiendo: false, enviado: false,
    };
  });

  const st = {
    circuitCode: opts.circuitCode || 0,
    agentId: opts.agentId || null,
    sessionId: opts.sessionId || null,
    handshake: 0, patches: 0, objects: 0, avatars: 0, chat: 0, touches: 0,
    pings: 0, stats: 0, coarse: 0, terse: 0, agentUpdates: 0, rezes: 0, borrados: 0,
    movementStarted: false, terrainSent: false, objectsSent: false, throttle: null,
    pose: { position: [128, 128, 25], quaternion: [0, 0, 0, 1], controlFlags: 0, state: 0 },
    startedAt: now(), lastPing: 0, lastStats: 0, lastCoarse: 0, lastTick: 0,
    stopped: false,
  };

  const circuit = createCircuit({ udp, log });
  const traza = [];
  const escuchas = [];
  circuit.on("message", (msg) => {
    traza.push(msg.name);
    if (traza.length > 400) traza.shift();
    for (const fn of escuchas.slice()) { try { fn(msg); } catch (e) { log("escucha del simulador: " + e.message); } }
  });

  function send(name, blocks, o) {
    return circuit.send(Object.assign({ name, blocks }, o || {}));
  }

  // --- lo que manda el simulador ---------------------------------------------

  function enviarRegionHandshake() {
    st.handshake++;
    send("RegionHandshake", {
      RegionInfo: [{
        RegionFlags: REGION_FLAGS,
        SimAccess: 21,
        SimName: regionName,
        SimOwner: uuidDe(900, 3),
        IsEstateManager: false,
        WaterHeight: agua,
        BillableFactor: 1,
        CacheID: uuidDe(901, 3),
        TerrainBase0: uuidDe(910, 3), TerrainBase1: uuidDe(911, 3),
        TerrainBase2: uuidDe(912, 3), TerrainBase3: uuidDe(913, 3),
        TerrainDetail0: uuidDe(920, 3), TerrainDetail1: uuidDe(921, 3),
        TerrainDetail2: uuidDe(922, 3), TerrainDetail3: uuidDe(923, 3),
        TerrainStartHeight00: agua - 2, TerrainStartHeight01: agua - 2,
        TerrainStartHeight10: agua - 2, TerrainStartHeight11: agua - 2,
        TerrainHeightRange00: 60, TerrainHeightRange01: 60,
        TerrainHeightRange10: 60, TerrainHeightRange11: 60,
      }],
      RegionInfo2: [{ RegionID: uuidDe(902, 3) }],
      RegionInfo3: [{
        CPUClassID: 801, CPURatio: 1, ColoName: "Simulador local",
        ProductSKU: "visor-sl", ProductName: SIM_VERSION,
      }],
    }, { reliable: true });
  }

  function enviarTerreno() {
    st.terrainSent = true;
    let lote = [];
    let enviados = 0;
    const soltar = () => {
      if (!lote.length) return;
      const bytes = encodeLayerData(lote, { stride: TERRAIN_STRIDE, layerType: LAYER_CODE.LAND, patchSize: PATCH });
      send("LayerData", { LayerID: [{ Type: LAYER_CODE.LAND }], LayerData: [{ Data: bytes }] });
      st.patches += lote.length;
      enviados += lote.length;
      lote = [];
    };
    for (let py = 0; py < PATCHES; py++) {
      for (let px = 0; px < PATCHES; px++) {
        lote.push({ x: px, y: py, heights: parcheDeTerreno(terrain, px, py) });
        if (lote.length >= PATCHES_PER_LAYERDATA) soltar();
      }
    }
    soltar();
    log("sim: " + enviados + " parches de terreno enviados");
  }

  function enviarObjetos(lista) {
    st.objectsSent = true;
    let total = 0;
    const entradas = lista.map((o) => encodeObjectUpdateEntry(o, { faces: o.facesCount }));
    for (const trozo of trocear(entradas, 1000)) {
      send("ObjectUpdate", {
        RegionData: [{ RegionHandle: regionHandle, TimeDilation: 65535 }],
        ObjectData: trozo,
      }, { reliable: true });
      total += trozo.length;
    }
    st.objects += total;
    return total;
  }

  // El TextureEntry de la apariencia de un avatar. Se manda VACIO a proposito:
  // viene de que los bakes de un avatar real son texturas J2C que este visor
  // todavia no sabe decodificar, y con el TextureEntry vacio el visor deriva una
  // apariencia estable de la semilla (que no necesita recursos y se ve bien).
  // Cuando haya decodificador de J2C, aqui van las 45 caras con sus bakes.
  function textureEntryDeAvatar() {
    void TE_AVATAR_POR_DEFECTO;
    return new Uint8Array(0);
  }

  function enviarAvatares() {
    const entradas = [];
    for (const r of residentes) {
      if (r.enviado) continue;
      r.enviado = true;
      entradas.push(encodeObjectUpdateEntry(r.objeto, { faces: 1 }));
    }
    if (entradas.length) {
      send("ObjectUpdate", {
        RegionData: [{ RegionHandle: regionHandle, TimeDilation: 65535 }],
        ObjectData: entradas,
      }, { reliable: true });
      st.objects += entradas.length;
    }
    for (const r of residentes) {
      send("AvatarAppearance", {
        Sender: [{ ID: r.objeto.uuid, IsTrial: false }],
        ObjectData: [{ TextureEntry: textureEntryDeAvatar() }],
        VisualParam: [],
        AppearanceData: [{ AppearanceVersion: 1, CofVersion: 0, Flags: 0 }],
      });
      st.avatars++;
    }
  }

  function enviarDatosDelAgente() {
    const id = st.agentId;
    if (!id) return;
    send("AgentDataUpdate", {
      AgentData: [{
        AgentID: id,
        FirstName: opts.agentFirstName || "Visor", LastName: opts.agentLastName || "Pruebas",
        GroupTitle: "tecnico", ActiveGroupID: uuidDe(903, 3), GroupPowers: 0, GroupName: "Simulador",
      }],
    });
    send("AgentWearablesUpdate", {
      AgentData: [{ AgentID: id, SessionID: st.sessionId, SerialNum: 1 }],
      WearableData: [
        { ItemID: uuidDe(930, 3), AssetID: uuidDe(931, 3), WearableType: 0 },
        { ItemID: uuidDe(932, 3), AssetID: uuidDe(933, 3), WearableType: 1 },
      ],
    });
    // OJO: el `AgentMovementComplete` lo manda el simulador en cuanto acepta el
    // `CompleteAgentMovement`, no en el handshake; aqui se adelanta porque el
    // visor lo usa para saber donde esta el avatar nada mas entrar.
    send("AgentMovementComplete", {
      AgentData: [{ AgentID: id, SessionID: st.sessionId }],
      Data: [{
        Position: st.pose.position.slice(),
        LookAt: [1, 0, 0],
        RegionHandle: regionHandle,
        Timestamp: Math.floor(now() / 1000) >>> 0,
      }],
      SimData: [{ ChannelVersion: CHANNEL_VERSION }],
    }, { reliable: true });
  }

  function enviarCoarseLocation() {
    st.coarse++;
    const locs = [];
    const ids = [];
    const p = st.pose.position;
    locs.push({ X: byte(p[0]), Y: byte(p[1]), Z: byte(p[2] / 4) });
    ids.push({ AgentID: st.agentId || uuidDe(999, 3) });
    for (const r of residentes) {
      const q = r.objeto.position;
      locs.push({ X: byte(q[0]), Y: byte(q[1]), Z: byte(q[2] / 4) });
      ids.push({ AgentID: r.objeto.uuid });
    }
    send("CoarseLocationUpdate", { Location: locs, Index: [{ You: 0, Prey: -1 }], AgentData: ids });
  }

  function byte(v) { return Math.max(0, Math.min(255, Math.round(v))); }

  function enviarParcelOverlay() {
    const data = new Uint8Array(1024);
    // Un nibble por celda de 4x4 m: 1 = crear objetos, 2 = volar.
    for (let i = 0; i < data.length; i++) data[i] = (i & 1) ? 0x12 : 0x21;
    send("ParcelOverlay", { ParcelData: [{ SequenceID: 0, Data: data }] });
    send("ParcelOverlay", { ParcelData: [{ SequenceID: -1, Data: new Uint8Array(0) }] });
  }

  function enviarParcelProperties() {
    send("ParcelProperties", {
      ParcelData: [{
        RequestResult: 0, SequenceID: 0, SnapSelection: false,
        SelfCount: 1, OtherCount: residentes.length, PublicCount: 0, LocalID: 1,
        OwnerID: uuidDe(900, 3), IsGroupOwned: false,
        AABBMin: [0, 0, 0], AABBMax: [256, 256, 100],
        Area: 65536, Status: 0,
        SimWideMaxPrims: 20000, SimWideTotalPrims: objetos.length,
        MaxPrims: 20000, TotalPrims: objetos.length, OwnerPrims: objetos.length,
        ParcelPrimBonus: 1,
        ParcelFlags: (1 << 1) | (1 << 2) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 15) | (1 << 19) | (1 << 21),
        Name: "Plaza de la Bahia",
        Desc: "Region del simulador LLUDP (no es Second Life)",
        MusicURL: "", MediaURL: "",
        MediaID: uuidDe(904, 3), MediaAutoScale: 0,
        GroupID: uuidDe(905, 3), PassPrice: 0, PassHours: 0,
        Category: 0, AuthBuyerID: uuidDe(906, 3), SnapshotID: uuidDe(907, 3),
        UserLocation: [0, 0, 0], UserLookAt: [1, 0, 0],
        LandingType: 0, RegionPushOverride: false,
        RegionDenyAnonymous: false, RegionDenyIdentified: false, RegionDenyTransacted: false,
      }],
      AgeVerificationBlock: [{ RegionDenyAgeUnverified: false }],
      RegionAllowAccessBlock: [{ RegionAllowAccessOverride: true }],
      ParcelEnvironmentBlock: [{ ParcelEnvironmentVersion: 1, RegionAllowEnvironmentOverride: true }],
    });
  }

  function enviarRegionInfo() {
    send("RegionInfo", {
      AgentData: [{ AgentID: st.agentId || uuidDe(999, 3), SessionID: st.sessionId || uuidDe(999, 3) }],
      RegionInfo: [{
        SimName: regionName, EstateID: 1, ParentEstateID: 1,
        RegionFlags: REGION_FLAGS, SimAccess: 21, MaxAgents: 40,
        BillableFactor: 1, ObjectBonusFactor: 1, WaterHeight: agua,
        TerrainRaiseLimit: 100, TerrainLowerLimit: -100,
        PricePerMeter: 0, RedirectGridX: 0, RedirectGridY: 0,
        UseEstateSun: false, SunHour: 11.5,
      }],
      RegionInfo2: [{ ProductSKU: "visor-sl", ProductName: SIM_VERSION, MaxAgents32: 40, HardMaxAgents: 100, HardMaxObjects: 20000 }],
    });
  }

  function enviarStats() {
    st.stats++;
    send("SimStats", {
      Region: [{ RegionX: regionX, RegionY: regionY, RegionFlags: REGION_FLAGS, ObjectCapacity: 20000 }],
      Stat: [
        { StatID: 0, StatValue: 0.995 },   // dilatacion del tiempo
        { StatID: 1, StatValue: 44.5 },    // fps
        { StatID: 2, StatValue: 0.1 },     // fisica
        { StatID: 4, StatValue: 120 },     // agentes
        { StatID: 11, StatValue: 18.5 },   // kb de entrada
        { StatID: 12, StatValue: 9.5 },    // kb de salida
        { StatID: 23, StatValue: objetos.length + residentes.length },
        { StatID: 26, StatValue: 1 },
      ],
      PidStat: [{ PID: 4242 }],
    });
  }

  function enviarTiempoDelSol() {
    send("SimulatorViewerTimeMessage", {
      TimeInfo: [{
        UsecSinceStart: (Math.floor(now()) * 1000) % 1e12,
        SecPerDay: 14400, SecPerYear: 158400,
        SunDirection: [0.3, 0.5, 0.8], SunPhase: 0.5, SunAngVelocity: [0, 0, 0.0001],
      }],
    });
  }

  function enviarChat(nombre, uuid, mensaje, tipo) {
    send("ChatFromSimulator", {
      ChatData: [{
        FromName: nombre, SourceID: uuid, OwnerID: uuid,
        SourceType: 1, ChatType: tipo === undefined ? 1 : tipo, Audible: 1,
        Position: [128, 128, 26], Message: mensaje,
      }],
    });
    st.chat++;
  }

  function avataresTerses() {
    const t = (now() - st.startedAt) / 1000;
    const entradas = [];
    for (const r of residentes) {
      const a = r.fase + t * r.velocidad;
      const x = 128 + Math.cos(a) * r.radio + Math.sin(a * 3) * 1.5;
      const y = 128 + Math.sin(a) * r.radio * r.zig;
      const z = heightAtSl(terrain, x, y) + 0.1;
      const giro = Math.atan2(x - 128, -(y - 128));
      const q = [0, 0, Math.sin(giro / 2), Math.cos(giro / 2)];
      r.objeto.position = [x, y, z];
      r.objeto.quaternion = q;
      entradas.push({
        Data: encodeTerseBlock({
          localId: r.objeto.localId, state: 0, position: [x, y, z],
          velocity: [0, 0, 0], acceleration: [0, 0, 0], quaternion: q,
          angularVelocity: [0, 0, 0], collisionPlane: [0, 0, 0, 1],
        }, true),
        TextureEntry: new Uint8Array(4),
      });
    }
    if (!entradas.length) return;
    send("ImprovedTerseObjectUpdate", {
      RegionData: [{ RegionHandle: regionHandle, TimeDilation: 65535 }],
      ObjectData: entradas,
    });
    st.terse += entradas.length;
  }

  function charlaAmbiente() {
    const r = residentes[Math.floor(rng() * residentes.length)];
    if (!r) return;
    enviarChat(r.nombre, r.objeto.uuid, CHARLA_AMBIENTE[Math.floor(rng() * CHARLA_AMBIENTE.length)], 1);
  }

  function responderA(texto) {
    const t = String(texto || "").toLowerCase();
    if (/invitad|quien eres|qui[eé]n eres/.test(t)) return "Soy " + RESIDENTES[0] + ". Esto llega por LLUDP, el protocolo real de Second Life.";
    if (/d[oó]nde|faro|plaza|agua|mar\b/.test(t)) return "El faro queda al noroeste, junto al agua. La plaza esta en el centro, alrededor de la fuente.";
    if (/ayuda|help|c[oó]mo|como /.test(t)) return "Toca el cartel de la plaza. Con las flechas te mueves y arrastrando giras la vista.";
    if (/hola|buenas|hey|qu[eé] tal/.test(t)) return "Hola. Bienvenido a la bahia.";
    if (/vuel[ao]s|volar|fly/.test(t)) return "Aqui se puede volar: manten pulsado el boton de salto y empuja hacia arriba.";
    if (/\?$/.test(t)) return "Buena pregunta. Prueba a mirar el cartel de la plaza.";
    return "Te leo perfectamente por el cable.";
  }

  function nombreDeResidente(uuid) {
    const r = residentes.find((x) => x.objeto.uuid === uuid);
    if (!r) return null;
    const partes = r.nombre.split(" ");
    return { first: partes[0], last: partes.slice(1).join(" ") || "Residente" };
  }

  function tocar(localId) {
    st.touches++;
    const o = porLocalId.get(localId);
    let clave = "defecto";
    if (o) {
      const nombre = (o.name || "").toLowerCase();
      if (/cartel/.test(nombre)) clave = "cartel";
      else if (/fuente/.test(nombre)) clave = "fuente";
      else if (/farola/.test(nombre)) clave = "farola";
      else if (/estatua/.test(nombre)) clave = "estatua";
    }
    enviarChat("Simulador", uuidDe(999, 3), o ? "Has tocado: " + (o.name || "objeto") : "No hay nada que tocar ahi.", 0);
    enviarChat("Simulador", uuidDe(999, 3), RESPUESTA_TOQUE[clave], 0);
    // Un objeto con script se delata con ScriptControlChange (lo usa el runtime
    // de scripts del visor para saber que el objeto pide los controles).
    send("ScriptControlChange", { Data: [{ TakeControls: true, Controls: 0x00000001, PassToAgent: true }] });
  }

  // --- respuestas a los mensajes del visor ------------------------------------

  function onMessage(msg) {
    switch (msg.name) {
      case "UseCircuitCode": {
        const b = msg.first("CircuitCode");
        st.circuitCode = b.Code >>> 0;
        st.sessionId = b.SessionID;
        st.agentId = b.ID;
        enviarRegionHandshake();
        break;
      }

      case "RegionHandshakeReply":
        enviarTerreno();
        enviarDatosDelAgente();
        enviarObjetos(objetos);
        enviarAvatares();
        enviarCoarseLocation();
        enviarParcelOverlay();
        enviarParcelProperties();
        enviarRegionInfo();
        enviarStats();
        enviarTiempoDelSol();
        send("HealthMessage", { HealthData: [{ Health: 100 }] });
        break;

      case "CompleteAgentMovement":
        st.movementStarted = true;
        log("sim: el agente ha entrado en la region");
        break;

      case "AgentUpdate": {
        st.agentUpdates++;
        const b = msg.first("AgentData");
        st.pose.position = [b.CameraCenter[0], b.CameraCenter[1], b.CameraCenter[2]];
        st.pose.quaternion = b.BodyRotation.slice();
        st.pose.controlFlags = b.ControlFlags >>> 0;
        st.pose.state = b.State;
        break;
      }

      case "AgentThrottle":
        st.throttle = msg.first("Throttle") ? msg.first("Throttle").Throttles : null;
        break;

      case "ChatFromViewer": {
        const b = msg.first("ChatData");
        log("sim: chat del visor (canal " + b.Channel + "): " + texto(b.Message));
        const r = residentes[Math.floor(rng() * residentes.length)];
        if (r) enviarChat(r.nombre, r.objeto.uuid, responderA(texto(b.Message)), b.Type === 2 ? 2 : 1);
        break;
      }

      case "ObjectSelect":
      case "ObjectGrab": {
        const b = msg.first("ObjectData") || {};
        tocar((b.LocalID !== undefined ? b.LocalID : b.ObjectLocalID) >>> 0);
        break;
      }

      case "ObjectDeGrab": {
        const b = msg.first("ObjectData") || {};
        log("sim: el agente ha soltado el objeto " + (b.LocalID >>> 0));
        break;
      }

      case "RequestMultipleObjects": {
        const ids = msg.list("ObjectData").map((b) => b.ID >>> 0);
        const pedidos = ids.map((id) => porLocalId.get(id)).filter(Boolean);
        if (pedidos.length) enviarObjetos(pedidos);
        break;
      }

      case "RequestObjectPropertiesFamily": {
        const b = msg.first("ObjectData") || {};
        const o = porUuid.get(b.ObjectID);
        if (!o) break;
        send("ObjectPropertiesFamily", {
          ObjectData: [{
            RequestFlags: b.RequestFlags >>> 0,
            ObjectID: o.uuid, OwnerID: uuidDe(900, 3), GroupID: uuidDe(905, 3),
            BaseMask: 0x7fffffff, OwnerMask: 0x7fffffff, GroupMask: 0, EveryoneMask: 0, NextOwnerMask: 0x7fffffff,
            OwnershipCost: 0, SaleType: 0, SalePrice: 0, Category: 0, LastOwnerID: uuidDe(908, 3),
            Name: o.name || "", Description: o.desc || "",
          }],
        });
      }

      case "RequestRegionInfo":
        enviarRegionInfo();
        break;

      case "ParcelPropertiesRequest":
      case "ParcelInfoRequest":
        enviarParcelProperties();
        break;

      case "UUIDNameRequest": {
        const bloques = [];
        for (const b of msg.list("UUIDNameBlock")) {
          const r = nombreDeResidente(b.ID);
          bloques.push({
            ID: b.ID,
            FirstName: r ? r.first : "Residente",
            LastName: r ? r.last : "Desconocido",
          });
        }
        if (bloques.length) send("UUIDNameReply", { UUIDNameBlock: bloques });
        break;
      }

      case "MoneyBalanceRequest":
        send("MoneyBalanceReply", {
          MoneyData: [{
            AgentID: st.agentId || uuidDe(999, 3), TransactionID: uuidDe(940, 3),
            TransactionSuccess: true, MoneyBalance: 0,
            SquareMetersCredit: 0, SquareMetersCommitted: 0,
            Description: "El simulador no lleva cuenta de Linden dolares.",
          }],
          TransactionInfo: [{
            TransactionType: 0, SourceID: uuidDe(941, 3), IsSourceGroup: false,
            DestID: st.agentId || uuidDe(999, 3), IsDestGroup: false, Amount: 0, ItemDescription: "",
          }],
        });
        break;

      case "AgentWearablesRequest":
        enviarDatosDelAgente();
        break;

      case "AgentSetAppearance":
        send("AvatarAppearance", {
          Sender: [{ ID: st.agentId || uuidDe(999, 3), IsTrial: false }],
          ObjectData: [{ TextureEntry: msg.first("ObjectData") ? msg.first("ObjectData").TextureEntry : new Uint8Array(0) }],
          VisualParam: msg.list("VisualParam").map((b) => ({ ParamValue: b.ParamValue })),
          AppearanceData: [{ AppearanceVersion: 1, CofVersion: 0, Flags: 0 }],
        });
        break;

      case "AgentCachedTexture": {
        const a = msg.first("AgentData") || {};
        send("AgentCachedTextureResponse", {
          AgentData: [{ AgentID: st.agentId || uuidDe(999, 3), SessionID: st.sessionId || uuidDe(999, 3), SerialNum: a.SerialNum }],
          WearableData: msg.list("WearableData").map((b) => ({ TextureID: uuidDe(950, 3), TextureIndex: b.TextureIndex, HostName: "" })),
        });
        break;
      }

      case "ObjectDelete": {
        for (const b of msg.list("ObjectData")) {
          const o = porLocalId.get(b.ObjectLocalID >>> 0);
          if (!o) continue;
          st.borrados++;
          send("KillObject", { ObjectData: [{ ID: o.localId }] });
        }
        break;
      }

      case "RezObject":
      case "ObjectAdd": {
        st.rezes++;
        const id = 3000 + st.rezes;
        const od = msg.first("ObjectData") || {};
        const o = makeObject();
        o.localId = id;
        o.uuid = uuidDe(id, 5);
        o.pcode = PCODE.PRIMITIVE;
        o.params = new PrimParams("box");
        o.shape = "box";
        o.scale = msg.name === "ObjectAdd" && od.Scale ? od.Scale.slice() : [1, 1, 1];
        o.position = [128, 128, 30];
        o.quaternion = [0, 0, 0, 1];
        o.color = 0x7fb2e5;
        o.name = "Objeto rezado";
        o.linkset = 1;
        o.crc = (0x2000 + id) >>> 0;
        o.velocity = [0, 0, 0];
        o.acceleration = [0, 0, 0];
        o.angularVelocity = [0, 0, 0];
        porLocalId.set(id, o);
        porUuid.set(o.uuid, o);
        enviarObjetos([o]);
        break;
      }

      case "TeleportLocationRequest": {
        const b = msg.first("Info") || {};
        const pos = (b.Position || [128, 128, 25]).slice();
        st.pose.position = pos;
        send("TeleportLocal", {
          Info: [{
            AgentID: st.agentId || uuidDe(999, 3), LocationID: 1,
            Position: pos, LookAt: (b.LookAt || [1, 0, 0]).slice(), TeleportFlags: 0x00040000,
          }],
        }, { reliable: true });
        break;
      }

      case "LogoutRequest":
        send("LogoutReply", {
          AgentData: [{ AgentID: st.agentId || uuidDe(999, 3), SessionID: st.sessionId || uuidDe(999, 3) }],
        }, { reliable: true });
        st.stopped = true;
        break;

      case "ViewerEffect":
      case "SetAlwaysRun":
      case "AgentFOV":
      case "AgentHeightWidth":
      case "AgentAnimation":
      case "ModifyLand":
      case "ParcelPropertiesUpdate":
      case "ScriptAnswerYes":
      case "AgentIsNowWearing":
      case "ObjectDuplicateOnRay":
      case "ImprovedInstantMessage":
      case "GenericMessage":
      case "EstateOwnerMessage":
      case "AgentDataUpdateRequest":
      case "AvatarPropertiesRequest":
      case "RequestTaskInventory":
      case "AgentRequestSit":
      case "AgentSit":
      case "SetStartLocationRequest":
        // Se aceptan en silencio, como el simulador de verdad.
        break;

      default:
        log("sim: mensaje no atendido: " + msg.name);
        break;
    }
  }

  // --- el reloj ---------------------------------------------------------------

  function update() {
    if (st.stopped) return;
    const t = now();
    circuit.tick();
    if (!st.movementStarted) return;
    if (t - st.lastPing >= PING_EVERY_MS) {
      st.lastPing = t;
      st.pings++;
      send("StartPingCheck", { PingID: [{ PingID: st.pings & 0xff, OldestUnacked: 0 }] });
    }
    if (t - st.lastStats >= STATS_EVERY_MS) {
      st.lastStats = t;
      enviarStats();
    }
    if (t - st.lastCoarse >= COARSE_EVERY_MS) {
      st.lastCoarse = t;
      enviarCoarseLocation();
    }
    if (t - st.lastTick >= TICK_MS) {
      st.lastTick = t;
      avataresTerses();
      if (rng() < 0.12) charlaAmbiente();
    }
  }

  const api = {
    circuit, pair, terrain, objetos, residentes, state: st, traza,
    region: {
      name: regionName, handle: regionHandle, x: regionX, y: regionY,
      waterLevel: agua, simVersion: SIM_VERSION,
      objects: objetos, residents: residentes,
    },
    heightAt: (x, y) => heightAtSl(terrain, x, y),
    objectAt: (localId) => porLocalId.get(localId) || null,
    objectByUuid: (u) => porUuid.get(u) || null,
    on(fn) { escuchas.push(fn); return () => { const i = escuchas.indexOf(fn); if (i >= 0) escuchas.splice(i, 1); }; },
    start() { return api; },
    update,
    stop() { st.stopped = true; circuit.close("simulador detenido"); },
    flush() { if (pair) pair.flush(); },
  };
  circuit.on("message", onMessage);
  return api;
}

// Registro para el retransmisor (igual que `mockServer.recordFor`): convierte un
// objeto de protocolo en el registro que viaja por el cable del retransmisor.
export function registroDe(o, viewerId) {
  return primRecord(o, viewerId);
}

// --- autotest -----------------------------------------------------------------
//
// Se le habla al simulador COMO LE HABLA UN VISOR y se exige que conteste lo que
// tiene que contestar, decodificado con los mismos lectores que usara el
// retransmisor. Es la prueba de que el protocolo esta completo por los dos lados.

export async function runSimSelfTest() {
  const checks = [];
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const near = (name, got, want, eps = 1e-3) => checks.push({ name, ok: Math.abs(got - want) <= eps, got, want });

  const { defaultTemplates } = await import("./template.js");
  const { decodePacket, encodePacket } = await import("./codec.js");
  const obj = await import("./objects.js");
  const tr = await import("./terrain.js");
  const ag = await import("./agent.js");
  const { createFakeUdp } = await import("./udp.js");
  const t = defaultTemplates();
  const { decodeObjectUpdate, decodeImprovedTerseObjectUpdate } = obj;

  // Un cable de mentira: el transporte del simulador guarda lo que manda y deja
  // inyectar lo que le llega. Es el mismo contrato que usa el circuito real.
  const salida = [];
  let entrada = null;
  const udpS = { send: (u8) => salida.push(u8.slice()), setHandler: (fn) => { entrada = fn; } };
  void createFakeUdp;

  let reloj = 1000000;
  const nowFn = () => reloj;
  const sim = createRegionSim({ udp: udpS, seed: 11, residentes: 4, log: () => {}, now: nowFn });
  sim.start();

  const vistos = [];
  const scan = () => { while (salida.length) vistos.push(decodePacket(salida.shift(), t)); };
  const de = (name) => vistos.filter((m) => m.name === name);
  const ultimo = (name) => { const l = de(name); return l.length ? l[l.length - 1] : null; };
  const AGENTE = "66666666-7777-8888-9999-aaaaaaaaaaaa";
  const SESION = "11111111-2222-3333-4444-555555555555";
  const enviar = (name, blocks, packetId) => {
    entrada(encodePacket({ name, packetId, blocks }, t));
    scan();
  };

  // 1. Handshake: como el visor.
  enviar("UseCircuitCode", { CircuitCode: [{ Code: 0x1234, SessionID: SESION, ID: AGENTE }] }, 1);
  const hs = ultimo("RegionHandshake");
  ok("sim: contesta al UseCircuitCode", !!hs, vistos.map((m) => m.name).join(","));
  if (hs) {
    const info = ag.readRegionHandshake(hs);
    eq("sim: nombre de la region", info.name, "Bahia de Pruebas");
    eq("sim: acceso moderado", info.access, 21);
    near("sim: altura del agua", info.waterHeight, 20);
    eq("sim: producto", info.productSku, "visor-sl");
  }
  eq("sim: guarda el codigo de circuito", sim.state.circuitCode, 0x1234);

  // 2. RegionHandshakeReply -> el mundo entero.
  enviar("RegionHandshakeReply", { AgentData: [{ AgentID: AGENTE, SessionID: SESION }], RegionInfo: [{ Flags: 0x20 }] }, 2);
  ok("sim: manda terreno", de("LayerData").length > 0, de("LayerData").length);
  ok("sim: manda el AgentMovementComplete", de("AgentMovementComplete").length > 0);
  ok("sim: manda objetos", de("ObjectUpdate").length > 0);
  ok("sim: manda apariencias", de("AvatarAppearance").length === sim.residentes.length, de("AvatarAppearance").length);
  ok("sim: manda CoarseLocationUpdate", de("CoarseLocationUpdate").length > 0);
  ok("sim: manda ParcelOverlay", de("ParcelOverlay").length > 0);
  ok("sim: manda la parcela", de("ParcelProperties").length > 0);
  ok("sim: manda RegionInfo", de("RegionInfo").length > 0);
  ok("sim: manda SimStats", de("SimStats").length > 0);
  ok("sim: manda la salud", de("HealthMessage").length > 0);
  {
    const amc = ag.readAgentMovementComplete(ultimo("AgentMovementComplete"));
    eq("sim: el movimiento apunta al agente", amc.agentId, AGENTE);
    ok("sim: con la version del canal", /Simulador|Second Life/.test(amc.channelVersion), amc.channelVersion);
    near("sim: y el handle de la region", amc.regionHandle, 1100 * 256 * 4294967296 + 1000 * 256, 1);
  }
  eq("sim: 256 parches", sim.state.patches, 256);

  // El terreno: se juntan TODOS los parches y se comparan con la rejilla del
  // simulador. Es la comprobacion de que el empaquetado DCT y las coordenadas
  // cuadran (el retransmisor hara esta misma conversion).
  {
    const grid = new Float32Array(256 * 256);
    let n = 0;
    for (const m of de("LayerData")) {
      const d = tr.applyLayerData(m);
      for (const p of d.patches) {
        n++;
        for (let ky = 0; ky < 16; ky++) {
          for (let kx = 0; kx < 16; kx++) grid[(p.y * 16 + ky) * 256 + p.x * 16 + kx] = p.heights[ky * 16 + kx];
        }
      }
    }
    eq("sim: los 256 parches vuelven", n, 256);
    let peor = 0;
    for (let i = 0; i < 256 * 256; i += 613) {
      const x = i % 256, y = (i / 256) | 0;
      peor = Math.max(peor, Math.abs(grid[i] - sim.heightAt(x, y)));
    }
    ok("sim: el terreno decodificado coincide con el del simulador (error maximo " + peor.toFixed(3) + " m)", peor < 1, peor);
  }

  // Los objetos: cuentan y vuelven con su forma, nombre y posicion.
  {
    const objs = [];
    for (const m of de("ObjectUpdate")) objs.push.apply(objs, decodeObjectUpdate(m));
    eq("sim: tantos objetos como tiene la region (mas residentes)", objs.length, sim.objetos.length + sim.residentes.length);
    const prims = objs.filter((o) => o.pcode === obj.PCODE.PRIMITIVE);
    eq("sim: los prims son los de la region", prims.length, sim.objetos.length);
    const plataforma = prims.find((o) => o.localId === 1);
    ok("sim: la plataforma vuelve", !!plataforma, prims.length);
    if (plataforma) {
      eq("sim: con su forma", plataforma.shape, "box");
      eq("sim: y su nombre", plataforma.name, "Plataforma de la plaza");
      near("sim: y su posicion", Math.hypot(plataforma.position[0] - 128, plataforma.position[1] - 128, plataforma.position[2] - (sim.heightAt(128, 128) + 0.3)), 0, 0.01);
      near("sim: y su escala", plataforma.scale[1], 0.6, 1e-6);
      eq("sim: y su color", plataforma.color, 0x8d8577);
    }
    eq("sim: los residentes llegan como avatares", objs.filter((o) => o.pcode === obj.PCODE.AVATAR).length, sim.residentes.length);
  }

  // 3. Entrar del todo y dejar correr el reloj.
  enviar("CompleteAgentMovement", { AgentData: [{ AgentID: AGENTE, SessionID: SESION, CircuitCode: 0x1234 }] }, 3);
  ok("sim: el agente ha entrado", sim.state.movementStarted, sim.state.movementStarted);
  for (let i = 0; i < 60; i++) { reloj += 250; sim.update(); }
  scan();
  ok("sim: manda pings", de("StartPingCheck").length > 0, de("StartPingCheck").length);
  ok("sim: manda estadisticas", de("SimStats").length > 1, de("SimStats").length);
  ok("sim: manda posiciones terses", de("ImprovedTerseObjectUpdate").length > 0, de("ImprovedTerseObjectUpdate").length);
  {
    const u = decodeImprovedTerseObjectUpdate(ultimo("ImprovedTerseObjectUpdate"));
    eq("sim: una entrada terse por residente", u.length, sim.residentes.length);
    ok("sim: y todas son avatares", u.every((x) => x.isAvatar), u.map((x) => x.isAvatar).join(","));
    const r0 = sim.residentes[0].objeto;
    near("sim: la posicion terse vuelve", Math.hypot(u[0].position[0] - r0.position[0], u[0].position[1] - r0.position[1], u[0].position[2] - r0.position[2]), 0, 0.05);
  }
  {
    const stats = ag.readSimStats(ultimo("SimStats"));
    eq("sim: la region de las estadisticas", [stats.regionX, stats.regionY], [1100, 1000]);
    ok("sim: con sus 8 medidas", Object.keys(stats.stats).length === 8, Object.keys(stats.stats).length);
    ok("sim: y con el fps y la dilatacion", stats.fps > 0 && stats.timeDilation > 0, stats.fps);
  }

  // 4. AgentUpdate: el simulador se queda con la pose.
  enviar("AgentUpdate", { AgentData: [{
    AgentID: AGENTE, SessionID: SESION, BodyRotation: [0, 0, 0, 1], HeadRotation: [0, 0, 0, 1], State: 0,
    CameraCenter: [140.5, 100.25, 30.75], CameraAtAxis: [1, 0, 0], CameraLeftAxis: [0, 1, 0], CameraUpAxis: [0, 0, 1],
    Far: 128, ControlFlags: 1 | 0x4000, Flags: 0,
  }] }, 4);
  eq("sim: la pose del agente llega", sim.state.agentUpdates, 1);
  near("sim: y la posicion se guarda", sim.state.pose.position[0], 140.5, 1e-3);
  ok("sim: con sus banderas de control", (sim.state.pose.controlFlags & 0x4000) !== 0, sim.state.pose.controlFlags);

  // 5. Chat: contesta uno de los residentes.
  {
    const antes = de("ChatFromSimulator").length;
    enviar("ChatFromViewer", { AgentData: [{ AgentID: AGENTE, SessionID: SESION }], ChatData: [{ Message: "hola, donde esta el faro?", Type: 1, Channel: 0 }] }, 5);
    const chats = de("ChatFromSimulator");
    ok("sim: contesta al chat", chats.length > antes, chats.length - antes);
    const c = ag.readChatFromSimulator(chats[chats.length - 1]);
    ok("sim: la respuesta habla del faro", /faro/i.test(c.message), c.message);
    ok("sim: el que habla tiene nombre", c.fromName.length > 0, c.fromName);
  }

  // 6. Toque: ObjectGrab -> chat + ObjectPropertiesFamily.
  {
    const cartel = sim.objetos.find((o) => /Cartel/.test(o.name || ""));
    enviar("ObjectGrab", { AgentData: [{ AgentID: AGENTE, SessionID: SESION }], ObjectData: [{ LocalID: cartel.localId, GrabOffset: [0, 0, 0] }] }, 6);
    ok("sim: el cartel contesta al toque", de("ChatFromSimulator").some((m) => /Cartel/.test(ag.readChatFromSimulator(m).message)), de("ChatFromSimulator").length);
    eq("sim: se cuenta el toque", sim.state.touches, 1);
    ok("sim: el script pide los controles", de("ScriptControlChange").length > 0);
    enviar("RequestObjectPropertiesFamily", { AgentData: [{ AgentID: AGENTE, SessionID: SESION }], ObjectData: [{ RequestFlags: 0, ObjectID: cartel.uuid }] }, 7);
    const fam = ultimo("ObjectPropertiesFamily");
    ok("sim: contesta con las propiedades", !!fam, !!fam);
    if (fam) eq("sim: el nombre del cartel", ag.readObjectPropertiesFamily(fam).name, cartel.name);
  }

  // 7. RequestMultipleObjects devuelve SOLO lo pedido.
  {
    const objetivo = sim.objetos[3];
    const antes = de("ObjectUpdate").length;
    enviar("RequestMultipleObjects", { AgentData: [{ AgentID: AGENTE, SessionID: SESION }], ObjectData: [{ CacheMissType: 0, ID: objetivo.localId }] }, 8);
    const objs = [];
    for (const m of de("ObjectUpdate").slice(antes)) objs.push.apply(objs, decodeObjectUpdate(m));
    eq("sim: devuelve justo lo pedido", objs.length, 1);
    if (objs.length) eq("sim: y es el objeto pedido", objs[0].localId, objetivo.localId);
  }

  // 8. Nombres, dinero, region y teletransporte.
  {
    enviar("UUIDNameRequest", { UUIDNameBlock: [{ ID: sim.residentes[0].objeto.uuid }] }, 9);
    const rep = ultimo("UUIDNameReply");
    ok("sim: contesta a los nombres", !!rep, !!rep);
    if (rep) {
      const b = rep.first("UUIDNameBlock");
      eq("sim: con el nombre del residente", ag.texto(b.FirstName) + " " + ag.texto(b.LastName), sim.residentes[0].nombre);
    }
    enviar("MoneyBalanceRequest", { AgentData: [{ AgentID: AGENTE, SessionID: SESION }], MoneyData: [{ TransactionID: "00000000-0000-0000-0000-000000000000" }] }, 10);
    ok("sim: contesta al saldo", de("MoneyBalanceReply").length > 0);
    ok("sim: y cuadra el saldo", ag.readMoneyBalanceReply(ultimo("MoneyBalanceReply")).moneyBalance === 0, ag.readMoneyBalanceReply(ultimo("MoneyBalanceReply")).moneyBalance);
    enviar("RequestRegionInfo", { AgentData: [{ AgentID: AGENTE, SessionID: SESION }] }, 11);
    ok("sim: contesta a la info de region", de("RegionInfo").length > 1);
    enviar("TeleportLocationRequest", { AgentData: [{ AgentID: AGENTE, SessionID: SESION }], Info: [{ RegionHandle: regionHandleDe(1100, 1000), Position: [40, 50, 30], LookAt: [1, 0, 0] }] }, 12);
    const tl = ultimo("TeleportLocal");
    ok("sim: contesta al teletransporte", !!tl, !!tl);
    if (tl) near("sim: y deja al agente donde pidio", tl.first("Info").Position[0], 40, 1e-6);
  }

  // 9. Rez y borrado.
  {
    enviar("ObjectAdd", { AgentData: [{ AgentID: AGENTE, SessionID: SESION, GroupID: "00000000-0000-0000-0000-000000000000" }], ObjectData: [{
      PCode: 9, Material: 3, AddFlags: 0, PathCurve: 16, ProfileCurve: 1,
      PathBegin: 0, PathEnd: 0, PathScaleX: 100, PathScaleY: 100,
      PathShearX: 0, PathShearY: 0, PathTwist: 0, PathTwistBegin: 0, PathRadiusOffset: 0,
      PathTaperX: 0, PathTaperY: 0, PathRevolutions: 0, PathSkew: 0,
      ProfileBegin: 0, ProfileEnd: 0, ProfileHollow: 0,
      BypassRaycast: 1, RayStart: [0, 0, 0], RayEnd: [0, 0, 0],
      RayTargetID: "00000000-0000-0000-0000-000000000000", RayEndIsIntersection: 0,
      Scale: [1, 1, 1], Rotation: [0, 0, 0, 1], State: 0,
    }] }, 13);
    eq("sim: se cuenta el rez", sim.state.rezes, 1);
    ok("sim: el objeto rezado existe", !!sim.objectAt(3001), 3001);
    enviar("ObjectDelete", { AgentData: [{ AgentID: AGENTE, SessionID: SESION, Force: false }], ObjectData: [{ ObjectLocalID: 3001 }] }, 14);
    eq("sim: se cuenta el borrado", sim.state.borrados, 1);
    eq("sim: y sale el KillObject", obj.decodeKillObject(ultimo("KillObject")), [3001]);
  }

  // 10. Logout y traza.
  enviar("LogoutRequest", { AgentData: [{ AgentID: AGENTE, SessionID: SESION }] }, 15);
  ok("sim: contesta al logout", de("LogoutReply").length > 0);
  ok("sim: la traza guarda todo lo que le llego", sim.traza.indexOf("ChatFromViewer") >= 0 && sim.traza.length >= 14, sim.traza.length);
  ok("sim: no revienta con mensajes que no atiende", vistos.length > 40, vistos.length);

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
}
