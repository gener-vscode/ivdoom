import type { Rgb } from './types.js';

/*
 * ─── 64 -> 32 FRAME DOWNSCALE (added 2026-10-10) ────────────────────────────────
 * Why this file exists: the panel is 64x64 LEDs, but a `PicWidth: 32` request is
 * physically only a quarter of the pixel data, and that is what makes it fast:
 *
 *   PicWidth 64  -> 12 KB base64 -> 141.8 ms/frame measured -> 7.05 fps, input lag 142 ms
 *   PicWidth 32  ->  3 KB base64 ->  61.3 ms/frame measured -> 16.3 fps, input lag  61 ms
 *   (scripts/../.gener/t0-findings.md §8, §11, §12 - `--trace` proved frame period == POST RTT)
 *
 * The device upscales a 32 frame to fill the panel (user verified on hardware: identical
 * framing, "smooth左" - and §14 proved the old `--scale 2` 64 frame was *byte-for-byte*
 * a 2x nearest-neighbour upscale of the 32 world, i.e. it carried ZERO extra information).
 *
 * So what does drawing at 64 and shrinking to 32 buy us? NOT resolution - the LEDs are the
 * same 64x64 either way. It buys ANTI-ALIASING: at 64 we can draw a ball as a disc and a
 * paddle with rounded ends and a brick with internal shading; the downscale then turns
 * "this LED is 62% covered" into a dimmer LED instead of a hard on/off stair. That is a
 * real, visible improvement on an LED panel - and it is the only thing this trade can give.
 *
 * Filter choice:
 *   'box'     - area average of each k x k block. Physically correct (it is the integral of
 *               the authored image over one output LED's area), so authored sub-pixel detail
 *               survives as intermediate brightness. DEFAULT.
 *   'nearest' - sample one pixel per block. Throws away 3/4 of the authored pixels and re-adds
 *               no AA; for any 2x-aligned rectangle the result is IDENTICAL to never having
 *               drawn at 64 at all. Kept only so `--filter nearest` can prove the point.
 */

export type DownscaleFilter = 'box' | 'nearest';

/**
 * Shrink a row-major flat RGB buffer by an integer factor.
 * @param src     src.length MUST equal srcSize * srcSize
 * @param srcSize authored resolution, e.g. 64
 * @param dstSize push resolution, e.g. 32
 */
export const downscaleFrame = (src: Rgb[], srcSize: number, dstSize: number, filter: DownscaleFilter = 'box'): Rgb[] => {
  if (dstSize === srcSize) return src;
  if (srcSize % dstSize !== 0) throw new Error(`downscaleFactor must be an integer (${srcSize} / ${dstSize})`);
  if (src.length !== srcSize * srcSize) throw new Error(`frame buffer length ${src.length} != ${srcSize * srcSize}`);

  const k = srcSize / dstSize;
  const out: Rgb[] = new Array(dstSize * dstSize);

  if (filter === 'nearest') {
    for (let oy = 0; oy < dstSize; oy++) {
      const srcRow = oy * k * srcSize;
      const outRow = oy * dstSize;
      for (let ox = 0; ox < dstSize; ox++) out[outRow + ox] = src[srcRow + ox * k];
    }
    return out;
  }

  const div = k * k;
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let oy = 0; oy < dstSize; oy++) {
    const outRow = oy * dstSize;
    for (let ox = 0; ox < dstSize; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < k; dy++) {
        let idx = (oy * k + dy) * srcSize + ox * k;
        for (let dx = 0; dx < k; dx++) {
          const px = src[idx++];
          r += px[0];
          g += px[1];
          b += px[2];
        }
      }
      // rounding, not truncation: a 50%-covered LED lands on half brightness, not a shade below it
      out[outRow + ox] = [clamp(Math.round(r / div)), clamp(Math.round(g / div)), clamp(Math.round(b / div))];
    }
  }
  return out;
};

export type CropRect = { x: number; y: number; width: number; height: number };

export type ResampleRequest = {
  /** row-major RGB matrix of the source image (e.g. DOOM's 320x200 framebuffer) */
  src: Rgb[];
  srcWidth: number;
  srcHeight: number;
  /** region of the source that is actually wanted (DOOM play view == everything above the status bar) */
  crop: CropRect;
  dstWidth: number;
  dstHeight: number;
  filter?: DownscaleFilter;
};

/**
 * Crop an arbitrary rectangle and resample it to an arbitrary W x H.
 *
 * `downscaleFrame` above only handles "square, integer factor", which is what Breakout needed.
 * DOOM needs the general case, and the numbers say why that matters:
 *   source            320x200, bottom 32 rows are the status bar -> play view is 320x168
 *   square crop       168x168 centred -> 64x64 fills the whole panel (factor 2.625, NOT an integer)
 *   wide crop         320x168        -> 64x34 embedded in the 64x64 buffer (factor 5 / 4.94)
 * A fractional factor cannot be done with a k x k loop, so 'box' here integrates the SOURCE
 * PIXEL AREAS that overlap each output pixel's footprint (area weights), then divides by the
 * total weight. For an integer factor and crop == full source this is exactly equal to
 * `downscaleFrame(.., 'box')`, which `scripts/scale-equivalence.cjs` checks.
 */
