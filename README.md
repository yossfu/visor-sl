# Visor SL Native — fase 1

Esta es la migración del visor fuera de WebView. El APK usa:

- Kotlin para la Activity y el ciclo de vida Android.
- `SurfaceView` + Filament 1.77.0 para renderizado nativo.
- C++/JNI para leer las mallas base `.llm` de Second Life.
- Los mismos assets LLM que ya existen en el proyecto anterior.

## Objetivo de esta fase

Demostrar una ruta completamente nativa para el avatar base: `.llm.gz` → GZIP → parser C++ → buffers Filament → GPU.

No contiene un WebView ni Three.js.

## Importante

El login y la sesión Second Life todavía no se han "simulado" dentro de esta fase. El código anterior tenía gran parte del protocolo en `sl-session.js`; para no esconder ese JavaScript detrás de otro WebView, la migración se hace por capas:

1. SL Core: login, capabilities, UDP, message templates, LLSD, EventQueue.
2. Asset Manager: J2C, cache, baked textures y assets.
3. World: prims, ObjectUpdateCompressed y terrain.
4. Avatar: visual params, GPU skinning, skeleton, animaciones.
5. Wearables/Mesh: AgentWearables, GetMesh/GetMesh2, LOD, Bento.
6. UI nativa: chat, inventario, amigos, teleport, cámara y controles.

La versión del renderer y del build no debe mezclar responsabilidades: el protocolo no dependerá de Filament.
