// env.js -- capa de "plataforma" para el visor dentro de la app Android.
//
// El visor (la carpeta `viewer/`) es el mismo codigo que corre en perchance,
// donde las cosas que no puede hacer el navegador las dan los plugins de la
// plataforma: `root.kv` (IndexedDB), `root.superFetch` (fetch sin CORS),
// `root.createServerSocket` (multijugador) y `root.generateText`/`generateImage`.
//
// En la app Android no hay motor de perchance, asi que este archivo rellena
// `window.root` con una version minima y honesta:
//
//   * `root.kv`            -> IndexedDB del WebView (mismo formato de carpetas
//                             que el plugin `kv`), para que el autoguardado de
//                             la region, el inventario y el aspecto funcionen.
//   * `root.superFetch`    -> el puente de red de la app (`/proxy?url=...`,
//                             ver `ViewerServer.kt`). El WebView aplica CORS
//                             igual que Chrome y los servidores de Second Life
//                             no mandan cabeceras CORS, asi que la peticion la
//                             hace el lado nativo desde fuera del navegador.
//   * `root.createServerSocket` -> NO se define: el multijugador de la app va
//                             por dentro del enlace con el puente UDP nativo
//                             (`UdpBridgeServer`), no por el servidor de
//                             perchance. `src/net.js` detecta su ausencia y
//                             degrada solo.
//
// Ademas lee el parametro `?relay=ws://127.0.0.1:PUERTO` que le pasa
// `MainActivity` (el enlace interno con el nucleo nativo) y lo deja escrito en
// el campo del retransmisor, para que el usuario no tenga que copiarlo a mano.
//
// Y lee `?udp=ws://127.0.0.1:PUERTO`: el puente de datagramas UDP que abre
// `UdpBridgeServer` en el propio telefono. Con el, el visor habla LLUDP con un
// simulador de Second Life DE VERDAD: el nucleo nativo solo mueve bytes UDP, y
// todo el protocolo lo lleva `viewer/src/sl/lludp/`. (`?relay=` sigue valiendo
// para el retransmisor de siempre, que ya no hace falta.)

