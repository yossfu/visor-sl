// three.js viewer core: renderer, SL<->three coordinate frame, sky, water,
// camera controllers (orbit / fly / touch) and the render loop.
import * as THREE from "../vendor/three.module.min.js";
import { terrainTextures } from "./textures.js";

export const SL_UP = new THREE.Vector3(0, 0, 1);

/**
 * What the GPU actually is, and what the WebGL2 context can do — the numbers
 * that tell "the phone is rendering on its GPU" apart from "the WebView fell
 * back to SwiftShader (software)". Worth logging on every launch: on Android
 * this is the difference between a smooth region and a slideshow, and it is
 * invisible from anywhere else in the app.
 */
export function gpuInfo(renderer) {
  const out = { vendor: "", renderer: "", webgl: "", maxTexture: 0, maxRenderbuffer: 0, extensions: 0, software: false };
  try {
    const gl = renderer.getContext();
    out.webgl = gl instanceof WebGL2RenderingContext ? "WebGL2" : "WebGL1";
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    out.vendor = String((dbg && gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || "");
    out.renderer = String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
    out.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
    out.maxRenderbuffer = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 0;
    out.extensions = (gl.getSupportedExtensions() || []).length;
    out.software = /swiftshader|software|llvmpipe|mesa offscreen/i.test(out.renderer);
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

export class Viewer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    // preserveDrawingBuffer costs a full-frame copy on every present. It is only
    // needed so a screenshot (the editor's own preview, or the diagnostics
    // button) can read the canvas back — never for a normal frame on a phone.
    const keepBuffer = opts.preserveDrawingBuffer === true;
    // The context was already created by the page's GPU probe (index.html), on
    // this very canvas, and recorded whatever the device could actually give:
    // WebGL2, WebGL1, or nothing. three.js is handed that same context instead
    // of asking for one of its own — a canvas keeps the first context it hands
    // out for good, so a probe and a second request can only ever agree by
    // accident.
    const probed = (typeof window !== "undefined" && window.visorGpu && window.visorGpu.context) || null;
    this.renderer = new THREE.WebGLRenderer(Object.assign({
      canvas,
      antialias: opts.antialias !== false,
      alpha: false,
      preserveDrawingBuffer: keepBuffer,
      powerPreference: "high-performance",
    }, probed ? { context: probed } : {}));
    this.renderScale = 1;
    this.profile = opts.profile || null;
    this.maxPixelRatio = (this.profile && this.profile.pixelRatioMax) || Math.min(devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const shadowsOn = !!(this.profile && this.profile.shadows);
    this.renderer.shadowMap.enabled = shadowsOn;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gpu = gpuInfo(this.renderer);

    const p = this.profile || {};
    const fogFar = p.fogFar || 420;
    const drawDistance = p.drawDistance || 200;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xbfd8ee, Math.min(120, drawDistance * 0.6), fogFar);

    // The far plane must clear the sky dome (radius 3000 in sky.js), or the sky
    // is sliced off and the world shows a black polygon above the horizon.
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.08, Math.max(6000, fogFar * 3));
    this.camera.position.set(30, 24, -44);

    // SL space (Z up, right handed) lives under this root
    this.slRoot = new THREE.Group();
    this.slRoot.rotation.x = -Math.PI / 2;
    this.scene.add(this.slRoot);

    this.setupLights();
    this.sky = new Sky(this.scene);
    this.water = new Water(2000);
    this.slRoot.add(this.water.mesh);

    this.clock = new THREE.Clock();
    this.stats = { fps: 0, frame: 0, drawCalls: 0, tris: 0, lastFpsTime: 0, frames: 0, time: 0 };
    this.updateSize();
    window.addEventListener("resize", () => this.updateSize());

    this.sunAngle = 0.42; // radians above horizon
    this.sunAzimuth = 2.1;
    this.setSun(this.sunAngle, this.sunAzimuth);

    this.controls = new CameraController(this);
  }

  setupLights() {
    this.sun = new THREE.DirectionalLight(0xfff3e0, 2.1);
    const shadowsOn = !!(this.profile && this.profile.shadows);
    this.sun.castShadow = shadowsOn;
    const mapSize = (this.profile && this.profile.shadowMap) || 1024;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    const d = 90;
    this.sun.shadow.camera.left = -d; this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d; this.sun.shadow.camera.bottom = -d;
    this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 400;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun);
    this.sun.target = new THREE.Object3D();
    this.scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xa9c9ff, 0x4a5a3a, 1.05);
    this.scene.add(this.hemi);
    this.fill = new THREE.DirectionalLight(0x88aaff, 0.25);
    this.fill.position.set(-1, 0.4, 1);
    this.scene.add(this.fill);
  }

  setSun(elevation, azimuth) {
    this.sunAngle = elevation;
    this.sunAzimuth = azimuth;
    const r = 200;
    const x = Math.cos(elevation) * Math.cos(azimuth) * r;
    const y = Math.cos(elevation) * Math.sin(azimuth) * r;
    const z = Math.sin(elevation) * r;
    // SL -> three
    this.sunOrientation = new THREE.Vector3(x, z, -y);
    this.sun.position.copy(this.sunOrientation);
    this.sun.target.position.set(0, 0, 0);
    this.sky.update(elevation, azimuth);
    this.sun.intensity = Math.max(0.05, Math.sin(elevation)) * 2.4;
    this.hemi.intensity = 0.35 + 0.9 * Math.max(0, Math.sin(elevation));
    if (this.water) this.water.setSun(elevation, azimuth);
  }

  // Camera basis converted to SL axes (Z up) for AgentUpdate.
  getCamAxes() {
    const p = this.camera.position;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const center = [p.x, -p.z, p.y];
    const at = [dir.x, -dir.z, dir.y];
    let lx = -at[1], ly = at[0], lz = 0;
    const ll = Math.hypot(lx, ly) || 1;
    lx /= ll; ly /= ll;
    const left = [lx, ly, lz];
    const up = [
      at[1] * left[2] - at[2] * left[1],
      at[2] * left[0] - at[0] * left[2],
      at[0] * left[1] - at[1] * left[0],
    ];
    return { center, at, left, up };
  }

  updateSize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Effective device-pixel multiplier. The governor moves it between
   * `profile.renderScaleMin` and the profile ceiling; on a phone that is the
   * single biggest lever on frame rate (halving it quarters the pixels drawn).
   */
  setRenderScale(scale) {
    const next = Math.max(0.4, Math.min(this.maxPixelRatio, scale));
    if (Math.abs(next - this.renderScale) < 0.02) return false;
    this.renderScale = next;
    this.renderer.setPixelRatio(next);
    this.updateSize();
    return true;
  }

  /** Applies a profile produced by perf.js at runtime (no reload needed). */
  applyProfile(profile) {
    this.profile = profile;
    this.maxPixelRatio = profile.pixelRatioMax;
    this.renderer.shadowMap.enabled = !!profile.shadows;
    if (this.sun) {
      this.sun.castShadow = !!profile.shadows;
      const m = profile.shadowMap || 1024;
      if (this.sun.shadow.mapSize.x !== m) {
        this.sun.shadow.mapSize.set(m, m);
        if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      }
    }
    if (this.scene.fog) {
      this.scene.fog.near = Math.min(120, profile.drawDistance * 0.6);
      this.scene.fog.far = profile.fogFar;
    }
    if (this.water) this.water.mesh.visible = profile.water !== false;
    this.setRenderScale(Math.min(this.renderScale, this.maxPixelRatio));
  }

  frame(dt) {
    this.stats.time += dt;
    const t = this.stats.time;
    this.controls.update(dt);
    if (this.water && this.water.mesh.visible !== false) this.water.update(t);
    this.sky.follow(this.camera);
    if (this.renderer.shadowMap.enabled) {
      // keep shadow volume around the camera
      const c = this.camera.position;
      this.sun.target.position.set(c.x, 0, c.z);
      this.sun.position.set(c.x + this.sunOrientation.x * 0.4, this.sunOrientation.y, c.z + this.sunOrientation.z * 0.4);
    }
    this.renderer.render(this.scene, this.camera);
    this.stats.frames++;
    if (t - this.stats.lastFpsTime > 0.5) {
      this.stats.fps = this.stats.frames / (t - this.stats.lastFpsTime);
      this.stats.lastFpsTime = t;
      this.stats.frames = 0;
      this.stats.drawCalls = this.renderer.info.render.calls;
      this.stats.tris = this.renderer.info.render.triangles;
      this.stats.geometries = this.renderer.info.memory.geometries;
      this.stats.textures = this.renderer.info.memory.textures;
      this.stats.programs = this.renderer.info.programs ? this.renderer.info.programs.length : 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Sky (procedural gradient + sun disc + stars)
// ---------------------------------------------------------------------------

class Sky {
  constructor(scene) {
    this.uniforms = {
      uTop: { value: new THREE.Color(0x3d7fd6) },
      uMid: { value: new THREE.Color(0x9fc8f2) },
      uBottom: { value: new THREE.Color(0xdfe9f2) },
      uSunDir: { value: new THREE.Vector3(0, 0.5, 0.5) },
      uSunColor: { value: new THREE.Color(0xfff4d6) },
      uNight: { value: 0 },
    };
    const geo = new THREE.SphereGeometry(3000, 32, 20);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: this.uniforms,
      vertexShader: `varying vec3 vDir;
        void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 uTop, uMid, uBottom, uSunColor; uniform vec3 uSunDir; uniform float uNight;
        varying vec3 vDir;
        float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,45.164)))*43758.5453); }
        void main(){
          float h = clamp(vDir.y*0.5+0.5, 0.0, 1.0);
          vec3 col = mix(uBottom, uMid, smoothstep(0.42, 0.58, h));
          col = mix(col, uTop, smoothstep(0.55, 0.95, h));
          vec3 d = normalize(vDir);
          vec3 s = normalize(uSunDir);
          float sun = max(dot(d, s), 0.0);
          col += uSunColor * pow(sun, 220.0) * 3.0;
          col += uSunColor * pow(sun, 12.0) * 0.35;
          if (uNight > 0.5) {
            vec3 g = floor(d * 260.0);
            float st = step(0.9985, hash(g));
            float tw = 0.8 + 0.4*hash(g+1.3);
            col += vec3(st * tw);
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  update(elevation) {
    const e = new THREE.Vector3(
      Math.cos(elevation) * Math.cos(this._az ?? 2.1),
      Math.sin(elevation),
      -Math.cos(elevation) * Math.sin(this._az ?? 2.1));
    this.uniforms.uSunDir.value.copy(e).normalize();
    const night = elevation < -0.05 ? 1 : 0;
    this.uniforms.uNight.value = night;
    const day = Math.max(0, Math.sin(elevation));
    const warm = new THREE.Color(1.0, 0.85, 0.6).lerp(new THREE.Color(0.55, 0.75, 1.0), Math.min(1, day * 1.4));
    this.uniforms.uBottom.value.setRGB(0.86 * (0.25 + 0.75 * day), 0.9 * (0.3 + 0.7 * day), 0.95 * (0.4 + 0.6 * day));
    this.uniforms.uMid.value.copy(warm).multiplyScalar(0.55 + 0.45 * day);
    this.uniforms.uTop.value.setRGB(0.04 + 0.20 * day, 0.07 + 0.42 * day, 0.12 + 0.72 * day);
    this.uniforms.uSunColor.value.setRGB(1.0, 0.92 - 0.25 * (1 - day), 0.78 - 0.3 * (1 - day));
  }
  follow(cam) {
    this.mesh.position.copy(cam.position);
    if (this._az === undefined) this._az = 2.1;
  }
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

class Water {
  constructor(size) {
    this.uniforms = Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x1d4f7a) },
      uDeep: { value: new THREE.Color(0x08243c) },
      uSun: { value: new THREE.Vector3(0, 1, 0) },
      uLevel: { value: 20 },
    });
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: true, fog: true,
      uniforms: this.uniforms,
      vertexShader: `
        #include <fog_pars_vertex>
        varying vec3 vWorld;
        void main(){
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        #include <fog_pars_fragment>
        uniform float uTime; uniform vec3 uColor, uDeep, uSun;
        varying vec3 vWorld;
        float wave(vec2 p, float t){
          return sin(p.x*0.35 + t*1.1)*0.5 + sin(p.y*0.27 - t*0.9)*0.5
               + sin((p.x+p.y)*0.11 + t*0.6)*0.4;
        }
        void main(){
          vec2 p = vWorld.xz;
          float h = wave(p, uTime)*0.5;
          vec3 n = normalize(vec3(
            cos(p.x*0.35 + uTime*1.1)*0.35*0.5,
            1.0,
            cos(p.y*0.27 - uTime*0.9)*0.27*0.5));
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 2.5);
          vec3 col = mix(uDeep, uColor, 0.5 + 0.5*h);
          col += vec3(1.0,0.95,0.85) * pow(max(dot(reflect(-normalize(uSun), n), viewDir), 0.0), 40.0) * 0.8;
          col = mix(col, vec3(0.75,0.85,0.95), fres*0.55);
          gl_FragColor = vec4(col, 0.78);
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = 0; // plane already in SL XY for Z-up root
    this.mesh.receiveShadow = false;
  }
  setLevel(z) { this.mesh.position.z = z; this.uniforms.uLevel.value = z; }
  setSun(elevation, azimuth) {
    this.uniforms.uSun.value.set(
      Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth));
  }
  update(t) { this.uniforms.uTime.value = t; }
}

// ---------------------------------------------------------------------------
// Camera controller: orbit-drag + WASD/QE fly + touch
// ---------------------------------------------------------------------------

export class CameraController {
  constructor(viewer) {
    this.viewer = viewer;
    this.target = new THREE.Vector3(40, 8, -40);
    this.distance = 70;
    this.yaw = 0.8;
    this.pitch = -0.35;
    this.flying = false;
    this.keys = new Set();
    this.moveSpeed = 18;
    this.enabled = true;
    this._dragging = null;
    this._pinch = 0;
    this.applyOrbit();
    this.bind();
  }

  bind() {
    const c = this.viewer.canvas;
    const down = (e) => {
      if (!this.enabled) return;
      try { c.setPointerCapture(e.pointerId); } catch (_) {}
      this._dragging = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
    };
    const move = (e) => {
      if (!this._dragging || this._dragging.id !== e.pointerId) return;
      const dx = e.clientX - this._dragging.x, dy = e.clientY - this._dragging.y;
      this._dragging.x = e.clientX; this._dragging.y = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) this._dragging.moved = true;
      if (this.flying) {
        const r = new THREE.Vector3();
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.viewer.camera.quaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.viewer.camera.quaternion);
        r.addScaledVector(right, -dx * 0.08).addScaledVector(up, dy * 0.08);
        this.viewer.camera.position.add(r);
        this.target.add(r);
      } else {
        this.yaw -= dx * 0.005;
        this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dy * 0.005));
        this.applyOrbit();
      }
    };
    const up = (e) => { if (this._dragging && this._dragging.id === e.pointerId) this._dragging = null; };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.flying) {
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.viewer.camera.quaternion);
        this.viewer.camera.position.addScaledVector(dir, -e.deltaY * 0.05);
      } else {
        this.distance = Math.max(1.5, Math.min(1200, this.distance * (1 + e.deltaY * 0.0012)));
        this.applyOrbit();
      }
    }, { passive: false });
    // touch pinch
    c.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (this._pinch) {
          this.distance = Math.max(1.5, Math.min(1200, this.distance * (this._pinch / d)));
          if (!this.flying) this.applyOrbit();
        }
        this._pinch = d;
      }
    }, { passive: false });
    c.addEventListener("touchend", () => { this._pinch = 0; });
    window.addEventListener("keydown", (e) => {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      this.keys.add(e.code);
      if (e.code === "KeyF") this.setFly(!this.flying);
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  setFly(on) {
    this.flying = on;
    if (on) {
      const dir = new THREE.Vector3().subVectors(this.target, this.viewer.camera.position).normalize();
      this.lookDir = dir;
    } else {
      // re-derive orbit params from current camera
      this.applyOrbit();
    }
    document.body.classList.toggle("flying", on);
  }

  applyOrbit() {
    const cam = this.viewer.camera;
    const x = Math.cos(this.pitch) * Math.sin(this.yaw);
    const y = Math.sin(this.pitch);
    const z = Math.cos(this.pitch) * Math.cos(this.yaw);
    cam.position.set(
      this.target.x + x * this.distance,
      this.target.y + y * this.distance,
      this.target.z + z * this.distance);
    cam.lookAt(this.target);
  }

  focus(slPos, distance) {
    const w = new THREE.Vector3(slPos[0], slPos[2], -slPos[1]);
    this.target.copy(w);
    if (distance) this.distance = distance;
    this.flying = false;
    this.applyOrbit();
  }

  // Moves the orbit centre to an SL position without changing the camera's
  // yaw/pitch/distance: the camera is dragged along by the same delta.
  follow(slPos) {
    if (!slPos) return;
    const w = new THREE.Vector3(slPos[0], slPos[2], -slPos[1]);
    const d = w.clone().sub(this.target);
    if (d.lengthSq() === 0) return;
    this.target.copy(w);
    this.viewer.camera.position.add(d);
  }

  update(dt) {
    if (!this.flying || !this.enabled) return;
    const cam = this.viewer.camera;
    const speed = this.moveSpeed * (this.keys.has("ShiftLeft") ? 3.5 : 1) * dt;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) v.add(fwd);
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) v.sub(fwd);
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) v.sub(right);
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) v.add(right);
    if (this.keys.has("KeyE") || this.keys.has("Space")) v.add(up);
    if (this.keys.has("KeyQ")) v.sub(up);
    if (v.lengthSq() > 0) {
      v.normalize().multiplyScalar(speed);
      cam.position.add(v);
      this.target.copy(cam.position).addScaledVector(fwd, this.distance * 0.5);
    }
  }
}
