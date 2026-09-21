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

- **Prims con forma real, esculturas incluidas**: `prims.js` es un port de
  `PrimProfile`, `PrimPath`, `PrimVolume`, `PrimVolumeFace` (cortes, huecos,
  torsión, estrechamiento, inclinación, revoluciones, curvas de perfil/camino,
  revolución completa…) y, desde la ronda 10, **las esculturas**: la forma sale
  de un *sculpt map* (R,G,B → X,Y,Z) con la resolución, las costuras y los flags
  del visor oficial. Desde la ronda 11, **las mallas (`LLMESH`) se decodifican y
  se dibujan** (`mesh.js`, pedidas por `GetMesh`): un objeto de malla ya no es un
  hueco. Un prim esculpido al que todavía no le ha llegado su mapa, y un objeto
  de malla cuyo activo aún no ha llegado, **no se dibujan** — antes se dibujaba
  su forma base y eso llenaba la región de cajas.
- **Buscador de tierras y teletransporte**: por nombre, SLURL o coordenadas de
  rejilla, con el mapa del grid, elección del punto exacto dentro de la región y
  `TeleportLocationRequest` → circuito nuevo en el simulador de destino.
- **Terreno SL**: decodificación DCT de las capas (`LayerData`, tipo **76** con
  su cabecera de 4 bytes) con `decodeTerrainLayer` + mezcla de 4 texturas por
  altura/pendiente.
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

## 2b. Rendimiento y diagnóstico (ronda 8)

Un visor de Second Life sin esto no es usable en un teléfono: la primera prueba
en el móvil fue «todo lentísimo» y «no se ve nada», que en un visor significa
cosas muy distintas. Las dos se atacan por separado.

### Perfiles de render (`perf.js`)

Tres perfiles —`bajo`, `medio`, `alto`— que fijan de una vez la resolución máxima,
la distancia de dibujo, el presupuesto de objetos, el teselado del terreno, el
tamaño máximo de textura, el presupuesto de memoria de GPU y cada cuántos
fotogramas se recalcula el LOD y la visibilidad. Al arrancar se elige uno según lo
que el dispositivo dice de sí mismo (modelo y SDK por el puente nativo, núcleos,
RAM) y en ☰ → *Perfil de render* se puede forzar.

Encima va el **gobernador de fps**: la escala de resolución baja sola hasta el
mínimo del perfil cuando los fotogramas se alargan, y **si aun así el aparato no
llega** (medido, no supuesto), el visor baja un perfil entero, lo avisa en el
registro y lo recuerda para el próximo arranque. Nunca se queda tiritando en
«calidad alta» por haber acertado mal al adivinar el hardware.

### Batches estáticos (`batch.js`)

El coste real de una región no está en los polígonos sino en las llamadas de
dibujo: cada prim son hasta seis caras, así que 1200 prims son ~3500 llamadas y
la GPU de un móvil se ahoga. Los prims que no se mueven se funden en **una sola
malla por celda de 32 m y material** (con las matrices ya cocidas en los
vértices) y las llamadas caen a un par de centenares. Los prims que se mueven,
los seleccionados y los que están fuera del presupuesto de objetos conservan sus
mallas propias: el *picking* sigue funcionando (three.js también hace *raycast*
contra mallas invisibles, cosa que se verificó) y mover un prim lo saca de la
celda. La reconstrucción va limitada por tiempo (4 ms por fotograma) y de la
celda más cercana a la más lejana.

Medido con el arnés de estrés (`test/stress.js`, 1200 prims con texturas reales,
GPU Intel HD 500 del equipo de pruebas): **3259 → 187** llamadas en `medio` y
**82** en `bajo`; de **~15 fps a 38 fps de media** (`medio`) y **55 fps** (`bajo`).
La geometría y los materiales se comparten entre prims iguales: 4800 mallas →
44 geometrías y 8 materiales, y reconstruir un batch cuesta 0,3-0,8 ms.

### Texturas

- El tamaño de decodificación se limita por perfil (256/512/1024 px): una textura
  de 1024 es cuatro veces la memoria y el tiempo de subida de una de 512, y en
  una pantalla de móvil no se distingue.
