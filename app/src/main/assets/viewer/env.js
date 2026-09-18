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
//   * `root.superFetch`    -> `fetch` normal (la app no atraviesa CORS: si el
//                             visor necesita pedir algo, se le da una direccion
//                             que el WebView ya pueda pedir).
//   * `root.createServerSocket` -> NO se define: el multijugador de la app va
//                             por dentro del enlace con el nucleo nativo
//                             (`RelayServer`), no por el servidor de perchance.
//                             `src/net.js` detecta su ausencia y degrada solo.
//
// Ademas lee el parametro `?relay=ws://127.0.0.1:PUERTO` que le pasa
// `MainActivity` (el enlace interno con el nucleo nativo) y lo deja escrito en
// el campo del retransmisor, para que el usuario no tenga que copiarlo a mano.

(function () {
  "use strict";

  var params = new URLSearchParams(window.location.search || "");
  var relayUrl = (params.get("relay") || "").trim();

  window.__SL_APP__ = {
    android: true,
    relayUrl: relayUrl,
    version: "0.1.0",
  };

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
  function superFetch(url, opts) {
    return fetch(url, opts);
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

  console.log("[env] app Android lista. Enlace interno:", relayUrl || "(sin relay)");
})();
