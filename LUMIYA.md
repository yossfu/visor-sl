# LUMIYA.md — qué hacía Lumiya y qué está portado

Fuente de estudio: `github.com/Kaleaon/Linkpoint` (contiene el código **decompilado**
de Lumiya en `lumiya_decompiled_source/com/lumiyaviewer/lumiya/`, 846 ficheros en
`slproto/`), más `lumiya_decompiled_source/com/lumiyaviewer/lumiya/{render,ui,cloud}/`.

## 1. Datos de formato de red verificados en el código decompilado

Todo esto se comprobó leyendo ficheros concretos y se usa en
`src/web/js/message-template.js` / `udp.js`:

| Hecho | Fuente | Nota |
| --- | --- | --- |
| Los campos numéricos del cuerpo van en **little-endian** | `slproto/SLMessage.java` (`PackPayloadLE`/`UnpackPayloadLE` cambian el `ByteOrder` a LITTLE_ENDIAN) | los UUID van siempre como 16 bytes en orden de red |
| La cabecera del paquete es `flags(1) + secuencia(4, BE) + 1 byte extra (0)` | `SLMessage.Pack` / `Unpack` | el byte extra se salta si no es 0 |
| `flags`: `0x10` ACKs adjuntos, `0x20` reenvío, `0x40` fiable, `0x80` zerocode | `SLMessage` constantes `LL_ACK_FLAG`, `LL_RESENT_FLAG`, `LL_RELIABLE_FLAG`, `LL_ZERO_CODE_FLAG` | |
| Los ACKs adjuntos se leen del **final** del paquete: `n` enteros BE y el contador como último byte | `SLMessage.Unpack` | |
| Números de mensaje: High = 1 byte; Medium = `FF nn`; Low = `FF FF hh ll`; Fixed = `FF FF FF FB` | `SLMessage.DecodeMessageID` + `Put` de cada mensaje (`UseCircuitCode` → `FF FF 00 03`, `AgentDataUpdate` → `FF FF 01 83`, `CoarseLocationUpdate` → `FF 06`, `PacketAck` → `FF FF FF FB`) | implementado en `encodeNumber`/`decodeNumber` |
| **LLQuaternion = 3 floats (12 bytes)**, la W se calcula | `SLMessage.packLLQuaternion` (x,y,z) y `LLQuaternion.parseFloatVec3` | `AgentUpdate.CalcPayloadSize() == 115` lo confirma |
| `LLVector3d` = 3 doubles; `LLVector4` = 4 floats; `IPADDR` = 4 bytes crudos; `BOOL` = 1 byte | `SLMessage.pack*` | |
| Los campos `Variable n` llevan delante su longitud en n bytes **little-endian**; las cadenas incluyen el NUL final dentro de esa longitud | `SLMessage.packVariable` + `stringToVariableUTF` | `ChatFromViewer` vacío = 40 bytes (32 + 2 + 1 + 1 + 4) |
| Los bloques `Variable` escriben su contador como **1 byte al principio del bloque** | `PacketAck`, `ObjectProperties`, `CoarseLocationUpdate`, `AgentUpdate`… | |
| Los bloques `Multiple` (sólo `TestMessage`, `NeighborList`, `SimulatorPresentAtLocation`, `ViewerStats`) escriben sus N registros **sin contador** en Lumiya | `TestMessage.PackPayload` | este visor sí escribe el contador en la cabecera, como libomv/la plantilla |
| Zerocode: `00` + (nº de ceros) delante del siguiente byte no nulo; la cuenta va **después** del marcador | `SLMessage.ZeroEncode`, `DirectByteBuffer.zeroDecode` | se implementa de forma compatible |
| Contraseña: `"$1$" + md5(password.trim().substring(0,16))` | `slproto/auth/SLAuth.getPasswordHash` | |
| Posición "terse" (16/32/48 bytes): `pos, vel, accel, rot` (cuantizados U8 o U16) y luego velocidad angular | `slproto/objects/SLObjectInfo.ParseObjectData` | en 60 bytes es flotante: `pos,vel,accel,rot(+angVel)`; la variante de 76 lleva 16 bytes de prefijo |

### Animaciones y esqueleto del avatar (ronda 6) — verificado en el código decompilado

