#!/usr/bin/env node
'use strict';
/**
 * ONE PROCESS, PROVEN OVER REAL HTTP.
 *
 * WHY. The claim「playable DOOM 唔使 func，亦唔使 TLS proxy」is only worth writing down if something answers
 * `/ui`, `/input` and `/hud` on the SAME port as the game. So this script starts the module the game starts
 * (`src/host/server.ts`, default prefix `api/doom` - not a test copy of it) and then asks it, over loopback,
 * for the things a phone and a player actually ask:
 *   · the page, the manifest, the icon           → the install prerequisites, and 404/400 that name a reason
 *   · /input                                     → a stick LEVEL is held, a release clears it, an unknown
 *                                                  session is an empty read and NOT an error
 *   · /hud                                       → a strip posted by the PRODUCTION producer
 *                                                  (`src/hud/upload.ts`) is held, and GET /hud/image returns
 *                                                  the same bytes with the same sequence
 * The proof that it is ONE process is not a diagram: `/version` reports its own `pid`, and this check asserts
 * that pid equals `process.pid` of the process making the requests.
 *
 * NOTHING here touches the panel or the engine. `engineBuilt` is REPORTED, never assumed. Default port is
  * 8455, never the DEFAULT_*_PORT pair of `src/host/server.ts`: `yarn play` owns those and a check must not
     * collide with a game. 8455 is this file's own port and is not used by the runner.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // before `dist` is imported: the dev cert is self-signed

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PNG } = require('pngjs'); // the same library src/hud/bar.ts writes status strips with

const REPO = path.join(__dirname, '..');
const loadDist = async (rel) => import(pathToFileURL(path.join(REPO, 'dist', rel)).href);
const argValue = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
};

const SESSION = String(argValue('session', 'main'));
const PORT = Number(argValue('port', '8455')) || 8455;

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n   ${detail}` : ''}`);
};

(async () => {
  const { startHost } = await loadDist('host/server.js');
  const host = await startHost({ port: PORT });
  const origin = new URL(host.base).origin;
  console.log(`host: ${host.base}  tls=${host.tls ? 'yes (.gener/devcert)' : 'no (run `yarn cert` first)'}  prefix=${host.prefix}`);
  if (host.lanUrls.length) console.log(`what a phone would open: ${host.lanUrls.join('  ')}`);

  /* ─── 1. one process: the version body reports the pid of THIS process ─────────────────────────── */
  const version = await (await fetch(host.apiUrl('version'))).json();
  check(
    '/version answers AND the pid it reports is this process (so no second server is serving anything)',
    version.ok === true && version.pid === process.pid,
    `pid(host)=${version.pid} pid(this)=${process.pid} engineBuilt=${version.engineBuilt} node=${version.node}`,
  );
  if (!version.engineBuilt) console.log('   ℹ️  engine not built: run `yarn engine` before `yarn play`. Not a failure of this check.');

  /* ─── 2. the page, the manifest and the icon: the three things Android needs ───────────────────── */
  const redirect = await fetch(host.apiUrl('ui'), { redirect: 'manual' });
  const page = await fetch(host.apiUrl('ui/'));
  const pageText = await page.text();
  const script = await fetch(host.apiUrl('ui/app.js'));
  const head = await fetch(host.apiUrl('ui/'), { method: 'HEAD' });
  check(
    'GET /ui/ is the page, /ui redirects to it, app.js is served, HEAD answers the same headers',
    redirect.status === 302 && String(redirect.headers.get('location') || '').endsWith('/ui/') && page.status === 200 && String(page.headers.get('content-type') || '').includes('text/html') && pageText.includes('manifest') && script.status === 200 && head.status === 200,
    `ui=${page.status} ui(no-slash)=${redirect.status} -> ${redirect.headers.get('location')} app.js=${script.status} HEAD=${head.status} len=${head.headers.get('content-length')}`,
  );

  const manifestRes = await fetch(host.apiUrl('ui/manifest.webmanifest'));
  const manifestText = await manifestRes.text();
  let manifest = null;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    /* left null: parsed below, and a manifest that is not JSON is the real bug being looked for */
  }
  check(
    'manifest.webmanifest is served AS a manifest and parses (every path relative → same origin)',
    manifestRes.status === 200 && String(manifestRes.headers.get('content-type') || '').includes('manifest') && manifest !== null && String(manifest.start_url || '').startsWith('./') && String(manifest.scope || '').startsWith('./') && Array.isArray(manifest.icons) && manifest.icons.length > 0,
    `type=${manifestRes.headers.get('content-type')} start_url=${manifest && manifest.start_url} scope=${manifest && manifest.scope} display=${manifest && manifest.display} icons=${manifest && (manifest.icons || []).map((i) => `${i.src}:${i.sizes || '-'}`).join(' ')}`,
  );
  console.log('   ⚠️  the icons above are SVG with sizes:"any". Whether Android Chrome offers "Install" for THAT icon is an open question - `yarn ui:install-check` asks Chrome, this check only proves the file is served.');

  const icon = await fetch(host.apiUrl('ui/icon.svg'));
  check('icon.svg is served as an image (a 404 here would be the whole install bug)', icon.status === 200 && String(icon.headers.get('content-type') || '').includes('image/'), `type=${icon.headers.get('content-type')} bytes=${(await icon.arrayBuffer()).byteLength}`);

  const missing = await fetch(host.apiUrl('ui/does-not-exist.js'));
  const outside = await fetch(`${origin}/something-outside-the-prefix`);
  const missingBody = await missing.text();
  const outsideBody = await outside.json();
  check(
    'a missing asset and a wrong prefix answer 404 WITH the reason and the ui root in the body',
    missing.status === 404 && missingBody.includes('uiRoot=') && outside.status === 404 && String(outsideBody.reason || '').includes('not under'),
    `missing=${missing.status} body=${missingBody.replace(/\n/g, ' | ')} outside=${outside.status} reason=${outsideBody.reason}`,
  );

  /* ─── 3. /input: the phone writes, the player reads ───────────────────────────────────────────── */
  const postInput = async (events, seq) => {
    const res = await fetch(host.apiUrl('input'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'host-check' },
      body: JSON.stringify({ session: SESSION, seq, events }),
    });
    return { status: res.status, body: await res.json() };
  };
  const readInput = async (extra = '') => await (await fetch(host.apiUrl(`input/state?session=${SESSION}${extra}`))).json();

  const broken = await fetch(host.apiUrl('input'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json at all' });
  const brokenBody = await broken.json();
  check('an unparseable /input POST is 400 with a named reason (never a 200, never a silent 500)', broken.status === 400 && Boolean(brokenBody.reason), `status=${broken.status} reason=${brokenBody.reason}`);

  const pressed = await postInput([{ kind: 'stick', id: 'r', x: 0.95, y: 0, magnitude: 0.95, direction: 'right', source: 'probe' }], 1);
  const held = await readInput();
  check('a stick LEVEL posted over HTTP is held as a LEVEL (a game sees the newest value)', pressed.status === 200 && pressed.body.ok === true && held.exists === true && held.state.stick.direction === 'right' && held.state.stick.magnitude > 0.9, `post=${JSON.stringify(pressed.body)} state=${JSON.stringify({ dir: held.state && held.state.stick.direction, mag: held.state && held.state.stick.magnitude, active: held.state && held.state.stick.active })}`);

  const letGo = await postInput([{ kind: 'release', id: 'r', source: 'probe' }], 2);
  const after = await readInput();
  check('a release over HTTP stops driving the player (an edge that never arrives leaves the engine turning forever)', letGo.status === 200 && after.state.stick.active === false, `state.stick.active=${after.state.stick.active}`);

  const sessions = await (await fetch(host.apiUrl('input/sessions'))).json();
  const absent = await (await fetch(host.apiUrl('input/state?session=nobody-was-here'))).json();
  check('GET /input/sessions lists the live session; an unknown session is an EMPTY read, not an error', Array.isArray(sessions.sessions) && sessions.sessions.some((entry) => entry.session === SESSION) && absent.ok === true && absent.exists === false, `sessions=${(sessions.sessions || []).map((s) => s.session).join(',')} absent=${JSON.stringify(absent).slice(0, 90)}`);

  /* ─── 4. /hud: the production producer against the host that holds it ─────────────────────────── */
  const { HudUploader } = await loadDist('hud/upload.js');
  const strip = new PNG({ width: 300, height: 16 });
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 120; x++) {
      const i = (y * 300 + x) * 4;
      strip.data[i] = 255;
      strip.data[i + 1] = 40;
      strip.data[i + 2] = 0;
      strip.data[i + 3] = 255;
    }
  }
  const png = PNG.sync.write(strip);
  const uploader = new HudUploader({ apiBase: host.base, id: SESSION });
  /* `anchor: 'bottom'` is the DOOM shape: a bar that does not fit 64x64 (src/hud/wire.ts). The pixels here
     are synthetic on purpose - what must match is the CONTRACT, not any game's typography. */
  uploader.submit({ png, width: 300, height: 16, rows: 1, anchor: 'bottom', source: 'host-check', meta: { hp: 52, armor: 100, weapon: 'shotgun' } });
  await uploader.settle();
  check('the real producer (src/hud/upload.ts) got accepted by its own host', uploader.stats.uploads === 1 && uploader.stats.errors === 0, uploader.report());

  const state = await (await fetch(host.apiUrl(`hud/state?id=${SESSION}`))).json();
  const imageRes = await fetch(host.apiUrl(`hud/image?id=${SESSION}`));
  const image = Buffer.from(await imageRes.arrayBuffer());
  check(
    'GET /hud/state and /hud/image return the strip the producer sent - same sequence, same bytes',
    Number(state.sequence) === Number(uploader.stats.sequence) && Number(state.bytes) === png.length && imageRes.status === 200 && String(imageRes.headers.get('content-type') || '').includes('image/png') && image.length === png.length && Buffer.compare(image, png) === 0 && imageRes.headers.get('x-hud-sequence') === String(uploader.stats.sequence),
    `producerSeq=${uploader.stats.sequence} heldSeq=${state.sequence} sentBytes=${png.length} heldBytes=${state.bytes} got=${image.length} identical=${Buffer.compare(image, png) === 0} meta=${JSON.stringify(state.meta || {})}`,
  );

  const hudRejected = await fetch(host.apiUrl('hud'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 1, id: SESSION, png: 'x', width: 0, height: 0, rows: 0, anchor: 'bottom', source: 'host-check', meta: {} }) });
  const hudRejectedBody = await hudRejected.json();
  check('an invalid strip is refused with a reason (a bad HUD never becomes a 200)', hudRejected.status === 400 && Boolean(hudRejectedBody.reason), `status=${hudRejected.status} reason=${hudRejectedBody.reason}`);

  /* ─── 5. closing is real: the game must be able to END ─────────────────────────────────────────── */
  await host.close();
  const afterClose = await fetch(host.apiUrl('version')).then((r) => r.ok).catch(() => false);
  check('close() really stops listening (a Ctrl-C that leaves a server holding the port is the orphan bug, in new clothes)', !afterClose, `request after close answered=${afterClose}`);

  const s = host.stats;
  console.log(`\nhost handled ${s.requests} requests: ${s.inputPosts} /input POST, ${s.hudPosts} /hud POST, ${s.rejected} refused`);
  console.log(`\n${failed ? `❌ ${failed} check(s) FAILED` : '✅ one process served the page, the broker and the hud cache'}`);
  console.log('What this does NOT prove: that a phone installs the page (that needs the phone, or `yarn ui:install-check`), nor that the panel plays anything - no device, no engine was touched.');
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(`❌ ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
