#!/usr/bin/env python3
"""Generate compositions/ovB.html: Task B callouts, the context-pack explainer (data from the real
context.pack event) and the tool-call ticker (one row per real event in the run log, timed to the footage)."""
import json, html
LOG = "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/scratch/vd/User/globalStorage/forge-a-thon.forge-a-thon-extension/runs/3e3fd083-0366-4ffe-b15d-1c91079f99e2.jsonl"
OUT = "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/video-production/composition/compositions/ovB.html"
ev = [json.loads(l) for l in open(LOG)]
t0 = ev[0]["t"]
pack = ev[0]
# Footage mapping: recording time = 13.85 + log time; run segment starts at raw 14.2 (local 24.278) at 5x.
RUN0, RAW0, SPEED, OFF = 24.278, 14.2, 5.0, 13.85
def local(tlog): return RUN0 + (OFF + tlog - RAW0) / SPEED
E = lambda s: html.escape(str(s))

rows = []
ends = {e["id"]: e for e in ev if e["type"] == "tool.end"}
for e in ev:
    tl = (e["t"] - t0) / 1000
    if e["type"] == "tool.start" and e["name"] != "submit_for_review":
        end = ends.get(e["id"], {}); summ = end.get("summary", "")
        name = e["name"]; title = e.get("title", name)
        if e["id"].startswith("tf-"): badge, cls = "TRUEFORGE", "tf"
        elif name == "stage_edits": badge, cls = "FORGE · STAGING", "stage"
        elif name == "run_command": badge, cls = "FORGE · SANDBOX", "sand"
        else: badge, cls = "FORGE · MCP", "mcp"
        title = title.replace("TrueForge ", "")
        rows.append((tl, badge, cls, title, summ))
    elif e["type"] == "model.switch":
        rows.append((tl, "FORGE · ROUTER", "router", f"quota: {e['from'].split('/')[-1]} → {e['to'].split('/')[-1]}", "automatic switch · same session"))
    elif e["type"] == "model.retry":
        rows.append((tl, "FORGE · ROUTER", "router", f"503 from {e['model'].split('/')[-1]} → retry in {e['delayMs']//1000} s", "backoff"))
    elif e["type"] == "compaction" and e["phase"] == "finished":
        rows.append((tl, "TRUEFORGE", "tf", "context compaction", "older turns summarised to stay in budget"))
rows.sort(key=lambda r: r[0])
H, VIEW = 40, 680
row_html, row_js = [], []
for i, (tl, badge, cls, title, summ) in enumerate(rows):
    res_cls = "bad" if ("✗" in summ or "failed" in summ) else ("good" if "✓" in summ else "")
    mm = f"{int(tl//60)}:{int(tl%60):02d}"
    row_html.append(f'<div id="tk-r{i}" class="tk-row" style="top:{i*H}px"><span class="tk-t">{mm}</span><span class="tk-b {cls}">{E(badge)}</span><span class="tk-x">{E(title[:58])}</span><span class="tk-s {res_cls}">{E(summ[:46])}</span></div>')
    t = round(local(tl), 3)
    row_js.append(f'[{i},{t}]')
files = pack["files"]
role = {"implementation": "IMPL", "test": "TEST", "docs": "DOCS"}
file_html = "".join(f'<div class="ex-file"><span class="ex-role">{role.get(f["role"], f["role"].upper())}</span><b>{E(f["path"])}</b><span class="ex-tok">{f["tokens"]/1000:.1f}k tok</span><div class="ex-why">{E(" · ".join(f["reasons"][:3]))}</div></div>' for f in files)
terms = [t for t in pack["terms"] if t not in ("built", "prints", "containing", "appear", "commands")][:10]
term_html = "".join(f'<span class="ex-term">{E(t)}</span>' for t in terms)
g = pack["graphInfo"]
callers = "".join(f'<div class="gn caller">{E(c["name"])}<small>{E(c["file"])}:{c["line"]}</small></div>' for c in g["callers"])
budget_html = ""
colors = ["#4c8dff", "#3fb950", "#e3b341", "#9b7bff"]
for f, c in zip(files, colors):
    w = f["tokens"] / pack["budget"] * 100
    budget_html += f'<div class="bseg" style="width:{w:.2f}%; background:{c}"><span>{E(f["path"].split("/")[-1])}</span></div>'

