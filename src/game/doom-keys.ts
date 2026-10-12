/**
 * PHONE CONTROLLER  →  DOOM'S OWN KEYMAP
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * The engine needs key events (`DG_GetKey`) and nothing else; the phone gives a LEVEL (the stick)
 * and a set of edges (a tap, a slide). This file is the only place that turns one into the other, so
 * the mapping is testable headlessly before it can ever be blamed for "DOOM is not listening".
 *
 * THE WIRE IT WRITES is the one already proven against the real engine (`scripts/doom/dg_stdio.c`,
 * `scripts/doom-input-check.cjs`) - `<press> <decimal key>` and `r` to release everything held.
 * That run reported `DG_INPUT parsed=3 rejected=0 keys_still_held=0` AND moved the player: 172 turned
 * the view, 173 walked, 163 made the engine set its own `attackdown`. Those three bytes are therefore
 * not a guess. `use/strafe` come from `doomkeys.h` and are exercised by nothing yet.
 *
 * WHY EACH AXIS IS ITS OWN DECISION (this is the mistake that froze the Breakout paddle). A thumb that
 * is nearly straight up has x = 0.05, y = -0.9. Deriving the direction LABEL first and then an axis
 * from it is exactly how `directionToAxis('up'|'down') → x = 0` silently froze a paddle on 2026-10-11.
 * Here: forward/back come from the SIGN OF Y, turning from the SIGN OF X, each gated by the SAME
 * `STICK_DEADZONE` as the rest of the project. A diagonal therefore walks AND turns (which is what a
 * stick does in a tank-controlled game), a purely vertical hold walks and does not turn, a purely
 * horizontal hold turns and does not walk, and letting go stops - no stuck keys, no frozen axis.
 *
 * LEVEL vs EDGE is preserved: a LEVEL publishes only its CHANGES (a held thumb must not re-press a key
 * 40 times a second), an EDGE is consumed exactly once, and DOOM cannot hold a key without us also
 * releasing it - so a tap writes the press AND the release.
 */
import { STICK_DEADZONE, edgeTerm } from '../input/protocol.js';
import { isInputStale } from '../input/reducer.js';
import type { InputState, ResolvedEvent } from '../input/reducer.js';

/** `doomkeys.h`, verbatim. 172 / 173 / 163 were proven against the running engine (see the header). */
export const DOOM_KEYS = {
  strafeLeft: 0xa0,
  strafeRight: 0xa1,
  use: 0xa2,
  fire: 0xa3,
    left: 0xac,
    up: 0xad,
    right: 0xae,
    down: 0xaf,
} as const;

/** Only the stick is needed here, so the caller may pass a full `InputState` or just its stick. */
type LevelHolder = Pick<InputState, 'stick'>;

/**
 * One source of the TTL rule: `isInputStale` in src/input/reducer.ts reads NOTHING but
 * `state.stick.active` and `state.stick.updatedAt` (line 181-182 of that file), so a stick-bearing
 * object is enough. The cast says exactly that, instead of re-implementing "stale" a second time and
 * letting the two copies drift.
 */
const isLevelStale = (holder: LevelHolder, now: number, ttlMs: number): boolean =>
    isInputStale(holder as InputState, now, ttlMs);

export type DoomKeyOptions = {
  /** Writes one line to the engine's stdin. The runner owns the process; this owns the meaning. */
  sink: (line: string) => void;
  /** A stick older than this belongs to a controller that vanished mid-press: DOOM must stop. */
  stickTtlMs: number;
  /**
   * `arrows` (default) is the only pairing this repo has MEASURED: 172/173 moved the view and the
   * player in `yarn doom:input-check`. `strafe` swaps the horizontal pair for KEY_STRAFE_L/R, which
   * is a keymap change this engine has never been tested with - do not use it without a new proof.
   */
    horizontal?: 'turn' | 'strafe';
    /**
     * How long a TAP holds its key down before releasing it. This is a MEASURED number, not a style one: an
     * engine tic is 1/35 s = 28.6 ms, and `scripts/doom-tap-check.cjs` measured that a press+release written
     * in the SAME batch never reaches `attackdown` (atkSamples=0 over 12 taps, `parsed` counted every line),
     * while the identical key released 120 ms later does (atkSamples=6). A tap must therefore be held past at
     * least one engine tic. Default 120 ms ≈ 4 tics.
     */
    keyHoldMs?: number;
};

