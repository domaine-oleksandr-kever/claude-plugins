#!/usr/bin/env bash
#
# worktree-setup.sh — prepare an isolated `git worktree` so one long run (a `/fnd:ship`
# pipeline, say) can occupy its own checkout, its own dev-server port and its own Claude
# session while the MAIN checkout stays free for other work.
#
# MODEL: code is isolated, the task workspace is SHARED. The worktree gets its own branch,
# its own directory, its own node_modules and its own copies of the gitignored config a fresh
# checkout cannot have — shopify.theme.toml (the preview script's `pin` / `--pin-toml` rewrites
# the `theme =` line in that copy, so this worktree's session preview theme is the one its dev
# server syncs into; a pin the SOURCE checkout had made is undone in the copy, so this stream
# starts from the shared dev theme rather than inheriting another one's) and .env (the Admin API
# token every store read needs). But
# `<worktree>/.claude/tasks` is a SYMLINK to `<main>/.claude/tasks`, so both sessions read and
# write one cache — and removing the worktree cannot take the cache with it (the link is
# dropped before the removal, so nothing walking the tree can reach the shared workspaces
# through it).
#
# Run FROM the client theme repo (any checkout of it), never from the plugin repo: the
# plugin is installed elsewhere, so the repo is resolved with `git rev-parse` and nothing
# here is derived from $0.
#
# Usage:
#   worktree-setup.sh <WORK-ID> [<base-branch>]                      (default base: develop)
#       → worktree=… branch=… base=… branch_source=… reused=… npm=… toml=… env=…
#         settings=… workspace=… dev_port=…   followed by the hand-off block
#   worktree-setup.sh --remove <WORK-ID> [--force]
#       → removed=… branch=… branch_kept=… workspace_kept=…
#
# <WORK-ID> is a Jira ticket key (`ABC-123`) or a kebab-case slug (`header-refactor`) — the
# same work-id the task workspace uses; not every worktree is ticket-shaped.
#
# Remove mode refuses a dirty worktree — or one on a detached HEAD, whose commits nothing else
# points at — unless --force, never deletes the branch, never
# touches the preview theme (the orphan reaper in create-preview-theme.sh owns that) and
# never deletes `.claude/tasks/<WORK-ID>/` (it lives in the main checkout).
#
# Output is `key=value` lines on stdout; non-fatal problems print `warn=<reason>`. Errors
# print `error=<reason>` on STDOUT — as create-preview-theme.sh does, because the calling
# skill relays this output to the developer verbatim — and exit 1.
# Requires: git. npm only when the repo has a package.json.

set -euo pipefail
# The work-id validation below relies on glob bracket ranges ([A-Z], [!a-z0-9-]); under a UTF-8
# collating locale some shells match those by collation order, which lets mixed-case ids like
# ABC-12a through as "slugs" — and the id becomes a branch and directory name.
export LC_ALL=C

BASE_DEFAULT="develop"
# 9292 is the Shopify CLI default and belongs to the main checkout's dev server; every
# worktree takes the next free port above it.
PORT_FIRST=9293
PORT_LAST=9312

USAGE='usage: worktree-setup.sh <WORK-ID> [<base-branch>] | worktree-setup.sh --remove <WORK-ID> [--force]'

fail() { printf 'error=%s\n' "$1"; exit 1; }
warn() { printf 'warn=%s\n' "$1"; }
# git's own message is the only thing that says WHY the operation failed, so it is relayed as a
# one-line `cause=` (the skill pastes this output to the developer) with the full log kept on disk.
fail_with_log() { # fail_with_log <logfile> <reason>
  printf 'cause=%s\n' "$(tr '\n' ' ' < "$1" | cut -c1-200)"
  printf 'log=%s\n' "$1"
  fail "$2"
}

# The hand-off block is pasted into a shell verbatim, and a repo checked out under a path with
# a space would otherwise turn `cd <path> && claude` into a `cd` with three arguments — the
# developer then launches claude in whatever directory they were already in, i.e. the main
# checkout, which is the one outcome this script exists to prevent.
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