- **`ObjectUpdateCompressed` (lo que hacía que el mundo saliera blanco)**: la
  cabecera fija es FullID(16) LocalID(4) PCode(1) Estado(1) CRC(4) Material(1)
  ClickAction(1) Escala(12) Posición(12) Rotación(12, tres floats — la W se
  deriva) y **SpecialCode(4) y Owner(16) incondicionales** (el bit 0x01 del
  SpecialCode es el *scratchpad*, no el dueño). Después van los parámetros extra
  tal cual los describe la plantilla y, **al final del bloque**, la **forma del
  prim (23 B, de PathCurve a ProfileHollow) y el TextureEntry (`S32` tamaño +
  datos)**. Lumiya (`SLObjectInfo.java`) los lee de ahí, no del principio.
- **Parámetros extra**: `U8 num_params` y por cada uno `[U16 tipo][S32 tamaño][datos]`;
  flexible = tension/drag/gravity/wind + 3 floats de fuerza; luz = RGBA(4×U8) +
  3 floats (radio, corte, caída) = 16 B; sculpt = UUID + U8 tipo = 17 B.
- **Escalas de hueso (`LLPolySkeletalDistortion`)**: el `<bone scale="x y z"/>`
  de `avatar_lad.xml` es un *delta* que se **suma** a la escala del hueso,
  multiplicado por el peso del slider, y el hueso deforma **su propia malla y a
  sus volúmenes de colisión**, mientras que **cada hijo escala su desplazamiento
  con la escala de su padre directo** (`SLSkeletonBone.updateGlobalPos`:
  `usePosition * parent.scale + offset`). Es decir: la escala **no** se acumula
  multiplicando generación tras generación — con la lectura ingenua, la Altura al
  máximo daba un avatar de 3,2 m en vez de 2,2 m. La escala del hueso se aplica
  *después* de su rotación, sólo a los vértices ligados a él
  (`Matrix.scaleM(... globalMatrix, scale)`).
- **`mPelvis` es la raíz** y las piernas crecen hacia abajo, así que un avatar
  alto se hundiría en el suelo: el visor recoloca el cuerpo con
  `getPelvisToFoot()` (deformado, no de reposo) y `getBodySize()`. En este visor
  se replanta con el mínimo de los tobillos/pies de la **forma** (no de la
  animación, que sí puede levantar el cuerpo: volar, sentarse).
- **Formato de animación (`AnimationData`)**: `S32` desconocido (siempre 1),
  prioridad, duración, nombre de expresión acabado en NUL, `inPoint`/`outPoint`,
  bucle, `easeIn`/`easeOut`, `handPose`, nº de huesos y, por hueso: nombre,
  **prioridad por hueso**, fotogramas de rotación (`U16` tiempo + 3 `U16` del
  vector del cuaternión, que se normaliza con `w = √(1-|v|²)`) y fotogramas de
  posición (`±5 m`). Los archivos acaban con 4 bytes que el visor no lee.
  - La **prioridad por hueso** es lo que agrupa los huesos en "conjuntos": una
    animación puede llevar las caderas en prioridad 3 y el torso en 0, y en la
    mezcla cada conjunto compite por separado (por eso una animación de brazos no
    rompe la de caminar). El *blend* final normaliza el cuaternión por el peso
    total aplicado.
  - Los 118 assets de Lumiya son los que trae la app; sus UUID de sistema
    (`animUUID_*` en `SLAvatarControl`) son los que manda el simulador en
    `AvatarAnimation` (STAND `2408fe9e…`, WALK `6ed24bd8…`, RUN `05ddbff8…`).

### LLSD (capacidades y EventQueue) — verificado en `llsdserialize*.cpp`

- El XML de LLSD (respuesta de la capability semilla, EventQueueGet) escribe los
  mapas **planos**: `<llsd><map><key>k</key><string>v</string>…</map></llsd>`,
  **sin** `<member>` (eso es XML-RPC, que sí lo usa `login.cgi`).
- La notación LLSD (`application/llsd+notation`) escribe las cadenas entre
  comillas simples (`'texto'`), los mapas como `{'clave':valor}`, las fechas
  como `d"..."`, las URI como `l"..."`, las UUID como `u<36>` y los enteros
  como `i<n>`. El parser acepta además `s<len>:texto` y `b64"..."`.
