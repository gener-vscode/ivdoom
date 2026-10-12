/*
 * ─── PANEL PACING TABLE (measured on THIS Pixoo 64x64 panel, 2026-10-11) ───────────
 *
 * Two different numbers decide whether a live stream looks smooth, and they are NOT the same
 * number:
 *
 *   1. the UPLOAD ceiling  - how fast the device accepts one-frame requests. Measured, stable at
 *      any duration: ~61-67 ms/frame at PicWidth 32 (15.31 fps), ~141-145 ms at 64 (6.83 fps).
 *   2. the PLAYABLE rate   - how fast the panel actually paints. The panel paints at
 *      1000/PicSpeed, so it only plays what we send if PicSpeed sits just BELOW the interval at
 *      which we send. Measured by an A/B on the panel with the user watching:
 *
 *        PicWidth 32:  full rate, PicSpeed 60  -> 172 pushes / 14.26 fps -> stutters, frames late
 *                       pace 120 + PicSpeed 110 ->  99 pushes /  8.2 fps  -> smooth, no dropped steps
 *        PicWidth 64:  pace 200 + PicSpeed 180 -> 149 pushes /  4.95 fps -> best of the tested pairs
 *                       pace 250 + PicSpeed 220 -> 119 pushes /  3.96 fps -> WORSE / stiffer
 *
 *      Then the RATIO was probed on its own (§35): pace held at 120 @32, ONLY PicSpeed varied, 7 runs.
 *      Every one of them supplied 83-84 pushes / 8.30 fps with identical per-second checkpoints, so
 *      PicSpeed cannot change supply - only what the panel shows. Ranked by the user watching:
 *
 *                       PicSpeed 110 (0.917 x pace) -> rejected
 *                       PicSpeed  96 (0.800 x pace) -> "明顯順", CHOSEN
 *                       PicSpeed  90 (0.750 x pace) -> worse than 96
 *                       PicSpeed   1 (0.008 x pace) -> worse again (§34)
 *
 *      Ratio = 0.8. `pace` itself did NOT change: 120 at 32, 200 at 64 are still the verified supply.
 *
 *      So the playable rate is ~8-9 fps at 32 and ~4-5 fps at 64 - roughly 60-70% of the upload
 *      ceiling. Pacing costs no latency (the A/B had identical 69 ms RTT); it only lowers supply.
 *
 * Read the failure modes carefully, they are the reason for the shape of this table:
 *   • Over-pacing is its own failure mode. 200 -> 200ms made it worse while PicSpeed/pace stayed
 *     the same ratio; a lower supply means a bigger motion step per displayed frame. So do NOT
 *     "play it safe by going slower" - pick the SMALLEST pace that removes the stepping.
 *   • Do NOT minimise PicSpeed either, and do not hard-code a low one. With the pace held constant,
 *     PicSpeed 1 was measured at BOTH widths and read as worse than the paired value by the user
 *     watching ("B seems better" at 32; "A、B 都有跳，不過 B 係明顯 smooth 過 A" at 64), and at
 *     PicWidth 32 it cost 20.4 ms per request (89.3 vs 68.9 avg RTT). The panel has no lower bound -
 *     PicSpeed 1 is accepted and at 64 costs nothing on the wire - so the 0.8 x pace pairing is a
 *     VISIBILITY rule, not a firmware limit. §34, §35.
 *   • The pairing ratio is 0.8 x pace, and it is the ONLY part of a row that is a ratio rather than a
 *     measurement. Pick `pace` from the table; derive PicSpeed from it. Nothing in 0.75..0.917 changes
 *     supply or RTT measurably (§35: 7 runs, all 8.30 fps, RTT scattered 61.7-92.5 ms with no order) -
 *     the difference is purely what the panel paints, so it may only be changed by looking at the panel.
 *   • Do not derive `pace` from the RTT model (RTT ~ 30 ms + 8.1 ms/KB): at PicWidth 64 the
 *     measured average RTT moved WITH the pacing (176 ms at pace 200, 149 ms at pace 250). The
 *     model is a lower bound, this table is the input.
 *   • Anything grouped (PicNum > 1, or Draw/CommandList carrying a multi-frame animation) never
 *     plays while it is being streamed continuously. One frame per request is the only live shape.
 *
 * Full measurements: .gener/t0-findings.md §21 (PicSpeed is the root cause), §30 (grouped
 * animation is a dead end for live content), §31 (a device degraded by grouped probes is not a
 * valid measurement; PicSpeed costs nothing on the wire, within the sane range only), §32 (@32
 * pairing), §33 (@64 pairing), §34 (PicSpeed 1: accepted, no degradation, but reads worse than the
 * pairing at both widths and costs 20 ms/request at 32), §35 (the ratio itself: 96 over 90 and 110 at a
 * fixed pace; supply identical in every run, so a ratio can only be settled by eye).
 *
 * This file is deliberately import-free: the values describe the DEVICE, not a game. It lives with
 * the Pixoo client so that when the panel client is reused by another repository there is still
 * exactly one copy of them, and it stays valid when the supply loop (which does the waiting) moves
 * somewhere else - only a loop that supplies frames knows its own interval, and the client must
 * never sleep by itself, because the clock/weather/bus pages WANT the frame to hold (PicSpeed 1000).
 */

