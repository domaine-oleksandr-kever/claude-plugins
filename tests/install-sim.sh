#!/usr/bin/env bash
# Simulation harness for scripts/install.sh (multi-harness port, M2).
# Hermetic: every case runs against a fixture repo built in $TMP with a COPY of the
# installer, and against a throwaway $HOME — no network, no writes outside $TMP, and
# the git cases talk to a local bare origin only. Exit 0 = all green.
set -u

# A developer's real config dir would re-target every opencode case; the git identity vars
# would leak into the fixture commits. Both are set explicitly where a case needs them.
unset XDG_CONFIG_HOME GIT_DIR GIT_WORK_TREE GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL \
      GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL="$ROOT/scripts/install.sh"
BASH_BIN="$(command -v bash)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; failures=""
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); failures="${failures}  [$1] $2
"; }

O="$TMP/out"; E="$TMP/err"; RC=0

# run <home> <repo-dir> [args...] — installer under a throwaway HOME; RC/O/E hold the result
run() {
  local home="$1" repo="$2"; shift 2
  mkdir -p "$home"
  RC=0
  HOME="$home" "$BASH_BIN" "$repo/scripts/install.sh" "$@" >"$O" 2>"$E" || RC=$?
}

# mkrepo <dir> — a minimal fnd checkout: the installer plus enough plugin content to link
mkrepo() {
  local d="$1"
  mkdir -p "$d/scripts" "$d/plugins/fnd/skills/alpha" "$d/plugins/fnd/skills/beta" "$d/plugins/fnd/references"
  cp "$INSTALL" "$d/scripts/install.sh"
  chmod +x "$d/scripts/install.sh"
  echo "alpha" > "$d/plugins/fnd/skills/alpha/SKILL.md"
  echo "beta"  > "$d/plugins/fnd/skills/beta/SKILL.md"
  echo "ref"   > "$d/plugins/fnd/references/notes.md"
}

# mkbundle <repo-dir> <version> — the packaging a real install carries: three manifests, a hook
# script and a COPY of the real doctor, so the installer's verification step runs for real.
mkbundle() {
  local d="$1/plugins/fnd" h
  mkdir -p "$d/.claude-plugin" "$d/.cursor-plugin" "$d/.codex-plugin" "$d/hooks" "$d/scripts"
  for h in .claude-plugin .cursor-plugin .codex-plugin; do
    printf '{"name":"fnd","version":"%s"}\n' "$2" > "$d/$h/plugin.json"
  done
  printf '#!/bin/sh\nexit 0\n' > "$d/hooks/no-verify-bypass.sh"; chmod +x "$d/hooks/no-verify-bypass.sh"
  cp "$ROOT/plugins/fnd/scripts/doctor.cjs" "$d/scripts/doctor.cjs"
}

# restamp <repo-dir> <version> — what a release commit does to the manifests
restamp() {
  local d="$1/plugins/fnd" h
  for h in .claude-plugin .cursor-plugin .codex-plugin; do
    printf '{"name":"fnd","version":"%s"}\n' "$2" > "$d/$h/plugin.json"
  done
}

# mkdoctor <repo-dir> <exit-code> — stub doctor.cjs recording its argv next to the fixture
mkdoctor() {
  mkdir -p "$1/plugins/fnd/scripts"
  cat > "$1/plugins/fnd/scripts/doctor.cjs" <<STUB
const fs = require('fs');
fs.writeFileSync(process.env.FND_DOCTOR_LOG || '/dev/null', process.argv.slice(2).join(' ') + '\n');
process.exit($2);
STUB
}

gitq() {
  git -c user.name=fnd -c user.email=fnd@example.com -c commit.gpgsign=false \
      -c init.defaultBranch=main -c advice.detachedHead=false "$@"
}

CURSOR_LINK=".cursor/plugins/local/fnd"
CURSOR_MODE=".cursor/plugins/local/.fnd-install-mode"

# ------------------------------------------------------------------ version stamp (drift) --
# The installer's FND_VERSION is one of the stamps bump-version.cjs owns; the canonical
# manifest is the source of truth, and a drift here ships a wrong install report.
MANIFEST_VER="$(node -e 'process.stdout.write(require("'"$ROOT"'/plugins/fnd/.claude-plugin/plugin.json").version)' 2>/dev/null || echo "?")"
INSTALL_VER="$(grep -m1 '^FND_VERSION=' "$INSTALL" | sed 's/^FND_VERSION="\(.*\)"$/\1/')"
if [ -n "$MANIFEST_VER" ] && [ "$MANIFEST_VER" = "$INSTALL_VER" ]; then ok
else bad V1-version-stamp "installer=$INSTALL_VER manifest=$MANIFEST_VER"; fi

