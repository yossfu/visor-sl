# TODO — Visor SL

Ordenado por impacto. Lo primero es lo que hay que hacer en cuanto se pruebe con
una cuenta real en el grid.

## Ronda 10 — lo hecho en esta revisión (informe 7)

El informe 7 (móvil, 900 prims) traía la pista decisiva: `LayerData` **sí**
llegaba (113 mensajes, `tipos 55×85, 76×28`) y el terreno seguía en
«PLACEHOLDER PLANO»; en pantalla, «cubos con cuadrículas blancas y un sinfín de
geometrías extrañas»; el avatar ya salía con cuerpo pero deforme y sin texturas.
Lo crucial era el mundo, así que esta ronda ha ido a eso, más el buscador de
tierras que pidió el usuario para probar el teletransporte:

- [x] **Terreno: el tipo es el 76 y lleva cabecera de 4 bytes.** Leer sólo el
      tipo 0 (y sin saltar `stride`/`patchSize`/`type`) es la razón exacta de que
      nunca llegara terreno. Corregido en `terrain.js` + `sl-session.js`; el
      arnés escribe la cabecera y hay pruebas de ida y vuelta.
- [x] **Máscara de caras del `TextureEntry` en big-endian** (verificado contra
      `unpack_TEField` del visor oficial). Con más de 7 caras, la textura se
      asignaba a **otras** caras. Además el lector ya no revienta con entradas
      truncadas.
- [x] **Esculturas**: implementadas de verdad (`prims.js`, port de
      `sculptGenerateMapVertices`/`sculpt_calc_mesh_resolution`); los mapas
      viajan por la cola de texturas y `world.setSculptMap` reconstruye los prims
      que esperaban. Mapa sin relieve o sin llegar → no se dibuja. Arnés aislado
      `?test=sculpt` + 6 pruebas nuevas.
- [x] **Los objetos *mesh* ya no se dibujan como cajas** (se cuentan y salen en
      el informe). Es la otra mitad de las «geometrías extrañas».
- [x] **Texturas**: decodificador en un *pool* de hasta 3 hilos y la caché del
      móvil guarda el **PNG ya decodificado** (se acabó re-decodificar todo en
      cada entrada). El diagnóstico dice cuántos hilos.
- [x] **Buscador de tierras y teletransporte** (botón *Lands* y ☰ → *Buscar
      tierras y teletransportarse*): búsqueda por nombre/SLURL/coordenadas, mapa
      del grid con rejilla y etiquetas, elección del punto exacto, «estás aquí» y
      `TeleportLocationRequest` → `TeleportStart`/`TeleportProgress` →
      `TeleportFinish` (cola de eventos) → `moveToSim()`. Probado de punta a punta
      con `?test=grid&tp=1004,1006`.
- [x] **`main.pjs` con `$meta`** (título, descripción, etiquetas) y la lista
      `regionesDePrueba` que alimenta los botones del buscador. `superFetch`
      importado para que el buscador y el mapa funcionen también sin el APK.
- [x] Versión **1.5.0 (build 6)**.

Pendiente de comprobar en el móvil (informe 8), por orden:

- [ ] Que el registro empiece por `app 1.5.0 (build 6)`.
- [ ] La fila **terreno**: ya no debe decir «PLACEHOLDER PLANO», y la línea de
      `LayerData` debe mostrar `cabecera stride … patch 16x16 tipo 76` y
      **parches aplicados** (256 por capa completa).
- [ ] ☰ → **Ver las texturas decodificadas** con muchas casillas (no 4).
- [ ] La línea `TEXTURAS:` con `decodificadas` mucho mayor que 312 (el *pool* de
      3 hilos) y `en cola` bajando hasta 0.
- [ ] La parte nueva `esculturas: N dibujadas de M` en el informe de texturas: si
      `M` es alto y `dibujadas` 0, los mapas no están llegando y hay que mirar
      esa cola.
