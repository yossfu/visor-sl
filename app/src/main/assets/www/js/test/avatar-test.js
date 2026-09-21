// Visual harness for the avatar pipeline: builds bodies from the shipped meshes
// with a few shape presets, without touching the grid.
//
//   index.html?test=avatar            three residents (neutral / feminine / muscular)
//   index.html?test=avatar&count=1    just one
//   index.html?test=avatar&plain=1    no synthetic textures at all
//
// It also paints synthetic "baked" textures (skin + face + eyes) so the
// texture-arrives-later path (GetTexture → applyTexture → body part) is
// exercised without a connection. The face features are placed by looking up the
// texture coordinates of the mesh vertices closest to the eye/nose/mouth joints,
// so they land on the real face instead of being guessed.
import * as THREE from "../../vendor/three.module.min.js";
import { createAvatar, applyShape, applyBakedTextures, AVATAR_PARTS, BAKED_EYES } from "../avatar/builder.js";
import { loadSkeleton } from "../avatar/skeleton.js";

// The shape editor's sliders, by their real names — including the ones that are
// not morphs at all: Height/Shoulders/Hip Width move *bones*, which is the only
// way an avatar is actually a different size.
const PRESETS = {
  neutral: {},
  femenina: {
    "Breast Size": 0.95, "Butt Size": 0.95, "Body Fat": 0.4, "Torso Muscles": 0.05,
    "Hip Width": 1.8, "Height": -0.8, "Shoulders": -0.9, "Belly Size": 0.15,
    "Eyelashes Long": 0.9,
  },
  musculoso: {
    "Torso Muscles": 0.95, "Leg Muscles": 0.9, "Body Definition": 0.7, "Body Fat": 0.2,
    "Height": 1.9, "Shoulders": 1.2, "Hip Width": -1.4, "Breast Size": 0.2,
  },
};

/** UV of the mesh vertex closest to a point in avatar space. */
function uvNear(mesh, target) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < mesh.numVertices; i++) {
    const dx = mesh.coords[i * 3] - target[0];
    const dy = mesh.coords[i * 3 + 1] - target[1];
    const dz = mesh.coords[i * 3 + 2] - target[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return null;
  return [mesh.texCoords[best * 2], mesh.texCoords[best * 2 + 1]];
}

function makeCanvas(size) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  return c;
}

