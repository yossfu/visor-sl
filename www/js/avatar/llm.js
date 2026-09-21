// Reader for the SL avatar mesh files (`.llm`), the format described by
// indra/llappearance/llpolymesh.cpp and llpolymorph.cpp.
//
// Layout (little-endian, "Linden Binary Mesh 1.0"):
//
//   0    128 bytes  header string (padded)
//   24   U8         hasWeights
//   25   U8         hasDetailTexCoords
//   26   F32 x3     position
//   38   F32 x3     rotationAngles
//   50   U8         rotationOrder
//   51   F32 x3     scale
//   63   U16        numVertices
//        F32 x3 x N base coordinates
//        F32 x3 x N base normals
//        F32 x3 x N base binormals
//        F32 x2 x N texture coordinates
//        [F32 x2 x N detail tex coords]   if hasDetailTexCoords
//        [F32 x N   skin weights]         if hasWeights
//        U16        numFaces
//        U16 x3 x numFaces  (vertex indices)
//        U16        numSkinJoints
//        char[64] x numSkinJoints joint names
//        morphs until the 64-byte name "End Morphs":
//          char[64] morphName
//          S32      numMorphVertices
//          per vertex: U32 index, F32 x3 delta position, F32 x3 delta normal,
//                      F32 x3 delta binormal, F32 x2 delta uv
//
// The morph targets are what makes an SL avatar *the* avatar of a particular
// resident: the shape sliders (avatar_lad.xml visual params, sent in
// AvatarAppearance) are weights on these named targets.

export const LLM_HEADER = "Linden Binary Mesh 1.0";

export function parseLLM(bytes) {
  const len = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = ascii(bytes, 0, 24);
  if (!header.startsWith(LLM_HEADER)) {
    throw new Error("no es una malla Linden: " + JSON.stringify(header.slice(0, 24)));
  }
  let p = 24;
  const hasWeights = bytes[p++] > 0;
  const hasDetailTexCoords = bytes[p++] > 0;
  const position = readF32x3(view, (p += 0));
  p += 12;
  const rotation = readF32x3(view, p);
  p += 12;
  const rotationOrder = bytes[p++];
  const scale = readF32x3(view, p);
  p += 12;
  const numVertices = view.getUint16(p, true);
  p += 2;

  const coords = new Float32Array(numVertices * 3);
  for (let i = 0; i < numVertices * 3; i++) coords[i] = view.getFloat32(p + i * 4, true);
  p += numVertices * 12;

  const normals = new Float32Array(numVertices * 3);
  for (let i = 0; i < numVertices * 3; i++) normals[i] = view.getFloat32(p + i * 4, true);
  p += numVertices * 12;

  const binormals = new Float32Array(numVertices * 3);
  for (let i = 0; i < numVertices * 3; i++) binormals[i] = view.getFloat32(p + i * 4, true);
  p += numVertices * 12;

  const texCoords = new Float32Array(numVertices * 2);
  for (let i = 0; i < numVertices * 2; i++) texCoords[i] = view.getFloat32(p + i * 4, true);
  p += numVertices * 8;

  let detailTexCoords = null;
  if (hasDetailTexCoords) {
    detailTexCoords = new Float32Array(numVertices * 2);
    for (let i = 0; i < numVertices * 2; i++) detailTexCoords[i] = view.getFloat32(p + i * 4, true);
    p += numVertices * 8;
  }

  let weights = null;
  if (hasWeights) {
    weights = new Float32Array(numVertices);
    for (let i = 0; i < numVertices; i++) weights[i] = view.getFloat32(p + i * 4, true);
    p += numVertices * 4;
  }

  const numFaces = view.getUint16(p, true);
  p += 2;
  const faces = new Uint16Array(numFaces * 3);
  for (let i = 0; i < numFaces * 3; i++) faces[i] = view.getUint16(p + i * 2, true);
  p += numFaces * 6;

  const numSkinJoints = view.getUint16(p, true);
  p += 2;
  const jointNames = [];
  for (let i = 0; i < numSkinJoints; i++) {
    jointNames.push(cString(bytes, p, 64));
    p += 64;
  }

  const morphs = new Map();
  while (p + 64 <= len) {
    const name = cString(bytes, p, 64);
    p += 64;
    if (name === "End Morphs" || name.length === 0) break;
    const count = view.getInt32(p, true);
    p += 4;
    if (count < 0 || count > 20000 || p + count * 48 > len) break;
    const indices = new Uint32Array(count);
    const dCoords = new Float32Array(count * 3);
    const dNormals = new Float32Array(count * 3);
    const dBinormals = new Float32Array(count * 3);
    const dUV = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      indices[i] = view.getUint32(p, true); p += 4;
      for (let k = 0; k < 3; k++) { dCoords[i * 3 + k] = view.getFloat32(p, true); p += 4; }
      for (let k = 0; k < 3; k++) { dNormals[i * 3 + k] = view.getFloat32(p, true); p += 4; }
      for (let k = 0; k < 3; k++) { dBinormals[i * 3 + k] = view.getFloat32(p, true); p += 4; }
      for (let k = 0; k < 2; k++) { dUV[i * 2 + k] = view.getFloat32(p, true); p += 4; }
    }
    morphs.set(name, { indices, coords: dCoords, normals: dNormals, binormals: dBinormals, uv: dUV });
  }

  return {
    position, rotation, scale, rotationOrder,
    hasWeights, hasDetailTexCoords,
    numVertices, coords, normals, binormals, texCoords, detailTexCoords, weights,
    numFaces, faces, jointNames, morphs, bytesRead: p, totalBytes: len,
  };
}

/**
 * Applies named morph weights to a parsed mesh. `params` maps a morph name to a
 * weight in 0..1 (a visual param's current value, normalised). Returns fresh
 * typed arrays so several avatars can share one parsed mesh.
 */
export function morphMesh(mesh, weights) {
  const n = mesh.numVertices;
  const coords = mesh.coords.slice();
  const normals = mesh.normals.slice();
  let applied = 0;
  for (const [name, w] of weights) {
    if (!w) continue;
    const m = mesh.morphs.get(name);
    if (!m) continue;
    applied++;
    for (let i = 0; i < m.indices.length; i++) {
      const v = m.indices[i];
      if (v >= n) continue;
      for (let k = 0; k < 3; k++) {
        coords[v * 3 + k] += m.coords[i * 3 + k] * w;
        normals[v * 3 + k] += m.normals[i * 3 + k] * w;
      }
    }
  }
  return { coords, normals, applied };
}

function ascii(bytes, off, len) {
  let s = "";
  for (let i = 0; i < len && off + i < bytes.length; i++) s += String.fromCharCode(bytes[off + i]);
  return s;
}

function cString(bytes, off, max) {
  let s = "";
  for (let i = 0; i < max; i++) {
    const c = bytes[off + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function readF32x3(view, off) {
  return [view.getFloat32(off, true), view.getFloat32(off + 4, true), view.getFloat32(off + 8, true)];
}