- [ ] **Buscador de tierras**: buscar «Ahern» y que el mapa se pinte, y pulsar
      Teletransportar (el registro debe decir `TeleportStart`, luego
      `TeleportFinish: simulador de destino …` y «Región: …» del destino).
- [ ] Si sigue habiendo «geometrías extrañas», una captura con el objeto de
      cerca: con esculturas y mesh ya descartados, lo siguiente sería **mallas**
      (hay que implementar el asset LLMesh) y **prims flexibles**.

## Ronda 9 — lo hecho en esta revisión (informe 6)

El informe 6 (cuenta ExeQiel, región con 900 prims) traía: **los 8 archivos del
avatar en 404** dentro del APK (`avatar_lad.xml.gz`, `avatar_skeleton.xml.gz`,
los `.llm.gz` y `anims.gz`), el avatar como cápsula, el terreno en placeholder
plano con 200 mensajes `LayerData` recibidos, y —lo más importante— una petición
explícita del usuario: **si las texturas se guardan en el móvil, ¿cómo se
comprueba que un arreglo cambió algo?** Hecho en esta ronda:

- [x] **Los assets del avatar ya no se llaman `.gz`.** El servidor de assets del
      WebView contestaba 404 a **todos** los `.gz` mientras servía sin problema
      `j2c-sample.bin` en la misma carpeta: la extensión era la única diferencia.
      Ahora van gzip igual que antes pero con nombre neutro
      (`avatar_head.llm.bin`, `avatar_lad.xml.bin`, `anims.bin`, …) y el
      cargador detecta el gzip por su cabecera (`1f 8b`), no por el nombre.
- [x] **Segundo camino para leer los assets**: si el servidor de assets falla, el
      mismo archivo se lee por el puente nativo (`assetsList` + `assetGet`,
      `assets.open`). El diagnóstico dice cuántos vinieron por cada camino, que
      es lo que separa «no está en el APK» de «el WebView no lo sirve».
- [x] **Caché con revisión** (`cache.js`): las copias se guardan como
      `r2_tex_<uuid>`; si la revisión cambia, la caché se borra al arrancar (con
      una línea en el registro). Ninguna copia vieja puede disimular un arreglo.
- [x] **Caché que se comprueba y se repara sola**: antes de usar una copia se
      mira que empiece como una imagen y que se pueda decodificar; si no, se
      borra y se vuelve a pedir al grid (antes una copia mala era permanente).
- [x] **Panel ☰ → «Caché y verificación»**: tamaño y nº de archivos,
      «Verificar lo guardado» (cabecera de cada archivo, en el nativo),
      «Borrar caché ahora» y **modo sin caché** (todo se pide al grid otra vez).
- [x] **Los 404 no se cachean y la caché HTTP se vacía por build**
      (`MainActivity`): `ETag` = build + ruta, `max-age=0, must-revalidate`, y
      `no-store` en los errores; al arrancar con un `versionCode` nuevo se vacía
      la caché del WebView (los datos de la app sobreviven a actualizar el APK,
      así que un 404 cacheado se quedaba para siempre).
- [x] **☰ → «Ver las texturas decodificadas»**: rejilla con los píxeles que el
      visor tiene en memoria (los mismos `ImageBitmap` que usa el mundo), con
      uuid y tamaño. Una captura de esa pantalla dice si el problema está en la
      decodificación o en otra parte.
- [x] **Terreno contado por tipos**: `LayerData` se cuenta por `LayerID.Type` y,
      si uno de tipo 0 no produce parches, se registra su tamaño y su primer
      byte. El informe dirá si el simulador no manda parches o si llegan con otro
      tipo.
- [x] Versión **1.4.0 (build 5)**.
- [x] El arnés local (`?test=grid`) tiene caché y preferencias en memoria, así
      que todo esto se prueba sin móvil (verificado: 40 copias buenas, una copia
      corrupta detectada, borrada y vuelta a pedir).

