#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT_DIR/fixtures/flask-3.1.3"
PINNED_COMMIT="22d924701a6ae2e4cd01e9a15bbaf3946094af65"

if [[ ! -d "$FIXTURE/.git" ]]; then
  printf 'ERROR: fixture is missing: %s\n' "$FIXTURE" >&2
  exit 2
fi

if [[ -n "$(git -C "$FIXTURE" status --porcelain)" ]]; then
  printf 'REFUSING: fixture has tracked or untracked changes; inspect it before resetting.\n' >&2
  git -C "$FIXTURE" status --short
  exit 3
fi

git -C "$FIXTURE" fetch --quiet --depth 1 origin tag 3.1.3
git -C "$FIXTURE" checkout --detach --quiet "$PINNED_COMMIT"
printf 'Fixture is clean at %s\n' "$(git -C "$FIXTURE" rev-parse HEAD)"

