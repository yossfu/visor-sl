# Visor de Second Life en el navegador

Un visor/editor de Second Life que corre en el navegador, con geometría de prims
**idéntica** a la de SL (port fiel del teselador de Linden Lab, `LLVolume`), y
herramientas de construcción de verdad: mover/rotar/escalar, link sets, texturas
por cara, un mini-intérprete de LSL y multijugador.

Todo el código vive en `src/` y se sirve con rutas relativas desde `index.html`.
No hay build step: son módulos ES que el navegador carga directamente.

## Estado

Fases 1 (geometría), 2 (visor), 3 (construcción), 4 (apariencia), 5 (mini-LSL),
6 (multijugador con `server-plugin`), 7 (metadatos, responsive y rendimiento),
8 (visor de Second Life de verdad, salvo el retransmisor) y 9 (avatares reales:
cuerpo de sistema, texturas, mallas `.llm` y animaciones `.anim`) terminadas y
verificadas. La única pieza que no puede vivir en el navegador —el proceso que
habla LLUDP con el simulador— sigue especificada, trama a trama, en
[`VIEWER-REAL.md`](VIEWER-REAL.md).

> **Forma del avatar (Fase 9).** El visor deforma el cuerpo real de sistema con
> los MISMOS parámetros de `avatar_lad.xml` que usa Second Life, así que el
> avatar toma la forma física que tiene en SL (altura, corpulencia, cara), y está
> preparado para las tres familias de avatar: **mesh legacy** (el cuerpo clásico
> de sistema), **Bakes-on-Mesh** (las texturas cocidas se aplican por uuid) y
> **Bento** (el esqueleto de 133 huesos y los parámetros de Bento). Ver "Modelo
> de la forma real del avatar (SL, Bento y BoM)".

> **Depuración e informes.** Hay una sección en Ajustes que cuenta lo que pasa
> (niveles, categorías, errores capturados, estado de los subsistemas) y genera
> un informe que se guarda/comparte/copia. En el APK el informe se escribe en una
> carpeta del teléfono y se puede mandar. Ver [`DIAGNOSTICS.md`](DIAGNOSTICS.md).

> **App Android (fase 10).** Para tener el visor en el movil sin depender de un
> retransmisor externo se esta construyendo una app Android que lleva el visor
> dentro (WebView + servidores locales) y un nucleo nativo que abriria el socket
> UDP. El diseno completo y las fases estan en [`ANDROID.md`](ANDROID.md), y el
> proyecto Android ya escrito vive en [`android/`](android/) (su README explica
> como compilarlo o subirlo a GitHub para que lo compile Actions).

> **Fase 8 — visor real.** `src/sl/` trae el lado del navegador de un visor de
> Second Life: login real (`login.js`), protocolo y transporte con el
> retransmisor (`relay.js`), sesión (`session.js`), pantalla de arranque
> (`startPanel.js`) y un simulador de pruebas que sirve una región inventada
> desde el propio navegador (`mockServer.js`). Lo único que no puede vivir en el
> navegador —el proceso que habla LLUDP con el simulador— está especificado en
> [`VIEWER-REAL.md`](VIEWER-REAL.md), trama a trama.

- [x] `src/llvolume.js` — port del teselador de LL (`generateVolume`).
- [x] `src/prims.js` — tabla de formas de SL y `PrimParams` (los campos del
      "build floater"), más el catálogo de casos de prueba (`primCaseList()`).
- [x] `src/llvolume.selftest.js` — **489 comprobaciones** (volúmenes exactos por
      caso, invariantes topológicos, convergencia de Pappus). Todas pasan.
- [x] `src/primMesh.js` — `BufferGeometry` de three.js desde `generateVolume`
      (+ un grupo por cara, + caché por `key(lod)`).
- [x] `src/primGallery.js` + ruta `#primtest`: galería de las 7 formas y las
      variantes de parámetros, etiquetada, más la **sonda de píxeles**
      (`probeVolumes`) que verifica automáticamente el winding de todas las mallas.
- [x] `src/region.js` — terreno 256×256 m con malla, **pads de terreno** (la
      primitiva de esculpido), agua con shader de profundidad real, cielo con
      ciclo día/noche y paleta tipo WindLight.
- [x] `src/world.js` — objetos de la región (`SlPrim`): params + transform +
      caja envolvente + raycast; `serialize`/`deserialize` listos para guardar.
- [x] `src/sandbox.js` — región de ejemplo: plataforma con escalera, arco de 8
      prims del catálogo, casa con solar aplanado, árboles, lago esculpido y
      muelle con barandilla.
- [x] `src/avatar.js` — avatar con física: andar/correr/volar, salto de 1.07 m,
      escalones de 0.5 m, colisión OBB contra prims y contra el terreno.
- [x] `src/viewer.js` + `src/app.js` — cámara tipo SL (seguir/libre), control
      teclado+ratón y táctil (joystick + botones), calidad adaptativa, HUD.
- [x] `src/minimap.js` — el dibujo del mapa (región, prims, residentes, sitios y
      el avatar con su rumbo) reutilizado por el minimapa y por el mapa grande.
- [x] `src/gameHUD.js` — HUD de juego: minimapa, carril de menús y los cajones
      de inventario, armario, mapa, sitios y ajustes. Ver "Modelo de navegación
      y HUD de juego".
- [x] `src/wardrobe.js` — el armario (cuerpo, cara, piel, pelo y ropa) con
      conjuntos guardados en `kv`.
- [x] `src/build.js` — herramientas de construcción: selección por raycast con
      resaltado de cara (cian al pasar, naranja la elegida), gizmo de
      mover/rotar/escalar con rejilla, panel de parámetros en vivo (por grupos y
      solo los que aplican a la forma), color con paleta, crear/duplicar/borrar,
      deshacer/rehacer, y panel plegable para el móvil.
- [x] Link sets en `src/world.js` + `src/build.js` — ver "Modelo de link sets".
- [x] `src/store.js` — persistencia sobre el plugin `kv`: región (autoguardado
      con retardo, cargar, exportar/importar JSON) e inventario (guardar prim,
      rezar, borrar).
- [x] Esculpido de terreno en `src/terrainTools.js` sobre la capa `terrain.sculpt`
      de `src/region.js` — ver "Modelo de esculpido de terreno".
- [x] `src/faces.js` — `FaceSpec` por cara (patrón, tinte, UV, alfa, glow,
      rugosidad, metalicidad, emisivo) con `facesToJson`/`facesFromJson`.
- [x] `src/textures.js` — 20 texturas procedurales + mapas de normales +
      miniaturas, generadas en canvas (sin ficheros ni red).
- [x] `src/appearance.js` — panel "Apariencia": rejilla de texturas, paleta de
      colores, deslizadores de UV/alfa/glow/PBR — ver "Modelo de apariencia".
- [x] `src/lsl/` — mini-intérprete de LSL: `lexer`, `parser`, `interp` (con
      presupuesto de pasos y de tiempo por evento), `values`, `builtins`
      (~120 `ll*` + tabla de lo no soportado) y `constants`. Autotest
      `runLslSelfTest()` → 92/92.
