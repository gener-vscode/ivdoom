/**
 * Every route ivdoom answers, written against THIS file's own request shape - no `@azure/functions`.
 *
 * WHY THIS FILE EXISTS. The phone page and the game must talk to ONE process. Until 2026-10-12 the routes
 * lived in `src/functions/*` on the Azure Functions host, so a playable run meant a second process:
 * `func start` (whose worker recreates `dist/` - the measured 404 trap of 12:06) behind
 * `scripts/https-proxy.cjs` (whose 502 body was read as "the page is broken" while the page was fine).
 * What is removed here is only the `app.http()` wrapper. The bodies - status codes, JSON shapes, and the
 * rule that a REFUSED post prints - are copied from the versions the page and the game already speak, so a
 * controller written for one speaks to the other.
 *
 * THE SAME-ORIGIN RULE IS WHY THIS IS NOT A SEPARATE SERVICE. `resources/ui/app.js` derives its API root
 * from the URL it was served from (`…/api/doom/ui/` → `…/api/doom/`), so whoever serves the page must own
 * `/input` and `/hud` too. One origin: no CORS, no second port, and the phone and the player share one
 * broker and one hud id.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_VERSION } from '../input/protocol.js';
import { inputStore } from '../input/store.js';
import { hudCache } from '../hud/cache.js';
import { DEFAULT_ID } from '../hud/wire.js';
import { UI_ROOT, resolveAsset } from '../ui/static.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_BIN = path.join(REPO, '.gener', 'build', 'doom', 'doom-headless');

/**
 * Everything hangs under this path, and it is ONE definition on purpose: `resources/ui/app.js` cuts its API
 * root at `/ui`, so `GET /api/doom/ui/` is all a phone has to open. `api/doom` rather than the old
 * `api/pixoo` so a request log says which program answered it.
 */
export const DEFAULT_PREFIX = 'api/doom';

/** Read by the server only: the body is already in memory, so every handler below is synchronous. */
export type HttpReq = {
  method: string;
  /** path AFTER the prefix, query string removed; '' means the prefix itself */
  route: string;
  /** the raw request target including the prefix - a directory redirect has to echo it back untouched */
  url: string;
  query: (name: string) => string | undefined;
  header: (name: string) => string | undefined;
  body: Buffer;
};

export type HttpRes = { status: number; headers?: Record<string, string>; body?: string | Buffer; json?: unknown };

const asJson = (status: number, value: unknown): HttpRes => ({ status, json: value });
const badRequest = (reason: string): HttpRes => asJson(400, { ok: false, reason });

