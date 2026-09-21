// Touch controls for the Android app: a virtual stick on the left moves the
// avatar, dragging the right half of the screen orbits the camera, and a column
// of buttons on the right toggles fly / run / jump — the same layout mobile
// players know from Genshin Impact and similar games.
//
// Movement is camera-relative (push the stick away from you and the avatar walks
// where the camera is looking, turning to face that way), which is what SL does
// in third-person "move with camera" mode: the viewer sends AT_POS/LEFT_POS plus
// the BodyRotation of the heading and the simulator walks the avatar.
//
// Everything is a pointer event, so it also works with a mouse in the desktop
// preview (a pointer is a pointer).

import { el } from "./ui.js";

const DEAD_ZONE = 0.22;

export class TouchControls {
  constructor(app) {
    this.app = app;
    this.move = { x: 0, y: 0 };
    this.jump = false;
    this.run = false;
    this.fly = false;
    this.sit = false;
    this._look = { dx: 0, dy: 0 };
    this._stick = null;
    this._lookDrag = null;
    this.visible = false;
    this.build();
    this.setVisible(false);
  }

  build() {
    const layer = el("div", { class: "touch layer hidden", id: "touchLayer" });

    // --- camera drag area (right half) -------------------------------------
    this.lookArea = el("div", { class: "look-area", id: "lookArea" });
    this.bindLook(this.lookArea);
    layer.appendChild(this.lookArea);

    // --- movement stick (bottom left) --------------------------------------
    this.knob = el("div", { class: "knob" });
    this.stick = el("div", { class: "stick", id: "stick" }, [this.knob]);
    this.bindStick(this.stick);
    layer.appendChild(this.stick);

    // --- action buttons (bottom right) -------------------------------------
    const btn = (id, label, cls, onTap) => {
      const b = el("button", { class: "tbtn " + (cls || ""), id, text: label });
      let down = false;
      b.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        down = true;
        b.classList.add("on");
        if (onTap) onTap(true);
      });
      const up = (e) => {
        if (!down) return;
        down = false;
        b.classList.remove("on");
        if (onTap) onTap(false);
      };
      b.addEventListener("pointerup", up);
      b.addEventListener("pointercancel", up);
      b.addEventListener("pointerleave", up);
      this[id + "El"] = b;
      return b;
    };

    this.jumpBtn = btn("jump", "Saltar", "small", (on) => { this.jump = on; });
    this.flyBtn = btn("fly", "Volar", "small", (on) => {
      if (!on) return;
      this.fly = !this.fly;
      this.flyBtn.classList.toggle("active", this.fly);
      this.app.onTouchFly(this.fly);
    });
    this.runBtn = btn("run", "Correr", "small", (on) => {
      this.run = on;
    });
    this.sitBtn = btn("sit", "Sentar", "small", (on) => {
      if (on) this.app.onTouchSit();
    });

    const right = el("div", { class: "touch-right" }, [this.jumpBtn, this.flyBtn, this.runBtn, this.sitBtn]);
    layer.appendChild(right);

    const help = el("div", { class: "touch-help", text: "Arrastra la mitad derecha para mirar · botón ☰ para el registro" });
    layer.appendChild(help);

    this.layer = layer;
    document.getElementById("hud").appendChild(layer);
  }

  bindStick(node) {
    const RADIUS = 58;
    // setPointerCapture throws for events that are not from a real pointer
    // (synthetic tests, some WebView quirks) — capture is a nicety, not a need.
    const capture = (e) => { try { node.setPointerCapture(e.pointerId); } catch (_) {} };
    const setFrom = (e) => {
      const r = node.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = (e.clientX - cx) / RADIUS;
      let dy = (e.clientY - cy) / RADIUS;
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      this.move.x = dx;
      this.move.y = -dy; // screen Y grows downwards; +y means "forward"
      this.knob.style.transform = `translate(${dx * RADIUS}px, ${dy * RADIUS}px)`;
      const mag = Math.hypot(dx, dy);
      if (mag < DEAD_ZONE) { this.move.x = 0; this.move.y = 0; }
      // Pushing the stick all the way runs (Genshin-style), so the run button
      // is only needed to lock into running.
      this.pushRun = mag > 0.92;
      this.stick.classList.toggle("pushed", this.pushRun);
    };
    node.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      capture(e);
      this._stick = e.pointerId;
      node.classList.add("active");
      setFrom(e);
    });
    node.addEventListener("pointermove", (e) => {
      if (this._stick !== e.pointerId) return;
      e.preventDefault();
      setFrom(e);
    });
    const end = (e) => {
      if (this._stick !== e.pointerId) return;
      this._stick = null;
      this.move.x = 0; this.move.y = 0;
      this.pushRun = false;
      this.stick.classList.remove("pushed");
      this.knob.style.transform = "translate(0px, 0px)";
      node.classList.remove("active");
    };
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  }

  bindLook(node) {
    const capture = (e) => { try { node.setPointerCapture(e.pointerId); } catch (_) {} };
    node.addEventListener("pointerdown", (e) => {
      capture(e);
      const now = performance.now();
      const last = this._lastTap;
      this._lookDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, t: now };
      // Double tap jumps, like every third-person mobile game.
      if (last && now - last.t < 280 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 60) {
        this._lastTap = null;
        this.app.onTouchJump && this.app.onTouchJump();
      } else {
        this._lastTap = { x: e.clientX, y: e.clientY, t: now };
      }
    });
    node.addEventListener("pointermove", (e) => {
      const d = this._lookDrag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      this._look.dx += dx;
      this._look.dy += dy;
      const c = this.app.viewer.controls;
      c.yaw -= dx * 0.006;
      c.pitch = Math.max(-1.2, Math.min(1.2, c.pitch + dy * 0.005));
      c.applyOrbit();
    });
    const end = (e) => {
      const d = this._lookDrag;
      if (!d || d.id !== e.pointerId) return;
      this._lookDrag = null;
      // a quick tap is a "pick", like the desktop mouse click
      const dt = performance.now() - d.t;
      if (!d.moved && dt < 400 && this.app.pickAt) this.app.pickAt(e.clientX, e.clientY);
    };
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  }

  setVisible(on) {
    this.visible = !!on;
    this.layer.classList.toggle("hidden", !on);
    document.body.classList.toggle("touch-mode", !!on);
    if (!on) { this.move.x = 0; this.move.y = 0; this.fly = false; this.run = false; this.flyBtn.classList.remove("active"); }
  }

  // The stick vector the render loop turns into SL control flags.
  get vector() { return this.move; }

  /** True while the player is holding the virtual jump button (or pushed the stick all the way). */
  get jumping() { return this.jump; }

  /** Whether the movement should be a run: the button, or the stick pushed fully. */
  get running() { return this.run || !!this.pushRun; }
}
