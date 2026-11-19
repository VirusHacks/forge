# Task B execution optimization

19 November 2026. **Status: offline reference and scripted simulation pass; live autonomous Task B remains incomplete.** The live result below predates the final small-response and overlap-safety adjustments; those final adjustments have deterministic test coverage but have not had a second live run.

## Reference implementation (evaluation only)

The reference was written by hand in `/private/tmp/forge-task-b-reference-codex`, a disposable clone of Flask 3.1.3 at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. It is **not production agent context**. The reference diff is saved at [evidence/task-b-reference.patch](evidence/task-b-reference.patch) solely to reproduce the offline simulation. It changes three tracked files, 35 insertions:

- `src/flask/cli.py`: `FlaskGroup.__init__` registers a command beside existing built-ins (reference lines 595–598); the new app-context command is at line 1060. The reference serializes configuration, replacing values for matching sensitive keys; `default=str` preserves non-native values as strings.
- `tests/test_cli.py:706`: test checks JSON, public value, all four sensitive categories, and help visibility.
- `docs/cli.rst:559`: documents the command and masking.

Reference test: `PYTHONPATH=/private/tmp/forge-task-b-reference-codex/src <venv>/bin/python -m pytest tests/test_cli.py -q -p no:cacheprovider` -> **59 passed**. With a temporary app, `python -m flask --app <app> --help` listed `config`; `flask ... config` returned `PUBLIC_VALUE=visible` and `***` for `SECRET_VALUE`, `DB_PASSWORD`, `API_TOKEN`, and `API_KEY`. The existing isolated verifier also accepted this three-file candidate during the scripted test, checking the CLI test suite, help, and masked JSON for both app factory and instance. This is not evidence that an LLM authored or reviewed the patch.

## Implementation

- The existing `investigate_repository` remains the MCP entry point. It now returns role-ranked paths, file-selection reasons, SHA-256 versions, exact bounded ranges, navigation and missing-evidence hints. The existing local RepoMap symbol search/context is used only if direct implementation navigation is missing and budget permits; failure retains the direct-search fallback. Relationships are inferred, not verified. The agent remains free to choose tools and edits.
- Full-versioned search results are cached in memory per workspace and query; repeated identical searches return compact references until a tracked source changes. Fully contained explicit reads are summarized; partial overlaps are logged; implicit continuation is still available. The investigator avoids overlapping navigation excerpts. No search is blocked.
- Evidence hashes, source excerpts, selected-role rationale, task, staged hunks, validation results and stage are carried in the existing checkpoint. On restore, evidence is checked against exact file version and location. The search cache itself resets for a new model; a fallback receives the persisted state rather than an invisible cached answer. Restored proposals need revalidation and fresh human approval.
- Investigator responses respect the configured character limit as valid JSON. Only actually delivered excerpts authorize observed-anchor staging, including when output must be reduced. Existing validation, review, cancellation and undo boundaries remain.
- Instructions are short and ask for investigation, missing evidence, patch, isolated validation, repair and review. No Flask path or solution was added to production logic.
- The live host now passes `forge.taskBIterationLimit` (or validated `FORGE_ITERATION_LIMIT`, 1–64) and the compaction setting through. TrueForge selectively preloads essential tools; other tools stay deferred. The default remains 24. The test run reserved 4,000 output tokens, used a 24,000 estimated input limit and 32,768 declared window, and left compaction disabled. Existing provider fallback stays bounded; this controlled run had no fallback and no retry.

## Measurements

The previous OpenRouter session found the three files, made 24 completed model responses, 23 workspace tool starts, and reported 171,212 input / 3,046 output tokens, then hit the iteration limit without a patch. See [prior evidence](evidence/task-b/1795084010420.jsonl).

