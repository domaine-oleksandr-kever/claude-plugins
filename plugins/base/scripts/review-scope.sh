#!/usr/bin/env bash
#
# review-scope.sh — the branch's review scope and its hash, for base's review flow
# (references/review-flow.md §1): the `.git/.base-review` marker compares `diff_hash`, the review
# agents read the file list.
#
# Base: --base <ref> when given; else the candidate nearest HEAD (fewest commits from its merge-base
# to HEAD; a tie keeps the earlier) of develop, main and every release/* branch, by name. Each name
# resolves to origin/<b> when the local <b> is missing or only behind it (a stale local branch gives an
# old merge-base and foreign files in scope); a local <b> with commits of its own wins.
#
# Scope: ONE diff from the merge-base to the WORKING TREE — committed, staged, unstaged and untracked
# work alike. A throwaway copy of the index (`<git-dir>/base-review-index`, rebuilt every run) marks
# untracked, not-ignored files (listed in `<git-dir>/base-review-untracked`) intent-to-add, so each diffs as the new file it becomes once staged (same hash
# before and after `git add`); the real index is never touched. Untracked files under .claude/ or
# docs/technical-approaches/ and any .env* file or dir / settings.local.json stay out, name and body.
#
# --ws <dir> (the task workspace, `.claude/tasks/<work-id>`, relative to the repo root): the
# `build-dirtied:` lines of its notes.md since the last bare one (no paths) name tracked files a
# preview build rewrote, and their working-tree rewrite leaves the scope: a file whose index equals
# the merge-base leaves it whole; one with a committed or staged change (the developer's, or an
# artifact `git add -A` swept in) stays in, diffed merge-base → index. Only a token that is exactly
# a tracked file's path counts.
#
# Usage:
#   review-scope.sh [--base <ref>] [--ws <dir>]  → branch= base= merge_base= diff_hash= excluded=
#                                                   then a blank line and the scope's files, one a line
#   review-scope.sh [--ws <dir>] --diff          → the scope diff itself
#   review-scope.sh [--ws <dir>] --since <rev>   → the scope's --stat against <rev>, a blank line,
#                                                   and the files changed since <rev>
#   review-scope.sh [--ws <dir>] --check         → one line: marker=<verdict> branch= marker_branch=
#                                                   diff_hash= marker_hash= — the `.base-review` marker
#                                                   against this branch and scope: fresh (same branch,
#                                                   same hash) · stale (same branch, other hash) ·
#                                                   other-branch · none (no marker file)
#
# Every form takes --base <ref> (any ref `git rev-parse` resolves to a commit). `excluded=` lists the build-dirtied paths out of the scope whole, space-separated. Runs from any
# directory of the checkout, linked worktrees included.
#
# Exit: 0 ok · 2 usage or a bad --base · 3 not a git checkout, or no develop / main / release/* to
# diff against.
set -u

USAGE='usage: review-scope.sh [--base <ref>] [--ws <dir>] [--diff | --since <rev> | --check]'
die() { printf 'review-scope: %s\n' "$1" >&2; exit "$2"; }

ws=; mode=list; since=; base=
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) printf '%s\n' "$USAGE"; exit 0 ;;
    --ws) [ $# -ge 2 ] || die "--ws needs a value" 2; ws=$2; shift 2 ;;
    --ws=*) ws=${1#--ws=}; shift ;;
    --base) [ $# -ge 2 ] && [ -n "$2" ] || die "--base needs a ref" 2; base=$2; shift 2 ;;
    --base=*) base=${1#--base=}; [ -n "$base" ] || die "--base needs a ref" 2; shift ;;
    --diff) mode=diff; shift ;;
    --check) mode=check; shift ;;
    --since) [ $# -ge 2 ] && [ -n "$2" ] || die "--since needs a rev" 2; mode=since; since=$2; shift 2 ;;
    --since=*) mode=since; since=${1#--since=}; [ -n "$since" ] || die "--since needs a rev" 2; shift ;;
    *) die "unknown argument: $1
$USAGE" 2 ;;
  esac
done

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git checkout" 3
gitdir=$(git rev-parse --absolute-git-dir) || die "not inside a git checkout" 3
cd "$top" || die "cannot enter $top" 3

branch=$(git rev-parse --abbrev-ref HEAD)
if [ -n "$base" ]; then
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || die "not a ref: $base" 2
else
  best=
  while read -r b; do
    [ -n "$b" ] || continue
    if git show-ref --verify --quiet "refs/remotes/origin/$b" \
       && { ! git show-ref --verify --quiet "refs/heads/$b" || git merge-base --is-ancestor "$b" "origin/$b"; }; then
      c="origin/$b"
    elif git show-ref --verify --quiet "refs/heads/$b"; then c=$b
    else continue; fi
    m=$(git merge-base "$c" HEAD) || continue
    n=$(git rev-list --count "$m..HEAD")
    if [ -z "$best" ] || [ "$n" -lt "$best" ]; then base=$c; best=$n; fi
  done <<EOF
