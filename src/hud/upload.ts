/**
 * The PRODUCER side of the status strip: the game's own memory copy, plus the 1 FPS POST.
 *
 * `latest` IS the "local image buffer to variable or memory cache" the user asked for (2026-10-11 23:20).
 * It lives in the game process on purpose, so the game can run with no Function App at all, and so a
 * transport failure can never make the producer forget what it drew. The POST is only the transport.
 *
 * THREE RULES THAT COME FROM MEASURED FAILURES ELSEWHERE IN THIS REPO:
 *  1. `due()` is the gate, and the CALLER (the supply loop) owns the clock - like `applyPanelPacing()`,
 *     only the loop that supplies frames knows its own interval.
 *  2. One request in flight, and a newer frame REPLACES a queued one (counted as `skippedBusy`). A status
 *     image is a LEVEL, not an event: an old score must never be queued behind a new one (same reasoning
 *     as stick LEVEL vs edge in src/input/protocol.ts). Edges are not carried here, they go through
 *     /input, where the ring + cursor guarantee delivery.
 *  3. `submit()` never awaits: the frame pump must not inherit the phone's latency. Failures are counted
 *     and logged on the first one only (the log-noise rule).
 */
import { clampInterval, HUD_PROTOCOL, type Anchor, type MetaValue } from './wire.js';

export type StripPayload = {
  png: Uint8Array | Buffer;
  width: number;
  height: number;
  rows: number;
  anchor: Anchor;
  source: string;
  meta: { [key: string]: MetaValue };
};

export type StoredStrip = StripPayload & { png: Buffer; bytes: number; at: number };

export type UploaderOptions = {
  /** e.g. http://127.0.0.1:7071/api/pixoo - the SAME base the controller page uses */
  apiBase: string;
  id: string;
  intervalMs?: number;
  /** how long to wait for the last POST at shutdown */
  settleMs?: number;
};

export type UploaderStats = {
  renders: number;
  uploads: number;
  errors: number;
  skippedBusy: number;
  sequence: number;
  bytes: number;
  rttMs: number;
  lastError: string;
  lastUploadAt: number;
};

const toBuffer = (png: Uint8Array | Buffer): Buffer =>
  Buffer.isBuffer(png) ? png : Buffer.from(png.buffer, png.byteOffset, png.byteLength);

export class HudUploader {
  readonly apiBase: string;
  readonly id: string;
  readonly intervalMs: number;
  private readonly settleMs: number;

  /** The memory buffer, public by design: `--hud` diagnostics read this, not a log line. */
  latest: StoredStrip | null = null;
  readonly stats: UploaderStats = {
    renders: 0,
    uploads: 0,
    errors: 0,
    skippedBusy: 0,
    sequence: 0,
    bytes: 0,
    rttMs: 0,
    lastError: '',
    lastUploadAt: 0,
  };

  private inFlight: Promise<void> | null = null;
  private nextAt = 0;

  constructor(opts: UploaderOptions) {
    this.apiBase = String(opts.apiBase ?? '').replace(/\/+$/, '');
    this.id = opts.id;
    this.intervalMs = clampInterval(opts.intervalMs ?? 1000, 1000);
    this.settleMs = Math.max(0, Number(opts.settleMs ?? 3000) || 3000);
  }

  endpoint(): string {
    return `${this.apiBase}/hud`;
  }

  /**
   * Is it time for the next strip? False while a POST is still in flight, and false again for a backoff
   * after a failure - a game must not spend its frame budget retrying a HUD image.
   */
  due(now: number = Date.now()): boolean {
    if (this.inFlight) return false;
    return now >= this.nextAt;
  }

  /** Store, then send if nothing is already being sent. Never awaits, never queues. */
  submit(payload: StripPayload): StoredStrip {
    const png = toBuffer(payload.png);
    this.latest = { ...payload, meta: { ...payload.meta }, png, bytes: png.length, at: Date.now() };
    this.stats.renders++;
    if (this.inFlight) {
      this.stats.skippedBusy++;
      return this.latest;
    }
    this.inFlight = this.send();
    return this.latest;
  }

  private async send(): Promise<void> {
    const frame = this.latest;
    // The in-flight marker must clear even on a synchronous throw below, or `due()` stays false forever.
    try {
      if (!frame) return;
      if (!this.apiBase) {
        this.stats.errors++;
        this.stats.lastError = 'no API base configured';
        this.nextAt = Date.now() + Math.max(this.intervalMs, 5000);
        return;
      }
      const started = Date.now();
      const response = await fetch(this.endpoint(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: HUD_PROTOCOL,
          id: this.id,
          png: frame.png.toString('base64'),
          width: frame.width,
          height: frame.height,
          rows: frame.rows,
          anchor: frame.anchor,
          source: frame.source,
          meta: frame.meta,
          sentAt: started,
        }),
      });
      const text = await response.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      if (!response.ok || json?.ok !== true) {
        throw new Error(typeof json?.reason === 'string' ? json.reason : `http ${response.status}: ${text.slice(0, 120)}`);
      }
      const rtt = Date.now() - started;
      this.stats.uploads++;
      this.stats.sequence = Number(json.sequence) || this.stats.sequence + 1;
      this.stats.bytes = Number(json.bytes) || frame.bytes;
      this.stats.rttMs = rtt;
      this.stats.lastError = '';
      this.stats.lastUploadAt = Date.now();
      this.nextAt = Date.now() + this.intervalMs;
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      this.stats.errors++;
      this.stats.lastError = message;
      this.nextAt = Date.now() + Math.max(this.intervalMs, 5000);
      // first failure only, then silent counting: 1 failure/s must not drown the game's own diagnostics
      if (this.stats.errors === 1) console.log(`[hud] REFUSED/failed: ${message}  (endpoint=${this.endpoint() || 'none'} id=${this.id})`);
    } finally {
      this.inFlight = null;
    }
  }

  /** Give the last strip a chance to land before the process exits. */
  async settle(): Promise<void> {
    if (!this.inFlight) return;
    await Promise.race([this.inFlight, new Promise<void>((resolve) => setTimeout(resolve, this.settleMs))]);
    this.inFlight = null;
  }

  /** One line, always defined, for the run summary. */
  report(): string {
    const held = this.latest ? `${this.latest.width}x${this.latest.height} rows=${this.latest.rows} ${this.latest.bytes}B` : 'none';
    return `id=${this.id} renders=${this.stats.renders} uploaded=${this.stats.uploads} seq=${this.stats.sequence} bytes=${this.stats.bytes} lastRtt=${this.stats.rttMs}ms skippedBusy=${this.stats.skippedBusy} errors=${this.stats.errors} held=${held}${this.stats.lastError ? ` lastError=${this.stats.lastError}` : ''}`;
  }
}