- La biblioteca de texturas tiene un **tope de memoria de GPU** (48/96/256 MB) con
  recorte LRU: la imagen decodificada se conserva y sólo se libera la copia que
  estaba sin usar en la GPU, así que nada desaparece de la pantalla.
- La decodificación JPEG2000 corre **en un hilo aparte** (`j2c-worker.js`): son
  decenas o cientos de milisegundos por textura y en el hilo principal eso es el
  bucle de render parado. El wasm viaja al worker como bytes (no como URL), así
  que funciona igual sirviendo los archivos desde el propio APK que desde otro
  origen, y si el worker no arranca el mismo decodificador sigue en el hilo
  principal: una textura siempre acaba en pantalla.

### Avatares (arreglo del «sigue siendo una cápsula»)

El lector de mallas `.llm` (`avatar/llm.js`) leía `numSkinJoints` y la lista de
huesos **siempre**, pero esa sección sólo existe si el mesh trae pesos
(`hasWeights`). El mesh de los ojos (`avatar_eye.llm.gz`) no los trae: el lector
se comía los dos primeros bytes de la marca de fin de morphs y a partir de ahí
recorría el fichero a ciegas (reproducido: `145` vértices y **31045** huesos
inexistentes). Ahora esa sección sólo se lee si `hasWeights`, con comprobaciones
de longitud, así que un fichero truncado da un error claro en vez de datos
absurdos.

Y en la misma línea de «lo que falla tiene que decirlo»: `AvatarAppearance` ya no
se traga sus errores (es donde se aplican la forma y las texturas baked), el
error de construcción de un avatar se registra con su excepción y, si los cuerpos
no se pueden leer, el aviso sale en el registro del visor en vez de dejar
cápsulas sin explicación (con un reintento por avatar por si fue un fallo
transitorio del servidor de assets). `GetTexture` pide además su tipo explícito
(`Accept: image/x-j2c`), que es lo que hace el visor oficial.

### El mundo mientras llega el terreno

Hasta que el sim manda el primer parche de terreno, la región es un suelo plano a
0 m y **el agua no se dibuja**: el plano de agua está a la altura del mar (20 m en
la mayoría de regiones) y, sin terreno real, tapaba toda la vista como un mar
oscuro y semitransparente con los prims hundidos debajo — que en pantalla se ve
igual que «cuadros negros y espacios transparentes» y que «no hay terreno». En
cuanto llega el primer `LayerData` el agua aparece en su sitio, y el diagnóstico
dice en qué estado está el terreno (`PLACEHOLDER PLANO` o `malla real`).

### Diagnóstico en el propio móvil (☰ → *Diagnóstico completo*)

GPU real y si el WebView ha caído a software, las funciones del navegador que
existen (WebGL2, DecompressionStream, Worker, WebAssembly…), los 8 archivos del
avatar (descarga **y** descompresión), el decodificador JPEG2000 con una
decodificación de prueba cuyos píxeles se comparan con los colores esperados, y
los contadores vivos de la sesión: texturas pedidas/decodificadas/fallidas, estado
del terreno, prims dibujados, cuerpos de avatar construidos y animaciones en
reproducción. Se copia con un toque o se guarda en *Descargas*.

Existe porque «no se ven texturas» tiene media docena de causas muy distintas —no
llegaron, llegaron y no se pudieron decodificar, la GPU es software, los cuerpos
de avatar no se pudieron leer— y en la pantalla todas se ven iguales. Por el mismo
motivo, al arrancar se escribe en el registro una línea `GPU:`, otra `Calidad:`
(con el perfil elegido y sus límites) y, si los cuerpos de avatar no se pueden
cargar, un aviso explícito en vez de dejar cápsulas sin explicación.

Y para separar «fallo del móvil» de «fallo de la conexión» sin sacar la app del
teléfono, ☰ → **Prueba de vista con simulador local** conecta el visor a un
simulador en memoria que ya viene dentro del APK (el mismo que usa
`?test=grid`): si el mundo se ve bien ahí, el motor y el dispositivo están bien y
el problema está en el grid; si también se ve mal, el problema es el dispositivo.
Es reversible (el mismo botón vuelve a la pantalla de inicio y devuelve el puente
nativo), y avisa en el registro de que lo que se ve es sintético.

