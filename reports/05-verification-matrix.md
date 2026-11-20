# Competition-aligned verification matrix and self-assessment

## Final self-assessment (20 November 2026, submission build)

This is our own reading of the rubric's written anchors (`task.md` → Evaluation Criteria) against what the **final demo video** (`TRUEFORGE_FORGEATHON_DEMO.mp4`, 3:59) and the write-up show on screen. Judges score what the extension visibly does; where a capability is implemented but not shown, we score the anchor the video supports, not the code. Timestamps are positions in the final video, and each was checked against frames from it (see `video-production/JUDGING_EVIDENCE_MATRIX.md`).

| Criterion | Max | Anchor we believe applies | Self-score | Video | Evidence on screen | Gap / risk |
|---|---:|---|---:|---|---|---|
| A1 Inline edit | 10 | *diff rendered with per-hunk accept and reject* | **10** | 0:51–1:10 | Selection → ⌘⌥K → typed instruction → inline diff (2 hunks) → hunk unticked/re-ticked → Accept → `FLASK_DEBUG=off … → False` | Per-hunk choice is shown in the sidebar for Task A; the in-diff CodeLens appears in Task B (2:18) |
| A2 Agent mode | 10 | *discovers and edits three or more files unprompted* | **10** | 1:19–2:18, 2:56 | Request with no file names → `cli.py`, `test_cli.py`, `cli.rst` → `git status` shows exactly those 3 | The run needed a 4-model free-tier fallback chain and 3 recording takes |
| A3 Streaming and cancellation | 10 | *cancellation is immediate and the workspace stays consistent* | **10** | 1:43–2:16, 3:11–3:17, 3:28 | Tool calls and banners stream live; live Task B run, Stop pressed after 3 tool calls (3:12) → "Cancelled. No files were changed." within a second → `git status --short && git diff --exit-code` → "cancelled: nothing written" (3:15); the editor stays responsive during retries | The cancel is a separate take of the same Task B request (not the run that produced the diff), and is labelled as such in the evidence matrix |
| B1 Context assembly | 15 | *retrieval with a size budget, strategy stated, visibly at work in Task B (shows which files it chose and why)* | **15** | 0:18–0:27, 1:25–1:43 | RepoMap graph (call-site-verified edges) + BM25 → context card: 4 files, a reason each, 4.8k / 7k tokens; a labelled pause explains each step | `@file`/`@symbol` exist but are not exercised (Task B names no files) |
| B2 Diff safety | 10 | *per-hunk review and a working undo of an applied change, shown on screen* | **10** | 0:59, 2:18–3:02, 3:41–3:48 | Edits staged in memory; per-hunk review and CodeLens; nothing written before Accept; Undo → "undo: all files restored"; a rejected proposal leaves git clean | — |
| B3 Resilience | 10 | *automatic fallback to a second configured model with no user action, workspace unchanged* | **10** | 3:21–3:48 | `curl` → connection refused; retry after 2 s, then 4 s; "Fallback … Same TrueForge session continues"; `git status` empty; "workspace unchanged" | — |
| B4 TrueForge integration | 10 | *MCP tools + approval driving the review, plus a context-engineering feature explained in the write-up and visible in the session* | **10** | 0:11–0:45, 1:43–2:16, 2:23–2:30, 3:04 | 9 MCP tools; "Tool Approval Required for submit_for_review" → "The user accepted 4 hunk(s)"; **deferred tool loading** (`list_tools`, `get_tool_info`, `call_tool`) and **compaction** in the run log and session | Subagents, skills and Code Mode are not used |
| C1 Video | 10 | *all three complete, legible, and visibly verified on screen* | **10** | 0:45 · 1:19 · 3:17 | A → B → C in order; each followed by terminal verification; Task B session and a live cancel shown; 3:59 | Task B is shown at 5× (labelled, continuous from instruction to review) |
| C2 Write-up | 15 | *also carries an accurate scorecard with timestamps and an honest limitations section* | **15** | — | 3-page PDF, 8 required headings, scorecard with verified timestamps, limitations and "another month" | — |
| **Total** | **100** | | **100** | | | Every anchor is now shown on screen; the remaining risk is judges reading the anchors more strictly than we do (see the Gap column) |

