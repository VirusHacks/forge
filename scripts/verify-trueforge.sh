#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASE_URL="${TRUEFORGE_BASE_URL:-http://localhost:8790}"
printf '%s\n' 'Checking configured TrueForge endpoint (address omitted from logs).'
printf '%s\n' 'The server must be started separately with: npx @truefoundry/trueforge@latest'

if curl --fail --silent --show-error --max-time 3 "$BASE_URL/healthz"; then
  printf '\nhealthz_exit=0\n'
else
  code=$?
  printf '\nhealthz_exit=%s\n' "$code"
  printf '%s\n' 'No local server reachable; non-model connectivity is blocked until TrueForge is started.'
  exit "$code"
fi

cd "$ROOT_DIR/extension"
if [[ ! -d node_modules ]]; then
  printf '%s\n' 'ERROR: install extension dependencies first: npm install' >&2
  exit 2
fi
node scripts/trueforge-connectivity.mjs

