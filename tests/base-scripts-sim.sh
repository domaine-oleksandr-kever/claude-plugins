#!/usr/bin/env bash
# Simulation harness for plugins/base/scripts/worktree-setup.sh (the generic worktree: branch, port,
# shared task workspace, the caller's --copy list) and plugins/base/scripts/scratch-hygiene.cjs (the
# base-tmp sweep CLI). Scratch git repos only: `origin` is a local bare repo, npm is a shim, nothing
# touches the network or the real checkout. Exit 0 = all green.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WTS="$ROOT/plugins/base/scripts/worktree-setup.sh"
HYG="$ROOT/plugins/base/scripts/scratch-hygiene.cjs"
BASH_BIN="$(command -v bash)"

TMP="$(mktemp -d)"
# WPID/WPID2 are the port-probe listeners (wt_listen): an interrupt must not leak a process holding a port.
WPID=""; WPID2=""
trap 'for p in "$WPID" "$WPID2"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; rm -rf "$TMP"' EXIT
HEAD_BEFORE="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)"
O="$TMP/out"; E="$TMP/err"

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

# ------------------------------------------------------------ worktree-setup.sh fixtures --
# Hermetic git: HOME pinned inside $TMP and an explicit identity, so the developer's ~/.gitconfig never
# reaches the fixtures. NB worktree-setup.sh prints error= on STDOUT — every case greps $O.
WTR="$TMP/wt"; mkdir -p "$WTR/home" "$WTR/shim"
wt_git() { HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 git \
             -c init.defaultBranch=develop -c user.name=base -c user.email=base@example.com \
             -c commit.gpgsign=false "$@"; }
wt_run() { # wt_run <args…>   ; stdout -> $O, stderr -> $E
  (cd "$WTR/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
     "$BASH_BIN" "$WTS" "$@") >"$O" 2>"$E"
}
wt_branch() { wt_git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null || true; }
wt_key() { grep "^$1=" "$O" | head -1 | cut -d= -f2- ; }
show() { tr '\n' ';' < "$O" | head -c 400; }

wt_wait_port() { # blocks until 127.0.0.1:$1 accepts (5 s cap)
  local i=0
  while [ "$i" -lt 50 ] && ! node -e '
    const s=require("net").connect(Number(process.argv[1]),"127.0.0.1");
    s.on("connect",()=>process.exit(0)); s.on("error",()=>process.exit(1));' "$1" 2>/dev/null; do
    sleep 0.1; i=$((i + 1))
  done
}
wt_listen() {
  node -e 'require("net").createServer().listen(Number(process.argv[1]),"127.0.0.1")' "$1" &
  WPID=$!
  wt_wait_port "$1"
}
wt_listen2() {
  node -e 'require("net").createServer().listen(Number(process.argv[1]),"127.0.0.1")' "$1" &
  WPID2=$!
  wt_wait_port "$1"
}
wt_unlisten() {
  local p
  for p in "$WPID" "$WPID2"; do
    [ -n "$p" ] || continue
    kill "$p" 2>/dev/null; wait "$p" 2>/dev/null
  done
  WPID=""; WPID2=""
}
# The lowest port no workspace has recorded yet: a probe case must occupy a port the bookkeeping does
# not already exclude, or it proves nothing.
wt_next_port() {
  local p=9293
  while [ "$p" -le 9312 ] && grep -rqE "dev-port: $p\$" "$WTR/theme/.claude/tasks" 2>/dev/null; do
    p=$((p + 1))
  done
  printf '%s' "$p"
}
mk_repo() { # <dir>
  mkdir -p "$1"
  wt_git init --bare -q "$1/origin.git"
  wt_git init -q "$1/theme"
  printf 'x\n' > "$1/theme/README.md"
  wt_git -C "$1/theme" add -A
  wt_git -C "$1/theme" commit -qm init
  wt_git -C "$1/theme" remote add origin "$1/origin.git"
  wt_git -C "$1/theme" push -qu origin develop
}
repo_run() { # <repo-dir> <args…>
  (cd "$1/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
     "$BASH_BIN" "$WTS" "${@:2}") >"$O" 2>"$E"
}

