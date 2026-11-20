#!/usr/bin/env python3
"""Cut a recording into an edited clip: segments of (start, end, speed). Writes <out>.mp4 and <out>.edl.json.
Speed-ups only; nothing is reordered. The EDL maps edited time back to recording time for the evidence matrix."""
import json, subprocess, sys
src, out, segs = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
parts, labels, edl, t = [], [], [], 0.0
for i, (a, b, sp) in enumerate(segs):
    parts.append(f"[0:v]trim={a}:{b},setpts=(PTS-STARTPTS)/{sp}[v{i}]"); labels.append(f"[v{i}]")
    d = (b - a) / sp; edl.append({"edited_start": round(t, 3), "edited_end": round(t + d, 3), "rec_start": a, "rec_end": b, "speed": sp}); t += d
fc = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(segs)}:v=1:a=0,fps=30,format=yuv420p[out]"
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", src, "-filter_complex", fc, "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "16", out + ".mp4"], check=True)
json.dump({"source": src, "segments": edl, "duration": round(t, 3)}, open(out + ".edl.json", "w"), indent=1)
print(out, round(t, 2))
