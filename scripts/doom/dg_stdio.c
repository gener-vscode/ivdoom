/*
 * dg_stdio.c - headless "no display" driver for doomgeneric (pixoo bridge).
 *
 * The engine renders into DG_ScreenBuffer (RGBA8888, pixel_t = uint32_t).
 * This driver converts each finished frame to raw RGB24 and writes it to fd 3.
 * Node reads fd 3 (spawn stdio[3]) and slices fixed-size frames out of it.
 *
 * ─── WHY THE CLOCK LOOKS WEIRD HERE (learned the hard way, 2026-10-10) ────────
 * i_timer.c takes ALL of the engine's time from DG_GetTicksMs(), and DG_SleepMs()
 * is the only place the engine is allowed to wait. A first version of this driver
 * used a *virtual* clock advanced 28 ms per requested frame, and the engine then
 * hung forever with zero frames: I_GetTime() = (ticks*35)/1000 quantises 28 ms to
 * ZERO game tics, so TryRunTics() waited for `lowtic >= gametic` inside a loop
 * whose I_Sleep() is a NO-OP in this port (SDL_Delay/usleep are commented out).
 * => a driver must not hand the engine a clock that can stand still.
 *
 * Final behaviour = the same contract the upstream xlib/sdl drivers use:
 *   DG_GetTicksMs() -> real monotonic milliseconds since start
 *   DG_SleepMs()    -> real nanosleep
 * The engine therefore self-paces at DOOM's 35 tics/s in wall-clock time, exactly
 * like a normal port. Frame *selection* (drop frames to match the panel's 16 fps
 * or 7 fps) is the reader's job - see src/doom/play-doom.ts.
 *
 * Stopping is bounded so a headless run can never hang a build:
 *   DOOM_MAX_FRAMES  stop after N frames  (0 = unlimited)
 *   DOOM_MAX_MS      stop after N wall milliseconds (0 = unlimited)
 * Either one bounds the run; default DOOM_MAX_MS keeps a safety net.
 *
 * Frame wire format (fd 3): nothing extra, DOOMGENERIC_RESX*RESY*3 bytes per frame,
 * row-major RGB24. Framing is the reader's job (fixed size).
 */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <unistd.h>

#include "doomgeneric.h"

/*
 * STATE wire (fd 4) - added 2026-10-12 for playable DOOM. Only these four headers, and the engine
 * itself is untouched: `players`, `consoleplayer`, `gametic`, `gamemap` are the engine's own
 * exported state (`d_player.h` pulls `p_mobj.h`, so `mo->x/y/angle` are reachable too).
 */
#include "doomdef.h"
#include "doomstat.h"
#include "d_player.h"

#define FRAME_FD 3
/* One state line every N tics (N>0). 5 tics ~ 7 lines/s at DOOM's 35 tics/s: a few hundred
 * bytes/s, and fine-grained enough to see a key take effect within two game tics. */
#define STATE_FD 4
#define STATE_EVERY 5

static uint64_t start_ms = 0;
static uint64_t frames_written = 0;

static uint64_t monotonic_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000ull + (uint64_t)(ts.tv_nsec / 1000000);
}

void DG_Init(void)
{
    start_ms = monotonic_ms();
    /* Input arrives on fd 0 from the Node side. It must never block the engine: a player who
     * stopped typing is not a reason for DOOM to stop running. */
    const int flags = fcntl(0, F_GETFL, 0);
    if (flags >= 0)
        fcntl(0, F_SETFL, flags | O_NONBLOCK);
}

void DG_SetWindowTitle(const char *title)
{
    (void)title;
}

/* Real sleep: a no-op sleep turns TryRunTics()'s wait loop into a busy hang. */
void DG_SleepMs(uint32_t ms)
{
    struct timespec ts;
    if (ms == 0)
        return;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
}

/* Real clock: this is the only time source the engine has (i_timer.c). */
uint32_t DG_GetTicksMs(void)
{
    return (uint32_t)(monotonic_ms() - start_ms);
}

