// Animation harness: plays the shipped animations on the test avatars, without
// touching the grid.
//
//   index.html?test=anim&anim=walk      one avatar playing the walk cycle
//   index.html?test=anim&anim=stand     the stand cycle
//   index.html?test=anim&t=0.4          frozen at 0.4 s (no rAF stepping)
//
// It reports, per animation, which bones moved and how far the mesh actually
// travelled — the numbers that tell "the animation runs" apart from "a skeleton
// pose was applied to nothing".
import * as THREE from "../../vendor/three.module.min.js";
import { applyPose } from "../avatar/builder.js";
import { DEFAULT_ANIMS, listAnimations, shippedAnimationCount } from "../avatar/anim-data.js";

/** Every animation the app ships, as a table (used by the HUD and the test). */
export async function animationCatalogue() {
  return listAnimations();
}

export async function runAnimTest(app, opts = {}) {
  const qs = new URLSearchParams(location.search);
  const which = String(opts.anim || qs.get("anim") || "stand").toLowerCase();
  const fixed = opts.t !== undefined ? opts.t
    : (qs.get("t") !== null ? parseFloat(qs.get("t")) : null);
  const uuid = DEFAULT_ANIMS[which] || which;
  const now = performance.now();

  app.ui.hideModal();
  app.mode = "test";
  app.world.reset();
  app.ui.regionEl.textContent = "Prueba de animaciones (sin conexión)";
  app.world.setDrawDistance(60);

  const count = await shippedAnimationCount();
  const av = app.world.addAvatar("test-anim", "prueba " + which);
  av.group.position.set(128, 128, 0);
  const group = await app.world.provideAvatarBody(av);
  if (!group) return { error: "sin cuerpo" };

  const anim = av.anim;
  await anim.setList([{ animationID: uuid, sequenceID: 1 }], now);
  if (!anim.sequences.size) {
    app.ui.log(`La animación "${which}" (${uuid}) no está en el paquete de ${count} animaciones.`);
    return { error: "animación no encontrada", count, missing: [...anim.missing] };
  }
  const parsed = [...anim.sequences.values()][0].anim;
  app.ui.log(`Animación "${which}": ${uuid} · ${parsed.length.toFixed(2)} s · prioridad ${parsed.priority} · ` +
    `${parsed.joints.length} huesos · ${parsed.sets.length} conjuntos de prioridad · ` +
    `${parsed.loop ? "en bucle" : "una vez"}`);

  // Sample the animation across its length and record how the body moves.
  const samples = [];
  const times = fixed !== null ? [fixed] : [0, 0.25, 0.5, 0.75].map((f) => f * parsed.length);
  for (const t of times) {
    const at = now + t * 1000;
    anim.update(at);
    app.world.animateAvatars(at);
    const box = new THREE.Box3();
    for (const p of group.userData.parts) {
      p.mesh.updateMatrix();
      p.mesh.geometry.computeBoundingBox();
      box.union(p.mesh.geometry.boundingBox.clone().applyMatrix4(p.mesh.matrix));
    }
    samples.push({
      t: +t.toFixed(2),
      alto: +(box.max.z - box.min.z).toFixed(3),
      ancho: +(box.max.y - box.min.y).toFixed(3),
      z: [+box.min.z.toFixed(3), +box.max.z.toFixed(3)],
      huesos: anim.pose.count,
    });
  }
  app.ui.log("Animación: " + samples.map((s) => `t=${s.t}→alto ${s.alto} ancho ${s.ancho} (${s.huesos} huesos)`).join(" · "));
  const boneNames = [...anim.pose.rotations.keys()];
  app.ui.log("Huesos rotados: " + (boneNames.slice(0, 12).join(", ") || "ninguno"));

  if (fixed === null) {
    const step = () => {
      if (app.mode !== "test") return;
      app.world.animateAvatars(performance.now());
      app._animRaf = requestAnimationFrame(step);
    };
    app._animRaf = requestAnimationFrame(step);
  }

  const ctl = app.viewer.controls;
  ctl.focus([128, 128, 0.95], 3.4);
  ctl.yaw = Math.PI / 2;
  ctl.pitch = -0.02;
  ctl.applyOrbit();
  app.viewer.controls.groundHeight = () => 0;
  app.ui.log(`Paquete: ${count} animaciones.`);
  app.ui.log("Harness de animación listo.");
  return { count, uuid, length: parsed.length, samples, boneNames };
}
