# Forge architecture

Forge is a VS Code extension, and TrueForge is its agent harness. TrueForge runs the agent loop and makes every model call. Forge decides **what the model sees**, exposes the editor as **MCP tools**, and keeps the editor **safe**: nothing is written before review, everything is undoable, and failures are handled.

```text
┌──────────────────────────── VS Code ────────────────────────────┐
│ Sidebar webview: context card + code graph, tool timeline,      │
│                  per-hunk review, model picker, Stop, Undo      │
│ Inline edit (⌘⌥K): selection + instruction → diff               │
└───────────────┬─────────────────────────────────────────────────┘
                │ validated messages
┌───────────────▼──────────── Forge extension host ───────────────┐
│ context pack  ─ BM25 + RepoMap graph + role selection + budget  │
│ model router  ─ wait / back off / retry / switch (same session) │
│ session runner─ streams events, TrueForge approvals → review    │
│ review        ─ diff tabs, per-hunk apply, save, undo           │
│ loopback MCP server (Streamable HTTP, random path per run)      │
│   search_code · read_code · find_symbol · list_files            │
│   stage_edits (+ auto-verify) · view_staged · discard_staged    │
│   run_command (sandboxed snapshot) · submit_for_review          │
│   propose_edit (inline)                                         │
└───────────────┬─────────────────────────────────────────────────┘
                │ TrueForge SDK: agents, sessions, turns, events
┌───────────────▼──────────── TrueForge (local) ──────────────────┐
│ agent loop · MCP client · tool approval · deferred tool loading │
│ context compaction · large tool responses · session history     │
└───────────────┬─────────────────────────────────────────────────┘
                ▼
         any configured model (Gemini, Groq, OpenRouter, local…)
```

## 1. Graph engineering: how context is chosen

Code: [`extension/src/agent/retrieval.ts`](../extension/src/agent/retrieval.ts).

Before the first model call, Forge builds a **context pack** under a token budget. All ranking is deterministic and needs no model call.

