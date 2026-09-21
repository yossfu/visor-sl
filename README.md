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
  login XML-RPC, seed capability por **POST con array LLSD de nombres**,
  EventQueueGet, circuito UDP con secuencia, ACKs (mensaje `PacketAck` y trailer
  adjunto), zerocoding y reenvíos, arranque de agente
  (`UseCircuitCode` → acuse → `CompleteAgentMovement` → `AgentMovementComplete`),
  RegionHandshake/Reply, AgentThrottle, AgentUpdate (10 Hz),
  `SimulatorViewerTimeMessage` (sol/hora de la región), chat
  (ChatFromViewer/ChatFromSimulator), IM, ObjectUpdate,
  ObjectUpdateCached/Compressed, ImprovedTerseObjectUpdate, KillObject,
  CoarseLocationUpdate, UUIDNameRequest/Reply.
- **Presupuesto de prims**: de todos los objetos de la región sólo los ~900 más
  cercanos (dentro de 320 m) tienen geometría real; el resto se guarda como
  metadatos y entra/sale según te mueves (`updateResidency`).
- **Texturas del grid**: descarga por la capacidad `GetTexture`, con reserva por
  `ViewerAsset`; el JPEG2000 se decodifica con **OpenJPEG wasm vendorizado**
  (`src/web/vendor/openjpeg/`, sin CDN) y se sube a la GPU como textura sRGB.
- **Otros residentes**: mallas **reales** del avatar SL (`avatar_head/upper_body/lower_body/eyelashes/eye.llm`, dentro del APK) con:
  - **forma**: los 253 parámetros del `AvatarAppearance` (avatar_lad.xml) resueltos con los *drivers* como en el visor oficial, aplicados como morphs **y** como escalas de hueso (Altura, Cadera, Hombros, Grosor…), así que cada residente es un cuerpo distinto, no una cápsula;
  - **piel y ropa**: las texturas *baked* (caras 8–11/19/20 del TextureEntry) del mismo paquete `GetTexture`; mientras llegan, el cuerpo se dibuja en su color de piel por defecto;
  - **animaciones reales**: los 118 assets de animación que trae la app (`data/avatar/anims.gz`, formato LLKeyframeMotion) reproducidos con el **blend por prioridad** del visor oficial (conjuntos de prioridad por hueso, ease-in/out cúbicos, bucle con in/out point) a partir de la lista que manda el simulador en `AvatarAnimation`;
  - cartel con el nombre siempre por encima (el nombre se pide con UUIDNameRequest).
- **Arreglo del "mundo de estructuras blancas"**: los `ObjectUpdateCompressed` se leían sólo hasta el UUID del dueño, pero la **forma del prim (23 B) y el TextureEntry (S32 + datos) van al final** del bloque, después de los parámetros extra. Sin eso cada prim comprimido se dibujaba como un cubo gris sin textura. Verificado en el simulador falso: 40/40 prims con forma y textura, 0 fallos de cola.
- **Al conectar se limpia el mundo demo**: `World.reset()` borra la isla de
  prueba (y su suelo a 3–46 m) antes del login, así que la región real no queda
  enterrada. Si el login falla, se vuelve al modo demo automáticamente.
- **HUD**: fps/tris/prims/objetos, inspector de prims en vivo, panel de mundo,
  registro/chat, modal de login.
- **Datos en el dispositivo**: el registro de sesión (hash de la contraseña, MFA
  recordado, último grid/usuario) y la **caché de texturas y assets** viven en
  carpetas propias de la app (`NativeBridge.cachePut/cacheGet`, `prefsSet/All`),
  que en Android **no necesitan ningún permiso**. Para sacar el registro del
  móvil hay un botón que lo escribe en *Descargas* con MediaStore (tampoco pide
  permiso en Android 10+; en versiones anteriores usa el permiso clásico).
- **GPU de verdad**: el WebView se crea con `hardwareAccelerated`, capa
  `LAYER_TYPE_HARDWARE` y el contexto three.js pide `powerPreference:
  "high-performance"`. Al arrancar el visor escribe en el registro qué GPU ha
  usado (`ANGLE (…Adreno…)`, `WebGL2`, tamaño máximo de textura) y avisa si ha
  caído a **renderizado por software** (SwiftShader), que es la causa típica de
  que vaya a tirones.
