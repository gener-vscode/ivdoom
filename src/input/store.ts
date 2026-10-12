/**
 * In-memory input broker for the Function App: the controller POSTs here, the game loop polls here.
 *
 * ⚠️ This state lives in ONE host process. Locally that is exactly one process, so a phone and a
 * game both talk to the same sessions. A serverless plan that scales past one instance would split a
 * session between instances: for that deployment put the sessions in something shared (Table Storage /
 * Redis) or turn on session affinity. Nothing here imports Azure, so this file can move with the API.
 */
import { applyRawEvent, createInputState, recordInvalidEvent } from './reducer.js';
import { ACTION_NAMES, describeEvent, validatePost } from './protocol.js';
import type { InputState, ResolvedEvent } from './reducer.js';
import type { ActionName, DirectionName, InputPost, RejectedEvent } from './protocol.js';

export type StoreConfig = { maxSessions: number; idleTtlMs: number; ringCapacity: number };
export const STORE_DEFAULTS: StoreConfig = { maxSessions: 8, idleTtlMs: 5 * 60_000, ringCapacity: 256 };
/** How many refused POSTs stay quotable. A refusal is the only record a session-less failure ever gets. */
const REFUSED_HISTORY = 8;

export type IngestResult = {
  ok: boolean;
  reason?: string;
  session?: string;
  received?: number;
  applied?: number;
  coalesced?: number;
  rejected?: { reason: string; event: string }[];
  seq?: number;
  state?: InputState;
};

/**
 * `events` are the EDGES since `since`; `state` is the LEVEL. Both, because they answer different questions.
 *
 * ⚠️ `state` is the LIVE object, deliberately: a consumer must never see an old level. It is not a
 * snapshot - a test or a log that wants to compare before/after must copy the numbers it cares about
 * first. (`stats`-style diagnostics are copied as plain numbers, so `list()` is safe to compare.)
 */
export type ReadResult = {
  ok: boolean;
  session: string;
  exists: boolean;
  seq: number;
  state?: InputState;
  events: ResolvedEvent[];
  nextCursor: number;
  droppedBeforeCursor: number;
  evictedEdges: number;
};

type SessionHandle = { state: InputState; ring: ResolvedEvent[]; oldestSeq: number; evicted: number; agent: string };

export class InputStore {
  private readonly handles = new Map<string, SessionHandle>();
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly ringCapacity: number;
    private expiredSessions = 0;
    private refusedPosts = 0;
    private refused: { at: number; session: string; reason: string }[] = [];

  constructor(config: Partial<StoreConfig> = {}) {
    this.maxSessions = Math.max(1, config.maxSessions ?? STORE_DEFAULTS.maxSessions);
    this.idleTtlMs = Math.max(1000, config.idleTtlMs ?? STORE_DEFAULTS.idleTtlMs);
    this.ringCapacity = Math.max(1, config.ringCapacity ?? STORE_DEFAULTS.ringCapacity);
  }

  get sessions(): number {
    return this.handles.size;
  }