# V2 (bug): bump-version.cjs rewrites EVERY double-quoted FND_VERSION assignment in this file,
# so a second one — a shell variable set from the manifest, an example in a comment — would be
# frozen into a constant at the next release and the installer would report the wrong version.
LITERALS="$(grep -c 'FND_VERSION="' "$INSTALL")"
if [ "$LITERALS" -eq 1 ]; then ok
else bad V2-single-version-literal "$LITERALS quoted FND_VERSION assignments in scripts/install.sh, want 1"; fi

# ------------------------------------------------------------------------- argument gates --
REPO1="$TMP/repo1"; mkrepo "$REPO1"

run "$TMP/h-args" "$REPO1"
if [ "$RC" -eq 2 ] && grep -q 'target is required' "$E"; then ok; else bad A1-no-target "rc=$RC err=$(head -c 120 "$E")"; fi

run "$TMP/h-args" "$REPO1" --target claude
if [ "$RC" -eq 2 ] && grep -q "unknown target" "$E"; then ok; else bad A2-bad-target "rc=$RC err=$(head -c 120 "$E")"; fi

run "$TMP/h-args" "$REPO1" --target cursor --wat
if [ "$RC" -eq 2 ] && grep -q "unknown argument" "$E"; then ok; else bad A3-unknown-flag "rc=$RC err=$(head -c 120 "$E")"; fi

run "$TMP/h-args" "$REPO1" --target
if [ "$RC" -eq 2 ]; then ok; else bad A4-target-needs-value "rc=$RC"; fi

run "$TMP/h-args" "$REPO1" --help
if [ "$RC" -eq 0 ] && grep -q -- '--uninstall' "$O"; then ok; else bad A5-help "rc=$RC out=$(head -c 120 "$O")"; fi

# --------------------------------------------------------------- cursor: fresh install ----
H1="$TMP/h1"
run "$H1" "$REPO1" --target cursor
if [ "$RC" -eq 0 ] && [ -L "$H1/$CURSOR_LINK" ] \
   && [ "$(readlink "$H1/$CURSOR_LINK")" = "$REPO1/plugins/fnd" ]; then ok
else bad C1-fresh-symlink "rc=$RC link=$(readlink "$H1/$CURSOR_LINK" 2>/dev/null) err=$(head -c 160 "$E")"; fi

if [ -f "$H1/$CURSOR_LINK/skills/alpha/SKILL.md" ]; then ok
else bad C2-content-reachable "plugin content not reachable through the link"; fi

if grep -q "^mode=symlink$" "$H1/$CURSOR_MODE" \
   && grep -q "^repo=$REPO1$" "$H1/$CURSOR_MODE" \
   && grep -q "^version=$INSTALL_VER$" "$H1/$CURSOR_MODE" \
   && [ "$(grep -c '^entry=' "$H1/$CURSOR_MODE")" -eq 1 ]; then ok
else bad C3-mode-file "$(tr '\n' ';' < "$H1/$CURSOR_MODE" 2>/dev/null)"; fi

if grep -q "fnd $INSTALL_VER installed for cursor" "$O" && grep -q "mode: symlink" "$O"; then ok
else bad C4-report-line "out=$(tr '\n' ';' < "$O")"; fi

if grep -q "Reload Window" "$O"; then ok; else bad C5-reload-hint "out=$(tr '\n' ';' < "$O")"; fi

# C6: no doctor in the fixture — the installer says so instead of failing
if grep -q "doctor.cjs not in this checkout" "$O"; then ok
else bad C6-doctor-absent "out=$(tr '\n' ';' < "$O")"; fi

# --------------------------------------------------------------------- idempotent re-run --
run "$H1" "$REPO1" --target cursor
if [ "$RC" -eq 0 ] && [ -L "$H1/$CURSOR_LINK" ] \
   && [ "$(readlink "$H1/$CURSOR_LINK")" = "$REPO1/plugins/fnd" ] \
   && grep -q "0 created, 0 replaced, 1 unchanged" "$O" \
   && [ "$(grep -c '^entry=' "$H1/$CURSOR_MODE")" -eq 1 ]; then ok
