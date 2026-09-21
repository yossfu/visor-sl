# Especificación — Visor SL

Resumen de lo que el usuario pidió, para que ninguna sesión futura lo pierda.
Última actualización: ronda de implementación del protocolo SL.

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
| 5. Paridad con Lumiya | terreno, prims (forma + textura, **arreglado el bloque comprimido**), **avatar real con forma, texturas y animaciones**: hechos. Ropa del inventario: la puesta se ve (bake del simulador); cambiar de ropa necesita inventario y transferencias → siguiente hito. Falta: sculpt/mallas, inventario, grupos, búsqueda, minimapa, voz |
| 6. Controles tipo Genshin | **hecho**: joystick izquierdo, cámara por arrastre en la mitad derecha, botones de saltar/volar/correr/sentar, doble toque para saltar y stick a tope = correr |
| 7. Investigación exhaustiva | **hecho y documentado** en `LUMIYA.md`: formatos de red verificados contra el código decompilado de Lumiya y contra el visor oficial de Linden (`ObjectUpdateCompressed`, ExtraParams, `AnimationData`, `SLSkeletonBone`/`getPelvisToFoot`, `LLPolySkeletalDistortion`) |
| 8. Avisos del informe 4 | **hecho**: `KillObject` ya no falla (bloque `Variable` truncado por los *acks adjuntos* → ahora se recorta a lo que cabe); 70/70 pruebas del protocolo |

