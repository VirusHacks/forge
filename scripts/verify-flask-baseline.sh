#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT_DIR/fixtures/flask-3.1.3"
VENV="$ROOT_DIR/scratch/flask-3.1.3-venv"
PINNED_COMMIT="22d924701a6ae2e4cd01e9a15bbaf3946094af65"
mkdir -p "$ROOT_DIR/scratch"

if [[ ! -d "$FIXTURE/.git" ]]; then
  printf 'ERROR: missing pristine Flask fixture at %s\n' "$FIXTURE" >&2
  exit 2
fi
if [[ "$(git -C "$FIXTURE" rev-parse HEAD)" != "$PINNED_COMMIT" ]]; then
  printf 'ERROR: fixture is not at required commit %s\n' "$PINNED_COMMIT" >&2
  exit 3
fi
if [[ -n "$(git -C "$FIXTURE" status --porcelain)" ]]; then
  printf 'REFUSING: pristine Flask fixture has local changes.\n' >&2
  git -C "$FIXTURE" status --short
  exit 4
fi

if [[ ! -x "$VENV/bin/python" ]]; then
  uv venv "$VENV"
fi
# Flask 3.1.3 declares its test dependencies as a dependency group, not a
# project extra. Use the fixture's checked-in lockfile and keep the environment
# outside the pristine checkout.
VIRTUAL_ENV="$VENV" uv sync \
  --project "$FIXTURE" \
  --no-default-groups \
  --group tests \
  --active \
  --locked

printf '\n-- fixture commit --\n'
git -C "$FIXTURE" rev-parse HEAD
printf '\n-- fixture status before checks --\n'
git -C "$FIXTURE" status --porcelain
printf '\n-- local import --\n'
"$VENV/bin/python" -c 'import flask, importlib.metadata; print(flask.__file__); print(importlib.metadata.version("flask"))'
printf '\n-- flask CLI --\n'
FLASK_APP= "$VENV/bin/flask" --version
printf '\n-- Task A baseline --\n'
FLASK_DEBUG=off "$VENV/bin/python" -c 'from flask.helpers import get_debug_flag; print(get_debug_flag())'
printf '\n-- tests/test_cli.py --\n'
set +e
"$VENV/bin/pytest" "$FIXTURE/tests/test_cli.py" -q
pytest_code=$?
set -e
printf 'pytest_exit=%s\n' "$pytest_code"
printf '\n-- fixture status after checks --\n'
git -C "$FIXTURE" status --porcelain
if [[ -n "$(git -C "$FIXTURE" status --porcelain)" ]]; then
  printf 'ERROR: fixture is not clean\n' >&2
  exit 3
fi
exit "$pytest_code"

