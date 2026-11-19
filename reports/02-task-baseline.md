# Task baseline and dry-run evidence

## Pinned fixture

- Remote: `https://github.com/pallets/flask`
- Requested release: `3.1.3`
- Verified commit: `22d924701a6ae2e4cd01e9a15bbaf3946094af65`
- Fixture: `fixtures/flask-3.1.3`
- Working tree after all baseline checks: clean
- Environment: `scratch/flask-3.1.3-venv`, uv-managed, CPython 3.14.8
- Supported install source: the fixture's `pyproject.toml` and checked-in `uv.lock`; the `tests` dependency group was synced with `uv sync --no-default-groups --group tests --active --locked`.

## Baseline command results

| Check | Result |
|---|---|
| Local import | `<repo>/fixtures/flask-3.1.3/src/flask/__init__.py`, version `3.1.3` |
| Flask CLI | Python 3.14.8 / Flask 3.1.3 / Werkzeug 3.1.5 |
| `FLASK_DEBUG=off ... get_debug_flag()` | `True` on pristine baseline; expected Task A gap |
| `pytest tests/test_cli.py -q` | `58 passed in 0.17s` |
| Fixture status | clean before and after checks |
| Original `flask --help` | built-ins: `routes`, `run`, `shell`; no `config` |

## Task A

### Investigation

`flask.helpers.get_debug_flag` currently returns false only when the lower-cased value is one of `0`, `false`, or `no`; any other non-empty value, including `off` and `n`, returns true. Lower-casing is already case-insensitive for the existing set. The docstring only says the default is false and does not enumerate false values. Unset and empty environment values also evaluate false through the existing `bool(val and ...)` expression.

