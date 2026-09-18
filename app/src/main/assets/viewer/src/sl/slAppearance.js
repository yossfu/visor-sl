// slAppearance.js -- la apariencia REAL de un avatar de Second Life.
//
// `avatarLad.js` sabe leer los parametros visuales; este modulo los ata a un
// `AvatarMesh` concreto y anade lo que en SL se llama "bakes":
//
//   - FORMA: los pesos de morph (mallas de sistema) y los deltas de hueso
//     (esqueleto) que salen de resolver los parametros. Es lo que hace que el
//     avatar tenga LA MISMA forma que en Second Life: misma altura, misma
//     corpulencia, misma cara. No es una imitacion: es el mismo modelo
//     (`avatar_head.llm`...) deformado con los mismos numeros de
//     `avatar_lad.xml`.
//
//   - BAKES / BAKES ON MESH: en SL el visor compone las capas de ropa sobre la
//     piel y "cuece" tres texturas (cabeza, torso, piernas) mas los ojos. Un
//     avatar BoM lleva esas texturas cocidas dibujadas encima del propio cuerpo
//     mesh, asi que solo hay que ponerlas como material de la pieza. Aqui se
//     hace exactamente eso: `setBake("head", textura)` sustituye el material de
//     la cabeza. Cuando el retransmisor traiga las texturas cocidas (o la
//     composicion de `skinTexture.js` cuando no haya ropa), se aplican igual.
//
// Compatibilidad de mallas: las piezas de sistema cubren el avatar "legacy"
// (clasico) y tambien sirven de cuerpo base bajo un avatar mesh/Bento: un
// cuerpo mesh (activo LLMESH atado al esqueleto de Bento) se dibuja encima del
// cuerpo de sistema, y como comparten el mismo esqueleto de 133 huesos y los
// mismos morphs, la forma se aplica a los dos a la vez.

import { loadAvatarLad, resolveAppearance, defaultShapeValues, genderedShapeValues, shapeSliders, sexFromValues, sexLabel, genderParamId, SEX } from "./avatarLad.js";

// --- indices de textura del visor (llavatarappearancedefines.h) --------------
// Los primeros son las capas clasicas; a partir del 9 estan los "baked" (BoM).
export const TEX = {
  HEAD_BODYPAINT: 0, UPPER_SHIRT: 1, LOWER_PANTS: 2, EYES_IRIS: 3, HAIR: 4,
  UPPER_BODYPAINT: 5, LOWER_BODYPAINT: 6, LOWER_SHOES: 7, LOWER_SOCKS: 8,
  HEAD_BAKED: 9, UPPER_BAKED: 10, LOWER_BAKED: 11, EYES_BAKED: 12,
  LOWER_JACKET: 13, UPPER_JACKET: 14, SKIRT: 15,
};

// Nombre de slot de bake -> pieza(s) del cuerpo de sistema que lo reciben.
// Es la asociacion que el visor guarda en `mBakedID`/`mBakedTextureDatas`.
export const BAKE_PART = {
  head: ["head"],
  upper: ["upperBody"],
  lower: ["lowerBody"],
  eyes: ["eyeLeft", "eyeRight"],
  hair: ["hair"],
  skirt: ["skirt"],
  eyelashes: ["eyelashes"],
};

// Nombre de slot -> indice de textura. `head`/`upper`/`lower`/`eyes` son los
// cuatro "baked" del BoM; el pelo y la falda van aparte (no se cuecen).
export const BAKE_TEX = {
  head: TEX.HEAD_BAKED, upper: TEX.UPPER_BAKED, lower: TEX.LOWER_BAKED,
  eyes: TEX.EYES_BAKED, hair: TEX.HAIR, skirt: TEX.SKIRT,
  eyelashes: null,
};

export const BAKE_SLOTS = Object.keys(BAKE_PART);

export function sexName(sex) {
  if (sex === "auto" || sex === undefined || sex === null) return "auto";
  const s = typeof sex === "number" ? sex : 0;
  if (s === SEX.MALE) return "male";
  if (s === SEX.FEMALE) return "female";
  return "both";
}

// --- el objeto de apariencia -------------------------------------------------

