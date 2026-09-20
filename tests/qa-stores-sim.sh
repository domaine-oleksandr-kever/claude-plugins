#!/usr/bin/env bash
# Simulation harness for scripts/qa-stores.cjs — the QA store registry. HOME points at a throwaway
# dir, so every case reads and writes a sandbox registry and the developer's own
# ~/.config/domaine/qa-stores.json is never touched (C0 re-checks that at the end). No network.
# Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QS="$ROOT/plugins/fnd/scripts/qa-stores.cjs"

TMP="$(mktemp -d)"; TMP="$(cd "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

# Fingerprint of the developer's OWN registry, read before HOME is redirected — re-checked at the
# end (C10): a case that leaks the real path would rewrite their store passwords for real.
REAL_REG="$HOME/.config/domaine/qa-stores.json"
REAL_BEFORE="$( [ -f "$REAL_REG" ] && cksum < "$REAL_REG" || echo absent )"

# Hermetic env: the script resolves its path from os.homedir(), which on POSIX is $HOME. The home
# dir deliberately does NOT exist yet — the help and path cases run before anything creates it.
export HOME="$TMP/home"
REG="$HOME/.config/domaine/qa-stores.json"

# A storefront password as they really come: spaces, `$`, backticks, both quote kinds, shell
# metacharacters. It must survive argv verbatim and never appear outside `get`.
PW='p@ss w0rd $HOME `id` "q" '\''sq'\'' &|;*?'

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

O="$TMP/out"; E="$TMP/err"
run() { rc=0; node "$QS" "$@" > "$O" 2> "$E" || rc=$?; }

# mode <path> — octal permission bits, macOS (stat -f) or GNU coreutils (stat -c)
mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }
# jsonfield <file> <expr> — a field of the JSON document in <file>, without jq on the PATH
jsonfield() {
  node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
           const v=(function(d){return eval(process.argv[2])})(o);
           process.stdout.write(v===undefined?"<undef>":typeof v==="object"?JSON.stringify(v):String(v))' \
       "$1" "$2"
}
snap() { [ -f "$REG" ] && cksum < "$REG" || echo absent; }

# ------------------------------------------------------ C1 --help before any file access --
# "How do I call this" must be answerable on a machine with no registry and no home dir at all.
for ha in --help -h; do
  run "$ha"
  if [ "$rc" -eq 0 ] && grep -q '^Usage:' "$O" && grep -q 'qa-stores.cjs set <domain>' "$O" \
     && [ ! -e "$HOME" ] && [ ! -s "$E" ]; then ok
  else bad "C1-help[$ha]" "rc=$rc home-exists=$([ -e "$HOME" ] && echo yes || echo no) out=$(head -c 120 "$O") err=$(head -c 120 "$E")"; fi
done

# C1b: --help anywhere in a command's args is still a usage question — no registry is read
run set foo.myshopify.com --help
if [ "$rc" -eq 0 ] && grep -q '^Usage:' "$O" && [ ! -e "$HOME" ]; then ok
else bad C1b-help-mid-args "rc=$rc home-exists=$([ -e "$HOME" ] && echo yes || echo no) out=$(head -c 120 "$O")"; fi

# C1c (drift guard): --help prints the header's own `// Usage:` block. Two hand-maintained copies of
# a call shape are two copies free to disagree, and the header is the one a reader lands on.
HDR="$TMP/usage-header"
awk '/^\/\/ Usage:/ { f = 1 } f { if ($0 !~ /^\/\/( |$)/) exit; sub(/^\/\/ ?/, ""); print }' \
  "$QS" > "$HDR"
run --help
if [ "$rc" -eq 0 ] && [ "$(wc -l < "$HDR" | tr -d ' ')" -eq 10 ] \
   && sed '$d' "$O" | diff -q - "$HDR" >/dev/null; then ok
else bad C1c-help-matches-header "rc=$rc lines=$(wc -l < "$HDR" | tr -d ' ') diff=$(sed '$d' "$O" | diff - "$HDR" | head -c 300 | tr '\n' ';')"; fi

# C1d: the pointer line names where the full contract lives
if [ "$(tail -1 "$O")" = "Full contract: the header of $QS" ]; then ok
else bad C1d-help-pointer "tail=$(tail -1 "$O")"; fi

