import {
  encodeBody, decodeBody, encodeNumber, decodeNumber, wireNumber, zeroEncode, zeroDecode,
} from "./message-template.js";

export const FLAG_APPENDED_ACKS = 0x10;
export const FLAG_RESENT = 0x20;
export const FLAG_RELIABLE = 0x40;
export const FLAG_ZEROCODED = 0x80;

export const MAX_PAYLOAD = 1018;
export const MAX_ACKS_PER_PACKET = 40;

export function writeBE32(out, offset, value) {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

export function readBE32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function buildPacket({ sequence = 0, reliable = false, zerocodable = true, payload, acks = null, resent = false }) {
  let body = payload;
  let flags = reliable ? FLAG_RELIABLE : 0;
  if (resent) flags |= FLAG_RESENT;
  if (zerocodable && payload.length > 8) {
    const z = zeroEncode(payload);
    if (z.length < payload.length) {
      body = z;
      flags |= FLAG_ZEROCODED;
    }
  }
  const ackCount = acks && acks.length ? Math.min(acks.length, MAX_ACKS_PER_PACKET) : 0;
  const out = new Uint8Array(6 + body.length + ackCount * 4 + (ackCount ? 1 : 0));
  out[0] = flags;
  writeBE32(out, 1, sequence);
  out[5] = 0;
  out.set(body, 6);
  if (ackCount) {
    out[0] |= FLAG_APPENDED_ACKS;
    let p = 6 + body.length;
    for (let i = 0; i < ackCount; i++) {
      writeBE32(out, p, acks[i]);
      p += 4;
    }
    out[p] = ackCount;
  }
  return out;
}

export function parsePacket(bytes) {
  const flags = bytes[0];
  const sequence = readBE32(bytes, 1);
  const extra = bytes[5];
  const start = 6 + extra;
  let end = bytes.length;
  const acks = [];
  if (flags & FLAG_APPENDED_ACKS) {
    const count = bytes[end - 1];
    end -= 1 + count * 4;
    for (let i = 0; i < count; i++) acks.push(readBE32(bytes, end + i * 4));
  }
  const payload = flags & FLAG_ZEROCODED ? zeroDecode(bytes, start, end) : bytes.slice(start, end);
  const num = decodeNumber(payload, 0);
  return {
    flags,
    sequence,
    extra,
    acks,
    payload,
    messageNumber: num.value,
    bodyOffset: num.size,
    reliable: !!(flags & FLAG_RELIABLE),
    resent: !!(flags & FLAG_RESENT),
    zerocoded: !!(flags & FLAG_ZEROCODED),
  };
}

export function buildMessage(def, obj) {
  const header = encodeNumber(wireNumber(def));
  const body = encodeBody(def, obj);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

export function decodeMessage(def, packet) {
  return decodeBody(def, packet.payload, packet.bodyOffset);
}

export class Circuit {
  constructor(send, opts = {}) {
    this.send = send;
    this.sequence = 0;
    this.pendingAcks = new Set();
    this.unacked = new Map();
    this.retryMs = opts.retryMs || 1000;
    this.maxRetries = opts.maxRetries || 8;
    this.stats = { sent: 0, received: 0, bytesIn: 0, bytesOut: 0, resends: 0, acksSent: 0 };
    this.lastSend = 0;
    this.remote = null;
  }

  nextSequence() {
    this.sequence = (this.sequence + 1) >>> 0;
    return this.sequence;
  }

  sendMessage(def, obj, opts = {}) {
    const reliable = opts.reliable !== false;
    const payload = buildMessage(def, obj);
    const packet = this.buildPacket(payload, reliable);
    this.send(packet);
    this.stats.sent++;
    this.stats.bytesOut += packet.length;
    this.lastSend = Date.now();
    return packet;
  }

  buildPacket(payload, reliable) {
    const seq = this.nextSequence();
    this.lastSeq = seq;
    const acks = this.takeAcks();
    const packet = buildPacket({ sequence: seq, reliable, payload, acks });
    if (reliable) this.unacked.set(seq, { payload, sent: Date.now(), retries: 0 });
    return packet;
  }

  takeAcks() {
    if (!this.pendingAcks.size) return null;
    const list = [...this.pendingAcks].slice(0, MAX_ACKS_PER_PACKET);
    for (const s of list) this.pendingAcks.delete(s);
    this.stats.acksSent += list.length;
    return list;
  }

  handlePacket(bytes, now = Date.now()) {
    const packet = parsePacket(bytes);
    this.stats.received++;
    this.stats.bytesIn += bytes.length;
    if (packet.reliable) this.pendingAcks.add(packet.sequence);
    for (const a of packet.acks) this.unacked.delete(a);
    return packet;
  }

  /**
   * A standalone PacketAck message (0xFFFFFFFB) also acknowledges our reliable
   * packets — the simulator mostly uses those instead of the appended-ack
   * trailer, so ignoring them makes the resend loop retry forever.
   */
  ack(sequence) {
    const seq = sequence >>> 0;
    if (this.unacked.delete(seq)) this.stats.acksIn++;
  }

  pendingResends(now = Date.now()) {
    const due = [];
    for (const [seq, rec] of this.unacked) {
      if (now - rec.sent >= this.retryMs * (rec.retries + 1)) {
        rec.retries++;
        rec.sent = now;
        this.stats.resends++;
        const packet = buildPacket({
          sequence: seq, reliable: true, payload: rec.payload, acks: this.takeAcks(), resent: true,
        });
        due.push({ seq, packet, retries: rec.retries });
      }
    }
    return due;
  }

  dropExpired(now = Date.now()) {
    for (const [seq, rec] of this.unacked) {
      if (now - rec.sent > this.retryMs * this.maxRetries * 4) this.unacked.delete(seq);
    }
  }

  reset() {
    this.sequence = 0;
    this.pendingAcks.clear();
    this.unacked.clear();
  }
}
