/**
 * Pixoo HID controller - deliberately plain DOM, no framework, no build step.
 *
 * Why not React (or anything else): this page is ONE surface, ~10 event handlers and ~15 fields of
 * state. A framework would buy us a bundler (Azure Functions serves these files straight off disk), a
 * virtual DOM to re-diff 40 times a second just to move a knob, and a second build pipeline to keep in
 * step with the Functions build. Plain DOM keeps every handler one `addEventListener` you can read in
 * place, and the page cold-starts instantly on a phone. If this ever grows real widgets, the escape
 * hatch I would pick is `lit` (ESM components, no bundler required) - not React.
 *
 * The wire shape is defined in src/input/protocol.ts and mirrored here by hand; the broker recomputes
 * the direction from x/y and we compare it (see syncBadge) rather than trusting our own geometry.
 *
 *   ?session=name  controller identity (default 'main', matches the game's default)
 *   ?api=URL       override the API base (default: derived from where this page was served from)
 *   ?local=1       gestures + HUD only, no requests (for testing on a phone with no LAN)
 *   ?panel=1       open the diagnostics panel at start
 */

const params = new URLSearchParams(location.search);
const cfg = {
  local: ['1', 'true', 'yes'].includes((params.get('local') ?? '').toLowerCase()),
  panelOpen: params.get('panel') === '1',
  session: /^[A-Za-z0-9._:-]{1,64}$/.test(params.get('session') ?? '') ? params.get('session') : 'main',
};

/** Same-origin by default: the page comes from /api/pixoo/ui/, so the API is one directory up. */
const apiRoot = (() => {
  const given = params.get('api');
  if (given) return given.replace(/\/+$/, '') + '/';
  const path = location.pathname.replace(/\/+$/, '');
  const cut = path.indexOf('/ui');
  return ((cut > -1 ? path.slice(0, cut) : '/api/pixoo').replace(/\/+$/, '')) + '/';
})();

const $ = (id) => document.getElementById(id);
const el = {
  linkBadge: $('linkBadge'), sessLabel: $('sessLabel'), syncBadge: $('syncBadge'), zoomWarn: $('zoomWarn'),
  panelBtn: $('panelBtn'), clearBtn: $('clearBtn'), panel: $('panel'), panelBody: $('panelBody'),
  slotLabel: $('slotLabel'), lastCmd: $('lastCmd'), ackBadge: $('ackBadge'),
  padLeft: $('padLeft'), padRight: $('padRight'), knob: $('knob'), stickRead: $('stickRead'),
  actionFlash: $('actionFlash'), rotateGate: $('rotateGate'),
};

const STICK_DEADZONE = 0.18; // must equal STICK_DEADZONE in src/input/protocol.ts
const STICK_REFRESH_MS = 200;
const STICK_MAG_STEP = 0.12;
const SWIPE_PX = 34;
const FLUSH_MS = 40;
const HEARTBEAT_MS = 2000;
const STICK_ID = 'main';

const rt = {
  seq: 0,
  pending: [],
  sending: false,
  attempts: 0,
  published: { active: false, direction: 'none', magnitude: 0, at: 0 },
  stats: {
    posts: 0, postErrors: 0, stickPosts: 0, heartbeats: 0, heartbeatErrors: 0, droppedByOverflow: 0,
      ackMismatch: 0, rttMs: 0, serverSeq: 0, serverSelected: 0, geometryMismatch: 0,
      serverRejects: 0, lastServerError: '',
      sync: 'unknown', lastError: '', lastCommand: '—', wakeLockHeld: false, fullscreen: 'not requested',
  },
};

