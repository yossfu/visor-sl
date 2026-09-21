# Migración del visor SL de WebView/three.js a renderer nativo

## Diagnóstico actual

El proyecto ya contiene el avatar base de Second Life en `www/data/avatar/`:
- `avatar_head.llm.gz`
- `avatar_upper_body.llm.gz`
- `avatar_lower_body.llm.gz`
- `avatar_eyelashes.llm.gz`
- `avatar_eye.llm.gz`
- `avatar_skeleton.xml.gz`
- `avatar_lad.xml.gz`

La cápsula aparecía porque `llm.js` leía `numSkinJoints` aun cuando `hasWeights=0`.
`avatar_eye.llm.gz` es precisamente un mesh no pesado; después de los rostros del mesh
el archivo entra directamente al terminador `End Morphs`. Ese desplazamiento corrupto
hacía fallar `loadAvatarParts()` y `createAvatar()`, y `World.provideAvatarBody()` dejaba
la cápsula como fallback.

## Cambios aplicados

1. `llm.js`: `numSkinJoints` y los nombres de joints sólo se leen cuando `hasWeights` es verdadero.
2. `sl-session.js`: `GetTexture` solicita `Accept: image/x-j2c`.
3. `sl-session.js`: los errores de `AvatarAppearance` ya no se silencian.
4. `world.js`: una excepción construyendo un avatar queda visible y puede ser instrumentada.

## Qué NO conviene hacer

No sustituir WebView por Filament sin separar el sistema en capas. Filament es el renderer;
no implementa el protocolo de Second Life, el inventario, UDP, capacidades, EventQueue ni
la descarga de assets.

Tampoco conviene convertir cada mesh de SL a glTF como formato obligatorio. Para runtime móvil
es preferible decodificar el formato nativo de SL a buffers internos y subirlos directamente
al renderer. glTF puede quedar como formato de prueba/offline.

## Arquitectura objetivo

```text
Kotlin UI / Android lifecycle
        |
        +-- SL Core (C++/Kotlin)
        |     +-- UDP / message templates / zerocode / ACK
        |     +-- HTTP capabilities + EventQueue
        |     +-- region/world model
        |     +-- asset cache
        |     +-- inventory + wearables
        |     +-- avatar appearance
        |
        +-- Asset decoders
        |     +-- J2C/JPEG2000
        |     +-- classic LLM avatar
        |     +-- SL Mesh Asset (LLSD + gzip)
        |     +-- LLKeyframeMotion
        |
        +-- Scene bridge
        |     +-- terrain
        |     +-- prims/sculpt
        |     +-- mesh objects
        |     +-- avatars/attachments
        |
        +-- Filament renderer
              +-- materials/textures
              +-- skinning/morphs
              +-- LOD/culling
              +-- shadows/lighting
              +-- camera
```

## Orden recomendado de implementación

### Fase A — estabilizar el visor existente

- Probar la corrección de `LLM` en un APK real.
- Confirmar que el log muestre `avatares: N (con cuerpo N)` y que desaparezca la cápsula.
- Confirmar `TEXTURAS: ... decodificadas > 0`.
- Conservar tres.js sólo como renderer de referencia mientras se valida la escena.

### Fase B — asset pipeline nativo

Implementar primero una caché con claves por UUID y tipo de asset:

```text
cache/
  textures/<uuid>.j2c
  meshes/<uuid>.slmesh
  wearables/<uuid>.wear
  animations/<uuid>.anim
```

La clave del asset debe ser el UUID y la respuesta debe almacenar también versión/tipo/CRC
cuando el protocolo lo proporcione.

### Fase C — mesh de Second Life

`GetMesh` / `GetMesh2` deben descargar el asset de mesh de SL. El formato oficial usa un
header LLSD binario sin comprimir y bloques LOD de listas LLSD binarias comprimidas; los
submeshes contienen posición, normal, UV y triángulos, y una sección de skin puede contener
`joint_names`, `bind_shape_matrix`, `inverse_bind_matrix` y pesos.