Pendiente de comprobar en el móvil (informe 7):

- [ ] Que el registro empiece por `app 1.4.0 (build 5)` y que aparezca la línea
      «Caché: revisión r2 … borrados N archivos» (es lo que borra las 212 MB
      viejas: en la siguiente conexión las texturas se descargan limpias).
- [ ] ☰ → **Diagnóstico completo**: la fila `(APK) carpeta data/avatar` debe decir
      **9 archivos**, y las 8 filas `*.bin` en **OK**; si alguna sigue en FALLA,
      hay que mirar «transporte de los archivos de avatar» para ver si vino por
      el puente nativo.
- [ ] Que los avatares se vean **con cuerpo** (ya no cápsulas) a los pocos
      segundos.
- [ ] La fila **terreno**: qué dice de los `LayerData` (cuántos mensajes y de qué
      tipos) y si el mundo deja de ser un plano.
- [ ] ☰ → **Ver las texturas decodificadas**: una captura. Si ahí se ven bien y
      el mundo sigue con cuadros negros, el problema está en cómo se aplican las
      texturas o en la luz, no en el decodificador.
- [ ] La línea `TEXTURAS:` termina en `caché r2 activada, N copias guardadas
      descartadas por no decodificar` — si N > 0, esas copias eran basura de
      rondas anteriores y ya se están reparando solas.


## Ronda 8 — lo hecho en esta revisión (tras la prueba en el móvil)

El usuario probó el APK y reportó: «todo se ve mal, no carga texturas ni nada de
terreno, el avatar sigue siendo una cápsula, va lentísimo, cuadros negros y
espacios transparentes, la app no pidió permiso de almacenamiento», y preguntó si
conviene pasar a un motor nativo (Filament). Hecho en esta ronda:

- [x] **Perfiles de render** (`perf.js`): `bajo`/`medio`/`alto` con resolución
      máxima, alcance, presupuesto de objetos, teselado, tamaño máximo de textura
      y memoria de GPU. Se eligen por dispositivo y se pueden forzar en el menú.
- [x] **Gobernador de fps** con **bajada automática de perfil** si el aparato no
      llega ni al mínimo de resolución (con 30 s de gracia tras conectar, para no
      juzgar la carga inicial), avisando en el registro y recordándolo.
- [x] **Batches estáticos** (`batch.js`): una malla por celda de 32 m y material;
      medido con 1200 prims: 3259 → 187 llamadas (medio) y 82 (bajo); ~15 → 38-55 fps.
- [x] **Geometría y materiales compartidos** (4800 mallas → 44 geometrías y 8
      materiales) y `pickList()` sin coste cuadrático.
- [x] **Texturas**: tope de decodificación por perfil (256/512/1024 px), presupuesto
      de memoria de GPU con recorte LRU (48/96/256 MB) y decodificación **en un
      worker** para no parar el bucle de render.
- [x] **Diagnóstico completo** en el propio móvil: GPU y software, funciones del
      navegador, los 8 archivos de avatar (descarga **y** gzip), decodificación de
      prueba comparada píxel a píxel, y contadores vivos de texturas, terreno,
      prims, cuerpos de avatar y animaciones.
- [x] **Prueba de vista con simulador local** (☰): conecta el visor al simulador
      en memoria que ya va dentro del APK para separar «fallo del móvil» de
      «fallo de la conexión», y se deshace con el mismo botón.
- [x] **Aviso explícito si los cuerpos de avatar no cargan** (antes: cápsulas y
      ninguna explicación) y reintento de los assets (3 intentos por archivo,
      compartidos entre todos los avatares que lleguen a la vez).
- [x] **Bug real del lector de mallas `.llm`**: `numSkinJoints` se leía siempre,
      pero sólo existe si el mesh trae pesos; el mesh de los ojos lo incumple, así
      que el lector se desviaba y devolvía 31045 huesos inexistentes. Ahora se lee
      sólo cuando `hasWeights`, con comprobaciones de longitud. `AvatarAppearance`
      ya no silencia sus errores y el error de construcción del avatar se registra
      con la excepción.
