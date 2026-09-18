# El visor de Second Life de verdad (Fases 8 y 12)

Este documento existe porque el código lo cita: `main.pjs`, `index.html` y las
cabeceras de `src/sl/relay.js`, `src/sl/login.js`, `src/sl/session.js` y
`src/sl/mockServer.js` apuntan aquí. Cuenta **por qué** hay un retransmisor de
por medio, **qué** habla el navegador con él, **qué** tiene que hacer la mitad
que no está en el navegador, y **qué** falta para estar dentro de una región de
Second Life de verdad.

> **Estado (Fase 12).** El retransmisor **ya está escrito en JavaScript**
> (`src/sl/lludp/gateway.js`, con el resto del núcleo LLUDP en `src/sl/lludp/`),
> y ya entra en regiones de verdad: login, circuito UDP, handshake, terreno,
> objetos, avatares, chat, toque, movimiento y teletransporte dentro de la
> región. Lo único que queda fuera del navegador es **mover datagramas UDP**: lo
> hace el puente tonto de la app Android (`UdpBridgeServer.kt`), y en el
> escritorio lo suple un simulador de región en JavaScript (`?udp=sim`). Las
> secciones §6 y §7 se conservan como referencia del protocolo del enlace y de
> la lista de trabajo (hoy cumplida salvo assets/caps y cambio de región).

---

## 1. Por qué hace falta un retransmisor

Un navegador **no puede** hablar con un simulador de Second Life, y no por falta
de ganas ni de rendimiento:

1. **Los simuladores hablan LLUDP.** El protocolo de la región es UDP en crudo,
   con su propia cabecera (flags, numeración de secuencia, acks, resentidos),
   su troceado de mensajes grandes y su **cifrado XOR** con la clave derivada
   del `circuit_code`. El navegador no tiene sockets UDP: ni WebRTC (que solo
   hace ICE/DTLS entre pares, no UDP arbitrario a un host) ni WebTransport
   (QUIC, tampoco UDP en crudo) llegan a eso.
2. **Las *capabilities* de la región son HTTP sin CORS.** El login devuelve
   `seed_capability`, una URL `https://sim…/?sg=…` desde la que cuelgan el
   `EventQueueGet` (la cola de eventos, por donde llegan el terreno por HTTP,
   las parcelas, el inventario, el teletransporte…) y las peticiones de assets.
   Ese servidor no manda `Access-Control-Allow-Origin`, así que `fetch` no puede
   leerlo. (El proxy de `super-fetch-plugin` sí puede con el login, que es una
   petición suelta, pero **no** sirve para un socket ni para una cola larga.)
3. **El login sí es HTTP.** `login_to_simulator` es XML-RPC sobre HTTPS **sin**
   CORS: por eso lo hace el propio visor a través de `super-fetch-plugin`
   (`src/sl/login.js`). Lo que no puede hacer el navegador es lo que viene
   *después* del login.

Esto no es una limitación de este proyecto. Es la razón por la que **SpeedLight,
Lumiya, Radegast, Metabolt o el visor de Alchemy funcionan con un componente
fuera del navegador**: hace falta un proceso que tenga un socket UDP y que
pueda abrir las capabilities.

```
   navegador / WebView                     retransmisor LLUDP              simulador
  (el visor JS)                 ┌──────────────────────────────┐        de Second Life
  ┌─────────────┐               │  circuito LLUDP (UDP+acks)   │        ┌──────────┐
  │ index.html  │◄──enlace─────►│  src/sl/lludp/gateway.js     │◄──UDP──►│  sim      │
  │ src/sl/*    │  (relay.js)   │  (TODO en JavaScript)        │  puente │  (región)  │
  │ three.js    │               │  caps/EventQueue (falta)     │        └──────────┘
  └─────────────┘               └──────────────────────────────┘
      hecho                      hecho (menos caps/assets)      hecho en la app Android
```