ovl = r'''<template>
  <style>
    #root { position: absolute; inset: 0; pointer-events: none; font-family: Inter, sans-serif; color: #e6edf3; }
    .ovb-chip { position: absolute; left: 1290px; top: 112px; padding: 14px 22px; border-radius: 14px; background: #0b0f16ee; border: 1.5px solid #9b7bff; font-size: 26px; font-weight: 700; }
    .ovb-chip span { display: block; font-size: 22px; font-weight: 400; color: #9da7b3; margin-top: 4px; font-family: "JetBrains Mono", monospace; }
    .ovb-box { position: absolute; border: 3px solid #3fb950; border-radius: 12px; box-shadow: 0 0 26px #3fb95066; }
    .ovb-tag { position: absolute; padding: 8px 14px; border-radius: 10px; font-size: 25px; font-weight: 700; color: #0b0f16; background: #3fb950; white-space: nowrap; }
    .blue { border-color: #4c8dff !important; box-shadow: 0 0 26px #4c8dff66 !important; } .tag-blue { background: #4c8dff; color: #fff; }
    .violet { border-color: #9b7bff !important; box-shadow: 0 0 26px #9b7bff66 !important; } .tag-violet { background: #9b7bff; color: #fff; }
    .amber { border-color: #e3b341 !important; box-shadow: 0 0 26px #e3b34166 !important; } .tag-amber { background: #e3b341; }
    /* explainer */
    #ex { position: absolute; left: 640px; top: 58px; width: 1262px; height: 970px; background: #0b0f16f2; border: 1.5px solid #2a3342; border-radius: 18px; }
    #ex-h { position: absolute; left: 34px; top: 22px; font-size: 32px; font-weight: 800; }
    #ex-h small { display: block; font-size: 20px; font-weight: 500; color: #8b949e; margin-top: 4px; }
    #ex-pause { position: absolute; right: 26px; top: 26px; padding: 6px 12px; border-radius: 8px; border: 1.5px solid #e3b341; color: #f2cc60; font-size: 19px; font-weight: 700; }
    .ex-step { position: absolute; left: 34px; width: 1194px; }
    .ex-n { display: inline-block; width: 34px; height: 34px; border-radius: 50%; background: #4c8dff; color: #fff; text-align: center; line-height: 34px; font-weight: 800; font-size: 20px; margin-right: 12px; }
    .ex-lab { font-size: 25px; font-weight: 700; }
    .ex-term { display: inline-block; font-family: "JetBrains Mono", monospace; font-size: 19px; padding: 5px 10px; border-radius: 8px; background: #151b25; border: 1px solid #2a3342; margin: 10px 8px 0 0; color: #9cc3ff; }
    .ex-file { font-size: 20px; padding: 8px 12px; margin-top: 8px; border-radius: 10px; background: #151b25; border: 1px solid #222b38; }
    .ex-file b { font-family: "JetBrains Mono", monospace; font-weight: 600; margin-left: 10px; }
    .ex-role { font-size: 15px; font-weight: 800; padding: 2px 7px; border-radius: 5px; border: 1px solid #8b949e; color: #c9d1d9; }
    .ex-tok { float: right; color: #8b949e; font-size: 18px; }
    .ex-why { font-size: 17px; color: #9da7b3; margin-top: 3px; }
    .gn { position: absolute; font-family: "JetBrains Mono", monospace; font-size: 17px; padding: 6px 10px; border-radius: 8px; background: #151b25; border: 1.5px solid #2a3342; white-space: nowrap; }
    .gn small { display: block; font-size: 13px; color: #8b949e; }
    .gn.focus { border-color: #4c8dff; background: #12233f; font-size: 21px; font-weight: 700; }
    .gn.test { border-color: #3fb950; color: #7ee787; }
    #ex-callers { position: absolute; left: 0; top: 46px; }
    #ex-callers .gn { position: relative; margin-bottom: 5px; font-size: 15px; padding: 4px 9px; }
    #ex-callers .gn small { font-size: 12px; }
    .bar { position: absolute; left: 0; top: 48px; width: 1180px; height: 46px; border-radius: 10px; background: #151b25; border: 1.5px solid #2a3342; overflow: hidden; display: flex; }
    .bseg { height: 100%; position: relative; }
    .bseg span { position: absolute; left: 8px; top: 11px; font-size: 16px; font-weight: 700; color: #0b0f16; white-space: nowrap; }
    /* ticker */
    #tk { position: absolute; left: 640px; top: 58px; width: 1262px; height: 970px; background: #0b0f16f2; border: 1.5px solid #2a3342; border-radius: 18px; overflow: hidden; }
    #tk-h { position: absolute; left: 30px; top: 18px; font-size: 28px; font-weight: 800; }
    #tk-h small { display: block; font-size: 19px; font-weight: 500; color: #8b949e; margin-top: 3px; }
    #tk-ff { position: absolute; right: 24px; top: 22px; padding: 6px 12px; border-radius: 8px; border: 1.5px solid #e3b341; color: #f2cc60; font-size: 20px; font-weight: 800; text-align: right; }
    #tk-ff small { display: block; font-size: 14px; color: #c9d1d9; font-weight: 500; }
    #tk-leg { position: absolute; left: 30px; top: 104px; font-size: 16px; }
    #tk-leg span { margin-right: 10px; }
    #tk-view { position: absolute; left: 20px; top: 150px; width: 1222px; height: ''' + str(VIEW) + r'''px; overflow: hidden; }
    #tk-rows { position: absolute; left: 0; top: 0; width: 100%; }
    .tk-row { position: absolute; left: 0; width: 100%; height: ''' + str(H - 4) + r'''px; display: flex; align-items: center; gap: 12px; font-size: 18px; border-bottom: 1px solid #1c2330; opacity: 0; }
    .tk-t { width: 46px; color: #6e7681; font-family: "JetBrains Mono", monospace; font-size: 15px; }
    .tk-b { width: 158px; flex: none; text-align: center; font-size: 13px; font-weight: 800; padding: 4px 0; border-radius: 6px; color: #0b0f16; }
    .tk-b.mcp { background: #4c8dff; color: #fff; } .tk-b.stage { background: #3fb950; } .tk-b.sand { background: #2ea043; color: #fff; }
    .tk-b.tf { background: #9b7bff; color: #fff; } .tk-b.router { background: #e3b341; }
    .tk-x { flex: 1; font-family: "JetBrains Mono", monospace; font-size: 18.5px; color: #e6edf3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tk-s { width: 420px; flex: none; font-size: 17.5px; color: #9da7b3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tk-s.bad { color: #ff7b72; font-weight: 700; } .tk-s.good { color: #7ee787; font-weight: 700; }
    #tk-foot { position: absolute; left: 30px; bottom: 18px; right: 30px; font-size: 18px; color: #9da7b3; }
  </style>
  <div id="root" data-composition-id="ovB" data-width="1920" data-height="1080">
    <div id="ovb-chip" class="ovb-chip clip" data-start="0.2" data-duration="4.2">TASK B · Agent mode<span>a regular request · no files named</span></div>
    <div id="ovb-req" class="clip" data-start="0.8" data-duration="3.6">
      <div class="ovb-box blue" style="left:76px; top:876px; width:526px; height:104px;"></div>
      <div class="ovb-tag tag-blue" style="left:620px; top:900px;">the exact Task B request · no file names</div>
    </div>

    <!-- Context-pack explainer (data from the run log's context.pack event) -->
    <div id="ex" class="clip" data-start="4.7" data-duration="19.5">
      <div id="ex-h">Inside the @@PACKMS@@ ms before the first model call<small>Forge's context pack, replayed from the run log · the real card is on the left</small></div>
      <div id="ex-pause">▌▌ footage paused to explain</div>
      <div id="ex1" class="ex-step" style="top:118px"><span class="ex-n">1</span><span class="ex-lab">Terms from the request</span> <span style="color:#8b949e;font-size:19px">(“test”, “documented” are read as intent, not search words)</span><div>@@TERMS@@</div></div>
      <div id="ex2" class="ex-step" style="top:236px"><span class="ex-n">2</span><span class="ex-lab">Rank files: BM25 matches, paths, module names</span>@@FILES@@<div style="font-size:18px;color:#8b949e;margin-top:6px">+ @@OMITTED@@ more candidates ranked but left out</div></div>
      <div id="ex3" class="ex-step" style="top:636px; height:220px"><span class="ex-n">3</span><span class="ex-lab">RepoMap code graph around the top symbol</span>
        <div id="ex-callers">@@CALLERS@@</div>
        <div class="gn focus" style="left:420px; top:110px">FlaskGroup<small>src/flask/cli.py:531</small></div>
        <div class="gn" style="left:720px; top:48px">AppGroup<small>calls → base class</small></div>
        <div class="gn test" style="left:720px; top:116px">tests/test_cli.py</div>
        <div class="gn test" style="left:720px; top:170px">tests/test_testing.py</div>
        <div style="position:absolute; left:960px; top:110px; width:230px; font-size:18px; color:#9da7b3">callers → focus → calls / tests<br/><b style="color:#7ee787">@@VERIFIED@@ edges verified at the call site</b></div>
      </div>
      <div id="ex4" class="ex-step" style="top:884px"><span class="ex-n">4</span><span class="ex-lab">Fit the budget: @@TOK@@ of @@BUDGET@@ tokens → TrueForge's first message</span><div class="bar">@@BUDGETBAR@@</div></div>
    </div>
    <div id="ovb-card" class="clip" data-start="11.9" data-duration="12.3">
      <div class="ovb-box blue" style="left:84px; top:150px; width:510px; height:324px;"></div>
      <div class="ovb-box blue" style="left:84px; top:484px; width:510px; height:210px;"></div>
    </div>

    <!-- Live tool-call ticker (each row = one event from the real run log, timed to the footage) -->
    <div id="tk" class="clip" data-start="24.3" data-duration="33.5">
      <div id="tk-h">Live run log · TrueForge loop + Forge's own architecture<small>every row is a real event from session 01m7tqmk… · @@NROWS@@ rows</small></div>
      <div id="tk-ff">▶▶ 5× speed<small>real time to review 2 min 49 s · no cuts</small></div>
      <div id="tk-leg"><span class="tk-b mcp" style="padding:3px 8px">FORGE · MCP</span>editor tools &nbsp;<span class="tk-b stage" style="padding:3px 8px">FORGE · STAGING</span>memory only &nbsp;<span class="tk-b sand" style="padding:3px 8px">FORGE · SANDBOX</span>tests in a copy &nbsp;<span class="tk-b router" style="padding:3px 8px">FORGE · ROUTER</span>fallback &nbsp;<span class="tk-b tf" style="padding:3px 8px">TRUEFORGE</span>harness</div>
      <div id="tk-view"><div id="tk-rows">@@ROWS@@</div></div>
      <div id="tk-foot">Model calls go through TrueForge only · Forge never calls a provider directly · 65 model calls · 3 automatic switches in one session</div>
    </div>

    <div id="ovb-diff" class="clip" data-start="59.3" data-duration="6.3">
      <div class="ovb-box amber" style="left:620px; top:50px; width:1010px; height:40px;"></div>
      <div class="ovb-tag tag-amber" style="left:640px; top:104px;">3 files discovered and edited: cli.py · test_cli.py · cli.rst</div>
    </div>
    <div id="ovb-appr" class="clip" data-start="65.9" data-duration="5.7">
      <div class="ovb-box violet" style="left:1136px; top:536px; width:740px; height:40px;"></div>
      <div class="ovb-box violet" style="left:1094px; top:824px; width:794px; height:44px;"></div>
      <div class="ovb-tag tag-violet" style="left:1100px; top:610px;">TrueForge: submit_for_review awaits approval</div>
      <div class="ovb-box amber" style="left:94px; top:798px; width:146px; height:42px;"></div>
      <div class="ovb-tag tag-amber" style="left:250px; top:752px;">Forge's review = that approval</div>
    </div>
    <div id="ovb-acc" class="clip" data-start="72.0" data-duration="3.8">
      <div class="ovb-tag" style="left:620px; top:120px;">Accept → 4 hunks applied in one edit, saved</div>
      <div class="ovb-box violet" style="left:1176px; top:448px; width:702px; height:126px;"></div>
      <div class="ovb-tag tag-violet" style="left:1180px; top:590px;">TrueForge tool response: "The user accepted 4 hunk(s)…"</div>
    </div>
    <div id="ovb-pytest" class="clip" data-start="81.4" data-duration="2.1">
      <div class="ovb-box" style="left:478px; top:832px; width:290px; height:34px;"></div>
      <div class="ovb-tag" style="left:790px; top:830px;">pytest tests/test_cli.py -q → 59 passed</div>
    </div>
    <div id="ovb-help" class="clip" data-start="88.5" data-duration="2.6">
      <div class="ovb-box" style="left:500px; top:964px; width:350px; height:34px;"></div>
      <div class="ovb-tag" style="left:870px; top:962px;">flask --help lists config</div>
    </div>
    <div id="ovb-mask" class="clip" data-start="92.8" data-duration="3.8">
      <div class="ovb-box" style="left:500px; top:938px; width:420px; height:110px;"></div>
      <div class="ovb-tag" style="left:940px; top:950px;">PASSWORD · TOKEN · KEY → "***" · PUBLIC_NAME kept</div>
    </div>
    <div id="ovb-secret" class="clip" data-start="101.7" data-duration="1.9">
      <div class="ovb-box" style="left:640px; top:713px; width:420px; height:54px;"></div>
      <div class="ovb-tag" style="left:1080px; top:718px;">SECRET_KEY → "***" (same output, scrolled up)</div>
    </div>
    <div id="ovb-git" class="clip" data-start="105.3" data-duration="5.6">
      <div class="ovb-box amber" style="left:630px; top:518px; width:330px; height:96px;"></div>
      <div class="ovb-tag tag-amber" style="left:640px; top:820px; font-size:30px;">git status: exactly the 3 files the agent changed</div>
    </div>
    <div id="ovb-undo" class="clip" data-start="111.4" data-duration="2.0">
      <div class="ovb-box" style="left:630px; top:562px; width:300px; height:30px;"></div>
      <div class="ovb-tag" style="left:640px; top:820px; font-size:30px;">Undo → all 3 files restored · git diff clean</div>
    </div>
    <div id="ovb-sess" class="clip" data-start="113.5" data-duration="6.4">
      <div class="ovb-box violet" style="left:736px; top:98px; width:1086px; height:36px;"></div>
      <div class="ovb-tag tag-violet" style="left:740px; top:146px;">the same TrueForge session, reviewed after the run</div>
    </div>
    <div id="ovb-s1" class="clip" data-start="114.6" data-duration="1.4"><div class="ovb-tag tag-violet" style="left:1250px; top:960px;">turn 1: request + Forge context pack</div></div>
    <div id="ovb-s2" class="clip" data-start="116.0" data-duration="2.4"><div class="ovb-tag tag-violet" style="left:1250px; top:960px;">tool calls per turn · list_tools</div></div>
    <div id="ovb-s4" class="clip" data-start="118.4" data-duration="1.5"><div class="ovb-tag tag-violet" style="left:1200px; top:960px;">submit_for_review · approval-gated</div></div>
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    const pop = (sel, at) => tl.fromTo(`${sel} > *`, { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.3, ease: "power2.out", stagger: 0.08 }, at);
    tl.fromTo("#ovb-chip", { opacity: 0, x: 30 }, { opacity: 1, x: 0, duration: 0.4, ease: "power3.out" }, 0.2);
    // explainer steps follow the narration
    tl.fromTo("#ex", { opacity: 0, x: 40 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, 4.7);
    [["#ex1", 9.6], ["#ex2", 11.9], ["#ex3", 13.3], ["#ex4", 19.0]].forEach(([s, t]) => tl.fromTo(s, { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, t));
    tl.fromTo("#ex1 .ex-term", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.25, stagger: 0.09 }, 9.8);
    tl.fromTo("#ex2 .ex-file", { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.3, stagger: 0.25 }, 12.1);
    tl.fromTo("#ex3 .gn", { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.3, stagger: 0.18 }, 13.6);
    tl.fromTo("#ex4 .bseg", { scaleX: 0, transformOrigin: "0% 50%" }, { scaleX: 1, duration: 0.45, stagger: 0.35, ease: "power2.out" }, 19.4);
    pop("#ovb-card", 11.9);
    tl.fromTo("#ovb-card > *:nth-child(2)", { opacity: 0 }, { opacity: 1, duration: 0.3 }, 13.3);
    // ticker: each row appears at its real (5x-scaled) time; the list scrolls like a log
    tl.fromTo("#tk", { opacity: 0 }, { opacity: 1, duration: 0.35 }, 24.3);
    const ROWT = [@@ROWJS@@];
    ROWT.forEach(([i, t]) => {
      tl.fromTo(`#tk-r${i}`, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.18, ease: "power2.out" }, t);
      tl.to("#tk-rows", { y: Math.min(0, @@VIEWH@@ - (i + 1) * @@ROWH@@), duration: 0.18, ease: "power1.out" }, t);
    });
    [["#ovb-req",0.8],["#ovb-diff",59.3],["#ovb-appr",65.9],["#ovb-acc",72.0],["#ovb-pytest",81.4],["#ovb-help",88.5],["#ovb-mask",92.8],["#ovb-secret",101.7],["#ovb-git",105.3],["#ovb-undo",111.4],["#ovb-sess",113.5],["#ovb-s1",114.6],["#ovb-s2",116.0],["#ovb-s4",118.4]].forEach(([s, t]) => pop(s, t));
    tl.to({}, { duration: 0.1 }, 119.8);
    window.__timelines["ovB"] = tl;
  </script>
</template>
'''
rep = {"PACKMS": str(pack["ms"]), "TERMS": term_html, "FILES": file_html, "OMITTED": str(pack["omitted"]), "CALLERS": callers,
       "VERIFIED": str(g["verifiedEdges"]), "TOK": f'{pack["tokens"]:,}', "BUDGET": f'{pack["budget"]:,}', "BUDGETBAR": budget_html,
       "NROWS": str(len(rows)), "ROWS": "".join(row_html), "ROWJS": ",".join(row_js), "VIEWH": str(VIEW), "ROWH": str(H)}
