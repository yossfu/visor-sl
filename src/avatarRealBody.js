// avatarRealBody.js -- el cuerpo del avatar del mundo, pero el de VERDAD.
//
// `avatar.js` construye la malla con `avatarBody.js` (geometria parametrica: un
// muñeco inventado, valido para moverse por el mundo pero que no es un avatar de
// Second Life). Este modulo ofrece la MISMA interfaz que `createAvatarBody`
// (`group`, `animate`, `setAppearance`, `dispose`) pero por dentro monta el
// cuerpo de sistema ORIGINAL de SL sobre el esqueleto de 133 huesos, con sus
// texturas reales, y lo anima con las animaciones de `avatarPose.js`.
//
// La carga es asincrona (8 mallas `.llm` + 16 texturas TGA del repositorio
// publico del visor), asi que no se puede bloquear el arranque del mundo: hasta
// que llega, se dibuja el cuerpo procedural de siempre y cuando esta listo se
// cambia por el real, sin que el mundo ni la fisica se enteren (el grupo
// contenedor es el mismo y la fisica solo toca ESE grupo, nunca los huesos).

import * as THREE from "./three.js";
import { createAvatarBody } from "./avatarBody.js";
import { normalizeAppearance, normalizeShape, shapeOf, shapeSummary } from "./avatarParams.js";
import { AvatarMesh } from "./sl/avatarMesh.js";
import { SLAppearance } from "./sl/slAppearance.js";
import { loadAvatarLad, randomShapeValues } from "./sl/avatarLad.js";
import { fetchSystemBodyFiles, fetchCharacterTextures, SYSTEM_TEXTURE_FILES } from "./sl/characterAssets.js";
import { buildAvatarMaterials } from "./sl/skinTexture.js";
import { buildIdleAnim, buildWalkAnim, buildRunAnim, buildSitAnim } from "./sl/avatarPose.js";
import { diag as visorDiag } from "./diag.js";

// Los bytes de las mallas y las imagenes de las texturas se piden UNA vez para
// todos los avatares (los residentes comparten cuerpo): sin esto, cada avatar
// remoto volveria a pedir y a componer 16 TGA.
let bodyBytesPromise = null;
let textureImagesPromise = null;
// La tabla de parametros visuales (`avatar_lad.xml`) tambien es comun a todos
// los avatares: se pide una sola vez y se comparte. Sin esto, cada residente
// remoto volveria a bajar y a analizar el XML.
let ladTablePromise = null;

function loadBodyBytes() {
  if (!bodyBytesPromise) bodyBytesPromise = fetchSystemBodyFiles({});
  return bodyBytesPromise;
}

function loadTextureImages() {
  if (!textureImagesPromise) {
    textureImagesPromise = fetchCharacterTextures(SYSTEM_TEXTURE_FILES, {}).catch((e) => {
      textureImagesPromise = null;
      throw e;
    });
  }
  return textureImagesPromise;
}

function loadLadTable() {
  if (!ladTablePromise) {
    ladTablePromise = loadAvatarLad().catch((e) => { ladTablePromise = null; throw e; });
  }
  return ladTablePromise;
}