/*
 * ─── INPUT (added 2026-10-12, for playable DOOM) ──────────────────────────────────────────────
 * The engine already drains this every tic (`i_input.c: while (DG_GetKey(&pressed, &key))`) and
 * `TranslateKey()` in that file is the identity, so a line here reaches `ev_keydown/ev_keyup`
 * unchanged. We therefore send the engine's OWN key bytes straight from `doomkeys.h`
 * (KEY_UPARROW 0xad, KEY_DOWNARROW 0xaf, KEY_LEFTARROW 0xac, KEY_RIGHTARROW 0xae,
 *  KEY_STRAFE_L 0xa0, KEY_STRAFE_R 0xa1, KEY_USE 0xa2, KEY_FIRE 0xa3) - no engine patch.
 *
 * Wire (fd 0, one event per line, ASCII):
 *     <press> <decimal key>        press = 0 | 1      e.g.  "1 172" = key down 0xac (turn left)
 *     r                            release EVERY key currently held (a stick release must not
 *                                  leave DOOM walking forever)
 * Same queue shape as the upstream drivers (doomgeneric_sdl.c etc.): keyData = (pressed << 8) | key.
 */
#define KEYQUEUE_SIZE 128
static unsigned short s_KeyQueue[KEYQUEUE_SIZE];
static unsigned int s_KeyQueueWriteIndex = 0;
static unsigned int s_KeyQueueReadIndex = 0;

/* Held keys, so `r` can release exactly what is down. */
static int s_held[256];

static void queue_key(int pressed, unsigned char key)
{
    const unsigned int next = (s_KeyQueueWriteIndex + 1) % KEYQUEUE_SIZE;
    if (next == s_KeyQueueReadIndex)
        return; /* full: drop, never block the engine */
    s_KeyQueue[s_KeyQueueWriteIndex] = (unsigned short)(((pressed & 1) << 8) | key);
    s_KeyQueueWriteIndex = next;
    s_held[key] = pressed ? 1 : 0;
}

static char s_line[64];
static size_t s_line_len = 0;
static int s_stdin_open = 1;
static unsigned long s_keys_parsed = 0;
static unsigned long s_keys_bad = 0;

static void parse_line(void)
{
    const char *line = s_line;
    while (*line == ' ' || *line == '\t')
        line++;
    if (*line == 'r' || *line == 'R')
    {
        for (int key = 0; key < 256; key++)
            if (s_held[key])
                queue_key(0, (unsigned char)key);
        return;
    }
    /* ⚠️ The bug this file's own state instrument caught (2026-10-12): the first version ended the
     * number parsing with `end == line + strlen(line)` as a FAILURE test - but a successful parse of
     * the whole line leaves `end` exactly THERE. So every valid line was rejected, no key was ever
     * queued, and the state proof measured avgMove=0 / maxTurn=0 in every phase. `end == start` is
     * the real "no digits here" test; that is the only version that can tell the two apart.
     */
    char *end = NULL;
    const long press = strtol(line, &end, 10);
    if (end == NULL || end == line || (press != 0 && press != 1))
    {
        s_keys_bad++;
        return;
    }
    const char *key_start = end;
    const long key = strtol(key_start, &end, 10);
    if (end == NULL || end == key_start || key < 0 || key > 255)
    {
        s_keys_bad++;
        return;
    }
    queue_key((int)press, (unsigned char)key);
    s_keys_parsed++;
}

static void drain_stdin(void)
{
    char buf[256];
    if (!s_stdin_open)
        return;
    const ssize_t n = read(0, buf, sizeof(buf));
    if (n == 0)
    {
        s_stdin_open = 0; /* Node closed stdin: run without input, never hang */
        return;
    }
    if (n < 0)
    {
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)
            s_stdin_open = 0;
        return;
    }
    for (ssize_t i = 0; i < n; i++)
    {
        const char c = buf[i];
        if (c == '\n' || c == '\r')
        {
            s_line[s_line_len] = '\0';
            parse_line();
            s_line_len = 0;
            continue;
        }
        if (s_line_len < sizeof(s_line) - 1)
            s_line[s_line_len++] = c;
    }
}

