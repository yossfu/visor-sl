// login.js -- inicio de sesion de verdad en Second Life.
//
// El login de SL es una llamada XML-RPC (`login_to_simulator`) a
// `login.agni.lindenlab.com`. La contrasena no viaja en claro: el campo
// `passwd` va como "$1$" + MD5(contrasena) (src/sl/md5.js). La peticion tiene
// que salir por un proxy porque el servidor de Linden Lab no manda cabeceras
// CORS (se usa `super-fetch-plugin`, ver src/VIEWER-REAL.md).
//
// La respuesta trae, ademas de los datos de la cuenta, el resto de la sesion:
// `agent_id`, `session_id`, `secure_session_id`, `circuit_code`, la region de
// destino (`sim_ip`, `sim_port`, `region_x`, `region_y`) y `seed_capability`,
// que es la puerta HTTP a las capabilities de esa region. Con eso, un
// retransmisor (src/sl/relay.js) puede abrir el circuito UDP real.
//
// Aqui solo se habla HTTP: este modulo NO abre el circuito de simulador (eso es
// imposible desde un navegador, ver src/VIEWER-REAL.md). Su trabajo es
// autenticar, normalizar la respuesta y traducir los fallos al castellano.
//
// La contrasena no se guarda ni se escribe en ningun sitio. El unico rastro es
// el hash MD5 que se manda en la peticion (que es exactamente lo que manda
// cualquier visor).

import { toXmlRpc, parseXml, parseNotation, pick, str, num, isBinary } from "./llsd.js";
import { slPasswordHash, md5Hex } from "./md5.js";

// --- grids ------------------------------------------------------------------

export const GRIDS = {
  agni: {
    id: "agni",
    name: "Second Life (grid principal)",
    loginUri: "https://login.agni.lindenlab.com/cgi-bin/login.cgi",
  },
  aditi: {
    id: "aditi",
    name: "Second Life Beta (Aditi)",
    loginUri: "https://login.aditi.lindenlab.com/cgi-bin/login.cgi",
  },
};

export const LOGIN_CHANNEL = "Visor Perchance";
export const LOGIN_VERSION = "0.1.0";

// Lo que se pide en `options`: la lista de la izquierda del visor oficial. Se
// deja corta a proposito (el inventario entero de una cuenta vieja puede ser
// de varios MB de XML).
export const DEFAULT_OPTIONS = [
  "inventory-root",
  "inventory-lib-root",
  "inventory-lib-owner",
  "buddy-list",
  "ui-config",
];

function platform() {
  if (typeof navigator === "undefined") return "Lin";
  const p = String(navigator.platform || "");
  if (/mac/i.test(p)) return "Mac";
  if (/win/i.test(p)) return "Win";
  return "Lin";
}

// Los visores mandan un identificador de maquina estable en `id0`. No hace
// falta que sea el MAC real: basta con que sea el mismo entre sesiones para
// que Linden Lab no lo tome por un equipo nuevo en cada entrada.
export function makeId0(seed) {
  return md5Hex(String(seed || "perchance") + "|" + LOGIN_CHANNEL);
}

// --- nombre -----------------------------------------------------------------
//
// SL acepta "nombre apellido" o el nombre de usuario moderno ("steller.sunshine").
// Devuelve siempre { firstName, lastName }.

export function splitSlName(input) {
  const s = String(input || "").trim().replace(/\s+/g, " ");
  if (!s) return { firstName: "", lastName: "" };
  const sp = s.indexOf(" ");
  if (sp > 0) return { firstName: s.slice(0, sp), lastName: s.slice(sp + 1) };
  const dot = s.indexOf(".");
  if (dot > 0) return { firstName: s.slice(0, dot), lastName: s.slice(dot + 1).replace(/\./g, " ") };
  return { firstName: s, lastName: "" };
}

// --- peticion ---------------------------------------------------------------

export function buildLoginBody(o) {
  const grid = GRIDS[o.grid] || GRIDS.agni;
  const nm = o.firstName !== undefined
    ? { firstName: o.firstName, lastName: o.lastName || "" }
    : splitSlName(o.name);
  const fields = {
    first: nm.firstName,
    last: nm.lastName,
    passwd: o.passwordHash || slPasswordHash(o.password || ""),
    start: o.start || "last",
    channel: o.channel || LOGIN_CHANNEL,
    version: o.version || LOGIN_VERSION,
    platform: o.platform || platform(),
    platform_version: o.platformVersion || "0.0.1",
    mac: o.mac || "00:00:00:00:00:00",
    id0: o.id0 !== undefined ? o.id0 : "",
    agree_to_tos: o.agreeToTos !== false,
    read_critical: o.readCritical !== false,
    options: o.options || DEFAULT_OPTIONS.slice(),
  };
  // Segundo factor (si la cuenta lo tiene activado, el visor oficial lo pide).
  if (o.token) fields.token = String(o.token);
  return toXmlRpc("login_to_simulator", [fields]);
}

