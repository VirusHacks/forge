# Issue log

The entries below distinguish environment/setup blockers and expected missing competition features from defects in the pinned Flask fixture. No speculative behavior is labeled as confirmed.

| ID | Component | Severity | Category | Issue | Reproduction | Expected | Actual | Proposed fix | Scoring criterion affected |
|---|---|---|---|---|---|---|---|---|---|
| ENV-001 | Workspace Git | Medium | ENVIRONMENT | Root workspace is not a Git repository and `git init` is blocked by the desktop sandbox's `.git` permission | From workspace: `git init` | New setup can keep root history | `Operation not permitted` at `.git` | Initialize the root repo in a normal terminal, after reviewing the generated files. | No direct rubric item; C2 reproducibility |
| ENV-002 | Network / uv | Medium | ENVIRONMENT | Default sandbox cannot write uv cache or resolve some public hosts | Run `./scripts/verify-flask-baseline.sh` without external access | Reproducible setup script can fetch packages | uv cache lock/temp creation failed; GitHub DNS failed | Run from normal host terminal or grant package/network access; script now fails clearly. | C2 reproducibility; indirect A1/A2/B4 |
| DEP-001 | Flask test dependencies | Medium | DEPENDENCY | Installing `-e fixture[tests]` is incorrect because Flask declares a dependency group, not a project extra | `uv pip install -e 'fixtures/flask-3.1.3[tests]'` | Install tests as declared by project config | Warning: extra `tests` not found; pytest missing | Use checked-in lockfile with `uv sync --no-default-groups --group tests --active --locked`, now implemented. | C2 reproducibility |
| DEP-002 | Flask test dependencies | Medium | DEPENDENCY | Unpinned latest pytest 9.2 breaks this fixture's internal test import | Install unpinned `pytest`, run `tests/test_cli.py` | Collection succeeds | `ImportError: cannot import name 'notset' from _pytest.monkeypatch` | Respect `uv.lock`; pinned pytest 9.0.2 passes. | A1/A2 validation; C2 evidence |
| DEP-003 | Extension test dependencies | Medium | DEPENDENCY | Test/development dependency tree has 12 npm audit advisories and no automatic fix | Run `npm --prefix extension audit` | No known advisories | 1 low, 5 moderate, 6 high in dev/test packages; `--omit=dev` reports zero | Review when `@vscode/test-cli` ships patched transitive versions; avoid force-updating unrelated packages. | C2 engineering quality; no direct runtime mark |
| TF-001 | TrueForge model setup | High | BLOCKED | No model provider or model is configured in local TrueForge | Start TrueForge; query `/api/v1/models` and `/api/v1/settings/model-providers` | SDK session/turn smoke can run if a model exists | Both return `{ "data": [] }`; SDK agent and session list calls succeed with counts 0; model turn skipped. Groq form is prepared with lowercase `groq` but remains unsaved. | Revoke the key shared in chat, create a replacement, enter it in the local TrueForge form, and click **Add provider**; then select the model in the extension or set `TRUEFORGE_MODEL` for the smoke script. | A3, B3, B4; also blocks A1/A2 demonstration |
| TF-002 | TrueForge fallback | High | UNVERIFIED | Native automatic second-model fallback has not been demonstrated | Configure invalid provider and a second provider; run a turn | First failure is handled and second model takes over | Not tested because no providers exist; official docs reviewed do not document a fallback primitive | Verify against a two-provider test setup; otherwise implement coordination above TrueForge while keeping the loop in TrueForge. | B3 and B4 |
| TF-003 | TrueForge stream resilience | Medium | UNVERIFIED | Long SSE streams can disconnect before terminal event per official benchmark notes | Run a long model turn and interrupt the SSE connection | Client resumes or polls to terminal state | Not run without a model | Persist session/turn/sequence IDs; use `getTurn`, `subscribeToTurn`, or `listTurnEvents`. | A3 and B3 |
| TF-004 | SDK/server versions | Low | DEPENDENCY | Local server is 0.185.1 while scaffold pins SDK 0.185.0 | `npx ...` and `npm ls` | Compatible API surface | Health/agent and session lists work; model path unverified | Re-pin SDK after model smoke, or align server and SDK versions intentionally. | B4; A3 stream path unverified |
| TF-005 | Workspace MCP connector | Medium | CONFIGURATION | TrueForge blocks outbound loopback MCP URLs by default | Register the workspace connector at `http://127.0.0.1:8791/mcp` | TrueForge discovers the workspace tools | First registration returned HTTP 400 for blocked `127.0.0.1`; after starting TrueForge with `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'`, discovery returned `read_file` and `search_repository` | Keep the narrow localhost/127.0.0.1 allowlist in the documented local TrueForge startup command. | B4 |
| VS-001 | Extension unit test | Medium | VSCODE_INTEGRATION | Directly importing `vscode` in a Node unit test fails outside an Extension Host | Import `src/extension.ts` from `node --test` | Unit tests run in plain Node | `Cannot find module 'vscode'` | Extracted pure health logic to `src/health.ts`; VS Code Host tests now pass. | C2 test evidence |
| VS-002 | Editor agent | High | EXPECTED_MISSING_FEATURE | Inline hunk review, multi-file approval, and transactional apply are not implemented | Press F5 and inspect scaffold | Competition feature | Only environment-status command exists | Phase 1: implement preview-only proposal model and per-hunk review before any writes. | A1, A2, B1, B2 |
| VS-003 | Editor Task C | High | EXPECTED_MISSING_FEATURE | No VS Code agent exists yet to prove editor responsiveness/fallback/no writes | Fault-inject endpoint in Extension Development Host | UI stays responsive, clear error/fallback, clean Git | Not applicable; editor agent absent | Add bounded SDK calls, cancellation, stale-state guard, and failure UI. | A3 and B3 |
| VS-004 | Extension test host | Low | TESTING_GAP | The downloaded stable VS Code 1.147.0 archive lacks the `Electron` executable path expected by the runner on this machine | `npm --prefix extension test` without `VSCODE_EXECUTABLE` | Extension Host tests launch and exit cleanly | `spawn .../Contents/MacOS/Electron ENOENT`; installed VS Code 1.146.0 runs all 3 tests, but a later repeat reports `SIGABRT` during process teardown after the renderer logs 3 passing tests | Use the documented `VSCODE_EXECUTABLE` workaround locally; investigate test-runner compatibility and teardown before relying on clean-machine stable downloads. | C2 test infrastructure |
| FLASK-001 | Flask fixture | Low | EXPECTED_MISSING_FEATURE | `FLASK_DEBUG=off` returns `True` on pristine 3.1.3 | `FLASK_DEBUG=off python -c ...` | Task A post-change expects `False` | `True` | This is the benchmark's intended gap; do not report as an upstream bug. | A1 benchmark evidence |

