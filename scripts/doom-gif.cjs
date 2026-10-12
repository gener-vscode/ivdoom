#!/usr/bin/env node
/*
 * ─── DOOM -> 4 GIFs OF 6 FRAMES, 250 ms EACH (24 frames = 1 s of 24 fps) ───────────────────
 *
 * The question this asks (asked 2026-10-11 14:23): every other probe in this repo feeds the panel one
 * frame per `Draw/SendHttpGif` request, so the frame rate is capped by OUR upload ceiling (§12/§13:
 * 61-67 ms @32, 141-146 ms @64) - and §30 showed a grouped animation streamed continuously never plays.
 * There is a different door: `Device/PlayTFGif FileType 2` hands the panel a **URL** and the panel fetches
 * and decodes the GIF itself. Then the panel is the one pacing the frames, and our ceiling is out of the
 * loop entirely. Is that usable for live content? Measure it with real DOOM frames.
 *
 * What is produced here, exactly as asked ("4x6frames gif each gif in 250ms, so total 1s@24fps"):
 *   4 GIF files x 6 frames, each GIF's frame delays summing to EXACTLY 250 ms
 *   -> GIF delay units are hundredths of a second, so 250 ms / 6 = 41.67 ms is not representable as a
 *      single delay. It is represented exactly as a pattern: [40,40,40,40,40,50] ms = 250 ms per group,
 *      averaging 41.67 ms => 24.00 fps nominal, 4 groups = 1.00 s.
 *   frames are consecutive frames from the engine, so the motion is DOOM's own; note DOOM runs at 35 tps,
 *   so a 24 fps playback of consecutive frames is 24/35 = 0.69x game speed (slow motion). The smoothness
 *   of the picture is what is being tested, not the pacing of the game clock.
 *
 * Frames come from the same headless engine as scripts/doom-device.cjs (.gener/build/doom/doom-headless,
 * built by `make -C scripts/doom`): it streams raw RGB24 320x200 on fd 3 while playing its own DEMO1, so
 * no HID is involved. The play view is cropped centred (168x168 of the 320x168 view above the status bar)
 * and box-filtered down to the GIF size - the filter the user chose for the panel in §16.
 *
 * Because `Device/PlayTFGif` docs say the GIF size must be 16x16, 32x32 or 64x64 (see src/pixoo/api.ts
 * playTFGif), the output is exactly `--size` square, no padding, no letterboxing.
 *
 * A 1 px border in a per-group colour is burned into every frame (red / green / blue / amber) for the same
 * reason the frame-number baseline exists: the panel is the only display we have, and without a marker
 * "which group played, and in what order" is not answerable afterwards. `--no-border` removes it.
 *
 * Output:  PNG frames + a manifest + the GIFs in .gener/doom-gif/, and the GIFs COPIED into the web
 * directory that this machine already serves (`--install`, default /home/tommy/repo/Strata/serve/web), so
 * they are reachable at `--url-base` (default http://192.168.1.16:8080/ui/web/) - verified mapping:
 * a file in serve/web/ answers at /ui/web/<file> (HTTP 200), /ui/<file> answers 404.
 *
 * Play them on the panel with: node scripts/play-net-gif.cjs   (wraps Device/PlayTFGif FileType 2)
 *
 * Usage: node scripts/doom-gif.cjs [--groups 4] [--frames 6] [--gif-ms 250] [--size 64]
 *                                 [--crop square|wide] [--filter box|nearest] [--no-border]
 *                                 [--loop 0|1] [--install <dir>] [--url-base <url>] [--skip-engine]
 *                                 [--skip-s 3]   start at N seconds of DEMO1 time (asked 2026-10-11 15:37:
 *                                 "can offset from 3s?"). The engine has no seek, but DEMO1 replay is
 *                                 deterministic at DOOM_MAX_TPS=35 tics/s, so an offset is just "capture
 *                                 skip+N frames, drop the first skip". It changes ONLY the content: frames,
 *                                 delays, size and loop stay byte-for-byte comparable to the t=0 run.
 * Requires: yarn build (dist/game/scale.js) and make -C scripts/doom (unless --skip-engine reuse)
 */
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const { PNG } = require('pngjs');

