#!/usr/bin/env bash
# Simulation harness for scripts/bump-version.cjs (multi-harness port, M2).
# Every case builds a throwaway repo layout under $TMP and runs the script with --root
# against it, so the real repo is never mutated. Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BV="$ROOT/plugins/fnd/scripts/bump-version.cjs"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fingerprint of the real repo's own stamp targets — re-checked at the end (C13): a case that
# forgets --root would rewrite the plugin's version for real.
REAL_BEFORE="$(cksum < "$ROOT/plugins/fnd/.claude-plugin/plugin.json"; cksum < "$ROOT/README.md")"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# sandbox <dir> — a repo layout with every stamp target at 0.59.0, plus decoys that must
# survive untouched: a NESTED "version" key in the canonical manifest and README prose
# carrying version-shaped text that is not an fnd marker.
sandbox() {
  local d="$1"
  mkdir -p "$d/plugins/fnd/.claude-plugin" "$d/plugins/fnd/.cursor-plugin" \
           "$d/plugins/fnd/.codex-plugin" "$d/scripts"
  cat > "$d/plugins/fnd/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "fnd",
  "version": "0.59.0",
  "keywords": ["shopify", "foundation"],
  "mcpServers": {
    "shopify-dev-mcp": {
      "command": "npx",
      "env": { "version": "9.9.9" }
    }
  }
}
JSON
  cat > "$d/plugins/fnd/.cursor-plugin/plugin.json" <<'JSON'
{
  "name": "fnd",
  "version": "0.59.0"
}
JSON
  cat > "$d/plugins/fnd/.codex-plugin/plugin.json" <<'JSON'
{
	"name": "fnd",
	"version": "0.59.0"
}
JSON
  cat > "$d/README.md" <<'MD'
# fnd

Installed build: fnd v0.59.0

```bash
FND_VERSION="0.59.0"
```

Requires Node 18.0.0 and Shopify CLI v3.2.1.
MD
  cat > "$d/scripts/install.sh" <<'SH'
#!/usr/bin/env bash
FND_VERSION="0.59.0"
echo "fnd installer"
export FND_VERSION="0.59.0"
SH
}

# snap <dir> — content fingerprint of the whole sandbox, for "nothing was written" asserts
snap() { (cd "$1" && find . -type f | LC_ALL=C sort | xargs cksum); }

# ver <file> — the top-level version of a JSON manifest, read without a JSON parser
ver() { sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1; }

# stamps <dir> — every version stamp in the sandbox, one per line. All-or-nothing means these
# always agree: a run that stamps some targets and dies is the drift this script exists to stop.
stamps() {
  local d="$1"
  ver "$d/plugins/fnd/.claude-plugin/plugin.json"
  ver "$d/plugins/fnd/.cursor-plugin/plugin.json"
  ver "$d/plugins/fnd/.codex-plugin/plugin.json"
  grep -o 'FND_VERSION="[^"]*"' "$d/scripts/install.sh" | head -1 | sed 's/.*"\(.*\)"/\1/'
}
distinct_stamps() { stamps "$1" | LC_ALL=C sort -u | wc -l | tr -d ' '; }

run() { node "$BV" "$@" > "$O" 2> "$E"; }

O="$TMP/out"; E="$TMP/err"

# ---------------------------------------------------------------- C1 explicit stamp --
C1="$TMP/c1"; sandbox "$C1"
rc=0; run 0.60.0 --root "$C1" || rc=$?
if [ "$rc" -eq 0 ] \
   && [ "$(ver "$C1/plugins/fnd/.claude-plugin/plugin.json")" = "0.60.0" ] \
   && [ "$(ver "$C1/plugins/fnd/.cursor-plugin/plugin.json")" = "0.60.0" ] \
   && [ "$(ver "$C1/plugins/fnd/.codex-plugin/plugin.json")" = "0.60.0" ] \
   && grep -q 'fnd v0.60.0' "$C1/README.md" \
   && [ "$(grep -c 'FND_VERSION="0.60.0"' "$C1/README.md")" -eq 1 ] \
   && [ "$(grep -c 'FND_VERSION="0.60.0"' "$C1/scripts/install.sh")" -eq 2 ]; then ok
else bad C1-stamp-all "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E")"; fi

# C1b the decoys: a nested "version" key and non-marker README prose stay as they were
if grep -q '"version": "9.9.9"' "$C1/plugins/fnd/.claude-plugin/plugin.json" \
   && grep -q 'Node 18.0.0' "$C1/README.md" \
   && grep -q 'Shopify CLI v3.2.1' "$C1/README.md"; then ok
