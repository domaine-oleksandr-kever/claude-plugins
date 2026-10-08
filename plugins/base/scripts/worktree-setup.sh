#!/usr/bin/env bash
#
# worktree-setup.sh — prepare an isolated `git worktree` so one long run can occupy its own
# checkout, its own dev-server port and its own Claude session while the MAIN checkout stays free
# for other work.
#
# MODEL: code is isolated, the task workspace is SHARED. The worktree gets its own branch, its own
# directory, its own node_modules and its own copies of the gitignored files a fresh checkout
# cannot have — the paths the caller names with --copy (the team plugin's `worktree copy list:`
# line: a store config, a `.env` with credentials). A copy, never a link: a tool that rewrites its
# config in one checkout must not repoint the other. But `<worktree>/.claude/tasks` is a SYMLINK
# to `<main>/.claude/tasks`, so both sessions read and write one cache — and removing the worktree
# cannot take the cache with it (the link is dropped before the removal, so nothing walking the
# tree can reach the shared workspaces through it).
#
# Run FROM the project repo (any checkout of it), never from the plugin repo: the plugin is
# installed elsewhere, so the repo is resolved with `git rev-parse`, never from $0.
#
# The dev port is picked before `worktree add` and recorded in the shared workspace right after
# it, before `npm ci` — a parallel setup started during the install sees the claim.
#
# Usage:
#   worktree-setup.sh <WORK-ID> [<base-branch>] [--copy <path>]…      (default base: develop)
#       → worktree=… branch=… base=… branch_source=… reused=… npm=… copied=… kept=… missing=…
#         settings=… workspace=… dev_port=…   followed by the hand-off block
#   worktree-setup.sh --remove <WORK-ID> [--force]
#       → removed=… branch=… branch_kept=… workspace_kept=…
#
# <WORK-ID> is a Jira ticket key (`ABC-123`) or a kebab-case slug (`header-refactor`) — the same
# work-id the task workspace uses; not every worktree is ticket-shaped.
#
# --copy <path> (repeatable): a repo-relative file or directory copied from the main checkout into
# the worktree when the worktree has none (`copied=`), left alone when it has one (`kept=`), and
# named in `missing=` when the main checkout has none either. The files it copies are recorded in
# the worktree's own git dir, so --remove does not count them as uncommitted work while they still
# match the main checkout's. `.git`, `.claude`, `.claude/tasks` and `.claude/settings.local.json`
# are refused.
#
# Remove mode refuses a dirty worktree — or one on a detached HEAD, whose commits nothing else
# points at — unless --force, never deletes the branch and never deletes
# `.claude/tasks/<WORK-ID>/` (it lives in the main checkout).
#
# Output is `key=value` lines on stdout; non-fatal problems print `warn=<reason>`. Errors print
# `error=<reason>` on STDOUT, because the calling skill relays this output to the developer
# verbatim, and exit 1. Requires: git. npm only when the repo has a package.json.

set -euo pipefail
# The work-id validation below relies on glob bracket ranges ([A-Z], [!a-z0-9-]); under a UTF-8
# collating locale some shells match those by collation order, which lets mixed-case ids like
# ABC-12a through as "slugs" — and the id becomes a branch and directory name.
export LC_ALL=C

DEFAULT_BASE="develop"
# The main checkout's dev server keeps 9292 (Shopify CLI's default); every worktree takes the next
# free port above it.
PORT_FIRST=9293
PORT_LAST=9312
COPIES_FILE="base-worktree-copies"

USAGE='usage: worktree-setup.sh <WORK-ID> [<base-branch>] [--copy <path>]… | worktree-setup.sh --remove <WORK-ID> [--force]'

fail() { printf 'error=%s\n' "$1"; exit 1; }
warn() { printf 'warn=%s\n' "$1"; }
# git's own message is the only thing that says WHY the operation failed, so it is relayed as a
# one-line `cause=` with the full log kept on disk.
fail_with_log() { # fail_with_log <logfile> <reason>
  printf 'cause=%s\n' "$(tr '\n' ' ' < "$1" | cut -c1-200)"
  printf 'log=%s\n' "$1"
  fail "$2"
}

