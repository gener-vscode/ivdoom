/**
 * Game-side input client. THIS file belongs to the game, not to the API: it is the half that knows a
 * paddle needs a fresh level every tick and an action exactly once.
 *
 * The split matters:
 *   `apply()`      - reads the LEVEL (the newest stick) every simulation tick, never consumes anything.
 *   `drainEdges()` - takes the EDGEs out of a local buffer exactly once (an action must not fire twice,
 *                    and must not be lost because the poll happened between two presses).
 * A failed poll keeps the last known level: a dropped packet must not teleport the player's paddle.
 *
 * ─── WHY EVERY COUNTER IN `stats` EXISTS ────────────────────────────────────────────────────────────
 * The first real-device test (2026-10-11) measured: the phone's stick moved, the paddle did NOT follow,
 * and nothing in the log could say WHICH segment broke - the page, the broker, or this file. A probe
 * that cannot name the failing segment is not a probe (the same rule the frame probes learned: an HTTP
 * 200 says nothing about the content). So `apply()` counts what it actually did with the level:
 *
 *   noSessionTicks - the broker has no such session  (wrong `--input-session`, or no page is open)
 *   staleTicks     - a level exists but is older than `stickTtlMs` (the controller is dropping posts)
 *   frozenTicks    - a FRESH level with no horizontal component  <- this is how the real bug showed up
 *   levelTicks     - the level was written into `state.player`
 *
 * plus `lastLevel` (the exact vector and its age) and `report()`, which the runner prints every second.
 * The runner measures `paddleTravel` in world px separately: it is the one number that cannot be
 * explained away by "the panel is only 8 fps".
 */
import { ACTION_NAMES, edgeTerm, horizontalDirectionFromVector } from '../input/protocol.js';
import { isInputStale } from '../input/reducer.js';
import type { InputState, ResolvedEvent } from '../input/reducer.js';
import type { BreakoutState, PlayerControl } from './types.js';

export type RemoteInputOptions = {
  apiBase: string;
  session: string;
  pollMs: number;
  /** a stick older than this belongs to a controller that vanished mid-press */
  stickTtlMs: number;
};

