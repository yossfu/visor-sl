# Especificación — Visor SL

Resumen de lo que el usuario pidió, para que ninguna sesión futura lo pierda.
Última actualización: ronda 8 (rendimiento, diagnóstico y decisión de motor).

## Petición original (resumen fiel)

1. **Descargar y mantener el proyecto en el chat** para trabajar con él.
2. Entregar un **archivo `.bat`** con el estilo del que envió el usuario:
   comprueba que existe `git`, comprueba que existe `visor-sl-app.zip`,
   descomprime, clona/actualiza `https://github.com/yossfu/visor-sl.git`,
   copia con `robocopy /MIR`, hace `git add/commit/push` y termina indicando
   `https://github.com/yossfu/visor-sl/actions` y dónde descargar el artefacto
   `visor-sl-apk`.
3. Entregar **los archivos necesarios para compilar la app** de visor de Second Life.
4. Hacer una **app de Second Life con un motor de juego basado en web** que se
   ejecute **dentro de una app Android** que el usuario compila en GitHub.
5. **Sacar todo lo que hacía Lumiya viewer** (visor Android de SL, abandonado).
   Referencia de estudio: `github.com/Kaleaon/Linkpoint` (visor basado en Lumiya,
   incluye el **código decompilado de Lumiya** en `lumiya_decompiled_source/`).
6. Log de error enviado por el usuario (de Linkpoint) que **no debe reproducirse**:

```
android.net.ConnectivityManager$TooManyRequestsException
  at android.net.ConnectivityManager.sendRequestForNetwork(ConnectivityManager.java:4786)
  at …registerDefaultNetworkCallbackForUid(ConnectivityManager.java:5467)
  at androidx.work.impl.constraints.trackers.NetworkStateTracker24.startTracking(NetworkStateTracker24.kt:138)
```

   Causa: `androidx.work` registrando callbacks de red una y otra vez.
   **Requisito**: la app NO usa WorkManager; el estado de red se consulta una vez
   y todo el tráfico va por sockets propios (`NativeBridge`).

## Decisiones tomadas (y por qué)

- **Motor web**: three.js r169 vendorizado dentro del propio proyecto (sin CDN en
  tiempo de ejecución) para que el APK funcione sin red para el motor.
- **Geometría de prims**: port directo de Lumiya (`PrimProfile`/`PrimPath`/
  `PrimVolume`) en vez de inventar un motor nuevo: así los prims del grid se ven
  como en SL (cortes, huecos, torsión, revoluciones…).
- **UDP**: un WebView no puede abrir sockets UDP → `NativeBridge` de Android
  expone `udpOpen/udpSend/udpClose`; el JS habla con él por `transport.js`.
  Es el mismo motivo por el que Lumiya era una app nativa.
- **HTTP**: `NativeBridge.http()` evita CORS en login/capacidades/texturas.
  En navegador de escritorio se usa `superFetch` de Perchance como reserva (el
  login y las capacidades sí funcionan; el circuito UDP no).
- **Plantilla de mensajes**: se usa la `message_template.msg` oficial de SL
  (483 mensajes) y un codificador genérico; el formato se validó contra el código
  decompilado de Lumiya (números de mensaje, campos little-endian, cuaterniones
  de 12 bytes, bloques `Variable` con contador de 1 byte, zerocode, ACKs
  adjuntos). Detalle en `LUMIYA.md`.
- **Presupuesto de prims**: una región puede tener >15 000 objetos y el motor web
  no puede teselarlos todos. Se mantiene una "residencia" de ~900 prims cercanos
  y el resto espera como metadatos; es el equivalente ligero a las listas de
  interés del visor oficial.
- **Sin WorkManager / sin dependencias pesadas de Android**: cero dependencias
  (`dependencies {}`). MainActivity sirve el visor con un interceptor propio
  (`shouldInterceptRequest` → `assets/www`) sobre el origen
  `https://appassets.androidplatform.net/`, con MIME correctos para módulos ES.
  `WebViewAssetLoader` se descartó porque quita el prefijo registrado del path
  (sólo sirve ficheros en la raíz de `assets/`) y devuelve `text/plain` para
  extensiones desconocidas, que el navegador rechaza al importar módulos.
