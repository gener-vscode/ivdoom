# ivdoom — DOOM on a Pixoo 64 panel, driven by a phone

**One Node process.** The controller page, the input broker, the status-strip cache, the panel supply loop
and the headless engine all live in the same PID. There is no Azure Functions host here and no TLS forwarder:
`src/host/server.ts` serves `/api/doom/ui/`, `/api/doom/input` and `/api/doom/hud` itself and terminates TLS
itself. A C subprocess (`.gener/build/doom/doom-headless`) is unavoidable — it is the game — but nothing else here.

Split out of `../pixoo` on 2026-10-12 at the user's instruction: *"no shared layer, just move and clone."*
So this repo **never imports from, reads from, or depends on** the other repo. The shared layers
(`src/input`, `src/pixoo`, `src/hud/{bar,wire,cache,upload}`, `src/ui/static`, `resources/ui`) are **copies**,
and copies drift. That trade-off was chosen deliberately: no `file:../pixoo`, no third package, no build coupling.
`src/pixoo/pacing.ts` still owns the panel's millisecond numbers; if you change them here, change no other file.

## Run it

```bash
yarn engine          # clone doomgeneric + make → .gener/build/doom/doom-headless (needs gcc)
yarn cert            # .gener/devcert/dev.crt + dev.key, SAN from os.networkInterfaces()
yarn play            # host + playable DOOM, one command: --input remote --warp 1 2 --push 64
yarn play:32         # the width actually measured playable (see «Measured»)
yarn play:demo       # no phone: -playdemo DEMO1, the path every pixoo frame note was measured through
yarn serve           # the page + broker + hud cache only: no engine, no panel
yarn host:check      # prove one process serves every route (no panel, no engine)
yarn canary          # Channel/GetIndex liveness before/after a device run
yarn ui:install-check -- --urls https://<this-box>:8443/api/doom/ui/
yarn kill            # free 8443/8080
```
`.gener/` is gitignored: vendor (8 MB), `freedoom1.wad` (28 MB of 51 MB of downloads), the build and the dev
cert are all reproducible with the two commands above. `local.settings.json` holds `PIXOO_ORIGIN` (the panel's
LAN address) and nothing else.

`yarn play` keeps the stage and width **the user chose** (`--warp 1 2 --push 64`, E1M2 at PicWidth 64). Changing
the default means editing this file's `package.json`, because every option here is read with `indexOf()` —
**the FIRST match wins**.

## Shape of it

| file | role |
|---|---|
| `scripts/doom-device.cjs` | the entry: read args → start the host → build the engine argv → spawn → pull frames from fd 3 → scale → push → `Ctrl-C` releases keys, closes engine **then** host |
| `src/host/server.ts` | `node:https` when `.gener/devcert` exists, else `node:http`. Own port (8443 TLS / 8080 plain), 4 MB body cap, `EADDRINUSE` answered as "another ivdoom host is still running", `close()` also closes keep-alive sockets |
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

## NOT proven / open (do not silently "fix")

1. **Android install.** The install menu disappeared at 17:11 because the phone got the *forwarder's* 502 text,
   which contains no `<link rel=manifest>` — nothing for Chrome to offer. Here that failure mode cannot occur,
   and the page/manifest/icon answer 200 with a real secure context — but **"it will install" is still
   unproven**: it needs the phone (or `yarn ui:install-check` over adb). If Chrome still refuses, suspect #1 is
   the **SVG icon with `sizes:"any"`** vs Chrome wanting a raster PNG; suspect #2 is the CA not being trusted.
   Open the page at `https://<box>:8443/api/doom/ui/` with `.gener/devcert/dev.crt` installed as a CA.
2. **`--push 64` playability.** Only **32** has ever been measured playable on this panel, and E1M2 is dark
   (mean luma ≈36, lit>60 ≈11%) compared with E1M5 (≈103, ≈82%). What the panel shows at 64 is readable
   **only by the person standing in front of it**.
3. **No jump in this engine** (`doomkeys.h` has none; 172/173 are strafe left/right), and the 2×2 four-button
   pad idea is **parked by the user**. If resumed, do all three at once: `src/game/doom-keys.ts` (+2 verbs),
   `scripts/doom-keys-check.cjs` (expected lines), `resources/ui/app.js` (`zones.right` 2 halves → 4 cells).
4. `PixooAPI#push()` still discards the device response, so a panel that refuses a frame leaves no evidence.
5. The panel's own `GetIndex` connection count is not printed by the runner yet — a firmware restart mid-run
   currently has to be noticed by eye.

## Rules this repo inherited (from the work that made it)

A claim is not evidence: run the shipped code and assert on its output (`--print-argv` prints what `spawn()`
would receive; `host:check` uses `src/hud/upload.ts` as the producer, not a hand-built POST). Never keep a
second copy of a parser, a rule or a number. A falsy value is not proof of absence. Fix one variable at a
time. Log a refusal loudly, log an accepted request rarely. And: prove what you can locally, then say plainly
which part only the phone — or the person reading the panel — can answer.