int DG_GetKey(int *pressed, unsigned char *doomKey)
{
    drain_stdin();
    if (s_KeyQueueReadIndex == s_KeyQueueWriteIndex)
        return 0; /* queue empty */
    const unsigned short keyData = s_KeyQueue[s_KeyQueueReadIndex];
    s_KeyQueueReadIndex = (s_KeyQueueReadIndex + 1) % KEYQUEUE_SIZE;
    *pressed = keyData >> 8;
    *doomKey = (unsigned char)(keyData & 0xFF);
    return 1;
}

static void write_all(int fd, const unsigned char *buf, size_t len)
{
    while (len > 0)
    {
        ssize_t n = write(fd, buf, len);
        if (n <= 0)
            return;
        buf += n;
        len -= (size_t)n;
    }
}

/*
 * WHY THIS EXISTS (and why the frame is the wrong instrument). Measured 2026-10-12 with
 * `scripts/doom-input-check.cjs`: after discarding the `-warp` level-transition wipes (those reach
 * ~4.5M |diff| per frame), holding turn+walk produced 11469/frame against an idle map at 9718/frame.
 * The map's OWN animation is bigger than what a held key does to the view, so a pixel difference
 * cannot answer "did the input arrive". `players[consoleplayer]` can: either its x/y/angle move or
 * they do not.
 * These are also the numbers a DOOM status strip needs - `src/hud/bar.ts` was never missing a
 * layout, it was missing a source.
 *
 * `ang` is the engine's raw angle unit (NOT degrees): a change of >1000000 units is clearly "the
 * view turned"; converting here would mean trusting an ANG1 constant I have not verified in this tree.
 *
 *   DG_STATE t=<gametic> map=<gamemap> ps=<playerstate> mo=<0|1> x=<fixed_t> y=<fixed_t>
 *            ang=<angle_t> hp=<player health> ar=<armorpoints> wp=<readyweapon>
 *            atk=<attackdown> use=<usedown>
 *
 * `atk`/`use` are the engine's OWN record that the FIRE / USE button was down on the last tic -
 * i.e. a button press can be proven without interpreting a single pixel. `player_t` has no `pitch`
 * member in this tree (measured: the compiler says so), and the ammo enum name is not `AMMO_CLIP`
 * here either, so the amount of ammo is deliberately NOT reported until its name is verified.
 */
static void write_state(void)
{
    char buf[256];
    const player_t *p = &players[consoleplayer];
    const int n = snprintf(
        buf, sizeof(buf),
        "DG_STATE t=%d map=%d ps=%d mo=%d x=%lld y=%lld ang=%lld hp=%d ar=%d wp=%d atk=%d use=%d\n",
        gametic, gamemap, (int)p->playerstate, p->mo ? 1 : 0,
        p->mo ? (long long)p->mo->x : 0LL,
        p->mo ? (long long)p->mo->y : 0LL,
        p->mo ? (long long)p->mo->angle : 0LL,
        p->health, p->armorpoints, (int)p->readyweapon, p->attackdown, p->usedown);
    if (n > 0)
        write_all(STATE_FD, (const unsigned char *)buf, (size_t)n);
}

void DG_DrawFrame(void)
{
    static unsigned char rgb[DOOMGENERIC_RESX * DOOMGENERIC_RESY * 3];
    const pixel_t *src = DG_ScreenBuffer;
    const size_t count = (size_t)DOOMGENERIC_RESX * (size_t)DOOMGENERIC_RESY;
    unsigned char *dst = rgb;
    size_t i;

    for (i = 0; i < count; i++)
    {
        const uint32_t v = src[i];
        dst[0] = (unsigned char)((v >> 16) & 0xff);
        dst[1] = (unsigned char)((v >> 8) & 0xff);
        dst[2] = (unsigned char)(v & 0xff);
        dst += 3;
    }

    write_all(FRAME_FD, rgb, sizeof(rgb));
    frames_written++;
}