- [x] `src/lsl/runtime.js` — puente intérprete ↔ mundo: transformadas en
      coordenadas de región, chat con alcances de SL, `llSetText` y burbujas
      como capas DOM, touch con el puntero, timers, sensores, `llTargetOmega`
      — ver "Modelo de scripting".
- [x] `src/lsl/examples.js` + `src/lslPanel.js` — 8 scripts de ejemplo, editor
      por prim y chat local (ver "Modelo de scripting").
- [x] `src/net.js` + `src/peers.js` + el `<script type="text/x-server-plugin">`
      de `index.html` — multijugador: región compartida, avatares remotos y
      chat en red (ver "Modelo multijugador").
- [x] `src/sl/` — **visor de Second Life de verdad** (Fase 8). Ver
      [`VIEWER-REAL.md`](VIEWER-REAL.md) y "Modelo del visor real":
      - `src/sl/bin.js` — `Writer`/`Reader` little-endian (uuid = 16 bytes).
      - `src/sl/md5.js` — MD5 y `slPasswordHash` (`"$1$"` + MD5); 6/6.
      - `src/sl/llsd.js` — XML-RPC/LLSD y notación LLSD; 25/25.
      - `src/sl/login.js` — login real vía `superFetch`; 21/21.
      - `src/sl/relay.js` — protocolo (`C.*`/`S.*`) y transporte WebSocket;
        26/26.
      - `src/sl/mockServer.js` — retransmisor de pruebas (región inventada);
        19/19.
      - `src/sl/session.js` — puente enlace ↔ mundo.
      - `src/sl/startPanel.js` — pantalla de arranque con los tres modos.
      - `src/sl/skeleton.js` — el esqueleto de SL (`avatar_skeleton.xml` v2.0, 133
        huesos + 26 volúmenes de colisión, port literal), base de las mallas y
        animaciones reales (Fase 9); autotest 32/32.
      - `src/sl/llmesh.js` — mallas de SL (activo `LLMESH`, `.llm`): cabecera LLSD
        + bloques zlib, LODs, submeshes, piel (`SkinInfo`) y colisión convexa →
        `SkinnedMesh` de three.js; autotest 24/24.
      - `src/sl/anim.js` — animaciones de SL (`.anim`): rotaciones y posiciones
        por hueso, prioridades, bucle, `ease` y mezcla sobre el esqueleto;
        autotest 41/41.
- [x] `src/avatarRealBody.js` + `src/sl/slAppearance.js` + `src/sl/avatarLad.js` —
      la **forma real** del avatar: resuelve los parámetros de `avatar_lad.xml`
      sobre el cuerpo de sistema (morphs y deltas de hueso), deriva el **sexo del
      mando de género** (como el visor de SL) y aplica **bakes** por slot (BoM).
      Editor en `src/shapeEditor.js` (cajón **Forma** del HUD) y en
      `#bodytest/forma`; la forma se guarda con `src/sl/shapeStore.js` y viaja
      con el avatar. Ver "Modelo de la forma real del avatar (SL, Bento y BoM)".
- [x] `src/diag.js` — **depuración e informes**: niveles, categorías, captura de
      errores, ventana en Ajustes y el informe de texto (guardar/compartir/copiar);
      en el APK se apoya en `android/.../VisorDiag.kt`. Ver
      [`DIAGNOSTICS.md`](DIAGNOSTICS.md).
- [x] `$meta` en `main.pjs` — título, descripción, `image` (captura real del
      visor) y etiquetas. `main.pjs` solo lleva el `$meta` y los dos imports de
      plugins; no hay listas de plantilla.

Ver `SPEC.md` (qué debe hacer) y `TODO.md` (orden de trabajo).

## Modelo de navegación y HUD de juego

La navegación imita a la de Genshin Impact: tercer persona, un dedo mira y el
otro anda, y todo se puede hacer **a la vez**. Tres piezas:

- **La cámara** (`src/viewer.js`). `cam.yaw` es el rumbo y `cam.pitch` la
  inclinación **vista** (`+` = mirar hacia arriba); la cámara se coloca con
  `cam.pos = objetivo − dir·dist`, donde `dir = (−sin(yaw)·cos(pitch),
  sin(pitch), −cos(yaw)·cos(pitch))`. Arrastrar un dedo o el ratón gira: hacia
  arriba mira arriba y hacia la derecha gira a la derecha (`cam.yaw -= dx·sens`,
  `cam.pitch -= dy·sens`), que es la convención que espera cualquiera que haya
  jugado a un juego de mundo abierto. La rueda o la pinza de dos dedos acercan
  (`cam.dist`, entre `cam.min` y `cam.max`); al acercarse mucho, el avatar se
  oculta para que la cámara no acabe dentro de la cabeza. Ajustes guardados en
  `kv.ajustes` (clave `camara`): `invertY`, `sens`, `fov` y la calidad.
- **El joystick flotante** (`#joyPad` → `#joyBase`/`#joyKnob`). La mitad
  izquierda de abajo es la zona del joystick; al apoyar el dedo el anillo
  **aparece debajo** (no hay que acertarle a un círculo fijo), el vector sale del
  centro y al soltar vuelve a su sitio (`parkStick`). La base se centra donde
  cayó el dedo y solo se recorta para que quepa en la pantalla: si se recortara
  contra el recuadro del joystick, un toque cerca del borde daría velocidad
  máxima de golpe. Empujar al borde (`|v| > 0.92`) corre.
- **El racimo de acciones** (`#actCtn`, abajo a la derecha), en arco alrededor
  del botón grande como el ataque de un MOBA: **Saltar** (80 px, con un aro
  suave), **Correr** a su izquierda y **Volar** encima. Al volar, Correr deja su
  sitio a **Subir** y **Bajar** (`body.avatar-flying`). Los botones que se
  mantienen pulsados (subir/bajar) usan `holdBtn`, con `pointerup`,
  `pointercancel` y `pointerleave`, para que no se queden pegados.

El canvas y el joystick son **elementos distintos**, así que cada uno lleva su
propio puntero: andar y mirar a la vez funciona de verdad (no es un `if` de
"mientras ando no miro"). Los dos dedos del canvas sí se cuentan juntos (pinza).

El HUD de juego (`src/gameHUD.js`) cuelga de `#gameUi` (capa `pointer-events:
none` con hijos que sí los reciben):

- **Minimapa** arriba a la izquierda, con el nombre de la región, la rejilla y
  los sitios; al tocarlo se abre el mapa grande. Se coloca **debajo de la barra
  del HUD** (`placeMini`) porque esa barra cambia de alto; en el móvil nace
  plegada (`body.foot-fold`) y se despliega con un toque.
- **Carril** (`#gRail`) con siete botones en el borde derecho: Inventario,
  Armario, Mapa, Sitios, Construir, Chat y Ajustes. Los cinco primeros abren un
  **cajón** (`#gPanelCtn`, con fondo oscurecido en el móvil y `Escape` para
  cerrar); Construir y Chat actúan sobre lo que ya existe (`#buildToggleBtn` y el
  chat local).
- **Mapa** (`gMapCanvas`): el mismo dibujo que el minimapa, con marcador de
  destino, zoom, "Centrar en mí", "Región" y "Ir aquí" (que llama a
  `session.teleport` si hay sesión, o a `viewer.teleport`). Tocar marca el
  destino; arrastrar mueve el mapa.
