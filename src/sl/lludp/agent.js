// agent.js -- los mensajes del agente, la region, los avatares y el chat.
//
// QUE ES ESTO
// -----------
// El codec (codec.js) sabe convertir bytes en campos y al reves, y las tablas
// de plantillas (template.js) dicen que campos tiene cada mensaje. Lo que falta
// es el SIGNIFICADO: que es el byte 0x2000 de `ControlFlags` (volar), que
// `ChatType` 8 es un mensaje de la region, donde esta el UUID del bake de la
// cabeza dentro del TextureEntry de un avatar, o como se rellena un
// `AgentUpdate` para que un simulador de verdad acepte que el avatar camina.
//
// Este modulo es, por tanto, el diccionario del protocolo: los valores de
// enumeracion de Linden Lab, los constructores de los mensajes que MANDA el
// visor, y los lectores de los que RECIBE. Todo lo que hay aqui esta sacado de
// las fuentes del visor de Linden Lab (`indra_constants.h`,
// `llviewermessage.cpp`, `llagent.cpp`, `llviewerstats.h`, `llparcelflags.h`,
// `llteleportflags.h`, `llavatarappearancedefines.cpp`) y comprobado contra las
// capturas reales de `recapturas.js`.
//
// Las cantidades son las del cable, no las del mundo: `Position` de
// CoarseLocationUpdate va en metros pero en pasos de 4 en Z, `ControlFlags` es
// una mascara de bits, y `VisualParam` de `AvatarAppearance` es un byte 0..255
// que hay que llevar al rango [min,max] de cada parametro del esqueleto (eso lo
// hace `visualParamsToValues`, con la tabla de `avatarLad.js`).

import { NULL_UUID, uuidFromBytes, u64ToNumber } from "./codec.js";
import { MAX_TES } from "./objects.js";

// --- texto de los campos Variable -------------------------------------------
//
// Los campos `Variable` de texto llegan como bytes con un NUL final que cuenta
// en la longitud (es lo que hace `addString` en el visor). `texto()` los
// convierte en cadena y quita ese NUL. Los binarios (TextureEntry, NameValue)
// no pasan por aqui.

