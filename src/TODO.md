# TODO

Orden de trabajo. Marcar al terminar; añadir al final lo nuevo.

## Fase 1 — Geometría
- [x] Port de `LLVolume` (`src/llvolume.js`)
- [x] Tabla de formas + `PrimParams` (`src/prims.js`)
- [x] Selftest numérico (489/489) (`src/llvolume.selftest.js`)
- [x] `README.md` / `SPEC.md` / `TODO.md`
- [x] `src/primMesh.js`: `BufferGeometry` de three.js desde `generateVolume`
      (+ grupo por cara, + caché por `key(lod)`)
- [x] `src/primGallery.js` + ruta `#primtest`: galería visual de las 7 formas y
      variantes, verificada con `vision`
- [x] Arreglo de orientación: referencia de tapa por normal del plano,
      normales de columna por desplazamiento dentro de la cara, y arista de
      cierre del corte de perfil (ver README, regla 9)
- [x] Invariante `orientationReport` (aristas mal orientadas / doble cobertura /
      degeneradas) + tabla de volúmenes exactos por caso
- [x] Sonda de píxeles autovalidada (`probeVolumes` / `window.__app.probe()`):
      21/21 casos sin agujeros ni normales nulas
- [ ] Optimizar: compartir buffers entre prims idénticos, teselado incremental
      (no re-teselar lo que no cambió), LOD por distancia

## Fase 2 — Visor
- [x] `index.html`: cascarón (canvas + HUD), three.js vía `src/three.js`
- [x] `#viewer` como ruta por defecto (`#primtest` sigue disponible)
- [x] Terreno de región 256×256 (`src/region.js`): malla de 129², color por
      altura+pendiente, y **pads** como primitiva de modelado (`addPad` con
      `falloff`, `wobble` y `bowl`; base de la futura herramienta de esculpido)
- [x] Agua con shader propio: olas de dos escalas, espéculo doble y
      **profundidad real** (el terreno se empaqueta en una `DataTexture` RG8 que
      el fragment shader consulta para el tinte de orilla y el alfa)
- [x] Cielo por gradiente + disco solar/lunar + estrellas, con `DayCycle` y
      paleta tipo WindLight; luz direccional con sombras (frustum ±44 m) y
      **luz lunar** (por la noche la direccional cambia de sol a luna, antes la
      luz salía de debajo del suelo y la noche era negra)
- [x] Avatar (`src/avatar.js`): cuerpo, andar/correr/volar, gravedad, salto de
      1.07 m, escalones de 0.5 m, colisión OBB contra prims y altura de terreno
- [x] Cámara estilo SL: seguir/libre, órbita, zoom, primera/tercera persona
- [x] Táctil: joystick + botones, HUD en dos franjas que no se solapan en móvil
- [x] Calidad adaptativa: presupuesto de píxeles (2.2 M en táctil, 9 M en
      escritorio), DPR base recalculado al redimensionar, AA solo con DPR < 1.75.
      Medido en un Adreno 619: 51-60 fps a 1920×1080, 51-58 a 390×844
- [x] Regresión de física determinista (`v.update` congelado + paso manual):
      subir/bajar escalones, entrar en la casa, caminar por el muelle, entrar en
      el lago y salir, salto 1.071 m, barandilla que bloquea

## Fase 3 — Construcción
- [x] Raycast + selección + resaltado de cara (`src/build.js`)
- [x] Gizmos mover/rotar/escalar (snap 0.5 m / 45° / 0.125, ejes locales)
- [x] Panel de parámetros del prim en vivo (deslizadores por cara/grupo,
      color con paleta + cuentagotas, tamaño/posición numéricos, lista de caras)
- [x] Crear/copiar/borrar, bajar al suelo, traer al avatar, reiniciar forma,
      deshacer/rehacer por instantáneas
- [x] Panel plegable (secciones "Herramientas" / "Prim seleccionado" / "Caras")
      para que quepa en el móvil