- **Sitios**: los lugares de la región (los `landmarks` de `src/sandbox.js`) más
  los que guarda el usuario en `kv.sitios`; tocar uno lleva allí.
- **Ajustes**: cámara (invertir el eje, sensibilidad, campo de visión),
  hora del día, calidad (automática o a mano) y el recordatorio de controles.

Z-order, que tiene su gracia porque estas capas se pisan: `#touchCtn` 12 (mando),
`#gameUi` 13 (minimapa y carril) y `#gPanelCtn` 14 (cajones). En el móvil, con el
editor de construcción abierto, `#gameUi` **baja a 10** para quedar por debajo de
`#buildCtn` (11): lo que el editor tapa deja de robarle el toque, y lo que no
tapa sigue vivo. En horizontal (`max-height: 520px`) el carril se tumba encima
del racimo de acciones y el chat se arrima a la izquierda para no meterse debajo.

### El menú de rutas en el móvil

La clase `body.touch` la pone **`src/app.js` al cargar** (`const TACTIL`), no
`viewer.js` al montarse: la pantalla de entrada (`#sl`) no monta visor y se
quedaba sin ella, así que dentro de la app Android salía la maqueta de
escritorio. No basta con mirar `(pointer: coarse)` (algunos WebView no lo
anuncian): también se cuenta `maxTouchPoints` + `(hover: none)` y, si está
`window.__SL_APP__.android`, se da por hecho.

En táctil, `<nav>` (que tiene id `#hudNavEl` precisamente por esto) **se mueve al
`<body>`** desde `gameHUD.js` y pasa de ser una tira de enlaces siempre visible a
un **cajón** que abre el botón `☰` (`#hudMenuBtn`) y cierra el telón
`#hudMenuBackdrop` (z 41/42, por encima del carril y del mando). Se mueve al
`<body>` porque los `.hud` llevan `backdrop-filter`, que crea su propio contexto
de apilado: dentro de la barra el cajón quedaría **debajo** del minimapa y del
carril. La posición vertical se mide al abrir (`#hudTopCtn` cambia de alto al
plegarse la línea de datos).

Los datos del visor van partidos en dos: `#viewStatEl` (dónde estás) y
`#hudInfoEl` (velocidad, hora, prims, distancia, calidad). En el móvil la franja
nace plegada y solo se ve la primera parte, de modo que el plegado sirve de algo.
`#hudPerfEl` (ruta, tris, fps) se movió del alto a esa misma línea para dejar la
barra limpia, junto con el botón Construir (que ya está en el carril) y la
leyenda de teclas de Ajustes (`.gKeys`).

## Rutas de la app
- `#primtest` — galería 3D orbitable de los 21 casos (7 formas + variantes).
- `#primtest/hoja` — hoja de contactos cenital con etiquetas.
- `#primtest/<forma>` — una forma base aislada y girando (`box`, `cylinder`,
  `prism`, `sphere`, `torus`, `tube`, `ring`).
- `window.__app.mount.focusCase(i)` aísla por índice cualquier caso del catálogo;
  `window.__app.probe()` ejecuta la sonda de píxeles.
- `#sl` — pantalla de arranque del visor real (Fase 8): modo de sesión, modo por
  retransmisor y simulador de pruebas. En el navegador la ruta por defecto es
  `#viewer` y se llega a `#sl` desde el menú; en la **app Android** (`MainActivity`)
  la app abre directamente `#sl`, que es donde está el formulario de entrada y
  donde `env.js` deja ya relleno el retransmisor interno.
- `#bodytest[/modo]` — el **avatar real** (cuerpo de sistema + texturas), con
  modos `quieto`, `cara`, `pose`, `correr`, `saludar`, `sentar`, `huesos`,
  `morph`, `falda`.
- `#avatartest` — galería de avatares procedurales (el respaldo).
- `#meshtest` — banco de **activos de fuera** (Fase 9): suelta o pega un `.llm`
  (malla de SL), un `.anim` (animación real de SL) o un `.glb`/`.gltf`/`.obj`
  riggeado a los huesos de SL, y se monta sobre el esqueleto; incluye la
  «Autoprueba» (exporta el cuerpo de sistema a GLB y lo vuelve a importar),
  botones de animación, vista del esqueleto y diagnóstico de emparejado.

## Cómo correr el selftest

No tiene dependencias: recibe los namespaces de `llvolume.js` y `prims.js`.
Desde un worker (por ejemplo la herramienta `execute_js`):

```js
const llURL = URL.createObjectURL(new Blob([await fs.readTextFile("src/llvolume.js")], {type:"text/javascript"}));
const ll = await import(llURL);
const primsSrc = (await fs.readTextFile("src/prims.js")).replace("./llvolume.js", llURL);
const prims = await import(URL.createObjectURL(new Blob([primsSrc], {type:"text/javascript"})));
const st = await import(URL.createObjectURL(new Blob([await fs.readTextFile("src/llvolume.selftest.js")], {type:"text/javascript"})));
return st.runSelfTest(ll, prims).summary; // -> "llvolume selftest: all 489 checks passed"
```

El mismo patrón (Blob URL + reemplazo del import relativo) sirve para probar
cualquier módulo de `src/` en un worker sin DOM ni service worker.

## Verificación visual automática (sonda de píxeles)

Un triángulo con el *winding* invertido no rompe el volumen firmado (se cancela
con el signo del vecino), pero en un visor que descarta caras traseras deja un
agujero por el que se ve el fondo. Por eso `probeVolumes()` (en
`primGallery.js`, expuesta como `mount.probeCases()` / `window.__app.probe()`)
mide píxeles: renderiza cada malla tres veces contra fondos conocidos y desde la
misma cámara, encuadrada por su caja envolvente.

1. sombreada `DoubleSide` sobre negro → luminancia media (una malla con el
   winding *global* invertido sale oscura entera: las normales apuntan hacia
   dentro).
2. blanca `DoubleSide` sobre negro → máscara de la silueta.
3. sombreada `FrontSide` sobre magenta → los píxeles magenta dentro de la
   silueta son agujeros (triángulos descartados al revés).

Se ignoran los píxeles del borde (se exige que los 4 vecinos estén dentro de la
silueta) para no contar el antialias. La sonda se **autovalida** con tres casos
de calibración: media malla invertida (tiene que dar `holeFrac > 0.05`), malla
entera invertida (tiene que salir oscura) y malla colapsada (no debe dibujar
nada). Si la calibración falla, devuelve `calibrated: false` y sus medidas no
valen nada. Resultado actual: **calibrada, 21/21 casos sin fallos**, `holeFrac`
0, `darkFrac` 0 y `zeroNormals` 0 en todos — incluidos los huecos (el interior
del hueco se ve porque las caras internas están orientadas hacia la cavidad) y
los cortes de path/perfil.

## Modelo de esculpido de terreno

El terreno de SL no se guarda como alturas absolutas sino como **parches**
(`LLPatch`) de 2×2 m con un perfil de 4 bytes por vértice. Aquí hay tres capas,
en este orden de aplicación (`Terrain.heightAt`):

