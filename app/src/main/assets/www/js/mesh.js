// Second Life mesh assets — the `LLMESH` asset (what GetMesh serves, and what a
// `.llm` file on disk is). Everything in SL that is not a prim shape is one of
// these: the modern buildings, trees, furniture and vehicles that a region is
// mostly made of. Without them a region shows terrain and a handful of boxes,
// which is exactly what "no structures" looks like.
//
// FORMAT (port of `LLModel::loadModel`, `LLVolume::unpackVolumeFacesInternal`
// and `LLMeshRepository::headerReceived` from the Linden viewer):
//
//   [header]  a BINARY LLSD map, optionally behind the deprecated
//             `<? llsd/binary ?>` text tag (`strip_deprecated_header`):
//               material_list            names of the materials (upload tool)
//               submodel_id              set when this is a submodel
//               skin{offset,size}        zlib block
//               physics_convex{offset,size}
//               physics_mesh{offset,size}
//               lowest_lod {offset,size}  each level of detail
//               low_lod    {offset,size}
//               medium_lod {offset,size}
//               high_lod   {offset,size}
//
//   [blocks]  each is a *zlib* stream (deflateInit, so the zlib wrapper — the
//             browser's DecompressionStream("deflate")) holding a binary LLSD
//             ARRAY with one entry per material. The header's `offset`s are
//             measured from the END of the header.
//
// Each LOD entry:
//   Position      U16 x3 per vertex, inside PositionDomain Min/Max
//   Normal        U16 x3, mapped to -1..1
//   TexCoord0     U16 x2 per vertex, inside TexCoord0Domain Min/Max
//   TriangleList  U16 x3 per triangle (vertex indices)
//   Weights       compact skin stream: U8 bone, then U16 weight pairs, 0xFF
//                 closes each vertex
//   NoGeometry    the material slot is unused (the empty entry is kept so the
//                 remaining entries still line up with the object's texture
//                 faces)
//
// A submesh at index i belongs to texture face i of the object that references
// the asset, which is why the empty entries are preserved.

export const MESH_LODS = ["lowest_lod", "low_lod", "medium_lod", "high_lod"];

// ---------------------------------------------------------------------------
// zlib
// ---------------------------------------------------------------------------

let fflatePromise = null;

/**
 * Inflates one zlib block. `DecompressionStream("deflate")` is the zlib
 * container (not raw deflate), which is what the viewer's `inflateInit` writes.
 * Browsers inside some apps lack it, so fflate is the fallback.
 */
export async function inflateZlib(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof DecompressionStream === "function") {
    try {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) {
      throw new Error("mesh: bloque zlib corrupto (" + ((e && e.message) || e) + ")");
    }
  }
  if (!fflatePromise) fflatePromise = import("https://esm.sh/fflate@0.8.2");
  const fflate = await fflatePromise;
  return fflate.inflateSync(buf);
}

// ---------------------------------------------------------------------------
// Binary LLSD
// ---------------------------------------------------------------------------

// The tags are the ASCII characters of the notation form ('i', 'r', '{', ...)
// and every integer on the wire is BIG-ENDIAN: the viewer reads them through
// `ntohl` (`LLSDBinaryParser`). Maps and arrays carry a count, and a map entry
// is `k` + length + name + value.
const BINARY_HEADER_RE = /^<\?\s*llsd\/binary\s*\?>/i;

/**
 * Parses one binary LLSD value starting at `start` and reports where it ended.
 * `next` is what makes a container (like a `.llm`) usable: the header's
 * `offset`s are counted from the byte right after the header.
 *
 * Unlike `llsd.js` this keeps no type wrappers — the mesh reader only needs
 * numbers, strings and byte ranges — but it does keep the byte ranges as
 * Uint8Array views (no copy).
 */
export function parseBinaryAt(data, start = 0) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let off = start;
  if (bytes[off] === 0x3c) { // '<' -> maybe the deprecated text tag
    const head = latin1(bytes, off, Math.min(bytes.length, off + 24));
    const m = BINARY_HEADER_RE.exec(head);
    if (m) {
      off += m[0].length;
      if (bytes[off] === 0x0d && bytes[off + 1] === 0x0a) off += 2;
      else if (bytes[off] === 0x0a) off += 1;
    }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = () => dv.getUint8(off++);
  const i32 = () => { const v = dv.getInt32(off, false); off += 4; return v; };
  const f64 = () => { const v = dv.getFloat64(off, false); off += 8; return v; };
  const take = (n) => { const v = bytes.subarray(off, off + n); off += n; return v; };
  const u32len = () => {
    const n = i32();
    if (n < 0) throw new Error("llsd binario: longitud negativa");
    return n;
  };

  function dec(depth) {
    if (depth > 96) throw new Error("llsd binario: demasiado anidado");
    const tag = u8();
    switch (tag) {
      case 0x21: return null;                                   // !
      case 0x30: return false;                                  // 0
      case 0x31: return true;                                   // 1
      case 0x69: return i32();                                  // i
      case 0x72: return f64();                                  // r
      case 0x75: return uuidText(take(16));                     // u
      case 0x73: case 0x6c: return latin1Bytes(take(u32len()));  // s / l (uri)
      case 0x62: return take(u32len());                          // b
      case 0x64: return f64();                                   // d (date)
      case 0x5b: {                                               // [
        const n = u32len();
        const out = new Array(n);
        for (let i = 0; i < n; i++) out[i] = dec(depth + 1);
        if (bytes[off] === 0x5d) off++;
        return out;
      }
      case 0x7b: {                                               // {
        const n = u32len();
        const out = {};
        for (let i = 0; i < n; i++) {
          const kt = u8();
          if (kt !== 0x6b) throw new Error("llsd binario: se esperaba una clave en el mapa");
          out[latin1Bytes(take(u32len()))] = dec(depth + 1);
        }
        if (bytes[off] === 0x7d) off++;
        return out;
      }
      default:
        throw new Error(`llsd binario: etiqueta desconocida 0x${tag.toString(16)} en el byte ${off - 1}`);
    }
  }

  const value = dec(0);
  return { value, next: off };
}

