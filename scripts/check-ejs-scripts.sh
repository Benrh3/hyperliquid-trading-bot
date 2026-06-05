#!/usr/bin/env bash
# check-ejs-scripts.sh — extract inline <script> blocks from every EJS template,
# strip EJS server-side interpolations (which produce valid JS at render time),
# and run `node --check` to catch client-side JS syntax errors before they ship.
#
# EJS substitution rules (applied with Perl multi-line slurp so patterns can
# span multiple lines, as they often do in template literals):
#   <%= expr %> / <%- expr %>  →  replaced with  0   (valid numeric literal)
#   <% code %>                 →  replaced with  ''  (empty string, no-op)
#
# Usage:  bash scripts/check-ejs-scripts.sh

set -euo pipefail

VIEWS_DIR="$(dirname "$0")/../src/dashboard/views"
TMPFILE="$(mktemp /tmp/hl_ejs_scripts_XXXXXX.js)"
trap 'rm -f "$TMPFILE"' EXIT

for f in "$VIEWS_DIR"/*.ejs; do
  # Step 1: extract inline <script>…</script> blocks (skip <script src="…">)
  # Step 2: strip EJS with perl -0777 (slurp whole file so .* matches newlines)
  awk '
    /<script[[:space:]]+[^>]*src=/ { skip=1 }
    /<\/script>/                   { if (skip) skip=0; else p=0; next }
    /<script>/ && !skip            { p=1; next }
    p && !skip                     { print }
  ' "$f" \
  | perl -0777 -pe \
      's/<%[-=].*?%>/0/gs;   # output/escaped expressions → 0
       s/<%.*?%>//gs;         # scriptlet blocks → empty
      ' \
  >> "$TMPFILE"
  printf '\n' >> "$TMPFILE"
done

LINES=$(wc -l < "$TMPFILE")
echo "[check-ejs-scripts] Checking ${LINES} lines of extracted JS from $(basename "$VIEWS_DIR")/*.ejs ..."
node --check "$TMPFILE"
echo "[check-ejs-scripts] All inline scripts passed syntax check."
