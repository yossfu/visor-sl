// Demo region: a synthetic "sandbox" built entirely from real SL prims so the
// geometry engine can be exercised and evaluated offline (no grid connection).
import { proceduralTerrain } from "./terrain.js";

const CUBE = { profileCurve: 1, pathCurve: 16 };
const CYL = { profileCurve: 0, pathCurve: 16 };
const SPHERE = { profileCurve: 5, pathCurve: 32 };
const TORUS = { profileCurve: 0, pathCurve: 32, pathScaleX: 100, pathScaleY: 40 };
const TUBE = { profileCurve: 16, pathCurve: 16, profileHollow: 9000 };
const RING = { profileCurve: 0, pathCurve: 32, profileEnd: 15000 };
const PRISM = { profileCurve: 3, pathCurve: 16 };
const CONE = { profileCurve: 0, pathCurve: 16, pathScaleX: 0 };

let seq = 0;
const id = (p) => `${p}-${(++seq).toString(16).padStart(6, "0")}-0000-0000-0000-000000000000`;

export function buildDemoRegion(world, opts = {}) {
  const seed = opts.seed ?? 1337;
  const terrain = proceduralTerrain(seed, { island: true });
  world.setTerrain(terrain);

  const H = (x, y) => world.heightAt(x, y);

  // ---- showcase gallery -------------------------------------------------
  const shapes = [
    ["Cube", CUBE, [1, 1, 1]],
    ["Cylinder", CYL, [1, 1, 1.4]],
    ["Sphere", SPHERE, [1.2, 1.2, 1.2]],
    ["Torus", TORUS, [1.3, 1.3, 1.3]],
    ["Tube (hollow)", TUBE, [1.1, 1.1, 1.6]],
    ["Ring (path cut)", RING, [1.4, 1.4, 1.4]],
    ["Prism", PRISM, [1, 1, 1.3]],
    ["Sloped cone", CONE, [1, 1.5, 1.5]],
    ["Tapered", Object.assign({}, CUBE, { pathScaleX: 55 }), [1.2, 1.2, 1.2]],
    ["Twisted", Object.assign({}, CUBE, { pathTwist: 150 }), [0.9, 0.9, 2.2]],
    ["Hollow cube", Object.assign({}, CUBE, { profileHollow: 5000 }), [1.2, 1.2, 1.2]],
    ["Cut tube", Object.assign({}, TUBE, { profileBegin: 8000 }), [1.1, 1.1, 1.6]],
  ];
  const galleryX = 92, galleryY = 148;
  shapes.forEach((s, i) => {
    const [name, params, scale] = s;
    const x = galleryX + (i % 6) * 6.5;
    const y = galleryY + Math.floor(i / 6) * 8;
    const z = H(x, y) + 1.6;
    world.addPrim({
      id: id("shape"), name, params, scale, position: [x, y, z],
      rotation: [0, 0, 0, 1],
      textureByFace: {}, texture: { all: i % 3 === 0 ? "gen:grid" : i % 3 === 1 ? "gen:metal" : "gen:wood" },
      material: 0,
    });
    // pedestal
    world.addPrim({
      id: id("pedestal"), name: `${name} pedestal`,
      params: Object.assign({}, CUBE, { pathScaleX: 60, pathScaleY: 60 }),
      scale: [1.5, 1.5, 1.2], position: [x, y, H(x, y) + 0.6],
      rotation: [0, 0, 0, 1], texture: { all: "gen:brick" },
    });
    // floating label
    world.addPrim({
      id: id("label"), name: `label:${name}`,
      params: Object.assign({}, CUBE, { pathScaleY: 40 }),
      scale: [3.2, 0.75, 0.1], position: [x, y, z + 1.5],
      rotation: [0, 0, 0, 1], textureByFace: {}, texture: { all: `gen:sign:${name}` },
      fullbright: true,
    });
  });

  // ---- plaza ------------------------------------------------------------
  const px = 128, py = 128;
  const pz = H(px, py);
  world.addPrim({
    id: id("plaza"), name: "plaza",
    params: Object.assign({}, CUBE, { profileCurve: 0, pathScaleX: 50, pathScaleY: 50 }),
    scale: [46, 46, 0.6], position: [px, py, pz + 0.3], rotation: [0, 0, 0, 1],
    texture: { all: "gen:stone" }, repeat: [6, 6],
  });

  // ---- lighthouse -------------------------------------------------------
  const lx = 128, ly = 108;
  const lz = H(lx, ly);
  world.addPrim({
    id: id("tower"), name: "tower", params: Object.assign({}, CYL, { pathScaleX: 70 }), scale: [6, 6, 18],
    position: [lx, ly, lz + 9], rotation: [0, 0, 0, 1], texture: { all: "gen:brick" }, repeat: [4, 6],
  });
  world.addPrim({
    id: id("towerTop"), name: "tower top", params: CYL, scale: [7.5, 7.5, 1.6],
    position: [lx, ly, lz + 18.8], rotation: [0, 0, 0, 1], texture: { all: "gen:metal" },
  });
  world.addPrim({
    id: id("lamp"), name: "lamp", params: SPHERE, scale: [3.4, 3.4, 3.4],
    position: [lx, ly, lz + 21.5], rotation: [0, 0, 0, 1],
    texture: { all: "gen:grid" }, fullbright: true, glow: 1,
  });

  // ---- pavilion (walls + roof from prims) --------------------------------
  buildPavilion(world, H, 152, 128, id);

  // ---- floating sculpture (well clear of the plaza) ----------------------
  const scx = 186, scy = 96, scz = pz + 18;
  world.addPrim({
    id: id("sculptA"), name: "sculpture", params: TORUS, scale: [4.2, 4.2, 4.2],
    position: [scx, scy, scz], rotation: [0.38, 0, 0.2, 0.9], texture: { all: "gen:metal" },
  });
  world.addPrim({
    id: id("sculptB"), name: "sculpture core", params: SPHERE, scale: [1.4, 1.4, 1.4],
    position: [scx, scy, scz], rotation: [0, 0, 0, 1],
    texture: { all: "gen:metal" }, fullbright: true, glow: 0.85,
  });
  for (let i = 0; i < 3; i++) {
    const r = 3.4 + i * 1.3;
    world.addPrim({
      id: id("ring"), name: `neon ring ${i + 1}`,
      params: Object.assign({}, RING, { profileEnd: 3000 }),
      scale: [r, r, r],
      position: [scx, scy, scz],
      rotation: [0.5 + i * 0.3, 0.1 * i, Math.cos(i) * 0.4, 0.8],
      texture: { all: "gen:grid" }, fullbright: true, glow: 0.7,
    });
  }

  // ---- trees -------------------------------------------------------------
  const rnd = mulberry(seed ^ 0x9e3779b9);
  for (let i = 0; i < 70; i++) {
    const x = 20 + rnd() * 216, y = 20 + rnd() * 216;
    const h = H(x, y);
    if (h < 21 || Math.hypot(x - px, y - py) < 30) continue;
    if (Math.hypot(x - galleryX - 8, y - galleryY - 4) < 22) continue;
    const scale = 0.7 + rnd() * 0.9;
    world.addPrim({
      id: id("trunk"), name: "trunk", params: Object.assign({}, CYL, { pathScaleX: 40, pathScaleY: 40 }),
      scale: [0.5 * scale, 0.5 * scale, 4 * scale],
      position: [x, y, h + 2 * scale], rotation: [0, 0, 0, 1], texture: { all: "gen:wood" }, repeat: [1, 2],
    });
    const kind = rnd();
    world.addPrim({
      id: id("leaf"), name: "foliage",
      params: kind < 0.5 ? SPHERE : Object.assign({}, CYL, { pathScaleX: 0, pathScaleY: 0, pathCurve: 16 }),
      scale: [3.4 * scale, 3.4 * scale, 5 * scale],
      position: [x, y, h + 5.2 * scale], rotation: [0, 0, 0, 1], texture: { all: "gen:leaf" },
    });
  }

  // ---- pier --------------------------------------------------------------
  for (let i = 0; i < 12; i++) {
    world.addPrim({
      id: id("pier"), name: "pier plank", params: CUBE,
      scale: [3, 1.6, 0.3], position: [128, 128 - 30 - i * 1.8, 21.4],
      rotation: [0, 0, 0, 1], texture: { all: "gen:wood" },
    });
  }

  return { terrain, pz };
}

