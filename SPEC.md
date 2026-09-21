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
- **Sin WorkManager / sin dependencias pesadas de Android**: sólo
  `androidx.webkit` para servir los assets por `WebViewAssetLoader`
  (origen `https://appassets.androidplatform.net/`), lo que permite usar
  módulos ES, `fetch` y service workers sin restricciones de `file://`.

## Requisitos de entrega

- `visor-sl-app.zip` (proyecto Gradle completo + visor web + workflow).
- `subir-a-github-y-compilar.bat` (subida automática + disparo del APK).
- `src/` con las fuentes reales del visor (carpeta de trabajo del agente).
- Documentación: `README.md`, `SPEC.md` (este), `TODO.md`, `LUMIYA.md`.
