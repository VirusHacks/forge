# Tasks B and C implementation readiness

Updated 19 November 2026. Final live Task B and Task C demonstrations remain to be performed by the user. No live model calls were made during this implementation sprint.

## Implementation

- TrueForge remains responsible for agent, model, MCP and stream execution. Task B preloads `investigate_repository`, `search_repository`, `read_file`, `stage_edit`, `validate_edits`, `submit_review` and `get_run_state`; the less common directory tool stays deferred. SDK 0.185.0 serializes `preloadTools` to `preload_tools`; the [TrueForge documentation](https://trueforge.dev/key-features/deferred-tool-loading) describes selective preloading.
- Task B uses shorter tool descriptions and instructions, capped repository excerpts, tool results and verifier diagnostics. A configurable request estimate includes schemas, instructions, a 1,200-token harness allowance, model messages and tool results; the output allowance is separate. This is an estimate, not a provider tokenizer or a guarantee about total tokens per minute. The context window is a conservative user-configured value, not automatically discovered model capability. Optional native compaction remains disabled by default because the earlier Groq experiment exhausted its output quota; large-result offloading and skills require a sandbox and were not enabled.
- The existing deterministic investigator keeps its ranked implementation, test and documentation candidates, reasons, symbols and bounded excerpts. The checkpoint now retains short source evidence as well as reasons, staged hunks and verification state. Resumed hunks require fresh validation and approval; the current proposal is never auto-approved.
- Task B tracks rate-limited provider-family cooldowns, including Groq's textual retry delay; skips invalid or cooling providers across nonadjacent aliases; bounds transient retries; handles interrupted streams and context overflow; and retains staged state. User cancellation and a started review prevent fallback. The default fallback order is Gemini Flash Lite followed by OpenRouter free, both accessed only through TrueForge. `forge.freeOnly` defaults true and uses an explicit model allowlist; this is not a billing guarantee because provider account tiers and quotas are external. Verify account billing and limits before final testing.
- Task A now restarts the same selected-source request in a fresh TrueForge session after eligible provider failures, streams progress, and preserves its existing validation, diff and approval gate. It ignores late events after cancellation, handles EOF/timeout, and bounds retry and fallback. Duplicate stream IDs are ignored. No agent framework or provider-direct calls were added.
- Multi-file validation, per-hunk review, editor version checks, explicit Save All, undo and compensation/recovery remain in the existing code. The validator uses a disposable, sandboxed copy and bounded error summaries.

## Measurements

The last actual Groq run in [report 11](11-task-b-live-run.md) completed three model responses (7,262 input / 292 output tokens), plus a rejected request. It made two workspace calls and four native discovery calls, with 366 estimated repository tokens. It stopped at HTTP 429 before staging a candidate.

In a local serialization measurement, the old two preloaded MCP schemas were 1,197 characters, approximately 399 tokens at bytes/3. Seven compact preloaded schemas are 3,908 characters, approximately 1,303 tokens. This adds approximately 904 estimated upfront tokens per model request and may remove the observed list-tools and schema-fetch turns. These estimates use schema JSON, not the exact TrueForge/provider tokenizer; **there is no measured post-change live token total or demonstrated net savings**. Actual session usage and completed model events are logged after each Task B run.

## Verification

- `npm --prefix extension run test:safety`: **46 passed, 0 failed**, including MCP contracts, budget/preload checks, checkpoint, routing/cooldown, mocked Task C fault/cancellation, isolated verifier and recovery.
- `VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm --prefix extension test`: **25 passed, exit 0**, including multi-file save and review guards. Both commands compile TypeScript.
- The first headless run had eight failures caused by cooldowns persisting between unrelated tests. Tests now clear the process cooldown between cases and separately verify persistence and expiry; the full rerun passed.
- No autonomous Task B candidate, real Task B approval, final official verification, or live Task C fallback has been observed. Mocked fault injection exercises an unreachable provider at the session boundary; it does not establish a live TrueForge provider failure.

## Final Task B run

1. Start local TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@latest`. Confirm configured names with `npm --prefix extension run trueforge:models`.
2. Use a fresh clean linked worktree at Flask commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. From the project root:

```sh
FLASK_TASK_B_REPO='~/.codex/worktrees/flask-task-b-agent/flask-3.1.3' \
TRUEFORGE_MODEL='google-gemini/gemini-3-5-flash-lite' \
TRUEFORGE_FALLBACK_MODELS='openrouter/openrouter-free' \
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
npm --prefix extension run task-b:live
```

The launcher prints an evidence path. Review each displayed diff; explicitly approve the digest and selected hunks or reject. After saving an approved change, run `pytest tests/test_cli.py -q`, `flask --help`, and `flask config` against a test app with sensitive and ordinary settings; verify JSON, masking, at least three changed files and the TrueForge session. The isolated validator already performs the corresponding checks before review. Do not treat the recorded baseline rehearsal as a live agent success.

## Final Task C run

1. In TrueForge add a custom provider named `forge-task-c-unreachable`, with an OpenAI-compatible base URL at an unused loopback port (for example `http://127.0.0.1:1/v1`) and model ID/name `unreachable`; no real key is needed. This is a deliberate local fault, not a failure of the TrueForge server.
2. In the disposable Flask worktree's VS Code settings set `forge.trueforgeModel` to `forge-task-c-unreachable/unreachable`, `forge.taskAFallbackModels` to `["google-gemini/gemini-3-5-flash-lite"]`, `forge.providerMaxRetries` to `0`, and keep `forge.freeOnly` true. The exact fault-model identifier is permitted for this local demo. Select the complete `get_debug_flag` function and run **Forge: Task A — Propose Selected Function Patch**.
3. Show the failed primary, automatic fallback and responsive editor in the Forge Task A output. Before any approval, show `git status --short` is clean. Review or reject the proposal; cancellation must stop further attempts. If both models fail, report the error and leave the workspace clean.

OpenRouter and Gemini completed simple TrueForge smoke turns before this sprint; neither was tested with the changed Task B tools. The fault provider must be created for the final demonstration, and credentials stay in TrueForge settings.