const octant = (x, y) => {
  const magnitude = Math.hypot(x, y);
  if (magnitude < STICK_DEADZONE) return 'none';
  const table = ['right', 'upRight', 'up', 'upLeft', 'left', 'downLeft', 'down', 'downRight'];
  return table[Math.round((((Math.atan2(-y, x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4))) % 8];
};

/* ------------------------------------------------------------------ geometry */
const zones = { left: null, right: null };
const measure = () => {
  for (const [key, node] of [['left', el.padLeft], ['right', el.padRight]]) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    // full deflection happens at 36% of the smaller side, so a thumb never has to cross the pad
    zones[key] = { left: rect.left, top: rect.top, w: rect.width, h: rect.height, radius: Math.min(rect.width, rect.height) * 0.36 };
  }
  const ok = window.innerWidth > window.innerHeight;
  el.rotateGate.style.display = ok ? 'none' : 'flex';
};

/** visualViewport is the only height that follows the browser chrome; iOS `scale` is how pinch shows up. */
const syncViewport = () => {
  const vv = window.visualViewport;
  const height = vv && vv.height ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(height)}px`);
  const zoomed = (vv && vv.scale > 1.01) || Math.abs(window.scrollY) > 2 || window.visualZoom > 1.01;
  if (zoomed) window.scrollTo(0, 0);
  document.body.toggleAttribute('data-zoomed', !!zoomed);
  measure();
  requestPaint();
};

/* ------------------------------------------------------------------ transport */
const describe = (event) => {
  if (event.kind === 'stick') return `stick ${event.dir || event.direction} ${event.magnitude.toFixed(2)}`;
  if (event.kind === 'action') return `action ${event.action}`;
  if (event.kind === 'select') return `select ${event.direction}`;
  if (event.kind === 'release') return 'release';
  return 'clear';
};

const enqueue = (event) => {
  if (event.kind !== 'select') rt.lastCommand = describe(event);
  rt.lastCommand = describe(event);
  el.lastCmd.textContent = rt.lastCommand;
  if (event.kind === 'select') rt.serverSelected += event.direction === 'next' ? 1 : -1;
  if (rt.pending.length >= 64) {
    rt.pending.shift();
    rt.stats.droppedByOverflow++; // a controller that cannot post must say so, not silently eat presses
  }
  rt.pending.push(event);
  scheduleFlush(event.kind === 'action' || event.kind === 'select');
};

let flushTimer = 0;
const scheduleFlush = (urgent) => {
  if (urgent) {
    clearTimeout(flushTimer);
    flushTimer = 0;
    flush();
    return;
  }
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = 0; flush(); }, FLUSH_MS);
};

/** One request in flight, and its batches are never interleaved - that is what lets a failed `seq` be rewound. */
const flush = async () => {
  if (cfg.local || rt.sending || !rt.pending.length) return;
  const events = rt.pending.splice(0, 32);
  const seq = ++rt.seq;
  rt.sending = true;
  const started = performance.now();
  try {
    const res = await fetch(`${apiRoot}input`, {
      method: 'post',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: cfg.session, seq, sentAt: Date.now(), agent: navigator.userAgent.slice(0, 160), events }),
    });
    const body = await res.json().catch(() => null);
    rt.stats.rttMs = Math.round(performance.now() - started);
      if (res.ok && body && body.ok === true) {
          // The broker must account for every event we sent; a 200 alone proves nothing.
          const rejected = body.rejected || [];
          const accounted = (body.applied | 0) + (body.coalesced | 0) + rejected.length;
          rt.stats.ackMismatch += accounted === events.length ? 0 : 1;
          rt.stats.serverRejects += rejected.length;
          if (rejected.length) rt.stats.lastServerError = `${rejected.length}/${events.length} ${rejected[0].reason}`;
          rt.stats.lastError = accounted === events.length ? '' : `ack ${accounted}/${events.length}`;
          rt.stats.serverSeq = body.seq | 0;
          applyServerState(body.state);
          rt.attempts = 0;
      } else if (res.status === 400 && body) {
          /* The broker READ this body and said no. Re-sending the same bytes cannot change that answer, and the
             old unconditional `requeue` is what made one refused event ride inside EVERY later batch: after one
             thumb-down the phone POSTed forever and nothing ever landed, including a tap. Drop it, and say why.
             A 400 is not a transport failure and must not be counted as one. */
          const rejected = body.rejected || [];
          rt.stats.serverRejects += rejected.length || events.length;
          rt.stats.lastServerError = String(body.reason || `refused ${events.length} event(s)`);
          rt.stats.lastError = rt.stats.lastServerError;
          rt.attempts = 0;
      } else {
          rt.stats.postErrors++;
          rt.stats.lastError = (body && body.reason) || `http ${res.status}`;
          requeue(events, seq);
      }
  } catch (error) {
    rt.stats.postErrors++;
    rt.stats.lastError = String((error && error.message) || error);
    requeue(events, seq);
  } finally {
    rt.sending = false;
    if (rt.pending.length) setTimeout(flush, Math.min(4000, 250 * 2 ** rt.attempts++));
  }
};

const requeue = (events, seq) => {
  rt.pending = events.concat(rt.pending).slice(0, 64);
  rt.seq = seq - 1; // the batch never reached the broker, so no gap may appear in its sequence
};

const applyServerState = (state) => {
  if (!state) return;
  rt.stats.serverSeq = state.seq | 0;
  rt.stats.serverSelected = state.selected | 0;
  rt.stats.geometryMismatch = (state.counts && state.counts.geometryMismatch) | 0;
  rt.stats.sync = rt.published.active && state.stick && state.stick.direction !== rt.published.direction ? 'desync' : 'in sync';
  rt.stats.lastCommandServer = (state.actions && state.actions.primary && state.actions.primary.count) || 0;
};

/** Read-only self-check: does the broker's LEVEL still match what we last sent? */
const heartbeat = async () => {
  if (cfg.local || rt.sending) return;
  rt.stats.heartbeats++;
  try {
    const res = await fetch(`${apiRoot}input/state?session=${encodeURIComponent(cfg.session)}&since=${rt.stats.serverSeq}&limit=0`);
    const body = await res.json();
    if (!body || body.ok !== true) throw new Error((body && body.reason) || `http ${res.status}`);
    rt.stats.lastError = '';
    if (!body.exists) {
      rt.stats.sync = 'no session';
      return;
    }
    applyServerState(body.state);
  } catch (error) {
    rt.stats.heartbeatErrors++;
    rt.stats.lastError = String((error && error.message) || error);
    rt.stats.sync = 'unreachable';
  }
  requestPaint();
};

/* ------------------------------------------------------------------ left pad: direction (LEVEL) */
const pointers = new Map();
const gestureState = new Map();
let lastSource = 'touchLeft';

/* ------------------------------------------------------------------ the left pad's ONE held stick
 * `pointers` is keyed by `event.pointerId`, and STICK_ID is singular: this pad drives one stick. What
 * used to happen is the bug the user measured twice - `publishStick()` looked the held thumb up with
 * `pointers.get('stick')`, a key this file NEVER writes, so it returned before enqueueing anything. The
 * knob on screen moved (paintStick is called directly) and no LEVEL was ever POSTed: an analog stick that
 * visibly works, moves nothing, and produces no error anywhere. WASD worked because publishKeyStick()
 * enqueues directly, and so did a tap - which is why "start the ball" was fine while the paddle sat still.
 *
 * A pointer id can legitimately be 0, so "no stick" must be null and must never be tested with falsiness.
 */
let stickPointerId = null;

const heldStick = () => (stickPointerId === null ? undefined : pointers.get(stickPointerId));

/**
 * "A thumb is on the pad and points nowhere" is NOT a stick sample. The protocol refuses a stick event whose
 * vector is (0,0) and says so: `kind:release` IS that state. A real thumb down IS (0,0) - `onLeftDown`
 * records `ox=event.clientX` and then calls `moveStick`, so the first sample has zero displacement - and the
 * broker refused it, which (with the old whole-batch rejection + `requeue`) poisoned every batch after it.
 * Measured, verbatim, against the compiled broker:
 *   [x=0,y=0]                      -> refused
 *   [x=0,y=0] + drag LEFT + TAP    -> refused  <- the drag and the tap died with it
 *   drag LEFT + TAP                -> applied 2
 */
const publishCentered = (source) => {
    const now = performance.now();
    const wasActive = rt.published.active;
    rt.published = { active: false, direction: 'none', magnitude: 0, at: now };
    if (!wasActive) return; // nothing to withdraw: there is no LEVEL to stop
    lastSource = source;
    enqueue({ kind: 'release', id: STICK_ID, source });
};

const publishStick = (force) => {
    const local = heldStick();
    if (!local || !local.stick) return;
    if (local.x === 0 && local.y === 0) {
        publishCentered(local.source);
        return;
    }
    rt.stats.stickPosts++;
  const direction = octant(local.x, local.y);
  const now = performance.now();
  const changed =
    !rt.published.active ||
    rt.published.direction !== direction ||
    Math.abs(rt.published.magnitude - local.magnitude) >= STICK_MAG_STEP ||
    now - rt.published.at > STICK_REFRESH_MS;
  if (!changed && !force) return;
  rt.published = { active: true, direction, magnitude: local.magnitude, at: now };
  lastSource = local.source;
  enqueue({ kind: 'stick', id: STICK_ID, x: local.x, y: local.y, magnitude: local.magnitude, direction, source: local.source });
};

const stickPointers = () => [...pointers.entries()].filter(([, value]) => value.stick);

const onLeftDown = (event) => {
  const zone = zones.left;
  if (!zone) return;
  event.preventDefault();
  const pointer = { ox: event.clientX, oy: event.clientY, x: 0, y: 0, magnitude: 0, stick: true, source: event.pointerType === 'mouse' ? 'mouse' : 'touchLeft' };
  pointers.set(event.pointerId, pointer);
  stickPointerId = event.pointerId; // the key publishStick/heldStick will use - it must be this exact one
  /* The self-check for the bug class above: the lookup must resolve to this very pointer. If it does not,
     a thumb would again move the knob and post nothing, and the only place that could say so is here. */
  if (heldStick() !== pointer) rt.stats.lastError = `stick lookup failed (id ${event.pointerId})`;
  el.padLeft.dataset.here = '1';
  document.body.toggleAttribute('data-stick', true);
  moveStick(event);
};

const moveStick = (event) => {
  const local = pointers.get(event.pointerId);
  const zone = zones.left;
  if (!local || !local.stick || !zone) return;
  let x = (event.clientX - local.ox) / zone.radius;
  let y = (event.clientY - local.oy) / zone.radius;
  const raw = Math.hypot(x, y);
  if (raw > 1) {
    x /= raw;
    y /= raw;
  }
  local.x = x;
  local.y = y;
  local.magnitude = Math.min(1, raw);
  publishStick(false);
  paintStick(x, y);
};

const releaseStick = (event) => {
  const local = pointers.get(event.pointerId);
  if (!local || !local.stick) return;
  pointers.delete(event.pointerId);
  if (stickPointerId === event.pointerId) {
    // A second finger already on this pad takes the stick over; otherwise there is no held stick left.
    const next = stickPointers()[0];
    stickPointerId = next ? next[0] : null;
  }
  if (stickPointers().length) return;
  rt.published = { active: false, direction: 'none', magnitude: 0, at: performance.now() };
  enqueue({ kind: 'release', id: STICK_ID, source: local.source });
  el.padLeft.removeAttribute('data-here');
  document.body.toggleAttribute('data-stick', false);
  paintStick(0, 0);
};

/* ------------------------------------------------------------------ right pad: action / secondary (EDGE) */
const fireAction = (action, source) => {
  enqueue({ kind: 'action', action, source });
  el.actionFlash.removeAttribute('data-fire');
  void el.actionFlash.offsetWidth; // restart the CSS animation
  el.actionFlash.setAttribute('data-fire', '1');
  setTimeout(() => el.actionFlash.removeAttribute('data-fire'), 240);
};

/* WHICH HALF the finger landed in decides WHICH button. The user's control choice of 2026-10-12, REVERSED
   at 12:41 after the run that proved move+shoot work: the LOWER half is the main action (`primary` = DOOM's
   FIRE, the button a thumb reaches without leaving the rest position) and the UPPER half is the other one
   (`secondary` = DOOM's USE). Only the GEOMETRY changed here - the wire terms and the game's mapping did
   not: `primary` still means "this pad's main action", which half of the pad carries it moved.
   It is decided AT POINTER-DOWN on purpose: a thumb that then drifts a few px inside the same half must not
   change verb mid-gesture, and a slide that crosses the midline still belongs to the half it started in.
   `zones.right` is the pad's own measured rect - the same one the stick uses - so this is geometry, not a
   guess about layout. */
const rightHalf = (clientY) => {
  const zone = zones.right;
  if (!zone) return 'primary'; // no measured rect => the old single-button behaviour, never a wrong half
  return clientY < zone.top + zone.h / 2 ? 'secondary' : 'primary';
};

const onRightDown = (event) => {
  event.preventDefault();
  gestureState.set(event.pointerId, { ox: event.clientX, oy: event.clientY, fired: false, action: rightHalf(event.clientY), source: event.pointerType === 'mouse' ? 'mouse' : 'touchRight' });
  el.padRight.dataset.here = '1';
};

const onRightMove = (event) => {
  const gesture = gestureState.get(event.pointerId);
  if (!gesture || gesture.fired) return;
  const dx = event.clientX - gesture.ox;
  const dy = event.clientY - gesture.oy;
  if (Math.hypot(dx, dy) < SWIPE_PX) return;
  gesture.fired = true; // one command per gesture: a slide must not also count as a tap
  if (Math.abs(dy) > Math.abs(dx)) fireAction(dy < 0 ? 'altUp' : 'altDown', gesture.source);
  else enqueue({ kind: 'select', direction: dx > 0 ? 'next' : 'prev', source: gesture.source });
};

const onRightUp = (event) => {
  const gesture = gestureState.get(event.pointerId);
  if (!gesture) return;
  gestureState.delete(event.pointerId);
  el.padRight.removeAttribute('data-here');
  // A tap becomes an action only once we know it was NOT a slide - that is what keeps
  // "tap = action" and "slide = altUp/altDown" from firing each other by accident.
  // The term comes from the half the finger landed in (`rightHalf`, decided at pointer-down), NOT from a
  // fixed 'primary': a two-button pad needs both buttons, and the game decides what each one MEANS.
  if (!gesture.fired) fireAction(gesture.action || rightHalf(gesture.oy), gesture.source);
};

el.padRight.addEventListener('pointerdown', onRightDown);
el.padRight.addEventListener('pointermove', onRightMove);
el.padRight.addEventListener('pointerup', onRightUp);
el.padRight.addEventListener('pointercancel', (event) => {
  gestureState.delete(event.pointerId);
  el.padRight.removeAttribute('data-here');
});

/* Anywhere else (e.g. the HUD column) a plain mouse click means the same as a pad tap. */
document.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'mouse') return;
  if (event.target.closest('#padLeft') || event.target.closest('#padRight')) return;
  if (event.target.closest('button, #panel')) return;
  onRightDown(event);
});
document.addEventListener('pointerup', (event) => {
  if (event.pointerType === 'mouse' && gestureState.has(event.pointerId) && !el.padRight.matches(':hover')) onRightUp(event);
});

/* ------------------------------------------------------------------ keyboard + mouse (for desktop testing) */
const held = new Set();
const keyAxis = () => {
  let x = 0;
  let y = 0;
  if (held.has('KeyA') || held.has('ArrowLeft')) x -= 1;
  if (held.has('KeyD') || held.has('ArrowRight')) x += 1;
  if (held.has('KeyW') || held.has('ArrowUp')) y -= 1;
  if (held.has('KeyS') || held.has('ArrowDown')) y += 1;
  return { x, y };
};

const publishKeyStick = () => {
  const { x, y } = keyAxis();
  const now = performance.now();
  if (!x && !y) {
    rt.published = { active: false, direction: 'none', magnitude: 0, at: now };
    enqueue({ kind: 'release', id: STICK_ID, source: 'keys' });
    paintStick(0, 0);
    return;
  }
  const length = Math.hypot(x, y);
  const nx = x / length;
  const ny = y / length;
  const direction = octant(nx, ny);
  if (rt.published.active && rt.published.direction === direction) return; // a held key is a LEVEL, not a stream of presses
  rt.published = { active: true, direction, magnitude: 1, at: now };
  enqueue({ kind: 'stick', id: STICK_ID, x: nx, y: ny, magnitude: 1, direction, source: 'keys' });
  paintStick(nx, ny);
};

document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, button')) return;
  const code = event.code;
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
    event.preventDefault();
    held.add(code);
    publishKeyStick();
    return;
  }
  if (event.repeat) return;
  if (code === 'Space' || code === 'Enter') { event.preventDefault(); fireAction('primary', 'keys'); return; }
  if (code === 'KeyE' || code === 'KeyU' || code === 'PageUp') { event.preventDefault(); fireAction('altUp', 'keys'); return; }
  if (code === 'KeyQ' || code === 'KeyJ' || code === 'PageDown') { event.preventDefault(); fireAction('altDown', 'keys'); return; }
  if (code === 'KeyD' || code === 'BracketRight') { event.preventDefault(); enqueue({ kind: 'select', direction: 'next', source: 'keys' }); return; }
  if (code === 'KeyC' || code === 'BracketLeft') { event.preventDefault(); enqueue({ kind: 'select', direction: 'prev', source: 'keys' }); return; }
  if (code === 'Tab') { event.preventDefault(); enqueue({ kind: 'select', direction: event.shiftKey ? 'prev' : 'next', source: 'keys' }); return; }
  if (code === 'Escape' || code === 'Backspace') { event.preventDefault(); enqueue({ kind: 'clear', source: 'keys' }); }
});

document.addEventListener('keyup', (event) => {
  if (!held.delete(event.code)) return;
  publishKeyStick();
});

let wheelAcc = 0;
window.addEventListener('wheel', (event) => {
  event.preventDefault();
  const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  wheelAcc += horizontal ? event.deltaX : event.deltaY;
  if (Math.abs(wheelAcc) < 40) return; // trackpads deliver many small deltas; one gesture = one command
  const forward = wheelAcc > 0;
  wheelAcc = 0;
  if (horizontal) enqueue({ kind: 'select', direction: forward ? 'next' : 'prev', source: 'wheel' });
  else fireAction(forward ? 'altDown' : 'altUp', 'wheel');
}, { passive: false });

/* ------------------------------------------------------------------ fullscreen + lifecycle */
let armed = false;
const armFullscreen = async () => {
  if (armed || cfg.local) return;
  armed = true;
  try {
    if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    rt.stats.fullscreen = document.fullscreenElement ? 'fullscreen' : 'denied / unsupported';
  } catch {
    rt.stats.fullscreen = 'denied';
  }
  try {
    const lock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null;
    rt.stats.wakeLockHeld = !!lock;
    if (lock) lock.addEventListener('release', () => { rt.stats.wakeLockHeld = false; requestPaint(); });
  } catch {
    rt.stats.wakeLockHeld = false;
  }
  try {
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch {
    /* not allowed outside fullscreen; the rotate gate covers it */
  }
  requestPaint();
};
document.addEventListener('pointerdown', armFullscreen, { once: true });

const finalFlush = () => {
  const events = rt.pending.splice(0, 8);
  if (rt.published.active) events.push({ kind: 'release', id: STICK_ID, source: lastSource });
  if (!events.length || cfg.local) return;
  fetch(`${apiRoot}input`, {
    method: 'post',
    keepalive: true, // the POST must survive the page going away, or a mid-press becomes a stuck paddle
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: cfg.session, seq: ++rt.seq, sentAt: Date.now(), events }),
  }).catch(() => undefined);
};
window.addEventListener('pagehide', finalFlush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') finalFlush();
  else requestPaint();
});

['gesturestart', 'gesturechange', 'gestureend'].forEach((type) => document.addEventListener(type, (event) => event.preventDefault()));
document.addEventListener('dblclick', (event) => event.preventDefault());
el.clearBtn.addEventListener('click', () => enqueue({ kind: 'clear', source: 'probe' }));
el.panelBtn.addEventListener('click', () => {
  const open = el.panel.hidden;
  el.panel.hidden = !open;
  el.panelBtn.setAttribute('aria-expanded', String(open));
  requestPaint();
});

/* ------------------------------------------------------------------ HUD */
const paintStick = (x, y) => {
  const zone = zones.left;
  if (!zone) return;
  const travel = Math.min(zone.w, zone.h) * 0.3;
  el.knob.style.transform = `translate(calc(-50% + ${Math.round(x * travel)}px), calc(-50% + ${Math.round(y * travel)}px))`;
  const direction = octant(x, y);
  el.stickRead.textContent = direction === 'none' ? 'idle' : `${direction} ${Math.min(1, Math.hypot(x, y)).toFixed(2)}`;
};

let paintQueued = false;
const requestPaint = () => {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => {
    paintQueued = false;
    paint();
  });
};

const row = (label, value, cls) => `<div class="row"><span>${label}</span><span class="${cls || ''}">${value}</span></div>`;

const paint = () => {
  const stats = rt.stats;
  el.sessLabel.textContent = `session ${cfg.session}`;
  el.linkBadge.textContent = cfg.local ? 'LOCAL (no network)' : stats.lastError ? 'link error' : 'linked';
  el.linkBadge.className = `badge ${cfg.local || stats.lastError ? 'badge--bad' : 'badge--good'}`;
  el.syncBadge.textContent = stats.sync;
  el.syncBadge.className = `badge ${stats.sync === 'in sync' ? 'badge--good' : 'badge--bad'}`;
  el.slotLabel.textContent = `slot ${stats.serverSelected}`;
  el.ackBadge.textContent = stats.lastError || `seq ${rt.seq} <- ${stats.serverSeq}`;
  if (el.panel.hidden) return;
  el.panelBody.innerHTML =
    row('api', apiRoot) +
    row('session', cfg.session) +
    row('last command', rt.lastCommand) +
    row('posts / errors', `${stats.posts} / ${stats.postErrors}`) +
    row('heartbeats / errors', `${stats.heartbeats} / ${stats.heartbeatErrors}`) +
    row('rtt', `${stats.rttMs} ms`) +
    row('client seq -> server seq', `${rt.seq} -> ${stats.serverSeq}`, stats.serverSeq >= rt.seq ? 'ok' : 'bad') +
  row('ack mismatches', stats.ackMismatch, stats.ackMismatch ? 'bad' : 'ok') +
  /* The row that answers "I pressed, why is nothing moving" from the phone side: the server's own words. */
  row('rejected by server', stats.serverRejects, stats.serverRejects ? 'bad' : 'ok') +
  row('server reason', stats.lastServerError || '-', stats.lastServerError ? 'bad' : 'ok') +
    row('overflow dropped', stats.droppedByOverflow, stats.droppedByOverflow ? 'bad' : 'ok') +
    row('geometryMismatch (server)', stats.geometryMismatch, stats.geometryMismatch ? 'bad' : 'ok') +
    row('link error', stats.lastError || '-', stats.lastError ? 'bad' : 'ok') +
    row('fullscreen', stats.fullscreen) +
    row('wake lock', stats.wakeLockHeld ? 'held' : 'no') +
    '<p class="note">keyboard: wasd/arrows = direction &nbsp; space/enter = action &nbsp; e·q / pageup·pagedown = secondary &nbsp; tab (shift+tab) = slot next/prev &nbsp; c = slot prev &nbsp; mouse click = action &nbsp; wheel = secondary &nbsp; esc = clear<br>' +
    'two controllers on the same session share one input: add ?session=name and run the game with --input-session name.</p>';
};

/* ------------------------------------------------------------------ start */
el.padLeft.addEventListener('pointerdown', onLeftDown);
el.padLeft.addEventListener('pointermove', (event) => moveStick(event));
el.padLeft.addEventListener('pointerup', releaseStick);
el.padLeft.addEventListener('pointercancel', releaseStick);
window.addEventListener('resize', syncViewport);
window.addEventListener('orientationchange', () => setTimeout(syncViewport, 150));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
}
el.panel.hidden = !cfg.panelOpen;
measure();
syncViewport();
paint();
if (!cfg.local) {
  setInterval(() => {
    // A held thumb must keep refreshing, or a 5 s keep-alive in the broker would read it as gone;
    // the keep-alive is only the backstop, this is what makes the LEVEL continuous.
    if (rt.published.active && performance.now() - rt.published.at > STICK_REFRESH_MS) publishStick(true);
    heartbeat();
  }, Math.max(HEARTBEAT_MS / 2, STICK_REFRESH_MS));
}
