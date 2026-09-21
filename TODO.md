# TODO — Visor SL

Ordenado por impacto. Lo primero es lo que hay que hacer en cuanto se pruebe con
una cuenta real en el grid.

## 0. Primera conexión real (comprobaciones)

**Estado tras la 2ª prueba real (cuenta ExeQiel, circuito 712948182, Xiaomi API 36):**
el login funciona y el **circuito UDP vive** (el simulador manda `PacketAck` y
`StartPingCheck`, y contesta a nuestros pings). No llegaba el mundo, y ya se sabe
por qué.

Corregido en esta revisión:

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

- [ ] Decodificador **JPEG2000** real. `j2c.js` intenta cargar
      `@cornerstonejs/codec-openjpeg` desde esm.sh; hay que comprobar que carga
      y que la API (`J2KDecoder`, `getEncodedBuffer`, `getDecodedBuffer`,
      `getFrameInfo`) es la esperada. Alternativas: vendorizar el `jpx.js` de
      pdf.js (JS puro, ~90 KB) o compilar openjpeg a wasm y subirlo con
      `upload_file` (dejando la receta de compilación en un comentario).
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
