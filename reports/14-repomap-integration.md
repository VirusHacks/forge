# RepoMap integration and Flask benchmark

Updated 19 November 2026. This is a deterministic local comparison, not an end-to-end model success or a claim of token savings.

## Decision

RepoMap adds useful symbol ranges and static relationship hints; it complements Forge's existing investigator. It should not replace broad file discovery: in this benchmark the existing investigator found the Task B implementation, tests and docs in one call, while RepoMap's first five hits for `test CLI config` did not include `tests/test_cli.py`. Whether the combined system reduces model calls, input tokens or failures remains unmeasured.

## Attribution and dependency

- Official repository: https://github.com/SylphxAI/repomap; inspected source commit `0195f264a08b296801025926d5e94449abfe5c5e`.
- `@sylphx/repomap` **1.9.0** is pinned in `extension/package.json` and lockfile; npm installs the corresponding platform-specific native binary. MIT license, copyright SylphxAI; see `third_party/repomap/LICENSE` and `THIRD_PARTY_NOTICES.md`. The inspected checkout identifies itself as version 1.9.0; we did not independently verify that its commit is the npm release's exact source revision.
- Native stdio MCP tools used: `search`, `context`, `trace`, `impact`. Forge uses the existing MCP SDK stdio client and its existing loopback HTTP MCP server. No graph implementation, database, second agent loop or provider client was added. `REPOMAP_EMBED=0` disables the optional embedding-model download; search is local keyword/AST-based.

## Architecture and safety

`TrueForge → Forge HTTP MCP → TaskBTools → one reusable RepoMap stdio process`. The three new tools are:

1. `find_symbols(query)` wraps `search`; returns bounded ranked symbols, actual source-line snippets and opaque `path:line#sourcehash` IDs. Scores are ranking values, not confidence probabilities.
2. `get_symbol_context(symbol_id)` wraps `context` and Forge's bounded reader. It verifies the current file hash and returned location, adds the actually delivered excerpt to Forge's observed-anchor set, and returns callers, callees and related test candidates.
3. `trace_symbol(symbol_id, depth=1)` wraps `context`, caller and callee `trace`, and `impact`; depth is capped at two. It checks source paths and line numbers and includes source-line text where available. Graph edges and impact remain **statically inferred**. `referenceMatch` only indicates whether a symbol name appears in the source line; it is not proof of a runtime call.

RepoMap indexes a private mode-0700 mirror containing only regular, tracked, non-sensitive text files already permitted by Forge, up to 256 KiB each. Hidden paths, credentials, untracked files, symlinks, binary files and common dependency directories are excluded by the existing workspace boundary. A regular `.repomapignore` of at most 8 KiB is copied into the mirror and applied by RepoMap; changes to it trigger a refresh. Only the mirror and a private temporary cache are given to RepoMap; its subprocess environment excludes provider credentials. Mirror contents are hashed on each lookup. If allowed tracked file contents change, only changed mirror files are updated, deleted files removed, and the process restarts so locations are fresh while RepoMap may reuse per-file cache. Hash-bound symbol IDs are rejected after source changes. Each Task B run owns its own root/index and disposes it at completion; it remains alive across tool calls and model fallback within that run. If the host crashes, temporary files may remain in the OS temporary directory.

Results share Forge's configured repository token budget and tool-result limits; symbol summaries are recorded in the existing private checkpoint. `find_symbols` is selectively preloaded; `get_symbol_context` and `trace_symbol` stay deferred. The agent decides whether to invoke them. If RepoMap is unavailable or disabled, `find_symbols` uses existing tracked-file search; context falls back to a bounded read for a valid ID; trace reports relationships unavailable rather than inventing them. `forge.repoMapEnabled` and `forge.repoMapMaxResults` control use and result count.

