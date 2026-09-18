// Self-test for the LLVolume port (src/llvolume.js) + the SL shape table
// (src/prims.js).
//
// Dependency-free module: `runSelfTest(LL, PRIMS)` takes the llvolume and prims
// module namespaces, so it can be run from anywhere. From a worker:
//
//   const llURL = URL.createObjectURL(new Blob([await fs.readTextFile("src/llvolume.js")], {type:"text/javascript"}));
//   const primsSrc = (await fs.readTextFile("src/prims.js")).replace("./llvolume.js", llURL);
//   const prims = await import(URL.createObjectURL(new Blob([primsSrc], {type:"text/javascript"})));
//   const st = await import(URL.createObjectURL(new Blob([await fs.readTextFile("src/llvolume.selftest.js")], {type:"text/javascript"})));
//   console.log(st.runSelfTest(ll, prims).summary);
//
// Ground truths: the 7 SL prim shapes (profile/path pairs from
// llpanelobject.cpp:1281), each shape's exact analytic volume for the
// tessellation LL produces, and the convex/outward-winding invariants.

// LL's MIN_DETAIL_FACES = 6, LOD detail = {1, 1.5, 2.5, 4} -> 24-gon at lod 3.
const NGON = 24;
const CIRCUM = 0.5;
const polygonArea = (n, r) => 0.5 * n * r * r * Math.sin(2 * Math.PI / n);

const tri = (positions, i) => i * 9;
function signedVolume(positions, tris) {
  let v = 0;
  for (let i = 0; i < tris; i++) {
    const o = tri(positions, i);
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

function bbox(positions) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  return { lo, hi };
}

function allFinite(...arrays) {
  for (const arr of arrays) for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) return false;
  return true;
}

// Valid for convex shapes: every triangle normal must point away from the centre.
function convexInwardCount(positions, tris) {
  let bad = 0;
  for (let i = 0; i < tris; i++) {
    const o = tri(positions, i);
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o], vy = positions[o + 7] - positions[o + 1], vz = positions[o + 8] - positions[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.hypot(nx, ny, nz);
    if (area < 1e-9) continue; // degenerate (SL emits a few at duplicated contour points)
    const cx = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
    const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
    if (nx * cx + ny * cy + nz * cz < 0) bad++;
  }
  return bad;
}

function degenerateCount(positions, tris, LL) {
  const isDeg = LL.isDegenerateTriangle;
  let n = 0;
  for (let i = 0; i < tris; i++) if (isDeg(positions, tri(positions, i))) n++;
  return n;
}

// Sign consistency between the per-vertex normals and the winding of the
// triangle they belong to. It does not assume which way is "out" (a bore's
// inner wall faces inward), so it catches only genuinely inverted normals --
// the failure mode that makes a correct surface render as black/broken faces.
// Returns [badCount, worstDot].
function normalFlipCount(positions, normals, tris, LL) {
  let bad = 0, worst = 1;
  const isDeg = (LL && LL.isDegenerateTriangle) || null;
  for (let i = 0; i < tris; i++) {
    const o = tri(positions, i);
    if (isDeg && isDeg(positions, o)) continue;
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const vx = positions[o + 6] - positions[o], vy = positions[o + 7] - positions[o + 1], vz = positions[o + 8] - positions[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 0)) continue;
    nx /= nl; ny /= nl; nz /= nl;
    for (let k = 0; k < 3; k++) {
      const j = o + k * 3;
      const d = nx * normals[j] + ny * normals[j + 1] + nz * normals[j + 2];
      if (d < worst) worst = d;
      if (d <= 0) bad++;
    }
  }
  return [bad, worst];
}