export function parseBinary(data, start = 0) {
  return parseBinaryAt(data, start).value;
}

function latin1(bytes, off, end) {
  let s = "";
  for (let i = off; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function latin1Bytes(b) {
  return latin1(b, 0, b.length);
}

function uuidText(b) {
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += b[i].toString(16).padStart(2, "0");
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

// ---------------------------------------------------------------------------
// The asset
// ---------------------------------------------------------------------------

const num = (v) => (typeof v === "number" ? v : Number(v));

function blockRange(header, name) {
  const entry = header && header[name];
  if (!entry || typeof entry !== "object") return null;
  const offset = num(entry.offset);
  const size = num(entry.size);
  if (!Number.isFinite(offset) || !Number.isFinite(size) || offset < 0 || size <= 0) return null;
  return { offset, size };
}

/**
 * Reads an asset's header without inflating anything: which LODs exist, where
 * each block lives, and the material names. This is all the viewer needs to
 * decide what to download, and all we need to decide a LOD later — the blocks
 * themselves are inflated on demand (`decodeMeshLod`), because a region can
 * hold hundreds of meshes and four LODs each would be a lot of memory.
 */
export function decodeMeshHeader(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const seen = parseBinaryAt(buf, 0);
  const header = seen.value;
  if (!header || typeof header !== "object" || Array.isArray(header) || header instanceof Uint8Array) {
    throw new Error("mesh: la cabecera no es un mapa LLSD");
  }
  const blocks = {};
  for (const name of MESH_LODS.concat(["skin", "physics_convex", "physics_mesh"])) {
    const range = blockRange(header, name);
    if (range) blocks[name] = range;
  }
  const lods = MESH_LODS.filter((n) => blocks[n]);
  return {
    header,
    base: seen.next,
    blocks,
    lods,
    materialList: Array.isArray(header.material_list) ? header.material_list.map(String) : [],
    submodelId: header.submodel_id === undefined ? 0 : num(header.submodel_id),
    version: header.version === undefined ? 0 : num(header.version),
    byteLength: buf.length,
  };
}

/**
 * Decodes one LOD into geometry the world can draw: one entry per material,
 * with positions/normals/uvs/indices already unpacked. Emptied material slots
 * (`NoGeometry`) are kept as `empty` so the indices still match the object's
 * texture faces.
 *
 * Faithful to `LLVolume::unpackVolumeFacesInternal`: the positions are U16
 * values spread across `PositionDomain`, the normals are U16 spread across
 * -1..1, and the UVs are U16 spread across `TexCoord0Domain`. The texture
 * coordinates are used as they come: the viewer does the same, and the
 * V flip that makes them line up is the one every SL texture already carries.
 */
export async function decodeMeshLod(bytes, info, lodName) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const range = info && info.blocks ? info.blocks[lodName] : null;
  if (!range) return null;
  const start = info.base + range.offset;
  if (start + range.size > buf.length) throw new Error(`mesh: el bloque ${lodName} se sale del activo`);
  const raw = await inflateZlib(buf.subarray(start, start + range.size));
  const list = parseBinaryAt(raw, 0).value;
  if (!Array.isArray(list)) throw new Error(`mesh: ${lodName} no es una lista de submeshes`);
  return decodeLodFaces(list);
}

/** Split out so a test can hand it a decoded LLSD list directly. */
export function decodeLodFaces(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const raw = list[i];
    if (!raw || typeof raw !== "object" || raw.NoGeometry !== undefined) {
      out.push({ id: i, faceID: i, materialIndex: i, empty: true, positions: null, normals: null, uvs: null, indices: null, triangles: 0, vertexCount: 0 });
      continue;
    }
    const pos = raw.Position instanceof Uint8Array ? raw.Position : new Uint8Array(raw.Position || 0);
    const norm = raw.Normal instanceof Uint8Array ? raw.Normal : new Uint8Array(raw.Normal || 0);
    const tc = raw.TexCoord0 instanceof Uint8Array ? raw.TexCoord0 : new Uint8Array(raw.TexCoord0 || 0);
    const idx = raw.TriangleList instanceof Uint8Array ? raw.TriangleList : new Uint8Array(raw.TriangleList || 0);

    // A trailing partial triangle is discarded, exactly as the viewer does.
    const total = Math.floor(idx.length / 2);
    const numIndices = total - (total % 3);
    const indices = new Uint32Array(numIndices);
    const iv = new DataView(idx.buffer, idx.byteOffset, idx.byteLength);
    for (let j = 0; j < numIndices; j++) indices[j] = iv.getUint16(j * 2, true);

    const nverts = Math.floor(pos.length / 6);
    if (!nverts || numIndices < 3) {
      out.push({ id: i, faceID: i, materialIndex: i, empty: false, degenerate: true, positions: new Float32Array(0), normals: new Float32Array(0), uvs: new Float32Array(0), indices: new Uint32Array(0), triangles: 0, vertexCount: 0 });
      continue;
    }

    const pv = new DataView(pos.buffer, pos.byteOffset, pos.byteLength);
    const domain = raw.PositionDomain || {};
    const mn = toVec3(domain.Min, [0, 0, 0]);
    const mx = toVec3(domain.Max, [0, 0, 0]);
    const positions = new Float32Array(nverts * 3);
    for (let j = 0; j < nverts; j++) {
      for (let a = 0; a < 3; a++) {
        positions[j * 3 + a] = (pv.getUint16(j * 6 + a * 2, true) / 65535) * (mx[a] - mn[a]) + mn[a];
      }
    }

    const normals = new Float32Array(nverts * 3);
    if (norm.length) {
      const nv = new DataView(norm.buffer, norm.byteOffset, norm.byteLength);
      for (let j = 0; j < nverts; j++) {
        for (let a = 0; a < 3; a++) normals[j * 3 + a] = (nv.getUint16(j * 6 + a * 2, true) / 65535) * 2 - 1;
      }
    }

    const uvs = new Float32Array(nverts * 2);
    if (tc.length) {
      const tv = new DataView(tc.buffer, tc.byteOffset, tc.byteLength);
      const tdomain = raw.TexCoord0Domain || {};
      const tmn = toVec2(tdomain.Min, [0, 0]);
      const tmx = toVec2(tdomain.Max, [0, 0]);
      for (let j = 0; j < nverts; j++) {
        for (let a = 0; a < 2; a++) {
          const o = j * 4 + a * 2;
          const q = o + 2 <= tc.length ? tv.getUint16(o, true) : 0;
          uvs[j * 2 + a] = (q / 65535) * (tmx[a] - tmn[a]) + tmn[a];
        }
      }
    }

    out.push({
      id: i, faceID: i, materialIndex: i, empty: false,
      positions, normals, uvs, indices,
      vertexCount: nverts, triangles: numIndices / 3,
      weights: raw.Weights instanceof Uint8Array ? raw.Weights : null,
    });
  }
  return out;
}

function toVec3(v, fallback) {
  if (Array.isArray(v) && v.length >= 3) return [num(v[0]), num(v[1]), num(v[2])];
  if (v && typeof v === "object" && v.length === undefined && v.x !== undefined) return [num(v.x), num(v.y), num(v.z)];
  return fallback;
}

function toVec2(v, fallback) {
  if (Array.isArray(v) && v.length >= 2) return [num(v[0]), num(v[1])];
  return fallback;
}

// ---------------------------------------------------------------------------
// Choosing a level of detail
// ---------------------------------------------------------------------------

/**
 * The viewer's own LOD choice is based on the distance and the prim size; this
 * viewer already computes an equivalent `detail` (1 = coarsest) per prim, so
 * the mesh LOD is just that number named.
 */
export function lodForDetail(detail) {
  const d = Math.max(1, Math.min(4, Math.round(detail || 1)));
  return MESH_LODS[d - 1];
}

/** The closest existing LOD to the one wanted, so something is always drawn. */
export function nearestLod(lods, want) {
  if (!lods || !lods.length) return null;
  if (lods.includes(want)) return want;
  const wi = MESH_LODS.indexOf(want);
  let best = lods[0];
  let bestDist = Infinity;
  for (const l of lods) {
    const d = Math.abs(MESH_LODS.indexOf(l) - wi);
    if (d < bestDist) { bestDist = d; best = l; }
  }
  return best;
}

/** Vertices/triangles/materials of one decoded LOD, for the diagnostics panel. */
export function meshLodStats(faces) {
  const s = { faces: 0, vertices: 0, triangles: 0, empty: 0, skinned: 0 };
  for (const f of faces || []) {
    if (f.empty) { s.empty++; continue; }
    s.faces++;
    s.vertices += f.vertexCount || 0;
    s.triangles += f.triangles || 0;
    if (f.weights) s.skinned++;
  }
  return s;
}