wt_git init --bare -q "$WTR/origin.git"
wt_git init -q "$WTR/theme"
printf 'x\n' > "$WTR/theme/README.md"
wt_git -C "$WTR/theme" add -A
wt_git -C "$WTR/theme" commit -qm init
wt_git -C "$WTR/theme" remote add origin "$WTR/origin.git"
wt_git -C "$WTR/theme" push -qu origin develop
# Untracked on purpose, not excluded: a real repo gitignores the `.claude` wiring and the copied
# config, so they land in the worktree as untracked paths — what the remove-mode dirty check looks past.
mkdir -p "$WTR/theme/.claude"
printf '{"permissions":{"allow":["Bash(ls:*)"]}}\n' > "$WTR/theme/.claude/settings.local.json"
# npm never really runs: the shim logs every call. WT_NPM_WAIT holds `npm ci` until that file exists;
# WT_NPM_NOTES logs how many `dev-port:` lines that notes file carries at install time.
cat > "$WTR/shim/npm" <<'FAKE'
#!/usr/bin/env bash
printf 'argv=%s\n' "$*" >> "${WT_NPM_LOG:-/dev/null}"
if [ -n "${WT_NPM_WAIT:-}" ]; then
  i=0; while [ ! -f "$WT_NPM_WAIT" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
fi
[ -z "${WT_NPM_NOTES:-}" ] || \
  printf 'dev-port-lines=%s\n' "$(grep -c 'dev-port:' "$WT_NPM_NOTES" 2>/dev/null)" >> "${WT_NPM_LOG:-/dev/null}"
exit 0
FAKE
chmod +x "$WTR/shim/npm"
WT_NPM_LOG="$WTR/npm.log"; : > "$WT_NPM_LOG"; export WT_NPM_LOG
# The script reports git's PHYSICAL paths ($TMP under /var reaches them through /private/var).
WTMAIN="$(cd "$WTR/theme" && pwd -P)"

# W1: a fresh ticket-key run creates the sibling worktree on feat/<KEY> off origin/develop
rc=0; wt_run ABC-123 || rc=$?
W1DIR="$WTR/theme-ABC-123"
if [ "$rc" -eq 0 ] && [ -d "$W1DIR" ] && [ "$(wt_branch "$W1DIR")" = "feat/ABC-123" ] \
   && [ "$(wt_key worktree)" = "$(cd "$W1DIR" && pwd -P)" ] \
   && grep -q '^branch_source=created$' "$O" && grep -q '^reused=false$' "$O" \
   && grep -q '^copied=none$' "$O" && grep -q '^kept=none$' "$O" && grep -q '^missing=none$' "$O" \
   && ! grep -qE '^(toml|toml_unpinned|env)=' "$O"; then ok
else bad W1-fresh-create "rc=$rc out=$(show) err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# W2: the hand-off block names the worktree, the shared workspace and the port; no team skill
W1PORT="$(wt_key dev_port)"; W1DIRP="$(cd "$W1DIR" && pwd -P)"
if grep -qF "cd '$W1DIRP' && claude" "$O" && grep -qF 'the task workspace .claude/tasks/ABC-123 is shared' "$O" \
   && grep -qF "# dev server: start it on port $W1PORT" "$O" \
   && ! grep -qE '/fe:|shopify|--theme' "$O" && printf '%s' "$W1PORT" | grep -qE '^9[0-9]+$'; then ok
else bad W2-handoff-block "port=$W1PORT out=$(show)"; fi

# W3: `.claude/tasks` is a symlink INTO the main checkout; settings.local.json is a real copy
if [ -L "$W1DIR/.claude/tasks" ] \
   && [ "$(cd "$W1DIR/.claude/tasks" && pwd -P)" = "$(cd "$WTR/theme/.claude/tasks" && pwd -P)" ] \
   && [ -f "$W1DIR/.claude/settings.local.json" ] && [ ! -L "$W1DIR/.claude/settings.local.json" ] \
   && grep -q '^settings=copied$' "$O"; then ok
else bad W3-claude-wiring "link=$(ls -l "$W1DIR/.claude" 2>&1 | tr '\n' ';')"; fi

# W3c: the symlink is stamped into the shared `.git/info/exclude`, so git never sees it
if ! wt_git -C "$W1DIR" status --porcelain -uall | grep -q '\.claude/tasks' \
   && grep -qx '\.claude/tasks' "$WTR/theme/.git/info/exclude"; then ok
else bad W3c-tasks-link-excluded "status=$(wt_git -C "$W1DIR" status --porcelain -uall | tr '\n' ';')"; fi

# W4: the dev port is recorded in the SHARED workspace, and it is not the main checkout's 9292
if grep -qE "dev-port: $W1PORT\$" "$WTR/theme/.claude/tasks/ABC-123/notes.md" 2>/dev/null \
   && [ -f "$W1DIR/.claude/tasks/ABC-123/notes.md" ] && [ "$W1PORT" != "9292" ]; then ok
else bad W4-dev-port-recorded "port=$W1PORT notes=$(tr '\n' ';' < "$WTR/theme/.claude/tasks/ABC-123/notes.md" 2>&1)"; fi

# W5: no package.json ⇒ `npm ci` is skipped, not attempted
if grep -q '^npm=skipped$' "$O" && [ ! -s "$WT_NPM_LOG" ]; then ok
else bad W5-npm-skipped "out=$(grep '^npm=' "$O") log=$(tr '\n' ';' < "$WT_NPM_LOG")"; fi

# W6: a re-run is the re-entry path: same port, one dev-port line
rc=0; wt_run ABC-123 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^reused=true$' "$O" && [ "$(wt_key dev_port)" = "$W1PORT" ] \
   && grep -q '^settings=kept$' "$O" \
   && [ "$(grep -c 'dev-port:' "$WTR/theme/.claude/tasks/ABC-123/notes.md")" -eq 1 ]; then ok
else bad W6-idempotent-rerun "rc=$rc out=$(show)"; fi

# W7: a kebab-case slug is a valid work-id too
rc=0; wt_run header-refactor || rc=$?
if [ "$rc" -eq 0 ] && [ -d "$WTR/theme-header-refactor" ] \
   && [ "$(wt_branch "$WTR/theme-header-refactor")" = "feat/header-refactor" ] \
   && [ -d "$WTR/theme/.claude/tasks/header-refactor" ]; then ok
else bad W7-slug-create "rc=$rc out=$(show) err=$(head -c 200 "$E" | tr '\n' ' ')"; fi

# W8: neither a ticket key nor a clean slug → refused BEFORE any git write
for badid in Bad_ID ABC-12a abc--x trail- "sp ace" ../escape; do
  rc=0; wt_run "$badid" || rc=$?
  if [ "$rc" -eq 1 ] && grep -q '^error=invalid_work_id' "$O" && [ ! -e "$WTR/theme-$badid" ]; then ok
  else bad "W8-invalid-id[$badid]" "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi
done
rc=0; wt_run -lead || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=unknown arg: -lead' "$O"; then ok
else bad W8b-dash-id "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# W9: an existing LOCAL feat/<KEY> is checked out into the worktree, never duplicated
wt_git -C "$WTR/theme" branch -q feat/REU-7 develop
rc=0; wt_run REU-7 || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^branch_source=local$' "$O" \
   && [ "$(wt_branch "$WTR/theme-REU-7")" = "feat/REU-7" ] \
   && [ "$(wt_git -C "$WTR/theme" branch --list 'feat/REU-7' | wc -l | tr -d ' ')" = "1" ]; then ok
else bad W9-local-branch-reuse "rc=$rc out=$(show)"; fi

# W9b: a branch that exists only on origin is fetched and tracked, not forked off the base
wt_git -C "$WTR/theme" branch -q feat/REM-8 develop
wt_git -C "$WTR/theme" push -q origin feat/REM-8
wt_git -C "$WTR/theme" branch -qD feat/REM-8
wt_git -C "$WTR/theme" update-ref -d refs/remotes/origin/feat/REM-8
rc=0; wt_run REM-8 || rc=$?
wt_up="$(wt_git -C "$WTR/theme-REM-8" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || true)"
if [ "$rc" -eq 0 ] && grep -q '^branch_source=remote$' "$O" \
   && [ "$(wt_branch "$WTR/theme-REM-8")" = "feat/REM-8" ] && [ "$wt_up" = "origin/feat/REM-8" ]; then ok
else bad W9b-remote-branch-reuse "rc=$rc upstream=$wt_up out=$(show)"; fi

# W9c: origin unreachable, the remote-tracking ref on disk still marks the branch as existing
wt_git -C "$WTR/theme" checkout -q -b feat/OFF-3
printf 'colleague work\n' > "$WTR/theme/work.txt"
wt_git -C "$WTR/theme" add work.txt
wt_git -C "$WTR/theme" commit -qm colleague
wt_git -C "$WTR/theme" push -q origin feat/OFF-3
wt_git -C "$WTR/theme" checkout -q develop
wt_git -C "$WTR/theme" branch -qD feat/OFF-3
wt_git -C "$WTR/theme" fetch -q origin '+refs/heads/feat/OFF-3:refs/remotes/origin/feat/OFF-3'
wt_git -C "$WTR/theme" remote set-url origin "$WTR/unreachable.git"
rc=0; wt_run OFF-3 || rc=$?
wt_git -C "$WTR/theme" remote set-url origin "$WTR/origin.git"
if [ "$rc" -eq 0 ] && grep -q '^branch_source=remote$' "$O" && [ -f "$WTR/theme-OFF-3/work.txt" ]; then ok
else bad W9c-offline-remote-ref "rc=$rc out=$(show)"; fi

# W11: the port probe steps over a port that is already listening
wt_probe_port="$(wt_next_port)"
wt_listen "$wt_probe_port"
rc=0; wt_run PORT-2 || rc=$?
wt_port2="$(wt_key dev_port)"
wt_unlisten
if [ "$rc" -eq 0 ] && [ -n "$wt_port2" ] && [ "$wt_port2" != "$wt_probe_port" ] \
   && [ "$wt_port2" -gt "$wt_probe_port" ]; then ok
else bad W11-port-probe "rc=$rc port=$wt_port2 occupied=$wt_probe_port out=$(show)"; fi

# W11b: two worktrees created back to back get two ports, though nothing listens on either yet
rc=0; wt_run PAR-3 || rc=$?; wt_par1="$(wt_key dev_port)"
rc2=0; wt_run PAR-4 || rc2=$?; wt_par2="$(wt_key dev_port)"
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ -n "$wt_par1" ] && [ "$wt_par1" != "$wt_par2" ]; then ok
else bad W11b-port-per-worktree "rc=$rc/$rc2 ports=$wt_par1/$wt_par2"; fi