else bad C1b-decoys-untouched "manifest=$(grep -c 9.9.9 "$C1/plugins/fnd/.claude-plugin/plugin.json") readme=$(grep -n '18.0.0\|3.2.1' "$C1/README.md" | tr '\n' ';')"; fi

# C1c the stage-and-rename write path carries each target's file mode (install.sh is
# executable in the real repo; a rename from a default-mode stage file dropped the x bit)
C1C="$TMP/c1c"; sandbox "$C1C"; chmod 755 "$C1C/scripts/install.sh"
rc=0; run 0.60.0 --root "$C1C" || rc=$?
if [ "$rc" -eq 0 ] && [ -x "$C1C/scripts/install.sh" ] && [ ! -x "$C1C/README.md" ]; then ok
else bad C1c-mode-preserved "rc=$rc mode=$(ls -l "$C1C/scripts/install.sh" | cut -d' ' -f1)"; fi

# C1c formatting survives: only the one version line differs from the pristine sandbox
C1REF="$TMP/c1ref"; sandbox "$C1REF"
DIFFLINES="$(diff "$C1REF/plugins/fnd/.claude-plugin/plugin.json" "$C1/plugins/fnd/.claude-plugin/plugin.json" | grep -c '^[<>]')"
TABS="$(grep -c '^	"version"' "$C1/plugins/fnd/.codex-plugin/plugin.json")"
if [ "$DIFFLINES" -eq 2 ] && grep -q '"keywords": \["shopify", "foundation"\]' "$C1/plugins/fnd/.claude-plugin/plugin.json" \
   && [ "$TABS" -eq 1 ]; then ok
else bad C1c-formatting-preserved "difflines=$DIFFLINES tabs=$TABS"; fi

# ------------------------------------------------------------------- C2 idempotence --
BEFORE="$(snap "$C1")"
rc=0; run 0.60.0 --root "$C1" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(snap "$C1")" = "$BEFORE" ] \
   && [ "$(grep -c '^  unchanged ' "$O")" -eq 5 ] && ! grep -q '^  stamped ' "$O"; then ok
else bad C2-idempotent "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# --------------------------------------------------------------- C3 keyword bumps --
for pair in "patch 0.59.1" "minor 0.60.0" "major 1.0.0"; do
  kw="${pair%% *}"; want="${pair##* }"
  D="$TMP/kw-$kw"; sandbox "$D"
  rc=0; run "$kw" --root "$D" || rc=$?
  if [ "$rc" -eq 0 ] \
     && [ "$(ver "$D/plugins/fnd/.claude-plugin/plugin.json")" = "$want" ] \
     && [ "$(ver "$D/plugins/fnd/.codex-plugin/plugin.json")" = "$want" ] \
     && grep -q "fnd v$want" "$D/README.md" \
     && grep -q "^bump-version: 0.59.0 -> $want" "$O"; then ok
  else bad "C3-$kw" "rc=$rc got=$(ver "$D/plugins/fnd/.claude-plugin/plugin.json") want=$want out=$(tr '\n' ';' < "$O")"; fi
done

# ------------------------------------------------------------- C4 malformed versions --
C4="$TMP/c4"; sandbox "$C4"; BEFORE="$(snap "$C4")"
for v in 1.2 v1.2.3 1.2.3.4 01.2.3 abc "1.2.3 " "-1.2.3"; do
  rc=0; run "$v" --root "$C4" || rc=$?
  if [ "$rc" -eq 1 ] && [ "$(snap "$C4")" = "$BEFORE" ] && grep -q 'not a valid semver\|unknown option' "$E"; then ok
  else bad "C4-bad-version[$v]" "rc=$rc err=$(head -c 160 "$E") mutated=$([ "$(snap "$C4")" = "$BEFORE" ] && echo no || echo yes)"; fi
done

# --------------------------------------------------------- C5 missing required target --
C5="$TMP/c5"; sandbox "$C5"; rm "$C5/plugins/fnd/.codex-plugin/plugin.json"
BEFORE="$(snap "$C5")"
rc=0; run 0.60.0 --root "$C5" || rc=$?
if [ "$rc" -eq 2 ] && [ "$(snap "$C5")" = "$BEFORE" ] \
   && grep -q 'codex-plugin/plugin.json — required target is missing' "$E" \
   && grep -q 'nothing was written' "$E"; then ok
else bad C5-missing-required "rc=$rc err=$(tr '\n' ';' < "$E")"; fi

