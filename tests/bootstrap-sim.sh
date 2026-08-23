#!/usr/bin/env bash
# Simulation harness for scripts/bootstrap.sh (one-command install).
# Hermetic: every case runs a COPY of bootstrap whose REPO_URL points at a local bare origin,
# against a throwaway $HOME, with a stub scripts/install.sh that records its argv and a `git`
# shim that records every invocation — no network, no writes outside $TMP, and the piped case
# runs under a kill-on-timeout guard so a prompt that hangs fails the suite instead of it.
# Exit 0 = all green.
set -u

# A developer's real config dir would re-target the opencode leftovers; the git identity vars
# would leak into the fixture commits. Both are set explicitly where a case needs them.
unset XDG_CONFIG_HOME GIT_DIR GIT_WORK_TREE GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL \
      GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP="$ROOT/scripts/bootstrap.sh"
BASH_BIN="$(command -v bash)"
REAL_GIT="$(command -v git || true)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

O="$TMP/out"; E="$TMP/err"; RC=0; TIMED_OUT=no
STUB_LOG="$TMP/install-argv"
GIT_LOG="$TMP/git-argv"

SHIM="$TMP/shim"
mkdir -p "$SHIM"
cat > "$SHIM/git" <<SHIMEOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "\${STUB_GIT_LOG:-/dev/null}"
exec "$REAL_GIT" "\$@"
SHIMEOF
chmod +x "$SHIM/git"

gitq() {
  "$REAL_GIT" -c user.name=fnd -c user.email=fnd@example.com -c commit.gpgsign=false \
      -c init.defaultBranch=main -c advice.detachedHead=false "$@"
}

# mkboot <dest> <repo-url> — a copy of bootstrap with the clone source retargeted at a local
# bare origin. The single unconditional REPO_URL assignment is what makes this rewrite safe;
# case R1 below is the guard that it stays single and unconditional.
mkboot() {
  sed "s|^REPO_URL=.*|REPO_URL=\"$2\"|" "$BOOTSTRAP" > "$1"
  chmod +x "$1"
}

# mkcheckout <dir> — a minimal claude-plugins checkout: bootstrap, the install.sh stub, and
# enough plugin content that the in-checkout detection fires
mkcheckout() {
  local d="$1"
  mkdir -p "$d/scripts" "$d/plugins/fnd/skills/alpha" "$d/docs"
  mkboot "$d/scripts/bootstrap.sh" "$TMP/origin.git"
  cat > "$d/scripts/install.sh" <<'STUB'
#!/usr/bin/env bash
# stub installer: records argv, reports the checkout it lives in, exits with a scripted rc
printf '%s\n' "$*" >> "${STUB_LOG:-/dev/null}"
D="$(cd "$(dirname "$0")/.." && pwd)"
t=""; prev=""
for a in "$@"; do
  [ "$prev" = "--target" ] && t="$a"
  prev="$a"
done
rc=0
[ -f "$D/.stub-rc-$t" ] && rc="$(cat "$D/.stub-rc-$t")"
echo "stub install.sh ran for '$t' from $D"
exit "$rc"
STUB
  chmod +x "$d/scripts/install.sh"
  echo "alpha" > "$d/plugins/fnd/skills/alpha/SKILL.md"
  echo "opencode doc" > "$d/docs/README.opencode.md"
}

# run <home> <script> [args...] — bootstrap under a throwaway HOME with both recorders armed,
# from a scratch cwd so that anything written to a relative path lands where a case can see it
# instead of in the suite's own directory
run() {
  local home="$1" script="$2"; shift 2
  mkdir -p "$home/cwd"
  : > "$STUB_LOG"; : > "$GIT_LOG"
  RC=0
  ( cd "$home/cwd" && HOME="$home" PATH="$SHIM:$PATH" STUB_LOG="$STUB_LOG" \
      STUB_GIT_LOG="$GIT_LOG" exec "$BASH_BIN" "$script" "$@" ) >"$O" 2>"$E" || RC=$?
}

# runpiped <home> <script> [args...] — the curl|bash shape: the script arrives on stdin, so a
# prompt could only come from /dev/tty. Killed after ~10s: a bootstrap that waits for input
# here must fail the suite, not stall it.
runpiped() {
  local home="$1" script="$2"; shift 2
  mkdir -p "$home"
  : > "$STUB_LOG"; : > "$GIT_LOG"
  RC=0; TIMED_OUT=no
  local pid waited=0
  HOME="$home" PATH="$SHIM:$PATH" STUB_LOG="$STUB_LOG" STUB_GIT_LOG="$GIT_LOG" \
    "$BASH_BIN" -s -- "$@" <"$script" >"$O" 2>"$E" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge 50 ]; then kill -9 "$pid" 2>/dev/null; TIMED_OUT=yes; break; fi
    sleep 0.2
    waited=$((waited + 1))
  done
  wait "$pid" || RC=$?
}