### Almacenamiento (☰ → *Permiso y carpeta de almacenamiento*)

Dónde vive la caché, cuánto ocupa, cuánto queda libre y los dos gestos que
Android ofrece: el permiso clásico (sólo en Android ≤9) y el selector de carpeta
del sistema. En Android 10+ la carpeta propia de la app no necesita permiso
alguno, y el panel lo explica en vez de dejar al usuario pensando que falta algo.

## 2c. Ronda 9 — que el móvil se pueda comprobar (y no nos mienta)

El informe 6 traía tres cosas que ninguna captura podía explicar: **los 8 archivos
del avatar daban 404** dentro del APK (mientras `j2c-sample.bin`, en la misma
carpeta, cargaba bien), el **avatar seguía siendo una cápsula**, y el usuario
avisó de un problema de fondo: *«si se guardan las texturas, ¿cómo compruebo que
los arreglos cambiaron algo?»*. Las tres tienen la misma respuesta: **hacer que
el estado se pueda ver y que lo viejo no pueda disfrazarse de nuevo**.

### Los archivos del avatar ya no se llaman `.gz`

El servidor de assets del WebView contestaba **404 a todo asset `.gz`** mientras
servía sin problema un `.bin` de la misma carpeta. Los archivos van gzip
igual que antes, pero con extensión neutra (`avatar_head.llm.bin`,
`avatar_lad.xml.bin`, `anims.bin`, …) y el cargador decide qué son **mirándolos**
(cabecera gzip `1f 8b` → se descomprime; si no, se usan tal cual). Si aun así el
servidor de assets se niega, el mismo archivo se lee por el **puente nativo**
(`assetsList`/`assetGet`, `assets.open`), que no pasa por el WebView. El
diagnóstico dice qué camino funcionó («por la red interna N · por el puente
nativo M»), que es lo que distingue «el archivo no está en el APK» de «el WebView
no lo sirve».

### Caché con revisión, comprobación y autoreparación (`cache.js`)

- Cada copia se guarda bajo una **revisión** (`r2_tex_<uuid>`). Si la revisión
  cambia, la caché **se borra al arrancar** y queda anotado en el registro: una
  copia vieja no puede volver a disimular un arreglo.
- Antes de usar una copia se comprueba que **empiece como una imagen** y que
  **se pueda decodificar**. Si no, se borra y se vuelve a pedir al grid (antes un
  archivo malo era permanente: no se decodificaba nunca más y el visor no lo
  volvía a pedir).
- ☰ → **Caché y verificación**: tamaño, número de archivos, «Verificar lo
  guardado» (lee la cabecera de cada archivo en el nativo y dice cuántas copias
  son inservibles), «Borrar caché ahora» y **modo sin caché** (todo se pide al
  grid otra vez, para comprobar que un cambio se nota de verdad).

### El servidor de assets no cachea errores, y la caché HTTP se vacía por build

`MainActivity` contesta a los assets con `ETag` = build + ruta y
`Cache-Control: max-age=0, must-revalidate` (y **`no-store` en los 404**), y al
arrancar, si el `versionCode` instalado es nuevo, **vacía la caché HTTP del
WebView**. Un 404 cacheado (o una copia de un archivo de la build anterior)
sobrevive a las actualizaciones del APK porque los datos de la app no se borran,
y eso convierte un fallo de una build en un «no está» permanente.

### Ver las texturas que se han decodificado (☰ → *Ver las texturas decodificadas*)

Una rejilla con los píxeles que el visor tiene en memoria, dibujados desde los
mismos `ImageBitmap` que usa el mundo, con su uuid y su tamaño. «Los prims salen
negros» puede ser que el decodificador devuelva negro, que la textura no se haya
aplicado, o que el material esté mal; en el mundo las tres cosas se ven igual y
en esta rejilla no. Una captura de esa pantalla es una prueba, no una teoría.

### El terreno, contado por tipos

`LayerData` se cuenta por tipo (`tipos 0×5`) y, si llega uno de tipo 0 sin sacar
ni un parche, el registro dice cuántos bytes traía y por qué byte empieza. «El
terreno sigue plano» tiene dos causas posibles —el simulador no manda parches, o
los manda con un `LayerID` que este código no esperaba— y ahora el informe las
distingue.

