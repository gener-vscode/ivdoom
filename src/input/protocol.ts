/**
 * HID wire protocol - the ONE definition shared by the controller page (`resources/ui/`), the
 * Function-App broker (`src/functions/input.ts`) and the game loop (`src/game/remote-control.ts`).
 *
 * Zero imports, exactly like `src/pixoo/pacing.ts`: these are facts about the contract, not the
 * behaviour of one side. When the game engine moves to its own repository, THIS is the file that
 * travels with it - the controller and the API keep importing the same copy.
 *
 * Two kinds of input, and the difference IS the design:
 *   LEVEL - the left stick. State, not history. The broker keeps only the newest value and a
 *           consumer reads it every frame. Ring-buffering 40 stick samples per second would only let
 *           a slow poller act on last week's position.
 *   EDGE  - a tap, an action press, an action switch. Must never be lost, so edges go into a
 *           per-session ring that is consumed with a cursor (`since`). A tap that happens *between*
 *           two polls is still delivered - that is why "just POST the key" was not enough.
 */

export const PROTOCOL_VERSION = 1;

export type InputSource = 'touchLeft' | 'touchRight' | 'keys' | 'mouse' | 'wheel' | 'probe';
export const INPUT_SOURCES: InputSource[] = ['touchLeft', 'touchRight', 'keys', 'mouse', 'wheel', 'probe'];

/**
 * Semantic names only. What a press MEANS is the game's business; the controller knows gestures.
 *
 * `primary` / `secondary` are named by WHICH PART OF THE ACTION PAD the finger landed on (the user's
 * control choice of 2026-10-12: LOWER half = the main action, UPPER half = the other one), so they are
 * position-derived and work as an ordinary two-button pad. `primary` always means "this pad's main action";
 * the two names never encode a verb - only where on the pad the press landed. `altUp` / `altDown` are named by a GESTURE
 * (a vertical slide past the threshold, or the keyboard's E/Q · PageUp/PageDown) — that is a different
 * input, and keeping the names separate is what lets a log say which one happened. A game may decide
 * both mean the same verb; the wire never collapses them.
 */
export type ActionName = 'primary' | 'secondary' | 'altUp' | 'altDown';
export const ACTION_NAMES: ActionName[] = ['primary', 'secondary', 'altUp', 'altDown'];

export type DirectionName = 'none' | 'up' | 'down' | 'left' | 'right' | 'upLeft' | 'upRight' | 'downLeft' | 'downRight';
export const DIRECTIONS: DirectionName[] = ['none', 'up', 'down', 'left', 'right', 'upLeft', 'upRight', 'downLeft', 'downRight'];

export type StickEvent = { kind: 'stick'; id: string; x: number; y: number; magnitude: number; direction: DirectionName; source: InputSource };
export type ReleaseEvent = { kind: 'release'; id: string; source: InputSource };
export type ActionEvent = { kind: 'action'; action: ActionName; source: InputSource };
export type SelectEvent = { kind: 'select'; direction: 'next' | 'prev'; source: InputSource };
export type ClearEvent = { kind: 'clear'; source: InputSource };
export type RawInputEvent = StickEvent | ReleaseEvent | ActionEvent | SelectEvent | ClearEvent;

/** One controller -> broker POST. `seq` is the sender's own counter; it only has to increase. */
export type InputPost = { session: string; seq: number; sentAt?: number; agent?: string; events: RawInputEvent[] };

export const LIMITS = {
  sessionMax: 64,
  stickIdMax: 16,
  agentMax: 160,
  eventsPerPost: 32,
  selectedClamp: 4096,
};

/** Identical threshold at both ends of the wire, so "no direction" cannot mean two things. */
export const STICK_DEADZONE = 0.18;

export const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));
const isString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isSource = (value: unknown): value is InputSource => INPUT_SOURCES.includes(value as InputSource);
const isDirectionName = (value: unknown): value is DirectionName => DIRECTIONS.includes(value as DirectionName);

/**
 * The server derives the direction FROM THE VECTOR and never trusts the claimed one; a disagreement is
 * counted (`geometryMismatch`) instead of swallowed. Same rule as the frame probes: proving a message
 * arrived proves nothing about whether its CONTENT still meant what it claimed.
 * Screen y points down, so 'up' is -y (that is also what the controller page draws).
 */
