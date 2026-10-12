#!/usr/bin/env node
'use strict';
/**
 * ─── THE `--warp` FLAG IS CHECKED AS A FLAG, NOT AS A CLAIM ────────────────────────────────────────────
 *
 * WHY THIS EXISTS. `-warp` is the ONE argument of this runner whose value is MORE THAN ONE TOKEN, because
 * DOOM itself takes `<episode> <map>` for this WAD (proven from its own DG_STATE: `-warp 1 3` really is
 * map 3, spawn -51642368,-14155776). Both failures of 2026-10-12 were in exactly that shape, and neither
 * was visible on the wire:
 *   1. `argValue(argv,'warp')` reads ONE token, so `--warp 1 5` written the way a shell or package.json
 *      hands it over (UNQUOTED) became `-warp 1` = E1M1 = the DARKEST stage in the table (mean luma 29.9).
 *      The user's report was 「this arg not work… still in the dark scene, no matter the values」 and they
 *      were right: every value dropped its second token, so every value LOOKED identical.
 *   2. My earlier "verification" re-implemented the parser in the test instead of calling the shipped one.
 *      So this check parses NOTHING itself: it runs `scripts/doom-device.cjs --print-argv`, which prints the
 *      array `startEngine` would spawn, and asserts on THAT. The only difference between the printed line
 *      and a real run is the word `spawn()`, and both come from the same `buildEngineArgs()`.
 *
 * THE OTHER HALF OF THIS STORY - THE LAUNCHER - DOES NOT EXIST HERE. In the dashboard repo `yarn doom` routed
 * through `run-both.cjs`, and that file's arg splitter skipped the token after EVERY flag it owns, including
 * the valueless ones (`--dry-run --warm` ate `--warm`, `--log-all --push 64` would have handed the game a bare
 * `64`). The rules it broke are still rules here - a valueless flag owns nothing, a flag is never forwarded as
 * a value, the FIRST match wins - but in ivdoom `yarn play` IS the command: nothing sits between you and the
 * runner. So the launcher cases below only run if a launcher is present (they print SKIPPED here), and in
 * their place this file checks the two things this repo really can get wrong: a `--print-argv` run must bind
 * no port and start no host, and `--no-host` without `--api` must fail out loud instead of leaving a phone
 * posting into nowhere. Those two need `dist/`, which `yarn doom:warp-check` builds first.
 *
 * Nothing here touches the device, the engine, `dist/` or port 7071 - so it can run at any time, in any
 * order, even while the Function App is up, and it needs no build. Zero imports beyond node builtins.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const RUNNER = path.join(REPO, 'scripts/doom-device.cjs');
const LAUNCHER = path.join(REPO, 'scripts/run-both.cjs');

const run = (script, args) => {
    const res = spawnSync(process.execPath, [script, ...args], { cwd: REPO, encoding: 'utf8' });
  return { out: `${res.stdout || ''}${res.stderr || ''}`, status: res.status };
};

/* The engine must never receive a TWO-dash flag: that would mean a value was forwarded as a flag.
   `--playdemo` likewise never belongs to a playable run. Both are invariants, applied to every case. */
const NEVER = ['--warp', '-playdemo'];