## 2d. Ronda 10 — que el mundo cargue de verdad, y poder teletransportarse

El informe 7 (móvil, 900 prims) dejó claro el cuadro: `LayerData` **sí** llegaba
(113 mensajes, `tipos 55×85, 76×28`) y el terreno seguía en «PLACEHOLDER PLANO»;
en pantalla, «cubos con cuadrículas blancas y un sinfín de geometrías extrañas».
Eso apuntaba a tres cosas distintas y se arreglaron las tres:

- [x] **El terreno es el tipo 76, no el 0, y lleva cabecera.** El simulador manda
      la tierra como `LayerID.Type = 76` (`LAYER_TYPE_LAND`) y el agua como 55;
      leer sólo el 0 es la razón de que **nunca** llegara terreno. Además el
      bloque empieza con 4 bytes (`stride U16`, `patchSize U8`, `type U8`) antes
      del flujo DCT (`TerrainData.ProcessLayerData` en Lumiya). `terrain.js`
      lee esa cabecera, `sl-session.js` acepta el 76 e ignora el 55, y el
      simulador falso del arnés la escribe (ida y vuelta probada).
- [x] **La máscara de caras del `TextureEntry` estaba al revés.** Los grupos de
      7 bits van en **big-endian** (lo confirma `unpack_TEField` en
      `llprimitive.cpp` del visor oficial: `index_flags <<= 7; index_flags |=
      (sbit & 0x7F)`). Leerlos al revés coincide mientras el campo cabe en un
      byte (≤ 7 caras) y a partir de ahí pone la textura **en otras caras**: es
      exactamente «las texturas no se aplican bien». El lector además ya no se
      cae con un `TextureEntry` truncado (lee 0 al pasarse del final).
- [x] **Esculturas (sculpt maps) de verdad.** Un prim esculpido no se extruye:
      su forma son los píxeles de una textura (R,G,B → X,Y,Z). Antes se dibujaba
      su forma base, y eso es una caja con la textura por defecto — la mitad de
      las «geometrías extrañas» de una región moderna. `prims.js` implementa
      `sculpt_calc_mesh_resolution` y `sculptGenerateMapVertices` tal como están
      en `llvolume.cpp` (incluidos `LL_SCULPT_TYPE_*`, los flags *invert/mirror* y
      las reglas de costura de esfera/toro/cilindro/plano), un mapa sin relieve se
      rechaza (igual que el visor oficial) y **un prim esculpido al que aún no le
      ha llegado el mapa no se dibuja** en vez de dibujarse mal. El mapa viaja
      por la misma cola de texturas; `world.setSculptMap` reparte los píxeles y
      reconstruye todo lo que esperaba ese mapa.
- [x] **Los objetos *mesh* no se dibujan como cajas.** Un objeto mesh (esculpido
      con `SculptType = 5`) lleva una malla que este visor todavía no decodifica;
      dibujar su forma base llenaba la región de cajas blancas. Ahora se
      reconocen, se cuentan (salen en el informe) y simplemente no se dibujan,
      como los mapas sin relieve. **En la ronda 11 sí se decodifican** (ver 2e).
- [x] **Texturas: decodificación en paralelo y caché de píxeles.** El decodificador
      JPEG2000 pasa a un *pool* de hasta 3 hilos (`decoderWorkers()`), y el
      diagnóstico dice cuántos. La caché del móvil guarda el **PNG ya
      decodificado** (antes el flujo J2C crudo, que se volvía a decodificar en
      cada entrada), y las copias viejas se sustituyen al leerlas.
- [x] **Buscador de tierras y teletransporte (☰ → *Buscar tierras y
      teletransportarse*, y botón *Lands* en la barra).** Busca por nombre de
      región, por SLURL (`secondlife://Región/x/y/z`) o por coordenadas de
      rejilla; el nombre se resuelve con la web pública de mapas
      (`data-region-coords-x/y`) y el mapa se pinta con los mosaicos de
      `map.secondlife.com` (`map-<zoom>-<rx>-<ry>-objects.jpg`; un mosaico es su
      esquina suroeste y en la imagen el norte es arriba — comprobado a nivel de
      píxel contra regiones contiguas). Tocar el mapa elige región **y** el punto
      exacto dentro de ella; el círculo amarillo «eres tú», el recuadro verde el
      destino; X/Y/Z se pueden escribir a mano. Las regiones de prueba se editan
      en `main.pjs` (`regionesDePrueba`).
