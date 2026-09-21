# TODO — Visor SL

Ordenado por impacto. Lo primero es lo que hay que hacer en cuanto se pruebe con
una cuenta real en el grid.

## 0. Primera conexión real (comprobaciones)

**Última prueba real (cuenta ExeQiel, APK `app-release.apk`):** el login XML-RPC
funcionó (sesión iniciada, circuito 712942918) y el fallo estaba justo después:
el visor se quedaba en «Abriendo circuito UDP con 54.190.153.220:13005…» y
terminaba en «Desconectado.».

Causas ya corregidas en esta revisión:

- **`udpOpen` colgado (la causa del fallo).** `nativeCall()` mandaba al puente
  nativo un `id` que el llamador usaba a la vez como clave del socket, de modo que
  la respuesta de `udpOpen` volvía con otro identificador y **nunca** se
  emparejaba: 15-18 s de espera y desconexión. Ahora `id` (identifica la llamada)
  y `chan` (identifica el socket UDP) son campos distintos en los dos lados.
- **Capacidades ilegibles** («Capacidades: 6 (0, 1, 2, 3, 4, 5…)»): la respuesta
  del seed capability se parseaba como texto. Ahora se le pasan los bytes a
  `LLSD.parse` (detecta XML, notación o LLSD binario, ignora el BOM) y, si aun así
  no sale un mapa, el registro muestra el estado HTTP y el principio del cuerpo.
- **Los errores no quedaban en el registro**: el motivo sólo se veía en el modal
  (no copiable). Ahora todo error va al registro con ⚠ y el botón ⧉ copia el
  texto con saltos de línea reales.

Pendiente de comprobar en el grid real:

- [ ] **Login XML-RPC**: confirmar que `login.agni.lindenlife…` (ver `GRIDS` en
      `sl-session.js`) acepta el struct enviado (canal/versión/mac/options). El
      motivo exacto del servidor ya aparece en el registro del HUD.
- [ ] **MFA**: si la cuenta tiene verificación en dos pasos, comprobar el flujo
      `mfa_challenge` → código de 6 dígitos → `mfa_hash` recordado.
- [ ] **`sim_ip`/`sim_port`**: comprobar que `openCircuit` abre el socket y que
      llega el RegionHandshake. Si el socket abre pero no contesta nadie, el
      diagnóstico automático dirá si el problema es la red (STUN tampoco
      responde → probar datos móviles u otra wifi) o nuestro paquete.
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
