// Render profiles + adaptive resolution.
//
// A phone cannot draw a Second Life region the way a desktop preview does: the
// viewer has to trade resolution, shadow quality, draw distance and how many
// objects it keeps meshed for a frame rate that stays usable. Instead of one
// hard-coded compromise, the viewer picks a profile from what the device says
// about itself (`hardwareConcurrency`, `deviceMemory`, the WebGL renderer, the
// native bridge) and then lets the frame timer trim the render scale until the
// target frame rate is met.
import { platformInfo, hasNative } from "./transport.js";

export const PROFILES = {
  bajo: {
    name: "bajo",
    label: "Rendimiento (móvil modesto)",
    pixelRatioMax: 1,
    renderScaleMin: 0.55,
    antialias: false,
    shadows: false,
    shadowMap: 0,
    drawDistance: 72,
    maxObjects: 600,
    fogFar: 260,
    terrainSkip: 4,
    water: false,
    texMax: 256,
    lodEvery: 8,
    visibilityEvery: 4,
    textureBudgetMB: 48,
    terrainDetail: 0,
  },
  medio: {
    name: "medio",
    label: "Equilibrado (móvil)",
    pixelRatioMax: 1.25,
    renderScaleMin: 0.6,
    antialias: true,
    shadows: false,
    shadowMap: 0,
    drawDistance: 112,
    maxObjects: 1600,
    fogFar: 340,
    terrainSkip: 2,
    water: true,
    texMax: 512,
    lodEvery: 5,
    visibilityEvery: 3,
    textureBudgetMB: 96,
    terrainDetail: 1,
  },
  alto: {
    name: "alto",
    label: "Calidad (escritorio)",
    pixelRatioMax: 2,
    renderScaleMin: 0.7,
    antialias: true,
    shadows: true,
    shadowMap: 2048,
    drawDistance: 200,
    maxObjects: 4000,
    fogFar: 460,
    terrainSkip: 1,
    water: true,
    texMax: 1024,
    lodEvery: 3,
    visibilityEvery: 2,
    textureBudgetMB: 256,
    terrainDetail: 2,
  },
};

const ORDER = ["bajo", "medio", "alto"];

export function profileNames() {
  return ORDER.slice();
}

export function profile(name) {
  return PROFILES[name] || null;
}

/** True when the page is running inside the Android shell (or a touch device). */
export function isMobile() {
  if (hasNative()) return true;
  if (typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "")) return true;
  return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
}

/**
 * Picks a starting profile. The Android shell reports the model/SDK, which is a
 * far better hint than the user agent, so it is preferred when available.
 */
export function detectProfile() {
  const info = platformInfo();
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  const ram = (typeof navigator !== "undefined" && navigator.deviceMemory) || 0;

  if (info && info.platform === "android") {
    const sdk = Number(info.sdk || 0);
    const lowEnd = (ram && ram <= 3) || cores <= 4;
    const known = /sm-\w|mi \d|redmi|poco|moto g\d|galaxy a\d/i.test(String(info.model || ""));
    if (lowEnd || known || sdk === 0) return PROFILES.bajo;
    return PROFILES.medio;
  }
  if (isMobile()) return PROFILES.bajo;
  return PROFILES.alto;
}

/**
 * Frame-rate governor. It keeps a bounded render-scale multiplier and nudges it
 * down when frames are slow and back up when there is head-room, so a device
 * that cannot hold 30 fps at 1.0 ends up at 0.6 instead of stuttering.
 */
export class AdaptiveScaler {
  constructor(opts = {}) {
    this.target = opts.target || 32;
    this.ceiling = opts.ceiling || 1;
    this.floor = opts.floor || 0.55;
    this.scale = opts.scale || this.ceiling;
    this.window = [];
    this.windowSize = 45;
    this.cooldown = 0;
    this.enabled = opts.enabled !== false;
    this.lastChange = 0;
    // How many measurement windows in a row have been slow *after* the render
    // scale hit its floor. At that point resolution has nothing left to give and
    // the caller (app.js) steps the whole profile down instead.
    this.starved = 0;
  }

  setBounds(ceiling, floor) {
    this.ceiling = Math.max(0.4, ceiling);
    this.floor = Math.min(this.ceiling, Math.max(0.35, floor));
    this.scale = Math.min(this.scale, this.ceiling);
  }

  /** Feed one frame time in ms; returns true when the scale changed. */
  sample(ms) {
    if (!this.enabled || !isFinite(ms) || ms <= 0) return false;
    this.window.push(ms);
    if (this.window.length > this.windowSize) this.window.shift();
    if (this.window.length < this.windowSize) return false;
    if (this.cooldown > 0) { this.cooldown--; return false; }

    const sorted = [...this.window].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const fps = 1000 / median;
    const before = this.scale;
    if (fps < this.target - 4) {
      if (this.scale > this.floor) {
        this.scale = Math.max(this.floor, this.scale - 0.1);
        this.starved = 0;
      } else if (fps < this.target - 8) {
        // Already as cheap as the resolution can get and still clearly slow.
        this.starved++;
      }
    } else {
      this.starved = 0;
      if (fps > this.target + 14 && this.scale < this.ceiling) {
        this.scale = Math.min(this.ceiling, this.scale + 0.05);
      }
    }
    if (this.scale === before) {
      // Head-room at the ceiling: keep the measurement window short so a
      // regression is noticed quickly.
      this.window.length = Math.floor(this.windowSize / 2);
      return false;
    }
    this.window.length = 0;
    this.cooldown = 60;
    this.lastChange = performance.now();
    return true;
  }

  get fpsTarget() {
    return this.target;
  }
}
