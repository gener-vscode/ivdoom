#!/usr/bin/env node
/*
 * ─── DOOM ON THE REAL PANEL: 3 s ANIMATED A/B, PicWidth 32 THEN PicWidth 64 ──────
 *
 * Same capture path as scripts/doom-preview.cjs (headless DOOM on fd 3 -> crop -> box),
 * but the output is the physical display, one request per frame, which is the only shape
 * this panel plays (src/pixoo/api.ts sendBuffer, PicNum 1).
 *
 * The engine stays at DOOM's 35 tics/s on its own clock and we DROP frames to match the panel,
 * never slow the game down; the reader keeps ONLY the newest frame, which bounds input lag to one
 * frame instead of a growing backlog.
 *
 * Two ceilings, measured on this panel, and only the second one is what the eye sees:
 *   upload ceiling (accept rate):  PicWidth 32 ~61-67 ms/frame (15.31 fps), 64 ~141-145 ms (6.83)
 *   playable rate  (what plays) :  PicWidth 32 ~8-9 fps, PicWidth 64 ~4-5 fps
 * So the default here paces the supply to the PLAYABLE rate with PicSpeed paired just under it
 * (src/pixoo/pacing.ts, .gener/t0-findings.md §31-§33). Sending at the upload ceiling is measurably
 * worse: frames arrive faster than the panel paints them and get shown late / out of order.
 *
 * Usage: node scripts/doom-device.cjs [--seconds 3] [--push 32,64] [--crop square|wide]
 *                                     [--filter box|nearest] [--trace] [--no-canary]
 *                                     [--warm]   solid RED/GREEN/BLUE first: if the user sees those,
 *                                                the transport+PicID path works and any dark screen is
 *                                                a CONTENT problem, not a protocol problem
  *                                     [--hold]   leave the last game frame on the panel (no black-out)
 *                                     [--picspeed N|auto]  PicSpeed ms in every Draw/SendHttpGif. Default auto = the verified value for
 *                                                that PicWidth (110 @32, 180 @64). 1000 = the pre-2026-10-11 production behaviour, kept
 *                                                so an old run can still be reproduced. The panel plays at 1000/PicSpeed.
 *                                     [--pace N|auto|0]    ms to hold between pushes. Default auto = the measured playable interval for
 *                                                that PicWidth (120 @32 -> ~8.3 fps, 200 @64 -> ~5 fps). 0 = as fast as the device
 *                                                answers: throughput measurement only, the panel then stutters (§32). A custom N drags
 *                                                PicSpeed to picSpeedForPace(N) unless --picspeed says otherwise. Over-pacing is its own
 *                                                failure mode: 250/220 measured WORSE than 200/180 (§33).
 *                                     [--picid epoch|reset]  'reset' = the legacy shape that is known to
 *                                                play on this firmware (see the PICID POLICY note in
 *                                                src/pixoo/api.ts). Set before the module is imported.
 *                                     [--print-argv]  print the engine command line this run WOULD use and
 *                                                exit: no panel, no host, no engine. It exists because the
 *                                                start stage is CONTENT (a dark panel is a real symptom with
 *                                                no words attached to it), and both `--warp` bugs so far were
 *                                                invisible unless a panel was involved.
 * Rule from AGENTS/notes: the device must have been restarted by the user if it misbehaves,
 * and every device case is bracketed by scripts/canary.cjs.
 */
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const ENGINE = path.join(REPO, '.gener/build/doom/doom-headless');
const WAD_DIR = path.join(REPO, '.gener/wad');
const WAD = 'freedoom1.wad';
const SRC_W = 320;
const SRC_H = 200;
const FRAME_BYTES = SRC_W * SRC_H * 3;
const TICK_HZ = 35;

const argValue = (argv, name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
};
const has = (argv, name) => argv.includes(`--${name}`);
const loadDist = async (rel) => import(url.pathToFileURL(path.join(REPO, 'dist', rel)).href);

/* One reader for the panel address (scripts/device-config.cjs). `local.settings.json` is gone on purpose: it
   is the Azure Functions host's file and this repo has no Functions host. */
const { deviceValues, noOriginMessage } = require('./device-config.cjs');

const decodeFrame = (buf) => {
  const px = new Array(SRC_W * SRC_H);
  for (let i = 0; i < px.length; i++) {
    const o = i * 3;
    px[i] = [buf[o], buf[o + 1], buf[o + 2]];
  }
  return px;
};

const embedSquare = (pixels, w, h, side) => {
    const out = Array.from({ length: side * side }, () => [0, 0, 0]);
    const oy = Math.floor((side - h) / 2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(y + oy) * side + x] = pixels[y * w + x];
    return out;
};

/**
 * How much light is really in the frame we are about to send.
 * Added after the user reported a DARK PANEL: if avgLuma is > 0 and the panel is still black,
 * the problem is the device/PicID path; if avgLuma is ~0, the problem is our crop/decode.
 */
const frameStats = (buffer) => {
    let lit = 0;
    let luma = 0;
    for (const [r, g, b] of buffer) {
        luma += (r * 299 + g * 587 + b * 114) / 1000;
        if (r + g + b > 90) lit++;
    }
    return {
        litPct: +((100 * lit) / buffer.length).toFixed(1),
        avgLuma: +(luma / buffer.length).toFixed(1),
    };
};