const cases = [
  { label: 'UNQUOTED `--warp 1 5` (the form a shell / package.json hands over) -> `-warp 1 5`', flags: ['--input', 'remote', '--warp', '1', '5'], want: ['-warp 1 5'], reject: ['-warp 1 3'] },
  { label: 'QUOTED `--warp "1 5"` (arrives as ONE token) -> the SAME `-warp 1 5`', flags: ['--input', 'remote', '--warp', '1 5'], want: ['-warp 1 5'] },
  { label: '`--warp 1 3` (the value the USER typed into package.json) -> `-warp 1 3`', flags: ['--input', 'remote', '--warp', '1', '3'], want: ['-warp 1 3'] },
  { label: 'NO `--warp` -> `-warp 1`: today default, so every recorded frame number stays reproducible', flags: ['--input', 'remote'], want: ['-warp 1'] },
  { label: 'a LIST value STOPS at the next flag: `--warp 1 5 --seconds 20`', flags: ['--input', 'remote', '--warp', '1', '5', '--seconds', '20', '--print-argv'], want: ['-warp 1 5'], reject: ['20'] },
  { label: 'a LIST value STOPS at the next flag: `--warp 1 9 --push 32`', flags: ['--input', 'remote', '--warp', '1', '9', '--push', '32', '--print-argv'], want: ['-warp 1 9'], reject: ['32'] },
  { label: '`--warp 2` stays VERBATIM (this runner never rebuilds the form, never guesses the mode)', flags: ['--input', 'remote', '--warp', '2'], want: ['-warp 2'] },
    { label: '`--warp` followed by another flag -> the proven default `-warp 1` (never an empty value list)', flags: ['--input', 'remote', '--warp', '--seconds', '20', '--print-argv'], want: ['-warp 1'] },
    /* Every option in this repo is read with indexOf(), so the FIRST match wins. That is a documented rule, and
       it is the reason a default written in package.json can only be changed by editing it. */
    { label: 'DUPLICATED flag: FIRST match wins (`--warp 1 5 -- --warp "1 3"`) - so a package.json default is NOT overridden by a `--` suffix', flags: ['--input', 'remote', '--warp', '1', '5', '--', '--warp', '1 3'], want: ['-warp 1 5'], reject: ['-warp 1 3'] },
  /* The DEMO path must not change at all: every frame number in AGENTS.md was measured through it. */
  { label: 'DEMO path unchanged: without `--input remote` it is `-playdemo DEMO1`, no `-warp`', flags: [], want: ['-playdemo DEMO1'], reject: ['-warp'], never: ['--warp'] },
  /* `whole: true` asserts on the FULL output, because what matters is what a run does NOT print. A flag that
     only prints a decision must not quietly bind port 8443 - `yarn play` owns that port and a second listener
     is how EADDRINUSE gets blamed on the game. */
  { label: '`--print-argv` starts NOTHING in a repo where the runner owns the host: no port, no [host] line', flags: ['--input', 'remote', '--print-argv'], want: ['print-argv'], reject: ['[host]', 'engine argv', 'EADDRINUSE'], whole: true },
  /* The mistake this catches is the one that would otherwise appear much later, on the phone, as "the
     controller does nothing": `--no-host` says "someone else owns /input" and `--api` says who. */
  { label: '`--no-host` WITHOUT `--api` FAILS with the reason named (no host, no silent 404 for the phone)', flags: ['--input', 'remote', '--no-host', '--no-canary', '--seconds', '1'], want: [], fail: 'nothing owns /input', noPrint: true },
];

