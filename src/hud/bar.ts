/**
 * The status-strip renderer: BLOCKS → ROWS → PNG.
 *
 * ASPECT-INDEPENDENT ON PURPOSE. Nothing in this file knows what a Breakout score is or what a DOOM
 * bottom bar looks like: it packs opaque bitmap BLOCKS (text, or any image someone hands it - e.g. DOOM's
 * signature face) into as many ROWS as needed to fit a target width. That is what the user asked for on
 * 2026-10-11 23:20: "the controller side also use similar background image to display the missing bottom
 * bar with signature face, but should split the long thin bar to 2 row". A general reflow transformer, not
 * a hardcoded two-row header - the same call with a wider target produces one row, a taller block produces
 * a taller row, and neither path loses content.
 *
 * The output is ALPHA PNG (transparent background). A strip that is going to be painted over a phone page
 * must not bring its own opaque rectangle: the scrim belongs to CSS, the glyphs belong to the image.
 */
import { PNG } from 'pngjs';
import type { FontType } from '../pixoo/fonts.js';

export type Rgb = [number, number, number];

/** An opaque piece of content: fixed pixel size, RGBA row-major, alpha 0 where nothing is drawn. */
export type StripBlock = { width: number; height: number; data: Uint8ClampedArray; tag: string };

export type PlacedBlock = { block: StripBlock; x: number; y: number };
export type StripRow = { items: PlacedBlock[]; width: number; height: number };
export type StripLayout = {
  rows: StripRow[];
  /** widest row content, in px - the image is padded to the requested width, never cropped */
  contentWidth: number;
  height: number;
  /** < 1 only when packing into `maxRows` required shrinking; see `scaleBlock` */
  scale: number;
  tags: string[];
  /** always 0: a reflow may shrink, it may never drop a block */
  dropped: number;
  gutter: number;
  rowGap: number;
};
export type StripImage = { width: number; height: number; data: Uint8ClampedArray };
export type StripFrame = {
  image: StripImage;
  layout: StripLayout;
  png: Buffer;
  bytes: number;
  width: number;
  height: number;
  rows: number;
  targetWidth: number;
};

export const DEFAULT_GUTTER = 8;
export const DEFAULT_ROW_GAP = 4;
const MIN_SCALE = 0.3;

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const clampInt = (v: number, min: number, max: number, fallback: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

export const blankBlock = (width: number, height: number, tag = 'blank'): StripBlock => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
  tag,
});

const putPixel = (data: Uint8ClampedArray, width: number, height: number, x: number, y: number, color: Rgb, alpha: number) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const at = (x + y * width) * 4;
  data[at] = clamp255(color[0]);
  data[at + 1] = clamp255(color[1]);
  data[at + 2] = clamp255(color[2]);
  data[at + 3] = clamp255(alpha);
};

/** A hairline separator block: content that separates cells without ever being a gap in the layout. */
export const dividerBlock = (height: number, color: Rgb, thickness = 1, tag = 'divider'): StripBlock => {
  const block = blankBlock(thickness, height, tag);
  for (let y = 0; y < height; y++) for (let x = 0; x < thickness; x++) putPixel(block.data, block.width, block.height, x, y, color, 255);
  return block;
};

/**
 * Advance of a string, EXACTLY as `PixooAPI#getTextWidth` computes it (space = 3 px, every glyph is
 * followed by 1 px). Reusing the app's own rule is the point: the strip and the panel must measure text
 * identically, or "the same header" would line up differently on the two surfaces.
 */
export const textWidth = (text: string, font: FontType): number =>
  [...text].reduce((acc, char) => {
    if (char === ' ') return acc + 3;
    const glyph = font.bitmap[char] ? char : '?';
    return acc + Math.floor((font.bitmap[glyph]?.length ?? 0) / font.height) + 1;
  }, 0);

/** Characters the font cannot draw, for a self-check rather than a silent '?' substitution. */
export const missingGlyphs = (text: string, font: FontType): string[] =>
  [...text].filter((char) => char !== ' ' && !font.bitmap[char]);

export const textBlock = (text: string, opts: { font: FontType; color: Rgb; tag?: string }): StripBlock => {
  const { font, color } = opts;
  const height = font.height;
  const width = Math.max(1, textWidth(text, font));
  const block = blankBlock(width, height, opts.tag ?? text);
  let x = 0;
  for (const raw of [...text]) {
    if (raw === ' ') { x += 3; continue; }
    const char = font.bitmap[raw] ? raw : '?';
    const matrix = font.bitmap[char] ?? [];
    const glyphWidth = Math.max(1, Math.floor(matrix.length / height));
    matrix.forEach((bit, index) => {
      if (!bit) return;
      putPixel(block.data, width, height, x + (index % glyphWidth), Math.floor(index / glyphWidth), color, 255);
    });
    x += glyphWidth + 1;
  }
  return block;
};

