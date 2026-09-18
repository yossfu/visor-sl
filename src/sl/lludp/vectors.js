// Vectores de prueba: paquetes UDP de Second Life capturados en una region real
// y guardados tal cual (en base64). Sirven para que el decodificador LLUDP se
// compruebe contra bytes autenticos del cable, y no contra datos inventados, de
// modo que una refactorizacion no pueda romper el analisis del protocolo sin que
// salte un test.
//
// Origen: la carpeta de pruebas de node-metaverse (testing/packets), que a su vez
// son capturas de un visor Linden contra una region de produccion.
//
// Los cinco paquetes cubren las rutas calientes del visor: update de prim
// completo (High/12), update comprimido (High/13), update cacheado (High/14),
// update terse (High/15) y borrado de objetos (High/16).
//
// `runVectorsSelfTest()` se usa desde el panel de diagnostico del visor.

import { defaultTemplates } from "./template.js";
import { decodePacket } from "./codec.js";
import {
  decodeObjectUpdate, decodeObjectUpdateCompressed, decodeObjectUpdateCached,
  decodeImprovedTerseObjectUpdate, decodeKillObject, primRecord,
} from "./objects.js";

// Datagramas completos (cabecera LLUDP incluida), base64 sin saltos de linea.
export const VECTORES = {
  ObjectUpdate: "wAAACFgADAABTgQAAgkEAAH//wHx6ooiAAGew2UP8qq49Goc3d1mHhV9lGCeHAkDAAGAS8k/N8NEPgrXIzw8+Kf8wFUvJ8D6/7HAABigxBw/psQcvy8Etb4ADAvriiJQAAIQEAEABGRkAA9ZAAHegaaOxncuzq3jE596mJ7eH4lVZ0cky0PtkgtHyu0VRl8AAn//AAEfAAP/AAOAPwADgD8ACiAfAAQNHwAeOQIgAAEQAAP/gAAB/wACIEEABoA/QAABHAAD3oGmjsZ3Ls6t4xOfepie3gACwD8AAoA/AEY=",
  ObjectUpdateCompressed: "QAAABVwADQBOBAAACQQAYv8DEAgCEOgAu4gq5l6dWr/0G7tSAt6Dpr0urSEJAB5AAAADAM41pD3UNos88wizPcBoh0Cx1xBAqvF5RUYzij3rgTU/wKmjvQAAAAAAAAAAAAAAAAAAAAAAAAAAAWAAEQAAADZjUHOHqIUV/hzRZ8GrB2IFEAAAAABkZAAAAAAAAAAAAAAAAAAAAABhAAAAV0jezPYpRhyaNqNaIh/iHwJaMXiyp8WtQvrr7YsolgSnARHlLUoon7Yokp1Rlhj2pdIAAAAAAAAAAIA/AAAAgD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANAEABDGALlvAkZiviTpTaIcCUuZ48dI1kshCQB1BgAAAwAK1yM8CtcjPArXIzz///9CAAAAQwIAekQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFgABEAAABbxa9QIWpLMY6q1wRYS1WOBSAAAAAAZKUAAAAAAAAAAAAAAAAAAPoAPwAAAHB5pZ3zJLS2NgdS9rJiql4AAAAA/wAAAIA/AAAAgD8AAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAAAhC4AMLXQNaXlXttZfp1d5pzAqBAlfMJCQDeAAAAAwCPwvU8j8L1PI/C9TyKdsFAcxngQM/1eUUAAAAA9AQ1PwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAGRkAACcZAAAAAAABQAAAADzfkgAAABXSN7M9ilGHJo2o1oiH+IfAP///wAEAAAAzAAAAIA/AAAAgD8AAAAAAAAAAAAAwAQgAAAAAAQmAAAAAAAAAAAAAAAAAAAAAAA=",
  ObjectUpdateCached: "QAAABQ4ADgBOBAAACQQANf4ik7F5IP5KAADQgAIQlLF5IAkAAADQAAIQlbF5IIoQAADQAAIQlrF5IFAQAADQAAIQl7F5IJQWAADQAAIQmLF5IAcRAADQAAIQmbF5ILgPAADQAAIQ5ER1IAoBAADQgAIQ4ER1IBYBAADQgAIQE3NzICY3AADQBAAAk57GICgGAADQBAAQyqHGIB8AAAAQCAIQBHNzIEQDAADQBAAABXNzIL0IAADQDAIABnNzINQIAADQDAIAB3NzINMIAADQDAIACHNzINEIAADQDAIACXNzINIIAADQDAIACnNzILAJAADQDAIAC3NzIMwEAADQDAIADHNzIMsDAADQDAIADXNzIL4DAADQDAIADnNzIM8DAADQDAIAD3NzIMQDAADQDAIAEHNzILoDAADQDAIAEXNzIMYBAADQDAIAEnNzINICAADQDAIAt6HGICUAAAAQCAIQyE54IP/2CADQAAIQ9KxzIG0BAAAQCAIQx054IDmhCADQCAIQYKDGIIYFAADQAAIQXqDGIE0AAADQCAIQX6DGIE4AAADQCAIQ",
  ImprovedTerseObjectUpdate: "QAAACF0ADwBOBAAACQQAtf4MLFCxACYAAJrAYkONGGJDWh7/Qv9//3//f/9//3//f/9//3++Cfuw/3//f/9/igCGAAAAV0jezPYpRhyaNqNaIh/iHwlKALtcH7OSfIEmIR36ZGt4BD0CctllnO3nQNQg4gDZ2kMC6BI+CZLNcJAHxYFxPYbomgDl//8ADwAAAAAAAACAPwAAAIA/CAAAAEEBAAAAQAAAAAAAAAEBQAAAAAAgAAAA5g8AAAAAAAAAAAAAAAAAAAAAAAAs+9zCIgAA3ud4PG5PkDr1ZRk+/3//f/9//3//f/9/fSX/f30l/3//f/9//38AACwA3cIiAACT7QBDYF5FQ1/RA0P/f/9//3//f/9//3//f/9/liWb2v9//3//fwAALGPmCyQAAJtVjz6IgIO9YAEcvv9//3//f/9//3//f/9//3//f////3//f/9/QwA/AAAADc0aSIoKGDvP+GEilMGe3gAAAAD/AAAAgD8AAACAPwAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAALGTmCyQAAJtVjz7NWzW9ZForvv9//3//f/9//3//f/9//3//f////3//f/9/QwA/AAAADc0aSIoKGDvP+GEilMGe3gAAAAAAAAAAgD8AAACAPwAAAAAAAAAAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAALGfmCyQAAFQDQkMF8kJD/Hj9Qv9//3//f/9//3//f/9//3++Cfuw/3//f/9/WQBVAAAAL6W/cv9IWUvRX8rZBPm63gFXSN7M9ilGHJo2o1oiH+IfAAAAAAABAAAA/wAAAIA/AAAAgD8AAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAACwD64oiAAB40udA1NaIufhvuL//f/9//3//f/9//3/+P/6//z/+v/9//3//fwAALAXriiIAAHjS50DU1oi5/Z+zv/9//3//f/9//3//f/4//r//P/6//3//f/9/AAAssQyLIgAANLYCQ0bnGkOvGQJD/3//f/9//3//f/9//3//f/9/////f/9//38AACw/JzAjAABsCXk8GLSQOh9kGT7/f/9//3//f/9//399Jf9/fSX/f/9//3//fwAALD4nMCMAADPc2kI/ir1CdbADQ/9//3//f/9//3//f/9//3/UK5Ef/3//f/9/AAAsU7EAJgAAvF1hQ8OkXEOve/RC/3//f/9//3//f/9//3//f8ntzcH/f/9//39DAD8AAACl2MKM3Et5Yzx/2quYL8T3AAAAAAAAAACAPwAAAIA/AAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  KillObject: "QAAACCgAEAauDIsirwyLIrIMiyKzDIsi7nOLIu9ziyI=",
};

