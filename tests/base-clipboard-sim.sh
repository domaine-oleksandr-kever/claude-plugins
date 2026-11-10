#!/usr/bin/env bash
# Simulation harness for plugins/base/scripts/clipboard.sh. Every case runs the script on a PATH it
# builds: a `base` dir with only the POSIX tools the script needs, plus fake clipboard tools — a
# pbcopy / xclip / xsel that write stdin and their argv to $TMP, an xclip that fails. No real
# clipboard is touched. Exit 0 = all green.
set -u
unset BASE_CLIPBOARD

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CB="$ROOT/plugins/base/scripts/clipboard.sh"
BASH_BIN="$(command -v bash)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
O="$TMP/out"; E="$TMP/err"; GOT="$TMP/got"; ARGV="$TMP/argv"
BASE="$TMP/base"; OK="$TMP/ok"; FAILX="$TMP/failx"; XSEL="$TMP/xsel"
mkdir -p "$BASE" "$OK" "$FAILX" "$XSEL"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }
show() { printf 'rc=%s out=%s err=%s' "$rc" "$(tr '\n' ';' < "$O" | head -c 300)" "$(tr '\n' ';' < "$E" | head -c 200)"; }

for t in cat wc tr mktemp rm; do
  p="$(command -v "$t")" || { echo "base-clipboard-sim: no $t on PATH"; exit 1; }
  ln -s "$p" "$BASE/$t"
done
fake() { # fake <dir> <name> <exit code>: records argv and stdin, exits with the code
  cat > "$1/$2" <<SH
#!$BASH_BIN
printf '%s\n' "\$*" > "$ARGV"
cat > "$GOT"
exit $3
SH
  chmod +x "$1/$2"
}
fake "$OK" pbcopy 0
fake "$OK" xclip 0
fake "$FAILX" xclip 1
fake "$XSEL" xsel 0

# cb <path dirs> <args…> — runs the script on that PATH; stdin comes from the caller
cb() { local p="$1"; shift; rc=0; rm -f "$GOT" "$ARGV"; PATH="$p" "$BASH_BIN" "$CB" "$@" >"$O" 2>"$E" || rc=$?; }
line() { [ "$(wc -l < "$O" | tr -d ' ')" -eq 1 ] && [ "$(cat "$O")" = "$1" ]; }

# C1: usage, both spellings, no probing
for h in --help -h; do
  cb "$OK:$BASE" "$h" </dev/null
  if [ "$rc" -eq 0 ] && grep -q '^usage: clipboard.sh' "$O" && [ ! -e "$GOT" ]; then ok; else bad "C1-help$h" "$(show)"; fi
done

# C2: stdin → pbcopy first; one line with the byte count; the text reaches the tool and never stdout/stderr
printf 'secret prompt text\nline 2\n' > "$TMP/in"
cb "$OK:$BASE" < "$TMP/in"
if [ "$rc" -eq 0 ] && line "result=copied tool=pbcopy bytes=26" && cmp -s "$GOT" "$TMP/in" \
   && ! grep -q secret "$O" "$E"; then ok; else bad C2-stdin-pbcopy "$(show)"; fi

# C3: --file reads the file, stdin ignored
printf 'from the file' > "$TMP/f.md"
cb "$OK:$BASE" --file "$TMP/f.md" </dev/null
if [ "$rc" -eq 0 ] && line "result=copied tool=pbcopy bytes=13" && cmp -s "$GOT" "$TMP/f.md"; then ok; else bad C3-file "$(show)"; fi

# C4: without pbcopy, xclip runs with -selection clipboard
mkdir -p "$TMP/xonly"; cp "$OK/xclip" "$TMP/xonly/"
cb "$TMP/xonly:$BASE" <<<x
if [ "$rc" -eq 0 ] && line "result=copied tool=xclip bytes=2" && [ "$(cat "$ARGV")" = "-selection clipboard" ]; then ok
else bad C4-xclip-args "$(show) argv=$(cat "$ARGV" 2>/dev/null)"; fi

# C5: xsel runs with --clipboard --input
cb "$XSEL:$BASE" <<<y
if [ "$rc" -eq 0 ] && line "result=copied tool=xsel bytes=2" && [ "$(cat "$ARGV")" = "--clipboard --input" ]; then ok
else bad C5-xsel-args "$(show) argv=$(cat "$ARGV" 2>/dev/null)"; fi

# C6: the first tool found fails → copy_failed, exit 3, the next tool is not tried
cb "$FAILX:$XSEL:$BASE" <<<z
if [ "$rc" -eq 3 ] && line "result=unavailable error=copy_failed" && [ "$(cat "$ARGV")" = "-selection clipboard" ]; then ok
else bad C6-copy-failed "$(show)"; fi

# C7: no clipboard tool on PATH → no_clipboard_tool, exit 3
cb "$BASE" <<<z
if [ "$rc" -eq 3 ] && line "result=unavailable error=no_clipboard_tool"; then ok; else bad C7-no-tool "$(show)"; fi

# C8: empty input (stdin and file) → empty, exit 2, no tool run
cb "$OK:$BASE" </dev/null
if [ "$rc" -eq 2 ] && line "result=unavailable error=empty" && [ ! -e "$GOT" ]; then ok; else bad C8-empty-stdin "$(show)"; fi
: > "$TMP/empty.md"
cb "$OK:$BASE" --file "$TMP/empty.md" </dev/null
if [ "$rc" -eq 2 ] && line "result=unavailable error=empty" && [ ! -e "$GOT" ]; then ok; else bad C8b-empty-file "$(show)"; fi

# C9: BASE_CLIPBOARD=0 → disabled, exit 3, stdin unread and no tool run; any other value stays on
rc=0; rm -f "$GOT"; printf 'q' | BASE_CLIPBOARD=0 PATH="$OK:$BASE" "$BASH_BIN" "$CB" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 3 ] && line "result=unavailable error=disabled" && [ ! -e "$GOT" ]; then ok; else bad C9-disabled "$(show)"; fi
rc=0; rm -f "$GOT"; printf 'q' | BASE_CLIPBOARD=1 PATH="$OK:$BASE" "$BASH_BIN" "$CB" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && line "result=copied tool=pbcopy bytes=1"; then ok; else bad C9b-enabled "$(show)"; fi

# C10: usage errors → exit 2: unknown flag, --file without a path, a missing file
cb "$OK:$BASE" --nope </dev/null
if [ "$rc" -eq 2 ] && line "result=unavailable error=usage"; then ok; else bad C10-unknown-flag "$(show)"; fi
cb "$OK:$BASE" --file </dev/null
if [ "$rc" -eq 2 ] && line "result=unavailable error=usage"; then ok; else bad C10b-file-no-arg "$(show)"; fi
cb "$OK:$BASE" --file "$TMP/missing.md" </dev/null
if [ "$rc" -eq 2 ] && line "result=unavailable error=usage" && [ ! -e "$GOT" ]; then ok; else bad C10c-missing-file "$(show)"; fi

# C11: the script leaves no temp file behind
TD="$TMP/td"; mkdir -p "$TD"
rc=0; printf 'w' | TMPDIR="$TD" PATH="$OK:$BASE" "$BASH_BIN" "$CB" >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && [ -z "$(ls -A "$TD")" ]; then ok; else bad C11-no-temp-left "$(show) left=$(ls -A "$TD")"; fi

echo "base-clipboard-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
