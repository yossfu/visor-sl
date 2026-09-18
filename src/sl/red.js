// red.js -- la comprobacion de red: «¿sale un datagrama UDP de este movil?».
//
// POR QUE EXISTE
// --------------
// Todo el fallo del visor en el movil se reduce, casi siempre, a una de estas
// dos cosas:
//
//   a) la red (o la operadora) no deja salir UDP, o
//   b) sale UDP, pero desde un socket de doble pila (IPv6) y la operadora (CGNAT)
//      no sabe devolver la respuesta -- «se envian paquetes y no llega ninguno»,
//      que es exactamente lo que parecia un puerto del simulador cerrado.
//
// Hasta ahora, para distinguirlas habia que conectar con Second Life y mirar el
// informe (el puente dice cuantos datagramas salieron y cuantos entraron). Esto
// lo responde ANTES y con un servicio que no es de Linden Lab: se manda una
// peticion STUN a un servidor publico y el servidor contesta con la direccion de
// origen que ve. Si llega la respuesta, la red deja salir UDP y deja volver la
// respuesta; y de paso dice la IP y el puerto PUBLICOS (que es el dato que hay
// que comparar con el puerto local del puente: en CGNAT suelen ser distintos, y
// si la entrada del NAT caduca cada 30-60 s, hay que mantener el circuito vivo
// con pings -- ver `scratch/lp/02-cellular-and-background.md` de Linkpoint).
//
// STUN es exactamente lo que usan los visores de voz y los clientes de chat para
// descubrir su direccion publica, asi que no es nada raro ni propio de SL.
//
// COMO SE MONTA
// -------------
// Este modulo NO tiene sockets (un navegador no los tiene): monta la PETICION y
// LEE la respuesta, y el envio se lo pide al puente UDP (`udp.js` -> app Android,
// comando `probe`). Asi toda la logica -- que es la que se puede probar -- vive
// aqui, en JavaScript, y el puente sigue siendo un simple movedor de bytes.
//
//   const r = await comprobarRed(puente);
//   r.ok      -> la red deja salir UDP y volver la respuesta
//   r.linea   -> una frase para el informe (y para el usuario)
//   r.detalle -> el dato crudo: IP publica, puerto publico, puerto local, familia
//
// El modulo de STUN es minimo a proposito: una peticion Binding (tipo 0x0001) y
// el parseo de MAPPED-ADDRESS (0x0001) y XOR-MAPPED-ADDRESS (0x0020), que son
// los dos unicos atributos que hacen falta. RFC 5389 / RFC 8489.

const noop = () => {};

// Cabecera de STUN: tipo (0x0001 = Binding request), longitud 0, la cookie
// magica (que distingue STUN de otros protocolos que empiezan igual) y 12 bytes
// de identificador de transaccion. 20 bytes exactos.
export const STUN_COOKIE = 0x2112a442;
export const STUN_BINDING_REQUEST = 0x0001;
export const STUN_BINDING_RESPONSE = 0x0101;
export const STUN_BINDING_ERROR = 0x0111;

// Los atributos que sabemos leer.
export const STUN_ATTR = {
  MAPPED_ADDRESS: 0x0001,       // obsoleto, pero algunos servidores lo mandan
  XOR_MAPPED_ADDRESS: 0x0020,   // el moderno (RFC 5389)
};

// Servidores publicos de STUN. Se prueban en orden: si el primero no contesta
// (algunos operadores tienen mala ruta hacia Google), se pasa al siguiente.
export const STUN_POR_DEFECTO = [
  { host: "stun.l.google.com", puerto: 19302 },
  { host: "stun.cloudflare.com", puerto: 3478 },
  { host: "stun1.l.google.com", puerto: 19302 },
];

// --- aleatoriedad --------------------------------------------------------------

