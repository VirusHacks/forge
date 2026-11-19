# Harness v2: context pack, batched MCP tools, same-session fallback, general inline edit

19–20 November 2026. This report records the v2 rewrite of the extension and the live and offline evidence gathered so far. **Tasks A and C now pass live through TrueForge on free models.** Task B now also passes end to end through the extension with a scripted approval (see the addendum). No recorded demo exists yet.

## Why v1 was replaced

The assessment at the start of this session found these root causes behind the Task B failures in reports 11–20:

- **Benchmark-specific code.**
  - Task A accepted only `get_debug_flag`, hard-coded the instruction and the tool arguments, and had no instruction input or keybinding.
  - Task B required the pinned commit and at least three files, and its verifier encoded Task B's acceptance criteria.
- **No `run_command` MCP tool.** `task.md` lists "run a command" among the editor capabilities that must be exposed as MCP tools, so this was an eligibility risk.
- **Model gating.** `forge.freeOnly` defaulted to a three-model allowlist, which would have hidden an organiser-chosen model.
- **Self-imposed context starvation.** A 4k-token repository budget, 40-line reads, a local estimator that aborted runs, and the rule that edited text must already have been read together produced 40–85 model calls per run. Each call re-sends the whole history, so the one success consumed 1.2M input tokens.
- **The "buffer changed" failure in report 18.** The review held a `TextDocument` across a long review while both diff sides were virtual URIs, so VS Code could dispose that document before apply.

The v1 modules, tests and scripts are preserved in `scratch/legacy-v1/` (git-ignored) and in commit `6e1b4d6`.

## What v2 does

| Area | Implementation (`extension/src/…`) |
|---|---|
| Context assembly | `agent/retrieval.ts`: BM25 over lines; filename and definition boosts; RepoMap symbol hits and static callers/tests; module affinity (`cli.py` → `test_cli.py`, `docs/cli.rst`); test/doc words treated as role intent, not search terms; changelog penalty; symbol-level excerpts; stated reasons for every file; token budget per model profile |
| Tools (MCP) | `agent/tools.ts`: `search_code` (several queries per call), `read_code` (several whole symbols or ranges per call), `find_symbol` (RepoMap), `list_files`, `stage_edits`, `view_staged`, `discard_staged`, `run_command`, `submit_for_review`. Schemas accept single or batched arguments because Groq validates tool arguments strictly. Each result carries the model-call budget |
| Staging | `agent/staging.ts`: in memory; exact unique anchors; trailing-whitespace and uniform-indentation slips repaired; misses return the closest real lines; new files supported |
| Commands | `agent/commands.ts`: argv only (no shell), executable allowlist, disposable snapshot with staged edits, credential-free environment, timeout, bounded output, macOS `sandbox-exec` with network and outside writes denied |
| Sessions | `core/session.ts`: streams text, reasoning and tool events; TrueForge approval drives review; the call cap counts completed responses only |
| Routing | `core/router.ts`: waits out short 429s using Retry-After (up to 65 s), backs off on 5xx and network errors, retries malformed tool calls once, switches on credential, quota, availability and size failures, and blocks a provider after a credential or quota failure. A switch uses `sessions.update(agent.spec)` and `previousTurnId`, so it continues **the same session** |
| Budgets | `core/profiles.ts`: "tight" profile for `forge.tightBudgetProviders` (default `groq`): 2.2k-token pack, compaction at 5.2k. "Standard" profile: 7k pack, compaction at 40k |
| Review | `review/reviewController.ts`: one diff tab per file and per-hunk selection in the sidebar; re-reads targets at apply time and refuses if they changed; one `WorkspaceEdit` plus save; explicit Undo |
| Inline edit | `inline/inlineEdit.ts`: any selection plus a typed instruction, ⌘⌥K; approval-gated `propose_edit`; a guard sends truncated or signature-less proposals back to the model; prose replies are parsed as a fallback |
| UI | `ui/sidebar.ts` and `media/forge.js`/`.css`: context card, streaming "Thinking" blocks, markdown, tool cards (status, duration, expandable output), retry/fallback/compaction banners with countdown, review card with verification badge, Undo, TrueForge session link, `@file`/`@symbol` mentions, model picker, Stop/Esc |
| Agent definitions | `trueforge/agents/forge-agent.json` and `forge-inline.json`, exported from the same builders as the live specs (`extension/scripts/export-agents.mjs`) |

## TrueForge findings (measured)

