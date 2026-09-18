// shapeStore.js -- la FORMA REAL del residente, guardada entre sesiones.
//
// El editor de forma (`#bodytest/forma`) produce el mismo tipo de datos que el
// editor de aspecto de Second Life: el peso de cada parametro visual de
// `avatar_lad.xml`. Aqui se guarda ese bloque para que el avatar del mundo
// (`viewer.js` -> `avatarRealBody.js`) salga deformado igual que en SL sin
// tener que volver a tocar los mandos.
//
// Se guarda en `kv` (IndexedDB, por usuario, sobrevive a recargas) y, si el
// plugin no estuviera disponible, en `localStorage`. Es un objeto pequeno
// (unos cientos de bytes): solo los parametros que no estan de fabrica.

import { normalizeShape } from "../avatarParams.js";
import { diag } from "../diag.js";

const FOLDER = "forma";
const KEY = "residente";
const LS_KEY = "visor-sl/forma-real";

function kvFolder() {
  try {
    if (typeof root !== "undefined" && root && root.kv) return root.kv[FOLDER];
  } catch (e) { /* sin plugin */ }
  return null;
}

// Guarda la forma. Devuelve `true` si se guardo en algun sitio.
export async function saveStoredShape(shape) {
  const norm = normalizeShape(shape);
  if (!norm) return false;
  const payload = { v: 1, sex: norm.sex, visualParams: norm.visualParams, bakes: norm.bakes };
  let ok = false;
  const folder = kvFolder();
  if (folder) {
    try { await folder.set(KEY, payload); ok = true; }
    catch (e) { diag.aviso("forma", "no se pudo guardar la forma en kv: " + (e && e.message ? e.message : e)); }
  }
  if (!ok) {
    try {
      if (typeof localStorage !== "undefined") { localStorage.setItem(LS_KEY, JSON.stringify(payload)); ok = true; }
    } catch (e) { diag.aviso("forma", "no se pudo guardar la forma en localStorage: " + (e && e.message ? e.message : e)); }
  }
  if (ok) diag.info("forma", "forma guardada para el avatar del mundo (" + payload.visualParams.length + " parámetros)");
  return ok;
}

// Carga la forma guardada (o `null`). Nunca lanza.
export async function loadStoredShape() {
  let raw = null;
  const folder = kvFolder();
  if (folder) {
    try { raw = await folder.get(KEY); } catch (e) { /* se prueba localStorage */ }
  }
  if (!raw && typeof localStorage !== "undefined") {
    try {
      const s = localStorage.getItem(LS_KEY);
      if (s) raw = JSON.parse(s);
    } catch (e) { /* nada */ }
  }
  if (!raw) return null;
  const norm = normalizeShape(raw);
  if (!norm || (!norm.visualParams.length && !Object.keys(norm.bakes).length)) return null;
  return norm;
}

// Borra la forma guardada.
export async function clearStoredShape() {
  const folder = kvFolder();
  if (folder) { try { await folder.delete(KEY); } catch (e) { /* nada */ } }
  try { if (typeof localStorage !== "undefined") localStorage.removeItem(LS_KEY); } catch (e) { /* nada */ }
  return true;
}
