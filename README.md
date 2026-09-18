# Visor SL (Android)

Una app Android que lleva dentro el visor de Second Life del proyecto: una
`WebView` a pantalla completa con el visor web, un servidor local que le sirve
los archivos, un **puente UDP** que abre el socket que el navegador no puede
abrir, y el panel de depuración e informes. Un solo APK, un solo icono, **sin
retransmisor externo ni ninguna otra app**.

## Que hace esta version

- Arranca el visor web completo: render de la región, avatar con su forma real,
  constructor de prims, inventario local, apariencia, LSL y mallas `.glm`.
- **Entra en Second Life de verdad.** En la pantalla de entrada escribes tu
  nombre y contraseña y el visor hace el login real (XML-RPC), abre el circuito
  UDP con el simulador con el que te toca y te deja **andar, correr, volar,
  chatear, tocar prims y teletransportarte dentro de la región**.
- El **protocolo LLUDP entero (el de Second Life) está en JavaScript**, dentro
  del visor (`src/sl/lludp/`). Aquí, en Kotlin, solo vive un puente tonto:
  recibe un datagrama UDP y lo manda como una trama binaria por un WebSocket
  local, y al revés. ~150 líneas y no entiende ni una palabra del protocolo. La
  ventaja: el mismo código de protocolo corre en el navegador de escritorio, se
  prueba sin móvil y solo se mantiene una vez.
- Guarda de verdad en el teléfono: la región, el inventario y los avatares se
  guardan en el almacenamiento del WebView (IndexedDB), asi que sobreviven al
  cierre de la app.
- Trae un **panel de depuracion** (Ajustes → Depuracion e informes) que genera un
  informe de texto con lo que pasa dentro y fuera del visor, para poder mandarlo
  cuando algo va mal.

## Lo que aun no hace (y esta documentado, no es un fallo)

- Las **texturas de la region y los bakes del avatar** son **JPEG2000** y el
  navegador no las decodifica. Los prims usan su material por defecto y el cuerpo
  lleva su **forma** real (altura, corpulencia, cara) pero no la textura cocida.
  Hace falta un decodificador J2C y las *capabilities* de la region.
- El **inventario, los IM de grupo y la descarga de assets** dependen de las
  *capabilities* (`seed_capability` + `EventQueueGet`), que aun no estan.
- El **teletransporte a OTRA region** aun no cambia de circuito: si lo intentas,
  el visor lo dice y hay que volver a entrar desde la pantalla de inicio.

## Compilarlo en tu ordenador (opcional)

Necesitas Android Studio o el SDK de Android y Java 17. Desde la raiz:

```bash
node build-viewer.mjs             # mete el visor en app/src/main/assets/viewer/
node fetch-character-assets.mjs   # mete el modelo real del avatar (cuerpo de SL)
./gradlew assembleDebug           # compila
```

El APK queda en `app/build/outputs/apk/debug/app-debug.apk`. Para instalarlo en
un telefono conectado por USB:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Compilarlo sin instalar nada (GitHub Actions)

Es la via recomendada si no quieres montar el entorno de Android. Este
repositorio trae un flujo de trabajo en `.github/workflows/build-apk.yml` que
compila el APK en los servidores de GitHub cada vez que subes cambios. El APK
aparece como artefacto descargable en la pestana **Actions**. Las instrucciones
paso a paso estan en la conversacion que acompana a este proyecto.

## Subirlo a GitHub

**Opcion A, la que no falla: GitHub Desktop.** Es una aplicacion de escritorio
(Windows/macOS) que sube lo que haya en una carpeta tal cual, sin limites de
"cuantos archivos arrastras de golpe" y sin olvidarse de las carpetas que
empiezan por punto. Descomprime el `.zip` del proyecto, y:

1. Instala GitHub Desktop y entra con tu cuenta.
2. *File → Clone repository* → elige `yossfu/visor-sl` y una carpeta local.
3. Copia TODO el contenido del `.zip` descomprimido encima del clon
   (sobrescribiendo lo que haya).
4. En GitHub Desktop escribe un resumen ("Visor completo + puente UDP + arreglos"),
   pulsa *Commit to main* y luego *Push origin*.