- [x] **El teletransporte, en `sl-session.js`**: `TeleportLocationRequest` (con
      `RegionHandle` y posición local, como Lumiya) → `TeleportStart` /
      `TeleportProgress` por UDP → `TeleportFinish` en la cola de eventos CAPS
      (que trae `Info[0].SimIP/SimPort/SeedCapability`) → `moveToSim()` (cierra el
      circuito viejo **sin** cerrar sesión, vacía el mundo, carga las caps del
      destino y abre circuito allí). La cola de eventos lleva una **generación**
      para que la del simulador viejo no siga viva tras el salto. El arnés local
      (`?test=grid&tp=1004,1006`) ejecuta el camino entero y lo deja en el
      registro.
- [x] **`$meta` y `superFetch` en `main.pjs`.** El visor ya tiene título,
      descripción y etiquetas, y el buscador de tierras funciona también en un
      navegador normal: sin puente nativo, `httpRequest` sale por el proxy sin
      CORS de `super-fetch-plugin` (los mosaicos del mapa exigen un `User-Agent`;
      el CDN contesta 403 sin él).

## 2e. Ronda 11 — mallas, búsqueda de regiones por UDP y teletransporte

El informe 7 del móvil seguía diciendo «todo roto sin sentido, sin estructuras ni
texturas lógicas», y además: los teletransportes no llegaban y el buscador de
regiones no encontraba nada. Se atacó cada causa por separado, leyendo cómo lo
hace el visor oficial y Lumiya (que es lo que se ha usado como referencia):

- [x] **JPEG2000: un *codestream* de 4 componentes se leía como RGBA entrelazado.**
      El decodificador (OpenJPEG en wasm) reserva un búfer de
      `ancho × alto × componentes` bytes pero **sólo escribe tripletas RGB** en
      `x*3`: con 4 componentes, cada fila queda con los píxeles a 3 bytes de paso
      dentro de filas de 4, y el último 25 % de la fila sin escribir. Leer eso
      como RGBA entrelazado da exactamente lo que se veía en las capturas del
      móvil: **rayas verticales de colores ciclados y una barra negra a la
      derecha**. Ahora `j2c.js` lee la geometría real que escribió el
      decodificador (`ancho*componentes*bytes` de paso por fila), los codestreams
      de 16 bits o multicomponente se rechazan en vez de dibujarse, y la
      revisión de caché (**r3**) tira las texturas guardadas por la versión mala.
- [x] **Buscador de regiones por el protocolo, no raspando la web.** `MapNameRequest`
      (405/408) → `MapBlockReply` (409) para el nombre → coordenadas de rejilla, y
      `MapBlockRequest` (407) → `MapBlockReply` para llenar el mapa de nombres de
      región. Se elige el primer camino (UDP) y sólo si la región no lo contesta
      se cae a la web de mapas de antes.
- [x] **Teletransporte: `CrossedRegion` no se atendía.** Cruzar el borde de una
      región es un salto de región: el simulador manda `CrossedRegion` por UDP (no
      `TeleportFinish` por la cola de eventos) y el visor lo ignoraba, así que el
      avatar aparecía en el borde y el mundo se quedaba atrás. Ahora se enruta por
      el mismo camino que `TeleportFinish`. Además `send()` es fiable por
      defecto, como en Lumiya (`teleportLocationRequest.isReliable = true`).
- [x] **LLSD binario, corregido entero.** El lector era *little-endian*, los mapas
      no llevaban recuento y las claves iban con etiqueta `s`. El formato real
      (visor oficial, `LLSDBinaryParser`/`LLSDBinaryFormatter`) es **big-endian**,
      el mapa lleva recuento (`LLSDBinaryFormatter::formatMap`) y la clave es
      `k` + longitud + nombre. Nada de esto se notaba antes porque no se leía
      ningún LLSD binario… hasta que hizo falta leer una malla.