# --------------------------------------------------------------------------- the pty half --
# Everything above runs with stdout on a file, which is exactly the shape where bootstrap must
# NOT prompt. The prompts themselves therefore need a terminal, and the only portable way to
# manufacture one is script(1) — two incompatible spellings of it, so probe for the one this
# machine has. In pty mode the child's stderr comes back on the same stream as its stdout, so
# those cases assert against "$O" alone.
PTY_MODE=""
PTY_SKIPPED="no"
if command -v script >/dev/null 2>&1; then
  if script -q /dev/null /bin/echo probe </dev/null 2>/dev/null | grep -q probe; then
    PTY_MODE=bsd
  elif script -qe -c "/bin/echo probe" /dev/null </dev/null 2>/dev/null | grep -q probe; then
    PTY_MODE=util
  fi
fi

# runpty <home> <keystrokes|""> <script> [args...] — bootstrap on a real terminal. The feeder's
# trailing sleep keeps the pty master open long enough for the script to read what was typed;
# an empty feeder is stdin closed at once, i.e. the Ctrl-D shape. Same kill-on-timeout guard as
# runpiped: a prompt nobody answers must fail the suite, not stall it. Runs in a scratch cwd so
# a case can assert on what a mis-expanded path would have created there.
runpty() {
  local home="$1" feed="$2" script="$3"; shift 3
  mkdir -p "$home/cwd"
  : > "$STUB_LOG"; : > "$GIT_LOG"
  RC=0; TIMED_OUT=no
  local inner pid waited=0
  inner="$(printf '%q ' "$BASH_BIN" "$script" "$@")"
  (
    export HOME="$home" PATH="$SHIM:$PATH" STUB_LOG="$STUB_LOG" STUB_GIT_LOG="$GIT_LOG"
    cd "$home/cwd" || exit 99
    if [ -n "$feed" ]; then
      ( printf '%s' "$feed"; sleep 2 ) | pty_exec "$inner"
    else
      pty_exec "$inner" </dev/null
    fi
  ) >"$O" 2>"$E" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge 60 ]; then kill -9 "$pid" 2>/dev/null; TIMED_OUT=yes; break; fi
    sleep 0.2
    waited=$((waited + 1))
  done
  wait "$pid" || RC=$?
  # a pty turns every newline into CRLF; strip the CRs so the assertions stay ordinary greps
  tr -d '\r' < "$O" > "$O.clean" && mv "$O.clean" "$O"
}

pty_exec() {
  case "$PTY_MODE" in
    bsd) script -q /dev/null "$BASH_BIN" -c "$1" ;;
    util) script -qe -c "$1" /dev/null ;;
    *) return 99 ;;
  esac
}

argv_line() { sed -n "$1p" "$STUB_LOG" 2>/dev/null; }
argv_count() { awk 'END { print NR }' "$STUB_LOG" 2>/dev/null; }

# The clone source for every copy of bootstrap in this file, built before the first case: a case
# that clones unexpectedly must fail on the assertion, not on a bare origin that is not there yet.
ORIGIN="$TMP/origin.git"; WORK="$TMP/work"
if [ -n "$REAL_GIT" ]; then
  gitq init -q --bare "$ORIGIN" >/dev/null 2>&1
fi

# -------------------------------------------------------------------- R. the clone source --
# R1: the repo URL is one unconditional assignment — the only line a piped run cannot correct
# and the only line this harness rewrites. Two of them (a fallback, an example) and half the
# suite would be testing a URL the real script never uses.
URLS="$(grep -c '^REPO_URL=' "$BOOTSTRAP")"
if [ "$URLS" -eq 1 ]; then ok
else bad R1-single-repo-url "$URLS '^REPO_URL=' assignments in scripts/bootstrap.sh, want 1"; fi

# R2: and it names this repo's own slug — a placeholder here clones something that is not fnd
SLUG="domaine-oleksandr-kever/claude-plugins"
if grep -qF "REPO_URL=\"https://github.com/$SLUG.git\"" "$BOOTSTRAP"; then ok
else bad R2-repo-url-slug "bootstrap's REPO_URL does not name https://github.com/$SLUG.git"; fi

# ------------------------------------------------------------------------- argument gates --
BOOT="$TMP/loose/bootstrap.sh"          # outside any checkout: the piped/clone shape
mkdir -p "$TMP/loose"
mkboot "$BOOT" "$TMP/origin.git"

run "$TMP/h-args" "$BOOT" --help
if [ "$RC" -eq 0 ] && grep -q "usage: bootstrap.sh" "$O" && grep -q -- '--uninstall' "$O"; then ok
else bad A1-help "rc=$RC out=$(head -c 160 "$O")"; fi

run "$TMP/h-args" "$BOOT" --wat
if [ "$RC" -eq 2 ] && grep -q "unknown argument" "$E"; then ok
else bad A2-unknown-flag "rc=$RC err=$(head -c 160 "$E")"; fi

run "$TMP/h-args" "$BOOT" --targets
if [ "$RC" -eq 2 ] && grep -q "needs a value" "$E"; then ok
else bad A3-targets-needs-value "rc=$RC err=$(head -c 160 "$E")"; fi

run "$TMP/h-args" "$BOOT" --dir
if [ "$RC" -eq 2 ] && grep -q -- "--dir needs a value" "$E"; then ok
else bad A4-dir-needs-value "rc=$RC err=$(head -c 160 "$E")"; fi

