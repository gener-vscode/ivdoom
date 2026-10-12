// Copyright (C) 2022 Adam K Dean <adamkdean@googlemail.com>
// Use of this source code is governed by the GPL-3.0
// license that can be found in the LICENSE file.

// Note: this is based on the documentation at http://doc.divoom-gz.com/web/#/12?page_id=220
// which is not the greatest documentation in the world. I've tried to make the methods
// easy to understand and use, but you may need to experiment to get the right values.
// - AKD, Jan 2023.
import { Colors } from './color.js'
import type { FontType } from '../pixoo/fonts.js';
import { Vari5 } from '../pixoo/fonts.js'
import wlt from '@codepunkt/wasm-layout-text';
import { panelPacingFor, PIC_SPEED_LIMITS, type PanelPacing } from './pacing.js';

export type Font = { [char: string]: number[] }
export type Color = [number, number, number] | keyof typeof Colors;
export type Position = [number, number];
export type PNGWithMetadata = { data: Uint8Array; width: number; height: number };

const { USER_AGENT = 'fd3c4a50-58d3-4368-a9e5-e43be003efae' } = process.env;

/*
 * ─── PICID POLICY (changed 2026-10-10, after measuring on the real panel) ──────
 * The doc rule (see sendHttpGif below) is "PicID … every animation must have unique
 * ID and auto increase … the current gif id is 100, and then next gif's id should be
 * greater than or equal to 101" — and that counter belongs to the DEVICE, not to this
 * process. The old policy was a process-local counter that started at 0 and was only
 * reset every 1000 pushes, which has two measured failure modes:
 *   • After a cold start (Function App restart, `yarn dev`, device reboot) it sends
 *     PicID 1, 2, 3 … into a device that has already seen much larger ids. Measured
 *     2026-10-10 with scripts/request-rate.cjs: PicID 1200 / 1400 with no reset were
 *     answered 12/12 and 4/4 with error_code:0 while the panel stayed frozen on its
 *     own built-in animation. `error_code:0` only proves the request was PARSED.
 *   • The "every 1000" reset is a Draw/ResetHttpGifId *mid-stream*, which makes the
 *     device reload the gif slot: a visible flicker during a running animation.
 * The only shape this panel has verifiably played (scripts/baseline-4corner.cjs, and
 * everything that has ever worked in production) began with Draw/ResetHttpGifId.
 *
 * New policy = both halves of what was asked for ("reset the picID, or use Date.now()"):
 *   1. reset once per sequence (cold start / explicit resetCounter()), and if the
 *      firmware answers Device/GetHttpGifId, continue from the id it reports;
 *   2. every PicID is anchored to the wall clock:
 *        picId = max(lastPicId + 1, floor(Date.now() / 1000))
 *      strictly increasing, and a NEW process can never send an id lower than the one
 *      an earlier process already used. The anchor is epoch SECONDS, not milliseconds:
 *      Date.now() (~1.7e12) would overflow an int32 field, 1.7e9 stays inside int32
 *      until 2038. The `lastPicId + 1` half is what keeps a 6–7 fps game strictly
 *      increasing inside the same second.
 *
 * ⚠️ One thing is still unproven: whether a firmware that has just been reset accepts
 * an id far above 1. `PIXOO_PICID=reset` switches to the legacy sequence (reset, then
 * 1, 2, 3 …) — the exact shape that is known to play. If the panel ever freezes while
 * the API reports error_code:0, that is the first switch to try.
 */
export type PicIdMode = 'epoch' | 'reset';
const PICID_MODE: PicIdMode = String(process.env.PIXOO_PICID || 'epoch').toLowerCase() === 'reset' ? 'reset' : 'epoch';
/** int32-safe wall-clock anchor; see the note above. */
const picIdAnchor = () => Math.floor(Date.now() / 1000);

/*
 * ─── PIC SPEED POLICY (changed 2026-10-11, after measuring on the real panel) ─────
 * PicSpeed is NOT a hint: it is how many ms the DEVICE holds each frame of the
 * animation, i.e. the panel paints at 1000/PicSpeed. Three independent measurements on
 * this panel agree (.gener/t0-findings.md §21, §30, §31):
 *   PicSpeed 1000 -> ~1 fps visible, and at a push rate of 6-15 fps the device builds a
 *                     backlog: the user sees frames out of order / repeating (a frame
 *                     counter that went 1, 6, 10, 17, 30 … then back to 31).
 *   PicSpeed   60 -> the panel plays ~what we send. Measured 2026-10-11 with
 *                     `scripts/doom-device.cjs --picspeed 60 --push 32 --seconds 60`:
 *                     868 pushes in 60 s (14.46 fps) at avg 68 ms per push - the SAME
 *                     throughput as PicSpeed 1000 (919 pushes, 15.31 fps), so lowering
 *                     PicSpeed costs nothing on the wire.
 *   grouped (PicNum > 1) -> the stream never plays at all, regardless of pacing; do not
 *                     use grouped animation for anything live.
 *
 * So the rule is: PicSpeed must sit just BELOW the real push interval of the path that is
 * sending - ~60 ms for PicWidth 32, ≤150 ms for PicWidth 64 (those are the measured
 * intervals; a lower value is not "better", it just leaves the panel with nothing to show).
 *
 * PIXOO_PIC_SPEED defaults to 1000 on purpose: the clock/weather/bus pages push once every
 * few seconds and WANT the frame to hold. Only a continuous stream should lower it, via this
 * env var or PixooAPI#setPicSpeed() on that one instance.
 */