1. `Terrain.base` (`Float32Array` de 129² en metros) — el ruido base.
2. `Terrain.pads` — los parches de modelado (`addPad(x, z, {radius, height,
   falloff, wobble, bowl})`): la primitiva con la que se construyó el lago, el
   solar de la casa y los montículos del ejemplo.
3. `Terrain.sculpt` (nuevo) — lo que pinta el usuario. Capa **aditiva** de
   `Int16` en centímetros que solo existe para las regiones tocadas (se asigna
   la `Float32Array` la primera vez). `applyPads()` termina llamando a
   `applySculpt()`, así que `refreshMesh()`/`heightAt` la ven sin cambios.

- `Terrain.encodeSculpt()` / `decodeSculpt(rec)` serializan la capa a base64 de
  `Int16` cm (≈44 KB en claro para una región entera, y solo se codifican los
  vértices con delta ≠ 0). Es lo que guarda el autoguardado/exportación junto a
  los prims (`regionState()` en `build.js`).
- `Terrain.refreshRegion(i0, i1, j0, j1)` reconstruye **solo el trozo** de malla
  tocado y recalcula normales analíticas; `vertexRange(x0, x1, z0, z1)` traduce
  un rectángulo en metros al rango de índices. Un trazo típico son ~1 ms.
- `src/terrainTools.js` implementa el pincel. Lo importante:
  - **Ray-march analítico** (`marchTerrain`): recorre el rayo por el interior de
    la caja XZ de la región con bisección sobre `heightAt`, con salida temprana
    si el rayo va hacia arriba y ya está por encima de `terrain.peak`. Mide
    **0.011 ms** y coincide con el `Raycaster` contra la malla con error
    < 0.0001 m (el `Raycaster` tardaba 5 ms y hacía inusable el pincel).
  - Perfil de pincel `1 − smoothstep(0.55R, R, d)`, dabs espaciados 0.35R, y
    `beginStroke/endStroke` que guardan el **diff** (`Float32Array` de la capa
    solo en el rectángulo tocado) para deshacer/rehacer en 1.2 ms.
  - 6 herramientas: Subir, Bajar, Aplanar, Alisar, Rugosidad y Revertir.
  - Selección por rectángulo ("Rectángulo" + "Aplicar a la selección") con peso
    que decae desde el borde del rectángulo.
  - El modo `terrain` del panel se pinta igual que los demás modos (ver
    `setMode` en `build.js`), y **bloquea la cámara** (`cam.locked = true`)
    mientras se pinta: los manejadores de puntero de `viewer.js` salen antes
    cuando `cam.locked`.

En el móvil el panel no cabe: `autoFold()` pliega las secciones que no tocan y
`scrollPanelTo()` pone delante (debajo de la barra de estado) la que se está
usando, de modo que el pincel siempre se ve entero.

## Modelo de apariencia

Cada prim tiene `faces`: un `FaceSpec` por cara (un prim de caja tiene 6, el
toro 3, etc.). Un `FaceSpec` describe **sólo el material**, nunca geometría:

```
{ pattern, color, repeat:[u,v], offset:[u,v], rotate, alpha, glow,
  roughness, metalness, emissive }
```

- Si `pattern` es `null` la cara usa el color del prim (`SlPrim.colorHex`),
  como en SL (la textura por defecto de un prim es blanca y el color la tiñe).
  El tinte por cara multiplica la textura, también como en SL.
- `src/textures.js` genera 20 patrones procedurales en canvas (madera, ladrillo,
  metal, oro, hierba, arena, agua, piedra, mármol, tela, ...) con su **mapa de
  normales** calculado a partir de la luminancia (derivada de Sobel) y una
  miniatura para la rejilla del panel. No hay ningún fichero de imagen: todo se
  dibuja al arrancar.
- **Metalicidad y entorno**: con `metalness` alto, el color del material es su
  *reflectancia* y sin un mapa de entorno no hay nada que reflejar → el objeto
  sale negro. Por eso `viewer.js` cocina el cielo a un `envMap` con
  `PMREMGenerator.fromScene` y lo pone en `scene.environment`; los patrones
  metálicos usan una base **clara** (≈0.88) precisamente por esto. La cocción
  sólo se repite cuando el tramo del sol cambia (`round(sunElev*6)`, mínimo 3 s
  entre cocciones), no en cada frame.
- `ENV_INTENSITY` (exportado por `src/region.js`) es el único factor de ambiente
  compartido por terreno, agua, prims y avatar (`envMapIntensity`); al cocinar el
  entorno, `applySky` baja la luz hemisférica por `env.ambientFactor` para no
  contar el ambiente dos veces.
- **Caché de materiales** (`src/world.js`): los `MeshStandardMaterial` se
  reutilizan por `key(cara)` (patrón + parámetros) con poda LRU, así que 120
  prims con texturas repetidas no crean 120 materiales; las texturas cargadas de
  forma diferida (`onTextureLoaded`) avisan para repintar.
- El panel (`src/appearance.js`) se pliega para el móvil; al tocar **otra** cara
  de un prim ya seleccionado, `revealAppearance()` despliega la sección y hace
  scroll hasta ella (`scrollPanelTo`).
- **Persistencia**: `facesToJson`/`facesFromJson` viajan en el autoguardado, en
  la exportación JSON y en el inventario (`primToItem` guarda `faces`, `rezItem`
  llama a `restoreFaces`), así que un prim guardado conserva su apariencia.

## Modelo de link sets

Un prim tiene `parent` (`null` = raíz del conjunto) y `local` (`Matrix4`
relativa a la raíz) además de su `position`/`rotation`/`scale` de mundo. Las
reglas que hay que respetar al tocar esto:

- `world.link(children, root)`, `world.unlink(set)`,
  `world.applyLinkRoot(root)`, `world.refreshLinkLocals(root)`,
  `world.linkSetOf(prim)`, `world.isRoot(prim)`, `world.linkRootFor(prim)`.
- Mover/rotar/escalar la raíz mueve a los hijos; mover un hijo **rompe** el
  conjunto solo si se pide explícitamente (por eso el gizmo actúa siempre sobre
  la raíz y el arrastre mueve el conjunto entero).
- `serialize()` guarda `parent` como índice y `local` como los 16 números de la
  matriz; `deserialize()` reconstruye en dos pasadas (primero todos los prims,
  después los padres).
- `setBox(set)` da la caja envolvente del conjunto: es la que se dibuja y sobre
  la que actúa "stretch"; `unlink` conserva las transformadas de mundo exactas.

## Modelo de scripting (mini-LSL)

El contenido de un objeto es un script LSL, como en SL: `prim.script` es la
fuente, y el runtime la compila y la arranca. Cuatro piezas:

- **`src/lsl/` — el lenguaje.** `lexer.js` → `parser.js` → `interp.js` sobre
  `values.js` (Vec/Rot/listas que no anidan) y `builtins.js` (~120 `ll*`).
  Subconjunto soportado: los seis tipos, `vector`/`rotation`/`list`, casts,
  ternario, `if/for/while/do`, funciones propias, `state`, y los eventos
  `state_entry`, `state_exit`, `touch`/`touch_start`/`touch_end`, `timer`,
  `listen`, `sensor`, `no_sensor`. `LslError` lleva línea y columna.