/**
 * Start the engine and keep ONE frame in hand: the newest complete one.
 * Older frames are dropped here, on purpose - see the pacing note at the top.
 */
/*
 * PLAYABLE mode (`--input remote`) differs from the demo run in exactly TWO places, which is deliberate:
 * everything else stays byte-identical to the runs AGENTS.md already measured, so a playable run can be
 * compared with them.
 *   1. NO `-playdemo`: a demo drives the engine itself, so a key from the phone could never change
 *      anything. `-warp 1` starts E1M1 instead of the title screen (same as scripts/doom-input-check.cjs).
 *   2. fd 0 becomes a PIPE (the key lines) and fd 4 a PIPE (DG_STATE). fd 4 is stated in BOTH modes now:
 *      the driver writes DG_STATE every 5 tics, and "not mentioned in the stdio array" means inherited -
 *      which is how a quiet probe would quietly start printing state lines on the terminal.
 *
 * The player's own numbers are read here, not guessed from pixels: `moveTotal` / `turnTotal` accumulate
 * the engine's x/y/angle deltas, exactly the instrument that proved (scripts/doom-input-check.cjs) that a
 * line on fd 0 reaches the engine. Angle deltas are |Δ| per sample, so an angle wrap (0→±180°) shows up as
 * one large step; the totals are for reading a trend, not for geometry.
 */
/* `warp` is a PARAMETER, not something this function reads for itself. That was the bug of 2026-10-12
   14:18: the first version called `argValue(argv, 'warp', ...)` here, but `argv` is a local of `main()` -
   this function is defined at module level, where the name does not exist. A ReferenceError thrown here,
   AFTER warm had already pushed its solid frames, left the panel holding blue with the runner alive and
   doing nothing, and the only trace was one line `argv is not defined`. See main() for the parsing. */
/* THE ENGINE'S COMMAND LINE IS COMPOSED HERE, AS PLAIN DATA, by ONE function that startEngine then spawns.
   That is deliberate: the bug of 2026-10-12 16:00 was in how `--warp` is read, and my earlier "proof" was a
   hand-written copy of the parser - the real one was never executed. A composed value can be printed
   (`--print-argv`) and a real run spawns EXACTLY what was printed, so the flag is testable with no panel,
   no Function App and no build. */
const buildEngineArgs = ({ input, warp }) => {
  const args = ['-file', WAD, '-nomusic', '-nosound'];
  /* WHICH stage a playable run starts on (`--warp`), added 2026-10-12 because the user's read of E1M1 was
     「this stage is too dark, can't see the path well」 - and the probe says they are right: mean luma of
     the PLAY AREA (rows minus the 32-row status bar) is 29.9 with 6.0% of pixels above 60 at `-warp 1`,
     against 48.3 / 22.9% on the map DOOM's own DEMO1 plays. Numbers from scripts/doom-stage-probe.cjs.

     The FORM is passed through VERBATIM on purpose, because `-warp` does not mean one thing: `d_main.c`
     takes a single integer when gamemode==commercial (MAPxx) and `<episode> <map>` otherwise, and this WAD
     is the second one - measured, not inferred from the file name:
       -warp 1    -> DG_STATE map=1, spawn -27262976,16777216
       -warp 1 2  -> DG_STATE map=2, spawn 39845888,3145728      (so TWO arguments really are E1M2)
       -warp 2    -> the engine exits without ever giving the player a position  (episode-only form, rejected)
     Default "1" is today's behaviour exactly, so every frame number recorded in AGENTS.md stays reproducible.
     A demo cannot be played (no key from the phone changes anything - see the note above this function),
     which is why the stage is what travels, not `-playdemo`. */
  const stage = warp.length ? warp : ['1']; // never an empty argument list: `-warp` with nothing after it is a different engine error
  args.push(input ? '-warp' : '-playdemo', ...(input ? stage : ['DEMO1']));
  if (input && stage.join(' ') !== '1') console.log(`   stage: -warp ${stage.join(' ')} (proved by the engine's own DG_STATE map=)`);
  return args;
};