TMPROOT="${TMPDIR:-/tmp}"; TMPROOT="${TMPROOT%/}"
mk_tmpf() { mktemp "$TMPROOT/fnd-wt.XXXXXX" 2>/dev/null || mktemp -t fnd-wt; }

# Undo EVERY session-theme pin in a freshly copied shopify.theme.toml (see the copy site below) —
# block-agnostic, because a multi-environment toml can carry one pin per block.
# create-preview-theme.sh's pin leaves one of two shapes behind:
#   - a REWRITE keeps the value it replaced on the line directly ABOVE the pinned one, commented
#     and marked `# fnd:superseded` — the restore is purely local: uncomment that line (dropping
#     the marker) and comment out the session id under it. Value-preserving both ways, so nothing
#     is lost whichever theme the developer wants back. Only a real marker line (`# theme = …`
#     carrying the string) counts — a stray comment merely mentioning fnd:superseded is not one.
#   - an APPEND (the block had no `theme =` line) tags the inserted line `# fnd:session-theme` —
#     the line is session-owned and the original state had no `theme =` at all, so the restore is
#     DELETION of that line.
# A copy with neither shape (never pinned) is left exactly as it came.
# Returns 0 only when a pin was actually reverted. Never prints a line of the file: it holds the
# Theme Access token.
unpin_toml() { # $1 = the copied toml
  local f="$1" tmp endnl
  [ -f "$f" ] || return 1
  grep -Eq 'fnd:(superseded|session-theme)' "$f" 2>/dev/null || return 1
  endnl=1
  if [ -s "$f" ] && [ -n "$(tail -c 1 "$f" 2>/dev/null)" ]; then endnl=0; fi
  tmp="$(mk_tmpf)" || return 1
  if ! awk -v endnl="$endnl" '
    function emit(t) { if (started) printf "\n"; printf "%s", t; started = 1 }
    { line[++n] = $0 }
    END {
      changed = 0
      for (i = 1; i <= n; i++) {
        s = line[i]; sub(/\r$/, "", s)
        if (s ~ /^[ \t]*#?[ \t]*theme[ \t]*=/ && s ~ /#[ \t]*fnd:session-theme[ \t]*$/) {
          del[i] = 1; changed = 1; continue
        }
        if (i == n || s !~ /fnd:superseded/ || s !~ /^[ \t]*#[ \t]*theme[ \t]*=/) continue
        t = line[i + 1]; u = t; sub(/\r$/, "", u)
        if (u ~ /^[ \t]*#/ || u !~ /^[ \t]*theme[ \t]*=/) continue
        r = line[i]; cr = ""
        if (r ~ /\r$/) { cr = "\r"; sub(/\r$/, "", r) }
        sub(/[ \t]*#[ \t]*fnd:superseded[ \t]*$/, "", r)
        sub(/^#[ \t]?/, "", r)
        line[i] = r cr
        line[i + 1] = "# " t
        changed = 1
        i++   # the pinned line is handled — do not re-read it as a marker candidate
      }
      if (changed == 0) exit 1
      started = 0
      for (i = 1; i <= n; i++) if (!(i in del)) emit(line[i])
      if (started && endnl == 1) printf "\n"
    }
  ' "$f" > "$tmp" 2>/dev/null; then
    rm -f "$tmp"; return 1
  fi
  [ -s "$tmp" ] || { rm -f "$tmp"; return 1; }
  # cat->, never mv: mktemp lives in $TMPDIR (a rename could cross filesystems) and the in-place
  # copy keeps the destination file's own inode and mode
  cat "$tmp" > "$f" || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  return 0
}

# --- args --------------------------------------------------------------------
MODE="create"; WORK_ID=""; BASE=""; FORCE=0; POS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) MODE="remove"; shift ;;
    --force)  FORCE=1; shift ;;
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
[ -n "$BASE" ] || BASE="$BASE_DEFAULT"

# Ticket key or kebab slug, decided with `case` globs: bash 3.2's `[[ =~ ]]` quoting rules
# differ from 4.x and this script must run on stock macOS bash.
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

# --- repo layout -------------------------------------------------------------
command -v git >/dev/null 2>&1 || fail "git not found on PATH"

TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$TOP" ] || fail "not_a_git_repo — run this from the theme repo (no git checkout at $(pwd))"

# `--show-toplevel` is THIS checkout, which may already be a linked worktree; the sibling
# directory and the shared `.claude/tasks` must both hang off the MAIN checkout. Its git dir is
# the COMMON dir, printed relative to the cwd when it is relative — hence the `cd "$TOP"`.
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
# task-workspace reference documents (`.claude/tasks/`, trailing slash) matches directories only
# — a symlink is not one. Unstamped, the ship run's "git add every new file" pass stages a link
# holding an absolute path from one machine, or the whole shared workspace, into a client PR. No
# trailing slash here, so one line covers both the link and the main checkout's real directory;
# `info/exclude` lives in the COMMON git dir, so one stamp serves every worktree.
ensure_tasks_excluded() { # $1 = a checkout to ask check-ignore in
  if git -C "$1" check-ignore -q .claude/tasks 2>/dev/null; then return 0; fi
  mkdir -p "$CDIR/info"
  local exclude="$CDIR/info/exclude"
  # An exclude file whose last byte is not a newline is legal and not rare (hand-edited ones
  # often are), and appending blind would glue `.claude/tasks` onto the developer's last pattern:
  # their rule breaks AND the workspace stays unexcluded. `$( )` strips trailing newlines, so a
  # non-empty result means the last byte was not one.
  if [ -s "$exclude" ] && [ -n "$(tail -c 1 "$exclude" 2>/dev/null)" ]; then
    printf '\n' >> "$exclude"
  fi
  printf '.claude/tasks\n' >> "$exclude"
}

# One-time migration from the workspace's pre-rename home: existing per-ticket memory
# follows the rename; never merged into a `.claude/tasks` that already exists.
if [ -d "$MAIN/.claude/fnd" ] && [ ! -L "$MAIN/.claude/fnd" ] && [ ! -e "$MAIN/.claude/tasks" ]; then
  mv "$MAIN/.claude/fnd" "$MAIN/.claude/tasks"
  # Worktrees created before the rename hold `<wt>/.claude/fnd -> <main>/.claude/fnd`, which the
  # mv above turns into a dangling link: the session working there would silently start a second,
  # private workspace and the two forks would never meet again. Each one is re-pointed under its
  # new name — a fresh `<wt>/.claude/tasks` link, the legacy link dropped only once its
  # replacement exists. A compat `fnd -> tasks` link in MAIN was the alternative and is not taken:
  # `.claude/fnd` is not in the exclude line below, so it would be one more untracked link for a
  # bulk `git add` to stage. The never-merge rule of the mv applies here too — a worktree that
  # already has a real `.claude/tasks` is left exactly as it is.
  git -C "$MAIN" worktree list --porcelain 2>/dev/null | while IFS= read -r wtline; do
    case "$wtline" in 'worktree '*) ;; *) continue ;; esac
    owt="${wtline#worktree }"
    [ -L "$owt/.claude/fnd" ] || continue
    [ ! -e "$owt/.claude/tasks" ] || continue
    if ln -s "$MAIN/.claude/tasks" "$owt/.claude/tasks" 2>/dev/null; then
      rm -f "$owt/.claude/fnd"
    fi
  done || true
  # The migration also runs in --remove mode, where the create-mode stamp below never happens:
  # a workspace renamed by a teardown and left unexcluded is one bulk `git add` away from a
  # client PR. Stamped wherever the rename itself runs.
  ensure_tasks_excluded "$MAIN"