// PIC_SPEED_LIMITS comes from ./pacing.ts so the clamp, the pairing rule and the measured panel
// pacing table cannot drift apart. See PIC SPEED POLICY above and PANEL PACING TABLE there.
const picSpeedFromEnv = (): number => {
  const raw = process.env.PIXOO_PIC_SPEED;
  if (raw === undefined || raw.trim() === '') return PIC_SPEED_LIMITS.max;
  const n = Number(raw);
  if (!Number.isFinite(n)) return PIC_SPEED_LIMITS.max;
  return Math.min(PIC_SPEED_LIMITS.max, Math.max(PIC_SPEED_LIMITS.min, Math.round(n)));
};
const PIC_SPEED_DEFAULT = picSpeedFromEnv();

/** Every device reply, or only refused ones? Default: only refused. See `post()` below. */
const DEVICE_LOG = ['1', 'true', 'yes'].includes(String(process.env.PIXOO_LOG_DEVICE ?? '').toLowerCase()) ||
  ['1', 'true', 'yes'].includes(String(process.env.DEBUG_MODE ?? '').toLowerCase());

export type DeviceReply = { ok: boolean; status: number; text: string; json: any };
export type PicSequence = {
  /** PicID the next Draw/SendHttpGif will use. */
  firstPicId: number;
  /** Whether Draw/ResetHttpGifId was accepted. */
  resetAccepted: boolean;
  /** Whether Device/GetHttpGifId actually reported an id (this firmware does not). */
  fromDevice: boolean;
  mode: PicIdMode;
};

/** Same field list scripts/pixoo-protocol.cjs uses (its own copy; scripts/ is not importable here). */
const readPicId = (value: any): number | null => {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['PicID', 'PicId', 'GifId', 'Id', 'id']) {
    const v = value[key];
    if (Number.isFinite(+v) && +v >= 0) return +v;
  }
  return null;
};

export const parseColor = (color: Color): [number, number, number] => {
    if (typeof color === 'string') return hexToRgb(color)
    if (Array.isArray(color) && color.length === 3) return color
    throw new Error(`Invalid color: ${color}`)
  }



  export const hexToRgb = (hex: string): [number, number, number] => {
    if (hex[0] === '#') hex = hex.slice(1)
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return [r, g, b]
  }

    export const toRgb = (color: Color, alpha: number, background: Color = Colors.Black): [number, number, number] => {


    const [cRed, cGreen, cBlue] = parseColor(color);
    const [bRed, bGreen, bBlue] = parseColor(background);

    const red = (1 - alpha) * bRed + alpha * cRed;
    const green = (1 - alpha) * bGreen + alpha * cGreen;
    const blue = (1 - alpha) * bBlue + alpha * cBlue;

    return [Math.floor(red), Math.floor(green), Math.floor(blue)];
  }


const fonts = await (async () => {
    const result: {[key: number]: Uint8Array} = {};
    /*
    for(const size of [8,10,12]){
      const buffer = await readFile(`./resources/fonts/fusion-pixel-${size}px-monospaced-zh_hant.zip`);
        const zipped = await jszip.loadAsync(buffer);
        const [file] = Object.values(zipped.files)
        const fontBuffer = await file.async('uint8array');
        result[size] = fontBuffer;
    }
    */
    return result;
})()

export const textToBmp = (text:string, color: Color = '#fff', size:7 | 9 | 11 = 7) => {
    const fontSize = size + 1;
    const height = fontSize;
    const width = fontSize * text.length;
    const font = fonts[fontSize];

    const bmp = [...wlt.render(
        // text, size, color, ttf font buffer
        new wlt.Text(text, fontSize, new wlt.RgbColor(...parseColor(color)), font),
        // image dimension
        new wlt.Dimension(width, height),
        // text bounds
        new wlt.Dimension(width, height),
        // text position
        new wlt.Position(0, -1),
        // text alignment
        new wlt.Alignment(wlt.HorizontalAlign.Left, wlt.VerticalAlign.Top)
    )];
    
    return bmp
}


export class PixooAPI {

  size: number;
  pixelCount: number;
  buffer: [number, number, number][];
  url: string;
  pushCount: number;
  pushAvgElapsed: number;
  /** Last PicID handed to Draw/SendHttpGif - see the PICID POLICY note at the top of this file. */
  lastPicId: number;
  private picIdPrepared: boolean;
  constructor(address: string, size = 64) {
    if (address) {
      this.url = address
    }

    this.size = size

    this.pixelCount = size * size
    this.buffer = new Array(this.pixelCount).fill([0, 0, 0])
    this.pushCount = 0
    this.pushAvgElapsed = 0
    this.lastPicId = 0;
    this.picIdPrepared = false;
  }