/* startEngine spawns what buildEngineArgs composed - there is no second copy of the `-warp` rule anywhere. */
const startEngine = ({ frames, logPath, onStats, input = false, maxMs = 120000, warp = ['1'] }) => {
  const args = buildEngineArgs({ input, warp });
  console.log(`   engine argv: ${args.join(' ')}`); // the run says what it ACTUALLY asked the engine for
  const child = spawn(ENGINE, args, {
    cwd: WAD_DIR,
    stdio: input ? ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe', 'pipe', 'ignore'],
    env: { ...process.env, DOOM_MAX_FRAMES: String(frames), DOOM_MAX_MS: String(maxMs) },
  });
  const state = { newest: null, dropped: 0, received: 0, alive: true, child, exitCode: null, exitSignal: null, input: null };
  let pending = Buffer.alloc(0);
  let stderr = '';
  /* The engine's OWN last words. A run that stops must quote the engine, not just an exit code - the same
     rule that made `DG_STATE samples=0` the evidence in the 12:06 order bug, and that says a 200 / `Succeeded`
     / `error_code:0` proves nothing about the content. */
  state.lastWords = () => {
    const lines = String(stderr).trim().split('\n').filter(Boolean);
    return lines.length ? lines.slice(-4).join(' ⏐ ') : '(the engine wrote nothing to stderr)';
  };

  /* DG_STATE (fd 4) - the engine's own report, one line per 5 game tics. */
  const engineState = { samples: 0, player: null, newest: null, moveTotal: 0, turnTotal: 0, prev: null };
  let stateBuf = '';
  const STATE_LINE = /^DG_STATE t=(\d+) map=(-?\d+) ps=(-?\d+) mo=(\d+) x=(-?\d+) y=(-?\d+) ang=(-?\d+) hp=(-?\d+) ar=(-?\d+) wp=(-?\d+) atk=(\d+) use=(\d+)/;
  if (input) {
    child.stdio[4].on('data', (chunk) => {
      stateBuf += chunk.toString();
      let nl;
      while ((nl = stateBuf.indexOf('\n')) !== -1) {
        const line = stateBuf.slice(0, nl);
        stateBuf = stateBuf.slice(nl + 1);
        const m = STATE_LINE.exec(line);
        if (!m) continue;
        const s = { t: +m[1], map: +m[2], state: +m[3], moving: +m[4], x: +m[5], y: +m[6], ang: +m[7], hp: +m[8], armor: +m[9], weapon: +m[10], attack: +m[11], use: +m[12] };
        if (engineState.prev) {
          engineState.moveTotal += Math.hypot(s.x - engineState.prev.x, s.y - engineState.prev.y);
          engineState.turnTotal += Math.abs(s.ang - engineState.prev.ang);
        }
        engineState.prev = s;
        engineState.newest = s;
        engineState.samples++;
      }
    });
  }
  state.engineState = engineState;

  child.stdio[2].on('data', (c) => (stderr += c.toString()));
  child.stdio[3].on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    let offset = 0;
    while (pending.length - offset >= FRAME_BYTES) {
      const frame = Buffer.from(pending.subarray(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
      if (state.newest) state.dropped++;
      state.newest = frame;
      state.received++;
    }
    pending = offset ? pending.subarray(offset) : pending;
  });
  child.on('close', (code, signal) => {
    fs.writeFileSync(logPath, stderr);
    state.alive = false;
    state.exitCode = code;
    state.exitSignal = signal;
    const done = /DG_HEADLESS done frames=(\d+) wall_ms=(\d+)/.exec(stderr);
    const keys = /DG_INPUT parsed=(\d+) rejected=(\d+) keys_still_held=(\d+)/.exec(stderr);
    if (keys) state.input = { parsed: +keys[1], rejected: +keys[2], stillHeld: +keys[3] };
    if (done) onStats({ engineFrames: +done[1], engineWallMs: +done[2], exitCode: code });
  });
  child.on('error', (err) => {
    state.alive = false;
    console.error(`engine error: ${err.message}`);
  });
  return state;
};

/** DG_STATE as ONE line: what the engine says the PLAYER did. Engine numbers, not pixels - a display model
 *  can never explain these away, which is exactly why `yarn doom:input-check` reads the same fields. */
const describeEngineState = (engine) => {
  const s = engine && engine.engineState;
  if (!s || !s.newest) return 'DG_STATE samples=0 (the engine reported nothing)';
  const cur = s.newest;
  return `engine t=${cur.t} map=${cur.map} hp=${cur.hp} armor=${cur.armor} weapon=${cur.weapon} atk=${cur.attack} use=${cur.use} x=${cur.x} y=${cur.y} ang=${cur.ang} moveTotal=${Math.round(s.moveTotal)} turnTotal=${Math.round(s.turnTotal)} samples=${s.samples}`;
};

const canary = (label) => {
  const res = spawnSync(process.execPath, [path.join(REPO, 'scripts/canary.cjs')], { cwd: REPO, encoding: 'utf8' });
  const out = String(res.stdout || '').trim().split('\n');
  console.log(`canary ${label}: ${out.slice(-3).join(' | ') || 'no output'}${res.status ? ` (exit ${res.status})` : ''}`);
};