export function texto(bytes) {
  if (bytes === undefined || bytes === null) return "";
  if (typeof bytes === "string") return bytes;
  let n = bytes.length;
  while (n > 0 && bytes[n - 1] === 0) n--;
  try { return new TextDecoder("utf-8").decode(bytes.subarray(0, n)); }
  catch (e) {
    let out = "";
    for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
}

// ===========================================================================
// 1. ENUMERACIONES DE LINDEN LAB
// ===========================================================================

// Bits de `AgentUpdate.State`.
export const AGENT_STATE = {
  TYPING: 0x04,
  EDITING: 0x10,
};

// Bits de `AgentUpdate.Flags`.
export const AU_FLAG = {
  NONE: 0x00,
  HIDETITLE: 0x01,
  CLIENT_AUTOPILOT: 0x02,
};

// `AgentUpdate.ControlFlags`: cada bit es una tecla o una accion. Los valores
// son los de `indra_constants.h` (`AGENT_CONTROL_*`), que es exactamente lo que
// espera el simulador.
export const CONTROL = {
  AT_POS: 0x00000001,
  AT_NEG: 0x00000002,
  LEFT_POS: 0x00000004,
  LEFT_NEG: 0x00000008,
  UP_POS: 0x00000010,
  UP_NEG: 0x00000020,
  PITCH_POS: 0x00000040,
  PITCH_NEG: 0x00000080,
  YAW_POS: 0x00000100,
  YAW_NEG: 0x00000200,
  FAST_AT: 0x00000400,
  FAST_LEFT: 0x00000800,
  FAST_UP: 0x00001000,
  FLY: 0x00002000,
  STOP: 0x00004000,
  FINISH_ANIM: 0x00008000,
  STAND_UP: 0x00010000,
  SIT_ON_GROUND: 0x00020000,
  MOUSELOOK: 0x00040000,
  NUDGE_AT_POS: 0x00080000,
  NUDGE_AT_NEG: 0x00100000,
  NUDGE_LEFT_POS: 0x00200000,
  NUDGE_LEFT_NEG: 0x00400000,
  NUDGE_UP_POS: 0x00800000,
  NUDGE_UP_NEG: 0x01000000,
  TURN_LEFT: 0x02000000,
  TURN_RIGHT: 0x04000000,
  AWAY: 0x08000000,
  LBUTTON_DOWN: 0x10000000,
  LBUTTON_UP: 0x20000000,
  ML_LBUTTON_DOWN: 0x40000000,
  ML_LBUTTON_UP: 0x80000000,
};

// Nombres en orden de bit, para el panel de diagnostico.
export const CONTROL_NAME = [
  "AT_POS", "AT_NEG", "LEFT_POS", "LEFT_NEG", "UP_POS", "UP_NEG",
  "PITCH_POS", "PITCH_NEG", "YAW_POS", "YAW_NEG",
  "FAST_AT", "FAST_LEFT", "FAST_UP", "FLY", "STOP", "FINISH_ANIM",
  "STAND_UP", "SIT_ON_GROUND", "MOUSELOOK",
  "NUDGE_AT_POS", "NUDGE_AT_NEG", "NUDGE_LEFT_POS", "NUDGE_LEFT_NEG",
  "NUDGE_UP_POS", "NUDGE_UP_NEG", "TURN_LEFT", "TURN_RIGHT", "AWAY",
  "LBUTTON_DOWN", "LBUTTON_UP", "ML_LBUTTON_DOWN", "ML_LBUTTON_UP",
];

// Las teclas del visor -> bits del protocolo. `sit` no es una tecla.
export function controlFlags(on = {}) {
  let f = 0;
  if (on.forward) f |= CONTROL.AT_POS;
  if (on.back) f |= CONTROL.AT_NEG;
  if (on.left) f |= CONTROL.LEFT_POS;
  if (on.right) f |= CONTROL.LEFT_NEG;
  if (on.up) f |= CONTROL.UP_POS;
  if (on.down) f |= CONTROL.UP_NEG;
  if (on.pitchUp) f |= CONTROL.PITCH_POS;
  if (on.pitchDown) f |= CONTROL.PITCH_NEG;
  if (on.yawLeft) f |= CONTROL.YAW_POS;
  if (on.yawRight) f |= CONTROL.YAW_NEG;
  if (on.run) f |= CONTROL.FAST_AT | CONTROL.FAST_LEFT | CONTROL.FAST_UP;
  if (on.fly) f |= CONTROL.FLY;
  if (on.stop) f |= CONTROL.STOP;
  if (on.standUp) f |= CONTROL.STAND_UP;
  if (on.sitOnGround) f |= CONTROL.SIT_ON_GROUND;
  if (on.mouselook) f |= CONTROL.MOUSELOOK;
  if (on.turnLeft) f |= CONTROL.TURN_LEFT;
  if (on.turnRight) f |= CONTROL.TURN_RIGHT;
  return f >>> 0;
}

export function controlNames(flags) {
  const out = [];
  for (let i = 0; i < 32; i++) if (flags & (1 << i)) out.push(CONTROL_NAME[i]);
  return out;
}

// `ChatFromSimulator.ChatType` / `ChatFromViewer.Type`.
export const CHAT_TYPE = {
  WHISPER: 0,
  NORMAL: 1,
  SHOUT: 2,
  START_TYPING: 3,
  STOP_TYPING: 4,
  DEBUG: 5,
  REGION: 6,
  OWNER: 7,
  BROADCAST: 8,
  DIRECT: 9,
};
export const CHAT_TYPE_NAME = [
  "susurro", "normal", "grito", "escribiendo", "dejo-de-escribir",
  "depuracion", "region", "propietario", "anuncio", "directo",
];

// El tipo de SL -> el tipo de la trama de relé (`CHAT_KIND` de relay.js).
// 0 say, 1 whisper, 2 shout, 3 region.
export function chatKindFromType(chatType) {
  if (chatType === CHAT_TYPE.WHISPER) return 1;
  if (chatType === CHAT_TYPE.SHOUT) return 2;
  if (chatType === CHAT_TYPE.REGION || chatType === CHAT_TYPE.OWNER ||
      chatType === CHAT_TYPE.BROADCAST || chatType === CHAT_TYPE.DEBUG ||
      chatType === CHAT_TYPE.DIRECT) return 3;
  return 0;
}

export function chatTypeFromKind(kind) {
  if (kind === 1) return CHAT_TYPE.WHISPER;
  if (kind === 2) return CHAT_TYPE.SHOUT;
  if (kind === 3) return CHAT_TYPE.REGION;
  return CHAT_TYPE.NORMAL;
}

// `ChatFromSimulator.SourceType`: quien habla.
export const CHAT_SOURCE = { SYSTEM: 0, AGENT: 1, OBJECT: 2 };
export const CHAT_AUDIBLE = { NOT: 0, YES: 1 };

// Dialogos de `ImprovedInstantMessage` (los que importan para un visor).
export const DIALOG = {
  MESSAGEBOX: 0,
  GROUP_INVITATION: 1,
  IM: 2,
  FRIENDSHIP_OFFERED: 38,
  FRIENDSHIP_ACCEPTED: 39,
  TASK_INVENTORY_OFFERED: 4,
  TASK_INVENTORY_ACCEPTED: 5,
  TASK_INVENTORY_DECLINED: 6,
  TASK_INVENTORY_RETURNED: 7,
  TEXTBOX: 21,
  FROM_TASK: 22,
  CONFIRM_LAND_SALE: 23,
};

// `TeleportProgress` / `TeleportStart` / `TeleportFinish`. Indice de bit -> nombre.
export const TELEPORT_FLAG = {
  SET_HOME: 0, SET_LAST: 1, VIA_LURE: 2, VIA_LANDMARK: 3, VIA_LOCATION: 4,
  VIA_HOME: 5, VIA_TELEHUB: 6, VIA_LOGIN: 7, VIA_GODLIKE_LURE: 8, GODLIKE: 9,
  TELEPORT_911: 10, DISABLE_CANCEL: 11, VIA_REGION_ID: 12, IS_FLYING: 13,
  SHOW_RESET_HOME: 14, FORCE_REDIRECT: 15, VIA_GLOBAL_COORDS: 16, WITHIN_REGION: 17,
};
export const TELEPORT_FLAG_NAME = [
  "desde-casa", "a-ultima-posicion", "por-invitacion", "por-marca", "por-coordenadas",
  "a-casa", "telehub", "por-login", "invitacion-divina", "divino",
  "emergencia", "sin-cancelar", "por-uuid-de-region", "volando",
  "ofrecer-fijar-casa", "redireccion-forzada", "coordenadas-globales", "dentro-de-la-region",
];
export function teleportFlagNames(v) {
  const out = [];
  for (let i = 0; i < 32; i++) if (v & (1 << i)) out.push(TELEPORT_FLAG_NAME[i] || ("bit" + i));
  return out;
}

// `ParcelPropertiesRequest`/`ParcelProperties.ParcelFlags` (`llparcelflags.h`).
export const PARCEL_FLAG = {
  ALLOW_FLY: 1 << 0, ALLOW_OTHER_SCRIPTS: 1 << 1, FOR_SALE: 1 << 2,
  ALLOW_LANDMARK: 1 << 3, ALLOW_TERRAFORM: 1 << 4, ALLOW_DAMAGE: 1 << 5,
  CREATE_OBJECTS: 1 << 6, FOR_SALE_OBJECTS: 1 << 7, USE_ACCESS_GROUP: 1 << 8,
  USE_ACCESS_LIST: 1 << 9, USE_BAN_LIST: 1 << 10, USE_PASS_LIST: 1 << 11,
  SHOW_DIRECTORY: 1 << 12, ALLOW_DEED_TO_GROUP: 1 << 13, CONTRIBUTE_WITH_DEED: 1 << 14,
  SOUND_LOCAL: 1 << 15, SELL_PARCEL_OBJECTS: 1 << 16, ALLOW_PUBLISH: 1 << 17,
  MATURE_PUBLISH: 1 << 18, URL_WEB_PAGE: 1 << 19, URL_RAW_HTML: 1 << 20,
  RESTRICT_PUSHOBJECT: 1 << 21, DENY_ANONYMOUS: 1 << 22,
  ALLOW_GROUP_SCRIPTS: 1 << 25, CREATE_GROUP_OBJECTS: 1 << 26,
  ALLOW_ALL_OBJECT_ENTRY: 1 << 27, ALLOW_GROUP_OBJECT_ENTRY: 1 << 28,
  ALLOW_VOICE_CHAT: 1 << 29, USE_ESTATE_VOICE_CHAN: 1 << 30, DENY_AGEUNVERIFIED: 1 << 31,
};
export const PARCEL_FLAG_NAME = [
  "volar", "scripts-de-otros", "en-venta", "marcas", "terraformar", "dano",
  "crear-objetos", "vender-objetos", "grupo-de-acceso", "lista-de-acceso", "lista-de-prohibidos",
  "lista-de-permitidos", "mostrar-en-directorio", "ceder-a-grupo", "contribuir-al-ceder",
  "sonido-local", "vender-objetos-de-la-parcela", "publicar", "publicar-adulto",
  "pagina-web", "html-crudo", "restringir-objetos-empujados", "prohibir-anonimos",
  "", "", "scripts-de-grupo", "crear-objetos-de-grupo",
  "entrada-de-cualquiera", "entrada-del-grupo", "voz", "voz-del-estate", "prohibir-sin-edad",
];
export function parcelFlagNames(flags) {
  const out = [];
  for (let i = 0; i < 32; i++) if (flags & (1 << i)) out.push(PARCEL_FLAG_NAME[i] || ("bit" + i));
  return out;
}

// `RegionHandshake.SimAccess` / `RegionInfo.SimAccess`: los 7 bits bajos son la
// madurez (`SIM_ACCESS_PG` = 13, `SIM_ACCESS_MATURE` = 21) y los altos son
// avisos del estado de la region (`llregionflags.h`).
export const SIM_ACCESS = {
  PG: 13, MATURE: 21, DOWN: 1 << 7, RESTRICTED: 1 << 8,
};
export const SIM_ACCESS_NAME = { 13: "PG", 21: "Moderada" };
export function simAccessText(v) {
  const base = v & 0x7f;
  let t = SIM_ACCESS_NAME[base] || ("acceso " + base);
  if (v & SIM_ACCESS.RESTRICTED) t += " · restringida";
  if (v & SIM_ACCESS.DOWN) t += " · caida";
  return t;
}

// Bits de `RegionHandshake.RegionFlags` / `RegionInfo.RegionFlags`
// (`llregionflags.h`, valores exactos). Ojo: hay huecos (10, 11, 24, 25 no se
// usan) y el bit 19 esta INVERTIDO (es `BLOCK_FLY`, no `ALLOW_FLY`), que es una
// fuente clasica de confusion al leer regiones.
export const REGION_FLAGS = {
  ALLOW_DAMAGE: 1 << 0,
  ALLOW_LANDMARK: 1 << 1,
  ALLOW_SET_HOME: 1 << 2,
  RESET_HOME_ON_TELEPORT: 1 << 3,
  SUN_FIXED: 1 << 4,
  ALLOW_ACCESS_OVERRIDE: 1 << 5,
  BLOCK_TERRAFORM: 1 << 6,
  BLOCK_LAND_RESELL: 1 << 7,
  SANDBOX: 1 << 8,
  ALLOW_ENVIRONMENT_OVERRIDE: 1 << 9,
  SKIP_COLLISIONS: 1 << 12,
  SKIP_SCRIPTS: 1 << 13,
  SKIP_PHYSICS: 1 << 14,
  EXTERNALLY_VISIBLE: 1 << 15,
  ALLOW_RETURN_ENCROACHING_OBJECT: 1 << 16,
  ALLOW_RETURN_ENCROACHING_ESTATE_OBJECT: 1 << 17,
  BLOCK_DWELL: 1 << 18,
  BLOCK_FLY: 1 << 19,
  ALLOW_DIRECT_TELEPORT: 1 << 20,
  ESTATE_SKIP_SCRIPTS: 1 << 21,
  RESTRICT_PUSHOBJECT: 1 << 22,
  DENY_ANONYMOUS: 1 << 23,
  ALLOW_PARCEL_CHANGES: 1 << 26,
  BLOCK_FLYOVER: 1 << 27,
  ALLOW_VOICE: 1 << 28,
  BLOCK_PARCEL_SEARCH: 1 << 29,
  DENY_AGEUNVERIFIED: 1 << 30,
  DENY_BOTS: 1 << 31,
};
export const REGION_FLAG_NAME = [
  "permite-dano", "permite-marcas", "permite-fijar-casa", "reinicia-casa-al-irte",
  "sol-fijo", "anula-el-acceso-privado", "bloquea-terraformar", "bloquea-vender-terreno",
  "arenal", "permite-anular-el-entorno", "", "", "ignora-colisiones", "ignora-scripts",
  "ignora-fisica", "visible-desde-fuera", "permite-devolver-invasores",
  "permite-devolver-invasores-del-estate", "bloquea-dwell", "bloquea-volar",
  "permite-teletransporte-directo", "ignora-scripts-del-estate", "restringe-empujar-objetos",
  "prohibe-anonimos", "", "", "permite-cambios-de-parcela", "bloquea-sobrevolar",
  "permite-voz", "bloquea-buscar-parcelas", "prohibe-sin-edad", "prohibe-bots",
];
export function regionFlagNames(flags) {
  const out = [];
  for (let i = 0; i < 32; i++) if (flags & (1 << i)) out.push(REGION_FLAG_NAME[i] || ("bit" + i));
  return out;
}

// Tipos de prenda (`LLWearableType::EType`). El byte viaja en
// `AgentWearablesUpdate.WearableData.WearableType` y en
// `AgentIsNowWearing.WearableData.WearableType`.
export const WEARABLE_TYPE = {
  SHAPE: 0, SKIN: 1, HAIR: 2, EYES: 3, SHIRT: 4, PANTS: 5, SHOES: 6, SOCKS: 7,
  JACKET: 8, GLOVES: 9, UNDERSHIRT: 10, UNDERPANTS: 11, SKIRT: 12, ALPHA: 13,
  TATTOO: 14, PHYSICS: 15, UNIVERSAL: 16,
};
export const WEARABLE_TYPE_NAME = [
  "cuerpo", "piel", "pelo", "ojos", "camisa", "pantalon", "zapatos", "calcetines",
  "chaqueta", "guantes", "camiseta", "calzoncillos", "falda", "alfa", "tatuaje",
  "fisica", "universal",
];

// Los 41 contadores de `SimStats.Stat` (`llviewerstats.h`, orden de `LLViewerStats`).
export const STAT_ID = {
  TIMEDILATION: 0, FPS: 1, PHYSFPS: 2, AGENTUPS: 3, FRAMEMS: 4, NETMS: 5,
  SIMOTHERMS: 6, SIMPHYSICSMS: 7, AGENTMS: 8, IMAGESMS: 9, SCRIPTMS: 10,
  NUMTASKS: 11, NUMTASKSACTIVE: 12, NUMAGENTMAIN: 13, NUMAGENTCHILD: 14,
  NUMSCRIPTSACTIVE: 15, LSLIPS: 16, INPPS: 17, OUTPPS: 18, PENDINGDOWNLOADS: 19,
  PENDINGUPLOADS: 20, VIRTUALSIZEKB: 21, RESIDENTSIZEKB: 22, PENDINGLOCALUPLOADS: 23,
  TOTALUNACKEDBYTES: 24, PHYSICSPINNEDTASKS: 25, PHYSICSLODTASKS: 26,
  SIMPHYSICSSTEPMS: 27, SIMPHYSICSSHAPEMS: 28, SIMPHYSICSOTHERMS: 29,
  SIMPHYSICSMEMORY: 30, SCRIPTPES: 31, SIMSPARETIME: 32, SIMSLEEPTIME: 33,
  IOPUMPTIME: 34, PCTSCRIPTSRUN: 35, REGIONIDLE: 36, REGIONIDLEPOSSIBLE: 37,
  SIMAISTEPTIMEMS: 38, SKIPPEDAISILSTEPSPS: 39, PCTSTEPPEDCHARACTERS: 40,
};
export const STAT_NAME = [
  "dilatacion-de-tiempo", "fps", "fps-fisica", "ups-del-agente", "ms-de-fotograma",
  "ms-de-red", "ms-otros-del-sim", "ms-de-fisica-del-sim", "ms-del-agente", "ms-de-imagenes",
  "ms-de-scripts", "tareas", "tareas-activas", "agentes-principales", "agentes-hijos",
  "scripts-activos", "ips-de-lsl", "paquetes-entrada/s", "paquetes-salida/s",
  "descargas-pendientes", "subidas-pendientes", "tamano-virtual-kb", "tamano-residente-kb",
  "subidas-locales-pendientes", "bytes-sin-confirmar", "tareas-fijadas-a-fisica",
  "tareas-lod-fisica", "ms-de-paso-fisico", "ms-de-forma-fisica", "ms-de-otros-fisico",
  "memoria-fisica", "eventos-de-script/s", "tiempo-libre-del-sim", "tiempo-dormido-del-sim",
  "ms-de-bomba-de-e/s", "porcentaje-de-scripts", "region-inactiva", "inactividad-posible",
  "ms-de-paso-de-ia", "pasos-de-ia-omitidos/s", "porcentaje-de-personajes",
];

// PCode (tipo de objeto del mundo).
export const PCODE = { PRIMITIVE: 9, AVATAR: 47, GRASS: 95, TREE: 111, PARTICLE_SYSTEM: 143, NEW_TREE: 255 };
export const PCODE_NAME = { 9: "primitiva", 47: "avatar", 95: "hierba", 111: "arbol", 143: "particulas", 255: "arbol-nuevo" };

// Indices de textura del avatar (`ETextureIndex` de
// `llavatarappearancedefines.cpp`, en el orden en que se declaran). El
// TextureEntry de un `AvatarAppearance` trae 45 caras, una por indice: las 34
// primeras son las texturas de las prendas, y las 11 ultimas (34..44) son los
// BAKES, que es donde el simulador publica las texturas compuestas del avatar.
export const TE_INDEX = [
  "head_bodypaint", "upper_shirt", "lower_pants", "eyes_iris", "hair",
  "upper_bodypaint", "lower_bodypaint", "lower_shoes", "lower_socks",
  "upper_jacket", "lower_jacket", "upper_gloves", "upper_undershirt",
  "lower_underpants", "skirt", "lower_alpha", "upper_alpha", "head_alpha",
  "eyes_alpha", "hair_alpha", "head_tattoo", "upper_tattoo", "lower_tattoo",
  "head_universal_tattoo", "upper_universal_tattoo", "lower_universal_tattoo",
  "skirt_tattoo", "hair_tattoo", "eyes_tattoo", "leftarm_tattoo", "leftleg_tattoo",
  "aux1_tattoo", "aux2_tattoo", "aux3_tattoo",
  "head-baked", "upper-baked", "lower-baked", "eyes-baked", "hair-baked",
  "skirt-baked", "leftarm-baked", "leftleg-baked", "aux1-baked", "aux2-baked", "aux3-baked",
];
export const TE_COUNT = TE_INDEX.length;

// Nombre de ranura de bake (`BAKE_SLOT_KEYS` de src/avatarParams.js) -> cara del
// TextureEntry del avatar. Es la traduccion entre el protocolo y el visor.
export const BAKE_FACE = {
  head: 34, upper: 35, lower: 36, eyes: 37, hair: 38, skirt: 39,
  leftarm: 40, leftleg: 41, aux1: 42, aux2: 43, aux3: 44,
};

// Valor que el simulador pone en TODAS las caras de un avatar que no tienen
// textura propia. Esta observado en la captura real
// `AvatarAppearanceMessageZL`: con 45 caras, la mayoria valen esto, y solo unas
// pocas llevan el UUID nulo o el alfa por defecto. Al leer los bakes hay que
// tratar este valor como "aqui no hay bake" para no pintar el avatar con un
// asset equivocado.
export const TE_AVATAR_POR_DEFECTO = "3a367d1c-bef1-6d43-7595-e88c1e3aadb3";

// Lee los bakes del TextureEntry de un avatar. Devuelve el mapa
// `{head, upper, lower, ...}` -> uuid, con null donde no hay uno de verdad.
//
// `raw` es lo que devuelve `readTextureEntryRaw(te, TE_COUNT)`. Ojo: hay que
// pasarle 45 caras; con menos, las excepciones de las caras altas (los bakes)
// se pierden y el parser devuelve el valor por defecto en todas.
export function bakesFromTE(raw) {
  const out = {};
  for (const slot of Object.keys(BAKE_FACE)) {
    const i = BAKE_FACE[slot];
    const b = raw && raw.image ? raw.image[i] : null;
    out[slot] = null;
    if (!b || b.length !== 16) continue;
    const u = uuidFromBytes(Uint8Array.from(b), 0);
    if (u === NULL_UUID || u === TE_AVATAR_POR_DEFECTO) continue;
    out[slot] = u;
  }
  return out;
}

// Igual que `bakesFromTE` pero con la lista completa de caras, por si hace falta
// depurar una textura concreta de prenda.
export function avatarFacesFromTE(raw) {
  const out = {};
  for (let i = 0; i < TE_INDEX.length; i++) {
    const b = raw && raw.image ? raw.image[i] : null;
    if (!b || b.length !== 16) { out[TE_INDEX[i]] = null; continue; }
    const u = uuidFromBytes(Uint8Array.from(b), 0);
    out[TE_INDEX[i]] = (u === NULL_UUID || u === TE_AVATAR_POR_DEFECTO) ? null : u;
  }
  return out;
}

// `VisualParam[]` de `AvatarAppearance` -> valores con nombre.
//
// En el cable viajan 253 bytes, uno por parametro, en el mismo orden en que los
// declara `avatar_lad.xml` filtrado a los grupos 0 (TWEAKABLE) y 3
// (TRANSMIT_NOT_TWEAKABLE). Cada byte es una posicion dentro de [min,max] de ESE
// parametro, no un valor absoluto: hay que hacer el recorrido con la tabla del
// esqueleto, que es lo que hace esta funcion si le pasas `lad`.
export function visualParamsToValues(bytes, lad) {
  const out = [];
  const order = lad && lad.order ? lad.order : null;
  const recs = lad && lad.byId ? lad.byId : null;
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i];
    const id = order && i < order.length ? order[i] : null;
    const rec = recs && id !== null ? recs[id] : null;
    if (!rec) { out.push({ id, weight: v, value: v / 255 }); continue; }
    const min = rec.min === undefined ? 0 : rec.min;
    const max = rec.max === undefined ? 1 : rec.max;
    out.push({ id, weight: v, value: min + (v / 255) * (max - min) });
  }
  return out;
}