- [x] **`Accept: image/x-j2c`** al pedir texturas (lo que pide el visor oficial).
- [x] **Diagnóstico de compilación en el workflow**: el APK se compila dos veces
      (segundo intento con el estado limpio) y, si falla, el registro del error
      queda en el resumen de la ejecución **y** en `build-error.log` del
      repositorio, legible sin sesión.
- [x] **Panel de almacenamiento**: rutas, tamaño de la caché, espacio libre,
      permiso clásico donde existe (Android ≤9) y selector de carpeta del sistema.
- [x] **Cielo negro arreglado**: el plano lejano de la cámara cortaba la cúpula del
      cielo y aparecía un polígono negro grande.
- [x] Versión **1.3.0 (build 4)** — el registro debe decirlo.
- [x] **Error de compilación de Kotlin arreglado** (por eso falló la primera
      compilación de esta ronda): `MainActivity.kt` pasaba `pendingFolderRequest`
      (un `String?`) a `pushResult(kind, id: String)`. Ahora hay un `if (id ==
      null) return` después de leerlo en `onActivityResult`.
- [x] **`pushRaw` de `NativeBridge.kt` arreglado**: la concatenación
      `"…(" + if (…) "'" + json + "'" else … + ")"` colgaba el `+ ")"` del
      `else` (precedencia de Kotlin), así que la rama normal generaba
      `visornative('…'` **sin cerrar el paréntesis** — un error de sintaxis en
      cada respuesta nativa. Ahora el argumento se compone en una `val` antes de
      construir la llamada.

Pendiente de comprobar en el móvil (informe 5):

- [ ] Que el registro empiece por `app 1.3.0 (build 4)` (si pone 1.2.0, el APK no
      es de esta ronda).
- [ ] La línea `Calidad:` (qué perfil eligió solo) y si más tarde aparece
      «Rendimiento insuficiente…» (bajada automática).
- [ ] La línea `GPU:` que **no** diga «SOFTWARE (sin GPU)».
- [ ] ☰ → **Diagnóstico completo**: los 8 archivos de avatar en `OK`, la
      decodificación de prueba con «colores correctos», y las filas de texturas,
      terreno, prims y **cuerpos de avatar** (`N de M con cuerpo real`).
- [ ] Que el mundo salga con texturas y terreno y sin cuadros negros.
- [ ] ☰ → **Permiso y carpeta de almacenamiento**: qué dice de la carpeta y del
      permiso en su versión de Android, y probar el selector de carpeta.
- [ ] Que los avatares se vean **con cuerpo** (no cápsula) a los pocos segundos.
- [ ] ☰ → **Prueba de vista con simulador local**: si el mundo se ve bien aquí (es
      sintético, a propósito) el móvil y el motor están bien y el problema está en
      el grid; si también se ve mal, mandar el diagnóstico completo.

## Ronda 6 — lo hecho en esta revisión (informe 4)

El informe 4 (cuenta ExeQiel, en el grid) traía: `LayerData`, `ObjectUpdate`,
`ObjectUpdateCompressed`, `ImprovedTerseObjectUpdate`, `AvatarAppearance`,
`KillObject`, `SoundTrigger`, `AttachedSound`, `SimStats`… y el usuario seguía
viendo **estructuras cuadriculadas blancas**. Diagnosticado y arreglado:

- [x] **Causa raíz del mundo blanco**: el bloque `ObjectUpdateCompressed` se leía
      sólo hasta el UUID del dueño. La **forma del prim (23 B) y el TextureEntry
      (S32 tamaño + datos) van al final**, después de los parámetros extra, y
      además el UUID del dueño es incondicional (no depende de la bandera 0x01).
      Sin leerlos, cada prim comprimido salía como un cubo por defecto sin
      textura. Verificado en el simulador falso: 40 prims comprimidos, 0 fallos
      de cola, 40/40 con su forma y su textura.
