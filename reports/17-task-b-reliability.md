# Task B reliability: live staging and verification

19 November 2026. **Task B is not yet successful.** The TrueForge agent independently staged a three-file proposal in memory and invoked the isolated Flask verifier, but all three verifier attempts failed the same newly added test. No proposal reached a VS Code review and no workspace edit was applied. The clean fixture and linked worktree remain available.

## Diagnosis and changes

The previous 24-response session never called the available single-hunk patch tool and requested a 60-line read that was rejected by the 40-line MCP schema. It repeatedly searched/inspected documentation rather than staging. The new live attempts reveal additional, distinct problems: some anchors spanned multiple overlapping excerpts; early invalid validation requests incorrectly consumed the three-verification allowance; and resumed models reconstructed incorrect staged text or submitted hunks to validation instead of verifying the saved proposal. Once a real proposal was verified, its new test expected `DEBUG=True` but the CLI run produced `False`; the model repeatedly modified implementation rather than resolving that test failure. These findings do not prove that any single change guarantees another model will finish.

- Added atomic multi-file `stage_patch` with exact unique anchors, a generic schema example, actionable errors and no disk writes. `stage_edit` remains available for compatibility. Repairs can target one unique occurrence inside an existing staged replacement; ambiguous matches are rejected.
- Added `verify_patch` with no arguments for the current staged proposal. `validate_edits` remains available as a legacy tool. Final approval still uses the existing TrueForge `submit_review` boundary, diff viewer, per-hunk selection, and explicit save.
- `get_run_state` can page through a staged replacement using `stagedIndex` and `textOffset`, helping a resumed model inspect its actual proposed code instead of inventing it. Checkpoints remain private and require revalidation and new approval.
- Exact anchors covered by multiple uniquely located overlapping delivered excerpts may be staged; unseen gaps and ambiguous evidence remain rejected. Oversized read requests are capped with a continuation hint instead of failing the MCP schema.
- The existing investigator supplies bounded versioned source, import and role evidence, optionally uses RepoMap when direct evidence is missing, and returns a compact no-new-evidence message on repeated investigation. Repeated navigation is counted in run state. This did not demonstrably eliminate the live loop.
- Essential MCP tools are selectively preloaded. The live session also made one `list_tools` discovery call, so preloading did not eliminate all discovery. Compaction was configured but no compaction-finished event was observed. The model catalog reported a 1,048,576-token context window; the test used a 60,000-token estimated input cap, 8,192 maximum output tokens, and a 45,000-token compaction trigger. Cumulative input usage is not the size of a single context window.
- Forge's old default of 24 iterations is removed. The default is now **1,024**, the maximum accepted by the installed TrueForge schema; true unlimited iterations are not supported by that version. User cancellation, provider quotas, context budgets and verifier repair limits still apply. The terminal launcher supports `FORGE_RESUME_CHECKPOINT` and `TRUEFORGE_FALLBACK_MODELS=none`.

## Staging probe

A separate unrelated README edit was requested through TrueForge using `google-gemini/gemini-3-5-flash-lite`. The first temporary probe paused at TrueForge's default write-tool approval because the probe had omitted the extension's explicit staging policy; it was cancelled after 2 completed responses, 1,735 input and 130 output tokens. A corrected probe used the extension's in-memory staging policy and succeeded: 2 completed responses, 1,735 input and 129 output tokens; 1 `read_file`, 1 `stage_patch`, 1 in-memory README hunk, no file write. This proves basic tool usability, not Task B success.

## Live Task B attempts

| Run | Model / sessions | Completed responses | Reported input / output tokens | Result |
|---|---|---:|---:|---|
| Initial extended run | Gemini `01m7sr831mf001ga61ywthpk88`; OpenRouter fallback `01m7sr9cq7yn2k2dakx06yeqs4` | 23 + 33 | 296,771 / 1,009 + 251,164 / 2,340 | No patch; Gemini input-token-per-minute 429, then OpenRouter free daily 429. An empty fallback environment value was stripped by the host; the new explicit `none` option fixes this. |
| Targeted rerun | Gemini `01m7srjh41809as3kaptt1hd5v` | 28 | 422,112 / 4,118 | First `stage_patch` attempt at response 22; two anchor rejections; one CLI hunk staged at response 28, then input-token-per-minute 429. |
| Resume one file | Gemini `01m7srtebkdzb4b1gdn89mw08h` | 27 | 230,679 / 2,241 | Staged CLI and test hunks; two incomplete/invalid verification preflight errors, zero actual verifier runs; requests-per-minute 429. |
| Resume two files | Gemini `01m7srz1xgp7p5xkjrrmj8r7vf` | 35 | 438,867 / 6,428 | Staged implementation, tests and docs; verifier attempt 1 failed with 58 passing, 1 failing; input-token-per-minute 429 during attempted repair. |
| Resume three files | Gemini `01m7ss92wemm23ykp3xhxs7qw0` | 39 | 583,369 / 9,767 | Verifier attempts 2 and 3 failed the same test (58 passed, 1 failed each). Session cancelled after the three-check limit made further repair impossible. |

