// faces.js -- apariencia de UNA cara de un prim (el "texture entry" de SL).
//
// En SL la textura, el color, la transparencia, el brillo, la repeticion y el
// material NO son propiedades del objeto sino de cada cara (se pueden tener 6
// caras con 6 texturas distintas y en SL eso es lo normal). Aqui se replica
// igual: `obj.faces[i]` es un registro de estos campos, y solo las caras que se
// tocan se guardan en el JSON (las demas siguen el color del prim).
//
// `tex` es la referencia a la textura, en una de estas formas:
//   { k: "ladrillo" }        receta procedural de `textures.js`
//   { u: "https://..." }     URL externa
//   { d: "data:image/...", id: "u12" }  imagen subida por el usuario
//   { a: "uuid" }            textura de la region, servida por el retransmisor
//                            bajo demanda (S.ASSET); ver `World.setAssetTexture`
//
// Los campos numericos se guardan tal cual para que el JSON sea estable y las
// caras identicas compartan material (ver `faceSpecKey`).

export function emptyFace() {
  return {
    tex: null,
    color: null,        // null = usar el color del prim
    alpha: 1,           // 0..1 transparencia
    glow: 0,            // 0..1 brillo (emision), como el "glow" de SL
    fullbright: false,  // sin sombreado
    mask: false,        // recorte por alfa (alpha test) en vez de mezcla
    repeat: [1, 1],     // repeticiones por cara
    offset: [0, 0],
    rotation: 0,        // radianes
    rough: null,        // null = rugosidad por defecto
    metal: null,
    doubleSide: false,
  };
}

// Clave de la textura de una cara. `{a}` es una textura que sirve el
// retransmisor bajo demanda por su uuid (ver `World.setAssetTexture`).
export function texKey(tex) {
  if (!tex) return "none";
  if (tex.k) return "p:" + tex.k;
  if (tex.a) return "a:" + tex.a;
  if (tex.id) return "t:" + tex.id;
  return "u:" + (tex.u || "");
}

export function faceIsDefault(f) {
  if (!f) return true;
  const d = emptyFace();
  return !f.tex && f.color === null && f.alpha === 1 && f.glow === 0 &&
    !f.fullbright && !f.mask && !f.doubleSide &&
    f.repeat[0] === d.repeat[0] && f.repeat[1] === d.repeat[1] &&
    f.offset[0] === d.offset[0] && f.offset[1] === d.offset[1] &&
    f.rotation === 0 && f.rough === null && f.metal === null;
}

// Resuelve todos los campos de una cara a valores concretos (el color del prim
// rellena el hueco de `color`, y los nulos se vuelven numeros), para que el
// material se pueda construir y cachear por `faceSpecKey`.
export function faceSpec(obj, i, f) {
  const src = f || emptyFace();
  return {
    index: i,
    tex: src.tex || null,
    color: src.color === null || src.color === undefined
      ? (obj && obj.colorHex !== undefined && obj.colorHex !== null ? obj.colorHex : 0xb9c2cf)
      : src.color,
    alpha: src.alpha === undefined ? 1 : src.alpha,
    glow: src.glow || 0,
    fullbright: !!src.fullbright,
    mask: !!src.mask,
    repeat: src.repeat || [1, 1],
    offset: src.offset || [0, 0],
    rotation: src.rotation || 0,
    rough: src.rough === null || src.rough === undefined ? 0.62 : src.rough,
    metal: src.metal === null || src.metal === undefined ? 0.05 : src.metal,
    doubleSide: !!src.doubleSide,
  };
}

export function faceSpecKey(s) {
  return [
    texKey(s.tex), s.color, s.alpha, s.glow, s.fullbright ? 1 : 0, s.mask ? 1 : 0,
    s.repeat[0], s.repeat[1], s.offset[0], s.offset[1], s.rotation,
    s.rough, s.metal, s.doubleSide ? 1 : 0,
  ].join("|");
}

// JSON compacto: solo las caras que no son "por defecto", como pares
// [indice, registro]. Los numeros se redondean para que el autoguardado no
// engorde con decimales basura.
export function facesToJson(faces) {
  if (!faces) return null;
  const out = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    if (faceIsDefault(f)) continue;
    const rec = { i };
    if (f.tex) rec.tex = f.tex;
    if (f.color !== null && f.color !== undefined) rec.color = f.color;
    if (f.alpha !== 1) rec.alpha = round3(f.alpha);
    if (f.glow) rec.glow = round3(f.glow);
    if (f.fullbright) rec.fb = 1;
    if (f.mask) rec.mask = 1;
    if (f.repeat[0] !== 1 || f.repeat[1] !== 1) rec.rep = [round3(f.repeat[0]), round3(f.repeat[1])];
    if (f.offset[0] || f.offset[1]) rec.off = [round3(f.offset[0]), round3(f.offset[1])];
    if (f.rotation) rec.rot = round4(f.rotation);
    if (f.rough !== null && f.rough !== undefined) rec.rough = round3(f.rough);
    if (f.metal !== null && f.metal !== undefined) rec.metal = round3(f.metal);
    if (f.doubleSide) rec.ds = 1;
    out.push(rec);
  }
  return out.length ? out : null;
}

export function facesFromJson(json, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(emptyFace());
  if (!json) return out;
  for (const rec of json) {
    const i = rec.i | 0;
    if (i < 0 || i >= n) continue;
    const f = out[i];
    if (rec.tex) f.tex = rec.tex;
    if (rec.color !== undefined) f.color = rec.color;
    if (rec.alpha !== undefined) f.alpha = rec.alpha;
    if (rec.glow !== undefined) f.glow = rec.glow;
    if (rec.fb) f.fullbright = true;
    if (rec.mask) f.mask = true;
    if (rec.rep) f.repeat = [rec.rep[0], rec.rep[1]];
    if (rec.off) f.offset = [rec.off[0], rec.off[1]];
    if (rec.rot) f.rotation = rec.rot;
    if (rec.rough !== undefined) f.rough = rec.rough;
    if (rec.metal !== undefined) f.metal = rec.metal;
    if (rec.ds) f.doubleSide = true;
  }
  return out;
}

function round3(v) { return Math.round(v * 1000) / 1000; }
function round4(v) { return Math.round(v * 10000) / 10000; }
