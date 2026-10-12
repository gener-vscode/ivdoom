#!/usr/bin/env node
/*
 * DOES THE CONTROLLER'S INPUT REACH THE ENGINE?  Measured on the engine's OWN numbers.
 *
 * Instrument history - all three versions, because the reason for v2 is the lesson:
 *   v1  pixel diff per frame, no warm-up  -> "idle" 1,014,323/frame: that was the -warp level
 *      transition, not the map.  Meaningless.
 *   v2  pixel diff per frame, 4 s warm-up -> idle 9,718 vs held turn+walk 11,469 (x1.18).
 *      The map's own animation is bigger than what a held key does to the view. A FRAME cannot
 *      answer this question, no matter how it is sampled.
 *   v3  (this file) `DG_STATE` on fd 4 (see scripts/doom/dg_stdio.c): `players[consoleplayer]`.
 *
 * WHY BUCKETS ARE GAME TICS AND NOT WALL CLOCK (measured 2026-10-12, raw dump of the same wire):
 *   t=1..65    x=-27262976 y=16777216 ang=0        atk=0   <- a standing player is EXACTLY still
 *   t=75..175  x,y move; ang 0 -> 188743680 -> ... -> 46137344   atk=1  <- keys held: it turns
 *   t=195..255 momentum decays, then x,y,ang constant again      atk=0  <- `r` really released
 * A wall-clock phase boundary is a guess about the engine's clock; `t` is the engine's clock. Same
 * rule as the pacing table: only the loop that owns an interval may measure against it.
 *
 * No panel, no phone, no network.   node scripts/doom-input-check.cjs
 */
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENGINE = path.join(__dirname, '..', '.gener/build/doom/doom-headless');
const WAD_DIR = path.join(__dirname, '..', '.gener/wad');
/* `doomkeys.h`, sent through the engine's identity `TranslateKey()`. */
const KEY_LEFTARROW = 0xac;
const KEY_UPARROW = 0xad;
const KEY_FIRE = 0xa3;

const baselineTics = 60; /* must be exactly still */
const heldTics = 120; /* must move and turn */
const releasedTics = 120; /* must return to exactly still */

const child = spawn(ENGINE, ['-file', 'freedoom1.wad', '-nomusic', '-nosound', '-warp', '1'], {
  cwd: WAD_DIR,
  /* fd0 = keys IN, fd3 = frames (not needed here), fd4 = DG_STATE - the instrument. */
  stdio: ['pipe', 'ignore', 'pipe', 'ignore', 'pipe'],
    /* The phases need ~300 game tics = ~9-10 s of real DOOM time. Letting the engine reach its OWN
   * time limit (instead of killing it) is what makes it print `DG_INPUT parsed=… rejected=…` - the
   * driver's own account of the input wire, which a killed process never gets to say. */
    env: { ...process.env, DOOM_MAX_MS: '20000', DOOM_MAX_FRAMES: '0', DOOM_MAX_TPS: '35' },
});