fi

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
# git's metadata behind, and reading HEAD from the (now missing) directory would call a perfectly
# intact feat/<WORK-ID> "detached". Directory first, metadata second.
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

# Uncommitted work in the worktree, MINUS the paths this script put there: the `.claude`
# wiring and the copied shopify.theme.toml / .env are untracked by design (both carry
# credentials, so repos gitignore them). git's own `worktree remove` counts them and
# refuses — which would make EVERY clean worktree look dirty — so dirtiness is decided here
# and git is then told `--force`. Kept a function, not an inline `$(… | while …)`: bash 3.2
# mis-parses a `case` inside a command substitution.
# `-uall` is load-bearing: the default collapses an untracked directory to `.claude/`, and a
# skip list matching that swallows everything under it — the QA notes a developer keeps in
# `.claude/` would be deleted by --remove without ever appearing on a `dirty=` line. Hence the
# skips below name the exact paths this script creates and nothing else.
dirty_lines() {
  local line p
  git -C "$WT" status --porcelain -uall 2>/dev/null | while IFS= read -r line; do
    p="$(printf '%s' "$line" | cut -c4-)"
    case "$line" in
      '?? '*)
        case "$p" in
          .claude/tasks|.claude/settings.local.json|shopify.theme.toml|.env|node_modules/*) continue ;;
        esac
        ;;
    esac
    printf '%s\n' "$p"
  done
}

# --- remove mode -------------------------------------------------------------
if [ "$MODE" = "remove" ]; then
  wt_registered "$WT" || fail "worktree_not_found path=$WT (git worktree list knows nothing there)"

  # Report the branch the worktree is REALLY on, read before the removal: a developer who
  # switched branches inside it would otherwise be told `feat/<WORK-ID>` was kept while the
  # branch that actually holds the work goes unmentioned.
  BRANCH_REPORT="$(wt_branch_of "$WT")"
  [ -d "$WT" ] || warn "worktree_dir_missing path=$WT (the directory is already gone; only git's registration is being cleaned up)"

  if [ -z "$BRANCH_REPORT" ]; then
    # A detached HEAD is held by NOTHING but this worktree's own HEAD and reflog, and
    # `git worktree remove` deletes both — every commit made here (a mid-rebase amend, a bisect
    # fixup, a quick "save point") becomes unreachable at once. That is the one removal this
    # script must not do quietly.
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
  # descending through it (verified), so this is belt-and-braces — but the link points at the
  # main checkout's `.claude/tasks`, and a delete that ever followed it would take EVERY task
  # workspace in the repo with it. Cheap insurance for an irreversible loss.
  LINK_DROPPED=0
  if [ -L "$WT/.claude/tasks" ]; then rm -f "$WT/.claude/tasks"; LINK_DROPPED=1; fi

  RMLOG="$(mk_tmpf)"
  if ! git_main worktree remove --force "$WT" >"$RMLOG" 2>&1; then
    # The worktree directory outlives the failed removal (git may or may not have kept its
    # registration), so the link back to the shared task workspace has to go back — without it
    # a session working there silently starts its own `.claude/tasks` and the two forks of the
    # workspace never meet again.
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
# its fetch/ls-remote would be a round trip nobody asked for — and a spurious `warn=fetch_failed`
# on every re-entry of an offline session.
REUSED=false
if wt_registered "$WT"; then
  REUSED=true
elif [ -e "$WT" ]; then
  fail "worktree_path_taken path=$WT (something is already there and git does not know it as a worktree)"
fi

# --- dev port ----------------------------------------------------------------
# Picked BEFORE `worktree add`: a port problem used to surface at the very end, after the
# worktree, the npm install and the config copies were all in place, and the `exit 1` then left
# a registered worktree nobody cleaned up and a re-run that hit `worktree_path_taken`.
#
# Free-port probe without a dependency: bash's own /dev/tcp redirection when this bash was
# built with net redirections (stock macOS bash 3.2 was), else `nc -z`. A refused connection and
# a bash without the feature both fail the redirect, so each mechanism is asked once, on
# loopback port 1, and told apart by its MESSAGE — the exit status alone cannot separate "port
# closed" from "I do not know that option". When neither works the scan still returns a port,
# but says so (`warn=port_probe_unavailable`) instead of passing a guess off as a check.
# Never probe a hostname — a DNS stall would hang the scan.
PROBE=devtcp
DEVTCP_MSG="$( ( exec 3<>/dev/tcp/127.0.0.1/1 ) 2>&1 || true )"
case "$DEVTCP_MSG" in
  *'not supported'*|*'No such file'*|*'no such file'*)
    PROBE=none
    if command -v nc >/dev/null 2>&1; then
      # `-z` is a BSD flag some ncat builds reject, and an option error is indistinguishable
      # from a refused connection by exit status alone — so ask once, on loopback port 1, and
      # read the message.
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
# that took it is still registered — otherwise every work-id ever started would burn a port for
# good and the range would be exhausted after ~20 tickets with nothing listening anywhere.
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
# The recorded port is sticky for the SAME worktree — a re-entry must hand back the number the
# running dev server already uses. But the workspace outlives the worktree by design, so after
# a --remove the stale line is still there: a fresh create re-probes and keeps the old number
# only while it is still free.
if [ -n "$PORT" ] && [ "$REUSED" = "false" ] && ! port_free "$PORT"; then PORT=""; fi
PORT_FROM_NOTES=true
if [ -z "$PORT" ]; then
  PORT_FROM_NOTES=false
  p="$PORT_FIRST"
  while [ "$p" -le "$PORT_LAST" ]; do
    # "Nothing is listening" is not enough: the dev servers are started later, by hand, in the
    # new sessions, so at setup time NOTHING is listening and two worktrees created a minute
    # apart would both be handed 9293. A port another live worktree recorded is taken.
    if port_free "$p" && ! port_recorded "$p"; then PORT="$p"; break; fi
    p=$((p + 1))
  done
  if [ -z "$PORT" ]; then
    # Every port is claimed by a live worktree. The claim is bookkeeping, not evidence — a
    # worktree whose dev server was never started holds nothing — so the second pass trusts the
    # live probe alone rather than refusing to set the worktree up at all.
    p="$PORT_FIRST"
    while [ "$p" -le "$PORT_LAST" ]; do
      if port_free "$p"; then PORT="$p"; break; fi
      p=$((p + 1))
    done
    [ -z "$PORT" ] || \
      warn "port_range_crowded range=$PORT_FIRST-$PORT_LAST — every port is claimed by another worktree, so dev_port=$PORT may collide with one of them; start that worktree's dev server first if both run at once"
  fi
  [ -n "$PORT" ] || fail "no_free_port range=$PORT_FIRST-$PORT_LAST (something is listening on every port in the range — stop a stale dev server, then re-run)"
  [ "$PROBE" != "none" ] || \
    warn "port_probe_unavailable — this bash has no /dev/tcp and there is no usable \`nc\`, so dev_port=$PORT was picked without checking whether anything is listening; if the dev server refuses to bind, start it on another port (\`shopify theme dev --port <n>\`) and note that in the workspace"
fi

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
  # silently orphan whatever a colleague already pushed, so the remote-tracking ref already on
  # disk is the second witness — and the `remote` arm below tolerates a failing fetch.
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
    # `ls-remote` only proves the branch exists on the server; the remote-tracking ref it is
    # checked out from has to be on disk, and a plain `fetch origin <branch>` is not
    # guaranteed to write one.
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
else
  # Re-entry: the worktree already exists, and nothing here moves it back onto feat/<WORK-ID>.
  # Report what it is on — a developer who renamed or switched branches inside it must not be
  # told the run continues on a branch it left.
  BRANCH_REPORT="$(wt_branch_of "$WT")"
  if [ -z "$BRANCH_REPORT" ]; then
    BRANCH_REPORT=detached
    warn "worktree_detached path=$WT (no branch checked out there)"
  elif [ "$BRANCH_REPORT" != "$BRANCH" ]; then
    warn "branch_switched expected=$BRANCH actual=$BRANCH_REPORT (the worktree was moved off the branch this script created)"
  fi
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

TOML=missing
TOML_UNPINNED=no
if [ -f "$WT/shopify.theme.toml" ]; then TOML=kept
elif [ -f "$MAIN/shopify.theme.toml" ]; then
  # A COPY, never a link: the preview script pins this worktree's session theme id into this
  # file (`pin` / `--pin-toml`) and must not repoint the main checkout's dev environment.
  cp "$MAIN/shopify.theme.toml" "$WT/shopify.theme.toml"; TOML=copied
  # …and the source is routinely a pinned config itself (the main checkout ran its own ship).
  # Inheriting THAT stream's session theme is worse than inheriting nothing: it is what this
  # worktree's first `create` would pull customizer settings from, so another ticket's
  # half-edited preview would land on this one's theme (and a `create` after that theme was
  # deleted fails naming an id nobody here has heard of). The pin left the superseded line
  # behind for exactly this — restore it and re-comment the session id.
  if unpin_toml "$WT/shopify.theme.toml"; then TOML_UNPINNED=yes; fi
else
  warn "no_shopify_theme_toml — the worktree has no store config; copy one in before pushing a preview theme"
fi

# `.env` is gitignored for the same reason the toml is — it holds SHOPIFY_ADMIN_TOKEN, which
# shopify-admin-gql.sh reads relative to the CWD. Without this copy every store read from the
# worktree fails with `no_admin_token` and the run silently degrades to no store access, on a
# ticket that would have had it in the main checkout. Copied only when the worktree has none,
# so a re-entry never clobbers a locally-edited one.
ENV_STATE=missing
if [ -f "$WT/.env" ]; then ENV_STATE=kept
elif [ -f "$MAIN/.env" ]; then cp "$MAIN/.env" "$WT/.env"; ENV_STATE=copied
fi

mkdir -p "$MAIN/.claude/tasks"
mkdir -p "$WT/.claude"
LINK="$WT/.claude/tasks"
if [ -L "$LINK" ]; then rm -f "$LINK"
elif [ -e "$LINK" ]; then
  fail "claude_tasks_not_a_symlink path=$LINK (a real directory is in the way — move it aside; the worktree has to share the main checkout's task workspaces)"
fi
ln -s "$MAIN/.claude/tasks" "$LINK"
# The new link is asked about in the WORKTREE — check-ignore answers per checkout, and this is
# the one the ship run's `git add` pass will run in.
ensure_tasks_excluded "$WT"

SETTINGS=absent
if [ -f "$WT/.claude/settings.local.json" ]; then SETTINGS=kept
elif [ -f "$MAIN/.claude/settings.local.json" ]; then
  # Copied, not shared: two sessions approving permissions would write the same file
  # concurrently and lose each other's approvals.
  cp "$MAIN/.claude/settings.local.json" "$WT/.claude/settings.local.json"; SETTINGS=copied
fi

# The port lives in the SHARED workspace, so the session that runs in the worktree finds it
# in `.claude/tasks/<WORK-ID>/notes.md` — the same append-only log every skill already reads.
if [ "$PORT_FROM_NOTES" = "false" ] || [ "$REUSED" = "false" ]; then
  [ -f "$NOTES" ] || printf '# %s — notes\n\n' "$WORK_ID" > "$NOTES"
  printf -- '- %s worktree `%s` on branch `%s`, dev-port: %s\n' \
    "$(date +%Y-%m-%d)" "$WT" "$BRANCH_REPORT" "$PORT" >> "$NOTES"
fi

printf 'worktree=%s\n' "$WT"
printf 'branch=%s\n' "$BRANCH_REPORT"
printf 'base=%s\n' "$BASE"
printf 'branch_source=%s\n' "$BRANCH_SOURCE"
printf 'reused=%s\n' "$REUSED"
printf 'npm=%s\n' "$NPM"
printf 'toml=%s\n' "$TOML"
printf 'toml_unpinned=%s\n' "$TOML_UNPINNED"
printf 'env=%s\n' "$ENV_STATE"
printf 'settings=%s\n' "$SETTINGS"
printf 'workspace=%s\n' "$WORKSPACE"
printf 'dev_port=%s\n' "$PORT"

printf '\nnext:\n'
printf '  cd %s && claude\n' "$(shq "$WT")"
if [ "$KIND" = "ticket" ]; then
  printf '  # then inside that session:  /fnd:ship %s\n' "$WORK_ID"
else
  printf '  # then inside that session: start the work there\n'
fi
# The port alone is half the isolation — a dev server started without --theme syncs this branch
# into the SHARED dev theme the copied config names. The skill fills the id in once the session
# theme is settled; naming the flag here keeps the verbatim block from advertising the unsafe form.
printf '  # dev server:  npm run dev -- --theme <session-theme-id> --port %s\n' "$PORT"
printf '  # this checkout (%s) stays free — the worktree needs its OWN terminal and session\n' "$MAIN"