export class DoomKeyBridge {
    private held = new Set<number>();
    /** key -> the time its release is due. A tap's release is DEFERRED on purpose: see `tap`. */
    private pendingTaps = new Map<number, number>();
  private lastIntent = 'none';
  private lastReason = 'no input yet';

  readonly stats = {
    ticks: 0,
    levelTicks: 0,
    staleTicks: 0,
    noSessionTicks: 0,
    /** a LEVEL arrived but carries NO movement intent at all (both axes inside the dead zone) */
    frozenTicks: 0,
    keysDown: 0,
    keysUp: 0,
    lines: 0,
    edges: 0,
    fire: 0,
    use: 0,
    /** counted, deliberately NOT mapped: the engine has no verified "next weapon" key in this repo */
    selects: 0,
    clears: 0,
  };

  constructor(private readonly opts: DoomKeyOptions) {}

  /**
   * LEVEL. Safe to call every tick: a repeated level writes nothing.
   * Returns the keys that are down after this call, for the runner's diagnostics.
   */
    applyLevel(input: LevelHolder | undefined, now: number = Date.now()): number[] {
        this.stats.ticks++;
        /* The tick ALSO releases the taps whose hold is over: only the caller that owns the supply loop can
           say when a tick happened, so the release is emitted here and not from a timer of its own. */
        this.flushTaps(now);
    if (!input || !input.stick || !input.stick.active) {
      this.stats.noSessionTicks++;
      this.lastReason = input ? 'stick not active' : 'no session state';
      this.releaseAll('no level');
      return [];
    }
      if (isLevelStale(input, now, this.opts.stickTtlMs)) {
      this.stats.staleTicks++;
      this.lastReason = `level stale ${(now - input.stick.updatedAt) | 0}ms (ttl ${this.opts.stickTtlMs}ms)`;
      this.releaseAll('stale level');
      return [];
    }

    const { x, y } = input.stick;
    const want = new Set<number>();
    const horizontal = this.opts.horizontal ?? 'turn';
    /* Each axis decides for itself, against the shared dead zone. Reading a label instead is what
       froze the paddle before; see the header of this file. */
    if (x <= -STICK_DEADZONE) want.add(horizontal === 'turn' ? DOOM_KEYS.left : DOOM_KEYS.strafeLeft);
    if (x >= STICK_DEADZONE) want.add(horizontal === 'turn' ? DOOM_KEYS.right : DOOM_KEYS.strafeRight);
    if (y <= -STICK_DEADZONE) want.add(DOOM_KEYS.up);
    if (y >= STICK_DEADZONE) want.add(DOOM_KEYS.down);

    this.stats.levelTicks++;
    if (!want.size) this.stats.frozenTicks++;
    this.lastIntent =
      `x=${x.toFixed(2)} y=${y.toFixed(2)} → ${[...want].map((key) => KEY_NAMES[key] ?? `0x${key.toString(16)}`).join('+') || 'nothing'}`;
    this.writeDiff(want);
    return [...this.held];
  }

  /** EDGE. Consumed exactly once, and always released again in the same call (a tap IS a tap). */
  applyEdges(edges: ResolvedEvent[]): void {
    for (const edge of edges) {
      this.stats.edges++;
      if (edge.kind === 'clear') {
        /* The phone's Esc / clear: stop moving. Not "release the fire button" - nothing is held there. */
        this.stats.clears++;
        this.releaseAll('clear');
        continue;
      }
      if (edge.kind === 'select') {
        this.stats.selects++;
        continue;
      }
      if (edge.kind !== 'action') continue;
        const term = edgeTerm(edge.description);
        /* `primary` is the LOWER HALF of the action pad (the user's control choice, reversed 2026-10-12
           12:41 after the first playable run) = FIRE; `secondary` is the UPPER HALF = USE. Nothing about
           this mapping moved - only which half of the phone pad produces which term, and that lives in
           resources/ui/app.js. `altUp`/`altDown` arrive from a slide or the keyboard and DOOM has no reason
           to tell them apart from the upper half - same verb, different gesture, and the counters keep them
           separate (`fire` vs `use`) so a log can still say which one fired. */
        if (term === 'primary') {
            this.stats.fire++;
            this.tap(DOOM_KEYS.fire);
        } else if (term === 'secondary' || term === 'altUp' || term === 'altDown') {
            this.stats.use++;
            this.tap(DOOM_KEYS.use);
        }
    }
  }