- **Diagnóstico en vez de adivinar**: como no hay forma de ver el móvil del
  usuario, el visor trae sus propias pruebas (`runUdpDiagnosis`): red activa,
  creación de socket UDP, un datagrama de control a un STUN público y un
  `UseCircuitCode` real al simulador desde sockets desechables. Se ejecuta sola
  tras 25 s de circuito mudo y cuando falla una conexión, y todo queda en el
  registro copiable con ⧉ (el texto del modal no se puede copiar).
- **Protocolo del puente nativo**: cada llamada lleva `id` (empareja la
  respuesta) y, en UDP, `chan` (identifica el socket). Son campos distintos
  porque mezclarlos dejaba todas las llamadas UDP esperando al timeout; ver
  `README.md` § «Protocolo del puente nativo».
- **Secuencia de arranque verificada contra el visor oficial** (no adivinada):
  `UseCircuitCode` → acuse → `CompleteAgentMovement` (+`AgentThrottle`) →
  `AgentMovementComplete`, y el `RegionHandshake` se responde cuando llega, sin
  bloquear nada. Igual que en `indra/newview/llstartup.cpp`: esperar el handshake
  antes de `CompleteAgentMovement` deja al visor con el circuito vivo pero sin
  mundo. El seed capability se pide por POST con un array LLSD de nombres, como
  en `CapabilityManager` del cliente Kotlin de Linkpoint. Detalle en `LUMIYA.md`.

## Requisitos de entrega

- `visor-sl-app.zip` (proyecto Gradle completo + visor web + workflow).
- `subir-a-github-y-compilar.bat` (subida automática + disparo del APK).
- `src/` con las fuentes reales del visor (carpeta de trabajo del agente).
- Documentación: `README.md`, `SPEC.md` (este), `TODO.md`, `LUMIYA.md`.

---

## Ronda 5 (petición del usuario tras la 4ª prueba en el grid)

> «…la app debería tener data para guardar texturas, así mismo pedir permisos de
> escritura de datos y lectura, etc. También el uso de GPU… entré al mundo y sigue
> solamente habiendo estructuras cuadriculadas blancas… es indispensable un visor
> con acceso a todo lo que tiene Lumiya, incluido el avatar, sus texturas,
> animaciones, es decir todo lo que ofrece Lumiya y Second Life… el modelo 3D del
> avatar que cambie de forma para Second Life y que se pueda vestir con la ropa de
> mi inventario… necesito una app funcional en todos los aspectos… no quiero un
> juego simulado ni basado en SL, quiero que sea Second Life con cuenta, avatares,
> etc. reales… la isla del juego no es necesaria, solo la pantalla de inicio de
> sesión, guardado de datos para sesión rápida o que la sesión esté de fondo en
> segundo plano como notificación… controles táctiles de movimiento con manejo de
> cámara como se manejan los personajes en Genshin Impact.»

Requisitos concretos (todos obligatorios):

1. **Nada de simulación como producto**: el modo demo/isla deja de existir en el
   arranque normal. La app abre en la **pantalla de inicio de sesión** y, al
   entrar, va al **grid real** con la cuenta real. (El modo demo puede quedar
   disponible sólo para desarrollo tras `?test=demo`.)
2. **Almacenamiento en el dispositivo**: caché de texturas (y luego de mallas y
   animaciones) en disco, con **permisos de lectura/escritura** pedidos en tiempo
   de ejecución cuando hagan falta, y almacenamiento del usuario para **sesión
   rápida** (recordar cuenta / entrar sin volver a escribir todo).
3. **Sesión en segundo plano**: opción de mantener la sesión viva cuando la app
   pasa a segundo plano, con **notificación persistente** (no WorkManager).