// Vuelta atras: valores fisicos -> bytes del cable (para `AgentSetAppearance`).
export function valuesToVisualParams(values, lad) {
  const order = lad && lad.order ? lad.order : null;
  const recs = lad && lad.byId ? lad.byId : null;
  const out = [];
  for (const v of values) {
    const rec = recs && recs[v.id] ? recs[v.id] : null;
    if (rec) {
      const min = rec.min === undefined ? 0 : rec.min;
      const max = rec.max === undefined ? 1 : rec.max;
      const w = max === min ? 0 : (v.value - min) / (max - min);
      out.push(clamp255(Math.round(w * 255)));
    } else {
      out.push(clamp255(Math.round((v.weight === undefined ? v.value : v.weight) * 255)));
    }
  }
  // El orden del cable es el de la tabla, no el de la llamada.
  if (order) {
    const map = new Map();
    for (let i = 0; i < values.length; i++) map.set(values[i].id, out[i]);
    return order.map((id) => (map.has(id) ? map.get(id) : 0));
  }
  return out;
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// ===========================================================================
// 2. MENSAJES QUE MANDA EL VISOR
// ===========================================================================
//
// Cada constructor devuelve los argumentos que espera `circuit.send()`. Solo se
// marca `reliable` lo que el visor de Linden Lab manda fiable; lo que va a 10 Hz
// (AgentUpdate) NO es fiable a proposito: perder uno da igual, el siguiente
// corrige la posicion.

function uuidOrNull(u) { return u || NULL_UUID; }

// Low 3. Lo primero que se manda: presenta el circuito. El simulador lo usa para
// saber quien eres antes de aceptar nada mas.
export function useCircuitCode(o) {
  return {
    name: "UseCircuitCode", reliable: true,
    blocks: { CircuitCode: [{ Code: o.circuitCode || 0, SessionID: o.sessionId, ID: o.agentId }] },
  };
}

// Low 149. Respuesta al RegionHandshake. `Flags` bit 0 = "acepto el terreno tal
// cual". El visor manda 0.
export function regionHandshakeReply(o) {
  return {
    name: "RegionHandshakeReply", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      RegionInfo: [{ Flags: o.flags || 0 }],
    },
  };
}

// Low 249. Con esto el simulador te mete en la region y empieza a mandar
// AgentMovementComplete y los objetos.
export function completeAgentMovement(o) {
  return {
    name: "CompleteAgentMovement", reliable: true,
    blocks: { AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, CircuitCode: o.circuitCode || 0 }] },
  };
}

// High 4. El latido del agente: posicion, camara, estado y teclas. El simulador
// espera uno cada ~100 ms; si dejan de llegar, te expulsa por inactividad.
//
// `o.camera` lleva los cuatro vectores de la camara ya calculados
// ({center, at, left, up}); el visor los manda en coordenadas del mundo.
export function agentUpdate(o) {
  const cam = o.camera || {};
  return {
    name: "AgentUpdate", reliable: false,
    blocks: {
      AgentData: [{
        AgentID: o.agentId,
        SessionID: o.sessionId,
        BodyRotation: quat3(o.bodyRotation),
        HeadRotation: quat3(o.headRotation === undefined ? o.bodyRotation : o.headRotation),
        State: o.state || 0,
        CameraCenter: vec3(cam.center),
        CameraAtAxis: vec3(cam.at, [1, 0, 0]),
        CameraLeftAxis: vec3(cam.left, [0, 0, 1]),
        CameraUpAxis: vec3(cam.up, [0, 1, 0]),
        Far: cam.far === undefined ? 128 : cam.far,
        ControlFlags: (o.controlFlags || 0) >>> 0,
        Flags: o.flags || 0,
      }],
    },
  };
}

// Low 80. Chat del usuario. `Type` es CHAT_TYPE; `Channel` 0 es el canal publico
// y los negativos son los de los scripts.
export function chatFromViewer(o) {
  return {
    name: "ChatFromViewer", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      ChatData: [{ Message: String(o.message === undefined ? "" : o.message), Type: o.type === undefined ? CHAT_TYPE.NORMAL : o.type, Channel: o.channel || 0 }],
    },
  };
}

// Low 252. Cierre ordenado: guarda la posicion y la apariencia.
export function logoutRequest(o) {
  return {
    name: "LogoutRequest", reliable: true,
    blocks: { AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }] },
  };
}

// Medium 3. Pide los objetos que el simulador solo ha anunciado con
// `ObjectUpdateCached` (los que cree que ya tienes en cache).
export function requestMultipleObjects(o) {
  const reqs = (o.ids || []).map((id) => ({ CacheMissType: o.cacheMissType || 0, ID: id }));
  return {
    name: "RequestMultipleObjects", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      ObjectData: reqs,
    },
  };
}

// Low 110 / 111. Seleccionar y soltar. El simulador solo manda las propiedades
// (nombre, descripcion, permisos) de lo que tienes seleccionado.
export function objectSelect(o) {
  return {
    name: "ObjectSelect", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      ObjectData: (o.localIds || []).map((id) => ({ ObjectLocalID: id })),
    },
  };
}
export function objectDeselect(o) {
  return {
    name: "ObjectDeselect", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      ObjectData: (o.localIds || []).map((id) => ({ ObjectLocalID: id })),
    },
  };
}

// Low 117 / 119. Agarrar y soltar un objeto. Es la primera mitad de "tocar".
export function objectGrab(o) {
  return {
    name: "ObjectGrab", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      ObjectData: [{ LocalID: o.localId || 0, GrabOffset: vec3(o.offset) }],
      SurfaceInfo: [],
    },
  };
}
export function objectDeGrab(o) {
  return {
    name: "ObjectDeGrab", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      ObjectData: [{ LocalID: o.localId || 0 }],
      SurfaceInfo: [],
    },
  };
}

// Low 63. Teletransporte por coordenadas dentro del mundo conocido.
export function teleportLocationRequest(o) {
  return {
    name: "TeleportLocationRequest", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      Info: [{ RegionHandle: o.regionHandle || 0, Position: vec3(o.position), LookAt: vec3(o.lookAt, [1, 0, 0]) }],
    },
  };
}

// Los canales de `AgentThrottle`, en el orden del cable. Son bytes por segundo.
export const THROTTLE_CHANNELS = ["resend", "land", "wind", "cloud", "task", "texture", "asset"];

// Perfiles de ancho de banda del visor (kbps de la interfaz -> bytes/s).
export const THROTTLE_PRESETS = {
  50: [5, 10, 3, 3, 10, 10, 9],
  300: [30, 40, 9, 9, 86, 86, 40],
  500: [50, 70, 14, 14, 136, 136, 80],
  1000: [100, 100, 20, 20, 310, 310, 140],
};

export function throttleBytes(preset) {
  const kb = THROTTLE_PRESETS[preset] || THROTTLE_PRESETS[500];
  return kb.map((k) => k * 1024);
}

// Low 81. Ancho de banda por canal. El simulador lo necesita para no saturar;
// sin el usa un perfil por defecto mas bien tacaño.
export function agentThrottle(o) {
  const vals = o.bytesPerSecond || throttleBytes(o.preset || 500);
  const b = new Uint8Array(28);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < 7; i++) dv.setFloat32(i * 4, vals[i] || 0, true);
  return {
    name: "AgentThrottle", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, CircuitCode: o.circuitCode || 0 }],
      Throttle: [{ GenCounter: o.genCounter || 0, Throttles: b }],
    },
  };
}

// Low 141. Pide el bloque RegionInfo (parcela, agua, version del simulador).
export function requestRegionInfo(o) {
  return {
    name: "RequestRegionInfo", reliable: true,
    blocks: { AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }] },
  };
}

// Medium 11. Pide las propiedades de la parcela. El rectangulo va en metros; el
// visor suele pedir la parcela entera (-1..257) para recibir la que pisa.
export function parcelPropertiesRequest(o) {
  return {
    name: "ParcelPropertiesRequest", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      ParcelData: [{
        SequenceID: o.sequenceId || 0,
        West: o.west === undefined ? -1 : o.west,
        South: o.south === undefined ? -1 : o.south,
        East: o.east === undefined ? 257 : o.east,
        North: o.north === undefined ? 257 : o.north,
        SnapSelection: !!o.snap,
      }],
    },
  };
}

// Low 54. Propiedades de una parcela por su UUID (el que sale en el mapa).
export function parcelInfoRequest(o) {
  return {
    name: "ParcelInfoRequest", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      Data: [{ ParcelID: uuidOrNull(o.parcelId) }],
    },
  };
}

// Low 88. Correr siempre (el simulador lo usa para el control del avatar).
export function setAlwaysRun(o) {
  return {
    name: "SetAlwaysRun", reliable: true,
    blocks: { AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, AlwaysRun: !!o.alwaysRun }] },
  };
}

// High 5. Arrancar o parar animaciones.
export function agentAnimation(o) {
  return {
    name: "AgentAnimation", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      AnimationList: (o.animations || []).map((a) => ({ AnimID: uuidOrNull(a.id || a.animId), StartAnim: !!a.start })),
      PhysicalAvatarEventList: [],
    },
  };
}

