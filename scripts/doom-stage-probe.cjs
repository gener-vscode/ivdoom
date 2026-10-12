#!/usr/bin/env node
/*
 * scripts/doom-stage-probe.cjs - WHICH stage does an argument select, and how bright is it?
 *
 * WHY (2026-10-12): playable DOOM starts at `-warp 1` = E1M1, and the user's read was
 * 「this stage is too dark, can't see the path well」. Before adding a `--map` flag to the runner, two
 * things must be MEASURED instead of assumed:
 *
 *   1. the FORM of `-warp`. `d_main.c` (the engine's own parser) does:
 *        gamemode == commercial -> startmap = atoi(argv[p+1])                  // one integer = MAPxx
 *        otherwise              -> startepisode = argv[p+1][0]-'0', map = argv[p+2][0]-'0'  // "1 3" = E1M3
 *      so the same word `--map 3` means different things depending on the IWAD. Which one this WAD is
 *      is not something to guess from its file name - probe both and read the engine's own `gamemap`.
 *   2. the BRIGHTNESS of the candidates, because "too dark" is only answered by numbers: mean luma of the
 *      PLAY AREA (all rows except the 32-row status bar), plus the fraction of pixels a real LED panel
 *      would call lit. `yarn canary` measures the panel; this measures the CONTENT.
 *
 * Proof is the engine's own DG_STATE (fd 4), never a screenshot: `map=`, and the player's spawn x/y.
 * A candidate that never reaches a map (bad lump name -> the engine exits) is reported as FAILED, which
 * is exactly what makes the FORM question answerable.
 *
 * Nothing here touches the panel. Usage:
 *   node scripts/doom-stage-probe.cjs                       # default candidate list
 *   node scripts/doom-stage-probe.cjs --ms 4000 --sample 8
 *   node scripts/doom-stage-probe.cjs --cases "demo;warp 2;warp 1 2"
 */
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const ENGINE = path.join(REPO, '.gener/build/doom/doom-headless');
/* EXACTLY the runner's shape, and this is a measured fact, not a style choice: this engine finds the
   IWAD by NAME inside its cwd, and `-file <path>` is not an IWAD argument here. Run with cwd=repo and it
   ends in 255 with "Game mode indeterminate. No IWAD file was found." - the first version of this probe
   failed every case for that reason alone (the probe's own bug, not the maps'). */
const WAD_DIR = path.join(REPO, '.gener/wad');
const WAD = 'freedoom1.wad';
const STATUS_BAR_ROWS = 32; // DOOM's status bar is the bottom 32 lines of the 320x200 frame

const argv = process.argv.slice(2);
const argValue = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= argv.length ? dflt : argv[i + 1];
};

const limitMs = Math.max(1000, Number(argValue('ms', '2600')) || 2600);
const maxSample = Math.max(1, Number(argValue('sample', '6')) || 6);
// `warp 1 3` = DOOM 1 form; `warp 3` = commercial form. `demo` = what -playdemo DEMO1 really plays.
const cases = String(argValue('cases', 'demo;warp 2;warp 1 2;warp 3;warp 1 3;warp 1 5'))
  .split(';')
  .map((c) => c.trim())
  .filter(Boolean);

const luminanceOf = (buf, resx, resy) => {
  const rows = resy - STATUS_BAR_ROWS;
  const pixels = resx * rows;
  if (pixels <= 0 || buf.length < resx * resy * 3) return null;
  let sum = 0;
  let max = 0;
  let lit60 = 0;
  let lit128 = 0;
  let darkest = 255;
  let darkPixels = 0;
  const hist = new Array(9).fill(0);
  for (let row = 0; row < rows; row++) {
    let i = row * resx * 3;
    for (let col = 0; col < resx; col++, i += 3) {
      const luma = (buf[i] * 75 + buf[i + 1] * 150 + buf[i + 2] * 28) >> 8; // 0.299/0.587/0.114
      sum += luma;
      if (luma > max) max = luma;
      if (luma < darkest) darkest = luma;
      if (luma > 60) lit60++;
      if (luma > 128) lit128++;
      if (luma < 24) darkPixels++;
      hist[Math.min(8, (luma / 32) | 0)]++;
    }
  }
  // percentiles from the histogram, so one bright wall cannot hide a dark floor
  let acc = 0;
  const pct = (p) => {
    const target = pixels * p;
    for (let b = 0; b < 9; b++) {
      acc += hist[b];
      if (acc >= target) return b * 32;
    }
    return 255;
  };
  void darkPixels;
  return { mean: sum / pixels, max, min: darkest, p10: pct(0.1), p50: pct(0.5), lit60: lit60 / pixels, lit128: lit128 / pixels };
};

