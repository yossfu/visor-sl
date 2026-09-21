// Writes real `LLMESH` assets in memory. Nothing in the shipped viewer needs to
// *create* a mesh, but two things do: the offline demo, which has no grid to
// fetch a building from, and the tests, which check the decoder against a real
// encoder instead of a stub. Having both sides in the same repository is what
// makes "the decoder is right" a checkable statement rather than a belief.
//
// The encoder mirrors the uploader: each submesh is quantized into the same U16
// domains the viewer's `unpackVolumeFacesInternal` reads back, the submeshes are
// written as a binary LLSD array, that array is deflated (zlib), and the header
// records where each block landed — counted from the end of the header, exactly
// like the real thing.

import { serializeLLSDBinary } from "./llsd.js";

const LODS = ["lowest_lod", "low_lod", "medium_lod", "high_lod"];

function deflateZlib(bytes) {
  if (typeof CompressionStream !== "function") {
    return Promise.reject(new Error("mesh-fixture: este navegador no puede comprimir (CompressionStream)"));
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
}

function domainMinMax(values, stride) {
  const mn = new Array(stride).fill(Infinity);
  const mx = new Array(stride).fill(-Infinity);
  for (let i = 0; i < values.length; i += stride) {
    for (let a = 0; a < stride; a++) {
      const v = values[i + a];
      if (v < mn[a]) mn[a] = v;
      if (v > mx[a]) mx[a] = v;
    }
  }
  for (let a = 0; a < stride; a++) {
    if (!Number.isFinite(mn[a])) { mn[a] = 0; mx[a] = 1; }
    if (mx[a] === mn[a]) mx[a] = mn[a] + 1;   // the reader divides by the range
  }
  return { mn, mx };
}

function quantize(values, stride, mn, mx) {
  const count = values.length / stride;
  const out = new Uint8Array(count * stride * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < stride; a++) {
      const q = Math.round(((values[i * stride + a] - mn[a]) / (mx[a] - mn[a])) * 65535);
      dv.setUint16(i * stride * 2 + a * 2, Math.max(0, Math.min(65535, q)), true);
    }
  }
  return out;
}

/**
 * One submesh in the wire form. `vert` is `{positions: Float32Array,
 * normals?, uvs?, indices: Uint16Array|Uint32Array}`.
 */
export function encodeSubmesh(vert) {
  const positions = vert.positions;
  const nverts = positions.length / 3;
  const pd = domainMinMax(positions, 3);
  const entry = {
    Position: quantize(positions, 3, pd.mn, pd.mx),
    PositionDomain: { Min: pd.mn, Max: pd.mx },
    TriangleList: u16Bytes(vert.indices),
  };
  if (vert.normals && vert.normals.length === nverts * 3) {
    // Unit normals are quantized across the fixed -1..1 domain, which is what
    // the viewer reads back.
    entry.Normal = quantizeRange(vert.normals, 3, [-1, -1, -1], [1, 1, 1]);
  } else {
    entry.Normal = new Uint8Array(nverts * 6);
  }
  if (vert.uvs && vert.uvs.length === nverts * 2) {
    entry.TexCoord0 = quantizeRange(vert.uvs, 2, [0, 0], [1, 1]);
    entry.TexCoord0Domain = { Min: [0, 0], Max: [1, 1] };
  } else {
    entry.TexCoord0 = new Uint8Array(nverts * 4);
    entry.TexCoord0Domain = { Min: [0, 0], Max: [1, 1] };
  }
  return entry;
}

function quantizeRange(values, stride, mn, mx) {
  const count = values.length / stride;
  const out = new Uint8Array(count * stride * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < count * stride; i++) {
    const q = Math.round(((values[i] - mn[i % stride]) / (mx[i % stride] - mn[i % stride])) * 65535);
    dv.setUint16(i * 2, Math.max(0, Math.min(65535, q)), true);
  }
  return out;
}

function u16Bytes(indices) {
  const out = new Uint8Array(indices.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < indices.length; i++) dv.setUint16(i * 2, indices[i], true);
  return out;
}