// Low 254. Mensaje instantaneo / chat de grupo. `Dialog` dice de que va; el
// visor usa 2 (IM) para hablar con alguien y 25 (FROM_TASK) para lo que manda un
// prim. `binaryBucket` lleva la sesion de chat de grupo (0/1 + uuid).
export function improvedInstantMessage(o) {
  const blocks = {
    AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
    MessageBlock: [{
      FromGroup: !!o.fromGroup,
      ToAgentID: uuidOrNull(o.toAgentId),
      ParentEstateID: o.parentEstateId || 0,
      RegionID: uuidOrNull(o.regionId),
      Position: vec3(o.position),
      Offline: o.offline || 0,
      Dialog: o.dialog === undefined ? DIALOG.IM : o.dialog,
      ID: uuidOrNull(o.id),
      Timestamp: o.timestamp || 0,
      FromAgentName: String(o.fromName === undefined ? "" : o.fromName),
      Message: String(o.message === undefined ? "" : o.message),
      BinaryBucket: o.binaryBucket instanceof Uint8Array ? o.binaryBucket : new Uint8Array(0),
    }],
  };
  if (o.estateId !== undefined) blocks.EstateBlock = [{ EstateID: o.estateId }];
  return { name: "ImprovedInstantMessage", reliable: true, blocks };
}

// Low 386. Pide el `AgentDataUpdate` (nombre, grupo activo, poderes).
export function agentDataUpdateRequest(o) {
  return {
    name: "AgentDataUpdateRequest", reliable: true,
    blocks: { AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }] },
  };
}

// Low 235. Traduce UUIDs a nombres. Es la unica via para saber quien es quien
// cuando solo tienes el UUID de un objeto o de un residente.
export function uuidNameRequest(ids) {
  return {
    name: "UUIDNameRequest", reliable: true,
    blocks: { UUIDNameBlock: (ids || []).map((ID) => ({ ID: uuidOrNull(ID) })) },
  };
}

// Medium 5. Nombre, descripcion, propietario y permisos de un objeto.
export function requestObjectPropertiesFamily(o) {
  return {
    name: "RequestObjectPropertiesFamily", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      ObjectData: [{ RequestFlags: o.flags || 0, ObjectID: uuidOrNull(o.objectId) }],
    },
  };
}

// Low 313. Saldo de L$.
export function moneyBalanceRequest(o) {
  return {
    name: "MoneyBalanceRequest", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      MoneyData: [{ TransactionID: uuidOrNull(o.transactionId) }],
    },
  };
}

// Low 381. Pide la lista de prendas puestas.
export function agentWearablesRequest(o) {
  return {
    name: "AgentWearablesRequest", reliable: true,
    blocks: { AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }] },
  };
}

// Low 383. Cambiar de ropa sin subir la apariencia entera.
export function agentIsNowWearing(o) {
  return {
    name: "AgentIsNowWearing", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      WearableData: (o.wearables || []).map((w) => ({ ItemID: uuidOrNull(w.itemId), WearableType: w.type || 0 })),
    },
  };
}

// Low 384. Avisa de las texturas (bakes) que ya tenemos subidas a la CDN; el
// simulador contesta con `AgentCachedTextureResponse` y asi todos los visores
// comparten bakes en vez de subir cada uno los suyos.
export function agentCachedTexture(o) {
  return {
    name: "AgentCachedTexture", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, SerialNum: o.serialNum || 0 }],
      WearableData: (o.bakes || []).map((b) => ({ ID: uuidOrNull(b.cacheId || b.id), TextureIndex: b.index === undefined ? b.textureIndex : b.index })),
    },
  };
}

// Low 84. Sube la apariencia completa (los bytes de los 253 parametros + el
// TextureEntry con los bakes). Es el mensaje que hace que los demas te vean
// como te ves.
export function agentSetAppearance(o) {
  const params = o.visualParams || [];
  return {
    name: "AgentSetAppearance", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, SerialNum: o.serialNum || 0, Size: vec3(o.size, [0.45, 1.8, 0.3]) }],
      WearableData: (o.wearables || []).map((w) => ({ CacheID: uuidOrNull(w.cacheId), TextureIndex: w.index === undefined ? w.textureIndex : w.index })),
      ObjectData: [{ TextureEntry: o.textureEntry instanceof Uint8Array ? o.textureEntry : new Uint8Array(0) }],
      VisualParam: params.map((v) => ({ ParamValue: v & 0xff })),
    },
  };
}

// Low 313 -> el visor tambien manda `AvatarPropertiesRequest` para llenar la
// ficha de un residente.
export function avatarPropertiesRequest(o) {
  return {
    name: "AvatarPropertiesRequest", reliable: true,
    blocks: { AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, AvatarID: uuidOrNull(o.avatarId) }] },
  };
}

// Low 82 / 83. Ajustes de camara y tamano de la ventana. El simulador los usa
// para decidir que objetos te manda.
export function agentFOV(o) {
  return {
    name: "AgentFOV", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, CircuitCode: o.circuitCode || 0 }],
      FOVBlock: [{ GenCounter: o.genCounter || 0, VerticalAngle: o.verticalAngle || 1.0 }],
    },
  };
}
export function agentHeightWidth(o) {
  return {
    name: "AgentHeightWidth", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, CircuitCode: o.circuitCode || 0 }],
      HeightWidthBlock: [{ GenCounter: o.genCounter || 0, Height: o.height || 768, Width: o.width || 1024 }],
    },
  };
}

// Medium 17. Efectos visuales (el rayo de un arma, el brillo de un hechizo).
export function viewerEffect(o) {
  const fx = (o.effects || []).map((e) => ({
    ID: uuidOrNull(e.id), AgentID: uuidOrNull(e.agentId), Type: e.type || 0, Duration: e.duration || 0,
    Color: colorBytes(e.color), TypeData: e.typeData instanceof Uint8Array ? e.typeData : new Uint8Array(0),
  }));
  return {
    name: "ViewerEffect", reliable: false,
    blocks: { AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }], Effect: fx },
  };
}

// Low 261 / 260. El canal de administracion de la region: con `GenericMessage`
// se piden cosas del grupo, y con `EstateOwnerMessage` se gobierna el estate.
export function genericMessage(o) {
  return {
    name: "GenericMessage", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, TransactionID: uuidOrNull(o.transactionId) }],
      MethodData: [{ Method: String(o.method || ""), Invoice: uuidOrNull(o.invoice) }],
      ParamList: (o.params || []).map((p) => ({ Parameter: String(p) })),
    },
  };
}
export function estateOwnerMessage(o) {
  return {
    name: "EstateOwnerMessage", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, TransactionID: uuidOrNull(o.transactionId) }],
      MethodData: [{ Method: String(o.method || ""), Invoice: uuidOrNull(o.invoice) }],
      ParamList: (o.params || []).map((p) => ({ Parameter: String(p) })),
    },
  };
}

// Low 89. Borrar objetos.
export function objectDelete(o) {
  return {
    name: "ObjectDelete", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, Force: !!o.force }],
      ObjectData: (o.localIds || []).map((id) => ({ ObjectLocalID: id })),
    },
  };
}

// Low 91. Duplicar objetos a lo largo de un rayo (el "copiar y pegar" del visor).
export function objectDuplicateOnRay(o) {
  return {
    name: "ObjectDuplicateOnRay", reliable: true,
    blocks: {
      AgentData: [{
        AgentID: o.agentId, SessionID: o.sessionId, GroupID: uuidOrNull(o.groupId),
        RayStart: vec3(o.rayStart), RayEnd: vec3(o.rayEnd),
        BypassRaycast: !!o.bypassRaycast, RayEndIsIntersection: !!o.rayEndIsIntersection,
        CopyCenters: !!o.copyCenters, CopyRotates: !!o.copyRotates,
        RayTargetID: uuidOrNull(o.rayTargetId), DuplicateFlags: o.duplicateFlags || 0,
      }],
      ObjectData: (o.localIds || []).map((id) => ({ ObjectLocalID: id })),
    },
  };
}

// Low 293. Rez del inventario en el mundo. Es como se pone un objeto.
export function rezObject(o) {
  const it = o.item || {};
  return {
    name: "RezObject", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, GroupID: uuidOrNull(o.groupId) }],
      RezData: [{
        FromTaskID: uuidOrNull(o.fromTaskId), BypassRaycast: o.bypassRaycast === undefined ? 1 : o.bypassRaycast,
        RayStart: vec3(o.rayStart), RayEnd: vec3(o.rayEnd), RayTargetID: uuidOrNull(o.rayTargetId),
        RayEndIsIntersection: !!o.rayEndIsIntersection, RezSelected: !!o.rezSelected,
        RemoveItem: !!o.removeItem, ItemFlags: it.flags || 0, GroupMask: it.groupMask || 0,
        EveryoneMask: it.everyoneMask || 0, NextOwnerMask: it.nextOwnerMask || 0,
      }],
      InventoryData: [{
        ItemID: uuidOrNull(it.itemId), FolderID: uuidOrNull(it.folderId), CreatorID: uuidOrNull(it.creatorId),
        OwnerID: uuidOrNull(it.ownerId), GroupID: uuidOrNull(it.groupId),
        BaseMask: it.baseMask || 0, OwnerMask: it.ownerMask || 0, GroupMask: it.groupMask || 0,
        EveryoneMask: it.everyoneMask || 0, NextOwnerMask: it.nextOwnerMask || 0,
        GroupOwned: !!it.groupOwned, TransactionID: uuidOrNull(it.transactionId),
        Type: it.type || 0, InvType: it.invType || 0, Flags: it.flags || 0,
        SaleType: it.saleType || 0, SalePrice: it.salePrice || 0,
        Name: String(it.name || ""), Description: String(it.description || ""),
        CreationDate: it.creationDate || 0, CRC: it.crc || 0,
      }],
    },
  };
}

// Medium 1. Crear una prim (el modo construccion).
export function objectAdd(o) {
  return {
    name: "ObjectAdd", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId, GroupID: uuidOrNull(o.groupId) }],
      ObjectData: [{
        PCode: o.pcode || PCODE.PRIMITIVE, Material: o.material || 3, AddFlags: o.addFlags === undefined ? 1 : o.addFlags,
        PathCurve: o.pathCurve || 16, ProfileCurve: o.profileCurve === undefined ? 1 : o.profileCurve,
        PathBegin: o.pathBegin || 0, PathEnd: o.pathEnd || 0, PathScaleX: o.pathScaleX || 100,
        PathScaleY: o.pathScaleY || 100, PathShearX: o.pathShearX || 0, PathShearY: o.pathShearY || 0,
        PathTwist: o.pathTwist || 0, PathTwistBegin: o.pathTwistBegin || 0, PathRadiusOffset: o.pathRadiusOffset || 0,
        PathTaperX: o.pathTaperX || 0, PathTaperY: o.pathTaperY || 0, PathRevolutions: o.pathRevolutions || 0,
        PathSkew: o.pathSkew || 0, ProfileBegin: o.profileBegin || 0, ProfileEnd: o.profileEnd || 0,
        ProfileHollow: o.profileHollow || 0,
        BypassRaycast: o.bypassRaycast === undefined ? 1 : o.bypassRaycast,
        RayStart: vec3(o.rayStart), RayEnd: vec3(o.rayEnd), RayTargetID: uuidOrNull(o.rayTargetId),
        RayEndIsIntersection: o.rayEndIsIntersection || 0,
        Scale: vec3(o.scale, [0.5, 0.5, 0.5]), Rotation: quat4(o.rotation), State: o.state || 0,
      }],
    },
  };
}

// Low 289. Inventario de un objeto (para leer los scripts de dentro).
export function requestTaskInventory(o) {
  return {
    name: "RequestTaskInventory", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      InventoryData: [{ LocalID: o.localId || 0 }],
    },
  };
}

// High 6 / 7. Sentarse.
export function agentRequestSit(o) {
  return {
    name: "AgentRequestSit", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      TargetObject: [{ TargetID: uuidOrNull(o.targetId), Offset: vec3(o.offset) }],
    },
  };
}
export function agentSit(o) {
  return {
    name: "AgentSit", reliable: true,
    blocks: { AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }] },
  };
}