// --- lectura de la respuesta ------------------------------------------------

// Un campo que puede venir como cadena, como binario de 4 bytes o como lista de
// numeros (los grids no se ponen de acuerdo con `sim_ip`).
export function ipString(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (isBinary(v)) {
    const b = v.bytes;
    if (b.length === 4) return [b[0], b[1], b[2], b[3]].join(".");
    // Algunos grids mandan la IP como texto dentro de un binario.
    const txt = String.fromCharCode.apply(null, [...b]).trim();
    return /^\d+(\.\d+){3}$/.test(txt) ? txt : undefined;
  }
  if (Array.isArray(v)) {
    const n = v.map((x) => (x && typeof x === "object" && "value" in x ? x.value : x));
    return n.join(".");
  }
  return String(v);
}

function xyz(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") {
    const parts = v.split(",").map((t) => parseFloat(t.trim()));
    return parts.length >= 3 && parts.every((n) => isFinite(n)) ? parts.slice(0, 3) : undefined;
  }
  if (Array.isArray(v) && v.length >= 3) {
    const n = v.slice(0, 3).map((x) => (x && typeof x === "object" && "value" in x ? x.value : parseFloat(x)));
    return n.every((x) => isFinite(x)) ? n : undefined;
  }
  return undefined;
}

// `start_location` viene como "uri:Nombre de region&128&128&25" (o "last"/"home").
export function parseStartLocation(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (s === "last") return { kind: "last" };
  if (s === "home") return { kind: "home" };
  if (s[0] === "{") {
    const m = parseNotation(s);
    return { kind: "uri", region: undefined, position: xyz(m.position), lookAt: xyz(m.look_at) };
  }
  if (/^uri:/i.test(s)) {
    const parts = s.slice(4).split("&");
    const region = decodeURIComponent(parts[0] || "").replace(/\+/g, " ").trim();
    const pos = parts.slice(1).map((t) => parseFloat(t));
    return {
      kind: "uri",
      region,
      position: pos.length >= 3 && pos.every((n) => isFinite(n)) ? pos.slice(0, 3) : null,
    };
  }
  return { kind: "uri", region: decodeURIComponent(s) };
}

// `home` llega como una CADENA que contiene un mapa en notacion LLSD. Segun el
// grid puede venir tal cual (`{region_handle:[...]}`) o envuelta en un literal
// de cadena (`s'{region_handle:[...]}'`); se desenvuelve en bucle.
export function parseHome(text) {
  if (!text) return null;
  if (typeof text === "object") return homeFrom(text);
  let v = text;
  for (let i = 0; i < 3; i++) {
    try { v = parseNotation(String(v)); } catch (e) { return null; }
    if (v && typeof v === "object" && !Array.isArray(v)) return homeFrom(v);
    if (typeof v !== "string") break;
  }
  if (typeof v === "string" && /^uri:/i.test(v)) {
    const s = parseStartLocation(v);
    return { regionHandle: null, position: s.position, lookAt: null, region: s.region };
  }
  return null;
}

function homeFrom(m) {
  const rh = pick(m, "region_handle");
  const pair = Array.isArray(rh) && rh.length >= 2
    ? rh.slice(0, 2).map((x) => (x && typeof x === "object" && "value" in x ? x.value : parseFloat(x)))
    : null;
  return {
    regionHandle: pair,
    // El handle es (regionX*256) << 32 | (regionY*256): las dos mitades dan las
    // coordenadas de rejilla de la region.
    regionX: pair && pair[0] % 256 === 0 ? pair[0] / 256 : undefined,
    regionY: pair && pair[1] % 256 === 0 ? pair[1] / 256 : undefined,
    position: xyz(pick(m, "position")),
    lookAt: xyz(pick(m, "look_at")),
    region: str(m, "region_name", "region"),
  };
}

