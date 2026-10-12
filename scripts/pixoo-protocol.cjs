#!/usr/bin/env node
'use strict';

/**
 * Draw/SendHttpGif wire format - the single source of truth for the payload shape.
 * ----------------------------------------------------------------------------
 * Established from the known-good request captured live out of the running app
 * (`.gener/mine-working.json`) plus the Divoom doc quoted in src/pixoo/api.ts:713-721:
 *
 *   PicNum    number  frames in this animation, must be < 60
 *   PicWidth  number  only 16 | 32 | 64
 *   PicOffset number  0..PicNum-1
 *   PicID     number  unique per animation, strictly increasing, starts at 1
 *   PicSpeed  number  ms per frame played *on the device* (production always 1000)
 *   PicData   string  ONE base64 string of RGB data, "left to right and up to down"
 *                     => PicNum frames concatenated = PicWidth*PicWidth*3*PicNum bytes
 *
 * ⚠️ Why this file exists: every probe script in scripts/ used to send
 *    `PicData: [base64]` (an ARRAY). The device replied HTTP 200 and then either
 *    rebooted or showed nothing at all. Field-by-field diff against the working
 *    payload proves the pixel encoding itself was correct (same length, same
 *    row-major order); the only real differences were the ARRAY shape and
 *    PicSpeed 15000 (far outside the 100..1000 range anything here has ever used).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚑ TESTING RULE (user, 2026-10-09) — why `createRunGuard` exists:
 *   "no batch means don't mix up diff PicNum in a continuous batch, it's no way
 *    for me to catch with PicNum crash then reboot"
 *   => ONE process sends ONE case: one PicNum (and one PicWidth, one PicSpeed).
 *      If the panel goes blank mid-run, that single case is the only possible cause.
 *      To test another PicNum you start a NEW process, after a manual restart.
 *   Nothing in scripts/ may loop over PicNum values in one run any more.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * CLI:
 *   node scripts/pixoo-protocol.cjs --check .gener/mine-working.json .gener/ready-64.json
 */

const fs = require('node:fs');
const path = require('node:path');

const PIC_WIDTHS = [16, 32, 64];
const MAX_PIC_NUM = 59; // doc: "smaller than 60"
// Production (src/pixoo/api.ts sendBuffer) uses 1000; benchmark-push.cjs used 120.
// Both worked. 15000 (used by the old ready-probe) has never been shown to work.
const SPEED_MIN = 100;
const SPEED_MAX = 1000;
const PRODUCTION_SPEED = 1000;

/**
 * Clamp PicSpeed. Default bounds are the range this device has been observed to
 * accept (100..1000 ms); pass `speedRange` to deliberately test outside it.
 */
const clampSpeed = (value, fallback = PRODUCTION_SPEED, { min = SPEED_MIN, max = SPEED_MAX } = {}) => {
    const n = Number.isFinite(+value) ? +value : fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
};

const settingsValues = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'local.settings.json'), 'utf8')).Values || {};
  } catch {
    return {};
  }
};

/** Solid-colour frame as raw RGB bytes (row-major: y*width+x), exactly like PixooAPI.buffer.flat(). */
const solidFrame = (size, [r, g, b]) => {
  const buffer = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    buffer[i * 3] = r;
    buffer[i * 3 + 1] = g;
    buffer[i * 3 + 2] = b;
  }
  return buffer;
};