- [x] **Formato de los parámetros extra corregido**: cabecera `U8 num_params` con
      entradas `[U16 tipo][S32 tamaño][datos]` (antes se leía mal), más flexible
      (0x10), luz (0x20) y sculpt (0x30/0x60) con sus tamaños reales.
- [x] **Avatares reales con forma**: los sliders del `AvatarAppearance` se
      resuelven con los *drivers* y se aplican a la vez como morphs y como
      escalas de hueso (`<bone scale/offset>` de avatar_lad.xml, unión de todas
      las declaraciones del mismo slider). Altura, cadera, hombros y grosor
      cambian el esqueleto de verdad: verificado 1,93 m neutro → 2,16 m al máximo
      de Altura, con los pies en el suelo en todos los casos.
- [x] **Animaciones reales**: los 118 assets de Lumiya (`anims/`, formato
      LLKeyframeMotion) empaquetados en `data/avatar/anims.gz` y reproducidos con
      el blend por prioridad del visor oficial. Verificado: STAND baja los brazos
      (1,88 m), WALK/ RUN/ FLY dan posturas distintas y cambian con el tiempo.
- [x] **`KillObject` (el error «Offset is outside the bounds of the DataView»)**
      arreglado de verdad: el recuento de un bloque `Variable` puede venir a
      `0xff`, y cuando el datagrama lleva *acks adjuntos* el simulador recorta la
      cola del bloque; el lector pedía 255 identificadores de 4 B y se salía del
      buffer. Ahora se recorta al número de repeticiones que caben enteras (así
      se siguen matando los objetos que sí llegaron) y el aviso se agrupa en vez
      de repetirse. Comprobado con los bytes reales del informe: `10 ff e2 0c …`
      → recuento 255, IDs 3298, 3299, 3300, 3301.
- [x] **GPU**: al arrancar se registra la GPU real (`ANGLE (…)`, WebGL2, tamaño
      máximo de textura) y se avisa si el WebView usa renderizado por software.
- [x] **Controles táctiles más Genshin**: doble toque = saltar, empujar el stick
      a tope = correr (con aviso visual en el propio stick).
- [x] 70/70 pruebas del protocolo (incluye las de animación y las de KillObject
      truncado).

Pendiente de comprobar en el grid real (5ª prueba, ver la lista de la ronda 8):

- [ ] **5ª prueba real** con el APK 1.3.0: el mundo debe salir **con texturas y
      formas distintas** (no la rejilla blanca), con avatares reales que se
      mueven, y en el registro deben verse las líneas nuevas de `TEXTURAS:`
      (prims/texturas/comprimidos), `animaciones:` (mensajes, avatares
      reproduciendo, huesos movidos) y `GPU:`.
- [ ] Comprobar en la línea de `GPU:` que **no** dice «SOFTWARE (sin GPU)».
- [ ] Ver si el registro trae animaciones que **no** estén en el paquete (un
      residente con animación propia): eso pide el transfer de assets.
- [ ] Que la ropa puesta se vea en las texturas baked (caras 8–11 del avatar).
- [ ] Probar el teclado/registro en segundo plano: cerrar la app con sesión
      abierta y ver que la notificación sigue y que al volver la sesión vive.

## 0. Conexión real (comprobaciones)

**Estado tras la 3ª prueba real (cuenta ExeQiel, Diamond Cove 54.190.153.220, Xiaomi API 36):**
el login funciona, el circuito UDP vive y **el mundo llegó entero**: 37/55
capacidades (EventQueueGet, GetTexture, GetMesh, GetDisplayNames),
`RegionHandshake` («Diamond Cove», agua a 20 m), agenta en **155.0, 101.6, 21.5**,
`LayerData`, `ObjectUpdateCompressed` (×400), `ObjectUpdate` (×200),
`ImprovedTerseObjectUpdate` (×600), `AvatarAppearance`, `CoarseLocationUpdate`,
`SimStats`, `KillObject` y una primera textura de 227 B. El usuario veía la isla
demo, ni terreno ni prims ni su avatar; era **todo de render**, no de protocolo.

