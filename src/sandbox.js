// sandbox.js -- el "mundo de arranque": lo que se ve al abrir el visor.
//
// Es un banco de pruebas construido con el propio motor (nada de geometria
// hardcodeada): una plataforma de arena, una escalera, una casa, arboles, un
// embarcadero sobre el agua y un arco de prims que muestra el rango de
// parametros del build floater de SL (huecos, cortes, twist, taper, shear).
//
// Devuelve `{objects, spawn, platform}`: los objetos creados, el punto donde
// aparece el avatar y la plataforma (que la fisica del avatar usa como suelo
// preferente para no caer al agua).
import * as THREE from "./three.js";
import { PrimParams } from "./prims.js";

// Contenido del cartel: LSL de verdad (lo compila el runtime del visor). Se
// escribe el `\\n` doble porque el fuente que ve el compilador tiene que llevar
// la barra invertida literal, como en SL.
const SIGN_SCRIPT = `// Cartel de bienvenida: script LSL que corre dentro del visor.
integer toques = 0;

default
{
    state_entry()
    {
        llSetText("Tócame", <1, 0.92, 0.6>, 1.0);
        llListen(0, "", NULL_KEY, "");
    }

    touch_start(integer num_detected)
    {
        toques = toques + 1;
        llSetColor(<0.2, 0.9, 0.6>, ALL_SIDES);
        llSetText("Tócame\\n(me has tocado " + (string)toques + ")", <0.7, 1, 0.8>, 1.0);
        llSay(0, "Soy un script LSL dentro del visor. Llevo " + (string)toques + (toques == 1 ? " toque." : " toques."));
    }

    listen(integer channel, string name, key id, string message)
    {
        if (id == llGetKey()) return;
        string m = llToLower(message);
        if (llSubStringIndex(m, "hola") >= 0)
        {
            llSay(0, "¡Hola, " + name + "! Escribe en el chat y te oigo; tócame para cambiarme de color.");
        }
        else if (llSubStringIndex(m, "script") >= 0)
        {
            llSay(0, "Puedes escribirme con el editor del panel de construcción (tecla B).");
        }
    }
}`;

// Contenido del anillo: giro continuo sin timer, como el "spin" de SL.
const SPIN_SCRIPT = `default
{
    state_entry()
    {
        llTargetOmega(<0, 0, 1>, 0.9, 1.0);
        llSetText("Girando (tócame)", <0.8, 0.9, 1>, 0.9);
    }

    touch_start(integer num_detected)
    {
        llTargetOmega(<0, 0, 1>, -0.9, 1.0);
        llSay(0, "Giro al revés.");
    }
}`;