El retransmisor **no traduce el mundo** a un protocolo propio complejo: manda
justo lo que hace falta para dibujar, en las tramas de `src/sl/relay.js`. Y no
es un binario aparte: es **JavaScript**, el mismo código que corre en el
navegador y que se prueba con el simulador de `src/sl/lludp/sim.js`. Las
referencias del protocolo real que se usaron fueron las fuentes de Linden Lab
(`message_template.msg`, etc.) y, como contraste,
**[Hippolyzer](https://github.com/SaladDais/Hippolyzer)** (Python).

## 2. Las dos mitades

- **Lado navegador (hecho).** `src/sl/login.js` autentica; `src/sl/relay.js`
  define las tramas y el transporte; `src/sl/session.js` es el puente entre el
  enlace y el mundo (`world.applyRemote`, el mismo camino que usa el
  multijugador, así que no hay dos mundos distintos); `src/sl/startPanel.js` es
  la pantalla de arranque con los modos de entrada.
- **Lado retransmisor (hecho, en JavaScript).** `src/sl/lludp/gateway.js` hace
  de cliente LLUDP contra el simulador y reenvía terreno/objetos/avatares/chat/
  toque/movimiento al visor en las tramas de la §6. Debajo están las plantillas,
  el códec, el circuito, el terreno, los objetos y el agente (`src/sl/lludp/*`).
  Lo que aún no hace: capabilities/EventQueueGet y assets (§7 punto 3 y §9).
- **Transporte (nativo, mínimo).** Un navegador no puede abrir UDP; el puente de
  la app Android mueve datagramas y nada más. En el escritorio lo suple el
  simulador en JS de `src/sl/lludp/sim.js`.

El mismo cliente sirve para el retransmisor de verdad y para el simulador de
pruebas: `relay.js` **no sabe nada de Second Life**, solo de bytes.

## 3. Flujo: del login a la región

```
1. Pantalla de arranque (src/sl/startPanel.js)
   ├─ modo "session"      login aquí (superFetch) → al gateway solo el id de sesión
   ├─ modo "credentials"  usuario+contraseña al gateway → él hace el login
   └─ modo "mock"         simulador local, sin red  (§7)

2. createSession() → createRelay() → WebSocket al gateway
   C.HELLO {protocol, client, version, capabilities[]}
   ◄─ S.WELCOME {protocol, region, regionHandle, …}          enlace "ready"

3. Credenciales
   ├─ session:      C.LOGIN {mode:"session", sessionId, secureSessionId,
                             agentId, circuitCode, simIp, simPort, regionX,
                             regionY, seedCapability}
   └─ credentials:  C.LOGIN {mode:"credentials", grid, name, password, token}

4. El gateway abre el circuito UDP:  UseCircuitCode → RegionHandshake
   → RegionHandshakeReply → CompleteAgentMovement → AgentUpdate(1 Hz)
   y empieza a bombear el mundo.

5. El gateway narra el progreso con S.STATE (fases de PHASE en relay.js).
   Terreno (S.TERRAIN), objetos (S.OBJECTS_BEGIN → S.OBJECT* → S.OBJECTS_END),
   avatares (S.AVATAR*), parcela (S.PARCEL), texturas a petición (S.ASSET).

6. session.js aplica la cola por fotograma (8 parches, 24 objetos, 4 assets),
   coloca al avatar en el punto de aparición y llama a onReady → la interfaz
   dice "en la región".
```

Mientras el enlace esté caído, `session.js` marca `loginSent = false` y vuelve
a presentarse al reconectar; el gateway **no** debe volver a mandar la región
entera sin que se la pidan (ver §8, "reentrada").

## 4. Los tres modos de entrada y la contraseña

| Modo | Quién hace el login | Qué le llega al gateway | Cuándo usarlo |
|---|---|---|---|
| `session` | este visor (`login.js` + `superFetch`) | `agentId`, `sessionId`, `secureSessionId`, `circuitCode`, `simIp`, `simPort`, `regionX/Y`, `seedCapability` | el gateway está en una máquina de terceros: **la contraseña no sale del navegador** |
| `credentials` | el gateway | usuario y contraseña en claro (por WSS) | gateway de confianza; sirve también para `token` (MFA) |
| `mock` | nadie | nada | probar el visor sin red ni cuenta |

Notas de seguridad, que están implementadas tal cual:

- En `session`, la contraseña solo se usa para calcular
  `"$1$" + MD5(contraseña)` (`src/sl/md5.js`), que es exactamente lo que manda
  cualquier visor de SL. El hash vive en una variable local y no se guarda en
  ningún sitio (`localStorage`, `kv`, URL o log).
- Los secretos de sesión (`sessionId`, `secureSessionId`) van **solo** al
  gateway, que los necesita para el `UseCircuitCode`. No se pintan en el HUD.
- El campo «Retransmisor» se persiste en `kv` (grid, nombre y URL), nunca la
  contraseña ni el token.
- `startPanel.js` **rechaza** una URL de retransmisor que no sea `wss://`
  (o `ws://` si la página va por http): una dirección imposible solo dejaría la
  interfaz girando para siempre. `relay.connect` avisa y no reintenta.

## 5. Qué NO puede hacer el navegador (y por eso lo hace el gateway)

- Abrir el circuito UDP: handshake, acks, resentidos, cifrado XOR.
- Leer las capabilities (EventQueueGet y los `GetTexture`/`GetMesh` por HTTP).
- Decodificar **J2C** (JPEG 2000), el formato de textura de SL (§9).

Todo lo demás lo hace el visor: teselar prims (`llvolume.js`), física, cámara,
construcción, LSL, terreno, apariencia. Del mundo real solo viajan
**parámetros**, igual que en el multijugador.

## 6. Referencia del protocolo

El protocolo es de `src/sl/relay.js`: **una trama = un mensaje de WebSocket**,
`[u8 tipo][cuerpo…]`, little-endian (`src/sl/bin.js`). Los cuerpos con campos
variables se mandan como JSON con la longitud delante, para poder ampliarlo sin
romper clientes viejos. `PROTOCOL = 1`.

### 6.1 Navegador → retransmisor (`C.*`)

| Trama | Cuerpo | Equivalente en SL |
|---|---|---|
| `C.HELLO` `0x01` | `{protocol, client, version, capabilities[]}` | apertura del circuito + `RegionHandshakeReply` |
| `C.LOGIN` `0x02` | `{mode:"session"\|"credentials", …}` | `login_to_simulator` (XML-RPC) / `UseCircuitCode` |
| `C.CHAT` `0x03` | `kind u8, canal i16, texto` | `ChatFromViewer` |
| `C.MOVE` `0x04` | `pos f32×3, giro f32, banderas u8` | `AgentUpdate` |
| `C.INTERACT` `0x05` | `accion u8, uuid` | `ObjectGrab` (el sim lo interpreta como toque) |
| `C.TELEPORT` `0x06` | `region(str) + pos f32×3` | `TeleportLocationRequest` + eventos de la EventQueue |
| `C.REQUEST` `0x07` | `que u8 (RES), id (uuid o nombre)` | `TransferRequest` / `GetTexture` / `GetMesh` |
| `C.PING` `0x08` | `t f64` | `StartPingCheck` / `CompletePingCheck` |
| `C.LOGOUT` `0x09` | — | `LogoutRequest` |
| `C.OBJECT_EDIT` `0x0a` | `uuid + json {position, quaternion, scale, delete, …}` | `MultipleObjectUpdate` / `ObjectDelete` / `ObjectDuplicate` / `ObjectLink` |
| `C.PARCEL_EDIT` `0x0b` | `json {name, desc, flags, …}` | `ParcelPropertiesUpdate` |
| `C.INVENTORY` `0x0c` | `que u8 (0=raíz,1=carpeta,2=crear,3=borrar), uuid, json` | capabilities de inventario (`FetchInventoryDescendents2`, …) |
| `C.GROUP_IM` `0x0d` | `uuid + texto` | `ImprovedInstantMessage` |

`RES = {TEXTURE:0, MESH:1, ANIM:2, SOUND:3, NOTECARD:4, INVENTORY:5}`.

### 6.2 Retransmisor → navegador (`S.*`)

| Trama | Cuerpo | Equivalente en SL |
|---|---|---|
| `S.WELCOME` `0x81` | `{protocol, region, regionHandle, …}` | `RegionHandshake` + `AgentMovementComplete` |
| `S.STATE` `0x82` | `estado u8 (PHASE), progreso u8, texto` | (narración del gateway) |
| `S.ERROR` `0x83` | `gravedad u8, codigo, texto` | `AgentAlertMessage` / `AlertMessage` / errores de conexión |
| `S.TERRAIN` `0x84` | `parche (px u8, py u8) + 16×16 f32` | `LayerData` (y `LandLayer` por HTTP) |
| `S.OBJECT` `0x85` | `uuid + padre uuid + json del registro` | `ObjectUpdate` / `ObjectUpdateCompressed` |
| `S.OBJECT_UPDATE` `0x86` | `uuid + json parcial` | `ObjectUpdate` (transformada) / `ImprovedTerseObjectUpdate` |
| `S.OBJECT_REMOVE` `0x87` | `uuid` | `KillObject` |
| `S.AVATAR` `0x88` | `uuid + json` | `AvatarAppearance` / `ObjectUpdate` de avatar |
| `S.AVATAR_UPDATE` `0x89` | `uuid + pos f32×3 + rot f32×4 + banderas u8` (bit0 vuela, bit1 escribe) | `ImprovedTerseObjectUpdate` |
| `S.AVATAR_REMOVE` `0x8a` | `uuid` | `KillObject` / logout del agente |
| `S.CHAT` `0x8b` | `de uuid + nombre + tipo u8 + canal i16 + pos f32×3 + texto` | `ChatFromSimulator` |
| `S.ASSET` `0x8c` | `uuid + clase u8 (+ ancho/alto si RGBA8) + bytes` (`putAsset`) | `TransferInfo`/`TransferPacket` o `GetTexture` por caps |
| `S.PARCEL` `0x8f` | `json` | `ParcelProperties` |
| `S.PONG` `0x90` | `t del cliente f64 + t del servidor f64` | (latido propio; en SL, `CompletePingCheck`) |
| `S.STATS` `0x91` | `json {pingMs, packetLoss, kbIn, kbOut, simFps}` | `SimStats` / `RegionInfo` |
| `S.INVENTORY` `0x92` | `json` | capabilities de inventario |
| `S.CAPS` `0x93` | `json {nombre: url}` | `seed_capability` + las URLs de las caps |
| `S.OBJECTS_BEGIN` `0x94` | `cuantos u32` | (lote del gateway: cuántos `S.OBJECT` vienen) |
| `S.OBJECTS_END` `0x95` | `total u32` | (fin del lote) |
| `S.REGION_INFO` `0x96` | `json {parcela, agua, tamaño, versión del sim, spawn}` | `RegionInfo` / `SimulatorViewerTimeMessage` / `ParcelProperties` |

`ASSET_FORMAT = {J2C:0, JPEG:1, PNG:2, RGBA8:3, LLMESH:4, TEXT:5, OGG:6}`.

`PHASE = {IDLE:0, HANDSHAKE:1, LOGIN_REQUEST:2, ENTERING:3, READY:4,
TELEPORT:5, DISCONNECTED:6}` — los textos en castellano están en `PHASE_TEXT`.

## 7. Qué tiene que hacer el retransmisor de verdad (lista de trabajo)

> Cumplida salvo los puntos 3 (capabilities) y 7 (assets/J2C), que son los que
> quedan pendientes. El resto está en `src/sl/lludp/gateway.js`.

1. **Circuito LLUDP.** Abrir un socket UDP al `sim_ip:sim_port`, mandar
   `UseCircuitCode(circuit_code, session_id, agent_id)`, esperar
   `RegionHandshake`, contestar `RegionHandshakeReply`, y mantener el reloj de
   acks/resentidos y la numeración de secuencia (cifrado XOR incluido).
2. **Entrada.** `CompleteAgentMovement` con la posición inicial, luego
   `AgentUpdate` a 1 Hz como mínimo (y al moverse).
3. **Capabilities.** Seguir `seed_capability`, abrir `EventQueueGet` (cola
   larga, ~40 s de timeout en SL) y anotar las URLs de `GetTexture`,
   `GetMesh`, `FetchInventory…`, `ParcelPropertiesUpdate`, etc.
4. **Terreno.** Reenviar `LayerData` tal cual (16×16 parches de 16×16 alturas) y
   `S.REGION_INFO` con el `waterLevel` **después** del terreno.
5. **Objetos y avatares.** Traducir `ObjectUpdate*` al registro JSON de
   `S.OBJECT` (forma, `PrimParams`, transformada, color, caras/texturas,
   `parent` para link sets), `KillObject` a `S.OBJECT_REMOVE`, y las
   actualizaciones tersas a `S.OBJECT_UPDATE`/`S.AVATAR_UPDATE`.
6. **Chat.** `ChatFromSimulator` → `S.CHAT` con su canal y su tipo.
7. **Texturas.** Servir `S.ASSET` a petición (o transcodificar, §9). El
   navegador pide con `C.REQUEST`; el gateway responde con `S.ASSET`.
8. **Parcelas e inventario.** `ParcelProperties` → `S.PARCEL`; inventario por
   caps → `S.INVENTORY`.
9. **Edición.** Traducir `C.OBJECT_EDIT`/`C.PARCEL_EDIT`/`C.INVENTORY`/
   `C.GROUP_IM` a sus mensajes reales (ver §6.1).
10. **Latido y reconexión.** Contestar `S.PONG`; cerrar con `S.ERROR` y
    gravedad cuando el sim cae. Nunca reenviar la región entera sin que el
    navegador vuelva a presentarse (`C.LOGIN`).

La referencia exacta de cada mensaje y de cada campo está en el código del
simulador de pruebas (`src/sl/mockServer.js`): **es la especificación
ejecutable del lado servidor**. Y en `Hippolyzer`/`rustmetaverse` están las
definiciones LLUDP reales.

## 8. Cosas que ya costaron un dolor de cabeza (no volver a romperlas)

Estos son bugs reales encontrados al construir la versión de pruebas. El
gateway de verdad tiene que respetar las mismas reglas:

- **Reentrada / reconexión.** Si el gateway reacciona a cada cambio de estado
  del enlace reenviando la región, el navegador recibe el terreno cientos de
  veces y la cola se dispara (se midió una cola de **873 000** parches que
  dejaba la entrada colgada en la fase 3). El navegador solo manda `C.LOGIN`
  **una vez por conexión** (`loginSent` en `session.js`), y el mock solo manda
  la región una vez (`regionSent`).
- **`S.REGION_INFO` llega después del terreno.** Si al recibirlo el visor
  volviese a entrar en "modo exterior", rellenaría las alturas con una base
  plana y borraría los parches (el mundo salía flotando sobre una llanura). Por
  eso `session.js` solo cambia el nivel del agua si aún no estaba en exterior,
  y el terreno exterior se activa una sola vez al conectar.
- **La rejilla de destino no siempre es 1 m/vértice.** En móvil la malla se
  construye con menos celdas (2 m/vértice), así que un parche no se puede
  mapear muestra-a-vértice. `Terrain.applyPatch` recorre el parche **en metros**
  y muestrea la altura que toca en cada vértice; acepta parches de 16×16 o
  17×17 (la fila 17 es la del parche vecino) y cualquier resolución.

## 9. Las texturas J2C (JPEG 2000)

Segundo Life guarda las texturas como **J2C** (JPEG 2000), que ningún navegador
decodifica de forma nativa. `session.onAsset` hoy entiende:

- `ASSET_FORMAT.RGBA8` — píxeles crudos (lo que manda el simulador de pruebas).
- `ASSET_FORMAT.PNG` / `JPEG` — los decodifica el propio navegador.
- Cualquier otra cosa (incluido `J2C`) — se avisa por consola y la cara se
  queda con su patrón procedural.

Opciones cuando se escriba el gateway:

1. **Decodificador en el navegador.** Un decodificador J2C en WASM (por
   ejemplo OpenJPEG compilado a wasm) pedido en diferido solo si aparece un
   asset J2C. Es la opción que mantiene al gateway tonto (solo reenvía bytes).
2. **Transcodificar en el gateway.** El gateway decodifica el J2C y manda
   `RGBA8` o PNG. Cómodo para el navegador, pero carga la CPU del servidor y
   multiplica el ancho de banda (una textura J2C de 100 KB pasa a cientos de KB
   en crudo).
3. **Híbrido.** `RGBA8` a resolución reducida (una "miniatura") nada más
   entrar, y el J2C completo solo si el usuario se acerca. Es lo que hacen los
   visores de verdad con los niveles de descarga.

El protocolo ya soporta las tres sin cambios: `ASSET_FORMAT` distingue el
formato y `S.ASSET` lleva las dimensiones cuando es `RGBA8`.

## 10. Lo que aún falta en el lado del navegador

El visor ya dibuja y habita la región, pero hay partes de la conversación que
todavía no usa:

- **Editar prims de la región real.** `relay.js` define `C.OBJECT_EDIT`, pero
  `src/build.js` aún no lo manda al gateway (el editor funciona sobre el mundo
  local/multijugador). Falta enganchar el gizmo y los paneles de
  construcción/apariencia al enlace cuando la sesión es real.
- **Parcelas.** `S.PARCEL` se guarda en el estado, pero no hay interfaz de
  parcela (nombre, dueño, flags).
- **Inventario y IM de grupo.** `C.INVENTORY`/`C.GROUP_IM` están definidos y no
  se usan; el inventario de SL es un árbol grande y necesita su propia UI.
- **Animaciones y sonidos.** `RES.ANIM`/`RES.SOUND` están definidos; el avatar
  aún no reproduce animaciones reales ni suena.
- **Avatares de verdad.** Hoy los residentes remotos son el avatar procedural de
  `src/avatar.js`/`src/peers.js`; no se aplican mallas de avatar ni accesorios
  (adjuntos). El camino está en la §12.
- **Sincronizar el terreno esculpido** con la región real (hoy el esculpido es
  local al visor). Igual que en el multijugador, viaja en la instantánea.

## 11. Cómo probarlo hoy

Tres caminos, de menos a más real:

1. **Simulador de pruebas** (`mockServer.js`): en la pantalla de arranque (`#sl`)
   pulsa «Simulador de pruebas». Región «Bahía de Pruebas», servida por el propio
   navegador. No es Second Life, pero habla el protocolo exacto.
2. **Núcleo LLUDP contra un simulador de región en JS**: añade `?udp=sim` a la
   URL (p. ej. `?udp=sim#sl`). El visor habla LLUDP **de verdad** (plantillas,
   circuito, DCT de terreno, `ObjectUpdate`, `AgentUpdate`, chat, toque) con
   `sim.js`. Es lo que se puede hacer sin móvil, y con lo que se verifica todo.
3. **Second Life real**: en la app Android, `MainActivity` carga el visor con
   `?udp=ws://127.0.0.1:PUERTO#sl` y el puente UDP abre el socket al
   `sim_ip:sim_port` que devolvió el login. Entra con tu cuenta y ya se puede
   andar, chatear y tocar prims.

**Autotests** (sin navegador ni red — desde la consola o un worker):

| Módulo | Entrada | Resultado |
|---|---|---|
| `src/sl/md5.js` | `runMd5SelfTest()` | 6/6 |
| `src/sl/llsd.js` | `runLlsdSelfTest()` | 20/20 |
| `src/sl/login.js` | `runLoginSelfTest()` | 15/15 |
| `src/sl/relay.js` | `runRelaySelfTest()` | 36/36 |
| `src/sl/mockServer.js` | `runMockSelfTest()` | 19/19 |
| `src/sl/lludp/*` | (14 suites, ver `scratch/lludp-runner.js`) | **866/866** |

El núcleo LLUDP se prueba entero sin navegador ni red: plantillas y códec,
circuito (acks, reenvíos, ping), terreno, objetos, avatares, el gateway real
(`runGatewaySelfTest`, 40/40) y su guardia de reconexión
(`runGatewayGuardiaSelfTest`, 15/15: relogin que cierra el circuito viejo, no
declararse «listo» sin paquetes del simulador, aviso de circuito caducado, y no
acusar al simulador antes de haberle mandado el login), el puente UDP y el
simulador de región.

La sesión contra `sim.js` se verificó en el editor: entra en la región en ~2 s,
recibe 256 parches de terreno, decenas de prims y 18 residentes, y el chat, el
toque y el movimiento (AgentUpdate) van y vuelven por el circuito.

## 12. Los avatares reales (cuerpos y cabezas mesh, ropa y animaciones)

Esta sección responde a la pregunta «¿puedo ver *mi* avatar de SL aquí, con mi
cuerpo mesh, mi ropa y mis animaciones?». Hay que separar tres cosas, porque
solo una necesita sesión:

1. **Lo clásico de Linden Lab (sin sesión).** El esqueleto (`avatar_skeleton.xml`),
   las mallas del cuerpo y la cabeza de *sistema* (`avatar_head.llm`,
   `avatar_upper_body.llm`, …) y sus texturas base (`head_skingrain.tga`,
   `head_hair.tga`, …) están en el repositorio público del visor
   (`github.com/secondlife/viewer`, LGPL) y los sirve GitHub por HTTPS. El visor
   los **descarga en tiempo de ejecución** (`sl/characterAssets.js`) y dibuja con
   ellos el avatar de sistema entero, con su piel, sus cejas, sus labios, su pelo
   y sus ojos. Esto ya funciona **hoy, sin cuenta y sin retransmisor**
   (`#bodytest`).
2. **Ficheros que aporta el usuario (sin sesión).** Una malla `.llm` (LLMESH), una
   animación `.anim` (LLKeyframeMotion) o una malla `.glb`/`.gltf`/`.obj`
   riggeada a los huesos de SL se leen y se montan sobre el mismo esqueleto
   (`#meshtest`). Si el usuario tiene en su disco el cuerpo o la cabeza mesh que
   compró (o una animación suya), funciona aquí sin más.
3. **Los activos DE LA CUENTA (necesitan sesión).** El **inventario**, las mallas
   y animaciones que el usuario compró, las **texturas cocidas** (*bakes*) de su
   cara y su ropa, y la apariencia de los demás residentes viven detrás de las
   *capabilities* de la región: solo se pueden pedir con una sesión autenticada,
   y el navegador no puede abrir el circuito LLUDP ni leer esas capabilities sin
   CORS. Ese es el único camino que exige el retransmisor de la §1.

Lo que **no** se hace nunca es copiar activos de SL al generador: el generador
solo lleva **código**; los activos se piden y se dibujan para la sesión del
usuario, o se leen de un fichero que él aporte.

### 12.1 Qué habla con qué

Nada de esto necesita un formato nuevo: todo cuelga del **esqueleto**, y ese es
el mismo para todas las piezas.

| Pieza de SL | Qué es | Quién la decodifica |
|---|---|---|
| `avatar_skeleton.xml` | los 133 huesos con sus nombres | `src/sl/skeleton.js` (hecho, 32/32) |
| cuerpo de sistema (`LLMESH` interno) | `avatar_head.llm`, `avatar_upper_body.llm`… | `src/sl/bodyMesh.js` (hecho, 34/34) |
| `LLMESH` (`.llm`) | cuerpo, cabeza, ropa, pelo, accesorios | `src/sl/llmesh.js` (hecho, 24/24) |
| `LLKeyframeMotion` (`.anim`) | las animaciones del inventario | `src/sl/anim.js` (hecho, 41/41) |
| `AvatarAppearance` | parámetros visuales, bakes, adjuntos | `src/sl/avatarMesh.js` (hecho para montar; falta recibirlo, §12.2) |
| mallas de fuera | `.glb`/`.gltf`/`.obj` riggeados al esqueleto | `src/sl/meshImport.js` (hecho, 17/17) |
| texturas base del cuerpo | TGA del repositorio del visor | `src/sl/tga.js` + `skinTexture.js` (hecho, 15/15 y 24/24) |
| texturas (J2C) | piel, ropa, cara de la cuenta | §9 |

- **Los pesos de piel traen los nombres.** Un `LLMeshSkinInfo` de una malla mesh
  (por ejemplo una cabeza Lelutka) lleva la lista de nombres de hueso y las
  matrices inversas de enlace. No hay que adivinar nada: se busca cada nombre en
  `SL_JOINT_INDEX` y se ata la malla al hueso correspondiente. El mismo índice de
  hueso sirve para todas las piezas, así que cuerpo, cabeza y ropa se deforman
  juntos.
- **Las animaciones traen rotaciones por nombre de hueso**, con prioridad y
  bucle. Se aplican sobre la pose de reposo del esqueleto y se mezclan por
  prioridad, que es como SL resuelve «andar» + «saludar» a la vez.
- **Los adjuntos van colgados de un hueso.** Cada adjunto tiene un punto de
  anclaje (`ATTACH_*`) que corresponde a una articulación; dibujarlo es colgar
  su registro de objeto (los mismos `PrimParams` de siempre) de ese hueso, con
  la escala y el desplazamiento del punto.
- **Las texturas del cuerpo son *bakes*.** El visor de SL compone las capas
  (piel, tatuajes, ropa) y sube el resultado «cocido» al simulador; el
  `AvatarAppearance` de cada residente trae entonces el uuid de sus bakes. Basta
  con pedirlos como cualquier textura: lo que se ve es lo que el residente lleva
  puesto de verdad, sin tener que componer nada. Componer los bakes *en este
  visor* (para editar la apariencia local) es un paso posterior.

### 12.2 Lo que tiene que añadir el gateway

Dos cosas, y las dos son reenviar bytes:

1. **Pedir activos por uuid** a las capabilities (`GetMesh`, `GetTexture`) o por
   `TransferRequest`, y mandarlos con `S.ASSET` con su clase (`RES.MESH`,
   `RES.ANIM`, `RES.TEXTURE`). `ASSET_FORMAT.LLMESH` y `RES.ANIM` ya están
   definidos en `relay.js`, así que el protocolo no cambia.
2. **Traducir `AvatarAppearance`** (que ya llega por LLUDP junto al avatar) al
   JSON de `S.AVATAR`: parámetros visuales, uuids de los bakes, lista de
   adjuntos (punto de anclaje + uuid de cada objeto) y, si el gateway quiere
   ahorrarle trabajo al navegador, los uuids de las mallas del cuerpo de sistema.

Todo lo demás (teselar, atar la malla al esqueleto, animar, mezclar) es trabajo
del navegador y no necesita nada más de la red.

### 12.3 Orden de trabajo

1. `src/sl/skeleton.js` — **hecho** (32/32): es la base y ya está verificada
   contra la pose de reposo.
2. `src/sl/llmesh.js` — **hecho** (24/24): `.llm` con autotest (contenedor,
   submeshes, `SkinInfo`) y `buildSkinnedMesh` para three.js.
3. `src/sl/anim.js` — **hecho** (41/41): `.anim` con autotest, `Animator` que
   mezcla por prioridad y reproducción sobre el esqueleto.
4. `src/sl/bodyMesh.js` + `src/sl/avatarMesh.js` + `src/sl/attachments.js` —
   **hecho** (34/34, 22/22, 21/21): el cuerpo de sistema, las mallas adjuntas,
   los puntos de anclaje y los morphs; `#bodytest` lo dibuja entero con las
   texturas reales (`tga.js` + `skinTexture.js`, 15/15 y 24/24).
5. `src/sl/meshImport.js` + `src/meshGallery.js` — **hecho** (17/17): una malla
   de fuera (`.glb`/`.gltf`/`.obj`), un `.llm` y un `.anim` que el usuario
   aporte se montan sobre el esqueleto en `#meshtest`, con diagnóstico de
   emparejado y alineación. Verificado con `vision` y numéricamente (133/133
   huesos, 0 mm).
6. **Forma real del avatar — hecho** (`slAppearance.js` + `avatarLad.js` +
   `avatarRealBody.js`): los parámetros de `avatar_lad.xml` se resuelven sobre
   el cuerpo de sistema y el esqueleto, así que el avatar se deforma igual que
   en SL. El **sexo se deriva del mando de género** (id 80), como el visor
   oficial. Cubre **mesh legacy**, **Bakes-on-Mesh** (`setBake` por slot) y
   **Bento** (133 huesos + parámetros de Bento). Editor en el cajón Forma del
   HUD y en `#bodytest/forma`.
7. **El modelo dentro del APK — hecho** (`fetch-character-assets.mjs` +
   `characterAssets.js`): el cuerpo de sistema real se empaqueta en los assets
   al compilar y se prefiere al espejo de red, así que la deformación funciona
   sin conexión.
8. **Falta (navegador):** usar el avatar real en `#viewer` en vez del procedural,
   y las animaciones de los residentes remotos (`S.AVATAR` + `RES.ANIM`).
9. **Falta (navegador):** `llStartAnimation`/`llStopAnimation` en el mini-LSL.
10. **Falta (cuenta):** el retransmisor de la §7 es lo único que trae los activos
    *de la cuenta* (inventario, mallas y animaciones compradas, bakes). Todo lo
    anterior funciona sin él: los activos clásicos son públicos y los demás los
    aporta el usuario.