static long env_long(const char *name, long fallback)
{
    const char *raw = getenv(name);
    if (raw == NULL || *raw == '\0')
        return fallback;
    return strtol(raw, NULL, 10);
}

int main(int argc, char **argv)
{
    const long max_frames = env_long("DOOM_MAX_FRAMES", 0);
    /* Safety net only: 0 would let a stuck engine run forever inside a build. */
    const long max_ms = env_long("DOOM_MAX_MS", 120000);
    /*
     * DOOM_MAX_TPS - how many doomgeneric_Tick() calls per wall second.
     * Measured 2026-10-10: with -playdemo the engine runs in `singletics` mode (g_game.c:
     * "run a single tic every time this function is called"), so a Tick is ONE game tic and
     * the wall clock is ignored -> an unthrottled loop played DEMO1 at ~57 tps, i.e. 1.6x
     * real speed. 0 = unthrottled; the default 35 restores DOOM's real 35 tics/s, which is
     * what makes "3 seconds of animation" mean 3 seconds of GAME time.
     */
    const long target_tps = env_long("DOOM_MAX_TPS", 35);

    /* doomgeneric_Create owns argv: -file <wad>, -playdemo, -warp, -nomusic ... */
    doomgeneric_Create(argc, argv);
    /* First line immediately: "is fd 4 readable at all" must not wait for the first tic. */
    write_state();

    fprintf(stderr, "DG_HEADLESS ready res=%dx%d max_frames=%ld max_ms=%ld frames_from_init=%llu\n",
            DOOMGENERIC_RESX, DOOMGENERIC_RESY, max_frames, max_ms,
            (unsigned long long)frames_written);
    fflush(stderr);

    /*
     * The schedule MUST be anchored here, not at start_ms: doomgeneric_Create() already
     * draws frames on its own (measured frames_from_init=42), so a schedule anchored at
     * DG_Init is ~1.2 s behind wall clock before the first Tick -> `due > now` is never
     * true and the throttle silently does nothing. Verified both ways on 2026-10-10:
     *   anchored at start_ms : DOOM_MAX_TPS=0 -> 2095 ms, =35 -> 2094 ms  (no effect)
     *   anchored at loop start: DOOM_MAX_TPS=0 -> fast, =35 -> ~ticks/35 s
     */
    uint64_t ticks_done = 0;
    const uint64_t loop_start = monotonic_ms();
    while (1)
    {
        if (max_frames > 0 && (long)frames_written >= max_frames)
            break;
        if (max_ms > 0 && (long)(monotonic_ms() - start_ms) >= max_ms)
            break;

        /* Once per iteration even when the engine reads no events this tic. */
        drain_stdin();
        doomgeneric_Tick();
        ticks_done++;
        if (STATE_EVERY > 0 && ticks_done % (uint64_t)STATE_EVERY == 0)
            write_state();

        if (target_tps > 0)
        {
            /* Absolute schedule (n*1000/tps), never a drifting += 28 ms sleep. */
            const uint64_t due = loop_start + (ticks_done * 1000ull) / (uint64_t)target_tps;
            const uint64_t now = monotonic_ms();
            if (due > now)
                DG_SleepMs((uint32_t)(due - now));
        }
    }

    {
        /* The input wire reporting for itself: "no key ever accepted" must be visible as a number,
         * never inferred from a picture. Same policy as /input/sessions exposing `refusedPosts`. */
        int held = 0;
        for (int key = 0; key < 256; key++)
            held += s_held[key] ? 1 : 0;
        fprintf(stderr, "DG_INPUT parsed=%lu rejected=%lu keys_still_held=%d\n",
                s_keys_parsed, s_keys_bad, held);
        const uint64_t wall = monotonic_ms() - start_ms;
        fprintf(stderr, "DG_HEADLESS done frames=%llu wall_ms=%llu fps=%.2f\n",
                (unsigned long long)frames_written, (unsigned long long)wall,
                wall ? (double)frames_written * 1000.0 / (double)wall : 0.0);
        fflush(stderr);
    }
    return 0;
}