5. Pestana **Actions** del repositorio → *Build APK* → *Run workflow* (o espera
   al que se lanza solo con el push).

**Opcion B, con la web: una carpeta por envio.** Crea el repositorio y en
*Add file → Upload files* arrastra **una sola carpeta cada vez**, en su propio
commit: primero `src/` (es la grande y la importante), luego `app/`, luego
`gradle/`, y por ultimo los archivos sueltos de la raiz. GitHub rechaza de golpe
mas de 100 archivos, y si eso pasa a mitad se queda un repositorio a medias: es
exactamente lo que dejo el visor sin arrancar (ver mas abajo).

Ojo: **no basta con seleccionar los archivos de la raiz**. Hay que subir tambien
las CARPETAS `src/`, `app/` y `gradle/` (la carpeta en si, no su contenido, y
`gradle/wrapper/gradle-wrapper.jar` es imprescindible). Si solo se suben los
archivos sueltos, el flujo de trabajo falla con
`ERROR: no encuentro src/app.js ...` o con
`Could not find or load main class org.gradle.wrapper.GradleWrapperMain`.
Ademas `.gitignore` y `.github/workflows/build-apk.yml` empiezan por punto:
si no aparecen en el repositorio, crea el flujo a mano desde la pestana
**Actions → set up a workflow yourself** pegando el contenido del archivo.

Debe quedar en la raiz del repositorio: `.github/`, `.gitignore`, `app/`,
`gradle/`, `src/`, `gradlew`, `gradlew.bat`, `build.gradle.kts`,
`settings.gradle.kts`, `gradle.properties`, `index.html`, `env.js`,
`build-viewer.mjs`, `fetch-character-assets.mjs` y los `.md`.

**Opcion C, con la linea de comandos.** Es la que no se deja nada:

```bash
git init
git add -A
git commit -m "Visor SL con puente UDP"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

Cuando el flujo de trabajo termine (pestana **Actions**, un par de minutos),
entra en la ejecucion, baja hasta *Artifacts* y descarga **visor-sl-apk**. Es un
`.zip`: dentro esta `app-debug.apk`. Pasalo al telefono, permitale instalar
aplicaciones de origen desconocido y abrelo.

### Si el APK se queda en «Preparando el mundo…»

Ese sintoma (la app carga para siempre, con el HTML de escritorio detras: barra
de navegacion, atajos WASD, el chat suelto) significa que **no se ejecuto ni una
linea de JavaScript**: al APK le faltan modulos del visor. Casi siempre es que en
el repositorio no esta la carpeta `src/` entera. El APK compila igual — no hay
error de Kotlin ni de Gradle — y solo se ve al abrirlo en el movil, asi que hay
dos redes de seguridad:

- `build-viewer.mjs` recorre el grafo de `import` de todos los modulos y, si
  alguno apunta a un archivo que no esta, **aborta la compilacion** con la lista
  exacta de lo que falta (asi no se vuelve a generar un APK "mudo").
- `env.js` lleva un **vigia de arranque**: si el visor no avisa de que ha
  arrancado en 9 segundos, tapa la pantalla con un diagnostico en castellano y
  comprueba, uno por uno, los modulos de `manifiesto.json` (la lista que escribe
  `build-viewer.mjs` al compilar), diciendo **los nombres exactos** de los que
  faltan y con un boton para copiar el informe.

## Como esta montado

En el repositorio (que arma `prepare-repo.mjs`) la raiz es a la vez el visor y el
proyecto Android:

```
index.html                    <- pagina del visor
env.js                        <- rellena `window.root` y `window.__SL_APP__`
src/                          <- todo el codigo del visor (incluye src/sl/lludp/)
build-viewer.mjs              <- copia index.html + env.js + src/** a los assets
fetch-character-assets.mjs    <- baja el modelo real del avatar a los assets
prepare-repo.mjs              <- arma ESTA carpeta para subirla a GitHub
app/src/main/
  assets/viewer/              <- el visor empaquetado (lo genera el script)
  assets/viewer/character/    <- el modelo del cuerpo de SL (lo genera el script)
  java/org/visor/sl/
    MainActivity.kt           <- la WebView, el arranque y el ciclo de vida
    ViewerServer.kt           <- sirve los assets por http://127.0.0.1
                                 (y el puente de red /proxy?url=... de env.js)
    UdpBridgeServer.kt        <- EL PUENTE UDP: WebSocket local + DatagramSocket
                                 (1 trama binaria = 1 datagrama)
    VisorDiag.kt              <- depuracion e informes (window.VisorDiag)
  res/drawable/ic_launcher_foreground.xml   <- el icono: un "prim" isometrico
  res/mipmap-anydpi-v26/ic_launcher.xml     <- icono adaptativo (Android 8+)
  res/mipmap-*/ic_launcher.png              <- icono para Android 7 y anteriores
  res/values/colors.xml                     <- fondo del icono
  AndroidManifest.xml                       <- declara el icono y los permisos