    /**
     * A tap is a press AND a release - but NEVER in the same write. MEASURED (scripts/doom-tap-check.cjs):
     * `1 163` followed immediately by `0 163` in one batch leaves the engine's tic command with nothing
     * pressed, so `attackdown` stays 0 for the whole 12-tap phase; the same key released 120 ms later fires.
     * That is exactly the difference between walking (a LEVEL, held across tics, works) and a gun (an EDGE).
     * The key goes into `held` so `r`, the stuck-key counters and a `clear` all still see it.
     */
    private tap(key: number): void {
        this.write(`1 ${key}`);
        this.stats.keysDown++;
        this.held.add(key);
        this.pendingTaps.set(key, Date.now() + (this.opts.keyHoldMs ?? 120));
    }

    /** Release every tap whose hold is over. Public so a test can prove the two halves separately. */
    flushTaps(now: number = Date.now()): void {
        for (const [key, dueAt] of [...this.pendingTaps]) {
            if (now < dueAt) continue;
            this.pendingTaps.delete(key);
            if (!this.held.has(key)) continue;
            this.held.delete(key);
            this.write(`0 ${key}`);
            this.stats.keysUp++;
        }
    }

  /** Only the DIFFERENCE is written - a held thumb never re-presses. */
  private writeDiff(want: Set<number>): void {
    for (const key of want)
      if (!this.held.has(key)) {
        this.held.add(key);
        this.write(`1 ${key}`);
        this.stats.keysDown++;
      }
    for (const key of [...this.held])
      if (!want.has(key)) {
        this.held.delete(key);
        this.write(`0 ${key}`);
        this.stats.keysUp++;
      }
  }

  /**
   * `r` = release EVERYTHING the driver is holding. Used by a removed level, a `clear`, and every exit
   * path: the engine's own proof run ended with the player completely stopped because of this line.
   */
  releaseAll(reason: string): void {
    if (this.held.size) {
      this.write('r');
      this.stats.keysUp += this.held.size;
          this.held.clear();
      }
      /* `r` releases everything the driver is holding, deferred tap releases included: writing them again
         would release a key that is no longer down. */
      this.pendingTaps.clear();
      this.lastReason = reason;
    this.lastIntent = 'none';
  }

  private write(line: string): void {
    this.opts.sink(line);
    this.stats.lines++;
  }

  /**
   * The runner prints this every second. Same rule as the frame probes and as `RemoteControl#report()`:
   * say what was DELIVERED and what was ACTED ON. `held=` is the one field that catches a stuck key.
   */
  report(): string {
    return (
      `doomkeys ticks=${this.stats.ticks} level=${this.stats.levelTicks} stale=${this.stats.staleTicks} ` +
      `noSession=${this.stats.noSessionTicks} frozen=${this.stats.frozenTicks} ` +
      `down=${this.stats.keysDown} up=${this.stats.keysUp} held=${[...this.held].join(',') || '-'} ` +
      `lines=${this.stats.lines} edges=${this.stats.edges} fire=${this.stats.fire} use=${this.stats.use} ` +
      `select=${this.stats.selects} clear=${this.stats.clears} intent=[${this.lastIntent}] reason=${this.lastReason}`
    );
  }
}

const KEY_NAMES: Record<number, string> = {
  [DOOM_KEYS.strafeLeft]: 'strafeLeft',
  [DOOM_KEYS.strafeRight]: 'strafeRight',
  [DOOM_KEYS.use]: 'use',
  [DOOM_KEYS.fire]: 'fire',
  [DOOM_KEYS.left]: 'turnLeft',
  [DOOM_KEYS.up]: 'forward',
  [DOOM_KEYS.right]: 'turnRight',
  [DOOM_KEYS.down]: 'backward',
};


