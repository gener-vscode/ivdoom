#!/usr/bin/env python3
"""
GIF assembly for scripts/doom-gif.cjs.

Why python and not node: this repo has no GIF encoder (no ffmpeg/gifsicle/ImageMagick installed), and the
only GIF codec reachable through node_modules is a transitive dependency of an image library - depending on
a transitive package would be a hidden coupling. `python3 -c "import PIL"` works on this machine (Pillow
12.3.0), and PIL is the one tool here that can write a GIF89a animation with an EXACT per-frame duration,
which is the whole point: a duration is only auditable if it was WRITTEN per frame, not guessed by whatever
"fps" flag some converter happened to apply.

Reads a manifest written by doom-gif.cjs:
  {"size":64, "outDir":"...", "prefix":"doom24",
   "groups":[{"name":"doom24-1.gif", "frames":["...png", ...], "durationsMs":[40,40,40,40,40,50]}]}

One palette per group: every frame of a group is quantized against the FIRST frame's 256-colour palette,
so the animation does not flicker between palettes and the device sees a single global colour table.

Copied - not shared - from the dashboard repo on 2026-10-12, like every other layer here. If it changes in
one repo, it does not change in the other.

Usage: python3 scripts/gif-assemble.py .gener/doom-gif/manifest.json
"""
import json
import os
import sys

from PIL import Image


def load_manifest(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def quantize_all(frames):
    """One shared 256-colour palette for a whole group (no palette flicker between frames)."""
    first = frames[0]
    palette = first.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.Dither.NONE)
    try:
        return [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    except Exception as exc:  # pragma: no cover - keep the probe alive if PIL changes API
        print(f"  ! shared palette failed ({exc}); falling back to per-frame quantization")
        return [frame.quantize(colors=256, method=Image.MEDIANCUT, dither=Image.Dither.NONE) for frame in frames]


def build_group(group, out_dir, loop):
    frames = [Image.open(p).convert("RGB") for p in group["frames"]]
    if not frames:
        raise SystemExit(f"group {group['name']} has no frames")

    durations = [int(d) for d in group["durationsMs"]]
    frames_ms = [int(group.get("framesMs", 0)) for _ in frames]
    quant = quantize_all(frames)
    out_path = os.path.join(out_dir, group["name"])
    quant[0].save(
        out_path,
        format="GIF",
        save_all=True,
        append_images=quant[1:],
        duration=durations,
        loop=int(group.get("loop", loop)),
        disposal=1,  # each frame is a full-size frame, nothing to dispose
        optimize=False,
        version="GIF89a",
    )
    total = sum(durations)
    size = frames[0].size
    bytes_out = os.path.getsize(out_path)
    print(
        f"GIF {out_path} {size[0]}x{size[1]} frames={len(frames)} "
        f"durationsMs={len(set(durations))} distinct values summing to {total}ms "
        f"avg={total / len(frames):.2f}ms nominal_fps={1000.0 * len(frames) / total:.2f} bytes={bytes_out} "
        f"framesMs={len(set(frames_ms))} distinct"
    )
    return out_path


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: python3 scripts/gif-assemble.py <manifest.json> [--loop 0|1]")
    manifest = load_manifest(sys.argv[1])
    loop = 0
    if "--loop" in sys.argv:
        loop = int(sys.argv[sys.argv.index("--loop") + 1])
    out_dir = manifest["outDir"]
    os.makedirs(out_dir, exist_ok=True)
    for group in manifest["groups"]:
        build_group(group, out_dir, loop)


if __name__ == "__main__":
    main()