# The hand-off block is pasted into a shell verbatim: a repo under a path with a space would
# otherwise turn `cd <path> && claude` into a `cd` with three arguments, and claude would start in
# the main checkout — the one outcome this script exists to prevent.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

TMPROOT="${TMPDIR:-/tmp}"; TMPROOT="${TMPROOT%/}"
mk_tmpf() { mktemp "$TMPROOT/base-wt.XXXXXX" 2>/dev/null || mktemp -t base-wt; }

# --- args --------------------------------------------------------------------
MODE="create"; WORK_ID=""; BASE=""; FORCE=0; POS=0; COPIES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) MODE="remove"; shift ;;
    --force)  FORCE=1; shift ;;
    --copy)
      [ $# -ge 2 ] || fail "--copy needs a path ($USAGE)"
      cp_arg="$2"
      while [ "${cp_arg%/}" != "$cp_arg" ]; do cp_arg="${cp_arg%/}"; done
      [ -n "$cp_arg" ] || fail "invalid_copy_path path='$2' (expected a path relative to the repo root)"
      COPIES="${COPIES}${cp_arg}
"
      shift 2 ;;
    -h|--help) printf '%s\n' "$USAGE"; exit 0 ;;
    -*) fail "unknown arg: $1 ($USAGE)" ;;
    *)
      POS=$((POS + 1))
      case "$POS" in
        1) WORK_ID="$1" ;;
        2) BASE="$1" ;;
        *) fail "too many arguments ($USAGE)" ;;
      esac
      shift ;;
  esac
done

[ -n "$WORK_ID" ] || fail "$USAGE"
[ -n "$BASE" ] || BASE="$DEFAULT_BASE"

# Ticket key or kebab slug, decided with `case` globs: bash 3.2's `[[ =~ ]]` quoting rules differ
# from 4.x and this script must run on stock macOS bash.
work_id_kind() { # prints ticket | slug ; empty when the id is neither
  local id="$1" head rest
  [ -n "$id" ] || return 0
  case "$id" in *-*)
    head="${id%%-*}"; rest="${id#*-}"
    case "$head" in [A-Z][A-Z0-9]*)
      case "$head" in *[!A-Z0-9]*) ;; *)
        case "$rest" in ''|*[!0-9]*) ;; *) printf 'ticket'; return 0 ;; esac ;;
      esac ;;
    esac ;;
  esac
  case "$id" in
    *[!a-z0-9-]*|-*|*-|*--*) return 0 ;;
  esac
  printf 'slug'
}

KIND="$(work_id_kind "$WORK_ID")"
[ -n "$KIND" ] || fail "invalid_work_id id='$WORK_ID' (expected a ticket key like ABC-123 or a kebab-case slug like header-refactor)"

case "$BASE" in
  ''|-*|*' '*|*'~'*|*'^'*|*':'*|*'?'*|*'*'*|*'['*|*'\'*)
    fail "invalid_base base='$BASE' (expected a branch name)" ;;
esac