else bad C7-rerun-idempotent "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# ------------------------------------------------------------- clobber refusal (non-link) --
H2="$TMP/h2"; mkdir -p "$H2/$CURSOR_LINK"
echo "someone else's plugin" > "$H2/$CURSOR_LINK/manifest.json"
run "$H2" "$REPO1" --target cursor
if [ "$RC" -eq 1 ] && grep -q "refusing to clobber" "$E" && grep -q "$CURSOR_LINK" "$E" \
   && [ -f "$H2/$CURSOR_LINK/manifest.json" ] && [ ! -L "$H2/$CURSOR_LINK" ]; then ok
else bad C8-refuse-dir "rc=$RC err=$(head -c 200 "$E")"; fi

if [ ! -f "$H2/$CURSOR_MODE" ]; then ok; else bad C9-refuse-no-mode-file "mode file written on refusal"; fi

# a plain FILE at the target path is the same refusal
H3="$TMP/h3"; mkdir -p "$(dirname "$H3/$CURSOR_LINK")"; echo "notes" > "$H3/$CURSOR_LINK"
run "$H3" "$REPO1" --target cursor
if [ "$RC" -eq 1 ] && grep -q "refusing to clobber" "$E" && [ "$(cat "$H3/$CURSOR_LINK")" = "notes" ]; then ok
else bad C10-refuse-file "rc=$RC err=$(head -c 160 "$E")"; fi

# ------------------------------------------------------------------- uninstall round trip --
H4="$TMP/h4"
run "$H4" "$REPO1" --target cursor
mkdir -p "$H4/.cursor/plugins/local/other"; echo x > "$H4/.cursor/plugins/local/other/keep.md"
run "$H4" "$REPO1" --target cursor --uninstall
if [ "$RC" -eq 0 ] && [ ! -e "$H4/$CURSOR_LINK" ] && [ ! -f "$H4/$CURSOR_MODE" ] \
   && [ -f "$H4/.cursor/plugins/local/other/keep.md" ]; then ok
else bad C11-uninstall "rc=$RC out=$(tr '\n' ';' < "$O") err=$(head -c 160 "$E")"; fi

if grep -q "uninstalled from cursor (1 removed" "$O"; then ok
else bad C12-uninstall-report "out=$(tr '\n' ';' < "$O")"; fi

# install → uninstall → install again lands the same state
run "$H4" "$REPO1" --target cursor
if [ "$RC" -eq 0 ] && [ "$(readlink "$H4/$CURSOR_LINK")" = "$REPO1/plugins/fnd" ]; then ok
else bad C13-reinstall-after-uninstall "rc=$RC"; fi

# uninstall with nothing installed is a no-op, not an error
H5="$TMP/h5"
run "$H5" "$REPO1" --target cursor --uninstall
if [ "$RC" -eq 0 ] && grep -q "0 removed" "$O"; then ok
else bad C14-uninstall-clean-home "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# a symlink at OUR path that points elsewhere is not ours to delete
H6="$TMP/h6"
run "$H6" "$REPO1" --target cursor
FOREIGN="$TMP/foreign-plugin"; mkdir -p "$FOREIGN"
rm "$H6/$CURSOR_LINK"; ln -s "$FOREIGN" "$H6/$CURSOR_LINK"
run "$H6" "$REPO1" --target cursor --uninstall
if [ "$RC" -eq 0 ] && [ -L "$H6/$CURSOR_LINK" ] && grep -q "kept:" "$O" && grep -q "1 kept" "$O"; then ok
else bad C15-uninstall-keeps-foreign-link "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# ...but an install may take that path back (the plan refuses non-symlinks only)
run "$H6" "$REPO1" --target cursor
if [ "$RC" -eq 0 ] && [ "$(readlink "$H6/$CURSOR_LINK")" = "$REPO1/plugins/fnd" ] \
   && grep -q "replacing foreign symlink" "$O"; then ok
else bad C16-install-replaces-foreign-link "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# ---------------------------------------------------------------------------- --copy mode --
H7="$TMP/h7"
run "$H7" "$REPO1" --target cursor --copy
if [ "$RC" -eq 0 ] && [ -d "$H7/$CURSOR_LINK" ] && [ ! -L "$H7/$CURSOR_LINK" ] \
   && [ -f "$H7/$CURSOR_LINK/skills/alpha/SKILL.md" ] \
   && grep -q "^mode=copy$" "$H7/$CURSOR_MODE"; then ok