/**
 * ─── WHAT THE OFFICIAL DOC ACTUALLY SAYS ─────────────────────────────────────
 * docin.divoom-gz.com → "Welcome to the Divoom API":
 *   "send animation to device, and device will loop animation."
 *   "This method only accepts ONE picture of animation at a time, and the picture format
 *    must be based on Base64 encoded RGB data. If the animation is composed of N pictures,
 *    it will be sent in N times, one picture data will be sent each time with the picture
 *    offset."
 *   PicNum    "the include single pictures of the animation and smaller than 60" → TOTAL frames
 *   PicOffset "the picture offset start from 0. eg:0,1,2,3,4,PicNum-1"           → WHICH frame
 *   PicID     "the animation ID, every animation must have unique ID and auto increase ...
 *              the current gif id is 100, and then next gif's id should be greater than or
 *              equal to 101"                                                      → ONE id per ANIMATION
 *   example   "we will send the gif with two frames, we will send two times ... the
 *             PicOffset=0 packet should be sended first"  → both packets carry PicID 3, PicNum 2
 *
 * So PicNum is not "how many frames are in THIS request", it is "how many frames the
 * ANIMATION has", and the animation is stitched together by every packet repeating the same
 * PicID while counting PicOffset up from 0. Our production code (src/pixoo/api.ts, PicNum 1
 * per push) is a legal 1-frame animation each time - which is why it has always worked.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * The documented upload of one animation: N requests, all with the same PicID and PicNum,
 * PicOffset 0..N-1, and PicData holding exactly ONE frame each. Send them in order.
 */
function gifAnimationPackets({ picWidth, frames, picId, picSpeed = PRODUCTION_SPEED, speedRange } = {}) {
    const list = (Array.isArray(frames) ? frames : [frames]).map((f) => (Buffer.isBuffer(f) ? f.toString('base64') : String(f)));
    if (list.length < 1 || list.length > MAX_PIC_NUM) {
        throw new Error(`an animation is 1..${MAX_PIC_NUM} frames (doc: "smaller than 60"), got ${list.length}`);
    }
    if (!Number.isInteger(+picId) || +picId < 1) throw new Error(`PicID must be an integer >= 1, got ${JSON.stringify(picId)}`);
    const picSpeedClamped = clampSpeed(picSpeed, PRODUCTION_SPEED, speedRange);
    return list.map((picData, offset) => ({
        Command: 'Draw/SendHttpGif',
        PicNum: list.length,
        PicWidth: picWidth,
        PicOffset: offset,
        PicID: +picId,
        PicSpeed: picSpeedClamped,
        PicData: picData,
    }));
}

/**
 * NOT the documented shape: everything in one request with PicData concatenated. Kept only so
 * the earlier experiments can be reproduced and compared; on this device it was accepted
 * ({"error_code":0}) and produced no visible change on the panel.
 */
function gifPayload({ picWidth, frames, picOffset = 0, picId, picSpeed = PRODUCTION_SPEED, speedRange } = {}) {
    const list = (Array.isArray(frames) ? frames : [frames]).map((f) => (Buffer.isBuffer(f) ? f.toString('base64') : String(f)));
    return {
        Command: 'Draw/SendHttpGif',
        PicNum: list.length,
        PicWidth: picWidth,
        PicOffset: picOffset,
        PicID: picId,
        PicSpeed: clampSpeed(picSpeed, PRODUCTION_SPEED, speedRange),
        PicData: list.join(''),
    };
}