# C5b README is a required file too
C5B="$TMP/c5b"; sandbox "$C5B"; rm "$C5B/README.md"; BEFORE="$(snap "$C5B")"
rc=0; run 0.60.0 --root "$C5B" || rc=$?
if [ "$rc" -eq 2 ] && [ "$(snap "$C5B")" = "$BEFORE" ]; then ok
else bad C5b-missing-readme "rc=$rc err=$(tr '\n' ';' < "$E")"; fi

# ------------------------------------------------------------------ C6 unparsable JSON --
C6="$TMP/c6"; sandbox "$C6"; printf '{ "name": "fnd", ' > "$C6/plugins/fnd/.cursor-plugin/plugin.json"
BEFORE="$(snap "$C6")"
rc=0; run 0.60.0 --root "$C6" || rc=$?
if [ "$rc" -eq 2 ] && [ "$(snap "$C6")" = "$BEFORE" ] && grep -q 'unparsable JSON' "$E"; then ok
else bad C6-unparsable "rc=$rc err=$(tr '\n' ';' < "$E")"; fi

# C6b a manifest with no top-level version field
C6B="$TMP/c6b"; sandbox "$C6B"; printf '{\n  "name": "fnd"\n}\n' > "$C6B/plugins/fnd/.codex-plugin/plugin.json"
BEFORE="$(snap "$C6B")"
rc=0; run 0.60.0 --root "$C6B" || rc=$?
if [ "$rc" -eq 2 ] && [ "$(snap "$C6B")" = "$BEFORE" ] && grep -q 'no top-level "version" string' "$E"; then ok
else bad C6b-no-version-field "rc=$rc err=$(tr '\n' ';' < "$E")"; fi

# C6c a non-semver version already in a manifest is a refusal, not a silent overwrite
C6C="$TMP/c6c"; sandbox "$C6C"; printf '{\n  "name": "fnd",\n  "version": "0.59"\n}\n' > "$C6C/plugins/fnd/.cursor-plugin/plugin.json"
BEFORE="$(snap "$C6C")"
rc=0; run 0.60.0 --root "$C6C" || rc=$?
if [ "$rc" -eq 2 ] && [ "$(snap "$C6C")" = "$BEFORE" ] && grep -q 'is not semver' "$E"; then ok
else bad C6c-nonsemver-current "rc=$rc err=$(tr '\n' ';' < "$E")"; fi

# C6d keyword bump with an unparsable canonical manifest cannot compute a base
C6D="$TMP/c6d"; sandbox "$C6D"; printf 'not json' > "$C6D/plugins/fnd/.claude-plugin/plugin.json"
BEFORE="$(snap "$C6D")"
rc=0; run patch --root "$C6D" || rc=$?
if [ "$rc" -eq 2 ] && [ "$(snap "$C6D")" = "$BEFORE" ] && grep -q 'cannot compute a patch bump' "$E"; then ok
else bad C6d-keyword-no-canonical "rc=$rc err=$(tr '\n' ';' < "$E")"; fi

# ------------------------------------------------------- C7 documented text no-ops --
C7="$TMP/c7"; sandbox "$C7"; printf '# fnd\n\nNo version markers here.\n' > "$C7/README.md"
README_BEFORE="$(cksum < "$C7/README.md")"
rc=0; run 0.60.0 --root "$C7" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(cksum < "$C7/README.md")" = "$README_BEFORE" ] \
   && grep -q '^  skipped   README.md  no fnd version markers' "$O" \
   && [ "$(ver "$C7/plugins/fnd/.cursor-plugin/plugin.json")" = "0.60.0" ]; then ok
else bad C7-readme-noop "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# C7b the optional installer target: absent is reported, not fatal
C7B="$TMP/c7b"; sandbox "$C7B"; rm "$C7B/scripts/install.sh"
rc=0; run 0.60.0 --root "$C7B" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^  missing   scripts/install.sh  optional target — not present' "$O" \
   && [ "$(ver "$C7B/plugins/fnd/.claude-plugin/plugin.json")" = "0.60.0" ]; then ok
else bad C7b-installer-optional "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# --------------------------------------------------------------------- C8 drift heal --
C8="$TMP/c8"; sandbox "$C8"
printf '{\n  "name": "fnd",\n  "version": "0.1.0"\n}\n' > "$C8/plugins/fnd/.cursor-plugin/plugin.json"
printf 'fnd v0.42.0 and FND_VERSION="0.7.0"\n' > "$C8/README.md"
rc=0; run patch --root "$C8" || rc=$?
if [ "$rc" -eq 0 ] \
   && [ "$(ver "$C8/plugins/fnd/.cursor-plugin/plugin.json")" = "0.59.1" ] \
   && [ "$(cat "$C8/README.md")" = 'fnd v0.59.1 and FND_VERSION="0.59.1"' ] \
   && grep -q 'cursor-plugin/plugin.json  0.1.0 -> 0.59.1' "$O"; then ok
