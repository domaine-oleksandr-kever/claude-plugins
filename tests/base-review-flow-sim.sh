#!/usr/bin/env bash
# Simulation harness for the scope + hash block of plugins/base/references/review-flow.md §1 (base
# resolution, merge-base, diff_hash over tracked + untracked work). The block lives in markdown, so it
# is extracted from the first ```bash fence after the line starting "Compute scope + hash" and run in
# scratch git repos — remote refs are written with update-ref, nothing touches the network or the
# real checkout. Runs the block under bash and, when present, zsh. Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLOW="$ROOT/plugins/base/references/review-flow.md"
BASH_BIN="$(command -v bash)"
ZSH_BIN="$(command -v zsh || true)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

BLOCK="$TMP/block.sh"
awk '/^Compute scope \+ hash/ { armed = 1; next }
     armed && /^```bash/ { inside = 1; next }
     inside && /^```/ { exit }
     inside { print }' "$FLOW" > "$BLOCK"
if grep -q 'diff_hash=' "$BLOCK" && grep -q 'merge-base' "$BLOCK"; then ok
else bad extract "no scope + hash block after 'Compute scope + hash' in review-flow.md"; fi

# Hermetic git: HOME pinned inside $TMP and an identity in the environment, so the developer's
# ~/.gitconfig never reaches the fixtures and the extracted block inherits the same setup.
export HOME="$TMP/home" GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=base GIT_AUTHOR_EMAIL=base@example.com \
  GIT_COMMITTER_NAME=base GIT_COMMITTER_EMAIL=base@example.com
mkdir -p "$HOME"
R=""
new_repo() { # new_repo <name> — main with one commit, cwd untouched
  R="$TMP/$1"; mkdir -p "$R"
  git -C "$R" init -q -b main
  git -C "$R" config commit.gpgsign false
  echo one > "$R/t.txt"; git -C "$R" add t.txt; git -C "$R" commit -qm c1
}
commit() { echo "$2" >> "$R/$1"; git -C "$R" add "$1"; git -C "$R" commit -qm "$2"; }
sha() { git -C "$R" rev-parse "$1"; }