# ------------------------------------------------------------------- C2 path is a read-only --
run path
if [ "$rc" -eq 0 ] && [ "$(cat "$O")" = "$REG" ] && [ ! -e "$HOME" ]; then ok
else bad C2-path "rc=$rc out=$(cat "$O") want=$REG"; fi

# C2b: an absent registry is an empty one, not an error — and `list` does not create it
run list
if [ "$rc" -eq 0 ] && grep -q 'no stores registered' "$O" && [ ! -f "$REG" ]; then ok
else bad C2b-list-absent "rc=$rc out=$(tr '\n' ';' < "$O") err=$(head -c 160 "$E")"; fi

# C2c: ...and `get` against it is "no such store" (1), not "corrupt registry" (3)
run get elc-us-mc-uat.myshopify.com
if [ "$rc" -eq 1 ] && grep -q 'no store matches' "$E"; then ok
else bad C2c-get-absent "rc=$rc err=$(head -c 160 "$E")"; fi

# --------------------------------------------------- C3 set creates a 0600 file in a 0700 dir --
run set 'https://ELC-US-MC-UAT.myshopify.com/' --alias 'MAC US UAT' --password "$PW" \
        --theme 156379611322:develop --note 'brand MAC, no write access'
if [ "$rc" -eq 0 ] && [ -f "$REG" ] && [ "$(mode "$REG")" = "600" ] \
   && [ "$(mode "$(dirname "$REG")")" = "700" ] \
   && [ "$(jsonfield "$REG" 'd.version')" = "1" ]; then ok
else bad C3-set-creates "rc=$rc file-mode=$([ -f "$REG" ] && mode "$REG" || echo none) dir-mode=$(mode "$(dirname "$REG")" 2>/dev/null) err=$(head -c 200 "$E")"; fi

# C3b: the domain is normalized — scheme, trailing slash and case are call decoration
if [ "$(jsonfield "$REG" 'Object.keys(d.stores).join(",")')" = "elc-us-mc-uat.myshopify.com" ]; then ok
else bad C3b-normalisation "keys=$(jsonfield "$REG" 'Object.keys(d.stores).join(",")')"; fi

# C3c: `set` echoes the merged store with the password masked
if grep -q '"password": "\*\*\*"' "$O" && grep -q '"alias": "MAC US UAT"' "$O" \
   && grep -q '"156379611322": "develop"' "$O" && ! grep -qF "$PW" "$O"; then ok
else bad C3c-set-output-masked "out=$(tr '\n' ';' < "$O" | head -c 300)"; fi

# C3d: userinfo, port, query and fragment are decoration too — a URL pasted from the browser bar
# must land on the entry the bare host reaches, not fork a duplicate with its own password. The note
# is re-sent unchanged so this write is a no-op for the later cases.
run set 'https://qa-user@ELC-US-MC-UAT.myshopify.com:8443/collections/all?x=1#frag' \
        --note 'brand MAC, no write access'
if [ "$rc" -eq 0 ] \
   && [ "$(jsonfield "$REG" 'Object.keys(d.stores).join(",")')" = "elc-us-mc-uat.myshopify.com" ]; then ok
else bad C3d-authority-normalisation "rc=$rc keys=$(jsonfield "$REG" 'Object.keys(d.stores).join(",")') err=$(head -c 200 "$E")"; fi

run get 'https://elc-us-mc-uat.myshopify.com:443/'
if [ "$rc" -eq 0 ] && [ "$(jsonfield "$O" 'd.domain')" = "elc-us-mc-uat.myshopify.com" ]; then ok
else bad C3e-port-lookup "rc=$rc err=$(head -c 160 "$E")"; fi

# ---------------------------------------------------------- C4 get is the only password print --
run get elc-us-mc-uat.myshopify.com
GOTPW="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).password)' "$O")"
if [ "$rc" -eq 0 ] && [ "$GOTPW" = "$PW" ]; then ok
else bad C4-get-password "rc=$rc got=[$GOTPW] want=[$PW]"; fi