(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search || "");
  var relayUrl = (params.get("relay") || "").trim();
  var udpUrl = (params.get("udp") || "").trim();

  window.__SL_APP__ = {
    android: true,
    relayUrl: relayUrl,
    udpUrl: udpUrl,
    version: "0.1.3",
  };

  // -------------------------------------------------------- vigia de arranque
  // El visor es un <script type="module"> con decenas de modulos que se
  // importan unos a otros. Si a los assets de la app les falta UNO solo, el
  // navegador no carga el modulo, no arranca ni una linea de JavaScript y la
  // pantalla se queda clavada en "Preparando el mundo..." con el HTML de
  // escritorio de fondo (barra de navegacion, atajos WASD, el chat suelto).
  // Desde fuera parece que la app "esta cargando" para siempre, y no hay ni un
  // mensaje que diga que pasa.
  //
  // Lo mas habitual es que al subir el proyecto a GitHub no se subiera `src/`
  // entera (esa es justo la causa de que el APK salga "mudo"), pero tambien
  // pasa si un archivo llega corrupto o si se compila con el visor a medias.
  // Este vigia convierte ese silencio en un diagnostico:
  //
  //   * si el visor no avisa de que ha arrancado (`window.__visorListo()`) en
  //     9 segundos, o si se ve un error de carga, se tapa la pantalla;
  //   * se comprueba, archivo por archivo, contra `manifiesto.json` (la lista
  //     que escribe `build-viewer.mjs` al compilar el APK) y se dicen los
  //     nombres EXACTOS de los que faltan.
  //
  // Se desactiva solo en cuanto el visor arranca: no se ve en el uso normal.
  var ARRANQUE = { listo: false, aviso: null, faltan: null, total: null, comprobando: false };
  window.__SL_ARRANQUE__ = ARRANQUE;

  var TIEMPO_LIMITE = 9000;

  // Dos señales distintas de "el visor arranco": la que le da `__visorListo()`
  // (src/app.js lo llama al terminar de arrancar) y la que deja el propio visor
  // en el DOM (`body[data-ready]`). Con las dos, el vigia no puede equivocarse
  // aunque el orden de carga se tuerza.
  function appArrancada() {
    if (ARRANQUE.listo) return true;
    var b = document.body;
    return !!(b && b.dataset && b.dataset.ready === "1");
  }

  window.__visorListo = function () {
    ARRANQUE.listo = true;
    quitarVigia();
  };

  window.__visorFallo = function (msg) {
    if (appArrancada()) return;                 // ya iba bien: no tapamos nada
    ARRANQUE.aviso = msg ? String(msg) : "error sin mensaje";
    pintarVigia();
  };

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function quitarVigia() {
    var el = document.getElementById("vigiaCtn");
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // Compara los archivos que deberia tener el APK con los que responde de
  // verdad el servidor interno. Es la parte que convierte "no arranca" en
  // "faltan src/world.js, src/net.js y 41 mas".
  function comprobarManifiesto() {
    if (ARRANQUE.comprobando || appArrancada()) return;
    ARRANQUE.comprobando = true;
    fetch("manifiesto.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("el APK responde " + r.status + " pidiendo manifiesto.json");
        return r.json();
      })
      .then(function (data) {
        var lista = Array.isArray(data) ? data : ((data && data.modulos) || []);
        ARRANQUE.total = lista.length;
        return Promise.all(lista.map(function (rel) {
          return fetch(rel, { cache: "no-store" }).then(
            function (r) { return r.ok ? null : rel + "   (responde " + r.status + ")"; },
            function () { return rel + "   (no responde)"; }
          );
        }));
      })
      .then(function (res) {
        ARRANQUE.faltan = res.filter(Boolean);
        pintarVigia();
      })
      .catch(function (e) {
        ARRANQUE.total = null;
        ARRANQUE.faltan = ["(no se pudo leer manifiesto.json: " + (e && e.message ? e.message : e) + ")"];
        pintarVigia();
      });
  }

  function pintarVigia() {
    if (appArrancada()) return;
    var host = document.body || document.documentElement;
    if (!host) return;
    var el = document.getElementById("vigiaCtn");
    if (!el) {
      el = document.createElement("div");
      el.id = "vigiaCtn";
      host.appendChild(el);
    }

    var faltan = ARRANQUE.faltan;
    var listaHtml;
    if (faltan === null) {
      listaHtml = "<p class='vEsp'>Comprobando si al APK le falta algún archivo del visor&hellip;</p>";
    } else if (!faltan.length && ARRANQUE.total) {
      listaHtml = "<p class='vOk'>El visor tiene los " + ARRANQUE.total +
        " archivos que debería: no falta ninguno. Entonces el problema está en el " +
        "propio código, no en la instalación: míranos el informe de depuración.</p>";
    } else {
      listaHtml = "<p class='vBad'>Faltan <b>" + faltan.length + "</b> archivos del visor" +
        (ARRANQUE.total ? " de los " + ARRANQUE.total + " que debería tener" : "") + ":</p><ul>" +
        faltan.slice(0, 16).map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") +
        (faltan.length > 16 ? "<li>&hellip;y " + (faltan.length - 16) + " más</li>" : "") +
        "</ul>";
    }

    el.innerHTML =
      "<div class='vBox'>" +
      "<h1>El visor no ha arrancado</h1>" +
      "<p>Se quedó en «Preparando el mundo…» porque <b>no se llegó a ejecutar " +
      "JavaScript</b>: el HTML se ve, pero ningún módulo del visor cargó.</p>" +
      (ARRANQUE.aviso ? "<p class='vErr'>Detalle: " + esc(ARRANQUE.aviso) + "</p>" : "") +
      listaHtml +
      "<p>Casi siempre significa que al subir el proyecto a GitHub <b>no se subió " +
      "la carpeta <code>src/</code> completa</b>, y el APK se compiló con el visor a " +
      "medias. Sube <code>src/</code> entera al repositorio y vuelve a lanzar " +
      "«Build APK» en GitHub Actions.</p>" +
      "<div class='vBtns'>" +
      "<button id='vigiaReintentar' class='vB1'>Reintentar</button>" +
      "<button id='vigiaCopiar' class='vB2'>Copiar informe</button>" +
      "</div>" +
      "<p class='vPie'>Para ver el detalle técnico: conecta el móvil por USB y abre " +
      "<code>chrome://inspect</code> en el ordenador.</p>" +
      "</div>";

    var rb = document.getElementById("vigiaReintentar");
    if (rb) rb.onclick = function () { location.reload(); };
    var cb = document.getElementById("vigiaCopiar");
    if (cb) cb.onclick = function () {
      var texto = "Visor SL no arranca.\n" +
        "aviso: " + (ARRANQUE.aviso || "(ninguno)") + "\n" +
        "manifiesto: " + (ARRANQUE.total === null ? "no legible" : ARRANQUE.total + " archivos") + "\n" +
        "faltan: " + (ARRANQUE.faltan === null ? "(comprobando)" :
          (ARRANQUE.faltan.length ? "\n  " + ARRANQUE.faltan.join("\n  ") : "ninguno")) + "\n" +
        "url: " + location.href + "\n" +
        "agente: " + navigator.userAgent + "\n";
      var listo = function () { cb.textContent = "Copiado"; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(texto).then(listo, function () { cb.textContent = texto; });
      } else {
        cb.textContent = texto;
      }
    };

    if (!document.getElementById("vigiaEstilo")) {
      var st = document.createElement("style");
      st.id = "vigiaEstilo";
      st.textContent =
        "#vigiaCtn{position:fixed;inset:0;z-index:2147483000;background:#0b0f18;color:#dfe6f2;" +
        "font:14px/1.5 system-ui,sans-serif;overflow:auto;-webkit-overflow-scrolling:touch;padding:18px}" +
        "#vigiaCtn .vBox{max-width:640px;margin:0 auto;padding-bottom:24px}" +
        "#vigiaCtn h1{font-size:18px;margin:0 0 10px;color:#ffb4b4}" +
        "#vigiaCtn p{margin:8px 0}" +
        "#vigiaCtn code{background:#1a2233;padding:1px 5px;border-radius:4px;font-size:12px}" +
        "#vigiaCtn .vErr{color:#ffd479;word-break:break-word}" +
        "#vigiaCtn .vEsp{color:#9fb0c8}" +
        "#vigiaCtn .vOk{color:#9ff0c4}" +
        "#vigiaCtn .vBad{color:#ffb4b4}" +
        "#vigiaCtn ul{margin:6px 0 6px 18px;padding:0;font-family:ui-monospace,monospace;font-size:12px;" +
        "color:#cfe0f5;max-height:34vh;overflow:auto}" +
        "#vigiaCtn .vBtns{display:flex;gap:8px;margin:14px 0}" +
        "#vigiaCtn button{flex:1;padding:12px;border:0;border-radius:10px;font-size:15px;font-weight:600}" +
        "#vigiaCtn .vB1{background:#2f7fd6;color:#fff}" +
        "#vigiaCtn .vB2{background:#1e2a3d;color:#cfe0f5}" +
        "#vigiaCtn .vPie{font-size:12px;color:#8b9bb4}";
      (document.head || document.documentElement).appendChild(st);
    }
    if (ARRANQUE.faltan === null) comprobarManifiesto();
  }
  window.__visorVigia = pintarVigia;

  // Un modulo o un archivo que no carga. El navegador no dice cual en el
  // mensaje, pero si deja ver el elemento culpable: de ahi el `src`.
  function esDelVisor(url) {
    return typeof url === "string" && url.indexOf("src/") !== -1;
  }

  window.addEventListener("error", function (ev) {
    var t = ev && ev.target;
    if (t && t !== window && (t.tagName === "SCRIPT" || t.tagName === "LINK")) {
      var url = t.src || t.href || "";
      if (esDelVisor(url)) {
        ARRANQUE.aviso = "no se pudo cargar " + String(url).split("/").slice(-3).join("/");
        setTimeout(pintarVigia, 1500);   // margen por si el visor arranca igual
        return;
      }
    }
    if (!appArrancada() && ev && ev.message) {
      ARRANQUE.aviso = ev.message + (ev.lineno ? " (línea " + ev.lineno + ")" : "");
      setTimeout(pintarVigia, 800);
    }
  }, true);

  window.addEventListener("unhandledrejection", function (ev) {
    if (appArrancada()) return;
    var r = ev && ev.reason;
    ARRANQUE.aviso = "promesa rechazada: " + (r && r.message ? r.message : r);
    setTimeout(pintarVigia, 800);
  });

  setTimeout(function () {
    if (appArrancada()) return;
    if (ARRANQUE.aviso === null) ARRANQUE.aviso = "el visor no arrancó en " + (TIEMPO_LIMITE / 1000) + " segundos";
    pintarVigia();
    comprobarManifiesto();
  }, TIEMPO_LIMITE);

  // ---------------------------------------------------------------- IndexedDB
  // Un unico almacen `kv` con clave completa `carpeta + "\u0000" + clave`. El
  // separador es el mismo que usa el plugin de perchance, y las consultas por
  // carpeta usan un rango sobre el prefijo, asi que no hay que recorrer todo.
  var DB_NAME = "visor-sl";
  var STORE = "kv";
  var SEP = "\u0000";
  var BASE_FOLDERS = ["region", "inventory", "avatar", "perfil", "visor"];

  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  // Ejecuta `fn(store)` dentro de una transaccion y resuelve cuando la
  // transaccion ha COMPROMETIDO (no cuando responde la peticion): asi al volver
  // de `set()` el dato esta de verdad escrito, que es lo que espera el visor.
  function run(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var store = tx.objectStore(STORE);
        var box = { value: undefined };
        try { fn(store, box); } catch (e) { reject(e); return; }
        tx.oncomplete = function () { resolve(box.value); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("transaccion abortada")); };
      });
    });
  }

  function fullKey(folder, key) { return folder + SEP + key; }

  function makeFolder(name) {
    var prefix = fullKey(name, "");

    function get(key) {
      return run("readonly", function (store, box) {
        var req = store.get(fullKey(name, key));
        req.onsuccess = function () { box.value = req.result; };
      });
    }
    function set(key, value) {
      return run("readwrite", function (store) {
        store.put(value, fullKey(name, key));
      }).then(function () { return true; });
    }
    function del(key) {
      return run("readwrite", function (store) {
        store.delete(fullKey(name, key));
      }).then(function () { return true; });
    }
    function entries() {
      return run("readonly", function (store, box) {
        var out = [];
        var req = store.openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur) { box.value = out; return; }
          out.push([String(cur.key).slice(prefix.length), cur.value]);
          cur["continue"]();
        };
      });
    }
    function keys() { return entries().then(function (e) { return e.map(function (p) { return p[0]; }); }); }
    function values() { return entries().then(function (e) { return e.map(function (p) { return p[1]; }); }); }
    function setMany(pairs) {
      return run("readwrite", function (store) {
        (pairs || []).forEach(function (p) { store.put(p[1], fullKey(name, p[0])); });
      }).then(function () { return true; });
    }
    function getMany(ks) {
      return Promise.all((ks || []).map(function (k) { return get(k); }));
    }
    function deleteMany(ks) {
      return run("readwrite", function (store) {
        (ks || []).forEach(function (k) { store.delete(fullKey(name, k)); });
      }).then(function () { return true; });
    }
    // `update` atomico: se hace lectura+escritura en la MISMA transaccion, que
    // es justo lo que garantiza IndexedDB con una transaccion "readwrite".
    function update(key, fn) {
      return run("readwrite", function (store, box) {
        var fk = fullKey(name, key);
        var req = store.get(fk);
        req.onsuccess = function () {
          var next = fn(req.result);
          store.put(next, fk);
          box.value = next;
        };
      });
    }
    function clear() {
      return run("readwrite", function (store) {
        var req = store.openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
        req.onsuccess = function () {
          var cur = req.result;
          if (!cur) return;
          cur["delete"]();
          cur["continue"]();
        };
      }).then(function () { return true; });
    }

    return {
      folder: name,
      get: get, set: set, delete: del,
      entries: entries, keys: keys, values: values,
      setMany: setMany, getMany: getMany, deleteMany: deleteMany,
      update: update, clear: clear,
    };
  }

  var folders = {};
  function folder(name) {
    if (!folders[name]) folders[name] = makeFolder(name);
    return folders[name];
  }
  BASE_FOLDERS.forEach(folder);

  var kv = {
    region: folders.region,
    inventory: folders.inventory,
    avatar: folders.avatar,
    perfil: folders.perfil,
    visor: folders.visor,
    // Igual que el plugin: `root.kv.subfolder("lo-que-sea")` da una carpeta
    // nueva sin tener que declararla antes.
    subfolder: function (name) { return folder(String(name)); },
  };

  // ---------------------------------------------------------------- root
  // ------------------------------------------------------- el puente de red
  // El WebView aplica CORS igual que Chrome: un `fetch` directo a
  // `login.agni.lindenlab.com` muere con un "Failed to fetch" que no explica
  // nada, porque Linden Lab no manda cabeceras CORS (y buena parte de los CDN
  // de Second Life tampoco). Eso NO se arregla desde JavaScript.
  //
  // El nucleo nativo (`ViewerServer.kt`) expone `/proxy?url=...`: se pide a un
  // camino del MISMO origen que esta pagina, asi que el navegador no tiene nada
  // que comprobar, y la peticion de verdad la hace Kotlin, que no esta sujeto a
  // CORS. Es el equivalente local del plugin `super-fetch` de perchance.
  //
  // Solo pasa por el puente lo que sale del aparato; lo de casa (los `src/`,
  // `character/`, el retransmisor) se pide directamente, sin dar una vuelta.
  var URL_DE_CASA = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i;

  function superFetch(url, opts) {
    var u = url === null || url === undefined ? "" : String(url);
    if (/^https?:\/\//i.test(u) && !URL_DE_CASA.test(u)) {
      return fetch("/proxy?url=" + encodeURIComponent(u), opts);
    }
    return fetch(u, opts);
  }

  // Una linea que se pueda LEER en el telefono: la consola del WebView no se ve
  // (haría falta un cable y chrome://inspect), asi que se manda al registro
  // nativo, que viaja dentro del informe (Ajustes -> Depuracion e informes).
  function anotar(texto) {
    try {
      if (window.VisorDiag && typeof window.VisorDiag.logNativo === "function") {
        window.VisorDiag.logNativo(texto);
      }
    } catch (e) { /* el puente es opcional */ }
    try { if (typeof console !== "undefined" && console.log) console.log("[env] " + texto); } catch (e) { /* nada */ }
  }

  // ------------------------------------------------------- prueba de la salida
  // Pide un recurso publico pequeno a traves del puente nada mas arrancar: deja
  // escrito si el telefono tiene salida a internet y si el puente responde, que
  // es justo lo que no se ve cuando el login falla con un "Failed to fetch".
  function probarSalida() {
    var destino = "https://login.agni.lindenlab.com/cgi-bin/login.cgi";
    var t0 = Date.now();
    var pedido;
    try {
      pedido = fetch("/proxy?url=" + encodeURIComponent(destino));
    } catch (e) {
      anotar("salida a internet: no se pudo pedir (" + (e && e.message ? e.message : e) + ")");
      return;
    }
    pedido.then(function (r) {
      return r.text().then(function (texto) {
        if (r.status >= 500) {
          anotar("salida a internet FALLIDA: el puente contesta HTTP " + r.status + " — " + String(texto).slice(0, 200));
        } else {
          anotar("salida a internet OK: HTTP " + r.status + " en " + (Date.now() - t0) + " ms (login.agni.lindenlab.com alcanzable)");
        }
      });
    }).catch(function (e) {
      anotar("salida a internet FALLIDA: " + (e && e.message ? e.message : e));
    });
  }

  if (!window.root) {
    window.root = {
      kv: kv,
      superFetch: superFetch,
      // Sin `createServerSocket`: en la app el enlace va por el nucleo nativo.
      // `src/net.js` comprueba que existe antes de usarlo, asi que el visor
      // simplemente no ofrece multijugador de perchance.
    };
  } else {
    if (!window.root.kv) window.root.kv = kv;
    if (!window.root.superFetch) window.root.superFetch = superFetch;
  }

  // El campo del retransmisor: se rellena con el enlace interno de la app.
  function fillRelayField() {
    var el = document.getElementById("slRelayEl");
    if (!el) return false;
    if (!el.value && relayUrl) {
      el.value = relayUrl;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }

  if (relayUrl) {
    try { kv.visor.set("retransmisor", relayUrl); } catch (e) { /* nada */ }
  }

  // El panel de entrada se construye pronto, pero por si acaso se reintenta.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      if (!fillRelayField()) setTimeout(fillRelayField, 400);
    });
  } else {
    if (!fillRelayField()) setTimeout(fillRelayField, 400);
  }

  // La prueba de salida va en segundo plano: no retrasa el arranque.
  setTimeout(probarSalida, 1500);

  console.log("[env] app Android lista. Enlace interno:", relayUrl || "(sin relay)", "· puente UDP:", udpUrl || "(sin puente)");
})();