4. **GPU**: aprovechar la GPU del dispositivo (WebGL2 de alto rendimiento, sin
   límite artificial de fps; calidad adaptativa medida).
5. **Paridad con Lumiya** (todo lo que ofrecía): terreno, prims con forma y
   texturas reales, **avatar 3D real** (malla del avatar de SL) con **forma**
   (parámetros de SL que cambian el cuerpo), **ropa del inventario**, **texturas
   del avatar (bake)**, **animaciones**, inventario, chat/IM, grupos, búsqueda,
   teletransporte, minimapa… por orden de importancia, empezando por lo visible.
6. **Controles táctiles tipo Genshin Impact**: joystick virtual para mover al
   personaje y arrastre en la zona derecha para girar la cámara, con botones de
   salto/volar/correr.
7. **Investigación exhaustiva** antes de implementar: el formato de malla del
   avatar de SL (`LLM`), los parámetros de forma (`SLAvatarParams`), el bake de
   texturas, el `AgentSetAppearance`/`AgentCachedTexture`, el inventario
   (`FetchInventoryDescendents`), las animaciones (`LLKeyframeMotion`), etc.
   Todo lo aprendido se documenta en `LUMIYA.md`.

## Ronda 6 — estado frente a esos requisitos

| Requisito | Estado |
| --- | --- |
| 1. Sólo login, sin isla | **hecho**: la app arranca en la pantalla de inicio de sesión con la región vacía; la isla demo sólo existe con `?test=demo` |
| 2. Almacenamiento + sesión rápida | **hecho**: caché de texturas en disco (`cachePut/cacheGet`), preferencias (último usuario/grid, hash de contraseña, MFA recordado) y botón para guardar el registro en *Descargas*. Todo en carpetas propias de la app: **no hace falta pedir permiso de almacenamiento** en Android (y se explica en el registro); sólo se pide el de notificaciones |
| 3. Sesión en segundo plano + notificación | **hecho**: `SessionService` en primer plano (`specialUse`), sin WorkManager, con la WebView (y su socket UDP) viva al pasar a segundo plano |
| 4. GPU | **hecho**: `hardwareAccelerated`, `LAYER_TYPE_HARDWARE`, `powerPreference: high-performance`, WebGL2; al arrancar se registra la GPU real y se avisa si es software |
| 5. Paridad con Lumiya | terreno (**tipo 76 + cabecera: arreglado en la ronda 10**), prims (forma + textura, bloque comprimido **y esculturas**), **mallas `LLMESH` decodificadas y dibujadas (ronda 11)**, **avatar real con forma, texturas y animaciones**: hechos. **Buscador de tierras (UDP) y teletransporte**: hechos. Ropa del inventario: la puesta se ve (bake del simulador); cambiar de ropa necesita inventario y transferencias → siguiente hito. Falta: inventario, grupos, búsqueda en el grid, minimapa, voz |
| 6. Controles tipo Genshin | **hecho**: joystick izquierdo, cámara por arrastre en la mitad derecha, botones de saltar/volar/correr/sentar, doble toque para saltar y stick a tope = correr |
| 7. Investigación exhaustiva | **hecho y documentado** en `LUMIYA.md`: formatos de red verificados contra el código decompilado de Lumiya y contra el visor oficial de Linden (`ObjectUpdateCompressed`, ExtraParams, `AnimationData`, `SLSkeletonBone`/`getPelvisToFoot`, `LLPolySkeletalDistortion`, y en la ronda 10 la máscara de caras de `llprimitive.cpp` y las esculturas de `llvolume.cpp`) |
| 8. Avisos del informe 4 | **hecho**: `KillObject` ya no falla (bloque `Variable` truncado por los *acks adjuntos* → ahora se recorta a lo que cabe); 76/76 pruebas del protocolo |

---

## Ronda 8 (tras la prueba en el móvil: «todo se ve mal y va lentísimo»)

