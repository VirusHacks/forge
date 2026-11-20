#!/usr/bin/env python3
"""Like cut.py but each segment names its own recording: [src, start, end, speed]. Speed-ups and cuts only."""
import json, subprocess, sys
out, segs = sys.argv[1], json.loads(sys.argv[2])
srcs = sorted({s[0] for s in segs}); idx = {s: i for i, s in enumerate(srcs)}
parts, labels, edl, t = [], [], [], 0.0
for i, seg in enumerate(segs):
    src, a, b, sp = seg[:4]; hold = seg[4] if len(seg) > 4 else 0
    # hold > 0: freeze the segment's last frame for `hold` seconds (a labelled pause, not new content)
    pad = f",tpad=stop_mode=clone:stop_duration={hold}" if hold else ""
    parts.append(f"[{idx[src]}:v]trim={a}:{b},setpts=(PTS-STARTPTS)/{sp}{pad}[v{i}]"); labels.append(f"[v{i}]")
    d = (b - a) / sp + hold; edl.append({"edited_start": round(t, 3), "edited_end": round(t + d, 3), "source": src, "rec_start": a, "rec_end": b, "speed": sp, "hold_s": hold}); t += d
fc = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(segs)}:v=1:a=0,fps=30,format=yuv420p[out]"
cmd = ["ffmpeg", "-loglevel", "error", "-y"]
for s in srcs: cmd += ["-i", s]
subprocess.run(cmd + ["-filter_complex", fc, "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "16", out + ".mp4"], check=True)
json.dump({"segments": edl, "duration": round(t, 3)}, open(out + ".edl.json", "w"), indent=1)
print(out, round(t, 2))