const main = async () => {
  const argv = process.argv.slice(2);
  /* PLAYABLE mode (`--input remote`): the phone drives the player through src/game/doom-keys.ts. The
     DEFAULT stays the DEMO path, so every measurement in AGENTS.md is still reproducible with the same
     command; a playable run is an explicit request, never a side effect.
     One PicWidth only: AGENTS.md rejected interlacing 64/32 inside one stream (§39), and while a person is
     playing, a second phase after the first is just a longer run of the same thing. */
  const inputMode = argValue(argv, 'input', 'demo') === 'remote';
  /* ONE session name on both sides. The page (`resources/ui/app.js`) opens `?session=main`; if this default
     were a different word, the phone would POST into a session the engine never reads - and every symptom
     would look like "the controller does nothing" (that class of bug already happened once, `noSession`). */
  const inputSession = argValue(argv, 'input-session', 'main');
  const inputPoll = Math.max(20, Number(argValue(argv, 'input-poll', '80')) || 80);
  const inputTtl = Math.max(400, Number(argValue(argv, 'input-ttl', '700')) || 700);
  /* NO SECOND PROCESS. A playable run serves its OWN `/ui` + `/input` + `/hud` (src/host/server.ts,
     routes in src/http/handlers.ts): the phone and the player therefore share one origin, one broker and
     one PID. `--api` exists only to point at ANOTHER host (`--no-host` says "someone else owns /input").
     `hostRef` is closed at the end of the run so Ctrl-C really exits: node keeps keep-alive sockets open. */
  const apiFlag = String(argValue(argv, 'api', '')).replace(/\/+$/, '');
  const hostPort = Number(argValue(argv, 'port', '')) || undefined;
  let hostRef = null;
  const seconds = Number(argValue(argv, 'seconds', inputMode ? '30' : '3'));
  const playMode = seconds <= 0; // no time limit: Ctrl-C / SIGTERM ends it, same as `yarn play`
  const cropArg = argValue(argv, 'crop', 'square');
  const pushSizes = argValue(argv, 'push', inputMode ? '32' : '32,64').split(',').map(Number);
  const filter = argValue(argv, 'filter', 'box');
  /* Parsed HERE, once, and passed to startEngine as data. `--warp 1 5` needs two tokens, so the value is a
     list and it is forwarded verbatim (the form of `-warp` is not this runner's to guess - see the comment
     in startEngine). Default ['1'] = today's behaviour exactly. */
  /* A FLAG WHOSE VALUE IS A LIST MUST BE READ AS A LIST. `--warp` is exactly that case: `-warp 1 5` is TWO
   engine arguments (E1M5). `argValue()` reads ONE token, so `--warp 1 5` written unquoted - which is how a
   shell and `package.json` hand it over - silently became `-warp 1` = E1M1, the DARKEST stage in the table.
   That is the user's report of 2026-10-12 16:00: 「this arg not work... still in the dark scene, no matter
   the values」 - the flag WAS forwarded, only its second token was dropped, so every value looked identical.
   Quoting (`--warp "1 5"`) happened to work because it arrives as one token, which is why my earlier tests
   passed: a test that only covers the quoted form is not a test of the flag. */
  const argList = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const values = [];
    for (let j = i + 1; j < argv.length; j++) {
      const token = String(argv[j]);
      if (token.startsWith('--')) break; // the next flag ends this value
      values.push(...token.trim().split(/\s+/).filter(Boolean)); // a quoted "1 5" splits too, so both forms mean one thing
    }
    return values.length ? values : fallback;
  };
  const stageWarp = argList('warp', ['1']);
  /* PRINT THE DECISION AND STOP. `--warp` failed twice for two different parsing reasons (see the notes
     above argList and above startEngine), and both were invisible whenever a panel was involved: the panel
     just looked dark. A flag that chooses CONTENT must be readable on its own, so this prints what
     startEngine WOULD spawn - the same function, no second implementation - and exits touching nothing:
     no panel, no Function App, no engine, no build. */
  if (has(argv, 'print-argv')) {
    console.log(`print-argv (nothing started): ${buildEngineArgs({ input: inputMode, warp: stageWarp }).join(' ')}`);
    return;
  }
  /* HOST ONLY: the controller page + broker + hud cache, no engine and no panel. This exists because two
     questions are answerable without a game running - "is the page installable on the phone" and "does one
     process really serve every route". `yarn serve` is this branch. */
  if (has(argv, 'host-only')) {
    if (!fs.existsSync(path.join(REPO, 'dist/host/server.js'))) {
      throw new Error('dist/host/server.js is missing. Run `yarn build` first.');
    }
    const { startHost } = await loadDist('host/server.js');
    const hostRef = await startHost({ port: hostPort });
    console.log(`[host] ${hostRef.tls ? 'TLS (.gener/devcert/dev.crt + dev.key)' : 'plain http - NOT installable on Android; run `yarn cert` then restart'}`);
    console.log(`[host] page here : ${hostRef.pageUrl}`);
    hostRef.lanUrls.forEach((url) => console.log(`[host] page phone : ${url}`));
    console.log('[host] no engine, no panel: Ctrl-C closes it');
    await new Promise((resolve) => process.once('SIGINT', resolve));
    await hostRef.close();
    const s = hostRef.stats;
    console.log(`[host] closed: ${s.requests} requests, ${s.inputPosts} /input POST, ${s.hudPosts} /hud POST, ${s.rejected} refused`);
    return;
  }
  const trace = has(argv, 'trace');
    const dividerMs = Number(argValue(argv, 'divider', '1500'));
    const warm = has(argv, 'warm');
    const hold = has(argv, 'hold');
    const picidMode = argValue(argv, 'picid', process.env.PIXOO_PICID || 'epoch');
    // PICID_MODE is read once when src/pixoo/api.ts is evaluated, so this must come before the import.
    process.env.PIXOO_PICID = picidMode;
    /*
     * PicSpeed and pace are only ARGS here; the values come from src/pixoo/pacing.ts (see
     * resolvePacing below). They are applied through the production API - PixooAPI#applyPanelPacing() /
     * setPicSpeed() -> pixoo.push() -> sendBuffer() - never a hand-built request, so a measurement here
     * says something about the shipped code.
     *
     * How this pair got settled, so the defaults are not treated as guesses:
     *   • PicSpeed alone was NOT enough - the user's read of the full-rate PicSpeed 60 run at PicWidth 32
     *     was "better than 1000, but still stuttering": 172 pushes / 14.26 fps, frames queued and shown
     *     late or out of order (a frame counter that went 1,4,7,…,40 then back to 31).
     *   • Pacing fixed it: pace 120 + PicSpeed 110 measured the SAME 69 ms RTT but only 99 pushes /
     *     8.2 fps, and the user's read was "smooth, no dropped steps" (§32).
     *   • Over-pacing is its own failure mode: at PicWidth 64, pace 250 / PicSpeed 220 (3.96 fps) was
     *     read as WORSE than pace 200 / PicSpeed 180 (4.95 fps) at the same PicSpeed/pace ratio (§33).
     *     Hence: the smallest pace that removes the stepping, never a safety margin.
     */
    const picSpeedArg = String(argValue(argv, 'picspeed', 'auto')).toLowerCase();
    const paceArg = String(argValue(argv, 'pace', 'auto')).toLowerCase();
  const outDir = path.join(REPO, '.gener/doom-device');
  fs.mkdirSync(outDir, { recursive: true });

    const { PixooAPI } = await loadDist('pixoo/api.js');
    const { panelPacingFor, picSpeedForPace } = await loadDist('pixoo/pacing.js');
    /*
     * Resolve the pacing for ONE PicWidth. 'auto' takes the verified row from the panel table
     * (src/pixoo/pacing.ts) - the same table PixooAPI#applyPanelPacing() reads, so this runner and a
     * game running inside the Function App resolve to identical numbers. Explicit values always win:
     *   --pace 0        full rate (throughput only); PicSpeed then pairs with the measured RTT
          *   --pace N        your own spacing => PicSpeed = picSpeedForPace(N) = 0.8 x N (PIC_SPEED_RATIO)
     *   --picspeed N    the value as asked, 1..1000. Below 42 it is UNPROVEN (42 is the lowest value
     *                   this panel has been seen accepting, §6/§21), so the run labels itself instead
     *                   of clamping the experiment away. Measured 2026-10-11: PicSpeed 1 IS accepted,
     *                   supplies 15.35 fps at 65 ms/frame with a clean canary, and reads the same as 42
     *                   (.gener/frame-counter-speed1-32.log).
     */
  const PROVEN_PIC_SPEED_MIN = 42;
  const resolvePacing = (pushSize) => {
    const table = panelPacingFor(pushSize);
    const paceMs = paceArg === 'auto' ? table.paceMs : Math.max(0, Math.round(Number(paceArg) || 0));
    let picSpeed;
    if (picSpeedArg !== 'auto') picSpeed = Math.min(1000, Math.max(1, Math.round(Number(picSpeedArg))));
        else if (paceMs > 0 && paceMs === table.paceMs) picSpeed = table.picSpeed;
        else if (paceMs > 0) picSpeed = picSpeedForPace(paceMs);
        else picSpeed = picSpeedForPace(table.uploadCeilingMs);
        return { table, paceMs, picSpeed };
    };
  const { cropAndDownscale, doomCrop, DOOM_VIEW_HEIGHT } = await loadDist('game/scale.js');
  const settings = deviceValues();
  const origin = argValue(argv, 'origin', process.env.PIXOO_ORIGIN || settings.PIXOO_ORIGIN);
  if (!origin) throw new Error(noOriginMessage('--origin'));

  /* DOOM_MAX_FRAMES/MS are the ENGINE's own caps. A bounded run must not be cut short by them - and a
   play-mode run must not be stopped by them at all - so they are set just past what this loop enforces.
   The engine still runs at its own 35 tics/s: this runner only ever DROPS frames (see the header). */
  const wantedFrames = playMode ? 35 * 3600 : Math.max(60, Math.round((seconds + 3) * TICK_HZ));
  const engineMaxMs = playMode ? 3600000 : Math.max(120000, seconds * 1000 + 20000);
    console.log(`DOOM on device  origin=${origin}  crop=${cropArg}  filter=${filter}  phases=${pushSizes.join(',')}  ${seconds}s each`);
    console.log(
        `push path: PixooAPI.push() -> sendBuffer() (the production shape)  pacing args: picspeed=${picSpeedArg} pace=${paceArg}  (auto resolves from src/pixoo/pacing.ts, printed per phase below)`,
    );

  if (!has(argv, 'no-canary')) canary('before');

  /* PLAYABLE: the key bridge and the input client. Printed at start, because the FIRST question of any
     input bug is always "are both sides talking about the same session" (see the noSession post-mortem). */
  let bridge = null;
  let remote = null;
  let engineRef = null;
  let stopping = false;
  if (inputMode) {
    /* THE ORDER OF THREE COMMANDS IS A REAL CONSTRAINT, not a style one: `yarn build` deletes `dist/`
       before it recompiles, and the Function App discovers its functions FROM `dist/`. Building while the
       host is running made this measured run poll `/input/state` into the host's empty 404 body
       (`polls=0 err=366 lastError=Unexpected end of JSON input`) and made the controller page unreachable
       on the phone - while the panel itself stayed perfectly healthy (canary clean, 246 pushes @8.19 fps).
       So this runner never builds. The order is: build → start the host → play. */
    if (!fs.existsSync(path.join(REPO, 'dist/game/doom-keys.js'))) {
      throw new Error('dist/game/doom-keys.js is missing. Run `yarn build` FIRST, then `yarn play` (`yarn play` already does the build; `tsc` while the host is up 404s /ui/ and /input/ - that is recorded in AGENTS.md).');
    }
    /* The host starts HERE - after `--print-argv` (which must touch nothing) and before anything is asked to
       reach /input. It answers 404/400 with the reason in the body, so a missing page or a wrong session is
       never a silent failure; and with a dev cert present (.gener/devcert) it IS the TLS endpoint, which is
       what a phone needs to install the page as an app. There is no forwarder here to be missing. */
    if (!has(argv, 'no-host')) {
      const { startHost } = await loadDist('host/server.js');
      hostRef = await startHost({ port: hostPort });
      console.log(`[host] ${hostRef.tls ? 'TLS (.gener/devcert/dev.crt + dev.key)' : 'plain http - NOT installable on Android; run `yarn cert` then restart'}`);
      console.log(`[host] on this machine: ${hostRef.pageUrl}`);
      hostRef.lanUrls.forEach((url) => console.log(`[host] on the phone : ${url}`));
    }
    const apiBase = apiFlag || (hostRef ? hostRef.base : '');
    if (!apiBase) throw new Error('`--no-host` without `--api`: nothing owns /input, so the phone has nowhere to post');
    const { DoomKeyBridge } = await loadDist('game/doom-keys.js');
    const { RemoteControl } = await loadDist('game/remote-control.js');
    remote = new RemoteControl({ apiBase, session: inputSession, pollMs: inputPoll, stickTtlMs: inputTtl });
    bridge = new DoomKeyBridge({
      /* The engine's stdin, not a buffer: the bridge owns the MEANING of a line, this owns the process. */
      sink: (line) => {
        const stdin = engineRef && engineRef.child.stdin;
        if (stdin && !stdin.writableEnded) stdin.write(`${line}\n`);
      },
      stickTtlMs: inputTtl,
      horizontal: 'turn', // the only pairing proven against this engine by scripts/doom-input-check.cjs
    });
    /* This line says which PHYSICAL HALF of the phone pad produces which verb, so after the 12:41 swap it
   must read LOWER=fire / UPPER=use - a log that names the wrong half is how a control bug gets chased
   in the wrong direction. */
    console.log(`input: session=${inputSession} api=${apiBase} poll=${inputPoll}ms stickTtl=${inputTtl}ms stage=-warp ${stageWarp.join(' ')} keys=turn(arrows)+fire(LOWER tap)+use(UPPER tap)`);
    remote.start();
  }
  if (playMode) {
    /* Play mode ends on a signal. `stopping` is checked INSIDE a loop that always awaits, which is the
       difference between a process that takes Ctrl-C and one that is too busy to notice it. */
    process.once('SIGINT', () => { stopping = true; console.log('\n⏹  Ctrl-C: finishing this frame, releasing keys, closing the engine'); });
    process.once('SIGTERM', () => { stopping = true; });
  }

  const results = [];
  for (const pushSize of pushSizes) {
    const crop = doomCrop(cropArg, 64, 64);
    const dstH = cropArg === 'wide' ? Math.round((pushSize * DOOM_VIEW_HEIGHT) / 320) : pushSize;
      const pixoo = new PixooAPI(origin, pushSize);
      /*
       * Production path only: sendBuffer() reads this.picSpeed. When nothing was overridden this calls
       * the shipped helper PixooAPI#applyPanelPacing() itself, so the measurement covers the code a game
       * inside the Function App would run, not a re-implementation of it.
       */
      const { table, paceMs, picSpeed } = resolvePacing(pushSize);
      if (picSpeedArg === 'auto' && paceArg === 'auto') {
          const applied = pixoo.applyPanelPacing();
          console.log(`applyPanelPacing() (shipped helper) -> PicSpeed=${applied.picSpeed}ms  pace to hold=${applied.paceMs}ms`);
      } else {
        /*
         * PixooAPI#setPicSpeed() clamps to the proven 42..1000 band on purpose: that clamp IS the
         * production policy, so a probe must not weaken it. Below the floor the probe sets the field
         * on this instance only - which is also the concrete answer to "why can't production just
         * hard-code PicSpeed 1": the shipped client would silently turn it into 42.
         */
        const clamped = pixoo.setPicSpeed(picSpeed);
        if (clamped !== picSpeed) {
          pixoo.picSpeed = picSpeed;
          console.log(`\x1b[33m⚠️ UNPROVEN PicSpeed=${picSpeed}ms\x1b[0m - below the client floor (${clamped} returned by setPicSpeed); set on this instance for this measurement only. Lowest value previously seen accepted: ${PROVEN_PIC_SPEED_MIN}ms (§6, §21).`);
        }
        console.log(`setPicSpeed applied: ${pixoo.getPicSpeed()}ms  (override: picspeed=${picSpeedArg} pace=${paceArg})`);
      }
      console.log(
          `pacing PicWidth ${pushSize}: pace=${paceMs ? `${paceMs}ms between pushes` : 'as fast as the device answers (throughput only)'}  PicSpeed=${picSpeed}ms (panel nominal ${(1000 / picSpeed).toFixed(2)} fps)  supply ~${(1000 / (paceMs || table.uploadCeilingMs)).toFixed(2)} fps  table verifiedByEyes=${table.verifiedByEyes}`,
      );
      await pixoo.resetCounter();

      /*
       * Known-good frames first (solid colour, the exact shape scripts/baseline-4corner.cjs and
       * the Breakout runs have always made visible). This splits the failure space:
       *   colours visible + DOOM dark  -> content bug (crop/decode/resample)
       *   colours not visible         -> PicID / device acceptance, not our pixels
       */
      if (warm) {
          for (const color of [[255, 0, 0], [0, 255, 0], [0, 0, 255]]) {
              pixoo.fill(color);
              await pixoo.push();
              await new Promise((r) => setTimeout(r, 350));
          }
          console.log(`warm: solid red/green/blue pushed at PicWidth ${pushSize}`);
      }

    const engine = startEngine({
      frames: wantedFrames,
      maxMs: engineMaxMs,
      input: inputMode,
      warp: stageWarp,
      logPath: path.join(outDir, `engine-${pushSize}.log`),
      onStats: () => { },
    });
    engineRef = engine;
    if (!fs.existsSync(ENGINE)) throw new Error(`engine missing: ${ENGINE}; build with make -C scripts/doom -j8`);

    console.log(`\n=== PicWidth ${pushSize}: ${crop.width}x${crop.height}@${crop.x},${crop.y} -> ${pushSize}x${pushSize} box=${filter} ===\n`);
    const t0 = Date.now();
    /* A supply loop MUST be able to tell "there is no next frame" from "there is no next clock tick".
       In play mode (`--seconds 0`) there IS no bound, so without this a dead or silent engine reads exactly
       like a frozen panel: warm's last solid frame stays lit, the loop keeps awaiting, and NOTHING is
       printed. That is the user's report of 2026-10-12 14:18 - 「yarn doom just stopped at full blue
       screen, no hung no reboot, no proceed」 - and a blue panel with no words after it is not a diagnosis.
       So: stop, say why, and quote the engine. (The blue frame itself is now a signature: warm finished,
       no game frame was ever pushed.) */
    const NO_FRAME_TIMEOUT_MS = 10000;
    const frameDeadline = t0 + NO_FRAME_TIMEOUT_MS;
    let silenceReportAt = t0;
    let frameStarvedReason = '';
    let pushes = 0;
    let pushMs = 0;
    let slowest = 0;
    let litAvg = 0;
    let lumaAvg = 0;
    let blackFrames = 0;
    let reportAt = 0;
    while (!stopping && (playMode || Date.now() - t0 < seconds * 1000)) {
      if (bridge) {
        /* The controller is read INSIDE the supply loop, at this loop's own rate. Only the loop that
           supplies frames knows its interval - the same rule that put `applyPanelPacing()` and the paddle
           frame budget here instead of in a timer of their own. */
        bridge.applyLevel(remote.latestState());
        bridge.applyEdges(remote.takeEdges());
        if (Date.now() - reportAt >= 1000) {
          reportAt = Date.now();
          console.log(`[doomkeys] ${bridge.report()}`);
          console.log(`[input]    ${remote.report()}`);
          console.log(`[player]   ${describeEngineState(engine)}`);
        }
      }
      if (!engine.newest) {
        if (!engine.alive) {
          frameStarvedReason = `the engine exited before it produced a single frame (exit=${engine.exitCode} signal=${engine.exitSignal || 'none'})`;
          break;
        }
        if (Date.now() > frameDeadline) {
          frameStarvedReason = `the engine is still running but sent NOTHING on fd 3 for ${NO_FRAME_TIMEOUT_MS} ms`;
          break;
        }
        if (Date.now() - silenceReportAt >= 2000) {
          silenceReportAt = Date.now();
          console.log(`… still no frame from the engine: alive=${engine.alive} frames=${engine.received} ${describeEngineState(engine)}`);
        }
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      const frame = engine.newest;
      const src = decodeFrame(frame);
      const small = cropAndDownscale({ src, srcWidth: SRC_W, srcHeight: SRC_H, crop, dstWidth: pushSize, dstHeight: dstH, filter });
      const buffer = pushSize === dstH ? small : embedSquare(small, pushSize, dstH, pushSize);
        pixoo.setBuffer(buffer);
        const stats = frameStats(buffer);
        const t = Date.now();
        // Production shape, unchanged payload: PicNum 1, PicWidth=this.size, PicOffset 0, strictly
        // increasing PicID, PicSpeed=this.picSpeed. The only thing a measurement varies is PicSpeed.
        await pixoo.push();
        let dt = Date.now() - t;
        pushes++;
        pushMs += dt;
        slowest = Math.max(slowest, dt);
        litAvg += stats.litPct;
        lumaAvg += stats.avgLuma;
        if (stats.litPct < 0.5) blackFrames++;
        if (paceMs > 0) {
            // Hold the SPACING at exactly paceMs by subtracting the request itself, so a paced run and
            // a full-rate run differ in nothing else.
            await new Promise((r) => setTimeout(r, Math.max(0, paceMs - dt)));
            dt = Date.now() - t;
        }
        if (trace)
            console.log(
                `push ${pushes} frame=${engine.received} dropped=${engine.dropped} push=${dt}ms lit=${stats.litPct}% luma=${stats.avgLuma}`,
            );
    }
    const wall = Date.now() - t0;
    if (frameStarvedReason) {
      /* WHY it stopped, and the engine's own words, printed BEFORE the summary table so nobody has to read
         a table to learn that nothing was ever sent. The panel is left exactly as it is (a held blue frame
         in `--warm --hold` runs) - turning a symptom into a guess is how this stayed unexplained. */
      console.log(`\n❌ ${frameStarvedReason}`);
      console.log(`   engine said: ${engine.lastWords()}`);
      console.log(`   ${describeEngineState(engine)}`);
      console.log('   the panel still shows the last thing WE pushed (warm) - that IS the signature of "no game frame was ever sent".');
      if (engine.alive) engine.child.kill('SIGTERM');
    }

    results.push({
      pushSize,
      pushes,
      avgPushMs: +(pushMs / Math.max(1, pushes)).toFixed(1),
      slowestMs: slowest,
      measuredFps: +(pushes * 1000 / wall).toFixed(2),
      engineFramesSeen: engine.received,
      framesDropped: engine.dropped,
        gameSeconds: +(engine.received / TICK_HZ).toFixed(2),
        realSpeed: +(pushes / Math.max(1, engine.received)).toFixed(2),
        litPctAvg: +(litAvg / Math.max(1, pushes)).toFixed(1),
        lumaAvg: +(lumaAvg / Math.max(1, pushes)).toFixed(1),
        blackFrames,
    });

      /*
       * Dark pause only BETWEEN phases. After the last phase the panel keeps the final DOOM frame
       * unless --hold is off, because "the panel is black" must not be an artefact of our own
       * black-out - that is exactly what made the 2026-10-10 20:57 run ambiguous to read.
       */
      const isLast = pushSize === pushSizes[pushSizes.length - 1];
      if (!(hold && isLast)) {
          pixoo.fill([0, 0, 0]);
          await pixoo.push();
          await new Promise((r) => setTimeout(r, dividerMs));
      } else {
          console.log(`held: the last game frame stays on the panel${' '}(${pushSize})`);
      }
  }

  /* PLAYABLE end, in this order on purpose: release every key the driver is HOLDING, then close stdin so
   the driver can print its own counters. `DG_INPUT parsed=… keys_still_held=0` is the engine's own
   statement that nothing is stuck; a stuck key would read `keys_still_held>0` forever after. */
  if (bridge) {
    bridge.releaseAll('run end');
    if (engineRef && engineRef.child.stdin && !engineRef.child.stdin.writableEnded) engineRef.child.stdin.end();
    const waitUntil = Date.now() + 15000;
    while (engineRef && engineRef.alive && engineRef.input === null && Date.now() < waitUntil) await new Promise((r) => setTimeout(r, 50));
    await remote.stop();
    console.log(`\n[doomkeys] ${bridge.report()}`);
    console.log(`[player]   ${describeEngineState(engineRef)} engineExit=${engineRef ? engineRef.exitCode : 'unknown'}`);
    const counters = engineRef && engineRef.input ? JSON.stringify(engineRef.input) : 'DG_INPUT not seen (the engine did not exit in time)';
    /* The two halves compared, because that is the only way to name the broken one: the lines THIS process
       wrote vs what the ENGINE did with them. A POST, an HTTP 200 and `error_code:0` all prove nothing. */
    const moved = engineRef && (engineRef.engineState.moveTotal > 0 || engineRef.engineState.turnTotal > 0);
    console.log(
      bridge.stats.lines > 0
        ? moved
          ? `✅ bridge wrote ${bridge.stats.lines} key lines AND the engine moved the player (${counters})`
          : `❌ bridge wrote ${bridge.stats.lines} lines but the player NEVER moved - the break is between this process and fd 0 (${counters})`
        : `⚠️ the bridge wrote NO key lines: nothing usable reached it from the phone (${counters})`,
    );
  }

  /* The phone may still be polling; stop the host last so a shutdown never looks like a broken controller. */
  if (hostRef) {
    await hostRef.close();
    const s = hostRef.stats;
    console.log(`[host] closed: ${s.requests} requests, ${s.inputPosts} /input POST, ${s.hudPosts} /hud POST, ${s.rejected} refused`);
  }

  if (!has(argv, 'no-canary')) canary('after');

    console.log(`picid mode=${picidMode}  warm=${warm ? 'yes' : 'no'}  hold=${hold ? 'yes' : 'no'}`);
    console.log('\npush  pushes  fps    avg push  slowest  engine frames  dropped  game s  lit%  avg luma  black frames');
    for (const r of results) {
        console.log(
            `${String(r.pushSize).padStart(5)} ${String(r.pushes).padStart(7)} ${String(r.measuredFps).padStart(6)} ${String(r.avgPushMs).padStart(9)}ms ${String(r.slowestMs).padStart(7)}ms ${String(r.engineFramesSeen).padStart(14)} ${String(r.framesDropped).padStart(8)} ${String(r.gameSeconds).padStart(7)} ${String(r.litPctAvg).padStart(5)} ${String(r.lumaAvg).padStart(9)} ${String(r.blackFrames).padStart(13)}`,
        );
    }
    console.log('\nIf lit% is well above 0 and the panel still stayed dark, the frames we sent were lit => the device did not play them (PicID/acceptance), not a rendering bug.');
  console.log('\nCompare on the panel: 64 is the true pixel grid but ~7 fps; 32 is the same panel filled by the device while we can send ~16 fps.');
  console.log('Local preview of exactly these frames: .gener/doom-preview/preview.html');
};

main().catch((err) => {
  console.error(err.message || err);
  /* An error mid-run must END the process. `process.exitCode = 1` alone leaves whatever the run had already
     started alive: an input poll (an interval) and a device holding the last frame WE pushed. That is what
     the user saw as 「stayed at blue, no hung no reboot, no proceed」 - half a program running, panel lit,
     nothing proceeding, and one line of error nobody reads off a panel. The delay only lets piped output
     flush before the hard exit. */
  console.error('❌ the runner stopped with an error. The panel is still holding the LAST frame we pushed - that IS the signature of a failure before any game frame was sent.');
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 400);
});
