# TrueFoundry Forge-a-thon Phase 0

This workspace contains a TrueForge-powered VS Code Task A vertical slice. TrueForge owns the agent turn; the extension exposes read-only workspace MCP tools, streams the response, renders a proposed single-function hunk in the diff editor, and writes only after explicit approval. It does not implement a separate agent loop.

## Layout

```text
extension/   TypeScript VS Code extension starter and SDK dependency
trueforge/   example agent configuration and local-runtime notes
fixtures/    pristine Flask 3.1.3 checkout at commit 22d92470...
scratch/     disposable dry-run copies and virtual environments
scripts/     repeatable verification commands
reports/     audit, baseline, issue, roadmap, and scorecard evidence
```

## Start immediately

```bash
cd /Users/dakshjain/Desktop/Hackathons/iit-true-forge
./scripts/setup.sh
npm --prefix extension test
code extension
```

In VS Code, choose **Run Extension** in Run and Debug and press F5. In the Extension Development Host, run `Forge: Environment Status` from the Command Palette.

Start TrueForge separately when needed:

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@latest
# then open http://localhost:8790
```

The loopback allowlist is needed for TrueForge to connect to the extension's local MCP endpoint. Configure models in TrueForge before attempting a model-backed SDK turn. The extension never calls providers directly or stores provider secrets.

**Verified Task A result.** The approved agent patch passed the official Flask CLI suite (58 tests). The [research handoff](reports/06-task-a-vertical-slice.md) includes the turn history, tokens, tool calls and test evidence.

For a fresh disposable Task A worktree, `npm --prefix extension run task-a:live` runs a proposal from the terminal. `npm --prefix extension run task-a:review` opens the review in VS Code. Both read `TRUEFORGE_MODEL`. The review launcher also reads `VSCODE_EXECUTABLE`.

## Run the Task A vertical slice

The local TrueForge UI must have at least one model configured under **Settings → Models**. Add provider credentials in that UI only; the extension never calls model providers directly. If several models are configured, **Forge: Task A** asks you to choose one and stores only its fully qualified model name in VS Code settings.

Create a disposable worktree from the pristine fixture:

```bash
git -C /Users/dakshjain/Desktop/Hackathons/iit-true-forge/fixtures/flask-3.1.3 worktree add \
  /Users/dakshjain/Desktop/Hackathons/iit-true-forge/scratch/flask-task-a-agent \
  -b forge-task-a-agent
```

Open that worktree in a VS Code window. Open `src/flask/helpers.py`, select the complete `get_debug_flag` function, then run **Forge: Task A — Propose Selected Function Patch**. TrueForge reads through the local `read_file` and `search_repository` MCP tools. The extension streams the turn in the **Forge Task A** output channel and shows the proposed single hunk in VS Code's diff editor. Use **Approve and apply hunk** only after reviewing the diff; cancel and reject commands are also available. No source write occurs before approval.

After approval, run:

```bash
/Users/dakshjain/Desktop/Hackathons/iit-true-forge/scripts/verify-task-a.sh
```

The script requires the disposable worktree to contain only the accepted change to `src/flask/helpers.py`, checks the official `FLASK_DEBUG=off` behavior plus case variants, confirms Flask imports from that worktree, and runs the CLI and helper test suites. The pristine fixture stays untouched.

## Exact workflow commands

Run long-lived commands in their own terminals:

```bash
# Open the extension project. In VS Code press F5, then run Forge: Environment Status.
code /Users/dakshjain/Desktop/Hackathons/iit-true-forge/extension

# Start TrueForge and leave this terminal running.
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' npx @truefoundry/trueforge@latest

# Open the pristine Flask benchmark in another VS Code window.
code /Users/dakshjain/Desktop/Hackathons/iit-true-forge/fixtures/flask-3.1.3

# Re-run pinned Flask checks.
/Users/dakshjain/Desktop/Hackathons/iit-true-forge/scripts/verify-flask-baseline.sh

