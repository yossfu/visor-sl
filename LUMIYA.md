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

### LLSD (capacidades y EventQueue) — verificado en `llsdserialize*.cpp`

- El XML de LLSD (respuesta de la capability semilla, EventQueueGet) escribe los
  mapas **planos**: `<llsd><map><key>k</key><string>v</string>…</map></llsd>`,
  **sin** `<member>` (eso es XML-RPC, que sí lo usa `login.cgi`).
- La notación LLSD (`application/llsd+notation`) escribe las cadenas entre
  comillas simples (`'texto'`), los mapas como `{'clave':valor}`, las fechas
  como `d"..."`, las URI como `l"..."`, las UUID como `u<36>` y los enteros
  como `i<n>`. El parser acepta además `s<len>:texto` y `b64"..."`.

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
| `slproto/objects/SLObjectInfo`, `SLPrimObjectDisplayInfo` (objetos y jerarquía) | **parcial**: objetos y updates; falta jerarquía de enlaces, `ObjectUpdateCompressed` completo y propiedades |
| `slproto/messages/*` (400+ mensajes) | **genérico**: la plantilla los cubre todos; implementados los que usa el flujo actual |
| `slproto/avatar/*`, `baker/*` (avatares, esqueleto, morphs, baking) | **no**: los residentes son cápsulas con nombre |
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
2. Decodificador JPEG2000 (texturas) y texturas del terreno desde la región.
3. Mallas (`ObjectUpdateCompressed` + carga de mesh por capacidad `GetMesh`) y sculpt maps.
4. Avatares con esqueleto y apariencia (baking) — la parte más grande de Lumiya.
5. Inventario y transferencias (Xfer) para wearables y objetos.
6. UI de conversaciones (IM por residente, historial), grupos, minimapa.

## 5. Puente nativo Android: dos identificadores, no uno

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