/**
 * LABEL + VALUE as ONE block. A cell must be atomic: a reflow may move a cell to the next row, it may
 * never separate `SCORE` from its number. The label is dimmed so the number is what the eye lands on.
 */
export const cellBlock = (
  label: string,
  value: string,
  opts: { font: FontType; valueColor: Rgb; labelColor?: Rgb; gap?: number },
): StripBlock => {
  const gap = label ? clampInt(opts.gap ?? 2, 0, 12, 2) : 0;
  const valueBlock = textBlock(value, { font: opts.font, color: opts.valueColor, tag: `${label}:${value}` });
  const labelBlock = label
    ? textBlock(label, { font: opts.font, color: opts.labelColor ?? shade(opts.valueColor, 0.5), tag: label })
    : null;
  const width = (labelBlock ? labelBlock.width + gap : 0) + valueBlock.width;
  const height = Math.max(valueBlock.height, labelBlock?.height ?? 0);
  const block = blankBlock(width, height, `${label}=${value}`);
  if (labelBlock) blit(block, labelBlock, 0, height - labelBlock.height);
  blit(block, valueBlock, labelBlock ? labelBlock.width + gap : 0, height - valueBlock.height);
  return block;
};

export const shade = (color: Rgb, factor: number): Rgb => [clamp255(color[0] * factor), clamp255(color[1] * factor), clamp255(color[2] * factor)];

/** Over-composite, alpha respected (alpha 0 leaves the destination alone). */
export const blit = (target: StripBlock | StripImage, block: StripBlock, x: number, y: number): void => {
  for (let sy = 0; sy < block.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= target.height) continue;
    for (let sx = 0; sx < block.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= target.width) continue;
      const src = (sx + sy * block.width) * 4;
      const alpha = block.data[src + 3];
      if (!alpha) continue;
      const dst = (dx + dy * target.width) * 4;
      const a = alpha / 255;
      target.data[dst] = clamp255(target.data[dst] * (1 - a) + block.data[src] * a);
      target.data[dst + 1] = clamp255(target.data[dst + 1] * (1 - a) + block.data[src + 1] * a);
      target.data[dst + 2] = clamp255(target.data[dst + 2] * (1 - a) + block.data[src + 2] * a);
      target.data[dst + 3] = clamp255(Math.max(target.data[dst + 3], alpha));
    }
  }
};

/**
 * Shrink by keeping, not by sampling: for every output pixel take the most opaque pixel of the source
 * region it covers. A box-average would erase a 1 px glyph stroke at 0.5x; this cannot lose a stroke,
 * which matters because the ONLY reason this function runs is "the content does not fit the width".
 */
export const scaleBlock = (block: StripBlock, factor: number): StripBlock => {
  const f = Number(factor);
  if (!Number.isFinite(f) || f >= 1) return block;
  const width = Math.max(1, Math.floor(block.width * f));
  const height = Math.max(1, Math.floor(block.height * f));
  const out = blankBlock(width, height, `${block.tag}@${Math.round(f * 100)}%`);
  for (let y = 0; y < height; y++) {
    const srcTop = Math.floor((y * block.height) / height);
    const srcBottom = Math.max(srcTop + 1, Math.floor(((y + 1) * block.height) / height));
    for (let x = 0; x < width; x++) {
      const srcLeft = Math.floor((x * block.width) / width);
      const srcRight = Math.max(srcLeft + 1, Math.floor(((x + 1) * block.width) / width));
      let best = -1;
      let bestAlpha = -1;
      for (let sy = srcTop; sy < srcBottom; sy++) {
        for (let sx = srcLeft; sx < srcRight; sx++) {
          const alpha = block.data[(sx + sy * block.width) * 4 + 3];
          if (alpha > bestAlpha) { bestAlpha = alpha; best = (sx + sy * block.width) * 4; }
        }
      }
      if (best < 0 || bestAlpha <= 0) continue;
      const dst = (x + y * width) * 4;
      out.data[dst] = block.data[best];
      out.data[dst + 1] = block.data[best + 1];
      out.data[dst + 2] = block.data[best + 2];
      out.data[dst + 3] = block.data[best + 3];
    }
  }
  return out;
};

/** Every width the packer will try, best first: only if 1.0 overflows `maxRows` do we shrink. */
const scaleLadder = (): number[] => {
  const ladder = [1];
  for (let s = 90; s >= MIN_SCALE * 100; s -= 10) ladder.push(s / 100);
  return ladder;
};

