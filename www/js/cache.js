// Policy for the copies of grid data that the viewer keeps on the device
// (textures today; anything immutable and expensive tomorrow).
//
// Why this module exists — two failures the user actually hit:
//
//  1. A stored copy is INVISIBLE. When a round of fixes changes how something
//     is decoded, the old entry keeps winning, and the fix looks like it did
//     nothing at all. So every entry carries the REVISION it was written under
//     (`r2_tex_<uuid>`), and when the revision changes the whole store is
//     thrown away at boot. Changing CACHE_REV is therefore all a future change
//     has to do to be sure it is not being lied to by an old file.
//
//  2. A bad entry used to be PERMANENT. A texture whose stored bytes were
//     truncated (or written by a buggy round) failed to decode every single
//     time; the viewer counted a failure and never asked the grid again. Now
//     every read is sanity-checked (magic bytes) and any entry that does not
//     decode is deleted and re-fetched — the cache heals itself.
//
// The user can also turn the store off entirely ("modo sin caché"), which is
// what you want while testing: every texture is then pulled from the grid
// again, so what you see is unambiguously the current code.

import { cacheGet, cachePut, cacheDelete, cacheClear, cacheVerify, prefsAll, prefsSet } from "./transport.js";

/**
 * Bump this whenever a change alters what a stored copy MEANS (a decoder fix, a
 * new encoding, a different size cap). Old entries are wiped on the next start.
 */
export const CACHE_REV = "r2";

const MODE_KEY = "visor.cache";
const REV_KEY = "visor.cacheRev";

/** `"on"` (default) or `"off"` (never read or write; everything from the grid). */
export function cacheMode() {
  try {
    return prefsAll()[MODE_KEY] === "off" ? "off" : "on";
  } catch (e) {
    return "on";
  }
}

export function setCacheMode(off) {
  try {
    prefsSet({ [MODE_KEY]: off ? "off" : "on" });
  } catch (e) {
    /* prefs are best-effort */
  }
}

/** Stored entries are always addressed under the current revision. */
export function cacheKey(kind, id) {
  return `${CACHE_REV}_${kind}_${id}`;
}

// Magic bytes of the things the grid (and the app) hand us. A stored copy that
// starts with none of these is truncated or was written wrong: it is worth less
// than no copy at all, because it can never decode.
const MAGIC = [
  [[0xff, 0x4f, 0xff, 0x51], "j2c"],            // JPEG2000 codestream (what GetTexture returns)
  [[0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50], "jp2"], // JPEG2000 wrapped in JP2
  [[0x89, 0x50, 0x4e, 0x47], "png"],
  [[0xff, 0xd8, 0xff], "jpeg"],
  [[0x47, 0x49, 0x46, 0x38], "gif"],
  [[0x42, 0x4d], "bmp"],
];

/** True when `bytes` starts like an image the decoder can be asked to decode. */
export function looksLikeImage(bytes) {
  if (!bytes || bytes.length < 16) return false;
  for (const [magic] of MAGIC) {
    let hit = true;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic[i]) { hit = false; break; }
    }
    if (hit) return true;
  }
  // RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return true;
  return false;
}

/** Bytes of a stored entry, or null (also null when the store is off). */
export async function readCached(key) {
  if (cacheMode() === "off") return null;
  try {
    const bytes = await cacheGet(key);
    return bytes && bytes.length ? bytes : null;
  } catch (e) {
    return null;
  }
}

/** Stores a copy. Returns whether it really was written. */
export async function writeCached(key, bytes) {
  if (cacheMode() === "off" || !bytes || !bytes.length) return false;
  try {
    return await cachePut(key, bytes);
  } catch (e) {
    return false;
  }
}

/** Forgets one entry (used when the stored copy turns out to be useless). */
export async function dropCached(key) {
  try {
    return await cacheDelete(key);
  } catch (e) {
    return null;
  }
}

/** Empties the whole store (native side). Returns {deleted} or null. */
export async function wipeCache() {
  try {
    return await cacheClear();
  } catch (e) {
    return null;
  }
}

/**
 * Reads the first bytes of every stored file natively and says how many are
 * corrupt. Reading 800 files through the bridge as base64 would take minutes;
 * the native side can look at 12 bytes each and answer in milliseconds.
 */
export async function verifyCache() {
  try {
    return await cacheVerify();
  } catch (e) {
    return null;
  }
}

/**
 * Boot-time guard: if the viewer last ran under another revision, wipe the store
 * (it cannot be trusted) and remember the new one. Also wipes when the mode was
 * switched off and on again? No — that would fight the "sin caché" test mode;
 * the point of off is to not touch the store, not to lose it.
 */
export async function syncRevision() {
  let previous = "";
  try {
    previous = String(prefsAll()[REV_KEY] || "");
  } catch (e) {
    /* no prefs (browser): nothing to compare against */
  }
  if (previous === CACHE_REV) return { changed: false, rev: CACHE_REV, previous };
  const res = await wipeCache();
  try {
    prefsSet({ [REV_KEY]: CACHE_REV });
  } catch (e) {
    /* best effort */
  }
  return {
    changed: true,
    rev: CACHE_REV,
    previous: previous || "(sin revisión)",
    deleted: res && typeof res.deleted === "number" ? res.deleted : null,
  };
}