The new controlled live session `01m7sphvv84q1fc8wndt834t2y`, model `google-gemini/gemini-3-5-flash-lite`, returned the relevant three file candidates in one investigator call. Before the final overlap adjustment, that investigator returned 5,080 characters and used an estimated 580 repository tokens; two of its implementation excerpts overlapped and are now deduplicated. The run made **24 completed model responses**, **23 workspace tool starts** (1 investigator, 16 searches, 6 reads), with 3 repeated search events and 4 repeated excerpt events. It used an estimated 3,652 repository tokens and reported **143,290 input / 832 output tokens**; provider input totals may include cached tokens and are not a billing figure. No `find_symbols`, `get_symbol_context`, `trace_symbol`, or dynamic tool-discovery invocation was recorded in the extension's event log; absence of dynamic-discovery records is not proof of zero internal harness discovery. There were zero staged hunks, validation attempts, SDK retries and model switches. It stopped with `You have reached iteration limit of 24`; time was 83 seconds. [Raw event evidence](evidence/task-b/1795085100488.jsonl).

The two live runs used different models and settings, so these totals are **not a controlled before/after efficiency comparison**. The new run does not demonstrate autonomous completion, a lower token bill, or graph use. The checkpoint is private and should be reviewed before sharing.

## Verification

- `npm run test:safety` with the reference simulation environment below: **60 passed, 0 failed**, including local HTTP MCP, RepoMap, cancellation, version invalidation, response limits, and approval guards.
- VS Code extension-host `npm test`: **31 passed**, rerun after the final bounded-response and overlap adjustments.
- Scripted simulation: an offline deterministic driver reads the oracle patch, calls the real MCP tools to investigate, read and stage each unique anchor, receives an injected compact failure, repairs and calls the existing isolated verifier, then reaches the gated review. Submission is rejected before simulated approval; workspace git status remains clean. This is explicitly a **simulation**; no live model participated.
- Pristine fixture and disposable agent worktree were clean after the live and simulation runs. No patch was applied by the agent.

## Reproduction

Run from the project root on macOS with the existing Flask venv and the pinned linked worktree. The reference patch is used only by the offline test; never include it in the agent's prompt or repository context.

```sh
npm --prefix extension run compile
FLASK_TASK_B_REPO="$HOME/.codex/worktrees/flask-task-b-agent/flask-3.1.3" \
FORGE_REFERENCE_PATCH="$PWD/reports/evidence/task-b-reference.patch" \
  npm --prefix extension run test:safety
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm --prefix extension test
```

Recreate and check the reference outside the worktree (choose a new empty destination):

```sh
git clone --no-hardlinks --branch 3.1.3 fixtures/flask-3.1.3 /private/tmp/forge-reference-repro
git -C /private/tmp/forge-reference-repro apply "$PWD/reports/evidence/task-b-reference.patch"
PYTHONPATH=/private/tmp/forge-reference-repro/src "$PWD/scratch/flask-task-a-agent-venv/bin/python" -m pytest /private/tmp/forge-reference-repro/tests/test_cli.py -q -p no:cacheprovider
```

The controlled live command used `TRUEFORGE_MODEL=google-gemini/gemini-3-5-flash-lite`, an empty `TRUEFORGE_FALLBACK_MODELS`, `FORGE_FREE_ONLY=true`, `FORGE_PROVIDER_MAX_RETRIES=0`, `FORGE_CONTEXT_BUDGET=8000`, `FORGE_MAX_INPUT_TOKENS=24000`, `FORGE_MAX_OUTPUT_TOKENS=4000`, `FORGE_MODEL_CONTEXT_WINDOW=32768`, `FORGE_ITERATION_LIMIT=24`, and `npm --prefix extension run task-b:live` with `FLASK_TASK_B_REPO` as above. Model quotas and charges depend on the provider account. Do not approve any proposal without reviewing its diff.

## Remaining blockers

The main blocker is the model's failure to advance from discovery to staging, even with the new bundle. A better specific tool-calling model and/or further improvements to actionable evidence and feedback need a new bounded evaluation. Raising the iteration limit alone is not established to fix this. Repeated-query caching is in-memory, and hashing the tracked corpus on each search has a CPU cost; benchmark this for larger repositories. The one live run was made before the final response-size and overlap fix. No autonomous three-file patch, official verification of an autonomous candidate, or human approval has been demonstrated.
