# Depuración e informes

Cómo el visor cuenta lo que le pasa, y cómo sacar ese relato del teléfono para
poder arreglar los problemas. Es la pieza que pediste: una **opción de
depuración e informes** que, cuando instales el APK y lo pruebes, genere
informes que puedas traer de vuelta.

Todo esto vive en `src/diag.js` (lado del navegador/visor) y en
`android/app/src/main/java/org/visor/sl/VisorDiag.kt` (lado de la app Android).

## 1. Qué es un «informe»

Un texto plano, pensado para copiarlo, pegarlo en un chat o mandarlo por correo.
Tiene siempre estas secciones, en este orden:

| Sección | Qué cuenta |
|---|---|
| Cabecera | cuándo se generó, cuánto lleva abierto el visor, la página y el nivel de depuración |
| `=== ENTORNO ===` | navegador o app nativa, Android/dispositivo, pantalla, ventana, núcleos, memoria, conexión, WebGL (tarjeta, versión, límites), y **el registro nativo** (ver §4) |
| `=== ESTADO AHORA ===` | una foto de los subsistemas en ese instante (sesión, región, avatares, forma del avatar, recursos...) |
| `=== RESUMEN ===` | los mensajes agrupados por texto, con cuántas veces ha salido cada uno y el total por categoría |
| `=== REGISTRO ===` | las últimas líneas, en orden, con hora `HH:MM:SS.mmm`, nivel, categoría y (si lo hay) un detalle |

`diag.json()` devuelve lo mismo en JSON (para volcados automáticos);
`diag.report({ full: true })` amplía el entorno con el bloque WebGL completo.

En `=== ESTADO AHORA ===` hay dos bloques que importan cuando «no pasa nada» en
el móvil:

- **sesión**: estado, enlace, fase, si está listo, región, `simPackets`,
  prims/parches/avatares, `kbIn`/`kbOut`, **parones** y **parón más largo**, y el
  error (si lo hay). Un parón es una congelación real de la página (WebView en
  segundo plano, montar la región): es normal y no significa que el enlace se
  haya caído.
- **LLUDP**: el resumen del retransmisor (`lldpRelay.gateway.resumen()`): fase,
  `simPackets`, **`relogins`**, el circuito (paquetes, RTT, reenvíos, silencio en
  ms) y el bloque **`puente`** con lo que ha ido y vuelto por el WebSocket local
  de la app (host, puertos, datagramas y KB en cada sentido). Si el puente no
  arrancó, aquí se ve por qué. Si el puente **no pudo enviar** algún datagrama,
  añade `erroresEnvio` y `ultimoErrorEnvio` (por ejemplo
  `sendto failed: EINVAL (Invalid argument)`): eso significa que el enlace va
  bien pero la salida a la red no, y es lo primero que hay que mirar.

## 2. Niveles y categorías

El nivel se elige en el desplegable del panel y **filtra lo que se guarda**
(cada nivel incluye los más graves):

| Nivel | Qué entra |
|---|---|
| `ERROR` | lo que ha roto algo |
| `AVISO` | lo que va mal pero sigue |
| `INFO` | los hitos (login, región cargada, informe guardado) |
| `DETALLE` | todo, incluido el ruido (por defecto) |

Las categorías (casillas para encender/apagar) son:
`Arranque`, `Red y relé`, `Sesión`, `Recursos`, `Mundo`, `Apariencia`,
`Forma y Bento`, `Animación`, `Scripts LSL`, `Gráficos`, `Interfaz`, `Errores`.

`Aviso`/`Info`/`Detalle` tienen atajos con nombre en inglés (`warn`/`log`/`debug`)
por si vienen de código existente. `diag.once(clave, ...)` anota algo **una sola
vez** con esa clave (para no repetir «no se pudo pedir X» en cada fotograma).

## 3. La ventana de depuración

Está en **Ajustes → Depuración e informes** (cajón de Ajustes del HUD). Trae:

- filtro por nivel, casillas por categoría y una caja para **buscar texto**;
- el registro en vivo (se va añadiendo solo, con el nivel y la categoría de cada
  línea, y los mensajes repetidos se cuentan: `×12`);
- el botón **«Probar error»**, que anota dos errores a propósito (uno directo y
  otro capturado por el manejador global) para comprobar que el informe recoge
  lo que tiene que recoger.

Botones: **Ver informe** (abre el texto completo, con su propio Guardar/Copiar),
**Guardar**, **Compartir**, **Copiar** y **Limpiar**.

La ventana no depende de la consola del navegador: en el APK no hay consola a
mano, así que todo lo que importa se ve ahí y acaba en el informe.

## 4. Automático: qué se captura sin pedirlo

Al arrancar, `diag.install()` engancha y anota por su cuenta:

- los **errores sin capturar** de la página (`window.onerror`) con archivo y
  línea, y las **promesas rechazadas** (`unhandledrejection`) con su pila;