- [x] **Mallas (`LLMESH`) de verdad: `mesh.js`.** Cabecera LLSD binaria con la
      tabla de bloques + bloques comprimidos con zlib, port de
      `LLVolume::unpackVolumeFacesInternal` y `LLMeshRepository::headerReceived`:
      posiciones/normales/UVs cuantizadas contra su `*Domain`, lista de
      triángulos, `NoGeometry` conservado (la cara `i` del `TextureEntry` es el
      material `i`) y elección de LOD con reserva. El activo se pide a **`GetMesh`**
      (`/?mesh_id=…`), en su propia cola y con caché en el dispositivo, y **un prim
      de malla cuyo activo aún no ha llegado no se dibuja** (nunca una caja de
      relleno). `World.meshFacesFor` reutiliza toda la tubería de prims
      (geometría compartida por activo+LOD, materiales por cara, batching).
- [x] **`mesh-encode.js` escribe activos reales**, así que el mismo formato se
      prueba de los dos lados: el autotest (97/97) y el arnés local
      (`?test=grid`, que sirve una casa de dos materiales y una caja por su
      `GetMesh`) comprueban el decodificador **contra un codificador**, no contra
      un muñeco. El demo offline (`?test=demo`) tiene también dos edificios de
      malla, sin grid ninguno.
- [x] **Dos caras de la caja salían del revés** (`boxMesh`): las caras ±Y se
      emitían con el orden de vértices invertido, así que el descarte de caras
      posteriores se las comía y una caja se veía como **una sola pared**. Las
      formas del arnés lo delataron (una «casa» sin tres de sus cuatro paredes).
      Es el mismo tipo de fallo que producía «estructuras sin sentido», sólo que
      en el codificador de pruebas en vez de en el decodificador.
- [x] **Tejado a dos aguas en vez de pirámide cuadrada.** El tejado anterior era
      un cuadrado de 6,4 m sobre una caja de 6 × 4: sobresalía más que el propio
      edificio y dejaba una rendija entre tejado y pared. Ahora es un tejado a
      dos aguas (`prismRoofMesh`, dos faldones + dos hastiales) con el alero
      metido 6 cm dentro de la caja, que es como se hacen de verdad.
- [x] **Las mallas van en metros, y el prim las multiplica** (como el cargador
      de SL: el vértice se guarda en metros y la `scale` del objeto lo escala).
      Los mapas de escultura, en cambio, están normalizados a −0,5…0,5. Tenerlo
      escrito evita el error simétrico de «escalar una malla como una escultura»,
      que fue justo lo que produjo un edificio de 25 m en el arnés.
- [x] **Bug del *batcher* al reutilizar el mundo.** `PrimBatcher.dispose()` sacaba
      su grupo de la escena y no lo volvía a poner: tras `world.dispose()` todos
      los prims nuevos quedaban marcados como fusionados en una celda (y por tanto
      ocultos) sin que nadie dibujara las celdas fusionadas. Se veía como una
      isla con terreno y **ni un solo objeto**. Ahora se reengancha
      (`attach()`), lo que además arregla `?test=demo`.
- [x] Versión **1.6.0 (build 7)**.

Comprobado en el editor, en el simulador falso (`?test=grid`), no sólo en los
tests unitarios:

- el **camino completo del teletransporte por la interfaz** (panel *Lands* →
  «Sandbox Cordova» → *Buscar* → *Teletransportar*): la búsqueda resuelve
  (1004, 1006) por UDP, la petición sale con `RegionHandle`, y llega
  `TeleportStart` → `TeleportFinish` con *seed capability*; la región nueva
  termina de llegar con sus 44 prims y el agente en 122, 122, 31.
- La **búsqueda por nombre** por sí sola: «Harness» → 2 regiones, «Sandbox
  Cordova» → 1, las dos por `MapNameRequest`/`MapBlockReply`.
- El **mundo del simulador falso** visto con la herramienta de captura: terreno
  con relieve, objetos sólidos, un edificio con tejado a dos aguas, 13–15 prims
  distinguibles, ninguno flotante ni con geometría rota (las texturas del arnés
  son degradados sintéticos a propósito).