# Open the reports.
code /Users/dakshjain/Desktop/Hackathons/iit-true-forge/reports/00-environment-audit.md
code /Users/dakshjain/Desktop/Hackathons/iit-true-forge/reports/01-extension-starter-decision.md
code /Users/dakshjain/Desktop/Hackathons/iit-true-forge/reports/02-task-baseline.md
code /Users/dakshjain/Desktop/Hackathons/iit-true-forge/reports/03-issue-log.md
code /Users/dakshjain/Desktop/Hackathons/iit-true-forge/reports/04-implementation-roadmap.md
code /Users/dakshjain/Desktop/Hackathons/iit-true-forge/reports/05-verification-matrix.md
```

## Verification

```bash
./scripts/verify-environment.sh
./scripts/verify-flask-baseline.sh
./scripts/verify-trueforge.sh
./scripts/verify-task-a.sh
npm --prefix extension test
```

The Flask verification uses an isolated virtual environment and never edits the pristine fixture. Read the generated evidence and limitations in `reports/` before treating any result as competition readiness.

The extension host test downloads stable VS Code on a clean machine. To use an already installed VS Code binary instead, set `VSCODE_EXECUTABLE` to its executable path before `npm --prefix extension test`.

On this Mac, the verified command is:

```bash
VSCODE_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/MacOS/Code" npm --prefix extension test
```

The extension's read-only MCP server listens only on `127.0.0.1` (default port 8791). TrueForge stores a named MCP connector and a workspace-specific Task A agent definition; the configured agent exposes only `read_file` and `search_repository`.


## Task B live agent

Task B runs from a clean linked Flask 3.1.3 worktree at the pinned commit. Set `FLASK_TASK_B_REPO` to that worktree, `TRUEFORGE_MODEL` to a model configured in local TrueForge, and `VSCODE_EXECUTABLE` to the installed VS Code binary. Run `npm --prefix extension run task-b:live` to open the editor and start the real TrueForge session. The launcher pauses at a reviewed digest and accepts an explicit approval for all or selected hunks, or a rejection. The extension command is **Forge: Task B — Discover, Verify and Review**. Read [Task B evidence](reports/07-task-b-vertical-slice.md) for current results.

### Task B model fallback and context handoff

Configure provider credentials privately under **TrueForge → Settings → Models**. For OpenRouter, add a custom OpenAI-compatible provider named `openrouter`, use base URL `https://openrouter.ai/api/v1`, and enter your OpenRouter key in that dialog. For a simple free fallback, add model ID `openrouter/free`; OpenRouter routes that ID to a free model that fits tool-calling requests. You can instead add a specific free model whose catalog page lists `tools` support. Free endpoints have rate limits, so a successful tool-calling test is still necessary. To see the exact TrueForge model names available to the extension, run:

```bash
npm --prefix /Users/dakshjain/Desktop/Hackathons/iit-true-forge/extension run trueforge:models
```

Choose a tool-calling primary model in `forge.trueforgeModel` and, optionally, up to two ordered tool-calling fallbacks in `forge.taskBFallbackModels`. The VS Code command can prompt for the primary model. For the terminal launcher, set `TRUEFORGE_MODEL` and optionally `TRUEFORGE_FALLBACK_MODELS` to the exact TrueForge names. These settings store model names only; TrueForge owns credentials and provider calls. Do not paste provider keys into VS Code settings, logs, or chat.

Task B supports one primary and up to two ordered fallback models, all configured in TrueForge. It retries one transient 5xx/network failure with bounded backoff, reads Retry-After/reset headers, skips rate-limited or invalid-credential provider families, and reduces repository context after a context-length error. Malformed model output can move to a different configured model; tool/verification failures, cancellation, and any error after review begins stop without switching. OpenRouter model aliases share the same provider family and are skipped together after a 429. TrueForge creates a fresh session for each retry or switch. The extension checkpoints the original task, model/session IDs, staged hunks, validation history, failures, and file selection reasons to private extension storage after each MCP action. On the next run, you can choose to resume; it verifies the same clean pinned worktree and reruns validation before review. The terminal launcher keeps its private checkpoint alongside the run log.

`forge.taskBContextBudget` bounds retrieved source excerpts. `forge.taskBDeferredTools` uses TrueForge deferred MCP loading and preloads only investigation and checkpoint tools. `forge.taskBEnableCompaction` is opt-in: one measured Qwen run emitted a 1,533-token compaction summary then hit its output-per-minute quota, so compaction stays off by default for that provider. `forge.taskBToolPaceMs` can slow tool responses for a provider's rolling token quota. Approved multi-file disk saves require one explicit Save All choice; if a later file save fails, earlier saves are rolled back and the complete proposal stays unsaved in editor buffers. If rollback encounters a conflicting file, a private recovery journal is preserved in extension storage. To explicitly restore only files still matching that journal, run `npm --prefix extension run task-b:recover -- /absolute/path/to/journal.json /absolute/path/to/worktree --rollback`. TrueForge's own tool loop remains the only agent loop. The optional [ECC reference](https://github.com/affaan-m/ecc) was cloned outside this project; its small Markdown handoff idea is reflected in [the working-state report](reports/08-working-state.md), without adding its separate runtime or memory service to Task B.

Run the headless local checks with `npm --prefix extension run test:safety`. Run the VS Code host and live TrueForge Task B flow after configuring the models. No live Task B result is claimed yet.

## Forge sidebar

In the Extension Development Host, open a clean pinned Flask worktree and select the **Forge** icon in the Activity Bar. Pick a TrueForge model, enter a task or select **Use Task B request**, and press Send. The sidebar shows streamed messages and tool activity; the existing diff editor, hunk selection, validation and save approval remain in control of changes. The current verifier is specific to Flask Task B. See [the Cline UI integration report](reports/13-cline-ui-integration.md) for the UI's scope, tests, attribution and current limitations.

## Symbol-level repository retrieval

Forge can use the pinned local RepoMap 1.9.0 MCP process for symbol search, bounded context and inferred call/impact relationships. It indexes only a private mirror of tracked non-sensitive files, disables embedding downloads, and falls back to the existing repository search if unavailable. Enable or disable it with `forge.repoMapEnabled`. See [the RepoMap integration report](reports/14-repomap-integration.md) for limits and a reproducible Flask benchmark.
