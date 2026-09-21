# Visor SL — visor de Second Life con motor web + app Android

Visor SL es un visor de Second Life escrito como **motor web (WebGL / three.js)** y
empaquetado dentro de una **app Android** (WebView + puente nativo para UDP/HTTP).
La idea es recuperar lo que hacía **Lumiya** (visor Android de SL, abandonado en 2016)
con un motor propio en lugar del motor C++ original, y compilar el APK en GitHub
Actions sin necesidad de Android Studio.

Autor del proyecto: yossfu · repositorio de trabajo: `yossfu/visor-sl`

---

## 1. Cómo se compila y se sube

1. Descarga `visor-sl-app.zip` y `subir-a-github-y-compilar.bat` desde el chat y
   ponlos en la misma carpeta.
2. Doble clic en `subir-a-github-y-compilar.bat` (necesita Git para Windows).
   El .bat descomprime el zip, clona/actualiza `https://github.com/yossfu/visor-sl.git`,
   copia los archivos, hace commit y push.
3. Abre `https://github.com/yossfu/visor-sl/actions`: el workflow **Compilar APK**
   compila `assembleDebug` y `assembleRelease` y publica el artefacto
   **visor-sl-apk** con los dos APK. Descárgalo al final de la página de la ejecución.
4. Instala el APK en el móvil (`app-debug.apk`). En el móvil abre la app → botón
   **Conectar a SL** → nombre completo y contraseña.

También puedes abrir la carpeta descomprimida en Android Studio y pulsar *Run*.

### Estructura del zip / repositorio

```
visor-sl-app/
  settings.gradle.kts build.gradle.kts gradle.properties gradlew gradle/wrapper/…
  app/build.gradle.kts app/proguard-rules.pro
  app/src/main/AndroidManifest.xml
  app/src/main/java/net/visorsl/viewer/{MainActivity.kt, NativeBridge.kt}
  app/src/main/assets/www/…          <- el visor web completo (autocontenido)
  www/…                              <- la misma copia, para abrir en un navegador de PC
  .github/workflows/build-apk.yml    <- compila el APK en cada push
  index.html                         <- redirección de conveniencia
  README.md SPEC.md TODO.md LUMIYA.md
  subir-a-github-y-compilar.bat LEEME.txt
```

`www/index.html` se puede abrir directamente en un navegador de PC: arranca en
**modo demo** (isla procedural) sin conexión. Para entrar al grid real hace falta
el APK, porque el protocolo de SL necesita **UDP** y un navegador no puede abrirlo.

---

## 2. Qué hace ya

- **Motor de prims fiel a Lumiya**: `prims.js` es un port de `PrimProfile`,
  `PrimPath`, `PrimVolume`, `PrimVolumeFace` (cortes, huecos, torsión, estrechamiento,
  inclinación, revoluciones, curvas de perfil/camino, revolución completa…).
- **Terreno SL**: decodificación DCT de las capas (`LayerData`) con
  `decodeTerrainLayer` + mezcla de 4 texturas por altura/pendiente.
- **TextureEntry real**: parseo del formato de red (bitfield por cara con
  continuación de 7 bits, RGBA, repeat/offset/rotation, glow, material, media).
- **Protocolo SL completo** (`message_template.msg` de 483 mensajes):
  login XML-RPC, capacidades (seed), EventQueueGet, circuito UDP con secuencia,
  ACKs adjuntos, zerocoding y reenvíos, RegionHandshake/Reply,
  CompleteAgentMovement, AgentThrottle, AgentUpdate (10 Hz), chat
  (ChatFromViewer/ChatFromSimulator), IM, ObjectUpdate,
  ObjectUpdateCached/Compressed, ImprovedTerseObjectUpdate, KillObject,
  CoarseLocationUpdate, UUIDNameRequest/Reply.
- **Presupuesto de prims**: de todos los objetos de la región sólo los ~900 más
  cercanos (dentro de 320 m) tienen geometría real; el resto se guarda como
  metadatos y entra/sale según te mueves (`updateResidency`).
- **Texturas del grid**: descarga por la capacidad `GetTexture`; el JPEG2000 se
  decodifica si hay decodificador disponible (ver TODO) y mientras tanto se usa
  un color plano por UUID.
- **Otros residentes**: cápsula + cartel con el nombre, alimentado por
  ObjectUpdate (PCode 47) y CoarseLocationUpdate.
- **HUD**: fps/tris/prims/objetos, inspector de prims en vivo, panel de mundo,
  registro/chat, modal de login.

## 3. Arquitectura (código)