/** Same clamp PixooAPI#setPicSpeed() uses; kept here so the pairing rule and the API agree. */
export const PIC_SPEED_LIMITS = { min: 42, max: 1000 } as const;

export type PanelPacing = {
  /** PicWidth this row applies to. */
  picWidth: number;
  /** Supply interval to hold between pushes, 0 = as fast as the device answers. */
  paceMs: number;
  /** PicSpeed verified together with `paceMs` (never lower "just to be safe"). */
  picSpeed: number;
  /** Measured single-frame RTT when pushing as fast as the device answers. */
  uploadCeilingMs: number;
  /** frames/s this path supplies at `paceMs`. */
  supplyFps: number;
    /** frames/s the user confirmed seeing on the panel; for an interpolated row this is only the
     * nominal 1000/PicSpeed of the full-rate pairing, which is an upper bound, not an observation. */
    playableFps: number;
  /** false = extrapolated from the measured rows, not confirmed on the panel. */
  verifiedByEyes: boolean;
  /**
   * Set when part of this row was DERIVED instead of watched. A caller should print it: the row is
   * usable, but the thing named here has not been confirmed on a real panel yet.
   */
  needsVisualCheck?: string;
};

const MEASURED: Record<number, PanelPacing> = {
  32: {
    picWidth: 32,
    paceMs: 120,
    // 0.8 x pace, chosen by eye over 90 (0.75) and 110 (0.917) at the SAME pace (§35).
    // 110 was the pairing used in §32; the ratio was re-probed because nothing in 0.75-0.917 was
    // ever distinguished on the wire, so only the panel can rank them.
    picSpeed: 96,
    uploadCeilingMs: 63,
    supplyFps: 8.33,
    playableFps: 8.2,
    verifiedByEyes: true,
  },
  64: {
    picWidth: 64,
    paceMs: 200,
    // pace 200 measured (§33); PicSpeed 160 = 0.8 x pace, confirmed on the panel on 2026-10-11 13:41
    // (99 pushes / 4.92 fps, avg 159.9 ms, canary 39/41 ms) and accepted by the user ("呢段已經夠好").
    // Replaces the 180/200 pair of §33, which the ratio probe then ranked below 0.8 at a fixed pace.
    picSpeed: 160,
    uploadCeilingMs: 143,
    supplyFps: 5.0,
    playableFps: 4.95,
    verifiedByEyes: true,
  },
};

export const PANEL_PACING: Record<number, PanelPacing> = MEASURED;

const clampPicSpeed = (ms: number): number =>
  Math.min(PIC_SPEED_LIMITS.max, Math.max(PIC_SPEED_LIMITS.min, Math.round(Number(ms) || PIC_SPEED_LIMITS.max)));

/**
 * PicSpeed = 0.8 x the real supply interval. Settled by eye on the panel, at a FIXED pace, comparing
 * 96 (0.8) against 90 (0.75) and 110 (0.917): supply was 8.30 fps in every run, so the ranking is a
 * display observation, not a throughput one (§35). 0.75 and 1 were both read as worse, so this is a
 * peak, not a preference - do not "play it safe" by going lower.
 * Use this for a pace you chose yourself; for the measured intervals use PANEL_PACING.picSpeed.
 */
export const PIC_SPEED_RATIO = 0.8;
export const picSpeedForPace = (paceMs: number): number => clampPicSpeed(Math.max(0, Number(paceMs)) * PIC_SPEED_RATIO);

/**
 * How long to wait AFTER a push has finished so the interval between pushes stays at `paceMs`
 * (the request itself already consumed part of it). Pure maths: the caller still owns the timer.
 */
export const paceSleepMs = (elapsedMs: number, paceMs: number): number =>
  Math.max(0, paceMs - Math.max(0, elapsedMs));

/**
 * Pacing for one PicWidth. 32 and 64 are the verified rows; anything else is interpolated between
 * them and comes back with verifiedByEyes:false, so a caller can warn the user before it is used.
 */
export const panelPacingFor = (picWidth: number): PanelPacing => {
  const width = Math.max(1, Math.round(Number(picWidth) || 64));
  const known = MEASURED[width];
  if (known) return known;

  const lo = MEASURED[32];
  const hi = MEASURED[64];
  const t = Math.min(1, Math.max(0, (width - 32) / (64 - 32)));
  const paceMs = Math.round(lo.paceMs + (hi.paceMs - lo.paceMs) * t);
  const uploadCeilingMs = Math.round(lo.uploadCeilingMs + (hi.uploadCeilingMs - lo.uploadCeilingMs) * t);
  return {
    picWidth: width,
    paceMs,
    picSpeed: picSpeedForPace(paceMs),
    uploadCeilingMs,
    supplyFps: +(1000 / paceMs).toFixed(2),
    playableFps: +(1000 / picSpeedForPace(uploadCeilingMs)).toFixed(2),
    verifiedByEyes: false,
  };
};
