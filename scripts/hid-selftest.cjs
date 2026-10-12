#!/usr/bin/env node
'use strict';
/**
 * Headless self-test for the HID input layer: no browser, no phone, no panel, no Azure.
 *
 *   yarn build && node scripts/hid-selftest.cjs
 *   node scripts/hid-selftest.cjs --http http://127.0.0.1:7071/api/pixoo   # with `func start` running
 *
 * The rule this file exists for (learned the hard way from the frame probes, see AGENTS.md): never
 * accept that a request SUCCEEDED - read back whether its CONTENT survived. So every assertion here is
 * on the state or the delivered edges, never on a status code or a counter that only means "sent".
 * Like every other probe in scripts/, this imports the COMPILED modules from dist/ (a .cjs probe may
 * not import src/*.ts).
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = (relative) => import(pathToFileURL(path.join(__dirname, '..', relative)).href);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  -> ${detail}` : ''}`);
};

const main = async () => {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--http');
  const base = at === -1 ? undefined : String(argv[at + 1] ?? '').replace(/\/+$/, '');

  const protocol = await load('dist/input/protocol.js');
  const reducer = await load('dist/input/reducer.js');
  const store = await load('dist/input/store.js');
  const staticMod = await load('dist/ui/static.js');

  /* 1 - the direction is DERIVED from the vector, never taken from what the sender claims */
  const compass = [['right', [1, 0]], ['left', [-1, 0]], ['up', [0, -1]], ['down', [0, 1]], ['upLeft', [-1, -1]], ['downRight', [1, 1]]];
  const wrong = compass.filter(([name, [x, y]]) => protocol.directionForVector(x, y) !== name);
  check('directionForVector: 8 octants, screen y down (up = -y)', wrong.length === 0, wrong.map(([name]) => name).join(','));
  const dead = protocol.directionForVector(0.1, 0.05);
  check('below STICK_DEADZONE means no direction', dead === 'none', dead);

    /* 2 - validation returns a REASON; it never invents a value and never silently ignores a bad event.
       Since 2026-10-11 the two halves are separated ON PURPOSE. An ENVELOPE problem (no session, seq<1, no
       events, not an object) makes the whole POST unusable. A bad EVENT is reported per event and must NOT
       discard the valid events travelling beside it: that whole-batch refusal is the bug the user measured -
       the phone's thumb-down sample (x=0,y=0) refused every batch it ever requeued, so nothing landed and
       `GET /input/sessions` stayed empty while the host ran `hidInputIngest` constantly. */
    const envelope = [
        { session: 'main', seq: 1, events: [] },
        { session: 'main', seq: 0, events: [{ kind: 'action', action: 'primary' }] },
        { session: 'bad session!', seq: 1, events: [{ kind: 'action', action: 'primary' }] },
        'not-an-object',
    ];
    const envelopeAccepted = envelope.filter((body) => protocol.validatePost(body).ok);
    check('validatePost refuses an unusable envelope: empty events / seq<1 / bad session chars / non-object', envelopeAccepted.length === 0 && envelope.every((body) => Boolean(protocol.validatePost(body).reason)), `refused ${envelope.length - envelopeAccepted.length}/${envelope.length}`);

    const badEvents = [
        { kind: 'stick', id: 'm', x: Number.NaN, y: 0.5, direction: 'left' },
        { kind: 'stick', id: 'm', x: 0, y: 0, direction: 'none' },
        { kind: 'teleport' },
    ];
    const carried = badEvents.map((event) => protocol.validatePost({ session: 'main', seq: 1, events: [event, { kind: 'action', action: 'primary' }] }));
    check('a bad event is REJECTED PER EVENT and the valid event beside it survives', carried.every((r) => r.ok === true && r.rejected.length === 1 && r.post.events.length === 1 && Boolean(r.rejected[0].reason) && Boolean(r.rejected[0].event)), JSON.stringify(carried.map((r) => ({ ok: r.ok, kept: (r.post || { events: [] }).events.length, rejected: r.rejected }))));
    const allBad = protocol.validatePost({ session: 'main', seq: 1, events: badEvents });
    check('a batch with NOTHING valid is described, not accepted as an empty success', allBad.ok === true && allBad.post.events.length === 0 && allBad.rejected.length === badEvents.length, JSON.stringify(allBad.rejected));
    const store2 = new store.InputStore({ maxSessions: 2, idleTtlMs: 60_000, ringCapacity: 8 });
    const mixed = store2.ingest({ session: 'mixed', seq: 1, events: [{ kind: 'stick', id: 'm', x: 0, y: 0, direction: 'none' }, { kind: 'action', action: 'primary', source: 'touchRight' }] }, 'selftest');
    check('the broker keeps the tap when a stick sample beside it is malformed', mixed.ok === true && mixed.applied === 1 && mixed.rejected.length === 1 && mixed.received === 2 && mixed.state.actions.primary.count === 1, JSON.stringify({ ok: mixed.ok, received: mixed.received, applied: mixed.applied, rejected: mixed.rejected }));
    const junkPost = store2.ingest({ session: 'junk', seq: 1, events: [{ kind: 'teleport' }] }, 'selftest');
    check('a POST that creates no session is COUNTED and quotable (stats() answers "no session" vs "no POST")', junkPost.ok === false && /no-valid-event/.test(String(junkPost.reason)) && store2.stats().refusedPosts === 1 && store2.stats().lastRefused.some((row) => row.session === 'junk') && store2.list().every((row) => row.session !== 'junk'), JSON.stringify(store2.stats().lastRefused));

  /* 3 - LEVEL vs EDGE: the whole reason a bare "POST the key" was not enough */
  const s = new store.InputStore({ maxSessions: 4, idleTtlMs: 60_000, ringCapacity: 64 });
  const post = (events, seq) => s.ingest({ session: 'probe', seq, events }, 'selftest');
  const stick = (x, y, direction = 'left') => ({ kind: 'stick', id: 'm', x, y, magnitude: Math.hypot(x, y), direction });

  const first = post([stick(-1, 0)], 1);
  const held = [post([stick(-1, 0.02)], 2), post([stick(-1, 0.04)], 3), post([stick(-0.99, 0.05)], 4)];
  check('a held direction publishes ONE edge; later samples are coalesced levels', first.applied === 1 && held.every((r) => r.applied === 0 && r.coalesced === 1), JSON.stringify(held.map((r) => [r.applied, r.coalesced])));
  const level = s.read('probe', 0, 64).state.stick;
  check('the LEVEL is always the newest value, not the first one', level.x < -0.9 && level.magnitude > 0.99, JSON.stringify({ x: level.x, magnitude: level.magnitude }));
  const turned = post([stick(1, 0, 'right')], 5);
  check('changing direction is an edge again', turned.applied === 1, JSON.stringify({ applied: turned.applied }));

  /* 4 - an edge that arrives while nobody is polling must still be delivered, exactly once */
  post([{ kind: 'action', action: 'primary' }, { kind: 'action', action: 'altUp' }, { kind: 'select', direction: 'next' }], 6);
  const read = s.read('probe', 0, 64);
  const edges = read.events.filter((event) => event.kind === 'action' || event.kind === 'select');
  check('presses between two polls are all delivered', edges.length === 3, JSON.stringify(edges.map((event) => event.kind)));
  check('the select became server state (a game may ignore it, the controller count must not drift)', read.state.selected === 1 && read.state.actions.altUp.count === 1, `selected=${read.state.selected} altUp=${read.state.actions.altUp.count}`);
  const replay = s.read('probe', read.nextCursor, 64);
  check('a cursor consumes an edge exactly once', replay.events.length === 0 && replay.nextCursor === read.nextCursor, JSON.stringify(replay.events.map((event) => event.seq)));

  /* 5 - a disagreement between claimed and computed geometry is COUNTED, and the geometry wins */
  const lied = post([stick(0.9, 0, 'left')], 7);
  const afterLie = s.read('probe', 0, 64).state.stick;
  check('claimed direction is not trusted; geometryMismatch is reported', lied.state.counts.geometryMismatch >= 1 && afterLie.direction === 'right' && afterLie.claimedDirection === 'left', `server=${afterLie.direction} claimed=${afterLie.claimedDirection}`);

  /* 6 - a sender that resends an old sequence is refused with a reason, not accepted twice */
  const stale = post([{ kind: 'action', action: 'primary' }], 5);
  check('a stale client seq is refused with a reason', stale.ok === false && /stale-client-seq/.test(String(stale.reason)), String(stale.reason));

  /* 7 - the human auto-repeat guard: one press, then a burst, both measured against the same clock */
  await sleep(40);
  const pressed = post([{ kind: 'action', action: 'altDown' }], 8);
  const burst = post([{ kind: 'action', action: 'altDown' }], 9);
  check('the same action twice within the burst window is auto-repeat, not two presses', pressed.applied === 1 && burst.applied === 0 && burst.rejected.length === 1, JSON.stringify(burst.rejected));

    /* 9 - a controller that vanished mid-press must stop driving the paddle. Done BEFORE the clear, and
     *      this is the fact that makes the order necessary: `read().state` is the LIVE object on purpose
     *      (a game must always see the newest level), so it is not a snapshot - a stale test needs a
     *      still-active stick, and any value you want to compare across a later post must be copied now. */
    const live = s.read('probe', 0, 64).state;
    check('isInputStale: an ACTIVE stick is stale only once it is older than the TTL', live.stick.active === true && reducer.isInputStale(live, Date.now(), 300) === false && reducer.isInputStale(live, Date.now() + 1400, 300) === true, `active=${live.stick.active}`);

    /* 8 - `clear` must drop the live input but KEEP the identity and the sequence, or every consumer
     *      cursor would restart and replay a whole session */
    const cleared = post([{ kind: 'clear' }], 10);
    const clearedRead = s.read('probe', 0, 64);
    const clearedSeq = clearedRead.seq;
    const clearedSelected = clearedRead.state.selected;
    const clearedClientSeq = clearedRead.state.lastClientSeq;
    const stickAfterClear = clearedRead.state.stick.active;
    await sleep(40);
    const afterClear = post([{ kind: 'action', action: 'primary' }], 11);
    check('clear resets the input but keeps the sequence monotonic', cleared.ok === true && clearedSelected === 0 && stickAfterClear === false && clearedClientSeq === 10 && afterClear.applied === 1 && afterClear.seq > clearedSeq, `seq=${clearedSeq} -> ${afterClear.seq}`);

  /* 10 - a ring that overflowed must report what it dropped, not pretend the history is complete */
    /* `select` on purpose: it has no auto-repeat guard, so this test measures the RING and not the burst
     * rule (the first attempt used two actions and the burst guard correctly rejected them - the test was
     * wrong, not the reducer). */
    const tiny = new store.InputStore({ maxSessions: 2, idleTtlMs: 60_000, ringCapacity: 3 });
    for (let i = 0; i < 8; i++) tiny.ingest({ session: 'overflow', seq: i + 1, events: [{ kind: 'select', direction: 'next' }] }, 'selftest');
  const overflow = tiny.read('overflow', 0, 64);
  check('ring overflow is visible to the consumer (droppedBeforeCursor / evictedEdges)', overflow.events.length === 3 && overflow.evictedEdges === 5 && overflow.droppedBeforeCursor === 5, `edges=${overflow.events.length} evicted=${overflow.evictedEdges} dropped=${overflow.droppedBeforeCursor}`);

  /* 11 - an idle session expires; it cannot be read as live input forever */
  const ttl = new store.InputStore({ maxSessions: 4, idleTtlMs: 1000, ringCapacity: 8 });
  ttl.ingest({ session: 'gone', seq: 1, events: [{ kind: 'action', action: 'primary' }] }, 'selftest');
  const before = ttl.list().length;
  await sleep(1100);
  ttl.ingest({ session: 'alive', seq: 1, events: [{ kind: 'action', action: 'primary' }] }, 'selftest');
  const live2 = ttl.list().map((entry) => entry.session);
  check('idle sessions expire and the count stays visible', before === 1 && !live2.includes('gone') && live2.includes('alive'), JSON.stringify(live2));

  /* 12 - the static route: only files inside resources/ui, and the page really is the controller */
  const entry = staticMod.resolveAsset('');
  const app = staticMod.resolveAsset('app.js');
  const escaped = staticMod.resolveAsset('../package.json');
  const hidden = staticMod.resolveAsset('.ssh');
  const missing = staticMod.resolveAsset('nope');
  check('ui resolves to the controller, and only inside the ui root', entry.status === 200 && String(entry.contentType).startsWith('text/html') && app.status === 200 && String(app.contentType).startsWith('text/javascript') && escaped.status === 400 && hidden.status === 400 && missing.status === 404, `entry=${entry.status} app=${app.status} escape=${escaped.status} dot=${hidden.status} missing=${missing.status}`);
  const pageIsAController = typeof entry.body === 'string' && entry.body.includes('id="padLeft"') && entry.body.includes('id="padRight"') && typeof app.body === 'string' && app.body.includes('pointermove') && app.body.includes('keydown');
  check('served content is actually the two-thumb controller with listeners', pageIsAController, '');

  /* ---- and the same contract through the real HTTP routes, when a host is given ---- */
    if (base) {
        /* A unique session per run. Re-using a name against a live host is correctly refused as
         * `stale-client-seq` (the store remembers the last sender seq) - that is the store being right, and a
         * wire test must not report its own second run as a failure. */
        const session = `selftest-${Date.now().toString(36)}`;
    const posted = await fetch(`${base}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, seq: 1, events: [stick(-1, 0), { kind: 'action', action: 'primary', source: 'probe' }] }) }).then((res) => res.json());
    check('POST /input accounts for every event it was sent', posted.ok === true && posted.applied + posted.coalesced + posted.rejected.length === 2, JSON.stringify(posted));
    const got = await fetch(`${base}/input/state?session=${session}&since=0&limit=64`).then((res) => res.json());
    check('GET /input/state returns the level AND the edges', got.exists === true && got.state.stick.direction === 'left' && got.events.filter((event) => event.kind === 'action').length === 1, `dir=${got.state && got.state.stick.direction} edges=${got.events.length}`);
    const absent = await fetch(`${base}/input/state?session=nobody-was-here`).then((res) => res.json());
    check('an unknown session is an empty read, not an error', absent.ok === true && absent.exists === false, JSON.stringify(absent));
    const list = await fetch(`${base}/input/sessions`).then((res) => res.json());
    check('GET /input/sessions lists the live sessions', Array.isArray(list.sessions) && list.sessions.some((entry2) => entry2.session === session), JSON.stringify((list.sessions ?? []).map((entry2) => entry2.session)));
    const page = await fetch(`${base}/ui/`);
    const pageBody = await page.text();
    const asset = await fetch(`${base}/ui/app.js`);
    const dot = await fetch(`${base}/ui/.ssh`);
    const missingAsset = await fetch(`${base}/ui/nope`);
    const redirect = await fetch(`${base}/ui`, { redirect: 'manual' });
    check('the Function App serves the page and its own assets (no second server)', page.status === 200 && String(page.headers.get('content-type')).includes('text/html') && pageBody.includes('id="padLeft"') && asset.status === 200 && dot.status === 400 && missingAsset.status === 404 && redirect.status === 302, `page=${page.status} asset=${asset.status} dot=${dot.status} missing=${missingAsset.status} redirect=${redirect.status} -> ${redirect.headers.get('location')}`);
  } else {
    console.log('ℹ️  pass --http http://127.0.0.1:7071/api/pixoo to also test the live functions (start them with `yarn dev:lan`).');
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
  process.exitCode = failed ? 1 : 0;
};

main().catch((error) => {
  console.error('selftest crashed:', error);
  process.exitCode = 1;
});
