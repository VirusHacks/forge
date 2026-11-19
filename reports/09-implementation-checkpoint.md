# Forge implementation checkpoint

**Updated:** 19 November 2026 (Asia/Kolkata)  
**Workspace:** `/Users/dakshjain/Desktop/Hackathons/iit-true-forge`  
**Pinned Flask revision:** `22d924701a6ae2e4cd01e9a15bbaf3946094af65`

## Objective and constraints

Build on the existing TrueForge-powered VS Code extension. TrueForge remains the sole agent and tool loop; provider credentials stay in TrueForge. Keep the pristine Flask fixture untouched, stage proposals before review, and leave final live integration to the user.

## Current architecture

- **TrueForge boundary:** the extension uses the installed `@truefoundry/trueforge-sdk` 0.185.0 for configured-model discovery, MCP registration, agent creation, sessions, streamed events, turn cancellation and approvals. Task A's 19 November handoff records local TrueForge server 0.185.1. No extension code calls Groq, OpenRouter or another provider endpoint.
- **Repository retrieval:** `RepositoryContext` uses tracked-file validation, ripgrep, ranked implementation/test/docs discovery, symbol/line reads and a configurable token budget. Tool output reports why files were selected and is capped by configurable result count, line count and response size.
- **Proposal and verification:** MCP stages hunks in memory and validates a candidate in a disposable pinned Flask copy. The model cannot write the workspace. The official Task B request remains the user turn; the agent does not receive hard-coded Task B file paths or solution text.
- **Review and save:** VS Code renders per-hunk diffs, checks source and editor versions, validates the chosen subset and applies one undoable WorkspaceEdit. Disk save requires one explicit Save All action. A later file-save failure triggers compensation; if a concurrent edit blocks rollback, a private journal remains for explicit recovery.
- **Recovery:** the extension stores a mode-0600 checkpoint under private global storage after MCP actions. It records the exact task, repository revision/root, model/session/turn IDs, ranked path reasons, full staged hunks, validation history, failure digests and next-run state. A resume choice rechecks the pinned clean worktree and anchors, never restores approval, and requires validation again.
- **Model routing:** one primary plus up to two ordered TrueForge models. A transient network/5xx error gets one bounded retry with backoff and Retry-After support. Rate-limited or invalid-credential model families are skipped. Context overflow shrinks repository retrieval before a provider switch. Malformed model output can switch models; tool/verification errors, cancellation and any error after review starts cannot.

## Verified features

- Task A previously completed a live TrueForge turn, displayed a VS Code diff, received explicit user approval and passed the official Flask checks. Evidence is in [report 06](06-task-a-vertical-slice.md).
- Task B deterministic retrieval, MCP contracts, staged multi-file verification, provider routing with mocked failures, checkpoint restore, path safety, context limits and recovery CLI pass the headless safety suite: **29/29**.
- The VS Code Extension Host suite passed **25/25** on the save-transaction build. It was not rerun after the later checkpoint/router changes; those changes have TypeScript and headless coverage.
- A simulated later-file save failure rolled the earlier save back and left the complete proposal unsaved in both editor buffers. Recovery CLI tests cover original/proposed byte states, conflict preflight and explicit invocation.
- The installed SDK declarations confirm `preloadTools`, context compaction and large-response settings. Deferred MCP loading is enabled in the Task B agent, preloading only investigation and run-state tools. Compaction is opt-in at 4,400 estimated input tokens; large-result offloading and native skills remain off because the agent sandbox is disabled.
- The disposable Task B worktree and pristine fixture remain at the pinned commit and were clean at the latest status check.

## Blockers and limits

- There is no successful live Task B proposal, accepted patch or Task B verifier result yet. Provider fallback and persisted resume have only local/mock verification. The subsequent live run in [report 11](11-task-b-live-run.md) exercised ranked file selection and deferred tool discovery, then stopped at Groq's input quota before staging any edits.
- The user will configure OpenRouter and provide the exact primary/fallback model names through TrueForge. Free endpoints share account/provider limits; the router skips a rate-limited provider family instead of rotating model IDs from that same family.
- TrueForge compaction stays off by default because an earlier Groq run emitted 1,533 output tokens during compaction and then hit its output-per-minute quota. Deferred tool loading is enabled by default but needs a live session to confirm the running server's behavior.
- Task C has no integrated VS Code automatic failover demonstration. Task A's cancellation path and a Task C invalid-endpoint probe exist, but do not satisfy the official Task C anchor.
- User-level `@file`/`@symbol` parsing UI is not implemented. The existing MCP `read_file` already accepts a tracked path, line range and symbol name.

## Reuse decisions

- **TrueForge:** reuse the installed SDK and native agent/session/stream/MCP/approval/deferred-tool APIs. This is the execution harness; no second agent loop was added.
- **ECC:** cloned to `/private/tmp/forge-ecc-reference` (MIT license, commit `3f14a10`). Reused its compact Markdown handoff and persistent-memory structure as design guidance; no ECC runtime source or hundreds of skills were copied into the extension.
- **Superpowers:** use the relevant engineering ideas (small changes, root-cause fixes, evidence before completion). No orchestration code imported.
- **OpenCode:** no code copied. Its provider behavior does not own this app's TrueForge sessions, so the extension uses a small bounded session router around TrueForge. The generic OpenCode loop is not used.
- **Skills/subagents:** native TrueForge skills require a sandbox, which stays disabled for safe workspace access. Dynamic subagents remain disabled because repository retrieval is deterministic and the expected benefit does not justify extra calls.

## Next actions

1. Configure a tool-calling OpenRouter model in TrueForge and list the exact model FQNs with `npm --prefix extension run trueforge:models`.
2. Run one Task B live integration from a fresh clean pinned worktree. Observe deferred tools, primary failure/fallback, checkpoint metadata, verifier result, diff review and final Git status. Do not spend beyond configured models.
3. If a provider returns an invalid tool call, malformed output or verification failure, fix that case locally and keep the previous staged candidate; do not repeat an identical model run.
4. After Task B succeeds, test Task C with a controlled configured-provider failure, prove no unapproved disk changes, then repeat Task A in the extension host if time permits.
