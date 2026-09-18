// prims.js -- Second Life prim "shape" definitions and the mapping between the
// user-facing parameters (as shown in SL's build floater -> Object tab) and the
// LLVolume params consumed by llvolume.js. The mapping mirrors SL's
// llpanelobject.cpp exactly, including the per-shape quirks.
import {
  ProfileParams, PathParams, VolumeParams,
  PROFILE_CIRCLE, PROFILE_SQUARE, PROFILE_EQUALTRI, PROFILE_CIRCLE_HALF,
  PATH_LINE, PATH_CIRCLE,
  HOLE_CIRCLE, HOLE_SQUARE, HOLE_TRIANGLE,
} from './llvolume.js';

// Shape table = SL's LLPanelObject::getVolumeParams (llpanelobject.cpp:1281).
// Note the prism/ring use the equilateral-triangle profile, and the sphere is
// the half-circle profile on a circular path (the legacy "full circle with
// ratio > 0.75" sphere is a double-covered surface, see getState).
// holeX/holeY are SL's per-shape "Hole Size X/Y" defaults (ratio x/y).
export const SHAPE_ORDER = ['box', 'cylinder', 'prism', 'sphere', 'torus', 'tube', 'ring'];

export const HOLE_SIZE_MIN = 0.05;
export const HOLE_SIZE_MAX_X = 1.0;
export const HOLE_SIZE_MAX_Y = 0.5;

export const SHAPES = {
  box: {
    label: 'Caja', icon: '▢', profile: PROFILE_SQUARE, path: PATH_LINE,
    linear: true,
  },
  cylinder: {
    label: 'Cilindro', icon: '⬭', profile: PROFILE_CIRCLE, path: PATH_LINE,
    linear: true,
  },
  prism: {
    label: 'Prisma', icon: '△', profile: PROFILE_EQUALTRI, path: PATH_LINE,
    linear: true,
  },
  sphere: {
    label: 'Esfera', icon: '◯', profile: PROFILE_CIRCLE_HALF, path: PATH_CIRCLE,
    locked: true,
  },
  torus: {
    label: 'Toro', icon: '◎', profile: PROFILE_CIRCLE, path: PATH_CIRCLE,
    round: true, holeX: 0.25, holeY: 0.25,
  },
  tube: {
    label: 'Tubo', icon: '▣', profile: PROFILE_SQUARE, path: PATH_CIRCLE,
    round: true, holeX: 1.0, holeY: 0.25,
  },
  ring: {
    label: 'Anillo', icon: '◍', profile: PROFILE_EQUALTRI, path: PATH_CIRCLE,
    round: true, holeX: 0.05, holeY: 0.25,
  },
};