- **Presupuesto.** Cada evento corre como mucho 300 000 pasos y 40 ms, y la
  pila de llamadas está limitada a 64. Un desbordamiento lanza `LslBudgetError`
  y se lleva el evento por delante, **no** el script: el mundo no se puede
  colgar por culpa de un script.
- **`src/lsl/runtime.js` — el puente.** Las coordenadas que ve el script son
  las de SL (región de 256 m con el origen en la esquina, `<128,128,0>` =
  centro) y se convierten con `slToThree`/`threeToSl`; las rotaciones con
  `slRotToThree` (basis `X90`). El chat usa los alcances reales (susurro 10 m,
  decir 20 m, gritar 100 m, región e IM al dueño) y marca lo que queda fuera de
  alcance; `llSetText` y las burbujas son capas DOM proyectadas desde el bucle
  de render. `update(dt)` también mueve los timers y aplica `llTargetOmega`.
- **Sin red y sin lo imposible.** `llHTTPRequest`, `llSleep`, `llDialog`,
  `llRezObject`, sonidos, animaciones, permisos o economía **avisan por la
  consola y siguen** (`unsupported` en `builtins.js`): un script traído de SL
  se puede pegar casi tal cual y lo que no se puede hacer se ve en la consola en
  vez de romper.

Dos frenos anti-bucle, porque en SL este bucle es real y aquí colgaría la
pestaña: un presupuesto de 20 líneas por segundo y prim, y una profundidad
máxima de 12 para la cadena decir → oír → decir.

Detalle heredado de LSL: no hay `float` separado de `integer` (los dos son
números de JS), así que `(string)5.0` da `"5"` y no `"5.000000"`. Los tests
asumen ese comportamiento.

## Modelo del visor real (Fase 8)

El visor puede, además de su región local y del multijugador, **entrar en una
región de Second Life de verdad**. La pieza que no puede vivir en el navegador
—el proceso que habla LLUDP con el simulador— está especificada en
[`VIEWER-REAL.md`](VIEWER-REAL.md). Lo que sí vive aquí:

- **`src/sl/login.js`** — login real: XML-RPC `login_to_simulator` a
  `login.agni.lindenlab.com` (o aditi) a través de `superFetch` (el servidor de
  Linden Lab no manda CORS). La contraseña nunca viaja en claro: se manda
  `"$1$" + MD5(contraseña)` (`src/sl/md5.js`), como cualquier visor, y no se
  guarda en ningún sitio. La respuesta trae `agent_id`, `session_id`,
  `secure_session_id`, `circuit_code`, la región de destino y
  `seed_capability`; `relayCredentials()` extrae justo lo que necesita el
  retransmisor.
- **`src/sl/relay.js`** — el protocolo y el transporte. Una trama = un mensaje
  de WebSocket, `[u8 tipo][cuerpo…]` little-endian, con JSON para los cuerpos
  variables. Define `C.*` (navegador → retransmisor), `S.*` (retransmisor →
  navegador), las fases (`PHASE`), los formatos de asset (`ASSET_FORMAT`,
  incluido J2C) y los tipos de chat. El transporte tiene latido (8 s), tiempo
  de espera del latido (6 s), reconexión con espera exponencial (0.8 s → 30 s
  con fluctuación) y medida de ida y vuelta. Una URL que no sea `ws(s)://` es un
  error **fatal** (no se reintenta): reintentar una dirección imposible solo
  dejaría la interfaz girando.
- **`src/sl/session.js`** — la sesión. Pide las credenciales cuando el enlace
  está listo, reparte el trabajo por fotograma (8 parches, 24 objetos, 4 assets)
  para que una ráfaga de cientos de tramas no congele el frame, coloca al
  avatar en el punto de aparición y aplica todo al mundo por el MISMO camino
  que el multijugador (`world.applyRemote`), así que no hay dos mundos
  distintos. Manda la pose a 8 Hz y avisa al gateway al tocar un prim.
- **`src/sl/startPanel.js`** — la pantalla de arranque (`#sl`) con los tres
  modos. En el modo **sesión** el login lo hace este visor y al retransmisor
  solo le llega el identificador de sesión (la contraseña no sale del
  navegador); en el modo **credenciales** el login lo hace el retransmisor (útil
  con `token`/MFA); en el modo **pruebas** no hay red.
- **`src/sl/mockServer.js`** — un retransmisor de mentira dentro del navegador
  que sirve «Bahía de Pruebas»: terreno por parches con el mismo ruido de la
  arena, una plaza de ~72 prims, 6 residentes paseando, chat que responde,
  toque y texturas RGBA8. Habla el protocolo exacto, así que es la
  **especificación ejecutable del lado servidor** (quién manda cada trama, en
  qué orden y con qué campos).

Dos cosas que costaron un bug y están arregladas con comentario en el código:
la sesión solo se presenta **una vez por conexión** (`loginSent`) y el
simulador solo manda la región **una vez** (`regionSent`) — si no, cada cambio
de estado del enlace reenviaba el terreno entero y la cola se disparaba; y
`S.REGION_INFO` llega **después** del terreno, así que no se puede volver a
entrar en modo exterior (borraría los parches y el mundo saldría flotando). El
mapeo de parches a la rejilla se hace **en metros**, no por índice de vértice,
porque en móvil la malla tiene 2 m por vértice.

Lo que aún no usa la conversación real: editar prims de la región
(`C.OBJECT_EDIT` está definido pero el editor aún no lo manda), interfaz de
parcela, inventario/IM de grupo, animaciones y sonidos, mallas de avatar, y el
decodificador **J2C** de texturas (hoy solo RGBA8/PNG/JPEG; ver
`VIEWER-REAL.md` §9).

**Fase 9 — avatares reales.** Dibuja el avatar de verdad, no el cuerpo procedural
de `avatarBody.js` (que se queda como respaldo cuando no hay activos). Piezas:

- `src/sl/skeleton.js` — el esqueleto de SL (`avatar_skeleton.xml` v2.0, 133
  huesos + 26 volúmenes de colisión, port literal) y `buildSkeleton` para
  three.js. Es la base de mallas, ropa, accesorios y animaciones; 32/32.
- `src/sl/bodyMesh.js` — el **cuerpo/cabeza de SISTEMA**: contenedor «Linden
  Binary Mesh 1.0» (`avatar_head.llm`, `avatar_upper_body.llm`…), morphs de
  `avatar_lad.xml` y montaje en el esqueleto; 34/34.
- `src/sl/llmesh.js` — el activo **`LLMESH`** (`.llm`): cabecera LLSD + bloques
  zlib, LODs, submeshes, piel (`SkinInfo`) y colisión convexa → `SkinnedMesh`;
  24/24. Es el formato de cualquier malla de un creador (cuerpos y cabezas mesh,
  ropa riggeada).
- `src/sl/anim.js` — **`LLKeyframeMotion`** (`.anim`): curvas de rotación y
  posición por hueso, prioridades, bucle, `ease` y `Animator` (mezcla por
  prioridad, como `LLJointStateBlender`); 41/41.
- `src/sl/avatarMesh.js` — el avatar real completo: sistema + mallas adjuntas +
  anclajes + morphs + animaciones; 22/22.