/** `parseJson` never throws: an unreadable body is a client bug to NAME (400), never a 500 and never a 200. */
const parseJson = (req: HttpReq): { ok: boolean; value?: unknown } => {
  try {
    return { ok: true, value: JSON.parse(req.body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
};

/* ─── /version: the readiness gate, and the answer to "did I forget `make`?" ─────────────────────── */
let versionBody: Record<string, unknown> | undefined;
export const versionInfo = (): HttpRes => {
  if (!versionBody) {
    let app = 'ivdoom';
    let version = 'unknown';
    try {
      const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
      version = String(pkg.version ?? 'unknown');
    } catch {
      /* a version we cannot read is reported as unknown, never as 0.0.0 - a fake number invites trust */
    }
    /* `engineBuilt` belongs in the body because a missing engine is the FIRST cause of "nothing happens",
       and it is cheaper to read it from one request than to guess it from a black panel. */
    versionBody = {
      ok: true,
      app,
      version,
      pid: process.pid,
      node: process.version,
      startedAt: new Date(STARTED_AT).toISOString(),
      engineBuilt: existsSync(ENGINE_BIN),
      enginePath: ENGINE_BIN,
      uiRoot: UI_ROOT,
      protocol: { input: PROTOCOL_VERSION },
      routes: ['version', 'input', 'input/state', 'input/sessions', 'hud', 'hud/state', 'hud/image', 'ui/'],
    };
  }
  return asJson(200, versionBody);
};
export const STARTED_AT = Date.now();

/* ─── /input: the phone writes, the player reads. Contract = src/input/protocol.ts ───────────────── */
export const inputIngest = (req: HttpReq): HttpRes => {
  const parsed = parseJson(req);
  if (!parsed.ok) return badRequest('body-not-json');
  const result = inputStore.ingest(parsed.value, String(req.header('user-agent') ?? ''));
  /* A refusal used to be invisible because the host logged the invocation as "Succeeded" whatever the
     status was; that is how the phone posted for 14 minutes against a broker that answered `noSession`. */
  if (!result.ok) console.log(`[input] REFUSED a POST: ${result.reason || 'unknown reason'}${result.session ? ` (session ${result.session})` : ''}`);
  return asJson(result.ok ? 200 : 400, result);
};

export const inputRead = (req: HttpReq): HttpRes => {
  const session = String(req.query('session') ?? '');
  if (!session) return badRequest('session-required');
  const rawSince = Number(req.query('since') ?? '0');
  const rawLimit = Number(req.query('limit') ?? '64');
  const since = Number.isFinite(rawSince) ? Math.max(0, Math.floor(rawSince)) : 0;
  // `limit=0` is a legitimate read: a controller polling the LEVEL does not want the history.
  const limit = Number.isFinite(rawLimit) ? rawLimit : 0;
  return asJson(200, inputStore.read(session, since, limit));
};

/* `sessions: []` alone cannot tell "nobody posted" from "every post was refused"; `broker` can. */
export const inputSessions = (): HttpRes =>
  asJson(200, { protocol: PROTOCOL_VERSION, sessions: inputStore.list(), broker: inputStore.stats() });

/* ─── /hud: what the player has to read (score/keys/hp) - the bar does not fit the panel ─────────── */
/** `?session=` is accepted as an alias so `--input-session foo` + `?session=foo` match, as documented in wire.ts. */
const readId = (req: HttpReq): string => String(req.query('id') ?? req.query('session') ?? DEFAULT_ID);

export const hudIngest = (req: HttpReq): HttpRes => {
  const parsed = parseJson(req);
  if (!parsed.ok) {
    console.log('[hud] REFUSED a POST: body-not-json');
    return badRequest('body-not-json');
  }
  const result = hudCache.put(parsed.value);
  if (!result.ok) {
    console.log(`[hud] REFUSED a POST: ${result.reason}`);
    return asJson(400, result);
  }
  if (result.ignored?.length) console.log(`[hud] meta keys ignored: ${result.ignored.join(', ')}`);
  // `sequence` is echoed so the producer can prove the frame it sent is the frame held.
  return asJson(201, { ...result, endpoints: { image: `hud/image?id=${result.id}`, state: `hud/state?id=${result.id}` } });
};

export const hudState = (req: HttpReq): HttpRes => {
  const id = readId(req);
  return {
    status: 200,
    headers: { 'cache-control': 'no-store' },
    json: { ...hudCache.state(id), endpoints: { image: `hud/image?id=${id}` }, broker: hudCache.stats() },
  };
};

export const hudImage = (req: HttpReq): HttpRes => {
  const id = readId(req);
  const found = hudCache.get(id);
  if (!found.exists || !found.png) {
    return { status: 404, headers: { 'cache-control': 'no-store' }, json: { ok: true, exists: false, id, reason: found.reason } };
  }
  const held = hudCache.state(id);
  return {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'cache-control': 'no-store', // a cached strip would show a score that no longer exists
      'x-hud-id': id,
      'x-hud-sequence': String(held.sequence ?? 0),
      'x-hud-age-ms': String(held.ageMs ?? 0),
      'x-hud-rows': String(held.rows ?? 0),
    },
    body: found.png,
  };
};

/* ─── /ui: the controller page, resolved by src/ui/static.ts (path rules tested without a host) ──── */
const redirectToDirectory = (url: string, extra = ''): HttpRes => ({
  status: 302,
  headers: { location: `${url.replace(/[?#].*$/, '')}${extra}/` },
  body: 'redirecting to the directory form',
});

export const pageAsset = (req: HttpReq): HttpRes => {
  const rest = req.route.replace(/^ui\/?/, '');
  // `/ui` without the slash would make the page resolve ./app.js one level too high - so redirect first.
  if (!rest && !req.url.replace(/[?#].*$/, '').endsWith('/')) return redirectToDirectory(req.url);
  const asset = resolveAsset(rest);
  if (asset.status === 302) return redirectToDirectory(req.url, `/${rest}`);
  if (asset.status !== 200) {
    // The reason and the UI root belong in the body: a phone showing a bare 404 tells you nothing.
    return {
      status: asset.status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      body: `${asset.status} ${asset.reason ?? ''}\nuiRoot=${UI_ROOT}\n`,
    };
  }
  return {
    status: 200,
    headers: {
      'content-type': asset.contentType ?? 'application/octet-stream',
      // no-store: a stale controller on a phone home screen is worse than one extra 4 KB GET.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body: asset.body ?? '',
  };
};

/* ─── the router: one place, plain compares, and a 404 that says what IS here ────────────────────── */
export const handleRequest = (req: HttpReq): HttpRes => {
  const route = req.route;
  const post = req.method === 'POST';
  const readable = req.method === 'GET' || req.method === 'HEAD';

  if (route === '' || route === 'version') return versionInfo();
  if (route === 'input') return post ? inputIngest(req) : badRequest(`POST /input is the only method here (got ${req.method})`);
  if (route === 'input/state') return readable ? inputRead(req) : badRequest(`GET /input/state is the only method here (got ${req.method})`);
  if (route === 'input/sessions') return readable ? inputSessions() : badRequest(`GET /input/sessions is the only method here (got ${req.method})`);
  if (route === 'hud') return post ? hudIngest(req) : badRequest(`POST /hud is the only method here (got ${req.method})`);
  if (route === 'hud/state') return readable ? hudState(req) : badRequest(`GET /hud/state is the only method here (got ${req.method})`);
  if (route === 'hud/image') return readable ? hudImage(req) : badRequest(`GET /hud/image is the only method here (got ${req.method})`);
  if (route === 'ui' || route.startsWith('ui/')) return readable ? pageAsset(req) : badRequest(`GET /ui/ is the only method here (got ${req.method})`);

  return asJson(404, { ok: false, reason: `no such route (${route})`, page: `/${DEFAULT_PREFIX}/ui/`, routes: ['version', 'input', 'input/state', 'input/sessions', 'hud', 'hud/state', 'hud/image', 'ui/'] });
};
