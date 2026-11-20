# Judging evidence matrix (v3 · final)

**File:** `final/TRUEFORGE_FORGEATHON_DEMO.mp4`, v3, 3:54.1. Every timestamp is computed from the clips' EDLs (recording time → edited time) and checked against frames from this file. The earlier cuts (`…_v1.mp4`, `…_v2.mp4`) have different timestamps.

## Scorecard (for write-up §6)

| Criterion | Timestamp | One-line claim |
|---|---|---|
| A1 Inline edit | 0:51.8–1:05.2 | Selection + ⌘⌥K + plain instruction → diff in the editor about 2 s later → per-hunk untick/re-tick → Accept |
| A2 Agent mode | 1:19, 2:18.0, 2:56.2 | A request with no file names → the agent edits `cli.py`, `test_cli.py`, `cli.rst`; `git status` shows exactly those three |
| A3 Streaming & cancellation | 1:43.1–2:16.5, 3:22.9–3:29.0 | Tool calls stream in one by one (sidebar plus run-log ticker); the editor stays usable during retries; Stop/Cancel visible. A live cancel is **not** shown |
| B1 Context assembly | 0:18–0:27, 1:25.3–1:43.1 | RepoMap code graph (call-site-verified edges) + BM25 → a budgeted context pack before the first model call: 4 files, a reason each, 4,777 / 7,000 tokens |
| B2 Diff safety | 0:58.9, 2:18.0, 2:58.1–3:01.8, 3:36.1–3:43.0 | Edits staged in memory; per-hunk review and CodeLens; nothing written before Accept; Undo restores 3 files; a rejected proposal leaves git clean |
| B3 Resilience | 3:22.9–3:43.0 | Unreachable model → backoff 2 s, then 4 s → automatic fallback in the same session → `git status` empty, "workspace unchanged". Task B also switches 3 times (1:47.9, 1:58.3, 2:03.6) |
| B4 TrueForge integration | 0:11–0:45, 1:43.1–2:16.5, 2:22.8–2:30.3, 3:04.3 | TrueForge runs the loop; its `list_tools`/`get_tool_info`/`call_tool` (deferred loading) and compaction appear in the ticker; "Tool Approval Required for submit_for_review" → "The user accepted 4 hunk(s)"; session turns and tool calls |
| C1 Video | 0:45 / 1:19 / 3:11 | A, B, C in order, each followed by terminal verification (1:09.8; 2:34.6–3:01.8; 3:39.9–3:43.0) |

## Detail

| Criterion | What is shown (timestamps) | Visibly verified | Implementation | Limitation |
|---|---|---|---|---|
| **A1** | Submit 0:51.8 → diff 0:53.9 (2 hunks) → untick ("Accept 1 of 2") 0:58.9 → Accept 1:03.5 → "Applied… (saved)" 1:05.2 | `FLASK_DEBUG=off … → False` 1:09.8; OFF/Off/n/N/no → False, 1/true → True 1:14.4 | `src/extension.ts` `inlineEdit()`, `src/inline/inlineEdit.ts`, `src/review/reviewController.ts` | — |
| **A2** | Request with no file names 1:19; submit 1:23.3; run 1:43.1–2:16.5 (5×, continuous); diff tabs for the 3 files 2:18.0 | `git status --short` → 3 files 2:56.2 | `src/agent/agentRun.ts`, `src/agent/tools.ts` | 5× speed, labelled; 2 min 49 s real |
| **A3** | Rows and banners stream in 1:43.1–2:16.5; editor scrolled during retries 3:22.9–3:29.0; Cancel/Stop visible | Live events | `src/core/session.ts` | **No live cancel clip**; covered by the extension-host test |
| **B1** | Graph-engineering panel 0:18–0:27 (callers → FlaskGroup → AppGroup/tests, edges verified, budget bar); "Assembling context…" → card 1:25.3; labelled pause 1:26.1–1:43.1: terms → ranked files with reasons → RepoMap graph → 4,777 / 7,000 | All numbers are on the real card (left side of frame) | `src/agent/retrieval.ts`, `src/repoMap.ts`, `src/core/profiles.ts` | `@file`/`@symbol` not used (task names no files) |
| **B2** | Untick 0:58.9; ticker STAGING rows refuse inexact anchors ("1/3 staged, 2 failed"); diff + CodeLens 2:18.0; Accept 2:28.6; Undo 2:58.1 | "undo: all files restored" 3:01.8; Task C Reject 3:36.1 → git clean 3:43.0 | `src/review/reviewController.ts`, `src/agent/staging.ts` | — |
| **B3** | `curl` refused 3:16.1; submit 3:20.8; retry 2 s 3:22.9; retry 4 s 3:25.0; fallback + toast 3:29.0; diff 3:29.5; Reject 3:36.1 | `git status --short` empty 3:39.9; "workspace unchanged" 3:43.0 | `src/core/router.ts`, `src/core/session.ts` | — |
| **B4** | "Why" scene 0:11–0:45 (TrueForge loop vs Forge's graph and 9 MCP tools; measured 85 → ~25 model calls); ticker: `list_tools` 1:52.0, sandbox `✗ 4 failed` 1:58.8, `✗ 1 failed` 2:02.3, `✓ 59 passed` 2:10.7; approval 2:22.8; response 2:30.3; session page 3:04.3–3:11 | Session `01m7tqmk7v34q3b1fzwp0wzxf6` matches the sidebar link | `src/core/session.ts`, `src/core/trueforge.ts`, `buildAgentSpec()` | Subagents, skills and Code Mode not used |
| **C1** | A 0:45–1:19 → B 1:19–3:11 → C 3:11–3:45 | Terminal verification after each | — | Speed changes in STORYBOARD.md |

## Authenticity notes

- **Cold open (0:00–0:11).** Real footage from the same recordings: the request, three diff tabs, `59 passed`, the fallback banner, git clean.
- **Measured impact (85 → ~25 model calls, 1.22M → ~0.39M input tokens).** From `reports/21-harness-v2.md` (v1 vs v2, three-file Task B proposal on free models).
- **The labelled pause and the ticker** are visualisations of the run's own JSONL event log (`tools/gen_ovB.py`).
- **Two Task B shots were captured after the run and are labelled on screen:**
  - 2:52.8: the scrollback showing `SECRET_KEY`.
  - 3:04.3: the session page.
