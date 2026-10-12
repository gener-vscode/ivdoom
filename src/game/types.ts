/**
 * Shared types for the Pixoo mini-game engine.
 *
 * The engine is deliberately dependency-free: game state is a plain mutable
 * object, `step()` advances it by exactly one fixed tick, and the renderer only
 * ever *reads* it. That keeps the simulation deterministic (same seed => same
 * play-by-play) and testable without a device.
 */

export type Rgb = [number, number, number];

export type GameStatus = 'serve' | 'playing' | 'lifeLost' | 'levelClear' | 'gameOver';

/** Things that happened during a tick - used for sound + stats, never for logic. */
export type GameEvent = 'brick' | 'paddle' | 'wall' | 'ceiling' | 'life' | 'levelClear' | 'gameOver';

export type Brick = {
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
  hits: number;
  required: number;
  /**
   * Index into the brick palette (`render.ts` `PALETTE.bricks`).
   * Assigned ONCE when the wall is built, from a seeded PRNG, so a brick keeps the same colour for
   * its whole life - the layout is random per level/seed but identical in every frame.
   * With no margins between bricks, colour is the only thing that makes one brick separable from
   * its neighbour, so each row is a permutation of the palette (no two columns in a row repeat).
   */
  ci: number;
};

export type Ball = {
  x: number;
  y: number;
  /** previous position, used for swept collision tests */
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
};

export type Paddle = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** max horizontal speed in world units / second */
  speed: number;
};

/** Computer player: re-plans only every N ms, which is what makes it beatable. */
export type AiBrain = {
  thinkUntil: number;
  targetX: number;
  bias: number;
};

/**
 * Human/HID channel. It is a LEVEL (`active`/`dirX`/`magnitude`) plus the last EDGE that was consumed
 * (`serveRequested`, the secondary counters). The engine never talks to HTTP: whatever drives the
 * paddle writes THIS, which is what lets the same `step()` run with a CPU, a phone or a keyboard.
 */
export type PlayerControl = {
  active: boolean;
  /**
   * -1 | 0 | +1. It is a SIGN, and `magnitude` below is its size: both come from
   * `horizontalDirectionFromVector(x, y)` in src/input/protocol.ts, i.e. from the stick VECTOR.
   * ⚠️ Do not rebuild this from the 8-way direction label: `directionToAxis('up' | 'down')` is x = 0 by
   * design, which silently freezes a one-axis paddle whenever a thumb lands in those octants. That was
   * the measured cause of "the stick moves but the paddle does not respect my control" (2026-10-11).
   */
  dirX: number;
  /** 0..1 - how far the deflection actually pushes ALONG that axis */
  magnitude: number;
  serveRequested: boolean;
  secondaryUp: number;
  secondaryDown: number;
  selected: number;
  lastInputAt: number;
};

export type GameStats = {
  ticks: number;
  brickHits: number;
  bricksBroken: number;
  paddleHits: number;
  wallHits: number;
  livesLost: number;
  levelsCleared: number;
};

export type GameOptions = {
    level: number;
    lives: number;
    /** CPU paddle max speed in world units / second */
    aiSpeed: number;
    /** how often the CPU re-plans, in ms */
    aiReactionMs: number;
    /** aiming error in world units, makes the CPU beatable */
    aiErrorPx: number;
    /** ball speed at level 1, world units / second */
    ballSpeed: number;
  ballSpeedPerLevel: number;
  maxBallSpeed: number;
  /** who moves the paddle: 'ai' (the CPU in breakout.ts) or 'player' (a value written into state.player) */
  control: 'ai' | 'player';
  /** human paddle max speed in world units / second */
  playerSpeed: number;
  /**
   * The interval (ms) that ONE DISPLAYED FRAME costs on this panel — i.e. the `pace` the supply loop
   * holds between pushes. When it is > 0 the human paddle may never travel more than `playerWidthBudget`
   * of its OWN width inside one displayed frame: `movePaddleByInput` splits that budget across the
   * simulation ticks that fit in the interval.
   *
   * This is the rule the user asked for on 2026-10-11 ("the paddle moving too fast per delta… half of
   * paddle width per trigger"). Measured cause: the physics runs at 30 Hz while this panel paints ~8 fps
   * at PicWidth 32 and ~5 fps at 64, so `playerSpeed 150` = 5 px/tick = **16–30 world px per frame you
   * actually see** ≈ a whole paddle width per frame. With the budget held at 0.5 the same game shows
   * ≈ 8 px per frame (≈66 px/s at the verified pace 120 ms @32, ≈40 px/s at 200 ms @64).
   * 0 = no cap (headless default; a run that is not attached to a panel has no frame interval).
   */
  playerFrameMs: number;
  /** Fraction of its own width the human paddle may travel per displayed frame. Default 0.5 = half. */
  playerWidthBudget: number;
};

export type BreakoutState = {
    /** seedable PRNG state (mulberry32) */
    rngState: number;
  /** simulated time in ms; the tick loop is driven by wall-clock catch-up */
  time: number;
  status: GameStatus;
  statusUntil: number;
  score: number;
  lives: number;
  level: number;
  bricks: Brick[];
  ball: Ball;
  paddle: Paddle;
  ai: AiBrain;
  /** always present; only read when `GameOptions.control === 'player'` */
  player: PlayerControl;
  selectedHint: number;
  stats: GameStats;
};
