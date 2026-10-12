/**
 * Input state machine - pure, no I/O. Runs inside the Function host AND inside scripts/hid-selftest.cjs,
 * so the semantics below are tested without a browser or a device.
 *
 * LEVEL vs EDGE is the whole file:
 *   a `stick` value always lands in `state.stick`, but only an ACT of that level (press, new
 *   direction, release) is published to the ring - a consumer re-reads the level every frame anyway.
 *   an `action` / `select` / `clear` is an edge and is always published, so it cannot be missed.
 */
import { ACTION_NAMES, PROTOCOL_VERSION, describeEvent, directionForVector, LIMITS } from './protocol.js';
import type { ActionName, DirectionName, InputSource, RawInputEvent } from './protocol.js';

export type StickView = {
  active: boolean;
  id: string | null;
  x: number;
  y: number;
  magnitude: number;
  /** derived by the server from x/y - the authoritative one */
  direction: DirectionName;
  /** what the controller claimed, kept so a disagreement is measurable instead of silent */
  claimedDirection: DirectionName;
  source: InputSource | null;
  updatedAt: number;
};

export type ActionCounter = { count: number; lastAt: number };

export type InputState = {
  session: string;
  protocol: number;
  createdAt: number;
  lastSeenAt: number;
  lastEventAt: number;
  /** server sequence: every published event gets one, and consumers poll with it */
  seq: number;
  /** last sender sequence accepted; a post at or below it is stale */
  lastClientSeq: number;
  stick: StickView;
  actions: Record<ActionName, ActionCounter>;
  selected: number;
  counts: { received: number; applied: number; coalesced: number; rejected: number; geometryMismatch: number };
  lastRejects: { at: number; reason: string; event: string }[];
};

export type ResolvedEvent = { seq: number; at: number; kind: RawInputEvent['kind']; description: string };

export type ApplyOutcome = { outcome: 'applied'; resolved: ResolvedEvent } | { outcome: 'coalesced' } | { outcome: 'rejected'; reason: string };

/** The same press twice faster than this is auto-repeat or a stuck key, not two presses. */
export const ACTION_MIN_GAP_MS = 25;
const REJECT_HISTORY = 8;

export const createInputState = (session: string, at: number): InputState => {
  const actions = {} as Record<ActionName, ActionCounter>;
  for (const name of ACTION_NAMES) actions[name] = { count: 0, lastAt: 0 };
  return {
    session,
    protocol: PROTOCOL_VERSION,
    createdAt: at,
    lastSeenAt: at,
    lastEventAt: 0,
    seq: 0,
    lastClientSeq: 0,
    stick: { active: false, id: null, x: 0, y: 0, magnitude: 0, direction: 'none', claimedDirection: 'none', source: null, updatedAt: 0 },
    actions,
    selected: 0,
    counts: { received: 0, applied: 0, coalesced: 0, rejected: 0, geometryMismatch: 0 },
    lastRejects: [],
  };
};

const recordReject = (state: InputState, event: RawInputEvent, at: number, reason: string): void => {
    state.counts.rejected++;
    state.lastRejects.push({ at, reason, event: describeEvent(event) });
    if (state.lastRejects.length > REJECT_HISTORY) state.lastRejects.shift();
};

/**
 * An event the PROTOCOL refused (not a policy refusal) never reaches `applyRawEvent`, so it must be booked
 * here instead: `received` has to stay equal to `applied + coalesced + rejected`, or the account every
 * consumer self-checks becomes a lie exactly when something goes wrong - which is when it is needed.
 */
export const recordInvalidEvent = (state: InputState, at: number, reason: string, description: string): void => {
    state.counts.received++;
    state.counts.rejected++;
    state.lastEventAt = at;
    state.lastRejects.push({ at, reason, event: description });
    if (state.lastRejects.length > REJECT_HISTORY) state.lastRejects.shift();
};

const emptyStick = (source: InputSource | null, at: number): StickView => ({
  active: false,
  id: null,
  x: 0,
  y: 0,
  magnitude: 0,
  direction: 'none',
  claimedDirection: 'none',
  source,
  updatedAt: at,
});

export const applyRawEvent = (state: InputState, event: RawInputEvent, at: number, clientSeq: number): ApplyOutcome => {
  state.counts.received++;
  state.lastEventAt = at;
  if (clientSeq > state.lastClientSeq) state.lastClientSeq = clientSeq;

  const publish = (kind: RawInputEvent['kind'], description: string): ResolvedEvent => {
    state.seq += 1;
    state.counts.applied++;
    return { seq: state.seq, at, kind, description };
  };

  if (event.kind === 'stick') {
    const direction = directionForVector(event.x, event.y);
    if (direction !== event.direction) state.counts.geometryMismatch++;
    const wasActive = state.stick.active;
    const sameDirection = state.stick.direction === direction;
    state.stick = {
      active: true,
      id: event.id,
      x: event.x,
      y: event.y,
      magnitude: event.magnitude,
      direction,
      claimedDirection: event.direction,
      source: event.source,
      updatedAt: at,
    };
    if (wasActive && sameDirection) {
      state.counts.coalesced++;
      return { outcome: 'coalesced' };
    }
    return { outcome: 'applied', resolved: publish('stick', `${describeEvent(event)} serverDir=${direction}`) };
  }

  if (event.kind === 'release') {
    if (!state.stick.active) {
      state.counts.coalesced++;
      return { outcome: 'coalesced' };
    }
    state.stick = emptyStick(event.source, at);
    return { outcome: 'applied', resolved: publish('release', describeEvent(event)) };
  }

  if (event.kind === 'action') {
    const counter = state.actions[event.action];
    if (counter.lastAt && at - counter.lastAt < ACTION_MIN_GAP_MS) {
      recordReject(state, event, at, `action-repeat-burst (<${ACTION_MIN_GAP_MS}ms)`);
      return { outcome: 'rejected', reason: 'action-repeat-burst' };
    }
    counter.count++;
    counter.lastAt = at;
    return { outcome: 'applied', resolved: publish('action', `${describeEvent(event)} total=${counter.count}`) };
  }

  if (event.kind === 'select') {
    const next = state.selected + (event.direction === 'next' ? 1 : -1);
    state.selected = Math.max(-LIMITS.selectedClamp, Math.min(LIMITS.selectedClamp, next));
    return { outcome: 'applied', resolved: publish('select', `select ${event.direction} -> selected=${state.selected}`) };
  }

  // `clear`: drop the live input, KEEP the identity and the sequence, or every consumer's cursor
  // would restart and replay a whole session.
  const resolved = publish('clear', 'clear -> fresh input state');
  const fresh = createInputState(state.session, at);
  fresh.createdAt = state.createdAt;
  fresh.seq = state.seq;
  fresh.lastClientSeq = state.lastClientSeq;
  fresh.counts.received = state.counts.received;
  fresh.counts.applied = state.counts.applied;
  fresh.counts.rejected = state.counts.rejected;
  fresh.counts.geometryMismatch = state.counts.geometryMismatch;
  fresh.lastRejects = state.lastRejects;
  Object.assign(state, fresh);
  return { outcome: 'applied', resolved };
};

/** A stick older than this belongs to a controller that vanished mid-press: it must not keep driving a paddle. */
export const isInputStale = (state: InputState, now: number, ttlMs: number): boolean =>
  !state.stick.active || now - state.stick.updatedAt > ttlMs;
