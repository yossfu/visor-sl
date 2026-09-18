// mockServer.js -- la otra mitad del protocolo: un "retransmisor de mentira"
// que sirve una region inventada desde el propio navegador.
//
// PARA QUE SIRVE
// --------------
// Levantar el retransmisor de verdad (el que habla LLUDP con un simulador de
// Second Life) es trabajo aparte y hace falta una maquina donde correrlo; ver
// src/VIEWER-REAL.md. Mientras tanto, esta mitad existe para poder construir y
// comprobar la mitad del navegador: inicio de sesion, enlace, entrada en la
// region, terreno por parches, objetos, avatares, chat, texturas y estadisticas.
// Habla EXACTAMENTE el protocolo de src/sl/relay.js, asi que cuando el
// retransmisor de verdad exista, el visor no cambia ni una linea: solo cambia
// la direccion.
//
// NO ES SECOND LIFE: la region la inventa este fichero (terreno con el mismo
// ruido que el de la arena de pruebas, prims colocados a mano y residentes
// paseando). En la pantalla de arranque aparece siempre marcado como simulador.
//
// Tambien sirve de especificacion ejecutable del lado servidor: quien escriba
// el retransmisor de verdad puede mirar aqui QUE campos hacen falta en cada
// mensaje y en que orden se mandan.
//
// EL TERRENO: 16x16 parches de 16x16 alturas, igual que el LayerData de SL. La
// rejilla de `Terrain` (src/region.js) tiene 1 m por vertice y es unica para
// toda la region, asi que los parches encajan sin costuras.

import { C, S, PROTOCOL, PHASE, RES, ASSET_FORMAT, ZERO_UUID, loopbackPair, createRelay, encode, encodeJson, decode, putAsset, readAsset } from "./relay.js";
import { makeRng, fbmP, REGION_SIZE, DEFAULT_WATER_LEVEL } from "../region.js";

export const MOCK_REGION = {
  name: "Bahía de Pruebas",
  mock: true,
  handle: [1100 * 256, 1000 * 256],
  regionX: 1100,
  regionY: 1000,
  size: REGION_SIZE,
  waterLevel: DEFAULT_WATER_LEVEL,
  simVersion: "simulador de pruebas 1.0",
};

const PATCH = 16;                 // metros por parche
const PATCHES = REGION_SIZE / PATCH; // 16
const TICK_MS = 200;              // 5 Hz: posiciones de avatares

// Nombres y charla ambiente. Son residentes inventados, no cuentas de SL.
const RESIDENTS = [
  "Nadia Ferrer", "Kikoro Ametza", "Bruno Vallcorba", "Sakura Mizuno",
  "Emil Ostrov", "Rita Bellver", "Tomas Kirchner", "Luna Peralta",
];
const AMBIENT = [
  "¡Qué buena luz hace hoy!",
  "¿Alguien sabe dónde está el faro?",
  "Estoy probando el visor desde el móvil.",
  "Se me ha ido el sombrero con el viento.",
  "¿Os va bien el sonido? A mí me va a saltos.",
  "He rezado una fuente nueva en la plaza.",
  "Qué raro se ve el agua desde la colina.",
  "¡Cuidado con el borde, que hay caída!",
];
const TOUCH_REPLY = {
  sign: "Cartel: bienvenido a la Bahía de Pruebas.",
  fountain: "Fuente: el agua está fresca hoy.",
  lamp: "Farola: se enciende sola al anochecer.",
  statue: "Estatua: la piedra está fría al tacto.",
  default: "El objeto no responde.",
};

// --- construccion de la region -------------------------------------------------

function buildTerrain(seed) {
  const n = REGION_SIZE + 1;
  const heights = new Float32Array(n * n);
  const water = MOCK_REGION.waterLevel;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / REGION_SIZE, v = j / REGION_SIZE;
      const big = fbmP(u, v, seed, 4, 4);
      const mid = fbmP(u, v, seed + 7, 4, 16);
      const fine = fbmP(u, v, seed + 13, 3, 64);
      let h = water + 2 + (big - 0.5) * 34 + (mid - 0.5) * 9 + (fine - 0.5) * 2;
      // Meseta central: la plaza, plana y a una altura comoda.
      const r = Math.hypot(i - 128, j - 128);
      const plaza = 1 - Math.max(0, Math.min(1, (r - 26) / 30));
      h = h * (1 - plaza) + (water + 6) * plaza;
      // Orilla: se hunde hacia el borde para que el agua rodee la region.
      const edge = Math.max(0, Math.min(1, (Math.max(Math.abs(i - 128), Math.abs(j - 128)) - 118) / 10));
      h = h * (1 - edge) + (water - 3) * edge;
      heights[j * n + i] = h;
    }
  }
  return heights;
}