- `src/sl/attachments.js` — los 38 puntos de anclaje de SL y su articulación;
  21/21.
- `src/sl/avatarPose.js` — poses/animaciones escritas a mano (quieto, andar,
  correr, saludar, sentado) para cuando aún no hay un `.anim`; 5/5.
- `src/sl/tga.js` y `src/sl/skinTexture.js` — las **texturas reales** del cuerpo:
  TGA (`tga.js`, 15/15) y composición de las capas de `character/` (skin grain,
  sombreado, cejas, labios, pelo…) en los materiales del cuerpo; 24/24.
- `src/sl/characterAssets.js` — descarga **en tiempo de ejecución** el cuerpo de
  sistema y sus texturas del repositorio público del visor de Linden Lab
  (`github.com/secondlife/viewer`, LGPL), que es de donde los saca cualquier
  visor; `cache` en memoria; 13/13.
- `src/sl/meshImport.js` — traer una malla de fuera (`.glb`/`.gltf`/`.obj`)
  riggeada a los huesos de SL: emparejado por nombre, **alineación rígida
  (Horn/Kabsch)** con escala, y retransmisión de rotaciones **y traslaciones**
  (así la malla acompaña el balanceo de la pelvis al andar); 17/17.

Lo que **no** se puede hacer sin el retransmisor: traer los activos *de una
cuenta* (inventario, mallas y animaciones que el usuario compró, bakes de su
cara). Eso exige su sesión autenticada; el camino está en `VIEWER-REAL.md` §12.
Lo que sí se trae sin sesión: el cuerpo/ cabeza de sistema y sus texturas (del
repositorio del visor) y cualquier fichero que el usuario suelte (`.llm`,
`.anim`, `.glb`, `.obj`).

## Modelo de la forma real del avatar (SL, Bento y BoM)

El objetivo no es «parecerse a mi avatar», sino que el avatar **se deforme igual
que en Second Life**: los mismos huesos, los mismos morphs y los mismos números.
No hay imitación: se usa el **cuerpo real de sistema** de Linden Lab
(`avatar_head.llm`, `avatar_upper_body.llm`…) y la **tabla real** de parámetros
(`avatar_lad.xml`), así que el resultado es el mismo cálculo que hace el visor
oficial. Si en SL mides 1.75 m con cierta corpulencia y cierta cara, aquí la
forma sale de esos mismos valores.

- **La forma es un bloque de datos** (`src/avatarParams.js`, `shape`):
  `{ v, sex, visualParams: [[id, valor], …], bakes: { slot: {uuid|texture} } }`.
  Va con el avatar (local y remoto) por el mismo camino que el resto del mundo.
- **Los parámetros se resuelven** en `src/sl/slAppearance.js` sobre
  `src/sl/avatarLad.js` (lector de `avatar_lad.xml`): pesos de morph (mallas),
  deltas de hueso (esqueleto), y de ahí la geometría. Incluye los parámetros de
  **Bento** (manos, cara, cola, alas) y los *drivers*.
- **El sexo se DERIVA del mando de género** (prueba: el deslizador de género
  cambia el cuerpo), **no** se fuerza desde la forma guardada. Esto imita a
  `llvoavatar.cpp`: el sexo sale del mando `<id 80>`, y con él se eligen los
  morphs y deltas femeninos/masculinos. Fue un bug real: `loadSnapshot()` forzaba
  el `sex` guardado y eso anulaba el deslizador; ahora, si los valores traen el
  mando de género, el modo vuelve a `"auto"` y el sexo se vuelve a derivar (y se
  vuelve a guardar como `"auto"`, así que el ciclo es estable).
- **Las tres familias de avatar están cubiertas**:
  - *mesh legacy*: es el propio cuerpo de sistema; se dibuja tal cual.
  - *Bakes-on-Mesh (BoM)*: `setBake(slot, {uuid}|textura)` sustituye el material
    de la pieza (cabeza, torso, piernas, ojos); los *slots* y su índice de
    textura son los del visor (`BAKE_SLOT`/`BAKE_TEX`). Cuando el retransmisor
    traiga los bakes cocidos por uuid, se aplican aquí.
  - *Bento*: el esqueleto de 133 huesos y los parámetros de Bento; una malla
    mesh de un creador (`.llm` o `.glb`) se ata al MISMO esqueleto y recibe la
    MISMA forma, así que el cuerpo de sistema, la cabeza mesh y la ropa se
    deforman juntos.
- **De dónde sale el modelo.** `src/sl/characterAssets.js` pide las mallas y
  texturas del repositorio público del visor (`github.com/secondlife/viewer`,
  LGPL) en tiempo de ejecución y las cachea; en perchance se piden por red
  porque no se empaquetan activos. **En la app Android, el modelo va DENTRO del
  APK**: `src/android/fetch-character-assets.mjs` lo descarga al compilar a
  `assets/viewer/character/` y `characterAssets.js` prefiere ese espejo local
  (`character/`), de modo que la deformación funciona **sin conexión**; si la
  carpeta no está, cae a la red sin cambiar nada.
- **Dónde se edita.** En el mundo, el cajón **Forma** del HUD (grupos de
  deslizadores, presets femenina/masculina, resumen) y, en la ruta de pruebas,
  `#bodytest/forma`. `src/sl/shapeStore.js` guarda la forma (kv `forma` /
  `residente` + `localStorage`) y la forma viaja con el avatar remoto.
- **Verificación**: `slAppearance` 23/23 y `avatarLad` 47/47, más una comparación
  visual hombre vs mujer (el pecho, los hombros y la cintura cambian como deben)
  y la comprobación de que el deslizador de género deforma el cuerpo resuelto.

## Depuración e informes

`src/diag.js` es el registro del visor: niveles (`ERROR`/`AVISO`/`INFO`/`DETALLE`),
categorías, anillo de 4000 líneas con deduplicación, captura automática de
errores y promesas rechazadas, y una ventana en **Ajustes → Depuración e
informes** que filtra y genera un **informe de texto** (entorno + estado + resumen
+ registro) que se guarda, comparte o copia. En el APK, `VisorDiag.kt` expone
`window.VisorDiag` y guarda los informes en una carpeta del teléfono, además de
incluir el **registro nativo** (arranque de servidores, pings del enlace, 404 del
servidor de assets). Todo el detalle, con la referencia del puente y cómo traer
los informes, está en [`DIAGNOSTICS.md`](DIAGNOSTICS.md).

## Modelo multijugador

La región puede ser **compartida** con quien esté en la página a la vez. Todo el
tráfico pasa por el socket del `server-plugin`, y el código del servidor es un
**retransmisor de bytes**: no entiende el protocolo, solo reenvía a los demás y
recuerda el historial corto y una instantánea del mundo. Toda la lógica está en
`src/net.js` (cliente) y `src/peers.js` (avatares remotos).

- **Qué viaja y qué no.** La red transporta **parámetros**, nunca geometría:
  cada cliente tesela localmente con el mismo `llvolume.js`. Se sincronizan
  prims (forma, transformada, color y caras) y el texto de los scripts; **no** se
  sincronizan en vivo el esculpido de terreno (viaja solo dentro de la
  instantánea) ni los timers/estados internos de cada script (cada cliente
  ejecuta su copia del script por su cuenta, con la misma semilla de reloj).