Task B total: **185 completed responses; 2,222,962 reported input and 25,903 output tokens** across six TrueForge sessions, excluding the separate staging probes. Provider-rejected requests and provider-internal retries may not be reflected; reported input can include cached tokens and is not a billing total. SDK retries were zero; the initial run made one automatic provider switch. The empty fallback value issue was fixed before later controlled runs.

The initial extended run recorded 12 investigator and 10 read calls on Gemini and 30 reads plus 1 run-state call on the fallback. The targeted rerun recorded 10 investigator, 15 reads and 3 patch calls. The final resume recorded 12 run-state, 17 read, 6 patch and 4 legacy validation calls. In the final resume, two validation calls failed preflight, while two actually ran the isolated verifier. Across the initial extended run the telemetry recorded 91 full-overlap and 13 partial-overlap events; these include internal investigator reads and are not all separate model calls.

The first two verification-preflight errors in the earlier resume were counted by the old code as attempts despite no isolated verifier call. For the next run only, a **private copy** of the checkpoint was adjusted from two to zero after checking that the session log had no `validation` event and no failed digest; the original checkpoint was preserved. The bookkeeping fix now increments only when verification starts.

The last checkpoint has five hunks across three files, three actual verification failures and no approval. It is private and intentionally excluded from Git. An earlier three-file checkpoint after verifier attempt 1 remains available locally at `reports/evidence/task-b/1795087629855.jsonl.state.json`; it has two repair attempts remaining if a later controlled model session is warranted. Do not treat either checkpoint as a passing patch.

## Final resumed session: tool-call trace

The table summarizes every completed model step's tool arguments and response. Patch arguments are represented by paths and character lengths to avoid placing the candidate solution into agent prompts or reusable instructions. Full exact calls and responses can be inspected locally with `node extension/scripts/task-b-trace.mjs 01m7ss92wemm23ykp3xhxs7qw0`; the generated raw trace may contain source and should be kept private. `source excerpt` means the response delivered text, not that it was necessarily new or useful; overlap events are logged separately.