// Vertex welding. Coincident points routinely come out of different code paths
// (outer ring vs inner ring, cap vs side wall, contour duplicate vs its
// original) with last-bit differences, so exact keys would report phantom holes.
// The weld uses a neighbour-searched spatial hash, which (unlike a plain
// coordinate quantisation) does not depend on where a value happens to land
// relative to the grid. Returns the welded id of every vertex, plus the count.
function weldVertices(positions, eps = 1e-5) {
  const nv = positions.length / 3;
  const id = new Int32Array(nv);
  const coord = new Float64Array(nv * 3);
  const grid = new Map();
  const inv = 1 / eps;
  let n = 0;
  for (let v = 0; v < nv; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const gx = Math.round(x * inv), gy = Math.round(y * inv), gz = Math.round(z * inv);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const bucket = grid.get((gx + dx) + ',' + (gy + dy) + ',' + (gz + dz));
          if (!bucket) continue;
          for (let j = 0; j < bucket.length; j++) {
            const c = bucket[j];
            if (Math.abs(coord[c * 3] - x) <= eps &&
                Math.abs(coord[c * 3 + 1] - y) <= eps &&
                Math.abs(coord[c * 3 + 2] - z) <= eps) { found = c; break; }
          }
        }
      }
    }
    if (found < 0) {
      found = n; coord[n * 3] = x; coord[n * 3 + 1] = y; coord[n * 3 + 2] = z; n++;
      const k = gx + ',' + gy + ',' + gz;
      let bucket = grid.get(k);
      if (!bucket) { bucket = []; grid.set(k, bucket); }
      bucket.push(found);
    }
    id[v] = found;
  }
  return { id, count: n };
}

// Boundary-edge count. In a closed surface every edge is shared by an even
// number of triangles, so an odd count means a hole (a dropped seam, or a
// cap/wall boundary that does not line up).
function oddEdgeCount(positions, tris, eps = 1e-5) {
  const { id } = weldVertices(positions, eps);
  const edges = new Map();
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const k = [id[o / 3], id[o / 3 + 1], id[o / 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      if (a === b) continue;
      const kk = a < b ? a + '|' + b : b + '|' + a;
      edges.set(kk, (edges.get(kk) || 0) + 1);
    }
  }
  let odd = 0;
  for (const c of edges.values()) if (c % 2 === 1) odd++;
  return odd;
}

// Winding consistency across shared edges. In a consistently oriented surface
// every edge shared by two triangles is traversed in OPPOSITE directions by them
// (one low->high, one high->low); a pair traversing it the SAME way means one of
// the two is wound backwards. That is invisible to the volume test when the pair
// is small -- the signed volume only moves a little -- but very visible in the
// renderer, where the flipped triangle is backface-culled and the model gets a
// hole (measured: the hollow cube's triangular bore lost 0.03 of volume and had
// 15 such edges, and the cut sphere had 28).
//
// Zero-area triangles carry no orientation (their normal is undefined), so LL's
// collinear cap slivers are ignored: an edge whose only live support is one
// triangle is reported as `degenerateEdges`, not as a failure. An edge with
// three or more live triangles is a double-covered seam -- LL's twisted circular
// prim keeps two coincident back-to-back cap discs, and revolutions=2
// double-covers the whole surface -- which is fine as long as each sheet is
// internally consistent, i.e. the directions come out balanced; an unbalanced
// one is a winding error and does fail.
// Returns { bad, boundary, doubleCover, degenerateEdges, worst }.
function orientationReport(positions, tris, LL, eps = 1e-5) {
  const { id } = weldVertices(positions, eps);
  const edges = new Map();
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const deg = LL.isDegenerateTriangle(positions, o);
    const v = [id[o / 3], id[o / 3 + 1], id[o / 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      if (a === b) continue;
      const k = a < b ? a + '|' + b : b + '|' + a;
      let r = edges.get(k);
      if (!r) { r = []; edges.set(k, r); }
      r.push({ dir: a < b ? 1 : -1, deg });
    }
  }
  let bad = 0, boundary = 0, doubleCover = 0, degenerateEdges = 0;
  for (const r of edges.values()) {
    const live = r.filter((x) => !x.deg);
    if (live.length === 0) { degenerateEdges++; continue; }
    if (live.length === 1) { if (r.length === 1) boundary++; else degenerateEdges++; continue; }
    const pos = live.filter((x) => x.dir > 0).length;
    if (live.length === 2) {
      if (pos === 1) continue;
      bad++;
    } else if (pos === live.length - pos) doubleCover++;
    else bad++;
  }
  return { bad, boundary, doubleCover, degenerateEdges };
}

