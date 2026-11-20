#!/usr/bin/env python3
"""Generate composition/index.html (v2 edit): section timing, narration placement, zooms, sound."""
import subprocess
def dur(p): return float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',p]).decode())
I, R1 = 0.0, 6.2
A = 28.2; LA = 38.0
B = A + LA; LB = 119.9
C = B + LB; LC = 39.2
RC = C + LC; LR = 9.0
END = round(RC + LR, 2)
narr = [("i1", I+0.25), ("r1", R1+0.3),
 ("a1", A+0.3), ("a2", A+10.0), ("a3", A+30.6),
 ("b1", B+0.1), ("b2", B+4.6), ("b3", B+24.6), ("b4", B+59.3), ("b4b", B+65.9), ("b5", B+72.0), ("b6", B+81.2), ("b7", B+88.4), ("b8", B+101.6), ("b9", B+105.0), ("b10", B+113.5),
 ("c1", C+0.3), ("c2", C+11.2), ("c3a", C+26.2), ("c3b", C+36.6), ("e1", RC+0.3)]
sfx = [("w1","whoosh-short",R1-0.2,0.35),("w2","whoosh-short",A-0.2,0.35),("w3","whoosh-short",B-0.2,0.35),("w4","whoosh-short",C-0.2,0.35),("w5","whoosh-short",RC-0.2,0.35),
 ("c1","click-soft",A+21.2,0.5),("c2","click-soft",B+71.9,0.5),("c3","click-soft",C+26.1,0.5),
 ("k1","chime",A+29.3,0.22),("k2","chime",B+81.3,0.22),("k3","chime",C+36.7,0.22)]
lines, prev = [], (None, 0)
for n, st in narr:
    d = dur(f'assets/audio/v2/{n}.wav')
    if st < prev[1]: print("OVERLAP", prev[0], n, prev[1], st)
    prev = (n, st + d)
    lines.append(f'      <audio id="n-{n}" class="clip" src="assets/audio/v2/{n}.wav" data-start="{st:.2f}" data-duration="{d:.3f}" data-track-index="10" data-volume="1"></audio>')
sl = [f'      <audio id="sfx-{i}" class="clip" src="assets/sfx/{f}.mp3" data-start="{st:.2f}" data-duration="{dur(f"assets/sfx/{f}.mp3"):.3f}" data-track-index="12" data-volume="{v}"></audio>' for i, f, st, v in sfx]
def host(i, src, st, d, z): return f'      <div id="{i}" data-composition-id="{i}" data-composition-src="compositions/{src}.html" data-start="{st}" data-duration="{d}" data-track-index="{1 if z < 5 else 3}" data-track-kind="graphics" data-width="1920" data-height="1080" style="z-index:{z}"></div>'
html = f'''<!doctype html>
<html lang="en" data-resolution="landscape">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * {{ margin: 0; padding: 0; box-sizing: border-box; }}
      html, body {{ margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: #0a0d13; }}
      #root {{ position: relative; width: 100%; height: 100%; font-family: Inter, sans-serif; }}
      #bg {{ position: absolute; inset: 0; background: #0a0d13; }}
      .wrap {{ position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; overflow: hidden; }}
      .wrap video {{ position: absolute; left: 0; top: 0; width: 1920px; height: 1080px; object-fit: contain; }}
    </style>
  </head>
  <body>
    <!-- Forge · Forge-a-thon demo, v2 edit. Footage in assets/clips is real VS Code capture (../CAPTURE_PLAN.md).
         Overlays point at what is on screen; the Task B explainer and ticker are generated from the real run log.
         Timeline (s): intro 0–{R1} · architecture {R1}–{A} · Task A {A}–{B:.1f} · Task B {B:.1f}–{C:.1f} · Task C {C:.1f}–{RC:.1f} · recap {RC:.1f}–{END} -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="{END}" data-width="1920" data-height="1080">
      <div id="bg"></div>
{host("intro","intro",I,R1,1)}
{host("arch","arch",R1,round(A-R1,2),1)}
      <div id="wrapA" class="wrap" style="z-index:2"><video id="vidA" class="clip" src="assets/clips/taskA.mp4" muted playsinline data-start="{A}" data-duration="{LA}" data-track-index="2"></video></div>
      <div id="wrapB" class="wrap" style="z-index:2"><video id="vidB" class="clip" src="assets/clips/taskB.mp4" muted playsinline data-start="{B:.2f}" data-duration="{LB}" data-track-index="2"></video></div>
      <div id="wrapC" class="wrap" style="z-index:2"><video id="vidC" class="clip" src="assets/clips/taskC.mp4" muted playsinline data-start="{C:.2f}" data-duration="{LC}" data-track-index="2"></video></div>
{host("ovA","ovA",A,LA,5)}
{host("ovB","ovB",round(B,2),LB,5)}
{host("ovC","ovC",round(C,2),LC,5)}
{host("recap","recap",round(RC,2),LR,6)}

      <!-- Narration (Kokoro af_heart, local) -->
{chr(10).join(lines)}

      <!-- Music bed (FFmpeg-synthesised) and sparse CC sound effects (assets/sfx/CREDITS.md) -->
      <audio id="music" class="clip" src="assets/audio/music_bed.wav" data-start="0" data-duration="{END}" data-track-index="11" data-volume="2.2" data-fade-in="2" data-fade-out="4"></audio>
{chr(10).join(sl)}
    </div>
    <script>
      const tl = gsap.timeline({{ paused: true }});
      const zoom = (sel, at, scale, ox, oy, dur = 0.9) => tl.to(sel, {{ scale, transformOrigin: `${{ox}}px ${{oy}}px`, duration: dur, ease: "power2.inOut" }}, at);
      tl.set(["#wrapA", "#wrapB", "#wrapC"], {{ scale: 1, transformOrigin: "960px 540px" }}, 0);
      zoom("#wrapA", {A} + 27.1, 1.7, 1065, 900);
      zoom("#wrapB", {B:.2f} + 76.4, 1.6, 900, 840);
      tl.set("#wrapB", {{ scale: 1.5, transformOrigin: "650px 720px" }}, {B:.2f} + 96.66);
      tl.set("#wrapB", {{ scale: 1.6, transformOrigin: "900px 840px" }}, {B:.2f} + 103.66);
      tl.set("#wrapB", {{ scale: 1, transformOrigin: "960px 540px" }}, {B:.2f} + 113.41);
      zoom("#wrapC", {C:.2f} + 31.6, 1.8, 900, 840);
      [["#wrapA", {A}, {B:.2f}], ["#wrapB", {B:.2f}, {C:.2f}], ["#wrapC", {C:.2f}, {RC:.2f}]].forEach(([s, a, b]) => {{
        tl.fromTo(s, {{ opacity: 0 }}, {{ opacity: 1, duration: 0.35 }}, a);
        tl.to(s, {{ opacity: 0, duration: 0.3 }}, b - 0.3);
      }});
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
'''
open('index.html', 'w').write(html)
print("END", END, "last narration ends", round(prev[1], 2))