## Task A follow-up (19 November 2026)

TF-001 was resolved by configuring Groq. TF-004 was exercised through a successful streamed turn. VS-002 now supports review and guarded application of the selected Task A function. The table above records the original Phase 0 findings. See the [Task A research handoff](06-task-a-vertical-slice.md) for the provider errors, successful turn and Flask verification.

## Cause and confidence notes

- **ENV-001 — confirmed:** the desktop sandbox rejects creation of the workspace root `.git`; no previous repository existed.
- **ENV-002 — confirmed:** sandbox restrictions prevented temporary uv cache writes and DNS resolution; approved package/network runs succeeded.
- **DEP-001 — confirmed:** Flask 3.1.3 uses `[dependency-groups].tests`, not an installable `tests` extra.
- **DEP-002 — confirmed:** an unpinned latest pytest did not match Flask's test imports; the checked-in lockfile selects a passing pytest.
- **DEP-003 — confirmed audit output:** all 12 findings are in development/test dependencies; the production-only audit is clean. npm offered no automatic fix.
- **TF-001 — confirmed:** local models and providers are empty; no model-backed turn was created.
- **TF-002 — unverified:** official docs reviewed expose sessions, streaming, errors, cancellation, and model selection, but do not document automatic provider fallback; there are no configured providers here to test it.
- **TF-003 — documented, not locally reproduced:** the official TrueForge benchmark warns that an SSE stream may close before the turn completes; the smoke environment has no model.
- **TF-004 — partial evidence:** SDK 0.185.0 reaches the 0.185.1 server's health, agent, and session-list APIs. Turn streaming compatibility has not been verified.
- **TF-005 — confirmed and resolved for this local run:** the MCP registration failed with HTTP 400 under TrueForge's default outbound host policy. Restarting with only `localhost` and `127.0.0.1` allowed the connector to register and expose its two read-only tools; the temporary connector was then removed.
- **VS-001 — confirmed and addressed:** plain Node could not resolve the VS Code host module; the tests now run inside the VS Code Extension Host.
- **VS-002 / VS-003 — intentional scope gaps:** these are competition features not implemented in Phase 0, not observed defects.
- **VS-004 — confirmed symptoms, cause unknown:** downloaded VS Code 1.147.0 did not contain the `Electron` path expected by the runner. With installed 1.146.0, an earlier complete run exited successfully; a later repeat logged all 3 tests as passing, then the runner received `SIGABRT` during teardown. Runner/archive layout incompatibility and process teardown instability are observed, but their root causes are not established.
- **FLASK-001 — expected benchmark behavior:** the pristine value `True` is the Task A starting gap, not a Flask defect.

## Detailed evidence

### DEP-002: lockfile mismatch

1. Create or use the isolated scratch venv.
2. Install Flask's tests group with unpinned `uv pip install ... pytest`.
3. Run `pytest fixtures/flask-3.1.3/tests/test_cli.py -q`.
4. Collection fails on `_pytest.monkeypatch.notset` with pytest 9.2.0.
5. Sync the fixture lockfile's tests group.
6. The suite passes 58 tests with pytest 9.0.2.

Root cause is a dependency compatibility mismatch caused by ignoring the repository lockfile, not a Flask source defect.

### TF-001: missing model

1. Start `npx @truefoundry/trueforge@latest --port 8790`.
2. `curl http://localhost:8790/healthz` returns `{"status":"ok","version":"0.185.1"}`.
3. Query `/api/v1/models` and `/api/v1/settings/model-providers`.
4. Both return empty `data` arrays.
5. The SDK probe reaches both `agents.list` and `sessions.list`, recording `agentCount: 0`, `sessionCount: 0`, and `modelTurn: skipped-no-TRUEFORGE_MODEL`.

This is an environment prerequisite, not a TrueForge runtime failure.

### DEP-003: extension test dependency audit

`npm --prefix extension audit --json` reported 12 findings in development/test dependencies, including the test CLI's transitive file matching, glob, Mocha, and serialization packages. npm reported `fixAvailable: false` for these findings. `npm --prefix extension audit --omit=dev` reported zero production findings. This does not affect the extension's runtime SDK path today, but it should be revisited before sharing or publishing the development toolchain.

### TF-003: documented stream hazard

The official TrueForge benchmark documentation says long SSE streams may close before `turn.done` while the server continues running. A future extension must not interpret an early stream close as an empty completed answer; it must inspect the turn and resume or replay stored events.