Corregido en esta revisión (3ª prueba):

- **La isla demo no se borraba nunca.** `App.connect()` entraba al grid sin
  limpiar el mundo procedural (alturas 3–46 m), que **enterraba** la región real
  (objetos a z≈21). Ahora `World.reset()` borra prims/avatares y pone un suelo
  plano a 0 m antes del login, y si el login falla se vuelve solo al modo demo.
- **El avatar no se veía** (sólo «la píldora con mi apodo»): el cartel tenía
  `depthTest:false` y la cápsula quedaba enterrada. `addAvatar()` es idempotente y
  renombra en el sitio, `App.followAgent()` crea/actualiza el avatar propio desde
  `agentPos`/`agentRot` cada fotograma y la cámara lo sigue (`CameraController.follow`).
- **`ImprovedTerseObjectUpdate` se ignoraba por completo** (el fallo grande): su
  bloque `Data` **no** tiene el formato de `ObjectUpdate`; lleva LocalID(4)+estado(1)+
  [plano 16]+pos F32×3+vel/acc/rot(4×U16)/omega. Nuevo `decodeImprovedTerse()`.
- **El "terse" de 32 B estaba mal**: la rotación son **cuatro U16** (x,y,z,w) en
  +18 y omega en +26 (no tres U16/+24); los rangos de vel/acc/omega son (-256,256).
- **Las texturas salían negras**: `TextureLibrary.install()` creaba la textura con
  versión 0 (nunca se subía a la GPU); arreglado con `needsUpdate` + sRGB. Además
  la URL de `GetTexture` era incorrecta (ahora `<cap>/?texture_id=<uuid>`), se lee
  la cabecera sin distinguir mayúsculas ("sin tipo" era un fallo de mayúsculas) y
  hay reserva por `ViewerAsset`.
- **JPEG2000 real**: se vendorizó OpenJPEG wasm (`src/web/vendor/openjpeg/`) y
  `j2c.js` se reescribió; verificado decodificando un J2C real.
- **El terreno ya no puede colgar la página**: `BitBuffer` lanza si el flujo se
  agota (un `LayerData` truncado antes se quedaba leyendo ceros para siempre).

Pendiente de comprobar en el grid real (4ª prueba):

- [ ] **4ª prueba real**: ¿se ve el terreno del grid, los prims y el avatar?
- [ ] Texturas del terreno (`TerrainDetail0..3`) y texturas de prims con el
      contenido correcto (el informe 3 trae el resultado de `textureFailures`).
- [ ] `KillObject` da «Offset is outside the bounds of the DataView»: ahora se
      registra con tamaño + cabecera hex en vez de romper el bucle; comprobar el
      patrón exacto en el informe 4 y ajustar el offsets si hace falta.
- [ ] Que llegue el `RegionHandshake` y que el mundo empiece a cargar
      (LayerData/ObjectUpdate) tras `CompleteAgentMovement`.
- [ ] **MFA** (código de 6 dígitos) si la cuenta lo pide.
- [ ] **Posiciones "terse"**: ya corregidas contra `llviewerobject.cpp`; si aun
      así salen desplazadas, revisar `POS_XY`/`POS_Z`/`VEL_XY`/`VEL_Z`.
- [ ] **ImprovedInstantMessage**: verificar que el simulador acepta el mensaje
      con `EstateBlock`/`MetaData` (si los IM no llegan, probar sin ellos).
- [ ] **Zerocoding de salida**: se envía sin zerocode (bandera limpia) a
      propósito; si el simulador rechazara esos paquetes, activarlo en `udp.js`.