const packRows = (blocks: StripBlock[], targetWidth: number, gutter: number): { block: StripBlock; x: number }[][] => {
  const rows: { block: StripBlock; x: number }[][] = [];
  let current: { items: { block: StripBlock; x: number }[]; x: number } = { items: [], x: 0 };
  for (const block of blocks) {
    // A row is only closed when it already HAS content: a block wider than the target still gets a row
    // (and the scale ladder gets it smaller), it is never skipped.
    if (current.items.length && current.x + gutter + block.width > targetWidth) {
      rows.push(current.items);
      current = { items: [], x: 0 };
    }
    current.items.push({ block, x: current.x });
    current.x += block.width + gutter;
  }
  if (current.items.length) rows.push(current.items);
  return rows;
};

/**
 * The reflow. `targetWidth` is the width the consumer can show (a landscape phone); `maxRows` is how many
 * rows it is allowed to occupy. Greedy left-to-right packing at 1.0 first; only when that needs more rows
 * than allowed does it walk down the scale ladder. Content is never dropped, and the result says which
 * scale it used, so a caller can tell "fits" from "shrunk to fit".
 */
export const layoutBlocks = (
  blocks: StripBlock[],
  targetWidth: number,
  opts: { maxRows?: number; gutter?: number; rowGap?: number } = {},
): StripLayout => {
  const width = clampInt(targetWidth, 16, 1024, 320);
  const maxRows = clampInt(opts.maxRows ?? 2, 1, 4, 2);
  const gutter = clampInt(opts.gutter ?? DEFAULT_GUTTER, 0, 32, DEFAULT_GUTTER);
  const rowGap = clampInt(opts.rowGap ?? DEFAULT_ROW_GAP, 0, 24, DEFAULT_ROW_GAP);
  const list = (Array.isArray(blocks) ? blocks : []).filter((block) => block && block.width > 0 && block.height > 0);

  let chosen = { rows: [] as { block: StripBlock; x: number }[][], scale: 1 };
  for (const scale of scaleLadder()) {
    const scaled = scale === 1 ? list : list.map((block) => scaleBlock(block, scale));
    const rows = packRows(scaled, width, gutter);
    chosen = { rows, scale };
    if (rows.length <= maxRows) break;
  }

  const rows: StripRow[] = chosen.rows.map((items) => {
    const height = items.reduce((max, item) => Math.max(max, item.block.height), 0);
    // bottom-aligned: glyphs from different blocks in one row share a baseline
    return {
      height,
      width: items.reduce((max, item) => Math.max(max, item.x + item.block.width), 0),
      items: items.map((item) => ({ block: item.block, x: item.x, y: height - item.block.height })),
    };
  });

  return {
    rows,
    contentWidth: rows.reduce((max, row) => Math.max(max, row.width), 0),
    height: rows.reduce((sum, row) => sum + row.height, 0) + rowGap * Math.max(0, rows.length - 1),
    scale: chosen.scale,
    tags: list.map((block) => block.tag),
    dropped: 0,
    gutter,
    rowGap,
  };
};

/**
 * Paint the layout into an image of EXACTLY `targetWidth` (alpha elsewhere). A fixed width is deliberate:
 * the page sets `--hud-w` once and only the height changes with the row count, so a re-flow never makes
 * the band jump sideways.
 */
export const composeStrip = (layout: StripLayout, targetWidth: number): StripImage => {
    const width = clampInt(targetWidth, 16, 1024, 320);
    const height = Math.max(1, layout.height);
    const image: StripImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  let top = 0;
  for (const row of layout.rows) {
    for (const item of row.items) blit(image, item.block, item.x, top + item.y);
    top += row.height + layout.rowGap;
  }
  return image;
};

export const encodePng = (image: StripImage): Buffer => {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png, { colorType: 6, inputHasAlpha: true });
};

export const decodePng = (bytes: Uint8Array | Buffer): StripImage => {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
};

export const isPngBytes = (bytes: Uint8Array): boolean =>
  bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;

/** Pixels that actually carry ink, for a test that must prove CONTENT rather than a byte count. */
export const litPixels = (image: StripImage): number => {
  let lit = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 0) lit++;
  return lit;
};

/** Blocks → rows → padded image → PNG bytes, in the order the user described. */
export const renderStrip = (
  blocks: StripBlock[],
  opts: { targetWidth?: number; maxRows?: number; gutter?: number; rowGap?: number },
): StripFrame => {
  const targetWidth = clampInt(opts.targetWidth ?? 320, 16, 1024, 320);
  const layout = layoutBlocks(blocks, targetWidth, opts);
  const image = composeStrip(layout, targetWidth);
  const png = encodePng(image);
  return { image, layout, png, bytes: png.length, width: image.width, height: image.height, rows: layout.rows.length, targetWidth };
};

/** The layout read as text - a test can then prove no cell was lost, which pixels cannot say. */
export const layoutTags = (layout: StripLayout): string[] => layout.rows.flatMap((row) => row.items.map((item) => item.block.tag));