- [x] Link sets: `world.link/unlink/applyLinkRoot/refreshLinkLocals/setBox`, matriz
      relativa `local` por hijo y `parent`/`local` en `serialize`; selección
      múltiple (Shift/Ctrl+clic o modo táctil), caja envolvente del conjunto,
      gizmo en la raíz, arrastre en grupo, "stretch" del conjunto, duplicar
      conjunto, borrar conjunto entero, `Ctrl+L` / `Ctrl+Shift+L`
- [x] Inventario (`kv`) con rez (`src/store.js`): guardar prim con nombre, rezar
      delante del avatar apoyado en el suelo, borrar; región en `kv.region` con
      autoguardado con retardo, Guardar/Recargar, Exportar/Importar JSON y
      "Volver al ejemplo"
- [x] Esculpido de terreno interactivo (`src/terrainTools.js` + capa
      `Terrain.sculpt`): ray-march analítico (0.011 ms, coincide con la malla a
      < 0.0001 m), pincel con 6 herramientas, tamaños 2-32 m, fuerza, trazo con
      dabs, deshacer/rehacer por diffs del rectángulo (1.2 ms), selección por
      rectángulo con "Aplicar a la selección", y la capa viaja en el
      autoguardado/exportación (base64 de `Int16` cm)

## Fase 4 — Apariencia
- [x] Modelo por cara (`src/faces.js`): `FaceSpec` = patrón procedural (20),
      tinte, repetir/desplazar/rotar UV, alfa, glow, rugosidad, metalicidad,
      emisivo; `facesToJson`/`facesFromJson` para guardar y rezar
- [x] Biblioteca procedural (`src/textures.js`): 20 patrones + mapas de normales
      + miniaturas, generados en canvas (madera, ladrillo, metal, oro, hierba,
      arena, agua, piedra, mármol, tela, ...)
- [x] Caché de materiales por combinación de cara con poda LRU (`src/world.js`)
- [x] Panel "Apariencia" (`src/appearance.js`): rejilla de texturas, paleta de
      16 muestras, deslizadores de UV/alfa/glow/rugosidad/metalicidad, emisivo
- [x] Herencia SL: sin textura propia la cara usa el color del prim; el tinte
      por cara multiplica la textura
- [x] Iluminación por entorno (PMREM): el cielo se cocina a un `envMap` que
      alimenta `metalness`, para que metales/oro no salgan negros; se re-cocina
      sólo cuando el sol cambia de tramo. `ENV_INTENSITY` (`src/region.js`)
      compartido por terreno/agua/prims/avatar para no duplicar ambiente
- [x] Inventario y autoguardado conservan las caras (`faces` en `primToItem`)
- [x] Verificado con `vision`: metales y oro con reflejos del cielo de día, y
      formas visibles de noche (sin siluetas negras)

## Fase 5 — Scripting (terminada)
- [x] Mini-intérprete LSL (`src/lsl/`): lexer, parser, evaluador con presupuesto
      (300k pasos / 40 ms por evento, profundidad de llamada 64), estados,
      tipos vector/rotation/list/string/key/integer/float, casts y `LslError`
      con línea. Autotest: `runLslSelfTest()` → 92/92
- [x] Eventos: `state_entry`, `state_exit`, `touch`/`touch_start`/`touch_end`,
      `timer`, `listen`, `sensor`/`no_sensor`
- [x] ~120 funciones `ll*`: chat (`llSay`/`llWhisper`/`llShout`/`llOwnerSay`/
      `llRegionSay`), texto flotante (`llSetText`), transformadas
      (`llGetPos`/`llSetPos`/`llGetRot`/`llSetRot`/`llRotate`/`llSetScale`,
      `llSetLinkPrimitiveParamsFast` con PRIM_COLOR/GLOW/FULLBRIGHT/TEXT/TEXTURE/
      POSITION/ROTATION/SIZE/NAME/DESC, `llGetPrimitiveParams`), `llTargetOmega`,
      timers, `llListen*`, matemáticas, cadenas, listas, sensores y
      `llDetected*`. Lo que no tiene sentido en un visor (llHTTPRequest, llSleep,
      llDialog, llRezObject…) **avisa por la consola en vez de romper**
