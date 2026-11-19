#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

status=0
run_check() {
  label="$1"
  shift
  printf '\n[%s]\n' "$label"
  if "$@"; then
    printf 'exit=0\n'
  else
    code=$?
    printf 'exit=%s\n' "$code"
    status=1
  fi
}

run_check "platform" uname -a
run_check "architecture" arch
run_check "node" node --version
run_check "npm" npm --version
run_check "python" python3 --version
run_check "pip" pip3 --version
run_check "uv" uv --version
run_check "git" git --version
run_check "vscode" code --version
run_check "trueforge package metadata" npm view @truefoundry/trueforge version engines --json

printf '\ncommand paths\n'
for command_name in node npm python3 pip3 uv git code npx trueforge; do
  printf '%-10s %s\n' "$command_name" "$(command -v "$command_name" 2>/dev/null || printf 'not-found')"
done

exit "$status"

