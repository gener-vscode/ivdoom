#!/usr/bin/env node
/*
 * ─── DOOM -> PIXOO PREVIEW (3 s ANIMATED, 32 vs 64, SIDE BY SIDE) ───────────────
 *
 * What this answers: "preview is a good idea, but can it be a 3 second ANIMATED demo
 * of 32 vs 64 rather just 1 frame?"  -> yes: the SAME captured game frames go through
 * both real pipelines and come out as an HTML page where every panel animates at the
 * frame rate that pipeline actually achieves on the hardware.
 *
 * Pipeline (no network, no device needed):
 *   .gener/build/doom/doom-headless  (scripts/doom/dg_stdio.c) streams raw RGB24 320x200
 *     on fd 3. DOOM's own demo (-playdemo DEMO1) plays itself, so no HID is involved.
 *   -> crop the play view (320x200 minus the 32-row status bar = 320x168) in two ways
 *      'square' 168x168 centred   -> 64x64, fills every LED
 *      'wide'   320x168           -> 64x34, keeps the whole horizontal view
 *   -> resample with the SAME filter the device run uses ('box', chosen by the user in §16)
 *      to PicWidth 64 and PicWidth 32
 *   -> write PNG frames + preview.html, each panel playing at its measured device fps.
 *
 * Measured device frame periods (.gener/t0-findings.md §12/§13) are used as the GIF-style
 * frame delays, so this page is a faithful simulation of what the panel will do:
 *   PicWidth 32 -> 61.3 ms/frame -> 16.3 fps   (capable of real speed, mild judder)
 *   PicWidth 64 -> 141.8 ms/frame -> 7.05 fps  (correct speed, visibly churning)
 *
 * Frame count == game time: with -playdemo the engine runs in `singletics` mode, i.e. one
 * game tic per tick call, so N frames == N/35 s of DOOM time regardless of wall clock.
 *
 * Usage: node scripts/doom-preview.cjs --seconds 3 [--crop both|square|wide]
 *                                     [--push 32,64] [--filter box|nearest] [--view]
 * Requires: make -C scripts/doom   (and yarn build, for dist/game/scale.js)
 */
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { spawn } = require('node:child_process');
const { PNG } = require('pngjs');

const REPO = path.join(__dirname, '..');
const ENGINE = path.join(REPO, '.gener/build/doom/doom-headless');
const WAD_DIR = path.join(REPO, '.gener/wad');
const WAD = 'freedoom1.wad';

// 320x200 RGB24 = 192000 bytes per frame, no header (dg_stdio.c writes raw frames only)
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

const loadDist = async (rel) => import(url.pathToFileURL(path.join(REPO, 'dist', rel)).href);

/** Decode one raw frame into the [r,g,b][] matrix shape every src/game helper expects. */
const decodeFrame = (buf) => {
  const px = new Array(SRC_W * SRC_H);
  for (let i = 0; i < px.length; i++) {
    const o = i * 3;
    px[i] = [buf[o], buf[o + 1], buf[o + 2]];
  }
  return px;
};

/**
 * Ask the engine for N frames. stdio[3] is the frame pipe (dg_stdio.c writes fd 3);
 * stdio[2] carries the engine log, kept on disk because a headless run is otherwise silent.
 */
