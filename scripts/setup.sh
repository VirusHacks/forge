#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT_DIR/fixtures/flask-3.1.3"
VENV="$ROOT_DIR/scratch/flask-3.1.3-venv"
PINNED_COMMIT="22d924701a6ae2e4cd01e9a15bbaf3946094af65"

if [[ ! -d "$FIXTURE/.git" ]]; then
  printf 'ERROR: missing Flask fixture at %s\n' "$FIXTURE" >&2
  exit 2
fi
if [[ "$(git -C "$FIXTURE" rev-parse HEAD)" != "$PINNED_COMMIT" ]]; then
  printf 'ERROR: Flask fixture is not at the required commit %s\n' "$PINNED_COMMIT" >&2
  exit 3
fi
if [[ -n "$(git -C "$FIXTURE" status --porcelain)" ]]; then
  printf 'REFUSING: Flask fixture has local changes; use a scratch clone for experiments.\n' >&2
  git -C "$FIXTURE" status --short
  exit 4
fi

npm ci --prefix "$ROOT_DIR/extension"
if [[ ! -x "$VENV/bin/python" ]]; then
  uv venv "$VENV"
fi
VIRTUAL_ENV="$VENV" uv sync \
  --project "$FIXTURE" \
  --no-default-groups \
  --group tests \
  --active \
  --locked

printf '\nSetup complete. Run ./scripts/verify-flask-baseline.sh and npm --prefix extension test.\n'