- [x] Runtime (`src/lsl/runtime.js`): puente al mundo — transformadas en
      coordenadas de región SL (`<128,128>` = centro), chat con alcances reales
      (susurro 10 m / decir 20 m / gritar 100 m), burbujas y `llSetText` como
      capas DOM proyectadas, tocar un prim con el puntero dispara touch, timers
      en el bucle de render, reconciliación automática (rezar o cargar región
      arranca los scripts solos) y dos frenos anti-bucle de chat
- [x] Editor (`src/lslPanel.js`): sección "Script (LSL)" en el panel de
      construcción (Guardar y ejecutar / Reiniciar / Borrar / ejemplos) y chat
      local con canal, alcance y avisos
- [x] El contenido viaja con el objeto: `prim.script` en `serialize`, en el
      inventario (`primToItem`) y al duplicar/rezar
- [x] Dos prims de ejemplo en el mundo de arranque (`src/sandbox.js`): el cartel
      con script (llSetText + touch + listen) y el anillo con `llTargetOmega`
- [ ] Animaciones de avatar (`llStartAnimation`), sonidos (`llPlaySound`),
      diálogos (`llDialog`) y red (`llHTTPRequest`): fuera de alcance en este
      visor, hoy avisan por la consola
- [ ] Multi-script por prim (las 5 pestañas de contenido de SL) y permisos

## Fase 6 — Multijugador (terminada)
- [x] `server-plugin`: `createServerSocket` + script de servidor (retransmisor de
      bytes con historial corto y una instantánea del mundo) en `index.html`
- [x] Estado de prims y transformadas con revisiones + diff-sync (`src/net.js`):
      alta/cambio/borrado, 40 mensajes por tick a 3 Hz, eco desactivado por firma
- [x] Presencia ("N en línea"): avatares remotos interpolados (`src/peers.js`),
      pose a 10 Hz, chip en el HUD que también cambia tu nombre
- [x] Chat local de jugadores y de los scripts, con canal y alcance, y el chat de
      un prim difundido solo por su dueño
- [x] Interpolación y reconciliación en el cliente; `held` para revisiones
      futuras, petición de historial si hay hueco
- [x] Entrada a una región poblada: descarga de instantánea a trozos o
      reconstrucción del historial; región virgen → publicar la propia
- [x] Propiedad (`owner`) y herencia de prims cuando un jugador se va
- [x] Guardar la región local como `pre-red` antes de adoptar la compartida
      ("↩ Mi región anterior")
- [ ] Sincronizar el terreno esculpido en vivo (hoy viaja solo en la instantánea)
- [ ] Mover prims ajenos / permisos de edición (hoy cada uno edita lo suyo)

## Fase 7 — Final
- [x] Guardar/cargar región (kv + exportar/importar JSON) — hecho en Fase 3
- [x] `$meta` (título, descripción, imagen de portada, tags): portada real del
      visor (captura a 1200×675 subida a `user.uploads.dev`), porque la
      plataforma no sabe dibujar WebGL y en el listado saldría en blanco
- [x] Pruebas responsive con las fases 5 y 6 dentro: 390×844 (HUD de dos
      franjas, panel de construcción plegado, joystick y chat caben sin
      solaparse; 57-60 fps) y 1920×1080 (barra superior limitada a 1180 px para
      que no se estire de borde a borde; sin desbordes)
- [x] Revisión de fps: el mapa de sombras (1536², PCF suave) se rehacía en cada
      frame y costaba ~11 fps en pantalla grande; ahora `shadowMap.autoUpdate`
      está apagado y se rehace cuando el sol o el avatar se mueven (o cada
      200 ms por seguridad), y la resolución y el alcance de las sombras bajan
      con la calidad (1536²/±44 m → 1024²/±36 → 512²/±30). Medido: 60 fps con
      el avatar quieto a 390×844, y el mapa de sombras ya no domina el frame