build.gradle.kts              <- Android Gradle Plugin + Kotlin
settings.gradle.kts
gradle.properties
```

### El puente UDP, en una pantalla

`MainActivity` arranca `ViewerServer` (los assets) y `UdpBridgeServer`; a este
ultimo le elige un puerto libre y carga el visor con la direccion del puente:

```
http://127.0.0.1:<puertoVisor>/index.html?udp=ws://127.0.0.1:<puertoPuente>#sl
```

El visor ve `?udp=...`, monta el nucleo LLUDP y abre el circuito a traves de ese
WebSocket. El protocolo del puente es minusculo:

1. La primera trama **de texto** es `{"cmd":"connect","host":H,"port":P}` y el
   puente responde `{"ok":true,"localPort":N}` o `{"error":"..."}`.
2. A partir de ahi, **cada trama binaria es un datagrama**, en los dos sentidos.
3. `{"cmd":"close"}` cierra; `{"cmd":"status"}` pide un resumen.

El `DatagramSocket` es *unconnected* (recibe de cualquiera y manda a `host:port`),
con `soTimeout` de 500 ms y bufer de recepcion de 1 MB. Repetir `connect` con
otro destino **reapunta** sin cambiar el puerto local (para el teletransporte).

El enlace de red del visor (`src/sl/relay.js`) sigue existiendo para los modos
antiguos (retransmisor `wss://`), pero la app ya no lo usa.

## El icono del lanzador

El icono es un **prim isometrico** (el cubo, el simbolo mas reconocible de
Second Life) en cian sobre el azul oscuro de la app. Android 8 y posteriores usan
el icono *adaptativo*: `res/mipmap-anydpi-v26/ic_launcher.xml` le dice al sistema
que ponga el fondo (`res/values/colors.xml`) y recorte la forma que use el
lanzador del movil; el dibujo va en `res/drawable/ic_launcher_foreground.xml`
(un `vector` de 108x108, con el cubo dentro de la "zona segura" central de
66x66). Para Android 7 y anteriores estan los PNG de
`res/mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher{,_round}.png`
(48/72/96/144/192 px).

Los PNG se dibujan **con la misma geometria y los mismos colores** que el
`vector`. Si se tocan las coordenadas o los colores de
`drawable/ic_launcher_foreground.xml`, hay que volver a generarlos; la forma
rapida es dibujarlos con `OffscreenCanvas` sobre un lienzo de 108x108 y exportar
a PNG con `convertToBlob`, escalando por `tamano/108`.

## La interfaz en el movil

La app **abre directamente la pantalla de entrada** (`#sl`: nombre, contrasena,
2FA), que es su pantalla natural: es la unica forma de entrar en Second Life.

Todo el aspecto tactil cuelga de la clase `body.touch`, y esa clase la decide
`src/app.js` al cargar —no el visor al montarse—, porque si no la pantalla de
entrada (que no monta visor) se pintaba con la maqueta de escritorio. En tactil:

- La barra de arriba **no** lleva la tira de enlaces: un boton `☰` abre un cajon
  con los destinos (Iniciar sesion, Arena, Galeria, Formas, Avatar, Mallas) que
  se cierra al elegir o al tocar fuera. La mayoria de la interfaz de escritorio
  (la ayuda de teclas WASD, el boton Construir, la leyenda de teclas de Ajustes)
  se oculta, porque en el movil no hay teclado.
