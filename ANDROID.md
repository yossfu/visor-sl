# Visor SL autónomo: la app Android (APK)

Este documento responde a dos preguntas del usuario:

1. «Quiero que la app sea autónoma, sin depender de un puente externo.»
2. «¿Podemos preparar el proyecto para compilarlo en un APK Android y usar así el
   UDP que hace falta?»

La respuesta corta es **sí a las dos**, y la forma correcta de conseguirlo es una
**app nativa Android**. Aquí está el porqué, la arquitectura y el plan.

---

## 1. Por qué hace falta nativo (y qué trozo, exactamente)

El navegador no puede abrir un socket UDP, y los simuladores de Second Life
hablan **LLUDP** (UDP en crudo). Eso no cambia. Lo que sí se puede elegir es
cuánto código vive en cada lado, y la respuesta de este proyecto es: **lo mínimo
en Kotlin, todo el protocolo en JavaScript**. Un navegador no puede abrir un
socket, pero sí puede hablar por un WebSocket local; el nativo solo tiene que
meter y sacar datagramas.

```
   UNA app Android
   ┌───────────────────────────────────────────────────────────────┐
   │  ┌────────────────────┐   WebSocket         ┌───────────────┐  │
   │  │ WebView            │  127.0.0.1          │ UdpBridge     │  │
   │  │ visor JS           │◄───────────────────►│ Server (Kotlin│──┼──UDP──► sim SL
   │  │ + núcleo LLUDP     │  (1 trama binaria   │ ~150 líneas)  │  │
   │  │   (src/sl/lludp/)  │   = 1 datagrama)    └───────────────┘  │
   │  └────────────────────┘                                       │
   │  ViewerServer (assets) + VisorDiag (informes)                  │
   └───────────────────────────────────────────────────────────────┘
```

Reparto de responsabilidades:

- **JavaScript (lo grande):** login, plantillas del protocolo, código binario,
  circuito UDP con acks/reenvíos/ping, terreno, objetos, avatares, chat, toque,
  teletransporte y el retransmisor (todo `src/sl/lludp/`). Es el MISMO código que
  corre en el navegador de escritorio y que se prueba con el simulador de región
  en JS, así que cada arreglo vale para los dos sitios y se verifica sin móvil.
- **Kotlin (lo pequeño):** un `DatagramSocket` y un WebSocket local
  (`UdpBridgeServer.kt`): recibe un datagrama y lo manda como trama binaria, y al
  revés. No entiende una sola palabra del protocolo de SL.

Ventajas:

- Un solo APK, un solo icono, sin ningún retransmisor externo ni segundo proceso.
- Un solo lenguaje para el protocolo: no hay que portarlo a Kotlin ni mantener
  dos implementaciones que se desincronicen.
- El nativo es tan pequeño que cabe entero en una pantalla y se revisa a ojo.

## 2. De dónde sale el protocolo (nada de portar un visor ajeno)

El núcleo LLUDP no se copió de ningún proyecto: está escrito aquí, en
JavaScript, a partir de las fuentes públicas de Linden Lab
(`message_template.msg`, `indra_constants.h`, `llprimitive.cpp`,
`lltextureentry.*`, `patch_dct.cpp`, `avatar_lad.xml`…) y **verificado contra
datagramas reales** congelados en los autotests (`recapturas.js` y
`vectors.js`). El resultado es `src/sl/lludp/` (835 comprobaciones en verde en
13 suites), más `src/sl/relay.js` (36) y `src/sl/red.js` (24, la sonda de red):
**895 comprobaciones en 15 suites**,
que es el MISMO código en el escritorio y dentro del APK.

En un principio se estudió portar la capa de red de **Linkpoint**
(`github.com/Kaleaon/Linkpoint`, Kotlin, MIT) al lado nativo. Se descartó: habría
sido mantener **dos** implementaciones del protocolo (una Kotlin en el móvil y
otra JS en el navegador) que se desincronizan a la primera de cambio, y la parte
nativa acababa siendo enorme. Con el puente tonto, el nativo cabe en una pantalla
y el protocolo se prueba sin móvil.

Eso sí: de Lumiya/Linkpoint **sí** se copió un hallazgo, el 18-09-2026, cuando el
móvil mandaba paquetes que nunca llegaban — ver «IPv4 a la fuerza» más abajo. No
es código portado: es un ajuste de dos líneas (`preferIPv4Stack`) y una
comprobación de la familia del socket.

## IPv4 a la fuerza (y la sonda de red)

En datos móviles, Android puede abrir un socket **de doble pila (IPv6)** por
defecto. Un socket así manda hacia la IP IPv4 de un simulador como
IPv4-metido-en-IPv6, y la respuesta puede no encontrar el camino de vuelta por el
NAT de la operadora (CGNAT): **«se envían paquetes y no llega ninguno»**, que se
confunde con un puerto bloqueado. Lumiya lo resolvió en el constructor de su
conexión, antes de crear ningún socket:

```java
System.setProperty("java.net.preferIPv4Stack", "true");
System.setProperty("java.net.preferIPv6Addresses", "false");
```

(Linkpoint lo documenta igual en `UDPConnectionFixed.kt` con capturas reales.) La
app hace lo mismo en dos capas:

- `VisorApp.kt` (un `Application`) lo pone en `onCreate`, antes de que exista
  ningún socket; `MainActivity` lo repite al arrancar y lo deja en el registro y
  en el informe.
- `UdpBridgeServer.abrirSocketUdp()` mira la familia del socket recién abierto y,
  si ha salido IPv6, lo descarta y abre uno IPv4 explícito
  (`DatagramChannel.open(StandardProtocolFamily.INET)`), avisando en el registro
  si tampoco. La familia va al informe (`puente.familia`).

