/**
 * The wire contract of the STATUS STRIP image (the score/lives bar the phone shows).
 *
 * ZERO imports, same rule as `src/input/protocol.ts`: this file is the single definition of the shape, it
 * is imported by the game (the producer) AND by the Function App (the holder of the cache), and it is a
 * candidate to travel with the engine when the two repos split. Anything that lives here is a protocol
 * decision, not an implementation detail.
 *
 * WHY AN IMAGE AND NOT JSON (the user's design, 2026-10-11 23:20): the game main process renders the
 * header into an image buffer at 1 FPS, the controller page polls it once a second and paints it as a
 * background. The panel itself has no header (`HUD_HEIGHT = 0` in src/game/breakout.ts), so this is the
 * only place a player can read score/lives. Rendering it as an IMAGE keeps the two sides visually identical
 * (same fonts, same palette as the panel) instead of asking the browser to redraw the game's typography.
 *
 * ⚠️ WHO HOLDS THE CACHE is a structural choice, not decoration: `play-breakout` and the Function App are
 * two processes. Here the PRODUCER keeps its own last frame in memory (`HudUploader#latest`) and the
 * ENDPOINT side holds the copy a browser can GET (`src/hud/cache.ts`). That is what lets DOOM post its
 * bottom bar through the same door later without either side owning the other's clock.
 */

export const HUD_PROTOCOL = 1;

export const DEFAULT_ID = 'main';
/** Same character set as an input session id, so `--input-session foo` + `?session=foo` also match here. */
export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** A strip is read by a phone once a second; a big one is a bug, not a feature. */
export const MAX_IMAGE_BYTES = 250_000;
/** base64 grows by 4/3; the limit is the decoded limit plus slack, so an oversized POST is refused early. */
export const MAX_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 512;
export const MAX_WIDTH = 1024;
export const MAX_HEIGHT = 256;
export const MAX_ROWS = 4;
export const MAX_META_KEYS = 24;
export const MAX_META_VALUE = 64;

/** The producer must never offer more than 1 image per second (the user's spec: 1 FPS). */
export const MIN_INTERVAL_MS = 250;
export const MAX_INTERVAL_MS = 60_000;

/** `top` = the header the panel no longer has (Breakout). `bottom` = a bar that does not fit the panel (DOOM). */
export const ANCHORS = ['top', 'bottom'] as const;
export type Anchor = (typeof ANCHORS)[number];

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export type MetaValue = string | number;

export type StripPost = {
  protocol: number;
  id: string;
  /** PNG bytes, base64. Base64 because the Function App body is JSON on both the dev host and Azure. */
  png: string;
  width: number;
  height: number;
  rows: number;
  anchor: Anchor;
  /** who produced it (`breakout`, `doom-device`, …) - purely for diagnosis */
  source: string;
  meta: { [key: string]: MetaValue };
  sentAt: number;
};

export type StripValidation = { ok: boolean; reason?: string; post?: StripPost };

const PNG_MAGIC = String.fromCharCode(...PNG_SIGNATURE);

const cleanId = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw && ID_PATTERN.test(raw) ? raw : '';
};

const cleanMetaValue = (value: unknown): MetaValue | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    // one line, no control characters, bounded: this is echoed straight into a phone page
    const flat = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return flat ? flat.slice(0, MAX_META_VALUE) : null;
  }
  return null;
};

/**
 * Only the ENVELOPE can make this whole POST unusable (id / png / dimensions). A bad meta key is dropped
 * and reported in `ignored`, never a reason to throw away a frame - the lesson from `validatePost` in
 * src/input/protocol.ts, where one malformed event refused a batch and poisons every later one.
 */
export const validateStripPost = (body: unknown): StripValidation & { ignored?: string[] } => {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body-not-object' };
  const raw = body as Record<string, unknown>;

  const id = cleanId(raw.id ?? raw.session);
  if (!id) return { ok: false, reason: `bad-or-missing-id (want ID_PATTERN, got ${JSON.stringify(String(raw.id ?? ''))})` };

  const png = typeof raw.png === 'string' ? raw.png : '';
  if (!png) return { ok: false, reason: 'png-required (base64 PNG bytes)', };
  if (png.length > MAX_BASE64_CHARS) return { ok: false, reason: `png-too-large (${png.length} base64 chars > ${MAX_BASE64_CHARS})` };
  // A PNG is identified by its bytes, not by the sender's claim. This is the "200 proves nothing" rule.
  if (!png.startsWith('iVBORw0KGgo')) {
    const head = Buffer.from(png.slice(0, 12), 'base64').toString('latin1');
    if (head.slice(0, 8) !== PNG_MAGIC) return { ok: false, reason: 'png-signature-missing (body is not a PNG)' };
  }

  const width = Number(raw.width);
  const height = Number(raw.height);
  const rows = Number(raw.rows);
  if (!Number.isFinite(width) || !Number.isInteger(width) || width < 1 || width > MAX_WIDTH) {
    return { ok: false, reason: `bad-width (want 1..${MAX_WIDTH}, got ${String(raw.width)})` };
  }
  if (!Number.isFinite(height) || !Number.isInteger(height) || height < 1 || height > MAX_HEIGHT) {
    return { ok: false, reason: `bad-height (want 1..${MAX_HEIGHT}, got ${String(raw.height)})` };
  }
  if (!Number.isFinite(rows) || !Number.isInteger(rows) || rows < 1 || rows > MAX_ROWS) {
    return { ok: false, reason: `bad-rows (want 1..${MAX_ROWS}, got ${String(raw.rows)})` };
  }

    const anchor = ANCHORS.includes(raw.anchor as Anchor) ? (raw.anchor as Anchor) : 'top';
    // `cleanMetaValue` may answer a number; `source` is declared a string, so narrow it, do not cast it.
    const rawSource = typeof raw.source === 'string' ? cleanMetaValue(raw.source) : null;
    const source = typeof rawSource === 'string' ? rawSource : '';

  const meta: { [key: string]: MetaValue } = {};
  const ignored: string[] = [];
  const rawMeta = raw.meta && typeof raw.meta === 'object' ? (raw.meta as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(rawMeta)) {
    if (!ID_PATTERN.test(key)) { ignored.push(key); continue; }
    if (Object.keys(meta).length >= MAX_META_KEYS) { ignored.push(`${key}(over-limit)`); continue; }
    const clean = cleanMetaValue(value);
    if (clean === null) ignored.push(`${key}(type)`);
    else meta[key] = clean;
  }

  const sentAt = Number.isFinite(Number(raw.sentAt)) ? Number(raw.sentAt) : Date.now();

  return {
    ok: true,
    post: { protocol: HUD_PROTOCOL, id, png, width, height, rows, anchor, source, meta, sentAt },
    ...(ignored.length ? { ignored } : {}),
  };
};

/** A one-line description for a log: never `undefined`, never the whole payload. */
export const describePost = (post: StripPost): string =>
  `${post.id} ${post.width}x${post.height} rows=${post.rows} anchor=${post.anchor} source=${post.source || '?'} base64=${post.png.length}`;

export const clampInterval = (value: unknown, fallback = 1000): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.round(n)));
};