// El identificador de transaccion (12 bytes) tiene que ser unico y no adivinable
// (ver la seccion de seguridad de la RFC). `crypto` esta en cualquier navegador
// moderno y en el WebView de Android; si no, se cae a Math.random (suficiente
// para una prueba de red: no hay nada que proteger aqui).
export function txidAleatorio() {
  const b = new Uint8Array(12);
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(b);
      return b;
    }
  } catch (e) { /* sigue el plan B */ }
  for (let i = 0; i < 12; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

// --- la peticion ---------------------------------------------------------------

export function peticionStun(txid) {
  const id = txid instanceof Uint8Array && txid.length === 12 ? txid : txidAleatorio();
  const b = new Uint8Array(20);
  b[0] = (STUN_BINDING_REQUEST >> 8) & 0xff;
  b[1] = STUN_BINDING_REQUEST & 0xff;
  b[2] = 0; b[3] = 0;                       // sin atributos: longitud 0
  b[4] = (STUN_COOKIE >>> 24) & 0xff;
  b[5] = (STUN_COOKIE >>> 16) & 0xff;
  b[6] = (STUN_COOKIE >>> 8) & 0xff;
  b[7] = STUN_COOKIE & 0xff;
  b.set(id, 8);
  return b;
}

// --- la lectura ----------------------------------------------------------------

function formatearIPv6(b) {
  const g = [];
  for (let i = 0; i < 16; i += 2) g.push(((b[i] << 8) | b[i + 1]).toString(16));
  // Se comprime la racha de ceros mas larga (la notacion "::").
  let mejorIni = -1, mejorLen = 0, ini = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && g[i] === "0") { if (ini < 0) ini = i; }
    else if (ini >= 0) {
      const len = i - ini;
      if (len > mejorLen) { mejorLen = len; mejorIni = ini; }
      ini = -1;
    }
  }
  if (mejorLen > 1) {
    const izq = g.slice(0, mejorIni).join(":");
    const der = g.slice(mejorIni + mejorLen).join(":");
    if (!izq && !der) return "::";
    if (!izq) return "::" + der;
    if (!der) return izq + "::";
    return izq + "::" + der;
  }
  return g.join(":");
}

/**
 * Lee una respuesta STUN. Devuelve `null` si no es una respuesta STUN valida
 * (demasiado corta o sin la cookie magica), o `{tipo, txid, ip, puerto, familia}`
 * con la direccion de origen que el servidor ha visto. `ip`/`puerto` quedan a
 * `null` si la respuesta no trae ningun atributo de direccion.
 */
export function leerStun(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (u8.length < 20) return null;
  const tipo = (u8[0] << 8) | u8[1];
  const largo = ((u8[2] << 8) | u8[3]) & 0xffff;
  const cookie = (((u8[4] << 24) | (u8[5] << 16) | (u8[6] << 8) | u8[7]) >>> 0);
  if (cookie !== STUN_COOKIE) return null;
  const txid = u8.slice(8, 20);
  const salida = { tipo, txid, ip: null, puerto: null, familia: "" };
  const fin = Math.min(u8.length, 20 + largo);
  let pos = 20;
  while (pos + 4 <= fin) {
    const at = (u8[pos] << 8) | u8[pos + 1];
    const al = (u8[pos + 2] << 8) | u8[pos + 3];
    const ini = pos + 4;
    if (ini + al > u8.length) break;
    if (at === STUN_ATTR.MAPPED_ADDRESS || at === STUN_ATTR.XOR_MAPPED_ADDRESS) {
      const xor = at === STUN_ATTR.XOR_MAPPED_ADDRESS;
      const fam = u8[ini + 1];
      let puerto = (u8[ini + 2] << 8) | u8[ini + 3];
      if (xor) puerto ^= (STUN_COOKIE >>> 16) & 0xffff;
      if (fam === 1 && al >= 8) {
        const a = [u8[ini + 4], u8[ini + 5], u8[ini + 6], u8[ini + 7]];
        if (xor) for (let i = 0; i < 4; i++) a[i] ^= (STUN_COOKIE >>> (24 - 8 * i)) & 0xff;
        salida.ip = a.join(".");
        salida.puerto = puerto;
        salida.familia = "IPv4";
      } else if (fam === 2 && al >= 20) {
        const a = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
          let b = u8[ini + 4 + i];
          if (xor) b ^= (i < 4 ? (STUN_COOKIE >>> (24 - 8 * i)) & 0xff : u8[8 + (i - 4)]);
          a[i] = b;
        }
        salida.ip = formatearIPv6(a);
        salida.puerto = puerto;
        salida.familia = "IPv6";
      }
    }
    pos = ini + Math.ceil(al / 4) * 4;
  }
  return salida;
}

// --- la comprobacion -----------------------------------------------------------