- El **arnés de esculturas** (`?test=sculpt`): esfera, toro, lámina ondulada,
  cilindro, toro espejado y una casa de malla, todos sólidos y sobre el suelo;
  los dos casos que **no** deben dibujarse (mapa sin relieve, malla sin activo)
  no dibujan nada.

## 3. Arquitectura (código)

| fichero | papel |
| --- | --- |
| `src/web/js/ui.js` | HUD y paneles (registro, diagnóstico, caché, texturas, inicio de sesión) y el **buscador de tierras + teletransporte** (`showLands`) |
| `src/web/js/app.js` | `App`: viewer + world + UI + bucle; entrada (clic, teclado), connect/disconnect |
| `src/web/js/renderer.js` | `Viewer` (three.js, sol, cielo, agua, sombras), `CameraController`, `getCamAxes()`, escala de resolución y perfiles |
| `src/web/js/world.js` | `World`: terreno, prims, materiales por cara, LOD, picking, avatares, `applyTexture`, cachés de geometría/material y batches |
| `src/web/js/perf.js` | perfiles de render (`bajo`/`medio`/`alto`), detección de dispositivo y gobernador de fps |
| `src/web/js/batch.js` | `PrimBatcher`: funde los prims quietos en una malla por celda de 32 m y material |
| `src/web/js/diag.js` | diagnóstico en el dispositivo (GPU, funciones, archivos, decodificador, contadores vivos) |
| `src/web/js/cache.js` | política de la caché en disco: revisión (invalida lo guardado), modo sin caché, comprobación y autoreparación |
| `src/web/js/prims.js` | motor de geometría de prims (port de Lumiya), **incluidas las esculturas** (`buildVolume`/`sculptMeshResolution`, port de `llvolume.cpp`) |
| `src/web/js/mesh.js` | activo **`LLMESH`** (`.llm`): cabecera LLSD binaria + bloques zlib + submeshes/LOD → geometría (port de `unpackVolumeFacesInternal` y `LLMeshRepository`) |
| `src/web/js/mesh-encode.js` | escribe activos `LLMESH` reales (casa/caja/multimaterial): lo usan el demo offline y los tests, para probar el decodificador contra un codificador |
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
| `src/web/js/j2c.js` | decodificador JPEG2000 (OpenJPEG wasm vendorizado, carga perezosa, tope de tamaño) |
| `src/web/js/j2c-worker.js` | el mismo decodificador en un hilo aparte (recibe el wasm como bytes) |
| `src/web/js/test/fake-grid.js` | simulador falso en memoria: prueba todo el camino del grid sin cuenta (`?test=grid`, `?test=grid&tp=gx,gy` para el teletransporte) |
| `src/web/js/test/sculpt-test.js` | esculturas en aislado, una por tipo (`?test=sculpt`) |
| `src/web/js/test/stress.js` | arnés de estrés: llena la región de prims con texturas reales y mide fps/llamadas |
| `src/web/js/avatar/assets.js` | carga los assets que van dentro de la app (`*.llm.bin`, `*.xml.bin`, `anims.bin`) |
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
| `src/tools/proto-selftest.mjs` | 97 pruebas del protocolo (ver abajo) |
| `src/android/**` | proyecto Gradle + WebView + `NativeBridge` (UDP/HTTP) |
| `src/ci/build-apk.yml` | workflow de GitHub Actions |

Las rutas de esa tabla son las de la **carpeta de trabajo** (el `src/web/` del
editor). En el zip y en el repositorio el visor vive en
`app/src/main/assets/www/` (y una copia igual en `www/`), y los documentos
`README.md`/`SPEC.md`/`TODO.md`/`LUMIYA.md`/`FILAMENT_MIGRATION.md` van en la raíz.

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

Métodos que **contestan al momento** (no pasan por `nativeCall`, se leen del
valor devuelto): `platform`, `storageInfo`, `storageStatus`, `netInfo`,
`prefsAll`, `assetsList`. El resto contesta con `push` y se espera con
`nativeCall`. Un método que devuelve el JSON directamente **no puede** esperarse
con `nativeCall` (nunca llegaría el `push` y la promesa moriría en el tiempo de
espera): es el error que tuvo `cacheVerify` al añadirlo, y por eso el arnés
(`test/fake-grid.js`) imita a la app hasta en eso.

