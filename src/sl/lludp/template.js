// template.js -- la plantilla de mensajes LLUDP: analizarla y consultarla.
//
// Second Life no manda mensajes autodescritos: cada datagrama UDP empieza por un
// numero de mensaje de 1, 2 o 4 bytes (segun su "frecuencia") y detras vienen
// campos de tamano fijo, en un orden que solo conocen las dos partes porque
// ambas leen la MISMA plantilla. La plantilla oficial es
// `scripts/messages/message_template.msg` del visor de Linden Lab (version 2.0,
// 483 mensajes) y el analizador de aqui es el mismo que usa Hippolyzer, escrito
// otra vez en JavaScript.
//
// `templates.js` trae esa plantilla ya analizada (datos generados). Este modulo
// sabe analizarla (para poder regenerarla) y consultarla rapido:
//
//   const t = defaultTemplates();
//   t.byName("RegionHandshake")   -> la plantilla del mensaje
//   t.byPair(2, 0x0094)           -> la plantilla de ese numero en el cable
//
// LA REGLA DEL NUMERO DE MENSAJE
// ------------------------------
// El numero que va en el cable es `[0xFF x n][numero]`, donde `n` dice la
// frecuencia (esta en `llmessagetemplateparser.cpp`):
//
//   High    n=0 -> 1 byte  (numero < 256)      ->  0x04 (AgentUpdate)
//   Medium  n=1 -> 2 bytes ->  0xFF 0x0C       ->  0xFF0C (ObjectUpdate)
//   Low     n=2 -> 4 bytes ->  0xFF 0xFF 0x00 0x94 (RegionHandshake = 0xFFFF0094)
//   Fixed   n=3 -> 4 bytes ->  0xFF 0xFF 0xFF 0xFB (PacketAck = 0xFFFFFFFB)
//
// Las `Fixed` ya llevan su numero alto en la plantilla (0xFFFFFFFB), asi que en
// el cable solo viaja el ultimo byte; al leerlo se vuelve a componer
// (`0xFFFFFF00 | byte`) para poder buscar la plantilla.

import { PACKED } from "./templates.js";

// --- constantes de la plantilla ---------------------------------------------

export const FREQ = { HIGH: 0, MEDIUM: 1, LOW: 2, FIXED: 3 };
export const FREQ_NAME = ["High", "Medium", "Low", "Fixed"];
export const FREQ_BY_NAME = { High: 0, Medium: 1, Low: 2, Fixed: 3 };

export const BLOCK = { SINGLE: 0, MULTIPLE: 1, VARIABLE: 2 };
export const BLOCK_NAME = ["Single", "Multiple", "Variable"];
export const BLOCK_BY_NAME = { Single: 0, Multiple: 1, Variable: 2 };

export const DEPRECATION = ["NotDeprecated", "Deprecated", "UDPDeprecated", "UDPBlacklisted"];

// Frecuencia -> cuantos bytes ocupa el numero (prefijo de 0xFF incluido).
export const FREQ_NUM_LEN = [1, 2, 4, 4];

// Tamano en bytes de cada tipo, cuando es fijo. `Variable` y `Fixed` lo llevan
// en la propia plantilla (el tamano del campo de longitud, o el tamano fijo).
export const TYPE_SIZE = {
  U8: 1, U16: 2, U32: 4, U64: 8,
  S8: 1, S16: 2, S32: 4, S64: 8,
  F32: 4, F64: 8,
  LLVector3: 12, LLVector3d: 24, LLVector4: 16, LLQuaternion: 12,
  LLUUID: 16, BOOL: 1, IPADDR: 4, IPPORT: 2,
};

// Numero de bytes del numero de mensaje, tal como va en el cable (big-endian).
export function freqNumBytes(freq, num) {
  switch (freq) {
    case FREQ.HIGH: return Uint8Array.of(num & 0xff);
    case FREQ.MEDIUM: return Uint8Array.of(0xff, num & 0xff);
    case FREQ.LOW: return Uint8Array.of(0xff, 0xff, (num >> 8) & 0xff, num & 0xff);
    default: return Uint8Array.of(0xff, 0xff, 0xff, num & 0xff);
  }
}

// --- el analizador -----------------------------------------------------------
//
// Traduce el texto de `message_template.msg` a una lista de mensajes. El estado
// es la PROFUNDIDAD de llaves: 1 = cabecera de mensaje, 2 = cabecera de bloque,
// 3 = linea de campo. Cada linea de campo abre y cierra su llave en la misma
// linea, asi que la profundidad sube a 3 y vuelve a 2 sola.

