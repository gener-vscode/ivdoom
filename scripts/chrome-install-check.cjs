#!/usr/bin/env node
'use strict';
/**
 * ─── ASK CHROME WHY IT WILL OR WILL NOT INSTALL THE CONTROLLER PAGE ────────────────────────────────────
 *
 * WHY THIS EXISTS. The symptom was a phone message, not a log line: iOS "Add to Main Screen" worked,
 * Android Chrome answered 無法安裝此應用程式. Two different features share that name:
 *   • iOS Safari builds a SHORTCUT from `apple-mobile-web-app-*` meta tags. No manifest, no HTTPS needed.
 *   • Chrome installs a WEB APP: it needs a Web App Manifest on a page in a SECURE CONTEXT.
 * Rather than repeat that from memory, this asks Chrome itself, through its own DevTools protocol:
 *   • `Runtime.evaluate` → `isSecureContext` (the page's own answer),
 *   • `Page.getAppManifest` → the manifest Chrome fetched, its parse `errors`, and its
 *     `installabilityErrors` — the exact reason codes behind that message.
 * Run it against BOTH origins (http and https) and the cause stops being a hypothesis.
 *
 * WHAT IT CANNOT prove here: what a phone shows on its home screen, and the part a headless run bypasses —
 * a self-signed certificate is accepted here only because Chrome is started with
 * `--ignore-certificate-errors`. A phone has no such flag: the CA has to be installed on the phone
 * (scripts/make-dev-cert.cjs prints how), because an untrusted certificate is not a secure context either.
 *
 *   node scripts/chrome-install-check.cjs \
 *     --urls http://127.0.0.1:7071/api/pixoo/ui/,https://127.0.0.1:7443/api/pixoo/ui/
 * Needs the Function App (and for the https URL, scripts/https-proxy.cjs) already running.
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};

const urls = String(opt('urls', 'http://127.0.0.1:7071/api/pixoo/ui/'))
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
const chrome = opt('chrome', 'google-chrome');
const portBase = Number(opt('port', '9400'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => (await fetch(url)).json();

const checkOne = async (url, port) => {
  const profile = path.join(os.tmpdir(), `pixoo-install-check-${port}`);
  fs.rmSync(profile, { recursive: true, force: true });
  const chromeArgs = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // This is the headless shortcut a real phone does NOT have — a phone must trust the CA instead.
    '--ignore-certificate-errors',
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
  const browser = spawn(chrome, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', (chunk) => (stderr += String(chunk)));

  console.log(`\n=== ${url}`);
  try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250);
      try {
        const list = await getJson(`http://127.0.0.1:${port}/json/list`);
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {
        /* Chrome is still binding the debugging port. */
      }
    }
    if (!target) throw new Error(`no CDP page target on port ${port}\n${stderr.slice(0, 400)}`);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP websocket failed'));
    });
    let nextId = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (frame) => {
      const msg = JSON.parse(String(frame.data));
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) events.push(msg.method);
    };
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });

    await call('Page.enable');
    await call('Page.navigate', { url });
    for (let i = 0; i < 40 && !events.includes('Page.loadEventFired'); i++) await sleep(250);

    /* The page's OWN answer about the secure context — not my reading of a spec. */
    const evaluated = await call('Runtime.evaluate', {
      expression:
        `JSON.stringify({ isSecureContext: isSecureContext, origin: location.origin,` +
        ` manifestLink: (document.querySelector('link[rel=manifest]')||{}).href || null,` +
        ` serviceWorkerScope: ('serviceWorker' in navigator) })`,
      returnByValue: true,
    });
    const page = JSON.parse(evaluated.result.value || '{}');
    console.log(`   page.isSecureContext : ${page.isSecureContext}`);
    console.log(`   origin               : ${page.origin}`);
    console.log(`   <link rel=manifest>  : ${page.manifestLink || 'NONE — nothing to install'}`);

    const manifest = await call('Page.getAppManifest');
    const info = manifest?.manifest || manifest || {};
    const errors = [...(manifest?.errors || []), ...(info.errors || [])];
    const installability = manifest?.installabilityErrors || info.installabilityErrors || [];
    console.log(`   Chrome fetched      : ${manifest?.url || info.url || 'NO MANIFEST REACHED CHROME'}`);
    if (errors.length) {
      console.log(`   manifest parse errors (${errors.length}):`);
      for (const e of errors) console.log(`      • ${e.message}${e.line ? ` (line ${e.line})` : ''}`);
    } else console.log('   manifest parse errors: none');
    if (installability.length) {
      console.log(`   Chrome's installabilityErrors (${installability.length}) — these ARE the "無法安裝" reasons:`);
      for (const e of installability) console.log(`      • ${e.errorId}: ${e.message}`);
    } else console.log('   Chrome installabilityErrors: none reported');

    ws.close();
    return { url, secure: page.isSecureContext, manifest: Boolean(manifest?.url || info.url), blocked: installability.length };
  } catch (error) {
    console.log(`❌ ${error.message}`);
    return { url, error: String(error.message) };
  } finally {
    browser.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true });
  }
};

(async () => {
  const results = [];
  for (let i = 0; i < urls.length; i++) results.push(await checkOne(urls[i], portBase + i));
  console.log('\n──────── summary ────────');
  for (const r of results) console.log(`${r.secure ? 'secure ' : 'INSECURE'} manifest=${r.manifest ? 'yes' : 'NO '} errors=${r.blocked ?? 'n/a'}  ${r.url}`);
  console.log('Read the pair together: if the SAME manifest passes on https and reports an origin/secure-context error on');
  console.log('http, the page is fine and the missing part is TLS. What a real phone needs ON TOP of this: a CA it trusts.');
  process.exit(0);
})();