let failed = 0;
console.log('PART 1 - `--print-argv`: the engine command line startEngine WOULD spawn (nothing started: no panel, no host, no engine)');
for (const c of cases) {
  /* `--print-argv` is appended BY THIS CHECK, not by the cases, so that "every case runs the shipped
     printer" is a property of the check. `noPrint: true` is the one exception: a case that expects the runner
     to REACH a later stage (and fail there) must not be short-circuited by the printer. */
  const args = c.noPrint ? c.flags : c.flags.concat(['--print-argv']);
  const { out, status } = run(RUNNER, args);
  const line = out.split('\n').find((l) => l.startsWith('print-argv')) || (out.trim().split('\n').pop() || '(no output)');
  const hay = c.whole ? out : line;
  const banned = [...(c.reject || []), ...(c.never ?? NEVER)].filter((token) => hay.includes(token));
  const missing = (c.want || []).filter((token) => !hay.includes(token));
  /* A case may EXPECT a failure and names the reason it must print: an exit code alone would pass for the
     wrong reason (a missing WAD, a missing build, a typo in another flag). */
  const expectsFailure = Boolean(c.fail);
  const namedTheReason = expectsFailure && out.includes(c.fail);
  const ok = expectsFailure
    ? status !== 0 && namedTheReason && !banned.length
    : status === 0 && !missing.length && !banned.length;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${c.label}`);
  console.log(`   ${line}`);
  if (missing.length) console.log(`   ❌ expected and MISSING: ${missing.join(' | ')}`);
  if (banned.length) console.log(`   ❌ must NOT appear: ${banned.join(' | ')}`);
  if (expectsFailure && !namedTheReason) console.log(`   ❌ expected a failure naming: ${c.fail}`);
  if (!expectsFailure && status !== 0) console.log(`   ❌ exit ${status}`);
}

console.log('\nPART 2 - the launcher half: kept so the rules survive, SKIPPED when this repo has no launcher');
/* The guard must cover the LOOP, not only the notice: running cases against a script that does not exist
   produces four failures that mean nothing, and a failing check that means nothing is worse than no check
   (it teaches you to ignore this file). */
const RUN_LAUNCHER = fs.existsSync(LAUNCHER);
if (!RUN_LAUNCHER) {
  console.log(`⏭️  SKIPPED: no ${LAUNCHER} here. In ivdoom \`yarn play\` IS the command, so those cases would describe a file that does not exist - a check of an absent thing proves nothing.`);
}
const launcherCases = [
  {
    label: 'what `yarn doom` does: --game doom --dry-run --warm --hold --seconds 0 --warp 1 5',
    flags: ['--game', 'doom', '--dry-run', '--warm', '--hold', '--seconds', '0', '--warp', '1', '5'],
    must: ['scripts/doom-device.cjs', '--input remote', '--input-session main', '--warm', '--hold', '--seconds 0', '--warp 1 5'],
    mustNot: [],
    note: 'a VALUELESS own flag (--dry-run) must not eat the next game flag (--warm)',
  },
  {
    label: 'a boolean own flag in front of a list-valued game flag: --log-all --dry-run --push 64',
    flags: ['--game', 'doom', '--log-all', '--dry-run', '--push', '64'],
      must: ['--push 64', 'scripts/doom-device.cjs'],
    mustNot: [],
    note: 'same class: --log-all owns nothing to skip',
  },
  {
    label: 'the user\'s own `--input` wins over the launcher default: -- --input ai',
    flags: ['--dry-run', '--game', 'breakout', '--', '--input', 'ai'],
    must: ['scripts/play-breakout.cjs', '--input ai'],
    mustNot: ['--input remote'],
    note: 'argValue() reads the FIRST match, so the launcher must not inject one at all',
  },
  {
    label: 'no --input named -> the launcher still supplies --input remote (that is this file\'s purpose)',
    flags: ['--dry-run', '--game', 'breakout', '--headless', '--seconds', '8'],
    must: ['scripts/play-breakout.cjs', '--input remote', '--headless', '--seconds 8'],
    mustNot: ['--input-session'],
    note: 'and --input-session main is a DOOM-only fix (Breakout already defaults to main both sides)',
  },
];
/* The guard covers the LOOP, not only the notice: iterating cases against a script that does not exist would
   add four meaningless failures, and a check that fails for no reason teaches you to ignore this file. */
for (const c of RUN_LAUNCHER ? launcherCases : []) {
  const { out, status } = run(LAUNCHER, c.flags);
  const gameLine = out.split('\n').find((l) => l.includes('[dry-run] game')) || '(no dry-run line)';
  const missing = c.must.filter((token) => token && !gameLine.includes(token));
  const present = c.mustNot.filter((token) => gameLine.includes(token));
  const startedNothing = out.includes('nothing started');
  const ok = status === 0 && startedNothing && !missing.length && !present.length;
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${c.label}`);
  console.log(`   ${gameLine}`);
  if (!startedNothing) console.log('   ❌ it started something - a dry run must touch no host, no port, no panel');
  if (missing.length) console.log(`   ❌ expected and MISSING: ${missing.join(' | ')}`);
  if (present.length) console.log(`   ❌ must NOT appear: ${present.join(' | ')}`);
  if (status !== 0) console.log(`   ❌ exit ${status}`);
}

console.log(`\n${failed ? `❌ ${failed} check(s) FAILED` : '✅ every `--warp` / flag-routing check passed'}`);
console.log('What this does NOT prove: that the ENGINE reaches that map (scripts/doom-stage-probe.cjs proves that, from the engine\'s own DG_STATE map=), nor what the panel looks like (only you can read that).');
process.exit(failed ? 1 : 0);