> «probe la app todo se ve mal, no carga texturas ni nada de terreno, el avatar
> sigue siendo una capsula, todo va super lentisimo no esta optimizado para
> compresion y calidad baja para el mvil quiza. tambien lo que veo solamente son
> puros cuadros negros y espacios transparentes.. la app no me pidio acceso o
> permiso de almacenamient... tambien creo que nos estamos enfocando en una
> version web.. tenemos android y podriamos usar lo que es un juego basado en
> android y no gl web.. por favor soluciona todo investiga bien como lo hce
> lumiya y aplicalo a nuestra app android. soluciona problemas e implementa sin
> mi concentimiento lo que deduscas necesario, tu tienes el control y te doy el
> permiso completo y autonomo de agregar lo que es necesario, modificar y
> emplear metodos mas nuevos, incluso si es posible usar el motor grafico
> filament»

Requisitos de esta ronda:

1. **Que se vea**: texturas y terreno de verdad, sin cuadros negros ni huecos.
2. **Que sea fluido en el móvil**: perfiles de calidad, presupuesto de objetos y
   de texturas, y que el visor se adapte solo si el aparato no llega.
3. **Saber por qué no se ve**, sin depender de que el usuario lea una consola:
   diagnóstico en el propio dispositivo y avisos en el registro.
4. **Permisos de almacenamiento**: pedirlos donde existan, explicarlos donde no, y
   dejar elegir carpeta.
5. **Investigar a Lumiya** y aplicar lo que hacía (rendimiento, caché de texturas,
   descarga progresiva, residencia de objetos).
6. **Permiso total** para añadir, modificar y usar métodos nuevos, incluido
   cambiar de motor gráfico si conviene.

### Decisión sobre el motor gráfico (Filament / nativo)

Se mantiene **WebGL2 dentro del WebView**, con el trabajo de rendimiento de esta
ronda (batches estáticos, perfiles, texturas limitadas, decodificación en otro
hilo). Razones, por orden de peso:

- **Todo el valor que ya funciona es web**: protocolo SL, terreno, prims,
  avatares con morphs y huesos, animaciones y UI son ~150 KB de JS verificados
  contra el simulador falso más 76/76 pruebas de protocolo. Portarlo a Kotlin/C++
  para Filament es rehacerlo **sin poder verificarlo aquí**: este entorno no
  compila ni ejecuta código Android nativo, así que se enviaría a ciegas al móvil.
- **El cuello de botella real era el exceso de llamadas de dibujo**, no el motor:
  3259 → 187 llamadas medidas con el mismo WebGL2. Filament no arregla eso por sí
  solo; la solución era dejar de dibujar 3500 mallas.
- **Filament se puede adoptar por partes** más adelante, si el diagnóstico del
  móvil demuestra que el WebView no da más de sí: la pieza sustituible es el
  render (`renderer.js`/`world.js`), no el protocolo. El paso intermedio sensato
  sería un `SurfaceView` + GLES nativo por el puente, dejando toda la lógica de SL
  en JS.

Lo que sí se hizo, en la dirección que pedía el mensaje («cómo lo hace Lumiya»),
está en `LUMIYA.md` §7.

### Estado frente a los requisitos de la ronda 8

