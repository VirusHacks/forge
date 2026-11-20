# Technical audit: Forge on TrueForge

**Audited:** 20 November 2026, branch `forge-v2` at `272201c`. I read the source in `extension/src` and checked it against live runs recorded for the demo video. Every claim below points at code or at recorded behaviour. Capabilities that TrueForge offers but Forge does not use are listed as such.

## 1. What Forge is

Forge is a VS Code extension (`extension/`). It is a client of a locally running TrueForge server (`npx @truefoundry/trueforge`, version 0.185.1 in our runs).

- **Agent loop.** TrueForge runs it: model calls, tool calling, approvals, compaction and session history.
- **Extension responsibilities:**
  - assembling context before the first turn
  - exposing the editor and workspace as MCP tools
  - turning TrueForge's approval request into a per-hunk diff review
  - choosing a fallback model when a provider fails

The extension never calls a model provider. Its comment in `src/core/trueforge.ts` says so, and every model call in the logs goes through TrueForge sessions.

## 2. TrueForge capabilities: used and not used

| Capability | Used? | Evidence |
|---|---|---|
| Sessions, turns and streamed turn events (TS SDK `@truefoundry/trueforge-sdk` 0.185.0) | Yes | `src/core/session.ts` `runSession()`: `sessions.create`, `sessions.createTurnStream`, `previousTurnId` |
| Named agent definitions | Yes | `upsertAgent()` registers `forge-agent` and `forge-inline`. Exported copies are in `trueforge/agents/*.json` |
| Remote MCP servers | Yes | `upsertMcpServer()` registers Forge's loopback Streamable-HTTP MCP endpoint (`src/workspaceMcp.ts`, random secret path) |
| Tool approval (`requireApprovalForTools`) | Yes | `submit_for_review` (agent) and `propose_edit` (inline) are approval-gated. The `tool.approval_required` event opens the diff review, and the reply is a `user.tool_approval` event (`session.ts`, lines 236–248) |
| Deferred tool loading (`preload: false` + `preloadTools`) | Yes, agent mode | `buildAgentSpec()`: 5 of the 9 tools are preloaded. TrueForge's `list_tools` calls appear in the timeline as "TrueForge list_tools · deferred tool loading" (`HARNESS_TITLES`) |
| Context compaction | Yes, agent mode | `contextManagement.compaction` with an `input_tokens` trigger (18k standard, 5.2k tight). The `thread.context_compaction_*` events surface as a UI banner |
| Large tool response handling | Yes | `largeToolResponse.enabled: true` in both specs |
| Session update to swap model | Yes, for fallback | `sessions.update(sessionId, { agent: { spec } })`, then the same session continues (`session.ts`, line 151) |
| Session cancel | Yes | `sessions.cancel()` on abort, and after the review decision to save calls |
| Per-request token breakdown (`usage.inputTokensBreakdown`) | Yes, displayed | Shown in the sidebar and the run log |
| Code Mode / sandbox | Optional, off by default | `forge.codeMode`. Measured at +1.8k harness tokens per request, so it is opt-in |
| Dynamic subagents, web search, ask-user, generative UI | **Not used** | Explicitly disabled in both specs |
| Skills | **Not used** | — |
| Built-in model fallback | Not available in TrueForge 0.185.1 | Forge implements the policy in `src/core/router.ts`. TrueForge still executes every call |

## 3. Architecture and data flow

```
User (VS Code)
  ├─ Inline edit: select → ⌘⌥K → instruction          src/extension.ts inlineEdit()
  └─ Agent panel: request (+ optional @file/@symbol)   src/ui/sidebar.ts + media/forge.js
        │
        ▼
Forge extension host
  1. Context pack (agent mode, before any model call)  src/agent/retrieval.ts assembleContext()
  2. Starts a loopback MCP server with the tools        src/workspaceMcp.ts + src/agent/tools.ts
  3. Registers the MCP server and agent in TrueForge    src/core/trueforge.ts
  4. Creates a session with an inline agent spec        src/core/session.ts
        │  HTTP + SSE (TrueForge SDK)
        ▼
TrueForge server (local)  ── model provider (Gemini / Groq / OpenRouter …)
  agent loop: model → tool calls → MCP → results → …
        │  tool calls over MCP (Streamable HTTP, loopback)
        ▼
Forge MCP tools: search_code · read_code · find_symbol · list_files · stage_edits ·
                 view_staged · discard_staged · run_command · submit_for_review (approval)
        │  approval_required(submit_for_review / propose_edit)
        ▼
Review controller: one diff tab per file, per-hunk accept/reject, apply in one
WorkspaceEdit, save, Undo                                    src/review/reviewController.ts
```

