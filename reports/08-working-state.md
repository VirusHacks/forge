# TrueForge Task B working state

**Latest update — 19 November 2026:** A real TrueForge run staged a three-file Task B proposal, but three isolated verifications failed the same new test; no review or write occurred. The final safety suite passed 73 tests and the VS Code host suite passed 31. The old 24-iteration default is now TrueForge’s supported maximum of 1,024. See [the current reliability report](17-task-b-reliability.md) for actual model usage, failures, checkpoints and limitations.


Updated 19 November 2026 (India time), implementation-first checkpoint. This is the continuation checkpoint for Phase 2. The Task A result is recorded in `reports/06-task-a-vertical-slice.md` and remains the baseline.

## Current status

Task B tooling is implemented, but **a successful autonomous Task B proposal has not yet been observed**. The ranked live run `1795030843055.jsonl` selected the expected implementation, test, and docs files in one MCP call, then failed when Qwen omitted the required `path` in a later read. Its saved turn recorded 4 completed model messages, 9,730 input / 1,169 output tokens, one investigation and four reads, and one native compaction. A pathless follow-up read now resolves only to the last successfully read tracked file; the focused suite passes 15/15. A subsequent run failed on its first response because Qwen called the hyphenated `investigate-repository` name; that exact alias is now registered and covered by the focused MCP suite. The run `1795031069253.jsonl` selected the expected files but Qwen repeated top-of-file reads and then hit HTTP 429 (18,886 input / 456 output tokens). The retriever now includes generic symbol navigation, and repeated top-of-file reads jump to the highest ranked related symbol; this selected the CLI command registration section at line 594 in a measured local check. Empty follow-up reads continue from the last delivered line, and a pathless first read after investigation defaults to its top ranked tracked implementation file. MCP error responses now obey the same pacing as successful responses. The run `1795031613913.jsonl` reached the CLI registration code, but native compaction generated 1,533 output tokens and the next request was rejected by Groq's 1,000 output-token/minute limit. Its saved turn recorded 5 model messages, 13,435 input / 1,837 output tokens, one investigation and three reads. No candidate was reached. The agent now has `maxTokens: 800`, native compaction disabled for this constrained model, and a `stage_edit` MCP tool for one hunk at a time. `validate_edits` assembles the staged candidate, blocks an unchanged failed candidate, and permits a bounded one-hunk repair. This is a measured compatibility adjustment, not a successful Task B run.

The disposable target is `~/.codex/worktrees/flask-task-b-agent/flask-3.1.3` at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Its source and index were clean at the last check. The project workspace is `<repo>`.

## Working implementation

- `extension/src/taskBRun.ts` creates a real TrueForge agent, session and streamed turn with the exact official Task B request. TrueForge owns tool selection and the loop. The agent's MCP connector requires approval for `submit_review`.
- `extension/src/taskBContext.ts` enforces a clean pinned linked worktree, tracked regular text files, lexical search, structural directory listing, bounded and paginated reads, a context budget, and logged selection reasons. Its new `investigate_repository` method ranks one implementation, test, and documentation file from the request text without Flask-specific paths. On the official Task B text it selected `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst` with 366 estimated excerpt tokens.
- `extension/src/taskBTools.ts` exposes `investigate_repository`, `search_repository`, `search_directory`, `read_file`, `stage_edit`, `validate_edits`, and `submit_review`. Candidate hunks remain in memory, require observed exact anchors across at least three files, and have a three-attempt verification limit. Unchanged failed candidates are rejected before another verifier run; individual hunks can be replaced before revalidation.
- `extension/src/taskBValidate.ts` and `scripts/task-b-check.py` copy the pinned Git tree into an isolated macOS sandbox and run `pytest tests/test_cli.py -q`, `flask --help`, and JSON/redaction checks for app factory and instance loading. Failure excerpts are bounded. The user's worktree is not used for execution.
- `extension/src/taskBReview.ts` opens one VS Code diff per hunk, accepts selected indices, revalidates the selection, checks disk and document versions, and applies an undoable WorkspaceEdit after explicit approval. One explicit Save All choice commits all approved files; a later-file failure triggers compensating rollback and private recovery journaling if needed.
- `extension/scripts/task-b-live.mjs` is the live host launcher. `extension/scripts/task-b-trace.mjs` reads saved TrueForge turn events.
- Last focused safety suite: 15/15 passed, including a generic code/test/docs ranking fixture and staged three-file repair. Installed VS Code host suite: the earlier 24/24 run was superseded by the 25/25 save-transaction run recorded below. The unchanged Flask baseline: 58/58 CLI tests passed, with the Task B command absent as expected.

## Observed failures and limits