// `login-flags` es texto con una linea por bandera ("remember:1\n").
export function parseFlags(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    if (i < 0) out[t] = true;
    else out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

// --- traduccion de los fallos -----------------------------------------------

export const FAILURES = {
  key: {
    title: "Nombre o contrasena incorrectos",
    hint: "Revisa el nombre (usuario o «nombre apellido») y la contrasena. Si tienes activado el segundo factor, escribe el codigo en el campo «Codigo».",
  },
  password: {
    title: "Contrasena incorrecta",
    hint: "Cambia la contrasena en secondlife.com si no la recuerdas.",
  },
  presence: {
    title: "Ya hay una sesion abierta",
    hint: "Second Life no permite dos conexiones a la vez con la misma cuenta. Sal del otro visor y espera un minuto (a veces la sesion anterior tarda en soltarse).",
  },
  disabled: {
    title: "Cuenta deshabilitada",
    hint: "Entra en secondlife.com para ver el estado de la cuenta.",
  },
  account: {
    title: "Cuenta no valida",
    hint: "Puede estar suspendida o a la espera de verificacion.",
  },
  suspended: {
    title: "Cuenta suspendida",
    hint: "Revisa el correo o el sitio de Linden Lab.",
  },
  update: {
    title: "El visor es demasiado antiguo",
    hint: "Linden Lab exige una version minima en las cuentas nuevas. Se puede subir el «version» del visor en el arranque.",
  },
  version: { title: "Version no aceptada", hint: "Mismo caso que «visor demasiado antiguo»." },
  tos: {
    title: "Faltan las condiciones de uso",
    hint: "Entra una vez con el visor oficial de Second Life (o la web) para aceptar las condiciones de esta cuenta; despues ya funciona aqui.",
  },
  critical: {
    title: "Hay un aviso que leer antes de entrar",
    hint: "Second Life manda un mensaje critico (por ejemplo, un cambio de precios o una politica). Entra una vez con el visor oficial para leerlo.",
  },
  connect: {
    title: "No se pudo conectar con la region",
    hint: "La region de destino puede estar caida o en mantenimiento. Prueba a entrar en «Ultima posicion (last)» o en una region publica conocida.",
  },
  offline: {
    title: "El grid esta en mantenimiento",
    hint: "Vuelve a intentarlo dentro de un rato (revisa status.secondlifegrid.net).",
  },
  internal: { title: "Fallo interno del login", hint: "Vuelve a intentarlo." },
  unknown: { title: "No se pudo iniciar sesion", hint: "Vuelve a intentarlo." },
  red: {
    title: "Sin contacto con el servidor de login",
    hint: "Puede ser la red o la salida a internet (el proxy de perchance, o el puente de la app). Comprueba la conexion y vuelve a intentarlo.",
  },
  formato: {
    title: "Respuesta ilegible del servidor",
    hint: "Llego algo que no es XML-RPC. Suele pasar cuando un proxy devuelve una pagina de error en vez de la respuesta de Linden Lab.",
  },
};

export function describeFailure(reason, message) {
  const f = FAILURES[reason];
  if (f) return { reason, title: f.title, hint: f.hint, message: message || "" };
  return {
    reason: reason || "unknown",
    title: "No se pudo iniciar sesion",
    hint: message || "El servidor no dio un motivo conocido.",
    message: message || "",
  };
}

// --- la llamada -------------------------------------------------------------

function defaultFetch() {
  const r = typeof window !== "undefined" ? window.root : null;
  if (r && typeof r.superFetch === "function") return r.superFetch;
  if (typeof fetch === "function") return fetch;
  return null;
}

// Devuelve siempre un objeto, nunca lanza por un fallo de credenciales:
//
//   { ok:true,  session:{...}, raw:{...} }
//   { ok:false, reason, title, hint, message, raw }
//
// `opts`: { name | firstName/lastName, password, token, grid, start, id0,
//           agreeToTos, readCritical, channel, version, onStatus }
export async function login(opts, deps) {
  const o = opts || {};
  const d = deps || {};
  const say = typeof o.onStatus === "function" ? o.onStatus : () => {};
  const f = d.fetch || defaultFetch();
  const grid = GRIDS[o.grid] || GRIDS.agni;

  const nm = o.firstName !== undefined ? { firstName: o.firstName, lastName: o.lastName || "" } : splitSlName(o.name);
  if (!nm.firstName) return fail("key", "escribe tu nombre de Second Life");
  if (!o.password && !o.passwordHash) return fail("key", "escribe tu contrasena");
  if (!f) return fail("red", "no hay forma de hacer peticiones HTTP");

  say("Contactando con " + grid.name + "…");
  let res;
  try {
    res = await f(grid.loginUri, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: buildLoginBody(Object.assign({}, o, nm)),
    });
  } catch (e) {
    const r = describeFailure("red", String((e && e.message) || e));
    return Object.assign({ ok: false }, r);
  }

  if (!res || (res.status && res.status >= 400)) {
    // El cuerpo del error trae la explicacion de verdad: el puente de la app (en
    // Android) o el proxy de perchance escriben ahi lo que ha fallado, y sin
    // esto solo se veria un "HTTP 502" que no dice nada.
    let detalle = "";
    try { detalle = String(await res.text()).trim().slice(0, 300); } catch (e) { detalle = ""; }
    const r = describeFailure("red", "HTTP " + (res && res.status) + (detalle ? " — " + detalle : ""));
    return Object.assign({ ok: false }, r);
  }

  let text = "";
  try { text = await res.text(); } catch (e) { text = ""; }

  say("Comprobando la cuenta…");
  let reply;
  try {
    reply = parseXml(text);
  } catch (e) {
    const r = describeFailure("formato", String((e && e.message) || e) + " — " + text.slice(0, 120));
    return Object.assign({ ok: false }, r);
  }
  if (!reply || typeof reply !== "object") {
    const r = describeFailure("formato", "la respuesta no es un mapa");
    return Object.assign({ ok: false }, r);
  }

  const loggedIn = String(pick(reply, "login") || "").toLowerCase() === "true";
  if (!loggedIn) {
    const reason = str(reply, "reason") || "unknown";
    const message = str(reply, "message") || "";
    const r = describeFailure(reason, message);
    return Object.assign({ ok: false }, r, { flags: parseFlags(str(reply, "login-flags")), raw: reply });
  }

  const region = parseStartLocation(str(reply, "start_location"));
  const invRoot = pick(reply, "inventory-root");
  const libRoot = pick(reply, "inventory-lib-root");

  const session = {
    grid: grid.id,
    gridName: grid.name,
    loginUri: grid.loginUri,
    agentId: str(reply, "agent_id"),
    sessionId: str(reply, "session_id"),
    secureSessionId: str(reply, "secure_session_id"),
    firstName: str(reply, "first_name") || nm.firstName,
    lastName: str(reply, "last_name") || nm.lastName,
    displayName: ((str(reply, "first_name") || nm.firstName) + " " + (str(reply, "last_name") || nm.lastName)).trim(),
    circuitCode: num(reply, "circuit_code"),
    simIp: ipString(pick(reply, "sim_ip")),
    simPort: num(reply, "sim_port"),
    regionX: num(reply, "region_x"),
    regionY: num(reply, "region_y"),
    seedCapability: str(reply, "seed_capability"),
    agentAccess: str(reply, "agent_access"),
    accessMax: str(reply, "agent_access_max"),
    start: region,
    home: parseHome(str(reply, "home")),
    lookAt: xyz(pick(reply, "look_at")),
    secondsSinceEpoch: num(reply, "seconds_since_epoch"),
    inventoryRoot: invRoot && invRoot.folder_id ? String(invRoot.folder_id) : undefined,
    inventoryLibRoot: libRoot && libRoot.folder_id ? String(libRoot.folder_id) : undefined,
    buddies: Array.isArray(pick(reply, "buddy-list")) ? pick(reply, "buddy-list") : [],
    flags: parseFlags(str(reply, "login-flags")),
    maxGroups: num(reply, "max-agent-groups"),
    searchUrl: str(reply, "search_url"),
    mapUrl: str(reply, "map-server-url"),
  };

  return { ok: true, session, raw: reply };
}