else bad P1-copy-install "rc=$RC err=$(head -c 200 "$E")"; fi

if grep -q "do not follow git pull" "$O"; then ok; else bad P2-copy-notice "out=$(tr '\n' ';' < "$O")"; fi

# re-running --copy refreshes the copy (this is the update path for copy installs)
echo "gamma" > "$REPO1/plugins/fnd/skills/alpha/NEW.md"
run "$H7" "$REPO1" --target cursor --copy
if [ "$RC" -eq 0 ] && [ -f "$H7/$CURSOR_LINK/skills/alpha/NEW.md" ] && [ ! -L "$H7/$CURSOR_LINK" ]; then ok
else bad P3-copy-refresh "rc=$RC out=$(tr '\n' ';' < "$O")"; fi
rm -f "$REPO1/plugins/fnd/skills/alpha/NEW.md"

# a recorded copy may be swapped for a symlink without the clobber refusal
run "$H7" "$REPO1" --target cursor
if [ "$RC" -eq 0 ] && [ -L "$H7/$CURSOR_LINK" ] && grep -q "^mode=symlink$" "$H7/$CURSOR_MODE"; then ok
else bad P4-copy-to-symlink "rc=$RC err=$(head -c 160 "$E")"; fi

# uninstall removes a copy we recorded
H8="$TMP/h8"
run "$H8" "$REPO1" --target cursor --copy
run "$H8" "$REPO1" --target cursor --uninstall
if [ "$RC" -eq 0 ] && [ ! -e "$H8/$CURSOR_LINK" ] && [ ! -f "$H8/$CURSOR_MODE" ]; then ok
else bad P5-copy-uninstall "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# an unrecorded directory survives uninstall even when a mode file says copy
H9="$TMP/h9"
run "$H9" "$REPO1" --target cursor --copy
rm -rf "$H9/$CURSOR_LINK"; mkdir -p "$H9/$CURSOR_LINK"; echo x > "$H9/$CURSOR_LINK/keep.md"
printf 'mode=copy\nrepo=%s\nversion=%s\nentry=%s\n' "$REPO1" "$INSTALL_VER" "$H9/.cursor/plugins/local/elsewhere" > "$H9/$CURSOR_MODE"
run "$H9" "$REPO1" --target cursor --uninstall
if [ "$RC" -eq 0 ] && [ -f "$H9/$CURSOR_LINK/keep.md" ]; then ok
else bad P6-uninstall-unrecorded-dir "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# ------------------------------------------------------------------------ opencode target --
OC=".config/opencode"
H10="$TMP/h10"
mkdir -p "$H10/$OC/skills/mine"; echo "mine" > "$H10/$OC/skills/mine/SKILL.md"
run "$H10" "$REPO1" --target opencode
if [ "$RC" -eq 0 ] && [ -L "$H10/$OC/skills/alpha" ] && [ -L "$H10/$OC/skills/beta" ] \
   && [ "$(readlink "$H10/$OC/skills/alpha")" = "$REPO1/plugins/fnd/skills/alpha" ]; then ok
else bad O1-opencode-skills "rc=$RC err=$(head -c 200 "$E")"; fi

# the user's own entries in the same dir are untouched — we never link over the dir itself
if [ -f "$H10/$OC/skills/mine/SKILL.md" ] && [ ! -L "$H10/$OC/skills" ]; then ok
else bad O2-opencode-user-skills-intact "user skills dir clobbered"; fi

if grep -q "provisional" "$O" && grep -q "M1c" "$O"; then ok
else bad O3-opencode-provisional-note "out=$(tr '\n' ';' < "$O")"; fi

if [ "$(grep -c '^entry=' "$H10/$OC/.fnd-install-mode")" -eq 2 ] \
   && grep -q "new OpenCode session" "$O"; then ok
else bad O4-opencode-mode-file "$(tr '\n' ';' < "$H10/$OC/.fnd-install-mode" 2>/dev/null)"; fi

run "$H10" "$REPO1" --target opencode --uninstall
if [ "$RC" -eq 0 ] && [ ! -e "$H10/$OC/skills/alpha" ] && [ ! -e "$H10/$OC/skills/beta" ] \
   && [ -f "$H10/$OC/skills/mine/SKILL.md" ] && [ ! -f "$H10/$OC/.fnd-install-mode" ]; then ok
