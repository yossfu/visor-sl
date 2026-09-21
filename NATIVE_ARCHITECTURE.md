# Arquitectura del visor native

```text
Android Kotlin UI
      │
      ▼
NativeFilamentView ───────► Filament GPU renderer
      │
      ▼
SL Core (Kotlin + C++/JNI)
      ├── Login / Capabilities
      ├── UDP circuit + ACK
      ├── EventQueue
      ├── LLSD / messages
      └── Region / Agent state
      │
      ▼
Asset Manager (C++)
      ├── J2C
      ├── LLM
      ├── SL Mesh
      ├── Wearables
      ├── Animations
      └── disk + GPU cache
      │
      ▼
Scene graph
      ├── terrain
      ├── prims
      ├── avatar
      ├── mesh clothing
      └── attachments
```