/**
 * Pregunta a la red si deja salir un datagrama UDP y volver la respuesta.
 *
 *   comprobarRed(puente)                    -> contra los STUN publicos
 *   comprobarRed(puente, { servidores, timeout, log })
 *
 * `puente` es el objeto de `openUdpBridge` (su metodo `probe`). Devuelve
 * `{ok, linea, detalle}`. Nunca lanza: un fallo de red es un `ok:false` con su
 * motivo, para que el informe lo pueda enseñar tal cual.
 */
export async function comprobarRed(puente, opts = {}) {
  const log = opts.log || noop;
  const servidores = opts.servidores || STUN_POR_DEFECTO;
  const timeout = opts.timeout === undefined ? 4000 : opts.timeout;

  if (!puente) {
    return { ok: false, linea: "sin puente UDP: esta prueba solo funciona en la app Android", detalle: { motivo: "sin-puente" } };
  }
  if (!puente.ready) {
    return { ok: false, linea: "el puente UDP no está abierto (espera a conectar con la región)", detalle: { motivo: "puente-cerrado" } };
  }
  if (typeof puente.probe !== "function") {
    return { ok: false, linea: "el puente no sabe hacer la sonda", detalle: { motivo: "puente-viejo" } };
  }

  const intentos = [];
  for (const s of servidores) {
    const txid = txidAleatorio();
    const peticion = peticionStun(txid);
    try {
      const r = await puente.probe(s.host, s.puerto, peticion, { timeout });
      const m = leerStun(r.datos);
      if (!m) {
        intentos.push({ host: s.host, ok: false, motivo: "contestó algo que no es STUN (" + (r.datos ? r.datos.length : 0) + " B)" });
        continue;
      }
      if (m.tipo === STUN_BINDING_ERROR) {
        intentos.push({ host: s.host, ok: false, motivo: "el servidor contestó con un error" });
        continue;
      }
      if (!m.ip) {
        intentos.push({ host: s.host, ok: false, motivo: "la respuesta no traía la dirección" });
        continue;
      }
      // El puerto PUBLICO que ve el servidor contra el puerto LOCAL del socket:
      // distintos quiere decir que hay un NAT por medio (lo normal en datos
      // moviles), y es el dato que explica que la entrada del NAT pueda caducar
      // si no se mantiene el circuito con pings.
      const pub = String(m.puerto);
      const local = String(r.localPort || "");
      const mapeo = local && pub ? (local === pub ? "igual" : "distinto") : "?";
      const avisoIpv6 = r.familia === "IPv6"
        ? " · OJO: el socket salió IPv6, y los simuladores de Second Life son IPv4 (puede que el simulador no reciba nada)"
        : "";
      const linea = "salida UDP correcta por " + s.host + " · dirección pública " + m.ip + ":" + m.puerto +
        " · socket local " + (r.local || "?") + " (" + (r.familia || "?") + ")" +
        " · puerto público " + mapeo + " al local" + avisoIpv6 + " · " + r.ms + " ms";
      log("red: " + linea);
      return {
        ok: true, linea,
        detalle: {
          servidor: s.host, puerto: s.puerto, ms: r.ms,
          ipPublica: m.ip, puertoPublico: m.puerto, ipPublicaFamilia: m.familia,
          socketLocal: r.local || null, socketFamilia: r.familia || null,
          mapeoPuertos: mapeo, intentos,
        },
      };
    } catch (e) {
      intentos.push({ host: s.host, ok: false, motivo: (e && e.message) || String(e) });
      log("red: " + s.host + " no contestó (" + ((e && e.message) || e) + ")");
    }
  }
  return {
    ok: false,
    linea: "ningún datagrama UDP salió y volvió (probados " + servidores.length + " servidores: " +
      intentos.map((i) => i.host + ": " + i.motivo).join("; ") + ")",
    detalle: { motivo: "sin-respuesta", intentos },
  };
}

// --- autotest ------------------------------------------------------------------