# A following flag is not a --dir value: `--dir --yes` (a dropped path) must refuse up front,
# not swallow --yes as the destination and die later in dirname/mkdir with no bootstrap error.
run "$TMP/h-args" "$BOOT" --targets cursor --dir --yes
if [ "$RC" -eq 2 ] && grep -q -- "--dir needs a value" "$E" && [ "$(argv_count)" -eq 0 ] \
   && ! grep -q '^clone' "$GIT_LOG"; then ok
else bad A10-dir-flag-as-value "rc=$RC err=$(head -c 160 "$E")"; fi

# The HOME-free paths must stay HOME-free under `set -u`: a claude-only run touches no
# filesystem, so an unset HOME (cron, containers) is no reason to die at line 1.
: > "$STUB_LOG"; : > "$GIT_LOG"; RC=0
( cd "$TMP" && env -u HOME PATH="$SHIM:$PATH" STUB_LOG="$STUB_LOG" STUB_GIT_LOG="$GIT_LOG" \
    "$BASH_BIN" "$BOOT" --targets claude ) >"$O" 2>"$E" || RC=$?
if [ "$RC" -eq 0 ] && grep -qF '/plugin install fnd@domaine' "$O"; then ok
else bad H1-no-home-claude-only "rc=$RC err=$(head -c 200 "$E")"; fi

# …while a target that needs the default destination has nowhere to put it: a named refusal,
# not bash's unbound-variable crash and not a clone into "/tools".
: > "$STUB_LOG"; : > "$GIT_LOG"; RC=0
( cd "$TMP" && env -u HOME PATH="$SHIM:$PATH" STUB_LOG="$STUB_LOG" STUB_GIT_LOG="$GIT_LOG" \
    "$BASH_BIN" "$BOOT" --targets cursor --yes ) >"$O" 2>"$E" || RC=$?
if [ "$RC" -eq 2 ] && grep -q "HOME is unset" "$E" && ! grep -q '^clone' "$GIT_LOG"; then ok
else bad H2-no-home-needs-dir "rc=$RC err=$(head -c 200 "$E")"; fi

run "$TMP/h-args" "$BOOT" --targets vscode --yes
if [ "$RC" -eq 2 ] && grep -q "unknown target 'vscode'" "$E"; then ok
else bad A5-unknown-target "rc=$RC err=$(head -c 160 "$E")"; fi
if [ ! -e "$TMP/h-args/tools" ]; then ok
else bad A6-unknown-target-no-clone "a refused run created the default clone dir"; fi

# An explicitly empty --targets is a typo — an unset variable in someone's wrapper — and the one
# thing it cannot mean is "every host", --yes or not.
run "$TMP/h-args" "$BOOT" --targets "" --yes
if [ "$RC" -eq 2 ] && grep -q "no targets selected" "$E" && [ ! -e "$TMP/h-args/tools" ]; then ok
else bad A7-empty-targets "rc=$RC err=$(head -c 160 "$E")"; fi

# …the same refusal a csv of nothing but separators already got, which is the behaviour A7 pins to
run "$TMP/h-args" "$BOOT" --targets ,, --yes
if [ "$RC" -eq 2 ] && grep -q "no targets selected" "$E"; then ok
else bad A8-separators-only-targets "rc=$RC err=$(head -c 160 "$E")"; fi

# A target is a word, not a pattern. The csv is split by leaving an expansion unquoted, so with
# globbing on `--targets '*'` becomes the filenames of whatever directory the one-liner ran in —
# and a file named `cursor` sitting there would select a host nobody typed.
mkdir -p "$TMP/h-glob/cwd"; : > "$TMP/h-glob/cwd/cursor"; : > "$TMP/h-glob/cwd/codex"
run "$TMP/h-glob" "$BOOT" --targets '*' --yes
if [ "$RC" -eq 2 ] && grep -qF "unknown target '*'" "$E" && [ "$(argv_count)" -eq 0 ]; then ok
else bad A9-targets-not-globbed "rc=$RC err=$(head -c 160 "$E")"; fi

# ------------------------------------------------------------------- piped, no tty, no ask --
# The delivery shape (`curl … | bash`): stdin is the script itself, so a prompt can only come
# from /dev/tty — and with no terminal there is nothing to ask on. The contract is a fast
# usage error; the kill-on-timeout guard is what proves "fast" rather than assuming it.
runpiped "$TMP/h-piped" "$BOOT"
if [ "$TIMED_OUT" = "no" ] && [ "$RC" -eq 2 ] && grep -q "no terminal to ask on" "$E" \
   && grep -q "usage: bootstrap.sh" "$E"; then ok
else bad B1-piped-no-tty "timed_out=$TIMED_OUT rc=$RC err=$(head -c 200 "$E")"; fi

if [ ! -e "$TMP/h-piped/tools" ] && ! grep -q '^clone' "$GIT_LOG"; then ok
else bad B2-piped-no-side-effects "the refused piped run cloned or wrote something"; fi