# C4b: alias lookup, case-insensitive, same store
run get 'mac us uat'
if [ "$rc" -eq 0 ] && [ "$(jsonfield "$O" 'd.domain')" = "elc-us-mc-uat.myshopify.com" ]; then ok
else bad C4b-alias-lookup "rc=$rc out=$(head -c 200 "$O" | tr '\n' ';') err=$(head -c 160 "$E")"; fi

# C4c: the bare domain reaches the entry written from a URL
run get ELC-US-MC-UAT.myshopify.com
if [ "$rc" -eq 0 ] && [ "$(jsonfield "$O" 'd.password')" = "$PW" ]; then ok
else bad C4c-domain-lookup "rc=$rc err=$(head -c 160 "$E")"; fi

# ------------------------------------------------------------------ C5 list and find mask it --
run list
if [ "$rc" -eq 0 ] && ! grep -qF "$PW" "$O" "$E" && grep -q '\*\*\*' "$O" \
   && grep -q 'elc-us-mc-uat.myshopify.com' "$O" && grep -q '^DOMAIN ' "$O"; then ok
else bad C5-list-masks "rc=$rc out=$(tr '\n' ';' < "$O" | head -c 300)"; fi

run list --json
if [ "$rc" -eq 0 ] && ! grep -qF "$PW" "$O" "$E" \
   && [ "$(jsonfield "$O" 'd[0].password')" = "***" ] \
   && [ "$(jsonfield "$O" 'd[0].notes')" = "brand MAC, no write access" ]; then ok
else bad C5b-list-json-masks "rc=$rc out=$(head -c 300 "$O" | tr '\n' ';')"; fi

for needle in 'MYSHOPIFY' 'mac us' 'no write access'; do
  run find "$needle"
  if [ "$rc" -eq 0 ] && [ "$(jsonfield "$O" 'd.length')" = "1" ] \
     && [ "$(jsonfield "$O" 'd[0].password')" = "***" ] && ! grep -qF "$PW" "$O" "$E"; then ok
  else bad "C5c-find[$needle]" "rc=$rc out=$(head -c 200 "$O" | tr '\n' ';')"; fi
done

run find 'kiko'
if [ "$rc" -eq 0 ] && [ "$(cat "$O")" = "[]" ]; then ok
else bad C5d-find-no-hit "rc=$rc out=$(cat "$O")"; fi

# ------------------------------------------------------------------------- C6 set merges --
# The second store exists so the merge cases prove they touch one entry only.
run set cl-us-uat.myshopify.com --alias 'CL US UAT' --password 'other-secret' \
        --default-theme 150843719862 --theme 150843719862:develop
[ "$rc" -eq 0 ] || bad C6-second-store "rc=$rc err=$(head -c 200 "$E")"

run set elc-us-mc-uat.myshopify.com --theme 150000000001:release --alias 'MAC US UAT 2'
if [ "$rc" -eq 0 ] \
   && [ "$(jsonfield "$REG" 'Object.keys(d.stores["elc-us-mc-uat.myshopify.com"].themes).join(",")')" = "156379611322,150000000001" ] \
   && [ "$(jsonfield "$REG" 'd.stores["elc-us-mc-uat.myshopify.com"].alias')" = "MAC US UAT 2" ] \
   && [ "$(jsonfield "$REG" 'd.stores["elc-us-mc-uat.myshopify.com"].notes')" = "brand MAC, no write access" ]; then ok
else bad C6b-themes-merge "rc=$rc themes=$(jsonfield "$REG" 'JSON.stringify(d.stores["elc-us-mc-uat.myshopify.com"].themes)') err=$(head -c 200 "$E")"; fi

# C6c: an omitted --password keeps the stored one (this is the whole point of a merging `set`)
run get elc-us-mc-uat.myshopify.com
if [ "$rc" -eq 0 ] && [ "$(jsonfield "$O" 'd.password')" = "$PW" ]; then ok
else bad C6c-password-kept "rc=$rc got=$(jsonfield "$O" 'd.password')"; fi

# C6d: a bare `--theme <id>` keeps the label it already has instead of blanking it
run set elc-us-mc-uat.myshopify.com --theme 156379611322 --theme 150000000002
if [ "$rc" -eq 0 ] \
   && [ "$(jsonfield "$REG" 'd.stores["elc-us-mc-uat.myshopify.com"].themes["156379611322"]')" = "develop" ] \
   && [ "$(jsonfield "$REG" 'd.stores["elc-us-mc-uat.myshopify.com"].themes["150000000002"]')" = "" ]; then ok
