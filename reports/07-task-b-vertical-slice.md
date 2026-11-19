# TrueForge Task B vertical slice

**Latest update — 19 November 2026:** A later live TrueForge session staged five hunks in three files and ran the isolated verifier, but the candidate failed the same test on all three verification attempts. No human review or workspace write occurred. See [the detailed reliability report](17-task-b-reliability.md).


## Current result

The latest integrated run (19 November, 12:32 IST) found all three relevant files and exercised deferred tool discovery, then hit Groq's input-token-per-minute quota before staging edits. It completed three model responses using 7,262 input and 292 output tokens, with no retry or fallback. See [the complete run report](11-task-b-live-run.md). No autonomous Task B candidate or approved edit has been observed. The disposable pinned Flask worktree remains clean at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`.

## Architecture

The extension registers a saved TrueForge agent and a loopback MCP connector. The agent receives the exact official Task B instruction without file names. TrueForge chooses tools and runs the loop. The connector exposes repository search, tracked filename discovery, bounded reads, isolated candidate validation, and a human approval gate. The extension keeps proposals in memory and displays one VS Code diff per hunk.

Search uses ripgrep against tracked files. A configurable token budget limits excerpts. The context log records discovered files, match reasons, estimated tokens and each tool call. Native TrueForge compaction is currently disabled for the constrained Groq model: a measured compaction used 1,533 output tokens and the next request hit its rolling 1,000 output-token/minute limit. Bounded retrieval and staged edits are the current context controls.

The candidate validator copies the pinned tree into a private directory and runs the official CLI suite, help command and masked JSON checks with macOS sandbox-exec. The candidate Python code cannot write the user's files or reach the network during validation. A failed check returns a bounded summary for a maximum of two repairs. Review revalidates the chosen hunk subset before the extension applies a version-checked VS Code WorkspaceEdit. One explicit Save All decision commits all reviewed files to disk; a failed save triggers compensating rollback and a private recovery journal if a conflict remains.

## Baseline and safety evidence

Before Task B edits, the Task A suite passed 5/5 focused checks, 7/7 VS Code host checks, 58/58 official CLI tests and 93/93 combined helper/CLI tests. The current headless safety suite passes 29/29. The VS Code Extension Host passed 25/25 on the save-transaction build, before the latest checkpoint/provider-router changes. The unchanged pinned Flask checkout passed 58 CLI tests and then failed the new help check as expected.

The first live Task B session `01m7r0k1n6b8c42kd2bnkwk9tp` searched twice and read once before a model-generated `read_file` call failed schema validation. It reported three completed model messages, 3,039 input tokens, 137 output tokens and 81.357 seconds. The second session `01m7r16429cdbxddg26x3jb53a` searched twice and read three times before Qwen attempted an unavailable `search_directory` tool. It reported four completed model messages, 5,382 input tokens, 292 output tokens and 91.625 seconds. The third session `01m7r19zhj7w2pap1wn4tyw2dh` failed its first model response because its search arguments omitted `terms`. No candidate reached the verifier in those sessions, and the worktree remained clean. SDK retries were disabled.

The connector now accepts either a single search query or a term list, supports directory discovery, and accepts common bounded-read parameter names. Local MCP tests cover these shapes. Evidence logs are in `reports/evidence/task-b/`.

## Subsequent measured attempts

The following values are from saved TrueForge turns; rejected provider requests may have unreported token usage. SDK retries remained at zero. Each row is a fresh session and none reached a candidate or changed the worktree.

| Evidence file | Model | Completed messages | Input / output tokens | MCP calls | Terminal result |
|---|---|---:|---:|---|---|
| `1795029494489.jsonl` | Qwen | 7 | 22,349 / 603 | search 2, directory 1, read 5 | HTTP 429 after repeated read navigation |
| `1795029701993.jsonl` | Llama 70B | 1 | 0 / 0 | none | HTTP 404: configured model unavailable |
| `1795029716577.jsonl` | GPT-OSS 20B | 2 | 1,056 / 102 | search 1 | HTTP 400: unsupported `reasoning_content` replay |
| `1795029760802.jsonl` | Qwen | 3 | 11,982 / 226 | search 1, directory 4 | HTTP 429 after recursive directory discovery |
| `1795029889814.jsonl` | Qwen | 6 | 17,731 / 2,304 | search 3, directory 1, read 5 | HTTP 429 during manual range navigation |
| `1795030144691.jsonl` | Qwen | 2 | 11,003 / 222 | directory 5 | HTTP 429 during structural discovery |
| `1795030204519.jsonl` | Qwen | 7 | 20,529 / 487 | search 2, directory 3, read 4 | Rejected pathless `read_file` arguments |
| `1795030843055.jsonl` | Qwen | 4 | 9,730 / 1,169 | investigation 1, read 4 | Rejected pathless `read_file` after native compaction |