// Cuelga de un `AvatarMesh`. Guarda los parametros visuales, la forma resuelta
// y los bakes, y los aplica cuando se lo piden.
export class SLAppearance {
  constructor(avatar, opts = {}) {
    this.avatar = avatar;
    this.THREE = opts.THREE || avatar.THREE;
    this.table = opts.table || null;
    // "auto" = el sexo que diga el mando «male» de la forma (lo que hace el
    // visor). Un numero (SEX.MALE/FEMALE/BOTH) lo fuerza.
    this.sex = opts.sex === undefined ? "auto" : opts.sex;
    this.valuesById = {};      // id de parametro -> peso
    this.resolved = null;      // ultima resolucion
    this.bakes = new Map();    // slot -> { material, source }
    this._resolveTexture = opts.resolveTexture || null;
    this._onApply = opts.onApply || null;
    this._notes = [];
  }

  get loaded() { return !!this.table; }

  // Carga la tabla de parametros si no venia ya.
  async loadTable(opts = {}) {
    if (!this.table) this.table = await loadAvatarLad(opts);
    return this.table;
  }

  // Sustituye todos los valores (objeto `{id: peso}` o lista `[[id, peso], ...]`).
  setValues(values) {
    if (Array.isArray(values)) {
      const o = {};
      for (const pair of values) if (pair && pair.length >= 2) o[pair[0]] = pair[1];
      this.valuesById = o;
    } else if (values && typeof values === "object") {
      this.valuesById = { ...values };
    } else {
      this.valuesById = {};
    }
    return this;
  }

  setValue(id, weight) { this.valuesById[id] = weight; return this; }
  getValue(id, fallback) { const v = this.valuesById[id]; return v === undefined ? fallback : v; }

  // La forma por defecto (todos los mandos en su valor de serie).
  setDefaultShape() {
    if (!this.table) throw new Error("slAppearance: falta la tabla");
    this.valuesById = defaultShapeValues(this.table);
    return this;
  }

  // Fuerza el sexo, o vuelve a "auto" (el que dicte la forma) con `"auto"`.
  setSex(sex) {
    if (sex === "auto" || sex === undefined || sex === null) this.sex = "auto";
    else this.sex = typeof sex === "number" ? sex : (sex === "male" ? SEX.MALE : sex === "female" ? SEX.FEMALE : SEX.BOTH);
    return this;
  }

  // El sexo con el que se resolvio la ultima forma (numero), o el que toque
  // ahora mismo si aun no se ha resuelto.
  get currentSex() {
    if (this.sex !== "auto") return this.sex;
    if (this.resolved) return this.resolved.sex;
    return this.table ? sexFromValues(this.table, this.valuesById) : SEX.BOTH;
  }

  // El sexo actual en palabras ("femenino"/"masculino"/"los dos"), para la
  // interfaz y los informes.
  describeSex() { return sexLabel(this.currentSex); }

  // --- forma ---

  // Resuelve los parametros a morphs + deltas de hueso (sin tocar el avatar).
  resolve() {
    if (!this.table) throw new Error("slAppearance: falta la tabla de avatar_lad");
    this.resolved = resolveAppearance(this.table, this.valuesById, { sex: this.sex });
    return this.resolved;
  }

  // Aplica la forma al avatar: morphs, huesos y recolocacion de los pies.
  applyShape() {
    const r = this.resolve();
    this.avatar.setMorphs(r.morphs);
    this.avatar.applyBoneDeltas(r.bones);
    this.avatar.groundSkeleton();
    if (this._onApply) this._onApply(this);
    return r;
  }

  // --- bakes ---

  // Pone (o quita, con `null`) la textura de un slot de bake. `source` puede ser
  // un material de three.js, una textura, o `{texture|uuid, color, roughness,
  // metalness, alphaTest, side, visible}`.
  setBake(slot, source) {
    if (!BAKE_PART[slot]) throw new Error("slAppearance: slot de bake desconocido «" + slot + "»");
    if (!source) { this.bakes.delete(slot); this.applyBakes(); return this; }
    this.bakes.set(slot, { source, material: this._makeMaterial(slot, source) });
    this.applyBakes();
    return this;
  }