/**
 * Assembles an asset. `submeshes` is the LOD list (one entry per material;
 * `null` writes the `NoGeometry` marker). A single list is reused for every
 * LOD unless `lods` is given, which is what most assets do anyway.
 */
export async function buildMeshAsset(submeshes, opts = {}) {
  const materials = opts.materialList || submeshes.map((s, i) => (s ? "material" + i : null)).filter(Boolean);
  const lods = opts.lods || null;
  const blocks = {};
  const order = [];
  if (opts.skin || opts.physics) {
    // Present so the reader has to skip real blocks before the LODs.
    if (opts.skin) { blocks.skin = await deflateZlib(serializeLLSDBinary(opts.skin, { header: false })); order.push("skin"); }
    if (opts.physics) { blocks.physics_convex = await deflateZlib(serializeLLSDBinary(opts.physics, { header: false })); order.push("physics_convex"); }
  }
  const names = opts.lodNames || LODS;
  for (const name of names) {
    const list = lods ? lods[name] : submeshes;
    if (!list) continue;
    blocks[name] = await deflateZlib(serializeLLSDBinary(list, { header: false }));
    order.push(name);
  }
  const header = {};
  if (materials.length) header.material_list = materials;
  let offset = 0;
  for (const name of order) {
    header[name] = { offset, size: blocks[name].length };
    offset += blocks[name].length;
  }
  const headerBytes = await headerBytesFor(header, opts);
  const total = headerBytes.length + offset;
  const asset = new Uint8Array(total);
  asset.set(headerBytes, 0);
  let at = headerBytes.length;
  for (const name of order) { asset.set(blocks[name], at); at += blocks[name].length; }
  return { bytes: asset, headerLength: headerBytes.length, lods: order, materialList: materials };
}

/**
 * The header of an asset is headerless binary LLSD. Real assets from long ago
 * also carry the deprecated `<? llsd/binary ?>` text tag in front of it, which
 * the viewer strips (`strip_deprecated_header`) — `textHeader: true` writes that
 * variant so the reader's tolerance for it is exercised too.
 */
