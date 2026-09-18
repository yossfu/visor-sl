// tga.js -- lector de TGA (Truevision).
//
// Las texturas del cuerpo de sistema de Second Life (`characterAssets.js`) van
// en TGA sin comprimir o con RLE, en escala de grises (que el visor usa como
// mascara) o en BGR/BGRA. Este modulo las pasa todas al mismo formato de
// trabajo: `{ width, height, data }` con RGBA en orden de filas de arriba
// abajo (el TGA guarda las filas al reves por defecto).
//
// Nota de color: en escala de grises se rellena tambien el alfa con el gris.
// Es lo que hace el visor, y es justo lo que necesitan las mascaras
// (`file_is_mask="TRUE"`): pueden leer el valor como color o como transparencia.

// Cabecera: tipo, tamano y si viene con el origen arriba.
export function tgaInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 18) throw new Error("tga: cabecera incompleta");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const desc = b[17];
  return {
    idLength: b[0],
    colorMapType: b[1],
    imageType: b[2],
    width: dv.getUint16(12, true),
    height: dv.getUint16(14, true),
    depth: b[16],
    topLeft: !!(desc & 0x20),
    extensionArea: !!(desc & 0x10),
    bytes: b.length,
  };
}

const GRAY_TYPES = new Set([3, 11]);
const COLOR_TYPES = new Set([2, 10]);

export function isTga(bytes) {
  try {
    const i = tgaInfo(bytes);
    return (GRAY_TYPES.has(i.imageType) || COLOR_TYPES.has(i.imageType))
      && i.colorMapType === 0 && i.width > 0 && i.height > 0;
  } catch (e) { return false; }
}