# …and the same piped shape WITH targets does the install, so B1 is proving the picker gate and
# not merely that a piped bootstrap always fails.
runpiped "$TMP/h-piped2" "$BOOT" --targets claude
if [ "$TIMED_OUT" = "no" ] && [ "$RC" -eq 0 ] && grep -q '/plugin install fnd@domaine' "$O"; then ok
else bad B3-piped-with-targets "timed_out=$TIMED_OUT rc=$RC out=$(head -c 200 "$O")"; fi

# …and it stayed a print: the claude target is four lines of text, so a claude-only run has
# nothing to install and therefore nothing to clone. Dropping that exemption would hand a
# developer who only wanted the slash commands a full checkout in $HOME they never asked for.
if [ ! -e "$TMP/h-piped2/tools" ] && ! grep -q '^clone' "$GIT_LOG" \
   && ! grep -q "^checkout " "$O"; then ok
else bad B4-claude-only-no-checkout "a claude-only run cloned or reported a checkout: git=$(tr '\n' ';' < "$GIT_LOG")"; fi

# ---------------------------------------------------------------------- in-checkout mode ---
# A direct run from inside a checkout installs THAT checkout: no clone, and --dir is a
# contradiction the script must name rather than silently honour or silently drop.
FIX="$TMP/checkout"; mkcheckout "$FIX"
FIXBOOT="$FIX/scripts/bootstrap.sh"

run "$TMP/h1" "$FIXBOOT" --targets cursor
if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 1 ] && [ "$(argv_line 1)" = "--target cursor" ]; then ok
else bad C1-single-target "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

if grep -q "from $FIX" "$O" && ! grep -q '^clone' "$GIT_LOG"; then ok
else bad C2-no-clone-in-checkout "out=$(tr '\n' ';' < "$O") git=$(tr '\n' ';' < "$GIT_LOG")"; fi

run "$TMP/h2" "$FIXBOOT" --targets cursor,opencode
if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 2 ] \
   && [ "$(argv_line 1)" = "--target cursor" ] && [ "$(argv_line 2)" = "--target opencode" ]; then ok
else bad C3-csv-order "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

# `all` has a documented expansion, and the order is part of it: the picker lists the hosts in
# this order and the report follows the install order, so a shuffled expansion reads as a
# different run every time. claude is last because it installs nothing — it prints.
run "$TMP/h3" "$FIXBOOT" --targets all
if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 3 ] \
   && [ "$(argv_line 1)" = "--target cursor" ] && [ "$(argv_line 2)" = "--target codex" ] \
   && [ "$(argv_line 3)" = "--target opencode" ] \
   && grep -q '/plugin install fnd@domaine' "$O"; then ok
else bad C4-all-expands "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

# a repeated host is one install, not two
run "$TMP/h4" "$FIXBOOT" --targets cursor,cursor,all
if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 3 ]; then ok
else bad C5-dedupe "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

# --target is the install.sh spelling; people type it here too
run "$TMP/h5" "$FIXBOOT" --target opencode
if [ "$RC" -eq 0 ] && [ "$(argv_line 1)" = "--target opencode" ]; then ok
else bad C6-target-alias "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

run "$TMP/h5b" "$FIXBOOT" --targets=codex
if [ "$RC" -eq 0 ] && [ "$(argv_line 1)" = "--target codex" ]; then ok
else bad C7-equals-form "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

run "$TMP/h6" "$FIXBOOT" --targets cursor --dir "$TMP/elsewhere"
if [ "$RC" -eq 0 ] && grep -q -- "--dir ignored" "$O" && grep -q "from $FIX" "$O" \
   && [ ! -e "$TMP/elsewhere" ]; then ok
else bad C8-dir-ignored-in-checkout "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# --copy is bootstrap's only pass-through flag and must reach the installer verbatim
run "$TMP/h7" "$FIXBOOT" --targets cursor --copy
if [ "$RC" -eq 0 ] && [ "$(argv_line 1)" = "--target cursor --copy" ]; then ok
else bad C9-copy-passthrough "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

# In-checkout detection must hold when scripts/ is itself a symlink (shared-tooling layouts):
# the -d probe and the recorded path resolve through the same logical cd, so bootstrap installs
# the tree the developer ran from instead of cloning a second copy.
SYMCO="$TMP/co-sym"; mkcheckout "$SYMCO"
mv "$SYMCO/scripts" "$TMP/shared-scripts"
ln -s "$TMP/shared-scripts" "$SYMCO/scripts"
run "$TMP/h7b" "$SYMCO/scripts/bootstrap.sh" --targets cursor
if [ "$RC" -eq 0 ] && [ "$(argv_line 1)" = "--target cursor" ] && grep -q "from $SYMCO" "$O" \
   && ! grep -q '^clone' "$GIT_LOG" && [ ! -e "$TMP/h7b/tools" ]; then ok
else bad C10-symlinked-scripts-dir "rc=$RC out=$(tr '\n' ';' < "$O") git=$(tr '\n' ';' < "$GIT_LOG")"; fi

# ------------------------------------------------------------------------- the claude target --
# Claude Code installs from inside a live session and cannot be driven from outside, so this
# target prints and says so. The four commands are the README block, verbatim.
run "$TMP/h8" "$FIXBOOT" --targets claude
if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 0 ]; then ok
else bad L1-claude-no-installer "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