# A copy path is repo-relative and stays inside the checkout: it is joined onto both the main
# checkout and the worktree, and `cp -R` follows it wherever it points.
while IFS= read -r cp_path; do
  [ -n "$cp_path" ] || continue
  case "/$cp_path/" in
    //*|*/../*|*/./*|*//*) fail "invalid_copy_path path='$cp_path' (expected a path relative to the repo root, with no . or .. segment)" ;;
  esac
  # Lower-cased: a case-insensitive file system resolves `.Claude/Tasks` to the shared workspace.
  case "$(printf '%s' "$cp_path" | tr '[:upper:]' '[:lower:]')" in
    .git|.git/*|.claude|.claude/tasks|.claude/tasks/*|.claude/settings.local.json)
      fail "invalid_copy_path path='$cp_path' (git's own files, the .claude wiring this script sets up and the shared task workspace are never copied)" ;;
  esac
done <<EOF
$COPIES
EOF

# --- repo layout -------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git not found on PATH"

TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$TOP" ] || fail "not_a_git_repo — run this from the project repo (no git checkout at $(pwd))"

# `--show-toplevel` is THIS checkout, which may already be a linked worktree; the sibling
# directory and the shared `.claude/tasks` must both hang off the MAIN checkout. Its git dir is the
# COMMON dir, printed relative to the cwd when it is relative — hence the `cd "$TOP"`.
CDIR="$(cd "$TOP" && git rev-parse --git-common-dir 2>/dev/null || true)"
[ -n "$CDIR" ] || fail "not_a_git_repo — git reported no common git dir for $TOP"
case "$CDIR" in /*) ;; *) CDIR="$TOP/$CDIR" ;; esac
MAIN="$(cd "$CDIR/.." 2>/dev/null && pwd -P || true)"
[ -n "$MAIN" ] || fail "main_checkout_not_found common_dir=$CDIR (a bare repo has no worktree to hang siblings off)"
# A submodule (or a `--separate-git-dir` checkout) keeps its common dir under
# `<super>/.git/modules/<name>`, so the parent directory is INSIDE .git — creating the sibling
# worktree and the shared `.claude/tasks` there would bury both in git's own plumbing.
[ -e "$MAIN/.git" ] || \
  fail "unsupported_layout main=$MAIN common_dir=$CDIR (the git dir does not sit beside a working tree — submodules and --separate-git-dir checkouts cannot host a sibling worktree)"

# `.claude/tasks` is untracked in every checkout that has one, and the exclude line the
# task-workspace reference documents (`.claude/tasks/`, trailing slash) matches directories only —
# a symlink is not one. Unstamped, a bulk `git add` stages a link holding an absolute path from one
# machine. No trailing slash here, so one line covers both the link and the main checkout's real
# directory; `info/exclude` lives in the COMMON git dir, so one stamp serves every worktree.
ensure_tasks_excluded() { # $1 = a checkout to ask check-ignore in
  if git -C "$1" check-ignore -q .claude/tasks 2>/dev/null; then return 0; fi
  mkdir -p "$CDIR/info"
  local exclude="$CDIR/info/exclude"
  # An exclude file whose last byte is not a newline is legal, and appending blind would glue
  # `.claude/tasks` onto the developer's last pattern. `$( )` strips trailing newlines, so a
  # non-empty result means the last byte was not one.
  if [ -s "$exclude" ] && [ -n "$(tail -c 1 "$exclude" 2>/dev/null)" ]; then
    printf '\n' >> "$exclude"
  fi
  printf '.claude/tasks\n' >> "$exclude"
}

REPO="$(basename "$MAIN")"
WT="$(dirname "$MAIN")/$REPO-$WORK_ID"
BRANCH="feat/$WORK_ID"
WORKSPACE="$MAIN/.claude/tasks/$WORK_ID"

git_main() { git -C "$MAIN" "$@"; }

wt_registered() { # 0 = $1 is a worktree git knows about
  git_main worktree list --porcelain 2>/dev/null | grep -Fqx "worktree $1"
}

branch_worktree() { # prints the worktree path holding $1 checked out (empty when none)
  git_main worktree list --porcelain 2>/dev/null | awk -v b="branch refs/heads/$1" '
    /^worktree /{ p = substr($0, 10) } $0 == b { print p; exit }'
}

wt_meta() { # prints the value git RECORDS for field $2 (HEAD | branch) of the worktree at $1
  git_main worktree list --porcelain 2>/dev/null | awk -v w="worktree $1" -v k="$2" '
    $0 == w { f = 1; next }
    f && $1 == k { print $2; exit }
    f && $0 == "" { exit }'
}

# The registration outlives the directory: a developer who `rm -rf`s the worktree by hand leaves
# git's metadata behind, and reading HEAD from the missing directory would call an intact
# feat/<WORK-ID> "detached". Directory first, metadata second.
wt_branch_of() { # the branch the worktree at $1 has checked out (empty = detached)
  local b
  b="$(git -C "$1" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -z "$b" ]; then b="$(wt_meta "$1" branch)"; b="${b#refs/heads/}"; fi
  printf '%s' "$b"
}

wt_head_sha() { # the commit the worktree at $1 is on (empty when git knows neither)
  local s
  s="$(git -C "$1" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$s" ] || s="$(wt_meta "$1" HEAD)"
  printf '%s' "$s"
}

# The worktree's own git dir (`<common>/worktrees/<name>`): the copy list recorded there goes
# away with the worktree.
wt_gitdir() { git -C "$WT" rev-parse --absolute-git-dir 2>/dev/null || true; }

# Uncommitted work in the worktree, MINUS the paths this script put there: the `.claude` wiring
# and the copied paths are untracked by design. git's own `worktree remove` counts them and
# refuses — which would make EVERY clean worktree look dirty — so dirtiness is decided here and
# git is then told `--force`. `-uall` is load-bearing: the default collapses an untracked directory
# to `.claude/`, and a skip list matching that would swallow notes a developer keeps in `.claude/`.
COPIED_BEFORE=""
is_copied() { # 0 = $1 is a file this script copied, byte for byte as the main checkout still has it
  printf '%s\n' "$COPIED_BEFORE" | grep -Fqx -- "$1" || return 1
  [ -f "$MAIN/$1" ] && [ ! -L "$WT/$1" ] && cmp -s "$WT/$1" "$MAIN/$1"
}
dirty_lines() {
  local line p gd
  gd="$(wt_gitdir)"
  [ -z "$gd" ] || [ ! -f "$gd/$COPIES_FILE" ] || COPIED_BEFORE="$(cat "$gd/$COPIES_FILE")"
  git -C "$WT" status --porcelain -uall 2>/dev/null | while IFS= read -r line; do
    p="$(printf '%s' "$line" | cut -c4-)"
    case "$line" in
      '?? '*)
        case "$p" in
          .claude/tasks|.claude/settings.local.json|node_modules/*) continue ;;
        esac
        if is_copied "$p"; then continue; fi
        ;;
    esac
    printf '%s\n' "$p"
  done
}

# --- remove mode -------------------------------------------------------------
if [ "$MODE" = "remove" ]; then
  wt_registered "$WT" || fail "worktree_not_found path=$WT (git worktree list knows nothing there)"

  # The branch the worktree is REALLY on, read before the removal: a developer who switched
  # branches inside it must not be told feat/<WORK-ID> was kept while the branch that holds the
  # work goes unmentioned.
  BRANCH_REPORT="$(wt_branch_of "$WT")"
  [ -d "$WT" ] || warn "worktree_dir_missing path=$WT (the directory is already gone; only git's registration is being cleaned up)"

  if [ -z "$BRANCH_REPORT" ]; then
    # A detached HEAD is held by NOTHING but this worktree's own HEAD and reflog, and
    # `git worktree remove` deletes both — every commit made here becomes unreachable at once.
    HEAD_SHA="$(wt_head_sha "$WT")"
    [ -n "$HEAD_SHA" ] || HEAD_SHA=unknown
    [ "$FORCE" -eq 1 ] || \
      fail "worktree_detached path=$WT head=$HEAD_SHA (no branch holds that commit — removing the worktree drops its HEAD and reflog with it; create a branch inside the worktree first, or re-run with --force)"
    warn "detached_head_removed head=$HEAD_SHA (nothing points at that commit any more — \`git branch <name> $HEAD_SHA\` recovers it until git prunes it)"
  fi

  DIRTY="$(dirty_lines || true)"

  if [ -n "$DIRTY" ] && [ "$FORCE" -eq 0 ]; then
    printf 'dirty=%s\n' "$(printf '%s' "$DIRTY" | tr '\n' ' ')"
    fail "worktree_dirty path=$WT (commit or stash the work inside the worktree, or re-run with --force)"
  fi

  # Drop the LINK before the removal. `git worktree remove` unlinks a symlink instead of
  # descending through it, but the link points at the main checkout's `.claude/tasks`, and a
  # delete that ever followed it would take EVERY task workspace in the repo with it.
  LINK_DROPPED=0
  if [ -L "$WT/.claude/tasks" ]; then rm -f "$WT/.claude/tasks"; LINK_DROPPED=1; fi

  RMLOG="$(mk_tmpf)"
  if ! git_main worktree remove --force "$WT" >"$RMLOG" 2>&1; then
    # The directory outlives the failed removal, so the link back to the shared task workspace
    # goes back — without it a session working there silently starts its own `.claude/tasks`.
    if [ "$LINK_DROPPED" -eq 1 ] && [ -d "$WT/.claude" ] && [ ! -L "$WT/.claude/tasks" ]; then
      ln -s "$MAIN/.claude/tasks" "$WT/.claude/tasks" 2>/dev/null || \
        warn "claude_tasks_link_not_restored path=$WT/.claude/tasks (re-create it by hand before working in the worktree again)"
    fi
    fail_with_log "$RMLOG" "worktree_remove_failed path=$WT"
  fi
  rm -f "$RMLOG"
  git_main worktree prune >/dev/null 2>&1 || true

  printf 'removed=%s\n' "$WT"
  if [ -n "$BRANCH_REPORT" ]; then
    printf 'branch=%s\n' "$BRANCH_REPORT"
    printf 'branch_kept=true\n'
  else
    printf 'branch=detached\n'
    printf 'branch_kept=false\n'
  fi
  if [ -d "$WORKSPACE" ]; then printf 'workspace_kept=%s\n' "$WORKSPACE"
  else printf 'workspace_kept=none\n'; fi
  exit 0
fi

# --- create mode -------------------------------------------------------------
[ -n "$(git_main config --get remote.origin.url || true)" ] || \
  fail "no_origin — this repo has no \`origin\` remote to branch off"

# Re-entry is decided BEFORE the network calls below: an idempotent re-run creates no branch, so
# its fetch/ls-remote would be a round trip nobody asked for.
REUSED=false
if wt_registered "$WT"; then
  REUSED=true
elif [ -e "$WT" ]; then
  fail "worktree_path_taken path=$WT (something is already there and git does not know it as a worktree)"
fi

# --- dev port ----------------------------------------------------------------
# Picked BEFORE `worktree add`, so a port problem stops the run before anything exists; recorded
# right AFTER it (see the call site): only a registered worktree's claim counts for others.
#
# Free-port probe without a dependency: bash's own /dev/tcp redirection when this bash was built
# with net redirections (stock macOS bash 3.2 was), else `nc -z`. A refused connection and a bash
# without the feature both fail the redirect, so each mechanism is asked once, on loopback port 1,
# and told apart by its MESSAGE. When neither works the scan still returns a port, but says so
# (`warn=port_probe_unavailable`). Never probe a hostname — a DNS stall would hang the scan.
PROBE=devtcp
DEVTCP_MSG="$( ( exec 3<>/dev/tcp/127.0.0.1/1 ) 2>&1 || true )"
case "$DEVTCP_MSG" in
  *'not supported'*|*'No such file'*|*'no such file'*)
    PROBE=none
    if command -v nc >/dev/null 2>&1; then
      # `-z` is a BSD flag some ncat builds reject, and an option error is indistinguishable from
      # a refused connection by exit status alone.
      case "$( nc -z 127.0.0.1 1 2>&1 || true )" in
        *sage*|*'llegal option'*|*'nrecognized'*|*'nvalid option'*|*'nknown option'*) ;;
        *) PROBE=nc ;;
      esac
    fi ;;
esac
port_free() { # 0 = nothing is listening on 127.0.0.1:$1 — and 0 when there is no way to ask
  case "$PROBE" in
    devtcp) if ( exec 3<>"/dev/tcp/127.0.0.1/$1" ) >/dev/null 2>&1; then return 1; fi ;;
    nc)     if nc -z 127.0.0.1 "$1" >/dev/null 2>&1; then return 1; fi ;;
  esac
  return 0
}

# The dev-ports other work-ids hold, one per line. A workspace OUTLIVES its worktree by design
# (--remove keeps `.claude/tasks/<WORK-ID>/`), so a recorded port counts only while the worktree
# that took it is still registered — otherwise every finished work-id would burn a port for good.
ports_taken() {
  local n id live
  live="$(git_main worktree list --porcelain 2>/dev/null | grep '^worktree ' || true)"
  for n in "$MAIN"/.claude/tasks/*/notes.md; do
    [ -f "$n" ] || continue
    [ "$n" != "$NOTES" ] || continue
    id="$(basename "$(dirname "$n")")"
    printf '%s\n' "$live" | grep -Fqx "worktree $(dirname "$MAIN")/$REPO-$id" || continue
    grep -oE 'dev-port: [0-9]+' "$n" 2>/dev/null | tr -cd '0-9\n'
  done
}
port_recorded() { printf '%s\n' "$PORTS_TAKEN" | grep -qx "$1"; }

