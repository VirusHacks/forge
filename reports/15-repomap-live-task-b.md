# Live Task B attempt with RepoMap

19 November 2026. **Result: Task B did not complete.** One requested run used a Gemini primary and one automatic OpenRouter fallback. Both exhausted the 4,000 estimated repository-token budget before staging a patch. No proposed edit reached verification, diff review or approval; the disposable worktree and pristine fixture remained clean at `22d9247`.

## Observations

| Session | Model | Completed model responses | Input / output tokens reported | Workspace tool starts | Result |
|---|---|---:|---:|---|---|
| `01m7sn3ns3gph4qpbz69cbrsqf` | `google-gemini/gemini-3-5-flash-lite` | 21 | 111,894 / 615 | investigate 1, search 12, read 5, find_symbols 3 | Repository retrieval budget exhausted after 74.810 s |
| `01m7sn5ymtmnbsfbkdmfxd7enh` | `openrouter/openrouter-free` | 15 | 90,440 / 1,639 | get_run_state 1, search 2, read 15 | Repository retrieval budget exhausted after 28.205 s |

Total: 36 completed responses, 202,334 reported input and 2,254 reported output tokens; 39 workspace-tool starts; one model switch; zero SDK retries; zero staged hunks; zero validation attempts. Token counts include any cache reads represented in the SDK's input totals and are not a billing figure. Rejected or provider-internal requests may not be visible.

The first `investigate_repository` selected `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst` with reasons. A live `find_symbols` call located `routes_command` at `src/flask/cli.py:1069` and `FlaskGroup.__init__` at `src/flask/cli.py:563`. RepoMap's tool therefore operated in a real TrueForge turn. The model still made repeated searches and reads, consumed its retrieval budget without staging, and the automatic fallback resumed with the original objective. The fallback read additional ranges and likewise staged nothing. Discovery and fallback worked; the desired agent behavior and cost efficiency did not.

The launcher compiled the extension before the run. The official Flask verifier was **not run against a candidate**, because no candidate existed. No diff opened and no approval was requested. The final private checkpoint records an interrupted task with no staged hunks; it must not be mistaken for an accepted patch.

Raw event evidence: [1795083586922.jsonl](evidence/task-b/1795083586922.jsonl). The associated private `.state.json` contains source context and should not be shared without review. Actual input and output totals above are taken from `usage.completed`, which fetches saved completed messages; the terminal `metrics` entries report zero token totals for the cancelled turns and should not be used as evidence of zero usage.

## Next engineering question

The bottleneck is now the models' navigation and staging behavior, rather than missing repository search or lack of fallback. Before another paid or rate-limited run, inspect the actual tool arguments and saved checkpoint to find why relevant excerpts did not lead to `stage_edit`; then change the retrieval/prompt or choose a demonstrated tool-calling model and evaluate with a controlled, bounded run. Do not claim a RepoMap token saving from this test.