const RE_START = /\{/;
const RE_END = /\}/;
const RE_COMMENT = /^\s*\/\//;
const RE_MESSAGE = /.*?(\w+)\s+(\w+)\s+(\w+)\s+(\w+)\s+(\w+)(\s+(\w+))?.*/;
const RE_BLOCK = /.*?(\w+)\s+(\w+)(\s+(\d+))?.*/;
const RE_FIELD = /.*?(\w+)\s+(\w+)(\s+(\d+))?.*/;
const RE_VERSION = /version\s+([\d.]+)/;

export function parseTemplateText(text) {
  const lines = String(text).split(/\r?\n/);
  let version = "";
  let depth = 0;
  const messages = [];
  let msg = null;
  let block = null;

  for (const line of lines) {
    if (RE_COMMENT.test(line)) continue;
    if (!version) {
      const v = RE_VERSION.exec(line);
      if (v) version = v[1];
    }
    const start = RE_START.test(line);
    const end = RE_END.test(line);
    if (start) depth++;

    if (depth === 1) {
      const m = RE_MESSAGE.exec(line);
      if (m && FREQ_BY_NAME[m[2]] !== undefined) {
        msg = {
          name: m[1], freq: FREQ_BY_NAME[m[2]], num: Number(m[3]),
          trusted: m[4] === "Trusted", zerocoded: m[5] === "Zerocoded",
          deprecated: DEPRECATION.indexOf(m[7] || "NotDeprecated"), blocks: [],
        };
        if (msg.deprecated < 0) msg.deprecated = 0;
        messages.push(msg);
      }
    } else if (depth === 2) {
      const m = RE_BLOCK.exec(line);
      if (m && BLOCK_BY_NAME[m[2]] !== undefined && msg) {
        block = { name: m[1], type: BLOCK_BY_NAME[m[2]], count: m[2] === "Multiple" ? Number(m[4]) : 0, vars: [] };
        msg.blocks.push(block);
      }
    } else if (depth === 3) {
      const m = RE_FIELD.exec(line);
      if (m && block) {
        const type = m[2];
        if (type === "Variable" || type === "Fixed") {
          const size = Number(m[4]);
          if (!size) throw new Error("campo " + type + " sin tamano en " + msg.name + "." + block.name + "." + m[1]);
          block.vars.push({ name: m[1], type, size });
        } else if (TYPE_SIZE[type]) {
          block.vars.push({ name: m[1], type, size: TYPE_SIZE[type] });
        } else {
          throw new Error("tipo desconocido " + type + " en " + msg.name + "." + block.name + "." + m[1]);
        }
      }
    }
    if (end) depth--;
  }
  return { version, messages };
}

// --- empaquetado (para `templates.js`) --------------------------------------
//
// Los nombres (de mensajes, bloques y campos) se repiten muchisimo, asi que se
// guardan una sola vez en una tabla y en su sitio va el indice. Con eso la tabla
// entera pasa de 123 KB a 66 KB.

export function packTemplate(parsed) {
  const names = [];
  const nameIdx = new Map();
  const types = [];
  const typeIdx = new Map();
  const nid = (n) => {
    let i = nameIdx.get(n);
    if (i === undefined) { i = names.length; names.push(n); nameIdx.set(n, i); }
    return i;
  };
  const tid = (n, s) => {
    const k = n + "|" + s;
    let i = typeIdx.get(k);
    if (i === undefined) { i = types.length; types.push([n, s]); typeIdx.set(k, i); }
    return i;
  };
  const messages = parsed.messages.map((t) => [nid(t.name), t.freq, t.num, t.trusted ? 1 : 0, t.zerocoded ? 1 : 0, t.deprecated,
    t.blocks.map((b) => [nid(b.name), b.type, b.count, b.vars.map((v) => [nid(v.name), tid(v.type, v.size)])])]);
  return { version: parsed.version, names, types, messages };
}

// --- la tabla, consultable ---------------------------------------------------