mkdir -p "$WORKSPACE"
NOTES="$WORKSPACE/notes.md"
PORTS_TAKEN="$(ports_taken || true)"
PORT=""
if [ -f "$NOTES" ]; then
  PORT="$(grep -oE 'dev-port: [0-9]+' "$NOTES" | tail -1 | tr -dc '0-9' || true)"
fi
# The recorded port is sticky for the SAME worktree — a re-entry hands back the number the running
# dev server already uses. After a --remove the stale line is still there: a fresh create keeps
# the old number only while it is still free.
if [ -n "$PORT" ] && [ "$REUSED" = "false" ] && ! port_free "$PORT"; then PORT=""; fi
# Sets PORT and PORT_PASS (1 = free and unrecorded, 2 = recorded but nothing listening).
pick_port() {
  local p="$PORT_FIRST"
  PORT=""; PORT_PASS=1
  while [ "$p" -le "$PORT_LAST" ]; do
    # "Nothing is listening" is not enough: the dev servers start later, by hand, in the new
    # sessions, so two worktrees created a minute apart would both get 9293. A port another live
    # worktree recorded is taken.
    if port_free "$p" && ! port_recorded "$p"; then PORT="$p"; break; fi
    p=$((p + 1))
  done
  if [ -z "$PORT" ]; then
    # Every port is claimed by a live worktree. The claim is bookkeeping, not evidence, so the
    # second pass trusts the live probe alone rather than refusing the setup.
    PORT_PASS=2
    p="$PORT_FIRST"
    while [ "$p" -le "$PORT_LAST" ]; do
      if port_free "$p"; then PORT="$p"; break; fi
      p=$((p + 1))
    done
    [ -z "$PORT" ] || \
      warn "port_range_crowded range=$PORT_FIRST-$PORT_LAST — every port is claimed by another worktree, so dev_port=$PORT may collide with one of them; start that worktree's dev server first if both run at once"
  fi
  [ -n "$PORT" ] || fail "no_free_port range=$PORT_FIRST-$PORT_LAST (something is listening on every port in the range — stop a stale dev server, then re-run)"
}
# The port lives in the SHARED workspace, so the session that runs in the worktree finds it in
# `.claude/tasks/<WORK-ID>/notes.md`.
record_port() {
  [ -f "$NOTES" ] || printf '# %s — notes\n\n' "$WORK_ID" > "$NOTES"
  printf -- '- %s worktree `%s` on branch `%s`, dev-port: %s\n' \
    "$(date +%Y-%m-%d)" "$WT" "$BRANCH_REPORT" "$PORT" >> "$NOTES"
}
PORT_FROM_NOTES=true
PORT_PASS=1
if [ -z "$PORT" ]; then PORT_FROM_NOTES=false; pick_port; fi