# run_block [shell] [subdir] — ws from the environment; prints base, mb, diff_hash, then the scope list; the scope diff -> $TMP/stream
run_block() {
  local sh="${1:-$BASH_BIN}"
  (cd "$R/${2:-}" && "$sh" -c '. "$1"
    printf "%s\n%s\n%s\n" "$base" "$mb" "$diff_hash"
    GIT_INDEX_FILE="$idx" git diff "$mb" -- ":/" ${ex[@]+"${ex[@]}"} > "$2"
    GIT_INDEX_FILE="$idx" git diff --name-only "$mb" -- ":/" ${ex[@]+"${ex[@]}"}' _ "$BLOCK" "$TMP/stream")
}
field() { run_block | sed -n "$1p"; }
hash_now() { field 3; }

# (a) stale local develop behind origin/develop -> origin/develop, merge-base = the branch point
new_repo a
git -C "$R" branch develop
commit t.txt c2; commit t.txt c3
git -C "$R" update-ref refs/remotes/origin/develop HEAD
point="$(sha HEAD)"
git -C "$R" checkout -qb feat; commit f.txt f1
out="$(run_block)"
if [ "$(echo "$out" | sed -n 1p)" = origin/develop ] && [ "$(echo "$out" | sed -n 2p)" = "$point" ]; then ok
else bad a-stale-develop "want origin/develop @ $point, got: $(echo "$out" | head -2 | tr '\n' ' ')"; fi

# (b) local develop with a commit of its own (not an ancestor of origin/develop) keeps winning
git -C "$R" checkout -q develop; commit own.txt d1; own="$(sha HEAD)"
git -C "$R" checkout -q feat; git -C "$R" merge -q --no-edit develop
out="$(run_block)"
if [ "$(echo "$out" | sed -n 1p)" = develop ] && [ "$(echo "$out" | sed -n 2p)" = "$own" ]; then ok
else bad b-own-develop "want develop @ $own, got: $(echo "$out" | head -2 | tr '\n' ' ')"; fi

# (c) no develop at all -> main; a stale local main behind origin/main -> origin/main
new_repo c
git -C "$R" checkout -qb feat; commit f.txt f1
if [ "$(field 1)" = main ]; then ok; else bad c-main "want main, got $(field 1)"; fi
git -C "$R" checkout -q main; commit t.txt c2
git -C "$R" update-ref refs/remotes/origin/main HEAD; git -C "$R" reset -q --hard HEAD~1
git -C "$R" checkout -q feat
if [ "$(field 1)" = origin/main ]; then ok; else bad c-stale-main "want origin/main, got $(field 1)"; fi

# (d)–(j) hash cases on one branch
new_repo h
git -C "$R" checkout -qb feat; commit f.txt f1
legacy="$(cd "$R" && git diff "$(git merge-base main HEAD)" | git hash-object --stdin)"
h0="$(hash_now)"
if [ "$h0" = "$legacy" ]; then ok
else bad i-legacy-hash "no untracked files: want the old git-diff hash $legacy, got $h0"; fi

echo new > "$R/n.txt"; h1="$(hash_now)"
if [ "$h1" != "$h0" ]; then ok; else bad d-untracked-add "hash unchanged after adding an untracked file"; fi
echo edit >> "$R/n.txt"; h2="$(hash_now)"
if [ "$h2" != "$h1" ]; then ok; else bad d-untracked-edit "hash unchanged after editing an untracked file"; fi

mkdir -p "$R/.claude/tmp" "$R/docs/technical-approaches"
echo x > "$R/.claude/tmp/shot.png"; echo y > "$R/docs/technical-approaches/ta.md"
if [ "$(hash_now)" = "$h2" ]; then ok; else bad e-excluded-dirs "hash moved for .claude/ or docs/technical-approaches/"; fi
if run_block | grep -q -e '^\.claude/' -e '^docs/technical-approaches/'; then
  bad e-excluded-scope "excluded dirs in the scope list"; else ok; fi

SENTINEL="BASE_SIM_SECRET_7f3a"
mkdir -p "$R/sub" "$R/cfg"
echo "TOKEN=$SENTINEL" > "$R/.env"; echo "K=$SENTINEL" > "$R/sub/.env.local"
echo "{\"k\":\"$SENTINEL\"}" > "$R/cfg/settings.local.json"
h3="$(hash_now)"
if [ "$h3" = "$h2" ]; then ok; else bad f-env-hash "hash moved after adding .env* / settings.local.json"; fi
echo "MORE=$SENTINEL" >> "$R/.env"
if [ "$(hash_now)" = "$h2" ]; then ok; else bad f-env-edit "hash moved after editing .env"; fi
if grep -q -e "$SENTINEL" -e '\.env' -e 'settings\.local\.json' "$TMP/stream"; then
  bad f-env-stream "the hashed stream carries a .env* / settings.local.json name or body"; else ok; fi

mkdir -p "$R/.envs/.prod"; echo "SECRET=$SENTINEL" > "$R/.envs/.prod/.django"
if [ "$(hash_now)" = "$h2" ] && ! grep -q "$SENTINEL" "$TMP/stream" && ! run_block | grep -q '^\.envs/'; then ok
else bad f-env-dir "a file inside a .env* dir reached the hash, the stream or the scope list"; fi

echo top > "$R/top.txt"; ht="$(hash_now)"
if [ "$(run_block "$BASH_BIN" sub | sed -n 3p)" = "$ht" ] && run_block "$BASH_BIN" sub | grep -qx top.txt; then ok
else bad l-subdir "run from a subdirectory: root untracked file dropped or hash differs"; fi
rm "$R/top.txt"

echo spaced > "$R/sub/a file.txt"; h4="$(hash_now)"
if [ "$h4" != "$h2" ] && run_block | grep -qx 'sub/a file.txt'; then ok
else bad g-space-name "a file name with a space is not hashed or listed"; fi

before="$(git -C "$R" status --porcelain)"; cached="$(git -C "$R" diff --cached --name-only)"
run_block >/dev/null
if [ "$(git -C "$R" status --porcelain)" = "$before" ] && [ "$(git -C "$R" diff --cached --name-only)" = "$cached" ]; then ok
else bad j-real-index "the block changed the real index"; fi

git -C "$R" add n.txt "sub/a file.txt"
if [ "$(hash_now)" = "$h4" ]; then ok; else bad h-staged-same "staging the untracked files moved the hash"; fi
git -C "$R" reset -q

if [ -n "$ZSH_BIN" ]; then
  if [ "$(run_block "$ZSH_BIN")" = "$(run_block)" ]; then ok; else bad k-zsh "zsh and bash disagree"; fi
fi

# (m)–(p) build-dirtied: the workspace's last notes.md line drops tracked files a build rewrote
new_repo w
mkdir -p "$R/dist" "$R/sub"; echo v1 > "$R/dist/app.js"; echo v1 > "$R/sub/a file.txt"
git -C "$R" add dist "sub/a file.txt"; git -C "$R" commit -qm assets
git -C "$R" checkout -qb feat; commit f.txt f1
clean="$(hash_now)"
echo rebuilt >> "$R/dist/app.js"; echo rebuilt >> "$R/sub/a file.txt"
dirty="$(hash_now)"
WS=.claude/tasks/T-1; mkdir -p "$R/$WS"
# note <text> — appends one line; the earlier fixture may end without a newline (that path is under test
# too), and without zsh the (p) branch that used to terminate it never runs.
note() { [ -z "$(tail -c1 "$R/$WS/notes.md")" ] || echo >> "$R/$WS/notes.md"; printf -- "%s\n" "$1" >> "$R/$WS/notes.md"; }
printf -- '- 2026-10-09 build-dirtied: t.txt\n- 2026-10-10 build-dirtied: dist/app.js' > "$R/$WS/notes.md"
git -C "$R" checkout -q -- "sub/a file.txt"; clean_sub="$(hash_now)"; echo rebuilt >> "$R/sub/a file.txt"
git -C "$R" checkout -q -- dist/app.js; want="$(hash_now)"; echo rebuilt >> "$R/dist/app.js"
[ "$want" != "$clean_sub" ] || bad m-fixture "restoring dist/app.js left the hash unchanged"
out="$(ws=$WS run_block)"
if [ "$(echo "$out" | sed -n 3p)" = "$want" ] && ! echo "$out" | grep -qx dist/app.js \
   && ! grep -q "^diff --git a/dist/app.js" "$TMP/stream" && echo "$out" | grep -qx "sub/a file.txt"; then ok
else bad m-excluded "the last build-dirtied line did not drop dist/app.js alone (unterminated last line)"; fi
if [ "$(ws=$WS run_block "$BASH_BIN" sub | sed -n 3p)" = "$want" ]; then ok
else bad m-subdir "run from a subdirectory: the exclusion is lost"; fi

echo new > "$R/n.txt"; hn="$(ws=$WS hash_now)"
git -C "$R" add n.txt
if [ "$hn" != "$want" ] && [ "$(ws=$WS hash_now)" = "$hn" ]; then ok
else bad n-staged-same "with an exclusion, staging an untracked file moved the hash (or it never counted)"; fi
git -C "$R" reset -q; rm "$R/n.txt"

note "- 2026-10-11 build-dirtied: sub/a file.txt ../x /etc/hosts dist * :(glob)** f.txt/"
if [ "$(ws=$WS hash_now)" = "$dirty" ]; then ok
else bad o-ignored "a spaced path, ../x, an absolute path, a directory or a glob reached the exclusion"; fi

if [ "$(ws=.claude/tasks/NONE hash_now)" = "$dirty" ] && [ "$(ws= hash_now)" = "$dirty" ]; then ok
else bad p-no-workspace "no workspace notes.md: the hash changed"; fi
note "- 2026-10-11 build-dirtied: dist/app.js"; printf -- "- 2026-10-12 build-dirtied:" >> "$R/$WS/notes.md"
if [ "$(ws=$WS hash_now)" = "$dirty" ]; then ok
else bad p-bare-line "a bare build-dirtied: line (no paths) did not end the exclusion"; fi
if [ -n "$ZSH_BIN" ]; then
  git -C "$R" checkout -q -- "sub/a file.txt"
  note "- 2026-10-12 build-dirtied: dist/app.js"
  if [ "$(ws=$WS run_block "$ZSH_BIN")" = "$(ws=$WS run_block)" ] && [ "$(ws=$WS hash_now)" = "$clean" ]; then ok
  else bad p-zsh "zsh and bash disagree on the exclusion"; fi
fi

# (q) a non-ASCII tracked path still matches its token (git would C-quote it)
git -C "$R" checkout -q -- .; echo v1 > "$R/é.js"; git -C "$R" add é.js; git -C "$R" commit -qm accent
note "- 2026-10-13 build-dirtied: é.js"
before="$(ws=$WS hash_now)"; echo rebuilt >> "$R/é.js"
if [ "$(ws=$WS hash_now)" = "$before" ]; then ok
else bad q-non-ascii "a build-dirtied non-ASCII path was not excluded"; fi

# (r) macOS bash 3.2 under set -u: an empty ex must not abort or blank the hash
if [ -x /bin/bash ]; then
  if [ "$(cd "$R" && /bin/bash -uc '. "$1"; echo "$diff_hash"' _ "$BLOCK" 2>&1)" = "$(hash_now)" ]; then ok
  else bad r-set-u "/bin/bash -u with no workspace: the block failed or the hash changed"; fi
fi

echo "base-review-flow-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
