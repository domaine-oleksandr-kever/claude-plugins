#!/usr/bin/env bash
#
# clipboard.sh — put one text on the system clipboard, for a hand-over the developer pastes
# elsewhere (`/base:shopify`'s Sidekick relay prompt). The chat keeps the text too: the clipboard
# is a convenience, never the only copy.
#
# Input: the text on stdin, or --file <path>. The text is never logged or echoed.
# Tool: the first one on PATH of pbcopy, wl-copy, xclip -selection clipboard,
# xsel --clipboard --input, clip.exe. BASE_CLIPBOARD=0 turns the script off without probing.
#
# Usage:
#   clipboard.sh [--file <path>] < text
#
# Output: one stdout line.
#   result=copied tool=<name> bytes=<n>                         exit 0
#   result=unavailable error=empty                              exit 2 (also a usage error: error=usage)
#   result=unavailable error=disabled|no_clipboard_tool|copy_failed   exit 3
set -u

usage() {
  cat <<'EOF'
usage: clipboard.sh [--file <path>]
Copies the text on stdin (or in <path>) to the system clipboard with the first of pbcopy, wl-copy,
xclip, xsel, clip.exe on PATH. Prints one line: result=copied tool=<name> bytes=<n> (exit 0), or
result=unavailable error=empty (exit 2) | disabled | no_clipboard_tool | copy_failed (exit 3).
BASE_CLIPBOARD=0 turns it off.
EOF
}

file=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --file)
      [ $# -ge 2 ] || { echo "result=unavailable error=usage"; exit 2; }
      file="$2"; shift 2 ;;
    *) echo "result=unavailable error=usage"; exit 2 ;;
  esac
done

if [ "${BASE_CLIPBOARD:-}" = "0" ]; then
  echo "result=unavailable error=disabled"; exit 3
fi

tmp="$(mktemp "${TMPDIR:-/tmp}/base-clipboard.XXXXXX")" || { echo "result=unavailable error=copy_failed"; exit 3; }
trap 'rm -f "$tmp"' EXIT
if [ -n "$file" ]; then
  [ -f "$file" ] && [ -r "$file" ] || { echo "result=unavailable error=usage"; exit 2; }
  cat -- "$file" > "$tmp"
else
  cat > "$tmp"
fi

bytes="$(wc -c < "$tmp" | tr -d ' ')"
if [ "$bytes" -eq 0 ]; then
  echo "result=unavailable error=empty"; exit 2
fi

for tool in pbcopy wl-copy xclip xsel clip.exe; do
  command -v "$tool" >/dev/null 2>&1 || continue
  case "$tool" in
    xclip) set -- xclip -selection clipboard ;;
    xsel) set -- xsel --clipboard --input ;;
    *) set -- "$tool" ;;
  esac
  if "$@" < "$tmp" >/dev/null 2>&1; then
    echo "result=copied tool=$tool bytes=$bytes"; exit 0
  fi
  echo "result=unavailable error=copy_failed"; exit 3
done

echo "result=unavailable error=no_clipboard_tool"; exit 3