function fail(reason, message) {
  return Object.assign({ ok: false }, describeFailure(reason, message));
}

// --- redireccion de la sesion al retransmisor -------------------------------
//
// Lo que necesita un gateway para abrir el circuito UDP. `sessionId` y
// `secureSessionId` son los secretos de la sesion: van SOLO al retransmisor
// (nunca a un tercero, nunca a un log).
export function relayCredentials(session) {
  return {
    grid: session.grid,
    loginUri: session.loginUri,
    agentId: session.agentId,
    sessionId: session.sessionId,
    secureSessionId: session.secureSessionId,
    circuitCode: session.circuitCode,
    simIp: session.simIp,
    simPort: session.simPort,
    regionX: session.regionX,
    regionY: session.regionY,
    seedCapability: session.seedCapability,
  };
}

// --- autotest ---------------------------------------------------------------

export function runLoginSelfTest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

  eq("nombre: dos palabras", splitSlName("Steller Sunshine"), { firstName: "Steller", lastName: "Sunshine" });
  eq("nombre: con punto", splitSlName("steller.sunshine"), { firstName: "steller", lastName: "sunshine" });
  eq("nombre: solo usuario", splitSlName("bobsmith12"), { firstName: "bobsmith12", lastName: "" });

  eq("start_location: uri", parseStartLocation("uri:Umbral Infinito&128&64&25"), { kind: "uri", region: "Umbral Infinito", position: [128, 64, 25] });
  eq("start_location: last", parseStartLocation("last"), { kind: "last" });

  const home = parseHome("s'{region_handle:[1000,1000],position:[128.0,64.5,22.1],look_at:[128,64,0]}'");
  eq("home: posicion", home && home.position, [128, 64.5, 22.1]);
  eq("home: mira", home && home.lookAt, [128, 64, 0]);
  eq("home: sin envolver", (parseHome("{region_handle:[1000,1000],position:[1,2,3],look_at:[4,5,6]}") || {}).position, [1, 2, 3]);

  eq("flags", parseFlags("remember:1\neverloggedin:0\n"), { remember: "1", everloggedin: "0" });

  const body = buildLoginBody({ name: "Prueba Cuenta", password: "secreta", grid: "agni" });
  eq("peticion: metodo", /<methodName>login_to_simulator<\/methodName>/.test(body), true);
  eq("peticion: hash de la contrasena", body.indexOf("$1$" + md5Hex("secreta")) > 0, true);
  eq("peticion: sin la contrasena en claro", body.indexOf("secreta") < 0, true);
  eq("peticion: campos obligatorios", ["first", "last", "passwd", "start", "channel", "version", "platform", "mac", "id0", "agree_to_tos"].every((k) => body.indexOf("<name>" + k + "</name>") > 0), true);
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(body, "text/xml");
    eq("peticion: XML valido", !doc.querySelector("parsererror"), true);
    eq("peticion: parametros", doc.querySelectorAll("methodCall > params > param").length, 1);
  }

  const errReply = '<?xml version="1.0"?><methodResponse><params><param><value><struct>' +
    '<member><name>login</name><value><string>false</string></value></member>' +
    '<member><name>reason</name><value><string>presence</string></value></member>' +
    '<member><name>message</name><value><string>You are already logged in.</string></value></member>' +
    '<member><name>login-flags</name><value><string>remember:1</string></value></member>' +
    "</struct></value></param></params></methodResponse>";
  if (typeof DOMParser !== "undefined") {
    const r = parseXml(errReply);
    const d = describeFailure(str(r, "reason"), str(r, "message"));
    eq("fallo: motivo", d.reason, "presence");
    eq("fallo: titulo en castellano", /sesion abierta/i.test(d.title), true);
  }

  const okReply = '<?xml version="1.0"?><methodResponse><params><param><value><struct>' +
    '<member><name>login</name><value><string>true</string></value></member>' +
    '<member><name>agent_id</name><value><string>11111111-2222-3333-4444-555555555555</string></value></member>' +
    '<member><name>session_id</name><value><string>aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee</string></value></member>' +
    '<member><name>first_name</name><value><string>Steller</string></value></member>' +
    '<member><name>last_name</name><value><string>Sunshine</string></value></member>' +
    '<member><name>circuit_code</name><value><int>123456</int></value></member>' +
    '<member><name>sim_ip</name><value><base64>ywBxCg==</base64></value></member>' +
    '<member><name>sim_port</name><value><int>13000</int></value></member>' +
    '<member><name>region_x</name><value><int>1000</int></value></member>' +
    '<member><name>region_y</name><value><int>1000</int></value></member>' +
    '<member><name>start_location</name><value><string>uri:Umbral Infinito&amp;128&amp;64&amp;25</string></value></member>' +
    '<member><name>look_at</name><value><array><data><value><double>128</double></value><value><double>64</double></value><value><double>0</double></value></data></array></value></member>' +
    '<member><name>home</name><value><string>{region_handle:[1000,1000],position:[1,2,3],look_at:[4,5,6]}</string></value></member>' +
    '<member><name>seed_capability</name><value><string>https://sim.example.com:9000/?sg=1</string></value></member>' +
    '<member><name>inventory-root</name><value><struct><member><name>folder_id</name><value><string>99999999-8888-7777-6666-555555555555</string></value></member></struct></value></member>' +
    "</struct></value></param></params></methodResponse>";
  if (typeof DOMParser !== "undefined") {
    const r = parseXml(okReply);
    eq("ok: id del agente", str(r, "agent_id"), "11111111-2222-3333-4444-555555555555");
    eq("ok: ip del simulador desde binario", ipString(pick(r, "sim_ip")), "203.0.113.10");
    eq("ok: region", parseStartLocation(str(r, "start_location")).region, "Umbral Infinito");
    eq("ok: home", (parseHome(str(r, "home")) || {}).regionHandle, [1000, 1000]);
  }

  const failed = checks.filter((c) => !c.ok);
  return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
}