else bad C6d-bare-theme "rc=$rc themes=$(jsonfield "$REG" 'JSON.stringify(d.stores["elc-us-mc-uat.myshopify.com"].themes)')"; fi

# C6e: --default-theme, and flags in any order
run set elc-us-mc-uat.myshopify.com --default-theme 156379611322
if [ "$rc" -eq 0 ] \
   && [ "$(jsonfield "$REG" 'd.stores["elc-us-mc-uat.myshopify.com"].defaultTheme')" = "156379611322" ]; then ok
else bad C6e-default-theme "rc=$rc got=$(jsonfield "$REG" 'd.stores["elc-us-mc-uat.myshopify.com"].defaultTheme')"; fi

run set --note 'reordered flags' --alias 'MAC US UAT' elc-us-mc-uat.myshopify.com
if [ "$rc" -eq 0 ] \
   && [ "$(jsonfield "$REG" 'd.stores["elc-us-mc-uat.myshopify.com"].notes')" = "reordered flags" ] \
   && [ "$(jsonfield "$REG" 'd.stores["elc-us-mc-uat.myshopify.com"].defaultTheme')" = "156379611322" ]; then ok
else bad C6f-flag-order "rc=$rc err=$(head -c 200 "$E")"; fi

# C6g: updatedAt is refreshed, and the neighbour store is untouched by any of the above
if [ "$(jsonfield "$REG" 'String(/^\d{4}-\d\d-\d\dT/.test(d.stores["elc-us-mc-uat.myshopify.com"].updatedAt))')" = "true" ] \
   && [ "$(jsonfield "$REG" 'd.stores["cl-us-uat.myshopify.com"].alias')" = "CL US UAT" ] \
   && [ "$(jsonfield "$REG" 'Object.keys(d.stores["cl-us-uat.myshopify.com"].themes).length')" = "1" ]; then ok
else bad C6g-neighbour-untouched "updatedAt=$(jsonfield "$REG" 'd.stores["elc-us-mc-uat.myshopify.com"].updatedAt') cl=$(jsonfield "$REG" 'JSON.stringify(d.stores["cl-us-uat.myshopify.com"])')"; fi

# C6h: a rewrite keeps 0600 (the stage-and-rename path, not just the create path) and leaves no
# stage file behind
LEFTOVERS="$(find "$(dirname "$REG")" -name '.qa-stores.json.tmp-*' 2>/dev/null | tr '\n' ';')"
if [ "$(mode "$REG")" = "600" ] && [ -z "$LEFTOVERS" ]; then ok
else bad C6h-rewrite-mode "mode=$(mode "$REG") leftovers=$LEFTOVERS"; fi

# --------------------------------------------------------------------------- C7 unset --
run unset 'cl us uat'
if [ "$rc" -eq 0 ] && grep -q 'removed cl-us-uat.myshopify.com' "$O" \
   && [ "$(jsonfield "$REG" 'Object.keys(d.stores).join(",")')" = "elc-us-mc-uat.myshopify.com" ]; then ok
else bad C7-unset "rc=$rc out=$(cat "$O") keys=$(jsonfield "$REG" 'Object.keys(d.stores).join(",")')"; fi

run get cl-us-uat.myshopify.com
if [ "$rc" -eq 1 ]; then ok; else bad C7b-unset-then-get "rc=$rc"; fi

run unset cl-us-uat.myshopify.com
if [ "$rc" -eq 1 ] && grep -q 'no store matches' "$E"; then ok
else bad C7c-unset-unknown "rc=$rc err=$(head -c 160 "$E")"; fi

