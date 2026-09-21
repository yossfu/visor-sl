// Sculpt-prim harness (?test=sculpt).
//
// Sculpted prims are the one part of the world whose geometry is *data*: the
// shape lives in an image, not in the prim's profile and path. That makes it
// easy to get subtly — but visibly — wrong (mirrored, squashed, or drawn as the
// base cube when the map has not arrived), which is why it has its own isolated
// scene: one row of sculpted prims, each from a map whose shape is known, plus
// the two cases that must draw *nothing*.
//
// The maps are generated the same way a creator's would be: R,G,B are the
// vertex's X,Y,Z (0..255 -> -0.5..0.5).
import { proceduralTerrain } from "../terrain.js";

const TERRAIN_SEED = 7;

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Builds a sculpt map canvas from a function of the normalised map coordinates
 * (u across the columns, v down the rows) returning a point in -0.5..0.5.
 */
function mapCanvas(size, fn) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = fn(x, y, size);
      const o = (y * size + x) * 4;
      img.data[o] = clamp255((p[0] + 0.5) * 255);
      img.data[o + 1] = clamp255((p[1] + 0.5) * 255);
      img.data[o + 2] = clamp255((p[2] + 0.5) * 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Latitude/longitude sphere. The top and bottom rows are the poles (a single
 *  point each), which is what the "sphere" stitching pinches them into. */
function sphereMap(size = 64) {
  return mapCanvas(size, (x, y, n) => {
    const u = x / (n - 1) * Math.PI * 2;
    const v = y / (n - 1) * Math.PI;
    const r = Math.sin(v) * 0.5;
    return [r * Math.cos(u), r * Math.sin(u), Math.cos(v) * 0.5];
  });
}

/** A donut: both seams wrap, so no row or column is special. */
function torusMap(size = 64) {
  return mapCanvas(size, (x, y, n) => {
    const a = x / n * Math.PI * 2;
    const b = y / n * Math.PI * 2;
    const R = 0.34, r = 0.16;
    const rr = R + r * Math.cos(b);
    return [rr * Math.cos(a), rr * Math.sin(a), r * Math.sin(b)];
  });
}

/** A wavy sheet: nothing wraps, the edges are just the edges. */
function planeMap(size = 64) {
  return mapCanvas(size, (x, y, n) => {
    const u = x / (n - 1) * 2 - 1;
    const v = y / (n - 1) * 2 - 1;
    const d = Math.sqrt(u * u + v * v);
    return [u * 0.5, v * 0.5, Math.cos(Math.min(d, 1) * Math.PI) * 0.28];
  });
}

/** A tube: the column seam wraps one way round, the rows run along the axis. */
function cylinderMap(size = 64) {
  return mapCanvas(size, (x, y, n) => {
    const a = x / n * Math.PI * 2;
    const v = y / (n - 1) * 2 - 1;
    return [Math.cos(a) * 0.4, Math.sin(a) * 0.4, v * 0.5];
  });
}

/** A single flat colour: no relief at all, so no shape to draw. */
function flatMap(size = 32) {
  return mapCanvas(size, () => [0, 0, 0]);
}

export async function runSculptTest(app) {
  const world = app.world;
  if (app.ui && app.ui.hideModal) app.ui.hideModal();
  if (world.setTerrain) world.setTerrain(proceduralTerrain(TERRAIN_SEED, { island: false }));
  world.settings = world.settings || {};

  const maps = [
    ["esfera", "scul-1111-0000-0000-0000-000000000001", sphereMap(), { sculptType: 1 }],
    ["toro", "scul-2222-0000-0000-0000-000000000002", torusMap(), { sculptType: 2 }],
    ["plano", "scul-3333-0000-0000-0000-000000000003", planeMap(), { sculptType: 3 }],
    ["cilindro", "scul-4444-0000-0000-0000-000000000004", cylinderMap(), { sculptType: 4 }],
    ["espejo", "scul-8888-0000-0000-0000-000000000008", torusMap(), { sculptType: 2 | 0x80 }],
  ];
  for (const [, uuid, canvas] of maps) world.setSculptMap(uuid, canvas);

  const x0 = 108, y0 = 118, step = 7;
  maps.forEach(([name, uuid, , flags], i) => {
    const x = x0 + (i - (maps.length - 1) / 2) * step;
    world.addPrim({
      id: `sculpt-${i}-0000-0000-0000-000000000000`,
      name: `escultura ${name}`,
      params: Object.assign({ profileCurve: 0, pathCurve: 32, sculptId: uuid }, flags),
      scale: [4, 4, 4],
      position: [x, y0, 6],
      rotation: [0, 0, 0, 1],
      texture: { all: "gen:grid" },
    });
  });

  // These two must draw nothing at all: a mesh (whose geometry is an asset this
  // viewer does not decode yet) and a sculpt map with no relief in it. Drawing
  // either as its base cube is the "cuadrículas blancas" complaint.
  world.addPrim({
    id: "sculpt-mesh-0000-0000-0000-000000000000",
    name: "mesh (no debe dibujarse)",
    params: { profileCurve: 1, pathCurve: 16, sculptType: 5, sculptId: "mesh-5555-0000-0000-0000-000000000005" },
    scale: [4, 4, 4], position: [x0 - step * 3.5, y0, 6], rotation: [0, 0, 0, 1],
  });
  const flatId = "flat-6666-0000-0000-0000-000000000006";
  world.setSculptMap(flatId, flatMap());
  world.addPrim({
    id: "sculpt-flat-0000-0000-0000-000000000000",
    name: "mapa plano (no debe dibujarse)",
    params: { profileCurve: 0, pathCurve: 32, sculptType: 1, sculptId: flatId },
    scale: [4, 4, 4], position: [x0 + step * 3.5, y0, 6], rotation: [0, 0, 0, 1],
  });

  if (app.viewer && app.viewer.controls && app.viewer.controls.focus) {
    app.viewer.controls.focus([x0, y0, 6], 34);
  }

  const stats = world.refreshSculptStats();
  const drawn = [...world.objects.values()].filter((r) => r.vol && r.shapeKind === "sculpt").length;
  app.ui.log(`Esculturas: ${drawn} dibujadas · ${stats.mesh} mesh (no dibujables) · ${stats.degenerate} mapas sin relieve · ${stats.waiting} esperando su mapa.`);
  return { sculpted: stats.sculpted, drawn, stages: stats, objects: world.objects.size };
}
