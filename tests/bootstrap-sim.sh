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

# bootstrap drives the `claude` CLI when one is on PATH, and the developer's real one installs into
# their real ~/.claude — so every case runs on a PATH with no `claude` at all. A directory that
# holds one (Homebrew's bin also holds git and bash) is replaced by a farm of symlinks to
# everything in it except `claude`. Only rows that ask for a CLI get the fake one below.
NOCLAUDE_PATH=""
farm=0
set -f
for d in $(printf '%s' "$PATH" | tr ':' ' '); do
  case ":$NOCLAUDE_PATH:" in *":$d:"*) continue ;; esac
  if [ -e "$d/claude" ]; then
    farm=$((farm + 1))
    mkdir -p "$TMP/pathfarm/$farm"
    set +f
    for e in "$d"/*; do
      [ "${e##*/}" = claude ] || ln -s "$e" "$TMP/pathfarm/$farm/${e##*/}"
    done
    set -f
    d="$TMP/pathfarm/$farm"
  fi
  NOCLAUDE_PATH="${NOCLAUDE_PATH:+$NOCLAUDE_PATH:}$d"
done
set +f
if PATH="$NOCLAUDE_PATH" command -v claude >/dev/null 2>&1; then
  echo "bootstrap-sim: refusing to run — a real claude is still reachable on the test PATH" >&2
  exit 1
fi

# The fake `claude`: records argv, answers the two read-only lists from scripted files, and exits
# with a scripted rc per subcommand and plugin (`.stub-rc-<sub>-<plugin>`, `.stub-rc-marketplace-
# <sub>`). It refuses any option the real 2.1.293 `--help` does not list for that subcommand, so
# bootstrap cannot pass a flag the real CLI would reject. Whatever reaches its stdin is kept: a
# piped bootstrap that let a child read stdin would hand it the rest of its own source.
SHIM_CLAUDE="$TMP/shim-claude"
STUB_CLAUDE_LOG="$TMP/claude-argv"
STUB_CLAUDE_STDIN="$TMP/claude-stdin"
CSTATE="$TMP/claude-state"
mkdir -p "$SHIM_CLAUDE" "$CSTATE"
cat > "$SHIM_CLAUDE/claude" <<'SHIMEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${STUB_CLAUDE_LOG:-/dev/null}"
cat >> "${STUB_CLAUDE_STDIN:-/dev/null}"
S="${STUB_CLAUDE_STATE:?}"
[ "${1:-}" = plugin ] || { echo "fake claude: only 'plugin' is modelled" >&2; exit 64; }
shift
sub="${1:-}"; shift || true
if [ "$sub" = marketplace ]; then sub="marketplace-${1:-}"; shift || true; fi
case "$sub" in
  install) allowed=" -y --yes --json -s --scope --config --accept-command --marketplace --registry " ;;
  update) allowed=" -y --yes --json -s --scope --accept-command " ;;
  uninstall) allowed=" -y --yes --json -s --scope --keep-data --prune " ;;
  enable) allowed=" --json -s --scope " ;;
  list) allowed=" --json --available --data-size " ;;
  marketplace-add) allowed=" --json --scope --sparse --claudeai " ;;
  marketplace-update|marketplace-list) allowed=" --json " ;;
  marketplace-remove) allowed=" --json --scope " ;;
  *) echo "error: unknown command '$sub'" >&2; exit 64 ;;
esac
target=""
while [ $# -gt 0 ]; do
  case "$1" in
    -s|--scope|--config|--accept-command|--marketplace|--registry|--sparse) opt="$1"; shift 2 ;;
    -*) opt="$1"; shift ;;
    *) target="$1"; shift; continue ;;
  esac
  case "$allowed" in *" $opt "*) ;; *) echo "error: unknown option '$opt'" >&2; exit 64 ;; esac
done
case "$sub" in
  marketplace-list) [ -f "$S/mp.json" ] || { echo "error: failed to read marketplaces" >&2; exit 1; }; cat "$S/mp.json"; exit 0 ;;
  list) [ -f "$S/installed.json" ] || { echo "error: failed to read installed plugins" >&2; exit 1; }; cat "$S/installed.json"; exit 0 ;;
esac
key="$sub"
case "$sub" in marketplace-*) ;; *) key="$sub-${target%@*}" ;; esac
rc=0
[ -f "$S/.stub-rc-$key" ] && rc="$(cat "$S/.stub-rc-$key")"
echo "fake claude: $sub $target -> $rc"
exit "$rc"
SHIMEOF
chmod +x "$SHIM_CLAUDE/claude"

# claude_state <mp: present|absent|broken> [installed json] — the machine the fake describes.
# `broken` makes the marketplace list itself fail; an absent installed json makes `plugin list`
# fail. Every rc file from the previous case is dropped.
claude_state() {
  rm -rf "$CSTATE"; mkdir -p "$CSTATE"
  case "$1" in
    present) printf '[\n  {\n    "name": "domaine",\n    "source": "github",\n    "repo": "domaine-oleksandr-kever/claude-plugins"\n  }\n]\n' > "$CSTATE/mp.json" ;;
    absent) printf '[\n  {\n    "name": "claude-plugins-official",\n    "source": "github",\n    "repo": "anthropics/claude-plugins-official"\n  }\n]\n' > "$CSTATE/mp.json" ;;
    broken) ;;
  esac
  printf '%s\n' "${2-[]}" > "$CSTATE/installed.json"
}
# installed_entry <id> <scope> <enabled> — one `claude plugin list --json` object, pretty-printed
# the way 2.1.293 prints it
installed_entry() {
  printf '  {\n    "id": "%s",\n    "version": "0.1.0",\n    "scope": "%s",\n    "enabled": %s,\n    "projectEnabled": false\n  }' "$1" "$2" "$3"
}
claude_calls() { tr '\n' ';' < "$STUB_CLAUDE_LOG" 2>/dev/null; }

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

