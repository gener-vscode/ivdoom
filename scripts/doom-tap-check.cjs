#!/usr/bin/env node
/*
 * DOES A TAP FIRE?  A tap is `1 163` then `0 163`.  If BOTH lines are in the same read batch, the engine
 * sees a press and a release before it builds its tic command - net state "not pressed". This is the ONE
 * difference between walking (a LEVEL: the key stays down across tics, and the user can walk ✅) and
 * firing (an EDGE: press+release written together).
 *
 * A/B against the real engine, judged by DG_STATE's OWN `atk` (players[consoleplayer].attackdown) - not by
 * frames, not by a POST.  Same instrument and same rules as scripts/doom-input-check.cjs:
 *   - phases are separated by time BUT the judgement only counts samples, and the engine's first samples
 *     carry atk=1 by itself, so nothing is counted before the first observed-quiet sample;
 *   - the engine keeps its own 35 tics/s clock; we only write key lines.
 *
 *   node scripts/doom-tap-check.cjs            (no panel, no phone, no network, nothing built)
 */
const path = require('node:path');
const { spawn } = require('node:child_process');

const ENGINE = path.join(__dirname, '..', '.gener/build/doom/doom-headless');
const WAD_DIR = path.join(__dirname, '..', '.gener/wad');
const KEY_FIRE = 0xa3;
const TAPS = 12;
const GAP_MS = 400; /* one tap per 400 ms: the samples are ~143 ms apart (5 tics at 35 tps), so a held key cannot hide */
const HELD_MS = 120; /* ~4 engine tics: longer than one tic, which is the whole question */
const RUN_MS = 30000;

const child = spawn(ENGINE, ['-file', 'freedoom1.wad', '-nomusic', '-nosound', '-warp', '1'], {
  cwd: WAD_DIR,
  stdio: ['pipe', 'ignore', 'pipe', 'ignore', 'pipe'],
  env: { ...process.env, DOOM_MAX_MS: String(RUN_MS), DOOM_MAX_FRAMES: '0', DOOM_MAX_TPS: '35' },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let phase = 'warm';
let stderr = '';
let pending = '';
const stats = { warm: blank(), sameBatch: blank(), heldThenRelease: blank() };
function blank() { return { samples: 0, atkSamples: 0, atkMaxRun: 0, run: 0, quietAt: null, firstAtkTic: null, lastTic: 0 }; }

child.stdio[2].on('data', (c) => (stderr += c.toString()));
child.stdio[4].on('data', (chunk) => {
  pending += chunk.toString('latin1');
  let nl;
  while ((nl = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    const s = {};
    for (const m of line.matchAll(/(\w+)=(-?\d+)/g)) s[m[1]] = Number(m[2]);
    if (!s.t) continue;
    const b = stats[phase];
    b.samples++;
    b.lastTic = s.t;
    /* The engine's own opening samples carry atk=1: only judge after the first observed quiet. */
    if (b.quietAt === null) {
      if (s.atk === 0) b.quietAt = s.t;
      else continue;
    }
    if (s.atk > 0) {
      b.atkSamples++;
      b.run++;
      b.atkMaxRun = Math.max(b.atkMaxRun, b.run);
      if (b.firstAtkTic === null) b.firstAtkTic = s.t;
    } else b.run = 0;
  }
});

const main = async () => {
  phase = 'warm';
  await sleep(4000);

  phase = 'sameBatch';
  for (let i = 0; i < TAPS; i++) {
    child.stdin.write(`1 ${KEY_FIRE}\n0 ${KEY_FIRE}\n`); /* ONE write: the press and its release in the same batch */
    await sleep(GAP_MS);
  }

  await sleep(1500);

  phase = 'heldThenRelease';
  for (let i = 0; i < TAPS; i++) {
    child.stdin.write(`1 ${KEY_FIRE}\n`);
    await sleep(HELD_MS);
    child.stdin.write(`0 ${KEY_FIRE}\n`);
    await sleep(Math.max(120, GAP_MS - HELD_MS));
  }

  child.stdin.end();
  const until = Date.now() + 20000;
  while (child.exitCode === null && Date.now() < until) await sleep(100);

  const input = /DG_INPUT parsed=(\d+) rejected=(\d+) keys_still_held=(\d+)/.exec(stderr);
  const a = stats.sameBatch;
  const b = stats.heldThenRelease;
  console.log(`same-batch  press+release : samples=${a.samples} atkSamples=${a.atkSamples} longestHeldRun=${a.atkMaxRun} firstAtkTic=${a.firstAtkTic}`);
  console.log(`held ${HELD_MS}ms then release : samples=${b.samples} atkSamples=${b.atkSamples} longestHeldRun=${b.atkMaxRun} firstAtkTic=${b.firstAtkTic}`);
  console.log(`engine said: ${input ? JSON.stringify({ parsed: +input[1], rejected: +input[2], stillHeld: +input[3] }) : 'DG_INPUT not seen'} exit=${child.exitCode}`);
  console.log(`lines written: same-batch ${TAPS * 2} + held ${TAPS * 2} = ${TAPS * 4}`);

  if (a.atkSamples === 0 && b.atkSamples > 0) {
    console.log('✅ A tap as written today does NOT reach attackdown, and the SAME key does when its release is delayed by more than one engine tic.');
    console.log('   => a tap must press NOW and release LATER, at least one engine tic later (1/35 s = 28.6 ms).');
    process.exit(0);
  }
  if (a.atkSamples > 0) {
    console.log('❌ the assumption is wrong: a same-batch press+release DOES reach the engine. The reason "no gun" is somewhere else.');
    process.exit(1);
  }
  console.log('❌ neither shape fired: the break is not in the press/release timing.');
  process.exit(1);
};

main().catch((err) => {
  console.error(`check failed: ${err.message}`);
  process.exit(1);
});