for k in rep: ovl = ovl.replace("@@" + k + "@@", rep[k])
# Pin every callout to a recorded event via the clip's EDL (no hand-typed times).
import re, sys
sys.path.insert(0, "/Users/dakshjain/Desktop/Hackathons/iit-true-forge/video-production/tools")
import edl
Bs = edl.load("taskB")
T = lambda raw: edl.at(Bs, raw, "take3")
SEG = {s["rec_start"]: s for s in Bs}
end_of = lambda rs: SEG[rs]["edited_end"]
times = {
  "ovb-diff": (T(202.7) + 0.1, end_of(202.7) - T(202.7) - 0.2),
  "ovb-appr": (T(226.0) + 0.2, end_of(226.0) - T(226.0) - 0.3),
  "ovb-acc": (T(235.1), end_of(234.9) - T(235.1)),
  "ovb-pytest": (T(248.0) + 0.1, end_of(244.6) - T(248.0) - 0.1),
  "ovb-help": (T(382.5) + 0.1, end_of(378.7) - T(382.5) - 0.1),
  "ovb-mask": (T(389.5) + 0.1, end_of(387.3) - T(389.5) - 0.1),
  "ovb-secret": (edl.at(Bs, 10.3, "secret") + 0.1, [x for x in Bs if "secret" in x["source"]][0]["edited_end"] - edl.at(Bs, 10.3, "secret") - 0.1),
  "ovb-git": (T(397.5) + 0.1, T(406.5) - T(397.5) - 0.2),
  "ovb-undo": (T(406.5), end_of(395.1) - T(406.5)),
}
sess0 = [x for x in Bs if "session" in x["source"]][0]
S = lambda raw: edl.at(Bs, raw, "session")
times.update({"ovb-sess": (S(1.0) + 0.1, sess0["edited_end"] - S(1.0) - 0.1), "ovb-s1": (S(6.0), S(9.2) - S(6.0)), "ovb-s2": (S(9.2), S(16.6) - S(9.2)), "ovb-s4": (S(16.6), sess0["edited_end"] - S(16.6) - 0.05)})
for k, (st, d) in times.items():
    ovl, n = re.subn(rf'id="{k}" class="clip" data-start="[\d.]+" data-duration="[\d.]+"', f'id="{k}" class="clip" data-start="{st:.2f}" data-duration="{max(0.8, d):.2f}"', ovl)
    assert n == 1, k
    ovl, n = re.subn(rf'\["#{k}",[\d.]+\]', f'["#{k}",{st:.2f}]', ovl)
    assert n == 1, k
total = Bs[-1]["edited_end"]
ovl = re.sub(r'tl.to\(\{\}, \{ duration: 0.1 \}, [\d.]+\);\n    window.__timelines\["ovB"\]', f'tl.to({{}}, {{ duration: 0.1 }}, {total - 0.1:.2f});\n    window.__timelines["ovB"]', ovl)
open(OUT, "w").write(ovl)
print({k: (round(v[0], 2), round(v[1], 2)) for k, v in times.items()})
print("rows", len(rows), "first", row_js[0], "last", row_js[-1])
