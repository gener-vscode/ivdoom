#!/usr/bin/env node
/*
 * THE MAPPING, PROVEN AS LINES - no engine, no phone, no panel.
 * `yarn doom:input-check` proves the ENGINE accepts these lines; this proves the bridge WRITES the
 * right ones. Split on purpose: a mapping test that also runs an engine cannot tell you which half
 * broke, and that is exactly the ambiguity that cost a whole day on the paddle ("noSession" looked
 * identical to "frozen level").
 *
 * Every case is a line diff, so a stuck key / a missing release cannot pass.
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const dist = (p) => pathToFileURL(path.join(__dirname, '..', 'dist', p)).href;
  const { DoomKeyBridge, DOOM_KEYS } = await import(dist('game/doom-keys.js'));
  const K = DOOM_KEYS;

  const stick = (x, y, ageMs = 0) => ({
    stick: {
      active: true, id: 'stick', x, y, magnitude: Math.hypot(x, y),
      direction: 'none', claimedDirection: 'none', source: 'touchLeft',
      updatedAt: Date.now() - ageMs,
    },
  });
  const edge = (kind, description) => [{ kind, seq: 1, at: Date.now(), description, source: 'touchLeft' }];

  const results = [];
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    results.push({ name, ok, got, want });
    console.log(`${ok ? '✅' : '❌'} ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
    return ok;
  };

  let lines = [];
  const bridge = new DoomKeyBridge({ sink: (line) => lines.push(line), stickTtlMs: 700 });
  const run = (fn) => { lines = []; fn(); return lines; };

  /* A thumb straight UP must WALK. `directionToAxis('up').x === 0` is the bug that froze the paddle:
     if this case fails, DOOM has inherited it. */
  check('up = forward, and a repeated level presses nothing again',
    run(() => { bridge.applyLevel(stick(0, -1)); bridge.applyLevel(stick(0, -1)); }),
    [`1 ${K.up}`]);

  /* A diagonal walks AND turns: each axis decides for itself, nothing is dropped because the thumb
     landed between two octants. */
  check('diagonal keeps walking and adds a turn',
    run(() => bridge.applyLevel(stick(-0.7, -0.7))),
    [`1 ${K.left}`]);
  check('the forward key from the previous sample is still held (no re-press)', bridge.stats.keysDown === 2 && bridge.stats.keysUp === 0, true);

  /* Pure horizontal: the walk key is released, the turn stays. */
  check('horizontal-only releases the walk key and keeps turning',
    run(() => bridge.applyLevel(stick(-0.9, 0))),
    [`0 ${K.up}`]);

    /* Inside the dead zone = no intent at all. ⚠️ My first expectation here was 'r' and it was WRONG
       (a test bug, not a mapping bug): a LEVEL that loses its intent is released key BY key through the
       same diff that any other change goes through; `r` is reserved for "the level is gone" (no session,
       stale, clear), which is a different event - exactly the LEVEL-vs-EDGE separation this whole repo
       runs on. Correcting the expectation is what makes that distinction visible in the test. */
    check('dead zone releases the held key and presses nothing',
        run(() => bridge.applyLevel(stick(0.1, 0.1))),
        [`0 ${K.left}`]);

  /* A LEVEL that is too old must stop DOOM, not keep it walking (same TTL as the paddle). */
  check('stale level = release all',
    run(() => bridge.applyLevel(stick(0, -1, 4000))),
    []);
  check('a missing session releases everything exactly once',
    run(() => { bridge.applyLevel(stick(0, -1)); bridge.applyLevel(undefined); }),
    [`1 ${K.up}`, 'r']);

  /* A tap is a press AND a release - DOOM has no edge concept, so an unreleased key is a stuck key. */
  check('tap = FIRE press+release', run(() => { bridge.applyEdges(edge('action', 'action primary')); bridge.flushTaps(Date.now() + 200); }), [`1 ${K.fire}`, `0 ${K.fire}`]);
  check('secondary (slide / E / Q) = USE press+release', run(() => { bridge.applyEdges(edge('action', 'action altDown')); bridge.flushTaps(Date.now() + 200); }), [`1 ${K.use}`, `0 ${K.use}`]);
    /* The phone's action pad is split in two halves (the user's control choice of 2026-10-12, reversed at
     12:41): the LOWER half is `primary`, the UPPER half is `secondary`. These cases name the WIRE TERM and
     never the half - the half is resources/ui/app.js's geometry. Both halves are taps, so both must press
     AND release. */
    check('upper-half tap (secondary) = USE press+release', run(() => { bridge.applyEdges(edge('action', 'action secondary')); bridge.flushTaps(Date.now() + 200); }), [`1 ${K.use}`, `0 ${K.use}`]);
    check('select is counted, NOT invented as a key', run(() => bridge.applyEdges(edge('select', 'select next'))), []);
  check('clear stops movement', run(() => { bridge.applyLevel(stick(1, 0)); bridge.applyEdges(edge('clear', 'clear')); }), [`1 ${K.right}`, 'r']);

  /* The account: every press is matched, and nothing is left held. */
  const linesTotal = bridge.stats.lines;
    /* The account, in the bridge's own numbers: every movement press is matched by a release (`r` counts
     as the release of everything it was holding), and a tap contributes its press AND its release - so
     the total line count must be derivable from the counters, with nothing left held. A one-line
     formula that mixed taps into keysUp would pass while the mapping stuck a key. */
    /* A TAP IS A HELD KEY NOW (press now, release at least one engine tic later - see `tap` in
       src/game/doom-keys.ts and scripts/doom-tap-check.cjs), so it is accounted for exactly like a movement
       key: `keysDown` and `keysUp` already include every tap. That makes this check STRICTER than before, not
       looser: a fire key that never got released would show here as down != up, where the old formula hid it
       inside a separate `+ 2 * (fire + use)` term. */
    const balanced =
        bridge.stats.keysDown === bridge.stats.keysUp &&
        bridge.stats.lines === bridge.stats.keysDown + bridge.stats.keysUp &&
        bridge.stats.fire + bridge.stats.use === 3;
  const nothingHeld = /held=-/.test(bridge.report());
  check('every press is matched by a release, nothing left held', [balanced, nothingHeld], [true, true]);
  console.log(bridge.report());

  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length}`);
  console.log(failed.length ? `FAIL ${failed.map((f) => f.name).join(' | ')}` : `✅ DONE (${linesTotal} lines total across the bridge's life)`);
  process.exit(failed.length ? 1 : 0);
})();