else bad O5-opencode-uninstall "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

# generated adapter dirs (M4/M5 output) are linked when the checkout carries them
REPO2="$TMP/repo2"; mkrepo "$REPO2"
mkdir -p "$REPO2/plugins/fnd/agents-opencode" "$REPO2/plugins/fnd/commands-opencode" "$REPO2/plugins/fnd/opencode"
echo "agent" > "$REPO2/plugins/fnd/agents-opencode/jira-reader.md"
echo "cmd"   > "$REPO2/plugins/fnd/commands-opencode/commit.md"
echo "js"    > "$REPO2/plugins/fnd/opencode/fnd-plugin.js"
H11="$TMP/h11"
run "$H11" "$REPO2" --target opencode
if [ "$RC" -eq 0 ] && [ -L "$H11/$OC/agents/jira-reader.md" ] && [ -L "$H11/$OC/commands/commit.md" ] \
   && [ -L "$H11/$OC/plugins/fnd-plugin.js" ] \
   && [ "$(grep -c '^entry=' "$H11/$OC/.fnd-install-mode")" -eq 5 ]; then ok
else bad O6-opencode-generated-dirs "rc=$RC entries=$(grep -c '^entry=' "$H11/$OC/.fnd-install-mode" 2>/dev/null)"; fi

run "$H11" "$REPO2" --target opencode --uninstall
if [ "$RC" -eq 0 ] && [ ! -e "$H11/$OC/agents/jira-reader.md" ] && [ ! -e "$H11/$OC/plugins/fnd-plugin.js" ] \
   && [ ! -d "$H11/$OC" ]; then ok
else bad O7-opencode-uninstall-prunes "rc=$RC leftover=$(find "$H11/$OC" 2>/dev/null | tr '\n' ';')"; fi

# XDG_CONFIG_HOME wins over ~/.config
H12="$TMP/h12"; XDG="$TMP/xdg"
RC=0
mkdir -p "$H12" "$XDG"
HOME="$H12" XDG_CONFIG_HOME="$XDG" "$BASH_BIN" "$REPO1/scripts/install.sh" --target opencode >"$O" 2>"$E" || RC=$?
if [ "$RC" -eq 0 ] && [ -L "$XDG/opencode/skills/alpha" ] && [ ! -e "$H12/.config/opencode" ]; then ok
else bad O8-xdg-config-home "rc=$RC err=$(head -c 160 "$E")"; fi

