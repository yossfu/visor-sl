// Transport layer: the viewer needs raw UDP (Second Life circuit) and CORS-free
// HTTP (login + capabilities). Inside the Android app both come from the
// native bridge (VisorNative). In a plain browser we fall back to the
// Perchance super-fetch proxy for HTTP, and UDP is simply unavailable.

const pending = new Map();
const channels = new Map();
let counter = 0;
let sinkInstalled = false;

export function nativeBridge() {
  return typeof window !== "undefined" && window.VisorNative && window.VisorNative.udp !== undefined
    ? window.VisorNative
    : (typeof window !== "undefined" && window.VisorNative) || null;
}

export function hasNative() {
  return !!nativeBridge();
}

export function hasUdp() {
  return hasNative();
}

function b64encode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64decode(text) {
  const raw = atob(text || "");
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function installSink() {
  if (sinkInstalled || typeof window === "undefined") return;
  sinkInstalled = true;
  window.visornative = (json) => {
    let msg;
    try {
      msg = typeof json === "string" ? JSON.parse(json) : json;
    } catch (e) {
      return;
    }
    if (!msg || !msg.id) return;
    if (msg.kind === "udpBatch") {
      for (const item of msg.batch || []) deliverDatagram(item);
      return;
    }
    if (msg.kind === "udp") {
      deliverDatagram(msg);
      return;
    }
    if (msg.kind === "udpSend") {
      if (msg.ok === false) channelError(msg.id, "envío UDP: " + (msg.error || "error nativo"));
      return;
    }
    if (msg.kind === "udpError") {
      channelError(msg.id, msg.error || "error de recepción UDP");
      return;
    }
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    resolve(msg);
  };
}

function deliverDatagram(msg) {
  const ch = channels.get(msg.chan || msg.id);
  if (!ch) return;
  let bytes;
  try {
    bytes = b64decode(msg.data);
  } catch (e) {
    return;
  }
  ch.stats.in++;
  ch.stats.bytesIn += bytes.length;
  if (ch.handlers.message) ch.handlers.message(bytes, msg.from, msg.port);
}

function channelError(key, text) {
  const ch = channels.get(key);
  if (ch && ch.handlers.error) ch.handlers.error(new Error(text));
}

function nativeCall(fn, arg) {
  const bridge = nativeBridge();
  if (!bridge) return Promise.reject(new Error("puente nativo no disponible"));
  if (typeof bridge[fn] !== "function") {
    return Promise.reject(new Error(`la app Android no tiene ${fn}() (APK antiguo: reinstala)`));
  }
  installSink();
  const id = "v" + ++counter;
  const budget = (arg && arg.timeout ? arg.timeout : 15000) + 10000;
  // `id` identifies THIS call so the reply can be matched; `chan` (if the caller
  // set one) identifies a UDP socket. The tracking id must win: letting a
  // caller-supplied `id` through silently broke every UDP call (the answer came
  // back under the channel's id and was dropped).
  const request = Object.assign({}, arg, { id });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`el puente nativo no respondió a ${fn} en ${Math.round(budget / 1000)}s`));
    }, budget);
    const done = (value) => { clearTimeout(timer); resolve(value); };
    pending.set(id, done);
    let ack;
    try {
      ack = bridge[fn](JSON.stringify(request));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
      return;
    }
    try {
      const parsed = typeof ack === "string" ? JSON.parse(ack) : ack;
      if (parsed && parsed.ok === false) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`${fn}: ${parsed.error || "error nativo"}`));
      }
    } catch (e) {
      /* ack is informational only */
    }
  });
}

export function platformInfo() {
  const bridge = nativeBridge();
  if (!bridge) {
    return { platform: "web", nativeBridge: false, udp: false };
  }
  try {
    return JSON.parse(bridge.platform());
  } catch (e) {
    return { platform: "android", nativeBridge: true, udp: true };
  }
}

export async function httpRequest({ url, method = "GET", headers = {}, body = null, timeout = 45000 }) {
  const bytes = body == null ? null : body instanceof Uint8Array ? body : new TextEncoder().encode(String(body));
  const bridge = nativeBridge();
  if (bridge) {
    const req = { url, method, headers, timeout, connectTimeout: 15000 };
    if (bytes) req.body = b64encode(bytes);
    const res = await nativeCall("http", req);
    if (!res.ok) throw new Error(res.error || "http fallido");
    const data = b64decode(res.body);
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      headers: res.headers || {},
      bytes: data,
      text: new TextDecoder().decode(data),
    };
  }
  const superFetch = typeof root !== "undefined" && root && root.superFetch ? root.superFetch : null;
  const doFetch = superFetch || fetch;
  const res = await doFetch(url, {
    method,
    headers: method === "GET" ? headers : Object.assign({ "Content-Type": "text/xml" }, headers),
    body: bytes || undefined,
  });
  const data = new Uint8Array(await res.arrayBuffer());
  const out = {};
  res.headers.forEach((v, k) => (out[k] = v));
  return {
    ok: res.ok,
    status: res.status,
    headers: out,
    bytes: data,
    text: new TextDecoder().decode(data),
  };
}

export class UdpChannel {
  constructor(id) {
    this.id = id;
    this.closed = false;
    this.localPort = 0;
    this.handlers = { message: null, error: null, close: null };
    this.stats = { in: 0, out: 0, bytesIn: 0, bytesOut: 0 };
  }

  send(bytes) {
    if (this.closed) return;
    this.stats.out++;
    this.stats.bytesOut += bytes.length;
    nativeCall("udpSend", { chan: this.id, data: b64encode(bytes) }).catch((e) => {
      if (this.handlers.error) this.handlers.error(e);
    });
  }

  onMessage(cb) { this.handlers.message = cb; }
  onError(cb) { this.handlers.error = cb; }
  onClose(cb) { this.handlers.close = cb; }

  close() {
    if (this.closed) return;
    this.closed = true;
    channels.delete(this.id);
    nativeCall("udpClose", { chan: this.id }).catch(() => {});
    if (this.handlers.close) this.handlers.close();
  }
}

export async function openUdp(host, port) {
  if (!hasNative()) {
    throw new Error(
      "Este dispositivo no puede abrir UDP desde el navegador. Abre la app Android de Visor SL para conectarte al grid."
    );
  }
  const id = "u" + ++counter;
  const ch = new UdpChannel(id);
  channels.set(id, ch);
  try {
    const res = await nativeCall("udpOpen", { chan: id, host, port, timeout: 8000 });
    if (!res.ok) throw new Error(res.error || `no se pudo abrir UDP ${host}:${port}`);
    ch.localPort = res.localPort || 0;
  } catch (e) {
    channels.delete(id);
    throw e;
  }
  return ch;
}

/**
 * One datagram out of a throwaway socket, waiting for any reply. The HUD
 * diagnostic uses it to separate "socket cannot be created" from "outbound UDP
 * blocked" from "the simulator never answered".
 */
export async function udpProbe(host, port, bytes, waitMs = 4000) {
  if (!hasNative()) throw new Error("puente nativo no disponible (hace falta el APK)");
  return nativeCall("udpProbe", {
    host, port, data: b64encode(bytes), waitMs, timeout: waitMs + 8000,
  });
}

export function netInfo() {
  const bridge = nativeBridge();
  if (!bridge || typeof bridge.netInfo !== "function") return null;
  try {
    return JSON.parse(bridge.netInfo());
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}
