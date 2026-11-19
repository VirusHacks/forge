#!/usr/bin/env bash
# Render the write-up to an A4 PDF with headless Chrome (figures are drawn by the page's JS).
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUT="${1:-../Forge-Writeup-Husttlers.pdf}"
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=3000 \
  --print-to-pdf="$OUT" "file://$PWD/forge-writeup.html" 2>/dev/null
echo "wrote $OUT"