# mkcheckout <dir> — a minimal claude-plugins checkout: bootstrap, the install.sh stub, the
# marketplace file the in-checkout detection looks for, and enough plugin content to install
mkcheckout() {
  local d="$1"
  mkdir -p "$d/scripts" "$d/plugins/fnd/skills/alpha" "$d/docs" "$d/.claude-plugin"
  printf '{ "name": "domaine", "plugins": [] }\n' > "$d/.claude-plugin/marketplace.json"
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
  # The leftovers report names this renderer only when the checkout carries it, so a fixture
  # without it would prove the opposite of what the OpenCode row asserts.
  mkdir -p "$d/plugins/fnd/scripts"
  printf '#!/usr/bin/env node\n' > "$d/plugins/fnd/scripts/opencode-config.cjs"
}

# run <home> <script> [args...] — bootstrap under a throwaway HOME with both recorders armed,
# from a scratch cwd so that anything written to a relative path lands where a case can see it
# instead of in the suite's own directory. stdin is closed: bootstrap never reads it, and a
# child that did would otherwise wait on the suite's own stdin
# WITH_CLAUDE=yes before a runner puts the fake `claude` on PATH; without it the case exercises
# the no-CLI fallback, which is what CI (no `claude` binary) always sees.
run_path() {
  if [ "${WITH_CLAUDE:-no}" = yes ]; then printf '%s' "$SHIM_CLAUDE:$SHIM:$NOCLAUDE_PATH"
  else printf '%s' "$SHIM:$NOCLAUDE_PATH"; fi
}

run() {
  local home="$1" script="$2" path; shift 2
  mkdir -p "$home/cwd"
  : > "$STUB_LOG"; : > "$GIT_LOG"; : > "$STUB_CLAUDE_LOG"; : > "$STUB_CLAUDE_STDIN"
  path="$(run_path)"
  RC=0
  ( cd "$home/cwd" && HOME="$home" PATH="$path" STUB_LOG="$STUB_LOG" \
      STUB_GIT_LOG="$GIT_LOG" STUB_CLAUDE_LOG="$STUB_CLAUDE_LOG" STUB_CLAUDE_STDIN="$STUB_CLAUDE_STDIN" \
      STUB_CLAUDE_STATE="$CSTATE" exec "$BASH_BIN" "$script" "$@" ) </dev/null >"$O" 2>"$E" || RC=$?
}