develop
main
$(git for-each-ref --format='%(refname)' refs/remotes/origin/release/ refs/heads/release/ \
  | sed -e 's#^refs/remotes/origin/##' -e 's#^refs/heads/##' | sort -u)
EOF
  [ -n "$base" ] || die "no develop or main branch, nor release/* (local or origin), to diff against" 3
fi
mb=$(git merge-base "$base" HEAD) || die "no merge-base between $base and HEAD" 3

idx="$gitdir/base-review-index"
if [ -f "$gitdir/index" ]; then cp "$gitdir/index" "$idx"; else rm -f "$idx"; fi
keep=(':/' ':(top,exclude).claude/' ':(top,exclude)docs/technical-approaches/' \
  ':(top,exclude,glob)**/.env*' ':(top,exclude,glob)**/.env*/**' ':(top,exclude,glob)**/settings.local.json')
new="$gitdir/base-review-untracked"
GIT_INDEX_FILE="$idx" git ls-files -z --others --exclude-standard -- "${keep[@]}" > "$new"
[ ! -s "$new" ] || GIT_INDEX_FILE="$idx" git --literal-pathspecs add -N --pathspec-from-file="$new" --pathspec-file-nul

ex=(); staged=(); excluded=; dirty=
notes="${ws%/}/notes.md"
if [ -n "$ws" ] && [ -f "$notes" ]; then
  while read -r dash day kind rest || [ -n "${kind:-}" ]; do
    if [ "${kind:-}" = build-dirtied: ]; then
      if [ -n "${rest:-}" ]; then dirty="$dirty $rest"; else dirty=; fi
    fi
  done < "$notes"
fi
set -f
for p in $dirty; do
  case " ${ex[*]+${ex[*]}} " in *" :(top,literal,exclude)$p "*) continue ;; esac
  [ "$(git -c core.quotePath=false ls-files --full-name -- ":(top,literal)$p" 2>/dev/null)" = "$p" ] || continue
  ex+=(":(top,literal,exclude)$p")
  if GIT_INDEX_FILE="$idx" git diff --cached --quiet "$mb" -- ":(top,literal)$p"; then
    excluded="${excluded:+$excluded }$p"
  else
    staged+=(":(top,literal)$p")
  fi
done
set +f

# scope <rev> [<diff option>…] — rev → working tree outside the build-dirtied files, then rev → index for
# the ones with a change of their own; $qp unquotes non-ASCII names in a listing, never in the hash
qp=
scope() {
  local rev=$1; shift
  GIT_INDEX_FILE="$idx" git $qp diff "$@" "$rev" -- ':/' ${ex[@]+"${ex[@]}"}
  [ ${#staged[@]} -eq 0 ] || GIT_INDEX_FILE="$idx" git $qp diff "$@" --cached "$rev" -- "${staged[@]}"
}

case "$mode" in
  diff) scope "$mb" ;;
  since)
    git rev-parse --verify --quiet "$since^{commit}" >/dev/null || die "not a commit: $since" 2
    qp='-c core.quotePath=false'
    scope "$since" --stat; echo; scope "$since" --name-only | sort -u ;;
  check)
    hash=$(scope "$mb" | git hash-object --stdin)
    marker="$gitdir/.base-review"; mbranch=; mhash=
    if [ -f "$marker" ]; then
      mbranch=$(sed -n 's/^branch=//p' "$marker" | head -n 1); mhash=$(sed -n 's/^diff_hash=//p' "$marker" | head -n 1)
      if [ "$mbranch" != "$branch" ]; then verdict=other-branch
      elif [ "$mhash" = "$hash" ]; then verdict=fresh
      else verdict=stale; fi
    else verdict=none; fi
    printf 'marker=%s branch=%s marker_branch=%s diff_hash=%s marker_hash=%s\n' \
      "$verdict" "$branch" "$mbranch" "$hash" "$mhash" ;;
  *)
    hash=$(scope "$mb" | git hash-object --stdin)
    qp='-c core.quotePath=false'
    printf 'branch=%s\nbase=%s\nmerge_base=%s\ndiff_hash=%s\nexcluded=%s\n\n' \
      "$branch" "$base" "$mb" "$hash" "$excluded"
    scope "$mb" --name-only | sort -u ;;
esac