# ---------------------------------------------------- C8 a registry it cannot parse is left alone --
# A hand-edited registry with a typo is recoverable; an overwritten one is not.
GOOD="$TMP/good.json"; cp "$REG" "$GOOD"
for body in '{"version":1,"stores":{' '[]' '{"version":2,"stores":{}}' '{"version":1}' \
            '{"version":1,"stores":{"a.myshopify.com":"nope"}}' \
            '{"version":1,"stores":{"a.myshopify.com":{"themes":[]}}}'; do
  printf '%s' "$body" > "$REG"
  BEFORE="$(snap)"
  for c in list get set; do
    case "$c" in
      get) run get a.myshopify.com ;;
      set) run set a.myshopify.com --alias x ;;
      *)   run list ;;
    esac
    if [ "$rc" -eq 3 ] && [ "$(snap)" = "$BEFORE" ] && [ -s "$E" ] && [ ! -s "$O" ]; then ok
    else bad "C8-corrupt[$c][$(printf '%s' "$body" | head -c 24)]" "rc=$rc mutated=$([ "$(snap)" = "$BEFORE" ] && echo no || echo yes) err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
  done
done
cp "$GOOD" "$REG"

# C8b: an unreadable file is the same refusal, not an empty registry (skipped as root, who can
# read a 0000 file)
if [ "$(id -u)" != "0" ]; then
  chmod 000 "$REG"
  run list
  chmod 600 "$REG"
  if [ "$rc" -eq 3 ] && grep -q 'cannot read' "$E"; then ok
  else bad C8b-unreadable "rc=$rc err=$(head -c 160 "$E")"; fi
fi

# ------------------------------------------------------------------------- C9 usage errors --
BEFORE="$(snap)"
run --bogus
if [ "$rc" -eq 2 ] && grep -q 'unknown command' "$E" && grep -q '^Usage:' "$E"; then ok
else bad C9-unknown-command "rc=$rc err=$(head -c 200 "$E" | tr '\n' ';')"; fi

for bad_args in "set elc-us-mc-uat.myshopify.com --bogus v" "list --bogus" "list extra" \
                "get" "get a b" "find" "unset" "path extra" \
                "set --alias only-a-flag" "set elc-us-mc-uat.myshopify.com --password" \
                "set elc-us-mc-uat.myshopify.com --theme :label" \
                "set a.myshopify.com b.myshopify.com"; do
  # shellcheck disable=SC2086
  run $bad_args
  if [ "$rc" -eq 2 ] && grep -q '^Usage:' "$E" && [ ! -s "$O" ]; then ok
  else bad "C9b-usage[$bad_args]" "rc=$rc err=$(head -c 160 "$E" | tr '\n' ' ')"; fi
done

if [ "$(snap)" = "$BEFORE" ]; then ok; else bad C9c-usage-wrote "a refused call rewrote the registry"; fi

# C9d: a password of exactly `-h` is a value, not a usage question (help is matched outside
# flag-value position)
run set hv.myshopify.com --password -h
if [ "$rc" -eq 0 ] && ! grep -q '^Usage:' "$O"; then
  run get hv.myshopify.com
  if [ "$rc" -eq 0 ] && [ "$(jsonfield "$O" 'd.password')" = "-h" ]; then ok
  else bad C9d-h-as-password "rc=$rc got=$(jsonfield "$O" 'd.password')"; fi
else bad C9d-h-as-password "set rc=$rc out=$(head -c 120 "$O")"; fi
run unset hv.myshopify.com

# C9e: a mistyped `set <domain> <password>` (a forgotten `--password`) must not quote the value back
# — stderr is captured by wrappers and kept in session logs
BEFORE="$(snap)"
run set elc-us-mc-uat.myshopify.com "$PW"
if [ "$rc" -eq 2 ] && ! grep -qF "$PW" "$O" "$E" && grep -q '^Usage:' "$E" \
   && [ "$(snap)" = "$BEFORE" ]; then ok
else bad C9e-usage-echoes-secret "rc=$rc err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# ------------------------------------------- C11 an alias never becomes a second registry key --
# `<store>` is accepted by alias everywhere else, so `set <alias>` looks right; keyed by the alias
# text it would shadow the real store and win alias resolution with no password.
BEFORE="$(snap)"
run set 'MAC US UAT' --theme 150000000001:release
if [ "$rc" -eq 2 ] && [ "$(snap)" = "$BEFORE" ] \
   && [ "$(jsonfield "$REG" 'Object.keys(d.stores).join(",")')" = "elc-us-mc-uat.myshopify.com" ]; then ok
