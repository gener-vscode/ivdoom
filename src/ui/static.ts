/**
 * Static asset resolver for the controller page (`func can serve static files: fs + a body`).
 * Kept Azure-free so scripts/hid-selftest.cjs can prove the path rules without a running host.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Derived from THIS file, never from process.cwd(): in dev that is <repo>/dist/ui -> <repo>/resources/ui,
 * and `yarn copy` produces exactly the same relative layout inside the deployment zip (release/dist +
 * release/resources), so one rule covers local and deployed.
 */
export const UI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'ui');

export const MAX_ASSET_BYTES = 1_500_000;

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export type StaticAsset = { status: number; file: string; body?: string; contentType?: string; reason?: string };

export const resolveAsset = (rawPath: string, root: string = UI_ROOT): StaticAsset => {
  const cleaned = String(rawPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleaned.split('/').filter((segment) => segment.length > 0);

  for (const segment of segments) {
    // no traversal, no dotfiles: what is outside the UI root cannot be served, whatever the caller says
    if (segment === '..' || segment === '.' || segment.startsWith('.')) {
      return { status: 400, file: cleaned, reason: `path-segment-rejected (${segment})` };
    }
  }

  const relative = segments.length ? segments.join('/') : 'index.html';
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relative);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    return { status: 400, file: cleaned, reason: 'outside-ui-root' };
  }
  if (!existsSync(target)) {
    return { status: 404, file: cleaned, reason: `no-such-file (${relative}) - the page is at ui/` };
  }

  const stat = statSync(target);
  if (stat.isDirectory()) return { status: 302, file: cleaned, reason: 'append-slash' };
  if (stat.size > MAX_ASSET_BYTES) return { status: 400, file: cleaned, reason: `file-too-large (${stat.size} > ${MAX_ASSET_BYTES})` };

  const extension = path.extname(target).toLowerCase();
  const contentType = MIME_TYPES[extension];
  if (!contentType) return { status: 400, file: cleaned, reason: `type-not-served (${extension || 'no-extension'})` };

  return { status: 200, file: cleaned, body: readFileSync(target, 'utf8'), contentType };
};