export function buildSandbox(world, terrain) {
  const ground = terrain ? terrain.heightAt(0, 0) : 24.6;
  const water = terrain ? terrain.waterLevel : 20;
  const objects = [];

  const put = (shape, over, position, o = {}) => {
    const p = new PrimParams(shape);
    Object.assign(p, over);
    const scale = o.scale || [1, 1, 1];
    const obj = world.add(p, {
      name: o.name || shape,
      position: new THREE.Vector3(position[0], position[1], position[2]),
      scale: new THREE.Vector3(scale[0], scale[1], scale[2]),
      quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(
        (o.rotX || 0) * Math.PI / 180, (o.rotY || 0) * Math.PI / 180, (o.rotZ || 0) * Math.PI / 180,
        o.rotOrder || "XYZ")),
      phantom: o.phantom,
    });
    if (o.color) world.setColor(obj, o.color);
    // Textura procedural en todas las caras (ver `src/textures.js`). El tinte
    // del prim multiplica la textura, igual que en SL.
    if (o.tex) {
      world.setFaceAll(obj, {
        tex: { k: o.tex },
        repeat: o.rep || [1, 1],
        rotation: o.rot || 0,
        rough: o.rough === undefined ? null : o.rough,
        metal: o.metal === undefined ? null : o.metal,
        glow: o.glow || 0,
      });
    }
    objects.push(obj);
    return obj;
  };

  // Apoya un prim sobre una superficie usando su caja local de verdad: no todas
  // las formas miden 1 m de alto ni estan centradas (un toro, un anillo o un
  // tubo no lo estan), asi que sin esto unos quedan hundidos y otros flotando.
  const sit = (obj, y0, gap) => {
    const b = obj.localBox || { min: [0, -0.5, 0] };
    obj.position.y = y0 - b.min[1] * obj.scale.y + (gap === undefined ? 0.006 : gap);
    obj.sync();
    return obj;
  };

  // --- plataforma + escalera ------------------------------------------------
  // La plataforma se entierra 0.15 m: si su cara inferior quedase justo a la
  // altura del terreno (que en la meseta es exactamente `ground`), ambas
  // superficies serian coplanares y parpadearian al mirarlas de canto.
  const platform = put("box", {}, [0, ground + 0.225, 0], { scale: [26, 0.75, 26], name: "Plataforma", color: 0xd0ccc5, tex: "arena", rep: [13, 13], rough: 0.85 });
  const deck = ground + 0.6;  // cara superior de la plataforma
  // Escalera: cada escalon sube 0.2 m (el avatar de SL sube 0.5 m sin saltar) y
  // el mas alto esta pegado a la plataforma; solapados entre si para que no
  // quede ningun hueco por el que el suelo se caiga al terreno. El escalon de
  // abajo queda 0.12 m por encima del terreno para no ser coplanar con el.
  for (let i = 0; i < 3; i++) {
    const top = deck - 0.08 - 0.2 * i;             // 25.12, 24.92, 24.72
    put("box", {}, [0, top - 0.14, 13.35 + i * 0.58],
      { scale: [7, 0.28, 0.9], name: "Escalon " + (i + 1), color: 0xc7cdd4, tex: "adoquin", rep: [7, 1] });
  }

  // --- arco de prims (el catalogo del build floater) ------------------------
  const showcase = [
    { shape: "cylinder", over: { twistEnd: 120 }, scale: [1.3, 2.2, 1.3], name: "Cilindro con twist", color: 0xe1c1ad, tex: "marmol", rep: [2, 2] },
    { shape: "torus", over: { hollow: 0.4 }, scale: [1.5, 1.5, 1.5], name: "Toro hueco", color: 0xdce6f2, tex: "metal", rep: [3, 3], rough: 0.3, metal: 0.85 },
    { shape: "sphere", over: { pathCutBegin: 0.25, pathCutEnd: 0.75 }, scale: [1.6, 1.6, 1.6], name: "Media esfera", color: 0xfff0c8, tex: "oro", rep: [2, 2], rough: 0.28, metal: 0.9 },
    { shape: "box", over: { hollow: 0.45, holeShape: "triangle" }, scale: [1.5, 1.5, 1.5], name: "Hueco triangular", color: 0xb9d2ad, tex: "ladrillo", rep: [3, 3] },
    { shape: "tube", over: {}, scale: [2, 1, 2], name: "Tubo", rotY: 20, color: 0xd4b0c1, tex: "azulejo", rep: [2, 4] },
    { shape: "box", over: { profileCutBegin: 0.2, profileCutEnd: 0.8 }, scale: [1.6, 1.6, 1.6], name: "Corte de perfil", color: 0xc1c6cd, tex: "hormigon", rep: [2, 2] },
    { shape: "ring", over: {}, scale: [2, 2, 2], name: "Anillo", rotY: -30, color: 0xdda29b, tex: "oxido", rep: [4, 1] },
    { shape: "box", over: { taperX: -0.7, taperY: 0.5, twistEnd: 45 }, scale: [1.5, 2, 1.5], name: "Caja taper + twist", color: 0xa7b0b0, tex: "madera", rep: [2, 3] },
  ];
  // El arco se abre en abanico delante del punto de aparicion (que mira hacia
  // -Z), cubriendo de 191 a 331 grados: asi ningun prim cae en el pasillo de
  // salida (el avatar no tropieza nada mas nacer) pero se ven todos de frente.
  const arcR = 9.5, arcN = showcase.length;
  showcase.forEach((c, i) => {
    const a = Math.PI * (1.062 + (i / (arcN - 1)) * 0.778);
    const x = Math.sin(a) * arcR, z = Math.cos(a) * arcR;
    const obj = put(c.shape, c.over, [x, deck, z], {
      scale: c.scale, name: c.name, rotY: c.rotY || 0, color: c.color,
      tex: c.tex, rep: c.rep, rough: c.rough, metal: c.metal,
    });
    sit(obj, deck);
  });

  // --- demo de scripts (mini-LSL) -------------------------------------------
  // Dos prims con contenido de verdad: el cartel lleva un script LSL que se
  // compila al arrancar la region (el runtime del visor arranca todo prim que
  // tenga `obj.script`), y el anillo gira con `llTargetOmega`. Es la forma de
  // que la funcion se descubra sola: se toca el cartel y contesta.
  const signY = deck + 2.2;
  const sign = put("box", {}, [6.2, signY, 7.0], {
    scale: [2.6, 1.3, 0.18], name: "Cartel con script", color: 0x33445a, tex: "madera", rep: [1, 1], rough: 0.6,
  });
  for (const dx of [-1.0, 1.0]) {
    put("cylinder", {}, [6.2 + dx, deck + 1.05, 7.0],
      { scale: [0.16, 2.3, 0.16], name: "Poste del cartel", color: 0x9a8f80, tex: "madera", rep: [1, 2] });
  }
  sign.script = SIGN_SCRIPT;

  const ring = put("torus", {}, [7.6, deck + 1.7, 1.4], {
    scale: [1.5, 1.5, 1.5], name: "Anillo giratorio", color: 0xcfe3ff, tex: "metal", rep: [3, 3], rough: 0.25, metal: 0.85,
  });
  ring.script = SPIN_SCRIPT;

  // --- casa -----------------------------------------------------------------
  // El solar se aplana con un "pad" de terreno antes de colocar nada: asi el
  // suelo de la casa queda a ras del exterior (la puerta es un escalon de
  // 0,35 m, no un muro) y las paredes no tienen que pelear con la ladera. Es la
  // misma operacion que hara la herramienta de terreno del editor.
  const hx = -34, hz = -16;
  if (terrain && terrain.addPad) {
    terrain.addPad({ x: hx, z: hz, halfW: 9.5, halfD: 8.5, height: water + 6, falloff: 13 });
  }
  const hg = terrain ? terrain.heightAt(hx, hz) : ground + 0.15;
  const wallTop = hg + 3.2, wallBot = hg - 1.4;
  const wallH = wallTop - wallBot, wallY = (wallTop + wallBot) * 0.5;
  const wall = (dx, dz, w, d, name) => put("box", {}, [hx + dx, wallY, hz + dz],
    { scale: [w, wallH, d], name, color: 0xe5ded2, tex: "hormigon", rep: [Math.max(w, d) * 0.4, 1.4] });
  // Tejado: el prim "prism" del visor lleva el triangulo en el plano X-Z y lo
  // extruye en Y (marco del mundo, ver `slToWorld` en primMesh.js). Para el
  // clasico tejado a dos aguas hay que poner el triangulo de pie (la arista
  // arriba) y la extrusion a lo largo de la casa: esa permutacion de ejes es
  // Euler(x=90, z=90) en orden "ZYX". Con eso la escala va asi: X = alto del
  // triangulo (0.75), Y = largo del caballete (1.0), Z = ancho del triangulo
  // (0.866). La base del triangulo queda 0.25*escalaX por debajo del centro.
  const roofH = 3.4, roofY = wallTop - 0.3;
  const roofSx = roofH / 0.75;
  put("prism", {}, [hx, roofY + 0.25 * roofSx, hz],
    { scale: [roofSx, 11, 13 / 0.866], name: "Tejado", rotX: 90, rotZ: 90, rotOrder: "ZYX", color: 0xd4aca4, tex: "tejado", rep: [5, 3] });
  put("box", {}, [hx, hg + 0.15, hz], { scale: [12, 0.4, 10], name: "Suelo de la casa", color: 0xcbbfae, tex: "madera", rep: [6, 5] });
  wall(0, -5, 12, 0.4, "Pared norte");
  wall(-6, 0, 0.4, 10, "Pared oeste");
  wall(6, 0, 0.4, 10, "Pared este");
  wall(-3.9, 5, 4.2, 0.4, "Pared sur A");
  wall(3.9, 5, 4.2, 0.4, "Pared sur B");
  // Puerta abierta: una hoja girada 90 grados junto al marco, para que el hueco
  // de la entrada quede libre y se pueda entrar andando.
  put("box", {}, [hx - 1.9, hg + 1.55, hz + 5.95], { scale: [0.25, 2.4, 1.9], name: "Puerta", color: 0xbfaa96, tex: "tablones", rep: [3, 1] });

  // --- arboles --------------------------------------------------------------
  const tree = (x, z, s) => {
    const g = terrain ? terrain.heightAt(x, z) : ground;
    sit(put("cylinder", {}, [x, g, z], { scale: [0.45 * s, 3 * s, 0.45 * s], name: "Tronco", color: 0xb6a99a, tex: "corteza", rep: [2, 3] }), g);
    sit(put("sphere", { taperX: -0.75, taperY: -0.75 }, [x, g, z],
      { scale: [2.6 * s, 2.8 * s, 2.6 * s], name: "Copa", color: 0xa7bf9e, tex: "hierba", rep: [4, 4] }), g + 2.3 * s);
  };
  tree(26, -24, 1.2); tree(32, -18, 0.9); tree(-20, 26, 1.1); tree(18, 26, 1.0); tree(-28, 4, 0.95);

  // --- lago + embarcadero ---------------------------------------------------
  // El terreno natural baja a ~21 m justo al sur de la plataforma (el agua esta
  // a 20), pero es una hondonada tan somera que no se lee como agua: una pala de
  // terreno la ahueca hasta 18 m y deja una orilla suave de 16 m de ancho. Es
  // exactamente la operacion que hara la herramienta de esculpido del editor,
  // asi que este lago es tambien la primera demo de ella.
  if (terrain) {
    terrain.addPad({ x: 0, z: 60, halfW: 15, halfD: 11, height: water - 1.6, falloff: 16, wobble: 5.5, bowl: 1.1 });
  }
  // El muelle se levanta 1.9 m sobre el agua (con la tarima a un metro los
  // postes apenas asoman y el muelle parece flotar) y su punta de tierra se
  // entierra en la orilla en vez de terminar en una rampa: el terreno cruza la
  // altura de la tarima justo en la orilla (z ~ 37), asi que la tarima nace del
  // cesped sin escalon, sin rampa y sin borde flotante que disimular.
  const pierZ = 52.5, pierLen = 33, pierWide = 3.6, pierTop = water + 1.9;
  const railZ = 53.7, railLen = 30;
  const woodColor = 0xbfb1a3, postColor = 0xafa498;
  put("box", {}, [0, pierTop - 0.125, pierZ], { scale: [pierWide, 0.25, pierLen], name: "Embarcadero", color: woodColor, tex: "tablones", rep: [3, 10] });
  // Las dos carreras longitudinales bajo la tarima: es lo que hace que el muelle
  // se lea como una estructura y no como un tablon sobre el agua.
  for (const dx of [-1.5, 1.5]) {
    put("box", {}, [dx, pierTop - 0.45, pierZ], { scale: [0.3, 0.4, pierLen], name: "Carrera", color: postColor, tex: "madera", rep: [1, 14] });
  }
  for (const dz of [-15, -9, -3, 3, 9, 15]) {
    for (const dx of [-1.5, 1.5]) {
      const px = dx, pz = pierZ + dz;
      const pg = terrain ? terrain.heightAt(px, pz) : water - 2;
      const h = Math.max(0.5, pierTop - 0.35 - pg);
      sit(put("cylinder", {}, [px, pg, pz], { scale: [0.34, h, 0.34], name: "Poste", color: postColor, tex: "madera", rep: [1, 3] }), pg);
    }
  }
  // Barandilla: pasamanos + balaustres. Ademas de dar escala al muelle, evita
  // que el borde de la tarima se lea como un simple plano de color.
  for (const dx of [-1.7, 1.7]) {
    put("box", {}, [dx, pierTop + 0.95, railZ], { scale: [0.14, 0.14, railLen], name: "Pasamanos", color: woodColor, tex: "madera", rep: [1, 12] });
    for (const dz of [-14, -7, 0, 7, 14]) {
      const pz = railZ + dz;
      const pg = terrain ? terrain.heightAt(dx, pz) : water - 2;
      const base = Math.max(pg, water + 0.05);
      put("cylinder", {}, [dx, (base + pierTop + 0.95) / 2, pz],
        { scale: [0.09, Math.max(0.6, pierTop + 1.02 - base), 0.09], name: "Balaustre", color: woodColor, tex: "madera", rep: [1, 2] });
    }
  }

  // --- sitios con nombre ----------------------------------------------------
  // El mapa y el panel de sitios necesitan saber QUE hay y DONDE. En vez de
  // repetir esas coordenadas fuera de aqui (donde se quedarian obsoletas al
  // primer cambio del banco de pruebas), es el propio mundo el que declara sus
  // sitios. Los de fuera (los que se guarda el usuario) se anaden aparte.
  const landmarks = [
    { name: "Plataforma de llegada", kind: "spawn", x: 0, y: deck, z: 11 },
    { name: "Arco de prims", kind: "work", x: 0, y: deck, z: 0 },
    { name: "Cartel con script", kind: "work", x: 6.2, y: deck, z: 7.0 },
    { name: "Anillo giratorio", kind: "work", x: 7.6, y: deck + 1.7, z: 1.4 },
    { name: "Casa de la colina", kind: "build", x: hx, y: hg, z: hz },
    { name: "Embarcadero", kind: "water", x: 0, y: pierTop, z: pierZ },
    { name: "Orilla del lago", kind: "water", x: 0, y: water + 0.3, z: 38 },
  ];
  if (terrain) {
    // La cumbre: el punto mas alto de la region. Se busca en una rejilla de 4 m
    // (basta para un mirador) y ya con los solares esculpidos aplicados.
    const half = terrain.size / 2;
    let best = -Infinity, bx = 0, bz = 0;
    for (let x = -half + 4; x <= half - 4; x += 4) {
      for (let z = -half + 4; z <= half - 4; z += 4) {
        const h = terrain.heightAt(x, z);
        if (h > best) { best = h; bx = x; bz = z; }
      }
    }
    if (isFinite(best)) landmarks.push({ name: "Cumbre de la región", kind: "peak", x: bx, y: best, z: bz });
  }

  return {
    objects, platform, deck, landmarks,
    // El avatar aparece de pie sobre la plataforma, mirando al arco de prims.
    spawn: new THREE.Vector3(0, deck + 0.1, 11),
  };
}