// Decodifica a RGBA de 8 bits por canal, fila 0 = arriba.
export function decodeTga(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const info = tgaInfo(b);
  if (info.colorMapType !== 0) throw new Error("tga: los mapas de color no estan soportados");
  const gray = GRAY_TYPES.has(info.imageType);
  const color = COLOR_TYPES.has(info.imageType);
  if (!gray && !color) throw new Error("tga: tipo de imagen no soportado (" + info.imageType + ")");
  const { width: w, height: h, depth } = info;
  const n = w * h;
  const gray8 = gray && depth === 8;
  const bpp = depth / 8;
  if (!gray8 && depth !== 24 && depth !== 32) throw new Error("tga: " + depth + " bits por pixel no soportado");

  const data = new Uint8Array(n * 4);
  let off = 18 + info.idLength;

  const readPixel = () => {
    if (gray8) { const v = b[off]; off += 1; return [v, v, v, v]; }
    const bl = b[off], g = b[off + 1], r = b[off + 2];
    const a = depth === 32 ? b[off + 3] : 255;
    off += bpp;
    return [r, g, bl, a];
  };
  const store = (i, p) => {
    data[i * 4] = p[0]; data[i * 4 + 1] = p[1]; data[i * 4 + 2] = p[2]; data[i * 4 + 3] = p[3];
  };

  if ((color && info.imageType === 2) || (gray && info.imageType === 3)) {
    for (let i = 0; i < n; i++) store(i, readPixel());
  } else {
    // RLE: un byte de cabecera; el bit alto dice si los que siguen son un solo
    // pixel repetido (cuenta = 1..128) o una tira de pixeles distintos.
    let i = 0;
    while (i < n) {
      if (off >= b.length) throw new Error("tga: los datos RLE se acaban antes de tiempo");
      const head = b[off++];
      const count = (head & 0x7f) + 1;
      if (head & 0x80) {
        const p = readPixel();
        for (let k = 0; k < count && i < n; k++) store(i++, p);
      } else {
        for (let k = 0; k < count && i < n; k++) store(i++, readPixel());
      }
    }
  }

  if (!info.topLeft) {
    const flipped = new Uint8Array(n * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) flipped.set(data.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return { width: w, height: h, data: flipped };
  }
  return { width: w, height: h, data };
}

// --- autotest -----------------------------------------------------------------

// Escribe un TGA a mano en cada formato que soportamos y lo vuelve a leer.
// Sirve de red de seguridad: si alguien toca el lector, esto lo delata.
export function runTgaSelfTest() {
  const checks = [];
  const ok = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: detail === undefined ? "" : String(detail) });

  const writeHeader = (type, w, h, depth, topLeft) => ([
    0, 0, type, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff,
    depth, topLeft ? 0x20 : 0x00,
  ]);

  // --- BGR 24 sin comprimir, origen arriba: 2x2 con colores conocidos.
  const px = [
    [255, 0, 0], [0, 255, 0],   // fila 0: rojo, verde
    [0, 0, 255], [255, 255, 255], // fila 1: azul, blanco
  ];
  const bgr = [];
  for (const [r, g, b] of px) bgr.push(b, g, r);
  const t1 = new Uint8Array([...writeHeader(2, 2, 2, 24, true), ...bgr]);
  const d1 = decodeTga(t1);
  ok("cabecera 24 bits", tgaInfo(t1).depth === 24 && tgaInfo(t1).width === 2);
  ok("es un tga", isTga(t1));
  ok("BGR -> RGBA: primer pixel rojo", d1.data[0] === 255 && d1.data[1] === 0 && d1.data[2] === 0, [...d1.data.slice(0, 4)]);
  ok("BGR -> RGBA: segundo pixel verde", d1.data[4] === 0 && d1.data[5] === 255 && d1.data[6] === 0);
  ok("24 bits sale opaco", d1.data[3] === 255);

  // --- Gris 8 sin comprimir, origen ABAJO: hay que darle la vuelta.
  const t2 = new Uint8Array([...writeHeader(3, 2, 2, 8, false), 10, 20, 30, 40]);
  const d2 = decodeTga(t2);
  ok("gris: la primera fila del resultado es la ultima del fichero",
    d2.data[0] === 30 && d2.data[4] === 40, d2.data[0] + "," + d2.data[4]);
  ok("gris: el alfa copia el gris", d2.data[3] === 30 && d2.data[7] === 40);

  // --- BGRA 32 con RLE: 4 pixeles, una tira de 2 distintos y una repeticion de 2.
  const bgra = [1, 2, 3, 4, 5, 6, 7, 8, /* repetido: */ 9, 10, 11, 12];
  const rle = [
    0x01, bgra[0], bgra[1], bgra[2], bgra[3], bgra[4], bgra[5], bgra[6], bgra[7],
    0x81, bgra[8], bgra[9], bgra[10], bgra[11],
  ];
  const t3 = new Uint8Array([...writeHeader(10, 4, 1, 32, true), ...rle]);
  const d3 = decodeTga(t3);
  ok("RLE: 4 pixeles", d3.width === 4 && d3.data.length === 16);
  ok("RLE: pixel 0 = (3,2,1,4)", d3.data[0] === 3 && d3.data[1] === 2 && d3.data[2] === 1 && d3.data[3] === 4, [...d3.data.slice(0, 4)]);
  ok("RLE: pixel 1 = (7,6,5,8)", d3.data[4] === 7 && d3.data[5] === 6 && d3.data[6] === 5 && d3.data[7] === 8);
  ok("RLE: el pixel repetido sale dos veces",
    d3.data[8] === 11 && d3.data[9] === 10 && d3.data[10] === 9 && d3.data[11] === 12
    && d3.data[12] === 11 && d3.data[15] === 12);

  // --- Gris con RLE (tipo 11), que es como viene `head_shading_alpha.tga`.
  const t4 = new Uint8Array([...writeHeader(11, 4, 1, 8, true), 0x02, 100, 200, 50, 0x80, 77]);
  const d4 = decodeTga(t4);
  ok("gris RLE: tres valores sueltos y uno repetido",
    d4.data[0] === 100 && d4.data[4] === 200 && d4.data[8] === 50 && d4.data[12] === 77, [...d4.data]);
  ok("gris RLE: el alfa sigue al gris", d4.data[15] === 77 && d4.data[3] === 100);

  // --- Casos que deben fallar con elegancia.
  let threw = "";
  try { decodeTga(new Uint8Array([1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 8, 0])); } catch (e) { threw = e.message; }
  ok("un tipo desconocido da error", threw.includes("no soportado"), threw);
  ok("una cabecera corta da error", (() => { try { tgaInfo(new Uint8Array(4)); return false; } catch (e) { return true; } })());

  const failed = checks.filter((c) => !c.pass);
  return {
    checks, total: checks.length, failed: failed.length,
    summary: failed.length === 0
      ? "tga selftest: all " + checks.length + " checks passed"
      : "tga selftest: " + failed.length + "/" + checks.length + " FAILED (" + failed.map((c) => c.name).join(", ") + ")",
  };
}
