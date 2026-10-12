/**
 * ivdoom's OWN http(s) server - the file that makes it ONE process instead of two.
 *
 * TLS IS TERMINATED HERE, NOT BY A FORWARDER. A certificate is only useful if it is valid for the address
 * the phone types, so `scripts/make-dev-cert.cjs` builds the SAN from `os.networkInterfaces()`; serving
 * directly means the cert matches the origin actually used. The old shape (`func start` on 7071 with
 * `scripts/https-proxy.cjs` on 7443) had a failure mode this one structurally cannot have: a forwarder with
 * no upstream answers 502 while the page and the manifest are perfectly fine, and an orphaned forwarder
 * holding the port answers `EADDRINUSE` to the next run. Here there is no second process to be missing, and
 * no orphan to collide with - one PID, own port 8443, `Ctrl-C` ends it.
 *
 * Plain `node:http` when there is no dev cert, `node:https` when there is one. The routes are
 * `src/http/handlers.ts`; nothing in this file decides a contract.
 */
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* `HttpReq` is not imported: this file builds the object inline and `handleRequest` types it. Importing a
   type this file never names would only be a claim that it is used. */
import { DEFAULT_PREFIX, handleRequest, type HttpRes } from '../http/handlers.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CERT_DIR = path.join(REPO, '.gener', 'devcert');
/** A strip POST is a few hundred KB of base64 (src/hud/wire.ts caps the decoded image); 4 MB is slack. */
export const MAX_BODY_BYTES = 4_000_000;
/** 7071/7443 belong to the Azure host and its forwarder; a game server must not ask to share them. */
export const DEFAULT_TLS_PORT = 8443;
export const DEFAULT_HTTP_PORT = 8080;

export type HostOptions = { port?: number; prefix?: string; certDir?: string };

export type HostStats = {
  requests: number;
  inputPosts: number;
  hudPosts: number;
  rejected: number;
  startedAt: number;
};

export type RunningHost = {
  port: number;
  prefix: string;
  tls: boolean;
  /** e.g. https://127.0.0.1:8443/api/doom - no trailing slash */
  base: string;
  pageUrl: string;
  /** one URL per real LAN interface: the address the phone should type, same list the cert was built from */
  lanUrls: string[];
  apiUrl: (route: string) => string;
  stats: HostStats;
  close: () => Promise<void>;
};

/** IPv4, not loopback, not internal - identical rule to scripts/make-dev-cert.cjs, so the URLs printed are the ones the cert answers for. */
export const lanAddresses = (): string[] => {
  const interfaces = os.networkInterfaces();
  const found: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const entry of interfaces[name] ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
};

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      /* An oversized request is a mistake to name, not a stream to absorb: a browser posting a whole session
         history of strips would otherwise grow this process without anyone being told. */
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body over the ${MAX_BODY_BYTES} byte limit`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const send = (out: http.ServerResponse, method: string, res: HttpRes): void => {
  const headers: Record<string, string> = { ...(res.headers ?? {}) };
  let payload: Buffer | string = '';
  if (res.json !== undefined) {
    if (!headers['content-type']) headers['content-type'] = 'application/json; charset=utf-8';
    payload = JSON.stringify(res.json);
  } else if (res.body !== undefined) {
    payload = res.body;
  }
  if (typeof payload === 'string') headers['content-length'] = String(Buffer.byteLength(payload));
  else if (Buffer.isBuffer(payload)) headers['content-length'] = String(payload.length);
  out.writeHead(res.status || 200, headers);
  // HEAD answers the headers of the GET it was asked about, with no body.
  out.end(method === 'HEAD' ? undefined : payload);
};

export const certificateAvailable = (certDir: string = CERT_DIR): boolean =>
  existsSync(path.join(certDir, 'dev.crt')) && existsSync(path.join(certDir, 'dev.key'));

export const startHost = async (options: HostOptions = {}): Promise<RunningHost> => {
  const prefix = String(options.prefix ?? DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '');
  const certDir = options.certDir ?? CERT_DIR;
  const tls = certificateAvailable(certDir);
  const port = Number(options.port ?? (tls ? DEFAULT_TLS_PORT : DEFAULT_HTTP_PORT));

  const server = tls
    ? https.createServer(
        {
          cert: readFileSync(path.join(certDir, 'dev.crt')),
          key: readFileSync(path.join(certDir, 'dev.key')),
        },
        () => {},
      )
    : http.createServer();

  const stats: HostStats = { requests: 0, inputPosts: 0, hudPosts: 0, rejected: 0, startedAt: Date.now() };

  server.on('request', async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const target = String(req.url ?? '/');
    const method = String(req.method ?? 'GET').toUpperCase();
    const [pathPart] = target.split('?');
    const search = new URLSearchParams(target.slice(pathPart.length));

    /* One prefix rule, applied by string compare: everything below is relative to it, which is what lets
       resources/ui/app.js derive the API root from its own URL instead of being told a second host. */
    const underPrefix = pathPart === `/${prefix}` || pathPart.startsWith(`/${prefix}/`);
    if (!underPrefix) {
      stats.requests++;
      stats.rejected++;
      send(res, method, {
        status: 404,
        json: { ok: false, reason: `not under /${prefix}`, page: `/${prefix}/ui/`, asked: pathPart },
      });
      return;
    }
    const route = pathPart.slice(prefix.length + 1).replace(/^\/+/, '');

    let handled: HttpRes;
    try {
      const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      handled = handleRequest({
        method,
        route,
        url: target,
        body,
        query: (name: string) => search.get(name) ?? undefined,
        header: (name: string) => String(req.headers[name.toLowerCase()] ?? ''),
      });
    } catch (error) {
      // A 500 here is a bug in this process, so it says so - it must never look like a device failure.
      const message = (error as Error)?.message ?? String(error);
      console.log(`[host] handler threw: ${message} (${method} ${pathPart})`);
      handled = { status: 500, json: { ok: false, reason: `host-handler-error (${message})` } };
    }

    stats.requests++;
    if (route === 'input' && method === 'POST') stats.inputPosts++;
    if (route === 'hud' && method === 'POST') stats.hudPosts++;
    if (handled.status >= 400) stats.rejected++;
    send(res, method, handled);
  });

  await new Promise<void>((resolve, reject) => {
    /* The one error a host can have on start, said plainly: a previous run is still holding the port. */
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`port ${port} is busy - another ivdoom host is still running (yarn kill, then start once)`)
          : error,
      ),
    );
    server.listen(port, '0.0.0.0', () => resolve());
  });

  const scheme = tls ? 'https' : 'http';
  const base = `${scheme}://127.0.0.1:${port}/${prefix}`;
  const lan = lanAddresses().map((address) => `${scheme}://${address}:${port}/${prefix}`);
  return {
    port,
    prefix,
    tls,
    base,
    pageUrl: `${base}/ui/`,
    lanUrls: lan.map((url) => `${url}/ui/`),
    apiUrl: (route: string) => `${base}/${String(route).replace(/^\/+/, '')}`,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        const done = () => resolve();
        server.close(done);
        // Node keeps keep-alive sockets open otherwise, and a Ctrl-C would look like it did nothing.
        const closeAll = (server as https.Server).closeAllConnections;
        if (typeof closeAll === 'function') closeAll.call(server);
        setTimeout(done, 1000).unref();
      }),
  };
};