// base64 -> Uint8Array (atob existe tanto en el navegador como en los workers).
export function base64ABytes(texto) {
  const bin = atob(texto);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Decodifica un vector entero (cabecera incluida) y devuelve el mensaje.
export function decodificarVector(nombre) {
  const b64Vector = VECTORES[nombre];
  if (!b64Vector) throw new Error("vector desconocido: " + nombre);
  return decodePacket(base64ABytes(b64Vector), defaultTemplates());
}

const TOL = 1e-3;

// Autotest: decodifica los cinco vectores reales y comprueba los valores que ya
// se verificaron a mano contra las capturas. Devuelve {checks, passed, fails},
// el mismo formato que los demas autotests del visor.
export function runVectorsSelfTest() {
  let checks = 0, passed = 0;
  const fails = [];
  const ok = (name, cond, got) => { checks++; if (cond) passed++; else fails.push({ name, got }); };
  const eq = (name, got, want) => ok(name, got === want, got);
  const near = (name, got, want, tol) => ok(name, typeof got === "number" && Math.abs(got - want) <= (tol === undefined ? TOL : tol), got);
  const nearArr = (name, got, want, tol) => ok(name, Array.isArray(got) && got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= (tol === undefined ? TOL : tol)), got);
  const eqJson = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), got);

  // --- ObjectUpdate (High/12): un prim completo ---------------------------
  {
    const msg = decodificarVector("ObjectUpdate");
    eq("vectores: ObjectUpdate nombre", msg.name, "ObjectUpdate");
    eq("vectores: ObjectUpdate secuencia", msg.packetId, 2136);
    const objs = decodeObjectUpdate(msg);
    eq("vectores: ObjectUpdate objetos", objs.length, 1);
    const o = objs[0];
    eq("vectores: ObjectUpdate id local", o.localId, 579529457);
    eq("vectores: ObjectUpdate uuid", o.uuid, "9ec3650f-f2aa-b8f4-6a1c-dddd661e157d");
    eq("vectores: ObjectUpdate pcode", o.pcode, 9);
    eq("vectores: ObjectUpdate forma", o.shape, "box");
    eq("vectores: ObjectUpdate padre", o.parentId, 579529483);
    eq("vectores: ObjectUpdate crc", o.crc, 480141460);
    eq("vectores: ObjectUpdate flags", o.flags, 268435536);
    nearArr("vectores: ObjectUpdate escala", o.scale, [1.5726, 0.19215, 0.01]);
    nearArr("vectores: ObjectUpdate posicion SL", o.position, [-7.8955, -2.61227, -5.5625]);
    eq("vectores: ObjectUpdate extra params", o.extraParams.length, 2);
    eqJson("vectores: ObjectUpdate luz", [o.extraParams[0].name, o.extraParams[0].length], ["LIGHT", 16]);
    eqJson("vectores: ObjectUpdate mapa de luz", [o.extraParams[1].name, o.extraParams[1].length], ["LIGHT_IMAGE", 28]);
    eq("vectores: ObjectUpdate caras", o.faces.length, 6);
    eq("vectores: ObjectUpdate textura cara 0", o.faces[0].tex.a, "89556747-24cb-43ed-920b-47caed15465f");
    eq("vectores: ObjectUpdate textura cara 5", o.faces[5].tex.a, "de81a68e-c677-2ece-ade3-139f7a989ede");
    eq("vectores: ObjectUpdate color cara 5", o.faces[5].color, 0xff8000);
    near("vectores: ObjectUpdate brillo cara 5", o.faces[5].glow, 13 / 255, 1e-3);
    eq("vectores: ObjectUpdate cara 0 transparente", o.faces[0].alpha, 0);
    eq("vectores: ObjectUpdate luminosidad cara 5", o.faces[5].fb, 1);
    const rec = primRecord(o, null);
    eq("vectores: ObjectUpdate forma del registro", rec.shape, "box");
    nearArr("vectores: ObjectUpdate posicion visor", rec.position, [-135.8955, -5.5625, 130.6123], 1e-2);
  }

  // --- ObjectUpdateCompressed (High/13): tres prims ------------------------
  {
    const msg = decodificarVector("ObjectUpdateCompressed");
    eq("vectores: comprimido nombre", msg.name, "ObjectUpdateCompressed");
    const objs = decodeObjectUpdateCompressed(msg);
    eq("vectores: comprimido objetos", objs.length, 3);
    const o = objs[0];
    eq("vectores: comprimido id local", o.localId, 564997821);
    eq("vectores: comprimido uuid", o.uuid, "bb882ae6-5e9d-5abf-f41b-bb5202de83a6");
    eq("vectores: comprimido forma", o.shape, "cylinder");
    eq("vectores: comprimido material", o.material, 3);
    nearArr("vectores: comprimido escala", o.scale, [0.080181, 0.016994, 0.087419], 1e-5);
    nearArr("vectores: comprimido posicion SL", o.position, [4.23154, 2.26316, 3999.104], 1e-2);
    eq("vectores: comprimido caras", o.faces.length, 3);
    eq("vectores: comprimido textura cara 0", o.faces[0].tex.a, "11e52d4a-289f-b628-929d-519618f6a5d2");
    eq("vectores: comprimido textura cara 1", o.faces[1].tex.a, "5a3178b2-a7c5-ad42-faeb-ed8b289604a7");
    eq("vectores: comprimido extra params", o.extraParams.length, 1);
    eqJson("vectores: comprimido malla", [o.extraParams[0].name, o.extraParams[0].length, o.extraParams[0].meshType],
      ["MESH", 17, 54]);
    eq("vectores: comprimido uuid de malla", o.extraParams[0].uuid, "63507387-a885-15fe-1cd1-67c1ab076205");
    eq("vectores: comprimido forma 1", objs[1].shape, "torus");
    nearArr("vectores: comprimido posicion 1", objs[1].position, [128, 128, 1000], 1e-2);
    eq("vectores: comprimido forma 2", objs[2].shape, "sphere");
    eq("vectores: comprimido caras 2", objs[2].faces.length, 6);
  }

  // --- ObjectUpdateCached (High/14): 34 referencias -----------------------
  {
    const msg = decodificarVector("ObjectUpdateCached");
    eq("vectores: cacheado nombre", msg.name, "ObjectUpdateCached");
    const lista = decodeObjectUpdateCached(msg);
    eq("vectores: cacheado cuenta", lista.length, 34);
    eqJson("vectores: cacheado primero",
      [lista[0].localId, lista[0].crc, lista[0].flags], [544846227, 19198, 268599504]);
    eqJson("vectores: cacheado ultimo",
      [lista[33].localId, lista[33].crc, lista[33].flags], [549888095, 78, 268568784]);
  }

  // --- ImprovedTerseObjectUpdate (High/15): 12 bloques --------------------
  {
    const msg = decodificarVector("ImprovedTerseObjectUpdate");
    eq("vectores: terse nombre", msg.name, "ImprovedTerseObjectUpdate");
    const ts = decodeImprovedTerseObjectUpdate(msg);
    eq("vectores: terse bloques", ts.length, 12);
    ok("vectores: terse cuaterniones unitarios",
      ts.every((t) => Math.abs(Math.hypot(...t.quaternion) - 1) < 1e-3));
    const t = ts[0];
    eq("vectores: terse id local", t.localId, 637579600);
    nearArr("vectores: terse posicion", t.position, [226.75235, 226.0959, 127.55928], 1e-2);
    nearArr("vectores: terse cuaternion", t.quaternion, [0, 0, -0.923888, 0.382681], 1e-3);
    eq("vectores: terse caras", t.faces.length, 6);
    eq("vectores: terse textura cara 0", t.faces[0].tex.a, "4a00bb5c-1fb3-927c-8126-211dfa646b78");
    eq("vectores: terse color cara 4", t.faces[4].color, 1703936);
  }

  // --- KillObject (High/16) ----------------------------------------------
  {
    const msg = decodificarVector("KillObject");
    eq("vectores: borrado nombre", msg.name, "KillObject");
    eqJson("vectores: borrado ids", decodeKillObject(msg),
      [579538094, 579538095, 579538098, 579538099, 579564526, 579564527]);
  }

  return { checks, passed, fails };
}