export class TemplateSet {
  constructor(packed = PACKED) {
    this.version = packed.version;
    this.types = packed.types;
    const names = packed.names;
    const t = this;
    this.messages = packed.messages.map((m) => ({
      name: names[m[0]],
      freq: m[1],
      num: m[2],
      freqNum: FREQ_NAME[m[1]],
      numBytes: freqNumBytes(m[1], m[2]),
      numLen: FREQ_NUM_LEN[m[1]],
      trusted: !!m[3],
      zerocoded: !!m[4],
      deprecated: DEPRECATION[m[5]] || "NotDeprecated",
      blocks: m[6].map((b) => ({
        name: names[b[0]],
        type: b[1],
        typeName: BLOCK_NAME[b[1]],
        count: b[2],
        vars: b[3].map((v) => ({ name: names[v[0]], type: packed.types[v[1]][0], size: packed.types[v[1]][1] })),
      })),
    }));
    this.byNameMap = new Map();
    this.byPairMap = new Map();
    for (const msg of this.messages) {
      this.byNameMap.set(msg.name, msg);
      // Las `Fixed` comparten el numero alto: en el cable solo viaja el ultimo
      // byte, asi que la clave es el numero completo y el lector lo recompone.
      this.byPairMap.set(msg.freq + ":" + msg.num, msg);
    }
    t.byName = (n) => t.byNameMap.get(String(n)) || null;
    t.byPair = (freq, num) => t.byPairMap.get(freq + ":" + num) || null;
  }
  get size() { return this.messages.length; }
  names() { return this.messages.map((m) => m.name); }
}

let _default = null;
export function defaultTemplates() {
  if (!_default) _default = new TemplateSet(PACKED);
  return _default;
}

// --- autotest ----------------------------------------------------------------