# W12: --remove refuses a worktree with real uncommitted work and removes nothing
printf 'edited in the worktree\n' >> "$W1DIR/README.md"
rc=0; wt_run --remove ABC-123 || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=worktree_dirty' "$O" && grep -q '^dirty=.*README.md' "$O" \
   && [ -d "$W1DIR" ]; then ok
else bad W12-remove-dirty-refused "rc=$rc out=$(show)"; fi

# W13: --force takes the worktree; the branch is kept
rc=0; wt_run --remove ABC-123 --force || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^removed=' "$O" && [ ! -d "$W1DIR" ] && grep -q '^branch_kept=true$' "$O" \
   && wt_git -C "$WTR/theme" show-ref --verify --quiet refs/heads/feat/ABC-123; then ok
else bad W13-remove-force "rc=$rc out=$(show)"; fi

# W14: a CLEAN worktree removes without --force; the shared workspace in the MAIN checkout survives
printf 'the approved plan\n' > "$WTR/theme/.claude/tasks/header-refactor/plan.md"
rc=0; wt_run --remove header-refactor || rc=$?
if [ "$rc" -eq 0 ] && [ ! -d "$WTR/theme-header-refactor" ] \
   && [ "$(cat "$WTR/theme/.claude/tasks/header-refactor/plan.md" 2>/dev/null)" = "the approved plan" ] \
   && [ -f "$WTR/theme/.claude/tasks/ABC-123/notes.md" ] \
   && grep -q "^workspace_kept=$WTMAIN/.claude/tasks/header-refactor$" "$O"; then ok
else bad W14-remove-clean-keeps-workspace "rc=$rc out=$(show)"; fi

# W14b: a re-create re-probes the stale recorded port instead of handing back a taken one
wt_listen "$W1PORT"
rc=0; wt_run ABC-123 || rc=$?
wt_port3="$(wt_key dev_port)"
wt_unlisten
if [ "$rc" -eq 0 ] && grep -q '^reused=false$' "$O" && [ -n "$wt_port3" ] && [ "$wt_port3" != "$W1PORT" ]; then ok
else bad W14b-stale-port-reprobed "rc=$rc port=$wt_port3 was=$W1PORT out=$(show)"; fi

