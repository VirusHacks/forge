# Forge engineering readiness

**Updated:** 19 November 2026 (Asia/Kolkata)

This is an implementation-readiness report, not a claim that every competition flow has passed live integration.

## Competition readiness

| Area | Status | Evidence | Remaining live proof |
|---|---|---|---|
| Task A inline edit | **Verified previously** | Real TrueForge/Groq Task A run, VS Code diff, explicit approval, official CLI and helper tests; see [report 06](06-task-a-vertical-slice.md). | Repeat once in the final host if the demo environment changed. |
| Task B discovery and context | **Initial live discovery verified** | The 12:32 IST run independently selected implementation, test and docs with reasons using 366 estimated source tokens; see report 11. Retrieval and cap checks also pass locally. | Sustain retrieval through a complete live proposal and verification. |
| Task B patch and verification | **Implemented; live proof pending** | In-memory multi-file hunks; isolated official Flask verifier; bounded repair attempts; repeated failure guard. | Produce and verify the official `flask config` implementation in a disposable clean worktree. |
| Task B diff safety | **Locally verified** | VS Code Extension Host passed 25/25 on the save-transaction build. Per-hunk diffs, stale-buffer checks, one undoable edit, explicit approval, Save All, compensation and recovery journal. | Review a real agent proposal and demonstrate reject/undo and save. |
| Task C resilience | **Not ready** | Mocked error classification/backoff/fallback tests pass; bounded fallback models remain inside TrueForge; cancellation and no-review-switch rules are implemented. | Trigger a controlled provider failure and show fallback, cancellation, and clean Git status. |
| TrueForge integration depth | **Partially verified live** | Agent/session/stream/MCP and deferred tool discovery were observed in report 11. SDK 0.185.0; server 0.185.1. | Reach a verified Task B proposal and approval-driven diff; demonstrate fallback separately. |

## Provider and retry policy

- Set one primary and up to two fallback FQNs in TrueForge. Provider keys never go in extension settings or logs.
- Rate limit or invalid credentials: skip the entire configured provider family. This avoids futile OpenRouter `:free` alias rotation under shared account limits.
- Temporary 5xx/network: one fresh TrueForge attempt after bounded backoff; use Retry-After/reset headers when available, and switch provider if the wait exceeds 10 seconds.
- Context overflow: reduce the repository retrieval budget before switching models.
- Malformed model output: switch to another configured model once available.
- Tool/verification errors: stop and preserve staged state. Cancellation or a failure after review begins never starts another model.
- All retries and switches have finite bounds. SDK automatic retries and stream reconnection are disabled.

## Safety and recovery

- Task B requires the clean linked Flask worktree at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`; the pristine fixture is not a target.
- Proposed changes remain in MCP memory and private checkpoint storage until review. No shell tool can write the workspace.
- Each hunk's source anchor is unique and tracked; disk and editor versions are checked before applying.
- Save All is explicit. If one save fails, previous saves are restored only when disk bytes still match the proposed patch. Concurrent edits are preserved and cause a private recovery journal to remain.
- To recover from that journal, run `npm --prefix extension run task-b:recover -- <journal.json> <worktree-root> --rollback`. The command preflights all files and refuses conflicting content.
- Checkpoints are owner-only, local, and contain staged source text. Do not copy them into chats or shared folders.

## Context and TrueForge decisions

The model does not receive the repository concatenated into its prompt. It gets a ranked set of file reasons, then retrieves bounded line ranges as needed. MCP response size and total repository tokens have configurable caps. `get_run_state` returns a small page and supports paging for larger staged proposals. The private checkpoint stores the detailed state for a fresh session.

TrueForge deferred MCP loading is on by default, preloading only `investigate_repository` and `get_run_state`. Compaction is off by default based on the observed Groq output quota failure; it can be enabled at 4,400 estimated input tokens. Skills and large-response sandbox offloading are unavailable in the current safe sandbox-disabled agent. Dynamic subagents remain off; no current task benefits enough to justify their extra calls.

The extension offers a resume choice after interrupted staged work. A resume is permitted only for the same clean pinned revision and revalidates the saved hunk anchors. It never restores an approval or a verified draft digest.

## Reproducible checks

From the project root:

```sh
npm --prefix extension run test:safety
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm --prefix extension test
npm --prefix extension run trueforge:models
```

For the user's final live Task B run, configure models in TrueForge, create a clean linked worktree from `fixtures/flask-3.1.3`, set `FLASK_TASK_B_REPO`, `TRUEFORGE_MODEL`, optional comma-separated `TRUEFORGE_FALLBACK_MODELS`, and `VSCODE_EXECUTABLE`, then run:

```sh
npm --prefix extension run task-b:live
```

For a normal VS Code run, open the disposable worktree and invoke **Forge: Task B — Discover, Verify and Review**. The extension prompts if a resumable checkpoint exists. Run the official verifier after an approved save and confirm `git status --short`.

## Overall assessment

The extension has now had one live Task B run after the checkpoint/router changes: ranked file discovery and native deferred tool discovery worked, then Groq's input-token-per-minute quota stopped the run before staging. Three completed responses used 7,262 input and 292 output tokens; no retry or fallback occurred. See [report 11](11-task-b-live-run.md). Task B and Task C remain unproven as complete live flows. Task A has a documented live pass. The headless safety suite passed 29/29; the full VS Code host suite's 25/25 result is from the earlier save-transaction build. No Task B candidate, Task B final verification, or Task C failover has been observed.