// Low 198. Cambiar cosas de la parcela (nombre, descripcion, musica, permisos).
export function parcelPropertiesUpdate(o) {
  const p = o.parcel || {};
  return {
    name: "ParcelPropertiesUpdate", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      ParcelData: [{
        LocalID: p.localId || 0, Flags: p.flags || 0, ParcelFlags: p.parcelFlags || 0,
        SalePrice: p.salePrice || 0, Name: String(p.name || ""), Desc: String(p.desc || ""),
        MusicURL: String(p.musicUrl || ""), MediaURL: String(p.mediaUrl || ""),
        MediaID: uuidOrNull(p.mediaId), MediaAutoScale: p.mediaAutoScale || 0,
        GroupID: uuidOrNull(p.groupId), PassPrice: p.passPrice || 0, PassHours: p.passHours || 0,
        Category: p.category || 0, AuthBuyerID: uuidOrNull(p.authBuyerId), SnapshotID: uuidOrNull(p.snapshotId),
        UserLocation: vec3(p.userLocation), UserLookAt: vec3(p.userLookAt, [1, 0, 0]), LandingType: p.landingType || 0,
      }],
    },
  };
}

// Low 124. Terraformar (subir/bajar terreno con la herramienta).
export function modifyLand(o) {
  const blocks = {
    AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
    ModifyBlock: [{
      Action: o.action || 0, BrushSize: o.brushSize || 0,
      Seconds: o.seconds || 0, Height: o.height || 0,
    }],
  };
  if (o.parcels && o.parcels.length) blocks.ParcelData = o.parcels;
  if (o.extended && o.extended.length) blocks.ModifyBlockExtended = o.extended;
  return { name: "ModifyLand", reliable: true, blocks };
}

// Low 132. Responder a la pregunta de un script ("¿permitir?").
export function scriptAnswerYes(o) {
  return {
    name: "ScriptAnswerYes", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      Data: [{ TaskID: uuidOrNull(o.taskId), ItemID: uuidOrNull(o.itemId), Questions: o.questions || 1 }],
    },
  };
}

// Low 324. Fijar la posicion de inicio de la region (solo el propietario).
export function setStartLocationRequest(o) {
  return {
    name: "SetStartLocationRequest", reliable: true,
    blocks: {
      AgentData: [{ AgentID: o.agentId, SessionID: o.sessionId }],
      StartLocationData: [{
        SimName: String(o.simName || ""), LocationID: o.locationId || 0,
        LocationPos: vec3(o.position), LocationLookAt: vec3(o.lookAt, [1, 0, 0]),
      }],
    },
  };
}

// --- ayudantes de vectores ---------------------------------------------------

function vec3(v, porDefecto) {
  const d = porDefecto || [0, 0, 0];
  if (!v) return [d[0], d[1], d[2]];
  if (Array.isArray(v)) return [v[0] || 0, v[1] || 0, v[2] || 0];
  return [v.x || 0, v.y || 0, v.z || 0];
}
function quat3(q) {
  if (!q) return [0, 0, 0];
  if (Array.isArray(q)) return [q[0] || 0, q[1] || 0, q[2] || 0];
  return [q.x || 0, q.y || 0, q.z || 0];
}
export function quat4(q) {
  if (!q) return [0, 0, 0, 1];
  if (Array.isArray(q)) return [q[0] || 0, q[1] || 0, q[2] || 0, q[3] === undefined ? 1 : q[3]];
  return [q.x || 0, q.y || 0, q.z || 0, q.w === undefined ? 1 : q.w];
}
function colorBytes(c) {
  if (c instanceof Uint8Array) return c;
  const a = c || [1, 1, 1, 1];
  return Uint8Array.of((a[0] || 0) * 255, (a[1] || 0) * 255, (a[2] || 0) * 255, (a[3] === undefined ? 255 : a[3] * 255));
}

// ===========================================================================
// 3. MENSAJES QUE LLEGAN DEL SIMULADOR
// ===========================================================================
//
// Todos reciben el objeto `msg` que devuelve `decodePacket` y devuelven datos
// normales (numeros, cadenas, arrays), ya convertidos a unidades del visor. El
// valor de este paso es que el resto del visor no necesita saber nada del cable.

export function readRegionHandshake(msg) {
  const r = msg.first("RegionInfo") || {};
  const r2 = msg.first("RegionInfo2") || {};
  const r3 = msg.first("RegionInfo3") || {};
  const r4 = msg.first("RegionInfo4") || {};
  return {
    name: texto(r.SimName),
    owner: r.SimOwner,
    flags: r.RegionFlags >>> 0,
    access: r.SimAccess,
    isEstateManager: !!r.IsEstateManager,
    waterHeight: r.WaterHeight,
    billableFactor: r.BillableFactor,
    cacheId: r.CacheID,
    terrainBase: [r.TerrainBase0, r.TerrainBase1, r.TerrainBase2, r.TerrainBase3],
    terrainDetail: [r.TerrainDetail0, r.TerrainDetail1, r.TerrainDetail2, r.TerrainDetail3],
    terrainStartHeight: [r.TerrainStartHeight00, r.TerrainStartHeight01, r.TerrainStartHeight10, r.TerrainStartHeight11],
    terrainHeightRange: [r.TerrainHeightRange00, r.TerrainHeightRange01, r.TerrainHeightRange10, r.TerrainHeightRange11],
    regionId: r2.RegionID,
    cpuClassId: r3.CPUClassID,
    cpuRatio: r3.CPURatio,
    coloName: texto(r3.ColoName),
    productSku: texto(r3.ProductSKU),
    productName: texto(r3.ProductName),
    flagsExtended: r4.RegionFlagsExtended === undefined ? null : u64ToNumber(r4.RegionFlagsExtended),
    protocols: r4.RegionProtocols === undefined ? null : u64ToNumber(r4.RegionProtocols),
  };
}

export function readAgentMovementComplete(msg) {
  const a = msg.first("AgentData") || {};
  const d = msg.first("Data") || {};
  const s = msg.first("SimData") || {};
  return {
    agentId: a.AgentID, sessionId: a.SessionID,
    position: d.Position, lookAt: d.LookAt,
    regionHandle: u64ToNumber(d.RegionHandle),
    timestamp: d.Timestamp,
    channelVersion: texto(s.ChannelVersion),
  };
}

export function readAgentDataUpdate(msg) {
  const a = msg.first("AgentData") || {};
  return {
    agentId: a.AgentID,
    firstName: texto(a.FirstName),
    lastName: texto(a.LastName),
    groupTitle: texto(a.GroupTitle),
    activeGroupId: a.ActiveGroupID,
    groupPowers: u64ToNumber(a.GroupPowers),
    groupName: texto(a.GroupName),
  };
}

export function readAgentWearablesUpdate(msg) {
  const a = msg.first("AgentData") || {};
  return {
    agentId: a.AgentID, sessionId: a.SessionID, serialNum: a.SerialNum,
    wearables: msg.list("WearableData").map((w) => ({
      itemId: w.ItemID, assetId: w.AssetID, type: w.WearableType,
      typeName: WEARABLE_TYPE_NAME[w.WearableType] || ("tipo" + w.WearableType),
    })),
  };
}

// `AvatarAppearance`: como es un avatar. Los VisualParam son 253 bytes; los
// bakes van en el TextureEntry, en las caras 34..44 (ver `bakesFromTE`).
export function readAvatarAppearance(msg) {
  const s = msg.first("Sender") || {};
  const od = msg.first("ObjectData") || {};
  const ad = msg.first("AppearanceData") || {};
  const ah = msg.first("AppearanceHover") || {};
  const params = msg.list("VisualParam").map((v) => v.ParamValue);
  const hover = ah.HoverHeight || [0, 0, 0];
  return {
    senderId: s.ID,
    isTrial: !!s.IsTrial,
    visualParams: params,
    appearanceVersion: ad.AppearanceVersion,
    cofVersion: ad.CofVersion,
    flags: ad.Flags,
    // Solo la Z: el simulador manda un LLVector3 pero la altura de flotado es la
    // tercera componente.
    hoverHeight: hover[2] || 0,
    attachments: msg.list("AttachmentBlock").map((a) => ({
      id: a.ID, attachmentPoint: a.AttachmentPoint,
    })),
    textureEntry: od.TextureEntry instanceof Uint8Array ? od.TextureEntry : new Uint8Array(0),
  };
}

export function readAvatarAnimation(msg) {
  const s = msg.first("Sender") || {};
  return {
    senderId: s.ID,
    animations: msg.list("AnimationList").map((a) => ({ id: a.AnimID, sequence: a.AnimSequenceID })),
    sources: msg.list("AnimationSourceList").map((a) => a.ObjectID),
  };
}

export function readChatFromSimulator(msg) {
  const c = msg.first("ChatData") || {};
  return {
    fromName: texto(c.FromName),
    sourceId: c.SourceID,
    ownerId: c.OwnerID,
    sourceType: c.SourceType,
    chatType: c.ChatType,
    chatTypeName: CHAT_TYPE_NAME[c.ChatType] || ("tipo" + c.ChatType),
    audible: c.Audible === 1,
    position: c.Position,
    message: texto(c.Message),
  };
}

export function readImprovedInstantMessage(msg) {
  const a = msg.first("AgentData") || {};
  const m = msg.first("MessageBlock") || {};
  const e = msg.first("EstateBlock") || {};
  return {
    fromAgentId: a.AgentID,
    fromAgentName: texto(m.FromAgentName),
    fromGroup: !!m.FromGroup,
    toAgentId: m.ToAgentID,
    parentEstateId: m.ParentEstateID,
    regionId: m.RegionID,
    position: m.Position,
    offline: m.Offline,
    dialog: m.Dialog,
    id: m.ID,
    timestamp: m.Timestamp,
    message: texto(m.Message),
    binaryBucket: m.BinaryBucket instanceof Uint8Array ? m.BinaryBucket : new Uint8Array(0),
    estateId: e.EstateID,
  };
}

// `SimStats`: los contadores del simulador. Devuelve el mapa id -> valor y,
// aparte, los datos de la region.
export function readSimStats(msg) {
  const r = msg.first("Region") || {};
  const stats = {};
  const byName = {};
  for (const s of msg.list("Stat")) {
    stats[s.StatID] = s.StatValue;
    byName[STAT_NAME[s.StatID] || ("stat" + s.StatID)] = s.StatValue;
  }
  const ri = msg.first("RegionInfo") || {};
  return {
    regionX: r.RegionX, regionY: r.RegionY,
    regionFlags: r.RegionFlags >>> 0, objectCapacity: r.ObjectCapacity,
    stats, byName,
    fps: stats[STAT_ID.FPS] || 0,
    timeDilation: stats[STAT_ID.TIMEDILATION] || 0,
    agents: stats[STAT_ID.NUMAGENTMAIN] || 0,
    scriptsActive: stats[STAT_ID.NUMSCRIPTSACTIVE] || 0,
    objects: stats[STAT_ID.NUMTASKS] || 0,
    pid: (msg.first("PidStat") || {}).PID,
    flagsExtended: ri.RegionFlagsExtended === undefined ? null : u64ToNumber(ri.RegionFlagsExtended),
  };
}

// `CoarseLocationUpdate`: la posicion aproximada de todos los que estan
// alrededor. Viene en pasos de 4 m en Z y de 1 m en X/Y, y las entradas van
// emparejadas por indice con `AgentData` (el UUID).
export function readCoarseLocationUpdate(msg) {
  const idx = msg.first("Index") || {};
  const locs = msg.list("Location");
  const agents = msg.list("AgentData");
  const out = [];
  for (let i = 0; i < agents.length; i++) {
    const l = locs[i];
    if (!l) continue;
    out.push({
      agentId: agents[i].AgentID,
      // X e Y en metros; la Z en cuartos de metro.
      x: l.X, y: l.Y, z: l.Z * 4,
      you: i === idx.You,
    });
  }
  return { agents: out, you: idx.You, prey: idx.Prey };
}