# W15: removing something that is not a registered worktree is a named refusal
rc=0; wt_run --remove NOPE-9 || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=worktree_not_found' "$O"; then ok
else bad W15-remove-unknown "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# W16: a directory already at the worktree path is a hard stop, its files untouched
mkdir -p "$WTR/theme-TAKEN-1"; printf 'mine\n' > "$WTR/theme-TAKEN-1/keep.txt"
rc=0; wt_run TAKEN-1 || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=worktree_path_taken' "$O" && [ -f "$WTR/theme-TAKEN-1/keep.txt" ]; then ok
else bad W16-path-taken "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# W17: outside a git repo the script says so; no worktree hangs off this repo or the fixture root
rc=0; (cd "$WTR" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 GIT_CEILING_DIRECTORIES="$WTR" \
  "$BASH_BIN" "$WTS" OUT-1) >"$O" 2>"$E" || rc=$?
wt_leak="$(ls -d "$WTR"/*OUT-1 "$(dirname "$ROOT")"/*OUT-1 2>/dev/null | tr '\n' ' ')"
wt_plug_leak="$(git -C "$ROOT" worktree list --porcelain 2>/dev/null | grep -c 'OUT-1' || true)"
if [ "$rc" -eq 1 ] && grep -q '^error=not_a_git_repo' "$O" && [ -z "$wt_leak" ] && [ "$wt_plug_leak" -eq 0 ]; then ok
else bad W17-outside-repo "rc=$rc leak='$wt_leak' plug=$wt_plug_leak out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# W18: a bare invocation prints the usage line; -h/--help print it and exit 0; a near miss is unknown
rc=0; wt_run || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=usage: worktree-setup.sh' "$O"; then ok
else bad W18-usage "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi
wt_count_before="$(wt_git -C "$WTR/theme" worktree list | wc -l | tr -d ' ')"
for hf in -h --help; do
  rc=0; wt_run "$hf" || rc=$?
  if [ "$rc" -eq 0 ] && grep -q '^usage: worktree-setup.sh <WORK-ID> \[<base-branch>\] \[--copy <path>\]' "$O" && [ ! -s "$E" ] \
     && [ "$(wt_git -C "$WTR/theme" worktree list | wc -l | tr -d ' ')" = "$wt_count_before" ]; then ok
  else bad "W18b-help[$hf]" "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi
done
rc=0; wt_run --helpme ABC-9 || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=unknown arg: --helpme' "$O" && [ ! -e "$WTR/theme-ABC-9" ]; then ok
else bad W18c-near-miss-flag "rc=$rc out=$(head -c 160 "$O" | tr '\n' ' ')"; fi

# W19: the hand-off line is pasted into a shell verbatim: a repo under a path with a space lands there
mk_repo "$WTR/sp ace"
rc=0; repo_run "$WTR/sp ace" SPC-1 || rc=$?
wt_spdir="$(cd "$WTR/sp ace/theme-SPC-1" 2>/dev/null && pwd -P || true)"
wt_cdline="$(grep '^  cd .* && claude$' "$O" | head -1 | sed 's/^  //; s/ && claude$//')"
wt_land="$( (eval "$wt_cdline" >/dev/null 2>&1; pwd -P) 2>/dev/null || true )"
if [ "$rc" -eq 0 ] && [ -n "$wt_spdir" ] && [ "$wt_land" = "$wt_spdir" ]; then ok
else bad W19-handoff-quoted "rc=$rc land=$wt_land want=$wt_spdir line=$wt_cdline"; fi

# W20: the report names the branch the worktree is REALLY on, at re-entry and at removal
rc=0; wt_run DIF-5 || rc=$?
wt_git -C "$WTR/theme-DIF-5" checkout -q -b hotfix/other
rc=0; wt_run DIF-5 || rc=$?
wt_dif_create="$(wt_key branch)"
wt_dif_warn=0; grep -q '^warn=branch_switched expected=feat/DIF-5 actual=hotfix/other' "$O" && wt_dif_warn=1
rc2=0; wt_run --remove DIF-5 --force || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$wt_dif_create" = "hotfix/other" ] \
   && [ "$wt_dif_warn" -eq 1 ] && [ "$(wt_key branch)" = "hotfix/other" ]; then ok
else bad W20-actual-branch-reported "rc=$rc/$rc2 create=$wt_dif_create warn=$wt_dif_warn remove=$(wt_key branch)"; fi

# W21: the dirty check sees INSIDE `.claude/` (`-uall`): a developer's notes there are listed, kept
rc=0; wt_run QAN-1 || rc=$?
mkdir -p "$WTR/theme-QAN-1/.claude/notes"
printf 'qa checklist\n' > "$WTR/theme-QAN-1/.claude/notes/qa.md"
rc2=0; wt_run --remove QAN-1 || rc2=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 1 ] && grep -q '^error=worktree_dirty' "$O" \
   && grep -q '^dirty=.*\.claude/notes/qa\.md' "$O" && [ -f "$WTR/theme-QAN-1/.claude/notes/qa.md" ]; then ok
else bad W21-dirty-sees-into-claude "rc=$rc/$rc2 out=$(show)"; fi
wt_run --remove QAN-1 --force >/dev/null 2>&1 || true

# W22: a detached HEAD is refused without --force; under --force the sha is printed, no branch claimed
rc=0; wt_run DET-6 || rc=$?
wt_git -C "$WTR/theme-DET-6" checkout -q --detach
printf 'mid-rebase work\n' > "$WTR/theme-DET-6/detached.txt"
wt_git -C "$WTR/theme-DET-6" add detached.txt
wt_git -C "$WTR/theme-DET-6" commit -qm 'only this HEAD holds it'
wt_det_sha="$(wt_git -C "$WTR/theme-DET-6" rev-parse HEAD)"
rc2=0; wt_run --remove DET-6 || rc2=$?
wt_det_refused=0
if grep -q '^error=worktree_detached' "$O" && grep -qF "$wt_det_sha" "$O" && [ -d "$WTR/theme-DET-6" ]; then wt_det_refused=1; fi
rc3=0; wt_run --remove DET-6 --force || rc3=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 1 ] && [ "$wt_det_refused" -eq 1 ] && [ "$rc3" -eq 0 ] \
   && [ ! -d "$WTR/theme-DET-6" ] && grep -qF "warn=detached_head_removed head=$wt_det_sha" "$O" \
   && ! grep -q '^branch_kept=true$' "$O"; then ok