type WireRead = {
  ok: boolean;
  exists: boolean;
  seq: number;
  state?: InputState;
  events?: ResolvedEvent[];
  nextCursor: number;
  droppedBeforeCursor: number;
  reason?: string;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RemoteControl {
  /** Node types give `setInterval` a `Timeout`, the DOM lib a `number` - ReturnType covers both. */
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private busy = false;
  private cursor = 0;
  private latest?: InputState;
  private edges: ResolvedEvent[] = [];
  private lastError = '';
  private lastLevel = 'none';
  private seenDirections = new Set<string>();

  readonly stats = {
    polls: 0,
    pollErrors: 0,
    noSessionPolls: 0,
    levelTicks: 0,
    staleTicks: 0,
    noSessionTicks: 0,
    frozenTicks: 0,
    edges: 0,
    lostEdges: 0,
    primary: 0,
    secondary: 0,
    altUp: 0,
    altDown: 0,
    selects: 0,
    clears: 0,
    directions: 0,
  };

  constructor(private readonly opts: RemoteInputOptions) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
  }

  /** ⚠️ Must be awaited before the process wants to exit: the interval keeps the event loop alive, so a
   *  runner that never calls this prints its summary and then hangs forever. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    while (this.busy) await sleep(20);
  }

  private async poll(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const url = `${this.opts.apiBase}/input/state?session=${encodeURIComponent(this.opts.session)}&since=${this.cursor}&limit=64`;
      const res = await fetch(url);
      const body = (await res.json()) as WireRead;
      this.stats.polls++;
      if (!res.ok || body.ok !== true) {
        this.stats.pollErrors++;
        this.lastError = `${res.status} ${body?.reason ?? ''}`.trim();
        return;
      }
      this.lastError = '';
      // `exists:false` is a real state, not an error: the game may start before anyone opens the page.
      if (!body.exists || !body.state) {
        this.stats.noSessionPolls++;
        this.latest = undefined;
        this.lastLevel = `no session '${this.opts.session}'`;
        return;
      }
      this.latest = body.state;
      this.cursor = body.nextCursor;
      if (Array.isArray(body.events) && body.events.length) this.edges.push(...body.events);
      if (body.droppedBeforeCursor > 0) this.stats.lostEdges += body.droppedBeforeCursor;
    } catch (error) {
      this.stats.pollErrors++;
      this.lastError = String((error as Error)?.message ?? error);
    } finally {
      this.busy = false;
    }
  }

  /**
 * LEVEL, for a game whose player does NOT live in a `BreakoutState` (DOOM keeps its player inside the
 * engine). Deliberately it does not judge anything: whether the level is stale or gone is decided by
 * `isInputStale` in src/input/reducer.ts - which `DoomKeyBridge` already calls - so the TTL rule stays
 * in exactly one place. This hands over what the poll delivered, nothing more.
 */
  latestState(): InputState | undefined {
    return this.latest;
  }

  /**
   * EDGEs, removed from the local buffer exactly once. `drainEdges` is the Breakout-shaped consumer;
   * a game with its own engine takes the events and maps them itself. Counted HERE so the total cannot
   * depend on which consumer took them.
   */
  takeEdges(): ResolvedEvent[] {
    const edges = this.edges.splice(0, this.edges.length);
    this.stats.edges += edges.length;
    return edges;
  }

  private static stop(player: PlayerControl): void {
    // No fresh level means STOP, not "keep doing what we were last doing".
    player.active = false;
    player.dirX = 0;
    player.magnitude = 0;
  }

  /** LEVEL: called once per simulation tick. */
  apply(state: BreakoutState): void {
    const input = this.latest;
    const player = state.player;
    const now = Date.now();

    if (!input || !input.stick) {
      this.stats.noSessionTicks++;
      RemoteControl.stop(player);
      return;
    }
    if (isInputStale(input, now, this.opts.stickTtlMs)) {
      this.stats.staleTicks++;
      this.lastLevel = `stale ${(now - input.stick.updatedAt) | 0}ms (ttl ${this.opts.stickTtlMs}ms)`;
      RemoteControl.stop(player);
      return;
    }

    /*
     * The axis comes from the LEVEL's VECTOR, from `horizontalDirectionFromVector` in protocol.ts.
     * It used to be `directionToAxis(input.stick.direction)` - the 8-WAY LABEL - and that is the bug the
     * user measured on the real panel: `directionToAxis('up')` and `('down')` return x=0 on purpose, so
     * any thumb sample that fell into those two octants froze the paddle while the stick was clearly
     * moving. A one-axis paddle must read how much horizontal push there IS, not which box the vector
     * landed in.
      */
    const axis = horizontalDirectionFromVector(input.stick.x, input.stick.y);
    const age = (now - input.stick.updatedAt) | 0;
    this.stats.levelTicks++;
    if (axis.direction === 0) this.stats.frozenTicks++;
    this.lastLevel = `${input.stick.direction} x=${input.stick.x.toFixed(2)} y=${input.stick.y.toFixed(2)} axis=${axis.direction} mag=${axis.magnitude.toFixed(2)} age=${age}ms`;

    if (!player.active || player.dirX !== axis.direction) this.seenDirections.add(input.stick.direction);
    player.active = true;
    player.dirX = axis.direction;
    player.magnitude = axis.magnitude;
    player.lastInputAt = now;
    this.stats.directions = this.seenDirections.size;
  }

  /** EDGE: consumed exactly once. The engine only acts on `primary` (launch the ball); the rest are
   *  counted so the wiring is provable before any game has a use for them. */
  drainEdges(state: BreakoutState): void {
    for (const edge of this.takeEdges()) {
      if (edge.kind !== 'action' && edge.kind !== 'select' && edge.kind !== 'clear') continue;
      const term = edgeTerm(edge.description);
      if (edge.kind === 'select') {
        this.stats.selects++;
        state.player.selected = state.selectedHint = term === 'next' ? 1 : -1;
        continue;
      }
      if (edge.kind === 'clear') {
        this.stats.clears++;
        state.player.serveRequested = false;
        continue;
      }
      if (term === 'primary') {
        state.player.serveRequested = true;
        this.stats.primary++;
      } else if (term === 'secondary') {
                /* The phone's UPPER-half button (the lower half is `primary`). Breakout has no verb for a second
           button (it never needed one),
           so it is COUNTED and not invented into something else - the same rule as `select` here and as
           `select` in src/game/doom-keys.ts. DOOM does have a verb for it (USE), and that mapping lives in
           the key bridge, not here. */
        this.stats.secondary++;
      } else if (term === 'altUp') {
        state.player.secondaryUp++;
        this.stats.altUp++;
      } else if (term === 'altDown') {
        state.player.secondaryDown++;
        this.stats.altDown++;
      }
    }
  }

  /** One line for the runner's per-second report - the same self-check rule as the frame probes: say
   *  what was DELIVERED and what was ACTED ON, never that a request happened. */
  report(): string {
    const actions = ACTION_NAMES.map((name) => `${name}=${this.latest ? this.latest.actions[name].count : 0}`).join(' ');
    return (
      `input polls=${this.stats.polls} err=${this.stats.pollErrors}${this.stats.noSessionPolls ? ` noSession=${this.stats.noSessionPolls}` : ''} ` +
      `ticks: level=${this.stats.levelTicks} stale=${this.stats.staleTicks} noSession=${this.stats.noSessionTicks} frozen=${this.stats.frozenTicks} ` +
      `edges=${this.stats.edges}${this.stats.lostEdges ? ` LOST=${this.stats.lostEdges}` : ''} primary=${this.stats.primary} secondary=${this.stats.secondary} select=${this.stats.selects} ` +
      `dirsSeen=${this.stats.directions} ${actions} last=[${this.lastLevel}]` +
      (this.lastError ? ` lastError=${this.lastError}` : '')
    );
  }
}
