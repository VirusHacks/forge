#!/bin/zsh
# Build a constant-30fps MP4 from captured frames using their real capture timestamps.
d=../recordings/$1
python3 - "$d" <<'PY'
import sys
d=sys.argv[1]; rows=[l.split('\t') for l in open(f'{d}/frames.tsv').read().split('\n') if l.strip()]
with open(f'{d}/concat.txt','w') as f:
    for i,(name,t) in enumerate(rows):
        nxt=float(rows[i+1][1]) if i+1<len(rows) else float(t)+0.04
        f.write(f"file 'frames/{name}'\nduration {max(0.001,nxt-float(t)):.4f}\n")
    f.write(f"file 'frames/{rows[-1][0]}'\n")
PY
ffmpeg -y -loglevel error -f concat -safe 0 -i $d/concat.txt -vf "fps=30,format=yuv420p" -c:v libx264 -preset medium -crf 16 $d/raw.mp4 && ffprobe -v error -show_entries format=duration -of csv=p=0 $d/raw.mp4