A generic ranked investigation MCP tool now selects the CLI implementation, CLI test, and CLI documentation from the exact task text in one call, using 366 estimated repository excerpt tokens. It does not embed Flask filenames or solution text. The first live turn using it independently selected `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`, then failed on a model-generated read without a path. The tool now accepts a pathless follow-up only after a successful read of a tracked file. Focused tests pass 15/15. This is an observed discovery improvement, not yet an end-to-end Task B success or a controlled cost comparison.

## Implementation-first handoff (19 November 2026)

After the measured attempts, one run with ranked investigation and symbol navigation (`1795031613913.jsonl`) reported five completed model messages, 13,435 input and 1,837 output tokens, one investigation and three reads. It reached the CLI registration region, then encountered the provider's rolling output quota after native compaction. It produced no candidate. A later interrupted run (`1795032057916.jsonl`) has no terminal metrics and is not counted as success. The pinned worktree and pristine fixture remain clean.

Earlier implementation note (superseded by the current checkpoint below): the extension staged one hunk per call and carried in-memory state across one fallback. Current model routing, durable resume and retry behavior are described below. **No live fallback model call or end-to-end Task B success has been observed.**

ECC was cloned into `/private/tmp/forge-ecc-reference` for inspection. Its concise Markdown handoff pattern informed `reports/08-working-state.md`; its separate runtime and stdio MCP bridge were not added to the Task B execution path. The model window is bounded through targeted retrieval and durable private staged state, not assumed to hold the entire repository or prior session transcript. An interrupted run can offer a validated resume from its private checkpoint; approvals are never resumed.

## Current implementation update (19 November 2026)

The local harness now has durable, owner-only checkpoints in VS Code extension storage after each MCP action. A resume choice is offered only for an incomplete staged run. Resumption verifies the root, pinned revision, tracked paths, unique anchors and staged hunk bounds; it never restores an approval and requires a fresh validation. The model-facing `get_run_state` is compact and paged, while the private checkpoint retains full staged hunks, task, selected-path reasons, validation history, error, model/session IDs and tool counts.

The fallback router accepts a primary plus two ordered TrueForge model names. It classifies 429, 5xx, network, model unavailable, invalid credentials, context overflow, malformed model output and tool/verification errors. It skips all configured models in a rate-limited or invalid-credential provider family, reads Retry-After/reset headers from the installed SDK's `TrueForgeError`, performs one bounded 5xx/network retry, shrinks repository retrieval on context overflow and never switches after cancellation or review begins. OpenRouter remains a configured provider behind TrueForge; no provider API is called directly. The SDK is version 0.185.0; the last recorded local server version was 0.185.1.

TrueForge deferred MCP loading is enabled by default and preloads only `investigate_repository` and `get_run_state`. Compaction is optional and off by default because a measured 4,400-token compaction emitted 1,533 output tokens before the provider output quota failed. Skills and large-result sandbox offloading remain disabled because the Task B agent sandbox is intentionally disabled. Search result count, read line count, tool response characters, total retrieved tokens, pacing and iteration count are configurable.

Approved multi-file saves now use one Save All choice. If a later save fails, earlier files are restored only while their bytes still match the approved proposal; the full proposal remains in dirty editor buffers. A mode-0600 journal is preserved if automatic restoration conflicts. The explicit `task-b:recover` command preflights every journal file and restores only original/proposed bytes, leaving the journal when any conflict prevents recovery.

Headless verification passed 29/29 checks, including real MCP contracts, checkpoint round-trip, context caps, mocked provider routing, recovery journal preflight and isolated Flask verifier behavior. The VS Code Extension Host suite passed 25/25 on the save-transaction build; the full suite has not been rerun after later checkpoint and routing changes. The subsequent single live run is recorded in [report 11](11-task-b-live-run.md). There is still no autonomous Task B candidate, accepted Task B patch or live Task C failover demonstration.

## Reproduction

Set `FLASK_TASK_B_REPO` to a fresh clean linked worktree of the pinned commit and `TRUEFORGE_MODEL` to a model configured in local TrueForge. Start the server with its loopback outbound allowlist, then run `npm --prefix extension run task-b:live` with the installed VS Code executable available. The launcher opens the editor review host and prints the hunk indices and digest when the agent requests approval. Explicitly approve a reviewed selection or reject it. The normal VS Code command is **Forge: Task B — Discover, Verify and Review**.
