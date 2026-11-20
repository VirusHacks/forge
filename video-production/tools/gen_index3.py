#!/usr/bin/env python3
"""v3 root composition: cold open, 'why' scene, tasks A/B/C, recap. Narration and effects are anchored
to recorded events through each clip's EDL, so nothing is placed by hand-typed offsets."""
import subprocess, sys
sys.path.insert(0, "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/video-production/tools")
import edl
def dur(p): return float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',p]).decode())
Aq, Bq, Cq = edl.load("taskA"), edl.load("taskB"), edl.load("taskC")
a = lambda r: edl.at(Aq, r); b = lambda r, h="take3": edl.at(Bq, r, h); c = lambda r: edl.at(Cq, r)
LA, LB, LC = Aq[-1]["edited_end"], Bq[-1]["edited_end"], Cq[-1]["edited_end"]
CO, LCO = 0.0, 10.8
W, LW = 10.8, 33.8
A = round(W + LW, 2); B = round(A + LA, 2); C = round(B + LB, 2); RC = round(C + LC, 2); LR = 9.0; END = round(RC + LR, 2)
narr = [("c0", CO + 0.25), ("r1", W + 0.3),
  ("a1", A + 0.3), ("a2", A + a(15.8) + 0.3), ("a2b", A + a(27.5) + 0.2), ("a3", A + a(38.0) - 0.5), ("a3b", A + a(52.6)),
  ("b1", B + 0.1), ("b2", B + 4.6), ("b3", B + 24.6), ("b4", B + b(181.4) + 0.1), ("b4b", B + b(226.0) + 0.2), ("b5", B + b(235.1) - 0.2),
  ("b6", B + b(248.0) - 1.15), ("b6b", B + b(373.5) - 0.6), ("b7", B + b(382.5)), ("b8", B + b(10.3, "secret") - 2.8),
  ("b9", B + b(397.5)), ("b10", B + b(1.0, "session") + 0.1),
  ("c1", C + 0.3), ("c2", C + c(31.3) + 0.2), ("c3a", C + c(46.6) - 4.0), ("c3b", C + c(56.0)), ("e1", RC + 0.3)]
sfx = [("hit", "impact-bass-1", 0.05, 0.4), ("cw1", "whoosh-short", 2.25, 0.16), ("cw2", "whoosh-short", 3.75, 0.16), ("cw3", "whoosh-short", 5.15, 0.16), ("cw4", "whoosh-short", 7.35, 0.16), ("logo", "sparkle", 9.4, 0.25),
  ("w2", "whoosh-short", A - 0.2, 0.3), ("w3", "whoosh-short", B - 0.2, 0.3), ("w4", "whoosh-short", C - 0.2, 0.3), ("w5", "whoosh-short", RC - 0.2, 0.3),
  ("c1", "click-soft", A + a(27.5), 0.5), ("c2", "click-soft", B + b(235.1), 0.5), ("c3", "click-soft", C + c(46.6), 0.5),
  ("k1", "chime", A + a(41.8), 0.22), ("k2", "chime", B + b(248.0), 0.22), ("k3", "chime", C + c(60.0), 0.22)]
lines, prev = [], (None, 0.0)
for n, st in sorted(narr, key=lambda x: x[1]):
    d = dur(f"assets/audio/v3/{n}.wav")
    if st < prev[1] - 1e-3: print("OVERLAP", prev[0], n, round(prev[1], 2), round(st, 2))
    prev = (n, st + d)
    lines.append(f'      <audio id="n-{n}" class="clip" src="assets/audio/v3/{n}.wav" data-start="{st:.2f}" data-duration="{d:.3f}" data-track-index="10" data-volume="1"></audio>')
