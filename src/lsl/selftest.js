// Selftest del mini-LSL. Se ejecuta en el propio visor (o en un worker con los
// modulos ya resueltos) y comprueba sintaxis, tipos, operadores, control de
// flujo, funciones, estados, eventos, errores y el presupuesto del sandbox.
//
// El "host" del test es un Proxy que apunta cada llamada: asi no hace falta
// simular medio visor y ademas queda registrado lo que el script pidio.

import { compile, tryCompile, describeError } from "./index.js";
import { Vec, Rot } from "./values.js";

function recordingHost() {
  const calls = [];
  const prim = { name: "Prim de prueba", id: 7 };
  const known = {
    prim,
    say: (kind, ch, msg) => { calls.push(["say", kind, ch, msg]); },
    setText: (t, c, a) => { calls.push(["text", t, a]); },
    getText: () => ({ text: "", color: new Vec(1, 1, 1), alpha: 1 }),
    getPos: () => new Vec(128, 128, 25),
    setPos: (v) => { calls.push(["setPos", v.x, v.y, v.z]); },
    getLocalPos: () => new Vec(0, 0, 0),
    setLocalPos: () => {},
    getRot: () => new Rot(0, 0, 0, 1),
    setRot: (r) => { calls.push(["setRot", r.x, r.y, r.z, r.s]); },
    getLocalRot: () => new Rot(0, 0, 0, 1),
    setLocalRot: () => {},
    getScale: () => new Vec(1, 1, 1),
    setScale: (v) => { calls.push(["setScale", v.x, v.y, v.z]); },
    setFace: (face, patch) => { calls.push(["setFace", face, JSON.stringify(patch)]); },
    getFaceColor: () => new Vec(1, 1, 1),
    faceCount: () => 6,
    getObjectName: () => "Prim de prueba",
    setObjectName: (n) => { calls.push(["name", n]); },
    getObjectDesc: () => "",
    setObjectDesc: () => {},
    setPhantom: () => {}, setPhysics: () => {}, setMaterial: () => {},
    primKey: () => "00000000-0000-0000-0000-000000000007",
    ownerKey: () => "11111111-1111-1111-1111-111111111111",
    linkSet: () => [prim],
    linkNumber: () => 0,
    linkKey: () => "00000000-0000-0000-0000-000000000007",
    linkName: () => "Prim de prueba",
    time: () => 0, resetTime: () => {},
    onTimerChanged: () => {}, onListenersChanged: () => {}, onStateChanged: () => {},
    resetScript: () => { calls.push(["resetScript"]); },
    warn: (m) => { calls.push(["warn", m]); },
    detected: (i, what) => (what === "pos" ? new Vec(0, 0, 0) : what === "type" || what === "link" ? 0 : ""),
    sensor: () => {},
    onError: (err) => { calls.push(["error", err.message]); },
  };
  const proxy = new Proxy(known, {
    get(t, k) {
      if (k in t) return t[k];
      return (...args) => { calls.push([String(k), ...args.map((a) => (a instanceof Vec || a instanceof Rot ? JSON.stringify(a) : a))]); return 0; };
    },
  });
  return { host: proxy, calls, prim };
}