function patchOf(terrain, px, py) {
  const out = new Float32Array(PATCH * PATCH);
  for (let y = 0; y < PATCH; y++) {
    const j = py * PATCH + y;
    for (let x = 0; x < PATCH; x++) {
      out[y * PATCH + x] = terrain[j * (REGION_SIZE + 1) + px * PATCH + x];
    }
  }
  return out;
}

function heightAt(terrain, x, z) {
  const n = REGION_SIZE + 1;
  const i = Math.max(0, Math.min(n - 1, Math.round(x + REGION_SIZE / 2)));
  const j = Math.max(0, Math.min(n - 1, Math.round(z + REGION_SIZE / 2)));
  return terrain[j * n + i];
}

// Coloca el mobiliario de la plaza. Los registros que salen de aqui son los
// MISMOS que usa el mundo del editor (`world.recordOf`): de eso se encarga
// src/sl/session.js, que los mete por `world.applyRemote`. Por eso el
// mobiliario se describe con los parametros de prim de siempre (PrimParams).
function buildObjects(terrain, rng) {
  const objs = [];
  let next = 1;
  const add = (o) => {
    const rec = {};
    rec.id = next++;
    rec.name = o.name;
    rec.shape = o.shape;
    rec.params = Object.assign({ shape: o.shape }, o.params || {});
    rec.position = o.position;
    rec.quaternion = o.quaternion || [0, 0, 0, 1];
    rec.scale = o.scale;
    rec.color = o.color === undefined ? null : o.color;
    // Textura servida por la region (S.ASSET) para la cara 0: asi el camino de
    // recursos se ejercita de verdad, con el uuid que pide el visor.
    rec.faces = o.faceTex ? [{ i: 0, tex: { a: uuidFromId(5000 + rec.id) } }] : null;
    rec.script = o.script || null;
    rec.desc = o.desc || null;
    rec.build = true;
    rec.phantom = !!o.phantom;
    rec.owner = null;
    rec.parent = null;
    rec.local = null;
    rec.tag = o.tag || null;
    rec.uuid = o.uuid || null;
    objs.push(rec);
    return rec;
  };

  // Cimientos de la plaza: una plataforma baja de 24x24 y un borde de losas.
  add({ name: "Plataforma de la plaza", shape: "box", position: [0, patchH(terrain, 0, 0) + 0.3, 0], scale: [24, 0.6, 24], color: "#8d8577", faceTex: true });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    add({
      name: "Losa " + (i + 1), shape: "cylinder", position: [Math.cos(a) * 14, patchH(terrain, Math.cos(a) * 14, Math.sin(a) * 14) + 0.35, Math.sin(a) * 14],
      scale: [3.4, 0.7, 3.4], color: i % 2 ? "#a29a8c" : "#b3aa9a",
    });
  }

  // Columnas y arcos alrededor de la plaza (cilindros y un toro).
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const x = Math.cos(a) * 19, z = Math.sin(a) * 19;
    const base = patchH(terrain, x, z);
    add({ name: "Columna " + (i + 1), shape: "cylinder", position: [x, base + 3.6, z], scale: [1.2, 7.2, 1.2], color: "#cfc7b6" });
    add({ name: "Capite " + (i + 1), shape: "box", position: [x, base + 7.5, z], scale: [2.2, 0.6, 2.2], color: "#bdb4a2" });
  }
  add({ name: "Anillo de la plaza", shape: "torus", position: [0, patchH(terrain, 0, 0) + 9.4, 0], scale: [16, 1.1, 16], color: "#c9a227", params: { holeX: 0.3, holeY: 0.3, profileCutEnd: 0.5 } });

  // Farolas.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.8;
    const x = Math.cos(a) * 11, z = Math.sin(a) * 11;
    const base = patchH(terrain, x, z);
    add({ name: "Poste de farola " + (i + 1), shape: "cylinder", position: [x, base + 2, z], scale: [0.28, 4, 0.28], color: "#33302b" });
    add({ name: "Farola " + (i + 1), shape: "sphere", position: [x, base + 4.3, z], scale: [1.1, 1.1, 1.1], color: "#ffe9b0", tag: "lamp", faceTex: true, params: { profileCutEnd: 0.55 } });
  }

  // La casa: muros, hueco de puerta, tejado a dos aguas y chimenea.
  const hx = 34, hz = -18;
  const hb = patchH(terrain, hx, hz);
  add({ name: "Muro norte", shape: "box", position: [hx, hb + 1.5, hz - 5], scale: [12, 3, 0.5], color: "#c8b58f" });
  add({ name: "Muro sur (con puerta)", shape: "box", position: [hx + 3, hb + 1.5, hz + 5], scale: [6, 3, 0.5], color: "#c8b58f" });
  add({ name: "Muro sur (lado)", shape: "box", position: [hx - 4.5, hb + 1.5, hz + 5], scale: [3, 3, 0.5], color: "#c8b58f" });
  add({ name: "Dintel", shape: "box", position: [hx + 3, hb + 3.3, hz + 5], scale: [6, 0.6, 0.5], color: "#bfa87f" });
  add({ name: "Muro este", shape: "box", position: [hx + 6, hb + 1.5, hz], scale: [0.5, 3, 10], color: "#c8b58f" });
  add({ name: "Muro oeste (con ventana)", shape: "box", position: [hx - 6, hb + 1.5, hz], scale: [0.5, 1.2, 10], color: "#c8b58f", params: { pathCutBegin: 0, pathCutEnd: 0.4 } });
  add({ name: "Muro oeste (alto)", shape: "box", position: [hx - 6, hb + 1.5, hz], scale: [0.5, 1.2, 10], color: "#8c8377" });
  add({ name: "Tejado", shape: "prism", position: [hx, hb + 3.6, hz], scale: [6.6, 4.4, 11.4], color: "#8a4a3a", params: { profileCutEnd: 1 } });
  add({ name: "Chimenea", shape: "cylinder", position: [hx + 4, hb + 4.9, hz - 3], scale: [0.8, 2.4, 0.8], color: "#7d4a3c" });
  add({ name: "Puerta", shape: "box", position: [hx + 3, hb + 1.5, hz + 4.8], scale: [3.4, 3, 0.24], color: "#6b4a2f" });

  // La torre del faro, al borde del agua, con su linterna y un tubo.
  const fx = -42, fz = 46;
  const fb = patchH(terrain, fx, fz);
  add({ name: "Torre del faro", shape: "cylinder", position: [fx, fb + 9, fz], scale: [5.4, 18, 5.4], color: "#e6e0d4", params: { hollow: 0.35 } });
  add({ name: "Barandilla", shape: "tube", position: [fx, fb + 18.4, fz], scale: [7.4, 0.3, 7.4], color: "#3b3b3b", params: { holeX: 1, holeY: 0.2 } });
  add({ name: "Linterna", shape: "cylinder", position: [fx, fb + 20, fz], scale: [3.2, 3, 3.2], color: "#ffe27a" });
  add({ name: "Cúpula", shape: "sphere", position: [fx, fb + 21.7, fz], scale: [3.3, 2.6, 3.3], color: "#b03a2e", params: { profileCutEnd: 0.5 } });
  add({ name: "Faro (remate)", shape: "prism", position: [fx, fb + 23.4, fz], scale: [0.6, 2.2, 0.6], color: "#33302b" });

  // Fuente: anillo + tubo + agua.
  const wx = -20, wz = -30;
  const wb = patchH(terrain, wx, wz);
  add({ name: "Brocal de la fuente", shape: "cylinder", position: [wx, wb + 0.5, wz], scale: [7, 1, 7], color: "#9aa0a6", params: { hollow: 0.8 } });
  add({ name: "Agua de la fuente", shape: "cylinder", position: [wx, wb + 0.85, wz], scale: [6.4, 0.2, 6.4], color: "#2f7fb5" });
  add({ name: "Columna de la fuente", shape: "tube", position: [wx, wb + 1.9, wz], scale: [1.6, 2.8, 1.6], color: "#b9b3a8", params: { holeX: 1, holeY: 0.35 } });
  add({ name: "Fuente", shape: "sphere", position: [wx, wb + 3.4, wz], scale: [2, 1.4, 2], color: "#8fd3f4", tag: "fountain", params: { hollow: 0.2, profileCutEnd: 0.55 } });

  // Árboles: tronco + copa de esfera (dos variantes de corte).
  for (let i = 0; i < 14; i++) {
    const x = (rng() - 0.5) * 150, z = (rng() - 0.5) * 150;
    if (Math.hypot(x, z) < 26) continue;
    const base = patchH(terrain, x, z);
    if (base < MOCK_REGION.waterLevel + 1.2) continue;
    const t = 1 + rng() * 0.8;
    add({ name: "Tronco " + (i + 1), shape: "cylinder", position: [x, base + 1.6 * t, z], scale: [0.5 * t, 3.2 * t, 0.5 * t], color: "#5b4634" });
    add({
      name: "Copa " + (i + 1), shape: "sphere", position: [x, base + 4 * t, z], scale: [3.4 * t, 3 * t, 3.4 * t],
      color: i % 2 ? "#3f7a3a" : "#356b34",
      params: { profileCutBegin: i % 3 === 0 ? 0.25 : 0, profileCutEnd: i % 3 === 0 ? 0.75 : 1 },
    });
  }

  // Cartel con script: el toque lo hace hablar (src/lsl/runtime.js).
  const sx = 8, sz = 18;
  const sb = patchH(terrain, sx, sz);
  add({ name: "Poste del cartel", shape: "cylinder", position: [sx, sb + 1, sz], scale: [0.24, 2, 0.24], color: "#4a4038" });
  add({
    name: "Cartel con script", shape: "box", position: [sx, sb + 2.4, sz], scale: [4.4, 1.6, 0.2], color: "#d8cfa6", tag: "sign", faceTex: true,
    script: "default {\n    state_entry() {\n        llSay(0, \"Cartel: toca para leer.\");\n    }\n    touch_start(integer n) {\n        llSay(0, \"Cartel: bienvenido a la Bahia de Pruebas.\");\n        llSetColor(<1, 0.85, 0.3>, ALL_SIDES);\n    }\n}\n",
  });

  // Estatua sobre pedestal (con una caja dentro para que el conjunto tenga
  // jerarquia, como un objeto enlazado de SL).
  const tx = -6, tz = 34;
  const tb = patchH(terrain, tx, tz);
  add({ name: "Pedestal", shape: "box", position: [tx, tb + 1.2, tz], scale: [4, 2.4, 4], color: "#a9a196" });
  add({ name: "Estatua", shape: "cylinder", position: [tx, tb + 4, tz], scale: [1.6, 4, 1.6], color: "#7f8c8d", params: { hollow: 0.4, pathCutEnd: 0.6 }, tag: "statue", faceTex: true });
  add({ name: "Estatua (cabeza)", shape: "sphere", position: [tx, tb + 6.4, tz], scale: [1.7, 1.7, 1.7], color: "#8d99a0" });

  return objs;
}

