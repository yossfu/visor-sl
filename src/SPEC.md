# SPEC — Visor de Second Life en el navegador

## Petición original

> "¿Podemos crear un motor con herramientas que existen para navegadores, un
> visor de second life que funcione con 3D y que sea útil?"

Interpretación acordada: un **visor/editor** de Second Life en el navegador. La
palabra clave es "útil": no una demo que dibuja siete formas, sino una
herramienta con la que se pueda de verdad construir y habitar un mundo: colocar
prims cuyos parámetros se comporten como en SL, texturizarlos, agruparlos,
programarlos y verlos con otras personas.

## Principio rector

La geometría de los prims **no se aproxima**: se porta el teselador de Linden
Lab (`LLVolume::generate`) para que un cubo cortado al 30 %, una esfera hueca con
agujero triangular, un tubo con twist y un anillo girado tengan exactamente la
misma forma que en el visor oficial, incluidas las rarezas. Todo lo demás se
construye encima de esa base.

## Alcance por fases

> Estado: Fases 1 a 7 terminadas y verificadas. Fase 8 (visor de Second Life
> de verdad) hecha salvo el retransmisor, que es un proceso nativo fuera del
> navegador y está especificado en `VIEWER-REAL.md`. Fase 9 (avatares reales)
> en curso. Fase 10 (cámara y HUD de juego tipo Genshin) terminada. Fase 11
> (app Android) en curso.

### Fase 1 — Motor de geometría (terminada)
- `generateVolume(VolumeParams, lod)` → malla con posiciones, UVs, normales y
  una lista de caras con su `faceID`/flags (tapa, plana, interior, lateral).
- Tabla de las 7 formas de SL y los campos del build floater.
- Selftest numérico contra volúmenes analíticos exactos.

### Fase 2 — Visor 3D (terminada)
- Región de SL: 256 × 256 m, terreno, agua, cielo con ciclo día/noche simple.
- Región de ejemplo (`sandbox.js`): plataforma con escalera, arco con 8 prims
  del catálogo, casa con solar aplanado, árboles, lago esculpido y muelle con
  barandilla (55 prims, ~104 k triángulos).
- El skyline del visor no es fijo: se puede **esculpir** (pads del terreno).
- Avatar (cápsula + cabeza + miembros) con el sistema de movimiento de SL
  (caminar/correr/volar, gravedad, altura de paso, colisión con AABB de prims).
- Cámara estilo SL: órbita alrededor del avatar con clic derecho, zoom con
  rueda, primera/tercera persona.

### Fase 3 — Herramientas de construcción (terminada)
- Selección por clic (raycast) con resaltado de la cara bajo el cursor.
- Gizmos de mover / rotar / escalar (snap a la rejilla de 0.5 m, Ctrl para
  rotaciones de 45°).
- Editor de parámetros del prim (todos los del build floater) en vivo.
- Link sets: agrupar/desagrupar, transformar el conjunto, jerarquía padre-hijo.
- Crear/copiar/borrar, deshacer/rehacer.
- Rez desde el inventario (bóveda de objetos).
- Esculpido de terreno con pincel (6 herramientas, tamaño y fuerza, trazo libre
  o por rectángulo), con deshacer/rehacer propio y guardado en la región.

### Fase 4 — Apariencia (terminada)
- Texturas por cara desde una biblioteca procedural (20 patrones generados en
  canvas, con mapas de normales), tinte por cara, transparencia y glow.
- Repetir/desplazar/rotar la textura por cara (UV).
- Materiales PBR sencillos (rugosidad/metalicidad) aproximando el viejo sistema
  de SL, con iluminación de entorno (el cielo se cocina a un `envMap`).
- Se descartó cargar texturas por **URL**: en SL las texturas son
  *assets* subidos a los servidores de Linden, y aquí la biblioteca procedural
  cubre el mismo papel sin depender de red ni de CORS.

### Fase 5 — Scripting (terminada)
- Mini-intérprete de LSL (subconjunto): `state_entry`/`state_exit`, `touch*`,
  `timer`, `listen`, `sensor`, estados, funciones propias, los seis tipos de
  LSL, ~120 funciones `ll*`. Sandbox seguro: sin red, sin DOM, presupuesto de
  pasos y de tiempo por evento, y errores de ejecución que no matan el script
  (solo el evento).
- El **contenido** del objeto es parte del objeto: viaja en el autoguardado, en
  la exportación de la región, en el inventario y al duplicar/rezar. Un prim
  con script lo arranca solo al entrar en la región.
- Chat local con los **alcances reales** de SL (susurro 10 m, decir 20 m,
  gritar 100 m, región, IM al dueño) y filtros de `llListen` (canal, nombre,
  key, texto); lo que se dice fuera de alcance se marca como tal.