- **No built-in model fallback** in server 0.185.1 or SDK 0.185.0, so the extension decides when to switch and TrueForge executes every call.
- **A session created from a named agent cannot change its agent** (`422: Session … is named; agent cannot be updated`). Sessions are therefore created with an inline spec.
- **Code Mode works in standalone mode** ("Local sandbox fallback is available" on darwin) and exposes an `exec` tool. Per-request harness tokens rise from **213 to 1,978**. On Groq's 7,000 input-tokens-per-minute free tier this cuts throughput about 3×, so Code Mode is opt-in (`forge.codeMode`) and batched MCP tools are the default.
- **Per-request token breakdowns** (`harness`, `instructions`, `toolDefinitions`, `messages`) are reported in streamed usage; agent mode used 845 / 315 / 783 tokens of fixed overhead per request.
- **`groq/gpt-oss-20b` fails on its second call**, because TrueForge sends `reasoning_content` back to Groq, which rejects it. This is a candidate harness PR for Round 2.
- **Free-tier conditions observed:** Gemini Flash and Flash Lite returned 503 repeatedly; `gemma-4-31b-it` reached its daily quota; `groq/llama-3-3-70b-versatile` returned 404 on this key; Groq Qwen worked in about 1 s but rejects any single request above about 7k tokens; OpenRouter free worked but routes to varying models.

## Live results (TrueForge 0.185.1, free models, cost $0)

| Run | Models (in order) | Result |
|---|---|---|
| Task A, exact instruction, `get_debug_flag` lines 28–33 (session `01m7t9npra2sn7zwpjs118syv5`) | `groq/qwen-3-8-27b` | First proposal dropped the definition line. The guard rejected it automatically and the model corrected it in the same turn: 2 hunks (docstring; `{"0","false","no","off","n"}`). **2 model calls, 3,622 input / 394 output tokens, 1.4 s** |
| Task C, broken primary plus fallback | `forge-demo-broken/unreachable` → `groq/qwen-3-8-27b` | `ECONNREFUSED`, retry after 2 s, automatic switch in the same session, correct 2-hunk edit in **3.9 s**; worktree clean |
| Task C, broken model only | `forge-demo-broken/unreachable` | Retry with backoff, then a clear error; no tool calls; **0 files changed** |
| Task B run 1 (`01m7t8jdwcyd1rwa88pj68zd6v`) | Qwen → Gemma | Exposed: the named-session 422, a strict Groq schema rejection, and per-minute 429s. Fixed |
| Task B run 2 (`01m7t8mgz7qvvc9jmme4ek9dx9`) | Qwen → Gemma | Two batched reads, then a Groq wait above the cap (37 s) and Gemma's daily quota. Wait cap raised to 65 s |
| Task B run 3 (`01m7t8q02bchb9a2bkr4rzeza5`) | OpenRouter free | 25 calls, 21 tools, 414k input tokens; staged a correct `config_command` and registration; stopped at the cap before test and docs |
| Task B run 4 (`01m7t9dbdp59pvw0ykqb28acb4`) | Gemini Flash → Groq Qwen → OpenRouter free | Gemini 503 ×3 (retried with backoff); switched to Groq, which rejected the request as too large (413); switched to OpenRouter. **6 hunks across `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst`**. 25 calls, 23 tools, 389k / 12.6k tokens, 198 s. Stopped at the cap right after staging |

**Offline check of run 4's proposal** (applied to a temporary copy of the worktree, with no model calls):
- `flask --help` lists `config  Show the app's config as JSON.`
- `flask config` masks `SECRET_KEY`, `SECRET_KEY_FALLBACKS`, `API_TOKEN` and `DB_PASSWORD`, and keeps `PUBLIC_NAME`.
- `pytest tests/test_cli.py -q`: **58 passed, 1 failed**. The model's new test calls the `runner` fixture without requesting it (`AttributeError: 'FixtureFunctionDefinition'`).

The implementation is correct; the test is not. Running the test before review would have caught this, but the run ended before `run_command`.

Compared with v1's one success (85 responses, 1.22M input tokens, a checkpoint resume and a manual apply), v2 reaches a three-file proposal in about 25 responses and about 390k tokens on the weakest free router, without resume machinery. Weak free models still mostly make one tool call per response despite the batching guidance.

## Automated checks

