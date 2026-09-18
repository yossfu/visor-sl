// store.js -- persistencia del visor sobre el plugin `kv` (IndexedDB).
//
// Se guardan dos cosas:
//   * la REGION (carpeta `region`): `autosave` se reescribe solo, con retardo,
//     despues de cada cambio del mundo, y ademas se pueden hacer guardados con
//     nombre. El contenido es exactamente `world.serialize()`.
//   * el INVENTARIO (carpeta `inventory`): prims sueltos con su forma,
//     parametros, tamano y color, para volver a rezarlos donde se quiera.
//
// En SL el inventario es la pieza que hace util al visor (lo que construyes no
// se pierde), asi que el autoguardado va enganchado al mismo embudo por el que
// pasan todas las ediciones del editor.
//
// `kv` es asincrono y puede no estar disponible (sin `root`, o si el plugin no
// cargo): el modulo entero degrada a "no guarda nada" sin lanzar excepciones.

import * as THREE from "./three.js";
import { facesToJson } from "./faces.js";

const VERSION = 1;
const AUTOSAVE = "autosave";

// Formato de un archivo de region exportado: envoltorio con metadatos para que
// el archivo se entienda solo, y el `serialize()` del mundo dentro. Al importar
// se acepta tanto el envoltorio como un `serialize()` suelto.
export function regionToJson(data, extra) {
  return JSON.stringify(Object.assign(
    { version: VERSION, generatedAt: new Date().toISOString() },
    extra || {},
    { world: data },
  ), null, 1);
}
export function parseRegionJson(text) {
  const parsed = JSON.parse(text);
  const data = parsed && parsed.world ? parsed.world : parsed;
  if (!data || !data.objects) throw new Error("el archivo no tiene prims");
  return data;
}

function kvFolders() {
  const r = typeof window !== "undefined" ? window.root : null;
  const kv = r && r.kv ? r.kv : null;
  if (!kv) return null;
  return { region: kv.region, inventory: kv.inventory, avatar: kv.avatar };
}

// Saca de un prim del mundo el registro que se guarda en el inventario: se
// guarda la transformada pero NO la posicion (al rezar se coloca en el suelo,
// delante del avatar, como hace SL con el "rez" de un objeto).
export function primToItem(obj) {
  return {
    version: VERSION,
    name: obj.name,
    shape: obj.params.shape,
    params: Object.assign({}, obj.params),
    scale: obj.scale.toArray(),
    quaternion: obj.quaternion.toArray(),
    color: obj.colorHex === undefined ? null : obj.colorHex,
    // La apariencia por cara viaja con el objeto: en SL un objeto guardado en
    // el inventario conserva sus texturas, no solo la forma.
    faces: facesToJson(obj.faces),
    // El script tambien es contenido del objeto: guardarlo en el inventario lo
    // conserva al rezarlo de nuevo (como el contenido de un objeto en SL).
    script: obj.script || null,
    build: obj.build !== false,
    phantom: !!obj.phantom,
    savedAt: Date.now(),
  };
}

// Opciones para `world.add` a partir de un registro del inventario. La posicion
// la decide quien reza; la escala, rotacion, color y flags vienen del registro.
export function itemToAdd(item) {
  const o = { name: item.name, build: item.build !== false, phantom: !!item.phantom };
  if (item.scale) o.scale = new THREE.Vector3().fromArray(item.scale);
  if (item.quaternion) o.quaternion = new THREE.Quaternion().fromArray(item.quaternion);
  return o;
}