else bad C11-set-by-alias "rc=$rc keys=$(jsonfield "$REG" 'Object.keys(d.stores).join(",")') err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# C11b: an alias that *is* host-shaped passes the shape check, so the key/alias collision is caught
# against the loaded registry as well
HOME="$TMP/home-alias"; ALIAS_REG="$HOME/.config/domaine/qa-stores.json"
run set real.myshopify.com --alias 'mac.uat' --password 'x'
run set mac.uat --theme 1
if [ "$rc" -eq 2 ] && grep -q 'is the alias of real.myshopify.com' "$E" \
   && [ "$(jsonfield "$ALIAS_REG" 'Object.keys(d.stores).join(",")')" = "real.myshopify.com" ]; then ok
else bad C11b-set-by-host-shaped-alias "rc=$rc keys=$(jsonfield "$ALIAS_REG" 'Object.keys(d.stores).join(",")') err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
HOME="$TMP/home"

# ------------------------------------------------ C12 an alias names exactly one store --
HOME="$TMP/home-uniq"; UNIQ_REG="$HOME/.config/domaine/qa-stores.json"
run set f1.myshopify.com --alias UAT --password p1
run set f2.myshopify.com --alias UAT --password p2
if [ "$rc" -eq 2 ] && grep -q 'already on f1.myshopify.com' "$E" \
   && [ "$(jsonfield "$UNIQ_REG" 'd.stores["f2.myshopify.com"]')" = "<undef>" ]; then ok
else bad C12-alias-reused "rc=$rc err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# C12b: the same alias re-sent to the store that already carries it is a no-op, not a refusal
run set f1.myshopify.com --alias uat --note 'same store'
if [ "$rc" -eq 0 ] && [ "$(jsonfield "$UNIQ_REG" 'd.stores["f1.myshopify.com"].alias')" = "uat" ]; then ok
else bad C12b-alias-own-store "rc=$rc err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# C12c: a hand-edited registry can still carry a duplicate alias — resolving it must refuse, not
# hand out whichever store came first (that would leak one store's password under the other's name)
printf '%s' '{"version":1,"stores":{"g1.myshopify.com":{"alias":"UAT","password":"p1"},
  "g2.myshopify.com":{"alias":"uat ","password":"p2"}}}' > "$UNIQ_REG"
run get UAT
if [ "$rc" -eq 1 ] && grep -q 'alias matches 2 stores' "$E" && [ ! -s "$O" ]; then ok
else bad C12c-ambiguous-alias "rc=$rc out=$(head -c 120 "$O") err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
HOME="$TMP/home"

# ------------------------------------------ C13 hand-edited leaf types render, never crash --
# A QA engineer editing the file types a Shopify theme id the natural way: unquoted. That is valid
# JSON, so `loadRegistry` accepts it — the table must stringify rather than die on `padEnd`.
HOME="$TMP/home-leaf"; LEAF_REG="$HOME/.config/domaine/qa-stores.json"
mkdir -p "$(dirname "$LEAF_REG")"
printf '%s' '{"version":1,"stores":{"a.myshopify.com":{"alias":12345,
  "defaultTheme":156379611322,"themes":{"156379611322":7}}}}' > "$LEAF_REG"
run list
if [ "$rc" -eq 0 ] && grep -q '156379611322' "$O" && grep -q '12345' "$O" && [ ! -s "$E" ]; then ok
else bad C13-numeric-leaves "rc=$rc out=$(tr '\n' ';' < "$O" | head -c 200) err=$(head -c 200 "$E" | tr '\n' ' ')"; fi
HOME="$TMP/home"

# --------------------------------------- C14 the dir is tightened even when it already exists --
# domaine-env.cjs creates ~/.config/domaine with no mode, so on the normal machine (fnd env file
# configured first) the dir is 0755 before this script ever runs.
HOME="$TMP/home-perm"; PERM_REG="$HOME/.config/domaine/qa-stores.json"
mkdir -p "$(dirname "$PERM_REG")"; chmod 755 "$(dirname "$PERM_REG")"
run set p.myshopify.com --password p
if [ "$rc" -eq 0 ] && [ "$(mode "$(dirname "$PERM_REG")")" = "700" ] \
   && [ "$(mode "$PERM_REG")" = "600" ]; then ok