else bad C8-drift-heal "rc=$rc cursor=$(ver "$C8/plugins/fnd/.cursor-plugin/plugin.json") readme=$(cat "$C8/README.md") out=$(tr '\n' ';' < "$O")"; fi

# ----------------------------------------------------------------------- C9 dry run --
C9="$TMP/c9"; sandbox "$C9"; BEFORE="$(snap "$C9")"
rc=0; run 1.0.0 --root "$C9" --dry-run || rc=$?
if [ "$rc" -eq 0 ] && [ "$(snap "$C9")" = "$BEFORE" ] \
   && grep -q 'dry run — nothing written' "$O" && grep -q '^  stamped   README.md' "$O"; then ok
else bad C9-dry-run "rc=$rc out=$(tr '\n' ';' < "$O")"; fi

# ------------------------------------------------------------------- C10 usage paths --
rc=0; run --root "$TMP/c1" || rc=$?
if [ "$rc" -eq 1 ] && grep -q 'missing version argument' "$E"; then ok
else bad C10-no-version-arg "rc=$rc err=$(head -c 160 "$E")"; fi

rc=0; run 0.60.0 --root || rc=$?
if [ "$rc" -eq 1 ] && grep -q -- '--root needs a directory' "$E"; then ok
else bad C10b-root-without-value "rc=$rc err=$(head -c 160 "$E")"; fi

rc=0; run 0.60.0 --root "$TMP/nope" || rc=$?
if [ "$rc" -eq 1 ] && grep -q 'is not a directory' "$E"; then ok
else bad C10c-root-missing-dir "rc=$rc err=$(head -c 160 "$E")"; fi

rc=0; run 0.60.0 0.61.0 --root "$TMP/c1" || rc=$?
if [ "$rc" -eq 1 ] && grep -q 'unexpected argument' "$E"; then ok
else bad C10d-extra-arg "rc=$rc err=$(head -c 160 "$E")"; fi

rc=0; run --help || rc=$?
if [ "$rc" -eq 0 ] && grep -q 'usage: node bump-version.cjs' "$O"; then ok
else bad C10e-help "rc=$rc out=$(head -c 160 "$O")"; fi

# ------------------------------------------------------- C11 prerelease + keyword bump --
C11="$TMP/c11"; sandbox "$C11"
printf '{\n  "name": "fnd",\n  "version": "1.0.0-rc.1"\n}\n' > "$C11/plugins/fnd/.claude-plugin/plugin.json"
BEFORE="$(snap "$C11")"
rc=0; run minor --root "$C11" || rc=$?
if [ "$rc" -eq 1 ] && [ "$(snap "$C11")" = "$BEFORE" ] && grep -q 'prerelease/build suffix' "$E"; then ok
else bad C11-prerelease-keyword "rc=$rc err=$(head -c 200 "$E")"; fi

# C11b an explicit prerelease version stamps fine
rc=0; run 1.0.0-rc.2 --root "$C11" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(ver "$C11/plugins/fnd/.claude-plugin/plugin.json")" = "1.0.0-rc.2" ] \
   && [ "$(ver "$C11/plugins/fnd/.codex-plugin/plugin.json")" = "1.0.0-rc.2" ]; then ok
else bad C11b-prerelease-explicit "rc=$rc got=$(ver "$C11/plugins/fnd/.claude-plugin/plugin.json") err=$(head -c 160 "$E")"; fi

# --------------------------------------------------- C12 default root = script's repo --
# The script ships inside the tree it stamps; with no --root it must resolve the repo root
# from __dirname (three levels up) — proven inside a sandbox copy, never on the real repo.
C12="$TMP/c12"; sandbox "$C12"; mkdir -p "$C12/plugins/fnd/scripts"
cp "$BV" "$C12/plugins/fnd/scripts/bump-version.cjs"
rc=0; (cd "$TMP" && node "$C12/plugins/fnd/scripts/bump-version.cjs" 0.60.0) > "$O" 2> "$E" || rc=$?
if [ "$rc" -eq 0 ] && [ "$(ver "$C12/plugins/fnd/.cursor-plugin/plugin.json")" = "0.60.0" ] \
   && grep -q 'fnd v0.60.0' "$C12/README.md"; then ok
else bad C12-default-root "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E")"; fi

