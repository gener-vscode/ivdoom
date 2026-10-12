/*
 * STATUS STRIP client - the phone half of src/hud/.
 *
 * WHAT IT DOES (the user's design, 2026-10-11 23:20): poll `hud/state` once a second; when the held image
 * has CHANGED, fetch `hud/image` and paint it as the background of the fixed #hudBand layer. The panel has
 * no score header (HUD_HEIGHT = 0 in src/game/breakout.ts), so this is where score/lives/level/bricks are.
 *
 * THREE DECISIONS THAT ARE NOT STYLE:
 *  1. state first, image second. Most 1 s polls change nothing, and a byte-compare signature means the
 *     identical image is never re-downloaded. `sequence` alone could not say that: the game posts a frame
 *     every second whether or not the score moved.
 *  2. 「郁」= the PICTURE changed. opacity 0.7 for 1.5 s after a real content change, 0.3 otherwise. A
 *     strip that only proved a POST arrived would sit at 0.7 forever.
 *  3. the same numbers are ALWAYS written as text into #hudLine. An image that failed, is dimmed, or is
 *     covered by the pads must never be the only copy of the score.
 *
 * A separate file from app.js on purpose: a different clock (1 s, not the 200 ms input heartbeat) and a
 * different failure mode (an image endpoint, not a session). It duplicates only the URL rules it needs.
 */

const params = new URLSearchParams(location.search);
/** app.js writes this into the URL and the game matches it with --input-session; keep the rules identical. */
const sessionValid = /^[A-Za-z0-9._:-]{1,64}$/;
const hudId = sessionValid.test(params.get('session') ?? '') ? params.get('session') : 'main';

/** Same-origin by default: the page is served from /api/pixoo/ui/, so the API is one directory up. */
const apiRoot = (() => {
  const given = params.get('api');
  if (given) return given.replace(/\/+$/, '') + '/';
  const path = location.pathname.replace(/\/+$/, '');
  const cut = path.indexOf('/ui');
  return ((cut > -1 ? path.slice(0, cut) : '/api/pixoo').replace(/\/+$/, '')) + '/';
})();

const POLL_MS = 1000;
/** How long a content change keeps the strip bright. 1.5 s = one poll plus slack, so a live game stays lit. */
const ACTIVE_MS = 1500;
const band = document.getElementById('hudBand');
const line = document.getElementById('hudLine');

const hud = {
  signature: '',
  sequence: 0,
  objectUrl: '',
  exists: false,
  changedAt: 0,
  polls: 0,
  imageFetches: 0,
  errors: 0,
  lastError: '',
  ageMs: 0,
  bytes: 0,
  width: 0,
  height: 0,
  rows: 0,
  meta: null,
};

const text = (value) => (value === null || value === undefined ? '' : String(value));

/** The numbers as text - always. `meta.text` is what the game drew into the image, produced by the same
 *  function that produced the pixels, so the text and the image cannot disagree. */
const paintLine = () => {
  if (!line) return;
  if (!hud.exists) {
    line.textContent = hud.lastError ? `game hud: ${hud.lastError}` : 'game hud: waiting';
    line.classList.remove('mid__game--live');
    return;
  }
  const body = text(hud.meta?.text) || `score ${text(hud.meta?.score)} · lives ${text(hud.meta?.lives)}`;
  line.textContent = `${body}  (${(hud.ageMs / 1000).toFixed(1)}s${hud.rows > 1 ? ` ${hud.rows} rows` : ''})`;
  line.classList.toggle('mid__game--live', performance.now() - hud.changedAt < ACTIVE_MS);
};

const paintBand = () => {
  if (!band) return;
  if (!hud.exists || !hud.objectUrl) {
    band.style.backgroundImage = '';
    document.body.removeAttribute('data-hud');
    document.body.removeAttribute('data-hud-active');
    document.body.removeAttribute('data-hud-anchor');
    return;
  }
  /* The image carries the LAYOUT (how many rows the reflow produced); this layer only decides where it
     sits. `anchor` comes from the producer: Breakout's header is top, DOOM's bottom bar is bottom. */
  band.style.setProperty('--hud-w', String(hud.width || 320));
  band.style.setProperty('--hud-h', String(hud.height || 20));
    band.style.backgroundImage = `url("${hud.objectUrl}")`;
  document.body.setAttribute('data-hud', '1');
  document.body.toggleAttribute('data-hud-active', performance.now() - hud.changedAt < ACTIVE_MS);
};

const rememberAnchor = (anchor) => {
  if (!band) return;
  band.dataset.anchor = anchor === 'bottom' ? 'bottom' : 'top';
  document.body.dataset.hudAnchor = band.dataset.anchor;
};

const fetchImage = async (state) => {
  const res = await fetch(`${apiRoot}hud/image?session=${encodeURIComponent(hudId)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`hud/image ${res.status}`);
  const blob = await res.blob();
  if (hud.objectUrl) URL.revokeObjectURL(hud.objectUrl);
  hud.objectUrl = URL.createObjectURL(blob);
  hud.imageFetches++;
  hud.bytes = blob.size;
  hud.signature = text(state.signature);
  hud.changedAt = performance.now();
};

const poll = async () => {
  hud.polls++;
  try {
    const res = await fetch(`${apiRoot}hud/state?session=${encodeURIComponent(hudId)}`, { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok !== true) {
      throw new Error((body && text(body.reason)) || `hud/state ${res.status}`);
    }
    hud.lastError = '';
    hud.exists = body.exists === true;
    if (!hud.exists) {
      hud.meta = null;
      hud.sequence = 0;
      hud.exists = false;
      if (hud.objectUrl) {
        URL.revokeObjectURL(hud.objectUrl);
        hud.objectUrl = '';
      }
      hud.signature = '';
      paintBand();
      paintLine();
      return;
    }
    hud.sequence = Number(body.sequence) || 0;
    hud.ageMs = Number(body.ageMs) || 0;
    hud.width = Number(body.width) || 0;
    hud.height = Number(body.height) || 0;
    hud.rows = Number(body.rows) || 0;
    hud.meta = body.meta ?? null;
    rememberAnchor(body.anchor);
    /* The only trigger for a download: the bytes differ. A frame that arrived with the same score costs
       one small JSON poll and nothing else. */
    if (text(body.signature) !== hud.signature) await fetchImage(body);
    paintBand();
    paintLine();
  } catch (error) {
    hud.errors++;
    hud.lastError = text(error?.message ?? error);
    hud.exists = false;
    paintBand();
    paintLine();
  }
};

paintLine();
poll();
setInterval(poll, POLL_MS);

/* Diagnostics, because "the HUD is not showing" must be answerable from the page itself: is the strip
   missing, refused, or just unchanged? (the same question the input diagnostics had to answer) */
document.addEventListener('keydown', (event) => {
  if (event.key !== 'F7') return;
  console.log(
    `[hud] id=${hudId} api=${apiRoot} polls=${hud.polls} images=${hud.imageFetches} errors=${hud.errors} ` +
    `seq=${hud.sequence} sig=${hud.signature || '-'} bytes=${hud.bytes} ${hud.width}x${hud.height} rows=${hud.rows} ` +
    `age=${hud.ageMs}ms active=${performance.now() - hud.changedAt < ACTIVE_MS}${hud.lastError ? ` lastError=${hud.lastError}` : ''}`,
  );
});