function patchH(terrain, x, z) { return heightAt(terrain, x, z); }

// --- el servidor ---------------------------------------------------------------

export function createMockServer(opts = {}) {
  const socket = opts.socket || null;
  const seed = opts.seed === undefined ? 20260917 : opts.seed;
  const rng = makeRng(seed);
  const terrain = buildTerrain(seed);
  const objects = buildObjects(terrain, rng);
  const stats = { patches: 0, objectsSent: 0, logins: 0, chatEchoes: 0, assetsServed: 0, ticks: 0 };
  const uuidOf = new Map();
  for (const o of objects) {
    const u = uuidFromId(o.id);
    o.uuid = u;
    uuidOf.set(u, o);
  }

  const walkers = RESIDENTS.slice(0, opts.residents === undefined ? 6 : opts.residents).map((name, i) => ({
    uuid: uuidFromId(1000 + i),
    name,
    phase: (i / 6) * Math.PI * 2,
    radius: 8 + (i % 4) * 5,
    speed: 0.06 + (i % 3) * 0.02,
    zig: i % 2 ? 1 : -1,
    flying: false,
    typing: false,
    sent: 0,
  }));

  let timer = null;
  let ambientAt = 0;
  let started = 0;
  let regionSent = false;
  let clientPos = { x: 0, y: 0, z: 0 };
  let chatCounter = 0;

  function send(type, write) { if (socket) socket.send(encode(type, write)); }
  function sendJson(type, obj) { if (socket) socket.send(encodeJson(type, obj)); }

  function sendState(phase, progress, text) {
    send(S.STATE, (w) => w.putU8(phase).putU8(progress).putStr(text || ""));
  }

  function terrainAtWalker(w, t) {
    const a = w.phase + t * w.speed;
    const x = Math.cos(a) * w.radius + Math.sin(a * 3) * 1.5;
    const z = Math.sin(a) * w.radius * w.zig;
    return { x, z, y: heightAt(terrain, x, z) + 0.05 };
  }

  function sendAvatars() {
    for (const w of walkers) {
      const p = terrainAtWalker(w, performance.now() / 1000);
      const yaw = Math.atan2(p.x, p.z);
      const q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      if (!w.sent) {
        w.sent = 1;
        send(S.AVATAR, (wr) => {
          wr.putUuid(w.uuid).putJson({
            name: w.name, position: [p.x, p.y, p.z], rotation: q,
            flags: 0, appearance: { seed: w.uuid, height: 1.7 + (w.name.length % 5) * 0.04, bodyType: "clasico" },
            attachments: [],
          });
        });
      } else {
        send(S.AVATAR_UPDATE, (wr) => {
          wr.putUuid(w.uuid).putF32(p.x).putF32(p.y).putF32(p.z).putF32(q[0]).putF32(q[1]).putF32(q[2]).putF32(q[3]).putU8((w.flying ? 1 : 0) | (w.typing ? 2 : 0));
        });
      }
    }
  }

  function say(name, text, uuid) {
    chatCounter++;
    walkers.forEach((w) => { if (w.name === name) w.typing = false; });
    send(S.CHAT, (w) => {
      w.putUuid(uuid || ZERO_UUID).putStr(name).putU8(0).putI16(0).putF32(0).putF32(0).putF32(0).putStr32(text);
    });
  }

  function tick() {
    stats.ticks++;
    const t = (performance.now() - started) / 1000;
    sendAvatars();
    if (t > ambientAt + 4) {
      ambientAt = t + 6 + rng() * 8;
      const w = walkers[Math.floor(rng() * walkers.length)];
      if (w) { w.typing = true; setTimeout(() => say(w.name, AMBIENT[Math.floor(rng() * AMBIENT.length)], w.uuid), 900); }
    }
    if (stats.ticks % 20 === 0) {
      sendJson(S.STATS, {
        pingMs: 0, packetLoss: 0, kbIn: Math.round(stats.patches * 1.03 + stats.objectsSent * 0.4),
        kbOut: 2, simFps: 44 + Math.round(rng() * 2), agents: walkers.length + 1,
        objects: objects.length, patches: stats.patches,
      });
    }
  }

  // Envia el terreno y el mobiliario, troceado, como haria un simulador de
  // verdad: el terreno por parches y los objetos de uno en uno (aqui llegan
  // todos de golpe porque la region entera es "el area de interes").
  function sendRegion(t0) {
    // La region se manda una sola vez: si llegase otro LOGIN (reconexion del
    // cliente, o un cliente que se presenta dos veces) no se repite el diluvio
    // de parches y objetos.
    if (regionSent) return;
    regionSent = true;
    sendState(PHASE.ENTERING, 5, "recibiendo el terreno…");
    let px = 0, py = 0;
    const stepPatches = () => {
      const from = performance.now();
      let n = 0;
      while (n < 24 && py < PATCHES) {
        send(S.TERRAIN, (w) => {
          w.putU8(px).putU8(py);
          const p = patchOf(terrain, px, py);
          for (let i = 0; i < p.length; i++) w.putF32(p[i]);
        });
        stats.patches++;
        n++;
        px++;
        if (px >= PATCHES) { px = 0; py++; }
      }
      sendState(PHASE.ENTERING, 5 + Math.round((stats.patches / (PATCHES * PATCHES)) * 45), "recibiendo el terreno…");
      if (py < PATCHES && performance.now() - from < 60) { setTimeout(stepPatches, 16); return; }
      if (py < PATCHES) { setTimeout(stepPatches, 16); return; }
      sendObjects();
    };
    stepPatches();
  }

  function sendObjects() {
    send(S.OBJECTS_BEGIN, (w) => w.putU32(objects.length));
    let i = 0;
    const step = () => {
      let n = 0;
      while (i < objects.length && n < 12) {
        const o = objects[i++];
        n++;
        stats.objectsSent++;
        send(S.OBJECT, (w) => {
          w.putUuid(o.uuid);
          w.putUuid(ZERO_UUID);
          w.putJson(recordFor(o));
        });
      }
      sendState(PHASE.ENTERING, 55 + Math.round((i / objects.length) * 35), "recibiendo los objetos…");
      if (i < objects.length) { setTimeout(step, 16); return; }
      send(S.OBJECTS_END, (w) => w.putU32(objects.length));
      sendJson(S.REGION_INFO, {
        region: MOCK_REGION.name, size: MOCK_REGION.size, waterLevel: MOCK_REGION.waterLevel,
        simVersion: MOCK_REGION.simVersion, handle: MOCK_REGION.handle,
        parcel: parcelInfo(),
      });
      sendJson(S.PARCEL, parcelInfo());
      sendAvatars();
      sendState(PHASE.READY, 100, "en la region");
      if (!timer) timer = setInterval(tick, TICK_MS);
    };
    setTimeout(step, 40);
  }

  function parcelInfo() {
    return {
      name: "Plaza de la Bahía", desc: "Region de pruebas del visor (no es Second Life)",
      area: 65536, owner: "Simulador de pruebas", flags: ["createObjects", "allowFly", "allowVoiceChat", "sandbox"],
      music: "", media: "", landing: [0, 0, 0], group: "", saleprice: 0,
    };
  }

  // El registro que viaja por el cable es el mismo que usa el mundo del editor,
  // mas un par de campos que el visor usa para el HUD (uuid y etiqueta).
  function recordFor(o) {
    return {
      id: o.id, uuid: o.uuid, name: o.name, shape: o.shape, params: o.params,
      position: o.position, quaternion: o.quaternion, scale: o.scale, color: o.color,
      faces: o.faces, script: o.script, desc: o.desc, build: o.build, phantom: o.phantom,
      owner: o.owner, parent: o.parent, local: o.local, tag: o.tag,
      slUuid: o.uuid,
    };
  }

  // --- texturas de pega -------------------------------------------------------
  // Un damero con el tono del objeto, generado a partir de su uuid: sirve para
  // comprobar el camino de recursos (S.ASSET) sin depender de la red.
  function textureFor(uuid, size = 64) {
    const h = hashUuid(uuid);
    const data = new Uint8Array(size * size * 4);
    const r = 40 + (h & 0xff), g = 40 + ((h >> 8) & 0xff), b = 40 + ((h >> 16) & 0xff);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = (((x >> 4) + (y >> 4)) & 1) ? 1 : 0.62;
        const i = (y * size + x) * 4;
        data[i] = Math.min(255, r * k * 1.5);
        data[i + 1] = Math.min(255, g * k * 1.5);
        data[i + 2] = Math.min(255, b * k * 1.5);
        data[i + 3] = 255;
      }
    }
    return data;
  }

  function onFrame(u8) {
    let f;
    try { f = decode(u8); } catch (e) { return; }
    switch (f.type) {
      case C.HELLO: {
        sendJson(S.WELCOME, {
          protocol: PROTOCOL,
          relay: "simulador de pruebas (en el navegador)",
          mock: true,
          authModes: ["credentials", "session"],
          region: { name: MOCK_REGION.name, handle: MOCK_REGION.handle, x: MOCK_REGION.regionX, y: MOCK_REGION.regionY, size: MOCK_REGION.size, waterLevel: MOCK_REGION.waterLevel, mock: true },
          capabilities: ["terrain", "objects", "avatars", "chat", "assets", "parcels", "stats"],
          limits: { maxAgents: 16, maxObjects: objects.length },
        });
        break;
      }
      case C.LOGIN: {
        stats.logins++;
        started = performance.now();
        const mode = (() => { try { const j = f.r.getJson(); return j.mode; } catch (e) { return "?"; } })();
        const how = mode === "credentials" ? "iniciando sesion (el retransmisor de pruebas hace el login)…"
          : (mode === "mock" ? "entrando en el simulador de pruebas…" : "abriendo una sesion ya iniciada…");
        sendState(PHASE.LOGIN_REQUEST, 0, how);
        setTimeout(() => sendState(PHASE.HANDSHAKE, 2, "abriendo el circuito…"), 350);
        setTimeout(() => sendRegion(started), 900);
        break;
      }
      case C.PING: {
        const t = f.r.getF64();
        send(S.PONG, (w) => w.putF64(t).putF64(performance.now()));
        break;
      }
      case C.CHAT: {
        const kind = f.r.getU8();
        const channel = f.r.getI16();
        let text = "";
        try { text = f.r.getStr32(); } catch (e) { text = ""; }
        stats.chatEchoes++;
        const who = walkers[chatCounter % walkers.length];
        if (who) {
          who.typing = true;
          setTimeout(() => say(who.name, (channel ? "(canal " + channel + ") " : "") + replyTo(text), who.uuid), 700 + rng() * 900);
        }
        break;
      }
      case C.MOVE: {
        clientPos = { x: f.r.getF32(), y: f.r.getF32(), z: f.r.getF32() };
        f.r.getF32();
        f.r.getU8();
        break;
      }
      case C.INTERACT: {
        const action = f.r.getU8();
        let uuid = ZERO_UUID;
        try { uuid = f.r.getUuid(); } catch (e) { uuid = ZERO_UUID; }
        const o = uuidOf.get(uuid);
        if (o) setTimeout(() => say(o.name, TOUCH_REPLY[o.tag] || TOUCH_REPLY.default, o.uuid), 400);
        else if (action === 0) setTimeout(() => say("Región", "No hay nada que tocar ahi."), 400);
        break;
      }
      case C.REQUEST: {
        const what = f.r.getU8();
        if (what === RES.TEXTURE) {
          const uuid = f.r.getStr();
          const data = textureFor(uuid);
          stats.assetsServed++;
          send(S.ASSET, (w) => putAsset(w, {
            uuid: /^[0-9a-f-]{36}$/.test(uuid) ? uuid : ZERO_UUID,
            format: ASSET_FORMAT.RGBA8, width: 64, height: 64, data,
          }));
        } else if (what === RES.INVENTORY) {
          sendJson(S.INVENTORY, mockInventory());
        }
        break;
      }
      case C.TELEPORT: {
        const region = f.r.getStr();
        sendState(PHASE.TELEPORT, 0, "teletransportando a " + (region || "otra region") + "…");
        setTimeout(() => sendState(PHASE.READY, 100, "en la region"), 1200);
        break;
      }
      case C.LOGOUT: {
        stop();
        break;
      }
      default: break;
    }
  }

  function replyTo(text) {
    const t = String(text || "").toLowerCase();
    if (/invitad|invita|quien eres|quién eres/.test(t)) return "Soy " + RESIDENTS[0] + ". Esta region es de pruebas, pero me muevo como en Second Life.";
    if (/d[oó]nde|far[oa]|plaza|agua|mar\b/.test(t)) return "El faro está al suroeste, junto al agua. La plaza queda en el centro, alrededor de la fuente.";
    if (/ayuda|help|c[oó]mo|como /.test(t)) return "Toca el cartel de la plaza y te lo explico. Con las flechas te mueves y arrastrando la pantalla giras la vista.";
    if (/hola|buenas|hey|qu[eé] tal/.test(t)) return "¡Hola! Bienvenido a la bahía.";
    if (/vuel[ao]s|volar|fly/.test(t)) return "Aquí se puede volar: mantén pulsado el botón de salto y empuja hacia arriba.";
    if (/\?$/.test(t)) return "Buena pregunta. Prueba a mirar el cartel de la plaza.";
    return "Te leo perfectamente.";
  }

  function mockInventory() {
    return {
      root: "Carpeta principal", folders: ["Objetos", "Texturas", "Scripts", "Ropa"],
      items: [
        { name: "Cubo de madera", shape: "box", type: "objeto" },
        { name: "Cilindro de piedra", shape: "cylinder", type: "objeto" },
        { name: "Toro dorado", shape: "torus", type: "objeto" },
        { name: "Cartel con script", shape: "box", type: "objeto" },
      ],
    };
  }

  function start() {
    if (!socket) return null;
    socket.addEventListener("message", (ev) => {
      const d = ev && ev.data;
      const u8 = d instanceof ArrayBuffer ? new Uint8Array(d) : (d && d.buffer ? new Uint8Array(d.buffer) : null);
      if (u8) onFrame(u8);
    });
    if (socket.readyState === 1) socket.emit("open", {});
    return api;
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    sendState(PHASE.DISCONNECTED, 0, "el simulador de pruebas se ha detenido");
    if (socket) setTimeout(() => { try { socket.close(1000, "fin"); } catch (e) { /* ya cerrado */ } }, 10);
  }

  const api = {
    socket, region: { info: MOCK_REGION, terrain, objects, walkers },
    stats, terrainAt: (x, z) => heightAt(terrain, x, z), parcel: parcelInfo,
    objectAt: (uuid) => uuidOf.get(uuid) || null, start, stop,
    objectCount: () => objects.length,
  };
  return api;
}