**What changed for A3:** the earlier cut showed streaming but never pressed Stop, so we scored A3 at 4. The final video adds a 6 s live clip between Task B and Task C (3:11–3:17): Stop is pressed mid-run, the sidebar reports "Cancelled. No files were changed.", and `git status` / `git diff --exit-code` confirm the workspace is untouched. To make room, the Task C settings shot was sped from 1.6× to 1.8× and the recap trimmed by 0.3 s; total 3:59.1, still under 4:00.

**Verification state of the submission build:** live Task A, B and C through the extension on free models (cost $0); 21 offline unit tests and 8 VS Code extension-host tests; the `.vsix` installs and activates in a fresh VS Code profile (release v0.2.0).

---

## History

**v2 update — 20 November 2026:** The extension was rewritten (see [report 21](21-harness-v2.md)). Live on free models through TrueForge: Task A passed in 2 model calls (1.4 s); Task C showed both automatic same-session fallback and a clear error, with a clean worktree. Task B produced a correct implementation and docs across 3 files, but its new test failed (58/59) and the run stopped before verification. Suites: 15 offline unit tests and 7 VS Code extension-host tests passed. The rows below describe v1 and are kept for history.

**Recovery update — 19 November 2026:** A final-attempt passing Task B checkpoint can now resume only through fresh verification and approval. An integration test replayed the real saved candidate through the VS Code review, save and undo path in a disposable worktree. Final suites: 79 safety and 31 extension-host tests passed. The delayed buffer mismatch and a fresh live sidebar demonstration remain open; see [recovery report](20-task-b-recovery-and-readiness.md).


**Latest update — 19 November 2026:** Task B produced a verified three-file proposal, but extension application hit a review-buffer guard and the explicitly approved hunks were applied directly. Task C was tested with a real isolated TrueForge provider failure: the error surfaced and the disposable worktree remained clean. The updated safety suite passed 78 tests and the VS Code extension-host suite passed 31 tests. See [Task B evidence](18-task-b-repair-guidance.md) and [Task C resilience](19-task-c-resilience.md). Remaining demo and review-buffer issues prevent a production-ready claim.


**Earlier snapshot — 19 November 2026:** Task B remains PARTIAL: the agent staged three files and invoked isolated verification, but its candidate failed one new test three times and never reached review. Task A’s earlier live result remains valid; Task C still needs its official live demonstration. Current automated results are 73 safety and 31 VS Code host tests. See [the live reliability report](17-task-b-reliability.md).


Status meanings: `READY`, `PARTIAL`, `NOT IMPLEMENTED`, `BLOCKED`, `NOT TESTED`. These are implementation-readiness statuses, not hypothetical earned marks.