- [ ] **Orden del handshake**: `UseCircuitCode → RegionHandshake →
      RegionHandshakeReply → CompleteAgentMovement → AgentThrottle`.
      Si el sim descarta algún paquete, probar `AgentDataUpdateRequest` y
      `RequestRegionInfo` antes de `CompleteAgentMovement`.

Corregido en la 2ª revisión:

- **`CompleteAgentMovement` no se enviaba nunca.** Lo mandábamos dentro del
  manejador del `RegionHandshake`, pero el visor oficial (`llstartup.cpp`) lo envía
  en cuanto llega el **acuse del `UseCircuitCode`** (`STATE_AGENT_SEND`), sin
  esperar al handshake; y el simulador no mete al avatar en la región (ni manda
  `RegionHandshake`, `LayerData` ni `ObjectUpdate`) hasta recibirlo. Se detecta el
  acuse por secuencia (`Circuit.lastSeq`), con temporizador de respaldo y 3
  reintentos si no llega `AgentMovementComplete`.
- **Los `PacketAck` sueltos se ignoraban.** El simulador acusa casi siempre con
  un mensaje `PacketAck` (16 B), no con el trailer de acks adjuntos; sin leerlos,
  `unacked` no se vaciaba nunca y cada paquete fiable se reenviaba una y otra vez.
  Ahora `handle("PacketAck")` limpia la cola (`Circuit.ack`).
- **Capacidades: HTTP 405 "Method Not Allowed".** El seed capability es un
  **POST** con un array LLSD de nombres (un GET recibe 405, que es el valor por
  defecto del nodo en `LLHTTPNode`). Ahora se piden 55 capacidades y se registra
  cuántas llegan. Esto devuelve `EventQueueGet` (teletransporte/IM en vivo),
  `GetTexture` (texturas reales) y `GetDisplayNames`.
- **Falsos «el puente nativo no respondió a udpSend en 25s».** Era un fallo
  nuestro en `transport.js`: la respuesta `udpSend` se emparejaba pero no se
  resolvía la promesa, así que cada envío dejaba un aviso falso a los 25 s (y la
  clave del canal en los errores era la de la llamada, no la del socket).
- **`SimulatorViewerTimeMessage`** ahora ajusta el sol de la escena con la hora
  real de la región.

Pendiente de comprobar en el grid real:

- [ ] Que llegue el `RegionHandshake` y que el mundo empiece a cargar
      (LayerData/ObjectUpdate) tras `CompleteAgentMovement`.
- [ ] **MFA** (código de 6 dígitos) si la cuenta lo pide.
- [ ] Texturas reales (`GetTexture` + JPEG2000, ver §1).
- [ ] **Posiciones "terse"**: si los objetos salen desplazados, ajustar
      `POS_XY`/`POS_Z`/`VEL_XY`/`VEL_Z` en `object-update.js` (los valores se
      eligieron desde el código decompilado y son la única incógnita grande).
- [ ] **ImprovedInstantMessage**: verificar que el simulador acepta el mensaje
      con `EstateBlock`/`MetaData` (si los IM no llegan, probar sin ellos).
- [ ] **Zerocoding de salida**: se envía sin zerocode (bandera limpia) a
      propósito; si el simulador rechazara esos paquetes, activarlo en `udp.js`.
- [ ] **Orden del handshake**: `UseCircuitCode → RegionHandshake →
      RegionHandshakeReply → CompleteAgentMovement → AgentThrottle`.
      Si el sim descarta algún paquete, probar `AgentDataUpdateRequest` y
      `RequestRegionInfo` antes de `CompleteAgentMovement`.

## 1. Texturas

- [x] Decodificador **JPEG2000** real: **OpenJPEG compilado a wasm y
      vendorizado** en `src/web/vendor/openjpeg/` (`openjpegwasm_decode.js` +
      `.wasm`, de `@cornerstonejs/codec-openjpeg`). `j2c.js` inyecta el glue,
      apunta `locateFile` al wasm local y expone `decodeJ2C`/`warmUp`. Verificado
      con un J2C real. (El intento anterior por esm.sh fallaba con
      `[unenv] fs.readFileSync`.)
