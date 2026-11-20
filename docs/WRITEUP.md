# Forge: an editor-native coding agent on TrueForge

*Draft of the 1–3 page write-up. Fill in the video timestamps after recording, then export to PDF.*

## 1. Team

**Husttlers**

| Member | College | GitHub |
|---|---|---|
| Vinay Vora (leader) | DJ Sanghvi College of Engineering | [@wizardsweb](https://github.com/wizardsweb) |
| Daksh Jain | Sardar Patel Institute of Technology (SPIT) | [@dash10107](https://github.com/dash10107) |
| Vinisha Bhagwani | Sardar Patel Institute of Technology (SPIT) | [@vinisha1014](https://github.com/vinisha1014) |
| Moksh Jain | DJ Sanghvi College of Engineering | [@Jain-Moksh](https://github.com/Jain-Moksh) |
| Moksha Jain | K. J. Somaiya College of Engineering | [@mdevworks](https://github.com/mdevworks) |

## 2. Starting point

From scratch, with no fork. Two pieces come from elsewhere:

- One visually-hidden accessibility CSS rule adapted from Cline (`eff43e19b267e171f597ab03733bfed25090f72d`, Apache-2.0).
- RepoMap `@sylphx/repomap@1.9.0` (MIT), used unmodified as a dependency.

Repository: <https://github.com/VirusHacks/forge>.

## 3. Architecture on TrueForge

The VS Code extension is a client of TrueForge 0.185.1 (local mode) through `@truefoundry/trueforge-sdk`. Every run is a TrueForge session; the extension streams its events (text, reasoning, tool calls, approvals, compaction) into the sidebar, and never calls a model provider itself.

**Editor capabilities exposed as MCP tools** (loopback Streamable HTTP):

| Tool | What it does |
|---|---|
| `search_code` | several queries per call |
| `read_code` | several whole symbols or ranges per call |
| `find_symbol` | RepoMap definition, callers, callees and tests |
| `list_files` | files under a directory |
| `stage_edits` | proposed writes, held in memory; runs verification automatically |
| `view_staged`, `discard_staged` | inspect or drop staged edits |
| `run_command` | allowlisted command in a sandboxed snapshot with the staged edits applied |
| `submit_for_review` | approval-gated; asks the user to review |
| `propose_edit` | approval-gated; the inline-edit answer |

**Harness features used, and why:**

| Feature | Why |
|---|---|
| `requireApprovalForTools` | TrueForge's approval request drives the per-hunk diff review, so nothing reaches disk unapproved |
| Deferred tool loading | 5 tools preloaded, 4 loaded on demand through TrueForge's `list_tools`, to keep prompts small for free tiers; the `list_tools` calls show in the session and the sidebar timeline |
| Context compaction | triggered per model profile (18k tokens, or 5.2k on tight free tiers); visible as compaction events in the session and the sidebar |
| Large-tool-response handling | keeps oversized tool output out of the conversation |
| `sessions.update` + `previousTurnId` | **same-session model fallback**: a failed model is replaced in the live session and every tool result is kept |

We measured Code Mode (local sandbox): harness tokens rise from 213 to 1,978 per request, about 3× fewer requests per minute on Groq's free tier. It is therefore opt-in.

Agent definitions are in `trueforge/agents/`.

## 4. How context is selected

**The context pack.** Before the first model call Forge builds a budgeted context pack, with no model calls involved:

1. BM25 over lines, with boosts for defining files and filenames, and role-intent terms ("test", "documented").
2. The RepoMap code graph, whose focus is anchored to the best lexically ranked file. The focus's callers, callees and tests are added.
3. Module affinity (`cli.py` → `test_cli.py`, `docs/cli.rst`).
4. Best implementation, test and docs files.
5. Whole-symbol excerpts and outlines with line ranges.

**Budgets.** About 2.2k tokens for strict-per-minute providers (Groq) and about 7k otherwise; both are configurable.

**Visible during Task B.** The sidebar shows each chosen file with its reasons, its token cost and the code-graph diagram. On Task B the graph is centred on `FlaskGroup`, with `TestRoutes.invoke` (an existing CLI-command test) as a caller.

**Afterwards.** The agent fetches only what is missing, in batched calls. Every tool result shows the remaining call budget.

## 5. Model setup

| | |
|---|---|
| Models | Free tiers configured in TrueForge: Google Gemini (`gemini-3-5-flash-lite`, `gemini-3-1-flash-lite`, `gemini-3-5-flash`, `gemma-4-31b-it`), Groq (`qwen-3-8-27b`), OpenRouter (`openrouter/free`) |
| Where they ran | Provider APIs, called by the local TrueForge server |
| Cost | **$0** |
| Switching models | Pick any TrueForge model in the sidebar. List automatic fallbacks in `forge.fallbackModels`. Nothing in the extension is provider-specific except an optional "tight budget" list for providers with strict per-minute limits. |

## 6. Scorecard

Timestamps refer to the demo video (3:54).

| Criterion | Video | Claim |
|---|---|---|
| A1 Inline edit | 0:51–1:10 | Select → ⌘⌥K → typed instruction → diff in the editor about 2 s later; per-hunk untick/re-tick; Accept; `FLASK_DEBUG=off` prints `False` (1:10) |
| A2 Agent mode | 1:19–2:18 | One request, no file names: the agent finds and edits `cli.py`, `test_cli.py` and `cli.rst`; 59 tests pass (2:35); `git status` shows those 3 files (2:56) |
| A3 Streaming and cancellation | 1:43–2:16 | Tool calls and banners stream live from TrueForge events; the editor stays responsive during retries (3:23); Stop/Cancel available. A live cancel is not shown in the video |
| B1 Context assembly | 0:18 · 1:25–1:43 | RepoMap code graph (edges verified at call sites) + BM25 → a budgeted pack before the first model call: 4 files, a reason each, 4.8k / 7k tokens |
| B2 Diff safety | 0:59 · 2:18–3:02 | Edits staged in memory; per-hunk review and in-diff CodeLens; nothing written before Accept; Undo restores all files (git clean at 3:02) |
| B3 Resilience | 3:23–3:43 | Unreachable endpoint → backoff 2 s, then 4 s → automatic fallback to the second model in the same session; `git status` empty (3:40) |
| B4 TrueForge depth | 0:11 · 1:43 · 2:23 | 9 MCP tools; approval-gated `submit_for_review` drives the review (live in TrueForge, 2:23–2:30); deferred tool loading and compaction; same-session fallback; session shown (3:04) |
| C1 Video | 0:45 · 1:19 · 3:11 | A, B and C in order, each verified on screen |
| C2 Write-up | n/a | This document |

## 7. Tools used

- Claude Code (Anthropic) and OpenAI Codex as coding assistants.
- TrueForge, the TrueForge TypeScript SDK, the MCP TypeScript SDK, RepoMap, VS Code Extension API, `@vscode/test-electron`, Node.js test runner, pytest, `uv`.

## 8. Known limitations and what we would do with another month

**Limitations:**
- Free models are unreliable (frequent 503s and quotas) and make many small tool calls: Task B takes 20–35 model calls.
- The command sandbox is macOS-only (`sandbox-exec`); on Linux commands run in a throwaway copy without OS isolation, and Windows is untested.
- The code graph is static analysis: each edge is verified at its call site, but dynamic calls can be missed.

**With another month:**
- Persistent RepoMap and BM25 indexes for very large repositories.
- Plan-then-fetch prefetching to cut tool calls further.
- Linux sandboxing (bubblewrap).
- Contributing upstream to TrueForge: built-in model fallback, agent switching for named sessions, and the `reasoning_content` echo bug we found with `gpt-oss-20b`.
- An evaluation suite of repository tasks to tune ranking weights against measured success rates rather than by hand.