- [ ] Mover prims ajenos / permisos de edición (hoy cada uno edita lo suyo)
- [ ] Sincronizar el terreno esculpido en vivo (hoy viaja en la instantánea)

## Fase 8 — Visor de Second Life de verdad (hecho el lado del navegador)
- [x] `src/sl/bin.js`: `Writer`/`Reader` little-endian, uuid de 16 bytes, JSON
      con longitud delante
- [x] `src/sl/md5.js` + `slPasswordHash` (`"$1$"` + MD5) — autotest 6/6
- [x] `src/sl/llsd.js`: XML-RPC/LLSD + notación LLSD + helpers de uuid —
      autotest 25/25
- [x] `src/sl/login.js`: login real a `login.agni.lindenlab.com`/aditi vía
      `superFetch`, traducción de fallos al castellano, `relayCredentials()` —
      autotest 21/21
- [x] `src/sl/relay.js`: protocolo `C.*`/`S.*`, fases, `ASSET_FORMAT`
      (incluido J2C), `putAsset`/`readAsset`, transporte WebSocket con latido,
      reconexión y RTT; URL no-WebSocket = error fatal sin reintento —
      autotest 26/26, `probe()`
- [x] `src/sl/mockServer.js`: retransmisor de pruebas «Bahía de Pruebas»
      (terreno, ~72 prims, 6 residentes, chat, toque, texturas RGBA8) —
      autotest 19/19; especificación ejecutable del lado servidor
- [x] `src/sl/session.js`: puente enlace ↔ mundo (login al conectar, colas por
      fotograma, pose 8 Hz, toque, assets, aparición del avatar) sobre
      `world.applyRemote`
- [x] `src/sl/startPanel.js` + ruta `#sl`: tres modos de entrada (sesión,
      credenciales, simulador), validación de la URL del retransmisor,
      persistencia en `kv` de grid/nombre/URL (nunca la contraseña)
- [x] `src/VIEWER-REAL.md`: por qué hace falta el retransmisor, el protocolo
      lado a lado con LLUDP, la lista de trabajo del gateway, el problema de
      las texturas J2C y lo que falta
- [x] Arreglados: reentrada (la sesión se presenta una vez por conexión,
      `loginSent`; el mock manda la región una vez, `regionSent`),
      `S.REGION_INFO` ya no vuelve a modo exterior (borraba el terreno),
      `Terrain.applyPatch` mapea el parche en metros (funciona con 2 m/vértice)
- [ ] Retransmisor de verdad (proceso nativo): circuito LLUDP, capabilities,
      `UseCircuitCode`/`RegionHandshake`/`CompleteAgentMovement`, terreno,
      objetos, avatares, chat, assets, parcelas — ver `VIEWER-REAL.md` §7
- [ ] Decodificador J2C (WASM o transcodificado en el gateway) —
      `VIEWER-REAL.md` §9
- [ ] Enganchar la edición de prims reales al enlace (`C.OBJECT_EDIT` está
      definido; hoy `src/build.js` edita solo el mundo local/multijugador)
- [ ] Interfaz de parcela, inventario/IM de grupo, animaciones y sonidos,
      mallas de avatar (tramas ya definidas, sin usar)

## Fase 9 — Avatares reales de Second Life (en curso)

El objetivo: que el visor dibuje **el avatar de verdad de cada residente** —el
cuerpo/cabeza mesh que lleva puesto, su ropa, sus accesorios— y que reproduzca
**sus animaciones reales**, en vez del cuerpo procedural de `avatarBody.js` (que
se queda como respaldo para cuando no hay datos). Todo esto llega por el mismo
camino que el resto del mundo real: el retransmisor (`VIEWER-REAL.md`), en
tiempo de ejecución. No se descarga ni se copia nada al generador: los activos de
SL (mallas de Linden Lab y de los creadores, texturas, animaciones) se piden y se
dibujan para la sesión del usuario, exactamente como hace cualquier visor.