// Una respuesta STUN de mentira, como la mandaria un servidor: sirve para probar
// el parseo sin red (y sin movil).
function respuestaStun(txid, ip, puerto, o = {}) {
  const xor = o.xor !== false;
  const familia = o.familia === "IPv6" ? 2 : 1;
  const attrType = xor ? STUN_ATTR.XOR_MAPPED_ADDRESS : STUN_ATTR.MAPPED_ADDRESS;
  const dir = o.direccionBytes || (familia === 1
    ? (typeof ip === "string" ? ip.split(".").map(Number) : ip)
    : (ip instanceof Uint8Array ? Array.from(ip) : ip));
  const attrLen = familia === 1 ? 8 : 20;
  const total = 20 + 4 + attrLen;
  const b = new Uint8Array(total);
  b[0] = 0x01; b[1] = 0x01;                                  // Binding success
  b[2] = ((attrLen + 4) >> 8) & 0xff; b[3] = (attrLen + 4) & 0xff;
  b[4] = (STUN_COOKIE >>> 24) & 0xff; b[5] = (STUN_COOKIE >>> 16) & 0xff;
  b[6] = (STUN_COOKIE >>> 8) & 0xff; b[7] = STUN_COOKIE & 0xff;
  b.set(txid.slice(0, 12), 8);
  b[20] = (attrType >> 8) & 0xff; b[21] = attrType & 0xff;
  b[22] = (attrLen >> 8) & 0xff; b[23] = attrLen & 0xff;
  b[24] = 0; b[25] = familia;
  let p = puerto & 0xffff;
  if (xor) p ^= (STUN_COOKIE >>> 16) & 0xffff;
  b[26] = (p >> 8) & 0xff; b[27] = p & 0xff;
  for (let i = 0; i < dir.length; i++) {
    let v = dir[i] & 0xff;
    if (xor) v ^= (i < 4 ? (STUN_COOKIE >>> (24 - 8 * i)) & 0xff : txid[i - 4]);
    b[28 + i] = v;
  }
  return b;
}