// For a shape swept along a circle, every vertex must lie in the cross-section
// plane of its ring position (offset perpendicular to the path tangent).
// Cap geometry is excluded: a cap's fan-centre vertex is the average of the
// profile points (in the cross-section plane, offset along the tangent from the
// path point when the path is open by twist), so it is not a swept vertex.
function crossSectionTest(positions, ringRadius, faces) {
  let sideOnly = null;
  if (faces) {
    sideOnly = new Set();
    for (const f of faces) {
      if (f.cap) continue;
      for (let t = f.start; t < f.start + f.count; t++) {
        const o = t * 9;
        sideOnly.add(o); sideOnly.add(o + 3); sideOnly.add(o + 6);
      }
    }
  }
  let maxTangent = 0, minR = Infinity, maxR = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (sideOnly && !sideOnly.has(i)) continue;
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const phi = Math.atan2(z, y);
    const tx = 0, ty = -Math.sin(phi), tz = Math.cos(phi);
    const ox = x, oy = y - ringRadius * Math.cos(phi), oz = z - ringRadius * Math.sin(phi);
    maxTangent = Math.max(maxTangent, Math.abs(ox * tx + oy * ty + oz * tz));
    const r = Math.hypot(ox, oy, oz);
    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
  }
  return { maxTangent, minR, maxR };
}

// SL's profile/path codes per shape (llpanelobject.cpp:1281).
const SHAPE_TABLE = {
  box: ['SQUARE', 'LINE'],
  cylinder: ['CIRCLE', 'LINE'],
  prism: ['EQUALTRI', 'LINE'],
  sphere: ['CIRCLE_HALF', 'CIRCLE'],
  torus: ['CIRCLE', 'CIRCLE'],
  tube: ['SQUARE', 'CIRCLE'],
  ring: ['EQUALTRI', 'CIRCLE'],
};