if grep -qF "/plugin marketplace add domaine-oleksandr-kever/claude-plugins" "$O" \
   && grep -qF "/plugin install fnd@domaine" "$O" \
   && grep -qF "/reload-plugins" "$O" && grep -qF "/fnd:smoke-test" "$O"; then ok
else bad L2-claude-block "out=$(tr '\n' ';' < "$O")"; fi

if grep -q "cannot be driven from outside" "$O"; then ok
else bad L3-claude-informational "the claude target does not say it is informational"; fi

# ------------------------------------------------------------------------ rc propagation ---
# One failing host does not cancel the others — they are independent installs — but its rc
# becomes bootstrap's own and the report has to name it.
FIX2="$TMP/checkout-fail"; mkcheckout "$FIX2"
echo 3 > "$FIX2/.stub-rc-opencode"
run "$TMP/h9" "$FIX2/scripts/bootstrap.sh" --targets cursor,opencode,codex
if [ "$RC" -eq 3 ] && [ "$(argv_count)" -eq 3 ]; then ok
else bad F1-rc-propagated "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

if grep -q "^opencode FAILED (install.sh exit 3)$" "$O" && grep -q "^cursor OK$" "$O" \
   && grep -q "^codex OK$" "$O"; then ok
else bad F2-report-names-failure "out=$(tr '\n' ';' < "$O")"; fi

# A checkout can arrive without scripts/install.sh — a tarball copied without the executable bit
# story, a vendored subtree pruned too hard. That is one target's failure, handled like any
# other: the run continues, the report still prints, and the rc says something went wrong.
FIX3="$TMP/checkout-no-installer"; mkcheckout "$FIX3"; rm -f "$FIX3/scripts/install.sh"
run "$TMP/h9b" "$FIX3/scripts/bootstrap.sh" --targets cursor,claude,codex
if [ "$RC" -eq 2 ] && grep -q "install.sh not found" "$E" \
   && grep -q "^cursor FAILED (no install.sh at $FIX3/scripts/install.sh)$" "$O" \
   && grep -q "^codex FAILED (no install.sh at $FIX3/scripts/install.sh)$" "$O"; then ok
else bad F3-missing-installer-per-target "rc=$RC out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E")"; fi

# …and the two things an early exit would have taken with it: the hosts after the failed one, and
# the report itself — which is where a developer learns what to fix by hand
if grep -qF "/plugin install fnd@domaine" "$O" && grep -q "^== summary ==$" "$O" \
   && grep -q "left to do by hand" "$O" && grep -q "MARKETPLACE-installed fnd copy first" "$O"; then ok
else bad F4-missing-installer-report "out=$(tr '\n' ';' < "$O")"; fi

# ---------------------------------------------------------------------------- the report ---
run "$TMP/h10" "$FIXBOOT" --targets all
if grep -q "left to do by hand" "$O" \
   && grep -q "MARKETPLACE-installed fnd copy first" "$O" \
   && grep -q "Reload Window" "$O"; then ok
else bad P1-report-cursor-leftovers "out=$(tr '\n' ';' < "$O")"; fi

if grep -q "docs/README.opencode.md" "$O" && grep -q "three pastes" "$O"; then ok
else bad P2-report-opencode-pastes "out=$(tr '\n' ';' < "$O")"; fi

if grep -qF "codex plugin marketplace add domaine-oleksandr-kever/claude-plugins" "$O" \
   && grep -q "dev-channel subagents" "$O"; then ok
else bad P3-report-codex-channel "out=$(tr '\n' ';' < "$O")"; fi

if grep -q "run /smoke-test once in a live session" "$O"; then ok
else bad P4-report-smoke-test "out=$(tr '\n' ';' < "$O")"; fi

# claude is the one selected host with no install to succeed or fail at, so both of its report
# lines have to say so: an "OK" row would claim work that never happened, and a leftovers section
# that skips it drops the only instruction that target ever produces.
if grep -q "^claude PRINTED (run the slash commands in a session)$" "$O" \
   && grep -q "Claude Code: run the four slash commands printed above in a live session" "$O"; then ok
else bad P5-report-claude-rows "out=$(tr '\n' ';' < "$O")"; fi

# a host that was not selected contributes no leftovers
run "$TMP/h11" "$FIXBOOT" --targets codex
if [ "$RC" -eq 0 ] && ! grep -q "docs/README.opencode.md" "$O" && ! grep -q "Reload Window" "$O"; then ok
else bad P6-report-only-selected "out=$(tr '\n' ';' < "$O")"; fi