export function runRedSelfTest() {
  const checks = [];
  const eq = (name, got, want) => checks.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });
  const ok = (name, cond, got) => checks.push({ name, ok: !!cond, got });

  // 1. La peticion tiene la forma que manda la RFC: 20 bytes, tipo Binding,
  //    longitud 0, la cookie magica y el txid que se le pide.
  const txid = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const pet = peticionStun(txid);
  eq("stun: la petición tiene 20 bytes", pet.length, 20);
  eq("stun: tipo Binding", [(pet[0] << 8) | pet[1], (pet[2] << 8) | pet[3]], [STUN_BINDING_REQUEST, 0]);
  eq("stun: lleva la cookie mágica", [(pet[4] << 24) | (pet[5] << 16) | (pet[6] << 8) | pet[7]], [STUN_COOKIE]);
  eq("stun: lleva el identificador que se le dio", Array.from(pet.slice(8, 20)), Array.from(txid));

  // 2. Sin txid, cada peticion es distinta (no se reutiliza el identificador).
  const a = peticionStun();
  const b = peticionStun();
  ok("stun: el identificador es aleatorio", Array.from(a.slice(8, 20)).join() !== Array.from(b.slice(8, 20)).join(),
    Array.from(a.slice(8, 20)).length);

  // 3. Una respuesta IPv4 con XOR-MAPPED-ADDRESS se lee entera.
  const r1 = leerStun(respuestaStun(txid, "203.0.113.7", 54321));
  eq("stun: lee la dirección y el puerto (XOR)", [r1.ip, r1.puerto, r1.familia], ["203.0.113.7", 54321, "IPv4"]);
  eq("stun: reconoce el tipo de respuesta", r1.tipo, STUN_BINDING_RESPONSE);
  eq("stun: devuelve el identificador de la respuesta", Array.from(r1.txid), Array.from(txid));

  // 4. Tambien se entiende el MAPPED-ADDRESS viejo (sin XOR).
  const r2 = leerStun(respuestaStun(txid, "198.51.100.9", 1234, { xor: false }));
  eq("stun: entiende el atributo antiguo (sin XOR)", [r2.ip, r2.puerto], ["198.51.100.9", 1234]);

  // 5. Y una direccion IPv6 (XOR con la cookie + el identificador).
  const ipv6 = Uint8Array.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const r3 = leerStun(respuestaStun(txid, ipv6, 4433, { familia: "IPv6" }));
  eq("stun: lee una dirección IPv6", [r3.ip, r3.puerto, r3.familia], ["2001:db8::1", 4433, "IPv6"]);

  // 6. Lo que no es STUN se rechaza sin lanzar (un puerto que contesta cualquier
  //    cosa, o basura).
  eq("stun: rechaza una respuesta corta", leerStun(Uint8Array.of(1, 2, 3)), null);
  eq("stun: rechaza algo sin la cookie mágica", leerStun(new Uint8Array(32)), null);
  eq("stun: no revienta con basura", (() => { try { leerStun("no soy bytes"); return "ok"; } catch (e) { return "excepcion"; } })(), "ok");

  // 7. La comprobacion completa contra un puente de mentira que contesta como un
  //    STUN (y dice que el socket salio IPv4, que es lo que queremos).
  const puenteOk = {
    ready: true,
    probe(host, puerto, bytes, o) {
      const t = bytes.slice(8, 20);
      return Promise.resolve({
        ok: true, ms: 42, local: "0.0.0.0:53100", localPort: "53100", familia: "IPv4",
        de: host + ":" + puerto, datos: Array.from(respuestaStun(t, "81.34.10.5", 53100)),
      });
    },
  };

  return Promise.resolve().then(async () => {
    const c1 = await comprobarRed(puenteOk, { servidores: STUN_POR_DEFECTO });
    ok("red: la comprobación sale bien", c1.ok, c1.linea);
    ok("red: la línea dice la IP publica", /81\.34\.10\.5/.test(c1.linea), c1.linea);
    ok("red: la línea dice que el mapeo de puertos es igual", /puerto público igual al local/.test(c1.linea), c1.linea);
    eq("red: el detalle lleva la familia del socket", c1.detalle.socketFamilia, "IPv4");

    // 8. Un puente que salio IPv6 tiene que AVISARLO: es la causa conocida de
    //    «mando paquetes y no vuelve nada».
    const puenteV6 = {
      ready: true,
      probe(host, puerto, bytes) {
        const t = bytes.slice(8, 20);
        return Promise.resolve({
          ok: true, ms: 60, local: "::", localPort: "53100", familia: "IPv6",
          de: host + ":" + puerto, datos: Array.from(respuestaStun(t, "81.34.10.5", 60123)),
        });
      },
    };
    const c2 = await comprobarRed(puenteV6, { servidores: [STUN_POR_DEFECTO[0]], timeout: 500 });
    ok("red: avisa cuando el socket salió IPv6", /IPv6/.test(c2.linea) && /simulador/.test(c2.linea), c2.linea);
    eq("red: y dice que el puerto publico es distinto del local", c2.detalle.mapeoPuertos, "distinto");

    // 9. El primero que falla no corta la prueba: se pasa al siguiente servidor.
    let llamadas = 0;
    const puenteReintenta = {
      ready: true,
      probe(host, puerto, bytes) {
        llamadas++;
        if (llamadas === 1) return Promise.reject(new Error("sin respuesta"));
        const t = bytes.slice(8, 20);
        return Promise.resolve({ ok: true, ms: 30, local: "0.0.0.0:53101", localPort: "53101", familia: "IPv4", datos: Array.from(respuestaStun(t, "9.9.9.9", 53101)) });
      },
    };
    const c3 = await comprobarRed(puenteReintenta, { servidores: STUN_POR_DEFECTO, timeout: 300 });
    ok("red: si el primero falla, prueba el siguiente", c3.ok && llamadas === 2, [c3.ok, llamadas]);
    eq("red: deja anotado el intento fallido", c3.detalle.intentos.length, 1);

    // 10. Sin puente (navegador de escritorio) no se puede: se dice claro, sin
    //     lanzar ni dejar la interfaz girando.
    const c4 = await comprobarRed(null);
    eq("red: sin puente lo dice y no revienta", [c4.ok, c4.detalle.motivo], [false, "sin-puente"]);
    const c5 = await comprobarRed({ ready: false });
    eq("red: con el puente cerrado lo dice", [c5.ok, c5.detalle.motivo], [false, "puente-cerrado"]);

    // 11. Si nadie contesta, el motivo sale en la linea (con quien se probo).
    const puenteMudo = { ready: true, probe: () => Promise.reject(new Error("la sonda no obtuvo respuesta en 300 ms")) };
    const c6 = await comprobarRed(puenteMudo, { servidores: [STUN_POR_DEFECTO[0], STUN_POR_DEFECTO[1]], timeout: 300 });
    ok("red: si nadie contesta lo dice con los servidores probados", !c6.ok && /2 servidores/.test(c6.linea), c6.linea);

    const failed = checks.filter((c) => !c.ok);
    return { checks: checks.length, passed: checks.length - failed.length, fails: failed };
  });
}