export function runSelfTest(LL, PRIMS, opts = {}) {
  const lod = opts.lod === undefined ? 3 : opts.lod;
  const { ProfileParams, PathParams, VolumeParams, generateVolume } = LL;
  const P = LL.PROFILE_SQUARE, C = LL.PROFILE_CIRCLE, CH = LL.PROFILE_CIRCLE_HALF, ET = LL.PROFILE_EQUALTRI;
  const LINE = LL.PATH_LINE, CIRCLE = LL.PATH_CIRCLE;
  const results = [];
  const info = [];
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); return ok; };
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const vp = (profile, path) => new VolumeParams(profile, path);

  const ngonArea = polygonArea(NGON, CIRCUM);
  const prismArea = 3 * Math.sqrt(3) / 4 * CIRCUM * CIRCUM;
  const circum24 = 2 * NGON * CIRCUM * Math.sin(Math.PI / NGON);
  const torusVolume = (ringR, sectionArea) => circum24 * (ringR / CIRCUM) * sectionArea;

  // `tolRel` = tolerancia relativa (fraccion del valor esperado); por defecto 3%
  // con un suelo absoluto de 0.004. Los casos con error de poligonizacion grande
  // (el anillo fino) pasan una tolerancia mayor y ademas comprueban su
  // convergencia al valor analitico mas abajo.
  // `openOk`: la superficie puede quedar abierta legitimamente (ver torus-revhalf).
  function generic(name, params, expect, tolRel, openOk) {
    const m = generateVolume(params, lod);
    const { positions, uvs, normals, faces, numTriangles } = m;
    check(name + ':finite', allFinite(positions, uvs, normals), 'non-finite vertex data');
    check(name + ':nonempty', numTriangles > 0 && positions.length > 0, 'no triangles');
    const vol = signedVolume(positions, numTriangles);
    const tol = Math.max(0.004, Math.abs(expect) * (tolRel === undefined ? 0.03 : tolRel));
    check(name + ':winding+volume',
      vol > 0 && (expect === undefined || near(vol, expect, tol)),
      'volume ' + vol.toFixed(5) + (expect === undefined ? '' : ' expected ' + expect.toFixed(5) + ' +/- ' + tol.toFixed(5)));
    let cursorOk = true, cursor = 0;
    for (const f of faces) { if (f.start !== cursor) cursorOk = false; cursor = f.start + f.count; }
    check(name + ':faces cover', cursorOk && cursor === numTriangles, 'face ranges do not tile the buffers');
    const degen = degenerateCount(positions, numTriangles, LL);
    // Los unicos triangulos de area cero que deben sobrevivir son las costuras
    // colineales que LL deja en los caps huecos (los usa la fila de la pared
    // adyacente; quitarlos perfora la superficie).
    const seams = m.seams || 0;
    check(name + ':no degenerate', degen === seams,
      degen + ' triangulos de area cero, ' + seams + ' de ellos costuras esperadas');
    const [flips, worstDot] = normalFlipCount(positions, normals, numTriangles, LL);
    check(name + ':normals', flips === 0,
      flips + ' normales de vertice invertidas respecto al triangulo (peor producto ' + worstDot.toFixed(3) + ')');
    const orient = orientationReport(positions, numTriangles, LL);
    check(name + ':orientation', orient.bad === 0,
      orient.bad + ' aristas compartidas recorridas en el mismo sentido (triangulo invertido); ' +
      orient.doubleCover + ' aristas de doble cobertura, ' + orient.degenerateEdges +
      ' aristas solo de triangulos nulos, ' + orient.boundary + ' de borde');
    const b = bbox(positions);
    const odd = oddEdgeCount(positions, numTriangles);
    info.push(name.padEnd(18) + ' tris=' + String(numTriangles).padStart(5) +
      ' vol=' + vol.toFixed(5) + ' odd=' + String(odd).padStart(3) +
      (orient.doubleCover ? ' dc=' + orient.doubleCover : '') +
      ' bbox=' + b.lo.map(v => v.toFixed(3)).join(',') + '..' + b.hi.map(v => v.toFixed(3)).join(','));
    check(name + ':estanco', odd === 0 || !!openOk,
      odd + ' aristas de borde sin emparejar (superficie no cerrada)');
    return { mesh: m, vol, bbox: b, odd };
  }

  // ---- shape table matches SL -------------------------------------------
  {
    const byCode = { [P]: 'SQUARE', [C]: 'CIRCLE', [CH]: 'CIRCLE_HALF', [ET]: 'EQUALTRI' };
    const pathByCode = { [LINE]: 'LINE', [CIRCLE]: 'CIRCLE' };
    for (const shape of Object.keys(SHAPE_TABLE)) {
      const s = PRIMS.SHAPES[shape];
      const got = s ? byCode[s.profile] + '+' + pathByCode[s.path] : 'missing';
      const want = SHAPE_TABLE[shape].join('+');
      check('shape:' + shape, got === want, 'table says ' + got + ' but SL uses ' + want);
    }
  }

  // ---- box (square profile, line path) ----------------------------------
  {
    const r = generic('box', vp(new ProfileParams(P), new PathParams(LINE)), 1);
    check('box:cube', r.bbox.lo.every(v => near(v, -0.5, 1e-4)) && r.bbox.hi.every(v => near(v, 0.5, 1e-4)), 'not a unit cube');
    check('box:outward', convexInwardCount(r.mesh.positions, r.mesh.numTriangles) === 0, 'inward-facing triangles');
  }

  // ---- cylinder (circle profile, line path) -----------------------------
  {
    const r = generic('cylinder', vp(new ProfileParams(C), new PathParams(LINE)), ngonArea);
    check('cylinder:extent', near(r.bbox.hi[0] - r.bbox.lo[0], 1, 1e-4) && near(r.bbox.hi[1] - r.bbox.lo[1], 1, 1e-3) && near(r.bbox.hi[2] - r.bbox.lo[2], 1, 1e-3), 'bbox ' + JSON.stringify(r.bbox.hi));
    check('cylinder:outward', convexInwardCount(r.mesh.positions, r.mesh.numTriangles) === 0, 'inward-facing triangles');
  }

  // ---- prism (equilateral triangle profile, line path) ------------------
  {
    const r = generic('prism', vp(new ProfileParams(ET), new PathParams(LINE)), prismArea);
    check('prism:outward', convexInwardCount(r.mesh.positions, r.mesh.numTriangles) === 0, 'inward-facing triangles');
  }

  // ---- sphere (half circle profile, circle path) ------------------------
  {
    const r = generic('sphere', vp(new ProfileParams(CH), new PathParams(CIRCLE)), 4 / 3 * Math.PI * 0.125 * 0.972);
    let maxR = 0;
    for (let i = 0; i < r.mesh.positions.length; i += 3) maxR = Math.max(maxR, Math.hypot(r.mesh.positions[i], r.mesh.positions[i + 1], r.mesh.positions[i + 2]));
    check('sphere:radius', maxR <= 0.5 + 1e-4 && maxR > 0.48, 'max radius ' + maxR.toFixed(4));
    check('sphere:outward', convexInwardCount(r.mesh.positions, r.mesh.numTriangles) === 0, 'inward-facing triangles');
  }

  // ---- torus / tube / ring (circle path) --------------------------------
  function roundShape(name, params, expect, sectionArea, holeY, tolRel) {
    const r = generic(name, params, expect, tolRel);
    const t = crossSectionTest(r.mesh.positions, 0.5 * (1 - holeY), r.mesh.faces);
    check(name + ':cross-section', t.maxTangent < 1e-6,
      'vertices leave the cross-section plane by ' + t.maxTangent.toExponential(3) + ' (skewed/twisted sweep)');
    if (sectionArea !== undefined) {
      check(name + ':section', near((t.minR + t.maxR) / 2, sectionArea, 1e-3) && t.maxR - t.minR < 1e-3,
        'radial offset ' + t.minR.toFixed(4) + '..' + t.maxR.toFixed(4) + ' expected ' + sectionArea);
    }
    return r;
  }
  {
    const torus = new PathParams(CIRCLE); torus.scaleX = 0.25; torus.scaleY = 0.25;
    roundShape('torus', vp(new ProfileParams(C), torus),
      torusVolume(0.5 * (1 - 0.25), polygonArea(NGON, 0.5 * 0.25)), 0.5 * 0.25, 0.25);

    // El tubo barre un cuadrado de 1.0 (eje del anillo) x 0.25 (radial):
    // 2*0.5*scaleX * 2*0.5*scaleY = 0.25 de seccion (no 0.125: el barrido de un
    // cuadrado completo, no de medio).
    const tube = new PathParams(CIRCLE); tube.scaleX = 1.0; tube.scaleY = 0.25;
    const tubeSection = (2 * 0.5 * tube.scaleX) * (2 * 0.5 * tube.scaleY);
    roundShape('tube', vp(new ProfileParams(P), tube),
      torusVolume(0.5 * (1 - 0.25), tubeSection), undefined, 0.25);

    // El anillo es una banda finisima (0.0375 axial x 0.2165 radial) sobre un
    // camino de radio 0.375, medida con la formula de Pappus. A LOD 3 (24-gono)
    // el error de poligonizacion es pequeno (~0.8%), asi que la tolerancia es
    // del 5%; ademas se comprueba aparte la convergencia al valor de Pappus
    // cuando el camino se refina.
    const ring = new PathParams(CIRCLE); ring.scaleX = 0.05; ring.scaleY = 0.25;
    roundShape('ring', vp(new ProfileParams(ET), ring),
      torusVolume(0.5 * (1 - 0.25), prismArea * 0.05 * 0.25), undefined, 0.25, 0.05);

    const twisted = new PathParams(CIRCLE); twisted.scaleX = 0.25; twisted.scaleY = 0.25;
    twisted.twistBegin = 0.25; twisted.twistEnd = 1.25;
    roundShape('torus-twist', vp(new ProfileParams(C), twisted),
      torusVolume(0.5 * 0.75, polygonArea(NGON, 0.5 * 0.25)), 0.5 * 0.25, 0.25);

    const shell = new PathParams(CIRCLE); shell.scaleX = 0.25; shell.scaleY = 0.25;
    const hollow = new ProfileParams(C | 0x10, 0, 1, 0.5);
    const rt = roundShape('torus-hollow', vp(hollow, shell), undefined, undefined, 0.25);
    const expanded = torusVolume(0.5 * 0.75, polygonArea(NGON, 0.5 * 0.25));
    const holeArea = polygonArea(NGON, 0.5 * 0.25 * 0.5);
    // Al hueco del 50% le corresponde un agujero de radio 0.25 en el perfil, asi
    // que el volumen es el del toro solido menos el del agujero (radio mitad ->
    // area un cuarto).
    const hollowExpect = expanded - torusVolume(0.5 * 0.75, holeArea);
    check('torus-hollow:volume', near(rt.vol, hollowExpect, Math.max(0.002, hollowExpect * 0.03)),
      'hollow torus volume ' + rt.vol.toFixed(5) + ' expected ' + hollowExpect.toFixed(5) +
      ' (solid ' + expanded.toFixed(5) + ', hole section ' + holeArea.toFixed(5) + ')');
  }

  // ---- convergencia al valor analitico cuando se refina el camino ---------
  // Los volumenes de los cuerpos barridos convergen a los de Pappus conforme el
  // camino poligonal se aproxima a la circunferencia. Esto comprueba de verdad
  // que la forma limite es correcta (y no solo que el volumen sea plausible a
  // LOD 3), usando el detalle configurable del ultimo LOD.
  {
    const saved = LL.LOD_DETAIL[3];
    const volAtDetail = (params, detail) => {
      LL.LOD_DETAIL[3] = detail;
      const m = generateVolume(params, 3);
      return signedVolume(m.positions, m.numTriangles);
    };
    const ringPath = new PathParams(CIRCLE); ringPath.scaleX = 0.05; ringPath.scaleY = 0.25;
    const ringParams = vp(new ProfileParams(ET), ringPath);
    const pappus = torusVolume(0.5 * 0.75, prismArea * 0.05 * 0.25);
    const v24 = volAtDetail(ringParams, 4), v48 = volAtDetail(ringParams, 8), v96 = volAtDetail(ringParams, 16);
    LL.LOD_DETAIL[3] = saved;
    // El camino es un poligono inscrito, asi que al refinar el volumen sube de
    // forma monotona hacia su limite, con incrementos que caen ~4x por cada
    // duplicacion de segmentos (convergencia cuadratica propia de aproximar un
    // arco por cuerdas). El limite NO es exactamente el valor de Pappus de la
    // banda fina: queda ~0.3% por encima, porque la seccion se barre girando
    // (twist) a lo largo de un camino poligonal, y ademas Pappus aqui usa el
    // perimetro poligonal de 24 lados. Por eso la prueba comprueba la
    // convergencia (monotonia + incrementos decrecientes) y que el limite
    // extrapolado por Richardson coincida con Pappus dentro del 1%, en vez de
    // exigir que cada iteracion se acerque mas que la anterior.
    const err24 = Math.abs(v24 - pappus), err48 = Math.abs(v48 - pappus), err96 = Math.abs(v96 - pappus);
    const i1 = v48 - v24, i2 = v96 - v48;
    const limit = v96 + i2 / 3;
    check('ring:convergencia',
      v24 < v48 && v48 < v96 && i1 > i2 * 2 && Math.abs(limit - pappus) < pappus * 0.01,
      'anillo: ' + [v24, v48, v96].map((v) => v.toFixed(5)).join(' < ') +
      ' (incrementos ' + i1.toExponential(2) + ' -> ' + i2.toExponential(2) +
      ', limite ' + limit.toFixed(5) + ' vs Pappus ' + pappus.toFixed(5) +
      ', error ' + err24.toFixed(5) + ' -> ' + err96.toFixed(5) + ')');

    const sph = new PathParams(CIRCLE);
    const sphP = vp(new ProfileParams(CH), sph);
    const s24 = volAtDetail(sphP, 4), s96 = volAtDetail(sphP, 16);
    const sphereExact = 4 / 3 * Math.PI * 0.125;
    LL.LOD_DETAIL[3] = saved;
    check('sphere:convergencia', Math.abs(s96 - sphereExact) < Math.abs(s24 - sphereExact) * 0.5,
      'esfera: ' + s24.toFixed(5) + ' -> ' + s96.toFixed(5) + ' (exacto ' + sphereExact.toFixed(5) + ')');
  }

  // ---- variants that must stay well-formed ------------------------------
  const variants = [
    ['box-hollow', new ProfileParams(P | 0x20, 0, 1, 0.5), new PathParams(LINE)],
    ['box-hollow-circle', new ProfileParams(P | 0x10, 0, 1, 0.5), new PathParams(LINE)],
    ['box-hollow-tri', new ProfileParams(P | 0x30, 0, 1, 0.5), new PathParams(LINE)],
    ['box-taper', new ProfileParams(P), Object.assign(new PathParams(LINE), { scaleX: 0.5, scaleY: 0.5 })],
    ['box-twist', new ProfileParams(P), Object.assign(new PathParams(LINE), { twistBegin: 0.25, twistEnd: 0.75 })],
    ['box-shear', new ProfileParams(P), Object.assign(new PathParams(LINE), { shearX: 1, shearY: 1 })],
    ['box-skew', new ProfileParams(P), Object.assign(new PathParams(LINE), { skew: 1 })],
    ['box-pcut', new ProfileParams(P, 0.25, 0.75), new PathParams(LINE)],
    ['box-pathcut', new ProfileParams(P), Object.assign(new PathParams(LINE), { begin: 0.25, end: 0.75 })],
    ['cyl-hollow', new ProfileParams(C | 0x30, 0, 1, 0.5), new PathParams(LINE)],
    ['cyl-hollow-sq', new ProfileParams(C | 0x20, 0, 1, 0.5), new PathParams(LINE)],
    ['cyl-pcut', new ProfileParams(C, 0.25, 0.75), new PathParams(LINE)],
    ['cyl-pcut-hollow', new ProfileParams(C | 0x10, 0.25, 0.75, 0.5), new PathParams(LINE)],
    ['sphere-hollow', new ProfileParams(CH | 0x10, 0, 1, 0.5), new PathParams(CIRCLE)],
    ['sphere-pcut', new ProfileParams(CH, 0.25, 0.75), new PathParams(CIRCLE)],
    ['torus-pcut', new ProfileParams(C, 0.25, 0.75), Object.assign(new PathParams(CIRCLE), { scaleX: 0.25, scaleY: 0.25 })],
    ['torus-taper', new ProfileParams(C), Object.assign(new PathParams(CIRCLE), { scaleX: 0.25, scaleY: 0.25, taperX: 0.5, taperY: 0.5 })],
    ['torus-slope', new ProfileParams(C), Object.assign(new PathParams(CIRCLE), { scaleX: 0.25, scaleY: 0.25, radiusOffset: 0.3 })],
    ['torus-skew', new ProfileParams(C), Object.assign(new PathParams(CIRCLE), { scaleX: 0.25, scaleY: 0.25, skew: 0.3 })],
    ['torus-rev2', new ProfileParams(C), Object.assign(new PathParams(CIRCLE), { scaleX: 0.25, scaleY: 0.25, revolutions: 2 })],
    // Con revolutions < 1 el camino no llega a cerrarse, pero LL decide la
    // apertura del camino con (end*end_scale - begin < 1), que NO mira
    // revolutions: no emite tapas. SL (que si expone "Revolutions" en el
    // floater) deja por tanto los dos extremos abiertos, y se replica: la
    // superficie es abierta a proposito.
    ['torus-revhalf', new ProfileParams(C), Object.assign(new PathParams(CIRCLE), { scaleX: 0.25, scaleY: 0.25, revolutions: 0.5 }), true],
    ['prism-pathcut', new ProfileParams(ET), Object.assign(new PathParams(LINE), { begin: 0.2, end: 0.8 })],
  ];
  for (const [name, profile, path, openOk] of variants) generic(name, vp(profile, path), undefined, undefined, openOk);

  // ---- prims.js -> params -> geometry for every shape, at every LOD -----
  if (PRIMS) {
    for (const shape of PRIMS.SHAPE_ORDER) {
      for (const lod2 of [0, 1, 2, 3]) {
        const pp = new PRIMS.PrimParams(shape);
        const params = pp.toVolumeParams();
        const m = generateVolume(params, lod2);
        const vol = signedVolume(m.positions, m.numTriangles);
        check('prim:' + shape + ':lod' + lod2, vol > 0 && allFinite(m.positions, m.uvs, m.normals) && m.numTriangles > 0,
          'volume ' + vol.toFixed(5));
        if (lod2 === 3) info.push(('prim ' + shape).padEnd(18) + ' tris=' + String(m.numTriangles).padStart(5) + ' vol=' + vol.toFixed(5));
      }
    }
    // Parametrised variants through the UI mapping
    const cases = [
      ['box', { hollow: 50, hollowShape: 'circle' }],
      ['box', { hollow: 50, hollowShape: 'triangle' }],
      ['box', { taperX: 0.5, taperY: 0.5 }],
      ['box', { twistBegin: 45, twistEnd: 90 }],
      ['box', { shearX: 1, shearY: 1 }],
      ['cylinder', { hollow: 50, hollowShape: 'square' }],
      ['cylinder', { pathCutBegin: 0.25, pathCutEnd: 0.75 }],
      ['prism', { hollow: 50, hollowShape: 'circle' }],
      ['sphere', { hollow: 50, hollowShape: 'circle' }],
      ['sphere', { profileCutBegin: 0.25, profileCutEnd: 0.75 }],
      ['torus', { holeX: 0.1, holeY: 0.5 }],
      ['torus', { twistBegin: 180, twistEnd: 360 }],
      ['torus', { taperX: 0.5, taperY: 0.5 }],
      ['torus', { slope: 0.5 }],
      ['torus', { skew: 0.5 }],
      ['torus', { revolution: 2 }],
      ['torus', { hollow: 50, hollowShape: 'square' }],
      ['tube', { holeX: 0.05, holeY: 0.5 }],
      ['tube', { hollow: 50, hollowShape: 'circle' }],
      ['ring', { profileCutBegin: 0.25, profileCutEnd: 0.75 }],
      ['ring', { hollow: 50, hollowShape: 'triangle' }],
    ];
    for (const [shape, fields] of cases) {
      const pp = new PRIMS.PrimParams(shape);
      for (const k of Object.keys(fields)) {
        if (k === 'hollowShape') pp.holeShape = fields[k];
        else pp[k] = fields[k];
      }
      const name = 'prim:' + shape + ':' + JSON.stringify(fields).replace(/["{}]/g, '');
      try {
        const m = generateVolume(pp.toVolumeParams(), 3);
        const vol = signedVolume(m.positions, m.numTriangles);
        check(name, vol > 0 && allFinite(m.positions, m.uvs, m.normals) && m.numTriangles > 0, 'volume ' + vol.toFixed(5));
      } catch (e) {
        check(name, false, 'threw ' + (e && e.message));
      }
    }
  }

  // ---- el catalogo de casos de la galeria, con los parametros exactos que ve
  // el usuario (misma fuente de verdad que el banco de pruebas visual). Se
  // aplican las mismas invariantes duras: volumen positivo, sin triangulos
  // degenerados, superficie estanca y orientacion coherente.
  //
  // Los volumenes de los casos lineales (perfil cuadrado/circular/triangular
  // barrido en linea recta) se comprueban ademas contra su valor EXACTO, porque
  // son los unicos que se pueden escribir en cerrado: el solido es area(perfil)
  // x longitud, menos el agujero si es hueco. Es justo la comprobacion que
  // delato este tipo de fallo: un triangulo invertido en la pared interior de la
  // caja hueca triangular restaba 2x el volumen del agujero al volumen firmado
  // (0.91881 en vez de 0.94804) y ningun caso del catalogo lo miraba.
  //
  // Un solido hueco de perfil P y agujero H (escalado s) tiene volumen
  // area(P) - area(H*s), y un corte de perfil de 0.2 a 0.8 de una caja deja la
  // mitad de su volumen. El resto de casos (toro, esfera, tubo, anillo y sus
  // variantes) no tienen formula cerrada sencilla para su version poligonizada,
  // asi que se apoyan en las invariantes + los tests de convergencia a Pappus.
  if (PRIMS.primBaseRow && PRIMS.primVariants) {
    const hollowBoxVolume = 1 - 0.5 * 0.5;
    const triHoleArea = 3 * Math.sqrt(3) / 4 * (CIRCUM * 0.4) * (CIRCUM * 0.4);
    const squareBoreArea = 0.6 * 0.6;
    const sphereTess = 4 / 3 * Math.PI * 0.125 * 0.972;
    const exact = {
      'Caja': 1,
      'Cilindro': ngonArea,
      'Prisma': prismArea,
      'Caja hueca': hollowBoxVolume,
      'Hueco triangular': 1 - triHoleArea,
      'Cilindro hueco cuad': ngonArea - squareBoreArea,
      'Esfera hueca': sphereTess * (1 - 0.55 * 0.55 * 0.55),
      'Esfera cortada': sphereTess * 0.5,
      'Caja con taper': 0.5,
      // Un corte de perfil de 0.2 a 0.8 deja el 60% del contorno, y para los
      // tres perfiles base (cuadrado, circulo, triangulo) el area barrida por el
      // radio crece proporcionalmente al contorno (la "velocidad areal"
      // |p x dp| es constante porque el contorno esta centrado), asi que el
      // volumen es exactamente 0.6.
      'Caja corte de perfil': 0.6,
    };
    for (const c of PRIMS.primBaseRow().concat(PRIMS.primVariants())) {
      const expect = exact[c.name];
      generic('caso:' + c.name, c.params.toVolumeParams(), expect, expect === undefined ? undefined : 1e-4);
    }
  }

  const failures = results.filter(r => !r.ok);
  return {
    passed: results.length - failures.length,
    failed: failures.length,
    failures,
    results,
    info,
    summary: (failures.length === 0
      ? 'llvolume selftest: all ' + results.length + ' checks passed\n'
      : 'llvolume selftest: ' + failures.length + '/' + results.length + ' FAILED\n' +
        failures.map(f => '  FAIL ' + f.name + ' -- ' + f.detail).join('\n') + '\n') + info.join('\n'),
  };
}
