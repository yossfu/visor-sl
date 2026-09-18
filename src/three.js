// three.js en un solo sitio: la version queda fijada aqui y todos los modulos
// del visor importan desde este archivo (asi nunca hay dos copias de three
// cargadas a la vez).
export * from "https://esm.sh/three@0.160.0";
export { OrbitControls } from "https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js";
export { TransformControls } from "https://esm.sh/three@0.160.0/examples/jsm/controls/TransformControls.js";
export { mergeGeometries } from "https://esm.sh/three@0.160.0/examples/jsm/utils/BufferGeometryUtils.js";