El decoder nativo debe producir un objeto interno equivalente a:

```text
MeshAsset
  lods[]
    submeshes[]
      positions
      normals
      uv0
      indices
      material/face info
      skin?
  skeleton?
```

### Fase D — avatar completo

El avatar del sistema debe seguir siendo el pipeline actual de `AvatarAppearance`:
visual params -> morphs/esqueleto -> baked textures.

Después hay que sumar:

1. `AgentWearablesRequest` / `AgentWearablesUpdate`.
2. Transferencia de los wearable assets.
3. Texturas por wearable cuando sean necesarias.
4. Mesh bodies/clothes mediante inventory item -> asset UUID -> `GetMesh2`.
5. Attachments y relaciones parent/child de objetos.
6. Mapeo de joints Bento por nombre.

La ropa de inventario NO está almacenada dentro de `avatar_*.llm.gz`; esos archivos son sólo
la base de avatar del sistema. Second Life separa wearables, attachments y animaciones.

### Fase E — renderer Filament

Filament encaja bien como backend móvil. La estrategia más segura es que Filament reciba
los buffers ya decodificados por el `SL Core` en vez de enseñarle a Filament los formatos
internos de Second Life.

Objetos principales:

```text
FilamentScene
FilamentRegion
FilamentPrim
FilamentMeshObject
FilamentAvatar
FilamentMaterial
FilamentTexture
```

### Fase F — rendimiento móvil

Medir antes de fijar límites:
- draw calls
- triangles visibles
- memoria de texturas
- tiempo de CPU del decoder
- tiempo de subida a GPU
- frame time 16.6 / 33.3 ms
- número de avatares visibles

Aplicar:
- frustum culling
- distance/LOD culling
- texture resolution tiers
- batching cuando el material lo permita
- decodificación y subida asíncronas
- caché persistente
- límite de assets simultáneos

## Hito concreto para este repositorio

El siguiente APK debe probar primero estas tres cosas, sin migrar el renderer todavía:

1. avatar base visible
2. avatar bake/texturas visible
3. prims + terreno texturizados

Sólo cuando esas tres rutas estén confirmadas conviene portar el backend gráfico a Filament.
De lo contrario se corre el riesgo de convertir un problema de protocolo/asset decoding en
un problema de renderer y perder la capacidad de diagnosticarlo.


---

## Nota de la ronda 8 (estado actual)

Este documento nace de la duda del usuario sobre pasar a un motor nativo. La
decisión de la ronda 8 está razonada en `LUMIYA.md` §7 y es coherente con lo que
dice aquí: **no se sustituye el render sin separar las capas primero**.

- Se mantiene **WebGL2 dentro del WebView**, porque el cuello de botella medido no
  era el motor sino el número de llamadas de dibujo (3259 → 187 con batches
  estáticos) y porque todo el protocolo ya está probado contra el simulador falso
  (70/70), algo que un port nativo perdería.
- Lo que **sí** se ha hecho en esa dirección: perfiles de calidad con gobernador
  de fps, batches estáticos por celda, tope de memoria de GPU con recorte LRU,
  decodificación JPEG2000 en un hilo aparte y diagnóstico en el propio móvil.
- El camino a un render nativo (Filament o GLES directo) queda abierto y sólo se
  recorrerá si el diagnóstico del dispositivo demuestra que el WebView no da más
  de sí; la pieza a sustituir es `renderer.js`/`world.js`, no el protocolo.
- De los arreglos listados arriba, los tres del avatar se han integrado en el
  código de la ronda 8: `llm.js` (leer `numSkinJoints` sólo si `hasWeights`, con
  comprobaciones de longitud), `Accept: image/x-j2c` en `GetTexture` y errores de
  `AvatarAppearance`/construcción de avatar que ya no se silencian.
