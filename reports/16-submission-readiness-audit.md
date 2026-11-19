# Forge readiness and submission audit

19 November 2026. This assessment distinguishes implemented behavior, controlled tests and live competition proof. The scores in `task.md` are awarded by judges from a recording and write-up; this document does not predict a numerical score or claim a 100/100 result.

## Git baseline

The project root was initialized as a new `main` repository. The initial staged snapshot includes source, tests, reports, lockfile, example agent definitions, third-party license notices, the benchmark reference patch and reproducible scripts. It excludes the separate Flask fixture, disposable worktrees, dependencies, VS Code test downloads, private session transcripts and state files. A basic token/private-key pattern scan over candidate files found no matching files; this is not a complete secrets audit. No Git remote has been configured. Raw session evidence remains local and links to it in reports will not resolve in a fresh clone unless sanitized evidence is deliberately provided. Git is configured locally with the supplied GitHub username and its account-specific GitHub no-reply email; inspect `git log` and `git status` for the current snapshot.

## Strengths to build on

- **TrueForge integration:** the extension creates TrueForge agents, sessions and turns, streams events, and exposes workspace capabilities as MCP tools. A live Task A run succeeded through TrueForge; the extension does not call model providers directly. Selective tool preloading and optional compaction are implemented.
- **Safety:** candidate edits are staged in memory, checked against observed unique source anchors, verified in an isolated copy, shown as diffs, and gated by explicit approval. Multi-file review supports per-hunk selection, stale-buffer checks, cancellation, rollback and recovery. These are valuable foundations; scripted tests are not a substitute for the requested live demonstration.
- **Retrieval:** the investigator finds relevant implementation, test and documentation candidates; RepoMap supplies symbol lookup and inferred static relationships. Bounded responses, source hashes, repeated-search detection, and checkpoints reduce avoidable rediscovery. Model/agent decisions stay with TrueForge.
- **Testing and evidence:** the most recent full safety suite passed 60 tests, and the VS Code host suite passed 31. The reference Flask solution passed 59 CLI tests and the isolated verifier. The successful reference and scripted offline simulation are not autonomous agent success. Live token and failure records are available locally.
- **Task A:** a prior live agent proposal was reviewed, explicitly approved and passed the specified Flask check; see `06-task-a-vertical-slice.md`. It should be re-demonstrated on the final build.

## Gaps against competition criteria

| Criterion | Current evidence | Gap for full demonstration |
|---|---|---|
| Inline edit | Prior live Task A passed with diff and approval | Repeat on final build and show review and verifier clearly. |
| Multi-file agent | Local staged-edit, verifier and review simulation passes | No live autonomous three-file Task B patch, validation, diff or approval has occurred. |
| Streaming and cancellation | Live streaming and automated cancellation guards | Show a live cancelled turn and clean workspace in the final editor. |
| Context assembly | File investigation, optional RepoMap, bounded context and references exist | Prove the agent uses useful evidence, identifies files with reasons and completes Task B efficiently. RepoMap use and token savings are not proven in the latest run. |
| Per-hunk safety and undo | Automated review, transaction, rollback and stale-edit tests | Show real Task B diff, selective review and working undo in the final editor. |
| Resilience | Mocked bounded retries/fallback; an actual Task B 503 triggered an OpenRouter fallback | The official Task C is Task A under a deliberate provider failure. Demonstrate that specific flow and clean Git status. |
| TrueForge depth | Real sessions, MCP and selective preload | Show the actual Task B session and meaningful TrueForge context feature in the recording. |
| Video and write-up | Technical reports exist | Produce public <=4-minute A/B/C video and a 1–3 page PDF with required headings, honest scorecard, costs and timestamps. |

## Why Task B is stopping

The last bounded run (`google-gemini/gemini-3-5-flash-lite`) found likely implementation, test and documentation files, but used 24 completed responses on navigation and hit the configured iteration limit without a staged hunk. It requested 16 searches and 6 reads after one investigator call; three searches repeated prior queries. TrueForge reported 143,290 input and 832 output tokens; the count may include cached input and is not a price. The preceding OpenRouter run also reached 24 responses without staging. Earlier failures included provider rate limits and an unavailable `rg` in the GUI environment; the latter now has an in-process fallback. The exact relative contributions of model ability, tool descriptions, evidence quality and orchestration remain unproven. The scripted test demonstrates that the current patch/verification pipeline can process a known solution, not that a model can generate it.

## Production and submission blockers

1. **Autonomous reliability:** achieve and repeat a real Task B run that stages at least three independently discovered files, passes the isolated checks, opens diffs and waits for human decisions. Analyze actual tool arguments and rejection reasons instead of only increasing iteration limits. Compare configured tool-calling models on a fixed bounded protocol and budget.
2. **General-purpose capability:** `RepositoryContext` requires the exact pinned Flask commit and a clean linked worktree; verification is Flask-specific, macOS-specific, and requires at least three files. There is no general model-invocable terminal-command MCP tool. Separate competition verification from general workspace behavior, design safe command execution/approval, and test multi-root, dirty-file, path, cancellation and cross-platform behavior. Do not weaken review boundaries.
3. **Resilience proof:** demonstrate official Task C with an intentionally unreachable provider or bad key, responsive editor, visible error/fallback, and unchanged files; then rehearse final Task A and B/C in the same build.
4. **Reproducible delivery:** root Git has no remote yet. The project has no root license file even though the package declares MIT; choose and add an appropriate project license while retaining upstream notices. The current setup script expects an already-existing ignored Flask fixture and the README contains machine-specific paths and historical text; make clean-clone setup reproduce the pinned fixture and required venv without local state. Verify `npm ci` and extension launch from a clean clone. `git diff --cached --check` currently reports pre-existing blank EOF/trailing whitespace and context lines inside the reference patch; handle it deliberately before enforcing it as a CI gate.
5. **Submission:** publish a permitted public repo, write the required 1–3 page PDF under the eight prescribed headings, provide model/provider/cost and third-party attribution, record A/B/C in order with on-screen verifiers and TrueForge Task B session, and supply accessible links. Do not claim unobserved behaviors or use the offline patch as model context.
6. **Product polish:** verify sidebar and diff in narrow/light/dark layouts, durable session history, actionable error/retry/cancel feedback, accessible controls, and undo focus. Current history is in-memory, mention attachments are references, and Markdown support is limited. These matter after the core live task works.

## Recommended order

Secure an initial Git commit with the correct author; fix clean-clone and project-license requirements; improve and measure the model-to-patch transition using bounded test cases; run Task B end to end; run Task C and recheck Task A; then record and prepare submission materials. Product-wide generalization can run alongside submission work only if it does not destabilize the fixed-task path.