/** Returns a list of hard problems (device will ignore or choke on this request). */
function validateGifPayload(body, { speedRange } = {}) {
    const problems = [];
    const lowLimit = speedRange && Number.isFinite(+speedRange.min) ? +speedRange.min : SPEED_MIN;
    const highLimit = speedRange && Number.isFinite(+speedRange.max) ? +speedRange.max : SPEED_MAX;
  if (body.Command !== 'Draw/SendHttpGif') problems.push(`Command must be "Draw/SendHttpGif", got ${JSON.stringify(body.Command)}`);
  if (!PIC_WIDTHS.includes(body.PicWidth)) problems.push(`PicWidth must be one of ${PIC_WIDTHS.join('/')}, got ${body.PicWidth}`);
  if (!Number.isInteger(body.PicNum) || body.PicNum < 1 || body.PicNum > MAX_PIC_NUM) problems.push(`PicNum must be an integer 1..${MAX_PIC_NUM}, got ${body.PicNum}`);
  if (!Number.isInteger(body.PicID) || body.PicID < 1) problems.push(`PicID must be an integer >= 1 (doc: unique, strictly increasing, starts at 1), got ${JSON.stringify(body.PicID)}`);
  if (typeof body.PicData !== 'string') {
    const kind = Array.isArray(body.PicData) ? `array[${body.PicData.length}]` : typeof body.PicData;
    problems.push(`PicData must be ONE base64 string, got ${kind} - this is the shape that makes the device no-op / reboot`);
    return problems;
  }
    const bytes = Buffer.from(body.PicData, 'base64').length;
    const oneFrame = body.PicWidth * body.PicWidth * 3;
    // Two byte-counts are accepted on purpose:
    //   == oneFrame                  the DOCUMENTED shape: one frame per request, PicNum states
    //                                how many frames the whole animation has (sent with PicOffset 0..PicNum-1)
    //   == oneFrame * PicNum         the shape we used before reading the doc (all frames concatenated
    //                                into one request). Accepted by this device, no visible effect.
    if (bytes !== oneFrame && bytes !== oneFrame * (body.PicNum || 1)) {
        problems.push(`PicData decodes to ${bytes} bytes but a ${body.PicWidth}x${body.PicWidth} frame is ${oneFrame} bytes; doc: one frame per request, an animation of PicNum=${body.PicNum} means ${body.PicNum} separate requests with PicOffset 0..${body.PicNum - 1}`);
    }
  if (body.PicData.length % 4 !== 0) problems.push(`PicData is not canonical base64 (length ${body.PicData.length} is not a multiple of 4) - a hand-edited JSON array usually breaks here`);
  if (body.PicData.includes(',')) problems.push(`PicData contains "," - looks like a stringified array`);
    if (!(body.PicSpeed >= lowLimit && body.PicSpeed <= highLimit)) problems.push(`PicSpeed ${body.PicSpeed} is outside the allowed ${lowLimit}..${highLimit} ms range (this device has only ever been seen accepting 100..${SPEED_MAX} ms)`);
    return problems;
}

/**
 * Check a whole animation (the array gifAnimationPackets returns) before a single byte is sent.
 * This is the check that would have caught the "accepted but nothing played" case: it declared
 * PicNum=4 and delivered only PicOffset=0.
 */
function validateGifAnimation(packets, { speedRange } = {}) {
    const problems = [];
    if (!Array.isArray(packets) || packets.length === 0) return ['validateGifAnimation needs a non-empty array of request bodies'];
    const first = packets[0];
    packets.forEach((body, index) => {
        const tag = `packet ${index}`;
        validateGifPayload(body, { speedRange }).forEach((p) => problems.push(`${tag} (PicOffset=${body.PicOffset}): ${p}`));
        if (body.PicOffset !== index) problems.push(`${tag}: PicOffset=${body.PicOffset} but the doc requires the packets to be sent in order with PicOffset ${index} (0..${packets.length - 1})`);
        if (body.PicNum !== first.PicNum) problems.push(`${tag}: PicNum=${body.PicNum} but this animation declared ${first.PicNum} frames - every packet of one animation repeats the SAME PicNum`);
        if (body.PicID !== first.PicID) problems.push(`${tag}: PicID=${body.PicID} differs from ${first.PicID} - the shared PicID is what stitches the frames into ONE animation`);
        if (body.PicWidth !== first.PicWidth) problems.push(`${tag}: PicWidth=${body.PicWidth} differs from ${first.PicWidth}`);
        if (body.PicSpeed !== first.PicSpeed) problems.push(`${tag}: PicSpeed=${body.PicSpeed} differs from ${first.PicSpeed}`);
    });
    return problems;
}

/**
 * PicID must be strictly greater than the last one the device saw. Read the
 * device's own counter first (Device/GetHttpGifId) fall back to 1 after a reset.
 */
function discoverPicId(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  for (const key of ['PicID', 'PicId', 'GifId', 'Id', 'id']) {
    const v = parsed[key];
    if (Number.isFinite(+v) && +v >= 0) return +v;
  }
  return null;
}

/**
 * Reset the device gif-id counter and return the first PicID to use.
 * `post` must resolve to { ok, text } (same shape as the probe scripts' post()).
 */
