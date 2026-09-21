// Application bootstrap: viewer + world + HUD + input + main loop.
import * as THREE from "../vendor/three.module.min.js";
import { Viewer } from "./renderer.js";
import { World } from "./world.js";
import { UI } from "./ui.js";
import { buildDemoRegion } from "./demo.js";
import { defaultPrimParams } from "./prims.js";
import { TouchControls } from "./touch.js";
import { detectProfile, AdaptiveScaler, isMobile, PROFILES, profileNames } from "./perf.js";
import { hasNative, prefsAll, prefsSet } from "./transport.js";

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    // Device profile first: the renderer, the world and the texture pipeline all
    // read their limits from it, and it is what makes the phone usable.
    // A profile the user picked by hand wins over the one guessed from the device.
    this.profile = PROFILES[prefsAll()["visor.profile"]] || detectProfile();
    this.viewer = new Viewer(canvas, {
      profile: this.profile,
      antialias: this.profile.antialias,
      // The editor's own preview screenshots the canvas; a real device must not
      // pay the per-frame copy that preserving the buffer costs.
      preserveDrawingBuffer: !hasNative(),
    });
    this.world = new World(this.viewer);
    this.world.applyProfile(this.profile);
    this.scaler = new AdaptiveScaler({
      target: isMobile() ? 30 : 60,
      ceiling: this.profile.pixelRatioMax,
      floor: this.profile.renderScaleMin,
      enabled: true,
    });
    this.world.onSelect = (rec) => this.ui.showInspector(rec);
    this.world.onAvatarError = (msg) => this.ui.log("⚠ No se pudieron cargar los cuerpos de avatar: " + msg +
      " (por eso se ven como cápsulas; abre ☰ → Diagnóstico completo).");
    this.ui = new UI(this);
    this.session = null;
    this.mode = "login";
    // The viewer opens on the login screen with an empty region: there is no
    // demo island any more (?test=demo brings it back for development).
    this.world.reset();
    this.viewer.controls.focus([128, 128, 30], 90);
    this.touch = new TouchControls(this);
    this.bindInput();
    this.lastTime = performance.now();
    // While a region is flooding in, the frame time is dominated by decoding and
    // GPU uploads rather than by what the device can sustain, so the quality is
    // not judged during that burst.
    this.graceUntil = 0;
    this.raf = requestAnimationFrame(() => this.loop());
    this.ui.showLogin();
  }

  loadDemo(seed = 1337) {
    this.mode = "demo";
    this.world.dispose();
    buildDemoRegion(this.world, { seed });
    this.world.setTerrainKnown(true);
    this.ui.regionEl.textContent = `Demo Sandbox (semilla ${seed})`;
    this.viewer.controls.focus([128, 128, 28], 86);
    this.viewer.controls.yaw = 0.35;
    this.viewer.controls.pitch = 0.42;
    this.viewer.controls.applyOrbit();
  }

  bindInput() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => { this._down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    c.addEventListener("pointerup", (e) => {
      if (!this._down) return;
      const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
      const dt = performance.now() - this._down.t;
      this._down = null;
      if (moved > 6 || dt > 600) return;
      this.pickAt(e.clientX, e.clientY);
    });
    c.addEventListener("dblclick", (e) => {
      const hits = this.raycastAt(e.clientX, e.clientY);
      if (hits.length) {
        const rec = this.world.objects.get(hits[0].object.userData.objectId);
        if (rec && rec.position) this.viewer.controls.focus(rec.position, Math.max(4, (rec.scale?.[0] || 1) * 4));
      }
    });
    window.addEventListener("contextmenu", (e) => { if (e.target === c) e.preventDefault(); });
  }

  raycastAt(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return [];
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    return this.world.raycast(ndc);
  }

  /** Click/tap on a prim: select it (and show it in the inspector). */
  pickAt(clientX, clientY) {
    const hits = this.raycastAt(clientX, clientY);
    if (hits.length) {
      const rec = this.world.objects.get(hits[0].object.userData.objectId);
      if (rec) { this.world.select(rec); return; }
    }
    this.world.select(null);
    this.ui.showInspector(null);
  }

  spawn(params) {
    const c = this.viewer.controls;
    const target = c.target;
    const sl = [target.x, -target.z, Math.max(target.y, this.world.heightAt(target.x, -target.z) + 1)];
    const rec = this.world.addPrim({
      id: `local-${Math.random().toString(16).slice(2)}`,
      name: "prim nuevo",
      params: defaultPrimParams(params),
      scale: [2, 2, 2],
      position: sl,
      rotation: [0, 0, 0, 1],
      texture: { all: "gen:wood" },
    });
    this.world.select(rec);
    this.ui.showInspector(rec);
  }

  updateSelected(patch) {
    if (!this.world.selection) return;
    this.world.updatePrim(this.world.selection.id, { params: patch });
    this.ui.showInspector(this.world.selection);
  }
  setSelectedTransform(t) {
    if (!this.world.selection) return;
    this.world.updatePrim(this.world.selection.id, t);
  }
  setSelectedTexture(key) {
    if (!this.world.selection) return;
    this.world.selection.texture = { all: key };
    this.world.rebuildPrim(this.world.selection);
  }
  setSelectedStyle(style) {
    if (!this.world.selection) return;
    Object.assign(this.world.selection, style);
    this.world.rebuildPrim(this.world.selection);
  }

  onChat(text) {
    if (this.session && this.session.state === "online") this.session.say(text);
    else this.ui.log("(modo demo) no hay conexión; el mensaje no se envió.");
  }

  setNetStatus(s) {
    this.netStatus = s;
    if (this.ui.netEl) {
      this.ui.netEl.textContent = `${s.queued} obj · ${s.kbIn}/${s.kbOut} KB`;
      this.ui.netEl.title = `${s.resident} con geometría · ${s.sent} enviados · ${s.recv} recibidos · ${s.resends} reenvíos`;
    }
  }

  async connect(opts) {
    const mod = await import("./sl-session.js");
    this.CONTROL = mod.CONTROL;
    // The demo island must be gone *before* the region stream starts: otherwise
    // its terrain stays on screen and swallows every prim and avatar the
    // simulator sends (they sit at 20-25 m, inside the demo hills).
    this.enterGridMode();
    this.session = new mod.SLSession(this, { onStatus: opts.status });
    let reply;
    try {
      reply = await this.session.login(opts);
    } catch (e) {
      const s = this.session;
      if (s) this.rememberDiag(s);
      this.ui.log("⚠ No se pudo conectar: " + ((e && e.message) || e));
      try { await s.disconnect(); } catch (_) {}
      this.session = null;
      this.ui.log("Volviendo a la pantalla de inicio de sesión.");
      this.returnToLogin();
      throw e;
    }
    this.rememberDiag(this.session);
    this.viewer.controls.focus(this.session.agentPos, 14);
    this.bindControls();
    this.ui.log("Controles: W/A/S/D moverse, Q/E subir-bajar, Espacio volar, Shift correr (en la app Android).");
    return reply;
  }

  /**
   * Leaves the sandbox behind and prepares an empty region: flat floor at 0 m
   * (the real heights arrive as LayerData patches), no prims, no avatars, water
   * at the default level until the handshake says otherwise.
   */
  enterGridMode() {
    this.mode = "grid";
    this.world.reset();
    this.graceUntil = performance.now() + 30000;
    this.selected = null;
    if (this.ui.showInspector) this.ui.showInspector(null);
    if (this.ui.regionEl) this.ui.regionEl.textContent = "conectando…";
    this.viewer.water.setLevel(20);
    this.viewer.controls.focus([128, 128, 30], 18);
    // Third-person camera (Genshin-like): close behind the avatar, looking slightly down.
    const ctl = this.viewer.controls;
    ctl.distance = 6.5;
    ctl.pitch = -0.22;
    ctl.yaw = 0;
    ctl.applyOrbit();
    // Touch pad only where it makes sense: inside the Android shell (the native
    // bridge is present) or on a coarse-pointer device. A desktop browser keeps
    // the mouse/keyboard controls it already had.
    const wantTouch = !!(window.VisorNative) ||
      (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) ||
      /[?&]touch=1/.test(location.search);
    if (this.ui.setTouchVisible) this.ui.setTouchVisible(wantTouch);
    this.ui.log("Modo grid: el mundo arranca vacío; el terreno, los prims y los avatares llegan del simulador.");
  }

  /** Back to the login screen with an empty region (after a failed login or a disconnect). */
  returnToLogin() {
    this.mode = "login";
    this.world.reset();
    this.viewer.water.setLevel(20);
    this.viewer.controls.focus([128, 128, 30], 90);
    if (this.ui.setTouchVisible) this.ui.setTouchVisible(false);
    if (this.ui.showLogin) this.ui.showLogin();
  }

  rememberDiag(session) {
    if (!session) return;
    this.diag = {
      host: session.simHost, port: session.simPort, circuitCode: session.circuitCode,
      sessionID: session.sessionID, agentID: session.agentID,
      region: session.regionName, agent: session.agentName,
    };
  }

  /**
   * Runs the network/UDP battery in the HUD log: active network, whether a UDP
   * socket can be created at all, whether a public STUN server answers (does
   * this network let UDP out?) and whether the simulator answers a real
   * UseCircuitCode packet.
   */
  async diagnoseUdp() {
    const mod = await import("./sl-session.js");
    const s = this.session || new mod.SLSession(this, {});
    if (!s.defs) {
      try {
        const t = await mod.loadMessageTemplate();
        s.template = t.msgs;
        s.defs = t.defs;
        s.index = t.index;
      } catch (e) {
        this.ui.log("No se pudo cargar la plantilla de mensajes: " + ((e && e.message) || e));
      }
    }
    if (this.diag) {
      s.simHost = s.simHost || this.diag.host;
      s.simPort = s.simPort || this.diag.port;
      s.circuitCode = s.circuitCode || this.diag.circuitCode;
      s.sessionID = s.sessionID || this.diag.sessionID;
      s.agentID = s.agentID || this.diag.agentID;
    }
    this.ui.log("— Diagnóstico de red y UDP —");
    if (!s.simHost) {
      this.ui.log("Sin datos del simulador todavía: inicia sesión una vez y repite el diagnóstico.");
    }
    await s.runUdpDiagnosis();
  }

  async disconnect() {
    if (!this.session) return;
    await this.session.disconnect();
    this.session = null;
    this.ui.netEl.textContent = "sin conexión";
    this.ui.log("Sesión cerrada. Vuelves a la pantalla de inicio de sesión.");
    this.returnToLogin();
  }

  // --- touch controls -------------------------------------------------------

  onTouchFly(on) {
    this.flying = !!on;
    const b = document.getElementById("flyBtn");
    if (b) b.textContent = on ? "Volar: sí" : "Volar (F)";
    this.ui.log(on ? "Modo volar activado." : "Modo volar desactivado.");
  }

  onTouchSit() {    if (!this.session || !this.CONTROL) return;
    const c = this.CONTROL;
    const sitting = !this._sitting;
    this._sitting = sitting;
    this.session.pulseControls(sitting ? c.SIT_ON_GROUND : c.STAND_UP);
    this.ui.log(sitting ? "Sentarse." : "Levantarse.");
  }

  /**
   * A jump pulse: the touch layer calls this on a double tap (and the keyboard on
   * Space). Holding the jump button also works — UP_POS is what the simulator
   * reads as "jump", and it needs to be *pulsed*, not latched.
   */
  onTouchJump() {
    this._jumpUntil = performance.now() + 260;
    this.ui.log("Salto.");
  }

  /**
   * Turns the virtual stick into SL control flags. Movement is camera-relative:
   * the avatar turns to face the direction you push and walks that way, which is
   * how mobile SL viewers (and third-person games) behave. BodyRotation is what
   * tells the simulator which way the avatar faces.
   */
  applyTouchInput() {
    const s = this.session;
    if (!s || !this.CONTROL || s.state !== "online" || !this.touch || !this.touch.visible) return;
    const C = this.CONTROL;
    const v = this.touch.vector;
    const mag = Math.hypot(v.x, v.y);
    const fly = this.touch.fly || this.flying;
    let flags = 0;
    if (mag > 0.22) {
      flags |= C.AT_POS;
      if (this.touch.running) flags |= C.FAST_AT;
      if (fly && v.y < -0.45) flags |= C.UP_NEG;
    }
    if (this.touch.jumping || performance.now() < (this._jumpUntil || 0)) flags |= C.UP_POS;
    if (fly) flags |= C.FLY;
    s.setControls(flags);
    if (mag > 0.22) {
      const heading = this.cameraHeading(v.x, v.y);
      s.bodyRot = [0, 0, Math.sin(heading / 2), Math.cos(heading / 2)];
    }
  }

  /** Yaw (SL space, about Z) of the camera-relative direction of the stick. */
  cameraHeading(x, y) {
    const cam = this.viewer.camera;
    const ctl = this.viewer.controls;
    const target = ctl.target;
    const fwd = new THREE.Vector3().subVectors(target, cam.position);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const dir = fwd.clone().multiplyScalar(y).addScaledVector(right, x);
    // three world (x, y, -z) <- SL (x, y, z): the SL direction is (dir.x, -dir.z)
    return Math.atan2(-dir.z, dir.x);
  }

  // Maps the keyboard onto AGENT_CONTROL_* bits for the live grid.
  bindControls() {
    if (this._controlsBound) return;
    this._controlsBound = true;
    const C = () => this.CONTROL;
    const down = new Set();
    const apply = () => {
      if (!this.session || this.session.state !== "online" || !C()) return;
      const c = C();
      let flags = 0;
      if (down.has("w")) flags |= c.AT_POS;
      if (down.has("s")) flags |= c.AT_NEG;
      if (down.has("a")) flags |= c.LEFT_POS;
      if (down.has("d")) flags |= c.LEFT_NEG;
      if (down.has("q")) flags |= c.UP_NEG;
      if (down.has("e")) flags |= c.UP_POS;
      if (down.has("shift")) flags |= c.FAST_AT;
      if (this.flying) flags |= c.FLY;
      this.session.setControls(flags);
    };
    window.addEventListener("keydown", (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === " ") { this.flying = !this.flying; apply(); e.preventDefault(); return; }
      down.add(k.length === 1 ? k : k);
      apply();
    });
    window.addEventListener("keyup", (e) => {
      down.delete(e.key.toLowerCase());
      apply();
    });
  }

  // Keeps the camera anchored to our own avatar: the simulator is the one that
  // moves it (we only send control flags), so the view has to follow whatever
  // position the region reports. In fly mode the camera is free.
  followAgent() {
    const s = this.session;
    if (!s || s.state !== "online" || !s.movementComplete) return;
    const av = this.world.addAvatar(s.agentID, s.agentName);
    this.world.updateAvatar(av, s.agentPos, s.agentRot);
    if (!this.viewer.controls.flying) this.viewer.controls.follow(s.agentPos);
  }

  loop() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.viewer.frame(dt);
    if (this.world.terrainDirty) {
      this.world.terrainDirty = false;
      this.world.rebuildTerrain();
    }
    this.followAgent();
    this.world.animateAvatars(now);
    this.applyTouchInput();
    this.frameCount = (this.frameCount || 0) + 1;
    const every = this.profile.lodEvery || 4;
    if (this.frameCount % every === 0) this.world.updateLOD(this.viewer.camera.position, 2);
    if (this.frameCount % (this.profile.visibilityEvery || 3) === 0) {
      this.world.updateVisibility(this.viewer.camera.position);
    }
    // Static batches are rebuilt here (time-boxed) and the near cells are drawn
    // from them instead of from thousands of individual prims.
    this.world.updateBatches(this.viewer.camera.position);
    // Frame-rate governor: trade pixels for smoothness on a weak GPU.
    if (this.scaler.sample(dt * 1000)) this.viewer.setRenderScale(this.scaler.scale);
    // Starved even at the lowest render scale: what has to shrink now is the
    // world itself, not the resolution.
    if (this.scaler.starved >= 4 && this.profile.name !== "bajo" && now > this.graceUntil) this.stepDownProfile();
    const s = this.viewer.stats;
    this.ui.updateStats({ fps: s.fps, tris: s.tris, objects: this.world.objectCount });
    this.raf = requestAnimationFrame(() => this.loop());
  }

  /** Switches render profile at runtime (settings panel). */
  setProfile(name) {
    const p = PROFILES[name];
    if (!p) return this.profile;
    this.profile = p;
    this.viewer.applyProfile(p);
    this.world.applyProfile(p);
    this.scaler.setBounds(p.pixelRatioMax, p.renderScaleMin);
    this.scaler.target = name === "alto" ? 60 : 30;
    this.scaler.starved = 0;
    this.scaler.window.length = 0;
    this.scaler.cooldown = 90;
    this.viewer.setRenderScale(Math.min(this.scaler.scale, p.pixelRatioMax));
    return p;
  }

  /**
   * The device cannot hold the frame rate even at the profile's lowest render
   * scale, so the profile itself drops a level (and is remembered for the next
   * start). This is what keeps a modest phone usable without the user having to
   * find the quality setting: the viewer measures, then decides.
   */
  stepDownProfile() {
    const names = profileNames();
    const from = this.profile.name;
    const i = names.indexOf(from);
    this.scaler.starved = 0;
    if (i <= 0) return;
    const next = names[i - 1];
    this.setProfile(next);
    prefsSet({ "visor.profile": next });
    this.ui.log(`Rendimiento insuficiente para «${from}»: bajo a «${next}» (${PROFILES[next].label}).`);
  }
}

export function boot() {
  const canvas = document.getElementById("view");
  const app = new App(canvas);
  window.visor = app;
  const params = location.search;
  if (params.includes("test=grid")) {
    import("./test/fake-grid.js")
      .then((m) => m.runFakeGrid(app))
      .catch((e) => app.ui.error("harness: " + ((e && e.message) || e)));
  }
  if (params.includes("test=avatar")) {
    import("./test/avatar-test.js")
      .then((m) => m.runAvatarTest(app))
      .catch((e) => app.ui.error("harness de avatares: " + ((e && e.message) || e)));
  }
  if (params.includes("test=demo")) {
    app.ui.hideModal();
    app.loadDemo();
  }
  return app;
}