- Editor por objeto en el panel de construcción (guardar+ejecutar, reiniciar,
  borrar, ejemplos) y consola de errores con línea.
- Se descartó el scripting con red o permisos (`llHTTPRequest`, `llDialog`,
  `llGiveInventory`, animaciones y sonidos): avisan por la consola en vez de
  romper, y el detalle está en `README.md`.

### Fase 6 — Multijugador (terminada)
- `server-plugin`: estado autoritativo del mundo (prims), presencia, chat.
- Determinismo: el servidor guarda parámetros y transformadas; cada cliente
  tesela localmente con el mismo `llvolume.js`, así que la red transporta
  parámetros, no geometría.
- El servidor es un retransmisor de bytes con historial corto y una instantánea
  del mundo; toda la lógica de sincronización (revisiones, diff, propiedad)
  vive en el cliente (`src/net.js`). Ver "Modelo multijugador" en `README.md`.
- Presencia: avatares remotos interpolados (`src/peers.js`), chip "N en línea".
- Chat local/IM de jugadores y de los scripts, con los alcances de SL.
- Si el mundo ya existe al entrar, se descarga (a trozos) o se reconstruye; si
  está virgen, se publica el tuyo. Tu región se guarda antes de adoptar la ajena
  y se puede recuperar ("pre-red").

### Fase 7 — Persistencia y publicación (terminada)
- Guardar/cargar la región en `kv` (o descarga como JSON/`.slp`-like) — hecho en
  Fase 3.
- `$meta` con título, descripción, imagen y tags. La imagen de portada es una
  captura real del visor subida a mano, porque el capturador de la plataforma no
  dibuja WebGL y en el listado el generador saldría en blanco.
- Pruebas responsive a 390 × 844 y 1920 × 1080 con las fases 5 y 6 dentro, y
  revisión de fps (ver "Rendimiento" en `README.md`).

### Fase 8 — Visor de Second Life de verdad (hecha salvo el retransmisor)
- Entrar en una región real de Second Life, no solo en la arena local.
- Un navegador **no puede** hablar con un simulador (LLUDP es UDP en crudo, y
  las capabilities son HTTP sin CORS), así que el visor habla por WebSocket con
  un **retransmisor** (gateway) que sí puede. Ese proceso no vive en el
  navegador: está especificado en `VIEWER-REAL.md`.
- Login real (`login_to_simulator` XML-RPC vía `superFetch`), con la contraseña
  hasheada como `"$1$" + MD5` y **sin guardarla en ningún sitio**. En el modo
  «sesión» la contraseña ni siquiera llega al retransmisor: solo su
  identificador de sesión.
- Protocolo propio sobre WebSocket (`src/sl/relay.js`), con los mismos
  conceptos que LLUDP: terreno por parches de 16×16, objetos y link sets,
  avatares, chat con canales y alcances, assets a petición, parcelas,
  inventario, edición.
- El mundo real entra por el MISMO camino que el multijugador
  (`world.applyRemote`): un solo mundo, no dos.
- Se descarta (documentado, no silencioso): decodificar J2C sin un WASM
   aparte, editar prims reales desde el editor (trama definida, sin enganchar),
  inventario/IM de grupo, animaciones y sonidos, mallas de avatar.
- Autotests sin navegador: `md5` 6/6, `llsd` 25/25, `login` 21/21, `relay`
  26/26, `mockServer` 19/19. El simulador de pruebas (`mockServer.js`) sirve
  una región inventada por el protocolo exacto y verifica el lado del navegador
  de punta a punta.

### Fase 9 — Avatares reales de Second Life (en curso)
- El visor dibuja el **cuerpo real** de cada residente (mallas de sistema y
  adjuntas, texturas de `character/`) y reproduce **sus animaciones reales**
  (`.anim`), en vez del cuerpo procedural de `avatarBody.js`, que queda como
  respaldo. Los activos se piden al repositorio público del visor de Linden Lab
  (LGPL) o los suelta el usuario; nada de SL se copia al generador.
- Piezas portadas fielmente, cada una con autotest: esqueleto
  (`avatar_skeleton.xml`, 133 huesos), malla `.llm` (LLMESH), animación `.anim`
  (LLKeyframeMotion) con su mezclador, cuerpo de sistema + morphs, 38 puntos de
  anclaje, texturas TGA y capas de piel, e importación de `.glb/.gltf/.obj`
  riggeados a los huesos de SL.