# --- branch and worktree ------------------------------------------------------
BRANCH_SOURCE=existing
BRANCH_REPORT="$BRANCH"
if [ "$REUSED" = "false" ]; then
  git_main fetch --quiet origin "$BASE" >/dev/null 2>&1 || \
    warn "fetch_failed base=$BASE (offline? continuing with the refs already on disk)"

  HAS_LOCAL=0
  if git_main show-ref --verify --quiet "refs/heads/$BRANCH"; then HAS_LOCAL=1; fi
  HAS_REMOTE=0
  # `ls-remote` is a live call, so offline / VPN down / an expired credential helper all make it
  # fail. Concluding "no such branch" from that would fork a fresh feat/<WORK-ID> off the base and
  # orphan what a colleague already pushed, so the remote-tracking ref on disk is the second witness.
  if git_main ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1 \
     || git_main show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then HAS_REMOTE=1; fi

  OTHER="$(branch_worktree "$BRANCH" || true)"
  [ -z "$OTHER" ] || fail "branch_checked_out_elsewhere branch=$BRANCH path=$OTHER (one branch, one worktree — remove that one first)"

  ADDLOG="$(mk_tmpf)"; rc=0
  if [ "$HAS_LOCAL" -eq 1 ]; then
    BRANCH_SOURCE=local
    git_main worktree add "$WT" "$BRANCH" >"$ADDLOG" 2>&1 || rc=$?
  elif [ "$HAS_REMOTE" -eq 1 ]; then
    BRANCH_SOURCE=remote
    # `ls-remote` only proves the branch exists on the server; a plain `fetch origin <branch>` is
    # not guaranteed to write the remote-tracking ref it is checked out from.
    git_main fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" >/dev/null 2>&1 || true
    if git_main show-ref --verify --quiet "refs/remotes/origin/$BRANCH"; then
      git_main worktree add --track -b "$BRANCH" "$WT" "origin/$BRANCH" >"$ADDLOG" 2>&1 || rc=$?
    else
      rc=1; printf 'origin/%s could not be fetched\n' "$BRANCH" > "$ADDLOG"
    fi
  else
    BRANCH_SOURCE=created
    if git_main show-ref --verify --quiet "refs/remotes/origin/$BASE"; then BASEREF="origin/$BASE"
    elif git_main show-ref --verify --quiet "refs/heads/$BASE"; then BASEREF="$BASE"
    else fail "base_not_found base=$BASE (no origin/$BASE and no local $BASE — pass the base branch as the second argument)"; fi
    git_main worktree add -b "$BRANCH" "$WT" "$BASEREF" >"$ADDLOG" 2>&1 || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then fail_with_log "$ADDLOG" "worktree_add_failed path=$WT"; fi
  rm -f "$ADDLOG"
  # Registered now, so competing setups count this worktree: re-verify the bookkeeping and claim
  # the port BEFORE npm ci (a pass-2 pick is recorded by construction, so it is not re-picked).
  PORTS_TAKEN="$(ports_taken || true)"
  if [ "$PORT_PASS" -eq 1 ] && port_recorded "$PORT"; then PORT_FROM_NOTES=false; pick_port; fi
  record_port