async function headerBytesFor(header, opts) {
  const body = serializeLLSDBinary(header, { header: false });
  if (!opts.textHeader) return body;
  const tag = new TextEncoder().encode("<? llsd/binary ?>\n");
  const out = new Uint8Array(tag.length + body.length);
  out.set(tag, 0);
  out.set(body, tag.length);
  return out;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** An axis-aligned box, centred, with per-face normals and UVs. */
export function boxMesh(sx = 1, sy = 1, sz = 1) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  // SL frame: X forward, Y left, Z up (the viewer renders it Z-up).
  const faces = [
    { n: [1, 0, 0], v: [[hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, hy, -hz], [-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[hx, -hy, hz], [-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz]] },
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(f.v[i][0], f.v[i][1], f.v[i][2]);
      normals.push(f.n[0], f.n[1], f.n[2]);
      uvs.push(i === 0 || i === 3 ? 0 : 1, i < 2 ? 0 : 1);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/** A square pyramid (roof). `offset` lifts it off the origin, since every
 * submesh of an asset lives in the same space as the others. */
export function pyramidMesh(size = 1, height = 1, offset = [0, 0, 0]) {
  const h = size / 2;
  const dz = offset[2] || 0;
  const apex = [offset[0] || 0, offset[1] || 0, dz + height / 2];
  const base = [
    [(offset[0] || 0) - h, (offset[1] || 0) - h, dz - height / 2],
    [(offset[0] || 0) + h, (offset[1] || 0) - h, dz - height / 2],
    [(offset[0] || 0) + h, (offset[1] || 0) + h, dz - height / 2],
    [(offset[0] || 0) - h, (offset[1] || 0) + h, dz - height / 2],
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i < 4; i++) {
    const a = base[i];
    const b = base[(i + 1) % 4];
    // The outward normal of a pyramid face is the cross product of its edges.
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [apex[0] - a[0], apex[1] - a[1], apex[2] - a[2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / len, n[1] / len, n[2] / len];
    const baseIndex = positions.length / 3;
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], apex[0], apex[1], apex[2]);
    normals.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
    uvs.push(0, 0, 1, 0, 0.5, 1);
    indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
  }
  // Closure quad, wound so it faces downwards like its normal.
  const b0 = positions.length / 3;
  for (const v of [base[3], base[2], base[1], base[0]]) { positions.push(v[0], v[1], v[2]); normals.push(0, 0, -1); uvs.push(v[0] + h, v[1] + h); }
  indices.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/**
 * A gable roof: two slopes meeting at a ridge that runs along X, with a
 * triangular gable at each end. This is what a house roof actually is — the
 * square pyramid gave a roof deeper than the building it sat on. `offset`
 * places the eaves, and the eaves are meant to sit a centimetre or two *inside*
 * the top of the walls so no slit shows between roof and wall.
 */
export function prismRoofMesh(sx = 1, sy = 1, height = 1, offset = [0, 0, 0]) {
  const hx = sx / 2, hy = sy / 2;
  const ox = offset[0] || 0, oy = offset[1] || 0, oz = offset[2] || 0;
  const eaveL = [ox - hx, oy - hy, oz];
  const eaveR = [ox + hx, oy - hy, oz];
  const eaveR2 = [ox + hx, oy + hy, oz];
  const eaveL2 = [ox - hx, oy + hy, oz];
  const ridgeL = [ox - hx, oy, oz + height];
  const ridgeR = [ox + hx, oy, oz + height];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const faceNormal = (a, b, c) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
  };
  const emit = (verts, n, uvsOf) => {
    const base = positions.length / 3;
    verts.forEach((v, i) => {
      positions.push(v[0], v[1], v[2]);
      normals.push(n[0], n[1], n[2]);
      uvs.push(uvsOf(i)[0], uvsOf(i)[1]);
    });
    for (let i = 2; i < verts.length; i++) indices.push(base, base + i - 1, base + i);
  };
  const quad = (a, b, c, d, uv) => emit([a, b, c, d], faceNormal(a, b, c), uv);
  const tri = (a, b, c, uv) => emit([a, b, c], faceNormal(a, b, c), uv);
  const quadUV = (i) => [[0, 0], [1, 0], [1, 1], [0, 1]][i];
  // -Y slope and +Y slope (winding decides which way each normal points).
  quad(eaveL, eaveR, ridgeR, ridgeL, quadUV);
  quad(eaveR2, eaveL2, ridgeL, ridgeR, quadUV);
  // Gable ends.
  tri(eaveL2, eaveL, ridgeL, (i) => [[0, 1], [1, 1], [0.5, 0]][i]);
  tri(eaveR, eaveR2, ridgeR, (i) => [[0, 1], [1, 1], [0.5, 0]][i]);
  // Underside, so the roof is a closed solid even seen from below.
  quad(eaveL, eaveL2, eaveR2, eaveR, quadUV);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/** A "house": a box for one material and a roof for another. The roof's eaves
 * sit just *inside* the top of the box (not exactly on it): two coincident
 * planes z-fight, and the fight looks like thin coloured stripes that are easy
 * to mistake for a broken texture. Vertices are in metres — the prim's scale
 * multiplies them, as in SL. */
export async function houseMeshAsset() {
  return buildMeshAsset([
    encodeSubmesh(boxMesh(6, 4, 3)),
    encodeSubmesh(prismRoofMesh(6.4, 4.4, 2, [0, 0, 1.44])),
  ]);
}

/** A plain box asset, one material. */
export async function boxMeshAsset(size = [2, 2, 2]) {
  return buildMeshAsset([encodeSubmesh(boxMesh(size[0], size[1], size[2]))]);
}

/**
 * An asset with two materials, the first slot empty (`NoGeometry`), so the
 * reader has to keep the empty entry and still texture the second submesh with
 * face 1.
 */
export async function twoMaterialAsset() {
  return buildMeshAsset([null, encodeSubmesh(boxMesh(2, 1, 1))]);
}