# --------------------------------------------------------------------------- clone update --
if command -v git >/dev/null 2>&1; then
  # not a git checkout at all
  H13="$TMP/h13"
  run "$H13" "$REPO1" --target cursor
  if grep -q "not a git checkout" "$O"; then ok
  else bad G1-non-git "out=$(tr '\n' ';' < "$O")"; fi

  # git checkout without a remote: nothing to pull from, install proceeds
  REPO3="$TMP/repo3"; mkrepo "$REPO3"
  ( cd "$REPO3" && gitq init -q . && gitq add -A && gitq commit -qm init ) >/dev/null 2>&1
  H14="$TMP/h14"
  run "$H14" "$REPO3" --target cursor
  if [ "$RC" -eq 0 ] && grep -q "no git remote" "$O" && [ -L "$H14/$CURSOR_LINK" ]; then ok
  else bad G2-no-remote "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

  # a local bare origin with a newer commit: the re-run IS the update
  ORIGIN="$TMP/origin.git"; WORK="$TMP/work"
  gitq init -q --bare "$ORIGIN" >/dev/null 2>&1
  mkrepo "$WORK"
  ( cd "$WORK" && gitq init -q . && gitq add -A && gitq commit -qm init \
      && gitq remote add origin "$ORIGIN" && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1
  CLONE="$TMP/clone"
  gitq clone -q "$ORIGIN" "$CLONE" >/dev/null 2>&1
  echo "shipped" > "$WORK/plugins/fnd/skills/alpha/NEW.md"
  ( cd "$WORK" && gitq add -A && gitq commit -qm feat && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1
  H15="$TMP/h15"
  run "$H15" "$CLONE" --target cursor
  if [ "$RC" -eq 0 ] && grep -q "updated clone" "$O" && [ -f "$CLONE/plugins/fnd/skills/alpha/NEW.md" ] \
     && [ -f "$H15/$CURSOR_LINK/skills/alpha/NEW.md" ]; then ok
  else bad G3-pull-ff-only "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

  # dirty tree: the pull is skipped, the install still happens
  echo "wip" > "$CLONE/plugins/fnd/skills/beta/WIP.md"
  echo "shipped2" > "$WORK/plugins/fnd/skills/alpha/NEW2.md"
  ( cd "$WORK" && gitq add -A && gitq commit -qm feat2 && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1
  run "$H15" "$CLONE" --target cursor
  if [ "$RC" -eq 0 ] && grep -q "local changes" "$O" && [ ! -f "$CLONE/plugins/fnd/skills/alpha/NEW2.md" ] \
     && [ -L "$H15/$CURSOR_LINK" ]; then ok
  else bad G4-dirty-skips-pull "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

  # ------------------------------------------------------------------- update = same run --
  # U1 (bug): the entry list is a snapshot of the checkout, so it must be built AFTER the pull.
  # Built before, an update links only what existed pre-pull and still reports success — every
  # new skill and every generated adapter dir would arrive one update late.
  ORIGIN2="$TMP/origin2.git"; WORK2="$TMP/work2"
  gitq init -q --bare "$ORIGIN2" >/dev/null 2>&1
  mkrepo "$WORK2"
  ( cd "$WORK2" && gitq init -q . && gitq add -A && gitq commit -qm init \
      && gitq remote add origin "$ORIGIN2" && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1
  CLONE2="$TMP/clone2"
  gitq clone -q "$ORIGIN2" "$CLONE2" >/dev/null 2>&1
  H18="$TMP/h18"
  run "$H18" "$CLONE2" --target opencode
  mkdir -p "$WORK2/plugins/fnd/skills/smoke-test"
  echo "smoke" > "$WORK2/plugins/fnd/skills/smoke-test/SKILL.md"
  ( cd "$WORK2" && gitq add -A && gitq commit -qm feat && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1
  run "$H18" "$CLONE2" --target opencode
  if [ "$RC" -eq 0 ] && grep -q "updated clone" "$O" \
     && [ -L "$H18/$OC/skills/smoke-test" ] \
     && [ "$(readlink "$H18/$OC/skills/smoke-test")" = "$CLONE2/plugins/fnd/skills/smoke-test" ] \
     && [ "$(grep -c '^entry=' "$H18/$OC/.fnd-install-mode")" -eq 3 ]; then ok
  else bad U1-pull-then-link "rc=$RC out=$(tr '\n' ';' < "$O")"; fi

  # U2 (bug): the mirror case — an entry the checkout no longer produces must be pruned in the
  # same run, or it survives as a dangling link that the new record no longer names, invisible
  # to both --uninstall and the doctor.
  ( cd "$WORK2" && gitq rm -rq plugins/fnd/skills/beta && gitq commit -qm drop \
      && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1
  run "$H18" "$CLONE2" --target opencode
  if [ "$RC" -eq 0 ] && [ ! -L "$H18/$OC/skills/beta" ] && [ ! -e "$H18/$OC/skills/beta" ] \
     && grep -q "pruned: " "$O" && grep -q "1 pruned" "$O" \
     && [ -L "$H18/$OC/skills/alpha" ] \
     && [ "$(grep -c '^entry=' "$H18/$OC/.fnd-install-mode")" -eq 2 ]; then ok
  else bad U2-prune-dropped-entry "rc=$RC out=$(tr '\n' ';' < "$O") left=$(ls "$H18/$OC/skills" | tr '\n' ';')"; fi

  # U3 (bug, the --copy update path): the version is read AFTER the pull, so the record carries
  # what the pull landed. Read before, the installer's own doctor call false-FAILs the refresh
  # it just performed and the report line names the old version.
  ORIGIN3="$TMP/origin3.git"; WORK3="$TMP/work3"
  gitq init -q --bare "$ORIGIN3" >/dev/null 2>&1
  mkrepo "$WORK3"; mkbundle "$WORK3" 0.59.0
  ( cd "$WORK3" && gitq init -q . && gitq add -A && gitq commit -qm init \
      && gitq remote add origin "$ORIGIN3" && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1
  CLONE3="$TMP/clone3"
  gitq clone -q "$ORIGIN3" "$CLONE3" >/dev/null 2>&1
  H19="$TMP/h19"
  run "$H19" "$CLONE3" --target cursor --copy
  if [ "$RC" -eq 0 ] && grep -q "^version=0.59.0$" "$H19/$CURSOR_MODE" && grep -q "0 failed" "$O"; then ok
  else bad U3-copy-baseline "rc=$RC out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E")"; fi

  restamp "$WORK3" 0.60.0
  ( cd "$WORK3" && gitq add -A && gitq commit -qm release && gitq push -q origin HEAD:refs/heads/main ) >/dev/null 2>&1
  run "$H19" "$CLONE3" --target cursor --copy
  if [ "$RC" -eq 0 ] && grep -q "updated clone" "$O" \
     && grep -q "^version=0.60.0$" "$H19/$CURSOR_MODE" \
     && grep -q "fnd 0.60.0 installed for cursor" "$O" \
     && grep -q "0 failed" "$O" && ! grep -q "copy install is stale" "$O"; then ok
  else bad U4-copy-update-version "rc=$RC out=$(tr '\n' ';' < "$O") err=$(head -c 200 "$E")"; fi
else
  bad G0-git-missing "git not on PATH — clone-update cases skipped"
fi

# ------------------------------------------------------------------------- prune limits --
# U5: pruning obeys the same ownership rule as uninstall — a foreign symlink parked at a path
# we once owned is left alone, and reported.
H20="$TMP/h20"
run "$H20" "$REPO1" --target opencode
FOREIGN_SKILL="$TMP/foreign-skill"; mkdir -p "$FOREIGN_SKILL"
rm "$H20/$OC/skills/beta"; ln -s "$FOREIGN_SKILL" "$H20/$OC/skills/beta"
mv "$REPO1/plugins/fnd/skills/beta" "$TMP/beta-stash"
run "$H20" "$REPO1" --target opencode
if [ "$RC" -eq 0 ] && [ "$(readlink "$H20/$OC/skills/beta")" = "$FOREIGN_SKILL" ] \
   && grep -q "kept: " "$O" && grep -q "0 pruned" "$O"; then ok
else bad U5-prune-keeps-foreign "rc=$RC out=$(tr '\n' ';' < "$O")"; fi
mv "$TMP/beta-stash" "$REPO1/plugins/fnd/skills/beta"

# U6: the recorded version is the checkout's canonical manifest, not the installer's literal —
# the doctor compares the two, so a literal that lags a release would false-FAIL every install.
REPO6="$TMP/repo6"; mkrepo "$REPO6"
mkdir -p "$REPO6/plugins/fnd/.claude-plugin"
printf '{"name":"fnd","version":"9.9.9"}\n' > "$REPO6/plugins/fnd/.claude-plugin/plugin.json"
H21="$TMP/h21"
run "$H21" "$REPO6" --target cursor
if [ "$RC" -eq 0 ] && grep -q "^version=9.9.9$" "$H21/$CURSOR_MODE" \
   && grep -q "fnd 9.9.9 installed for cursor" "$O"; then ok
else bad U6-version-from-manifest "rc=$RC mode=$(tr '\n' ';' < "$H21/$CURSOR_MODE" 2>/dev/null)"; fi

# ---------------------------------------------------------------------------- doctor call --
REPO4="$TMP/repo4"; mkrepo "$REPO4"; mkdoctor "$REPO4" 0
H16="$TMP/h16"; DLOG="$TMP/doctor-argv"
RC=0
mkdir -p "$H16"
HOME="$H16" FND_DOCTOR_LOG="$DLOG" "$BASH_BIN" "$REPO4/scripts/install.sh" --target cursor >"$O" 2>"$E" || RC=$?
if [ "$RC" -eq 0 ] && [ "$(cat "$DLOG" 2>/dev/null)" = "--target cursor" ]; then ok
else bad D1-doctor-invoked "rc=$RC argv=$(cat "$DLOG" 2>/dev/null) err=$(head -c 160 "$E")"; fi

# a failing doctor is a warning: the install is already on disk and must be reported as such
REPO5="$TMP/repo5"; mkrepo "$REPO5"; mkdoctor "$REPO5" 1
H17="$TMP/h17"
run "$H17" "$REPO5" --target cursor
if [ "$RC" -eq 0 ] && grep -q "doctor reported problems (exit 1)" "$E" && [ -L "$H17/$CURSOR_LINK" ]; then ok
else bad D2-doctor-failure-warns "rc=$RC err=$(head -c 160 "$E")"; fi

echo "install-sim: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '%s' "$failures"; exit 1; fi