else
  # Re-entry: nothing here moves the worktree back onto feat/<WORK-ID>. Report what it is on.
  BRANCH_REPORT="$(wt_branch_of "$WT")"
  if [ -z "$BRANCH_REPORT" ]; then
    BRANCH_REPORT=detached
    warn "worktree_detached path=$WT (no branch checked out there)"
  elif [ "$BRANCH_REPORT" != "$BRANCH" ]; then
    warn "branch_switched expected=$BRANCH actual=$BRANCH_REPORT (the worktree was moved off the branch this script created)"
  fi
  [ "$PORT_FROM_NOTES" = "true" ] || record_port
fi
if [ "$PROBE" = "none" ] && [ "$PORT_FROM_NOTES" = "false" ]; then
  warn "port_probe_unavailable — this bash has no /dev/tcp and there is no usable \`nc\`, so dev_port=$PORT was picked without checking whether anything is listening; if the dev server refuses to bind, start it on another port and note that in the workspace"
fi

NPM=skipped
if [ "$REUSED" = "false" ] && [ -f "$WT/package.json" ]; then
  if command -v npm >/dev/null 2>&1; then
    NPMLOG="$(mk_tmpf)"
    if (cd "$WT" && npm ci) >"$NPMLOG" 2>&1; then NPM=installed; rm -f "$NPMLOG"
    else NPM=failed; warn "npm_ci_failed log=$NPMLOG (install by hand inside the worktree)"; fi
  else
    NPM=no_npm; warn "npm_not_found — install dependencies inside the worktree yourself"
  fi