| Response | Tool | Argument summary | Response | Evidence / staging |
|---:|---|---|---|---|
| 1 | `get_run_state` | `{}` | returned | n/a |
| 2 | `validate_edits` | `hunks=4; paths=docs/cli.rst, src/flask/cli.py, tests/test_cli.py` | tool error | n/a |
| 3 | `read_file` | `{"end_line":520,"path":"tests/test_cli.py","reason":"read test_host to get exact anchor","start_line":500}` | returned | source excerpt |
| 4 | `stage_patch` | `tests/test_cli.py original=385 chars replacement=1102 chars; src/flask/cli.py original=1189 chars replacement=1648 chars; src/flask/cli.py original=163 chars replacement=208 chars; docs/cli.rst original=275 chars replacement=445 chars` | tool error | n/a |
| 5 | `get_run_state` | `{"limit":6,"stagedIndex":3}` | returned | n/a |
| 6 | `get_run_state` | `{"stagedIndex":2,"limit":6}` | returned | n/a |
| 7 | `get_run_state` | `{"stagedIndex":4,"limit":6}` | returned | n/a |
| 8 | `get_run_state` | `{"stagedIndex":0,"limit":6}` | returned | n/a |
| 9 | `get_run_state` | `{"limit":6,"stagedIndex":1}` | returned | n/a |
| 10 | `validate_edits` | `hunks=4; paths=docs/cli.rst, src/flask/cli.py, tests/test_cli.py` | tool error | n/a |
| 11 | `read_file` | `{"end_line":150,"path":"docs/cli.rst","start_line":120,"reason":"read docs/cli.rst around Open a Shell"}` | returned | source excerpt |
| 12 | `stage_patch` | `tests/test_cli.py original=385 chars replacement=1029 chars; src/flask/cli.py original=67 chars replacement=831 chars; src/flask/cli.py original=163 chars replacement=208 chars; docs/cli.rst original=242 chars replacement=583 chars` | tool error | n/a |
| 13 | `read_file` | `{"reason":"read around routes_command and add_default_commands","end_line":1130,"start_line":1080,"path":"src/flask/cli.py"}` | returned | source excerpt |
| 14 | `read_file` | `{"start_line":1030,"reason":"read routes_command definition in src/flask/cli.py","end_line":1000,"path":"src/flask/cli.py"}` | returned | source excerpt |
| 15 | `read_file` | `{"reason":"read routes_command definition further","start_line":1000,"path":"src/flask/cli.py","end_line":1075}` | returned | source excerpt |
| 16 | `read_file` | `{"reason":"read where commands are defined or added","path":"src/flask/cli.py","start_line":950,"end_line":1010}` | returned | source excerpt |
| 17 | `read_file` | `{"end_line":1160,"start_line":1120,"reason":"find routes_command and add_command calls","path":"src/flask/cli.py"}` | returned | source excerpt |
| 18 | `read_file` | `{"path":"src/flask/cli.py","start_line":1080,"end_line":1119,"reason":"read lines 1080 to 1119 in src/flask/cli.py"}` | returned | repeated |
| 19 | `read_file` | `{"end_line":900,"reason":"read FlaskGroup implementation or add_command calls","path":"src/flask/cli.py","start_line":850}` | returned | source excerpt |
| 20 | `read_file` | `{"path":"src/flask/cli.py","end_line":450,"reason":"read FlaskGroup definition","start_line":380}` | returned | source excerpt |
| 21 | `read_file` | `{"reason":"read FlaskGroup init and add_command calls","end_line":500,"start_line":450,"path":"src/flask/cli.py"}` | returned | source excerpt |
| 22 | `read_file` | `{"end_line":600,"reason":"read FlaskGroup class definition","path":"src/flask/cli.py","start_line":501}` | returned | source excerpt |
| 23 | `read_file` | `{"path":"src/flask/cli.py","end_line":650,"reason":"read FlaskGroup __init__","start_line":601}` | returned | source excerpt |
| 24 | `read_file` | `{"path":"src/flask/cli.py","start_line":560,"reason":"read FlaskGroup __init__ start","end_line":605}` | returned | source excerpt |
| 25 | `stage_patch` | `src/flask/cli.py original=163 chars replacement=208 chars; src/flask/cli.py original=67 chars replacement=831 chars; tests/test_cli.py original=385 chars replacement=1029 chars; docs/cli.rst original=242 chars replacement=583 chars` | tool error | n/a |
| 26 | `read_file` | `{"reason":"read routes_command start in src/flask/cli.py","path":"src/flask/cli.py","end_line":1010,"start_line":990}` | returned | source excerpt |
| 27 | `read_file` | `{"path":"src/flask/cli.py","start_line":1010,"end_line":1030,"reason":"read around routes_command in src/flask/cli.py"}` | returned | repeated |
| 28 | `read_file` | `{"reason":"read where routes_command starts","start_line":1040,"path":"src/flask/cli.py","end_line":1085}` | returned | source excerpt |
| 29 | `stage_patch` | `src/flask/cli.py original=163 chars replacement=208 chars; src/flask/cli.py original=67 chars replacement=831 chars; tests/test_cli.py original=385 chars replacement=1029 chars; docs/cli.rst original=242 chars replacement=583 chars` | returned | staged in memory |
| 30 | `validate_edits` | `{}` | validation failed | n/a |
| 31 | `get_run_state` | `{"limit":6,"stagedIndex":0}` | returned | n/a |
| 32 | `get_run_state` | `{"stagedIndex":3,"limit":6}` | returned | n/a |
| 33 | `stage_patch` | `src/flask/cli.py original=831 chars replacement=736 chars` | returned | staged in memory |
| 34 | `validate_edits` | `{}` | validation failed | n/a |
| 35 | `get_run_state` | `{"limit":6,"stagedIndex":0}` | returned | n/a |
| 36 | `stage_patch` | `src/flask/cli.py original=736 chars replacement=736 chars` | tool error | n/a |
| 37 | `get_run_state` | `{"limit":6,"stagedIndex":0}` | returned | n/a |
| 38 | `get_run_state` | `{"stagedIndex":1,"limit":6}` | returned | n/a |
| 39 | `get_run_state` | `{"limit":6,"stagedIndex":3}` | tool error | n/a |

## Tests and exact next verification

Final automated results: **73 safety tests passed** after the ambiguity regression, and the VS Code extension-host suite passed **31 tests**. The offline scripted reference simulation passes through real MCP, isolated Flask verification and simulated approval; it is not a live autonomous result. Live `flask config`, per-hunk acceptance and undo were not demonstrated for this candidate because the verifier never passed.

Reproduce the local safety suite:

```sh
FLASK_TASK_B_REPO="$HOME/.codex/worktrees/flask-task-b-agent/flask-3.1.3" \
FORGE_REFERENCE_PATCH="$PWD/reports/evidence/task-b-reference.patch" \
  npm --prefix extension run test:safety
VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm --prefix extension test
```

For a later live run, choose a suitable configured tool-calling model and account quota. Use the exact Task B prompt, inspect the proposed patch, run `pytest tests/test_cli.py -q`, `flask --help`, and a real app's `flask config`, and confirm masked JSON. Reach the real VS Code review, select hunks, and obtain explicit human approval before any workspace writes. Demonstrate undo. Do not feed the reference patch or its paths into the live agent.

## Remaining blockers

The model has produced a real three-file candidate, but it has not fixed its failing test despite three verifier runs. A more capable configured model and a fresh controlled run, or a carefully measured improvement to failure diagnosis, is needed. The no-argument `verify_patch` improvement was tested offline **after** the final live session, so its live effect is unverified. Raw run logs and checkpoints are local private files, not included in the Git snapshot. Clean-clone setup and the project license remain outstanding and were intentionally not changed before Task B works.