- **El seed capability se pide con POST** y un cuerpo que es un **array LLSD de
  nombres** (`<llsd><array><string>EventQueueGet</string>…`), con
  `Accept: application/llsd+xml, application/llsd+binary`; la respuesta es el mapa
  de nombres a URLs. Un GET devuelve `405 Method Not Allowed` (es el valor por
  defecto de `LLHTTPNode::get()` en Linden), que es justo lo que vimos en la
  segunda prueba real. Referencia cruzada: `CapabilityManager.requestCapabilities`
  del cliente Kotlin de Linkpoint.
- Las respuestas pueden llegar en XML o en **LLSD binario** (magia `LLSD\x01`), así
  que `loadCapabilities` le pasa los bytes a `LLSD.parse`, que detecta el formato.

### Bloques `Variable` y los *acks adjuntos* (ronda 6, informe 4)

Los mensajes de la plantilla pueden traer bloques `Variable`: **un byte de
recuento** antes de las repeticiones (`lltemplatemessagereader.cpp`). El recuento
puede valer `0xff` (p. ej. `KillObject` con 255 identificadores, que es lo que
manda el simulador al vaciar una región). El problema real era otro: **cuando el
datagrama lleva *acks adjuntos* (bandera `0x10`), el recorte de la cola puede
caer dentro del bloque**, y entonces el recuento pide más repeticiones de las que
quedan y el `DataView` se sale del buffer (`Offset is outside the bounds of the
DataView`). Cabecera real observada en el grid: `10 ff e2 0c 00 00 e3 0c 00 00 …`
→ byte de número de mensaje `0x10` (=16, `KillObject`), recuento `0xff`=255, IDs
`3298, 3299, 3300, 3301…`. `decodeBody` ahora recorta el recuento al número de
repeticiones que caben enteras, así que nunca lanza y se siguen matando los
objetos que sí venían en el paquete.

### Divergencias conscientes
- **ImprovedInstantMessage**: Lumiya empaqueta sólo hasta `BinaryBucket` (sin
  `EstateBlock` ni `MetaData`), mientras que la `message_template.msg` actual (y
  libomv) incluyen esos bloques. Este visor sigue **la plantilla** (más seguro:
  si sobran bytes al final el simulador los ignora, si faltan puede descartar el
  mensaje). Si los IM fallaran en el grid, esto es lo primero que hay que probar.
- **Rangos de cuantización "terse"**: se usan los de Lumiya (`x,y ∈ [-128,384]`,
  `z ∈ [-256,4096]`, rotación `[-1,1]`), porque la llamada del código decompilado
  para el caso de 8 bits aparece con argumentos corruptos (`384, 384`). Si los
  objetos aparecen desplazados, están todos los rangos en un solo sitio:
  `POS_XY`, `POS_Z`, `VEL_XY`, `VEL_Z` en `object-update.js`.

## 2. Login: lo que envía el visor oficial (verificado en Firestorm)

Fuente: `indra/newview/lllogininstance.cpp` (`LLLoginInstance::constructAuthParams`
y `connect`), `indra/newview/llxmlrpclistener.cpp` (`Poller`),
`indra/newview/llxmlrpctransaction.cpp` (construcción del XML-RPC) e
`indra/newview/fspanellogin.cpp` (`getFields`, nombres de usuario).

- La petición es **XML-RPC** (`<methodCall><methodName>login_to_simulator</methodName>`)
  con **un único `<param>` que es una struct plana**: cada parámetro es un
  `<member>` hermano; `options` va como array dentro. Los booleanos se convierten
  a **enteros** (`agree_to_tos`, `read_critical`, `extended_errors` → `<int>1</int>`).
- Parámetros que manda el visor: `first`, `last`, `passwd` (`$1$`+md5),
  `start`, `agree_to_tos`, `read_critical`, `mac`, `version`, `channel`,
  `platform`, `address_size`, `platform_version`, `platform_string`, `id0`,
  `host_id`, `extended_errors`, `token`, `mfa_hash`, `options`. (`viewer_digest`
  no lo manda; aquí se envía a ceros por compatibilidad con Lumiya.)
- **Usuario de una sola palabra**: en las grids de Linden, si no hay separador se
  envía `first=<usuario>`, `last="Resident"`; también se aceptan
  `nombre.apellido` y `nombre_apellido`.