else bad W22-remove-detached "rc=$rc/$rc2/$rc3 refused=$wt_det_refused out=$(show)"; fi

# W23: the port a removed worktree recorded is released
rc=0; wt_run REL-9 || rc=$?; wt_rel1="$(wt_key dev_port)"
rc2=0; wt_run --remove REL-9 || rc2=$?
rc3=0; wt_run REL-10 || rc3=$?; wt_rel2="$(wt_key dev_port)"
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$rc3" -eq 0 ] \
   && [ -f "$WTR/theme/.claude/tasks/REL-9/notes.md" ] && [ -n "$wt_rel1" ] && [ "$wt_rel2" = "$wt_rel1" ]; then ok
else bad W23-port-released-on-remove "rc=$rc/$rc2/$rc3 ports=$wt_rel1/$wt_rel2"; fi
wt_run --remove REL-10 --force >/dev/null 2>&1 || true

# W24: twenty claims by worktrees long gone do not exhaust the range
i=9293
while [ "$i" -le 9312 ]; do
  mkdir -p "$WTR/theme/.claude/tasks/OLD-$i"
  printf -- '- 2026-01-01 worktree `gone` on branch `feat/OLD-%s`, dev-port: %s\n' "$i" "$i" \
    > "$WTR/theme/.claude/tasks/OLD-$i/notes.md"
  i=$((i + 1))
done
rc=0; wt_run EXH-1 || rc=$?
wt_exh_port="$(wt_key dev_port)"
rm -rf "$WTR"/theme/.claude/tasks/OLD-*
if [ "$rc" -eq 0 ] && [ -d "$WTR/theme-EXH-1" ] && ! grep -q '^error=' "$O" \
   && printf '%s' "$wt_exh_port" | grep -qE '^9[0-9]+$'; then ok
else bad W24-stale-ports-released "rc=$rc port=$wt_exh_port out=$(show)"; fi
wt_run --remove EXH-1 --force >/dev/null 2>&1 || true

# W25: an exclude file whose last byte is not a newline is bridged, not glued onto
mk_repo "$WTR/nonl"
printf 'secret.txt' > "$WTR/nonl/theme/.git/info/exclude"
rc=0; repo_run "$WTR/nonl" NL-1 || rc=$?
WT_NL_EXCL="$WTR/nonl/theme/.git/info/exclude"
if [ "$rc" -eq 0 ] && grep -qx 'secret.txt' "$WT_NL_EXCL" && grep -qx '\.claude/tasks' "$WT_NL_EXCL" \
   && ! grep -q 'secret.txt\.claude' "$WT_NL_EXCL"; then ok
else bad W25-exclude-trailing-newline "rc=$rc exclude=$(tr '\n' ';' < "$WT_NL_EXCL" 2>&1)"; fi

# W26: no /dev/tcp and no usable `nc` → a port is still handed out, and the run says it was unchecked.
# The copy under test has the probe's verdict line replaced by the message such a bash prints.
WTS_NP="$WTR/worktree-setup-noprobe.sh"
sed 's#^DEVTCP_MSG=.*#DEVTCP_MSG="base-sim: No such file or directory"#' "$WTS" > "$WTS_NP"
mkdir -p "$WTR/ncshim"
cat > "$WTR/ncshim/nc" <<'FAKE'
#!/usr/bin/env bash
printf 'usage: nc [-46CDdFhklNnrStUuvZz]\n' >&2
exit 1
FAKE
chmod +x "$WTR/ncshim/nc"
rc=0; (cd "$WTR/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/ncshim:$WTR/shim:$PATH" \
  "$BASH_BIN" "$WTS_NP" NOP-1) >"$O" 2>"$E" || rc=$?
wt_nop_port="$(wt_key dev_port)"
if [ "$rc" -eq 0 ] && grep -q '^DEVTCP_MSG="base-sim' "$WTS_NP" \
   && [ "$(grep -c '^warn=port_probe_unavailable' "$O")" -eq 1 ] \
   && grep -qF 'start it on another port and note that in the workspace' "$O" \
   && printf '%s' "$wt_nop_port" | grep -qE '^9[0-9]+$' && [ -d "$WTR/theme-NOP-1" ]; then ok
else bad W26-port-probe-unavailable "rc=$rc port=$wt_nop_port out=$(show)"; fi
wt_run --remove NOP-1 --force >/dev/null 2>&1 || true

# W27: a `--separate-git-dir` checkout cannot host a sibling worktree: named refusal, nothing created
mkdir -p "$WTR/sep"
wt_git init -q --separate-git-dir "$WTR/sep/realgit" "$WTR/sep/theme"
rc=0; (cd "$WTR/sep/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
  "$BASH_BIN" "$WTS" SEP-1) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=unsupported_layout' "$O" \
   && [ ! -e "$WTR/sep-SEP-1" ] && [ ! -e "$WTR/sep/realgit/.claude" ]; then ok
else bad W27-separate-git-dir "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi

# W31: two setups at once never share a port: RACE-1 is frozen inside `npm ci` while RACE-2 runs
mk_repo "$WTR/race"
printf '{"name":"x","private":true}\n' > "$WTR/race/theme/package.json"
wt_git -C "$WTR/race/theme" add -A
wt_git -C "$WTR/race/theme" commit -qm pkg
wt_git -C "$WTR/race/theme" push -q origin develop
RACE_MK="$TMP/race.npm.mark"; rm -f "$RACE_MK"
RACE1_NOTES="$WTR/race/theme/.claude/tasks/RACE-1/notes.md"
(cd "$WTR/race/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
   WT_NPM_WAIT="$RACE_MK" WT_NPM_LOG=/dev/null "$BASH_BIN" "$WTS" RACE-1) >"$TMP/race1.out" 2>&1 &