// Id estable a partir del id numerico (los objetos de esta region inventada).
function uuidFromId(n) {
  const hex = (n >>> 0).toString(16).padStart(8, "0");
  return hex + "-0000-4000-8000-" + hex.padStart(12, "0");
}

function hashUuid(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// --- enlace listo para `createRelay` ---------------------------------------

export function createMockRelay(opts = {}) {
  const pair = loopbackPair();
  const server = createMockServer(Object.assign({}, opts, { socket: pair.server }));
  server.start();
  return {
    url: "loopback://simulador-de-pruebas",
    socketFactory: () => pair.client,
    server,
    pair,
    mock: true,
    label: "Simulador de pruebas (en el navegador)",
  };
}

// --- autotest ---------------------------------------------------------------

export async function runMockSelfTest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const ok = (name, cond, detail) => checks.push({ name, ok: !!cond, got: detail });

  const mock = createMockRelay({ seed: 7, residents: 4 });
  const info = { patches: 0, objects: 0, avatars: 0, chat: [], stats: 0, phases: [], regionInfo: null, parcel: null, assets: 0, asset: null, began: 0 };
  const t0 = performance.now();

  const relay = createRelayFor(mock, {
    onMessage(type, r) {
      switch (type) {
        case S.TERRAIN: r.getU8(); r.getU8(); r.getBytes(r.remaining); info.patches++; break;
        case S.OBJECT: r.getUuid(); r.getUuid(); r.getJson(); info.objects++; break;
        case S.AVATAR: r.getUuid(); r.getJson(); info.avatars++; break;
        case S.CHAT: {
          r.getUuid(); const name = r.getStr(); r.getU8(); r.getI16(); r.getF32(); r.getF32(); r.getF32();
          info.chat.push(name + ": " + r.getStr32());
          break;
        }
        case S.STATS: r.getJson(); info.stats++; break;
        case S.OBJECTS_BEGIN: info.began = r.getU32(); break;
        case S.REGION_INFO: info.regionInfo = r.getJson(); break;
        case S.PARCEL: info.parcel = r.getJson(); break;
        case S.ASSET: {
          const a = readAsset(r);
          info.assets++;
          info.asset = { format: a.format, width: a.width, height: a.height, bytes: a.data.length, uuid: a.uuid };
          break;
        }
        default: break;
      }
    },
    onState(s) {
      if (info.phases[info.phases.length - 1] !== s.phase) info.phases.push(s.phase);
    },
  });

  function createRelayFor(m, handlers) {
    return createRelay({
      url: m.url, socketFactory: m.socketFactory, autoConnect: true,
      onMessage: handlers.onMessage, onState: handlers.onState,
    });
  }

  await waitFor(() => relay.ready, 6000);
  ok("enlace listo", relay.ready, relay.state.link);
  eq("region anunciada", relay.state.region.name, MOCK_REGION.name);
  ok("es simulador", relay.state.mock === true, relay.state.mock);

  // Entrar de verdad: mandar el LOGIN como haria el visor tras autenticarse.
  relay.sendCredentials({ grid: "mock", name: "Visitante Prueba", start: "last" });
  await waitFor(() => info.patches >= PATCH_PATCHES, 8000);
  await waitFor(() => info.objects >= mock.server.objectCount(), 8000);
  await waitFor(() => relay.state.phase === PHASE.READY, 8000);

  eq("parches de terreno", info.patches, 256);
  eq("objetos recibidos", info.objects, mock.server.objectCount());
  ok("hay bastantes objetos", info.objects > 40, info.objects);
  eq("conteo anunciado", info.began, info.objects);
  ok("avatares recibidos", info.avatars >= 4, info.avatars);
  ok("info de region", info.regionInfo && info.regionInfo.waterLevel === MOCK_REGION.waterLevel, info.regionInfo);
  ok("parcela", info.parcel && /Bahía/.test(info.parcel.name), info.parcel && info.parcel.name);
  eq("fase final", relay.state.phase, PHASE.READY);

  // Chat: el simulador contesta con uno de sus residentes.
  relay.sendChat(0, 0, "hola, ¿dónde está el faro?");
  await waitFor(() => info.chat.length > 0, 4000);
  ok("el residente contesta", info.chat.length > 0, info.chat.join(" | "));
  ok("y contesta al faro", /faro/i.test(info.chat.join(" ")), info.chat.join(" | "));

  // Estadisticas y textura.
  const statsBefore = info.stats;
  relay.request(0, "11111111-2222-3333-4444-555555555555");
  await waitFor(() => info.assets > 0, 3000);
  ok("recurso servido", info.assets > 0, info.assets);
  ok("textura RGBA de 64x64", info.asset && info.asset.format === ASSET_FORMAT.RGBA8 && info.asset.width === 64 && info.asset.height === 64 && info.asset.bytes === 64 * 64 * 4, info.asset);
  ok("el recurso lleva su uuid", info.asset && /^1111/.test(info.asset.uuid), info.asset && info.asset.uuid);
  await waitFor(() => info.stats > statsBefore, 5000);
  ok("estadisticas del simulador", info.stats > statsBefore, info.stats);

  relay.close();
  await waitFor(() => relay.state.link === "closed", 2000);
  eq("se cierra", relay.state.link, "closed");
  ok("la cosa tardo poco", performance.now() - t0 < 20000, Math.round(performance.now() - t0) + " ms");

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed, phases: info.phases };
}

const PATCH_PATCHES = 256;

function waitFor(cond, ms) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const poll = () => {
      let v = false;
      try { v = !!cond(); } catch (e) { v = false; }
      if (v || performance.now() - t0 > ms) return resolve(v);
      setTimeout(poll, 20);
    };
    poll();
  });
}