const REPO = path.join(__dirname, '..');
const ENGINE = path.join(REPO, '.gener/build/doom/doom-headless');
const WAD_DIR = path.join(REPO, '.gener/wad');
const WAD = 'freedoom1.wad';
const OUT_DIR = path.join(REPO, '.gener/doom-gif');

// 320x200 RGB24, the engine's raw frame pipe (dg_stdio.c writes frames only, no header)
const SRC_W = 320;
const SRC_H = 200;
const FRAME_BYTES = SRC_W * SRC_H * 3;
const TICK_HZ = 35; // DOOM's fixed simulation rate

const argValue = (argv, name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
};
const has = (argv, name) => argv.includes(`--${name}`);
const loadDist = async (rel) => import(url.pathToFileURL(path.join(REPO, 'dist', rel)).href);

/** Device GIF sizes the firmware accepts (src/pixoo/api.ts playTFGif doc: 16, 32, 64). */
const ALLOWED_SIZES = [16, 32, 64];

/** Frame delays in ms that sum to EXACTLY `totalMs` over `n` frames (integer milliseconds). */
const exactDelays = (n, totalMs) => {
  const base = Math.floor(totalMs / n);
  const remainder = totalMs - base * n;
  // put the extra milliseconds on the LAST frames: the first frames of every group are identical, which
  // is what makes a group boundary comparable across groups.
  const out = new Array(n).fill(base);
  for (let i = n - remainder; i < n; i++) out[i] += 1;
  return out;
};

const decodeFrame = (buf) => {
  const px = new Array(SRC_W * SRC_H);
  for (let i = 0; i < px.length; i++) {
    const o = i * 3;
    px[i] = [buf[o], buf[o + 1], buf[o + 2]];
  }
  return px;
};

/** Ask the engine for N frames; fd 3 is the frame pipe, fd 2 the engine log (kept on disk). */
const captureFrames = ({ frames, logPath }) =>
  new Promise((resolve, reject) => {
    if (!fs.existsSync(ENGINE)) {
      reject(new Error(`engine missing: ${ENGINE}\n  build it with: make -C scripts/doom -j8`));
      return;
    }
    const child = spawn(ENGINE, ['-file', WAD, '-nomusic', '-nosound', '-playdemo', 'DEMO1'], {
      cwd: WAD_DIR,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, DOOM_MAX_FRAMES: String(frames), DOOM_MAX_MS: '120000' },
    });
    const out = [];
    let stderr = '';
    let buf = Buffer.alloc(0);
    child.stdio[2].on('data', (c) => (stderr += c.toString()));
    child.stdio[3].on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= FRAME_BYTES && out.length < frames) {
        out.push(buf.subarray(0, FRAME_BYTES));
        buf = buf.subarray(FRAME_BYTES);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.writeFileSync(logPath, stderr);
      const ready = /DG_HEADLESS ready.*\nDG_HEADLESS done frames=(\d+) wall_ms=(\d+)/m.exec(stderr);
      resolve({ frames: out, engineFrames: ready ? +ready[1] : out.length, engineWallMs: ready ? +ready[2] : 0, exitCode: code });
    });
  });