export const directionForVector = (x: number, y: number): DirectionName => {
  const magnitude = Math.hypot(x, y);
  if (!Number.isFinite(magnitude) || magnitude < STICK_DEADZONE) return 'none';
  const octant = Math.round((((Math.atan2(-y, x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4))) % 8;
  const table: DirectionName[] = ['right', 'upRight', 'up', 'upLeft', 'left', 'downLeft', 'down', 'downRight'];
  return table[octant];
};

export const directionToAxis = (direction: DirectionName): { x: number; y: number } => {
  switch (direction) {
    case 'left':
    case 'upLeft':
    case 'downLeft':
      return { x: -1, y: 0 };
    case 'right':
    case 'upRight':
    case 'downRight':
      return { x: 1, y: 0 };
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
    default:
      return { x: 0, y: 0 };
    }
};

/**
 * A ONE-AXIS control (a Breakout paddle) must read the VECTOR, not the 8-way label.
 *
 * `directionToAxis` is right for a 4-way game - its x IS zero for 'up'/'down' on purpose - but a thumb
 * on a touch pad is never axis-perfect: keeping a paddle pressed against the left edge reads as a drag
 * that wanders through 'left', 'upLeft' and sometimes plain 'up'. With the label, every sample that
 * lands inside the 'up' or 'down' octant freezes the paddle. That is what the first real-device test
 * measured on 2026-10-11 - "the analog stick moves, but the paddle does not respect my control" - and it
 * was invisible in the log because a frozen level and an undelivered level look exactly the same.
 *
 * Here `direction` is the SIGN of the horizontal component and `magnitude` is its SIZE (0..1): a purely
 * vertical hold contributes nothing (correct - there is no horizontal intent), a diagonal still moves,
 * and a light touch moves slowly. The SAME `STICK_DEADZONE` gates it, so "no direction" still cannot
 * mean two things on either side of the wire.
 */
export const horizontalDirectionFromVector = (x: number, y: number): { direction: number; magnitude: number } => {
  const length = Math.hypot(x, y);
  if (!Number.isFinite(length) || length < STICK_DEADZONE) return { direction: 0, magnitude: 0 };
  const dx = Math.max(-1, Math.min(1, Number.isFinite(x) ? x : 0));
  return { direction: Math.sign(dx), magnitude: Math.abs(dx) };
};

/**
 * Flat result objects on purpose: this project compiles with `strict: false`, where narrowing a
 * `ok: true | ok: false` union is not guaranteed. A reason is therefore optional, and every caller
 * must print one instead of assuming a silent success.
 */
export type ValidatedEvent = { ok: boolean; event?: RawInputEvent; reason?: string };

/** Normalizes and clamps: a malformed event must come back as a REASON, never as a silent no-op. */
export const validateEvent = (value: unknown): ValidatedEvent => {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'event-not-object' };
  const raw = value as Record<string, unknown>;
  const source: InputSource = isSource(raw.source) ? raw.source : 'probe';

  switch (raw.kind) {
    case 'stick': {
      const id = raw.id;
      if (!isString(id, LIMITS.stickIdMax)) return { ok: false, reason: 'stick-id-missing' };
      const x = raw.x;
      const y = raw.y;
      if (!isFiniteNumber(x)) return { ok: false, reason: 'stick-x-not-finite' };
      if (!isFiniteNumber(y)) return { ok: false, reason: 'stick-y-not-finite' };
      if (x === 0 && y === 0) return { ok: false, reason: 'stick-zero-vector (use kind:release)' };
      const magnitudeRaw = raw.magnitude;
      const magnitude = isFiniteNumber(magnitudeRaw) ? Math.max(0, Math.min(1, magnitudeRaw)) : 0;
      const claimed = raw.direction;
      const direction: DirectionName = isDirectionName(claimed) ? claimed : 'none';
      return { ok: true, event: { kind: 'stick', id, x: clampUnit(x), y: clampUnit(y), magnitude, direction, source } };
    }
    case 'release': {
      const id = raw.id;
      if (!isString(id, LIMITS.stickIdMax)) return { ok: false, reason: 'release-id-missing' };
      return { ok: true, event: { kind: 'release', id, source } };
    }
    case 'action': {
      const action = raw.action as ActionName;
      if (!ACTION_NAMES.includes(action)) return { ok: false, reason: `action-unknown (${ACTION_NAMES.join('|')})` };
      return { ok: true, event: { kind: 'action', action, source } };
    }
    case 'select': {
      const direction = raw.direction;
      if (direction !== 'next' && direction !== 'prev') return { ok: false, reason: 'select-direction-unknown' };
      return { ok: true, event: { kind: 'select', direction, source } };
    }
    case 'clear':
      return { ok: true, event: { kind: 'clear', source } };
    default:
      return { ok: false, reason: `kind-unknown (${String(raw.kind)})` };
  }
};

/** A description of something the protocol could not even type-check - a rejected event must be quotable. */
export const describeRawEvent = (value: unknown): string => {
    if (!value || typeof value !== 'object') return String(value);
    const raw = value as Record<string, unknown>;
    const parts = [`kind=${String(raw.kind)}`];
    if (raw.id !== undefined) parts.push(`id=${String(raw.id)}`);
    if (raw.action !== undefined) parts.push(`action=${String(raw.action)}`);
    if (raw.direction !== undefined) parts.push(`direction=${String(raw.direction)}`);
    if (raw.x !== undefined || raw.y !== undefined) parts.push(`x=${String(raw.x)} y=${String(raw.y)}`);
    return parts.join(' ');
};

/** One event the broker refused, with the reason and a quotation of what was sent. */
export type RejectedEvent = { reason: string; event: string };

/**
 * `ok` describes the ENVELOPE (session, seq, "events is a non-empty array"), deliberately NOT the events.
 *
 * Measured on 2026-10-11, and this is why: the controller's thumb-DOWN sample is `x=0,y=0`, the protocol
 * refuses a zero vector, and `validatePost` used to refuse the WHOLE batch for that one event. `store.ingest`
 * then returned before it created a session, the page requeued the batch, and the refused event rode inside
 * every later batch - the phone POSTed forever, `GET /input/sessions` stayed `[]`, and a tap beside the bad
 * event died with it. An envelope problem invalidates a POST; a bad event is reported per event.
 */
export type ValidatedPost = { ok: boolean; post?: InputPost; rejected?: RejectedEvent[]; reason?: string };

export const validatePost = (value: unknown): ValidatedPost => {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'body-not-object' };
  const raw = value as Record<string, unknown>;

  const session = raw.session;
  if (!isString(session, LIMITS.sessionMax)) return { ok: false, reason: `session-id-missing-or-too-long (max ${LIMITS.sessionMax})` };
  if (!SESSION_ID_PATTERN.test(session)) return { ok: false, reason: 'session-id-characters-not-allowed [A-Za-z0-9._:-]' };

  const seq = raw.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return { ok: false, reason: 'seq-must-be-integer>=1' };

  const incoming = raw.events;
  if (!Array.isArray(incoming)) return { ok: false, reason: 'events-must-be-array' };
  if (incoming.length === 0) return { ok: false, reason: 'events-empty' };
  if (incoming.length > LIMITS.eventsPerPost) return { ok: false, reason: `events>${LIMITS.eventsPerPost} per post` };

    const events: RawInputEvent[] = [];
    const rejected: RejectedEvent[] = [];
    for (const candidate of incoming) {
        const validated = validateEvent(candidate);
        if (!validated.ok) {
            rejected.push({ reason: validated.reason ?? 'invalid-event', event: describeRawEvent(candidate) });
            continue;
        }
        if (validated.event) events.push(validated.event);
    }

    const sentAtRaw = raw.sentAt;
    const agentRaw = raw.agent;
    /* A batch whose events ALL failed is still `ok` here: the envelope was fine, and `store.ingest` is the
       place that decides whether anything worth a session arrived - with this list it can say WHY. */
    return {
        ok: true,
        rejected,
        post: {
            session,
            seq,
            sentAt: isFiniteNumber(sentAtRaw) ? sentAtRaw : undefined,
            agent: isString(agentRaw, LIMITS.agentMax) ? agentRaw : undefined,
            events,
        },
    };
};

/** One line of text per event - used by logs, the Function responses and scripts/hid-selftest.cjs. */
export const describeEvent = (event: RawInputEvent): string => {
  switch (event.kind) {
    case 'stick':
      return `stick(${event.id}) x=${event.x.toFixed(2)} y=${event.y.toFixed(2)} m=${event.magnitude.toFixed(2)} dir=${event.direction}`;
    case 'release':
      return `release(${event.id})`;
    case 'action':
      return `action ${event.action}`;
    case 'select':
      return `select ${event.direction}`;
        default:
      return 'clear';
    }
};

/**
 * The description above is a log line, but it is also a stable prefix: `kind` first, then WHICH action
 * or WHICH select direction. A consumer that needs the term must take it through THIS function instead
 * of inventing its own string matching - that is the only structured part of a published edge.
 */
export const edgeTerm = (description: string): string => String(description ?? '').split(' ')[1] ?? '';
