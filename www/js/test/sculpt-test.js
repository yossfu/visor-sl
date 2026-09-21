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
import { houseMeshAsset } from "../mesh-encode.js";

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
  if (world.setTerrain) {
    // A flat plain: the terrain generator makes hills around z≈46, and a shape
    // harness wants the shapes, not a slope (nor objects buried inside the
    // ground, which is what the hilly version looked like).
    const flat = proceduralTerrain(TERRAIN_SEED, { island: false });
    flat.samples.fill(0);
    world.setTerrain(flat);
  }
  world.settings = world.settings || {};

  const maps = [
    ["esfera", "scul-1111-0000-0000-0000-000000000001", sphereMap(), { sculptType: 1 }],
    ["toro", "scul-2222-0000-0000-0000-000000000002", torusMap(), { sculptType: 2 }],
    ["plano", "scul-3333-0000-0000-0000-000000000003", planeMap(), { sculptType: 3 }],
    ["cilindro", "scul-4444-0000-0000-0000-000000000004", cylinderMap(), { sculptType: 4 }],
    ["espejo", "scul-8888-0000-0000-0000-000000000008", torusMap(), { sculptType: 2 | 0x80 }],
  ];
  for (const [, uuid, canvas] of maps) world.setSculptMap(uuid, canvas);

  const x0 = 108, y0 = 118;
  // The preview (and the phone) is a *portrait* viewport, so a long row does not
  // fit: the exhibits are laid out on a ring around the centre instead, and the
  // camera looks down at it. Every shape is then on screen at once.
  const RING = 7;
  const spot = (i, n) => {
    const a = (i / n) * Math.PI * 2;
    return [x0 + Math.cos(a) * RING, y0 + Math.sin(a) * RING];
  };
  const exhibits = [...maps, [
    "malla con activo (debe dibujarse)", "mesh-7777-0000-0000-0000-000000000007", null,
    { sculptType: 5, isMesh: true },
  ]];
  exhibits.forEach(([name, uuid, canvas, flags], i) => {
    const p = spot(i, exhibits.length);
    const prim = {
      id: `sculpt-${i}-0000-0000-0000-000000000000`,
      name: `escultura ${name}`,
      params: Object.assign({ profileCurve: 0, pathCurve: 32, sculptId: uuid }, flags),
      // A mesh's vertices are in *metres* (like SL's uploader writes them), so
      // the prim's scale multiplies that: the house asset is 6.4 m across, and
      // scale 1 is what makes it a house rather than a stadium. Sculpt maps are
      // normalised (-0.5..0.5), hence the 4.
      scale: flags && flags.isMesh ? [1, 1, 1] : [4, 4, 4],
      position: [p[0], p[1], 6],
      rotation: [0, 0, 0, 1],
      texture: { all: "gen:grid" },
    };
    if (flags && flags.isMesh) {
      // The house's two submeshes carry different materials: face 0 the walls,
      // face 1 the roof. If the material↔face mapping were wrong the whole
      // building would come out one colour, which is easy to see.
      prim.texture = { all: "gen:brick" };
      prim.textureByFace = { 0: "gen:brick", 1: "gen:roof" };
    }
    delete prim.params.isMesh;
    world.addPrim(prim);
  });

  // What must draw nothing: a sculpt map with no relief in it, and a MESH whose
  // asset has not arrived. Drawing either as its base cube is the "cuadrículas
  // blancas" complaint. (A mesh *with* its asset is drawn now — that is the ring
  // above, built from a real LLMESH asset.) Both sit inside the ring, where a
  // drawn cube would be impossible to miss.
  world.addPrim({
    id: "sculpt-mesh-0000-0000-0000-000000000000",
    name: "malla sin activo (no debe dibujarse)",
    params: { profileCurve: 1, pathCurve: 16, sculptType: 5, sculptId: "mesh-5555-0000-0000-0000-000000000005" },
    scale: [3, 3, 3], position: [x0 - 5.5, y0 - 8.5, 6], rotation: [0, 0, 0, 1],
  });
  const flatId = "flat-6666-0000-0000-0000-000000000006";
  world.setSculptMap(flatId, flatMap());
  world.addPrim({
    id: "sculpt-flat-0000-0000-0000-000000000000",
    name: "mapa plano (no debe dibujarse)",
    params: { profileCurve: 0, pathCurve: 32, sculptType: 1, sculptId: flatId },
    scale: [3, 3, 3], position: [x0 + 5.5, y0 - 8.5, 6], rotation: [0, 0, 0, 1],
  });

  // The mesh's asset is supplied in memory: the same `LLMESH` decode path the
  // grid uses (GetMesh), only the download is skipped because there is no grid
  // in this harness.
  const meshOk = "mesh-7777-0000-0000-0000-000000000007";
  const house = await houseMeshAsset();
  world.setMeshAsset(meshOk, house.bytes);

  if (app.viewer && app.viewer.controls && app.viewer.controls.focus) {
    const ctl = app.viewer.controls;
    ctl.yaw = 0;
    ctl.pitch = 0.7;
    ctl.focus([x0, y0, 6], 38);
  }

  // The mesh's LOD inflates on a worker, so give it a moment to land: the scene
  // must be judged *after* the asset is decodable, not merely after it arrived.
  const meshPrimId = "sculpt-5-0000-0000-0000-000000000000";
  for (let i = 0; i < 40; i++) {
    const rec = world.objects.get(meshPrimId);
    if (rec && rec.vol) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const stats = world.refreshSculptStats();
  const drawn = [...world.objects.values()].filter((r) => r.vol && r.shapeKind === "sculpt").length;
  const meshes = [...world.objects.values()].filter((r) => r.shapeKind === "mesh");
  const meshDrawn = meshes.filter((r) => r.vol).length;
  app.ui.log(`Esculturas: ${drawn} dibujadas · mallas: ${meshDrawn} dibujadas de ${meshes.length} (${stats.meshDrawn ?? meshDrawn} activas, ${stats.meshWaiting ?? (meshes.length - meshDrawn)} esperando activo) · ${stats.degenerate} mapas sin relieve · ${stats.waiting} esperando su mapa.`);
  return { sculpted: stats.sculpted, drawn, meshDrawn, meshTotal: meshes.length, stages: stats, objects: world.objects.size };
}