- [x] `src/sl/skeleton.js` — el esqueleto de SL (`avatar_skeleton.xml` v2.0, 133
      huesos + 26 volúmenes de colisión, port literal), cambio de marco
      SL→visor, `buildSkeleton` para three.js y autotest 32/32. Es la pieza de la
      que cuelgan mallas, ropa, accesorios y animaciones.
- [x] `src/sl/llmesh.js` — decodificador de malla (`LLMESH`, el activo `.llm`):
      contenedor (cabecera LLSD + bloques zlib), niveles de detalle, submeshes
      (posiciones/normales/UV/pesos), `SkinInfo` (nombres de hueso + matrices
      inversas de enlace + `bind_shape_matrix`), colisión convexa, y
      construcción directa de un `SkinnedMesh` de three.js. Incluye el escritor
      (`encodeMeshAsset`/`encodeSubmesh`, para el autotest) y autotest 24/24.
      Nota de convención: el visor guarda las matrices en el formato de
      `LLMatrix4a` (traslación en la FILA 3), o sea la traspuesta de la matriz
      habitual; `decodeSkin` las traspone al leer y `frameMatrix` las pasa al
      marco del visor. La piel es `boneInverse = invBind · bindShape` con
      `bindMatrix = I` (el visor aplica `bind_shape_matrix` a los vértices en
      `LLModelPreview::genBuffers`).
- [x] `src/sl/anim.js` — decodificador de animación (`LLKeyframeMotion`, el
      `.anim` de SL): versión 1.0 y la antigua 0.1, rotaciones por hueso
      (U16 → cuaternión por `unpackFromVector3`), posiciones (U16 → ±5 m,
      `LL_MAX_PELVIS_OFFSET`), prioridades base y por articulación, bucle
      (`loop_in_point`/`loop_out_point`), `ease in`/`out`, restricciones (se leen,
      no se aplican: es el IK de pies/manos) y `Animator`, que mezcla varias
      animaciones sobre el esqueleto con el mismo algoritmo que
      `LLJointStateBlender` (`llpose.cpp`). Escritor `encodeAnim` + autotest 41/41.
      Nota: las claves de posición son la traslación LOCAL del hueso en absoluto
      (así sienta SL a un avatar: la pelvis baja de sus 1.067 m de reposo).
- [x] `src/sl/bodyMesh.js` — el cuerpo/cabeza de SISTEMA: contenedor «Linden
      Binary Mesh 1.0» (`avatar_head.llm`, `avatar_upper_body.llm`…) + los
      morphs de `avatar_lad.xml` y el montaje en el esqueleto. Autotest 34/34.
- [x] `src/sl/avatarMesh.js` — el avatar real completo: sistema + mallas mesh
      adjuntas (`addMeshAsset`), adjuntos (puntos de anclaje), morphs y
      animaciones. Autotest 22/22.
- [x] `src/sl/attachments.js` — los 38 puntos de anclaje de SL y su articulación.
      Autotest 21/21.
- [x] `src/sl/avatarPose.js` — poses/animaciones a mano (quieto, andar, correr,
      saludar, sentado) para cuando no hay `.anim`. Autotest 5/5.
- [x] `src/sl/tga.js` + `src/sl/skinTexture.js` — texturas REALES del cuerpo:
      TGA (15/15) y composición de las capas de `character/` (grano de piel,
      sombreado, cejas, labios, pelo, ojos) en los materiales (24/24).
- [x] `src/sl/characterAssets.js` — descarga en tiempo de ejecución el cuerpo de
      sistema y sus 16 texturas del repositorio público del visor de Linden Lab
      (`github.com/secondlife/viewer`, LGPL); caché en memoria. Autotest 13/13.
      Es lo que NO necesita sesión: los activos clásicos son libres.