- **Forma del avatar (hecho).** El cuerpo real se deforma con los mismos
  parámetros de `avatar_lad.xml` que SL, así que el avatar toma la forma física
  que el residente tiene en SL (no una imitación). Cubre las tres familias:
  **mesh legacy** (cuerpo de sistema), **Bakes-on-Mesh** (texturas cocidas por
  uuid, por slot) y **Bento** (esqueleto de 133 huesos + parámetros de Bento).
  El **sexo se deriva del mando de género** (id 80), como `llvoavatar.cpp`. Se
  edita en el cajón Forma del HUD y en `#bodytest/forma`.
- **El modelo va dentro del APK.** `src/android/fetch-character-assets.mjs`
  descarga las mallas y texturas del cuerpo de sistema al compilar y las mete en
  los assets; `characterAssets.js` prefiere ese espejo local, de modo que la
  deformación funciona sin conexión (si no está, cae a la red).
- Falta: animaciones de residentes remotos, `AvatarAppearance` completo desde
  la red y el inventario de cuenta (lo que depende del retransmisor).

### Fase 10 — Cámara y HUD de juego tipo Genshin (terminada)
- La navegación se imita de **Genshin Impact** porque lo pedido es comodidad con
  el pulgar, no la cámara de escritorio de SL: tercer persona, ejes naturales y
  **andar y mirar a la vez**. Detalle en "Modelo de navegación y HUD de juego"
  (`README.md`).
- Cámara de seguimiento: `cam.pitch` es la inclinación *vista* (`+` = mirar
  arriba) y `cam.yaw` gira a la derecha al arrastrar a la derecha (antes los ejes
  estaban invertidos). Pellizco de dos dedos para acercar/alejar.
- Entrada **multitáctil real**: el joystick y el lienzo de la vista son elementos
  distintos, cada uno con su puntero, así que moverse y girar la cámara no se
  pisan.
- Joystick **flotante**: el anillo aparece bajo el dedo y vuelve a su esquina al
  soltar; la base se recorta contra la pantalla (no contra su recuadro) para que
  un toque cerca del borde no dé velocidad máxima de golpe.
- Racimo de acciones en **arco**, como un MOBA: Saltar (grande, con aro suave),
  Correr y Volar; al volar, Subir/Bajar ocupan su sitio. Botones circulares
  translúcidos, con estado y sin texto que se corte.
- HUD de juego (`src/gameHUD.js`): minimapa arriba a la izquierda y un carril de
  siete botones (Inventario, Armario, Mapa, Sitios, Construir, Chat, Ajustes)
  que abre cajones con fondo oscurecido en el móvil.
- Todo lo que se puede hacer tiene su sitio: **inventario**/bóveda de objetos,
  **armario**/ropa (parte de arriba/abajo, abrigo, calzado, sombrero, gafas,
  telas y conjuntos), **mapa** con destino e **Ir aquí** (teleporta), y
  **sitios**: los `landmarks` de la región (8: plataforma de llegada, arco,
  cartel con script, anillo, casa de la colina, embarcadero, orilla del lago,
  cumbre) más los que guarda el usuario.
- Franja superior del móvil compacta (menú de rutas en una línea deslizable) y
  franja de datos del visor plegada por defecto, para dejar sitio al mundo.
- Repaso de solapes y capas a 390 × 844, 844 × 390 y 1920 × 1080.

### Fase 11 — App Android (en curso)
- El visor es una app Android (WebView con servidores locales que sirven el
  visor) para poder hablar UDP con un simulador de SL desde el móvil. Plan y
  proyecto en `src/android/` y `ANDROID.md`.
- **El modelo del avatar va dentro del APK.** El flujo de compilación
  (`build-viewer.mjs` + `fetch-character-assets.mjs`) mete los módulos del visor
  y el cuerpo de sistema real de SL en los assets; así la forma del avatar
  funciona sin conexión.
- **Depuración e informes.** El APK expone `window.VisorDiag` (`VisorDiag.kt`):
  los informes del visor se guardan en una carpeta del teléfono y se pueden
  compartir, para poder traerlos de vuelta y arreglar los problemas. Un registro
  nativo (servidores, enlace, 404) viaja dentro del propio informe. Ver
  [`DIAGNOSTICS.md`](DIAGNOSTICS.md).
- Falta compilar el APK (GitHub Actions o Android Studio) y probarlo en el móvil.

## Requisitos no funcionales

- Responsive: escritorio y móvil (390 × 844 probado).
- 60 fps objetivo, con LOD adaptativo y teselado en caché por
  `VolumeParams.key(lod)`.
- Arranque rápido: geometría generada en el cliente, assets cargados de forma
  diferida.
- UI en español.
- Todo el estado del usuario en `kv` (local), nada subido al servidor salvo lo
  que exija el modo multijugador.
