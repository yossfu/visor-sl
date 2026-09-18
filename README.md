# Visor SL (Android)

Una app Android que lleva dentro el visor de Second Life del proyecto: una
`WebView` a pantalla completa con el visor web, un servidor local que le sirve
los archivos, y un nucleo nativo que abre el socket UDP que el navegador no
puede abrir. El objetivo es tener el visor en el bolsillo sin depender de un
retransmisor externo.

## Que hace esta version (Fase 1)

- Arranca el visor web completo (mundo de pruebas, constructor de prims,
  inventario, aspecto del avatar, importar mallas `.glb`/`.obj`/`.llm`).
- Guarda de verdad en el telefono: la region, el inventario y los avatares se
  guardan en el almacenamiento del WebView (IndexedDB), asi que sobreviven al
  cierre de la app.
- Levanta un **enlace interno** (un servidor WebSocket en `127.0.0.1`) que habla
  el mismo protocolo que hablaba el retransmisor. La app le pasa su direccion al
  visor automaticamente, asi que el campo del retransmisor aparece ya relleno.
- **Todavia no entra en el mundo real de Second Life**: el nucleo nativo
  contesta al enlace y mantiene la conexion, pero aun no habla LLUDP con los
  simuladores. Eso es la Fase 2 (ver mas abajo), y es la parte grande.

En resumen: esta version sirve para comprobar que el visor funciona bien dentro
de Android, que el enlace interno esta en pie y que el APK se compila y se
instala. El mundo real viene despues, sobre estos mismos cimientos.

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

**Opcion A, con la web (arrastra la CARPETA entera).** Crea un repositorio
nuevo y vacio, y en la pantalla del repositorio usa *Add file → Upload files*.
Arrastra la carpeta completa del proyecto (no los archivos sueltos: el
`.gitignore` y `.github/workflows/build-apk.yml` empiezan por punto y algunos
navegadores los esconden si eliges archivos uno a uno). El arrastre sí conserva
la carpeta `.github`, que es donde GitHub busca el flujo de trabajo.

**Opcion B, con la linea de comandos.** Es la que no se deja nada:

```bash
git init
git add -A
git commit -m "Visor SL: primera version Android"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

Cuando el flujo de trabajo termine (pestana **Actions**, un par de minutos),
entra en la ejecucion, baja hasta *Artifacts* y descarga **visor-sl-apk**. Es un
`.zip`: dentro esta `app-debug.apk`. Pasalo al telefono, permitale instalar
aplicaciones de origen desconocido y abrelo.

## Como esta montado

En el repositorio (que arma `prepare-repo.mjs`) la raiz es a la vez el visor y el
proyecto Android:

```
index.html                    <- pagina del visor (sin el bloque de servidor)
env.js                        <- rellena `window.root` (kv, superFetch, relay)
src/                          <- todo el codigo del visor
build-viewer.mjs              <- copia index.html + env.js + src/** a los assets
fetch-character-assets.mjs    <- baja el modelo real del avatar a los assets
prepare-repo.mjs              <- arma ESTA carpeta para subirla a GitHub
app/src/main/
  assets/viewer/              <- el visor empaquetado (lo genera el script)
  assets/viewer/character/    <- el modelo del cuerpo de SL (lo genera el script)
  java/org/visor/sl/
    MainActivity.kt           <- la WebView, el arranque y el ciclo de vida
    ViewerServer.kt           <- sirve los assets por http://127.0.0.1
    RelayServer.kt            <- enlace WebSocket interno con el visor
    FrameCodec.kt             <- el formato binario de los mensajes del enlace
    VisorDiag.kt              <- depuracion e informes (window.VisorDiag)
  AndroidManifest.xml
build.gradle.kts              <- Android Gradle Plugin + Kotlin
settings.gradle.kts
gradle.properties
```

El enlace interno habla el mismo protocolo que antes hablaba el retransmisor
(las mismas tramas que `src/sl/relay.js` y `src/sl/bin.js`
definen). Eso es a proposito: cuando el nucleo nativo aprenda a hablar LLUDP,
no hay que tocar ni una linea del visor.

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
incluye tambien un registro nativo (arranque de servidores, pings del enlace,
404 del servidor de assets), que es lo que la consola del navegador no veria.
Todo el detalle esta en [`DIAGNOSTICS.md`](DIAGNOSTICS.md) en el proyecto.

## Fase 2: el mundo real

El protocolo de Second Life (LLUDP) es grande — login, circuito de mensajes,
capabilities, colas de eventos, transferencia de assets, terreno, prims,
avatares — y ya existe un proyecto que lo tiene resuelto en Kotlin:
[Linkpoint](https://github.com/Kaleaon/Linkpoint) (licencia MIT). Su parte de
protocolo funciona; lo que le falla es justo lo que a nosotros nos sobra: el
renderizado 3D. El plan es portar su capa de protocolo al `RelayServer` de esta
app, mensaje a mensaje, empezando por el login y el circuito, y comprobando cada
paso contra un simulador real.

## Licencia

El visor es codigo propio. La parte que se reutilice de Linkpoint conserva su
licencia MIT (ver `LICENSE-LINKPOINT` cuando se incorpore).