- **MFA**: si la cuenta tiene verificación en dos pasos, el login falla con
  `reason == "mfa_challenge"` y un `mfa_hash` en la respuesta; el visor guarda ese
  hash y reintenta con `token` = código de 6 dígitos (sin espacios). Si el
  `mfa_hash` se recuerda, los siguientes logins no piden código. Es lo que hace
  `visor.mfa.<grid>.<usuario>` en `localStorage`.
- `extended_errors: 1` hace que la respuesta traiga `message_id` y
  `message_args`, que es lo que se enseña cuando el login falla.

## 3. Inventario de funciones de Lumiya y estado

| Área de Lumiya (ficheros) | Estado en Visor SL |
| --- | --- |
| `slproto/SLThreadingCircuit`, `SLCircuit`, `SLAgentCircuit` (circuito UDP, ACKs, reenvíos, ping) | **hecho** (`udp.js` + `sl-session.js`) |
| `slproto/auth/SLAuth`, `SLAuthParams/Reply` (login) | **hecho** (XML-RPC + `$1$` md5) |
| `slproto/caps/SLCaps`, `SLCapEventQueue` (capacidades + EventQueue) | **hecho** (teleport/cruce; resto de eventos ignorados) |
| `slproto/prims/*` (PrimProfile/Path/Volume/Face/Params) | **portado** (`prims.js`), incluidas caras, cortes, huecos, torsión, revoluciones |
| `slproto/terrain/*` (TerrainPatch, DCT, texturas de terreno) | **portado** (`terrain.js`); falta `EdgeDataPacket` (bordes de agua) |
| `slproto/textures/SLTextureEntry(+Face)` | **portado** (`texture-entry.js`) |
| `slproto/modules/texfetcher`, `texuploader` (descarga de texturas, HTTP) | **parcial**: descarga por capacidad `GetTexture`; falta JPEG2000 real y subida |
| `slproto/objects/SLObjectInfo`, `SLPrimObjectDisplayInfo` (objetos y jerarquía) | **parcial**: objetos y updates (incluido el bloque comprimido completo, forma + TextureEntry al final); falta jerarquía de enlaces y propiedades |
| `slproto/messages/*` (400+ mensajes) | **genérico**: la plantilla los cubre todos; implementados los que usa el flujo actual |
| `slproto/avatar/*`, `baker/*` (avatares, esqueleto, morphs, baking) | **hecho en lo esencial**: `avatar/params.js` (avatar_lad.xml + drivers), `avatar/skeleton.js` (avatar_skeleton.xml), `avatar/llm.js` (mallas y morphs), `avatar/skin.js` (pose + *skinning*) y `avatar/builder.js`; falta el *baking* propio (se usan las texturas baked que manda el simulador) |
| `res/avatar/AnimationData`, `AnimationSkeletonData`, `AvatarAnimationList` (animaciones) | **portado**: `avatar/anim-data.js` (formato LLKeyframeMotion + paquete de 118 animaciones que trae la app) y `avatar/animation.js` (secuencias, ease-in/out, bucle, blend por prioridad). Falta el transfer UDP para animaciones que no vengan en el paquete |
| `slproto/mesh/*`, `render/lumiya/drawable/*` (mallas, sculpt, render de prims) | **no**: sculpt/mesh pendientes (los `sculptId` se leen, no se dibujan) |
| `slproto/modules/rlv` (Restrained Life) | **no** |
| `slproto/inventory/*`, `modules/xfer`, `transfer` (inventario, transferencias) | **no** |
| `slproto/chat/*`, `users/*` (chat, IM, nombres, perfiles) | **parcial**: chat local, IM entrante/saliente, nombres; falta UI de conversaciones |
| `slproto/modules/{groups,search,voice,mutelist,finance}`, `objects/PayInfo` | **no** |
| `slproto/modules/SLMinimap`, `SLWorldMap`, `SLDrawDistance` | **no** (hay distancia de dibujo fija) |
| `slproto/windlight/*` (cielo/atmósfera) | **parcial**: cielo procedural propio, sin presets Windlight |
| `render/*` (GLES, shaders de prims/terreno/avatares, culling, LOD) | **equivalente web** en `renderer.js`/`world.js` (LOD por distancia y teselado) |
| `ui/*` (HUD, inventario, chat, cámara, RLV…) | **propio**: HUD web con inspector, panel, chat, login |

## 4. Siguientes pasos por orden de impacto

