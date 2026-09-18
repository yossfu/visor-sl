# Visor SL autónomo: la app Android (APK)

Este documento responde a dos preguntas del usuario:

1. «Quiero que la app sea autónoma, sin depender de un puente externo.»
2. «¿Podemos preparar el proyecto para compilarlo en un APK Android y usar así el
   UDP que hace falta?»

La respuesta corta es **sí a las dos**, y la forma correcta de conseguirlo es una
**app nativa Android**. Aquí está el porqué, la arquitectura y el plan.

---

## 1. Por qué hace falta nativo (y por qué el «puente» desaparece)

El navegador no puede abrir un socket UDP, y los simuladores de Second Life
hablan **LLUDP** (UDP en crudo). Eso no cambia. Lo que cambia es *dónde* vive la
pieza que sí puede: si esa pieza va **dentro de la misma app**, deja de ser un
puente externo y pasa a ser parte del programa.

```
   HOY (navegador)                        OBJETIVO (una sola app Android)
   ┌───────────────┐   WebSocket        ┌──────────────────────────────────┐
   │ visor JS      │──────► puente ──────►  ┌──────────────┐  ┌───────────┐  │
   │ (perchance)   │        (2º proceso)   │ WebView      │  │ núcleo    │  │
   └───────────────┘                       │ (visor JS)   │◄►│ nativo    │──┼──UDP──► sim
                                           └──────────────┘  │ (LLUDP)   │  │
                                              mismo proceso  └───────────┘  │
                                           └──────────────────────────────────┘
                                              UNA app, un icono, nada más
```

Dentro de la app, el visor JS y el núcleo nativo se hablan por un **WebSocket en
`127.0.0.1`**, con **el mismo protocolo que ya está escrito en
`src/sl/relay.js`**. Es decir: **el visor JS no cambia ni una línea.** Ya tiene
`session.js` y `startPanel.js` hablando ese protocolo; en la app, en vez de
apuntar a un retransmisor remoto, se apunta a `ws://127.0.0.1:<puerto>`.

Ventajas:

- Un solo APK, un solo icono: se acabó «dos apps abiertas».
- El visor (render, prims, terreno, avatar, LSL, apariencia) se reutiliza tal
  cual, y es la parte que **ya está verificada**.
- El núcleo nativo solo tiene que hacer lo que el navegador no puede: el
  circuito LLUDP y las *capabilities*.

## 2. De dónde sale el núcleo nativo (no empezamos de cero)

No hay que escribir un cliente LLUDP desde cero. **Linkpoint**
(`github.com/Kaleaon/Linkpoint`, Kotlin, licencia MIT) es un visor de SL para
Android y su parte de red **funciona**:

| Pieza de Linkpoint | Estado según su README | Lo que nos interesa |
|---|---|---|
| Login / conexión | funciona | `protocol/auth`, `protocol/circuit` |
| Circuito UDP | funciona | `protocol/messages/UDPConnectionFixed.kt`, `transport/nio/UdpDatagramTransport.kt` |
| Capabilities | funciona (12) | `protocol/capabilities/CapabilityManager.kt` |
| Event Queue | funciona (18 handlers) | `protocol/caps/CapEventQueue.kt` |
| LLSD | funciona | `protocol/llsd/*` (parser + streaming) |
| Terreno | — | `protocol/terrain/LayerDataParser.kt` |
| Transferencia de assets | — | `protocol/transfer/{TransferManager,XferManager}.kt` |
| Inventario / texturas / mensajes | — | `protocol/messages/ids/MessageIdRegistry.kt` (112 KB de plantillas), `MessageParser.kt` |
| **Render 3D** | **roto** (Filament, «swap chain issues») | **lo nuestro**: nuestro visor JS |
| **Carga de mundo** | **a medias** | **lo nuestro**: `world.js`, `region.js` |

Fíjate en lo importante: **lo que a Linkpoint le falta es justo lo que nosotros
ya tenemos resuelto** (el render y la carga de mundo en el visor JS), y **lo que
a nosotros nos falta es justo lo que Linkpoint ya tiene** (el circuito LLUDP y
las caps). Son complementarios. El camino más corto es casarlos:

- **Nuestro**: `index.html` + `src/*.js` → dentro de un `WebView`.
- **De Linkpoint**: el paquete `com.linkpoint.protocol` → adaptado a un módulo
  Kotlin propio que implementa el lado *retransmisor* del protocolo de
  `relay.js` (no el suyo).

Linkpoint también trae referencia útil: `Linkpoint/src/main/assets/mesh/avatar.bin`
y shaders de malla riggeada, `avatar/BakesOnMesh.kt`, `avatar/LLMeshLoader.kt`
(la misma familia de cosas que ya hicimos en `sl/llmesh.js` y
`sl/avatarMesh.js`, esta vez en Kotlin).

## 3. Arquitectura concreta de la app

```
android/
  app/
    src/main/
      AndroidManifest.xml            (INTERNET + un solo Activity)
      java/org/visor/sl/
        MainActivity.kt              (WebView + arranque + ciclo de vida)
        ViewerServer.kt              (sirve el visor por http://127.0.0.1:PORT)
        RelayServer.kt               (WebSocket local, el enlace interno)
        FrameCodec.kt                (formato binario de las tramas del enlace)
        VisorDiag.kt                 (puente de DEPURACIÓN E INFORMES)
      assets/viewer/                 (EL VISOR: index.html + env.js + src/**)
      assets/viewer/character/       (el MODELO real de SL, lo mete el build)
  build.gradle.kts / settings.gradle.kts / gradle.properties
build-viewer.mjs                     (mete el visor en los assets)
fetch-character-assets.mjs           (mete el cuerpo real de SL en los assets)
prepare-repo.mjs                     (arma la carpeta lista para subir a GitHub)
```