const parse = (line) => {
  const out = {};
  for (const m of line.matchAll(/(\w+)=(-?\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
};

const run = { phase: 'baseline', phaseStart: null, prev: null, samples: 0, lines: [] };
const stats = { baseline: blank(), held: blank(), released: blank() };
function blank() {
    return { n: 0, moveTotal: 0, lastMove: 0, turnTotal: 0, atkSamples: 0, quietAt: null, lateAtk: 0, tics: 0, identicalTails: 0 };
}

let pending = '';
let stderr = '';
child.stdio[2].on('data', (c) => (stderr += c.toString()));
child.stdio[4].on('data', (chunk) => {
  pending += chunk.toString('latin1');
  let cut;
  while ((cut = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, cut);
    pending = pending.slice(cut + 1);
    if (line.startsWith('DG_STATE')) handle(parse(line));
  }
});

const keyDown = () => child.stdin.write(`1 ${KEY_LEFTARROW}\n1 ${KEY_UPARROW}\n1 ${KEY_FIRE}\n`);
const keyUp = () => child.stdin.write('r\n');

function handle(s) {
  if (s.mo !== 1) return;
  if (run.phaseStart === null) run.phaseStart = s.t;
  const b = stats[run.phase];
  b.tics = s.t - run.phaseStart;
  if (run.prev) {
    b.n++;
    const moved = Math.hypot(s.x - run.prev.x, s.y - run.prev.y);
    b.moveTotal += moved;
    b.lastMove = moved;
    b.turnTotal += Math.abs(s.ang - run.prev.ang);
    if (moved === 0 && s.ang === run.prev.ang) b.identicalTails++;
      /* Measured in the raw dump: the engine's own FIRST state samples carry `atk=1` (t=1, t=10)
   * before any key could possibly have arrived. So in a no-input phase the claim that actually
   * matters is "once the button has gone quiet with nothing sent, IT STAYS QUIET" - a violation is
   * counted only after the first quiet sample, never against the engine's start state. */
      const button = Boolean(s.atk || s.use);
      if (run.phase === 'held') {
          if (button) b.atkSamples++;
      } else {
          if (!button && b.quietAt === null) b.quietAt = s.t;
          else if (b.quietAt !== null && button) b.lateAtk++;
      }
  }
  run.prev = s;
  run.samples++;

  if (run.phase === 'baseline' && b.tics >= baselineTics) {
    console.log(`-> baseline done at engine tic ${s.t}: keys DOWN (left + forward + fire)`);
    keyDown();
    run.phase = 'held';
    run.phaseStart = s.t;
  } else if (run.phase === 'held' && b.tics >= heldTics) {
    console.log(`-> held done at engine tic ${s.t}: release ALL (the 'r' line)`);
    keyUp();
    run.phase = 'released';
    run.phaseStart = s.t;
  } else if (run.phase === 'released' && b.tics >= releasedTics) {
      child.stdin.end(); /* let the engine finish by itself and report DG_INPUT */
  }
}

child.on('exit', (code) => {
  const show = (name) => {
    const s = stats[name];
      return `${name.padEnd(8)} samples=${String(s.n).padStart(3)} engineTics=${String(s.tics).padStart(3)} moveTotal=${Math.round(s.moveTotal)} lastMove=${Math.round(s.lastMove)} turnTotal=${Math.round(s.turnTotal)} stillSamples=${s.identicalTails} buttonDown=${s.atkSamples} quietFromTic=${s.quietAt} buttonAfterQuiet=${s.lateAtk}`;
  };
  console.log(`engine exit=${code} stateSamples=${run.samples}`);
  for (const name of ['baseline', 'held', 'released']) console.log(show(name));
  const base = stats.baseline;
  const held = stats.held;
  const rel = stats.released;
  /* A standing player is EXACTLY constant in x, y and angle (proven by the raw dump), so
   * "baseline must be zero" is a strict test, not a tolerance. `buttonDownSamples` is the engine's
   * own `attackdown` - a second, independent field making the same claim as the turning. */
  const ok =
    base.n >= 5 && held.n >= 5 && rel.n >= 5 &&
      base.moveTotal === 0 && base.turnTotal === 0 && base.quietAt !== null && base.lateAtk === 0 &&
      held.turnTotal > 100000 && held.moveTotal > 10000 && held.atkSamples > 0 &&
      rel.lastMove === 0 && rel.turnTotal < held.turnTotal * 0.2 && rel.quietAt !== null && rel.lateAtk === 0;
  console.log(
    ok
      ? `✅ input reaches the engine: held keys turned the view ${Math.round(held.turnTotal)} angle-units and moved ${Math.round(held.moveTotal)} map units, the engine reported its own fire button on ${held.atkSamples} samples, and after 'r' the player came to a complete stop (last sample identical to the previous one)`
      : `❌ input NOT proven (baseline move/turn=${base.moveTotal}/${base.turnTotal} held move/turn=${Math.round(held.moveTotal)}/${Math.round(held.turnTotal)} button=${held.atkSamples} released lastMove=${Math.round(rel.lastMove)} turn=${Math.round(rel.turnTotal)})`,
  );
  const notes = stderr.split('\n').filter((l) => l.startsWith('DG_'));
  if (notes.length) console.log(notes.join('\n'));
  process.exit(ok ? 0 : 1);
});