| Requisito | Estado |
| --- | --- |
| 1. Que se vea | **hecho**: el mundo blanco era el bloque comprimido mal leído (ronda 6) y el polígono negro del cielo era el plano lejano cortando la cúpula (ronda 8); una textura que no llega ya no queda negra sino con un patrón de «falta». Pendiente de confirmar en el móvil con el informe 5 |
| 2. Fluidez | **hecho**: perfiles `bajo`/`medio`/`alto`, batches estáticos (3259 → 187 llamadas; ~15 → 38-55 fps en el equipo de pruebas), gobernador de fps y bajada automática de perfil si el aparato no llega |
| 3. Saber por qué | **hecho**: panel *Diagnóstico completo* (GPU, funciones del navegador, 8 archivos de avatar, decodificación de prueba, contadores vivos), aviso si el WebView va por software, aviso explícito si los cuerpos de avatar no cargan y **prueba de vista con simulador local** (☰) para separar «fallo del móvil» de «fallo de la conexión» sin salir de la app |
| 4. Almacenamiento | **hecho**: panel con rutas, tamaño de caché, espacio libre, permiso clásico donde existe y selector de carpeta del sistema; el registro se puede guardar en *Descargas* |
| 5. Lumiya | **hecho**: `LUMIYA.md` §7 (cómo dibujaba Lumiya, qué se ha aplicado y qué queda: descarga progresiva por `Range`) |
| 6. Motor gráfico | **decidido**: se mantiene WebGL2 (razones arriba); el camino a un render nativo queda documentado y sólo se recorrerá si el diagnóstico del móvil lo justifica |

---

## Ronda 10 (informe 7: el mundo no carga, y hace falta teletransportarse)

> AHI ESTAN LOS ARCHIVOS DE LUMIYA EXTRACTED QUISA AYUDEN.. YAHORA EN ELVISOR SI
> SE VE EL AVATAR PERO SE VE DEFORME, NO ADQUIERE TEXTURAS NI MIS ANIMACIONES NI
> LA ROPA.. PERO LO CRUCIAL ES IR POR PASOS, PRIMERO ME INTERESA QU EL MUNDO
> CARGUE CORRECTAMENTE, SOLO VEO CUBOS CON CUADRICULAS BLANCAS, Y UN SIN FIN DE
> GEOMETRIAS XTRA;AS. NO SE ESTA LOGRANDO QUE SE CARGUEN LOS OBJETOS DEL MUNDO Y
> SUS TEXTURAS. INDAGA BIEN EN TOODOS LOS ARCHIVOS DE LUMIYA Y USA LO NECESARIO.
> CORRIGE COSAS, TAMBIEN NECESITO QUE PUEDA ACCEDER A UN BUSCADOR DE LANDS DESDE
> EL JUEGO PARA PROBAR EL TP

Requisitos, en el orden que pide el usuario:

1. **Ir por pasos**, y el primer paso es el mundo: que carguen **los objetos del
   mundo y sus texturas** («cubos con cuadrículas blancas y un sinfín de
   geometrías extrañas» = texturas del grid que no llegan + formas que no son
   las suyas).
2. **Investigar a fondo los fuentes de Lumiya** (y el visor oficial) y aplicar lo
   necesario.
3. **Un buscador de tierras dentro del juego, para probar el teletransporte (TP)**.
4. Después: el **avatar** (deforme, sin texturas, sin animaciones ni ropa) —
   sigue pendiente como paso 2 explícito del usuario.

Estado frente a esos requisitos:

| Requisito | Estado |
| --- | --- |
| 1. El mundo carga | **hecho y pendiente de confirmar en el móvil**: el terreno nunca llegaba porque es `LayerID.Type = 76` (no 0) y lleva cabecera de 4 bytes; la máscara de caras del `TextureEntry` estaba en orden inverso (texturas en caras equivocadas); las **esculturas** ahora se generan de verdad y un prim sin su mapa **no se dibuja**; los objetos **mesh** tampoco se dibujan como cajas |
| 2. Investigar Lumiya | **hecho**: `SLAgentCircuit.HandleLayerData`, `TerrainData.ProcessLayerData`, `SLTextureEntry.ReadFaceBitfield`, `PrimVolume.sculpt*`, más `llprimitive.cpp`/`llvolume.cpp` del visor oficial (ver `LUMIYA.md`) |
| 3. Buscador de tierras + TP | **hecho**: panel *Lands* con búsqueda por nombre/SLURL/coordenadas, mapa del grid, elección del punto exacto y `TeleportLocationRequest` → `TeleportStart` → `TeleportFinish` → circuito nuevo. Probado de punta a punta con `?test=grid&tp=1004,1006` |
| 4. Avatar (paso siguiente) | **pendiente**: el usuario dice que se ve deforme y sin texturas/animaciones/ropa; el siguiente paso es diagnosticarlo con un informe (y `?test=avatar`) |

