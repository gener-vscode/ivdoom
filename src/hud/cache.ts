/**
 * The in-memory image cache the controller page reads.
 *
 * WHO HOLDS IT: the process that owns the endpoints (the Function App). `HudUploader` in ./upload.ts keeps
 * the producer's own copy in the game process; this is the copy a browser can GET. Two processes, two
 * memories, one wire - `src/input/store.ts` is the same pattern (in-memory + stats exposed), and it carries
 * the same warning: one host process holds this. Scale past one instance and this map must move to shared
 * storage, exactly as the input sessions would.
 *
 * Everything a page or a test needs to tell "no upload" from "refused" from "stale" is in `state()`:
 * a 200 with no content proves nothing, so the cache says what it holds and why it refused the rest.
 */
import { MAX_IMAGE_BYTES, validateStripPost, type Anchor, type MetaValue, type StripPost } from './wire.js';

export type CachedStrip = {
    id: string;
    /** PNG bytes, kept as a Buffer so a GET can stream it without re-encoding. */
    png: Buffer;
    bytes: number;
    /** content signature (see `signatureOf`): the difference between "a POST arrived" and "the picture changed" */
    signature: string;
  width: number;
  height: number;
  rows: number;
  anchor: Anchor;
  source: string;
  meta: { [key: string]: MetaValue };
  /** per-id, strictly increasing: the page re-fetches an image only when this changes */
  sequence: number;
  updatedAt: number;
  ignored: string[];
};

export type CacheLimits = { maxEntries: number; ttlMs: number; maxBytes: number };
/** 2 min of TTL: a finished game should still show its last score, then honestly disappear. */
export const CACHE_DEFAULTS: CacheLimits = { maxEntries: 8, ttlMs: 120_000, maxBytes: MAX_IMAGE_BYTES };

export type PutResult = { ok: boolean; reason?: string; id?: string; sequence?: number; bytes?: number; ignored?: string[] };
export type GetResult = { ok: boolean; exists: boolean; reason?: string; png?: Buffer };
export type StateView = {
  ok: true;
  id: string;
  exists: boolean;
    reason?: string;
    sequence?: number;
    updatedAt?: number;
    ageMs?: number;
    bytes?: number;
    /** the content signature, exposed: it is the only field that can answer "did the PICTURE change?" */
    signature?: string;
  width?: number;
  height?: number;
  rows?: number;
  anchor?: Anchor;
  source?: string;
  meta?: { [key: string]: MetaValue };
};

const refusalLogSize = 8;

/**
 * FNV-1a over the PNG bytes. This is what「郁」means, precisely:
 * the game POSTS a strip every second whether or not the score moved, so a `sequence` change proves only
 * that a POST arrived. The page must dim (0.3) when the PICTURE is unchanged and brighten (0.7) when the
 * picture really changed - and it must not re-download an identical image either. A content signature is
 * the only thing that can tell those two apart, and it is 4 lines of arithmetic.
 */
export const signatureOf = (png: Uint8Array): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < png.length; i++) {
        h ^= png[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
};

export class HudCache {
  private frames = new Map<string, CachedStrip>();
  private refused: { at: number; reason: string }[] = [];
  private expired = 0;
  private limits: CacheLimits;

  constructor(limits: Partial<CacheLimits> = {}) {
    this.limits = { ...CACHE_DEFAULTS, ...limits };
  }

  /** Drop a frame that no longer means anything, so `exists:false` is a fact and not a guess. */
  private reap(now: number): void {
    for (const [id, frame] of this.frames) {
      if (now - frame.updatedAt <= this.limits.ttlMs) continue;
      this.frames.delete(id);
      this.expired++;
    }
  }

  private noteRefusal(reason: string): void {
    this.refused.push({ at: Date.now(), reason });
    if (this.refused.length > refusalLogSize) this.refused.shift();
  }

  put(body: unknown): PutResult {
    const validation = validateStripPost(body);
    if (!validation.ok || !validation.post) {
      this.noteRefusal(String(validation.reason));
      return { ok: false, reason: String(validation.reason) };
    }
    const post: StripPost = validation.post;
    const png = Buffer.from(post.png, 'base64');
    if (png.length > this.limits.maxBytes) {
      const reason = `png-too-large (${png.length} bytes > ${this.limits.maxBytes})`;
      this.noteRefusal(reason);
      return { ok: false, reason };
    }

    const now = Date.now();
    this.reap(now);
    const previous = this.frames.get(post.id);
    if (!previous && this.frames.size >= this.limits.maxEntries) {
      // bounded memory, oldest first: a stale page must not be able to grow this map forever
      let oldestId = '';
      let oldest = Number.MAX_SAFE_INTEGER;
      for (const [id, frame] of this.frames) if (frame.updatedAt < oldest) { oldest = frame.updatedAt; oldestId = id; }
      if (oldestId) this.frames.delete(oldestId);
    }

    const frame: CachedStrip = {
        id: post.id,
        png,
        bytes: png.length,
        signature: signatureOf(png),
      width: post.width,
      height: post.height,
      rows: post.rows,
      anchor: post.anchor,
      source: post.source,
      meta: post.meta,
      sequence: (previous?.sequence ?? 0) + 1,
      updatedAt: now,
      ignored: validation.ignored ?? [],
    };
    this.frames.set(post.id, frame);
    return { ok: true, id: post.id, sequence: frame.sequence, bytes: frame.bytes, ...(frame.ignored.length ? { ignored: frame.ignored } : {}) };
  }

  get(id: string): GetResult {
    this.reap(Date.now());
    const frame = this.frames.get(id);
    if (!frame) return { ok: true, exists: false, reason: 'no-frame (nothing has been posted for this id, or it expired)' };
    return { ok: true, exists: true, png: frame.png };
  }

  state(id: string, at: number = Date.now()): StateView {
    this.reap(at);
    const frame = this.frames.get(id);
    if (!frame) {
      return {
        ok: true,
        id,
        exists: false,
        reason: 'no-frame',
        ...(this.refused.length ? { lastRefused: this.refused[this.refused.length - 1]?.reason } : {}),
      } as StateView & { lastRefused?: string };
    }
    return {
      ok: true,
      id,
      exists: true,
        sequence: frame.sequence,
        updatedAt: frame.updatedAt,
        ageMs: Math.max(0, at - frame.updatedAt),
        bytes: frame.bytes,
        signature: frame.signature,
        width: frame.width,
      height: frame.height,
      rows: frame.rows,
      anchor: frame.anchor,
      source: frame.source,
      meta: frame.meta,
    };
  }

  list(at: number = Date.now()): { id: string; sequence: number; ageMs: number; bytes: number; width: number; height: number; rows: number; source: string }[] {
    this.reap(at);
    return [...this.frames.values()].map((frame) => ({
      id: frame.id,
      sequence: frame.sequence,
      ageMs: Math.max(0, at - frame.updatedAt),
      bytes: frame.bytes,
      width: frame.width,
      height: frame.height,
      rows: frame.rows,
      source: frame.source,
    }));
  }

  stats() {
    return {
      entries: this.frames.size,
      expiredFrames: this.expired,
      refusedPosts: this.refused.length,
      lastRefused: this.refused[this.refused.length - 1] ?? null,
      limits: this.limits,
    };
  }
}

/** The single host-process cache, same singleton shape as `inputStore`. */
export const hudCache = new HudCache();