export function runLslSelfTest() {
  const checks = [];
  let passed = 0;
  let failed = 0;
  const fail = (name, detail) => { checks.push({ name, ok: false, detail }); failed++; };
  const ok = (name) => { checks.push({ name, ok: true }); passed++; };

  function run(src, events = [{ name: "state_entry", args: [] }]) {
    const { host, calls, prim } = recordingHost();
    let interp;
    try {
      interp = compile(src);
    } catch (e) {
      return { compileError: describeError(e), calls, prim, inst: null };
    }
    const inst = interp.createInstance(host);
    prim.lsl = { inst, interp, source: src };
    const results = [];
    for (const ev of events) {
      results.push(interp.dispatch(inst, ev.name, ev.args || []));
    }
    return { inst, interp, calls, prim, results };
  }

  function eq(name, got, want) {
    if (JSON.stringify(got) === JSON.stringify(want)) ok(name);
    else fail(name, "esperaba " + JSON.stringify(want) + " y salió " + JSON.stringify(got));
  }
  // Mensaje del ultimo error de ejecucion (o un aviso si no hubo ninguno).
  function lastErr(r) {
    const e = r.inst && r.inst.lastError;
    return e ? e.message : "<sin error: llamadas=" + JSON.stringify(r.calls) + ">";
  }
  function hasErr(name, src, fragment, events) {
    const r = run(src, events);
    const m = lastErr(r);
    if (m.indexOf(fragment) >= 0) ok(name);
    else fail(name, "esperaba un error con '" + fragment + "' y salió: " + m);
    return r;
  }
  // El resultado de un `llSay`/`llOwnerSay` es "kind/channel/mensaje"; estos
  // atajos evitan reventar cuando un script no dice nada (o no compila) y dan
  // un diagnostico util en su lugar.
  function nSay(r, i = 0) {
    const s = r.calls.filter((c) => c[0] === "say");
    if (s[i]) return s[i][3];
    return "<sin salida>" + (r.compileError ? " no compila: " + r.compileError.message + " (línea " + r.compileError.line + ")" : " llamadas=" + JSON.stringify(r.calls));
  }
  function said(name, src, want, evName = "state_entry") {
    const r = run(src, [{ name: evName, args: [1] }]);
    if (r.compileError) return fail(name, "no compila: " + r.compileError.message + " (línea " + r.compileError.line + ")");
    eq(name, nSay(r), want);
  }

  // --- sintaxis y compilacion ------------------------------------------------
  const bad = tryCompile("integer x = 1;");
  if (!bad.ok && bad.error.kind === "syntax") ok("sin estado default no compila"); else fail("sin estado default no compila", JSON.stringify(bad.error));
  eq("el error de sintaxis trae linea", tryCompile("default { state_entry() { integer x = ; } }").error.line, 1);
  eq("llave sin cerrar da error", tryCompile("default { state_entry() { }").error.kind, "syntax");
  eq("jump no soportado", tryCompile("default { state_entry() { jump oops; } }").error.message.indexOf("jump") >= 0, true);
  eq("comentarios /* anidados */ y //", tryCompile("/* a /* b */ c */ default{state_entry(){/*x*/}}").ok, true);
  eq("enteros hexadecimales", nSay(run("default{state_entry(){ llSay(0,(string)0xFF); }}")), "255");

  // --- aritmetica y tipos ----------------------------------------------------
  said("precedencia", "default{state_entry(){ llSay(0,(string)(2+3*4)); }}", "14");
  said("parentesis", "default{state_entry(){ llSay(0,(string)((2+3)*4)); }}", "20");
  said("division entera", "default{state_entry(){ llSay(0,(string)(7/2)); }}", "3");
  said("float con seis decimales", "default{state_entry(){ llSay(0,(string)1.5); }}", "1.500000");
  said("modulo", "default{state_entry(){ llSay(0,(string)(17%5)); }}", "2");
  said("modulo float", "default{state_entry(){ llSay(0,(string)(5.5%2.0)); }}", "1.500000");
  said("cast a entero de string", "default{state_entry(){ llSay(0,(string)((integer)\"42\" + 1)); }}", "43");
  said("cast a float de string", "default{state_entry(){ llSay(0,(string)(float)\"3.5\"); }}", "3.500000");
  said("concatenacion de cadenas", "default{state_entry(){ llSay(0,\"a\"+\"b\"+(string)3); }}", "ab3");
  said("bool de comparacion", "default{state_entry(){ llSay(0,(string)(3>2)); }}", "1");
  said("y logico con cortocircuito", "default{state_entry(){ llSay(0,(string)(0 && 1/0)); }}", "0");
  said("negacion", "default{state_entry(){ llSay(0,(string)!0); }}", "1");
  said("bit a bit", "default{state_entry(){ llSay(0,(string)(6 & 3)); }}", "2");
  said("desplazamiento", "default{state_entry(){ llSay(0,(string)(1 << 4)); }}", "16");

  // --- vectores y rotaciones -------------------------------------------------
  said("suma de vectores", "default{state_entry(){ llSay(0,(string)(<1,2,3>+<10,20,30>)); }}", "<11.000000, 22.000000, 33.000000>");
  said("producto escalar", "default{state_entry(){ llSay(0,(string)(<1,2,3>*<4,5,6>)); }}", "32");
  said("producto vectorial", "default{state_entry(){ llSay(0,(string)(<1,0,0>%<0,1,0>)); }}", "<0.000000, 0.000000, 1.000000>");
  said("escalado de vector", "default{state_entry(){ llSay(0,(string)(<1,2,3>*2)); }}", "<2.000000, 4.000000, 6.000000>");
  said("rotar un vector 90 grados", "default{state_entry(){ rotation r = llEuler2Rot(<0,0,90>*DEG_TO_RAD); vector v = r*<1,0,0>; llSay(0,(string)llRound(v.y)); }}", "1");
  said("llVecMag", "default{state_entry(){ llSay(0,(string)llVecMag(<3,4,0>)); }}", "5");
  said("llVecNorm", "default{state_entry(){ llSay(0,(string)llVecNorm(<0,0,5>)); }}", "<0.000000, 0.000000, 1.000000>");
  said("llVecDist", "default{state_entry(){ llSay(0,(string)llVecDist(<0,0,0>,<1,2,2>)); }}", "3");
  const euler = run("default{state_entry(){ vector e = <10,20,30>*DEG_TO_RAD; rotation r = llEuler2Rot(e); vector b = llRot2Euler(r); llSay(0,(string)llRound(b.y*RAD_TO_DEG)); }}");
  eq("llEuler2Rot/llRot2Euler ida y vuelta", nSay(euler), "20");
  said("componente de vector", "default{state_entry(){ vector v = <1,2,3>; llSay(0,(string)v.z); }}", "3");
  said("escribir componente", "default{state_entry(){ vector v; v.y = 7.0; llSay(0,(string)v.y); }}", "7");

  // --- listas ----------------------------------------------------------------
  said("longitud de lista", "default{state_entry(){ list l = [1,2,3]; llSay(0,(string)llGetListLength(l)); }}", "3");
  said("sumar listas", "default{state_entry(){ list l = [1,2]+[3]; llSay(0,(string)llGetListLength(l)); }}", "3");
  said("insertar lista dentro de lista la aplana", "default{state_entry(){ list l = [1, [2,3]]; llSay(0,(string)llGetListLength(l)); }}", "3");
  said("list2string", "default{state_entry(){ list l = [1, \"b\"]; llSay(0,llList2String(l,1)); }}", "b");
  said("list2vector", "default{state_entry(){ list l = [<1,2,3>]; llSay(0,(string)llList2Vector(l,0)); }}", "<1.000000, 2.000000, 3.000000>");
  said("find en lista", "default{state_entry(){ list l = [4,5,6,7]; llSay(0,(string)llListFindList(l,[6,7])); }}", "2");
  said("ordenar lista", "default{state_entry(){ list l = llListSort([3,1,2],1,TRUE); llSay(0,llList2CSV(l)); }}", "1, 2, 3");
  said("borrar trozo de lista", "default{state_entry(){ list l = llDeleteSubList([1,2,3,4],1,2); llSay(0,llList2CSV(l)); }}", "1, 4");
  said("CSV a lista", "default{state_entry(){ list l = llCSV2List(\"a, b, c\"); llSay(0,(string)llGetListLength(l)); }}", "3");
  said("escribir en lista", "default{state_entry(){ list l = [1,2,3]; l[1] = 9; llSay(0,llList2CSV(l)); }}", "1, 9, 3");
  said("leer de lista", "default{state_entry(){ list l = [1,2,3]; llSay(0,(string)l[2]); }}", "3");

  // --- cadenas ---------------------------------------------------------------
  said("longitud de cadena", "default{state_entry(){ llSay(0,(string)llStringLength(\"hola\")); }}", "4");
  said("subcadena", "default{state_entry(){ llSay(0,llGetSubString(\"perchance\",0,3)); }}", "perc");
  said("subcadena negativa", "default{state_entry(){ llSay(0,llGetSubString(\"perchance\",-4,-1)); }}", "ance");
  said("indice de subcadena", "default{state_entry(){ llSay(0,(string)llSubStringIndex(\"hola mundo\",\"mundo\")); }}", "5");
  said("minusculas", "default{state_entry(){ llSay(0,llToLower(\"HOLA\")); }}", "hola");
  said("trim", "default{state_entry(){ llSay(0,\"[\"+llStringTrim(\"  x  \",0)+\"]\"); }}", "[x]");
  said("reemplazar", "default{state_entry(){ llSay(0,llReplaceSubString(\"a-b-c\",\"-\",\"+\")); }}", "a+b+c");
  said("llDumpList2String", "default{state_entry(){ llSay(0,llDumpList2String([1,2,3],\"|\")); }}", "1|2|3");

  // --- control de flujo, funciones y variables globales ----------------------
  said("bucle for", "default{state_entry(){ integer s = 0; integer i; for(i=0;i<5;i++){ s = s + i; } llSay(0,(string)s); }}", "10");
  said("bucle while con continue", "default{state_entry(){ integer s=0; integer i=0; while(i<10){ i++; if(i%2==0){ continue; } s = s + i; } llSay(0,(string)s); }}", "25");
  said("do-while", "default{state_entry(){ integer i = 5; do { llSay(0,\"x\"); i++; } while(i<5); }}", "x");
  said("break", "default{state_entry(){ integer i=0; while(1){ i++; if(i>3){ break; } } llSay(0,(string)i); }}", "4");
  said("funcion con parametros", "integer suma(integer a, integer b){ return a+b; } default{state_entry(){ llSay(0,(string)suma(2,3)); }}", "5");
  said("recursion", "integer fact(integer n){ if(n<=1){ return 1; } return n*fact(n-1); } default{state_entry(){ llSay(0,(string)fact(5)); }}", "120");
  said("la variable local no pisa la global", "integer x = 1; default{state_entry(){ integer x = 9; llSay(0,(string)x); }}", "9");
  said("el global persiste entre eventos",
    "integer n = 0; default{ state_entry(){ n = 5; } touch_start(integer d){ llSay(0,(string)(n+1)); } }",
    "6", "touch_start");
  said("ternario", "default{state_entry(){ integer x = 3; llSay(0,(string)(x>2 ? 100 : 200)); }}", "100");
  said("asignacion compuesta", "default{state_entry(){ integer x = 3; x += 4; x *= 2; llSay(0,(string)x); }}", "14");
  said("if/else encadenado", "default{state_entry(){ integer x=2; if(x==1){ llSay(0,\"uno\"); } else if(x==2){ llSay(0,\"dos\"); } else { llSay(0,\"otro\"); } }}", "dos");
  said("cadena en if", "default{state_entry(){ string s = \"x\"; if(s){ llSay(0,\"si\"); } }}", "si");

  // --- eventos ---------------------------------------------------------------
  const touch = run("default{ touch_start(integer n){ llSay(0,\"tocado \"+(string)n); } }", [{ name: "touch_start", args: [1] }]);
  eq("touch_start recibe el argumento", nSay(touch), "tocado 1");
  const entryFirst = run("default{ state_entry(){ llSay(0,\"entrada\"); } touch_start(integer n){ llSay(0,\"toque\"); } }", [{ name: "touch_start", args: [1] }]);
  eq("state_entry corre antes del primer evento", [nSay(entryFirst, 0), nSay(entryFirst, 1)], ["entrada", "toque"]);

  // --- estados ---------------------------------------------------------------
  const st = run(`integer n = 0;
default { state_entry(){ n = 1; } touch_start(integer d){ state dos; } }
state dos { state_entry(){ llSay(0, "estado dos, n=" + (string)n); llSetTimerEvent(2.0); } }`,
  [{ name: "touch_start", args: [1] }]);
  eq("state_entry del estado nuevo y las globales siguen", nSay(st), "estado dos, n=1");
  eq("al cambiar de estado el timer anterior se limpia", st.inst.timer.interval, 2.0);
  const stBad = run("default{ state_entry(){ state inexistente; } }");
  eq("cambiar a un estado que no existe da error", lastErr(stBad).indexOf("desconocido") >= 0, true);

  // --- listeners -------------------------------------------------------------
  const li = run("default{ state_entry(){ llListen(3,\"\",NULL_KEY,\"\"); } }");
  eq("llListen registra el canal", li.inst.listeners[0].channel, 3);
  eq("llListenRemove quita el listener", (() => {
    const r = run("default{ state_entry(){ integer h = llListen(3,\"\",NULL_KEY,\"\"); llListenRemove(h); } }");
    return r.inst.listeners.length;
  })(), 0);

  // --- timers ----------------------------------------------------------------
  const tm = run("default{ state_entry(){ llSetTimerEvent(0.5); } timer(){ llSay(0,\"tic\"); } }");
  eq("llSetTimerEvent guarda el intervalo", tm.inst.timer.interval, 0.5);

  // --- errores de ejecucion (el script no muere) -----------------------------
  const dz = run("default{ state_entry(){ llSay(0,(string)(1/0)); } touch_start(integer n){ llSay(0,\"sigo vivo\"); } }", [{ name: "state_entry", args: [] }, { name: "touch_start", args: [1] }]);
  eq("division por cero se reporta", lastErr(dz).indexOf("división") >= 0, true);
  eq("tras el error el script sigue vivo", dz.calls.some((c) => c[3] === "sigo vivo"), true);
  hasErr("variable no definida", "default{ state_entry(){ llSay(0,(string)noExiste); } }", "no definida");
  hasErr("funcion no definida", "default{ state_entry(){ llNoExiste(1); } }", "no definida");
  hasErr("indice fuera de rango", "default{ state_entry(){ list l=[1,2]; integer x = l[9]; } }", "fuera de rango");

  // --- sandbox ---------------------------------------------------------------
  hasErr("bucle infinito cortado por presupuesto", "default{ state_entry(){ while(1){ } } }", "presupuesto");
  const inf = run("default{ state_entry(){ while(1){ } } }");
  eq("el presupuesto no deja el script muerto", inf.inst.dead, false);
  hasErr("recursion infinita cortada", "integer f(integer n){ return f(n+1); } default{ state_entry(){ f(0); } }", "recursi");
  hasErr("llSleep avisa de que no existe", "default{ state_entry(){ llSleep(1.0); } }", "llSleep");

  // --- integracion con el host (llamadas al visor) ---------------------------
  const host = run("default{ state_entry(){ llSetText(\"hola\", <1,0,0>, 1.0); llSetPos(<128,128,30>); llSetColor(<1,0,0>, ALL_SIDES); } }");
  eq("llSetText llega al visor", host.calls.some((c) => c[0] === "text" && c[1] === "hola"), true);
  eq("llSetPos llega al visor", host.calls.some((c) => c[0] === "setPos" && c[3] === 30), true);
  eq("llSetColor con ALL_SIDES llega como cara -1", host.calls.some((c) => c[0] === "setFace" && c[1] === -1), true);
  const params = run("default{ state_entry(){ llSetLinkPrimitiveParamsFast(LINK_THIS, [PRIM_COLOR, ALL_SIDES, <0,1,0>, 0.5, PRIM_GLOW, ALL_SIDES, 0.4]); } }");
  eq("PRIM_COLOR viaja con alfa", params.calls.some((c) => c[0] === "setFace" && c[2].indexOf("\"alpha\":0.5") >= 0), true);
  eq("PRIM_GLOW viaja", params.calls.some((c) => c[0] === "setFace" && c[2].indexOf("\"glow\":0.4") >= 0), true);
  const tex = run("default{ state_entry(){ llSetTexture(\"oro\", 0); } }");
  eq("llSetTexture pasa el patron", tex.calls.some((c) => c[0] === "setFace" && c[2].indexOf("oro") >= 0), true);
  const uns = run("default{ state_entry(){ llHTTPRequest(\"http://x\", [], \"\"); } }");
  eq("lo no soportado avisa en vez de romper", uns.calls.some((c) => c[0] === "warn" && c[1].indexOf("no está soportado") >= 0), true);

  // --- formato y utilitarios -------------------------------------------------
  said("llRound", "default{state_entry(){ llSay(0,(string)llRound(2.6)); }}", "3");
  said("llFloor de negativo", "default{state_entry(){ llSay(0,(string)llFloor(-1.5)); }}", "-2");
  said("llFrand dentro de rango", "default{state_entry(){ float r = llFrand(10); if(r>=0 && r<10){ llSay(0,\"ok\"); } }}", "ok");
  said("llSubStringIndex sin coincidencia", "default{state_entry(){ llSay(0,(string)llSubStringIndex(\"abc\",\"z\")); }}", "-1");
  said("NULL_KEY", "default{state_entry(){ llSay(0,NULL_KEY); }}", "00000000-0000-0000-0000-000000000000");
  said("PI", "default{state_entry(){ llSay(0,(string)llRound(PI*100)); }}", "314");

  return {
    passed,
    failed,
    checks,
    summary: "mini-LSL selftest: " + passed + "/" + (passed + failed) + " comprobaciones" + (failed ? " · " + failed + " FALLOS" : " correctas"),
  };
}
