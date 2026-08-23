#!/usr/bin/env bash
# Simulation harness for plugins/fnd/scripts/opencode-config.cjs — the renderer of the three
# opencode.json blocks a user pastes by hand.
# Hermetic: the happy path reads the real checkout (read-only — the renderer never writes), and
# every failure case runs against a THROWAWAY copy of the plugin root under $TMP, so a deleted
# fragment or a corrupted one is never the developer's own file. Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugins/fnd"
CLI="$PLUGIN/scripts/opencode-config.cjs"
NODE_BIN="$(command -v node)"
# The renderer resolves its own location, so the expected paths are the PHYSICAL ones; a logical
# `pwd` would disagree with it the moment the checkout sits behind a symlink.
HOOKS_REAL="$(cd "$PLUGIN/hooks" && pwd -P)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

O="$TMP/out"; E="$TMP/err"; RC=0

# run <script> [args...] — the renderer from a scratch cwd; RC/O/E hold the result
run() {
  local script="$1"; shift
  RC=0
  ( cd "$TMP" && "$NODE_BIN" "$script" "$@" ) >"$O" 2>"$E" || RC=$?
}

# mkcopy <dir> — a throwaway plugin root: the renderer plus the three inputs it reads
mkcopy() {
  local d="$1"
  mkdir -p "$d/scripts" "$d/opencode" "$d/hooks"
  cp "$CLI" "$d/scripts/opencode-config.cjs"
  cp "$PLUGIN/opencode/mcp-fragment.json" "$d/opencode/mcp-fragment.json"
  cp "$PLUGIN/opencode/permission-fragment.example.json" "$d/opencode/permission-fragment.example.json"
  cp "$PLUGIN"/hooks/*.md "$d/hooks/"
}

# fences <file> — every ```json block re-serialized compactly, one per line; non-zero when a
# block does not parse, which is the whole point of printing them fenced
fences() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const out = [];
    for (const m of text.matchAll(/^```json\n([\s\S]*?)^```$/gm)) {
      try { out.push(JSON.stringify(JSON.parse(m[1]))); }
      catch (e) { process.stderr.write("block " + (out.length + 1) + ": " + e.message); process.exit(1); }
    }
    process.stdout.write(out.map((x) => x + "\n").join(""));
  ' "$1" 2>>"$TMP/fence-err"
}

# fence_to <file> <n> <dest> — the nth fenced block's body, written out for a JSON reader
fence_to() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const blocks = [...fs.readFileSync(process.argv[1], "utf8").matchAll(/^```json\n([\s\S]*?)^```$/gm)];
    const b = blocks[Number(process.argv[2]) - 1];
    if (!b) process.exit(1);
    fs.writeFileSync(process.argv[3], b[1]);
  ' "$1" "$2" "$3" 2>/dev/null
}

# jkeys <file> — the top-level keys of a JSON object, comma-separated in document order
jkeys() {
  "$NODE_BIN" -e '
    const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(Object.keys(o).join(","));
  ' "$1" 2>/dev/null
}

# jlines <file> <key> — the array at <key>, one element per line
jlines() {
  "$NODE_BIN" -e '
    const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = o[process.argv[2]];
    if (!Array.isArray(v)) process.exit(1);
    process.stdout.write(v.map((x) => x + "\n").join(""));
  ' "$1" "$2" 2>/dev/null
}

# deepeq <file-a> <key-a> <file-b> <key-b> — deep equality of two sub-objects, key order made
# irrelevant so this proves the CONTENT was carried, not the serialization
deepeq() {
  "$NODE_BIN" -e '
    const fs = require("fs");
    const canon = (v) => Array.isArray(v) ? v.map(canon)
      : (v && typeof v === "object")
        ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {})
        : v;
    const pick = (f, k) => JSON.parse(fs.readFileSync(f, "utf8"))[k];
    const a = pick(process.argv[1], process.argv[2]);
    const b = pick(process.argv[3], process.argv[4]);
    process.exit(JSON.stringify(canon(a)) === JSON.stringify(canon(b)) ? 0 : 1);
  ' "$1" "$2" "$3" "$4" 2>/dev/null
}

# jkeyseq <file> <dotted.path> — the keys at that path, one per line, in DOCUMENT order
jkeyseq() {
  "$NODE_BIN" -e '
    let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const k of process.argv[2].split(".")) {
      if (!v || typeof v !== "object") process.exit(1);
      v = v[k];
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) process.exit(1);
    process.stdout.write(Object.keys(v).map((k) => k + "\n").join(""));
  ' "$1" "$2" 2>/dev/null
}

# ------------------------------------------------------------------- the file is runnable --
if [ -f "$CLI" ]; then ok; else bad E1-cli-exists "plugins/fnd/scripts/opencode-config.cjs missing"; fi

# --------------------------------------------------------------------- default: three blocks --
run "$CLI"
if [ "$RC" -eq 0 ] && [ -s "$O" ] && [ ! -s "$E" ]; then ok
else bad D1-default-run "rc=$RC err=$(head -c 200 "$E")"; fi

# The headers are what tell a reader which paste each block is, and their order is the doc's
# walkthrough order — a shuffled render sends someone to the wrong step.
ORDER="$(grep -oE '^step [0-9]+' "$O" | awk '{ print $2 }' | tr '\n' ',')"
if [ "$ORDER" = "3,4,5," ]; then ok
else bad D2-step-order "headers in order '$ORDER', want '3,4,5,'"; fi

if grep -q '^step 3 .*"mcp"' "$O" && grep -q '^step 4 .*"permission"' "$O" \
   && grep -q '^step 5 .*"instructions"' "$O"; then ok
else bad D3-headers-name-key "a header does not name the top-level key it merges into: $(grep -E '^step ' "$O" | tr '\n' ';')"; fi

# Each block is pasted into a JSON file, so each block has to BE JSON — and carry the one
# top-level key its header names.
: > "$TMP/fence-err"
BLOCKS="$(fences "$O")"; FRC=$?
NBLOCKS="$(printf '%s' "$BLOCKS" | grep -c '' | tr -d ' ')"
if [ "$FRC" -eq 0 ] && [ "$NBLOCKS" -eq 3 ]; then ok
else bad D4-three-json-blocks "rc=$FRC blocks=$NBLOCKS err=$(head -c 200 "$TMP/fence-err")"; fi

if [ "$(printf '%s\n' "$BLOCKS" | sed -n 1p | cut -c1-8)" = '{"mcp":{' ] \
   && printf '%s\n' "$BLOCKS" | sed -n 2p | grep -q '^{"permission":' \
   && printf '%s\n' "$BLOCKS" | sed -n 3p | grep -q '^{"instructions":\['; then ok
else bad D5-block-keys "blocks=$(printf '%s' "$BLOCKS" | cut -c1-40 | tr '\n' ';')"; fi

# ------------------------------------------------------------------------ the statics list --
# The single source is the hooks directory itself, minus the one file the adapter injects.
if fence_to "$O" 3 "$TMP/step5.json"; then ok
else bad S1-step5-extract "the third fenced block could not be read"; fi

jlines "$TMP/step5.json" instructions > "$TMP/got-instructions" 2>/dev/null || : > "$TMP/got-instructions"
ls "$PLUGIN"/hooks/*.md | sed 's#.*/##' | grep -v '^store-access\.md$' | LC_ALL=C sort |
  sed "s#^#$HOOKS_REAL/#" > "$TMP/want-instructions"

if [ -s "$TMP/want-instructions" ] && cmp -s "$TMP/got-instructions" "$TMP/want-instructions"; then ok
else bad S2-statics-list "instructions != sorted hooks/*.md minus store-access.md:
      got=$(tr '\n' ';' < "$TMP/got-instructions")
      want=$(tr '\n' ';' < "$TMP/want-instructions")"; fi

# The order is the renderer's, not the filesystem's. readdir returns lexicographic names on APFS
# and hash order on ext4, so a dropped `.sort()` is invisible on a Mac and turns every re-run into
# a spurious config diff elsewhere — this preloads a readdir that hands back the reverse.
cat > "$TMP/reverse-readdir.cjs" <<'SHIM'
const fs = require('fs');
const real = fs.readdirSync;
fs.readdirSync = function (dir, opts) {
  const r = real.call(fs, dir, opts);
  return Array.isArray(r) ? r.slice().reverse() : r;
};
SHIM
RC=0
( cd "$TMP" && "$NODE_BIN" --require "$TMP/reverse-readdir.cjs" "$CLI" --json ) \
  >"$TMP/reversed.json" 2>"$E" || RC=$?
jlines "$TMP/reversed.json" instructions > "$TMP/reversed-instructions" 2>/dev/null \
  || : > "$TMP/reversed-instructions"
if [ "$RC" -eq 0 ] && cmp -s "$TMP/reversed-instructions" "$TMP/want-instructions"; then ok
else bad S2b-sorted-not-readdir-order "rc=$RC list=$(tr '\n' ';' < "$TMP/reversed-instructions")"; fi

MISSING=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  case "$p" in /*) ;; *) MISSING="$MISSING relative:$p" ;; esac
  [ -f "$p" ] || MISSING="$MISSING absent:$p"
done < "$TMP/got-instructions"
if [ -z "$MISSING" ]; then ok; else bad S3-absolute-and-present "$MISSING"; fi

# store-access.md is injected by the OpenCode adapter wherever store credentials are detected;
# a static copy of it here would deliver the block twice in exactly those sessions.
if ! grep -q 'store-access' "$O"; then ok
else bad S4-no-store-access "the render names store-access anyway: $(grep -n 'store-access' "$O" | head -1)"; fi

# ------------------------------------------------------------------------ cwd independence --
# The paths land in a config file that outlives the terminal that printed them, so they may
# never depend on where the command happened to run.
mkdir -p "$TMP/scratch/deep"
RC=0
( cd "$TMP/scratch/deep" && "$NODE_BIN" "$CLI" ) > "$TMP/out-elsewhere" 2>"$E" || RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$O" "$TMP/out-elsewhere"; then ok
else bad C1-cwd-independent "rc=$RC $(cmp "$O" "$TMP/out-elsewhere" 2>&1 | head -c 160)"; fi

# ---------------------------------------------------------------------------------- --json --
run "$CLI" --json
cp "$O" "$TMP/merged.json"
if [ "$RC" -eq 0 ] && [ "$(jkeys "$TMP/merged.json")" = "mcp,permission,instructions" ]; then ok
else bad J1-json-keys "rc=$RC keys=$(jkeys "$TMP/merged.json") err=$(head -c 160 "$E")"; fi

if deepeq "$TMP/merged.json" mcp "$PLUGIN/opencode/mcp-fragment.json" mcp; then ok
else bad J2-json-mcp "--json mcp is not the fragment's mcp block"; fi

if deepeq "$TMP/merged.json" permission "$PLUGIN/opencode/permission-fragment.example.json" permission; then ok
else bad J3-json-permission "--json permission is not the example fragment's permission block"; fi

# …and CONTENT is not enough for this one. OpenCode resolves `permission.bash` last-match-wins, so
# the order of those keys IS the blunt guard's semantics: the same 44 rules re-emitted with the
# catch-all last would allow every commit bypass the fragment denies. deepeq sorts keys, so only
# this row can see it.
jkeyseq "$TMP/merged.json" permission.bash > "$TMP/got-bash-order" 2>/dev/null || : > "$TMP/got-bash-order"
jkeyseq "$PLUGIN/opencode/permission-fragment.example.json" permission.bash > "$TMP/want-bash-order" 2>/dev/null \
  || : > "$TMP/want-bash-order"
if [ -s "$TMP/want-bash-order" ] && cmp -s "$TMP/got-bash-order" "$TMP/want-bash-order"; then ok
else bad J3b-permission-bash-order "permission.bash keys re-ordered:
      got=$(tr '\n' ';' < "$TMP/got-bash-order")
      want=$(tr '\n' ';' < "$TMP/want-bash-order")"; fi

# the `_comment` key is the fragment's note to a human reader and has no place in a config
if ! grep -q '_comment' "$TMP/merged.json"; then ok
else bad J4-no-comment-key "--json carries the fragment's _comment key"; fi

jlines "$TMP/merged.json" instructions > "$TMP/json-instructions" 2>/dev/null || : > "$TMP/json-instructions"
if cmp -s "$TMP/json-instructions" "$TMP/want-instructions"; then ok
else bad J5-json-instructions "--json instructions differ from the rendered block: $(tr '\n' ';' < "$TMP/json-instructions")"; fi

# ------------------------------------------------------------------- the copy renders too --
# The baseline for every broken-copy case below: an untouched copy must render exactly what the
# real checkout does, or a red case would only be proving the copy was wrong.
COPY="$TMP/copy-ok"; mkcopy "$COPY"
run "$COPY/scripts/opencode-config.cjs" --json
if [ "$RC" -eq 0 ] && [ "$(jkeys "$O")" = "mcp,permission,instructions" ]; then ok
else bad K1-copy-baseline "rc=$RC err=$(head -c 200 "$E")"; fi

# --------------------------------------------------------------------------- failure modes --
# A missing generated fragment is a partial checkout, and the fix is one command — so the error
# names it. Nothing on stdout: a half-rendered paste is worse than none.
COPY_NOMCP="$TMP/copy-no-mcp"; mkcopy "$COPY_NOMCP"
rm -f "$COPY_NOMCP/opencode/mcp-fragment.json"
run "$COPY_NOMCP/scripts/opencode-config.cjs"
if [ "$RC" -eq 2 ] && [ ! -s "$O" ] && grep -q 'gen-host-adapters.cjs' "$E" \
   && grep -q 'mcp-fragment.json' "$E"; then ok
else bad F1-mcp-missing "rc=$RC out=$(head -c 120 "$O") err=$(head -c 200 "$E")"; fi

# …and --json takes the same exit, so a `jq` pipeline cannot read a truncated object as success
run "$COPY_NOMCP/scripts/opencode-config.cjs" --json
if [ "$RC" -eq 2 ] && [ ! -s "$O" ]; then ok
else bad F2-mcp-missing-json "rc=$RC out=$(head -c 120 "$O")"; fi

# A fragment that does not parse is the everyday half-edit; the error has to name WHICH file,
# because two of them are read and only one is generated.
COPY_BADPERM="$TMP/copy-bad-perm"; mkcopy "$COPY_BADPERM"
printf '{ "permission": { "bash": { "*": "allow" }\n' > "$COPY_BADPERM/opencode/permission-fragment.example.json"
run "$COPY_BADPERM/scripts/opencode-config.cjs"
if [ "$RC" -eq 2 ] && [ ! -s "$O" ] && grep -q 'permission-fragment.example.json' "$E"; then ok
else bad F3-permission-invalid "rc=$RC out=$(head -c 120 "$O") err=$(head -c 200 "$E")"; fi

# …the same for the generated one: invalid JSON there is not "missing", but it is still rc 2
# with nothing rendered.
COPY_BADMCP="$TMP/copy-bad-mcp"; mkcopy "$COPY_BADMCP"
printf 'not json at all\n' > "$COPY_BADMCP/opencode/mcp-fragment.json"
run "$COPY_BADMCP/scripts/opencode-config.cjs"
if [ "$RC" -eq 2 ] && [ ! -s "$O" ] && grep -q 'mcp-fragment.json' "$E"; then ok
else bad F4-mcp-invalid "rc=$RC out=$(head -c 120 "$O") err=$(head -c 200 "$E")"; fi

# An empty `instructions` array is the one output that looks fine and installs nothing: no fnd
# convention would reach a session, and the config would carry the key that hides it.
COPY_NOHOOKS="$TMP/copy-no-hooks"; mkcopy "$COPY_NOHOOKS"
rm -f "$COPY_NOHOOKS"/hooks/*.md
run "$COPY_NOHOOKS/scripts/opencode-config.cjs"
if [ "$RC" -eq 2 ] && [ ! -s "$O" ] && grep -q 'hooks' "$E"; then ok
else bad F5-no-statics "rc=$RC out=$(head -c 120 "$O") err=$(head -c 200 "$E")"; fi

# ------------------------------------------------------------------- the list is derived --
# The point of deriving it: a convention file added under hooks/ shows up in the paste with no
# code change here. A hardcoded list would render a fixed set whatever hooks/ holds.
COPY_EXTRA="$TMP/copy-extra"; mkcopy "$COPY_EXTRA"
echo "# a new convention" > "$COPY_EXTRA/hooks/zz-new-convention.md"
run "$COPY_EXTRA/scripts/opencode-config.cjs" --json
EXTRA_REAL="$(cd "$COPY_EXTRA/hooks" && pwd -P)"
jlines "$O" instructions > "$TMP/extra-instructions" 2>/dev/null || : > "$TMP/extra-instructions"
if [ "$RC" -eq 0 ] && grep -qxF "$EXTRA_REAL/zz-new-convention.md" "$TMP/extra-instructions" \
   && [ "$(grep -c '' "$TMP/extra-instructions" | tr -d ' ')" -eq \
        "$(( $(grep -c '' "$TMP/want-instructions" | tr -d ' ') + 1 ))" ]; then ok
else bad N1-new-convention-file "rc=$RC list=$(tr '\n' ';' < "$TMP/extra-instructions")"; fi

# …and the exclusion is by name, so a new file does not smuggle store-access back in
if ! grep -q 'store-access' "$O"; then ok
else bad N2-extra-still-excludes "store-access re-appeared once another hooks file was added"; fi

# A name ending in .md is not yet a file a host can read. An entry OpenCode silently drops belongs
# in nobody's config, and the render must still succeed on the real conventions beside it.
COPY_ODD="$TMP/copy-odd"; mkcopy "$COPY_ODD"
mkdir -p "$COPY_ODD/hooks/zz-directory.md"
ln -s "$COPY_ODD/hooks/nowhere-at-all" "$COPY_ODD/hooks/zz-dangling.md"
run "$COPY_ODD/scripts/opencode-config.cjs" --json
jlines "$O" instructions > "$TMP/odd-instructions" 2>/dev/null || : > "$TMP/odd-instructions"
if [ "$RC" -eq 0 ] && ! grep -q 'zz-directory\.md' "$TMP/odd-instructions" \
   && ! grep -q 'zz-dangling\.md' "$TMP/odd-instructions" \
   && [ "$(grep -c '' "$TMP/odd-instructions" | tr -d ' ')" -eq \
        "$(grep -c '' "$TMP/want-instructions" | tr -d ' ')" ]; then ok
else bad N3-unreadable-entries "rc=$RC list=$(tr '\n' ';' < "$TMP/odd-instructions")"; fi

# ------------------------------------------------------------------------------ arguments --
# One flag exists. Anything else is a typo, and a typo that rendered the default output would be
# pasted as if the flag had worked.
run "$CLI" --wat
if [ "$RC" -eq 2 ] && [ ! -s "$O" ] && grep -q 'unknown argument' "$E" \
   && grep -q 'usage: opencode-config.cjs' "$E"; then ok
else bad A1-unknown-flag "rc=$RC out=$(head -c 120 "$O") err=$(head -c 200 "$E")"; fi

run "$CLI" step5
if [ "$RC" -eq 2 ] && [ ! -s "$O" ] && grep -q 'usage: opencode-config.cjs' "$E"; then ok
else bad A2-positional-arg "rc=$RC out=$(head -c 120 "$O") err=$(head -c 200 "$E")"; fi

# --------------------------------------------------------------- nothing was written back --
# opencode.json is the user's file and the fragments are inputs: this command only prints. The
# baseline has to be a tree the renderer never ran in — a rendered tree as reference would carry
# any stray write itself and compare equal.
mkcopy "$TMP/copy-pristine"
mkcopy "$TMP/copy-probe"
run "$TMP/copy-probe/scripts/opencode-config.cjs"
if diff -r "$TMP/copy-pristine" "$TMP/copy-probe" >/dev/null 2>&1; then ok
else bad W1-no-writes "the render changed its own plugin root: $(diff -r "$TMP/copy-pristine" "$TMP/copy-probe" 2>&1 | head -c 200)"; fi

# …and --json takes the same path through the same readers, so it gets the same probe
mkcopy "$TMP/copy-probe-json"
run "$TMP/copy-probe-json/scripts/opencode-config.cjs" --json
if diff -r "$TMP/copy-pristine" "$TMP/copy-probe-json" >/dev/null 2>&1; then ok
else bad W2-no-writes-json "--json changed its own plugin root: $(diff -r "$TMP/copy-pristine" "$TMP/copy-probe-json" 2>&1 | head -c 200)"; fi

echo "opencode-config-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