# ------------------------------------------------------------------------------ the clone ---
if [ -n "$REAL_GIT" ]; then
  mkcheckout "$WORK"
  ( cd "$WORK" && gitq init -q . && gitq add -A && gitq commit -qm init \
      && gitq remote add origin "$ORIGIN" && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1

  # fresh machine: the destination does not exist yet, so bootstrap clones and then delegates
  DEST="$TMP/dest/claude-plugins"
  run "$TMP/h12" "$BOOT" --targets cursor --dir "$DEST"
  if [ "$RC" -eq 0 ] && [ -f "$DEST/plugins/fnd/skills/alpha/SKILL.md" ] \
     && grep -q "^clone $ORIGIN $DEST$" "$GIT_LOG" \
     && [ "$(argv_line 1)" = "--target cursor" ] && grep -q "from $DEST" "$O"; then ok
  else bad G1-fresh-clone "rc=$RC git=$(tr '\n' ';' < "$GIT_LOG") out=$(tr '\n' ';' < "$O")"; fi

  # the default destination when --dir is absent
  run "$TMP/h13" "$BOOT" --targets cursor --yes
  if [ "$RC" -eq 0 ] && [ -f "$TMP/h13/tools/claude-plugins/plugins/fnd/skills/alpha/SKILL.md" ]; then ok
  else bad G2-default-dir "rc=$RC out=$(tr '\n' ';' < "$O") err=$(head -c 160 "$E")"; fi

  # re-run against the checkout it just made: reuse, and NO second pull — install.sh owns the
  # ff-only update, and a pull here would race it. A commit pushed after the clone is the
  # tell: bootstrap must not have brought it down.
  echo "shipped" > "$WORK/plugins/fnd/skills/alpha/NEW.md"
  ( cd "$WORK" && gitq add -A && gitq commit -qm feat && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1
  run "$TMP/h12" "$BOOT" --targets cursor --dir "$DEST"
  if [ "$RC" -eq 0 ] && grep -q "using the checkout already at $DEST" "$O" \
     && [ ! -f "$DEST/plugins/fnd/skills/alpha/NEW.md" ] \
     && ! grep -qE '^(clone|pull|fetch)' "$GIT_LOG"; then ok
  else bad G3-reuse-no-pull "rc=$RC git=$(tr '\n' ';' < "$GIT_LOG") out=$(tr '\n' ';' < "$O")"; fi

  if [ "$(argv_line 1)" = "--target cursor" ]; then ok
  else bad G4-reuse-still-installs "argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

  # something else already lives at that path: bootstrap refuses, and touches nothing
  FOREIGN="$TMP/foreign"; mkdir -p "$FOREIGN/src"; echo "someone's work" > "$FOREIGN/src/main.rs"
  run "$TMP/h14" "$BOOT" --targets cursor --dir "$FOREIGN"
  if [ "$RC" -eq 2 ] && grep -q "refusing to use $FOREIGN" "$E" \
     && [ "$(cat "$FOREIGN/src/main.rs")" = "someone's work" ] \
     && [ ! -e "$FOREIGN/plugins" ] && [ "$(argv_count)" -eq 0 ]; then ok
  else bad G5-foreign-dir-refusal "rc=$RC err=$(head -c 200 "$E")"; fi

  # …including a directory that IS a checkout of something else (git, but not this repo)
  NOTOURS="$TMP/notours"; mkdir -p "$NOTOURS"
  ( cd "$NOTOURS" && gitq init -q . ) >/dev/null 2>&1
  run "$TMP/h15" "$BOOT" --targets cursor --dir "$NOTOURS"
  if [ "$RC" -eq 2 ] && grep -q "not a claude-plugins checkout" "$E" \
     && ! grep -q '^clone' "$GIT_LOG"; then ok
  else bad G6-git-but-foreign "rc=$RC err=$(head -c 200 "$E")"; fi

  # --yes on its own is the whole non-interactive contract that usage promises: the default
  # destination AND every host.
  run "$TMP/h15b" "$BOOT" --yes
  if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 3 ] \
     && grep -q '^--target cursor$' "$STUB_LOG" && grep -q '^--target codex$' "$STUB_LOG" \
     && grep -q '^--target opencode$' "$STUB_LOG" \
     && grep -qF '/plugin install fnd@domaine' "$O" \
     && [ -f "$TMP/h15b/tools/claude-plugins/plugins/fnd/skills/alpha/SKILL.md" ]; then ok
  else bad G7-yes-defaults-to-all "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG") err=$(head -c 160 "$E")"; fi

  # A quoted --dir keeps its tilde: the calling shell expanded nothing, so bootstrap must, or
  # the clone lands in a directory literally named `~`.
  run "$TMP/h15c" "$BOOT" --targets cursor --dir '~/picked-by-flag'
  if [ "$RC" -eq 0 ] && [ -f "$TMP/h15c/picked-by-flag/plugins/fnd/skills/alpha/SKILL.md" ] \
     && [ ! -e "$TMP/h15c/cwd/~" ] && grep -q "^checkout $TMP/h15c/picked-by-flag$" "$O"; then ok
  else bad G8-tilde-flag-expanded "rc=$RC out=$(tr '\n' ';' < "$O") err=$(head -c 160 "$E")"; fi

  # `~someone` has no expansion bash 3.2 can do without eval, and taking it literally is the bug
  # this guard exists to prevent — so it is refused, loudly, before anything is written.
  run "$TMP/h15d" "$BOOT" --targets cursor --dir '~nobody/plugins'
  if [ "$RC" -eq 2 ] && grep -q "cannot expand" "$E" && [ "$(argv_count)" -eq 0 ] \
     && ! grep -q '^clone' "$GIT_LOG"; then ok
  else bad G9-tilde-user-refused "rc=$RC err=$(head -c 200 "$E")"; fi

  # --dir=<path>: the equals spelling of the one flag whose value decides where the clone lands.
  # Asserted here rather than in-checkout, where --dir is ignored and a parse bug would not show.
  run "$TMP/h15e" "$BOOT" --targets cursor --dir="$TMP/dest-eq"
  if [ "$RC" -eq 0 ] && [ -f "$TMP/dest-eq/plugins/fnd/skills/alpha/SKILL.md" ] \
     && grep -q "^clone $ORIGIN $TMP/dest-eq$" "$GIT_LOG" \
     && grep -q "^checkout $TMP/dest-eq$" "$O"; then ok
  else bad G10-dir-equals-form "rc=$RC git=$(tr '\n' ';' < "$GIT_LOG") err=$(head -c 160 "$E")"; fi

  # -y is the short --yes, and usage offers it; on its own it carries the whole non-interactive
  # contract, so a dropped alias is a run that stops to ask in a place with nothing to ask on.
  run "$TMP/h15f" "$BOOT" -y
  if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 3 ] \
     && [ -f "$TMP/h15f/tools/claude-plugins/plugins/fnd/skills/alpha/SKILL.md" ]; then ok
  else bad G11-short-yes-alias "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG") err=$(head -c 160 "$E")"; fi

  # The clone is the one step with a network at the other end: it fails on a typo'd slug, a
  # private repo, no credentials. Bootstrap must say so and leave the destination alone — a
  # half-written directory is what turns the retry into the foreign-dir refusal (G5).
  mkdir -p "$TMP/badsrc"
  mkboot "$TMP/badsrc/bootstrap.sh" "$TMP/no-such-origin.git"
  run "$TMP/h15g" "$TMP/badsrc/bootstrap.sh" --targets cursor --dir "$TMP/cf/claude-plugins"
  if [ "$RC" -eq 1 ] && grep -q "git clone failed" "$E" \
     && [ ! -e "$TMP/cf/claude-plugins" ] && [ "$(argv_count)" -eq 0 ]; then ok
  else bad G12-clone-failure "rc=$RC err=$(head -c 200 "$E") left=$(ls -A "$TMP/cf" 2>/dev/null | tr '\n' ' ')"; fi