## Ronda 11 (informe 8: «los TP no funcionan, el buscador de regiones no encuentra sitios, todo sigue viéndose roto sin estructuras ni texturas lógicas»)

> los tp no funcionan la busqueda de regiones no encuentra sitios. todo sigue
> viendose roto sin sentido sin estructuras ni teexturas logicas, debes indagar n
> como funciona second life y lumiya y como es que hacian para renderizar el mundo
> y los objetos, por favor analiza todos los archivos que e adjunto es necesariio
> aunque tardes, los archivos qe te adjunte son archivos de el proyecto linkpoint
> y de lumiya... debes usar lo necesario para usar en el nuestro

Requisitos, en el orden que pide el usuario:

1. **Que el teletransporte funcione.**
2. **Que el buscador de regiones encuentre sitios.**
3. **Que el mundo tenga estructuras y texturas lógicas** (analizar cómo renderizan
   el mundo y los objetos el visor oficial, Lumiya y Linkpoint, y aplicar lo
   necesario).
4. Analizar **todos** los archivos adjuntos (proyecto Linkpoint + Lumiya), aunque
   lleve tiempo.

Estado frente a esos requisitos:

| Requisito | Estado |
| --- | --- |
| 1. Teletransporte | **hecho**: `CrossedRegion` (salto de borde de región) ya no se ignora y se completa como `TeleportFinish`; el envío es fiable por defecto (como Lumiya). Pendiente de confirmar en el móvil (informe 9) |
| 2. Buscador de regiones | **hecho**: búsqueda de nombre por `MapNameRequest`/`MapBlockReply` (UDP, el protocolo real) y relleno del mapa con `MapBlockRequest`; la web de mapas queda de reserva |
| 3. Mundo con estructuras | **hecho**: (a) el JPEG2000 de 4 componentes se leía como RGBA entrelazado y producía **rayas verticales + barra negra** en cada textura — es la causa directa de «texturas sin sentido»; (b) **las mallas `LLMESH` se decodifican y se dibujan** (el activo viaja por `GetMesh`), que es lo que faltaba para que hubiera edificios: una región moderna es casi toda malla; (c) `LLSD` binario arreglado (big-endian, mapa con recuento, clave sin etiqueta `s`), que era lo que impedía leer una cabecera de malla |
| 4. Analizar los adjuntos | **hecho**: se han usado el visor oficial (`llmeshrepository.cpp`, `llvolume.cpp`, `llsdserialize.cpp`, `llprimitive.cpp`), Lumiya (`PrimVolumeParams`, `slproto/…`) y el proyecto Linkpoint (docs de `fixes/`, `capabilities/`, `reports/`), además del propio repositorio `yossfu/visor-sl` (que ya tenía un decodificador `llmesh.js` en otra carpeta) |
| Extra | **`mesh-encode.js`** escribe activos `LLMESH` reales, así que el decodificador se prueba contra un codificador (autotest 97/97, arnés `?test=grid`, demo offline). Un bug del *batcher* al reutilizar el mundo (el demo mostraba sólo terreno) quedó arreglado. Versión **1.6.0 (build 7)** |
| 3b. Verificación antes de subir | **hecho**, en `?test=grid`: el teletransporte **por la interfaz** (panel *Lands* → «Sandbox Cordova» → *Teletransportar*) recorre búsqueda UDP → `TeleportStart` → `TeleportFinish` y llega a la región nueva con sus 44 prims; la búsqueda por nombre resuelve por UDP; el mundo se ve con terreno, objetos sólidos y un edificio con tejado; y el arnés `?test=sculpt` dibuja las cinco esculturas y la casa de malla (y no dibuja los dos casos que no deben dibujarse) |