  _makeMaterial(slot, src) {
    const THREE = this.THREE;
    if (src && (src.isMaterial === true || (src.type && /Material/.test(src.type)))) return src;
    if (src && src.isTexture === true) return this._skinMaterial(THREE, { map: src });
    let texture = src && src.texture ? src.texture : null;
    if (!texture && src && src.uuid && this._resolveTexture) texture = this._resolveTexture(src.uuid) || null;
    if (!texture && src && src.isTexture) texture = src;
    return this._skinMaterial(THREE, {
      map: texture,
      color: src && src.color !== undefined ? src.color : 0xffffff,
      roughness: src && src.roughness !== undefined ? src.roughness : 0.72,
      metalness: src && src.metalness !== undefined ? src.metalness : 0.0,
      alphaTest: src && src.alphaTest !== undefined ? src.alphaTest : 0,
      transparent: !!(src && src.transparent),
      side: src && src.side,
      emissive: src && src.emissive,
    });
  }

  _skinMaterial(THREE, o) {
    const m = new THREE.MeshStandardMaterial(o);
    m.name = "bake";
    return m;
  }

  // Vuelca los bakes al avatar (material por pieza) y ajusta la visibilidad.
  applyBakes() {
    for (const [slot, entry] of this.bakes) {
      const parts = BAKE_PART[slot];
      for (const part of parts) {
        if (this.avatar.setPartMaterial(part, entry.material)) {
          const src = entry.source;
          const visible = src && src.visible !== undefined ? src.visible : true;
          this.avatar.setPartVisible(part, visible);
        }
      }
    }
    return this;
  }

  clearBakes() {
    this.bakes.clear();
    for (const slot of BAKE_SLOTS) {
      // Se vuelve al material por defecto pidiendoselo a la pieza.
      for (const part of BAKE_PART[slot]) this.avatar.setPartMaterial(part, this.avatar.materialFor(part));
    }
    return this;
  }

  // --- todo junto ---

  apply() { this.applyShape(); this.applyBakes(); return this; }

  // Objeto serializable para mandarlo por la red o guardarlo (unos cientos de
  // bytes: solo los parametros que NO estan en su valor de serie, y los uuid de
  // los bakes). Este objeto es el bloque `shape` del aspecto (avatarParams.js).
  snapshot() {
    const visualParams = [];
    for (const key in this.valuesById) {
      const id = Number(key);
      if (!Number.isFinite(id)) continue;
      const v = this.valuesById[key];
      const p = this.table && this.table.params ? this.table.params.get(id) : null;
      // Los mandos que estan como vienen de fabrica no hacen falta: el otro
      // extremo los pondra igual. Con esto la forma cabe de sobra en un mensaje.
      if (p && Number.isFinite(p.defaultWeight) && Math.abs(p.defaultWeight - v) < 1e-6) continue;
      visualParams.push([id, Math.round(v * 10000) / 10000]);
    }
    const bakes = {};
    for (const [slot, entry] of this.bakes) {
      const src = entry.source || {};
      bakes[slot] = src.uuid ? { uuid: src.uuid } : { texture: true };
    }
    return { v: 1, sex: sexName(this.sex), visualParams, bakes };
  }

  // Reconstruye desde un snapshot (sin las texturas: eso lo pone quien tenga
  // acceso al retransmisor con `setBake`). Acepta el formato de `snapshot()` o
  // el bloque `shape` de `avatarParams.js` (que es el mismo, anidado).
  loadSnapshot(snap) {
    if (!snap || typeof snap !== "object") return this;
    const src = snap.shape && typeof snap.shape === "object" ? snap.shape : snap;
    const vp = src.visualParams;
    if (Array.isArray(vp)) this.setValues(vp);
    else if (vp && typeof vp === "object") this.setValues(vp);
    // El sexo es una propiedad DERIVADA del mando de género (el mismo criterio
    // que `llvoavatar.cpp`: male > 0.5 -> masculino). Si la forma trae ese
    // mando, mandan los valores y el sexo se vuelve a derivar; el campo `sex`
    // solo se respeta como respaldo cuando la forma no trae el mando (p. ej.
    // una forma parcial que solo trae bakes).
    const gid = this.table ? genderParamId(this.table) : null;
    const hasGender = gid !== null && this.valuesById[gid] !== undefined;
    if (hasGender) this.setSex("auto");
    else if (src.sex) this.setSex(src.sex);
    return this;
  }