const captureFrames = ({ frames, logPath, progressEvery = 105 }) =>
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
    let t0 = Date.now();

    child.stdio[2].on('data', (c) => (stderr += c.toString()));
    child.stdio[3].on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        while (buf.length >= FRAME_BYTES) {
            if (out.length === 0) t0 = Date.now();
            out.push(buf.subarray(0, FRAME_BYTES));
            buf = buf.subarray(FRAME_BYTES);
            /*
             * The engine produces ONE frame per 1/35 s of its own real time, so a 60 s request
             * blocks here for 60 s of wall clock. Without this line a long run prints nothing at
             * all until the very end and looks like a hang (that is what the user reported for
             * --seconds 60 on 2026-10-10 21:33, while the run itself had completed fine).
             */
            if (progressEvery > 0 && out.length % progressEvery === 0) {
                const secs = (Date.now() - t0) / 1000;
                console.log(`  capturing ${out.length}/${frames} frames  ${secs.toFixed(1)}s elapsed  ${(out.length / secs).toFixed(1)} fps`);
            }
        }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      fs.writeFileSync(logPath, stderr);
      const ready = /DG_HEADLESS ready.*\nDG_HEADLESS done frames=(\d+) wall_ms=(\d+)/m.exec(stderr);
      resolve({
        frames: out,
        engineFrames: ready ? +ready[1] : out.length,
        engineWallMs: ready ? +ready[2] : 0,
        exitCode: code,
      });
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

/** Embed a WxH render into the square 64x64 buffer the panel always receives. */
const embedSquare = (pixels, w, h, side) => {
  const out = Array.from({ length: side * side }, () => [0, 0, 0]);
  const oy = Math.floor((side - h) / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(y + oy) * side + x] = pixels[y * w + x];
  return out;
};