export function readParcelOverlay(msg) {
  const p = msg.first("ParcelData") || {};
  return {
    sequenceId: p.SequenceID,
    data: p.Data instanceof Uint8Array ? p.Data : new Uint8Array(0),
  };
}

export function readMoneyBalanceReply(msg) {
  const m = msg.first("MoneyData") || {};
  const t = msg.first("TransactionInfo") || {};
  return {
    moneyBalance: m.MoneyBalance,
    success: !!m.TransactionSuccess,
    description: texto(m.Description),
    transactionType: t.TransactionType,
    sourceId: t.SourceID,
    destId: t.DestID,
    amount: t.Amount,
    itemDescription: texto(t.ItemDescription),
  };
}

export function readTeleportProgress(msg) {
  const a = msg.first("AgentData") || {};
  const i = msg.first("Info") || {};
  return { agentId: a.AgentID, flags: i.TeleportFlags >>> 0, flagNames: teleportFlagNames(i.TeleportFlags >>> 0), message: texto(i.Message) };
}

export function readTeleportStart(msg) {
  const i = msg.first("Info") || {};
  return { flags: i.TeleportFlags >>> 0, flagNames: teleportFlagNames(i.TeleportFlags >>> 0) };
}

export function readTeleportLocal(msg) {
  const i = msg.first("Info") || {};
  return { agentId: i.AgentID, locationId: i.LocationID, position: i.Position, lookAt: i.LookAt, flags: i.TeleportFlags >>> 0, flagNames: teleportFlagNames(i.TeleportFlags >>> 0) };
}

export function readTeleportFinish(msg) {
  const i = msg.first("Info") || {};
  return {
    agentId: i.AgentID,
    locationId: i.LocationID,
    simIp: i.SimIP, simPort: i.SimPort,
    regionHandle: u64ToNumber(i.RegionHandle),
    seedCapability: texto(i.SeedCapability),
    access: i.SimAccess,
    flags: i.TeleportFlags >>> 0, flagNames: teleportFlagNames(i.TeleportFlags >>> 0),
  };
}

export function readTeleportFailed(msg) {
  const i = msg.first("Info") || {};
  return {
    agentId: i.AgentID,
    reason: texto(i.Reason),
    alerts: msg.list("AlertInfo").map((a) => ({ message: texto(a.Message), extra: texto(a.ExtraParams) })),
  };
}

export function readRegionInfo(msg) {
  const r = msg.first("RegionInfo") || {};
  const r2 = msg.first("RegionInfo2") || {};
  const r3 = msg.first("RegionInfo3") || {};
  return {
    name: texto(r.SimName),
    estateId: r.EstateID, parentEstateId: r.ParentEstateID,
    flags: r.RegionFlags >>> 0,
    access: r.SimAccess, maxAgents: r.MaxAgents,
    billableFactor: r.BillableFactor, objectBonusFactor: r.ObjectBonusFactor,
    waterHeight: r.WaterHeight,
    terrainRaiseLimit: r.TerrainRaiseLimit, terrainLowerLimit: r.TerrainLowerLimit,
    pricePerMeter: r.PricePerMeter,
    redirectGridX: r.RedirectGridX, redirectGridY: r.RedirectGridY,
    useEstateSun: !!r.UseEstateSun, sunHour: r.SunHour,
    productSku: texto(r2.ProductSKU), productName: texto(r2.ProductName),
    maxAgents32: r2.MaxAgents32, hardMaxAgents: r2.HardMaxAgents, hardMaxObjects: r2.HardMaxObjects,
    flagsExtended: r3.RegionFlagsExtended === undefined ? null : u64ToNumber(r3.RegionFlagsExtended),
  };
}

export function readUUIDNameReply(msg) {
  return msg.list("UUIDNameBlock").map((b) => ({
    id: b.ID, firstName: texto(b.FirstName), lastName: texto(b.LastName),
    name: (texto(b.FirstName) + " " + texto(b.LastName)).trim(),
  }));
}

export function readOnlineNotification(msg) {
  return msg.list("AgentBlock").map((b) => b.AgentID);
}

export function readMapItemReply(msg) {
  return {
    itemType: (msg.first("RequestData") || {}).ItemType,
    items: msg.list("Data").map((d) => ({
      x: d.X, y: d.Y, id: d.ID, extra: d.Extra, extra2: d.Extra2, name: texto(d.Name),
    })),
  };
}

export function readObjectPropertiesFamily(msg) {
  const o = msg.first("ObjectData") || {};
  return {
    objectId: o.ObjectID, ownerId: o.OwnerID, groupId: o.GroupID,
    requestFlags: o.RequestFlags, name: texto(o.Name), description: texto(o.Description),
    lastOwnerId: o.LastOwnerID, salePrice: o.SalePrice, saleType: o.SaleType,
    baseMask: o.BaseMask, ownerMask: o.OwnerMask, groupMask: o.GroupMask, everyoneMask: o.EveryoneMask,
    nextOwnerMask: o.NextOwnerMask,
    position: o.Position, ownerName: null,
  };
}

export function readMapBlockReply(msg) {
  return {
    agentFlags: (msg.first("AgentData") || {}).Flags,
    regions: msg.list("Data").map((d) => ({
      x: d.X, y: d.Y, name: texto(d.Name),
      access: d.Access, flags: d.RegionFlags >>> 0,
      waterHeight: d.WaterHeight, agents: d.Agents, mapImageId: d.MapImageID,
    })),
  };
}

export function readLogoutReply(msg) {
  return {
    agentId: (msg.first("AgentData") || {}).AgentID,
    items: msg.list("InventoryData").map((i) => i.ItemID),
  };
}

export function readHealthMessage(msg) {
  return (msg.first("HealthData") || {}).Health;
}

export function readSimulatorViewerTime(msg) {
  const t = msg.first("TimeInfo") || {};
  return {
    usecSinceStart: u64ToNumber(t.UsecSinceStart),
    secPerDay: t.SecPerDay, secPerYear: t.SecPerYear,
    sunDirection: t.SunDirection, sunPhase: t.SunPhase, sunAngVelocity: t.SunAngVelocity,
  };
}

export function readCameraConstraint(msg) {
  return { plane: (msg.first("CameraCollidePlane") || {}).Plane };
}

export function readScriptControlChange(msg) {
  return msg.list("Data").map((d) => ({ takeControls: !!d.TakeControls, controls: d.Controls >>> 0, passToAgent: !!d.PassToAgent }));
}

export function readGroupRoleDataReply(msg) {
  const g = msg.first("GroupData") || {};
  return {
    groupId: g.GroupID, requestId: g.RequestID,
    roles: msg.list("RoleData").map((r) => ({
      roleId: r.RoleID, name: texto(r.Name), title: texto(r.Title), description: texto(r.Description),
      powers: u64ToNumber(r.Powers), members: r.Members,
    })),
  };
}

export function readAvatarPropertiesReply(msg) {
  const a = msg.first("AgentData") || {};
  const p = msg.first("PropertiesData") || {};
  return {
    avatarId: a.AvatarID,
    imageId: p.ImageID, firstLifeImageId: p.FLImageID,
    aboutText: texto(p.AboutText), firstLifeAboutText: texto(p.FLAboutText),
    flags: p.Flags, bornOn: texto(p.BornOn),
  };
}

export function readAlertMessage(msg) {
  const a = msg.first("AlertData") || {};
  return { message: texto(a.Message), extra: texto(a.ExtraParams) };
}

export function readAgentAlertMessage(msg) {
  const d = msg.first("AlertData") || {};
  return { agentId: d.AgentID, alert: !!d.Alert };
}

// ===========================================================================
// 4. AUTOTEST
// ===========================================================================
//
// Se apoya en las capturas reales de `recapturas.js`: cada lector tiene que
// sacar de la captura los valores que el visor de Linden Lab saca. Es la unica
// forma de comprobar el SIGNIFICADO (no solo los bytes) sin un simulador
// delante. Ademas, cada constructor se manda y se vuelve a leer para comprobar
// que la ida y vuelta no pierde nada.