- **Diagnóstico de red/UDP** (botón ⧉ del registro y «Diagnóstico de red y UDP» en
  el menú ☰): informa de la red activa (wifi/datos/VPN), de si se puede crear un
  socket UDP, y manda **un datagrama de control a un servidor STUN de Google y un
  `UseCircuitCode` real al simulador** desde sockets desechables, diciendo cuál de
  los dos contesta. Separa así «esta red bloquea el UDP» de «el simulador ignoró
  nuestro paquete». Además se ejecuta solo cada vez que falla una conexión, y todo
  queda en el registro copiable (el modal no se puede copiar).

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
| `src/web/js/j2c.js` | decodificador JPEG2000 (OpenJPEG wasm vendorizado, carga perezosa) |
| `src/web/js/test/prims-selftest.js` | pruebas visuales de geometría de prims (`?test=prims`) |
| `src/web/js/test/fake-grid.js` | simulador falso en memoria: prueba todo el camino del grid sin cuenta (`?test=grid`) |
| `src/web/js/avatar/assets.js` | carga los assets que van dentro de la app (`.llm.gz`, `.xml.gz`, `anims.gz`) |
| `src/web/js/avatar/llm.js` | lector del formato `.llm` (mallas + morph targets) |
| `src/web/js/avatar/skeleton.js` | esqueleto de `avatar_skeleton.xml` (133 huesos, posiciones de reposo acumuladas) |
| `src/web/js/avatar/params.js` | `avatar_lad.xml`: tabla de sliders, orden de transmisión, drivers, `<bone scale/offset>` |
| `src/web/js/avatar/skin.js` | pose del esqueleto (escalas de forma + rotaciones/offsets de animación), *skinning* de 2 huesos por vértice, replantado al suelo |
| `src/web/js/avatar/builder.js` | construye el cuerpo (morph → huesos → geometría en sitio) y aplica las texturas baked |
| `src/web/js/avatar/anim-data.js` | formato LLKeyframeMotion + paquete de las 118 animaciones que trae la app |
| `src/web/js/avatar/animation.js` | reproducción: secuencias, ease-in/out, bucle y *blend* por prioridad por hueso |
| `src/web/js/test/avatar-test.js` | pruebas visuales de cuerpos y formas (`?test=avatar`) |
| `src/web/js/test/anim-test.js` | pruebas de animación (`?test=anim`, `?test=anim&anim=walk`) |
| `src/web/data/message_template.msg` | plantilla de mensajes oficial de SL (241 KB) |
| `src/web/vendor/three.module.min.js` | three.js r169 (vendorizado) |
| `src/web/vendor/openjpeg/` | OpenJPEG wasm (decodificador J2C/JPEG2000 real; `openjpegwasm_decode.js` + `.wasm`) |
| `src/tools/pack.mjs` | empaqueta `visor-sl-app.zip` a partir de estas fuentes |
| `src/tools/proto-selftest.mjs` | 54 pruebas del protocolo (ver abajo) |
| `src/android/**` | proyecto Gradle + WebView + `NativeBridge` (UDP/HTTP) |
| `src/ci/build-apk.yml` | workflow de GitHub Actions |

Las rutas de esa tabla son las de la **carpeta de trabajo** (el `src/web/` del
editor). En el zip y en el repositorio el visor vive en
`app/src/main/assets/www/` (y una copia igual en `www/`), y los documentos
`README.md`/`SPEC.md`/`TODO.md`/`LUMIYA.md` van en la raíz.

### Protocolo del puente nativo (JS ↔ `NativeBridge.kt`)

Cada llamada JS→nativo es un JSON con `id` y el nativo contesta con
`window.visornative({id, ok, …})`. En las llamadas de UDP viajan **dos**
identificadores distintos, a propósito:

- `id`: identifica **la llamada** (lo pone `nativeCall()` en `transport.js` y el
  nativo lo devuelve tal cual). Es la clave con la que JS empareja la respuesta.
- `chan`: identifica **el socket UDP** (canal) y es la clave de
  `udpChannels`/`channels` en los dos lados. Los datagramas entrantes viajan en
  lotes (`kind:"udpBatch"`, uno cada ~20 ms) y cada elemento lleva su `chan`.

Si el `id` del llamador pisara el de seguimiento, la respuesta nunca se
emparejaría y **toda** llamada UDP se quedaría colgada hasta agotar el tiempo de
espera — exactamente el fallo de la primera prueba real («Abriendo circuito UDP
con …» y después «Desconectado.»). No volver a pasar `id` desde el llamador.

## 4. Pruebas

