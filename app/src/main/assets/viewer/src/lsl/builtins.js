// Biblioteca estandar del mini-LSL.
//
// Cada funcion recibe `(inst, args, node)` y devuelve un valor de LSL. Todo lo
// que toca el mundo pasa por `inst.host`, que es el unico puente entre el
// sandbox y el visor (a proposito: aqui no hay `fetch`, ni `document`, ni
// `window`). Las funciones que LSL tiene pero este visor no puede dar (red,
// llSleep, rezar objetos...) existen igualmente y avisan por la consola en vez
// de romper el script, para que un script real se pueda pegar y ejecutar.

import {
  Vec, Rot, isList, isVec, isRot, toLslString, toLslInteger, toLslFloat,
  listInsert, vecLen, vecNorm, vecDist, rotBetween, rotFromEuler, rotToEuler,
  rotAxisAngle, rotAngle, rotAxis, rotateVec,
} from "./values.js";
import { toVector, toRotation } from "./interp.js";
import { LslRuntimeError } from "./errors.js";

const I = (v) => toLslInteger(v);
const F = (v) => toLslFloat(v);
const S = (v) => toLslString(v);
const L = (v) => (isList(v) ? v : listInsert([], v));
const V = (v, n) => toVector(v, n && n.line, 1);
const R = (v, n) => toRotation(v, n && n.line, 1);