- los `console.error` / `console.warn` de todo el visor (con el prefijo
  `consola:`), sin registrar el propio registro (no hay bucles).

Los subsistemas registran su estado con `diag.registerState(nombre, () => ({...}))`
y sus mensajes con `diag.info/aviso/error("categoria", "texto", datos)`. Con eso
el informe lleva la foto del momento además del historial.

## 5. Dónde se guarda (en el APK)

La app expone `window.VisorDiag` al WebView (`VisorDiag.kt`). En cuanto
`diag.js` lo detecta, **guardar** y **compartir** pasan por ahí en vez de por la
descarga del navegador (que en un WebView no es fiable):

- **Carpeta de informes**: `Android/data/org.visor.sl/files/informes/`
  (`getExternalFilesDir("informes")` del propio APK: **no hace falta ningún
  permiso de almacenamiento**).
- **Guardar** escribe `visor-sl-informe-AAAAMMDD-HHMMSS.txt` ahí y devuelve la
  ruta.
- **Compartir** escribe el informe y abre la hoja de compartir de Android
  (se manda el **texto**, que basta para correo, mensajería o notas).
- **Copiar** usa el portapapeles del sistema.

Para traérmelo: pulsa **Compartir** y mándalo por donde quieras (correo, notas,
mensajería), o **Copiar** y pégalo; o abre la carpeta de informes con un
explorador de archivos. El informe es texto plano, así que pega el contenido tal
cual.

## 6. El registro nativo

Hay cosas que el visor web **no puede** ver: si arrancaron los servidores
locales, en qué puerto, si el enlace interno recibe pings, si el servidor del
visor devolvió un 404. Eso lo cuenta la parte nativa (`MainActivity.kt`,
`RelayServer.kt`, `ViewerServer.kt`) a un anillo corto,
`VisorNativeLog` (`VisorDiag.kt`):

- guarda las **últimas 300 líneas** en memoria y las escribe también en
  `informes/nativo.log` (para que sobrevivan al cierre de la app);
- viaja dentro de `VisorDiag.info()`, así que el **informe de texto lo incluye**
  bajo `registro nativo (últimas líneas)`.

Así, cuando algo va mal en la app (no en el visor), el informe también lo cuenta.

> La **consola del WebView no se ve en el teléfono** (haría falta un cable y
> `chrome://inspect`), así que el visor puede escribir en este registro con
> `VisorDiag.logNativo(texto)` — `env.js` lo usa, por ejemplo, para *probar la
> salida a internet* al arrancar: pide un recurso público a través del puente de
> red (`/proxy?url=…`) y deja en el registro si el teléfono llega o no, que es
> justo el dato que falta cuando el login falla con un «Failed to fetch».

## 7. El puente `window.VisorDiag` (referencia)

| Método (JS) | Qué hace |
|---|---|
| `ping()` | `true`: sirve para comprobar que el puente existe |
| `logNativo(texto)` | una línea del visor en el **registro nativo** (y por tanto en el informe) |
| `info()` | JSON con app/Android/SDK/modelo/fabricante/pantalla, la **carpeta de informes** y el **registro nativo** |
| `saveReport(nombre, texto)` | escribe el informe y devuelve su ruta |
| `shareReport(nombre, texto)` | escribe el informe y abre «Compartir» de Android |
| `listReports()` | JSON con los informes guardados (nombre, bytes, fecha) |
| `readReport(nombre)` | el texto de un informe guardado |
| `deleteReport(nombre)` / `clearReports()` | borra uno / todos |
| `toast(texto)` | un aviso breve en pantalla |

El puente es **opcional** para el visor: si no está (en perchance, o en un
navegador normal), `diag.js` guarda por descarga y comparte por
`navigator.share`/portapapeles. Los nombres de fichero se sanean para que no
puedan salir de la carpeta de informes.

## 8. Privacidad

- El informe **no lleva nunca la contraseña**: solo el *modo* de login
  (`RelayServer.kt` registra el modo, jamás la clave).
- El entorno sí lleva datos del dispositivo (modelo, Android, WebGL) — es lo que
  hace falta para diagnosticar. Si algún día no quieres que salgan, se pueden
  quitar del panel sin tocar nada más.
- Todo se queda en el teléfono hasta que **tú** pulsas Compartir/Copiar.

## 9. Capturas (`#captura`)

Para depurar gráficos, abre el visor con el hash **`#captura`** (por ejemplo
`...index.html#captura`): activa `preserveDrawingBuffer` en el lienzo, y así se
pueden hacer capturas fiables del 3D (que si no salen en negro). No cambia nada
del mundo; solo deja el búfer listo para capturarlo.

## 10. Para el lado del navegador (perchance)

En la página de perchance el panel funciona igual, con la diferencia de que
**Guardar** descarga un `.txt` y **Compartir** cae a `navigator.share` o copia.
No hay registro nativo (el bloque `app nativa: no (navegador)` lo dice). Útil
para reproducir un problema en el escritorio antes de mirarlo en el móvil.