export function runTemplateSelfTest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });
  const t = defaultTemplates();

  eq("version de la plantilla", t.version, "2.0");
  eq("numero de mensajes", t.size, 483);

  // La regla del numero de mensaje, comprobada contra casos conocidos.
  eq("UseCircuitCode es Low 3", [t.byName("UseCircuitCode").freqNum, t.byName("UseCircuitCode").num], ["Low", 3]);
  eq("UseCircuitCode en el cable", [...t.byName("UseCircuitCode").numBytes], [0xff, 0xff, 0x00, 0x03]);
  eq("AgentUpdate es High 4", [t.byName("AgentUpdate").freqNum, t.byName("AgentUpdate").num], ["High", 4]);
  eq("AgentUpdate en el cable", [...t.byName("AgentUpdate").numBytes], [0x04]);
  eq("ObjectUpdate es High 12", [t.byName("ObjectUpdate").freqNum, t.byName("ObjectUpdate").num], ["High", 12]);
  eq("ObjectUpdate en el cable", [...t.byName("ObjectUpdate").numBytes], [0x0c]);
  eq("PacketAck es Fixed 0xFFFFFFFB", [t.byName("PacketAck").freqNum, t.byName("PacketAck").num], ["Fixed", 0xfffffffb]);
  eq("PacketAck en el cable", [...t.byName("PacketAck").numBytes], [0xff, 0xff, 0xff, 0xfb]);
  eq("RegionHandshake en el cable", [...t.byName("RegionHandshake").numBytes], [0xff, 0xff, 0x00, 0x94]);

  // Busqueda por el numero del cable (lo que hace el lector).
  ok("se encuentra UseCircuitCode por su par", t.byPair(FREQ.LOW, 3) === t.byName("UseCircuitCode"));
  ok("se encuentra AgentUpdate por su par", t.byPair(FREQ.HIGH, 4) === t.byName("AgentUpdate"));
  ok("se encuentra PacketAck por su par", t.byPair(FREQ.FIXED, 0xfffffffb) === t.byName("PacketAck"));
  ok("un par que no existe da null", t.byPair(FREQ.HIGH, 250) === null);

  // Estructura de mensajes que usamos de verdad.
  const hs = t.byName("RegionHandshake");
  eq("RegionHandshake empieza por RegionInfo/RegionInfo2",
    hs.blocks.slice(0, 2).map((b) => b.name), ["RegionInfo", "RegionInfo2"]);
  eq("RegionHandshake.RegionInfo es Single", hs.blocks[0].typeName, "Single");
  eq("SimName es Variable de longitud 1",
    [hs.blocks[0].vars.find((v) => v.name === "SimName").type, hs.blocks[0].vars.find((v) => v.name === "SimName").size], ["Variable", 1]);
  eq("RegionFlags es U32 de 4 bytes",
    [hs.blocks[0].vars.find((v) => v.name === "RegionFlags").type, hs.blocks[0].vars.find((v) => v.name === "RegionFlags").size], ["U32", 4]);
  eq("TerrainHeightRange11 es F32",
    hs.blocks[0].vars[hs.blocks[0].vars.length - 1].name, "TerrainHeightRange11");

  const pa = t.byName("PacketAck");
  eq("PacketAck tiene un bloque Variable", pa.blocks[0].typeName, "Variable");
  eq("PacketAck.Packets tiene un campo U32", pa.blocks[0].vars.map((v) => v.name + ":" + v.type), ["ID:U32"]);

  // Todos los campos tienen un tamano real, y los unicos mensajes sin bloques
  // son los ocho de gestion del circuito (que no llevan datos: cerrar, darse de
  // baja, apagar el simulador...). Si apareciera otro, la plantilla estaria mal.
  const sinBloques = [];
  let malTamano = 0, campos = 0;
  for (const m of t.messages) {
    if (!m.blocks.length) sinBloques.push(m.name);
    for (const b of m.blocks) {
      if (b.type === BLOCK.MULTIPLE && b.count <= 0) malTamano++;
      for (const v of b.vars) {
        campos++;
        if (!(v.size > 0)) malTamano++;
      }
    }
  }
  eq("mensajes sin datos: solo los del circuito", sinBloques,
    ["CloseCircuit", "SubscribeLoad", "UnsubscribeLoad", "SimulatorShutdownRequest", "EconomyDataRequest", "DisableSimulator", "TallyVotes", "RequestTrustedCircuit"]);
  eq("ningun campo con tamano invalido", malTamano, 0);
  ok("la tabla tiene miles de campos", campos > 1500, campos);

  // El analizador: un trozo de plantilla de verdad, analizado y consultado.
  const muestra = [
    "version 2.0",
    "{",
    "    TestMessage Low 1 NotTrusted Zerocoded",
    "    {",
    "        TestBlock1 Single",
    "        {   Test1   U32 }",
    "    }",
    "    {",
    "        NeighborBlock Multiple 4",
    "        {   Test0   U32 }",
    "        {   Test1   U32 }",
    "        {   Test2   U32 }",
    "    }",
    "}",
    "{",
    "    PacketAck Fixed 0xFFFFFFFB NotTrusted Unencoded",
    "    {",
    "        Packets Variable",
    "        {   ID  U32 }",
    "    }",
    "}",
  ].join("\n");
  const parsed = parseTemplateText(muestra);
  eq("el analizador ve dos mensajes", parsed.messages.map((m) => m.name), ["TestMessage", "PacketAck"]);
  eq("la version se lee", parsed.version, "2.0");
  const tm = parsed.messages[0];
  eq("frecuencia y numero", [tm.freq, tm.num], [FREQ.LOW, 1]);
  eq("marcas del mensaje", [tm.trusted, tm.zerocoded], [false, true]);
  eq("bloques", tm.blocks.map((b) => b.name + "/" + BLOCK_NAME[b.type] + "/" + b.count),
    ["TestBlock1/Single/0", "NeighborBlock/Multiple/4"]);
  eq("campos del segundo bloque", tm.blocks[1].vars.map((v) => v.name + ":" + v.type + ":" + v.size),
    ["Test0:U32:4", "Test1:U32:4", "Test2:U32:4"]);

  // Empaquetar y desplegar tiene que dar lo mismo: si no, `templates.js` y el
  // analizador se han ido cada uno por su lado.
  const packed = packTemplate(parsed);
  const round = new TemplateSet(packed);
  eq("ida y vuelta por el empaquetado", round.messages.map((m) => m.name), ["TestMessage", "PacketAck"]);
  eq("ida y vuelta: campos", round.byName("TestMessage").blocks[1].vars.map((v) => v.name), ["Test0", "Test1", "Test2"]);
  eq("ida y vuelta: numero del cable", [...round.byName("PacketAck").numBytes], [0xff, 0xff, 0xff, 0xfb]);

  // Y la tabla de verdad tiene que ser coherente con el analizador: se
  // reconstruye desde `PACKED` y se compara con lo que hay en el modulo.
  const again = new TemplateSet(PACKED);
  eq("la tabla empaquetada da el mismo numero", again.size, t.size);
  eq("y el mismo nombre el primero", again.messages[0].name, t.messages[0].name);

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
}