- **Presencia.** Cada cliente manda su transformada ~10 por segundo (solo si se
  movió > 2 cm o giró > 0.03 rad, o cada 2 s como latido) y su nombre. Los demás
  se dibujan con `Avatar` y se **interpolan** en `src/peers.js`. El bit 1 de los
  flags de pose marca "transformada de verdad": un cliente recién llegado manda
  ceros y los demás no lo dibujan en el origen hasta que tenga una posición real.
- **Chat.** Lo que dice un jugador, o el script de un prim, viaja con su canal y
  alcance. Al recibirlo, el cliente lo pinta en el chat local, dibuja la burbuja
  si tiene ese prim y se lo entrega a sus `llListen` (`receiveChat` en
  `src/lsl/runtime.js`). El chat de un script solo lo difunde **el dueño** del
  prim (`isOwner`), para que no hable una vez por cada cliente conectado.
- **Revisiones y diff-sync.** La región es una secuencia de ediciones numeradas.
  Cada cliente compara el mundo con la última firma que envió (`sig()`, es decir
  `world.recordOf()` + JSON) y manda solo lo que cambió, con lo que hace falta:
  alta (op 1), cambio (op 2) o borrado (op 3), a lo sumo 40 por tick, 3 veces por
  segundo. Al aplicar una edición ajena se anota su firma para no devolverla como
  propia (si no, eco infinito). Los prims que giran con `llTargetOmega` no
  cuentan como cambio: su cuaternión cambia cada frame, pero lo reproduce cada
  cliente, así que `sig()` manda `OMEGA_ROT` en su lugar.
- **Entrar en una región ya poblada.** Del servidor vienen tres cosas en el
  `WELCOME`: su revisión, si tiene instantánea y una **base de ids** (para que
  los ids de prims de clientes distintos no choquen). Según eso, el cliente
  descarga la instantánea, o reconstruye el mundo reproduciendo el historial, o
  si el mundo está virgen sube el suyo. La instantánea se descarga **a trozos y a
  petición** (el cliente pide cada bloque de 48 KB tras recibir el anterior): si
  el servidor la empujara entera de golpe llenaría la cola de salida. El historial
  se reproduce en orden estricto: una edición con revisión futura se guarda en
  `held` y se aplica cuando llega su turno, pidiendo el historial si hay hueco.
- **Propiedad.** Cada prim tiene `owner`: el cliente que lo creó (o el que adoptó
  los prims sin dueño al entrar). Si un jugador se va, el servidor manda `HOST`
  con su id y los prims que eran suyos pasan al cliente que queda.
- **Guardar tu mundo antes de adoptar el ajeno.** Activar "Mundo compartido"
  cuando el servidor ya tiene un mundo **descarta** tu región local (y con ella
  el terreno). Por eso `stashLocal()` la guarda en `kv` como `pre-red` antes de
  adoptar la remota, y el panel de región ofrece "↩ Mi región anterior" para
  recuperarla (`net.preRedName`). Si la activación va a adoptar un mundo y tu
  región tiene cambios (`bt.state.rev > 0`) se pide confirmación antes.
- **Interruptor "Mundo compartido".** Con él apagado sigues viendo a los demás y
  oyéndolos, pero tus prims son solo tuyos: no se suben, no se difunden y no los
  edita nadie más. El estado del interruptor y tu nombre/`userId` viven en
  `kv.perfil` (ver `loadProfile`).
- **Reconexión.** El socket se reconecta solo con espera exponencial (0.8 s →
  30 s máxima, con fluctuación aleatoria). Un cierre `4403` significa "esto no es
  perchance.org", es permanente: no se reintenta y el chip pasa a "sin conexión".
- **Solo en perchance.org, y solo guardado.** El socket del `server-plugin` solo
  existe en la página publicada; mientras el generador no se haya guardado, el
  editor usa un emulador de un solo documento, así que **no** hay varios clientes.
  Para probarlo de verdad hay que guardar el generador y abrir dos pestañas o dos
  dispositivos. El chip del HUD dice "solo" / "N en línea" y al tocarlo se cambia
  el nombre.
- **Límites.** Máximo 30 MB por instantánea (`SNAP_CAP`), 48 KB por bloque de
  subida a 40 bloques/s, 600 ediciones en `held`, y mensajes de prim de 60 KB como
  mucho. Si la región no cabe, se avisa y no se comparte.

## Reglas de fidelidad con SL (cosas que costaron descubrir)

El port no es "una aproximación parecida a SL": reproduce los detalles exactos
del código de Linden Lab, incluidos los que parecen errores:

1. **El producto de cuaterniones de LL está invertido.** `operator*(a, b)` en
   `llquaternion.cpp` calcula la Hamilton product *al revés* (`b ⊗ a`). Todos los
   usos internos (`genNGonPath`, `twist`) cuentan con ello. Si se usa un
   `quatMul` estándar, hay que pasar los argumentos **invertidos**:
   `q = quatMul(qang, twist)` y no `quatMul(twist, qang)`. Verificado
   numéricamente: `LLmul(twist, qang) · e_z` cae exactamente sobre la tangente
   del path.
2. **`genNGonPath` no aplica `-π` al ángulo por defecto** (sí en el caso
   `twist != 0`). El desfase de medio paso se aplica de otra forma. Está
   replicado tal cual.
3. **Caras internas planas: `mNumS` se duplica.** En `llvolume.cpp` las caras
   laterales internas de un hueco con perfil plano usan `2 * mNumS`, lo que
   cancela el `mNumS / 2` de `createSide`. Sin duplicarlo salen columnas
   fraccionarias y triángulos degenerados.
4. **El perfil del prisma/anillo es `PROFILE_EQUALTRI`**, no `ISOTRI`.
5. **La esfera es `PROFILE_CIRCLE_HALF` sobre `PATH_CIRCLE`** (media
   circunferencia barrida), con las tapas cerradas por el propio sweep. La forma
   "legacy" (círculo completo con ratio > 0.75) es una superficie con doble
   cobertura y no se usa.
6. **La tabla de formas** (`llpanelobject.cpp:1281`) fija holeX/holeY por forma:
   toro 0.25/0.25, tubo 1.0/0.25, anillo 0.05/0.25. Los huecos se recortan a
   [0.05, 1.0] en X y [0.05, 0.5] en Y.
7. **LOD**: `LOD_DETAIL = [1, 1.5, 2.5, 4]` con `MIN_DETAIL_FACES = 6`, así que
   en LOD 3 (el que usa el visor por defecto) el círculo es un 24-gono y
   `scaleX = scaleY = 0.5`.
8. **Se emiten triángulos degenerados** (área cero) cuando el contorno tiene
   puntos repetidos, por ejemplo en las tapas de un hueco con perfil de 3 lados.
   LL los emite y el visor los descarta al dibujar; aquí **también se emiten**
   (no se borran: borrarlos renumera las caras y rompe la correspondencia con
   los `faceID` de SL). `isDegenerateTriangle`/`degenerateCount` los cuentan y el
   invariante de orientación los ignora (un triángulo de área cero no tiene
   winding que valga).