fi

# The copy list. Copied only when the worktree has none, so a re-entry never clobbers a file the
# worktree's own tools have since rewritten.
COPIED=""; KEPT=""; MISSING=""; COPIED_FILES=""
join() { if [ -n "$1" ]; then printf '%s,%s' "$1" "$2"; else printf '%s' "$2"; fi; }
while IFS= read -r cp_path; do
  [ -n "$cp_path" ] || continue
  if [ -e "$WT/$cp_path" ] || [ -L "$WT/$cp_path" ]; then KEPT="$(join "$KEPT" "$cp_path")"
  elif [ -e "$MAIN/$cp_path" ]; then
    mkdir -p "$(dirname "$WT/$cp_path")"
    if cp -R "$MAIN/$cp_path" "$WT/$cp_path"; then
      COPIED="$(join "$COPIED" "$cp_path")"
      COPIED_FILES="${COPIED_FILES}$(cd "$WT" && find "$cp_path" -type f)
"
    else warn "copy_failed path=$cp_path"; fi
  else MISSING="$(join "$MISSING" "$cp_path")"
  fi
done <<EOF
$COPIES
EOF
GD="$(wt_gitdir)"
if [ -n "$GD" ]; then
  # The files this script put there, merged with an earlier run's list. A kept path, and a file a
  # developer adds under a copied directory, are never on it.
  { [ ! -f "$GD/$COPIES_FILE" ] || cat "$GD/$COPIES_FILE"; printf '%s' "$COPIED_FILES"; } \
    | awk 'NF && !seen[$0]++' > "$GD/$COPIES_FILE.tmp" && mv "$GD/$COPIES_FILE.tmp" "$GD/$COPIES_FILE"