- `npm --prefix extension run test:unit`: **15 passed** (offline). Covers failure classification, Retry-After parsing and the routing policy; candidate ordering and redaction; budget profiles; line diff and selective apply; staging (exact, ambiguous, repaired, missing with hint, new file, path escape); the workspace boundary and outline; context-pack ranking and budget; sandboxed `run_command` against staged edits with the workspace untouched and the allowlist enforced; inline-edit selection, prose parsing and the replacement guard; and, with a fake TrueForge, same-session fallback, approval-driven review with an early finish, and cancellation without a switch. Also the existing workspace MCP test.
- `npm --prefix extension test` (VS Code 1.146 extension host): **7 passed**. Activation and commands; unreachable backend; applying only the accepted hunk plus save plus undo; reject writes nothing; refusal when the file changed during review; new file plus undo; cancel during review writes nothing.
- **UI:** the real `media/forge.js`/`forge.css` were rendered in a headless browser with VS Code Dark theme variables and the run 4 event stream. The context card, banners, tool cards and review card rendered without script errors. Path truncation and an empty text block were fixed. A real Extension Development Host run could not be screenshotted here (no screen-recording permission).

## Addendum: verification gates and the end-to-end Task B pass (20 November 2026)

**Changes made after run 4's broken test:**
- **Automatic verification after every `stage_edits`.** Forge infers the tests (staged test files plus `test_<module>.py` for staged modules) and runs them in the sandboxed snapshot without a model call. The result goes back to the model and to the review badge.
- **Baseline-aware verification.** The same command runs once on the unmodified snapshot, and only *new* failures count.
- **Completion gates on `submit_for_review`.** These cover failing verification, a request asking for tests or docs with none staged, and unverified changes. Each gate fires once.
- **Duplicate-insertion guard.**
- **Path-filter widening** when a filter hides every match.
- **Hard finishing guidance** when four or fewer model calls remain.
- **Quota failures now rule out only the failing model.** Gemini quotas are per model; credential failures still block the whole provider.
- **A JSONL event log per run.**
- **A code graph.** The RepoMap focus is anchored to the best lexical implementation file. The callers, callees and tests neighbourhood is added to the context pack and drawn in the sidebar.
- **UI restyle.** Tool rows now use a `⏺` bullet with a `⎿` result line.

**A root cause found by a live run.** `test_load_dotenv` failed only inside the snapshot, because the snapshot dropped the committed fixtures `tests/test_apps/.env` and `.flaskenv`. Committed dotenv files are now copied into command snapshots only; the agent still cannot read them. The snapshot baseline went from 57 passed / 1 failed to **58 passed**.

**Live Task B through the real VS Code extension** (Extension Development Host, sidebar run path, TrueForge, review controller). The review was approved by a script (`FORGE_UI_AUTO_ACCEPT=1`), not by a human click.

| Run | Outcome |
|---|---|
| Extension run 1 (Gemini 3.1 Flash Lite) | Completed, but wrong: 2 files only, `config_command` inserted twice, `cli.add_command` three times, and the new test failed (exit 2). This motivated the duplicate guard and the gates |
| Extension run 2 (Gemini 3.5 Flash Lite, session `01m7tbakv6wx4zn39rhggh3smn`) | 3 files, **59 passed**, `config` in `--help`, masked JSON. 33 model calls, 620k input tokens; about 10 calls were lost to the snapshot-only dotenv failure, since fixed |
| **Extension run 3** (session `01m7tbsk97s2q2nhe2k0ydakrg`, evidence `reports/evidence/task-b-v2-run.jsonl`) | Gemini 3.5 Flash Lite returned 503 four times, with backoff retries, then switched **automatically, in the same session**, to Gemini 3.1 Flash Lite. Auto-verify flagged a failing new test (58 passed / 1 failed); the model repaired it (**59 passed**) and documented the command. Review: 4 hunks in 3 files. **Official checks on the saved files:** `pytest tests/test_cli.py -q` → 59 passed; `flask --help` lists `config`; `flask config` → `SECRET_KEY`, `API_TOKEN`, `DB_PASSWORD` = `***`, `PUBLIC_NAME` kept. **Undo** via the extension restored 3 files, and `git status` was empty. 29 model calls, 23 tool calls, 412k / 6.2k tokens, **3.8 minutes, $0** |

Suites after these changes: **19 offline unit tests** and **7 extension-host tests** passed.

## Not yet done

- A Task B run in which a human clicks Accept in the sidebar. The automated runs above used a scripted approval.
- An on-screen demonstration of a cancelled live run with a clean `git status`.
- The video, the PDF write-up, a root `LICENSE` file, a Git remote, and commits of v2.
- Linux has no OS-level confinement for `run_command`. Windows is untested.

This is evidence of the tested paths, not a production-readiness claim.