# runpiped <home> <script> [args...] — the curl|bash shape: the script arrives on stdin, so a
# prompt could only come from /dev/tty. Killed after ~10s: a bootstrap that waits for input
# here must fail the suite, not stall it.
runpiped() {
  local home="$1" script="$2" path; shift 2
  mkdir -p "$home"
  : > "$STUB_LOG"; : > "$GIT_LOG"; : > "$STUB_CLAUDE_LOG"; : > "$STUB_CLAUDE_STDIN"
  path="$(run_path)"
  RC=0; TIMED_OUT=no
  local pid waited=0
  HOME="$home" PATH="$path" STUB_LOG="$STUB_LOG" STUB_GIT_LOG="$GIT_LOG" \
    STUB_CLAUDE_LOG="$STUB_CLAUDE_LOG" STUB_CLAUDE_STDIN="$STUB_CLAUDE_STDIN" STUB_CLAUDE_STATE="$CSTATE" \
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
    export HOME="$home" PATH="$SHIM:$NOCLAUDE_PATH" STUB_LOG="$STUB_LOG" STUB_GIT_LOG="$GIT_LOG"
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

# the help tells what the claude target runs on an uninstall and on a disabled install
if tr '\n' ' ' < "$O" | tr -s ' ' | grep -qF "For claude it runs 'claude plugin uninstall' (dependents first, the marketplace kept) and needs no checkout" \
   && tr '\n' ' ' < "$O" | tr -s ' ' | grep -qF "and enable when disabled" \
   && tr '\n' ' ' < "$O" | tr -s ' ' | grep -qF "always in the order slim, band, base, fe, qa, be, pm, fnd"; then ok
else bad A1b-help-claude-target "out=$(tr '\n' ';' < "$O")"; fi

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
( cd "$TMP" && env -u HOME PATH="$SHIM:$NOCLAUDE_PATH" STUB_LOG="$STUB_LOG" STUB_GIT_LOG="$GIT_LOG" \
    "$BASH_BIN" "$BOOT" --targets claude ) >"$O" 2>"$E" || RC=$?
if [ "$RC" -eq 0 ] && grep -qF '/plugin install fe@domaine' "$O"; then ok
else bad H1-no-home-claude-only "rc=$RC err=$(head -c 200 "$E")"; fi

# …while a target that needs the default destination has nowhere to put it: a named refusal,
# not bash's unbound-variable crash and not a clone into "/tools".
: > "$STUB_LOG"; : > "$GIT_LOG"; RC=0
( cd "$TMP" && env -u HOME PATH="$SHIM:$NOCLAUDE_PATH" STUB_LOG="$STUB_LOG" STUB_GIT_LOG="$GIT_LOG" \
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
if [ "$TIMED_OUT" = "no" ] && [ "$RC" -eq 0 ] && grep -q '/plugin install fe@domaine' "$O"; then ok
else bad B3-piped-with-targets "timed_out=$TIMED_OUT rc=$RC out=$(head -c 200 "$O")"; fi

# …and it stayed a print: the claude target is a few lines of text, so a claude-only run has
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
   && grep -q '/plugin install fe@domaine' "$O"; then ok
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
# the -f probe and the recorded path resolve through the same logical cd, so bootstrap installs
# the tree the developer ran from instead of cloning a second copy.
SYMCO="$TMP/co-sym"; mkcheckout "$SYMCO"
mv "$SYMCO/scripts" "$TMP/shared-scripts"
ln -s "$TMP/shared-scripts" "$SYMCO/scripts"
run "$TMP/h7b" "$SYMCO/scripts/bootstrap.sh" --targets cursor
if [ "$RC" -eq 0 ] && [ "$(argv_line 1)" = "--target cursor" ] && grep -q "from $SYMCO" "$O" \
   && ! grep -q '^clone' "$GIT_LOG" && [ ! -e "$TMP/h7b/tools" ]; then ok
else bad C10-symlinked-scripts-dir "rc=$RC out=$(tr '\n' ';' < "$O") git=$(tr '\n' ';' < "$GIT_LOG")"; fi

# ------------------------------------------------------------------------- the claude target --
# With no `claude` CLI on PATH (CI, a Desktop-only machine) this target prints and says why. The
# default is the new set (slim, band, base, fe — each dependency before what requires it). The
# README's team-use block names every team plugin, so the whole set's slash commands are that block,
# line for line. The CLI-present half is section Q.
run "$TMP/h8w" "$FIXBOOT" --targets claude --plugins slim,band,base,fe,qa,be,pm
README_CMDS="$(awk '/^### Claude Code — from the published Git marketplace \(team use\)/ { s = 1; next }
  s && /^```/ { if (inb) exit; inb = 1; next }
  inb && /^\// { print }' "$ROOT/README.md")"
BOOT_CMDS="$(sed -n 's/^ *\(\/[a-z][^ ].*\)$/\1/p' "$O" | sed 's/ *$//')"
if [ -n "$README_CMDS" ] && [ "$README_CMDS" = "$BOOT_CMDS" ]; then ok
else bad L2-claude-block-is-readme "readme='$(printf '%s' "$README_CMDS" | tr '\n' ';')' boot='$(printf '%s' "$BOOT_CMDS" | tr '\n' ';')'"; fi

run "$TMP/h8" "$FIXBOOT" --targets claude
if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 0 ]; then ok
else bad L1-claude-no-installer "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG")"; fi

if grep -qF 'claude: the `claude` CLI is not on PATH — run these in a session:' "$O"; then ok
else bad L3-claude-informational "the claude target does not say why it only prints"; fi

# the default set verifies with both doctors after the reload, carries the migration line and never
# names fnd's install or its verify step
INSTALLS="$(grep -oE '/plugin install [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$INSTALLS" = "slim@domaine band@domaine base@domaine fe@domaine " ] \
   && [ "$(grep -A2 '/reload-plugins' "$O" | tail -2 | tr -d ' ' | tr '\n' ' ')" = "/base-doctor /fe-doctor " ] \
   && grep -qF "Moving from fnd: run /plugin uninstall fnd@domaine first" "$O" \
   && ! grep -qF "/plugin install fnd@domaine" "$O" && ! grep -qF "/fnd:smoke-test" "$O"; then ok
else bad L4-default-is-the-new-set "installs='$INSTALLS' out=$(tr '\n' ';' < "$O")"; fi

# --plugins names another set; base's alone verifies with /base-doctor only, and keeps the migration line
run "$TMP/h8a" "$FIXBOOT" --targets claude --plugins slim,band,base
INSTALLS="$(grep -oE '/plugin install [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$INSTALLS" = "slim@domaine band@domaine base@domaine " ] \
   && grep -qF "Moving from fnd: run /plugin uninstall fnd@domaine first" "$O" \
   && [ "$(grep -A1 '/reload-plugins' "$O" | tail -1 | tr -d ' ')" = "/base-doctor" ] \
   && ! grep -qF "/fe-doctor" "$O" && ! grep -qF "/fnd:smoke-test" "$O"; then ok
else bad L4b-claude-base-set "rc=$RC installs='$INSTALLS' out=$(tr '\n' ';' < "$O")"; fi

# fnd is reached only by naming it: its own install and smoke test, no doctor and no migration line
run "$TMP/h8f" "$FIXBOOT" --targets claude --plugins fnd
INSTALLS="$(grep -oE '/plugin install [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$INSTALLS" = "fnd@domaine " ] \
   && [ "$(grep -A1 '/reload-plugins' "$O" | tail -1 | tr -d ' ')" = "/fnd:smoke-test" ] \
   && ! grep -qF -- "-doctor" "$O" && ! grep -qF "Moving from fnd" "$O"; then ok
else bad L4c-claude-fnd-only "rc=$RC installs='$INSTALLS' out=$(tr '\n' ';' < "$O")"; fi

# a repeat is one line, and a team plugin keeps its place after the three
run "$TMP/h8b" "$FIXBOOT" --targets claude --plugins slim,band,base,fe,base
INSTALLS="$(grep -oE '/plugin install [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$INSTALLS" = "slim@domaine band@domaine base@domaine fe@domaine " ]; then ok
else bad L5-claude-plugins-set "rc=$RC installs='$INSTALLS'"; fi

# a team plugin alone is installed alone and verified by its own doctor; base's is not asked for
run "$TMP/h8q" "$FIXBOOT" --targets claude --plugins qa
INSTALLS="$(grep -oE '/plugin install [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$INSTALLS" = "qa@domaine " ] \
   && [ "$(grep -A1 '/reload-plugins' "$O" | tail -1 | tr -d ' ')" = "/qa-doctor" ] \
   && ! grep -qF "/base-doctor" "$O" && grep -qF "Moving from fnd: run /plugin uninstall fnd@domaine first" "$O"; then ok
else bad L5b-claude-qa-alone "rc=$RC installs='$INSTALLS' out=$(tr '\n' ';' < "$O")"; fi

# the team plugins follow base in the order fe, qa, be, pm whatever order --plugins gives, each
# with its doctor after base's
run "$TMP/h8r" "$FIXBOOT" --targets claude --plugins pm,qa,slim,band,base
INSTALLS="$(grep -oE '/plugin install [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$INSTALLS" = "slim@domaine band@domaine base@domaine qa@domaine pm@domaine " ] \
   && [ "$(grep -A3 '/reload-plugins' "$O" | tail -3 | tr -d ' ' | tr '\n' ' ')" = "/base-doctor /qa-doctor /pm-doctor " ]; then ok
else bad L5c-claude-team-order "rc=$RC installs='$INSTALLS' out=$(tr '\n' ';' < "$O")"; fi

# fnd beside base or a team plugin is refused with the reason, before anything is printed or installed
for spelling in "--plugins fnd,base" "--plugins=base,fe,fnd" "--plugins fe,fnd" "--plugins qa,fnd" "--plugins be,fnd" "--plugins=fnd,pm"; do
  # shellcheck disable=SC2086
  run "$TMP/h8c" "$FIXBOOT" --targets claude,cursor $spelling
  if [ "$RC" -eq 2 ] && grep -qF "fnd must not run together with base or a team plugin (fe, qa, be, pm)" "$E" \
     && ! grep -q '/plugin ' "$O" && [ "$(argv_count)" -eq 0 ]; then ok
  else bad "L6-claude-fnd-base-refused($spelling)" "rc=$RC out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E")"; fi
done

# a plugin name is a name: a path or a flag is refused
for name in "../x" "-y" "Base"; do
  run "$TMP/h8d" "$FIXBOOT" --targets claude --plugins "$name"
  if [ "$RC" -eq 2 ] && grep -qF "'$name' is not a plugin name" "$E"; then ok
  else bad "L7-claude-plugin-name($name)" "rc=$RC err=$(head -c 200 "$E")"; fi
done

# --plugins without the claude target installs nothing differently and says it was ignored
run "$TMP/h8e" "$FIXBOOT" --targets cursor --plugins fe
if [ "$RC" -eq 0 ] && grep -q "note: --plugins ignored" "$O" && [ "$(argv_line 1)" = "--target cursor" ]; then ok
else bad L8-plugins-without-claude "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# ---------------------------------------------------------------- the checkout test ---
# A checkout is recognised by its marketplace file, not by any one plugin: a copy that carries the
# marketplace but no plugins/fnd is still this repo, a folder with plugins/fnd but no marketplace
# file is not.
NOFND="$TMP/co-nofnd"; mkcheckout "$NOFND"; rm -rf "$NOFND/plugins/fnd"
run "$TMP/h8f" "$NOFND/scripts/bootstrap.sh" --targets cursor
if [ "$RC" -eq 0 ] && grep -q "from $NOFND" "$O" && ! grep -q '^clone' "$GIT_LOG"; then ok
else bad K1-checkout-by-marketplace "rc=$RC out=$(tr '\n' ';' < "$O") git=$(tr '\n' ';' < "$GIT_LOG")"; fi

NOMKT="$TMP/co-nomkt"; mkcheckout "$NOMKT"; rm -rf "$NOMKT/.claude-plugin"
run "$TMP/h8g" "$NOMKT/scripts/bootstrap.sh" --targets cursor --uninstall --dir "$NOMKT"
if [ "$RC" -eq 2 ] && grep -q "is not one" "$E" && [ "$(argv_count)" -eq 0 ]; then ok
else bad K2-no-marketplace-not-a-checkout "rc=$RC err=$(head -c 200 "$E")"; fi

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
if grep -qF "/plugin install fe@domaine" "$O" && grep -q "^== summary ==$" "$O" \
   && grep -q "left to do by hand" "$O" && grep -q "MARKETPLACE-installed fnd copy first" "$O"; then ok
else bad F4-missing-installer-report "out=$(tr '\n' ';' < "$O")"; fi

# ---------------------------------------------------------------------------- the report ---
run "$TMP/h10" "$FIXBOOT" --targets all
if grep -q "left to do by hand" "$O" \
   && grep -q "MARKETPLACE-installed fnd copy first" "$O" \
   && grep -q "Reload Window" "$O"; then ok
else bad P1-report-cursor-leftovers "out=$(tr '\n' ';' < "$O")"; fi

# The leftovers block is bootstrap's own text (the stub installer never prints it), so this is
# the assert that the OpenCode row still says both halves: the pastes stay the user's to make,
# and one command renders them for the checkout this run just produced.
if grep -q "docs/README.opencode.md" "$O" && grep -q "three pastes" "$O" \
   && grep -q "no installer may write" "$O" \
   && grep -qF "node $FIX/plugins/fnd/scripts/opencode-config.cjs" "$O"; then ok
else bad P2-report-opencode-pastes "out=$(tr '\n' ';' < "$O")"; fi

# …and a checkout too old to carry the renderer must not be handed its path: that command exits
# "Cannot find module", while the doc pointer beside it still works.
FIX4="$TMP/checkout-no-renderer"; mkcheckout "$FIX4"
rm -f "$FIX4/plugins/fnd/scripts/opencode-config.cjs"
run "$TMP/h10c" "$FIX4/scripts/bootstrap.sh" --targets opencode
if ! grep -qF "opencode-config.cjs" "$O" && grep -q "three pastes" "$O" \
   && grep -qF "$FIX4/docs/README.opencode.md" "$O"; then ok
else bad P2b-renderer-absent "out=$(tr '\n' ';' < "$O")"; fi

run "$TMP/h10" "$FIXBOOT" --targets all
if grep -qF "codex plugin marketplace add domaine-oleksandr-kever/claude-plugins" "$O" \
   && grep -q "linked the subagents" "$O" && grep -qF "~/.codex/agents" "$O"; then ok
else bad P3-report-codex-channel "out=$(tr '\n' ';' < "$O")"; fi

if grep -q "run /smoke-test once in a live session" "$O"; then ok
else bad P4-report-smoke-test "out=$(tr '\n' ';' < "$O")"; fi

# without the CLI claude is the one selected host with no install to succeed or fail at, so both
# of its report lines have to say so: an "OK" row would claim work that never happened, and a
# leftovers section that skips it drops the only instruction that target then produces.
if grep -q "^claude PRINTED (no claude on PATH)$" "$O" \
   && grep -q "Claude Code: run the slash commands printed above in a live session" "$O"; then ok
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
     && grep -qF '/plugin install fe@domaine' "$O" \
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

# the default uninstall removes what the default install installed, dependents first
run "$TMP/h19" "$FIXBOOT" --targets claude --uninstall
REMOVES="$(grep -oE '/plugin uninstall [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$(argv_count)" -eq 0 ] \
   && [ "$REMOVES" = "fe@domaine base@domaine band@domaine slim@domaine " ] \
   && grep -qF "/plugin marketplace remove domaine" "$O"; then ok
else bad U5-uninstall-claude-block "rc=$RC removes='$REMOVES' out=$(tr '\n' ';' < "$O")"; fi

if ! grep -qF "/plugin install " "$O"; then ok
else bad U6-uninstall-not-install-block "the uninstall run printed the INSTALL slash commands"; fi

# the first step of a migration removes fnd alone, never the slim and band the developer keeps
run "$TMP/h19b" "$FIXBOOT" --targets claude --uninstall --plugins fnd
REMOVES="$(grep -oE '/plugin uninstall [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$REMOVES" = "fnd@domaine " ]; then ok
else bad U5b-uninstall-fnd-only "rc=$RC removes='$REMOVES' err=$(head -c 200 "$E")"; fi

# dependents first: base before slim, which it requires
run "$TMP/h19c" "$FIXBOOT" --targets claude --uninstall --plugins slim,band,base
REMOVES="$(grep -oE '/plugin uninstall [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$REMOVES" = "base@domaine band@domaine slim@domaine " ]; then ok
else bad U5c-uninstall-named-reversed "rc=$RC removes='$REMOVES'"; fi

# …whatever order --plugins names them in: fe,base, reversed literally, would remove base first
run "$TMP/h19e" "$FIXBOOT" --targets claude --uninstall --plugins fe,base
REMOVES="$(grep -oE '/plugin uninstall [a-z0-9-]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')"
if [ "$RC" -eq 0 ] && [ "$REMOVES" = "fe@domaine base@domaine " ]; then ok
else bad U5e-uninstall-dependency-order "rc=$RC removes='$REMOVES'"; fi

# removing both is no co-install
run "$TMP/h19d" "$FIXBOOT" --targets claude --uninstall --plugins fnd,base
if [ "$RC" -eq 0 ] && ! grep -q "must not run together" "$E"; then ok
else bad U5d-uninstall-fnd-and-base "rc=$RC err=$(head -c 200 "$E")"; fi

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

# ------------------------------------------------------------ Q. the claude CLI is on PATH --
# `claude plugin …` is an ordinary shell command, so with the CLI present the claude target
# installs for real. Every row here runs the fake from $SHIM_CLAUDE; the rows above never see it.
mp_calls() { grep -c '^plugin marketplace' "$STUB_CLAUDE_LOG"; }
verbs() { sed -nE 's/^plugin (install|update|enable|uninstall) (-y )?([a-z0-9-]+)@domaine$/\1 \3/p' "$STUB_CLAUDE_LOG" | tr '\n' ';'; }

# fresh machine: no domaine marketplace yet, so it is added, then the default set in install order
claude_state absent
WITH_CLAUDE=yes run "$TMP/hq1" "$FIXBOOT" --targets claude
if [ "$RC" -eq 0 ] && grep -qx 'plugin marketplace add domaine-oleksandr-kever/claude-plugins' "$STUB_CLAUDE_LOG" \
   && ! grep -q '^plugin marketplace update' "$STUB_CLAUDE_LOG" && [ "$(argv_count)" -eq 0 ]; then ok
else bad Q1-marketplace-added-when-absent "rc=$RC calls=$(claude_calls) err=$(head -c 200 "$E")"; fi

if [ "$(verbs)" = "install slim;install band;install base;install fe;" ] \
   && [ "$(grep -n '^plugin marketplace add' "$STUB_CLAUDE_LOG" | cut -d: -f1)" -lt "$(grep -n '^plugin install' "$STUB_CLAUDE_LOG" | head -1 | cut -d: -f1)" ]; then ok
else bad Q2-install-order "calls=$(claude_calls)"; fi

# the CLI did the work, so nothing is printed to paste and the report says OK with the one step left
if grep -q '^claude OK$' "$O" && ! grep -q '/plugin install' "$O" \
   && grep -qF -- '- Claude Code: restart Claude Code, or run /reload-plugins in an open session, then /base-doctor and /fe-doctor' "$O" \
   && ! grep -q 'slash commands printed above' "$O"; then ok
else bad Q3-cli-report "out=$(tr '\n' ';' < "$O")"; fi

# a re-run is the update: the marketplace already there is refreshed, never added twice
claude_state present
WITH_CLAUDE=yes run "$TMP/hq2" "$FIXBOOT" --targets claude
if [ "$RC" -eq 0 ] && grep -qx 'plugin marketplace update domaine' "$STUB_CLAUDE_LOG" \
   && ! grep -q '^plugin marketplace add' "$STUB_CLAUDE_LOG" \
   && [ "$(verbs)" = "install slim;install band;install base;install fe;" ]; then ok
else bad Q4-marketplace-updated-when-present "rc=$RC calls=$(claude_calls)"; fi

# a marketplace list that fails says nothing about what is there, so the add is tried…
claude_state broken
WITH_CLAUDE=yes run "$TMP/hq3" "$FIXBOOT" --targets claude
if [ "$RC" -eq 0 ] && grep -qx 'plugin marketplace add domaine-oleksandr-kever/claude-plugins' "$STUB_CLAUDE_LOG" \
   && grep -q 'could not list marketplaces' "$O" && [ "$(verbs)" = "install slim;install band;install base;install fe;" ]; then ok
else bad Q5-add-when-list-fails "rc=$RC calls=$(claude_calls) out=$(head -c 200 "$O")"; fi

# …and a failed add is this target's failure: no install runs against a marketplace that is not there
claude_state broken; echo 4 > "$CSTATE/.stub-rc-marketplace-add"
WITH_CLAUDE=yes run "$TMP/hq3b" "$FIXBOOT" --targets claude
if [ "$RC" -eq 4 ] && [ -z "$(verbs)" ] \
   && grep -qx 'claude FAILED (claude plugin marketplace add domaine-oleksandr-kever/claude-plugins exit 4)' "$O" \
   && grep -q '^== summary ==$' "$O"; then ok
else bad Q5b-add-failure-stops "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# a failed refresh only leaves the cached catalog: a WARN, and the installs still run
claude_state present; echo 1 > "$CSTATE/.stub-rc-marketplace-update"
WITH_CLAUDE=yes run "$TMP/hq4" "$FIXBOOT" --targets claude
if [ "$RC" -eq 0 ] && grep -q 'WARN' "$E" && [ "$(verbs)" = "install slim;install band;install base;install fe;" ] \
   && grep -qx 'claude OK (WARN: claude plugin marketplace update domaine exit 1)' "$O"; then ok
else bad Q6-marketplace-update-warns "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# --plugins fnd installs fnd alone, verified by its smoke test
claude_state present
WITH_CLAUDE=yes run "$TMP/hq5" "$FIXBOOT" --targets claude --plugins fnd
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "install fnd;" ] \
   && grep -qF 'restart Claude Code, or run /reload-plugins in an open session, then /fnd:smoke-test' "$O" \
   && ! grep -q -- '-doctor' "$O"; then ok
else bad Q7-plugins-fnd-only "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# the first failed install stops the rest — what follows it in the order depends on it — and its
# rc and name reach the report, which still prints
claude_state present; echo 5 > "$CSTATE/.stub-rc-install-band"
WITH_CLAUDE=yes run "$TMP/hq6" "$FIXBOOT" --targets claude
if [ "$RC" -eq 5 ] && [ "$(verbs)" = "install slim;install band;" ] \
   && grep -qx 'claude FAILED (claude plugin install band@domaine exit 5)' "$O" \
   && grep -q 'fix the failed .claude plugin. call above' "$O" && ! grep -q '^claude OK' "$O"; then ok
else bad Q8-first-failure-stops "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# what is already installed at user scope is updated (and enabled again when it was disabled);
# a copy at project scope elsewhere is not a user install, so that one is installed
claude_state present "[
$(installed_entry slim@domaine user true),
$(installed_entry band@domaine user false),
$(installed_entry base@domaine project true)
]"
WITH_CLAUDE=yes run "$TMP/hq7" "$FIXBOOT" --targets claude
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "update slim;update band;enable band;install base;install fe;" ]; then ok
else bad Q9-installed-is-updated "rc=$RC calls=$(claude_calls)"; fi

# an update that fails is reported under its own verb
echo 6 > "$CSTATE/.stub-rc-update-slim"
WITH_CLAUDE=yes run "$TMP/hq7b" "$FIXBOOT" --targets claude
if [ "$RC" -eq 6 ] && [ "$(verbs)" = "update slim;" ] \
   && grep -qx 'claude FAILED (claude plugin update slim@domaine exit 6)' "$O"; then ok
else bad Q9b-update-failure "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# `plugin list` failing leaves nothing to compare against: every plugin is installed, and the
# fnd check that could not run is a WARN in the summary and a step left by hand, never a silent OK
claude_state present; rm -f "$CSTATE/installed.json"
WITH_CLAUDE=yes run "$TMP/hq7c" "$FIXBOOT" --targets claude
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "install slim;install band;install base;install fe;" ] \
   && grep -q "could not read 'claude plugin list --json'" "$O" \
   && grep -qF 'WARN — an enabled fnd was not checked for' "$E" \
   && grep -qx 'claude OK (WARN: fnd not checked)' "$O" \
   && grep -qF "'claude plugin list' could not be read, so nothing checked that fnd is not" "$O"; then ok
else bad Q9c-list-fails-installs-all "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E")"; fi

# …the legacy set warns about base and the team plugins the same way, and a set with neither side warns nothing
claude_state present; rm -f "$CSTATE/installed.json"
WITH_CLAUDE=yes run "$TMP/hq7d" "$FIXBOOT" --targets claude --plugins fnd
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "install fnd;" ] && grep -qx 'claude OK (WARN: base or a team plugin not checked)' "$O"; then ok
else bad Q9d-list-fails-warns-legacy "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi
claude_state present; rm -f "$CSTATE/installed.json"
WITH_CLAUDE=yes run "$TMP/hq7e" "$FIXBOOT" --targets claude --plugins slim,band
if [ "$RC" -eq 0 ] && grep -qx 'claude OK' "$O" && ! grep -q 'not checked' "$O" "$E"; then ok
else bad Q9e-list-fails-no-conflict-no-warn "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# fnd never runs with base or a team plugin: an enabled fnd stops the new set before anything changes…
claude_state present "[
$(installed_entry fnd@domaine user true)
]"
WITH_CLAUDE=yes run "$TMP/hq8" "$FIXBOOT" --targets claude
if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] && [ "$(mp_calls)" -eq 0 ] \
   && grep -qF 'claude plugin uninstall fnd@domaine' "$E" \
   && grep -qx 'claude FAILED (fnd is installed and enabled — remove it first)' "$O" \
   && grep -qx '    claude plugin uninstall fnd@domaine;' "$O" \
   && grep -qF 'then re-run this command and restart Claude Code' "$O" \
   && ! grep -q 'fix the failed' "$O"; then ok
else bad Q10-enabled-fnd-refused "rc=$RC calls=$(claude_calls) err=$(head -c 200 "$E") out=$(tr '\n' ';' < "$O")"; fi

# …a disabled one does not load, so it is no conflict…
claude_state present "[
$(installed_entry fnd@domaine user false)
]"
WITH_CLAUDE=yes run "$TMP/hq8b" "$FIXBOOT" --targets claude
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "install slim;install band;install base;install fe;" ]; then ok
else bad Q10b-disabled-fnd-allowed "rc=$RC calls=$(claude_calls)"; fi

# …and the legacy set is refused beside an enabled base or team plugin the same way
claude_state present "[
$(installed_entry fe@domaine user true)
]"
WITH_CLAUDE=yes run "$TMP/hq8c" "$FIXBOOT" --targets claude --plugins fnd
if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] && grep -qx 'claude FAILED (base or a team plugin is installed and enabled — remove it first)' "$O" \
   && grep -qx '    claude plugin uninstall fe@domaine;' "$O" && ! grep -q 'fix the failed' "$O"; then ok
else bad Q10c-fnd-beside-enabled-fe-refused "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi
for p in qa be pm; do
  claude_state present "[
$(installed_entry "$p@domaine" user true)
]"
  WITH_CLAUDE=yes run "$TMP/hq8c-$p" "$FIXBOOT" --targets claude --plugins fnd
  if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] && grep -qx "    claude plugin uninstall $p@domaine;" "$O"; then ok
  else bad "Q10c-fnd-beside-enabled-$p-refused" "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi
done
# …and each team plugin alone is refused beside an enabled fnd
claude_state present "[
$(installed_entry fnd@domaine user true)
]"
for p in qa be pm; do
  WITH_CLAUDE=yes run "$TMP/hq8q-$p" "$FIXBOOT" --targets claude --plugins "$p"
  if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] && grep -qx 'claude FAILED (fnd is installed and enabled — remove it first)' "$O"; then ok
  else bad "Q10j-$p-beside-enabled-fnd-refused" "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi
done

# …an fnd synced from the claude.ai account loads too once nothing shadows it, and only the
# account can remove it…
claude_state present "[
$(installed_entry fnd@synced synced true)
]"
WITH_CLAUDE=yes run "$TMP/hq8d" "$FIXBOOT" --targets claude
if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] && [ "$(mp_calls)" -eq 0 ] \
   && grep -qx '    remove fnd@synced from your claude.ai account (it is synced from there);' "$O" \
   && ! grep -q 'claude plugin uninstall fnd@synced' "$O" "$E"; then ok
else bad Q10d-synced-fnd-refused "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# …and every enabled copy is named, in the order the list gives them, with a non-user scope spelled out
claude_state present "[
$(installed_entry fnd@domaine project true),
$(installed_entry fnd@synced synced true),
$(installed_entry fe@domaine user true)
]"
WITH_CLAUDE=yes run "$TMP/hq8e" "$FIXBOOT" --targets claude
if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] \
   && grep -qx '    claude plugin uninstall -s project fnd@domaine (run it in the project that installed it), then remove fnd@synced from your claude.ai account (it is synced from there);' "$O"; then ok
else bad Q10e-every-fnd-named "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# `uninstall -s` takes user, project or local only: a managed copy is the admin's to drop, and a
# local one uninstalls only from inside its project
claude_state present "[
$(installed_entry fnd@domaine managed true)
]"
WITH_CLAUDE=yes run "$TMP/hq8g" "$FIXBOOT" --targets claude
if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] \
   && grep -qx '    ask your admin to drop fnd@domaine from the managed settings (a user cannot uninstall it);' "$O" \
   && ! grep -q 'uninstall -s managed' "$O" "$E"; then ok
else bad Q10g-managed-fnd-admin "rc=$RC out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E")"; fi
claude_state present "[
$(installed_entry fnd@domaine local true)
]"
WITH_CLAUDE=yes run "$TMP/hq8h" "$FIXBOOT" --targets claude
if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] \
   && grep -qx '    claude plugin uninstall -s local fnd@domaine (run it in the project that installed it);' "$O"; then ok
else bad Q10h-local-fnd-in-project "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# the legacy set names base too when both are enabled, dependents first
claude_state present "[
$(installed_entry base@domaine user true),
$(installed_entry fe@domaine user true)
]"
WITH_CLAUDE=yes run "$TMP/hq8f" "$FIXBOOT" --targets claude --plugins fnd
if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] \
   && grep -qx '    claude plugin uninstall fe@domaine, then claude plugin uninstall base@domaine;' "$O"; then ok
else bad Q10f-legacy-names-fe-then-base "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi
# …every enabled team plugin before base, in the order the list gives them
claude_state present "[
$(installed_entry base@domaine user true),
$(installed_entry pm@domaine user true),
$(installed_entry qa@domaine user false),
$(installed_entry be@domaine user true)
]"
WITH_CLAUDE=yes run "$TMP/hq8f2" "$FIXBOOT" --targets claude --plugins fnd
if [ "$RC" -eq 2 ] && [ -z "$(verbs)" ] \
   && grep -qx '    claude plugin uninstall pm@domaine, then claude plugin uninstall be@domaine, then claude plugin uninstall base@domaine;' "$O"; then ok
else bad Q10f2-legacy-names-team-then-base "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# a dependency is installed before what requires it, whatever order --plugins names them in
claude_state present
WITH_CLAUDE=yes run "$TMP/hq8i" "$FIXBOOT" --targets claude --plugins fe,slim,base
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "install slim;install base;install fe;" ]; then ok
else bad Q10i-install-dependency-order "rc=$RC calls=$(claude_calls)"; fi
claude_state present
WITH_CLAUDE=yes run "$TMP/hq8k" "$FIXBOOT" --targets claude --plugins pm,be,slim,qa,band,fe,base
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "install slim;install band;install base;install fe;install qa;install be;install pm;" ] \
   && grep -qF -- '- Claude Code: restart Claude Code, or run /reload-plugins in an open session, then /base-doctor, /fe-doctor, /qa-doctor, /be-doctor and /pm-doctor' "$O"; then ok
else bad Q10k-install-team-order "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# --yes is "never prompt": the CLI gets its -y; without it, no -y is invented
claude_state present
WITH_CLAUDE=yes run "$TMP/hq9" "$FIXBOOT" --targets claude --yes
if [ "$RC" -eq 0 ] && [ "$(grep -c '^plugin install -y [a-z]*@domaine$' "$STUB_CLAUDE_LOG")" -eq 4 ]; then ok
else bad Q11-yes-passes-y "rc=$RC calls=$(claude_calls)"; fi

# claude beside an install.sh host: both run, both reported
claude_state present
WITH_CLAUDE=yes run "$TMP/hq10" "$FIXBOOT" --targets claude,cursor
if [ "$RC" -eq 0 ] && [ "$(argv_line 1)" = "--target cursor" ] \
   && [ "$(verbs)" = "install slim;install band;install base;install fe;" ] \
   && grep -q '^cursor OK$' "$O" && grep -q '^claude OK$' "$O"; then ok
else bad Q12-claude-and-cursor "rc=$RC argv=$(tr '\n' ';' < "$STUB_LOG") calls=$(claude_calls)"; fi

# The curl|bash shape with the CLI present: no prompt, no -y nobody asked for, and the CLI never
# reads stdin — which in this shape is the rest of bootstrap's own source.
claude_state present
WITH_CLAUDE=yes runpiped "$TMP/hq11" "$FIXBOOT" --targets claude
if [ "$TIMED_OUT" = "no" ] && [ "$RC" -eq 0 ] && [ ! -s "$STUB_CLAUDE_STDIN" ] \
   && [ "$(verbs)" = "install slim;install band;install base;install fe;" ] \
   && grep -q '^claude OK$' "$O"; then ok
else bad Q13-piped-with-cli "timed_out=$TIMED_OUT rc=$RC stdin=$(head -c 80 "$STUB_CLAUDE_STDIN") calls=$(claude_calls)"; fi

# uninstall: dependents first, past a failure, and the marketplace stays
claude_state present "[
$(installed_entry slim@domaine user true),
$(installed_entry band@domaine user true),
$(installed_entry base@domaine user true),
$(installed_entry fe@domaine user true)
]"
echo 1 > "$CSTATE/.stub-rc-uninstall-base"
WITH_CLAUDE=yes run "$TMP/hq12" "$FIXBOOT" --targets claude --uninstall
if [ "$RC" -eq 1 ] && [ "$(verbs)" = "uninstall fe;uninstall base;uninstall band;uninstall slim;" ]; then ok
else bad Q14-uninstall-reverse-continues "rc=$RC calls=$(claude_calls)"; fi

if [ "$(mp_calls)" -eq 0 ] && grep -qF "'claude plugin marketplace remove domaine' drops it too (optional)" "$O" \
   && grep -qx 'claude FAILED (claude plugin uninstall base@domaine exit 1)' "$O"; then ok
else bad Q15-uninstall-keeps-marketplace "calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# what is not installed at user scope is skipped by name, not reported as a failed removal
claude_state present "[
$(installed_entry slim@domaine user true),
$(installed_entry fe@domaine user true)
]"
WITH_CLAUDE=yes run "$TMP/hq13" "$FIXBOOT" --targets claude --uninstall
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "uninstall fe;uninstall slim;" ] \
   && grep -q 'band@domaine is not installed at user scope — skipped' "$O" && grep -q '^claude OK$' "$O"; then ok
else bad Q16-uninstall-skips-absent "rc=$RC calls=$(claude_calls) out=$(tr '\n' ';' < "$O")"; fi

# a named uninstall in the wrong order still removes the dependent first
claude_state present "[
$(installed_entry base@domaine user true),
$(installed_entry fe@domaine user true)
]"
WITH_CLAUDE=yes run "$TMP/hq13b" "$FIXBOOT" --targets claude --uninstall --plugins fe,base
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "uninstall fe;uninstall base;" ]; then ok
else bad Q16b-uninstall-dependency-order "rc=$RC calls=$(claude_calls)"; fi
# every team plugin goes before base, base before slim, in the reverse of the install order
claude_state present "[
$(installed_entry slim@domaine user true),
$(installed_entry band@domaine user true),
$(installed_entry base@domaine user true),
$(installed_entry fe@domaine user true),
$(installed_entry qa@domaine user true),
$(installed_entry be@domaine user true),
$(installed_entry pm@domaine user true)
]"
WITH_CLAUDE=yes run "$TMP/hq13c" "$FIXBOOT" --targets claude --uninstall --plugins slim,qa,base,pm,be,band,fe
if [ "$RC" -eq 0 ] && [ "$(verbs)" = "uninstall pm;uninstall be;uninstall qa;uninstall fe;uninstall base;uninstall band;uninstall slim;" ]; then ok
else bad Q16c-uninstall-team-order "rc=$RC calls=$(claude_calls)"; fi
# without the CLI the printed uninstall block keeps that order
run "$TMP/h13d" "$FIXBOOT" --targets claude --uninstall --plugins qa,base,pm
if [ "$RC" -eq 0 ] && [ "$(grep -oE '/plugin uninstall [a-z]+@domaine' "$O" | awk '{ print $3 }' | tr '\n' ' ')" = "pm@domaine qa@domaine base@domaine " ]; then ok
else bad Q16d-printed-uninstall-team-order "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# The fake is only as good as its argv check: an option the real CLI's --help does not list is
# refused, so a bootstrap passing one would fail these rows instead of passing against a fiction.
RC=0
STUB_CLAUDE_STATE="$CSTATE" "$SHIM_CLAUDE/claude" plugin install --bogus slim@domaine </dev/null >/dev/null 2>"$E" || RC=$?
if [ "$RC" -eq 64 ] && grep -q "unknown option '--bogus'" "$E"; then ok
else bad Q17-fake-refuses-unknown-flags "rc=$RC err=$(head -c 120 "$E")"; fi

if [ "$PTY_SKIPPED" = "yes" ]; then
  echo "bootstrap-sim: NOTE — no usable script(1), the 5 terminal-prompt cases (Y1-Y5) did not run" >&2
fi

echo "bootstrap-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