Y para saber **sin** un simulador delante si la red deja salir UDP, está la sonda
de red: el visor (`src/sl/red.js`) monta una petición **STUN** (RFC 5389) y el
puente la manda con la orden `probe`, devolviendo lo primero que llegue. Si
vuelve, la red deja salir UDP y volver la respuesta; además dice la IP y puerto
**públicos** (que se comparan con el puerto local: en CGNAT suelen diferir, y la
entrada del NAT puede caducar en 30-60 s si no se mantiene el circuito con
pings). La sonda se lanza sola al abrirse el puente, y el panel de depuración
tiene el botón **«Comprobar red»** para repetirla.

## 3. Arquitectura concreta de la app

```
android/
  app/
    src/main/
      AndroidManifest.xml            (INTERNET + un solo Activity)
      java/org/visor/sl/
        MainActivity.kt              (WebView + arranque + ciclo de vida)
        VisorApp.kt                  (Application: fuerza IPv4 antes de nada)
        ViewerServer.kt              (sirve el visor por http://127.0.0.1:PORT)
        UdpBridgeServer.kt           (WebSocket local + DatagramSocket: 1 trama
                                      binaria = 1 datagrama UDP, y la sonda
                                      `probe`)
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
con `udpUrl` y rellena `window.root`); `MainActivity` carga el visor con
`?udp=ws://127.0.0.1:PUERTO#sl`, así que el propio visor abre el circuito LLUDP
a través del puente sin escribir ninguna dirección a mano.

### El protocolo del puente (contrato exacto)

Lo comparten `src/sl/lludp/udp.js` (cliente) y `UdpBridgeServer.kt` (servidor):

1. La primera trama **de texto** es `{"cmd":"connect","host":H,"port":P}` →
   responde `{"ok":true,"localPort":N}` o `{"error":"…"}`.
2. Después, **cada trama binaria es un datagrama**, en los dos sentidos.
3. `{"cmd":"close"}` cierra; `{"cmd":"status"}` responde `{"status":"…"}`.

El `DatagramSocket` es *unconnected* (recibe de cualquiera y manda a `host:port`),
con `soTimeout` de 500 ms y búfer de recepción de 1 MB. Repetir `connect` con
otro destino **reapunta** sin cambiar el puerto local (para el teletransporte).

Se abre con **`DatagramSocket(0)` (comodín `0.0.0.0`), nunca atado a
`127.0.0.1`**: un socket atado al bucle solo puede hablar por el bucle, y
`sendto` hacia la IP pública del simulador devuelve `EINVAL` en el acto (fue el
fallo del 18-09-2026: el circuito abierto, el login hecho, diez `sendto failed:
EINVAL` seguidos y cero paquetes del simulador). Si el socket saliera IPv6 se
avisa en el registro, porque una dirección IPv4 en un socket IPv6 da el mismo
`EINVAL`. Los fallos de envío se cuentan, se agrupan en el registro y se le
avisan al visor (`{"sendError":…}`), que los pone en el informe.

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

## 5. Fases

> **Estado**: el proyecto Android está completo y escrito en `src/android/`
> (Gradle, manifiesto, `MainActivity`, `ViewerServer`, `UdpBridgeServer`,
> `VisorDiag`, `env.js`, `build-viewer.mjs` y `fetch-character-assets.mjs`).
> El núcleo LLUDP (`src/sl/lludp/`) entra en regiones reales: login, circuito,
> handshake, terreno, objetos, avatares, chat, toque, movimiento y
> teletransporte dentro de la región, todo verificado contra el simulador.

1. [x] **Esqueleto**: APK que abre, sirve el visor (HTTP local) y lleva dentro
   el modelo real del avatar y el panel de informes.
2. [x] **Login y circuito**: login XML-RPC real y apertura del circuito UDP a
   través del puente, con `UseCircuitCode` y `RegionHandshake`.
3. [x] **Mundo**: terreno (DCT), objetos (`ObjectUpdate`), avatares
   (`AvatarAppearance`), chat, `CoarseLocationUpdate` y `SimStats` → el visor lo
   pinta.
4. [x] **Interacción**: movimiento (`AgentUpdate` a 10 Hz), chat
   (`ChatFromViewer`), toque (`ObjectGrab`/`ObjectDeGrab`) y teletransporte
   dentro de la región.
5. [ ] **Assets**: capabilities + EventQueueGet + transferencias de
   texturas/mallas (**J2C incluido**) + inventario. Es lo que falta para ver las
   texturas reales de la región y los bakes del avatar (hoy son JPEG2000 y el
   navegador no las decodifica; los prims usan su material por defecto).
6. [ ] **Avatar de la cuenta**: bakes (BoM) + adjuntos + animaciones reales de
   la cuenta (la forma real ya se aplica).
7. [ ] **Pulido**: IM, parcelas, edición de objetos, cambio de región
   (hoy el teletransporte a otra región avisa y no se intenta).

## 6. Límites honestos

- El APK hay que **compilarlo y probarlo en un dispositivo**; eso ocurre en la
  máquina del usuario o en CI, no en este editor.
- Todo visor de SL debe cumplir la **Política de Visores de Terceros de Linden
  Lab** (identificarse como visor de terceros). Está previsto en el arranque.
- Las credenciales se piden en tiempo de ejecución y **nunca** se guardan ni se
  suben a ningún sitio.
- Lo que aún no se hace: **decodificar JPEG2000** (las texturas y los bakes de
  SL; sin eso, los prims usan su material por defecto y el cuerpo no lleva la
  textura cocida, aunque sí su **forma** real), **capabilities/EventQueueGet**
  (sin `caps.js` no hay inventario, IM de grupo ni descarga de assets) y
  **cambio de región** (el teletransporte a otra región avisa y no se intenta).