1. Probar el login real y arreglar lo que falle (ver `TODO.md`).
2. ~~Decodificador JPEG2000 (texturas)~~ **hecho** (OpenJPEG wasm); texturas del terreno desde la región: hecho el camino, pendiente de ver en el grid.
3. Sculpt maps y mallas (`GetMesh`): lo que queda de geometría.
4. ~~Avatares con esqueleto y apariencia~~ **hecho** (formas, morphs, escalas de hueso, texturas baked y animaciones con los 118 assets de Lumiya). Queda el *baking* propio y el transfer de animaciones no incluidas.
5. **Transferencias de assets por UDP** (`TransferRequest`/`TransferInfo`/`TransferPacket` + acks): es lo que desbloquea animaciones subidas por residentes, y después el inventario/wearables.
6. Inventario (capacidades `FetchInventory2`/`FetchLib2`) y ventana de ropa.
7. UI de conversaciones (IM por residente, historial), grupos, minimapa.

## 5. Arranque del agente y acuses (lo que faltaba en la 2ª prueba real)

Secuencia real, tal como la hace el visor oficial (`indra/newview/llstartup.cpp`,
comprobado en el código de Linden) y como la implementa ahora `sl-session.js`:

1. `UseCircuitCode` (fiable) → el simulador contesta con **`PacketAck`**.
2. **`CompleteAgentMovement`** en cuanto llega ese acuse (`STATE_AGENT_SEND`), sin
   esperar al `RegionHandshake`; junto con `AgentThrottle` y
   `AgentDataUpdateRequest`.
3. El simulador manda `RegionHandshake` (se responde con `RegionHandshakeReply`),
   `AgentMovementComplete` y, ya sí, el mundo: `LayerData`, `ObjectUpdate`,
   `ObjectUpdateCached/Compressed`, `ImprovedTerseObjectUpdate`, `KillObject`,
   `SimulatorViewerTimeMessage`…

Dos detalles que nos costaron una prueba entera contra el grid:

- **Esperar el `RegionHandshake` antes de `CompleteAgentMovement` bloquea todo**:
  el simulador acusa y hace ping (el circuito vive) pero no manda nada de la
  región, porque el avatar no ha "entrado". Ese era exactamente el registro de la
  segunda prueba real.
- **Los acuses llegan como mensaje `PacketAck`** (número 0xFFFFFFFB, con un bloque
  `Packets` variable de U32), no sólo como trailer de acks adjuntos. `udp.js`
  entiende ahora las dos formas: sin la de mensaje, la cola de fiables no se vacía
  y el bucle de reenvíos reintenta eternamente paquetes ya confirmados.

## 6. Puente nativo Android: dos identificadores, no uno

Lumiya hablaba UDP directamente porque era una app Java. Aquí el motor vive en un
WebView y el socket lo abre `NativeBridge.kt`, así que cada datagrama cruza la
frontera JS↔Java. Lo que hay que respetar:

- La llamada `@JavascriptInterface` **bloquea el hilo del renderer** mientras se
  ejecuta, y el método corre en el hilo *JavaBridge*: por eso abrir el socket y
  enviar se hacen en un pool propio (`udpPool`, un solo hilo → se conserva el
  orden de los datagramas) y la respuesta se devuelve **empujando** un JSON a
  `window.visornative(...)`. `nativeCall()` en `transport.js` empareja la
  respuesta con la llamada por el campo `id`, y el socket por el campo `chan`.
- **Ese emparejamiento fue el fallo de la primera prueba real**: el `id` del
  llamador pisaba el de seguimiento, la respuesta de `udpOpen` llegaba con otra
  clave y toda llamada UDP se quedaba esperando hasta el timeout (18 s), que en el
  registro se veía como «Abriendo circuito UDP…» y luego «Desconectado.».
- La recepción se acumula y se entrega en lotes (`kind:"udpBatch"`, uno cada
  ~20 ms): un `evaluateJavascript` por datagrama no aguanta el caudal de un sim
  con gente (cientos de paquetes por segundo).
- Diagnóstico incorporado (`runUdpDiagnosis` en `sl-session.js`): red activa,
  creación de socket, y **dos pruebas de ida y vuelta con sockets desechables** —
  un STUN de Google (control: ¿la red deja salir UDP?) y un `UseCircuitCode` real
  al simulador. Es la forma de distinguir un fallo de red de un fallo de paquete.
  Se ejecuta sola cuando el circuito lleva 25 s sin recibir nada.