RACE_PID=$!
i=0
while [ "$i" -lt 50 ] && ! grep -q 'dev-port:' "$RACE1_NOTES" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
rc=0; repo_run "$WTR/race" RACE-2 || rc=$?
wt_race2="$(wt_key dev_port)"
: > "$RACE_MK"
rc1=0; wait "$RACE_PID" || rc1=$?
wt_race1_rec="$(grep -oE 'dev-port: [0-9]+' "$RACE1_NOTES" 2>/dev/null | tail -1 | tr -dc '0-9')"
wt_race1_out="$(grep '^dev_port=' "$TMP/race1.out" | cut -d= -f2)"
if [ "$rc" -eq 0 ] && [ "$rc1" -eq 0 ] && [ -n "$wt_race1_rec" ] && [ "$wt_race1_rec" = "$wt_race1_out" ] \
   && [ -n "$wt_race2" ] && [ "$wt_race2" != "$wt_race1_rec" ] \
   && grep -q '^npm=installed$' "$TMP/race1.out" && grep -q '^npm=installed$' "$O"; then ok
else bad W31-port-race-parallel-setups "rc=$rc/$rc1 race1=$wt_race1_out rec=$wt_race1_rec race2=$wt_race2"; fi

# W31b: the claim is on disk when `npm ci` starts and is not written a second time afterwards
RACE3_NOTES="$WTR/race/theme/.claude/tasks/RACE-3/notes.md"
RACE3_LOG="$TMP/race3.npm.log"; : > "$RACE3_LOG"
rc=0; (cd "$WTR/race/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
   WT_NPM_NOTES="$RACE3_NOTES" WT_NPM_LOG="$RACE3_LOG" "$BASH_BIN" "$WTS" RACE-3) >"$O" 2>"$E" || rc=$?
if [ "$rc" -eq 0 ] && grep -qx 'dev-port-lines=1' "$RACE3_LOG" \
   && [ "$(grep -c 'dev-port:' "$RACE3_NOTES" 2>/dev/null)" -eq 1 ] \
   && grep -qE "dev-port: $(wt_key dev_port)\$" "$RACE3_NOTES"; then ok
else bad W31b-port-recorded-before-npm "rc=$rc log=$(tr '\n' ';' < "$RACE3_LOG") out=$(show)"; fi

# W32: every port claimed by a live worktree, nothing listening → still a port, with a warning;
# W32b: something listening on every port too → named refusal, nothing created
WTS_NAR="$WTR/worktree-setup-narrow.sh"
sed 's/^PORT_LAST=.*/PORT_LAST=9294/' "$WTS" > "$WTS_NAR"
mk_repo "$WTR/nar"
nar_run() {
  (cd "$WTR/nar/theme" && HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 PATH="$WTR/shim:$PATH" \
     "$BASH_BIN" "$WTS_NAR" "$@") >"$O" 2>"$E"
}
rc=0; nar_run NAR-1 || rc=$?; wt_nar1="$(wt_key dev_port)"
rc2=0; nar_run NAR-2 || rc2=$?; wt_nar2="$(wt_key dev_port)"
rc3=0; nar_run NAR-3 || rc3=$?; wt_nar3="$(wt_key dev_port)"
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$rc3" -eq 0 ] && grep -q '^PORT_LAST=9294$' "$WTS_NAR" \
   && [ "$wt_nar1" = 9293 ] && [ "$wt_nar2" = 9294 ] && [ "$wt_nar3" = 9293 ] \
   && [ "$(grep -c '^warn=port_range_crowded range=9293-9294' "$O")" -eq 1 ]; then ok
else bad W32-second-port-pass "rc=$rc/$rc2/$rc3 ports=$wt_nar1/$wt_nar2/$wt_nar3 out=$(show)"; fi
wt_listen 9293; wt_listen2 9294
rc=0; nar_run NAR-4 || rc=$?
if [ "$rc" -ne 0 ] && grep -q '^error=no_free_port range=9293-9294' "$O" && [ ! -d "$WTR/nar/theme-NAR-4" ]; then ok
else bad W32b-no-free-port "rc=$rc out=$(show)"; fi
wt_unlisten

# ------------------------------------------------------------------- the --copy list --
mk_repo "$WTR/cp"
CPM="$WTR/cp/theme"
printf 'JIRA_API_TOKEN=fixture\n' > "$CPM/.env"
printf '[environments.development]\nstore = "acme-dev"\n' > "$CPM/shop.toml"
mkdir -p "$CPM/config/local/deep"; printf 'a\n' > "$CPM/config/local/a.json"; printf 'b\n' > "$CPM/config/local/deep/b.json"
cp_run() { repo_run "$WTR/cp" "$@"; }

# C1: files and a directory are copied (real copies, never links); an absent path is named missing
rc=0; cp_run CPY-1 --copy .env --copy shop.toml --copy config/local --copy not/there || rc=$?
CPW="$WTR/cp/theme-CPY-1"
if [ "$rc" -eq 0 ] && grep -q '^copied=.env,shop.toml,config/local$' "$O" && grep -q '^kept=none$' "$O" \
   && grep -q '^missing=not/there$' "$O" \
   && [ -f "$CPW/.env" ] && [ ! -L "$CPW/.env" ] && cmp -s "$CPM/.env" "$CPW/.env" \
   && cmp -s "$CPM/shop.toml" "$CPW/shop.toml" && [ ! -L "$CPW/config/local" ] \
   && cmp -s "$CPM/config/local/deep/b.json" "$CPW/config/local/deep/b.json"; then ok
else bad C1-copy-list "rc=$rc out=$(show)"; fi