Métodos del puente (ronda 9): `cacheGet`, `cachePut`, `cacheDelete`,
`cacheClear`, `cacheVerify` (recorre la caché leyendo solo la cabecera de cada
archivo), `assetsList` (nombres dentro de un directorio de `assets/`),
`assetGet` (lee un asset por el puente, en base64).

## 4. Pruebas

En el editor de Perchance (`src/tools/proto-selftest.mjs` vive fuera del visor, así
que se importa antes de llamarla):

```js
await import("./src/tools/proto-selftest.mjs");
await window.runVisorSelfTest();   // → 97/97 correctas

// Estrés de render (llena la región de prims con texturas y mide fps y llamadas
// de dibujo): lo que se usa antes de tocar perf.js/batch.js.
const stress = await import("./src/web/js/test/stress.js");
await stress.runStress(window.visor, { count: 1200, seconds: 5 });
```

Comprueba **97 cosas** sin necesidad de cuenta: que la plantilla tiene 483
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
posición ±5 m); y desde la ronda 11, **mallas** (cabecera LLSD binaria con sus
bloques medidos desde el final de la cabecera, un cubo decodificado a 24 vértices
y 12 triángulos con las posiciones de vuelta en su dominio, normales unitarias y
UVs en 0..1, una ranura `NoGeometry` conservada para no desplazar los materiales,
la cabecera de texto obsoleta, la elección de LOD con reserva) y el **LLSD
binario** comprobado byte a byte contra el formato real (big-endian, recuento en
el mapa, clave sin etiqueta `s`).

Además hay un **simulador falso** para probar el camino completo del grid sin
cuenta ni red: abre el visor con `?test=grid` (o `await
import("./src/web/js/test/fake-grid.js").then(m => m.runFakeGrid(window.visor))`)
y el visor se conecta a un simulador en memoria que responde login XML-RPC,
capacidades, `GetTexture` (**JPEG2000 real, y la mitad de 4 componentes — el
mismo `codestream` RGBA que producía las rayas**), **`GetMesh` (un activo
`LLMESH` real, escrito con `mesh-encode.js`)**, EventQueueGet y envía
RegionHandshake, 4× LayerData (256 parches), ~40 prims comprimidos, dos objetos
de malla (casa de dos materiales y caja), ObjectUpdate con TextureEntry, dos
avatares (con nombre), KillObject y pings — más un agente que camina.
Añadiendo **`&tp=gx,gy`** el arnés hace un **teletransporte completo** (petición →
`TeleportStart` por UDP → `TeleportFinish` en la cola de eventos → circuito y
región nuevos) y lo deja escrito en el registro.

Y las esculturas tienen su propio arnés aislado, `?test=sculpt`: una fila con
esfera, toro, plano ondulado, cilindro, un toro *espejo* y **dos objetos que no
deben dibujarse** (un mesh y un mapa sin relieve).

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
- Sin mallas, grupos, búsqueda de inventario, voz, RLV, minimapa ni dinero (ver
  `LUMIYA.md`).
- **Texturas progresivas**: cada textura se pide entera y se decodifica de una
  vez. Lumiya pedía primero la cabecera y luego los niveles de detalle por
  `Range`, de modo que la textura se veía borrosa y se iba afinando; es el
  siguiente ahorro de tráfico (y de tiempo hasta que algo se ve bien).
- **Motor de render**: WebGL2 dentro del WebView. Por qué no un motor nativo
  (Filament/GLES) está razonado en `LUMIYA.md` §7, junto con lo que haría falta
  para dar ese paso sin romper lo que ya funciona.
- La app Android sirve el visor desde `assets/www` con un interceptor propio
  (`MainActivity.serveAsset`), con MIME correctos (`text/javascript` para los
  módulos ES), `Cache-Control: no-store` y página de error legible si algo
  falla. Necesita WebGL2: si el WebView del móvil es viejo, la propia página lo
  avisa.