/** A skin map with a painted face, laid out on the head bake's real UVs. */
async function faceTexture(headMesh, seed = 0) {
  const sk = await loadSkeleton();
  const eyeL = sk.byName.get("mEyeLeft").rest;
  const eyeR = sk.byName.get("mEyeRight").rest;
  const size = 512;
  const c = makeCanvas(size);
  const ctx = c.getContext("2d");
  const skin = ["#e8bb96", "#b07b52", "#f0d0b0"][seed % 3];
  ctx.fillStyle = skin;
  ctx.fillRect(0, 0, size, size);
  // subtle speckle so the surface is not perfectly flat
  ctx.fillStyle = "rgba(0,0,0,0.05)";
  for (let i = 0; i < 700; i++) ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);

  const uvL = uvNear(headMesh, eyeL);
  const uvR = uvNear(headMesh, eyeR);
  const browL = uvNear(headMesh, [eyeL[0] - 0.03, eyeL[1], eyeL[2] + 0.021]);
  const browR = uvNear(headMesh, [eyeR[0] - 0.03, eyeR[1], eyeR[2] + 0.021]);
  const nose = uvNear(headMesh, [0.126, 0, 1.7347]);
  const mouth = uvNear(headMesh, [0.105, 0, 1.70]);
  if (!uvL || !uvR) return new THREE.CanvasTexture(c);
  // The texture is flipped vertically in three.js (v=0 at the bottom).
  const px = (uv) => [uv[0] * size, (1 - uv[1]) * size];
  const [lx, ly] = px(uvL);
  const [rx, ry] = px(uvR);
  const eyeR_px = Math.abs(rx - lx) * 0.5 || 16;
  for (const [x, y] of [[lx, ly], [rx, ry]]) {
    // sclera + iris so an untextured eyeball has something to sit in
    ctx.fillStyle = "#efe9e0";
    ctx.beginPath();
    ctx.ellipse(x, y, eyeR_px * 0.62, eyeR_px * 0.34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3f5c46";
    ctx.beginPath(); ctx.arc(x, y, eyeR_px * 0.26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath(); ctx.arc(x, y, eyeR_px * 0.11, 0, Math.PI * 2); ctx.fill();
  }
  for (const uv of [browL, browR]) {
    if (!uv) continue;
    const [bx, by] = px(uv);
    ctx.strokeStyle = "#4a352a";
    ctx.lineWidth = Math.max(4, eyeR_px * 0.42);
    ctx.beginPath();
    ctx.moveTo(bx - eyeR_px * 0.75, by + eyeR_px * 0.25);
    ctx.quadraticCurveTo(bx, by - eyeR_px * 0.28, bx + eyeR_px * 0.75, by + eyeR_px * 0.2);
    ctx.stroke();
  }
  if (nose) {
    const [nx, ny] = px(nose);
    ctx.fillStyle = "rgba(150,100,80,0.28)";
    ctx.beginPath();
    ctx.ellipse(nx, ny, eyeR_px * 0.55, eyeR_px * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (mouth) {
    const [mx, my] = px(mouth);
    ctx.fillStyle = "#a8565a";
    ctx.beginPath();
    ctx.ellipse(mx, my, eyeR_px * 0.85, eyeR_px * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The eye bake: sclera + iris + pupil, on a small square texture. */
function eyeTexture() {
  const size = 128;
  const c = makeCanvas(size);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#f2efe9";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#4a6b52";
  ctx.beginPath(); ctx.arc(size * 0.5, size * 0.5, size * 0.26, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#141414";
  ctx.beginPath(); ctx.arc(size * 0.5, size * 0.5, size * 0.12, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function bodyTexture(seed) {
  const size = 256;
  const c = makeCanvas(size);
  const ctx = c.getContext("2d");
  const skin = ["#e8bb96", "#b07b52", "#f0d0b0"][seed % 3];
  ctx.fillStyle = skin;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "rgba(0,0,0,0.06)";
  for (let i = 0; i < 900; i++) ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function runAvatarTest(app) {
  const qs = new URLSearchParams(location.search);
  const count = Math.min(4, Math.max(1, parseInt(qs.get("count") || "3", 10)));
  const plain = qs.get("plain") === "1";
  app.ui.hideModal();
  app.mode = "test";
  app.world.reset();
  app.ui.regionEl.textContent = "Prueba de avatares (sin conexión)";
  app.world.setDrawDistance(80);

  const { loadAvatarParams, weightsFromOverrides } = await import("../avatar/params.js");
  const table = await loadAvatarParams();
  const names = Object.keys(PRESETS).slice(0, count);
  const avatars = [];
  let textures = null;
  for (let i = 0; i < names.length; i++) {
    // The presets name real sliders, so they go through the same default →
    // override → driver-resolution path the shape editor will use.
    const weights = weightsFromOverrides(PRESETS[names[i]], table);
    const av = app.world.addAvatar(`test-${i}`, `prueba ${names[i]}`);
    // Residents stand in a row across the camera's view (the camera is on the
    // +X side, so they are spread along Y).
    av.group.position.set(128, 128.8 - i * 1.3, 0);
    av.group.quaternion.set(0, 0, 0, 1);
    const group = await app.world.provideAvatarBody(av);
    if (!group) continue;
    applyShape(group, weights);

    const baked = [];
    if (!plain) {
      if (!textures) {
        const headPart = group.userData.parts.find((p) => p.key === "head");
        textures = {
          head: "test-head-baked",
          body: "test-body-baked",
          eyes: "test-eyes-baked",
        };
        app.world.texlib.install(textures.head, await faceTexture(headPart.source.mesh, i % 3));
        app.world.texlib.install(textures.body, bodyTexture(i % 3));
        app.world.texlib.install(textures.eyes, eyeTexture());
      }
      baked[8] = textures.head;    // TEX_HEAD_BAKED
      baked[9] = textures.body;    // TEX_UPPER_BAKED
      baked[10] = textures.body;   // TEX_LOWER_BAKED
      baked[BAKED_EYES] = textures.eyes;
    }
    const applied = applyBakedTextures(group, baked,
      (u) => (app.world.texlib.installed.has(u) ? app.world.texlib.get(u) : null));

    const box = new THREE.Box3().setFromObject(group);
    app.ui.log(`avatar ${names[i]}: ${group.userData.parts.length} piezas · ` +
      `${group.userData.parts.reduce((n, p) => n + p.source.mesh.numVertices, 0)} vértices · ` +
      `${group.userData.appliedMorphs || 0} morphs · ${applied} texturas · ` +
      `alto ${(box.max.z - box.min.z).toFixed(2)} m · ancho ${(box.max.y - box.min.y).toFixed(2)} m`);
    avatars.push(av);
  }

  const ctl = app.viewer.controls;
  ctl.focus([128, 128.8 - ((avatars.length - 1) * 1.3) / 2, 1.0], 3.6);
  ctl.yaw = Math.PI / 2;
  ctl.pitch = -0.02;
  ctl.applyOrbit();
  app.viewer.controls.groundHeight = () => 0;
  app.ui.log("Harness de avatares listo.");
  return avatars;
}
