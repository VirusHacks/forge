# Demo guide: Tasks A, B and C

This guide reproduces the three fixed tasks from the [brief](../task.md) on Flask 3.1.3 and doubles as the recording script. The video may be at most 4 minutes and must show A, B and C in that order, each followed by its check, plus the TrueForge session during Task B. You may cut model waiting time, but not the time between giving an instruction and the diff appearing.

## One-time setup

```bash
# From the repository root
git clone --branch 3.1.3 --single-branch https://github.com/pallets/flask.git fixtures/flask-3.1.3
git -C fixtures/flask-3.1.3 checkout --detach 22d924701a6ae2e4cd01e9a15bbaf3946094af65
uv venv scratch/flask-venv
VIRTUAL_ENV="$PWD/scratch/flask-venv" uv sync --project fixtures/flask-3.1.3 --no-default-groups --group tests --active --locked

# One clean worktree per task, so each starts from the pinned commit
for t in a b c; do git -C fixtures/flask-3.1.3 worktree add --detach "$PWD/scratch/demo-$t" 22d924701a6ae2e4cd01e9a15bbaf3946094af65; done
```

TrueForge (separate terminal):

```bash
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' MODEL_HTTP_MAX_RETRIES=0 npx @truefoundry/trueforge@0.185.1
```

Add model providers in **Settings → Models** (see [model-providers.example.json](../trueforge/config/model-providers.example.json)), including the test-only `forge-demo-broken` provider for Task C.

VS Code user settings in the Extension Development Host:

```json
{
  "forge.pythonPath": "<repo>/scratch/flask-venv/bin/python",
  "forge.fallbackModels": ["google-gemini/gemini-3-1-flash-lite", "groq/qwen-3-8-27b"]
}
```

Before recording, check which free models answer. Gemini often returns 503, and OpenRouter's free tier allows about 50 requests per day. Put the healthiest model first.

## Task A: inline edit

1. Open `scratch/demo-a`. Open `src/flask/helpers.py` and select the whole `get_debug_flag` function.
2. Press **⌘⌥K** and type: *Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.*
3. The diff opens. In the Forge sidebar, show the two hunks (docstring and logic) and click **Accept 2 of 2**.
4. Check in the terminal (inside `scratch/demo-a`):
   ```bash
   FLASK_DEBUG=off PYTHONPATH=src ../flask-venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"   # False
   ```

## Task B: agent mode

1. Open `scratch/demo-b`, then open the Forge sidebar.
2. Paste the request exactly, naming no files: *Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "\*\*\*". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.*
3. On screen, show:
   - the **context card** (files and reasons) and the **code graph** (`FlaskGroup`, its callers and its tests);
   - the tool timeline, including the **auto-verify** rows;
   - any retry or fallback banner.
4. Click **Open in TrueForge ↗** and briefly show the session: the turns and tool calls.
5. In the review card, show the hunks across `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst`, then **Accept**.
6. Check (inside `scratch/demo-b`):
   ```bash
   PYTHONPATH=src ../flask-venv/bin/python -m pytest tests/test_cli.py -q
   PYTHONPATH=src ../flask-venv/bin/python -m flask --help | grep config
   printf 'from flask import Flask\napp=Flask(__name__)\napp.config.update(SECRET_KEY="s",API_TOKEN="t",PUBLIC_NAME="demo")\n' > /tmp/demo_app.py
   (cd /tmp && PYTHONPATH=<repo>/scratch/demo-b/src <repo>/scratch/flask-venv/bin/python -m flask --app demo_app config)
   git diff --stat        # at least three files
   ```
7. Optional: click **Undo** and show `git status` clean.

## Task C: resilience

1. Open `scratch/demo-c`. In the sidebar model picker choose `forge-demo-broken/unreachable`.
2. Repeat Task A (select `get_debug_flag`, press ⌘⌥K, same instruction).
3. Show:
   - **With `forge.fallbackModels` set:** a "Retrying" banner, then a *Fallback: unreachable → …* banner and notification, then the diff. Click **Reject all**.
   - **Without fallbacks** (empty `forge.fallbackModels`): the clear error notification.
4. Check: `git status` shows no changes.

## Cancellation (optional extra)

Start Task B and press **Stop** while a tool row is running. The run ends as *Cancelled*, and `git status` stays clean.