# ----------------------------------------- C14 a write that fails leaves no half-stamp --
# (bug) Read/parse validation is not enough: a target that parses fine but cannot be written
# (read-only vendored checkout, file held by another process) used to abort mid-loop with the
# earlier targets already stamped. The invariant is all-or-nothing, so the assert covers both
# legitimate outcomes — refuse and write nothing, or stamp every target — and never a mix.
C14="$TMP/c14"; sandbox "$C14"
chmod 444 "$C14/plugins/fnd/.codex-plugin/plugin.json"
BEFORE="$(snap "$C14")"
rc=0; run 0.60.0 --root "$C14" || rc=$?
UNIQ="$(distinct_stamps "$C14")"
if [ "$UNIQ" -eq 1 ] && { [ "$rc" -eq 0 ] \
   || { [ "$rc" -eq 2 ] && [ "$(snap "$C14")" = "$BEFORE" ] \
        && grep -q 'codex-plugin/plugin.json — not writable' "$E" \
        && grep -q 'nothing was written' "$E"; }; }; then ok
else bad C14-readonly-target "rc=$rc distinct-stamps=$UNIQ err=$(tr '\n' ';' < "$E")"; fi
chmod 644 "$C14/plugins/fnd/.codex-plugin/plugin.json"

# C14b the same for a read-only directory, where staging the new content is what fails
C14B="$TMP/c14b"; sandbox "$C14B"
chmod 555 "$C14B/plugins/fnd/.cursor-plugin"
BEFORE="$(snap "$C14B")"
rc=0; run 0.60.0 --root "$C14B" || rc=$?
UNIQ="$(distinct_stamps "$C14B")"
if [ "$UNIQ" -eq 1 ] && { [ "$rc" -eq 0 ] \
   || { [ "$rc" -eq 2 ] && [ "$(snap "$C14B")" = "$BEFORE" ] && grep -q 'not writable' "$E"; }; }; then ok
else bad C14b-readonly-dir "rc=$rc distinct-stamps=$UNIQ err=$(tr '\n' ';' < "$E")"; fi
chmod 755 "$C14B/plugins/fnd/.cursor-plugin"

# ------------------------------------------------------- C15 hand formatting is not a contract --
# (bug) A manifest reformatted onto one line (jq -c, a wide prettier, a future generator) has no
# `"version"` line to anchor on; the release command must still stamp it.
C15="$TMP/c15"; sandbox "$C15"
printf '{"name":"fnd","version":"0.59.0","skills":"skills/"}' > "$C15/plugins/fnd/.cursor-plugin/plugin.json"
rc=0; run 0.60.0 --root "$C15" || rc=$?
if [ "$rc" -eq 0 ] && grep -q '"version":"0.60.0"' "$C15/plugins/fnd/.cursor-plugin/plugin.json" \
   && grep -q '"skills":"skills/"' "$C15/plugins/fnd/.cursor-plugin/plugin.json" \
   && [ "$(ver "$C15/plugins/fnd/.codex-plugin/plugin.json")" = "0.60.0" ]; then ok
else bad C15-minified-manifest "rc=$rc got=$(cat "$C15/plugins/fnd/.cursor-plugin/plugin.json") err=$(head -c 200 "$E")"; fi

# C15b ...but an ambiguous minified manifest (a nested version with the same value) is still a
# refusal — guessing which one is top-level is how a nested field gets corrupted.
C15B="$TMP/c15b"; sandbox "$C15B"
printf '{"name":"fnd","version":"0.59.0","env":{"version":"0.59.0"}}' > "$C15B/plugins/fnd/.cursor-plugin/plugin.json"
BEFORE="$(snap "$C15B")"
rc=0; run 0.60.0 --root "$C15B" || rc=$?
if [ "$rc" -eq 2 ] && [ "$(snap "$C15B")" = "$BEFORE" ] \
   && grep -q 'could not locate the "version" line' "$E"; then ok
else bad C15b-minified-ambiguous "rc=$rc err=$(tr '\n' ';' < "$E")"; fi

# ------------------------------------------------- C16 staging files never survive a run --
LEFTOVERS="$(find "$TMP" -name '*.bump-version-tmp' 2>/dev/null | tr '\n' ';')"
if [ -z "$LEFTOVERS" ]; then ok; else bad C16-stage-leftovers "$LEFTOVERS"; fi

# ------------------------------------------------- C13 the real repo is never mutated --
REAL_AFTER="$(cksum < "$ROOT/plugins/fnd/.claude-plugin/plugin.json"; cksum < "$ROOT/README.md")"
if [ "$REAL_AFTER" = "$REAL_BEFORE" ]; then ok
else bad C13-real-repo-clean "the suite rewrote the repo's own version stamps"; fi

echo "bump-version-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