| Criterion | Max | Current status | Tested? | Evidence | Remaining live proof | Highest-scoring anchor to demonstrate |
|---|---:|---|---|---|---|---|
| A1 Inline edit | 10 | READY (verified previously) | Yes, live Task A | TrueForge produced a proposal, VS Code showed the diff, approval was explicit, and the official Flask CLI/helper checks passed. See [report 06](06-task-a-vertical-slice.md). | Repeat in the final host only if the demo setup changed. | Select `get_debug_flag`, review the generated patch, approve it and show the verifier result. |
| A2 Agent mode | 10 | PARTIAL | Headless implementation checks; no successful live Task B | TrueForge owns the agent, session and MCP tool loop; the extension connector supplies staging and isolated verification. Ranked multi-file retrieval and durable resume are implemented. | Produce an autonomous multi-file candidate, validate it and review it in VS Code. | Task B with no filenames in the request, at least three independently selected files and visible tool activity. |
| A3 Streaming and cancellation | 10 | PARTIAL | Live Task A streaming; local cancellation coverage | TrueForge streaming events, counters and SDK cancellation are implemented; provider retries/reconnects are bounded or disabled as reported. | Demonstrate cancellation during a live Task B turn and show its terminal state and clean worktree. | Start a turn, show streamed deltas, cancel, and confirm no source write. |
| B1 Context assembly | 15 | PARTIAL | Headless retrieval and context-cap checks | Ranked implementation/test/docs discovery, bounded symbol/range reads, selected-path reasons, paging and configurable context/output limits are implemented. | Confirm useful live retrieval; add user-facing `@file`/`@symbol` parsing if the competition rubric requires those controls. | Explain the selected context from live retrieval reasons and show the bounded tool responses. |
| B2 Diff safety | 10 | PARTIAL | Headless safety suite; Extension Host 25/25 on save-transaction build | Per-hunk diffs, stale-buffer checks, explicit approval, Save All, compensating rollback and recovery are implemented. The host suite predates checkpoint/router edits. | Review a real Task B proposal and demonstrate reject or approved save in the final host. | Review or reject a multi-file proposal, then verify Git status and official checks. |
| B3 Resilience | 10 | PARTIAL | Mocked routing/backoff and recovery checks | Bounded primary plus two fallback models, provider-family skip, one transient retry, context reduction, cancellation stops and no switching after review are covered locally. | Demonstrate a controlled live provider failure, fallback, cancellation and clean Git status. | Trigger a configured provider failure and show one bounded fallback through TrueForge. |
| B4 TrueForge integration depth | 10 | PARTIAL | Task A live; Task B harness/headless path checked | TrueForge agent/session/stream/MCP APIs are used; deferred tool loading is enabled and model routing stays within TrueForge. SDK 0.185.0; last recorded server 0.185.1. | Confirm deferred discovery, fallback and approvals in a live Task B session. | Show TrueForge agent/session events and MCP calls driving the editor diff. |
| C1 Video | 10 | NOT TESTED | No | No recording produced. | Record a concise proof of the required flows. | One repeatable demo covering A/B/C and resilience. |
| C2 Write-up | 15 | PARTIAL | Reports exist; final demo evidence pending | Architecture, implementation decisions, actual Task A metrics, Task B attempts, limits and reproduction steps are documented across the reports. | Add final live Task B/Task C results and demo evidence. | Give a reproducible account of outcomes, failures, costs and tradeoffs. |

## Current implementation status (19 November 2026)

The Task B harness adds ranked discovery, configurable context/output caps, durable private checkpoints with validated resume, a bounded primary-plus-two-fallback TrueForge router, deferred tool loading, isolated verification, per-hunk review, Save All rollback and an explicit recovery command. The headless safety suite passed 29/29. The VS Code Extension Host suite passed 25/25 on the save-transaction build; the full suite has not been rerun after later checkpoint/router changes. One subsequent live run found all three relevant files and exercised deferred discovery, then hit Groq's input quota before staging (3 completed responses, 7,262 input / 292 output tokens, no retries); see [report 11](11-task-b-live-run.md). There is **no verified autonomous Task B proposal, approved Task B patch or live Task C failover**. Routing still needs a live fallback demonstration; compaction is opt-in. See [the working-state checkpoint](08-working-state.md) and [readiness report](10-engineering-readiness.md).

## Completed Phase 0 evidence

- Environment audit written.
- Starter selected and scaffolded.
- TypeScript compile passes; the VS Code Extension Host logged 3/3 passing tests on both runs using installed VS Code 1.146.0. One run exited cleanly; a later repeat returned `SIGABRT` during teardown after the passing test output.
- TrueForge startup and non-model SDK connectivity pass.
- Flask 3.1.3 pinned and clean at the requested commit.
- Flask CLI baseline passes: 58/58.
- Task A scratch rehearsal passes verification and 58/58 CLI tests.
- Task B scratch rehearsal passes 60/60 CLI tests, help check, masked JSON check, and three-file diff requirement.
- Task C invalid endpoint probe returns a structured error; scratch status is unchanged.
- Reports and safe rerunnable scripts are present.

## Verified Task A slice (19 November 2026)

The configured TrueForge agent produced a reviewed and approved patch. The official CLI suite passed 58/58 and the combined helper and CLI suite passed 93/93. The extension safety and host suites passed 5/5 and 7/7. The full turn ledger, approval method and verification limits are in the [Task A research handoff](06-task-a-vertical-slice.md).

## Manual F5 check still useful

The automated VS Code Extension Host run passed activation and command-registration checks. To verify the interactive debugger and notification visually:

1. `code <repo>/extension`
2. In Run and Debug, choose **Run Extension** and press F5.
3. In the new host, open the Command Palette and run **Forge: Environment Status**.
4. Confirm a notification shows `Forge extension loaded`, the workspace, active file, and `trueforge=reachable` if TrueForge is running.
5. Stop the debug host; no repository files should be changed by the status command.