**Is there a custom graph?** Forge has no custom orchestration graph or state machine. The loop is TrueForge's native agent loop. The "graph" in Forge is a **code graph**: RepoMap (`@sylphx/repomap`, run as a read-only subprocess over a private mirror of the workspace, `src/repoMap.ts`). It provides symbol ranking and the callers, callees and tests of the most relevant symbol. That neighbourhood is added to the context pack and drawn in the sidebar ("code graph" card). Call-site edges are kept only when the call-site line actually names the symbol (`verifiedEdges` / `droppedEdges`).

The extension adds three deterministic **gates** around TrueForge's loop:
- the context pack before turn 1
- auto-verification after each `stage_edits`
- completion gates on `submit_for_review`

These are hooks on the loop, not a replacement for it.

## 4. MCP tools (agent mode, `src/agent/tools.ts`)

| Tool | What it does | Writes to disk? |
|---|---|---|
| `search_code` | Several literal queries per call; returns `path:line: text [enclosing symbol]` | No |
| `read_code` | Several whole symbols or line ranges per call; parser-based outlines | No |
| `find_symbol` | RepoMap lookup: definition, signature, callers, callees, tests | No |
| `list_files` | Directory listing with a substring filter | No |
| `stage_edits` | In-memory find/replace edits on staged text (`src/agent/staging.ts`); repairs whitespace and indentation slips; empty `find` creates a file | **No** |
| `view_staged` / `discard_staged` | Inspect or drop staged edits | No |
| `run_command` | Allowlisted executable, argv only (no shell). Runs in a **disposable snapshot** with staged edits applied, a credential-free env and a timeout; on macOS `sandbox-exec` denies network and writes outside the snapshot (`src/agent/commands.ts`) | No (snapshot only) |
| `submit_for_review` | **Approval-gated** in TrueForge; the approval opens the per-hunk review | Only accepted hunks, after approval |

Inline edit uses its own small MCP server: `propose_edit` (approval-gated), `read_code` and `search_code` (`src/inline/inlineEdit.ts`).

## 5. Context selection and budget (`src/agent/retrieval.ts`, `src/core/profiles.ts`)

Before the first model call, Forge builds a **context pack**. It is deterministic and makes no model calls.

**Ranking signals:**
1. BM25/IDF-weighted term hits, boosted on definition lines
2. Filename and path matches
3. RepoMap symbol rank and graph neighbours (callers, tests)
4. Module affinity: tests and docs named after the top implementation file, e.g. `cli.py` → `test_cli.py`, `docs/cli.rst`
5. Explicit `@file` / `@symbol` mentions, always first

**Request-word handling.** "test"/"documented" are read as *role intent* rather than search terms. Changelogs are penalised.

**Pack contents.** Each selected file carries a role (implementation, test, docs, config), up to four stated **reasons**, an outline with line ranges, and symbol-level excerpts.

**Budget.** Token budget per model profile: `standard` 7,000 tokens, `tight` 2,200 tokens. The tight profile is for providers listed in `forge.tightBudgetProviders`, default `groq`, because of Groq's 7k-tokens-per-minute free tier. Both can be overridden with `forge.contextBudget`. Files beyond the best implementation, test and docs file need structural evidence to be included; omitted candidates are counted.

**Sidebar.** Shows the pack as a "context" card (files, roles, reasons, tokens out of budget) and a code-graph card. The agent can still search and read anything else through MCP.

**Explicit mentions.** `@file` and `@symbol` mentions are supported in the agent panel (`sidebar.onPickFile` / `onPickSymbol`). The fixed task deliberately names no files.

## 6. Streaming, approvals, cancellation

- **Streaming.** `model.message.delta` events become `assistant.delta` and `reasoning.delta` (a "Thinking" block), tool rows with duration, a usage line and banners for compaction and retries. The extension host never blocks: runs are async, and inline edit shows a cancellable progress notification.
- **Cancellation.** The sidebar **Stop** button, `forge.stop` (⌘⌥.) and the notification's Cancel all abort an `AbortController`. That calls `sessions.cancel()` and rejects any pending review. Because edits are only *staged* in memory until approval, a cancelled run never touches the workspace ("Cancelled. No files were changed."). Covered by the extension-host test "cancel during review writes nothing" (`extension/test/extension.test.ts`).

## 7. Diff safety and undo (`src/review/reviewController.ts`)

- Every proposal opens as a VS Code diff (`vscode.diff`, `forge-review:` virtual documents), one tab per file.
- **Per-hunk decisions:**
  - sidebar checkboxes ("Accept N of M")
  - `forge.hunkAccept` / `forge.hunkReject` commands and keybindings (⌘⌥Y / ⌘⌥N)
  - CodeLens buttons

  The CodeLens buttons need `diffEditor.codeLens: true` in VS Code 1.147; with it, "✓ Accept Hunk 4/4 | ✕ Reject" is visible in the Task B diff. The Task A take shows per-hunk control with the sidebar checkboxes.