- [x] `src/realAvatar.js` + ruta `#bodytest` — el avatar real, con modos quieto,
      cara, andar, correr, saludar, sentar, huesos, morph y falda. Verificado
      con `vision`.
- [x] `src/sl/meshImport.js` — traer mallas de FUERA (`.glb`/`.gltf`/`.obj`)
      riggeadas a los huesos de SL: emparejado por nombre (con alias y prefijos
      de exportador), alineación rígida Horn/Kabsch (rotación + escala +
      traslación) y retransmisión de rotaciones Y TRASLACIONES (la malla
      acompaña el balanceo de la pelvis al andar). Autotest 17/17.
- [x] `src/meshGallery.js` + ruta `#meshtest` — banco de activos: suelta o pega
      un `.llm` (LLMESH), un `.anim` (LLKeyframeMotion) o un `.glb/.gltf/.obj`,
      botones de animación, cuerpo de referencia translúcido, vista del
      esqueleto, autoprueba (cuerpo de sistema → GLB → reimportar) y diagnóstico
      de emparejado. Verificado con `vision` y numéricamente (133/133 huesos,
      error 0 mm en reposo y al animar).
- [x] **Forma real del avatar** (`src/sl/slAppearance.js` + `src/sl/avatarLad.js`
      + `src/avatarRealBody.js` + `src/avatarParams.js`): resuelve los parámetros
      de `avatar_lad.xml` sobre el cuerpo de sistema (pesos de morph y deltas de
      hueso), deriva el **sexo del mando de género** (id 80, como
      `llvoavatar.cpp`) y aplica **bakes** por slot. Cubre **mesh legacy**,
      **Bakes-on-Mesh** y **Bento**. Editor en `src/shapeEditor.js` (cajón Forma
      del HUD) y en `#bodytest/forma`; guardado con `src/sl/shapeStore.js`.
      Verificado: `slAppearance` 23/23, `avatarLad` 47/47, y el deslizador de
      género deforma el cuerpo resuelto (comparación visual hombre/mujer).
- [x] **El modelo va dentro del APK**: `src/android/fetch-character-assets.mjs`
      descarga el cuerpo de sistema real y sus texturas al compilar y
      `characterAssets.js` prefiere ese espejo local (`character/`), así que la
      deformación funciona sin conexión (si falta, cae a la red).
- [x] **Depuración e informes** (`src/diag.js` + `android/.../VisorDiag.kt`):
      niveles, categorías, captura de errores, ventana en Ajustes e informe de
      texto (guardar/compartir/copiar), con registro nativo en el APK. Ver
      `src/DIAGNOSTICS.md`.
- [ ] Reproducir las animaciones de los residentes REMOTOS (tramas
      `S.AVATAR` + `RES.ANIM`) e integrar el cuerpo real en `src/avatar.js` (hoy
      el mundo usa el procedural `avatarBody.js`; el real está en `#bodytest`).
- [ ] `AvatarAppearance` completo desde la red: parámetros visuales, bakes
      (texturas cocidas del cuerpo/ropa) y adjuntos (puntos de anclaje).
- [ ] `llStartAnimation`/`llStopAnimation` en el mini-LSL.
- [ ] Inventario: árbol de carpetas, prender/quitar ropa y adjuntos desde el
      navegador (capabilities de inventario, `C.INVENTORY`).
- [ ] Retransmisor de verdad (lo de Fase 8): es lo único que separa al visor de
      los activos DE LA CUENTA del usuario (su inventario, sus mallas y sus
      animaciones). Lo demás ya funciona con activos libres o ficheros que el
      usuario suelte.

## Fase 10 — Cámara y HUD de juego tipo Genshin