function buildPavilion(world, H, cx, cy, id) {
  const size = 11, wallH = 4.2;
  const base = H(cx, cy);
  // floor
  world.addPrim({
    id: id("floor"), name: "floor", params: CUBE, scale: [size + 3, size + 3, 0.4],
    position: [cx, cy, base + 0.2], rotation: [0, 0, 0, 1], texture: { all: "gen:wood" }, repeat: [4, 4],
  });
  for (let i = 0; i < 4; i++) {
    const ang = i * Math.PI / 2;
    const rot = [0, 0, Math.sin(ang / 2), Math.cos(ang / 2)];
    const ox = Math.cos(ang) * size / 2, oy = Math.sin(ang) * size / 2;
    // wall
    world.addPrim({
      id: id("wall"), name: "wall", params: CUBE, scale: [size, 0.4, wallH],
      position: [cx + ox, cy + oy, base + wallH / 2 + 0.4], rotation: rot, texture: { all: "gen:brick" }, repeat: [4, 2],
    });
    // column at each corner
    world.addPrim({
      id: id("col"), name: "column", params: CYL, scale: [0.7, 0.7, wallH + 1],
      position: [cx + Math.cos(ang + Math.PI / 4) * size * 0.72, cy + Math.sin(ang + Math.PI / 4) * size * 0.72, base + (wallH + 1) / 2 + 0.4],
      rotation: [0, 0, 0, 1], texture: { all: "gen:metal" },
    });
  }
  // roof (rotated pyramid-ish cone)
  world.addPrim({
    id: id("roof"), name: "roof",
    params: Object.assign({}, CYL, { profileCurve: 4, pathScaleX: 0, profileBegin: 0 }),
    scale: [size + 3, size + 3, 3.2], position: [cx, cy, base + wallH + 2], rotation: [0, 0, 0, 1],
    texture: { all: "gen:roof" }, repeat: [4, 4],
  });
  // glass panes
  world.addPrim({
    id: id("glass"), name: "glass", params: CUBE, scale: [size - 2, size - 2, wallH - 1.6],
    position: [cx, cy, base + wallH / 2 + 0.4], rotation: [0, 0, 0, 1],
    texture: { all: "gen:grid" }, rgba: [0.7, 0.85, 1, 0.22], transparent: true,
  });
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
