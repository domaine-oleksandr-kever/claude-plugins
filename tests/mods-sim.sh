#!/usr/bin/env bash
# The fnd hooks module (plugins/fnd/hooks/mods/**, Claude Code function hooks) is compiled and run by
# the engine itself, so its only checks are the engine's own: `claude plugin validate --strict`
# (manifest, userConfig, the $.state contract, every hook and $ call the source makes) and
# `claude plugin test` (hooks/mods/tests/*.test.ts(x) under the claude-code/testing kit).
# CI has no claude binary: without one this suite prints SKIP and exits 0, and the release
# checklist runs it locally. Exit 0 = green or skipped.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT/plugins/fnd"

if ! command -v claude >/dev/null 2>&1; then
  echo "mods-sim: SKIP (no claude binary on PATH)"
  exit 0
fi

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

if claude plugin validate --strict "$PLUGIN_DIR" >"$OUT" 2>&1; then ok
else bad validate "claude plugin validate --strict failed:
$(tail -n 30 "$OUT")"; fi

if claude plugin test "$PLUGIN_DIR" >"$OUT" 2>&1; then ok
else bad test "claude plugin test failed:
$(grep -E '^\(fail\)|error|Error' "$OUT" | head -n 30)"; fi

echo "mods-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
