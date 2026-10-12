# ivdoom — DOOM run in Node.js here, shown on a Pixoo 64 panel, controlled from a phone PWA

**One Node process.** The controller page, the input broker, the status-strip cache, the panel supply loop
and the headless engine all live in the same PID. There is no Azure Functions host here and no TLS forwarder:
`src/host/server.ts` serves `/api/doom/ui/`, `/api/doom/input` and `/api/doom/hud` itself and terminates TLS
itself. A C subprocess is unavoidable — it is the game: [ozkl/doomgeneric](https://github.com/ozkl/doomgeneric)
cloned to `.gener/vendor/doomgeneric`, compiled by `scripts/doom/Makefile` with `scripts/doom/dg_stdio.c` into
`.gener/build/doom/doom-headless`, spawned with `cwd: .gener/wad` and `-file freedoom1.wad` (28 795 076 B) —
but nothing else here.

Split out of `../pixoo` on 2026-10-12 at the user's instruction: *"no shared layer, just move and clone."*
So this repo **never imports from, reads from, or depends on** the other repo. The shared layers
(`src/input`, `src/pixoo`, `src/hud/{bar,wire,cache,upload}`, `src/ui/static`, `resources/ui`) are **copies**,
and copies drift. That trade-off was chosen deliberately: no `file:../pixoo`, no third package, no build coupling.
`src/pixoo/pacing.ts` still owns the panel's millisecond numbers; if you change them here, change no other file.

## Run it

```bash
yarn engine          # clone doomgeneric + make → .gener/build/doom/doom-headless (needs gcc)
yarn cert            # .gener/devcert/dev.crt + dev.key, SAN from os.networkInterfaces()
yarn play            # host + playable DOOM, one command; its --warp/--push are in package.json — read them there
yarn play:32         # the width actually measured playable (see «Measured»)
yarn play:demo       # no phone: -playdemo DEMO1, the path every pixoo frame note was measured through
yarn serve           # the page + broker + hud cache only: no engine, no panel
yarn host:check      # prove one process serves every route (no panel, no engine)
yarn canary          # Channel/GetIndex liveness before/after a device run
yarn ui:install-check -- --urls https://<this-box>:8043/api/doom/ui/   # 8043 = DEFAULT_TLS_PORT
yarn kill            # free 8043 (TLS) and 8000 (plain) — the two DEFAULT_*_PORT values
```
`.gener/` is gitignored: vendor (8 MB), `freedoom1.wad` (28 MB of 51 MB of downloads), the build and the dev
cert are all reproducible with the two commands above. `local.settings.json` holds `PIXOO_ORIGIN` (the panel's
LAN address) and nothing else.

`yarn play`'s stage and width are edited **in `package.json` and only there** — the user changes them while
testing, so this file deliberately does not copy them (a second copy of a value is the thing that goes stale).
Every option here is read with `indexOf()`: **the FIRST match wins**, which is why a `--` suffix in a yarn
script does not override an earlier one.

## Shape of it

| file | role |
|---|---|
| `scripts/doom-device.cjs` | the entry: read args → start the host → build the engine argv → spawn → pull frames from fd 3 → scale → push → `Ctrl-C` releases keys, closes engine **then** host |
| `src/host/server.ts` | `node:https` when `.gener/devcert` exists, else `node:http`. Own port (`DEFAULT_TLS_PORT` 8043 / `DEFAULT_HTTP_PORT` 8000 — not 8443/8080, see «Measured»), 4 MB body cap, `EADDRINUSE` answered with BOTH possible causes named (our previous run, or a foreign program ⇒ `--port <n>`), `close()` also closes keep-alive sockets |
| `src/http/handlers.ts` | every route, no `@azure/functions`. Bodies copied from the versions the page and the game already speak: status codes, JSON shapes, and a REFUSED POST always printing |
| `src/input/{protocol,reducer,store}.ts` | LEVEL-vs-EDGE input broker. `stick` is a level (held → held until released); presses are edges carried to a cursor |
| `src/game/{doom-keys,remote-control,render,scale}.ts` | phone frame → engine key lines on the engine's stdin; frames out of fd 3 |
| `src/hud/{wire,bar,cache,upload}.ts` | the status strip: producer keeps `latest` in memory, host holds what a browser may GET, `anchor: 'bottom'` is the DOOM shape |
| `src/pixoo/{api,color,fonts,pacing}.ts` | the panel client + the only authority on PicSpeed/post pacing numbers |
| `scripts/doom/{Makefile,dg_stdio.c}` | the engine build: fd 0 stdin in, fd 3 `DG_FRAME`/`DG_EVENT`(DG_STATE) out |

Why not `func start` + a proxy (the old shape), in one line each:
* a forwarder with no upstream answers **502** while the page and manifest are perfectly fine — that exact
  misreading happened at 17:03/17:11 on 2026-10-12;
* a forwarder left in the background by `( … &)` holds 7443 and the next run gets **EADDRINUSE**;
* `func` recreates its worker on `tsc`, and a `dist/` caught mid-rebuild 404s `/ui/` and `/input/*`;
* a certificate is only useful if it matches the address the phone types, which is why TLS is terminated here
  with the SAN list generated from the interfaces, not forwarded from a plain-HTTP upstream.

Both sides default to session **`main`** (`resources/ui/app.js` opens `?session=main`, the runner defaults to
`main`); two different default words is the `noSession` class of bug, in which a phone posts for minutes and
the player sees nothing.

## Measured in this repo (output, not claims)

`yarn host:check` (2026-10-12 18:0x, TLS on 8455):
```
✅ /version … pid(host)=232055 pid(this)=232055 engineBuilt=true      ← the one-process proof, by pid
✅ GET /ui/ 200 · /ui → 302 /api/doom/ui/ · app.js 200 · HEAD 200 len=5557
✅ manifest.webmanifest · application/manifest+json · start_url=./?source=pwa · scope=./ · icons=./icon.svg:any
✅ icon.svg 200 image/svg+xml 1063 B
✅ 404 names the reason + uiRoot=…/resources/ui ; a wrong prefix → 404 "not under /api/doom"
✅ unparseable /input POST → 400 body-not-json
✅ a stick LEVEL posted over HTTP is held as a LEVEL; a release makes state.stick.active=false
✅ GET /input/sessions lists `main`; an unknown session is an EMPTY read, not an error
✅ the production producer (src/hud/upload.ts) → 1 upload, seq=1, 136 B, rtt=2 ms
✅ GET /hud/state + /hud/image → same sequence, byte-identical PNG, meta intact
✅ a bad strip → 400 png-signature-missing     ✅ close() really stops listening
host handled 20 requests: 3 /input POST, 2 /hud POST, 4 refused
```
`yarn doom:warp-check`: 12 cases pass (`--warp` as a LIST, quoted and unquoted, `-warp 2` verbatim, list
boundary at `--seconds`/`--push`, default `-warp 1`, first-match wins, DEMO path unchanged, `--print-argv`
binds no port, `--no-host` without `--api` fails naming *nothing owns /input*); the launcher half prints
SKIPPED because there is no launcher here. `yarn doom:keys-check` 13/13.

`yarn demo:gif` (the README's clip) — and the bug it found in this repo's own generator:
```
engine: DG_HEADLESS done frames=1545 wall_ms=44151 fps=34.99     ← 1545 consecutive DEMO1 frames, real time
first run  → the script printed "avg=41.67ms nominal_fps=24.00"
the file   → PIL read back 1433 frames, delays {40,80,120}, sum 57 600 ms = 24.88 fps   ❌ 2.4 s short
fixed      → delays built in 10 ms GIF units: 1200×40 ms + 240×50 ms = 60 000 ms exactly
the file   → PIL read back sum 60 000 ms = 60.00 s, 64×64, loop=infinite, 5 308 239 B          ✅
```
A GIF stores a delay in hundredths of a second, so 41.67 ms was silently written as 40 ms. The arithmetic was
correct and the output was wrong — the generator never read its own file. `exactDelays` now quantises to 10 ms
steps and prints a warning when a requested length is not representable at all; `250 ms / 6 frames` still
produces the recorded `[40,40,40,40,40,50]`, which is why the old code passed its own test for two days.
Note the honest limit, printed in the README too: 1440 consecutive frames are 41.1 s of demo time at DOOM's
35 tics/s shown over 60.00 s = **0.69× game speed**; real-time 24 fps would mean dropping engine frames.

Which image-sizing markup survives GitHub's README renderer — measured by asking GitHub for its own output
(`Accept: application/vnd.github.html` → `GET /repos/gener-vscode/ivdoom/readme`). The candidates were put on
a throwaway branch (`git commit-tree` on top of `f773c3c` = `dc273483`, pushed as `probe/readme-me`, read back
with `?ref=`, then deleted — `git ls-remote --heads origin` now lists only `main`):
```
style="image-rendering: pixelated; zoom: 16"     STRIPPED  ← GitHub replaces style with max-width:100%
style="image-rendering: pixelated; transform:2x" STRIPPED
class="pixelated"                                STRIPPED
srcset="… 2x"                                    STRIPPED
width="256" height="256"                         KEPT, GitHub adds max-width:100%; height:auto; max-height:256px
width="256"  (no height)                         KEPT, aspect preserved, max-width:100%
align="left"                                     KEPT
<details><summary>…</summary><img …></details>   KEPT (image inside renders too)
![alt](file.gif "title")                         title KEPT; GitHub injects data-animated-image="" + max-width
```
So on GitHub **only attributes survive**; every CSS route (style, class, srcset) is gone before anything paints.
A `style=` in the README is a local-preview-only trick — which is exactly why `zoom:16` looked perfect on this
machine and cannot be expected on github.com. Note also that `max-width:100%` is GitHub's own injection, not
author-authored CSS surviving: it is a ceiling, never a scale-up.

Nearest-neighbour upscale of the shipped GIF (PIL `Image.NEAREST` on `assets/doom-demo-60s-24fps-1.gif`, the
per-frame durations copied as-is, then read back: every file is still 1433 frames / 60 000 ms — the frames
themselves, source included, were read back from the file, not inferred):
```
128×128  11 117 631 B (2.09×)   192×192  18 001 122 B (3.39×)   256×256  25 329 881 B (4.77×)
384×384  40 947 161 B (7.71×)   512×512  57 478 525 B (10.83×)  ← source 64×64 = 5 308 239 B
```
"Bake the pixels bigger" is therefore not free: crisp-by-construction at 8× costs 10.8× the file. A palette
GIF compresses repeated blocks well, but 48× the pixel count dominates the ledger. Probe files are under
`.gener/probe/` + `.gener/probe-up/` (gitignored), so measuring this changed nothing tracked.

`assets/ui-controller-2x.png` (the controller picture in the README) — and the two ways it does **not** work:
```
yarn serve                     → port 8080 busy: a Strata python server holds it here (ps -p 1690)
--host-only --port 8091        → GET /api/doom/ui/ 200 text/html 5557 B; /version 200                    ✅
Emulation.setDeviceMetricsOverride deviceScaleFactor=2 → ignored by page.screenshot: still 960×440          ❌
page.addStyleTag('html{zoom:2}') at viewport 1920×880 → CLIPPED: this page lays out in `vh`, so zoom makes
                                              it 2× taller than the viewport and half of it was cut        ❌
browser.newContext({viewport 960×440, deviceScaleFactor: 2}) + screenshot scale:'device'
                             → 1920×880 PNG, page reported dpr=2 innerWidth=960, nothing cut               ✅
```
So a crisp UI capture comes from a 2× **device** scale, not from CSS zoom on a `vh`-sized layout — the same
lesson as the GIF: bake it, don't ask the viewer to scale it. The README shows that file at `width="960"`,
i.e. the CSS size it was laid out at, which makes the browser *downscale* 2:1 (the direction that stays sharp
when no `image-rendering` survives). `--port` is real because `scripts/doom-device.cjs:271` reads
`argValue(argv,'port')`; the 8080 default is gone because that collision happened twice on this machine (the
Strata python runtime holds 8080 — `ss -ltnp` shows `python pid=1690`), which is why `DEFAULT_HTTP_PORT` is
8000 and `DEFAULT_TLS_PORT` is 8043 now. Verified after the change, `node scripts/doom-device.cjs --host-only`
with no `--port`:

```
[host] node:http  0.0.0.0:8000      ← no devcert, so plain; DEFAULT_HTTP_PORT
GET /api/doom/version → 200 {"repo":"ivdoom", ... "pid":<the same pid as the caller>}
lsof -ti:8043 -ti:8000 | xargs -r kill -9   (yarn kill) → 8000 released, nothing left listening
```

And the device side of the same run (`yarn play` before the port change, 20:2x) — the FIRST panel contact in
this repo's own history, and the panel was healthy:

```
canary before: ✅ device answering | answered 3/3  median 41ms  slowest 67ms
               ✅ clean: median is in the 30-70ms band measured for an idle device.
port 8080 is busy …  ❌ the runner stopped before any game frame; the panel kept the LAST frame it was given
```

That is the signature this repo documents: a green canary + a panel holding an old frame = the failure is on
this side of the wire, not the panel's.

Firewall: `grep ENABLE /etc/ufw/ufw.conf` → **`ENABLED=yes`**, so incoming is denied by default and 8000/8043
must be allowed or a phone gets nothing while this box answers *itself* perfectly:

```
sudo ufw allow from 192.168.0.0/16 to any port 8000 proto tcp comment 'ivdoom page http  -> LAN devices'
sudo ufw allow from 192.168.0.0/16 to any port 8043 proto tcp comment 'ivdoom page https -> LAN devices'
sudo ufw status numbered     # the only way to see them; both /etc/ufw/user.rules and nft need root
```

Two things this repo will not paper over:

1. **Editing `/etc/ufw/user.rules` in an editor does nothing by itself** — ufw reads that file when it is
   (re)loaded, so `sudo ufw reload` is required after a hand edit (done 2026-10-12 20:4x). Prefer `ufw allow`
   so the file is written in the syntax ufw itself expects.
2. **The 20:51 "reloaded, still unreachable" was measured to be a missing server, not a missing rule.** `ss`
   shows nothing listening on 8000 between 20:39 (a 14 s test host) and **20:52:51**, when the user's own
   `yarn play` (`pid 286280`) bound `0.0.0.0:8000`:
   ```
   ss -ltnp → LISTEN 0.0.0.0:8000 users:(("MainThread",pid=286280))
   ps -p 286280 → node scripts/doom-device.cjs --input remote --warm --hold …   (stage/width not quoted: see
                    «Run it» — they live in package.json and the user edits them while testing)
   curl http://192.168.1.16:8000/api/doom/version → 200 {"pid":286280,…}
   ```
   A self-request is **not** evidence about ufw: a packet this box sends to its own address never crosses the
   boundary the rule is about. Only a phone (or another machine) can prove a rule works — and this agent cannot
   even read the ruleset here (`nft list ruleset` → `Operation not permitted`, `sudo -n` → needs a password).
3. No `.gener/devcert` ⇒ the host is **plain HTTP**. Typing `https://192.168.1.16:8000/…` fails for that
   reason alone, before any firewall is involved: run `yarn cert` for the 8043 path.

## NOT proven / open (do not silently "fix")

1. **Android install.** The install menu disappeared at 17:11 because the phone got the *forwarder's* 502 text,
   which contains no `<link rel=manifest>` — nothing for Chrome to offer. Here that failure mode cannot occur,
   and the page/manifest/icon answer 200 with a real secure context — but **"it will install" is still
   unproven**: it needs the phone (or `yarn ui:install-check` over adb). If Chrome still refuses, suspect #1 is
   the **SVG icon with `sizes:"any"`** vs Chrome wanting a raster PNG; suspect #2 is the CA not being trusted.
      Open the page at `https://<box>:8043/api/doom/ui/` (TLS port = `DEFAULT_TLS_PORT`) with
   `.gener/devcert/dev.crt` installed as a CA.
2. **`--push 64` playability.** Only **32** has ever been measured playable on this panel, and E1M2 is dark
   (mean luma ≈36, lit>60 ≈11%) compared with E1M5 (≈103, ≈82%). What the panel shows at 64 is readable
   **only by the person standing in front of it**.
3. **No jump in this engine** (`doomkeys.h` has none; 172/173 are strafe left/right), and the 2×2 four-button
   pad idea is **parked by the user**. If resumed, do all three at once: `src/game/doom-keys.ts` (+2 verbs),
   `scripts/doom-keys-check.cjs` (expected lines), `resources/ui/app.js` (`zones.right` 2 halves → 4 cells).
4. `PixooAPI#push()` still discards the device response, so a panel that refuses a frame leaves no evidence.
5. The panel's own `GetIndex` connection count is not printed by the runner yet — a firmware restart mid-run
   currently has to be noticed by eye.
6. **How a scaled-up GIF *looks*.** Which attributes GitHub keeps is measured (above). What a browser actually
   paints when a 64 px source is asked for at `width="512"` — smooth, because the only remaining lever is the
   browser's own interpolation, and `README.md` now asks for exactly that (the user's choice of A/`512`, the
   file itself stays 64×64 at 5 308 239 B) — is a browser behaviour this repo has not measured (no headless
   renderer here). If it matters, settle it by looking at the pushed page, not by arguing about specs.

## Rules this repo inherited (from the work that made it)

A claim is not evidence: run the shipped code and assert on its output (`--print-argv` prints what `spawn()`
would receive; `host:check` uses `src/hud/upload.ts` as the producer, not a hand-built POST). Never keep a
second copy of a parser, a rule or a number. A falsy value is not proof of absence. Fix one variable at a
time. Log a refusal loudly, log an accepted request rarely. And: prove what you can locally, then say plainly
which part only the phone — or the person reading the panel — can answer.