async function beginPicIdSequence(post, { reset = true } = {}) {
    const resetResult = reset ? await post({ Command: 'Draw/ResetHttpGifId' }) : null;
    const probe = await post({ Command: 'Device/GetHttpGifId' });
  let parsed;
  try {
    parsed = JSON.parse(probe.text);
  } catch {
    parsed = undefined;
  }
    const found = discoverPicId(parsed);
    return {
        picId: found !== null ? Math.max(1, found) : 1,
        fromDevice: found !== null,
        raw: probe.text,
        // Device/GetHttpGifId is not answered by this firmware, so `fromDevice:false`
        // does NOT mean the reset failed - check resetAccepted instead.
        resetAccepted: resetResult ? resetResult.ok : undefined,
        resetText: resetResult ? resetResult.text : undefined,
        getHttpGifIdSupported: probe.ok,
    };
}

/**
 * Read the device's own answer. This firmware answers `{"error_code":0}` for a
 * request it accepted, and `{"error_code":"Request data illegal json"}` for one it
 * refuses; the old Divoom docs show `{"ErrCode":0,"ErrMsg":"no error"}` instead.
 * Both spellings are handled here.
 *
 * ⚠️ Before this, every probe/benchmark in scripts/ parsed ONLY `.ErrCode`, so a
 * refusal like that was counted as a success. Measured on 2026-10-09: this firmware
 * does not answer `Device/GetHttpGifId` at all (it replies with that error string)
 * while accepted `Draw/SendHttpGif` frames reply `{"error_code":0}`. Treat every
 * earlier "accepted=N/N" number as optimistic until it is re-measured.
 */
function parseDeviceResponse(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { known: false, code: undefined, message: undefined, rejected: false };
    }
    const code = parsed.ErrCode !== undefined ? parsed.ErrCode : parsed.error_code !== undefined ? parsed.error_code : parsed.errorCode;
    const message = parsed.ErrMsg || parsed.error_msg || (typeof code === 'string' ? code : undefined);
    const rejected = typeof code === 'string' || (typeof code === 'number' && code !== 0);
    return { known: true, code, message, rejected };
}

/**
 * One process = one case. Returns a guard that rejects any payload whose PicNum
 * differs from the one this run was started with, so a crash/reboot is always
 * attributable to exactly ONE measured setting.
 *
 * Throws immediately (before anything is sent) if the run is asked to mix PicNums.
 */
function createRunGuard({ picNum = 1, picWidth, picSpeed, label = 'case' } = {}) {
    const n = +picNum;
    if (!Number.isInteger(n) || n < 1 || n > MAX_PIC_NUM) {
        throw new Error(`PicNum must be exactly ONE integer 1..${MAX_PIC_NUM} per run, got ${JSON.stringify(picNum)} - a run that mixes PicNum values cannot be attributed if the device reboots`);
    }
    if (Array.isArray(picWidth) && picWidth.length > 1) {
        throw new Error(`PicWidth must be exactly ONE of ${PIC_WIDTHS.join('/')} per run, got ${picWidth.join(',')} - same attribution problem as mixing PicNum`);
    }
    const shape = { picNum: n, picWidth: Array.isArray(picWidth) ? picWidth[0] : picWidth, picSpeed };
    /** Problems with a payload that would break the single-case rule. */
    const offCase = (body) => {
        const problems = [];
        if (body.PicNum !== shape.picNum) {
            problems.push(`PicNum=${body.PicNum} breaks this run's fixed PicNum=${shape.picNum} (mixed PicNum => a reboot cannot be attributed)`);
        }
        if (shape.picWidth !== undefined && body.PicWidth !== shape.picWidth) {
            problems.push(`PicWidth=${body.PicWidth} breaks this run's fixed PicWidth=${shape.picWidth}`);
        }
        return problems;
    };
    const describe = () =>
        `${label}: PicNum=${shape.picNum}` +
        (shape.picWidth ? ` PicWidth=${shape.picWidth}` : '') +
        (shape.picSpeed ? ` PicSpeed=${shape.picSpeed}ms` : '') +
        ` - if the panel blanks/reboots, this is the ONLY thing that was sent`;
    return { picNum: shape.picNum, picWidth: shape.picWidth, picSpeed: shape.picSpeed, offCase, describe };
}