export function buildBuiltins() {
  const b = Object.create(null);
  const def = (name, fn) => { b[name] = fn; };
  const alias = (name, target) => { b[name] = b[target]; };

  // --- chat ------------------------------------------------------------------
  // `host.say(kind, channel, message)` decide el alcance (susurro/grito/region)
  // y lo pinta en la consola del visor. La distancia se filtra en el runtime.
  def("llSay", (inst, a) => { inst.host.say("say", I(a[0]), S(a[1])); return 0; });
  def("llWhisper", (inst, a) => { inst.host.say("whisper", I(a[0]), S(a[1])); return 0; });
  def("llShout", (inst, a) => { inst.host.say("shout", I(a[0]), S(a[1])); return 0; });
  def("llOwnerSay", (inst, a) => { inst.host.say("owner", 0, S(a[0])); return 0; });
  def("llRegionSay", (inst, a) => { inst.host.say("region", I(a[0]), S(a[1])); return 0; });
  def("llRegionSayTo", (inst, a) => { inst.host.say("region", I(a[1]), S(a[2])); return 0; });
  def("llInstantMessage", (inst, a) => { inst.host.say("im", 0, S(a[1])); return 0; });

  // --- texto flotante sobre el prim -----------------------------------------
  def("llSetText", (inst, a, n) => {
    inst.host.setText(S(a[0]), a.length > 1 ? V(a[1], n) : new Vec(1, 1, 1), a.length > 2 ? F(a[2]) : 1);
    return 0;
  });
  // llSetText con "" borra el texto, como en SL.
  def("llGetText", (inst) => inst.host.getText());

  // --- transformadas ---------------------------------------------------------
  def("llGetPos", (inst) => inst.host.getPos());
  def("llSetPos", (inst, a, n) => { inst.host.setPos(V(a[0], n)); return 0; });
  def("llGetLocalPos", (inst) => inst.host.getLocalPos());
  def("llSetLocalPos", (inst, a, n) => { inst.host.setLocalPos(V(a[0], n)); return 0; });
  def("llGetRot", (inst) => inst.host.getRot());
  def("llSetRot", (inst, a, n) => { inst.host.setRot(R(a[0], n)); return 0; });
  alias("llRotate", "llSetRot");
  def("llGetLocalRot", (inst) => inst.host.getLocalRot());
  def("llSetLocalRot", (inst, a, n) => { inst.host.setLocalRot(R(a[0], n)); return 0; });
  def("llGetScale", (inst) => inst.host.getScale());
  def("llTargetOmega", (inst, a, n) => { inst.host.targetOmega(V(a[0], n), F(a[1]), F(a[2]), null); return 0; });
  def("llSetScale", (inst, a, n) => { inst.host.setScale(V(a[0], n)); return 0; });
  def("llGetVel", () => new Vec(0, 0, 0));
  def("llGetOmega", () => new Vec(0, 0, 0));
  def("llMoveToTarget", (inst, a, n) => { inst.host.warn("llMoveToTarget no está soportado"); return 0; });
  def("llStopMoveToTarget", () => 0);

  // --- color, textura y parametros por cara ---------------------------------
  def("llSetColor", (inst, a, n) => { inst.host.setFace(a[1], { color: V(a[0], n) }); return 0; });
  def("llSetAlpha", (inst, a) => { inst.host.setFace(a[1], { alpha: F(a[0]) }); return 0; });
  def("llSetLinkColor", (inst, a, n) => { inst.host.setFace(a[2], { color: V(a[1], n) }, a[0]); return 0; });
  def("llSetLinkAlpha", (inst, a) => { inst.host.setFace(a[2], { alpha: F(a[1]) }, a[0]); return 0; });
  def("llSetTexture", (inst, a) => { inst.host.setFace(a[1], { pattern: S(a[0]) }); return 0; });
  def("llSetLinkTexture", (inst, a) => { inst.host.setFace(a[2], { pattern: S(a[1]) }, a[0]); return 0; });
  def("llSetPrimitiveParams", (inst, a) => { applyParamList(inst, a[0], null); return 0; });
  def("llSetLinkPrimitiveParams", (inst, a) => { applyParamList(inst, a[1], I(a[0])); return 0; });
  def("llSetLinkPrimitiveParamsFast", (inst, a) => { applyParamList(inst, a[1], I(a[0])); return 0; });
  def("llGetPrimitiveParams", (inst, a) => getParamList(inst, a[0]));
  def("llGetLinkPrimitiveParams", (inst, a) => getParamList(inst, a[1], I(a[0])));

  // --- nombre / descripcion --------------------------------------------------
  def("llGetObjectName", (inst) => inst.host.getObjectName());
  def("llSetObjectName", (inst, a) => { inst.host.setObjectName(S(a[0])); return 0; });
  def("llGetObjectDesc", (inst) => inst.host.getObjectDesc());
  def("llSetObjectDesc", (inst, a) => { inst.host.setObjectDesc(S(a[0])); return 0; });
  def("llGetObjectPrimCount", (inst) => inst.host.linkSet().length);
  def("llGetNumberOfPrims", (inst) => inst.host.linkSet().length);

  // --- identidad -------------------------------------------------------------
  def("llGetKey", (inst) => inst.host.primKey());
  def("llGetOwner", (inst) => inst.host.ownerKey());
  def("llGetOwnerKey", (inst, a) => inst.host.ownerKey());
  def("llGetCreator", (inst) => inst.host.ownerKey());
  def("llGetLinkKey", (inst, a) => inst.host.linkKey(I(a[0])));
  def("llGetLinkNumber", (inst) => inst.host.linkNumber());
  def("llGetLinkName", (inst, a) => inst.host.linkName(I(a[0])));
  def("llGetRegionName", () => "Perchance");
  def("llGetRegionFPS", () => 60);
  def("llGetSimulatorHostname", () => "perchance.org");
  def("llGetInventoryName", () => "");
  def("llGetInventoryNumber", () => 0);
  def("llGetInventoryKey", () => "00000000-0000-0000-0000-000000000000");

  // --- temporizadores --------------------------------------------------------
  def("llSetTimerEvent", (inst, a) => { inst.timer.interval = Math.max(0, F(a[0])); inst.timer.acc = 0; inst.host.onTimerChanged(); return 0; });
  def("llGetTimerEvent", (inst) => inst.timer.interval);
  def("llSleep", () => { throw new LslRuntimeError("llSleep no está disponible en el sandbox (usa llSetTimerEvent)"); });
  def("llResetScript", (inst) => { inst.host.resetScript(); return 0; });

  // --- tiempo ----------------------------------------------------------------
  def("llGetTime", (inst) => inst.host.time());
  def("llResetTime", (inst) => { inst.host.resetTime(); return 0; });
  def("llGetAndResetTime", (inst) => { const t = inst.host.time(); inst.host.resetTime(); return t; });
  def("llGetWallclock", () => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(); });
  def("llGetDate", () => { const d = new Date(); return d.toISOString().slice(0, 10); });
  def("llGetTimestamp", () => new Date().toISOString().replace("T", " ").replace("Z", ""));
  def("llGetUnixTime", () => Math.floor(Date.now() / 1000));

  // --- escucha ---------------------------------------------------------------
  def("llListen", (inst, a) => {
    const rule = {
      handle: inst.nextListenHandle++,
      channel: I(a[0]),
      name: S(a[1]).toLowerCase(),
      id: S(a[2]),
      message: S(a[3]).toLowerCase(),
      active: true,
    };
    inst.listeners.push(rule);
    inst.host.onListenersChanged();
    return rule.handle;
  });
  def("llListenRemove", (inst, a) => {
    const h = I(a[0]);
    const i = inst.listeners.findIndex((l) => l.handle === h);
    if (i >= 0) { inst.listeners.splice(i, 1); inst.host.onListenersChanged(); }
    return 0;
  });
  def("llListenControl", (inst, a) => {
    const h = I(a[0]);
    const l = inst.listeners.find((x) => x.handle === h);
    if (l) { l.active = !!I(a[1]); inst.host.onListenersChanged(); }
    return 0;
  });
  def("llListenRemoveAll", (inst) => { inst.listeners.length = 0; inst.host.onListenersChanged(); return 0; });

  // --- matematicas -----------------------------------------------------------
  def("llFrand", (inst, a) => F(a[0]) * Math.random());
  def("llSin", (inst, a) => Math.sin(F(a[0])));
  def("llCos", (inst, a) => Math.cos(F(a[0])));
  def("llTan", (inst, a) => Math.tan(F(a[0])));
  def("llAsin", (inst, a) => Math.asin(F(a[0])));
  def("llAcos", (inst, a) => Math.acos(F(a[0])));
  def("llAtan2", (inst, a) => Math.atan2(F(a[0]), F(a[1])));
  def("llSqrt", (inst, a) => Math.sqrt(F(a[0])));
  def("llPow", (inst, a) => Math.pow(F(a[0]), F(a[1])));
  def("llLog", (inst, a) => Math.log(F(a[0])));
  def("llLog10", (inst, a) => Math.log10(F(a[0])));
  def("llFloor", (inst, a) => Math.floor(F(a[0])));
  def("llCeil", (inst, a) => Math.ceil(F(a[0])));
  def("llRound", (inst, a) => Math.round(F(a[0])));
  def("llFabs", (inst, a) => Math.abs(F(a[0])));
  def("llAbs", (inst, a) => Math.abs(I(a[0])));
  def("llModPow", (inst, a) => { let r = 1, x = I(a[0]) % I(a[2]), e = I(a[1]), m = I(a[2]); while (e > 0) { if (e & 1) r = (r * x) % m; x = (x * x) % m; e >>= 1; } return r; });
  def("llMin", (inst, a) => Math.min(F(a[0]), F(a[1])));
  def("llMax", (inst, a) => Math.max(F(a[0]), F(a[1])));

  // --- vectores y rotaciones -------------------------------------------------
  def("llVecMag", (inst, a, n) => vecLen(V(a[0], n)));
  def("llVecNorm", (inst, a, n) => vecNorm(V(a[0], n)));
  def("llVecDist", (inst, a, n) => { const v = V(a[0], n); if (isVec(a[1])) return vecDist(v, a[1]); return 0; });
  def("llRotBetween", (inst, a, n) => rotBetween(V(a[0], n), V(a[1], n)));
  def("llEuler2Rot", (inst, a, n) => rotFromEuler(V(a[0], n)));
  def("llRot2Euler", (inst, a, n) => rotToEuler(R(a[0], n)));
  def("llAxisAngle2Rot", (inst, a, n) => rotAxisAngle(V(a[0], n), F(a[1])));
  def("llRot2Axis", (inst, a, n) => rotAxis(R(a[0], n)));
  def("llRot2Angle", (inst, a, n) => rotAngle(R(a[0], n)));
  def("llRot2Fwd", (inst, a, n) => rotateVec(R(a[0], n), new Vec(1, 0, 0)));
  def("llRot2Up", (inst, a, n) => rotateVec(R(a[0], n), new Vec(0, 0, 1)));
  def("llRot2Left", (inst, a, n) => rotateVec(R(a[0], n), new Vec(0, 1, 0)));
  def("llGetRot2Local", () => 0);

  // --- cadenas ---------------------------------------------------------------
  def("llStringLength", (inst, a) => S(a[0]).length);
  def("llGetSubString", (inst, a) => {
    const s = S(a[0]);
    let start = I(a[1]), end = I(a[2]);
    const n = s.length;
    if (start < 0) start = n + start;
    if (end < 0) end = n + end;
    start = Math.max(0, start); end = Math.min(n - 1, end);
    if (end < start) return "";
    return s.slice(start, end + 1);
  });
  def("llSubStringIndex", (inst, a) => S(a[0]).indexOf(S(a[1])));
  def("llToLower", (inst, a) => S(a[0]).toLowerCase());
  def("llToUpper", (inst, a) => S(a[0]).toUpperCase());
  def("llStringTrim", (inst, a) => {
    const s = S(a[0]);
    const f = I(a[1]);
    if (f === 1) return s.replace(/^\s+/, "");
    if (f === 2) return s.replace(/\s+$/, "");
    return s.trim();
  });
  def("llInsertString", (inst, a) => { const s = S(a[0]), p = I(a[1]); return s.slice(0, p) + S(a[2]) + s.slice(p); });
  def("llDeleteSubString", (inst, a) => { const s = S(a[0]); let x = I(a[1]), y = I(a[2]); const n = s.length; if (x < 0) x = n + x; if (y < 0) y = n + y; if (y < x) return s; return s.slice(0, Math.max(0, x)) + s.slice(Math.min(n, y + 1)); });
  def("llReplaceSubString", (inst, a) => S(a[0]).split(S(a[1])).join(S(a[2])));
  def("llEscapeURL", (inst, a) => encodeURIComponent(S(a[0])));
  def("llUnescapeURL", (inst, a) => { try { return decodeURIComponent(S(a[0])); } catch (e) { return S(a[0]); } });
  def("llStringToBase64", (inst, a) => btoa(S(a[0])));
  def("llBase64ToString", (inst, a) => { try { return atob(S(a[0])); } catch (e) { return ""; } });
  def("llMD5String", (inst, a) => "00000000000000000000000000000000");

  // --- listas ----------------------------------------------------------------
  def("llGetListLength", (inst, a) => L(a[0]).length);
  def("llList2String", (inst, a) => { const l = L(a[0]); const i = I(a[1]); return (i < 0 || i >= l.length) ? "" : toLslString(l[i]); });
  def("llList2Key", (inst, a) => { const l = L(a[0]); const i = I(a[1]); return (i < 0 || i >= l.length) ? "" : toLslString(l[i]); });
  def("llList2Integer", (inst, a) => { const l = L(a[0]); const i = I(a[1]); return (i < 0 || i >= l.length) ? 0 : toLslInteger(l[i]); });
  def("llList2Float", (inst, a) => { const l = L(a[0]); const i = I(a[1]); return (i < 0 || i >= l.length) ? 0 : toLslFloat(l[i]); });
  def("llList2Vector", (inst, a, n) => { const l = L(a[0]); const i = I(a[1]); if (i < 0 || i >= l.length) return new Vec(0, 0, 0); if (isVec(l[i])) return l[i]; return toVector(l[i], n.line, 1); });
  def("llList2Rot", (inst, a, n) => { const l = L(a[0]); const i = I(a[1]); if (i < 0 || i >= l.length) return new Rot(0, 0, 0, 1); if (isRot(l[i])) return l[i]; return toRotation(l[i], n.line, 1); });
  def("llList2List", (inst, a) => {
    const l = L(a[0]);
    let x = I(a[1]), y = I(a[2]);
    if (x < 0) x = l.length + x;
    if (y < 0) y = l.length + y;
    return l.slice(Math.max(0, x), Math.min(l.length, y + 1));
  });
  def("llListFindList", (inst, a) => {
    const hay = L(a[0]), needle = L(a[1]);
    if (!needle.length) return -1;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) { if (toLslString(hay[i + j]) !== toLslString(needle[j])) { ok = false; break; } }
      if (ok) return i;
    }
    return -1;
  });
  def("llListInsertList", (inst, a) => {
    const src = L(a[0]).slice(), ins = L(a[1]);
    let p = I(a[2]);
    if (p < 0) p = Math.max(0, src.length + p);
    return src.slice(0, p).concat(ins, src.slice(p));
  });
  def("llListReplaceList", (inst, a) => {
    const src = L(a[0]).slice();
    let start = I(a[2]), end = I(a[3]);
    if (start < 0) start = src.length + start;
    if (end < 0) end = src.length + end;
    start = Math.max(0, start); end = Math.min(src.length - 1, end);
    if (end < start) return src;
    return src.slice(0, start).concat(L(a[1]), src.slice(end + 1));
  });
  def("llDeleteSubList", (inst, a) => {
    const src = L(a[0]).slice();
    let start = I(a[1]), end = I(a[2]);
    if (start < 0) start = src.length + start;
    if (end < 0) end = src.length + end;
    start = Math.max(0, start); end = Math.min(src.length - 1, end);
    if (end < start) return src;
    return src.slice(0, start).concat(src.slice(end + 1));
  });
  def("llListSort", (inst, a) => {
    const src = L(a[0]), stride = Math.max(1, I(a[1])), asc = I(a[2]) !== 0;
    const groups = [];
    for (let i = 0; i < src.length; i += stride) groups.push(src.slice(i, i + stride));
    groups.sort((g1, g2) => {
      for (let i = 0; i < stride; i++) {
        const x = cmpValue(g1[i], g2[i]);
        if (x !== 0) return asc ? x : -x;
      }
      return 0;
    });
    const out = [];
    for (const g of groups) for (const e of g) out.push(e);
    return out;
  });
  def("llList2CSV", (inst, a) => L(a[0]).map((v) => toLslString(v)).join(", "));
  def("llCSV2List", (inst, a) => S(a[0]).split(",").map((x) => x.trim()));
  def("llDumpList2String", (inst, a) => L(a[0]).map((v) => toLslString(v)).join(S(a[1])));
  def("llParseString2List", (inst, a) => parseList(a, false));
  def("llParseStringKeepNulls", (inst, a) => parseList(a, true));
  def("llGetListEntryType", (inst, a) => entryType(L(a[0])[I(a[1])]));

  // --- sensores y deteccion (lo que el visor puede dar) ----------------------
  def("llDetectedKey", (inst, a) => inst.host.detected(I(a[0]), "key"));
  def("llDetectedName", (inst, a) => inst.host.detected(I(a[0]), "name"));
  def("llDetectedPos", (inst, a) => inst.host.detected(I(a[0]), "pos"));
  def("llDetectedType", (inst, a) => inst.host.detected(I(a[0]), "type"));
  def("llDetectedLinkNumber", (inst, a) => inst.host.detected(I(a[0]), "link"));
  def("llDetectedOwner", (inst, a) => inst.host.detected(I(a[0]), "owner"));
  def("llSensor", (inst, a) => { inst.host.sensor(S(a[0]), I(a[2]), F(a[3]), F(a[4])); return 0; });
  def("llSensorRepeat", (inst, a) => { inst.host.warn("llSensorRepeat no está soportado (usa llSensor + timer)"); return 0; });
  def("llSensorRemove", () => 0);

  // --- cosas que LSL tiene pero este visor no puede dar ----------------------
  const unsupported = {
    llGiveInventory: "no hay inventario de usuario",
    llRezObject: "no se pueden rezar objetos desde un script",
    llHTTPRequest: "el sandbox no tiene red",
    llHTTPResponse: "el sandbox no tiene red",
    llEmail: "el sandbox no tiene red",
    llOpenRemoteDataChannel: "el sandbox no tiene red",
    llRequestAgentData: "no hay servicio de perfiles",
    llMapDestination: "no hay mapa",
    llSetPrimMediaParams: "no hay media en las caras",
    llPlaySound: "no hay sonidos subidos",
    llTriggerSound: "no hay sonidos subidos",
    llStartAnimation: "el avatar no tiene animaciones",
    llAttachToAvatar: "no hay inventario del avatar",
    llTakeControls: "no hay controles de entrada desde scripts",
    llDialog: "no hay diálogos de LSL en este visor",
    llTextBox: "no hay diálogos de LSL en este visor",
    llGiveMoney: "no hay economía",
    llSetPayPrice: "no hay economía",
    llAllowInventoryDrop: "no hay inventario",
    llRemoveInventory: "no hay inventario",
    llRequestPermissions: "no hay permisos de LSL en este visor",
  };
  for (const [name, why] of Object.entries(unsupported)) {
    def(name, (inst) => { inst.host.warn(name + "() no está soportado: " + why); return 0; });
  }

  return b;

  // --- helpers ---------------------------------------------------------------

  // llParseString2List / llParseStringKeepNulls con varios separadores.
  function parseList(a, keepNulls) {
    let text = S(a[0]);
    const seps = L(a[1]).map((x) => toLslString(x)).filter((x) => x.length > 0);
    const spars = L(a[2]).map((x) => toLslString(x)).filter((x) => x.length > 0);
    // Los separadores "spacers" se eliminan y no crean celdas.
    for (const sp of spars) text = text.split(sp).join("\u0001");
    let parts;
    if (!seps.length) parts = [text.replace(/\u0001/g, "")];
    else {
      const pattern = seps.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((x, y) => y.length - x.length).join("|");
      parts = text.split(new RegExp(pattern));
    }
    const out = parts.map((p) => p.split("\u0001").join(""));
    return (keepNulls ? out : out.filter((x) => x.length > 0));
  }

  function entryType(v) {
    if (typeof v === "number") return Number.isInteger(v) ? 1 : 2;
    if (typeof v === "string") return 3;
    if (isVec(v)) return 5;
    if (isRot(v)) return 6;
    if (isList(v)) return 0;
    return 0;
  }

  function cmpValue(a, b) {
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
    const sa = toLslString(a), sb = toLslString(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  // --- llSetPrimitiveParams --------------------------------------------------
  // Lista plana de reglas: [REGLA, valores..., REGLA, valores...]. Se aplica
  // sobre el prim objetivo (o el suyo, o el que diga PRIM_LINK_TARGET).
  function applyParamList(inst, rawList, linkTarget) {
    const list = L(rawList);
    let target = linkTarget;
    let i = 0;
    const face = (v) => {
      const f = I(v);
      const n = inst.host.faceCount();
      return (f < 0 || f === -1) ? -1 : Math.max(0, Math.min(n - 1, f));
    };
    while (i < list.length) {
      const rule = I(list[i++]);
      switch (rule) {
        case 6: inst.host.setPos(V(list[i++]), target); break;                 // PRIM_POSITION
        case 33: inst.host.setLocalPos(V(list[i++]), target); break;           // PRIM_POS_LOCAL
        case 7: inst.host.setScale(V(list[i++]), target); break;               // PRIM_SIZE
        case 8: inst.host.setRot(R(list[i++]), target); break;                 // PRIM_ROTATION
        case 29: inst.host.setLocalRot(R(list[i++]), target); break;           // PRIM_ROT_LOCAL
        case 17: {                                                             // PRIM_TEXTURE
          const f = face(list[i++]);
          const key = S(list[i++]);
          const rep = V(list[i++]);
          const off = V(list[i++]);
          const rot = F(list[i++]);
          inst.host.setFace(f, { pattern: key, repeat: [rep.x, rep.y], offset: [off.x, off.y], rotate: rot }, target);
          break;
        }
        case 18: {                                                             // PRIM_COLOR
          const f = face(list[i++]);
          const col = V(list[i++]);
          const alpha = F(list[i++]);
          inst.host.setFace(f, { color: col, alpha }, target);
          break;
        }
        case 20: { const f = face(list[i++]); inst.host.setFace(f, { fullbright: I(list[i++]) !== 0 }, target); break; }
        case 25: { const f = face(list[i++]); inst.host.setFace(f, { glow: F(list[i++]) }, target); break; }
        case 26: {                                                             // PRIM_TEXT
          const text = S(list[i++]);
          const col = V(list[i++]);
          const alpha = F(list[i++]);
          inst.host.setText(text, col, alpha, target);
          break;
        }
        case 27: inst.host.setObjectName(S(list[i++]), target); break;
        case 28: inst.host.setObjectDesc(S(list[i++]), target); break;
        case 5: inst.host.setPhantom(I(list[i++]) !== 0, target); break;
        case 3: inst.host.setPhysics(I(list[i++]) !== 0, target); break;
        case 2: inst.host.setMaterial(I(list[i++]), target); break;
        case 34: target = I(list[i++]); break;                                 // PRIM_LINK_TARGET
        default:
          inst.host.warn("regla PRIM_* desconocida en llSetPrimitiveParams: " + rule);
          return;
      }
    }
  }

  function getParamList(inst, rawList, linkTarget) {
    const list = L(rawList);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const rule = I(list[i]);
      switch (rule) {
        case 6: listInsert(out, inst.host.getPos(linkTarget)); break;
        case 7: listInsert(out, inst.host.getScale(linkTarget)); break;
        case 8: listInsert(out, inst.host.getRot(linkTarget)); break;
        case 18: { const face = I(list[++i]); listInsert(out, inst.host.getFaceColor(linkTarget, face)); break; }
        case 26: { const t = inst.host.getText(linkTarget); listInsert(out, t.text); listInsert(out, t.color); listInsert(out, t.alpha); break; }
        case 27: listInsert(out, inst.host.getObjectName(linkTarget)); break;
        case 28: listInsert(out, inst.host.getObjectDesc(linkTarget)); break;
        default: listInsert(out, 0); break;
      }
    }
    return out;
  }
}