fi

mkdir -p "$MAIN/.claude/tasks"
mkdir -p "$WT/.claude"
LINK="$WT/.claude/tasks"
if [ -L "$LINK" ]; then rm -f "$LINK"
elif [ -e "$LINK" ]; then
  fail "claude_tasks_not_a_symlink path=$LINK (a real directory is in the way — move it aside; the worktree has to share the main checkout's task workspaces)"
fi
ln -s "$MAIN/.claude/tasks" "$LINK"
# Asked in the WORKTREE: check-ignore answers per checkout, and this is the one a bulk `git add`
# will run in.
ensure_tasks_excluded "$WT"

SETTINGS=absent
if [ -f "$WT/.claude/settings.local.json" ]; then SETTINGS=kept
elif [ -f "$MAIN/.claude/settings.local.json" ]; then
  # Copied, not shared: two sessions approving permissions would write the same file
  # concurrently and lose each other's approvals.
  cp "$MAIN/.claude/settings.local.json" "$WT/.claude/settings.local.json"; SETTINGS=copied
fi

printf 'worktree=%s\n' "$WT"
printf 'branch=%s\n' "$BRANCH_REPORT"
printf 'base=%s\n' "$BASE"
printf 'branch_source=%s\n' "$BRANCH_SOURCE"
printf 'reused=%s\n' "$REUSED"
printf 'npm=%s\n' "$NPM"
printf 'copied=%s\n' "${COPIED:-none}"
printf 'kept=%s\n' "${KEPT:-none}"
printf 'missing=%s\n' "${MISSING:-none}"
printf 'settings=%s\n' "$SETTINGS"
printf 'workspace=%s\n' "$WORKSPACE"
printf 'dev_port=%s\n' "$PORT"

printf '\nnext:\n'
printf '  cd %s && claude\n' "$(shq "$WT")"
printf '  # then inside that session: start the work there — the task workspace .claude/tasks/%s is shared\n' "$WORK_ID"
printf '  # dev server: start it on port %s\n' "$PORT"
printf '  # this checkout (%s) stays free — the worktree needs its OWN terminal and session\n' "$MAIN"