const main = async () => {
  const argv = process.argv.slice(2);
    const seconds = Number(argValue(argv, 'seconds', '3'));
    const cropArg = argValue(argv, 'crop', 'both');
    const cropModes = cropArg === 'both' ? ['square', 'wide'] : [cropArg];
    const pushSizes = argValue(argv, 'push', '32,64').split(',').map(Number);
    const filter = argValue(argv, 'filter', 'box');
    const outDir = path.join(REPO, '.gener/doom-preview');
    fs.mkdirSync(outDir, { recursive: true });

  const { cropAndDownscale, doomCrop, distinctColors, compareFilters, DOOM_SRC_WIDTH, DOOM_SRC_HEIGHT, DOOM_VIEW_HEIGHT } =
    await loadDist('game/scale.js');

  const wantedFrames = Math.round(seconds * TICK_HZ);
  const measuredFps = { 32: 16.3, 64: 7.05 }; // .gener/t0-findings.md §12/§13, same-lan single client
  const measuredPeriod = { 32: 61.3, 64: 141.8 };

  console.log(
    `DOOM preview  engine=${ENGINE.replace(REPO + '/', '')}  wad=${WAD}  ${seconds}s of game time = ${wantedFrames} frames @ ${TICK_HZ} tps`,
  );
  console.log(`crop=${cropModes.join(',')}  push=${pushSizes.join(',')}  filter=${filter}  out=${outDir.replace(REPO + '/', '')}`);

    const capture = await captureFrames({ frames: wantedFrames, logPath: path.join(outDir, 'engine.log') });
    console.log(
    `captured frames=${capture.frames.length} (engine reported ${capture.engineFrames}, exit=${capture.exitCode}, wall ${capture.engineWallMs} ms)`,
  );

  const panels = [];
  const stats = [];

  for (const cropMode of cropModes) {
    const crop = doomCrop(cropMode, 64, 64);
    for (const pushSize of pushSizes) {
      const fps = measuredFps[pushSize] ?? 16.3;
      const period = measuredPeriod[pushSize] ?? 61.3;
      // What the panel can actually take in `seconds` seconds of game time -> that is the
      // honest frame budget for this size; the rest of the captured frames are dropped.
      const budget = Math.max(1, Math.round(seconds * fps));
      const stride = Math.max(1, Math.round(capture.frames.length / budget));
      const dir = path.join(outDir, `${cropMode === 'square' ? 'sq' : 'wd'}${pushSize}`);
      fs.mkdirSync(dir, { recursive: true });

      const frames = [];
      let distinctBox = 0;
      let distinctNearest = 0;
      let differing = 0;
      let sampled = 0;

      for (let i = 0; i < capture.frames.length; i += stride) {
        const src = decodeFrame(capture.frames[i]);
        const dstW = pushSize;
        const dstH = cropMode === 'wide' ? Math.round((pushSize * DOOM_VIEW_HEIGHT) / DOOM_SRC_WIDTH) : pushSize;
        const small = cropAndDownscale({
          src,
          srcWidth: DOOM_SRC_WIDTH,
          srcHeight: DOOM_SRC_HEIGHT,
          crop,
          dstWidth: dstW,
          dstHeight: dstH,
          filter,
        });
        const buffer64 = dstW === 64 && dstH === 64 ? small : embedSquare(small, dstW, dstH, 64);
        const name = `${String(frames.length).padStart(3, '0')}.png`;
        writePng(dir, name, 64, 64, buffer64);
          frames.push(name);
          // Same crop through BOTH filters on the first frames: the difference is exactly the
          // sub-pixel detail that a 1-in-N sample throws away (the §15 measurement, but for DOOM).
          if (frames.length <= 3) {
              const nearest = cropAndDownscale({
                  src,
                  srcWidth: DOOM_SRC_WIDTH,
                  srcHeight: DOOM_SRC_HEIGHT,
                  crop,
                  dstWidth: dstW,
                  dstHeight: dstH,
                  filter: 'nearest',
              });
              distinctBox += distinctColors(small);
              distinctNearest += distinctColors(nearest);
              for (let i = 0; i < small.length; i++)
                  if (small[i][0] !== nearest[i][0] || small[i][1] !== nearest[i][1] || small[i][2] !== nearest[i][2]) differing++;
          }
      }

      const playedSeconds = (frames.length * period) / 1000;
      panels.push({
        title: `${cropMode} crop -> PicWidth ${pushSize}`,
        dir: path.relative(outDir, dir),
        frames,
        period,
        note: `${frames.length} frames, ${period} ms each = ${playedSeconds.toFixed(2)} s played for ${seconds} s of game time (x${(seconds / playedSeconds).toFixed(2)} real speed)`,
      });
      stats.push({
        crop: cropMode,
        pushSize,
        cropRect: `${crop.width}x${crop.height}@${crop.x},${crop.y}`,
        render: `${cropMode === 'wide' ? `${pushSize}x${Math.round((pushSize * DOOM_VIEW_HEIGHT) / DOOM_SRC_WIDTH)} embedded in 64x64` : `${pushSize}x${pushSize}`}`,
        captured: capture.frames.length,
        stride,
        pushed: frames.length,
        fps: fps,
        periodMs: period,
        boxVsNearestDiffering: differing,
        distinctBox: (distinctBox / 3).toFixed(1),
        distinctNearest: (distinctNearest / 3).toFixed(1),
      });
    }
  }

  // The page animates every panel from its own clock, so 16 fps and 7 fps are visible
  // as DIFFERENT motion in the same 3 s window. Both sizes are shown at the same physical
  // size, because that is what the panel does with them (32 is upscaled by the device).
  const html = `<!doctype html>
<meta charset="utf-8">
<title>DOOM on the Pixoo - 3 s animated, PicWidth 32 vs 64</title>
<style>
 body{background:#111;color:#ddd;font:13px/1.5 ui-monospace,monospace;margin:20px}
 h1{font-size:16px} .row{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:22px}
 .panel{background:#181818;border:1px solid #333;padding:12px}
 .panel h2{font-size:13px;margin:0 0 8px} .panel canvas{image-rendering:pixelated;display:block;width:320px;height:320px;background:#000}
 .panel p{color:#9ab;margin:8px 0 0;font-size:12px} table{border-collapse:collapse;margin-top:14px}
 th,td{border:1px solid #333;padding:4px 8px;font-size:12px;text-align:left} th{background:#222}
</style>
<h1>DOOM (Freedoom1, -playdemo DEMO1) - ${seconds} s of game time, box filter, both panel paths</h1>
<p>PicWidth 32 plays at 16.3 fps (61.3 ms/frame measured), PicWidth 64 at 7.05 fps (141.8 ms/frame measured).
Every panel is drawn at the same physical size - the device upscales a 32 frame to fill the 64x64 panel.</p>
<div class="row">${panels
    .filter((p) => p.title.startsWith('square'))
    .map(
      (p, i) =>
        `<div class="panel"><h2>${i === 0 ? 'PUSH 32 (what actually gets sent)' : 'PUSH 64 (device ceiling)'} - ${p.title}</h2><canvas data-panel="${i}" width="64" height="64"></canvas><p>${p.note}</p></div>`,
    )
    .join('')}</div>
<div class="row">${panels
    .filter((p) => p.title.startsWith('wide'))
    .map(
      (p, i) =>
        `<div class="panel"><h2>wide crop (whole 320x168 view) - ${p.title}</h2><canvas data-panel="${i + 2}" width="64" height="64"></canvas><p>${p.note}</p></div>`,
    )
    .join('')}</div>
<table><tr><th>crop</th><th>crop rect</th><th>PicWidth</th><th>render</th><th>frames captured</th><th>stride</th><th>frames kept</th><th>measured fps</th><th>ms/frame</th><th>box&neq;nearest px</th><th>distinct box</th><th>distinct nearest</th></tr>
${stats
  .map(
    (s) =>
      `<tr><td>${s.crop}</td><td>${s.cropRect}</td><td>${s.pushSize}</td><td>${s.render}</td><td>${s.captured}</td><td>${s.stride}</td><td>${s.pushed}</td><td>${s.fps}</td><td>${s.periodMs}</td><td>${s.boxVsNearestDiffering}</td><td>${s.distinctBox}</td><td>${s.distinctNearest}</td></tr>`,
  )
  .join('')}
</table>
<script>
const PANELS = ${JSON.stringify(panels.map((p) => ({ dir: p.dir, frames: p.frames, period: p.period })))};
const load = (p) => p.frames.map((f) => { const im = new Image(); im.src = p.dir + '/' + f; return im; });
const sets = PANELS.map(load);
const canv = [...document.querySelectorAll('canvas')].map((c) => ({ el: c, ctx: c.getContext('2d') }));
const t0 = performance.now();
function draw(now){
  const elapsed = now - t0;
  canv.forEach((c, idx) => {
    const p = PANELS[idx]; const imgs = sets[idx];
    if (!p || !imgs) return;
    const cycle = imgs.length * p.period;
    let i = Math.floor(((elapsed % cycle)) / p.period);
    if (i >= imgs.length) i = imgs.length - 1;
    const im = imgs[i];
    if (im.complete && im.naturalWidth) { c.ctx.clearRect(0,0,64,64); c.ctx.drawImage(im, 0, 0); }
  });
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
</script>
`;
  fs.writeFileSync(path.join(outDir, 'preview.html'), html);
  fs.writeFileSync(path.join(outDir, 'preview.json'), JSON.stringify({ panels: panels.map((p) => ({ title: p.title, frames: p.frames.length, period: p.period })), stats }, null, 2));

  console.log('\npanel                      captured  stride  kept  fps   ms/frame  box!=nearest  distinct(box/nearest)');
  for (const s of stats) {
    console.log(
      `${(s.crop + ' @' + s.pushSize).padEnd(26)} ${String(s.captured).padStart(8)} ${String(s.stride).padStart(7)} ${String(s.pushed).padStart(5)} ${String(s.fps).padStart(5)} ${String(s.periodMs).padStart(9)}  ${String(s.boxVsNearestDiffering).padStart(12)}  ${s.distinctBox} / ${s.distinctNearest}`.replace(/^/, '  '),
    );
  }
  console.log(`\nopen it with:  xdg-open ${path.relative(REPO, path.join(outDir, 'preview.html'))}`);
};

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