## 7. Rendimiento: cómo dibujaba Lumiya y cómo lo hace el motor web (ronda 8)

El usuario preguntó, con razón, si no deberíamos dejar el WebGL y usar algo como
**Filament**. Esta sección es la investigación que respalda la decisión (seguir
con WebGL2, y por qué) y el resumen de lo que sí se ha copiado de Lumiya.

### Lo que hacía Lumiya

| Pieza de Lumiya | Qué hacía | Nuestro equivalente |
| --- | --- | --- |
| `render/lumiya/drawable/*` (`DrawablePrim`) | Cada prim se dibujaba con **listas de dibujo por volumen**: la geometría de un volumen+detalle se construía una vez y se reutilizaba para todos los prims de la misma forma, con `glDrawElements` por cara. Era GLES **nativo**, sin capa de motor por encima | El coste equivalente en un motor web no son los triángulos sino las **llamadas de dibujo**: three.js no puede meter 3500 mallas en una sola. `batch.js` funde por celda+material (3259 → 187 llamadas medidas) |
| `slproto/modules/texfetcher`, `texuploader` | **Descarga progresiva**: pedía la cabecera del J2C y luego los niveles por `Range`, decodificaba e iba subiendo niveles de detalle. Cada textura subida se quedaba en una **caché en disco** de la app | `j2c.js` decodifica la textura entera (OpenJPEG wasm) en un **worker** y la guarda en la caché en disco (`NativeBridge.cachePut`). La descarga progresiva por `Range` sigue pendiente: es el siguiente ahorro real |
| `slproto/modules/SLMinimap`, listas de interés internas del `SLAgentCircuit` | Sólo se instanciaban los objetos cercanos; el resto existían como datos | `world.updateVisibility` + presupuesto de objetos por perfil (600/1600/4000) y `updateResidency` |
| `DrawablePrim` con niveles de detalle por distancia | LOD de geometría por tamaño en pantalla | `world.updateLOD` (detalle 1-4 por distancia y tamaño) + `terrainSkip` por perfil |
| Ajustes de calidad del visor Android | Distancia de dibujo, calidad de terreno, sombras, resolución | `perf.js`: perfiles con pixelRatio, alcance, sombras, teselado, tamaño de textura y presupuesto de GPU, con gobernador de fps |

### Por qué no Filament (todavía)

1. **El cuello de botella no era el motor gráfico.** Medido: el mismo WebGL2 pasa
   de ~15 fps a 38-55 fps sólo dejando de emitir 3000 llamadas de dibujo. Filament
   no hace eso por ti (sigue habiendo una llamada por *renderable*).
2. **Filament es Vulkan/GLES nativo, no un plugin**: adoptarlo significa que el
   render vive en C++/Kotlin y el protocolo SL, el terreno, los prims, el
   *skinning* de avatares y la UI tienen que hablarle. Es un visor nuevo con el
   mismo protocolo, no una mejora.
3. **No se puede verificar aquí.** Este entorno no compila Kotlin/C++ ni ejecuta
   un APK: cualquier port nativo se enviaría al móvil a ciegas, y las últimas
   rondas han demostrado lo caro que sale depurar a ciegas (cuatro pruebas reales).
4. **La arquitectura ya permite el cambio por partes.** El protocolo y los datos
   son JS puro y están probados (70/70) contra el simulador falso; el render está
   aislado en `renderer.js`/`world.js`. Si el diagnóstico del móvil demuestra que
   el WebView no da más de sí (por ejemplo, `GPU (software): SÍ`), el paso
   siguiente es un `SurfaceView` con GLES nativo detrás del puente, sustituyendo
   sólo la capa de render.

### Lo que sí se aplicó de Lumiya en esta ronda

- Reutilización agresiva de geometría y materiales (equivalente a las listas de
  dibujo por volumen), que es lo que permite que 4800 mallas se dibujen con 187
  llamadas.
- Presupuesto de objetos y LOD por distancia como las listas de interés.
- Caché de texturas en disco **y** tope de memoria de GPU con recorte LRU: la
  memoria gráfica se agota enseguida con texturas de 1024² y el driver empieza a
  hacer *thrashing*.
- Tamaño de textura dependiente del dispositivo (en Lumiya también se bajaba el
  detalle antes de pedir la textura completa).