Forge's existing Task A command continues to use its two existing read-only tools; the new tools are attached to Task B's MCP server. The Task A function was benchmarked through the new index, but a Task A model turn has not been changed to use RepoMap. The Task B validator still requires the pinned clean Flask worktree and official three-file verification. A newly tracked file list requires a new run; existing tracked-file changes are refreshed on lookup.

## Measurements

One local run on the clean linked worktree at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`; see [raw evidence](evidence/repomap-benchmark.json). Estimates are UTF-8 JSON bytes divided by three, not model tokenizer counts. Latencies are one observation on this machine, not a statistical comparison.

| Operation | Time | Result | Estimated response tokens |
|---|---:|---|---:|
| Existing Task B investigator | 146.1 ms | `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` | 929 total; 366 source excerpt |
| RepoMap cold `get_debug_flag` search | 146.5 ms | `src/flask/helpers.py:28–33` first | 667 |
| RepoMap warm full Task B request search | 22.5 ms | `FlaskGroup`, `src/flask/cli.py:531–696` first | 742 |
| RepoMap warm `add_command` search | 22.2 ms | `FlaskGroup.__init__`, `src/flask/cli.py:563–598` first | 645 |
| RepoMap warm `test CLI config` search | 21.2 ms | Top five did not include `tests/test_cli.py` | 592 |
| Task A symbol context | 20.4 ms | Function body; test candidates include `tests/test_helpers.py` | 780 |
| Task A trace and impact | 69.3 ms | Five caller candidates, labeled inferred | 787 |

One RepoMap subprocess served all benchmark queries. No model calls were made, so **model input tokens and live model/tool-call savings cannot be compared**. The listed operations answer different questions: the existing Task B investigator is one broad call; a symbol search, context and trace are three Forge calls backed by six native calls (one search, one context, and four inside trace). Preloading an additional tool also has schema overhead. The earlier real Task B run's 171,598 input / 2,401 output tokens across five sessions was a different run with search failures and is not a controlled comparison.

## Tests

- `npm --prefix extension run test:safety`: 52/52 passed, including real RepoMap over HTTP MCP; tracked/sensitive/untracked exclusions; process reuse; stale IDs and changed-file reindex; separate workspace roots; disabled-index fallback; bounded valid JSON; and pre-cancelled startup.
- VS Code extension-host regression suite: 31/31 passed, including Task A and multi-file approval guards. No live model run was made after integration.
- The pinned fixture and disposable worktree were clean at the final check.

## Reproduce

From the project root:

```sh
npm --prefix extension ci
npm --prefix extension run compile
node scripts/benchmark-repomap.cjs /absolute/path/to/clean/linked/flask-worktree
npm --prefix extension run test:safety
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm --prefix extension test
```

Use Flask 3.1.3 at the pinned commit. The benchmark creates a private temporary mirror and removes it when finished; it does not call a model or modify the Flask worktree. To test through the extension, reload the development host, start TrueForge, open a clean disposable worktree, and run Task B. Inspect `find_symbols` and related tool activity in the expandable sidebar. Do not approve a patch until reviewing the existing diff and verifier output.

## Remaining work

No live TrueForge Task B run has yet exercised the new schemas, graph tools, fallback or output budget together. No Task B end-to-end success, lower token usage, improved solve rate or cross-language graph accuracy is established. Relationship results can miss calls, follow aliases incorrectly, or rank irrelevant tests; verify cited source. Platform binaries are optional npm packages, so a missing or unsupported binary uses Forge's existing retrieval fallback. A persistent index across separate runs and automatic indexing of newly tracked files are not implemented.

## Subsequent live Task B run

A later user-requested live run exercised RepoMap through TrueForge but did **not** complete Task B: both the Gemini primary and OpenRouter fallback exhausted their 4,000-token retrieval budgets before staging a patch. The agent found relevant files and symbols, but repeated navigation remained costly. Actual calls, tokens and session IDs are in [the live test report](15-repomap-live-task-b.md). This run does not demonstrate lower model usage or a successful Task B solution.
