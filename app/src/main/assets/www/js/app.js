// Application bootstrap: viewer + world + HUD + input + main loop.
import * as THREE from "../vendor/three.module.min.js";
import { Viewer } from "./renderer.js";
import { World } from "./world.js";
import { UI } from "./ui.js";
import { buildDemoRegion } from "./demo.js";
import { defaultPrimParams } from "./prims.js";

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.viewer = new Viewer(canvas);
    this.world = new World(this.viewer);
    this.world.onSelect = (rec) => this.ui.showInspector(rec);
    this.ui = new UI(this);
    this.session = null;
    this.mode = "demo";
    this.loadDemo(1337);
    this.bindInput();
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(() => this.loop());
  }

  loadDemo(seed = 1337) {
    this.mode = "demo";
    this.world.dispose();
    buildDemoRegion(this.world, { seed });
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
      const rect = c.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const hits = this.world.raycast(ndc);
      if (hits.length) {
        const rec = this.world.objects.get(hits[0].object.userData.objectId);
        this.world.select(rec);
      } else {
        this.world.select(null);
        this.ui.showInspector(null);
      }
    });
    c.addEventListener("dblclick", (e) => {
      const rect = c.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const hits = this.world.raycast(ndc);
      if (hits.length) {
        const rec = this.world.objects.get(hits[0].object.userData.objectId);
        if (rec.position) this.viewer.controls.focus(rec.position, Math.max(4, (rec.scale?.[0] || 1) * 4));
      }
    });
    window.addEventListener("contextmenu", (e) => { if (e.target === c) e.preventDefault(); });
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
    this.session = new mod.SLSession(this, { onStatus: opts.status });
    await this.session.login(opts);
    this.viewer.controls.focus(this.session.agentPos, 14);
    this.bindControls();
    this.ui.log("Controles: W/A/S/D moverse, Q/E subir-bajar, Espacio volar, Shift correr (en la app Android).");
  }

  async disconnect() {
    if (!this.session) return;
    await this.session.disconnect();
    this.session = null;
    this.ui.netEl.textContent = "sin conexión";
    this.ui.log("Sesión cerrada. Volviendo al modo demo.");
    this.loadDemo();
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

  loop() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.viewer.frame(dt);
    if (this.world.terrainDirty) {
      this.world.terrainDirty = false;
      this.world.rebuildTerrain();
    }
    this.world.updateLOD(this.viewer.camera.position, 2);
    this.frameCount = (this.frameCount || 0) + 1;
    if (this.frameCount % 6 === 0) this.world.updateVisibility(this.viewer.camera.position);
    const s = this.viewer.stats;
    this.ui.updateStats({ fps: s.fps, tris: s.tris, objects: this.world.objectCount });
    this.raf = requestAnimationFrame(() => this.loop());
  }
}

export function boot() {
  const canvas = document.getElementById("view");
  const app = new App(canvas);
  window.visor = app;
  if (location.search.includes("test=prims")) {
    import("./test/prims-selftest.js").then((m) => m.runSelfTest(app)).catch(console.error);
  }
  return app;
}