const runCase = (label, engineArgs) =>
  new Promise((resolve) => {
      const child = spawn(ENGINE, ['-file', WAD, '-nomusic', '-nosound', ...engineArgs], {
          cwd: WAD_DIR,
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, DOOM_MAX_MS: String(limitMs), DOOM_MAX_FRAMES: '0' },
    });

    let res = null; // {resx,resy} parsed from DG_HEADLESS ready
      let stateLine = null;
      let lastAny = null; // the LAST state line even when it has no position: a failure must say what the engine was doing
      let armed = false; // only pixels AFTER the player exists are the map, not the title screen
    const pending = [];
    const samples = [];
    let stderrText = '';

    child.stdio[2].on('data', (d) => {
      stderrText += String(d);
      const m = /ready res=(\d+)x(\d+)/.exec(stderrText);
      if (m && !res) res = { resx: Number(m[1]), resy: Number(m[2]) };
    });

    child.stdio[4].on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (!line.startsWith('DG_STATE')) continue;
        const g = (k) => Number((new RegExp(`${k}=(-?\\d+)`).exec(line) || [])[1]);
          const cur = { t: g('t'), map: g('map'), ps: g('ps'), mo: g('mo'), x: g('x'), y: g('y'), hp: g('hp') };
          if (cur.t >= 0 && (!lastAny || cur.t >= lastAny.t)) lastAny = cur;
          /* The gate is `mo=1` - the engine's own "the player object exists" - and NOT "x and y are non-zero".
           * That second version was this probe's own bug, and it reported a WORKING stage as a failure:
           *   -warp 1 6 -> t=170 map=6 ps=0 mo=1 x=0 y=-10485760  ❌ "FAILED exit 0"
           * x=0 is a legal coordinate; E1M6 really does start the player on the map's X origin. Same shape as
           * the controller page's bug ("a falsy test standing in for 'does it exist'"), which is why the gate
           * now reads the field the engine actually means. */
          if (cur.mo === 1) {
              armed = true;
          if (!stateLine || cur.t > stateLine.t) stateLine = cur;
        }
      }
    });

    child.stdio[3].on('data', (d) => {
      if (!res || !armed) return; // a frame before the player exists is a menu, not a stage
      pending.push(d);
      const size = res.resx * res.resy * 3;
      while (pending.reduce((n, b) => n + b.length, 0) >= size && samples.length < maxSample) {
        let buf = Buffer.concat(pending);
        const frame = buf.subarray(0, size);
        pending.length = 0;
        if (buf.length > size) pending.push(buf.subarray(size));
        const stat = luminanceOf(frame, res.resx, res.resy);
        if (stat) samples.push(stat);
      }
    });

    child.on('close', (code) => {
      const failed = !stateLine || samples.length === 0;
      const avg = (key) => (samples.length ? samples.reduce((s, x) => s + x[key], 0) / samples.length : 0);
      resolve({
        label,
        failed,
        code,
        engineMap: stateLine ? stateLine.map : null,
        spawn: stateLine ? `${stateLine.x},${stateLine.y}` : '-',
        hp: stateLine ? stateLine.hp : null,
        frames: samples.length,
        mean: avg('mean'),
        p10: avg('p10'),
        p50: avg('p50'),
        max: Math.max(0, ...samples.map((s) => s.max)),
        lit60: avg('lit60'),
        lit128: avg('lit128'),
          reject: failed ? /Error:|not found|I_Error|IWAD/.exec(stderrText)?.[0] || `exit ${code}` : '',
          /* A failure that only says "exit N" is the same mistake as a 200 with an empty body: it proves
           * nothing about the content. So an unreachable stage reports the engine's own last word. */
          lastState: lastAny
              ? `t=${lastAny.t} map=${lastAny.map} ps=${lastAny.ps} mo=${lastAny.mo} x=${lastAny.x} y=${lastAny.y}`
              : 'never emitted a DG_STATE line',
          stderrTail: failed ? stderrText.trim().split('\n').slice(-1)[0] || '' : '',
      });
    });
  });

const parseCase = (c) => {
  const [kind, ...rest] = c.split(/\s+/);
  if (kind === 'demo') return ['-playdemo', 'DEMO1'];
  if (kind === 'warp') return ['-warp', ...rest];
  throw new Error(`unknown case "${c}" (use "demo" or "warp <args>")`);
};

(async () => {
    console.log(`stage probe  engine=${ENGINE}  wad=${WAD_DIR}/${WAD}  ${limitMs} ms/case, up to ${maxSample} frames`);
  console.log('brightness counts ONLY the play area (rows minus the 32-row status bar)\n');
  const rows = [];
  for (const c of cases) {
    const r = await runCase(c, parseCase(c));
    rows.push(r);
    if (r.failed) {
        console.log(`❌ ${c.padEnd(14)} FAILED ${r.reject}`);
        console.log(`     last engine state: ${r.lastState}`);
        if (r.stderrTail) console.log(`     engine said: ${r.stderrTail}`);
        continue;
    }
    console.log(
      `✅ ${c.padEnd(14)} engine map=${String(r.engineMap).padStart(2)} spawn=${r.spawn.padEnd(26)} hp=${r.hp} ` +
        `frames=${r.frames}  mean=${r.mean.toFixed(1)} p10=${r.p10} p50=${r.p50} max=${r.max} ` +
        `lit>60=${(r.lit60 * 100).toFixed(1)}% lit>128=${(r.lit128 * 100).toFixed(1)}%`
    );
  }
  const ok = rows.filter((r) => !r.failed);
  if (ok.length) {
    ok.sort((a, b) => a.mean - b.mean);
    console.log('\nDarkest -> brightest (what the panel can actually show):');
    for (const r of ok) console.log(`  mean ${r.mean.toFixed(1).padStart(6)}  lit>60 ${String((r.lit60 * 100).toFixed(1)).padStart(5)}%  ${r.label}`);
  }
  console.log('\nRule: the engine never lies about `map=`, and a candidate that cannot load a lump fails here.');
})();