/**
 * Is the device still answering? Needed because this firmware has NO status command:
 * measured 2026-10-09, `Device/WifiStatus`, `Device/GetSysInfo`, `Device/GetUnknown`,
 * `Device/GetSetting` and `Clock/GetTimer` are ALL answered with
 * {"error_code": "Request data illegal json"}, so uptime/boot state cannot be read
 * off the device. `Channel/GetIndex` IS answered, so it is used as the canary:
 * ask once before a run and once after it. If the canary dies at the end, whatever
 * this process just sent is the cause - which is only true because the guard kept
 * the run to a single case.
 */
async function livenessProbe(post, { attempts = 2, timeout = 6000 } = {}) {
    const samples = [];
    for (let i = 0; i < attempts; i++) {
        const res = await post({ Command: 'Channel/GetIndex' });
        samples.push({ ok: res.ok, status: res.status, ms: res.ms, text: res.text });
        if (res.ok) break;
    }
    const alive = samples.some((s) => s.ok);
    const last = samples[samples.length - 1];
    return { alive, ms: last.ms, text: last.text, attempts: samples.length };
}

/** Minimal HTTP client shared by the probes; error_code/ErrCode 0 == accepted. */
function createPoster({ origin, userAgent, timeout = 6000 }) {
  return async (command) => {
    const raw = typeof command === 'string' ? command : JSON.stringify(command);
    const t0 = performance.now();
    try {
      const res = await fetch(`${origin.replace(/\/+$/, '')}/post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
        body: raw,
        signal: AbortSignal.timeout(timeout),
      });
        const text = await res.text();
        const device = parseDeviceResponse(text);
        return { ok: res.ok && !device.rejected, status: res.status, errCode: device.code, deviceError: device.message, ms: performance.now() - t0, bytes: Buffer.byteLength(raw), text: text.slice(0, 120) };
    } catch (err) {
      return { ok: false, status: 0, ms: performance.now() - t0, bytes: Buffer.byteLength(raw), text: (err && err.message) || String(err) };
    }
  };
}

module.exports = {
  PIC_WIDTHS, MAX_PIC_NUM, SPEED_MIN, SPEED_MAX, PRODUCTION_SPEED,
    clampSpeed, settingsValues, solidFrame, gifPayload, validateGifPayload,
    discoverPicId, beginPicIdSequence, createPoster, parseDeviceResponse,
    createRunGuard, livenessProbe,
    gifAnimationPackets, validateGifAnimation,
};

// ---------------------------------------------------------------------------
// CLI: shape-check any saved request body
// ---------------------------------------------------------------------------
if (require.main === module) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.log('usage: node scripts/pixoo-protocol.cjs --check <payload.json> [...]');
    process.exit(1);
  }
    const RESET = '\x1b[0m';
    const RED = '\x1b[31m';
    const GREEN = '\x1b[32m';
    let failed = 0;
    for (const file of files) {
        const body = JSON.parse(fs.readFileSync(file, 'utf8'));
        const problems = validateGifPayload(body);
        const kind = Array.isArray(body.PicData) ? `array[${body.PicData.length}]` : typeof body.PicData;
        const bytes = typeof body.PicData === 'string' ? Buffer.from(body.PicData, 'base64').length : 0;
        console.log(`\n${path.resolve(file)}`);
        console.log(`  PicNum=${body.PicNum} PicWidth=${body.PicWidth} PicID=${body.PicID} PicSpeed=${body.PicSpeed} PicData=${kind} decoded=${bytes}B`);
        if (problems.length) {
            failed++;
            problems.forEach((p) => console.log(`  ${RED}✗ ${p}${RESET}`));
        } else {
            console.log(`  ${GREEN}✓ payload shape OK${RESET}`);
        }
    }
    process.exit(failed ? 1 : 0);
}