| fichero | papel |
| --- | --- |
| `src/web/js/app.js` | `App`: viewer + world + UI + bucle; entrada (clic, teclado), connect/disconnect |
| `src/web/js/renderer.js` | `Viewer` (three.js, sol, cielo, agua, sombras), `CameraController`, `getCamAxes()` |
| `src/web/js/world.js` | `World`: terreno, prims, materiales por cara, LOD, picking, avatares, `applyTexture` |
| `src/web/js/prims.js` | motor de geometría de prims (port de Lumiya) |
| `src/web/js/terrain.js` | terreno (BitBuffer, DCT, `Terrain`, malla) |
| `src/web/js/texture-entry.js` | parseo de TextureEntry + matrices UV |
| `src/web/js/textures.js` | texturas procedurales + `TextureLibrary` (claves `gen:*` y UUID) |
| `src/web/js/demo.js` | región de demostración (isla, faro, pabellón, galería…) |
| `src/web/js/message-template.js` | parser del `.msg` + codificador/decodificador de campos (LE), zerocode, números de mensaje |
| `src/web/js/udp.js` | cabecera de paquete, ACKs, `Circuit` (secuencia, reenvíos) |
| `src/web/js/transport.js` | puente nativo Android (UDP + HTTP), `superFetch`/`fetch` de reserva |
| `src/web/js/sl-session.js` | sesión SL: login, caps, circuito, handshake, objetos, chat |
| `src/web/js/object-update.js` | datos "terse" (16/32/48/60/76 bytes), ExtraParams, formas |
| `src/web/js/llsd.js` | LLSD XML / Notation / Binary + XML-RPC (login) |
| `src/web/js/md5.js` | MD5 (hash de contraseña `$1$…`) |
| `src/web/js/j2c.js` | decodificador JPEG2000 perezoso (texturas del grid) |
| `src/web/data/message_template.msg` | plantilla de mensajes oficial de SL (241 KB) |
| `src/web/vendor/three.module.min.js` | three.js r169 (vendorizado) |
| `src/tools/pack.mjs` | empaqueta `visor-sl-app.zip` a partir de estas fuentes |
| `src/tools/proto-selftest.mjs` | 24 pruebas del protocolo (ver abajo) |
| `src/android/**` | proyecto Gradle + WebView + `NativeBridge` (UDP/HTTP) |
| `src/ci/build-apk.yml` | workflow de GitHub Actions |

Las rutas de esa tabla son las de la **carpeta de trabajo** (el `src/web/` del
editor). En el zip y en el repositorio el visor vive en
`app/src/main/assets/www/` (y una copia igual en `www/`), y los documentos
`README.md`/`SPEC.md`/`TODO.md`/`LUMIYA.md` van en la raíz.

## 4. Pruebas

En el editor de Perchance (o en la consola del visor web):

```js
await window.runVisorSelfTest();
```

Comprueba 24 cosas sin necesidad de cuenta: que la plantilla tiene 483 mensajes,
que los números de mensaje son **byte a byte** los mismos que los de Lumiya
(descubiertos en el código decompilado), que `ChatFromViewer` coincide con la
referencia, que `AgentUpdate` mide 115 bytes, ida y vuelta de paquetes con
zerocode y ACKs, decodificación de posición/rotación "terse", ExtraParams,
XML-RPC de login, LLSD notation/binary y un **ObjectUpdate completo byte a byte**
más su decodificación.

Nota: en el editor el visor se ejecuta dentro de un iframe con service worker;
si `fetch("src/...")` falla con "Load failed" es porque el navegador no soporta
service workers (p. ej. el navegador interno de la app de Google en iOS).

## 5. Avisos / límites conocidos

- El diseño del protocolo está verificado contra el código decompilado de Lumiya
  y contra la plantilla oficial, pero **no se ha probado contra el grid real**
  (no hay credenciales en el entorno de desarrollo). Ver `TODO.md` para la lista
  de comprobaciones al conectar por primera vez.
- El navegador no puede abrir UDP: sin el APK, el botón de conectar avisa y
  se queda en modo demo.
- Las texturas del grid son JPEG2000; sin decodificador se ven colores planos.
- Los avatares son cápsulas con el nombre, no mallas con esqueleto.
- Sin inventario, apariencia, sculpt maps, mallas, grupos, búsqueda, voz, RLV,
  minimapa ni dinero (ver `LUMIYA.md`).
- La app Android sirve el visor desde `assets/www` con un interceptor propio
  (`MainActivity.serveAsset`), con MIME correctos (`text/javascript` para los
  módulos ES), `Cache-Control: no-store` y página de error legible si algo
  falla. Necesita WebGL2: si el WebView del móvil es viejo, la propia página lo
  avisa.