export function createStore(world, opts = {}) {
  const folders = kvFolders();
  const delay = opts.delay === undefined ? 1400 : opts.delay;
  let timer = null;
  let lastJson = null;
  let pending = null;
  let writes = 0;

  function pack(data) {
    return { version: VERSION, savedAt: Date.now(), data };
  }
  function unpack(rec) {
    if (!rec) return null;
    if (rec.data && (rec.data.objects || rec.data.nextId)) return rec.data;
    // Compatibilidad: un guardado que sea directamente el serialize().
    if (rec.objects) return rec;
    return null;
  }

  async function saveRegion(name, data) {
    if (!folders) return false;
    await folders.region.set(name || AUTOSAVE, pack(data));
    return true;
  }
  async function loadRegion(name) {
    if (!folders) return null;
    return unpack(await folders.region.get(name || AUTOSAVE));
  }
  async function listRegions() {
    if (!folders) return [];
    const ents = await folders.region.entries();
    return ents.map(([k, v]) => ({ name: k, savedAt: v && v.savedAt ? v.savedAt : 0, objects: v && v.data && v.data.objects ? v.data.objects.length : 0 }))
      .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }
  async function deleteRegion(name) {
    if (!folders) return false;
    await folders.region.delete(name || AUTOSAVE);
    if ((name || AUTOSAVE) === AUTOSAVE) lastJson = null;
    return true;
  }
  async function renameRegion(from, to) {
    if (!folders) return false;
    const v = await folders.region.get(from);
    if (v === undefined) return false;
    await folders.region.set(to, Object.assign({}, v, { savedAt: Date.now() }));
    await folders.region.delete(from);
    return true;
  }

  // Autoguardado con retardo: el editor llama aqui en cada cambio (el embudo es
  // `refreshStatus`), pero escribir en cada pixel de un deslizador seria absurdo
  // y ademas cada escritura es una transaccion de IndexedDB.
  //
  // Se le pasa una FUNCION que devuelve los datos, no los datos: asi
  // `world.serialize()` (que recorre los 60 prims y asigna arrays) solo se paga
  // cuando de verdad hay que escribir, no en cada evento de arrastre.
  function schedule(source) {
    pending = typeof source === "function" ? source : () => source;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, delay);
  }
  async function flush() {
    const source = pending;
    pending = null;
    if (!folders || !source) return false;
    const data = source();
    if (!data) return false;
    const json = JSON.stringify(data);
    if (json === lastJson) return false;
    lastJson = json;
    writes++;
    await folders.region.set(AUTOSAVE, pack(data));
    return true;
  }

  // --- inventario ---
  async function listItems() {
    if (!folders) return [];
    const ents = await folders.inventory.entries();
    return ents
      .map(([k, v]) => ({ name: k, savedAt: (v && v.savedAt) || 0, shape: v && v.shape, item: v }))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  async function saveItem(name, item) {
    if (!folders || !name) return false;
    await folders.inventory.set(name, item);
    return true;
  }
  async function deleteItem(name) {
    if (!folders) return false;
    await folders.inventory.delete(name);
    return true;
  }

  // --- aspecto del avatar ---
  // El aspecto propio se guarda con la clave "self" (y se puede guardar con
  // nombre, como un "outfit" de SL que se cambia de un clic).
  async function saveAppearance(name, appearance) {
    if (!folders) return false;
    await folders.avatar.set(name || "self", { savedAt: Date.now(), appearance });
    return true;
  }
  async function loadAppearance(name) {
    if (!folders) return null;
    const rec = await folders.avatar.get(name || "self");
    return rec && rec.appearance ? rec.appearance : null;
  }
  async function listAppearances() {
    if (!folders) return [];
    const ents = await folders.avatar.entries();
    return ents.map(([k, v]) => ({ name: k, savedAt: (v && v.savedAt) || 0 }))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  async function deleteAppearance(name) {
    if (!folders) return false;
    await folders.avatar.delete(name);
    return true;
  }

  return {
    available: !!folders,
    autosaveName: AUTOSAVE,
    saveRegion, loadRegion, listRegions, deleteRegion, renameRegion,
    schedule, flush,
    get writes() { return writes; },
    listItems, saveItem, deleteItem,
    saveAppearance, loadAppearance, listAppearances, deleteAppearance,
  };
}