else bad C14-existing-dir-mode "rc=$rc dir=$(mode "$(dirname "$PERM_REG")") file=$(mode "$PERM_REG")"; fi
HOME="$TMP/home"

# -------------------------------------------- C15 concurrent writes lose nothing --
# The stage-and-rename makes one write atomic but does not serialize read-modify-write: without the
# lock a later writer saves a snapshot taken before the earlier one's store existed.
HOME="$TMP/home-race"; RACE_REG="$HOME/.config/domaine/qa-stores.json"
for n in 1 2 3 4 5 6; do node "$QS" set "s$n.myshopify.com" --password "p$n" >/dev/null 2>&1 & done
wait
if [ "$(jsonfield "$RACE_REG" 'Object.keys(d.stores).length')" = "6" ]; then ok
else bad C15-race-stores "stores=$(jsonfield "$RACE_REG" 'Object.keys(d.stores).join(",")')"; fi

for n in 1 2 3 4 5 6; do node "$QS" set s1.myshopify.com --theme "t$n:l$n" >/dev/null 2>&1 & done
wait
if [ "$(jsonfield "$RACE_REG" 'Object.keys(d.stores["s1.myshopify.com"].themes).length')" = "6" ] \
   && [ "$(jsonfield "$RACE_REG" 'd.stores["s1.myshopify.com"].password')" = "p1" ]; then ok
else bad C15b-race-themes "themes=$(jsonfield "$RACE_REG" 'JSON.stringify(d.stores["s1.myshopify.com"].themes)')"; fi

# C15c: no lock survives — not a finished run, and not one that exits from inside the lock (a
# corrupt registry is read under it, and process.exit skips a finally block)
LOCKS="$(find "$(dirname "$RACE_REG")" -name 'qa-stores.json.lock' 2>/dev/null | tr '\n' ';')"
printf '%s' '{oops' > "$RACE_REG"
run set s1.myshopify.com --alias x
LOCKS="$LOCKS$(find "$(dirname "$RACE_REG")" -name 'qa-stores.json.lock' 2>/dev/null | tr '\n' ';')"
if [ "$rc" -eq 3 ] && [ -z "$LOCKS" ]; then ok
else bad C15c-lock-leftover "rc=$rc leftovers=$LOCKS"; fi
HOME="$TMP/home"

# ------------------------------- C16 an open storefront is "no password", never an empty one --
HOME="$TMP/home-empty"; EMPTY_REG="$HOME/.config/domaine/qa-stores.json"
run set e.myshopify.com --alias 'OPEN' --password ''
if [ "$rc" -eq 0 ] && [ "$(jsonfield "$EMPTY_REG" 'd.stores["e.myshopify.com"].password')" = "<undef>" ]; then ok
else bad C16-empty-password-dropped "rc=$rc got=$(jsonfield "$EMPTY_REG" 'd.stores["e.myshopify.com"].password')"; fi

# C16b: the two renderers agree — `list` says `-` and `list --json` omits the field, so the skill
# cannot read "a password is on file" from one and "none" from the other
run list
LIST_ROW="$(grep 'e.myshopify.com' "$O")"
run list --json
if [ "${LIST_ROW##* }" = "-" ] && [ "$(jsonfield "$O" 'd[0].password')" = "<undef>" ]; then ok
else bad C16b-empty-password-renderers "row=[$LIST_ROW] json=$(jsonfield "$O" 'd[0].password')"; fi

# C16c: `--password ''` is also how a stored password is cleared
run set e.myshopify.com --password 'temp'
run set e.myshopify.com --password ''
run get e.myshopify.com
if [ "$rc" -eq 0 ] && [ "$(jsonfield "$O" 'd.password')" = "<undef>" ]; then ok
else bad C16c-password-cleared "rc=$rc got=$(jsonfield "$O" 'd.password')"; fi
HOME="$TMP/home"

# ------------------------------------------------- C10 the developer's own registry is untouched --
REAL_AFTER="$( [ -f "$REAL_REG" ] && cksum < "$REAL_REG" || echo absent )"
if [ "$REAL_AFTER" = "$REAL_BEFORE" ]; then ok
else bad C10-real-registry-clean "the suite wrote to $REAL_REG"; fi

echo "qa-stores-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