sl = [f'      <audio id="sfx-{i}" class="clip" src="assets/sfx/{f}.mp3" data-start="{st:.2f}" data-duration="{dur(f"assets/sfx/{f}.mp3"):.3f}" data-track-index="12" data-volume="{v}"></audio>' for i, f, st, v in sfx]
def host(i, st, d, z, src=None): return f'      <div id="{i}" data-composition-id="{i}" data-composition-src="compositions/{src or i}.html" data-start="{st}" data-duration="{round(d, 2)}" data-track-index="{1 if z < 5 else 3}" data-track-kind="graphics" data-width="1920" data-height="1080" style="z-index:{z}"></div>'
seg = lambda q, h: [s for s in q if h in s["source"]][0]["edited_start"]
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
    <!-- Forge · Forge-a-thon demo, v3 (final). All footage is real VS Code capture (../CAPTURE_PLAN.md).
         Timeline (s): cold open 0–{LCO} · why {W}–{A} · Task A {A}–{B} · Task B {B}–{C} · Task C {C}–{RC} · recap {RC}–{END} -->
    <div id="root" data-composition-id="main" data-start="0" data-duration="{END}" data-width="1920" data-height="1080">
      <div id="bg"></div>
{host("coldopen", CO, LCO, 1)}
{host("arch", W, LW, 1)}
      <div id="wrapA" class="wrap" style="z-index:2"><video id="vidA" class="clip" src="assets/clips/taskA.mp4" muted playsinline data-start="{A}" data-duration="{LA:.3f}" data-track-index="2"></video></div>
      <div id="wrapB" class="wrap" style="z-index:2"><video id="vidB" class="clip" src="assets/clips/taskB.mp4" muted playsinline data-start="{B}" data-duration="{LB:.3f}" data-track-index="2"></video></div>
      <div id="wrapC" class="wrap" style="z-index:2"><video id="vidC" class="clip" src="assets/clips/taskC.mp4" muted playsinline data-start="{C}" data-duration="{LC:.3f}" data-track-index="2"></video></div>
{host("ovA", A, LA, 5)}
{host("ovB", B, LB, 5)}
{host("ovC", C, LC, 5)}
{host("recap", RC, LR, 6)}

      <!-- Narration (Kokoro af_heart, local; audio/v3) -->
{chr(10).join(lines)}

      <!-- Music bed (FFmpeg-synthesised) and sparse CC sound effects (assets/sfx/CREDITS.md) -->
      <audio id="music" class="clip" src="assets/audio/music_bed.wav" data-start="0" data-duration="{END}" data-track-index="11" data-volume="2.2" data-fade-in="1.5" data-fade-out="4"></audio>
{chr(10).join(sl)}
    </div>
    <script>
      const tl = gsap.timeline({{ paused: true }});
      const zoom = (sel, at, scale, ox, oy, dur = 0.6) => tl.to(sel, {{ scale, transformOrigin: `${{ox}}px ${{oy}}px`, duration: dur, ease: "power2.inOut" }}, at);
      tl.set(["#wrapA", "#wrapB", "#wrapC"], {{ scale: 1, y: 0, transformOrigin: "960px 540px" }}, 0);
      zoom("#wrapA", {A + a(34.5):.2f}, 1.7, 1065, 900);
      // Task B terminal shots: zoom is applied exactly at the cuts, never mid-shot
      tl.set("#wrapB", {{ scale: 1.6, transformOrigin: "900px 840px" }}, {B + b(244.6):.2f});
      tl.set("#wrapB", {{ scale: 1.5, transformOrigin: "650px 720px" }}, {B + seg(Bq, "secret"):.2f});
      // git status / Undo: normal size (no scaling); the window slides up so the git lines sit mid-frame
      tl.set("#wrapB", {{ scale: 1, y: -400, transformOrigin: "960px 540px" }}, {B + b(395.1):.2f});
      tl.set("#wrapB", {{ scale: 1, y: 0, transformOrigin: "960px 540px" }}, {B + seg(Bq, "session"):.2f});
      // final git check: normal size, slide up so the git lines sit mid-frame
      tl.to("#wrapC", {{ y: -300, duration: 0.6, ease: "power2.inOut" }}, {C + c(54.8) - 0.1:.2f});
      [["#wrapA", {A}, {B}], ["#wrapB", {B}, {C}], ["#wrapC", {C}, {RC}]].forEach(([s, x, y]) => {{
        tl.fromTo(s, {{ opacity: 0 }}, {{ opacity: 1, duration: 0.3 }}, x);
        tl.to(s, {{ opacity: 0, duration: 0.25 }}, y - 0.25);
      }});
      window.__timelines["main"] = tl;
      tl.seek(0);
    </script>
  </body>
</html>
'''
open("index.html", "w").write(html)
print("END", END, "A", A, "B", B, "C", C, "RC", RC, "last narration", prev)