1. **Terms.** Identifier-aware term extraction. Words that describe *which kind of file* is wanted ("test", "documented") become **role intent**, not search terms.
2. **BM25 over lines.** Scores are length-normalised, so large files do not win by size. Files that *define* an identifier named in the request get a strong boost. Filename matches count. Lines where several terms co-occur (registration sites) add weight. Changelogs are penalised.
3. **RepoMap code graph.** [RepoMap](https://github.com/SylphxAI/repomap) indexes a private mirror of the workspace. Forge takes the RepoMap symbol hits and then **anchors the graph focus to the hit inside the best lexically ranked implementation file**, so text ranking and graph ranking must agree. The focus's **callers, callees and tests** are pulled in as candidates with reasons ("calls FlaskGroup (static graph)", "RepoMap test for FlaskGroup").
4. **Module affinity.** Tests and docs named after the top implementation file are boosted (`cli.py` → `tests/test_cli.py`, `docs/cli.rst`).
5. **Role selection.** The best implementation file comes first, then the best test and docs file when the request asks for them. Any further file needs *structural* evidence: it defines a requested identifier, is a graph neighbour, is named after the module, or was mentioned. Shared words alone are not enough.
6. **Symbol-level excerpts.** Forge excerpts whole functions, classes and doc sections ranked by term density, not arbitrary line windows. Each file also gets an outline with line ranges, so the agent can request exactly the symbol it needs.
7. **Mentions.** `@file` and `@symbol` mentions are always included.

The pack gives the model the selected files with reasons, a **"Code graph" section** (focus, called from, calls, tests), outlines and code. The UI shows the same data as a context card and a node-link diagram.

On the Task B request the graph focuses on `FlaskGroup`. Its callers include `TestRoutes.invoke`, an existing test of a built-in CLI command: exactly the example to imitate.

Budgets come from [`core/profiles.ts`](../extension/src/core/profiles.ts):

| Profile | Context pack | Compaction trigger | Used for |
|---|---|---|---|
| tight | ~2.2k tokens | 5.2k | Providers listed in `forge.tightBudgetProviders` (default `groq`). Groq's free tier rejects any single request above ~7k tokens. |
| standard | ~7k tokens | 18k | Everyone else |

Each value can be overridden in settings.

## 2. Harness engineering: what Forge adds on top of TrueForge

Code: [`extension/src/agent/tools.ts`](../extension/src/agent/tools.ts), [`staging.ts`](../extension/src/agent/staging.ts), [`commands.ts`](../extension/src/agent/commands.ts), [`agentRun.ts`](../extension/src/agent/agentRun.ts).

| Mechanism | Why |
|---|---|
| **Batched tools.** `search_code` takes several queries and `read_code` several whole symbols per call; parallel calls are encouraged. Schemas also accept a single item. | Each model call re-sends the whole history, so fewer calls mean far fewer tokens. Groq validates tool arguments strictly. |
| **Staged edits.** Edits stay in memory. The anchor must be exact and unique; whitespace and uniform-indentation slips are repaired; misses return the closest real lines; duplicate insertions are skipped. | Weak models copy anchors imperfectly and repeat themselves. A failed edit should cost one retry, not five reads. |
| **`run_command`.** Argv only (no shell), an executable allowlist, a disposable snapshot with the staged edits applied, no credentials in the environment, a timeout, bounded output, and macOS `sandbox-exec` with network and outside writes denied. | The agent must be able to run tests (a requirement in the brief) without touching the real workspace. |
| **Auto-verification.** After each `stage_edits`, Forge infers the relevant tests and runs them **without a model call**. Results are compared with a **baseline run on the unmodified code**. | The model learns about a broken test immediately, and pre-existing failures never send it on a chase. |
| **Completion gates.** `submit_for_review` is refused once each for failing verification, missing requested tests or docs, or unverified changes. | Weak models declare victory too early. Each gate fires only once, so a model is never trapped. |
| **Call budget in every result.** For example "28/40 model calls used… stage now". | Models plan better when they can see the limit. |
| **Inline guard.** A proposal that drops the selected definition, or loses more than half the lines, is sent back as the approval-denial reason. | Fixed Groq Qwen's truncated first answer on Task A in the same turn. |
| **Model router.** Short 429s are waited out (Retry-After); 5xx and network errors back off and retry; a malformed tool call is retried once; credential, quota, availability and size failures switch models. Bad credentials block the whole provider; quotas block only the failing model. | Free tiers fail constantly; the right reaction depends on the error. |

## 3. TrueForge, used to the full

| TrueForge feature | How Forge uses it |
|---|---|
| Agents, sessions, turns, streamed events (SDK) | Every run is a TrueForge session. Text, reasoning and tool events stream into the sidebar. Stop calls `sessions.cancel`. |
| Remote MCP servers | The editor's capabilities are MCP tools, so **the agent decides** what to search, read, change and run. |
| `requireApprovalForTools` | `submit_for_review` and `propose_edit` need approval. TrueForge's approval request **is** the diff review; Forge answers allow or deny with a reason. |
| Deferred tool loading (`preloadTools`) | 5 core tools are preloaded; `find_symbol`, `list_files`, `view_staged` and `discard_staged` load on demand through TrueForge's `list_tools`. These harness calls (`toolInfo.type = "truefoundry-system"`) are shown in the sidebar timeline as *TrueForge list_tools · deferred tool loading*. |
| Context compaction | Enabled with a per-model trigger. Forge clears its "already shown" cache when TrueForge compacts. |
| Large tool response handling | Enabled for both agents. |
| `sessions.update` + `previousTurnId` | **Same-session fallback.** Sessions are created with an inline agent spec (named-agent sessions cannot change agent), so a switch updates the live session's model and continues from the last turn with all tool results. |
| Per-request token breakdown | Usage events (harness, instructions, tool definitions, messages) drive the token counters in the UI. |
| Named agents | `forge-agent` and `forge-inline` are registered for the TrueForge UI. Their definitions are exported to [`trueforge/agents/`](../trueforge/agents) by the same code that builds them. |

**Measured trade-off: Code Mode.** TrueForge's local sandbox and Code Mode work in standalone mode, but they raise per-request harness tokens from **213 to 1,978**. On Groq's 7,000 tokens-per-minute free tier that cuts throughput about 3×. Batched MCP tools get most of the benefit at no fixed cost, so Code Mode is opt-in (`forge.codeMode`).

**Harness findings worth contributing upstream:**
- TrueForge 0.185.1 has no built-in model fallback.
- Named-agent sessions cannot switch agent.
- `groq/gpt-oss-20b` fails on its second call because `reasoning_content` is sent back to a provider that rejects it.

## 4. Editor safety

Code: [`extension/src/review/reviewController.ts`](../extension/src/review/reviewController.ts).

- **Nothing is written before review.** Proposals open as diff tabs against a virtual base; the sidebar lists every hunk with `+/-` counts, a preview and a verification badge.
- **At apply time each file is re-read and compared with the exact text the proposal was based on.** A file changed during review is never overwritten. Accepted hunks are applied by offset in one `WorkspaceEdit`, then saved.
- **Undo** restores the previous content (or deletes created files) if the files still contain exactly what was applied. VS Code's own undo also works per buffer.
- **Cancellation** aborts the TrueForge session. Staged edits are discarded, so the workspace is untouched.

## 5. Inline edit

Code: [`extension/src/inline/inlineEdit.ts`](../extension/src/inline/inlineEdit.ts).

1. The selection (or the enclosing symbol) plus nearby context goes into one compact request.
2. The model answers by calling `propose_edit`, which needs approval.
3. Forge checks the proposal and then opens the per-hunk review.
4. If a model replies in prose instead of calling the tool, Forge extracts the code and still shows a review.

## 6. Tests

- [`extension/scripts/core.test.cjs`](../extension/scripts/core.test.cjs) (19 offline tests): routing policy, staging repairs and guards, diff, ranking, sandboxed commands, baseline-aware verification, the dotenv snapshot policy, the inline guard, and a fake TrueForge for same-session fallback, approval flow and cancellation.
- [`extension/test/extension.test.ts`](../extension/test/extension.test.ts) (7 tests in a real editor): per-hunk apply and save, undo, rejection, stale-file refusal, new files, cancel during review.
- [`extension/scripts/ui-host.cjs`](../extension/scripts/ui-host.cjs): drives a full live run through the installed extension, including the official Task B checks and undo.