export function runAgentSelfTest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });

  return (async () => {
    const { decodePacket, encodePacket, NULL_UUID: NIL } = await import("./codec.js");
    const { defaultTemplates } = await import("./template.js");
    const caps = await import("./recapturas.js");
    const T = defaultTemplates();
    const cap = (n) => decodePacket(caps.bytesDeRecaptura(n), T);

    // --- lectura de capturas reales ---------------------------------------

    const rh = readRegionHandshake(cap("RegionHandshakeMessageZL"));
    eq("region: nombre", rh.name, "Izanagi");
    eq("region: acceso", rh.access, 21);
    eq("region: texto del acceso", simAccessText(rh.access), "Moderada");
    eq("region: nivel del agua", rh.waterHeight, 20);
    eq("region: uuid", rh.regionId, "1ccf2f34-ecea-40f5-baff-4f0e4f9e5fea");
    eq("region: arranque del terreno 1-0", rh.terrainStartHeight[2], 0);
    eq("region: rango del terreno 0-0", rh.terrainHeightRange[0], 110);
    eq("region: colo", rh.coloName, "Chandler");
    eq("region: producto", rh.productName, "Estate / Full Region");
    eq("region: sku", rh.productSku, "024");
    eq("region: flags extendidos", rh.flagsExtended, 336625846);
    eq("region: protocolos", rh.protocols, 1);
    eq("region: dueño", rh.owner, "d1cd5b71-6209-4595-9bf0-771bf689ce00");
    eq("region: herramientas de estate", rh.isEstateManager, false);
    ok("region: permite marcas y voz, no bloquea volar", (rh.flags & REGION_FLAGS.ALLOW_LANDMARK) !== 0 && (rh.flags & REGION_FLAGS.ALLOW_VOICE) !== 0 && (rh.flags & REGION_FLAGS.BLOCK_FLY) === 0, regionFlagNames(rh.flags));

    const amc = readAgentMovementComplete(cap("AgentMovementCompleteMessageL"));
    eq("movimiento: agente", amc.agentId, "96b5f431-d0b5-4e9b-88dd-afc0e38a1567");
    eq("movimiento: x redondeada", Math.round(amc.position[0]), 212);
    eq("movimiento: z redondeada", Math.round(amc.position[2]), 140);
    eq("movimiento: handle", amc.regionHandle, 1135795511774720);
    eq("movimiento: version del canal", amc.channelVersion, "Second Life Server 17.12.01.511131");
    eq("movimiento: sello de tiempo", amc.timestamp, 1513785229);

    const adu = readAgentDataUpdate(cap("AgentDataUpdateMessageAL"));
    eq("agente: nombre", adu.firstName, "CustomerSupportOfficial");
    eq("agente: apellido", adu.lastName, "Resident");
    eq("agente: titulo de grupo", adu.groupTitle, "Casper Techie");
    eq("agente: grupo activo", adu.activeGroupId, "c6424e05-6e2c-fb03-220b-ca7904d11e04");
    eq("agente: poderes del grupo", adu.groupPowers, 437605627853006);
    eq("agente: nombre del grupo", adu.groupName, "CasperTech");

    const aw = readAgentWearablesUpdate(cap("AgentWearablesUpdateMessageAZL"));
    eq("ropa: numero de serie", aw.serialNum, 42);
    eq("ropa: cuantas", aw.wearables.length, 4);
    eq("ropa: tipos", aw.wearables.map((w) => w.type), [1, 2, 3, 4]);
    eq("ropa: nombres de tipo", aw.wearables.map((w) => w.typeName), ["piel", "pelo", "ojos", "camisa"]);
    eq("ropa: primer recurso", (aw.wearables[0].assetId || "").slice(0, 8), "d3d25329");

    const aa = readAvatarAppearance(cap("AvatarAppearanceMessageZL"));
    eq("apariencia: remitente", aa.senderId, "c458d09b-41c7-4091-9422-09def816fac5");
    eq("apariencia: parametros", aa.visualParams.length, 253);
    eq("apariencia: primeros parametros", aa.visualParams.slice(0, 3), [9, 40, 113]);
    eq("apariencia: version", aa.appearanceVersion, 1);
    eq("apariencia: version de cof", aa.cofVersion, 158);
    eq("apariencia: altura de flotado", aa.hoverHeight, 0);
    eq("apariencia: tamaño del texture entry", aa.textureEntry.length, 101);

    // El TextureEntry del avatar tiene 45 caras. Las que valen el valor por
    // defecto del simulador no llevan textura: se leen como null.
    const { readTextureEntryRaw } = await import("./objects.js");
    const teRaw = readTextureEntryRaw(aa.textureEntry, TE_COUNT);
    eq("apariencia: 45 caras", teRaw.image.length, TE_COUNT);
    eq("apariencia: una cara sin textura es nula", bakesFromTE(teRaw).upper, null);
    const par = visualParamsToValues(aa.visualParams, { order: [11000, 0], byId: { 11000: { min: 0, max: 1 }, 0: { min: -1, max: 1 } } });
    eq("apariencia: el byte 0..255 se vuelve fisico", [par[0].value, par[1].value], [9 / 255, -1 + (40 / 255) * 2]);

    const anim = readAvatarAnimation(cap("AvatarAnimationMessageL"));
    eq("animacion: remitente", anim.senderId, "d1cd5b71-6209-4595-9bf0-771bf689ce00");
    eq("animacion: cuantas", anim.animations.length, 7);
    eq("animacion: primera", anim.animations[0].id, "182e3e15-5af1-6c22-5fb3-6c42801519a3");
    eq("animacion: secuencia", anim.animations[0].sequence, 1225548);

    const chat = readChatFromSimulator(cap("ChatFromSimulatorMessageL"));
    eq("chat: de quien", chat.fromName, "#Firestorm LSL Bridge v2.21");
    eq("chat: origen", chat.sourceId, "bbacd23e-a773-f747-e9fa-23f2fa4940c3");
    eq("chat: tipo de origen", chat.sourceType, CHAT_SOURCE.OBJECT);
    eq("chat: tipo", chat.chatType, CHAT_TYPE.BROADCAST);
    eq("chat: se oye", chat.audible, true);
    eq("chat: posicion", Math.round(chat.position[0]), 212);
    ok("chat: el texto empieza por el puente", chat.message.indexOf("<bridge") === 0, chat.message.slice(0, 40));
    eq("chat: tipo de relé", chatKindFromType(chat.chatType), 3);
    eq("chat: ida y vuelta del tipo", chatKindFromType(chatTypeFromKind(1)), 1);

    const im = readImprovedInstantMessage(cap("ImprovedInstantMessageMessageZL"));
    eq("im: de", im.fromAgentId, "d1cd5b71-6209-4595-9bf0-771bf689ce00");
    eq("im: para", im.toAgentId, "96b5f431-d0b5-4e9b-88dd-afc0e38a1567");
    eq("im: dialogo", im.dialog, DIALOG.FROM_TASK);
    eq("im: nombre", im.fromAgentName, "Casper Warden");
    eq("im: estado", im.estateId, 7175);
    ok("im: el mensaje invita", im.message.indexOf("Join me in Izanagi") === 0, im.message.slice(0, 30));

    const stats = readSimStats(cap("SimStatsMessage"));
    eq("stats: x de la region", stats.regionX, 1033);
    eq("stats: y de la region", stats.regionY, 1102);
    eq("stats: capacidad de objetos", stats.objectCapacity, 20000);
    eq("stats: cuantos contadores", Object.keys(stats.stats).length, 35);
    ok("stats: dilatacion de tiempo", Math.abs(stats.timeDilation - 0.9957875) < 1e-6, stats.timeDilation);
    eq("stats: fps redondeados", Math.round(stats.fps), 45);
    eq("stats: pid del simulador", stats.pid, 8167);
    eq("stats: nombre del contador 2", STAT_NAME[2], "fps-fisica");

    const coarse = readCoarseLocationUpdate(cap("CoarseLocationUpdateMessage"));
    eq("posiciones: cuantas", coarse.agents.length, 8);
    eq("posiciones: tu indice", coarse.you, 1);
    eq("posiciones: presa", coarse.prey, -1);
    eq("posiciones: el primero", coarse.agents[0].agentId, "b5eb3daa-f5bc-4b86-a9e7-dd7a6ba00372");
    eq("posiciones: la z va en pasos de 4", coarse.agents[0].z, 31 * 4);
    eq("posiciones: el tuyo es el segundo", [coarse.agents[1].you, coarse.agents[0].you], [true, false]);

    const overlay = readParcelOverlay(cap("ParcelOverlayMessageZL"));
    eq("parcela: secuencia", overlay.sequenceId, 3);
    eq("parcela: tamaño", overlay.data.length, 1024);
    eq("parcela: primeros bytes", Array.from(overlay.data.slice(0, 5)), [97, 33, 33, 33, 65]);

    const money = readMoneyBalanceReply(cap("MoneyBalanceReplyMessageZL"));
    eq("dinero: saldo", money.moneyBalance, 4);
    eq("dinero: exito", money.success, true);
    eq("dinero: descripcion", money.description, "Casper Warden paid you L$2.");
    eq("dinero: tipo de transaccion", money.transactionType, 5001);
    eq("dinero: cantidad", money.amount, 2);

    const tp = readTeleportProgress(cap("TeleportProgressMessage"));
    eq("teletransporte: flags", tp.flags, 131076);
    eq("teletransporte: nombres", tp.flagNames, ["por-invitacion", "dentro-de-la-region"]);
    eq("teletransporte: mensaje", tp.message, "completing");

    const tl = readTeleportLocal(cap("TeleportLocalMessageL"));
    eq("teletransporte local: agente", tl.agentId, "96b5f431-d0b5-4e9b-88dd-afc0e38a1567");
    eq("teletransporte local: flags", tl.flags, 131076);
    eq("teletransporte local: posicion", Math.round(tl.position[0]), 212);

    eq("salida: inventario que se guarda", readLogoutReply(cap("LogoutReplyMessageL")).items.length, 4);
    eq("salud: valor", readHealthMessage(cap("HealthMessageMessageL")), 100);
    eq("ping: id", cap("StartPingCheckMessage").field("PingID", "PingID"), 17);
    eq("ping: el mas viejo sin confirmar", cap("StartPingCheckMessage").field("PingID", "OldestUnacked"), 2121);
    eq("acks: ids", cap("PacketAckMessage").list("Packets").map((p) => p.ID), [2006]);

    const map = readMapBlockReply(cap("MapBlockReplyMessageL"));
    eq("mapa: nombre", map.regions[0].name, "Izanagi");
    eq("mapa: coordenada", [map.regions[0].x, map.regions[0].y], [1033, 1102]);

    eq("camara: plano", readCameraConstraint(cap("CameraConstraintMessage")).plane.length, 4);
    eq("reloj: segundos por dia", readSimulatorViewerTime(cap("SimulatorViewerTimeMessageMessageL")).secPerDay, 14400);
    eq("controles: cuantos cambios", readScriptControlChange(cap("ScriptControlChangeMessageL")).length, 2);
    eq("grupo: cuantos roles", readGroupRoleDataReply(cap("GroupRoleDataReplyMessageL")).roles.length, 4);
    eq("grupo: primer rol", readGroupRoleDataReply(cap("GroupRoleDataReplyMessageL")).roles[0].name, "Officers");
    ok("conexion: aviso de residente", readOnlineNotification(cap("OnlineNotificationMessageL"))[0] === "d1cd5b71-6209-4595-9bf0-771bf689ce00", readOnlineNotification(cap("OnlineNotificationMessageL")));
    ok("muerte: se anuncia el borrado", cap("KillObjectMessageL").list("ObjectData").length === 6, true);
    ok("terreno: es la capa del suelo", cap("LayerDataMessageL").field("LayerID", "Type") === 0x4c, cap("LayerDataMessageL").field("LayerID", "Type"));
    eq("terreno: el viento es otra capa", cap("LayerDataMessage").field("LayerID", "Type"), 0x37);

    // --- ida y vuelta de los constructores --------------------------------
    //
    // Se construye el mensaje, se escribe el datagrama, se vuelve a leer y se
    // comprueba que lo leido es lo que se escribio. Esto pilla cualquier error
    // de orden de campos o de tipo, que es el fallo mas facil de cometer.

    const ID = "96b5f431-d0b5-4e9b-88dd-afc0e38a1567";
    const SS = "3d64e727-5147-4ea2-a76f-753f747c6108";
    const base = { agentId: ID, sessionId: SS };

    function vuelta(nombre, args, leer, esperado) {
      let d = null;
      try { d = decodePacket(encodePacket(args, T), T); }
      catch (e) { checks.push({ name: nombre + ": no se pudo escribir", ok: false, got: String(e.message) }); return null; }
      if (!d) return null;
      eq(nombre + ": nombre en el cable", d.name, args.name);
      if (leer) {
        const got = leer(d);
        eq(nombre + ": ida y vuelta", got, esperado);
      }
      return d;
    }

    vuelta("UseCircuitCode", useCircuitCode({ circuitCode: 12345, sessionId: SS, agentId: ID }),
      (d) => [d.field("CircuitCode", "Code"), d.field("CircuitCode", "SessionID")], [12345, SS]);

    vuelta("RegionHandshakeReply", regionHandshakeReply(Object.assign({ flags: 0 }, base)),
      (d) => [d.field("AgentData", "AgentID"), d.field("RegionInfo", "Flags")], [ID, 0]);

    vuelta("CompleteAgentMovement", completeAgentMovement(Object.assign({ circuitCode: 777 }, base)),
      (d) => [d.field("AgentData", "CircuitCode"), d.field("AgentData", "SessionID")], [777, SS]);

    vuelta("AgentUpdate", agentUpdate(Object.assign({
      bodyRotation: [0, 0, 0.383, 0.924], headRotation: [0, 0, 0.1, 0.995],
      state: AGENT_STATE.TYPING, controlFlags: CONTROL.AT_POS | CONTROL.FLY | CONTROL.FAST_AT,
      flags: AU_FLAG.NONE, camera: { center: [10, 20, 30], at: [1, 0, 0], left: [0, 0, 1], up: [0, 1, 0], far: 96 },
    }, base)),
      (d) => [d.field("AgentData", "State"), d.field("AgentData", "ControlFlags"), Math.round(d.field("AgentData", "CameraCenter")[1]), Math.round(d.field("AgentData", "Far")), Math.round(d.field("AgentData", "BodyRotation")[2] * 1000) / 1000],
      [AGENT_STATE.TYPING, (CONTROL.AT_POS | CONTROL.FLY | CONTROL.FAST_AT) >>> 0, 20, 96, 0.383]);

    vuelta("ChatFromViewer", chatFromViewer(Object.assign({ message: "hola a todos", type: CHAT_TYPE.NORMAL, channel: 0 }, base)),
      (d) => [texto(d.field("ChatData", "Message")), d.field("ChatData", "Type"), d.field("ChatData", "Channel")], ["hola a todos", 1, 0]);

    vuelta("ChatFromViewer (canal de script)", chatFromViewer(Object.assign({ message: "ping", type: CHAT_TYPE.WHISPER, channel: -1234 }, base)),
      (d) => [texto(d.field("ChatData", "Message")), d.field("ChatData", "Channel")], ["ping", -1234]);

    vuelta("LogoutRequest", logoutRequest(base), (d) => d.field("AgentData", "AgentID"), ID);

    vuelta("RequestMultipleObjects", requestMultipleObjects(Object.assign({ ids: [1, 2, 3] }, base)),
      (d) => d.list("ObjectData").map((b) => b.ID), [1, 2, 3]);

    vuelta("ObjectSelect", objectSelect(Object.assign({ localIds: [55, 66] }, base)),
      (d) => d.list("ObjectData").map((b) => b.ObjectLocalID), [55, 66]);

    vuelta("ObjectDeselect", objectDeselect(Object.assign({ localIds: [55] }, base)),
      (d) => d.list("ObjectData").map((b) => b.ObjectLocalID), [55]);

    vuelta("ObjectGrab", objectGrab(Object.assign({ localId: 42, offset: [0.1, 0.2, 0.3] }, base)),
      (d) => [d.field("ObjectData", "LocalID"), d.field("ObjectData", "GrabOffset").map((x) => Math.round(x * 10) / 10)], [42, [0.1, 0.2, 0.3]]);

    vuelta("ObjectDeGrab", objectDeGrab(Object.assign({ localId: 42 }, base)),
      (d) => d.field("ObjectData", "LocalID"), 42);

    vuelta("TeleportLocationRequest", teleportLocationRequest(Object.assign({ regionHandle: 1135795511774720, position: [128, 25, 128], lookAt: [1, 0, 0] }, base)),
      (d) => [u64ToNumber(d.field("Info", "RegionHandle")), Math.round(d.field("Info", "Position")[1])], [1135795511774720, 25]);

    vuelta("AgentThrottle", agentThrottle(Object.assign({ preset: 500 }, base)),
      (d) => { const b = d.field("Throttle", "Throttles"); const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); return [b.length, Math.round(dv.getFloat32(0, true)), Math.round(dv.getFloat32(20, true))]; },
      [28, 50 * 1024, 136 * 1024]);

    vuelta("RequestRegionInfo", requestRegionInfo(base), (d) => d.field("AgentData", "SessionID"), SS);
    vuelta("ParcelPropertiesRequest", parcelPropertiesRequest(Object.assign({ sequenceId: 7 }, base)),
      (d) => [d.field("ParcelData", "SequenceID"), d.field("ParcelData", "West"), d.field("ParcelData", "North")], [7, -1, 257]);

    vuelta("ParcelInfoRequest", parcelInfoRequest(Object.assign({ parcelId: "11111111-2222-3333-4444-555555555555" }, base)),
      (d) => d.field("Data", "ParcelID"), "11111111-2222-3333-4444-555555555555");

    vuelta("SetAlwaysRun", setAlwaysRun(Object.assign({ alwaysRun: true }, base)),
      (d) => d.field("AgentData", "AlwaysRun"), true);

    vuelta("AgentAnimation", agentAnimation(Object.assign({ animations: [{ id: "182e3e15-5af1-6c22-5fb3-6c42801519a3", start: true }, { id: "11111111-2222-3333-4444-555555555555", start: false }] }, base)),
      (d) => d.list("AnimationList").map((a) => [a.AnimID.slice(0, 8), a.StartAnim]), [["182e3e15", true], ["11111111", false]]);

    vuelta("ImprovedInstantMessage", improvedInstantMessage(Object.assign({
      toAgentId: "c458d09b-41c7-4091-9422-09def816fac5", fromName: "Yo Residente", message: "Hola, ¿qué tal?",
      dialog: DIALOG.IM, id: "e9118e89-16bc-2429-05d7-b978d8a09d63", estateId: 7175,
    }, base)),
      (d) => [texto(d.field("MessageBlock", "Message")), texto(d.field("MessageBlock", "FromAgentName")), d.field("MessageBlock", "Dialog"), d.field("EstateBlock", "EstateID")],
      ["Hola, ¿qué tal?", "Yo Residente", 2, 7175]);

    vuelta("AgentDataUpdateRequest", agentDataUpdateRequest(base), (d) => d.field("AgentData", "AgentID"), ID);
    vuelta("UUIDNameRequest", uuidNameRequest(["11111111-2222-3333-4444-555555555555", "66666666-7777-8888-9999-000000000000"]),
      (d) => d.list("UUIDNameBlock").length, 2);
    vuelta("RequestObjectPropertiesFamily", requestObjectPropertiesFamily(Object.assign({ flags: 6, objectId: "c458d09b-41c7-4091-9422-09def816fac5" }, base)),
      (d) => [d.field("ObjectData", "RequestFlags"), d.field("ObjectData", "ObjectID")], [6, "c458d09b-41c7-4091-9422-09def816fac5"]);
    vuelta("MoneyBalanceRequest", moneyBalanceRequest(Object.assign({ transactionId: NIL }, base)), (d) => d.field("MoneyData", "TransactionID"), NIL);
    vuelta("AgentWearablesRequest", agentWearablesRequest(base), (d) => d.field("AgentData", "SessionID"), SS);
    vuelta("AgentIsNowWearing", agentIsNowWearing(Object.assign({ wearables: [{ itemId: "11111111-2222-3333-4444-555555555555", type: WEARABLE_TYPE.SHIRT }] }, base)),
      (d) => [d.list("WearableData")[0].WearableType, d.list("WearableData")[0].ItemID.slice(0, 8)], [WEARABLE_TYPE.SHIRT, "11111111"]);
    vuelta("AgentCachedTexture", agentCachedTexture(Object.assign({ serialNum: 42, bakes: [{ cacheId: "11111111-2222-3333-4444-555555555555", textureIndex: 34 }] }, base)),
      (d) => [d.field("AgentData", "SerialNum"), d.list("WearableData")[0].TextureIndex], [42, 34]);
    vuelta("AgentSetAppearance", agentSetAppearance(Object.assign({ serialNum: 42, size: [0.45, 1.8, 0.3], visualParams: [1, 2, 255], wearables: [{ cacheId: NIL, index: 34 }] }, base)),
      (d) => [d.list("VisualParam").length, d.list("VisualParam")[2].ParamValue, Math.round(d.field("AgentData", "Size")[1] * 10) / 10], [3, 255, 1.8]);
    vuelta("AvatarPropertiesRequest", avatarPropertiesRequest(Object.assign({ avatarId: ID }, base)), (d) => d.field("AgentData", "AvatarID"), ID);
    vuelta("AgentFOV", agentFOV(Object.assign({ verticalAngle: 1.2 }, base)), (d) => Math.round(d.field("FOVBlock", "VerticalAngle") * 10) / 10, 1.2);
    vuelta("AgentHeightWidth", agentHeightWidth(Object.assign({ height: 800, width: 1280 }, base)), (d) => [d.field("HeightWidthBlock", "Height"), d.field("HeightWidthBlock", "Width")], [800, 1280]);
    vuelta("ViewerEffect", viewerEffect(Object.assign({ effects: [{ id: NIL, agentId: ID, type: 2, duration: 0.5, color: [1, 1, 1, 1], typeData: Uint8Array.of(1, 2) }] }, base)),
      (d) => [d.list("Effect").length, d.list("Effect")[0].Type], [1, 2]);
    vuelta("GenericMessage", genericMessage(Object.assign({ method: "getgroup", params: ["a", "b"] }, base)),
      (d) => [texto(d.field("MethodData", "Method")), d.list("ParamList").map((p) => texto(p.Parameter))], ["getgroup", ["a", "b"]]);
    vuelta("ObjectDelete", objectDelete(Object.assign({ localIds: [9] }, base)), (d) => d.list("ObjectData").length, 1);
    vuelta("ObjectDuplicateOnRay", objectDuplicateOnRay(Object.assign({ localIds: [9], rayStart: [1, 2, 3], rayEnd: [4, 5, 6] }, base)),
      (d) => [d.field("AgentData", "CopyCenters"), d.list("ObjectData")[0].ObjectLocalID], [false, 9]);
    vuelta("RequestTaskInventory", requestTaskInventory(Object.assign({ localId: 12 }, base)), (d) => d.field("InventoryData", "LocalID"), 12);
    vuelta("AgentRequestSit", agentRequestSit(Object.assign({ targetId: ID, offset: [0, 0.5, 0] }, base)), (d) => d.field("TargetObject", "TargetID"), ID);
    vuelta("AgentSit", agentSit(base), (d) => d.field("AgentData", "SessionID"), SS);
    vuelta("ParcelPropertiesUpdate", parcelPropertiesUpdate(Object.assign({ parcel: { localId: 3, name: "Mi trozo", desc: "nada", parcelFlags: PARCEL_FLAG.ALLOW_FLY | PARCEL_FLAG.CREATE_OBJECTS } }, base)),
      (d) => [texto(d.field("ParcelData", "Name")), d.field("ParcelData", "ParcelFlags") >>> 0], ["Mi trozo", (PARCEL_FLAG.ALLOW_FLY | PARCEL_FLAG.CREATE_OBJECTS) >>> 0]);
    vuelta("ModifyLand", modifyLand(Object.assign({ action: 1, brushSize: 2, seconds: 0.5, height: 3 }, base)),
      (d) => [d.field("ModifyBlock", "Action"), Math.round(d.field("ModifyBlock", "Height"))], [1, 3]);
    vuelta("ScriptAnswerYes", scriptAnswerYes(Object.assign({ taskId: ID, itemId: NIL, questions: 1 }, base)), (d) => d.field("Data", "TaskID"), ID);
    vuelta("SetStartLocationRequest", setStartLocationRequest(Object.assign({ simName: "Izanagi", position: [128, 25, 128] }, base)),
      (d) => [texto(d.field("StartLocationData", "SimName")), Math.round(d.field("StartLocationData", "LocationPos")[0])], ["Izanagi", 128]);
    vuelta("ObjectAdd", objectAdd(Object.assign({ scale: [0.5, 0.5, 0.5] }, base)),
      (d) => [d.field("ObjectData", "PCode"), d.field("ObjectData", "ProfileCurve"), Math.round(d.field("ObjectData", "Scale")[0] * 10) / 10], [9, 1, 0.5]);
    vuelta("RezObject", rezObject(Object.assign({ item: { itemId: ID, name: "Caja", type: 6, invType: 6, creationDate: 1700000000, crc: 1234 } }, base)),
      (d) => [texto(d.field("InventoryData", "Name")), d.field("InventoryData", "CRC")], ["Caja", 1234]);

    // Las enumeraciones clave tienen que cuadrar con Linden Lab.
    eq("control: ATRAS es el bit 1", CONTROL.AT_NEG, 0x2);
    eq("control: FAST_AT es el bit 10", CONTROL.FAST_AT, 1 << 10);
    eq("control: FLY es el bit 13", CONTROL.FLY, 1 << 13);
    eq("control: nombre del bit 13", controlNames(1 << 13), ["FLY"]);
    eq("control: nombre del bit 31", controlNames(0x80000000), ["ML_LBUTTON_UP"]);
    eq("control: FLY del pie de teclas", controlFlags({ fly: true }) & CONTROL.FLY, CONTROL.FLY);
    eq("control: correr pone los tres FAST", controlNames(controlFlags({ run: true })), ["FAST_AT", "FAST_LEFT", "FAST_UP"]);
    eq("parcela: CREATE_OBJECTS es 1<<6", PARCEL_FLAG.CREATE_OBJECTS, 64);
    eq("parcela: nombre del bit 6", parcelFlagNames(64), ["crear-objetos"]);
    eq("prendas: la camisa es 4", WEARABLE_TYPE.SHIRT, 4);
    eq("prendas: el nombre de 13", WEARABLE_TYPE_NAME[13], "alfa");
    eq("estados: escribiendo es 0x04", AGENT_STATE.TYPING, 4);
    eq("estados: editando es 0x10", AGENT_STATE.EDITING, 16);
    eq("teletransporte: VIA_LOGIN es el bit 7", TELEPORT_FLAG.VIA_LOGIN, 7);
    eq("dialogos: FROM_TASK es 22", DIALOG.FROM_TASK, 22);
    eq("apariencia: 45 indices de textura", TE_INDEX.length, MAX_TES);
    eq("apariencia: la cabeza horneada es la cara 34", BAKE_FACE.head, 34);
    eq("apariencia: los bakes ocupan 34..44", [BAKE_FACE.aux3, TE_INDEX.indexOf("aux3-baked")], [44, 44]);
    eq("apariencia: nombre de la cara 14", TE_INDEX[14], "skirt");
    eq("umbrales: el ancho de banda del perfil", throttleBytes(300).slice(0, 3), [30 * 1024, 40 * 1024, 9 * 1024]);
    eq("umbrales: canales en orden del cable", THROTTLE_CHANNELS.length, 7);

    const failed = checks.filter((c) => !c.ok);
    return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
  })();
}