Tres detalles técnicos que importan:

1. **El visor se sirve por HTTP local, no por `file://`.** Los módulos ES y los
   `fetch("src/...")` no funcionan bien en `file://`; un servidor diminuto en
   `127.0.0.1` lo resuelve y además da un ORIGEN estable para el
   `localStorage`/IndexedDB del visor.
2. **El WebSocket es `127.0.0.1`**, así que no necesita `wss://` ni certificados.
3. **Un solo permiso**: `INTERNET` (y el socket UDP no pide permisos extra en
   Android).
4. **La salida a internet pasa por un puente** (`/proxy?url=…` en
   `ViewerServer.kt`). El WebView aplica CORS igual que Chrome y los servidores
   de Second Life no mandan cabeceras CORS: un `fetch` directo a
   `login.agni.lindenlab.com` responde bien a curl pero el navegador descarta la
   respuesta, y el visor solo ve un «Failed to fetch». El puente se pide a un
   camino del **mismo origen** que la página y la petición de verdad la hace
   Kotlin, que no está sujeto a CORS. Es el equivalente local de `superFetch`:
   `env.js` enruta por ahí todo lo que sale del aparato y deja directo lo de casa
   (los `src/`, `character/`, el enlace con el núcleo nativo).

El visor JS detecta que corre dentro de la app (`env.js` deja `window.__SL_APP__`
y rellena `window.root`) y se conecta solo a `ws://127.0.0.1:PORT`, sin pantalla
de arranque ni URL que escribir.

### El modelo del avatar va dentro del APK

Para que el avatar se deforme «como en Second Life» hacen falta las mallas y
texturas **reales** del cuerpo de sistema. `fetch-character-assets.mjs` las baja
al compilar (del repositorio público del visor de Linden Lab, LGPL) a
`assets/viewer/character/`; `characterAssets.js` prefiere ese espejo local
(`character/`) antes que la red, así que la forma funciona **sin conexión**. Si
la descarga falla, el paso no rompe la compilación y el visor las pide por red en
tiempo de ejecución. Los ficheros no se suben al repositorio (están en
`.gitignore`): el repositorio guarda el script, no los activos.

### Depuración e informes

`VisorDiag.kt` expone `window.VisorDiag` al WebView: los informes del visor
(`src/diag.js`) se escriben en `Android/data/org.visor.sl/files/informes/` (sin
permisos de almacenamiento) y se comparten por texto, y un **registro nativo**
(arranque de servidores, pings del enlace, 404) viaja dentro del propio informe.
Todo el detalle en [`DIAGNOSTICS.md`](DIAGNOSTICS.md).

## 4. Cómo se obtiene el APK

Yo **no puedo compilar un APK desde este editor** (no hay Android SDK, Java ni
Gradle aquí; el generador de Perchance es una página web). El código sí lo puedo
escribir entero. Para convertirlo en APK hay dos caminos, y los dos son gratis:

- **Android Studio** (recomendado para probar rápido): abrir el proyecto y
  `./gradlew assembleDebug`, luego `adb install -r app/build/outputs/apk/debug/…`.
  Requisitos: Android Studio, JDK 17, SDK 34.
- **GitHub Actions** (sin ordenador potente): el proyecto incluye un workflow que
  compila el APK en la nube en cada push y lo deja como *artifact* descargable.
  Solo hace falta una cuenta de GitHub (gratis).

## 5. Fases (cada una es un APK que se puede instalar y probar)

> **Estado**: la Fase 1 esta escrita y lista en `src/android/` (es el proyecto
> Android completo: Gradle, manifiesto, `MainActivity`, `ViewerServer`,
> `RelayServer`, `FrameCodec`, `VisorDiag`, `env.js`, el script `build-viewer.mjs`
> que mete el visor en los assets y `fetch-character-assets.mjs` que mete el
> modelo real del avatar). Incluye ya la **depuración e informes** y el **modelo
> dentro del APK**. Falta subirlo a GitHub y compilarlo. Las fases 2-6 aun no
> estan.

1. **Esqueleto**: APK que abre, sirve el visor y arranca el modo simulador de
   pruebas (`mockServer.js`) contra el WebSocket local. Verifica que el empaquetado
   y el puente funcionan sin red. Incluye el **modelo real del avatar** dentro
   del APK y la **depuración e informes** (para poder traer un informe de vuelta
   desde el primer día).
2. **Login real**: trasladar `protocol/auth` + `protocol/circuit` de Linkpoint;
   entrar en la cuadrícula y abrir el circuito UDP.
3. **Mundo**: caps + EventQueueGet + terreno + objetos + avatares → el visor los
   pinta (aquí ganamos a Linkpoint, que se quedó atascado justo aquí).
4. **Assets**: transferencias de texturas/mallas (J2C incluido) + inventario.
5. **Avatar de la cuenta**: `AvatarAppearance` + bakes + adjuntos + animaciones
   reales (lo que el usuario pidió desde el principio).
6. **Pulido**: chat, IM, teletransporte, parcelas, edición, ajustes de rendimiento.

## 6. Límites honestos

- El APK hay que **compilarlo y probarlo en un dispositivo**; eso ocurre en la
  máquina del usuario o en CI, no en este editor.
- Es un proyecto **grande** (semanas, no horas). La buena noticia es que las dos
  mitades difíciles ya existen y son complementarias.
- Todo visor de SL debe cumplir la **Política de Visores de Terceros de Linden
  Lab** (identificarse como visor de terceros). Está previsto en el arranque.
- Las credenciales se piden en tiempo de ejecución y **nunca** se guardan ni se
  suben a ningún sitio.
