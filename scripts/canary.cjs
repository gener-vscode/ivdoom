#!/usr/bin/env node
'use strict';

/**
 * Device liveness canary — Channel/GetIndex, the only command this firmware answers
 * for status (see the livenessProbe note in scripts/pixoo-protocol.cjs).
 *
 * Run it BEFORE and AFTER any device run:
 *   node scripts/canary.cjs
 *   node scripts/canary.cjs --label after
 *
 * What the numbers mean (all measured on this panel, .gener/t0-findings.md):
 *   ~30-70ms      clean device, nobody else talking to it
 *   ~200-1000ms   DEGRADED, not "clean". Seen after a long run of grouped-animation
 *                 payloads (PicNum/Draw-CommandList streams): the HTTP server answers but
 *                 takes ~10x longer. A frame-rate measurement taken in this state is NOT
 *                 comparable with a clean-baseline run, so it must be labelled as such.
 *   3000-7000ms  a second client (Azure Function App / timer trigger) is hammering
 *                the same /post endpoint -> do not trust anything measured now
 *   alive:false  the device is rebooting or offline; it needs a manual restart
 *                before the next case counts as a measurement.
 */

const { createPoster, livenessProbe, settingsValues } = require('./pixoo-protocol.cjs');

const argNumber = (name, fallback, { min, max }) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const n = Number(process.argv[i + 1]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const argText = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
};

const origin = argText('origin') || process.env.PIXOO_ORIGIN || settingsValues().PIXOO_ORIGIN || '';
if (!origin) {
  console.error('❌ no PIXOO_ORIGIN (env, --origin, or local.settings.json)');
  process.exit(1);
}
const label = argText('label', 'canary');
const rounds = argNumber('rounds', 3, { min: 1, max: 10 });
const gapMs = argNumber('gap', 250, { min: 0, max: 5000 });
const timeoutMs = argNumber('timeout', 8000, { min: 1000, max: 30000 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const post = createPoster({ origin, userAgent: `canary-${label}`, timeout: timeoutMs });
  console.log(`canary "${label}" -> ${origin}  Channel/GetIndex x${rounds}, ${gapMs}ms apart`);
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const r = await livenessProbe(post, { attempts: 2, timeout: timeoutMs });
    samples.push(r);
    const verdict = r.alive ? '\x1b[32mALIVE\x1b[0m' : '\x1b[31mNO ANSWER\x1b[0m';
    console.log(`  ${i + 1}/${rounds} ${verdict} ${r.ms.toFixed(0)}ms  ${r.text || ''}`);
    if (i + 1 < rounds) await sleep(gapMs);
  }
  const ok = samples.filter((s) => s.alive);
  const alive = ok.length > 0;
  const times = ok.map((s) => s.ms).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : NaN;
  console.log(`\n${alive ? '✅ device answering' : '❌ device not answering - restart it manually before measuring anything'}`);
  if (alive) {
    console.log(`answered ${ok.length}/${rounds}  median ${median.toFixed(0)}ms  slowest ${times[times.length - 1].toFixed(0)}ms`);
    if (median > 1000) {
      console.log('\x1b[33m⚠️ median >1s: something ELSE is talking to this device (Function App / timer trigger) or it is still booting. Treat any run after this as contaminated.\x1b[0m');
    } else if (median > 120) {
      // A 444 ms median used to be printed as "clean" here, which is how a degraded device got
      // mistaken for a healthy one mid-session. 120ms is ~2x the 30-70ms idle band, well below
      // the contention band, so a slow answer cannot be silently reported as a good baseline.
      console.log(`\x1b[33m⚠️ DEGRADED: median ${median.toFixed(0)}ms is ~${(median / 45).toFixed(1)}x the 30-70ms idle band. Not a valid baseline - do not compare any number measured now with a clean run; power-cycle the panel and re-measure.\x1b[0m`);
    } else {
      console.log('✅ clean: median is in the 30-70ms band measured for an idle device.');
    }
  }
  process.exit(alive ? 0 : 1);
})();