En el editor de Perchance (o en la consola del visor web):

```js
await window.runVisorSelfTest();
```

Comprueba **70 cosas** sin necesidad de cuenta: que la plantilla tiene 483
mensajes, que los números de mensaje son **byte a byte** los mismos que los de
Lumiya (descubiertos en el código decompilado), que `ChatFromViewer` coincide con
la referencia, que `AgentUpdate` mide 115 bytes, ida y vuelta de paquetes con
zerocode y ACKs, decodificación de posición/rotación "terse" (32 B con
**cuaternión de 4 componentes**, ImprovedTerse de 44/60 B con su LocalID propio,
y el rechazo de blobs truncados), **terreno** (ida y vuelta de parches DCT,
dcOffset→nivel medio, parche vacío plano y **flujo truncado que lanza error en
vez de colgarse**), **TextureEntry** (textura, RGBA, repeat/offset, rotación,
material, media, glow), ExtraParams, **la petición de login completa comparada
con la del visor oficial** (struct XML-RPC plano, `first`/`last` con usuario de
una palabra, `$1$`+md5, `agree_to_tos`/`read_critical`/`extended_errors` como
enteros, `token`/`mfa_hash`) y su reto MFA, lectura de respuestas LLSD (XML plano
del simulador y notación), LLSD binary y un **ObjectUpdate completo byte a byte**
más su decodificación; y desde la ronda 6, **animaciones** (cabecera, ease-in/out,
prioridad por hueso, fotogramas de rotación en punto fijo → cuaternión y de
posición ±5 m).

Además hay un **simulador falso** para probar el camino completo del grid sin
cuenta ni red: abre el visor con `?test=grid` (o `await
import("./src/web/js/test/fake-grid.js").then(m => m.runFakeGrid(window.visor))`)
y el visor se conecta a un simulador en memoria que responde login XML-RPC,
capacidades, `GetTexture` (JPEG2000 real), EventQueueGet y envía RegionHandshake,
4× LayerData (256 parches), ~40 prims comprimidos, ObjectUpdate con TextureEntry,
dos avatares (con nombre), KillObject y pings — más un agente que camina.

Nota: en el editor el visor se ejecuta dentro de un iframe con service worker;
si `fetch("src/...")` falla con "Load failed" es porque el navegador no soporta
service workers (p. ej. el navegador interno de la app de Google en iOS).

## 5. Avisos / límites conocidos

- El diseño del protocolo está verificado contra el código decompilado de Lumiya
  y contra la plantilla oficial, y el mundo/avatares/animaciones están probados
  en el simulador falso; lo que **sigue sin probarse contra el grid real** es
  todo lo que necesita una cuenta (ver `TODO.md`).
- El navegador no puede abrir UDP: sin el APK, el botón de conectar avisa y
  se queda en modo demo.
- Las texturas del grid son JPEG2000 y ya se decodifican con OpenJPEG wasm; si
  `WebAssembly` no está disponible se cae a un color plano por UUID.
- **Los avatares usan las mallas reales de SL** con forma, texturas baked y
  animaciones. Dos límites honestos:
  - el *skinning* ata cada vértice a los **dos huesos más cercanos** de la malla
    (el peso por vértice del `.llm` está en un orden que el archivo no expone),
    así que en posturas muy forzadas los codos/rodillas pueden verse algo
    deformes;
  - sólo se reproducen las **118 animaciones que trae la app**; una animación
    subida por un residente necesita una transferencia de assets por UDP
    (`TransferRequest`/`TransferInfo`/`TransferPacket`), que es el siguiente
    trozo de protocolo pendiente (hasta entonces esa animación simplemente no se
    reproduce y queda anotada en el registro).
- **Ropa e inventario**: en un cuerpo de sistema el simulador *cuece* la ropa en
  las texturas baked, así que la ropa puesta **ya se ve**; lo que falta es la
  ventana de inventario para cambiarla (caras 8–11 del aviso de apariencia y las
  texturas de cada prenda ya están en el código).
- Sin sculpt maps, mallas, grupos, búsqueda, voz, RLV, minimapa ni dinero (ver
  `LUMIYA.md`).
- La app Android sirve el visor desde `assets/www` con un interceptor propio
  (`MainActivity.serveAsset`), con MIME correctos (`text/javascript` para los
  módulos ES), `Cache-Control: no-store` y página de error legible si algo
  falla. Necesita WebGL2: si el WebView del móvil es viejo, la propia página lo
  avisa.