  async initialize() {
    await this.resetCounter()
    await this.push()
  }

  //
  // Internal methods
  //
  async post({ Command, ...rest }: { [prop: string]: string | number | boolean }): Promise<DeviceReply> {

    if (!this.url) {
      return { ok: false, status: 0, text: 'no PIXOO_ORIGIN configured', json: undefined };
    }

    // console.log(`Sending: ${Command}...`)
    // Object.entries(rest).forEach(([prop, value]) => {
    //   if(typeof value === 'string' && value.length > 128){
    //     console.log(`\t${prop}: [${value.length}]`);
    //   }else{
    //     console.log(`\t${prop}: ${value}`);
    //   }
    // })
 
    try {
      const response = await fetch(`${this.url}/post`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT
        },
        body: JSON.stringify({ Command, ...rest })
      });
      const resText = await response.text();
      /* QUIET BY DEFAULT. `{"error_code":0}` is a per-COMMAND ack, not an event: at 8 fps it buried the
         input diagnostics under ~10 identical lines per second (the user's words: "this log message is too
         noisy"), and it carries no information - AGENTS.md §36 point 4 already measured that a PlayTFGif
         answers in 78 ms before it even fetches. A REPLY is printed only when it is a refusal, or when
         PIXOO_LOG_DEVICE/DEBUG_MODE asks for every reply (`PIXOO_LOG_DEVICE=1 yarn breakout:play`). */
      if (DEVICE_LOG) console.log(`${Command}: ${resText}`);
      let json: any;
      try { json = JSON.parse(resText); } catch { json = undefined; }
      // This firmware answers {"error_code":0} for an accepted request and
      // {"error_code":"Request data illegal json"} for a refused one, both with HTTP 200.
      // Same rule as scripts/pixoo-protocol.cjs parseDeviceResponse().
      const code = json ? (json.ErrCode !== undefined ? json.ErrCode : json.error_code !== undefined ? json.error_code : json.errorCode) : undefined;
      const rejected = typeof code === 'string' || (typeof code === 'number' && code !== 0);
      return { ok: response.ok && !rejected, status: response.status, text: resText, json };
    } catch (err) {
      const error = err as Error;
      console.error([error.message, error.stack].filter(s => s).join('\n'));
      return { ok: false, status: 0, text: error.message, json: undefined };
    }
    // return fetch(`${this.url}/post`, requestOptions)
    //     .then((response) => response.json())
    //     .catch((error) => console.error(error));
  }

  //
  // Helper methods
  //
  clear() {
    this.fill(Colors.Black)
  }



  // @color: [r, g, b]
  fill(color: Color) {
    this.buffer = new Array(this.pixelCount).fill(parseColor(color))
  }

  drawPixel(x: number, y: number, color: Color = Colors.White) {
    // ⚠️ integerise, always. This is the fix for "the user paddle never appears":
    // the game moves the paddle with float maths (p.x = clamp(p.x + 1.53 * dt ...)), so the
    // old code reached `this.buffer[24.966 + 58 * 64]` - a NON-integer key. On a JS Array that
    // silently creates an ordinary object property ("3756.966...") which is NOT part of the
    // indexed array, so `buffer.flat()` (and therefore PicData) never contained a single paddle
    // pixel, with no error anywhere. Integer coordinates only, always, from now on.
    x = Math.round(x)
    y = Math.round(y)
    if (x < 0 || y < 0) return
    if (x >= this.size || y >= this.size) return
    this.buffer[x + y * this.size] = parseColor(color)
  }

  /**
   * Replace the whole buffer with a prepared frame (used by the render-64 / push-32 path in
   * src/game/play-breakout.ts, where the 64 buffer lives in a separate PixooAPI instance).
   */
  setBuffer(frame: [number, number, number][]) {
    if (!Array.isArray(frame) || frame.length !== this.pixelCount) {
      throw new Error(`setBuffer: expected ${this.pixelCount} pixels, got ${frame ? frame.length : 'nothing'}`)
    }
    this.buffer = frame
  }

  getTextWidth(text: string, { bitmap, height }: FontType = Vari5) {
    return [...text].reduce((acc, c) => {

      if (c === ' ') {
        return acc + 3;
      } else {
        if (!bitmap[c]) c = '?' // unknown character
        const width = Math.floor(bitmap[c].length / height)
        return acc + width + 1
      }

    }, 0)
  }

  drawPngAlignCenter(
    png: PNGWithMetadata,
    startX: number, endX: number, startY: number,
    bgColor: Color = Colors.Black) {

    if (!png) {
      return;
    }

    const { data, width, height } = png;

    const imageX = Math.ceil(((startX + endX) / 2) - (width / 2));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (width * y + x) << 2;
        const alpha = data[idx + 3] / 255;
        const color = [data[idx], data[idx + 1], data[idx + 2]];
        const outColor = toRgb(color as [number, number, number], alpha, parseColor(bgColor))
        this.drawPixel(imageX + x, startY + y, outColor);
      }
    }
  }
  // @y: horizontal line to draw text on (from top pixel)
  // @color: [r, g, b]
  // @font: font to use
  // Caveat: due to the way the font is rendered, the text will be slightly
  // offset from the center of the screen to the left (by 1 pixel.)



  drawTextCenter(text: string, y: number, color: Color = Colors.White, font: FontType = Vari5) {
    const { bitmap, height } = font;
    let pixelSoFar = 0
    const x = Math.floor((this.size - this.getTextWidth(text, font)) / 2)
    const chars = [...text]
    chars.map((c, i) => {
      if (!bitmap[c]) c = '?'
      const width = Math.floor(bitmap[c].length / height)
      this.drawChar(c, [x + pixelSoFar, y], parseColor(color), font)
      pixelSoFar += width + 1
    })
  }


  drawTextAlignRight(text: string, [x, y]: Position, color: Color = Colors.White, font: FontType = Vari5) {
    const right = x;
    const width = this.getTextWidth(text, font);
    const left = right - width;
    this.drawText(text, [left, y], color, font);

    return left;
  }


  drawZhText(
    text: string, [startX,startY]: 
    Position, color: Color = Colors.White, 
    fontSize: 7 | 9 | 11 = 7) {

    const bmp = textToBmp(text, color, fontSize);
    const resolution = bmp.length / 4;
    const height = fontSize + 1;
    const width = resolution / height;

    //const imageX = startX; //Math.ceil(((startX + endX) / 2) - (width / 2));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (width * y + x) << 2;
        const alpha = bmp[idx + 3] / 255;
        if(alpha > 0){
          const color = [bmp[idx], bmp[idx + 1], bmp[idx + 2]] as Color;
          this.drawPixel(startX + x, startY + y, color);
        }
      }
    }
    // let pixelSoFar = 0
    // const x = Math.floor((this.size - this.getTextWidth(text, font)) / 2)
    // const chars = [...text]
    // chars.map((c, i) => {
    //   if (!bitmap[c]) c = '?'
    //   const width = Math.floor(bitmap[c].length / height)
    //   this.drawChar(c, [x + pixelSoFar, y], parseColor(color), font)
    //   pixelSoFar += width + 1
    // })
  }

  drawTextAlignCenter(text: string, [startX, startY]: Position, [endX, endY]: Position, color: Color = Colors.White, font: FontType = Vari5): [number, number] {
    const center = (startX + endX) / 2;
    const width = this.getTextWidth(text, font);
    const left = Math.ceil(center - (width / 2));
    this.drawText(text, [left, startY], color, font);

    return [left, left + width];
  }

  drawTextAlignCenter2x(text: string, [startX, startY]: Position, [endX, endY]: Position, color: Color = Colors.White, tight = false, font: FontType = Vari5) {
    const center = (startX + endX) / 2;
    const width = this.getTextWidth(text, font) * 2 - text.length;
    const left = Math.ceil(center - (width / 2));
    this.drawText2x(text, [left, startY], color, tight, font);
  }

  // @y: horizontal line to draw text on (from top pixel)
  // @color: [r, g, b]
  // @padding: number of pixels to pad the text on the left and right sides
  // @font: font to use
  drawTextRight(text: string, y: number, color = Colors.White, padding = 0, font: FontType = Vari5) {
    const { height, bitmap } = font;
    let pixelSoFar = 0
    const x = this.size - this.getTextWidth(text, font) - padding
    const chars = [...text]
    chars.map((c, i) => {
      if (c === ' ') {
        pixelSoFar += 3;
      } else {
        if (!bitmap[c]) c = '?'
        const width = Math.floor(bitmap[c].length / height)
        this.drawChar(c, [x + pixelSoFar, y], parseColor(color), font)
        pixelSoFar += width + 1
      }
    })
  }

  // @y: horizontal line to draw text on (from top pixel)
  // @color: [r, g, b]
  // @padding: number of pixels to pad the text on the left and right sides
  // @font: font to use
  drawTextLeft(text: string, y: number, color: Color = Colors.White, padding = 0, font: FontType = Vari5) {
    const { height, bitmap } = font;

    let pixelSoFar = 0
    const chars = [...text]
    chars.map((c, i) => {
      if (c === ' ') {
        pixelSoFar += 3;
      } else {
        if (!font.bitmap[c]) c = '?'
        const width = Math.floor(bitmap[c].length / height)
        this.drawChar(c, [padding + pixelSoFar, y], parseColor(color), font)
        pixelSoFar += width + 1
      }

    })
  }

  // Adapted from https://github.com/C453/Pixoo-TS (Apache 2.0)
  drawText(text: string, pos: Position, color: Color = Colors.White, font: FontType = Vari5) {
    const { height, bitmap } = font;
    let pixelSoFar = 0
    const chars = [...text]
    chars.map((c, i) => {
      if (c === ' ') {
        pixelSoFar += 3;
      } else {
        if (!bitmap[c]) c = '?'
        const width = Math.floor(bitmap[c].length / height)
        this.drawChar(c, [pixelSoFar + pos[0], pos[1]], parseColor(color), font)
        pixelSoFar += width + 1
      }
    })
  }

  // Adapted from https://github.com/C453/Pixoo-TS (Apache 2.0)
  drawChar(char: string, pos: Position, color: Color = Colors.White, { bitmap, height }: FontType = Vari5) {
    let charMatrix: boolean[] = bitmap[char]
    if (!charMatrix) {
      console.log(`Unknown char: ${char}`)
      charMatrix = bitmap['?'] // default to ?
    }
    const width = Math.floor(charMatrix.length / height)
    charMatrix.forEach((bit, index) => {
      if (bit) {
        const x = index % width
        const y = Math.floor(index / width)
        this.drawPixel(pos[0] + x, pos[1] + y, parseColor(color))
      }
    })
  }
  //{font, height}: FontType = Vari5
  // Adapted from https://github.com/C453/Pixoo-TS (Apache 2.0)
  drawText2x(text: string, pos: Position, color: Color = Colors.White, tight = false, font: FontType = Vari5) {
    const { height, bitmap } = font;
    let pixelSoFar = 0
    const chars = [...text]
    chars.map((c, i) => {
      if (!bitmap[c]) c = '?'
      const width = Math.floor(bitmap[c].length / height) * 2;
      this.drawChar2x(c, [pixelSoFar + pos[0], pos[1]], parseColor(color), font)
      pixelSoFar += width + (tight ? 1 : 2);
    })
  }

  // Adapted from https://github.com/C453/Pixoo-TS (Apache 2.0)
  drawChar2x(char: string, pos: Position, color: Color = Colors.White, { bitmap, height }: FontType = Vari5) {
    let charMatrix: boolean[] = bitmap[char]
    if (!charMatrix) {
      console.log(`Unknown char: ${char}`)
      charMatrix = bitmap['?'] // default to ?
    }
    const width = Math.floor(charMatrix.length / height)
    charMatrix.forEach((bit, index) => {
      if (bit) {
        const x = (index % width) * 2;
        const y = Math.floor(index / width) * 2;
        this.drawPixel(pos[0] + x, pos[1] + y, parseColor(color));
        this.drawPixel(pos[0] + x + 1, pos[1] + y, parseColor(color));
        this.drawPixel(pos[0] + x, pos[1] + y + 1, parseColor(color));
        this.drawPixel(pos[0] + x + 1, pos[1] + y + 1, parseColor(color));
      }
    })
  }

  // Co-pilot authored method
  // @start: [x, y]
  // @end: [x, y]
  // @color: [r, g, b]
  // @fill: boolean
  drawRect(start: Position, end: Position, color: Color = Colors.White, fill = false) {
    if (fill) {
      for (let x = start[0]; x < end[0]; x++) {
        for (let y = start[1]; y < end[1]; y++) {
          this.drawPixel(x, y, parseColor(color))
        }
      }
    } else {
      for (let x = start[0]; x < end[0]; x++) {
        for (let y = start[1]; y < end[1]; y++) {
          if (x === start[0] || y === start[1] || x === end[0] - 1 || y === end[1] - 1) {
            this.drawPixel(x, y, parseColor(color))
          }
        }
      }
    }
  }

  // Co-pilot authored method
  // @start: [x, y]
  // @end: [x, y]
  // @color: [r, g, b]
  drawLine(start: Position, end: Position, color: Color = Colors.White) {
    const dx = Math.abs(end[0] - start[0])
    const dy = Math.abs(end[1] - start[1])
    const sx = start[0] < end[0] ? 1 : -1
    const sy = start[1] < end[1] ? 1 : -1
    let err = dx - dy
    while (true) {
      this.drawPixel(start[0], start[1], parseColor(color))
      if (start[0] === end[0] && start[1] === end[1]) break
      const e2 = 2 * err
      if (e2 > -dy) {
        err -= dy
        start[0] += sx
      }
      if (e2 < dx) {
        err += dx
        start[1] += sy
      }
    }
  }

  /**
   * ms the device will hold the frame sent by push()/sendBuffer(). Defaults to
   * PIXOO_PIC_SPEED (1000 = the long-standing behaviour for the static pages); a continuous
   * stream (a game) should call setPicSpeed() once with a value just below its real push
   * interval. See the PIC SPEED POLICY note at the top of this file.
   */
  private picSpeed: number = PIC_SPEED_DEFAULT;

  /** Clamp and set the PicSpeed used by the buffer-push path; returns the value applied. */
  setPicSpeed(ms: number): number {
    const n = Number(ms);
    this.picSpeed = Number.isFinite(n) ? Math.min(PIC_SPEED_LIMITS.max, Math.max(PIC_SPEED_LIMITS.min, Math.round(n))) : PIC_SPEED_DEFAULT;
    return this.picSpeed;
  }

  getPicSpeed(): number {
    return this.picSpeed;
  }

  /**
   * A CONTINUOUS stream (a game) only: apply the measured panel pacing to this instance and return
   * the interval the CALLER must keep between push() calls (wait `paceMs - elapsed`, i.e. subtract
   * the request itself). This client never sleeps by itself - only the loop that supplies frames
   * knows its real interval, and the clock/weather/bus pages must keep holding their frame.
   *
   * Values are the ones verified on this panel (see PANEL PACING TABLE in ./pacing.ts and
   * .gener/t0-findings.md §31-§35). For PicWidth 32 that is pace 120 ms with PicSpeed 96 (0.8 x pace),
   * for 64 pace 200 ms with PicSpeed 160; an unmeasured PicWidth is interpolated and flagged
   * `verifiedByEyes: false`. Prefer panelPacingFor(size).paceMs == the value you actually space at,
   * otherwise call setPicSpeed() with picSpeedForPace(yourOwnInterval) instead.
   */
  applyPanelPacing(): PanelPacing {
    const pacing = panelPacingFor(this.size);
    this.setPicSpeed(pacing.picSpeed);
    return { ...pacing, picWidth: this.size };
  }

  async push() {
    await this.sendBuffer()
  }

  async sendBuffer() {
    // Once per sequence (cold start, or an explicit resetCounter()), instead of the old
    // "reset every 1000 pushes": a mid-stream Draw/ResetHttpGifId makes the device reload
    // its gif slot (visible flicker), and a wall-clock anchored id never wraps around.
    if (!this.picIdPrepared) await this.preparePicSequence()

    const start = Date.now()
    const response = await this.sendHttpGif(
      1, // PicNum: one frame per request - the only shape this panel measurably plays at PicWidth 64
      this.size, // PicWidth
      0, // PicOffset
      this.nextPicId(), // PicID - strictly increasing, see the PICID POLICY note at the top of this file
      this.picSpeed, // PicSpeed - the panel paints at 1000/this; see the PIC SPEED POLICY note at the top of this file
      Buffer.from(this.buffer.flat()).toString('base64') // PicData
    )
    this.pushAvgElapsed = (this.pushAvgElapsed * this.pushCount + (Date.now() - start)) / (this.pushCount + 1)
    this.pushCount++
    return response
  }

  /**
   * Start a PicID sequence the device agrees with: Draw/ResetHttpGifId, then continue from
   * the id Device/GetHttpGifId reports. This firmware does not answer that command, so the
   * wall-clock anchor (or 1, in PIXOO_PICID=reset mode) is what actually applies.
   */
  async preparePicSequence(): Promise<PicSequence> {
    const reset = await this.resetHttpGifId()
    const probe = await this.GetHttpGifId()
    const reported = readPicId(probe.json)
    this.lastPicId = reported !== null ? Math.max(reported, PICID_MODE === 'reset' ? 0 : picIdAnchor() - 1) : (PICID_MODE === 'reset' ? 0 : picIdAnchor() - 1)
    this.picIdPrepared = true

    const sequence: PicSequence = {
      firstPicId: this.lastPicId + 1,
      resetAccepted: reset.ok,
      fromDevice: reported !== null,
      mode: PICID_MODE,
    }
    console.log(`PicID sequence: Draw/ResetHttpGifId ${sequence.resetAccepted ? 'accepted' : 'NOT accepted'}, Device/GetHttpGifId reported ${reported !== null ? reported : 'nothing (unsupported by this firmware)'}, mode=${sequence.mode} -> first PicID ${sequence.firstPicId}`)
    return sequence
  }

  /**
   * Drop our position in the sequence and start a new one on the device.
   * Kept under the original name because src/game/play-breakout.ts calls it.
   */
  async resetCounter(): Promise<PicSequence> {
    this.lastPicId = 0
    this.picIdPrepared = false
    return await this.preparePicSequence()
  }

  /** The PicID for the next Draw/SendHttpGif: always > the previous one (doc requirement). */
  nextPicId(): number {
    this.lastPicId = PICID_MODE === 'reset'
      ? this.lastPicId + 1
      : Math.max(this.lastPicId + 1, picIdAnchor())
    return this.lastPicId
  }

  //
  // Pixoo API methods
  //
  async getCurrentChannel() {
    return this.post({
      Command: 'Channel/GetIndex'
    })
  }

  // @index: 0 (Faces), 1 (Cloud Channel), 2 (Visualizer), 3 (Custom), 4 (Black screen)
  async setChannel(index: number) {
    return this.post({
      Command: 'Channel/SetIndex',
      SelectIndex: index
    })
  }

  // @index: 0-2
  async setCustomPageIndex(index: number) {
    return this.post({
      Command: 'Channel/SetCustomPageIndex',
      CustomPageIndex: index
    })
  }

  // @eqPosition: index starts from 0
  async setVisualizerChannel(index: number) {
    return this.post({
      Command: 'Channel/SetEqPosition',
      EqPosition: index
    })
  }

  // @index: 0 (Recommend gallery), 1 (Favourite), 2 (Subscribe artist), 3 (Album)
  async setCloudIndex(index: number) {
    return this.post({
      Command: 'Channel/CloudIndex',
      Index: index
    })
  }

  // @brightness: 0-100
  async setBrightness(brightness: number) {
    return this.post({
      Command: 'Channel/SetBrightness',
      Brightness: brightness
    })
  }

  async getAllSettings() {
    return this.post({
      Command: 'Channel/GetAllConf'
    })
  }

  // @longitude: -180 to 180
  // @latitude: -90 to 90
  async setLogAndLat(longitude: number, latitude: number) {
    return this.post({
      Command: 'Sys/LogAndLat',
      Longitude: longitude,
      Latitude: latitude
    })
  }

  // @timeZoneValue: time zone value (string, e.g. GMT-5)
  async setTimeZone(timeZoneValue: string) {
    return this.post({
      Command: 'Sys/TimeZone',
      TimeZoneValue: timeZoneValue
    })
  }

  // "it will set the system time when the device powers on"
  // @utc: timestamp (e.g. 1672416000)
  async setSystemTime(utc: number) {
    return this.post({
      Command: 'Device/SetUTC',
      Utc: utc
    })
  }

  // @onOff: 0 (off), 1 (on)
  async setOnOffScreen(onOff: boolean) {
    return this.post({
      Command: 'Channel/OnOffScreen',
      OnOff: +onOff
    })
  }

  async getDeviceTime() {
    return this.post({
      Command: 'Device/GetDeviceTime'
    })
  }

  // @mode: 0 (Celsius), 1 (Fahrenheit)
  async setDisTempMode(mode: 'C' | 'F') {
    return this.post({
      Command: 'Device/SetDisTempMode',
      Mode: mode === 'C' ? 0 : 1
    })
  }

  // @mode: 0 (normal), 1 (90), 2 (180), 3 (270)
  async setScreenRotationAngle(rotate: 90 | 180 | 270) {

    const mode = (() => {
      switch (rotate) {
        case 90: return 1;
        case 180: return 2;
        case 270: return 3;
        default: return 0;
      }
    })();

    return this.post({
      Command: 'Device/SetScreenRotationAngle',
      Mode: mode
    })
  }

  // @mode: 0 (off), 1 (on)
  async setMirrorMode(mode: boolean) {
    return this.post({
      Command: 'Device/SetMirrorMode',
      Mode: +mode
    })
  }

  // @mode: 0 (12-hour), 1 (24-hour)
  async setTime24Flag(mode: boolean) {
    return this.post({
      Command: 'Device/SetTime24Flag',
      Mode: +mode
    })
  }

  // @mode: 0 (off), 1 (on)
  async setHighLightMode(mode: boolean) {
    return this.post({
      Command: 'Device/SetHighLightMode',
      Mode: +mode
    })
  }

  async restart() {
    return this.post({
      Command: 'Device/SysReboot'
    })
  }

  // @rValue: 0-100
  // @gValue: 0-100
  // @bValue: 0-100
  async setWhiteBalance(rValue: number, gValue: number, bValue: number) {
    return this.post({
      Command: 'Device/SetWhiteBalance',
      RValue: rValue,
      GValue: gValue,
      BValue: bValue
    })
  }

  async getWeatherInfo() {
    return this.post({
      Command: 'Device/GetWeatherInfo'
    })
  }

  // @minute: 0-59
  // @second: 0-59
  // @status: 0 (stop), 1 (start)
  async setTimer(minute: number, second: number, status: boolean) {
    return this.post({
      Command: 'Tools/SetTimer',
      Minute: minute,
      Second: second,
      Status: +status
    })
  }

  // @status: 0 (stop), 1 (start), 2 (reset)
  async setStopWatch(status: number) {
    return this.post({
      Command: 'Tools/SetStopWatch',
      Status: status
    })
  }



  // @blueScore: 0-999
  // @redScore: 0-999
  async setScoreBoard(blueScore: number, redScore: number) {
    return this.post({
      Command: 'Tools/SetScoreBoard',
      BlueScore: blueScore,
      RedScore: redScore
    })
  }

  // @status: 0 (off), 1 (on)
  async setNoiseStatus(status: boolean) {
    return this.post({
      Command: 'Tools/SetNoiseStatus',
      NoiseStatus: +status
    })
  }

  // "play gif file, the command can select the gif file,
  // the folder which includes gif files, and the net gif file.
  // the gif files only support the size (1616 ,32 32 ,64 * 64)."
  //
  // @fileType: 0 (play tf’s file), 1 (play tf’s folder), 2 (play net file)
  // @fileName: 2 (net file address), 1 (the folder path), 0 (the file path)
  async playTFGif(fileType: number, fileName: string) {
    return this.post({
      Command: 'Device/PlayTFGif',
      FileType: fileType,
      FileName: fileName
    })
  }

  // "get the PicId which the command Draw/SendHttpGif.
  // It will return the PicId, it’s value is the previous gif id plus 1"
  async GetHttpGifId() {
    return this.post({
      Command: 'Device/GetHttpGifId'
    })
  }

  async resetHttpGifId() {
    return this.post({
      Command: 'Draw/ResetHttpGifId'
    })
  }

  // See http://doc.divoom-gz.com/web/#/12?page_id=93
  //
  // Command	string	Draw/SendHttpGif
  // PicNum	number	the include single pictures of the animation and smaller than 60
  // PicWidth	number	the pixels of the animation, and only support the 16,32,64
  // PicOffset	number	the picture offset start from 0. eg:0,1,2,3,4,PicNum-1
  // PicID	number	the animation ID, every animation must have unique ID and auto increase,It’s getting bigger and start with 1, example: the current gif id is 100, and then next gif’s id should be greater than or equal to 101
  // PicSpeed	number	the animation speed, it bases on ms
  // PicData	string	the picutre Base64 encoded RGB data, The RGB data is left to right and up to down
  async sendHttpGif(picNum: number, picWidth: number, picOffset: number, picId: number, picSpeed: number, picDataBase64: string) {
    return this.post({
      Command: 'Draw/SendHttpGif',
      PicNum: picNum,
      PicWidth: picWidth,
      PicOffset: picOffset,
      PicID: picId,
      PicSpeed: picSpeed,
      PicData: picDataBase64
    })
  }

  // See http://doc.divoom-gz.com/web/#/12?page_id=219
  async clearHttpText() {
    return this.post({
      Command: 'Draw/ClearHttpText'
    })
  }

  // See http://doc.divoom-gz.com/web/#/12?page_id=234
  //
  // Command	string	Draw/SendHttpItemList
  // ItemList	array	item list
  // TextId	number	the text id is unique and will be replaced with the same ID， it is samller than 40
  // type	number	the display type， It will be introduced below
  // x	number	the start x postion
  // y	number	the start y postion
  // dir	number	0:scroll left, 1:scroll right
  // font	number	it is font id via https://app.divoom-gz.com/Device/GetTimeDialFontList, you shold select the font with Type=0 if you hope it to scrool
  // TextWidth	number	the text area width
  // Textheight	number	the text area height
  // TextString	string	the text string is utf8 string and length is smaller than 512 , it will be display string or request url string， it is Optional
  // speed	number	the scroll speed if it need scroll, the time (ms) the text move one step
  // color	string	the font color, eg:#FFFF00
  // update_time	number	the url request interval time based on seconds， it is Optional
  // align	number	horizontal text alignment, 1:left; 2: middle; 3:right
  async sendHttpItemList(itemList: any) {
    return this.post({
      Command: 'Draw/SendHttpItemList',
      ItemList: itemList
    })
  }

  // See http://doc.divoom-gz.com/web/#/12?page_id=347
  //
  // Command	string	Device/PlayBuzzer
  // ActiveTimeInCycle	number	Working time of buzzer in one cycle in milliseconds
  // OffTimeInCycle	number	Idle time of buzzer in one cycle in milliseconds
  // PlayTotalTime	number	Working total time of buzzer in milliseconds
  async playBuzzer(activeTimeInCycle: number, offTimeInCycle: number, playTotalTime: number) {
    return this.post({
      Command: 'Device/PlayBuzzer',
      ActiveTimeInCycle: activeTimeInCycle,
      OffTimeInCycle: offTimeInCycle,
      PlayTotalTime: playTotalTime
    })
  }

  // play divoom gif file, it will get from “Get Img Upload List” and “Get My Like Img List”.
  // See http://doc.divoom-gz.com/web/#/12?page_id=460
  async playRemote(fileId: string) {
    return this.post({
      Command: 'Draw/SendRemote',
      FileId: fileId
    })
  }

  // CommandList will run all commmand of the the command array.
  // See http://doc.divoom-gz.com/web/#/12?page_id=241
  //
  // Command	string	Draw/CommandList
  // CommandList	Array	the command array information
  // async commandList(commandList: any[]) {
  //   return this.post({
  //     Command: 'Draw/CommandList',
  //     CommandList: commandList
  //   })
  // }

  // UseHTTPCommandSource will run all commmands in url file.
  // See http://doc.divoom-gz.com/web/#/12?page_id=242
  //
  // Command	string	Draw/UseHTTPCommandSource
  // CommandUrl	string	the url address of the command array information
  async useHTTPCommandSource(commandUrl: string) {
    return this.post({
      Command: 'Draw/UseHTTPCommandSource',
      CommandUrl: commandUrl
    })
  }
}