export const HOLE_SHAPES = [
  { id: 'same', label: 'Igual', code: 0 },
  { id: 'circle', label: 'Círculo', code: HOLE_CIRCLE },
  { id: 'square', label: 'Cuadrado', code: HOLE_SQUARE },
  { id: 'triangle', label: 'Triángulo', code: HOLE_TRIANGLE },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------------------
// PrimParams: the user-facing parameter set of a prim (all the fields the SL
// build floater exposes), plus transforms (position/rotation/scale).
// ---------------------------------------------------------------------------
export class PrimParams {
  constructor(shape = 'box') {
    this.shape = shape;
    this.pathCutBegin = 0;
    this.pathCutEnd = 1;
    this.profileCutBegin = 0;
    this.profileCutEnd = 1;
    this.hollow = 0;
    this.holeShape = 'same';
    this.twistBegin = 0;
    this.twistEnd = 0;
    this.taperX = 0;
    this.taperY = 0;
    this.holeX = (SHAPES[shape] && SHAPES[shape].holeX) || 1;
    this.holeY = (SHAPES[shape] && SHAPES[shape].holeY) || 1;
    this.shearX = 0;
    this.shearY = 0;
    this.slope = 0;
    this.skew = 0;
    this.revolution = 1;
  }

  setShape(shape) {
    const def = SHAPES[shape];
    this.shape = shape;
    if (shape === 'sphere') { this.holeX = 1; this.holeY = 1; }
    else if (def.round) { this.holeX = def.holeX; this.holeY = def.holeY; }
    else { this.holeX = 1; this.holeY = 1; }
    if (def.round) { this.taperX = 0; this.taperY = 0; }
    if (shape === 'sphere') { this.taperX = 0; this.taperY = 0; this.skew = 0; this.slope = 0; this.revolution = 1; }
    return this;
  }

  copy() { return Object.assign(new PrimParams(this.shape), this); }

  // ---- field descriptors so the UI can be generated from one table ----
  visibleGroups() {
    const def = SHAPES[this.shape];
    return {
      cut: true,
      hollow: true,
      twist: true,
      taper: !def.locked,
      holes: !!def.round,
      shear: !def.locked,
      slope: !!def.round,
      skew: !!def.round,
      revolution: !!def.round,
    };
  }

  // ---- the SL floater -> LLVolumeParams conversion (llpanelobject.cpp) ----
  toVolumeParams() {
    const def = SHAPES[this.shape];
    const p = new ProfileParams();
    const a = new PathParams();

    p.curveType = def.profile | ((this.hollow > 0) ? (HOLE_SHAPES.find((h) => h.id === this.holeShape).code) : 0);
    a.curveType = def.path;

    let beginS = this.profileCutBegin, endS = this.profileCutEnd;
    if (beginS > endS - 0.02) beginS = Math.max(0, endS - 0.02);
    p.begin = beginS;
    p.end = endS;
    let beginT = this.pathCutBegin, endT = this.pathCutEnd;
    if (beginT > endT - 0.02) beginT = Math.max(0, endT - 0.02);
    a.begin = beginT;
    a.end = endT;

    let hole = clamp(this.hollow, 0, 0.95);
    const holeShapeCode = p.curveType & 0xf0;
    const squareish = holeShapeCode === HOLE_SQUARE &&
      this.shape !== 'box' && this.shape !== 'tube';
    if (this.shape !== 'box' && holeShapeCode === HOLE_SQUARE) hole = Math.min(hole, 0.7);
    void squareish;
    p.hollow = hole;

    // twist: SL divides degrees by 180 for linear paths, 360 for circular ones
    const div = def.linear ? 180 : 360;
    a.twistBegin = this.twistBegin / div;
    a.twistEnd = this.twistEnd / div;

    // ratio / taper
    a.shearX = this.shearX;
    a.shearY = this.shearY;
    a.revolutions = Math.max(1, this.revolution);

    if (def.linear) {
      a.scaleX = 1 - this.taperX;
      a.scaleY = 1 - this.taperY;
      a.taperX = 0;
      a.taperY = 0;
      a.radiusOffset = this.slope;
      a.skew = this.skew;
    } else if (this.shape === 'sphere') {
      a.scaleX = 1; a.scaleY = 1;
      a.taperX = 0; a.taperY = 0;
      a.skew = 0; a.radiusOffset = 0; a.revolutions = 1;
    } else {
      // llpanelobject.cpp:1476 -- the hole size (ratio) is clamped for the
      // round shapes; radius offset and skew have shape-dependent upper bounds.
      a.scaleX = clamp(this.holeX, HOLE_SIZE_MIN, HOLE_SIZE_MAX_X);
      a.scaleY = clamp(this.holeY, HOLE_SIZE_MIN, HOLE_SIZE_MAX_Y);
      a.taperX = this.taperX;
      a.taperY = this.taperY;

      let radiusOffset = this.slope;
      let taperYMag = Math.abs(a.taperY);
      if ((radiusOffset > 0 && a.taperY < 0) || (radiusOffset < 0 && a.taperY > 0)) taperYMag = 0;
      const maxRadius = 1 - a.scaleY * (1 - taperYMag) / (1 - a.scaleY);
      if (Math.abs(radiusOffset) > maxRadius) radiusOffset = Math.sign(radiusOffset) * maxRadius;

      let skew = this.skew;
      let minSkew = 1 - 1 / (a.revolutions * a.scaleX + 1);
      if (Math.abs(a.revolutions - 1) < 0.001) minSkew = 0;
      if (Math.abs(skew) < minSkew) skew = Math.sign(skew) * minSkew;

      a.radiusOffset = radiusOffset;
      a.skew = skew;
    }

    return new VolumeParams(p, a);
  }
}

// ---------------------------------------------------------------------------
// Catalogo de casos: la fila base (las 7 formas de SL con sus valores por
// defecto) y una variante por cada parametro del floater. Vive aqui, junto a
// PrimParams, porque es la lista de casos que usan tanto la galeria como el
// auto-test (una sola fuente de verdad para los parametros de prueba).
// ---------------------------------------------------------------------------
function variant(name, shape, over = {}) {
  const p = new PrimParams(shape);
  Object.assign(p, over);
  return { name, shape, params: p };
}

// Un unico caso (nombre + forma + parametros), sin pasar por las listas.
export function primCase(name, shape, over = {}) { return variant(name, shape, over); }

export function primBaseRow() {
  return SHAPE_ORDER.map((s) => variant(SHAPES[s].label, s));
}

export function primVariants() {
  return [
    variant('Caja hueca', 'box', { hollow: 0.5 }),
    variant('Hueco triangular', 'box', { hollow: 0.4, holeShape: 'triangle' }),
    variant('Cilindro hueco cuad', 'cylinder', { hollow: 0.6, holeShape: 'square' }),
    variant('Esfera hueca', 'sphere', { hollow: 0.55 }),
    variant('Esfera cortada', 'sphere', { pathCutBegin: 0.25, pathCutEnd: 0.75 }),
    variant('Toro con twist', 'torus', { twistEnd: 90 }),
    variant('Toro con taper', 'torus', { taperX: -0.5, taperY: 0.4 }),
    variant('Toro 2 vueltas', 'torus', { revolution: 2 }),
    variant('Caja con taper', 'box', { taperX: -0.6, taperY: 0.5 }),
    variant('Caja shear+skew', 'box', { shearX: 0.5, skew: 0.3 }),
    variant('Caja corte de perfil', 'box', { profileCutBegin: 0.2, profileCutEnd: 0.8 }),
    variant('Anillo cortado', 'ring', { pathCutBegin: 0.1, pathCutEnd: 0.6 }),
    variant('Prisma cortado', 'prism', { pathCutBegin: 0.2, pathCutEnd: 0.8 }),
    variant('Cilindro con twist', 'cylinder', { twistEnd: 60 }),
  ];
}

// La etiqueta se reutiliza al etiquetar las caras en el banco de pruebas.
export function primCaseList() {
  return primBaseRow().concat(primVariants());
}
