// Stress harness: builds a dense region (hundreds of prims with real textures)
// and reports the frame rate, draw calls and cache sizes. This is the only way
// to see whether a change actually helps on the GPU the viewer will run on — a
// region that looks fine with 40 prims can be a slideshow with 1500, and the
// phone is the target.
//
// Run it from the live preview with `?test=stress` (or call it directly).
import * as THREE from "../../vendor/three.module.min.js";
import { defaultPrimParams, primToFaces } from "../prims.js";

const SHAPES = [
  { profileCurve: 1, pathCurve: 16 },
  { profileCurve: 0, pathCurve: 16 },
  { profileCurve: 5, pathCurve: 32 },
  { profileCurve: 0, pathCurve: 32, pathScaleY: 40 },
  { profileCurve: 16, pathCurve: 16, profileHollow: 9000 },
  { profileCurve: 3, pathCurve: 16 },
  { profileCurve: 1, pathCurve: 16, pathTwist: 90 },
  { profileCurve: 1, pathCurve: 16, pathTaperX: -0.4 },
];

function noiseTexture(size, seed) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  let s = seed * 7919;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = 60 + ((s >> 16) & 0xbf);
    img.data[i] = v;
    img.data[i + 1] = (v * 3) & 0xff;
    img.data[i + 2] = (v * 7) & 0xff;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = "rgba(255,255,255,.25)";
  ctx.fillRect(0, 0, size, 6);
  return c;
}

/**
 * Fills the world with `count` prims on a grid, gives them a handful of real
 * textures, points the camera at them and measures for `seconds`.
 */
export async function runStress(app, opts = {}) {
  const count = opts.count || 1200;
  const seconds = opts.seconds || 4;
  const textureCount = opts.textures || 8;
  const world = app.world;

  world.reset();
  // Above the water line (the region's default sea level is 20 m) so the field
  // is not rendered through the water plane.
  app.viewer.water.setLevel(-8);
  const uuids = [];
  for (let t = 0; t < textureCount; t++) {
    const uuid = ("a1b2c3d4-0000-4000-8000-00000000000" + t).slice(0, 36);
    uuids.push(uuid);
    world.applyTexture(uuid, noiseTexture(256, t + 1));
  }

  const perRow = Math.ceil(Math.sqrt(count));
  const spacing = 5;
  const t0 = performance.now();
  for (let i = 0; i < count; i++) {
    const x = 8 + (i % perRow) * spacing;
    const y = 8 + Math.floor(i / perRow) * spacing;
    const shape = SHAPES[i % SHAPES.length];
    const tex = uuids[i % uuids.length];
    world.addPrim({
      id: "stress-" + i,
      params: defaultPrimParams(shape),
      position: [x, y, 1 + (i % 3)],
      scale: [1.6, 1.6, 1.6],
      rotation: [0, 0, Math.sin(i) * 0.3, Math.cos(i) * 0.95],
      texture: { all: tex },
      name: "stress",
    });
  }
  const buildMs = performance.now() - t0;

  // Look at the middle of the field from a few metres up.
  const mid = [8 + (perRow * spacing) / 2, 8 + (perRow * spacing) / 2, 12];
  app.viewer.controls.focus(mid, 90);

  const samples = [];
  const start = performance.now();
  return new Promise((resolve) => {
    const tick = () => {
      samples.push(app.viewer.stats.fps);
      if (performance.now() - start < seconds * 1000) {
        setTimeout(tick, 250);
        return;
      }
      const usable = samples.filter((f) => f > 0);
      const avg = usable.length ? usable.reduce((a, b) => a + b, 0) / usable.length : 0;
      const s = app.viewer.stats;
      resolve({
        prims: world.objects.size,
        visible: world.visibleObjects,
        buildMs: Math.round(buildMs),
        buildPerPrimMs: +(buildMs / count).toFixed(2),
        fpsAvg: +avg.toFixed(1),
        fpsMin: usable.length ? +Math.min(...usable).toFixed(1) : 0,
        fpsMax: usable.length ? +Math.max(...usable).toFixed(1) : 0,
        drawCalls: s.drawCalls,
        triangles: s.tris,
        geometries: s.geometries,
        textures: s.textures,
        programs: s.programs,
        renderScale: app.viewer.renderScale,
        activeMeshes: countMeshes(world),
        materials: world._matCache.size,
        geoCache: world._geoCache.size,
        geoCacheShared: sharedGeo(world),
        batches: world.batcher.stats.batches,
        batchMs: +world.batcher.stats.lastMs.toFixed(2),
        batchRebuilds: world.batcher.stats.rebuilds,
        textureMB: +(world.texlib.bytes / 1048576).toFixed(1),
        evictions: world.texlib.evictions,
      });
    };
    setTimeout(tick, 250);
  });
}

function countMeshes(world) {
  let n = 0;
  for (const rec of world.objects.values()) if (rec.group) n += rec.group.children.length;
  return n;
}

function sharedGeo(world) {
  let n = 0;
  for (const rec of world.objects.values()) {
    if (!rec.group) continue;
    for (const m of rec.group.children) if (m.userData.sharedGeo) n++;
  }
  return n;
}