- La linea de datos nace plegada y solo enseña donde estas; un toque la despliega
  (posicion, velocidad, hora, prims, distancia, calidad).
- El resto es el **HUD de juego**: minimapa arriba a la izquierda, carril de
  iconos a la derecha (Inventario, Armario, Forma, Mapa, Sitios, Construir,
  Chat, Ajustes) y sus cajones con telon, joystick flotante a la izquierda y
  racimo de acciones (Correr/Volar/Subir/Bajar/Saltar) a la derecha.

## El modelo del avatar dentro del APK

Para que el avatar se deforme «como en Second Life» no vale un cuerpo inventado:
hacen falta las MALLAS REALES del cuerpo de sistema de Linden Lab y sus texturas.
`fetch-character-assets.mjs` las descarga al compilar (del repositorio publico
del visor, LGPL) y las deja en `assets/viewer/character/`; el visor las usa de
ahi antes que de la red, asi que **la forma funciona aunque no haya conexion**.
Si la descarga falla, la compilacion sigue y el visor las pide por red. Los
ficheros no se suben al repositorio (los ignora `.gitignore`).

## Depuracion e informes

La app lleva un **panel de depuracion** (Ajustes → Depuracion e informes) que
cuenta lo que pasa y genera un **informe de texto**. Dentro del APK, `VisorDiag`
expone `window.VisorDiag` al visor: los informes se guardan en
`Android/data/org.visor.sl/files/informes/` (sin pedir permisos de
almacenamiento) y se pueden **compartir** o **copiar** para mandarlos. El informe
incluye tambien un registro nativo (arranque de servidores, datagramas que pasan
por el puente, 404 del servidor de assets), que es lo que la consola del
navegador no veria. Todo el detalle esta en [`DIAGNOSTICS.md`](DIAGNOSTICS.md) en
el proyecto.

## Errores de compilacion ya resueltos

- **`Accidental override: ... same JVM signature (getPort()I)`.** Pasaba en el
  antiguo `RelayServer.kt`: `WebSocketServer` ya expone `getPort()`, y un
  `val port: Int` en la subclase tiene la misma firma JVM. En
  `UdpBridgeServer.kt` el puerto es un parametro de constructor
  (`private val puertoEscucha`) y el puerto de escucha real se pregunta por
  `getPort()` (heredado). `MainActivity` no adivina puertos: elige uno libre con
  un `ServerSocket(0)` y se lo pasa al construirlo.
- **El APK no puede abrir `ws://` si el WebView se sirve por `https`.** No pasa
  aqui (todo es `http://127.0.0.1`), pero si algun dia se sirve por TLS habria
  que usar `wss://` o habilitar contenido mixto (ya esta en `ALWAYS_ALLOW`).

## El mundo real: como funciona por dentro

En una frase: **el protocolo, en JavaScript; el socket UDP, en Kotlin.**

1. El visor hace el login real con tu nombre y contrasena y recibe del servidor
   el `circuit_code`, el `session_id`, el `agent_id` y el `sim_ip:sim_port`.
2. `src/sl/lludp/gateway.js` pide al puente `connect(host, port)` y manda
   `UseCircuitCode`.
3. Llega `RegionHandshake`, se contesta, se manda `AgentThrottle` y
   `CompleteAgentMovement`, y empiezan a llegar `LayerData` (terreno) y
   `ObjectUpdate` (prims) y `AvatarAppearance` (residentes).
4. Ya esta: `AgentUpdate` a 10 Hz lleva tu posicion al simulador, `ChatFromViewer`
   manda lo que escribes, `ObjectGrab`/`ObjectDeGrab` tocan prims y
   `TeleportLocationRequest` te mueve dentro de la region.

Todo eso se puede probar **sin movil** en el navegador con `?udp=sim`, que pone
un simulador de region en JavaScript que habla el protocolo de verdad. Es la
razon de que el nucleo sea JavaScript: se verifica antes de tocar el telefono.