Relevant editor APIs for the future agent are `window.activeTextEditor.selection` / `document.getText(selection)` for selection capture, `WorkspaceEdit` plus `workspace.applyEdit` for controlled edits, `TextEditor.edit` undo stops for a single-document edit, `window.showTextDocument` for editor updates, and `commands.executeCommand('vscode.diff', leftUri, rightUri, title)` for a standard diff view. The VS Code API documents all-or-nothing application for a workspace edit containing only text edits; this is a useful basis for atomic multi-file application. Per-hunk approval remains application work. See the [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api) and [built-in diff command](https://code.visualstudio.com/api/references/commands).

### Scratch rehearsal

Scratch copy: `scratch/flask-task-a`.

Change made manually by the Phase 0 engineer:

```diff
- return bool(val and val.lower() not in {"0", "false", "no"})
+ return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})
```

The docstring was updated to list unset and empty values plus `0`, `false`, `no`, `off`, and `n`, case-insensitively. The existing helper test parametrization was extended for lowercase and uppercase `off` / `n`.

Evidence:

- Official verification with `FLASK_DEBUG=off`: `False`.
- `pytest scratch/flask-task-a/tests/test_helpers.py scratch/flask-task-a/tests/test_cli.py -q`: `98 passed in 0.19s`.
- Direct checks with `FLASK_DEBUG=off`, `OFF`, and `N` each printed `False`.
- Scratch diff contains `src/flask/helpers.py` and `tests/test_helpers.py`.
- This is a human/developer rehearsal, not evidence that a TrueForge agent performed the task.

### Future-agent traps

- Empty selection: should produce a useful request or switch to an explicit file/symbol context rather than silently editing the whole file.
- Wrong symbol: selection must be validated against the document version and a symbol/range resolver; do not trust stale offsets.
- Stale buffer: record document version / text hash before proposing and recheck before applying.
- Multiple hunks: represent hunks separately so one rejection does not apply unrelated edits.
- Rejection and undo: keep the original document snapshot and use a transactional `WorkspaceEdit`; do not treat preview rendering as a write.
- Cancellation: abort the SDK stream and prevent late events from applying edits; cancel any pending TrueForge turn before releasing UI state.

## Task B

### Baseline investigation

Repository search found the CLI architecture in `src/flask/cli.py`: `FlaskGroup.__init__` registers built-in commands; `ScriptInfo.load_app` loads an instance or factory; `with_appcontext` supplies the application context; and `tests/test_cli.py` already exercises `FlaskGroup`, factories, help, and app contexts. `docs/cli.rst` documents the built-in `run` and `shell` commands and is the natural documentation location. The pristine `flask --help` output confirmed that `config` is absent. That absence is an expected benchmark gap, not a Flask defect.

### Scratch rehearsal

Scratch copy: `scratch/flask-task-b`.

The ordinary engineering implementation touched exactly three files:

1. `src/flask/cli.py`: registers a built-in `config` command, loads the app through `with_appcontext`, masks keys containing `SECRET`, `PASSWORD`, `TOKEN`, or `KEY` case-insensitively and by substring, recursively handles mappings/sequences, and stringifies non-JSON-native values.
2. `tests/test_cli.py`: checks valid JSON, masking, nested keys, non-sensitive output, and help registration.
3. `docs/cli.rst`: documents invocation and masking.

Evidence:

- `pytest scratch/flask-task-b/tests/test_cli.py -q`: `60 passed in 0.16s`.
- Factory app invocation succeeds.
- Help includes `config  Show the app config as JSON.`.
- Example output masks both `SECRET_API_TOKEN` and Flask's default `SECRET_KEY` as `***`; `PUBLIC_NAME` remains visible.
- The resulting diff is three files and 75 added lines.

### Implementation traps identified

- Use `ScriptInfo.load_app` / `with_appcontext` so application factories behave like other Flask CLI commands.
- Make output machine-readable: no status banner on stdout, no Click table formatting, and a stable JSON serializer.
- Configuration includes values such as `datetime.timedelta` that are not JSON-native; an explicit safe conversion policy is needed.
- Match sensitive key names case-insensitively and as substrings, not exact names only.
- Mask before serialization and before exception formatting to reduce accidental leakage.
- Test both sensitive and ordinary keys, factory loading, help registration, nested mappings, and non-serializable defaults.

Again, this patch is an ordinary developer dry run. It is not a prewritten solution to place in a future agent prompt.

## Task C

### Verified runtime behavior

The documented startup command is accepted:

```text
TrueForge v0.185.1. Start the agent server.
Default port: 8790
```

The running local instance logged standalone SQLite mode, auth disabled, and `http://localhost:8790` with docs at `/api/v1/docs`. Health response:

```json
{"status":"ok","version":"0.185.1"}
```

The TypeScript SDK probe returned:

```json
{
  "baseUrl": "http://localhost:8790",
  "healthz": "200 ok",
  "sdk": "reachable",
  "sessions": "accessible",
  "modelTurn": "skipped-no-TRUEFORGE_MODEL",
  "events": [],
  "agentCount": 0,
  "sessionCount": 0
}
```

`/api/v1/models` and `/api/v1/settings/model-providers` both returned `{ "data": [] }`, so no model-dependent session or streamed turn was attempted. This is a blocked prerequisite, not a failure fabricated into a pass.

The OpenAPI path list confirms endpoints for agents, sessions, turns, cancellation, event listing, and subscription. Official SDK documentation describes `createTurnStream`, `turn.created`, `model.message.delta`, `turn.done`, `sessions.cancel`, and stream resumption through `subscribeToTurn` / stored events. No native two-provider automatic fallback was found in the reviewed official docs; fallback remains an application-level design item until verified experimentally.

### Fault injection

The SDK probe was run with `TRUEFORGE_BASE_URL=http://localhost:8799`, an unreachable local endpoint. It failed quickly with exit 2 and safe structured output containing `error.type: TypeError` without echoing the error body. Before and after the probe, both scratch repositories had identical `git status --porcelain` output. Because the actual editor agent is not implemented, editor responsiveness and zero-change behavior in a VS Code Extension Development Host are **not implemented**, not passed.

## Current separation of concerns

| Capability | TrueForge evidence | Extension work still required |
|---|---|---|
| Agent loop | SDK sessions/turns documented and non-model SDK access verified | Bind editor commands and MCP tools without reimplementing the loop |
| Streaming | Official SDK event model documented | Render deltas, correlate threads, handle disconnect/resume |
| Cancellation | Official SDK exposes `sessions.cancel` and abort signals | Wire Stop UI to cancellation and prevent late writes |
| Approvals | Official agent spec supports tool approval | Surface approvals in editor and gate write tools |
| Workspace edits | Not supplied by the Phase 0 SDK probe | Implement MCP read/edit/diff tools and transactional apply |
| Provider fallback | Not verified as native | Coordinate a second configured model at application level if required |