const writePng = (dir, name, width, height, pixels) => {
  const png = new PNG({ width, height });
  for (let i = 0; i < pixels.length; i++) {
    png.data[i * 4] = pixels[i][0];
    png.data[i * 4 + 1] = pixels[i][1];
    png.data[i * 4 + 2] = pixels[i][2];
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(path.join(dir, name), PNG.sync.write(png));
};

/** 1 px border so a group is identifiable on the panel afterwards. */
const bordered = (pixels, size, rgb) => {
  const out = pixels.map((p) => p.slice());
  for (let i = 0; i < size; i++) {
    out[i] = rgb.slice();
    out[(size - 1) * size + i] = rgb.slice();
    out[i * size] = rgb.slice();
    out[i * size + size - 1] = rgb.slice();
  }
  return out;
};

const BORDER_COLOURS = [
  [255, 40, 40],
  [40, 255, 60],
  [60, 90, 255],
  [255, 200, 40],
];

const main = async () => {
  const argv = process.argv.slice(2);
  const groupsCount = Math.max(1, Number(argValue(argv, 'groups', '4')));
  const framesPerGroup = Math.max(1, Number(argValue(argv, 'frames', '6')));
  const gifMs = Math.max(20, Number(argValue(argv, 'gif-ms', '250')));
  const size = ALLOWED_SIZES.includes(Number(argValue(argv, 'size', '64'))) ? Number(argValue(argv, 'size', '64')) : 64;
  const cropMode = argValue(argv, 'crop', 'square');
  const filter = argValue(argv, 'filter', 'box');
  const prefix = argValue(argv, 'prefix', 'doom24');
  const installDir = argValue(argv, 'install', '/home/tommy/repo/Strata/serve/web');
  const urlBase = argValue(argv, 'url-base', 'http://192.168.1.16:8080/ui/web/');
  const loop = Number(argValue(argv, 'loop', '0'));
    const border = !has(argv, 'no-border');
    const totalFrames = groupsCount * framesPerGroup;
    /*
     * Frame offset in SECONDS of demo time, converted with TICK_HZ (35 tics/s). With --skip-s 3 the GIF holds
     * frames 105..184 of DEMO1 instead of 0..79: same frame count, same delays, same size - only later, busier
     * game content. That is deliberate: a comparison against the t=0 run must have exactly one difference.
     */
    const skipSeconds = Number(argValue(argv, 'skip-s', '0'));
    const skipFrames = Number.isFinite(skipSeconds) && skipSeconds > 0 ? Math.round(skipSeconds * TICK_HZ) : 0;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'frames'), { recursive: true });

    const totalMs = groupsCount * gifMs;
    console.log(
        `DOOM -> GIFs  ${groupsCount} groups x ${framesPerGroup} frames, each GIF ${gifMs}ms ` +
        `=> ${totalFrames} frames / ${(totalMs / 1000).toFixed(2)}s nominal ${(1000 * totalFrames) / totalMs} fps`,
    );
    console.log(`size=${size}x${size} crop=${cropMode} filter=${filter} border=${border ? 'on' : 'off'} loop=${loop ? 'once' : 'forever'}`);
    if (skipFrames) console.log(`frame offset: skip ${skipFrames} (= ${skipSeconds}s of demo time at ${TICK_HZ} tics/s) -> using frames ${skipFrames}..${skipFrames + totalFrames - 1}`);

    // ask for the offset frames too, then drop them: the engine itself has no seek (see header note)
    const capture = has(argv, 'skip-engine') ? null : await captureFrames({ frames: totalFrames + skipFrames, logPath: path.join(OUT_DIR, 'engine.log') });
    if (capture) {
        console.log(`captured frames=${capture.frames.length} (engine reported ${capture.engineFrames}, exit=${capture.exitCode}, wall ${capture.engineWallMs} ms)`);
        if (capture.frames.length < totalFrames + skipFrames) {
            const missing = totalFrames + skipFrames - capture.frames.length;
            console.log(`! the engine produced ${capture.frames.length} of ${totalFrames + skipFrames} frames; ${missing} will be repeated`);
        }
        if (skipFrames) {
            capture.frames = capture.frames.slice(skipFrames);
            console.log(`dropped the first ${skipFrames} frames, keeping ${capture.frames.length}`);
        }
    } else {
        console.log('reusing the frames already on disk (--skip-engine)');
    }

  const { cropAndDownscale, doomCrop, DOOM_SRC_WIDTH, DOOM_SRC_HEIGHT } = await loadDist('game/scale.js');
  const crop = doomCrop(cropMode, size, size);
  const delaysMs = exactDelays(framesPerGroup, gifMs);

  const groupPngs = [];
  for (let g = 0; g < groupsCount; g++) {
    const frames = [];
    for (let f = 0; f < framesPerGroup; f++) {
        // PNGs are named by their DEMO1 frame index, so an offset run and a t=0 run never overwrite each other
        const frameName = `${String(skipFrames + g * framesPerGroup + f).padStart(3, '0')}.png`;
        const srcIndex = Math.min(capture ? capture.frames.length - 1 : 0, g * framesPerGroup + f);
        const raw = capture ? capture.frames[srcIndex] : fs.readFileSync(path.join(OUT_DIR, 'frames', frameName));
      let pixels;
      if (capture) {
        pixels = cropAndDownscale({
          src: decodeFrame(raw),
          srcWidth: DOOM_SRC_WIDTH,
          srcHeight: DOOM_SRC_HEIGHT,
          crop,
          dstWidth: size,
          dstHeight: size,
          filter,
        });
        if (border) pixels = bordered(pixels, size, BORDER_COLOURS[g % BORDER_COLOURS.length]);
      } else {
        const png = PNG.sync.read(raw);
        pixels = [];
        for (let i = 0; i < size * size; i++) pixels.push([png.data[i * 4], png.data[i * 4 + 1], png.data[i * 4 + 2]]);
      }
        const name = frameName;
        const pngPath = path.join(OUT_DIR, 'frames', name);
      if (capture) writePng(path.join(OUT_DIR, 'frames'), name, size, size, pixels);
      frames.push(pngPath);
    }
    groupPngs.push(frames);
  }

    const manifest = {
        size,
        outDir: OUT_DIR,
        prefix,
        // which DEMO1 frames this GIF holds: [skipFrames, skipFrames + framesPerGroup)
        skipFrames,
        skipSeconds,
        framesMs: delaysMs,
    groups: groupPngs.map((frames, g) => ({
      name: `${prefix}-${g + 1}.gif`,
      frames,
      durationsMs: delaysMs,
      loop,
    })),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const py = spawnSync('python3', [path.join(REPO, 'scripts', 'gif-assemble.py'), path.join(OUT_DIR, 'manifest.json')], { stdio: 'inherit' });
  if (py.status !== 0) {
    console.error(`! GIF assembly failed (python3 + Pillow). exit=${py.status}`);
    process.exit(1);
  }

  const installed = [];
  if (installDir) {
    fs.mkdirSync(installDir, { recursive: true });
    for (const group of manifest.groups) {
      const from = path.join(OUT_DIR, group.name);
      const to = path.join(installDir, group.name);
      fs.copyFileSync(from, to);
      installed.push({ name: group.name, path: to, url: new URL(group.name, urlBase).href, bytes: fs.statSync(to).size });
    }
  }

  console.log('');
  console.log('served as (map: serve/web/<file> -> /ui/web/<file>; this was verified with HTTP 200):');
  for (const [i, item] of installed.entries()) {
    console.log(`  group ${i + 1}  border=${border ? BORDER_COLOURS[i % BORDER_COLOURS.length].map((c) => c.toString(16).padStart(2, '0')).join('') : 'off'}  ${item.bytes} bytes  ${item.url}`);
  }
  console.log('');
    console.log(`play on the panel: node scripts/play-net-gif.cjs --gap ${gifMs}   (Device/PlayTFGif FileType 2, one per GIF)`);
  console.log(`frames kept for inspection: ${path.join(OUT_DIR, 'frames')}`);
};

main().catch((err) => {
  console.error(`[x] ${err.stack || err.message}`);
  process.exit(1);
});