  /** Idle sessions are dropped lazily (on any access), and the count of dropped ones is kept visible. */
  private sweep(at: number): void {
    for (const [id, handle] of [...this.handles]) {
      if (at - handle.state.lastSeenAt > this.idleTtlMs) {
        this.handles.delete(id);
        this.expiredSessions++;
      }
    }
    while (this.handles.size > this.maxSessions) {
      let oldestId: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, handle] of this.handles) {
        if (handle.state.lastSeenAt < oldest) {
          oldest = handle.state.lastSeenAt;
          oldestId = id;
        }
      }
      if (oldestId === null) break;
      this.handles.delete(oldestId);
      this.expiredSessions++;
    }
  }

  private ensure(session: string, at: number, agent: string): SessionHandle {
    const existing = this.handles.get(session);
    if (existing) {
      // A read counts as a heartbeat: a controller that is only polling is still alive.
      existing.state.lastSeenAt = at;
      if (agent) existing.agent = agent;
      return existing;
    }
    const handle: SessionHandle = { state: createInputState(session, at), ring: [], oldestSeq: 1, evicted: 0, agent };
    this.handles.set(session, handle);
    return handle;
  }

  /** A ring that overflows must tell the consumer, otherwise a slow poller silently loses presses. */
  private pushRing(handle: SessionHandle, event: ResolvedEvent): void {
    handle.ring.push(event);
    while (handle.ring.length > this.ringCapacity) {
      handle.ring.shift();
      handle.evicted++;
    }
    handle.oldestSeq = handle.ring.length ? handle.ring[0].seq : event.seq + 1;
  }

    /**
     * A POST the broker could not use creates NO session - and that is precisely the state that was
     * unanswerable on the real device on 2026-10-11: the controller POSTed (the host ran `hidInputIngest`
     * constantly) while `GET /input/sessions` stayed `[]`, and no log said why. So every refusal here is
     * counted and kept quotable, and `stats()` exposes it next to the session list.
     */
    private refuse(session: string, reason: string, rejected?: RejectedEvent[]): IngestResult {
        this.refusedPosts++;
        this.refused.push({ at: Date.now(), session, reason });
        if (this.refused.length > REFUSED_HISTORY) this.refused.shift();
        const result: IngestResult = { ok: false, reason, session };
        if (rejected && rejected.length) result.rejected = rejected;
        return result;
    }

    ingest(body: unknown, agent?: string): IngestResult {
        const at = Date.now();
        this.sweep(at);
        const validated = validatePost(body);
        if (!validated.ok || !validated.post) {
            const named = body && typeof body === 'object' ? String((body as Record<string, unknown>).session ?? '') : '';
            return this.refuse(named, validated.reason ?? 'invalid-post');
        }

        const post: InputPost = validated.post;
        /* A malformed event is a per-event rejection, never a reason to discard the valid ones travelling with
           it. Before this, one `x=0,y=0` sample refused the whole batch and the page requeued it forever. */
        const invalid: RejectedEvent[] = validated.rejected ?? [];
        if (!post.events.length) {
            return this.refuse(post.session, `no-valid-event (${invalid.map((item) => item.reason).join(' | ')})`, invalid);
        }

        const handle = this.ensure(post.session, at, post.agent ?? agent ?? '');

        if (post.seq <= handle.state.lastClientSeq) {
            return this.refuse(post.session, `stale-client-seq (last accepted ${handle.state.lastClientSeq}, got ${post.seq})`);
        }

        const rejected: RejectedEvent[] = [...invalid];
        for (const item of invalid) recordInvalidEvent(handle.state, at, item.reason, item.event);

        let applied = 0;
        let coalesced = 0;
        for (const event of post.events) {
            const outcome = applyRawEvent(handle.state, event, at, post.seq);
            if (outcome.outcome === 'applied') {
                applied++;
                this.pushRing(handle, outcome.resolved!);
                continue;
            }
            if (outcome.outcome === 'coalesced') {
                coalesced++;
                continue;
            }
            rejected.push({ reason: outcome.reason ?? 'rejected', event: describeEvent(event) });
        }

        /* `received` counts what the sender actually sent, malformed events included: the account a consumer
           self-checks (`applied + coalesced + rejected.length === received`) must balance when things break. */
        return { ok: true, session: post.session, received: post.events.length + invalid.length, applied, coalesced, rejected, seq: handle.state.seq, state: handle.state };
    }

  read(session: string, since = 0, limit = 64): ReadResult {
    const at = Date.now();
    this.sweep(at);
    const handle = this.handles.get(session);
    // A session that does not exist yet is NOT an error: the game may start before a phone connects.
    if (!handle) {
      return { ok: true, session, exists: false, seq: 0, events: [], nextCursor: since, droppedBeforeCursor: 0, evictedEdges: 0 };
    }
    const capped = Math.max(0, Math.min(64, Number.isFinite(limit) ? Math.floor(limit) : 0));
    const events = capped > 0 ? handle.ring.filter((event) => event.seq > since).slice(0, capped) : [];
    const nextCursor = events.length ? events[events.length - 1].seq : Math.max(since, handle.state.seq);
    const droppedBeforeCursor = Math.max(0, handle.oldestSeq - 1 - since);
    return { ok: true, session, exists: true, seq: handle.state.seq, state: handle.state, events, nextCursor, droppedBeforeCursor, evictedEdges: handle.evicted };
  }

  list() {
    const at = Date.now();
    this.sweep(at);
    return [...this.handles.values()].map((handle) => {
      const actions = {} as Record<ActionName, number>;
      for (const name of ACTION_NAMES) actions[name] = handle.state.actions[name].count;
      const summary = {
        session: handle.state.session,
        agent: handle.agent,
        idleMs: at - handle.state.lastSeenAt,
        seq: handle.state.seq,
        lastClientSeq: handle.state.lastClientSeq,
        stick: { active: handle.state.stick.active, direction: handle.state.stick.direction as DirectionName },
        selected: handle.state.selected,
        actions,
            counts: handle.state.counts,
            /* A session that exists but applies nothing is a different failure from no session at all, and it
               needs the same answer: WHAT was refused, and why. */
          lastRejects: handle.state.lastRejects.slice(-3),
            ringEdges: handle.ring.length,
            evictedEdges: handle.evicted,
        };
        return summary;
    });
    }

    /** Broker-level facts: what a consumer must be able to read when a session is MISSING altogether. */
    stats() {
        const at = Date.now();
        this.sweep(at);
        return {
            sessions: this.handles.size,
            expiredSessions: this.expiredSessions,
            refusedPosts: this.refusedPosts,
            lastRefused: [...this.refused],
        };
    }
}

/** The live broker (one per host process). */
export const inputStore = new InputStore();