export const cropAndDownscale = ({
  src,
  srcWidth,
  srcHeight,
  crop,
  dstWidth,
  dstHeight,
  filter = 'box',
}: ResampleRequest): Rgb[] => {
  if (src.length !== srcWidth * srcHeight) throw new Error(`frame length ${src.length} != ${srcWidth}x${srcHeight}`);
  if (crop.x < 0 || crop.y < 0 || crop.x + crop.width > srcWidth || crop.y + crop.height > srcHeight)
    throw new Error(`crop ${crop.width}x${crop.height}@${crop.x},${crop.y} outside ${srcWidth}x${srcHeight}`);

  const out: Rgb[] = new Array(dstWidth * dstHeight);
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

  if (filter === 'nearest') {
    for (let oy = 0; oy < dstHeight; oy++) {
      const sy = crop.y + Math.min(srcHeight - crop.y - 1, Math.floor(((oy + 0.5) * crop.height) / dstHeight));
      const row = sy * srcWidth;
      for (let ox = 0; ox < dstWidth; ox++) {
        const sx = crop.x + Math.min(srcWidth - crop.x - 1, Math.floor(((ox + 0.5) * crop.width) / dstWidth));
        out[oy * dstWidth + ox] = src[row + sx];
      }
    }
    return out;
  }

  for (let oy = 0; oy < dstHeight; oy++) {
    // footprint of one output pixel, in source coordinates
    const y0 = crop.y + (oy * crop.height) / dstHeight;
    const y1 = crop.y + ((oy + 1) * crop.height) / dstHeight;
    const syStart = Math.max(crop.y, Math.floor(y0));
    const syEnd = Math.min(crop.y + crop.height, Math.ceil(y1));
    for (let ox = 0; ox < dstWidth; ox++) {
      const x0 = crop.x + (ox * crop.width) / dstWidth;
      const x1 = crop.x + ((ox + 1) * crop.width) / dstWidth;
      const sxStart = Math.max(crop.x, Math.floor(x0));
      const sxEnd = Math.min(crop.x + crop.width, Math.ceil(x1));

      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;
      for (let sy = syStart; sy < syEnd; sy++) {
        // overlap height of source row sy under this output pixel
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        const row = sy * srcWidth;
        for (let sx = sxStart; sx < sxEnd; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const w = wx * wy;
          const px = src[row + sx];
          r += px[0] * w;
          g += px[1] * w;
          b += px[2] * w;
          weight += w;
        }
      }
      if (weight <= 0) {
        // degenerate footprint (dst larger than the crop): fall back to the centre sample
        const sy = Math.min(srcHeight - 1, Math.floor(y0));
        const sx = Math.min(srcWidth - 1, Math.floor(x0));
        out[oy * dstWidth + ox] = src[sy * srcWidth + sx];
        continue;
      }
      out[oy * dstWidth + ox] = [clamp(Math.round(r / weight)), clamp(Math.round(g / weight)), clamp(Math.round(b / weight))];
    }
  }
  return out;
};

/** DOOM's real geometry. 320x200 framebuffer, status bar = bottom 32 rows, play view = the rest. */
export const DOOM_SRC_WIDTH = 320;
export const DOOM_SRC_HEIGHT = 200;
export const DOOM_STATUS_BAR_HEIGHT = 32;
export const DOOM_VIEW_HEIGHT = DOOM_SRC_HEIGHT - DOOM_STATUS_BAR_HEIGHT; // 168

export type DoomCropMode = 'square' | 'wide';

/**
 * Which part of the DOOM frame goes to the panel (the "red square" in the photo is the play view).
 *  'square' 168x168 centred: fills all 64x64 LEDs, cuts ~1/2 of the horizontal view, no distortion.
 *  'wide'   320x168: keeps the whole horizontal view, becomes 64x34 with black bars top/bottom.
 */
export const doomCrop = (mode: DoomCropMode, dstWidth: number, dstHeight: number): CropRect => {
  if (mode === 'wide') return { x: 0, y: 0, width: DOOM_SRC_WIDTH, height: DOOM_VIEW_HEIGHT };
  const side = DOOM_VIEW_HEIGHT; // square == as tall as the play view allows
  return { x: Math.floor((DOOM_SRC_WIDTH - side) / 2), y: 0, width: side, height: side };
};

/** Every distinct colour in a frame. A purely blocky image has very few; box averaging creates more. */
export const distinctColors = (frame: Rgb[]): number => new Set(frame.map((c) => c.join(','))).size;

export type FilterComparison = {
    distinctBox: number;
    distinctNearest: number;
    /** Pixels the two filters disagree about == the sub-pixel detail `nearest` throws away. */
    differing: number;
    total: number;
};

/**
 * The honest answer to "does authoring at 64 buy anything?": run BOTH filters on the SAME authored
 * frame and count where they disagree. `nearest` is, by construction, exactly what the old 32-world
 * code produced (§14 proved it byte-for-byte), so every differing pixel is detail that only a true
 * 64 buffer can create. `differing === 0` means the 64 pass gave us literally nothing.
 */
export const compareFilters = (src: Rgb[], srcSize: number, dstSize: number): FilterComparison => {
    const box = downscaleFrame(src, srcSize, dstSize, 'box');
    const nearest = downscaleFrame(src, srcSize, dstSize, 'nearest');
    let differing = 0;
    for (let i = 0; i < box.length; i++) {
        if (box[i][0] !== nearest[i][0] || box[i][1] !== nearest[i][1] || box[i][2] !== nearest[i][2]) differing++;
    }
    return { distinctBox: distinctColors(box), distinctNearest: distinctColors(nearest), differing, total: box.length };
};