  describe() {
    const r = this.resolved;
    const parts = [...this.bakes.keys()];
    return "forma " + sexLabel(this.currentSex) + ": " + Object.keys(this.valuesById).length + " parametros -> "
      + (r ? (r.counts.morphs + " morphs, " + r.counts.bones + " huesos") : "sin resolver")
      + (parts.length ? " · bakes: " + parts.join(", ") : " · sin bakes");
  }

  notes() { return this._notes; }
}

export function createSLAppearance(avatar, opts) { return new SLAppearance(avatar, opts); }

// Atajo sin estado: aplica una forma ya resuelta a un avatar.
export function applyResolvedAppearance(avatar, resolved) {
  if (!resolved) return null;
  avatar.setMorphs(resolved.morphs || {});
  avatar.applyBoneDeltas(resolved.bones || []);
  avatar.groundSkeleton();
  return resolved;
}

// --- autotest -----------------------------------------------------------------

export function runSlAppearanceSelfTest() {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });

  // Un avatar de mentira con la misma interfaz que AvatarMesh.
  const calls = { morphs: null, bones: null, grounded: 0, materials: [], visible: [] };
  function FakeMaterial(o) { this.opts = o || {}; this.name = "bake"; }
  const fakeAvatar = {
    THREE: { MeshStandardMaterial: FakeMaterial },
    setMorphs(m) { calls.morphs = m; return this; },
    applyBoneDeltas(b) { calls.bones = b; return b.length; },
    groundSkeleton() { calls.grounded++; return 0; },
    setPartMaterial(part, mat) { calls.materials.push([part, !!mat]); return true; },
    setPartVisible(part, v) { calls.visible.push([part, v]); return true; },
    materialFor(part) { return { part }; },
  };

  // El parseo real se prueba en `avatarLad.js`; aqui se usa una tabla montada a mano.
  const table = {
    params: new Map([
      [33, { id: 33, name: "Height", kind: "skeleton", sex: SEX.BOTH, min: -2.3, max: 2, defaultWeight: 0, bones: [{ name: "mPelvis", scale: [0, 0, 0.1], offset: null }] }],
      [32, { id: 32, name: "Male_Skeleton", kind: "skeleton", sex: SEX.BOTH, min: 0, max: 1, defaultWeight: 0, bones: [{ name: "mChest", scale: [0.05, 0.05, 0.05], offset: null }] }],
    ]),
    drivers: new Map(),
    drivenIds: new Set(),
    editable: [33],
    groups: [{ key: "shape_body", label: "Cuerpo", params: [33] }],
    names: new Map(),
  };

  const app = new SLAppearance(fakeAvatar, { table });
  ok("la tabla queda enganchada", app.loaded);
  ok("el genero por defecto es «auto» (lo dicta la forma)", sexName(app.sex) === "auto");

  app.setValues([[33, 2], [32, 0.5]]);
  ok("setValues acepta lista de pares", app.valuesById[33] === 2 && app.valuesById[32] === 0.5);

  const r = app.applyShape();
  ok("aplica morphs (vacio) y huesos", calls.morphs && Object.keys(calls.morphs).length === 0 && calls.bones.length === 2, JSON.stringify(r.bones));
  ok("altura: mPelvis escala 0.2", Math.abs(calls.bones.find((b) => b.name === "mPelvis").scale[2] - 0.2) < 1e-9);
  ok("recoloca los pies", calls.grounded === 1);
  ok("snapshot: 2 parametros y genero", app.snapshot().visualParams.length === 2 && app.snapshot().sex === "auto");

  app.setSex("male");
  app.applyShape();
  ok("el genero se resuelve a numero", sexName(app.sex) === "male");

  // Regla del visor (`llvoavatar.cpp`): el sexo del avatar sale del mando
  // «male» de la forma (>0.5 = masculino) y decide si los parametros del otro
  // sexo usan su valor de serie. Se prueba con una tabla montada a mano.
  const gtable = {
    params: new Map([
      [80, { id: 80, name: "male", kind: "driver", sex: SEX.BOTH, min: 0, max: 1, defaultWeight: 0, bones: [], volumes: [], driven: [{ id: 32, min1: 0, max1: 1, max2: 1, min2: 1 }, { id: 153, min1: 0, max1: 1, max2: 1, min2: 1 }] }],
      [32, { id: 32, name: "Breast_Female_Cleavage", kind: "morph", sex: SEX.FEMALE, min: 0, max: 1, defaultWeight: 0, bones: [], volumes: [], driven: [] }],
      [153, { id: 153, name: "Male_Package", kind: "morph", sex: SEX.MALE, min: 0, max: 1, defaultWeight: 0, bones: [], volumes: [], driven: [] }],
    ]),
    drivers: new Map([[80, [{ id: 32, min1: 0, max1: 1, max2: 1, min2: 1 }, { id: 153, min1: 0, max1: 1, max2: 1, min2: 1 }]]]),
    drivenIds: new Set([32, 153]),
    editable: [80, 32, 153],
    shapeParams: [80, 32, 153],
    groups: [{ key: "shape_body", label: "Cuerpo", params: [] }],
    names: new Map([["male", [80]]]),
  };
  const masc = new SLAppearance(fakeAvatar, { table: gtable });
  masc.setValues(genderedShapeValues(gtable, "male"));
  const rm = masc.resolve();
  ok("una forma masculina resuelve a sexo masculino", rm.sex === SEX.MALE, sexName(rm.sex));
  ok("el mando de genero viaja con la forma (male=1)", masc.valuesById[80] === 1);
  ok("el pecho femenino se ignora en una forma masculina", !("Breast_Female_Cleavage" in rm.morphs), JSON.stringify(rm.morphs));
  const fem = new SLAppearance(fakeAvatar, { table: gtable });
  fem.setValues(genderedShapeValues(gtable, "female"));
  const rf = fem.resolve();
  ok("una forma femenina resuelve a sexo femenino", rf.sex === SEX.FEMALE, sexName(rf.sex));
  ok("el paquete masculino se ignora en una forma femenina", !("Male_Package" in rf.morphs), JSON.stringify(rf.morphs));
  ok("el primer grupo lleva la barra de genero", shapeSliders(gtable)[0].sliders[0].gender === true);

  // El sexo se DERIVA del mando de genero (como el visor): una forma guardada
  // con `sex` forzado pero con el mando de genero presente vuelve a «auto», de
  // modo que mover ese mando en el editor cambia el cuerpo de verdad.
  const rt = new SLAppearance(fakeAvatar, { table: gtable });
  rt.loadSnapshot({ v: 1, sex: "female", visualParams: [[80, 1]], bakes: {} });
  ok("loadSnapshot con mando de genero vuelve a «auto»", sexName(rt.sex) === "auto", sexName(rt.sex));
  ok("y resuelve al sexo que dice el mando (masculino)", rt.resolve().sex === SEX.MALE, sexName(rt.resolve().sex));
  const rt2 = new SLAppearance(fakeAvatar, { table: gtable });
  rt2.loadSnapshot({ v: 1, sex: "male", visualParams: [], bakes: { head: { uuid: "x" } } });
  ok("sin mando de genero se respeta el `sex` guardado", sexName(rt2.sex) === "male", sexName(rt2.sex));

  // Bakes: un material directo.
  const mat = { isMaterial: true, name: "mi-bake" };
  app.setBake("head", mat);
  ok("el bake de cabeza va a la cabeza", calls.materials.some(([p, m]) => p === "head" && m));
  app.setBake("eyes", { texture: null, color: 0x223344 });
  ok("el bake de ojos va a los dos ojos", calls.materials.filter(([p]) => p === "eyeLeft" || p === "eyeRight").length === 2);
  ok("describe cuenta lo aplicado", /bakes/.test(app.describe()) && /head/.test(app.describe()));
  app.setBake("hair", { texture: null, color: 0x111111, visible: false });
  ok("un bake puede ocultar la pieza (calvo)", calls.visible.some(([p, v]) => p === "hair" && v === false));
  app.clearBakes();
  ok("clearBakes olvida los slots", app.bakes.size === 0);
  ok("setBake rechaza un slot desconocido", (() => { try { app.setBake("ombligo", {}); return false; } catch (e) { return true; } })());

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "slAppearance selftest: all " + checks.length + " checks passed"
      : "slAppearance selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
