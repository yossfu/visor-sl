export class V2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  set(x, y) { this.x = x; this.y = y; return this; }
  copy(v) { this.x = v.x; this.y = v.y; return this; }
  mul(s) { this.x *= s; this.y *= s; return this; }
  magVec() { return Math.hypot(this.x, this.y); }
  normVec() { const m = this.magVec(); if (m > 0) { this.x /= m; this.y /= m; } return this; }
}

export class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  mul(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  setSub(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { const x = this.y * v.z - this.z * v.y, y = this.z * v.x - this.x * v.z, z = this.x * v.y - this.y * v.x; return this.set(x, y, z); }
  magVec() { return Math.hypot(this.x, this.y, this.z); }
  magVecSquared() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normVec() { const m = this.magVec(); if (m > 0) { this.x /= m; this.y /= m; this.z /= m; } return this; }
  static sub(a, b) { return new V3(a.x - b.x, a.y - b.y, a.z - b.z); }
  static cross(a, b) { return new V3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
  static lerp(a, b, t) { return new V3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t); }
}

export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  setAxisAngle(angle, ax, ay, az) {
    if (typeof ax === 'object') { az = ax.z; ay = ax.y; ax = ax.x; }
    const half = angle * 0.5, s = Math.sin(half);
    let len = Math.hypot(ax, ay, az);
    if (len < 1e-9) { this.x = this.y = this.z = 0; this.w = 1; return this; }
    this.x = (ax / len) * s; this.y = (ay / len) * s; this.z = (az / len) * s; this.w = Math.cos(half);
    return this;
  }
  setMul(a, b) {
    this.x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
    this.y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
    this.z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
    this.w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
    return this;
  }
  rotate(v, out = new V3()) {
    const { x, y, z, w } = this;
    const ix = w * v.x + y * v.z - z * v.y;
    const iy = w * v.y + z * v.x - x * v.z;
    const iz = w * v.z + x * v.y - y * v.x;
    const iw = -x * v.x - y * v.y - z * v.z;
    out.x = ix * w + iw * -x + iy * -z - iz * -y;
    out.y = iy * w + iw * -y + iz * -x - ix * -z;
    out.z = iz * w + iw * -z + ix * -y - iy * -x;
    return out;
  }
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
