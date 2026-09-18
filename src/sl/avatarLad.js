// avatarLad.js -- la tabla de PARAMETROS VISUALES del avatar de Second Life.
//
// `avatar_lad.xml` es el fichero con el que el visor oficial define TODO lo que
// puede cambiar de forma un avatar de sistema:
//
//   - `<skeleton><param><param_skeleton>` : parametros que deforman el
//     ESQUELETO (escalan y desplazan huesos). De aqui sale la altura, la
//     corpulencia, el tamano de cabeza, el largo de piernas... y tambien las
//     decenas de huesos de la cara con que se esculpe la nariz, la boca o los
//     parpados.
//   - `<mesh><param><param_morph>`        : parametros que son MORPH TARGETS de
//     una malla de sistema (el nombre del parametro coincide con el del morph
//     dentro del `.llm`: "Big_Belly_Torso", "Nose_Big_Out", "Blink_Left"...).
//   - `<driver_parameters><param><param_driver>` : parametros "maestros" que no
//     deforman nada por si mismos, pero que CONTROLAn a otros (los `<driven>`).
//     Es como el visor hace que un solo mando ("Nose Size") mueva a la vez el
//     morph de la cabeza y el hueso de la nariz.
//   - `<global_color>` / `<layer_set>`    : color y alfa de la piel, el pelo, el
//     maquillaje... (los "bakes" salen de combinar estas capas).
//
// Este modulo lo lee, construye la tabla y RESUELVE un conjunto de valores en
// tres cosas que el visor ya sabe aplicar: pesos de morph, deltas de hueso y
// colores. La formula del driver es un port literal de
// `LLDriverParam::getDrivenWeight` (lldriverparam.cpp) para que el resultado sea
// el mismo que en Second Life, no una aproximacion.
//
// Igual que el resto de activos de personaje (`characterAssets.js`), el XML NO
// se copia al repositorio: se pide a la fuente publica del visor en tiempo de
// ejecucion, o lo sirve el retransmisor cuando hay sesion abierta.

import { fetchCharacterFile } from "./characterAssets.js";

export const AVATAR_LAD_FILE = "avatar_lad.xml";

// --- sexo y grupos (llvisualparam.h) -----------------------------------------
// Los valores son un campo de bits: `(param.sex & avatarSex) !== 0`.
export const SEX = { FEMALE: 0x01, MALE: 0x02, BOTH: 0x03 };

// El sexo del avatar NO lo elige quien mira: lo dice el mando «male» de la
// forma que lleva puesta. Es literal del visor (`llvoavatar.cpp`):
//     ESex avatar_sex = (getVisualParamWeight("male") > 0.5f) ? SEX_MALE : SEX_FEMALE;
// Y no es un detalle: de él depende que los parametros exclusivos del otro
// sexo usen su valor de serie en vez del guardado, que es lo que hace que una
// forma masculina no se quede con pecho femenino.
export const GENDER_PARAM_NAME = "male";

export function genderParamId(table) {
  if (!table || !table.names) return null;
  const ids = table.names.get(GENDER_PARAM_NAME) || [];
  for (const id of ids) {
    const rec = table.params.get(id);
    if (rec && rec.wearable === "shape") return id;
  }
  return ids.length ? ids[0] : null;
}

// El sexo que implica una tabla de valores: `SEX.MALE` si el mando «male» pasa
// de 0.5, `SEX.FEMALE` en cualquier otro caso (igual que el visor, que también
// cae en femenino con el 0.5 exacto).
export function sexFromValues(table, valuesById, fallback) {
  const id = genderParamId(table);
  if (id === null) return fallback === undefined ? SEX.BOTH : fallback;
  const rec = table.params.get(id);
  const stored = valuesById ? valuesById[id] : undefined;
  const w = stored === undefined ? (rec ? rec.defaultWeight : 0) : stored;
  return w > 0.5 ? SEX.MALE : SEX.FEMALE;
}

export function sexLabel(sex) {
  return sex === SEX.MALE ? "masculino" : sex === SEX.FEMALE ? "femenino" : "los dos";
}

export const VISUAL_PARAM_GROUP = {
  TWEAKABLE: 0,
  ANIMATABLE: 1,
  TWEAKABLE_NO_TRANSMIT: 2,
  TRANSMIT_NOT_TWEAKABLE: 3,
};

// Etiquetas en castellano de los grupos del editor de forma. Las claves son las
// de `edit_group` en el XML (las que usa el visor en la pestana "Shape").
export const SHAPE_GROUP_LABELS = {
  shape_body: "Cuerpo",
  shape_head: "Cabeza",
  shape_torso: "Torso",
  shape_legs: "Piernas",
  shape_eyes: "Ojos",
  shape_ears: "Orejas",
  shape_nose: "Nariz",
  shape_mouth: "Boca",
  shape_chin: "Mentón",
  shape_cheeks: "Pómulos",
  shape_jaw: "Mandíbula",
  shape_neck: "Cuello",
  shape_feet: "Pies",
  shape_hover: "Altura de flotar",
};
// Grupos que no son mandos de usuario (parametros derivados).
export const NON_EDIT_GROUPS = new Set(["driven", "dummy"]);