// Interfaz equivalente a la de `createAvatarBody(appearance)`.
export function createRealAvatarBody(appearance, opts = {}) {
  const fallback = createAvatarBody(appearance);
  const group = new THREE.Group();
  group.name = opts.name || "avatar";
  group.add(fallback.group);
  group.userData.avatarBody = "real";

  const mesh = new AvatarMesh(THREE, { name: opts.name || "avatar" });
  const anims = {};
  let real = false;
  let disposed = false;
  let clip = null;
  let app = normalizeAppearance(appearance);
  const last = { moving: false, speed: 0, flying: false, grounded: true };
  // La forma REAL de SL (los parametros de avatar_lad aplicados sobre el cuerpo
  // de sistema). Se crea al vuelo la primera vez que hace falta.
  let sl = null;
  let shapeReady = false;
  // Semilla de forma automatica: si el aspecto no trae forma real, se deriva una
  // de aqui (estable). Es lo que hace que cada residente sin datos de forma
  // salga con un cuerpo de SL propio en vez de todos con el de fabrica.
  const autoShapeSeed = opts.autoShape || opts.shapeSeed || null;
  const resolveTexture = typeof opts.resolveTexture === "function" ? opts.resolveTexture : null;
  const label = opts.name || "avatar";

  function buildAnims() {
    anims.idle = buildIdleAnim(mesh.binding);
    anims.walk = buildWalkAnim(mesh.binding);
    anims.run = buildRunAnim(mesh.binding);
    anims.sit = buildSitAnim(mesh.binding);
  }

  function playClip(name) {
    if (clip === name || !anims[name]) return;
    mesh.stopAll();
    mesh.play(anims[name], { gain: 1 });
    clip = name;
  }

  function animate(st) {
    if (disposed) return;
    Object.assign(last, st);
    if (!real) { fallback.animate(st); return; }
    const name = st.flying ? "idle"
      : (st.speed > 4.2 ? "run" : (st.moving ? "walk" : "idle"));
    playClip(name);
    mesh.update(st.dt || 0);
    // Como el cuerpo procedural, el avatar mira a -Z; no hay que girar nada.
  }

  // Cambia el aspecto. El cuerpo de sistema no usa los parametros procedurales,
  // pero si la FORMA real (`appearance.shape`: parametros de avatar_lad + sexo +
  // bakes) y el tono de piel/pelo/ojos: se guarda para la proxima recomposicion.
  function setAppearance(next) {
    app = normalizeAppearance(next);
    if (!real) { fallback.setAppearance(app); return; }
    // El cuerpo real ya esta montado: la forma y los bakes se vuelven a aplicar
    // en el sitio, sin rehacer el cuerpo (es como lo hace el visor de SL cuando
    // llega una actualizacion de apariencia).
    applyShape();
  }

  // --- forma real de Second Life ---------------------------------------------
  // Resuelve los parametros visuales (avatar_lad) a morphs + deltas de hueso y
  // los aplica al cuerpo de sistema; despues pone los bakes (BoM) que vengan.
  // Esto es lo que hace que un avatar se DEFORME como en Second Life: mismas
  // mallas, mismos numeros, mismo resultado.
  async function applyShape() {
    if (!real || disposed) return false;
    let shape = shapeOf(app);
    const hasParamsOf = (s) => !!(s && s.visualParams && s.visualParams.length);
    const bakeKeysOf = (s) => (s && s.bakes ? Object.keys(s.bakes) : []);
    const needAuto = !shape && !!autoShapeSeed;
    if (!shape && !needAuto) return false;
    if (shape && !hasParamsOf(shape) && !bakeKeysOf(shape).length && !needAuto) return false;
    try {
      const table = await loadLadTable();
      if (disposed || !real) return false;
      if (!shape) {
        // Forma derivada de la semilla (aleatoria pero estable): misma semilla,
        // mismo cuerpo en todos los clientes.
        const values = randomShapeValues(table, autoShapeSeed, { amount: 0.5 });
        shape = normalizeShape({ sex: "auto", visualParams: values });
        if (!shape) return false;
        app.shape = shape;
      }
      const hasParams = hasParamsOf(shape);
      const bakeSlots = bakeKeysOf(shape);
      if (!sl) sl = new SLAppearance(mesh, { table });
      // `loadSnapshot` deriva el sexo del mando de género (igual que el visor),
      // así que mover ese mando en el editor cambia el cuerpo de verdad.
      sl.loadSnapshot(shape);
      if (hasParams) sl.applyShape();
      let withTexture = 0;
      for (const slot of bakeSlots) {
        const b = shape.bakes[slot];
        const tex = b && b.uuid && resolveTexture ? resolveTexture(b.uuid) : null;
        if (tex) withTexture++;
        sl.setBake(slot, { uuid: b && b.uuid, texture: tex, visible: true });
      }
      shapeReady = true;
      if (opts.onProgress) opts.onProgress("forma");
      visorDiag.info("forma", "forma real aplicada a «" + label + "»: " + shapeSummary(shape)
        + (hasParams ? " · " + sl.resolved.counts.morphs + " morphs, " + sl.resolved.counts.bones + " huesos" : "")
        + (bakeSlots.length ? " · bakes con textura " + withTexture + "/" + bakeSlots.length : ""));
      return true;
    } catch (e) {
      visorDiag.aviso("forma", "no se pudo aplicar la forma real a «" + label + "»: " + (e && e.message ? e.message : e));
      return false;
    }
  }

  async function load() {
    try {
      const bytes = await loadBodyBytes();
      if (disposed) return false;
      mesh.loadSystemBody(bytes);
      if (opts.onProgress) opts.onProgress("cuerpo");
      try {
        const images = await loadTextureImages();
        if (disposed) return false;
        const built = buildAvatarMaterials(THREE, images, {
          eye: { mesh: mesh.systemParts.get("eyeLeft").mesh },
        });
        for (const name in built.materials) mesh.setPartMaterial(name, built.materials[name]);
        if (opts.onProgress) opts.onProgress("piel");
      } catch (e) {
        // Sin piel se sigue: el avatar sale con su color plano, que es mejor que
        // no tener avatar.
        if (opts.onProgress) opts.onProgress("piel-fallo");
      }
      // La falda del cuerpo de sistema es un cono que solo tiene sentido con su
      // textura (sin bakes que digan lo contrario, taparia las piernas).
      mesh.setPartVisible("skirt", false);
      mesh.setPartVisible("eyelashes", false);
      mesh.group.traverse((o) => { if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; } });
      buildAnims();
      group.remove(fallback.group);
      try { fallback.dispose(); } catch (e) { /* noop */ }
      group.add(mesh.group);
      real = true;
      clip = null;
      // El aspecto cambia de tamaño (el cuerpo de sistema mide ~1.8 m): la
      // fisica no depende de esto, pero el HUD si quiere saberlo.
      group.userData.real = true;
      // Ahora que hay cuerpo de sistema, se le aplica la forma real de SL (los
      // parametros visuales del aspecto) y los bakes, si venian.
      await applyShape();
      if (opts.onProgress) opts.onProgress("listo");
      return true;
    } catch (e) {
      if (opts.onProgress) opts.onProgress("fallo");
      return false;
    }
  }

  return {
    group,
    get joints() { return fallback.joints; },
    get materials() { return fallback.materials; },
    get appearance() { return app; },
    get isReal() { return real; },
    get avatarMesh() { return mesh; },
    get slAppearance() { return sl; },
    get shapeReady() { return shapeReady; },
    setAppearance,
    applyShape,
    animate,
    load,
    ready: null,   // lo rellena quien llama si quiere esperar
    dispose() {
      disposed = true;
      try { fallback.dispose(); } catch (e) { /* noop */ }
      try { mesh.dispose(); } catch (e) { /* noop */ }
    },
  };
}