- [ ] Descarga **progresiva** de texturas (cabecera + niveles de detalle por
      `Range`), que es como lo hace Lumiya, para no bajar 1 MB por textura.
- [ ] Texturas del **terreno** desde RegionHandshake (`TerrainDetail0..3`).
- [ ] `removeBackground`, bump/`material` por cara, `fullbright`/glow reales
      (ahora se aproximan multiplicando el emisivo).

## 2. Objetos

- [ ] `ObjectUpdateCompressed` completo (hoy sólo el encabezado: UUID, localID,
      escala, posición, rotación) + flag de textura comprimida.
- [ ] Jerarquía de enlaces (`ParentID`), `ObjectProperties`,
      `ObjectPropertiesFamily` para nombres/descripciones y para el inspector.
- [ ] Mallas (`SculptType == 5`) y **sculpt maps** (ya se leen de ExtraParams:
      falta buscar la textura y deformar la esfera de 2512 caras).
- [ ] `ObjectUpdateCached` → peticiones de CRC: hoy se pide siempre el bloque
      completo (`CacheMissType = 0`); respetar el CRC evita tráfico.
- [ ] Selección/edición remota (`ObjectSelect`, `ObjectGrab`, `ObjectPosition`…)
      desde el inspector.

## 3. Avatares (lo más grande)

- [ ] Esqueleto (`SLDefaultSkeleton`), `AvatarAnimation` y morphs
      (`SLAvatarParams`) para que los residentes no sean cápsulas.
- [ ] Apariencia/baking (`baker/BakeProcess`, `AgentSetAppearance`,
      `AgentCachedTexture`) para ver tu propio avatar como te ve el grid.
- [ ] Animaciones de bailes/gestos y `SetAlwaysRun`.

## 4. Mundo y sesión

- [ ] Teletransporte completo (el EventQueue maneja `TeleportFinish`; falta la
      UI y `CrossedRegion` real con cambio de circuito).
- [ ] `EdgeDataPacket` (alturas de los bordes de agua) y patch de agua real.
- [ ] Presupuesto adaptativo según fps medidos (hoy el LOD usa distancia y calidad).
- [ ] Prefetch de prims al caminar y liberación de geometría con caché LRU.
- [ ] Minimapa con la región y los residentes (`CoarseLocationUpdate` ya llega).

## 5. Inventario y social

- [ ] Inventario (`FetchInventory*`, `SLInventory`, carpetas) y Xfer para
      wearables/notas/landmarks.
- [ ] UI de conversaciones por residente, historial, IMs offline.
- [ ] Grupos, búsqueda, mute list, dinero (L$), RLV (lo que hacía Lumiya).

## 6. Empaquetado / app Android

- [ ] Icono definitivo del lanzador (hay un vector provisional).
- [ ] Firmar el APK de release con una clave propia (hoy usa la de debug).
- [ ] Comprobar el WebView real en Android: UDP por `NativeBridge`, permisos de
      red y handshake real. (El servido de `assets/www` ya está resuelto a mano
      en `MainActivity.serveAsset`: `WebViewAssetLoader` **quita** el prefijo
      registrado del path, así que sólo sirve ficheros que estén en la raíz de
      `assets/`, no en `assets/www/`; y devuelve `text/plain` para extensiones
      desconocidas, lo que el navegador rechaza en módulos ES.)
- [ ] Pantalla de ajustes (grid, distancia de dibujo, calidad, cámara).
- [ ] Modo "conectar sin contraseña guardada" + no guardar credenciales.

## 7. Documentación

- [ ] Actualizar `LUMIYA.md` con cada apartado que se complete.
- [ ] Añadir capturas al README (el editor puede hacerlas con
      `vision`/`snapshot`).
