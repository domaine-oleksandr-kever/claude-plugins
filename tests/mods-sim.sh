#!/usr/bin/env bash
# Every plugin hooks module (plugins/*/hooks/mods/**, Claude Code function hooks) is compiled and run by
# the engine itself, so its only checks are the engine's own, per plugin with a hooks/hooks.json:
# `claude plugin validate --strict` (manifest, userConfig, the $.state contract, every hook and $ call
# the source makes) and `claude plugin test` (hooks/mods/tests/*.test.ts(x) under the claude-code/testing kit).
# CI has no claude binary: without one this suite prints SKIP and exits 0, and the release
# checklist runs it locally. Exit 0 = green or skipped.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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

checked=" "
while IFS= read -r hooks_json; do
  [ -f "$hooks_json" ] || continue
  PLUGIN_DIR="$(dirname "$(dirname "$hooks_json")")"
  name="$(basename "$PLUGIN_DIR")"

  if claude plugin validate --strict "$PLUGIN_DIR" >"$OUT" 2>&1; then ok; v=ok
  else v=FAIL; bad "$name validate" "claude plugin validate --strict failed:
$(tail -n 30 "$OUT")"; fi

  if claude plugin test "$PLUGIN_DIR" >"$OUT" 2>&1; then ok; t=ok
  else t=FAIL; bad "$name test" "claude plugin test failed:
$(grep -E '^\(fail\)|error|Error' "$OUT" | head -n 30)"; fi

  echo "mods-sim: $name: validate $v/test $t"
  checked="$checked$name "
done < <(printf '%s\n' "$ROOT"/plugins/*/hooks/hooks.json | LC_ALL=C sort)

# discovery is a glob, so a moved or renamed hooks.json would otherwise check nothing and stay green
case "$checked" in
  *" fnd "*) ok ;;
  *) bad discovery "plugins/fnd/hooks/hooks.json not found — no fnd module was validated (checked:$checked)" ;;
esac
case "$checked" in
  *" slim "*) ok ;;
  *) bad discovery-slim "plugins/slim/hooks/hooks.json not found — no slim module was validated (checked:$checked)" ;;
esac

echo "mods-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