# C2: a re-entry keeps the worktree's own (edited) copy instead of clobbering it
printf 'EXTRA=1\n' >> "$CPW/.env"
rc=0; cp_run CPY-1 --copy .env --copy shop.toml || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^kept=.env,shop.toml$' "$O" && grep -q '^copied=none$' "$O" \
   && grep -qx 'EXTRA=1' "$CPW/.env"; then ok
else bad C2-copy-kept-on-reentry "rc=$rc out=$(show)"; fi

# C3: a copied file that still matches the main checkout's is not uncommitted work, even after a
# re-entry with a shorter list (the record merges); an edited copy and any other untracked file are
printf 'scratch\n' > "$CPW/stray.txt"
rc=0; cp_run --remove CPY-1 || rc=$?
cp_dirty="$(wt_key dirty)"
rm -f "$CPW/stray.txt"; cp "$CPM/.env" "$CPW/.env"
rc2=0; cp_run --remove CPY-1 || rc2=$?
if [ "$rc" -eq 1 ] && [ "$cp_dirty" = ".env stray.txt" ] && [ "$rc2" -eq 0 ] && [ ! -d "$CPW" ] \
   && grep -q '^removed=' "$O" && [ -f "$CPM/.env" ]; then ok
else bad C3-copies-not-dirty "rc=$rc/$rc2 dirty='$cp_dirty' out=$(show)"; fi

# C4: a path that leaves the checkout, names git's own files or the shared workspace is refused
# before any git write
for badp in /etc/passwd ../outside a/../b ./x a//b . .. .git .git/config .claude .claude/ .claude/tasks \
            .claude/tasks/ABC-1 .claude/settings.local.json .Claude .CLAUDE/Tasks /; do
  rc=0; cp_run CPY-4 --copy "$badp" || rc=$?
  if [ "$rc" -eq 1 ] && grep -q '^error=invalid_copy_path' "$O" && [ ! -e "$WTR/cp/theme-CPY-4" ]; then ok
  else bad "C4-invalid-copy[$badp]" "rc=$rc out=$(head -c 200 "$O" | tr '\n' ' ')"; fi
done
rc=0; cp_run CPY-4 --copy "" || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=invalid_copy_path' "$O"; then ok; else bad C4b-empty-copy "rc=$rc out=$(show)"; fi
rc=0; cp_run CPY-4 --copy || rc=$?
if [ "$rc" -eq 1 ] && grep -q '^error=--copy needs a path' "$O" && [ ! -e "$WTR/cp/theme-CPY-4" ]; then ok
else bad C4c-copy-no-value "rc=$rc out=$(show)"; fi

# C5: a trailing slash names the same directory
rc=0; cp_run CPY-5 --copy config/local/ || rc=$?
if [ "$rc" -eq 0 ] && grep -q '^copied=config/local$' "$O" && [ -f "$WTR/cp/theme-CPY-5/config/local/a.json" ]; then ok
else bad C5-trailing-slash "rc=$rc out=$(show)"; fi
cp_run --remove CPY-5 >/dev/null 2>&1 || true

# C7: a new file under a copied directory is uncommitted work; the files the copy put there are not
rc=0; cp_run CPY-7 --copy config/local || rc=$?
CPW7="$WTR/cp/theme-CPY-7"
printf 'mine\n' > "$CPW7/config/local/mine.json"
rc2=0; cp_run --remove CPY-7 || rc2=$?
cp_dirty="$(wt_key dirty)"
rm -f "$CPW7/config/local/mine.json"
rc3=0; cp_run --remove CPY-7 || rc3=$?
if [ "$rc" -eq 0 ] && [ "$rc2" -eq 1 ] && [ "$cp_dirty" = "config/local/mine.json" ] && [ "$rc3" -eq 0 ] \
   && [ ! -d "$CPW7" ]; then ok
else bad C7-new-file-under-copied-dir "rc=$rc/$rc2/$rc3 dirty='$cp_dirty' out=$(show)"; fi

# C8: a path the worktree already had (kept=) is never recorded: new work under it stays dirty
mk_repo "$WTR/cp8"
mkdir -p "$WTR/cp8/theme/src"; printf 'a\n' > "$WTR/cp8/theme/src/a.js"
wt_git -C "$WTR/cp8/theme" add -A; wt_git -C "$WTR/cp8/theme" commit -qm src; wt_git -C "$WTR/cp8/theme" push -q origin develop
rc=0; repo_run "$WTR/cp8" CPY-8 --copy src || rc=$?
cp8_out="$(show)"
CPW8="$WTR/cp8/theme-CPY-8"
printf 'feature\n' > "$CPW8/src/new-feature.js"
rc2=0; repo_run "$WTR/cp8" --remove CPY-8 || rc2=$?
cp_dirty="$(wt_key dirty)"
if [ "$rc" -eq 0 ] && printf '%s' "$cp8_out" | grep -q 'kept=src;' && [ "$rc2" -eq 1 ] \
   && [ "$cp_dirty" = "src/new-feature.js" ] && [ -f "$CPW8/src/new-feature.js" ]; then ok
else bad C8-kept-dir-stays-dirty "rc=$rc/$rc2 dirty='$cp_dirty' out=$cp8_out"; fi

# C6: the generic script carries no team step: no store-theme pinning, no profile probe, no fixed copies
if ! grep -qE 'session-theme|project-profile|create-preview-theme|toml_unpinned|ENV_STATE' "$WTS"; then ok
else bad C6-no-team-steps "$(grep -nE 'session-theme|project-profile|create-preview-theme|toml_unpinned|ENV_STATE' "$WTS" | head -3)"; fi