- **Apply.** Each target is re-opened and compared with the exact base text. If the file changed, is dirty or was created by someone else, nothing is written. Accepted hunks go into **one `WorkspaceEdit`** and are saved, and the result is checked against the approved text.
- **Undo.** Restores the previous text of every applied file (and deletes created files) only if each still contains exactly what was applied.

## 8. Resilience (`src/core/router.ts`, `src/core/session.ts`)

- **Failure classes:** rate_limit, quota, server, network, unavailable, invalid_credentials, provider_incompatible, context_exceeded, malformed_output. Unclassified errors fail immediately.
- **Retries:**
  - network/5xx: up to 2 retries with exponential backoff (2 s, 4 s; Retry-After honoured)
  - 429: waits up to 65 s
  - malformed tool call: one retry
- **Then automatic fallback** to the next model in `forge.fallbackModels`. Only listed models are used, and only if TrueForge has them. The switch updates the **same session's** agent spec and continues from `previousTurnId`, so earlier tool results are kept. A bad credential blocks the whole provider; a quota error blocks only that model.
- **Without fallbacks:** a plain-language error such as "TrueForge could not reach the model endpoint. No files were changed." (`friendlyError()` in `src/extension.ts`).
- **Recorded (Task C, take 1):** `forge-demo-broken/unreachable` → retry in 2 s → retry in 4 s → "Fallback: unreachable → gemini-3-5-flash-lite (network). Same TrueForge session continues." → 2-hunk diff → rejected → `git status --short` empty, `git diff --exit-code` passes.

## 9. Models used for the video (all free tiers, cost $0)

| Role | Model (TrueForge name) | Where |
|---|---|---|
| Task A | `google-gemini/gemini-3-5-flash-lite` | Google Gemini API, free tier |
| Task B | `google-gemini/gemini-3-5-flash-lite` → fallbacks `gemini-b/gemini-3-5-flash-lite` (second Google project via Google's OpenAI-compatible endpoint), `google-gemini/gemini-3-1-flash-lite`, `openrouter/openrouter-free` | Google, OpenRouter free |
| Task C | `forge-demo-broken/unreachable` (OpenAI-compatible endpoint at 127.0.0.1:18791, no listener) → `google-gemini/gemini-3-5-flash-lite` | local / Google |

Models are switched in the sidebar model picker. The list comes from TrueForge's `/models`, and Forge has no provider code.

## 10. Issues found while producing the video (not fixed in the extension)

- **TrueForge crashes under Node 26.** It ran on Node v26.7.0 and crashed twice mid-run: `undici` threw an uncaught `setTypeOfService EINVAL`. Running it under Node 22 LTS (`scratch/run-trueforge.sh`) fixed it. This belongs in the README setup notes.
- **`groq/qwen-3-8-27b` returned empty or one-word `propose_edit` replacements** (`"replacement": ""`, `"off"`) in three runs on 20 Nov. Forge's replacement guard rejected the first two automatically each time. When the correction budget ran out, the junk proposal still reached the review, where it was rejected and nothing was written. Weak models can still put a bad proposal in front of the user, but never on disk.
- **`groq/gpt-oss-20b`** works for one-call inline edits. Multi-turn runs fail because TrueForge echoes `reasoning_content` back to Groq.
- **CodeLens buttons** need `diffEditor.codeLens: true`. VS Code's default is off, so the README should mention it.

## 11. Evidence per judging criterion (see JUDGING_EVIDENCE_MATRIX.md for timestamps)

| Criterion | Evidence available |
|---|---|
| A1 Inline edit | Task A recording: selection, ⌘⌥K, typed instruction, inline diff in the editor, per-hunk checkbox toggle, Accept, `False` |
| A2 Agent mode | Task B recording: request names no files; changes span `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` |
| A3 Streaming / cancellation | Streaming thinking, tool rows and status in A/B/C; editor scrolled during Task C retries. Cancellation: code path plus extension-host test; a live Stop clip is recorded only if time allows |
| B1 Context assembly | Task B: context card (files, roles, reasons, tokens of budget) and code-graph card |
| B2 Diff safety | Per-hunk checkboxes, diff tabs, apply on Accept, Undo restoring files, `git status` clean |
| B3 Resilience | Task C: retry/backoff, automatic same-session fallback, workspace unchanged |
| B4 TrueForge integration | Session link plus the TrueForge UI session (turns, tool calls) inside VS Code; approval-gated `submit_for_review`; deferred tool loading and compaction rows when they occur |
| C1 Video | A → B → C, each followed by its terminal verification |
