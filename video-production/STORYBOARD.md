# Storyboard (v3 · final, 3:54.1)

v3 adds a cold open, a "why we built it this way" scene (graph engineering, our nine MCP tools, measured impact), and a clean cut into the Task B terminal (no stale output, no mid-shot zoom). It also tightens the silent stretches. Total silence dropped from 69 s to under 35 s; what remains is reading time on verification output. Earlier cuts are kept as `…_v1.mp4`, `…_v2.mp4` and `…_v3.mp4`.

**Final polish:**
- The cold open and both git checks show the window at **normal size, with no zoom**. That means no upscaling, so the pixels stay sharp.
- In the git checks the full-size window slides up so the git lines sit mid-frame, with the caption below.
- Green outline boxes point at the evidence in each opening shot.
- Timestamps are unchanged, so JUDGING_EVIDENCE_MATRIX.md still applies.

| Time | Section | Picture | What it proves |
|---|---|---|---|
| 0:00–0:11 | Cold open | Five real shots with kinetic captions, then the logo:<br>1. "One sentence. No files named." (the request)<br>2. "3 files changed" (diff tabs)<br>3. "59 tests passing"<br>4. "Model fails → automatic fallback"<br>5. "Nothing written until you approve" (git clean) | Impact up front, all real footage |
| 0:11–0:45 | Why it's built this way | TrueForge runs the loop ↔ any model. Forge's side:<br>• the editor card<br>• **graph engineering:** a RepoMap graph of callers → FlaskGroup → AppGroup/tests; edges turn green as "verified at call site"; budget bar 4.8k / 7k<br>• **nine MCP tools we built:** search/read, graph lookup, staging, sandbox, approval-gated submit, each highlighted as named<br>• **measured impact:** 85 → ~25 model calls, 1.22M → ~0.39M tokens | B1/B4 design decisions and their effect |
| 0:45–1:19 | **Task A** | Real-time submit → diff; per-hunk untick/re-tick; Accept; terminal zoom | `False` (1:09.8); the case table (1:14.4) |
| 1:19–3:11 | **Task B** | Request → "Assembling context…" → labelled pause explaining the pack → 5× run with the live run-log ticker → review → live TrueForge approval → Accept → TrueForge response → clean cut to the zoomed terminal → verification → the session page | 59 passed; `config` in help; masked JSON incl. SECRET_KEY; git shows 3 files; Undo; session |
| 3:11–3:45 | **Task C** | Fallback setting; `curl` refused; repeat Task A; retries after 2 s and 4 s; automatic fallback; diff; Reject | `git status` empty; "workspace unchanged" |
| 3:45–3:54 | Recap | Five rows | — |

All callouts and narration lines are anchored to recorded events through the clips' EDLs:
- `tools/gen_index3.py`, `tools/gen_ovB.py`, `tools/pin_ac.py`
- `tools/edl.py` (the recording-time → edited-time mapper)

## The ticker is not a mock-up

`tools/gen_ovB.py` reads the extension's own JSONL run log for session `01m7tqmk7v34q3b1fzwp0wzxf6`. Every row is a `tool.start` (with its `tool.end` result), `model.switch`, `model.retry` or `compaction` event. The log's clock is aligned to the recording (recording time = 13.85 s + log time; checked against the first fallback banner and the context card), then scaled by the same 5× as the footage.

Badges:

| Badge | Meaning |
|---|---|
| FORGE · MCP | Forge's MCP tools |
| FORGE · STAGING | `stage_edits`: edits held in memory |
| FORGE · SANDBOX | `run_command` / auto-verify in a disposable copy |
| FORGE · ROUTER | retries and model switches |
| TRUEFORGE | the harness's own tools (`list_tools`, `get_tool_info`, `call_tool`) and compaction |

## Speed changes (`composition/assets/clips/*.edl.json`)

| Task | Changes |
|---|---|
| A | Select/keybinding at 1.3×; typing at 2.2×; the submit → diff → accept stretch at 1×; scrolling and terminal at 4×; command typing at 2–3×; output at 1× |
| B | Typing at 2.3×. Submit → card at 0.5×. A **17 s labelled freeze** on the card. The run at **5×**, one continuous segment, from instruction to review. Review diffs at 3×; TrueForge approval at 1.6×; Accept at 0.8×; a cut into the zoomed terminal after `clear`; terminal at 1.2–2.2×; scrollback at 1.75×; the post-run session page at 3.1× |
| C | Configuration at 1.6×; typing at 4×; submit → retries → fallback → diff and the reject at 1×; typing the git commands at 1.6–4×; outputs at 1× |
