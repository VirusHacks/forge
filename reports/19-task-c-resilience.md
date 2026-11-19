# Task C resilience and bounded model routing

19 November 2026. The real Task A controller was exercised in a VS Code extension-development host against a separate TrueForge 0.185.1 instance with a temporary SQLite database. Its only configured model used a deliberately unreachable OpenAI-compatible local endpoint. No provider API key or paid model was used.

## Observed Task C failure

- TrueForge server: `http://localhost:18790`; temporary provider endpoint: `http://127.0.0.1:18791/v1`; no fallback models or SDK retries.
- Selected the actual pristine `get_debug_flag` function in a disposable, clean Flask checkout at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`, then ran the actual `TaskAController`.
- Session `01m7t16w1rxfeyzyr5tf1syhrm`, turn `01m7t16w1ygbvhspyj0dvrvdgq`: TrueForge returned `[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:18791`.
- The extension output recorded the error, zero completed model calls, zero reported input/output tokens, zero MCP tool calls and zero retries. The host recorded two event-loop heartbeat ticks, no diff preview, unchanged source contents, a clean editor buffer and clean `git status`.
- The controller invokes its VS Code error notification on this path. The automated host did **not** verify a screenshot of the notification or a recorded competition demo; editor heartbeat is not a complete UI responsiveness or cancellation proof. No live successful fallback model was exercised.
- A first local fault attempt used port 1, which failed earlier as a blocked `bad port`; subsequent attempts used port 18791 and observed real `ECONNREFUSED`. One attempt exposed a misleading fallback status with no eligible fallback. The final run no longer reports a nonexistent fallback.

## Changes

- Both Task A and Task B now attempt at most one switch to another model, even when multiple candidate fallbacks are configured. Transient retries remain separately bounded by `forge.providerMaxRetries`.
- Automatic switching is limited to provider failures: rate limits, server and network errors, unavailable models, and invalid credentials. Context or repository budget exhaustion, malformed model output, and validation failures stop and retain their existing recovery path instead of silently switching models.
- Task A emits a fallback event only when an eligible replacement is actually attempted, including `from`, `to`, and the failure kind.
- An explicit empty `TRUEFORGE_FALLBACK_MODELS` launcher setting is sent to the VS Code host as `none`, avoiding loss of the empty environment variable and unexpected defaults.
- Task A error labels redact common Groq, OpenRouter, OpenAI, Gemini-style and bearer-token formats. This is defense in depth, not a guarantee that arbitrary secrets cannot appear in arbitrary error text.
- Added `extension/scripts/task-c-fault-host.cjs`, a reusable real-controller fault test with a pinned clean checkout, zero fallback models, output assertions, event-loop heartbeat, and no-write checks.
- The Task B review guard now distinguishes a closed buffer, unsaved edits, changed version, and changed contents. All existing checks remain in place; a VS Code host regression verifies that a version change still blocks the edit and reports its cause.

## Verification

- `FLASK_TASK_B_REPO=/private/tmp/forge-task-b-test-root FORGE_REFERENCE_PATCH=<repo>/reports/evidence/task-b-reference.patch npm run test:safety` from `extension/`: **78 passed, 0 failed**. This includes the real sandboxed failure/repair simulation and new routing, status and redaction checks.
- `VSCODE_EXECUTABLE='/Applications/Visual Studio Code.app/Contents/MacOS/Code' npm test` from `extension/`: **31 passed, 0 failed**.
- Integrated Task C host run: exit 0, evidence above. The original Task B worktree still contains its approved three-file patch; the pristine fixture remains clean.
- An initial safety run in the temporary project clone failed four verifier tests because its symlinked venv was not accessible within the macOS sandbox. The final run above used the actual project and passed all tests.

## Reproduction on this machine

Use separate temporary paths and a pinned clean disposable Flask checkout. Start the installed server in an isolated database (stop it after the test):

```sh
SQLITE_PATH=/private/tmp/forge-task-c-isolated.sqlite \
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' \
MODEL_HTTP_HEADERS_TIMEOUT_MS=5000 MODEL_HTTP_MAX_RETRIES=0 \
node <npx-cache>/@truefoundry/trueforge/dist/cli.js --port 18790
```

From `extension/`, configure the temporary server (its database must be separate from the user's real server):

```sh
node --input-type=module - <<'JS'
import {TrueForge} from '@truefoundry/trueforge-sdk';
const c = new TrueForge({baseUrl:'http://localhost:18790',maxRetries:0});
await c.settings.modelProviders.create({manifest:{type:'custom',name:'forge-task-c-unreachable',baseUrl:'http://127.0.0.1:18791/v1',models:[{name:'unreachable',modelId:'unreachable',properties:{contextLength:8192}}]}});
JS
```

Create a clean disposable checkout and run the real controller host (choose fresh temporary profile/checkout directories if the names exist):

```sh
git clone --no-hardlinks <repo>/fixtures/flask-3.1.3 /private/tmp/forge-task-c-flask
npm run compile
FORGE_TASK_C_URL=http://localhost:18790 \
'/Applications/Visual Studio Code.app/Contents/MacOS/Code' /private/tmp/forge-task-c-flask \
  --extensionDevelopmentPath=<repo>/extension \
  --extensionTestsPath=<repo>/extension/scripts/task-c-fault-host.cjs \
  --user-data-dir=/private/tmp/forge-task-c-profile \
  --extensions-dir=/private/tmp/forge-task-c-extensions \
  --disable-extensions --skip-welcome --skip-release-notes
```

The fault harness requires the provider name shown above and asserts the exact pinned commit and clean status. Use an actually unoccupied port and a fresh database. It creates a separate VS Code profile and never modifies the configured real TrueForge providers.

## Remaining work

The Task B diff was verified and approved, but the original extension review rejected its delayed application after a buffer-state mismatch; exact cause was not determined. An attempted short close-and-reopen reproduction did not close the VS Code document, so the guard was not weakened. Its new diagnostic will identify the condition if it recurs. Reproduce and fix the editor lifecycle issue, run Task B end to end through the sidebar including apply and undo, demonstrate Task C on screen, and record the competition demo. The installed standalone TrueForge server explicitly reports that it is not hardened for production/shared access. These checks do not establish production readiness.