Lo que se cambió para que la navegación sea cómoda con el pulgar, y para que
todo lo que se puede hacer tenga su botón a mano (ver "Modelo de navegación y HUD
de juego" en el README).

- [x] Cámara de tercer persona con los ejes bien: `cam.pitch` es la inclinación
      **vista** (`+` = mirar arriba) y `cam.yaw` gira a la derecha al arrastrar
      a la derecha. Antes los ejes estaban invertidos y el gesto natural hacía
      lo contrario de lo que se esperaba.
- [x] Andar y mirar a la vez de verdad: el joystick y el canvas son elementos
      distintos, cada uno con su puntero (antes el arrastre de cámara y el
      joystick se pisaban).
- [x] Joystick **flotante**: el anillo aparece bajo el dedo y vuelve a su sitio
      al soltar; la base se recorta contra la pantalla, no contra su recuadro
      (si no, un toque cerca del borde daba velocidad máxima de golpe).
- [x] Racimo de acciones en arco, como un MOBA: Saltar (grande, con aro suave),
      Correr y Volar; al volar, Subir/Bajar ocupan su sitio. Botones circulares
      translúcidos, con estado `.on` y sin texto que se corte.
- [x] HUD de juego (`src/gameHUD.js`): minimapa arriba a la izquierda, carril de
      siete botones a la derecha (Inventario, Armario, Mapa, Sitios, Construir,
      Chat, Ajustes) y cajones con fondo oscurecido en el móvil.
- [x] Mapa de la región con marcador de destino, zoom, centrar, vista de región
      y **Ir aquí** (teleporta por la sesión o directo).
- [x] Sitios: los `landmarks` de la región + los que guarda el usuario en
      `kv.sitios`, con ir/guardar/borrar.
- [x] Armario (`src/wardrobe.js`) accesible desde el carril: cuerpo, cara, piel,
      pelo y ropa (parte de arriba/abajo, abrigo, calzado, sombrero, gafas) con
      tejidos y conjuntos guardados.
- [x] Franja superior del móvil compacta: el menú de rutas pasa a una sola
      línea que se desliza con el dedo, y la franja de datos del visor nace
      plegada (un toque la despliega).
- [x] Repaso de solapes y capas a 390×844, 844×390 y 1920×1080 (minimapa, carril,
      joystick, racimo, chat, editor de construcción), verificado con `vision` y
      midiendo las cajas con `getBoundingClientRect`.

## Fase 11 — App Android

- [x] Proyecto Android escrito en `src/android/` y `scratch/visor-sl-app/`:
      WebView + servidores locales que sirven el visor. Ver `src/ANDROID.md`.
- [x] Puente de depuración e informes en la app (`VisorDiag.kt`): `window.VisorDiag`,
      informes en `Android/data/org.visor.sl/files/informes/`, compartir por texto
      y registro nativo. Ver `src/DIAGNOSTICS.md`.
- [x] El modelo del avatar dentro del APK (`fetch-character-assets.mjs` en el
      flujo de compilación) para que la forma funcione sin conexión.
- [x] **Puente UDP** (`UdpBridgeServer.kt`): WebSocket local + `DatagramSocket`
      (1 trama binaria = 1 datagrama). Sustituye al antiguo `RelayServer.kt` +
      `FrameCodec.kt`, que se borraron. `MainActivity` carga el visor con
      `?udp=ws://127.0.0.1:PUERTO#sl`.
- [x] Compilar el APK (GitHub Actions, flujo `Compilar APK`): el run nº 9 salió
      en verde el 2026-09-18. La APK se descarga del artefacto del propio run.
- [x] Primer informe del móvil y arreglo de lo que salió: el usuario vio «se ha
      perdido el enlace con el retransmisor · enlace cerrado (1000)». Eran dos
      fallos del vigilante de latido del enlace: los parones del WebView contaban
      como silencio, y un enlace *callado* (lo normal estando ya dentro) se
      mataba solo porque el latido solo se mandaba con el contador de silencio a
      cero (ver «Enlace y parones del móvil» en el README). Arreglado: parones
      perdonados, el enlace ahora se pregunta siempre y muere solo si un latido
      no se contesta, relogin automático al volver el enlace (aunque te pille a
      mitad de entrar), aviso de circuito caducado y el puente UDP visible en el
      informe. Verificado en vivo: 45 s seguidos dentro sin caerse, y caída
      forzada recuperada en ~0,8 s. Falta volver a compilar el APK y probarlo.
- [x] **Segundo informe del móvil** (17:21): el arreglo del latido funciona
      (`enlace: ready`, sin «enlace cerrado»), y salió el bloque `puente` del
      informe con el fallo de verdad: **`sendto failed: EINVAL`** en los diez
      envíos, con el socket atado a `127.0.0.1`. Un socket atado al bucle no
      puede salir a internet: el kernel rechaza cada `sendto` a la IP pública del
      simulador, así que el circuito se abría, mandaba sus diez paquetes y ninguno
      salía del teléfono (`datagramasIn: 0`). Arreglado abriendo el socket con
      `DatagramSocket(0)` (comodín `0.0.0.0`), registrando dirección y familia del
      socket, agrupando los fallos de envío en el registro nativo y avisando al
      visor (`{"sendError":…}` → `erroresEnvio`/`ultimoErrorEnvio` en el informe y
      en el mensaje de error de la sesión). Autotest 21/21 en `udp.js`. Versión de
      la app 0.1.1 y `DIAG_VERSION` 1.1, para que el próximo informe diga si la
      APK nueva es la que está corriendo. Falta compilar y probar en el móvil.

## Fase 12 — Núcleo LLUDP (mundo real)

Todo el protocolo de Second Life en JavaScript (`src/sl/lludp/`), con el nativo
reducido a mover datagramas. Ver "Modelo del núcleo LLUDP" en el README y
`src/VIEWER-REAL.md`. **864 comprobaciones en verde (14 suites).**

- [x] Plantillas del protocolo (`templates.js`, 483 mensajes) y códec binario
      (`codec.js`), verificados contra datagramas REALES (`recapturas.js`) y
      vectores de campos (`vectors.js`).
- [x] Circuito UDP (`circuit.js`): secuencia, pendientes, reenvíos, acks de
      gorra, ping y RTT.
- [x] Terreno (`terrain.js`, DCT/IDCT) y objetos (`objects.js`: `ObjectUpdate`,
      comprimido, terse, `TextureEntry`).
- [x] Agente (`agent.js`) y el retransmisor (`gateway.js`), que traduce entre
      `relay.js` y LLUDP.
- [x] Simulador de región en JS (`sim.js`) que habla LLUDP de verdad: la
      especificación ejecutable del lado servidor.
- [x] Transportes (`udp.js`): par en memoria y el puente WebSocket de la app.
- [x] Modo `?udp=sim` y cableado del modo real en la pantalla de arranque.
- [x] Verificado de extremo a extremo: login → circuito → 256 parches de
      terreno, decenas de prims, 18 residentes; **chat, toque y movimiento**
      (AgentUpdate) con ida y vuelta contra el simulador.
- [ ] `caps.js`: *seed capability* + LLSD + EventQueueGet (inventario, IM,
      descarga de assets).
- [ ] Decodificador **JPEG2000**: texturas de prims y bakes (BoM).
- [ ] Cambio de región (teletransporte a otro simulador: circuito nuevo).

## Deuda / notas
- El anillo converge despacio al volumen de Pappus con el LOD (es un artefacto
  de la sección poligonal, no un fallo): 0.01427/0.01216/0.01155/0.01059/0.00989
  en detalle 1/2/4/8/16.
- `llmatrix4a.inl` y `llmatrix3.cpp` no están disponibles en la copia de
  referencia; `LLMatrix4a::rotate`/`getMatrix3` están dentro de
  `llmatrix4a.h`/`llquaternion.cpp`.
