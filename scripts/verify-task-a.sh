#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TASK_REPO="${FLASK_TASK_A_REPO:-$ROOT_DIR/scratch/flask-task-a-agent}"
TASK_ENV="$ROOT_DIR/scratch/flask-task-a-agent-venv"
EXPECTED_COMMIT="22d924701a6ae2e4cd01e9a15bbaf3946094af65"

if [[ ! -d "$TASK_REPO/.git" && ! -f "$TASK_REPO/.git" ]]; then
  printf 'ERROR: disposable Task A worktree not found: %s\n' "$TASK_REPO" >&2
  printf 'Create it with the commands in README.md.\n' >&2
  exit 2
fi

actual_commit="$(git -C "$TASK_REPO" rev-parse HEAD)"
if [[ "$actual_commit" != "$EXPECTED_COMMIT" ]]; then
  printf 'ERROR: expected baseline commit %s, found %s\n' "$EXPECTED_COMMIT" "$actual_commit" >&2
  exit 2
fi

changed_files="$(git -C "$TASK_REPO" status --porcelain --untracked-files=all | sed -E 's/^...//')"
if [[ "$changed_files" != "src/flask/helpers.py" ]]; then
  printf 'ERROR: Task A worktree must contain only the approved helper change.\n' >&2
  git -C "$TASK_REPO" status --short >&2
  exit 2
fi

printf 'Task A worktree: %s\ncommit: %s\n' "$TASK_REPO" "$actual_commit"
UV_PROJECT_ENVIRONMENT="$TASK_ENV" uv sync --project "$TASK_REPO" --no-default-groups --group tests --locked
PYTHON="$TASK_ENV/bin/python"

cd "$TASK_REPO"
for debug_value in off OFF n N; do
  output="$(FLASK_DEBUG="$debug_value" "$PYTHON" -c 'from flask.helpers import get_debug_flag; print(get_debug_flag())')"
  if [[ "$output" != "False" ]]; then
    printf 'ERROR: FLASK_DEBUG=%s returned %s, expected False\n' "$debug_value" "$output" >&2
    exit 1
  fi
  printf 'FLASK_DEBUG=%s -> %s\n' "$debug_value" "$output"
done

PYTHONPATH="$TASK_REPO/src" "$PYTHON" -c 'import flask, pathlib; expected = pathlib.Path.cwd() / "src" / "flask"; actual = pathlib.Path(flask.__file__).resolve(); assert actual.is_relative_to(expected.resolve()), actual; print(f"Flask import: {actual}")'
"$PYTHON" -m pytest tests/test_cli.py -q
"$PYTHON" -m pytest tests/test_helpers.py tests/test_cli.py -q
printf 'Task A verification passed. The pristine fixture was not modified.\n'