# ------------------------------------------------------------- scratch-hygiene.cjs CLI --
HR="$TMP/hyg"
hyg_repo() { # <dir> — a git repo with a base-tmp holding one old and one fresh file
  mkdir -p "$1/.claude/base-tmp/playwright/s1"
  wt_git init -q "$1"
  printf 'fresh' > "$1/.claude/base-tmp/playwright/s1/fresh.png"
  printf 'old' > "$1/.claude/base-tmp/playwright/s1/old.yml"; touch -t 202001010000 "$1/.claude/base-tmp/playwright/s1/old.yml"
  printf 'old' > "$1/.claude/base-tmp/top.log"; touch -t 202001010000 "$1/.claude/base-tmp/top.log"
}
hyg() { rc=0; HOME="$WTR/home" GIT_CONFIG_NOSYSTEM=1 node "$HYG" "$@" >"$O" 2>"$E" || rc=$?; }

# H1: files past the TTL go, fresh ones and the directories stay; the root is stamped into the exclude
hyg_repo "$HR/a"
hyg --sweep "$HR/a"
if [ "$rc" -eq 0 ] && [ "$(cat "$O")" = "swept=2 kept=1" ] && [ -f "$HR/a/.claude/base-tmp/playwright/s1/fresh.png" ] \
   && [ ! -e "$HR/a/.claude/base-tmp/top.log" ] && [ -d "$HR/a/.claude/base-tmp/playwright/s1" ] \
   && grep -qx '/.claude/base-tmp/' "$HR/a/.git/info/exclude"; then ok
else bad H1-sweep "rc=$rc out=$(show) err=$(head -c 200 "$E")"; fi

# H2: --ttl-hours 0 sweeps nothing; a junk value falls back to 24 h; a large one keeps the old files
hyg_repo "$HR/b"
hyg --sweep "$HR/b" --ttl-hours 0
h2a="$(cat "$O")"
hyg --sweep "$HR/b" --ttl-hours 999999999
h2b="$(cat "$O")"
hyg --sweep "$HR/b" --ttl-hours soon
h2c="$(cat "$O")"
if [ "$h2a" = "swept=0 kept=3" ] && [ "$h2b" = "swept=0 kept=3" ] && [ "$h2c" = "swept=2 kept=1" ]; then ok
else bad H2-ttl "0='$h2a' big='$h2b' junk='$h2c'"; fi

# H3: no base-tmp → nothing created, nothing stamped
mkdir -p "$HR/c"; wt_git init -q "$HR/c"
hyg --sweep "$HR/c"
if [ "$rc" -eq 0 ] && [ "$(cat "$O")" = "swept=0 kept=0" ] && [ ! -e "$HR/c/.claude" ] \
   && ! grep -qs 'base-tmp' "$HR/c/.git/info/exclude"; then ok
else bad H3-absent "rc=$rc out=$(show)"; fi

# H4: a symlinked component is never followed: the files it points at survive
mkdir -p "$HR/d/.claude" "$HR/elsewhere"; printf 'x' > "$HR/elsewhere/keep"; touch -t 202001010000 "$HR/elsewhere/keep"
ln -s "$HR/elsewhere" "$HR/d/.claude/base-tmp"
hyg --sweep "$HR/d"
if [ "$rc" -eq 0 ] && [ "$(cat "$O")" = "swept=0 kept=0" ] && [ -f "$HR/elsewhere/keep" ]; then ok
else bad H4-symlink-root "rc=$rc out=$(show)"; fi

# H5: a symlink inside base-tmp is neither deleted nor followed
mkdir -p "$HR/e/.claude/base-tmp"; printf 'x' > "$HR/elsewhere/target"; touch -t 202001010000 "$HR/elsewhere/target"
ln -s "$HR/elsewhere/target" "$HR/e/.claude/base-tmp/link"
hyg --sweep "$HR/e"
if [ "$rc" -eq 0 ] && [ -L "$HR/e/.claude/base-tmp/link" ] && [ -f "$HR/elsewhere/target" ]; then ok
else bad H5-symlink-inside "rc=$rc out=$(show)"; fi

# H6: a project in a subdirectory of the repo is anchored with its prefix; a non-repo sweeps quietly
mkdir -p "$HR/f/sub"; wt_git init -q "$HR/f"
mkdir -p "$HR/f/sub/.claude/base-tmp"; printf 'x' > "$HR/f/sub/.claude/base-tmp/a"
hyg --sweep "$HR/f/sub"
h6="$rc"
mkdir -p "$HR/g/.claude/base-tmp"; printf 'x' > "$HR/g/.claude/base-tmp/a"; touch -t 202001010000 "$HR/g/.claude/base-tmp/a"
rc=0; (cd "$HR" && GIT_CEILING_DIRECTORIES="$HR" node "$HYG" --sweep "$HR/g") >"$O" 2>"$E" || rc=$?
if [ "$h6" -eq 0 ] && grep -qx '/sub/.claude/base-tmp/' "$HR/f/.git/info/exclude" \
   && [ "$rc" -eq 0 ] && [ "$(cat "$O")" = "swept=1 kept=0" ] && [ ! -s "$E" ]; then ok
else bad H6-prefix-and-no-git "h6=$h6 rc=$rc out=$(show) exclude=$(tr '\n' ';' < "$HR/f/.git/info/exclude" 2>&1)"; fi

# H7: usage — no args and an unknown arg exit 2 on stderr, --help exits 0 on stdout
hyg; h7a="$rc"
hyg --sweep "$HR/a" --bogus; h7b="$rc"; h7err="$(cat "$E")"
hyg --help; h7c="$rc"
if [ "$h7a" -eq 2 ] && [ "$h7b" -eq 2 ] && printf '%s' "$h7err" | grep -q 'unknown argument --bogus' \
   && [ "$h7c" -eq 0 ] && grep -q '^usage: scratch-hygiene.cjs --sweep' "$O"; then ok
else bad H7-usage "rc=$h7a/$h7b/$h7c err=$h7err"; fi

# The suite never touched the real checkout.
if [ "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)" = "$HEAD_BEFORE" ] \
   && ! git -C "$ROOT" worktree list --porcelain | grep -qE 'ABC-123|CPY-'; then ok
else bad head-untouched "the real checkout moved"; fi

echo "base-scripts-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