// Orden en que se muestran los grupos del editor de forma (el resto, al final).
const GROUP_ORDER = [
  "shape_body", "shape_torso", "shape_legs", "shape_eyes", "shape_head",
  "shape_ears", "shape_nose", "shape_mouth", "shape_chin", "shape_cheeks",
  "shape_jaw", "shape_neck", "shape_feet", "shape_hover",
];

// --- utilidades de parseo ----------------------------------------------------

function attrNum(el, name) {
  const v = el.getAttribute(name);
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function attrBool(el, name) {
  const v = el.getAttribute(name);
  if (v === null) return false;
  return v === "true" || v === "1" || v === "yes";
}

function attrVector3(el, name) {
  const v = el.getAttribute(name);
  if (!v) return null;
  const parts = v.trim().split(/[\s,]+/).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

function parseSex(v) {
  if (v === "male") return SEX.MALE;
  if (v === "female") return SEX.FEMALE;
  return SEX.BOTH;
}

function parseColor(v) {
  if (!v) return null;
  const p = v.trim().split(/[\s,]+/).map(Number);
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 255];
}

function directChildren(el, tag) {
  const out = [];
  for (const c of el.children) if (!tag || c.tagName === tag) out.push(c);
  return out;
}

function child(el, tag) {
  for (const c of el.children) if (c.tagName === tag) return c;
  return null;
}

// --- parseo ------------------------------------------------------------------

// Convierte el texto XML de `avatar_lad.xml` en la tabla de parametros. Se puede
// llamar sin red (util para el autotest).
export function parseAvatarLad(xmlText) {
  if (typeof DOMParser === "undefined") throw new Error("avatarLad: hace falta DOMParser");
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("avatarLad: XML invalido (" + String(err.textContent || "").slice(0, 160) + ")");
  const root = doc.documentElement;
  if (!root || root.tagName !== "linden_avatar") throw new Error("avatarLad: la raiz no es <linden_avatar>");

  const params = new Map();      // id -> registro
  const order = [];              // ids en orden de aparicion
  const names = new Map();       // nombre en minusculas -> [ids]
  const morphMasks = [];         // del bloque <morph_masks>
  const notes = [];

  // Recorre el arbol llevando el contexto (seccion, malla, conjunto de color).
  function walk(el, ctx) {
    for (const c of el.children) {
      const tag = c.tagName;
      if (tag === "mesh") { walk(c, { ...ctx, meshType: c.getAttribute("type") || null }); continue; }
      if (tag === "global_color") { walk(c, { ...ctx, colorSet: c.getAttribute("name") || null, section: "global_color" }); continue; }
      if (tag === "layer_set") { walk(c, { ...ctx, layerSet: c.getAttribute("name") || null, section: "layer_set" }); continue; }
      if (tag === "skeleton") { walk(c, { ...ctx, section: "skeleton" }); continue; }
      if (tag === "driver_parameters") { walk(c, { ...ctx, section: "driver" }); continue; }
      if (tag === "morph_masks") {
        for (const m of directChildren(c, "mask")) {
          morphMasks.push({
            morphName: m.getAttribute("morph_name") || "",
            bodyRegion: m.getAttribute("body_region") || "",
            layer: m.getAttribute("layer") || "",
          });
        }
        continue;
      }
      if (tag === "param") { addParam(c, ctx); continue; }
      walk(c, ctx);
    }
  }

  function addParam(el, ctx) {
    const id = attrNum(el, "id");
    if (id === null || id < 0) return;
    const min = attrNum(el, "value_min");
    const max = attrNum(el, "value_max");
    const lo = min === null ? 0 : min;
    const hi = max === null ? 1 : max;
    const rawDefault = attrNum(el, "value_default");
    // LLVisualParamInfo::parseXml: el valor por defecto se recorta al rango
    // SOLO si el atributo existe; si no, queda 0 (y `setWeight` lo recortara).
    const defaultWeight = rawDefault === null ? 0 : Math.max(lo, Math.min(hi, rawDefault));

    const skelEl = child(el, "param_skeleton");
    const morphEl = child(el, "param_morph");
    const driverEl = child(el, "param_driver");
    const colorEl = child(el, "param_color");
    const alphaEl = child(el, "param_alpha");

    let kind = "plain";
    if (driverEl) kind = "driver";
    else if (morphEl) kind = "morph";
    else if (skelEl) kind = "skeleton";
    else if (colorEl) kind = "color";
    else if (alphaEl) kind = "alpha";

    const rec = {
      id,
      name: el.getAttribute("name") || "",
      label: el.getAttribute("label") || el.getAttribute("name") || "",
      group: attrNum(el, "group") === null ? VISUAL_PARAM_GROUP.TWEAKABLE : attrNum(el, "group"),
      sex: parseSex(el.getAttribute("sex")),
      wearable: el.getAttribute("wearable") || null,
      min: lo,
      max: hi,
      defaultWeight,
      editGroup: el.getAttribute("edit_group") || null,
      editGroupOrder: attrNum(el, "edit_group_order"),
      showSimple: attrBool(el, "show_simple"),
      labelMin: el.getAttribute("label_min") || "Menos",
      labelMax: el.getAttribute("label_max") || "Más",
      clothingMorph: attrBool(el, "clothing_morph"),
      section: ctx.section || null,
      meshType: ctx.meshType || null,
      colorSet: ctx.colorSet || null,
      layerSet: ctx.layerSet || null,
      kind,
      bones: [],
      morphName: null,
      meshTypes: [],
      volumes: [],
      driven: [],
      colorStops: [],
      colorOperation: colorEl ? (colorEl.getAttribute("operation") || "replace") : null,
      morphMask: null,
    };

    if (skelEl) {
      for (const b of directChildren(skelEl, "bone")) {
        const bname = b.getAttribute("name");
        const scale = attrVector3(b, "scale");
        if (!bname || !scale) continue;
        rec.bones.push({ name: bname, scale, offset: attrVector3(b, "offset") });
      }
    }
    if (morphEl) {
      rec.morphName = rec.name;   // LLPolyMorphTargetInfo usa el atributo `name`
      for (const vm of directChildren(morphEl, "volume_morph")) {
        rec.volumes.push({
          name: vm.getAttribute("name") || "",
          scale: attrVector3(vm, "scale") || [0, 0, 0],
          pos: attrVector3(vm, "pos") || [0, 0, 0],
        });
      }
    }
    if (driverEl) {
      for (const d of directChildren(driverEl, "driven")) {
        const did = attrNum(d, "id");
        if (did === null) continue;
        rec.driven.push({
          id: did,
          min1: attrNum(d, "min1"), max1: attrNum(d, "max1"),
          max2: attrNum(d, "max2"), min2: attrNum(d, "min2"),
        });
      }
    }
    if (colorEl) {
      for (const v of directChildren(colorEl, "value")) {
        const c = parseColor(v.getAttribute("color"));
        if (c) rec.colorStops.push(c);
      }
    }
    if (alphaEl) {
      for (const v of directChildren(alphaEl, "value")) {
        const a = attrNum(v, "alpha");
        if (a !== null) rec.colorStops.push(a);
      }
    }

    // Un mismo id puede aparecer varias veces (los morphs de la cabeza salen
    // tambien en las pestanas, para que se deformen con ella). Se fusiona.
    const prev = params.get(id);
    if (prev) {
      if (prev.kind !== rec.kind) {
        notes.push("id " + id + " con dos tipos («" + prev.kind + "» y «" + rec.kind + "»)");
        return;
      }
      if (rec.meshType && prev.meshTypes.indexOf(rec.meshType) < 0) prev.meshTypes.push(rec.meshType);
      if (rec.morphName) prev.morphName = rec.morphName;
      for (const b of rec.bones) if (!prev.bones.some((x) => x.name === b.name)) prev.bones.push(b);
      for (const v of rec.volumes) prev.volumes.push(v);
      if (rec.driven.length > prev.driven.length) prev.driven = rec.driven;
      if (!prev.colorStops.length) prev.colorStops = rec.colorStops;
      return;
    }

    if (rec.meshType && rec.kind === "morph") rec.meshTypes.push(rec.meshType);
    params.set(id, rec);
    order.push(id);
    const key = rec.name.toLowerCase();
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(id);
  }

  walk(root, { section: null, meshType: null, colorSet: null, layerSet: null });

  // --- tabla de drivers: rellena los valores por defecto que el XML omite ------
  // LLDriverParamInfo::parseXml:
  //   min1 = driver.min ; max1 = driver.max ; max2 = max1 ; min2 = max1
  // (ojo: min2 es igual a max1, no a min1).
  const drivers = new Map();
  for (const rec of params.values()) {
    if (rec.kind !== "driver") continue;
    const list = rec.driven.map((d) => {
      const min1 = d.min1 === null ? rec.min : d.min1;
      const max1 = d.max1 === null ? rec.max : d.max1;
      const max2 = d.max2 === null ? max1 : d.max2;
      const min2 = d.min2 === null ? max1 : d.min2;
      return { id: d.id, min1, max1, max2, min2 };
    });
    drivers.set(rec.id, list);
  }

  // --- parametros derivados (los que alguien controla por driver) -------------
  const drivenIds = new Set();
  for (const list of drivers.values()) for (const d of list) drivenIds.add(d.id);

  // --- mandos del editor de forma ---------------------------------------------
  // Un mando es un parametro del wearable "shape" que se puede tocar (tiene
  // `edit_group`) y que no lo calcula otro: exactamente el criterio del visor.
  const editable = [];
  for (const rec of params.values()) {
    if (rec.wearable !== "shape") continue;
    if (!rec.editGroup || NON_EDIT_GROUPS.has(rec.editGroup)) continue;
    if (drivenIds.has(rec.id)) continue;
    editable.push(rec.id);
  }
  const groupKeys = [...new Set(editable.map((id) => params.get(id).editGroup))];
  groupKeys.sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  const groups = groupKeys.map((key) => ({
    key,
    label: SHAPE_GROUP_LABELS[key] || key,
    params: editable
      .filter((id) => params.get(id).editGroup === key)
      .sort((a, b) => {
        const oa = params.get(a).editGroupOrder, ob = params.get(b).editGroupOrder;
        return (oa === null ? 999 : oa) - (ob === null ? 999 : ob) || a - b;
      }),
  }));

  // morph_masks: relaciona un morph con la capa de ropa que lo "tapa". Se
  // guarda en el parametro para que el visor pueda decidir si un morph de ropa
  // debe aplicarse (aqui solo se anota).
  for (const m of morphMasks) {
    const ids = names.get(m.morphName.toLowerCase()) || [];
    for (const id of ids) {
      const rec = params.get(id);
      if (rec && rec.kind === "morph") rec.morphMask = { bodyRegion: m.bodyRegion, layer: m.layer };
    }
  }

  return {
    version: root.getAttribute("version") || null,
    wearableDefinitionVersion: attrNum(root, "wearable_definition_version"),
    skeletonFile: (() => { const s = child(root, "skeleton"); return s ? s.getAttribute("file_name") || null : null; })(),
    params,
    order,
    names,
    drivers,
    drivenIds,
    morphMasks,
    editable,
    // Todos los parametros que guarda una forma (no solo los que salen como
    // mando): incluye el genero y los que el editor esconde. Es lo que se
    // almacena/restaura con la forma.
    shapeParams: order.filter((id) => { const r = params.get(id); return r && r.wearable === "shape"; }),
    groups,
    notes,
  };
}

// --- carga (red o retransmisor) ----------------------------------------------

let _table = null;
let _promise = null;

export function cachedAvatarLad() { return _table; }
export function clearAvatarLadCache() { _table = null; _promise = null; }

// Pide el XML y lo parsea una sola vez por pagina. `opts` va tal cual a
// `fetchCharacterFile` (por ejemplo `{provider}` o `{mirrors}`).
export async function loadAvatarLad(opts = {}) {
  if (_table) return _table;
  if (_promise) return _promise;
  _promise = (async () => {
    const bytes = await fetchCharacterFile(AVATAR_LAD_FILE, opts);
    const text = new TextDecoder("utf-8").decode(bytes);
    const table = parseAvatarLad(text);
    _table = table;
    return table;
  })();
  try {
    return await _promise;
  } catch (e) {
    _promise = null;
    throw e;
  }
}

export function avatarLadSummary(table) {
  if (!table) return "avatar_lad: sin cargar";
  return "avatar_lad v" + (table.version || "?") + " · " + table.params.size + " parametros · "
    + table.drivers.size + " drivers · " + table.editable.length + " mandos de forma · "
    + table.groups.length + " grupos";
}

// --- resolucion --------------------------------------------------------------

// getDrivenWeight portado de LLPolySkeletalDistortion... en realidad de
// `LLDriverParam::getDrivenWeight` (lldriverparam.cpp). Devuelve el peso del
// parametro controlado a partir del peso del mando.
export function drivenWeight(driver, driven, inputWeight) {
  const minWeight = driver.min;
  const maxWeight = driver.max;
  let w;
  if (inputWeight <= driven.min1) {
    if (driven.min1 === driven.max1 && driven.min1 <= minWeight) w = driven.maxRef;
    else w = driven.minRef;
  } else if (inputWeight <= driven.max1) {
    const t = (inputWeight - driven.min1) / (driven.max1 - driven.min1);
    w = driven.minRef + t * (driven.maxRef - driven.minRef);
  } else if (inputWeight <= driven.max2) {
    w = driven.maxRef;
  } else if (inputWeight <= driven.min2) {
    const t = (inputWeight - driven.max2) / (driven.min2 - driven.max2);
    w = driven.maxRef + t * (driven.minRef - driven.maxRef);
  } else {
    w = driven.max2 >= maxWeight ? driven.maxRef : driven.minRef;
  }
  return w;
}

// Resuelve un conjunto de valores `{id: peso}` a los efectos que sabe aplicar
// `avatarMesh` (morphs + deltas de hueso) mas los colores y los volumenes de
// colision. `opts.sex` = "male" | "female" | "both".
export function resolveAppearance(table, valuesById, opts = {}) {
  if (!table) throw new Error("avatarLad: falta la tabla");
  // `sex: "auto"` (o sin sexo) = el que diga el mando «male» de la forma, que es
  // lo que hace el visor. Pasar un numero (SEX.MALE/FEMALE/BOTH) lo fuerza.
  const auto = opts.sex === undefined || opts.sex === null || opts.sex === "auto";
  const sex = auto ? sexFromValues(table, valuesById) : (typeof opts.sex === "number" ? opts.sex : parseSex(opts.sex));
  const wantColors = opts.colors !== false;

  const morphMap = new Map();     // nombre de morph -> peso
  const boneMap = new Map();      // nombre de hueso -> { scale, pos, hasPos, sources }
  const volumeMap = new Map();    // volumen de colision -> { scale, pos, sources }
  const colorMap = new Map();     // clave -> { rgba, ... }
  const unknown = [];
  const notes = [];

  const matchesSex = (rec) => (rec.sex & sex) !== 0;
  // LLPolyMorphTarget::apply / LLPolySkeletalDistortion::apply: si el sexo no
  // coincide, se usa el valor por defecto del parametro (no el valor actual).
  const effective = (rec, w) => (matchesSex(rec) ? w : rec.defaultWeight);

  function addBone(name, scale, offset, w) {
    let e = boneMap.get(name);
    if (!e) { e = { scale: [0, 0, 0], pos: [0, 0, 0], hasPos: false, sources: [] }; boneMap.set(name, e); }
    for (let i = 0; i < 3; i++) e.scale[i] += w * scale[i];
    if (offset) {
      e.hasPos = true;
      for (let i = 0; i < 3; i++) e.pos[i] += w * offset[i];
    }
  }

  function emit(rec, weight) {
    const w = effective(rec, weight);
    if (rec.kind === "skeleton") {
      for (const b of rec.bones) addBone(b.name, b.scale, b.offset, w);
    } else if (rec.kind === "morph") {
      const name = rec.morphName || rec.name;
      if (morphMap.has(name) && Math.abs(morphMap.get(name) - w) > 1e-6) {
        notes.push("morph «" + name + "» con dos pesos (" + morphMap.get(name) + " y " + w + ")");
      }
      morphMap.set(name, w);
      for (const v of rec.volumes) {
        let e = volumeMap.get(v.name);
        if (!e) { e = { scale: [0, 0, 0], pos: [0, 0, 0], sources: [] }; volumeMap.set(v.name, e); }
        for (let i = 0; i < 3; i++) { e.scale[i] += w * v.scale[i]; e.pos[i] += w * v.pos[i]; }
      }
    } else if (rec.kind === "color" && wantColors && rec.colorStops.length) {
      colorMap.set(rec.name, {
        name: rec.name, wearable: rec.wearable, set: rec.colorSet, layerSet: rec.layerSet,
        operation: rec.colorOperation, weight: w, rgba: sampleGradient(rec.colorStops, rec.min, rec.max, weight),
      });
    } else if (rec.kind === "alpha" && wantColors && rec.colorStops.length) {
      colorMap.set(rec.name, {
        name: rec.name, wearable: rec.wearable, set: rec.colorSet, layerSet: rec.layerSet,
        operation: "alpha", weight: w, alpha: sampleGradient(rec.colorStops, rec.min, rec.max, weight),
      });
    }
  }

  function process(id, weight, fromDriver) {
    const rec = table.params.get(id);
    if (!rec) { unknown.push(id); return; }
    if (rec.kind === "driver") {
      // Un driver calcula a sus controlados y no deforma por si mismo (exacto
      // en el visor). La formula usa el peso CRUDO del mando.
      const list = table.drivers.get(id) || [];
      for (const d of list) {
        const target = table.params.get(d.id);
        if (!target) { unknown.push(d.id); continue; }
        const dw = drivenWeight(rec, { ...d, minRef: target.min, maxRef: target.max }, weight);
        process(d.id, dw, true);
      }
      return;
    }
    void fromDriver;
    emit(rec, weight);
  }

  for (const key in valuesById) {
    const id = Number(key);
    const w = valuesById[key];
    if (!Number.isFinite(id) || !Number.isFinite(w)) continue;
    process(id, w, false);
  }

  const bones = [];
  for (const [name, e] of boneMap) {
    const mag = Math.abs(e.scale[0]) + Math.abs(e.scale[1]) + Math.abs(e.scale[2]);
    if (mag > 1e-9 || e.hasPos) bones.push({ name, scale: e.scale, pos: e.hasPos ? e.pos : null });
  }
  const volumes = [];
  for (const [name, e] of volumeMap) volumes.push({ name, scale: e.scale, pos: e.pos });
  const morphs = {};
  for (const [name, w] of morphMap) if (Math.abs(w) > 1e-9) morphs[name] = w;
  const colors = {};
  for (const [name, c] of colorMap) colors[name] = c;

  return {
    sex, autoSex: auto, genderParam: genderParamId(table), morphs, bones, volumes, colors, unknown, notes,
    counts: {
      inputs: Object.keys(valuesById).length,
      morphs: Object.keys(morphs).length,
      bones: bones.length,
      volumes: volumes.length,
      colors: Object.keys(colors).length,
      unknown: unknown.length,
    },
  };
}

// Muestrea una lista de valores (paradas de color o de alfa) a lo largo del
// rango del parametro. Los valores del XML estan repartidos uniformemente.
export function sampleGradient(stops, min, max, weight) {
  if (!stops || !stops.length) return null;
  if (stops.length === 1) return stops[0];
  const t = max > min ? Math.max(0, Math.min(1, (weight - min) / (max - min))) : 0;
  const pos = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = stops[i], b = stops[i + 1];
  if (typeof a === "number" && typeof b === "number") return a + f * (b - a);
  const out = [];
  for (let k = 0; k < a.length; k++) out.push(a[k] + f * (b[k] - a[k]));
  return out;
}

// --- valores de forma ---------------------------------------------------------

// La forma por defecto (un avatar "neutro"): los valores por defecto del XML.
// Se guardan TODOS los parametros de la forma (no solo los mandos), para que el
// genero viaje con ella.
export function defaultShapeValues(table) {
  const out = {};
  const ids = table.shapeParams || table.editable;
  for (const id of ids) out[id] = table.params.get(id).defaultWeight;
  return out;
}

// Generador pseudoaleatorio determinista (no toca Math.random del motor).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFrom(value) {
  if (typeof value === "number") return value >>> 0;
  const s = String(value === undefined || value === null ? "0" : value);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Una forma aleatoria pero ESTABLE para una semilla: los mismos valores en
// todos los clientes (como el resto de la apariencia derivada de semilla).
// `opts.amount` (0..1) controla cuanto se separa del valor por defecto.
export function randomShapeValues(table, seed, opts = {}) {
  const rnd = mulberry32(seedFrom(seed));
  const amount = opts.amount === undefined ? 0.55 : Math.max(0, Math.min(1, opts.amount));
  const out = {};
  const gid = genderParamId(table);
  for (const id of (table.shapeParams || table.editable)) {
    const p = table.params.get(id);
    // Ruido triangular en [-1,1]: la mayoria de la gente se parece a la media.
    const n = (rnd() - rnd()) * amount;
    out[id] = Math.max(p.min, Math.min(p.max, p.defaultWeight + n * (p.max - p.min) * 0.5));
  }
  // El genero, de medio lado: asi la mitad de las formas aleatorias salen
  // masculinas y la otra mitad femeninas, pero ninguna a medias.
  if (gid !== null && opts.gender !== false) {
    const g = table.params.get(gid);
    out[gid] = rnd() < 0.5 ? g.min : g.max;
  }
  return out;
}

// Una forma tipica femenina/masculina. El genero NO se consigue tocando mil
// mandos: se pone el mando «male» a 0 o a 1 y su driver (id 80 -> 32, 153, 40,
// 100, 857) hace el resto, exactamente como cuando mueves la barra «Gender» del
// editor de SL. A partir de ahi se orientan un poco los mandos de forma.
export function genderedShapeValues(table, sex, opts = {}) {
  const out = defaultShapeValues(table);
  const target = parseSex(sex);
  const gid = genderParamId(table);
  if (gid !== null) {
    const g = table.params.get(gid);
    out[gid] = target === SEX.MALE ? g.max : g.min;
  }
  for (const id of (table.shapeParams || table.editable)) {
    const p = table.params.get(id);
    if (id === gid) continue;
    if ((p.sex & target) !== 0 && p.sex !== SEX.BOTH) {
      // El parametro existe para este sexo: se lleva a su zona media-alta.
      out[id] = Math.max(p.min, Math.min(p.max, p.defaultWeight + (p.max - p.defaultWeight) * 0.5));
    }
  }
  const rnd = mulberry32(seedFrom(opts.seed === undefined ? "seed" : opts.seed));
  const amount = opts.amount === undefined ? 0.3 : opts.amount;
  for (const key in out) {
    const p = table.params.get(Number(key));
    if (!p || Number(key) === gid) continue;
    const n = (rnd() - rnd()) * amount;
    out[key] = Math.max(p.min, Math.min(p.max, out[key] + n * (p.max - p.min) * 0.35));
  }
  return out;
}

// Lista de mandos lista para pintar en la interfaz: un objeto por grupo con sus
// parametros y etiquetas. Al principio del primer grupo va la barra «Genero»
// (el mando «male»), que es como la coloca el editor de SL: no es un mando
// normal (el XML lo esconde en el grupo «dummy»), pero lo gobierna todo.
export function shapeSliders(table) {
  const out = table.groups.map((g) => ({
    key: g.key,
    label: g.label,
    sliders: g.params.map((id) => {
      const p = table.params.get(id);
      return {
        id, name: p.name, label: p.label || p.name,
        min: p.min, max: p.max, def: p.defaultWeight,
        labelMin: p.labelMin, labelMax: p.labelMax,
      };
    }),
  }));
  const gid = genderParamId(table);
  if (gid !== null && out.length) {
    const p = table.params.get(gid);
    out[0].sliders.unshift({
      id: gid, name: p.name, label: "Género",
      min: p.min, max: p.max, def: p.defaultWeight,
      labelMin: "Femenino", labelMax: "Masculino", gender: true,
    });
  }
  return out;
}

// --- autotest -----------------------------------------------------------------

// Comprueba el parseo, la formula del driver (incluida la de los tramos con
// `min1`/`max2` explicitos) y la resolucion, con un XML sintetico. No toca la
// red.
export function runAvatarLadSelfTest() {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });

  const XML = [
    '<?xml version="1.0" encoding="us-ascii"?>',
    '<linden_avatar version="2.0" wearable_definition_version="22">',
    '  <skeleton file_name="avatar_skeleton.xml">',
    '    <param id="32" group="1" wearable="shape" name="Male_Skeleton" value_min="0" value_max="1">',
    '      <param_skeleton><bone name="mNeck" scale="0 0 .2" /><bone name="mChest" scale=".05 .05 .05" /></param_skeleton>',
    '    </param>',
    '    <param id="33" group="0" wearable="shape" name="Height" label="Height" edit_group="shape_body" edit_group_order="1" value_min="-2.3" value_max="2">',
    '      <param_skeleton><bone name="mPelvis" scale="0 0 0.1" /></param_skeleton>',
    '    </param>',
    '    <param id="30002" group="1" name="Nose_Big_Out" value_min="-0.8" value_max="2.5">',
    '      <param_skeleton><bone name="mFaceNoseCenter" scale="0.5 0.3 0.1" /></param_skeleton>',
    '    </param>',
    '  </skeleton>',
    '  <mesh type="headMesh" lod="0" file_name="avatar_head.llm">',
    '    <param id="20002" group="1" name="Nose_Big_Out" value_min="-0.8" value_max="2.5"><param_morph /></param>',
    '    <param id="186" group="1" name="Egg_Head" value_min="0" value_max="1"><param_morph /></param>',
    '  </mesh>',
    '  <mesh type="eyelashMesh" lod="0" file_name="avatar_eyelashes.llm">',
    '    <param id="186" group="1" name="Egg_Head" value_min="0" value_max="1"><param_morph /></param>',
    '  </mesh>',
    '  <global_color name="skin_color">',
    '    <param id="111" group="0" wearable="skin" name="Pigment" value_min="0" value_max="1" value_default=".5">',
    '      <param_color><value color="252, 215, 200, 255" /><value color="29, 9, 6, 255" /></param_color>',
    '    </param>',
    '  </global_color>',
    '  <driver_parameters>',
    '    <param id="2" group="0" wearable="shape" name="Nose_Big_Out" value_min="-0.8" value_max="2.5">',
    '      <param_driver><driven id="20002" /><driven id="30002" /></param_driver>',
    '    </param>',
    '    <param id="663" group="0" wearable="shape" name="Shift_Mouth" value_min="-2" value_max="2">',
    '      <param_driver>',
    '        <driven id="20663" /><driven id="31663" min1="-2" max1="-2" max2="-2" min2="0" /><driven id="32663" min1="0" max1="2" max2="2" min2="2" />',
    '      </param_driver>',
    '    </param>',
    '    <param id="80" group="0" wearable="shape" name="male" value_min="0" value_max="1" />',
    '  </driver_parameters>',
    '  <morph_masks><mask morph_name="Egg_Head" body_region="head" layer="facialhair" /></morph_masks>',
    '</linden_avatar>',
  ].join("\n");

  let table = null;
  try {
    table = parseAvatarLad(XML);
    ok("parsea el XML", !!table);
  } catch (e) {
    ok("parsea el XML", false, e && e.message);
    const failed = checks.filter((c) => !c.pass);
    return { checks, total: checks.length, failed: failed.length, summary: "avatarLad selftest: " + failed.length + "/" + checks.length + " FAILED" };
  }

  ok("version y version de wearable", table.version === "2.0" && table.wearableDefinitionVersion === 22);
  ok("9 parametros", table.params.size === 9, table.params.size);
  ok("el mismo morph en dos mallas se fusiona", table.params.get(186).meshTypes.join(",") === "headMesh,eyelashMesh", JSON.stringify(table.params.get(186).meshTypes));
  ok("los huesos del parametro de esqueleto", table.params.get(32).bones.length === 2 && table.params.get(32).bones[0].name === "mNeck");
  ok("el morfo usa el atributo name", table.params.get(20002).kind === "morph" && table.params.get(20002).morphName === "Nose_Big_Out");
  ok("el id 30002 es de esqueleto", table.params.get(30002).kind === "skeleton");
  ok("el color tiene 2 paradas", table.params.get(111).colorStops.length === 2 && table.params.get(111).colorStops[1][3] === 255);
  ok("el default del color se recorta", Math.abs(table.params.get(111).defaultWeight - 0.5) < 1e-9);
  ok("morph_mask anotado en el morfo", !!table.params.get(186).morphMask && table.params.get(186).morphMask.layer === "facialhair");
  ok("no hay mandos repetidos", new Set(table.editable).size === table.editable.length);
  ok("los mandos excluyen a los controlados", !table.editable.includes(30002) && !table.editable.includes(20002));
  ok("mandos: solo Height (el driver no tiene edit_group)", table.editable.length === 1 && table.editable[0] === 33, JSON.stringify(table.editable));
  ok("grupos del editor", table.groups.length === 1 && table.groups[0].label === "Cuerpo");

  // --- genero: el mando «male» decide el sexo (llvoavatar.cpp) ---------------
  ok("el mando de genero se encuentra por nombre", genderParamId(table) === 80);
  ok("los parametros de forma incluyen el genero", table.shapeParams.includes(80));
  ok("sin forma, el sexo por defecto es femenino", sexFromValues(table, {}) === SEX.FEMALE);
  ok("male=1 -> masculino", sexFromValues(table, { 80: 1 }) === SEX.MALE);
  ok("male=0.5 exacto -> femenino (como el visor)", sexFromValues(table, { 80: 0.5 }) === SEX.FEMALE);
  ok("resolve deduce el sexo de la forma", resolveAppearance(table, { 80: 1 }).sex === SEX.MALE);
  ok("y lo respeta si se fuerza", resolveAppearance(table, { 80: 1 }, { sex: "female" }).sex === SEX.FEMALE);
  ok("una forma masculina pone male=1", genderedShapeValues(table, "male")[80] === 1);
  ok("una forma femenina pone male=0", genderedShapeValues(table, "female")[80] === 0);
  ok("la forma aleatoria elige un genero entero", [0, 1].includes(randomShapeValues(table, "genero")[80]), randomShapeValues(table, "genero")[80]);

  // --- formula del driver
  const driver2 = table.params.get(2);
  const d20002 = table.drivers.get(2).find((d) => d.id === 20002);
  ok("los defectos del driven: min1=driver.min, max1=driver.max, max2=max1, min2=max1",
    d20002.min1 === -0.8 && d20002.max1 === 2.5 && d20002.max2 === 2.5 && d20002.min2 === 2.5,
    JSON.stringify(d20002));
  const wAt = (input) => drivenWeight(driver2, { ...d20002, minRef: -0.8, maxRef: 2.5 }, input);
  ok("a mitad del mando, el controlado va a mitad", Math.abs(wAt(0.85) - 0.85) < 1e-9, wAt(0.85));
  ok("en el minimo, el controlado esta en su minimo", Math.abs(wAt(-0.8) - (-0.8)) < 1e-9, wAt(-0.8));
  ok("en el maximo, el controlado esta en su maximo", Math.abs(wAt(2.5) - 2.5) < 1e-9, wAt(2.5));

  // tramos explicitos (min1=max1 y max2=min2). El mando 663 tiene rango -2..2.
  const driver663 = { min: -2, max: 2 };
  const d31663 = { id: 31663, min1: -2, max1: -2, max2: -2, min2: 0, minRef: 0, maxRef: 1 };
  const d32663 = { id: 32663, min1: 0, max1: 2, max2: 2, min2: 2, minRef: 0, maxRef: 1 };
  ok("tramo fijo: input==min1 -> el maximo", drivenWeight(driver663, d31663, -2) === 1);
  ok("rampa descendente a mitad -> 0.5", Math.abs(drivenWeight(driver663, d31663, -1) - 0.5) < 1e-9, drivenWeight(driver663, d31663, -1));
  ok("pasado min2 -> el minimo", drivenWeight(driver663, d31663, 1) === 0, drivenWeight(driver663, d31663, 1));
  ok("rampa ascendente a mitad -> 0.5", Math.abs(drivenWeight(driver663, d32663, 1) - 0.5) < 1e-9, drivenWeight(driver663, d32663, 1));

  // --- resolucion: el mando de nariz mueve el morph Y el hueso
  let r = resolveAppearance(table, { 2: 2.5 });
  ok("el driver mueve el morph de la cabeza", Math.abs(r.morphs.Nose_Big_Out - 2.5) < 1e-9, JSON.stringify(r.morphs));
  const noseBone = r.bones.find((b) => b.name === "mFaceNoseCenter");
  ok("el driver mueve tambien el hueso de la nariz", !!noseBone && Math.abs(noseBone.scale[0] - 1.25) < 1e-9, noseBone && JSON.stringify(noseBone.scale));
  ok("no hay ids desconocidos", r.unknown.length === 0, JSON.stringify(r.unknown));

  // --- resolucion: un parametro de esqueleto directo
  r = resolveAppearance(table, { 33: 2 });
  const pelvis = r.bones.find((b) => b.name === "mPelvis");
  ok("Height mueve mPelvis", !!pelvis && Math.abs(pelvis.scale[2] - 0.2) < 1e-9, pelvis && JSON.stringify(pelvis.scale));

  // --- sexo: un parametro del sexo contrario usa su valor por defecto
  table.params.get(33).sex = SEX.MALE;
  table.params.get(33).defaultWeight = 0;
  r = resolveAppearance(table, { 33: 2 }, { sex: "female" });
  const pelvis2 = r.bones.find((b) => b.name === "mPelvis");
  ok("sexo distinto -> valor por defecto (sin escala)", !pelvis2 || Math.abs(pelvis2.scale[2]) < 1e-9, pelvis2 && JSON.stringify(pelvis2.scale));
  r = resolveAppearance(table, { 33: 2 }, { sex: "male" });
  ok("sexo igual -> el valor pedido", Math.abs(r.bones.find((b) => b.name === "mPelvis").scale[2] - 0.2) < 1e-9);

  // --- colores
  r = resolveAppearance(table, { 111: 1 });
  ok("el color del extremo alto es el ultimo del gradiente", r.colors.Pigment && r.colors.Pigment.rgba[0] === 29, JSON.stringify(r.colors.Pigment && r.colors.Pigment.rgba));
  r = resolveAppearance(table, { 111: 0.5 });
  ok("a mitad del gradiente el color se interpola", r.colors.Pigment && Math.abs(r.colors.Pigment.rgba[0] - (252 + 29) / 2) < 1e-6, r.colors.Pigment && r.colors.Pigment.rgba[0]);

  // --- formas
  const def = defaultShapeValues(table);
  ok("la forma por defecto tiene todos los parametros de la forma", Object.keys(def).length === 5 && def[33] === 0 && def[80] === 0 && def[32] === 0, JSON.stringify(def));
  const a = randomShapeValues(table, "semilla");
  const b = randomShapeValues(table, "semilla");
  const c = randomShapeValues(table, "otra");
  ok("la forma aleatoria es estable para la misma semilla", JSON.stringify(a) === JSON.stringify(b));
  ok("y distinta para otra semilla", JSON.stringify(a) !== JSON.stringify(c));
  ok("los valores aleatorios estan dentro del rango", Object.keys(a).every((id) => { const p = table.params.get(Number(id)); return a[id] >= p.min - 1e-9 && a[id] <= p.max + 1e-9; }));

  // --- sliders
  const sl = shapeSliders(table);
  ok("los sliders salen agrupados", sl.length === 1 && sl[0].sliders.length === 2 && sl[0].sliders[1].id === 33);
  ok("la barra de genero va la primera y marcada", sl[0].sliders[0].id === 80 && sl[0].sliders[0].gender === true && sl[0].sliders[0].label === "Género");
  ok("la barra de genero se rotula femenino/masculino", sl[0].sliders[0].labelMin === "Femenino" && sl[0].sliders[0].labelMax === "Masculino");

  const failed = checks.filter((x) => !x.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "avatarLad selftest: all " + checks.length + " checks passed"
      : "avatarLad selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((x) => x.name).join(", ") + ")",
  };
}