9. **Orientación de los triángulos** (el punto más delicado del port). LL asume
   que su winding ya es correcto, pero al reproducirlo aparecen tres familias de
   triángulos con el signo ambiguo, porque el "hacia fuera" no está definido de
   forma única en un contorno con hueco:
   - **Tapas (`buildCap`)**: la referencia de fuera es ahora la **normal exacta
     del plano de la tapa**, `n = quatRotate(pth[base].q, [0,0,1])`, y solo el
     *signo* lo decide el desplazamiento medio del contorno `mesh[base] -
     mesh[adj]`. Antes se derivaba de la diferencia de dos posiciones del path,
     que en la esfera (path de rotación pura, radio 0) es **cero** → referencia
     perpendicular a las tapas → el signo salía de un redondeo. Medido: 28
     aristas mal orientadas en `Esfera cortada`, ahora 0.
   - **Caras planas internas (`buildSide`)**: la normal de referencia de una
     columna se calcula con `colNormal(j)` a partir del **desplazamiento de
     columna dentro de la cara** (promedia las dos aristas adyacentes de la
     cara), no solo la siguiente. Con solo la siguiente, un triángulo de esquina
     recibía la normal de la pared vecina, perpendicular a la suya. Medido: 15
     aristas mal orientadas en `Hueco triangular`, ahora 0.
   - **Caras de corte de perfil**: `LL_FACE_PROFILE_BEGIN` empieza en
     `addFace(total-1, ...)`, cuya segunda columna se sale del contorno y
     **da la vuelta al punto 0** (en LL, `i = mBeginS+s + max_s*(t-1)` cuando
     `mBeginS+s >= max_s`). Sin ese módulo, la arista de cierre no tenía normal
     de referencia y el signo volvía a ser aleatorio (19 aristas en
     `sphere-pcut`, 33 en `torus-pcut`).
10. **Volumen firmado = volumen real** solo porque la malla es estanca *y*
    tiene las dos orientaciones consistentes; con eso `vol > 0` es el volumen
    encerrado y se puede comparar con el valor analítico exacto (ver el
    invariante siguiente).
11. **Marco de coordenadas.** `llvolume.js` genera en el marco local de SL
    (**X adelante, Y izquierda, Z arriba**) y el mundo de three.js es Y-arriba.
    `volumeToGeometry` convierte con `rotateX(-π/2)` sobre **copias** de los
    atributos (`position`/`normal` con `slice()`: las matrices del factory están
    cacheadas por `key(lod)` y mutarlas contamina todos los prims). Prueba
    barata de que falta la conversión: los vértices de un cilindro sin escalar
    cumplen `hypot(x,y)=0.5`, es decir el radio va alrededor del **eje Z**.
    `geometryBBox(vol)` devuelve ya la caja convertida:
    `{min:[minX, minZ, -maxY], max:[maxX, maxZ, -minY]}`.
12. **Nunca metas texturas en `material.userData`.** `Material.clone()`
    serializa `userData` con `JSON.stringify`, y con un `THREE.Texture` dentro
    arrastra canvas y datos de imagen: clonar pasaba de 0 a **~130 ms**, lo que
    hacía que deshacer (que reconstruye la región entera) tardase **8,4 s** en
    vez de 57 ms. El detalle de superficie se guarda en un `WeakMap`
    (`materialSurfaceInfo` en `region.js`).

## Invariantes comprobados por el selftest

- `signedVolume` contra el **valor analítico exacto** de la teselación de LL
  (p. ej. `Caja` 1, `Cilindro` = área del 24-gono, `Caja hueca` 0.75,
  `Hueco triangular` = 1 − (3√3/4)·0.2² = 0.94804, `Esfera cortada` = mitad de
  la esfera teselada, `Caja corte de perfil` 0.6 = fracción de contorno barrida).
- `orientationReport`: ninguna arista compartida por dos triángulos no
  degenerados puede recorrerse en el mismo sentido (eso es un triángulo
  invertido), y no puede haber más de dos triángulos vivos con direcciones
  balanceadas por arista (`doubleCover`). Excepciones legítimas y documentadas:
  `Toro con twist` (48 aristas con doble cobertura: LL deja dos discos de tapa
  pegados espalda con espalda) y `Toro 2 vueltas` (1728: `revolutions=2` cubre
  todo dos veces). `Anillo a medias` (`revhalf`) tiene aristas de borde porque
  es una superficie **abierta** a propósito.
- `oddEdgeCount`, `degenerateCount`, `normalFlipCount`, `convexInwardCount`,
  `crossSectionTest` y las pruebas de convergencia de Pappus (anillo y esfera
  convergen al volumen analítico al subir el LOD).

## Rendimiento

- **La palanca es la resolución interna**, no el número de triángulos: la
  escena son ~100 k triángulos y ~145 llamadas de dibujo, así que el cuello de
  botella es el relleno. `adapt()` en `viewer.js` baja el factor de resolución
  (`state.quality`, mínimo 0.45) si el fps cae por debajo de 50 y lo vuelve a
  subir por encima de 58. El presupuesto de píxeles de partida (`PIXEL_BUDGET`)
  es 2.2 MP en táctil y 9 MP en escritorio.
- **Mapa de sombras**: es lo más caro de la escena (medido: ~25% del frame con
  1536² y PCF suave a 1920×1080, unos 11 fps). Está bajo `shadowMap.autoUpdate
  = false`: se rehace sólo cuando el sol cambia de dirección, cuando el avatar
  se ha movido más de 20 cm (la cámara de sombras lo sigue, así que trasladarla
  no invalida el mapa) o cada 200 ms por si un script o una edición cambiaron
  algo. La resolución y el alcance bajan con la calidad (1536²/±44 m →
  1024²/±36 → 512²/±30), de modo que un mapa pequeño cubre poco terreno en vez
  de emborronar mucho.
- **Medido en un Adreno 619** (el móvil del usuario): 57-60 fps a 390×844 con el
  avatar quieto y ~45-55 andando; en el panel de vista previa del editor a
  1920×1080 (que además reescala el iframe al 23%) se queda en ~44 fps, pero
  reduciendo el tamaño del canvas no sube, así que ese techo es del propio panel
  del editor y no del visor (a 1280×720 da 60).
- **Otras cosas medidas y descartadas**: el agua (shader con profundidad) no
  cuesta nada apreciable; `applySky` por frame es trivial (unos `Color`); quitar
  todos los `backdrop-filter` del HUD da sólo ~3.5 fps, pero como son paneles
  pequeños y ayudan a leer el HUD sobre el mundo, se quedan.
- **Portada** (`$meta.image`): la plataforma no sabe dibujar WebGL, así que la
  imagen del listado es una captura real del visor (1200×675, subida a mano).

## Convenios

- Comentarios y UI en español (el usuario escribe en español).
- Los módulos de `src/` se importan entre sí con rutas relativas.
- Nada de build step; no hay dependencias de npm. three.js se carga desde
  `esm.sh` con versión fijada (`src/three.js` reexporta).
- Nombres de dominio iguales a los de SL (`PathParams`, `ProfileParams`,
  `VolumeParams`, `PrimParams`, `twistBegin`, `holeX`, ...) para que se pueda
  comparar el código con `llvolume.cpp` línea a línea.