else
  bad G0-git-missing "git not on PATH — clone cases skipped"
fi

# ------------------------------------------------------------------- prompts, on a terminal --
# The interactive half only exists when there is a terminal, so these run bootstrap under a real
# pty. They are the cases that decide what happens to a developer who backs out of the picker,
# and what a typed `~` means.
if [ -n "$PTY_MODE" ] && [ -n "$REAL_GIT" ]; then
  # Ctrl-D at the picker means "stop", not "yes to the default". The default here is target 5 =
  # every host, so reading EOF as Enter would install four hosts — and clone for them — for
  # someone who was trying to get out.
  runpty "$TMP/h21" "" "$BOOT"
  if [ "$TIMED_OUT" = "no" ] && [ "$RC" -eq 2 ] && grep -q "aborted at the prompt" "$O" \
     && [ "$(argv_count)" -eq 0 ] && ! grep -q '^clone' "$GIT_LOG" \
     && [ ! -e "$TMP/h21/tools" ]; then ok
  else bad Y1-eof-aborts-picker "timed_out=$TIMED_OUT rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG") out=$(tr '\n' ';' < "$O")"; fi

  # …while a real answer is honoured, which is what makes Y1 a statement about EOF and not about
  # the picker being broken
  runpty "$TMP/h22" '1
' "$BOOT" --dir "$TMP/dest-pty"
  if [ "$TIMED_OUT" = "no" ] && [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 1 ] \
     && [ "$(argv_line 1)" = "--target cursor" ] \
     && [ -f "$TMP/dest-pty/plugins/fnd/skills/alpha/SKILL.md" ]; then ok
  else bad Y2-picker-answer "timed_out=$TIMED_OUT rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG") out=$(tr '\n' ';' < "$O")"; fi

  # --yes means "never prompt" even when a terminal is sitting right there. With the input closed,
  # a bootstrap that asked anyway would abort at Y1's error instead of installing.
  runpty "$TMP/h23" "" "$BOOT" --yes
  if [ "$TIMED_OUT" = "no" ] && [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 3 ] \
     && ! grep -q "aborted at the prompt" "$O" \
     && ! grep -q "Which hosts" "$O" \
     && [ -f "$TMP/h23/tools/claude-plugins/plugins/fnd/skills/alpha/SKILL.md" ]; then ok
  else bad Y3-yes-never-prompts "timed_out=$TIMED_OUT rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG") out=$(tr '\n' ';' < "$O")"; fi

  # `~/…` is the likeliest thing to type at a prompt whose default is printed as $HOME/tools/…,
  # and nothing expands it on the way in. Taken literally it makes a directory NAMED `~` in
  # whatever cwd the one-liner ran from, and the summary then names a path the developer's next
  # `cd` cannot find.
  runpty "$TMP/h24" '2