- Early Qwen sessions failed on tool argument shapes; the MCP schemas now accept the observed variants and local tests pass.
- Qwen repeated identical reads and recursively walked `tests/`; the reader now pages repeats, jumps to ranked related symbols when repeating a top-of-file request, and continues empty requests from the last read. The directory tool lists immediate children. These changes have focused tests.
- Multiple exploratory sessions hit Groq HTTP 429. One stopped turn continued server-side after its VS Code host exited; the live launcher now sends `sessions.cancel` before killing the host. One saved turn reported 17,731 input and 2,304 output tokens across six completed model messages before HTTP 429. The limit was 7,000 input tokens/minute. Current pacing is 65 seconds for successful and failed tool responses; its effect is not yet measured.
- The configured Llama model returned HTTP 404. GPT-OSS 20B returned HTTP 400 on an unsupported `reasoning_content` field after one tool response. Neither is a working fallback yet.
- There is no verified Task B candidate, diff, repair cycle, approval, or applied edit. Multi-file disk saves now use compensating rollback; if a conflicting disk edit prevents rollback, the private journal and `task-b:recover` command preserve a manual recovery path.
- Native TrueForge compaction was evaluated with a 4,400 input-token trigger. One run compacted, then its next request exceeded Groq's 1,000 output-token/minute limit after the compaction emitted 1,533 tokens. Compaction is disabled for this model; the retriever and staged edits now bound context. This result does not support claiming compaction improved Task B. Deferred tools and subagents are not in use; add them only on measured benefit. TrueForge skills and large-result offloading need a TrueForge sandbox, which this agent does not enable.

## Current implementation checkpoint

The VS Code extension writes private checkpoints after each MCP action and offers an explicit resume choice after an interrupted staged run. Restored state is checked against the same clean pinned root and file anchors; approvals are never restored, and the candidate must pass validation again. The model-facing `get_run_state` is concise and paged; the storage checkpoint retains full edits, task, selected-path reasons, validation attempts/results, errors, active model/session and tool counts.

The model router accepts a primary plus two ordered fallbacks. It reads Retry-After/reset headers from TrueForge SDK errors, retries a transient server/network failure once with bounded jitter, skips a rate-limited or invalid-credential provider family, reduces retrieval on context overflow and switches to a different configured model after malformed model output. Tool or validation errors, cancellation, and errors after review begins do not switch. All API traffic remains inside TrueForge; OpenRouter model IDs are read from TrueForge configuration. The terminal launcher retains its concise run-state file.

TrueForge SDK 0.185.0 API types confirm deferred MCP loading and compaction settings. Deferred loading is enabled for discovery and state tools; context compaction stays opt-in due the observed output-quota failure. Skills and large-result offloading need the sandbox, which remains disabled. The smaller deterministic MCP tools therefore enforce configurable path count, line count, response characters and total token budget.

Multi-file Save All now uses a compensating rollback and an explicit recovery CLI. Tests cover later-file save failure, rollback, conflict-safe journal recovery and all-or-nothing preflight. ECC's MIT-licensed repository remains in `/private/tmp/forge-ecc-reference` for reference; no source files were copied into the project. Superpowers workflow ideas were applied without importing its orchestration. No OpenCode loop or code was copied; its broader model switching did not fit TrueForge's owner-controlled session API. TrueForge remains the only agent/tool loop.

Current checks: headless safety suite 29/29. VS Code host suite 25/25 on the save-transaction build, before the most recent checkpoint/router edits. Flask fixtures and the disposable Task B target remain unchanged and clean. Task A's live pass remains documented in report 06. One subsequent Task B live attempt found the three relevant files and exercised deferred tool discovery, then stopped at Groq's input quota before staging edits (3 completed responses, 7,262 input / 292 output tokens, no retries). See [report 11](11-task-b-live-run.md). Task B completion and live Task C fallback remain unverified.

## Next actions

1. After configuring OpenRouter in TrueForge, run the integrated flow once with a primary and up to two fallback models and capture the ranked investigation tool. Record whether it reduces navigation calls and reaches a candidate. Capture actual session metrics, tool calls, discovered files, validation result and context use.
2. If it produces a validated proposal, inspect all hunks and verifier output, then request explicit Task B approval. Never infer approval from Task A. Apply only the approved selection and rerun official checks.
3. If it fails, fix the specific blocker and test that change locally before another model run. Prefer improving model/tool compatibility over repeated unchanged sessions.
4. If source changes are made after this checkpoint, rerun targeted headless tests; reserve another Extension Host run for changes to editor transaction behavior.

## Exact verification commands

From the project root:

```sh
npm --prefix extension run test:safety
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm --prefix extension test
TRUEFORGE_MODEL='<configured-primary>' TRUEFORGE_FALLBACK_MODELS='<fallback-1>,<fallback-2>' FLASK_TASK_B_REPO='~/.codex/worktrees/flask-task-b-agent/flask-3.1.3' VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' FORGE_PACE_MS=65000 FORGE_CONTEXT_BUDGET=3000 npm --prefix extension run task-b:live
node extension/scripts/task-b-trace.mjs SESSION_ID
```

From the disposable Flask worktree after an approved disk save:

```sh
git diff --check
pytest tests/test_cli.py -q
flask --help
```

For the factory/instance and redaction probes, use the isolated `scripts/task-b-check.py` via the extension's `validateTaskB` path; it supplies trusted test apps and masks secrets without writing into the worktree. Check `git -C <repo>/fixtures/flask-3.1.3 status --porcelain` for the pristine fixture.

## Sprint checkpoint — 19 November 2026

Task B now selectively preloads seven core tools, bounds estimated complete request size separately from patch output, stores compact source evidence, and tracks provider cooldowns. Task A has bounded automatic TrueForge fallback and cancellation handling for Task C. `test:safety` passed 46/46; the VS Code Extension Host passed 25/25. There was no live model call in this sprint. The requested detailed status, measured schema tradeoff, limitations and final test commands are in [report 12](12-task-b-c-readiness.md).