~/picked-at-prompt
' "$BOOT"
  if [ "$TIMED_OUT" = "no" ] && [ "$RC" -eq 0 ] \
     && [ -f "$TMP/h24/picked-at-prompt/plugins/fnd/skills/alpha/SKILL.md" ] \
     && [ ! -e "$TMP/h24/cwd/~" ] \
     && grep -q "^checkout $TMP/h24/picked-at-prompt$" "$O"; then ok
  else bad Y4-tilde-at-prompt "timed_out=$TIMED_OUT rc=$RC out=$(tr '\n' ';' < "$O") stray=$(ls -A "$TMP/h24/cwd" 2>/dev/null | tr '\n' ' ')"; fi

  # The picker splits its answer the same unquoted way the --targets parser does, so it needs the
  # same no-globbing guard: a typed `*` in a directory that happens to hold a file named `cursor`
  # must stay an unknown target, not become a host selection.
  mkdir -p "$TMP/h25/cwd"; : > "$TMP/h25/cwd/cursor"; : > "$TMP/h25/cwd/opencode"
  runpty "$TMP/h25" '*
' "$BOOT"
  if [ "$TIMED_OUT" = "no" ] && [ "$RC" -eq 2 ] && grep -qF "unknown target '*'" "$O" \
     && [ "$(argv_count)" -eq 0 ] && ! grep -q '^clone' "$GIT_LOG"; then ok
  else bad Y5-picker-answer-not-globbed "timed_out=$TIMED_OUT rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG") out=$(tr '\n' ';' < "$O")"; fi
elif [ -z "$REAL_GIT" ]; then
  : # already reported as G0
else
  PTY_SKIPPED="yes"
fi

# ------------------------------------------------------------------------------ uninstall ---
# Uninstall delegates the same way and never clones: the checkout has to be there already,
# because only its install.sh knows what it created.
run "$TMP/h16" "$FIXBOOT" --targets cursor,opencode --uninstall
if [ "$RC" -eq 0 ] && [ "$(argv_line 1)" = "--target cursor --uninstall" ] \
   && [ "$(argv_line 2)" = "--target opencode --uninstall" ]; then ok
else bad U1-uninstall-delegates "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

if ! grep -q '^clone' "$GIT_LOG"; then ok
else bad U2-uninstall-no-clone "git=$(tr '\n' ';' < "$GIT_LOG")"; fi

# no checkout to uninstall from: a usage error, never a clone-then-remove
run "$TMP/h17" "$BOOT" --targets cursor --uninstall --dir "$TMP/h17/absent"
if [ "$RC" -eq 2 ] && grep -q -- "--uninstall needs the checkout" "$E" \
   && [ ! -e "$TMP/h17/absent" ] && ! grep -q '^clone' "$GIT_LOG" \
   && [ "$(argv_count)" -eq 0 ]; then ok
else bad U3-uninstall-absent-dir "rc=$RC err=$(head -c 200 "$E") git=$(tr '\n' ';' < "$GIT_LOG")"; fi

# …and with no --dir either, the default destination is just as absent
run "$TMP/h18" "$BOOT" --targets cursor --uninstall
if [ "$RC" -eq 2 ] && ! grep -q '^clone' "$GIT_LOG" && [ ! -e "$TMP/h18/tools" ]; then ok
else bad U4-uninstall-default-dir "rc=$RC err=$(head -c 200 "$E")"; fi

run "$TMP/h19" "$FIXBOOT" --targets claude --uninstall
if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 0 ] \
   && grep -qF "/plugin uninstall fnd@domaine" "$O" \
   && grep -qF "/plugin marketplace remove domaine" "$O"; then ok
else bad U5-uninstall-claude-block "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

if ! grep -qF "/plugin install fnd@domaine" "$O"; then ok
else bad U6-uninstall-not-install-block "the uninstall run printed the INSTALL slash commands"; fi

# The report's two uninstall-only facts: the clone is the user's to delete, and a Cursor
# marketplace copy is out of every script's reach.
run "$TMP/h20" "$FIXBOOT" --targets cursor,claude --uninstall
if grep -q "clone kept at $FIX" "$O"; then ok
else bad U7-report-clone-kept "out=$(tr '\n' ';' < "$O")"; fi

if grep -q "removable only in the editor UI" "$O" && grep -q "Customize -> Plugins" "$O" \
   && grep -q "no script can reach it" "$O"; then ok
else bad U8-report-marketplace-ui-only "out=$(tr '\n' ';' < "$O")"; fi

# the destination is part of the report on every run that used one — a bootstrap whose clone
# landed somewhere the developer cannot name is a checkout they will clone a second time
if grep -q "^checkout $FIX$" "$O"; then ok
else bad U9-report-names-checkout "out=$(tr '\n' ';' < "$O")"; fi

if grep -q "^cursor OK$" "$O" && ! grep -q "run /smoke-test once in a live session" "$O"; then ok
else bad U10-uninstall-report-shape "out=$(tr '\n' ';' < "$O")"; fi

if [ "$PTY_SKIPPED" = "yes" ]; then
  echo "bootstrap-sim: NOTE — no usable script(1), the 5 terminal-prompt cases (Y1-Y5) did not run" >&2
fi

echo "bootstrap-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
