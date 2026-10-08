# Shared helpers for base's fetcher scripts (jira-attachments.sh, external-screenshots.sh,
# figma-rest.sh) — sourced, never executed (mode 644 on purpose). The credential and out-dir
# discipline they share: the dotenv reader, the 0600 curl-config writer and the "--out must be a
# path git ignores" gate.

# leading/trailing whitespace off, INNER whitespace untouched — exactly `read`'s trimming
trim_ws() { # $1 = value, result on stdout
  local v="$1"
  while :; do
    case "$v" in
      [[:space:]]*) v="${v#?}" ;;
      *[[:space:]]) v="${v%?}" ;;
      *) break ;;
    esac
  done
  printf '%s' "$v"
}

# dotenv scalar reader: LAST assignment wins (a later line overrides an earlier one), `export KEY=`
# is a legal line, values may be "…" / '…' / bare, and a bare value's trailing ` #comment` and any CR
# are dropped. The CR matters because a CRLF .env defeats a plain `s/"$//`, leaving BOTH the closing
# quote and the CR inside the token; either that or an inline comment reaching the auth header is an
# opaque 401 from the API.
dotenv_value() { # $1 = key, $2 = file
  awk -v k="$1" '
    BEGIN { SQ = "\047" }
    /^[ \t]*#/ { next }
    $0 ~ "^[ \t]*(export[ \t]+)?" k "[ \t]*=" {
      v = $0
      sub("^[ \t]*(export[ \t]+)?" k "[ \t]*=[ \t]*", "", v)
      sub(/\r$/, "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == SQ) {
        v = substr(v, 2)
        p = index(v, q)
        if (p > 0) v = substr(v, 1, p - 1)
      } else {
        h = index(v, " #"); if (h > 0) v = substr(v, 1, h - 1)
        h = index(v, "\t#"); if (h > 0) v = substr(v, 1, h - 1)
        sub(/[ \t\r]+$/, "", v)
      }
      out = v; found = 1
    }
    END { if (found) print out }
  ' "$2"
}

# --- a private curl config, and the out dir that must be a path git ignores ------------------
# Both live here because the fetchers need exactly the same discipline, and a second copy of
# either would be a second set of rules: the one that drifted would be the one nobody re-read.
# The callers own their error CHANNEL and exit codes; the messages below are the contract those
# suites assert on.

# The credential rides a file, never the argv: `ps` on a shared box reads a command line, and a
# curl config is the only place a header or a `user =` line can live without one. mktemp already
# creates 0600, and the chmod is re-applied before the first byte lands so a caller that passed a
# path of its own cannot widen it. Every directive is written as ONE line — a value carrying a
# newline would inject a second directive, which is why callers gate their values first.
curl_config_write() { # $1 = file (mktemp'd by the caller), $2… = whole directive lines
  local f="$1" line
  shift
  chmod 600 "$f" 2>/dev/null || return 1
  : > "$f" || return 1
  for line in "$@"; do
    printf '%s\n' "$line" >> "$f" || return 1
  done
  return 0
}

# Absolute and lexically normalised — the dir need not exist yet (the gate runs before mkdir), and
# `..` has to be folded away here, while the segments are still text: once resolve_phys() below
# follows the symlinks, a `..` would climb the physical tree instead of the one the caller wrote.
abs_dir() { # $1 = path
  local p="$1" out="" seg reglob=0
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  # the split below is an unquoted expansion: without `set -f` a `*` or `[…]` in a segment (of
  # --out or of $PWD) would glob against the cwd and silently re-point the download dir
  case "$-" in *f*) ;; *) reglob=1; set -f ;; esac
  local IFS=/
  for seg in $p; do
    case "$seg" in ''|.) ;; ..) out="${out%/*}" ;; *) out="$out/$seg" ;; esac
  done
  [ "$reglob" -eq 0 ] || set +f
  printf '%s' "${out:-/}"
}

# WHERE THE DIR PHYSICALLY IS. `git check-ignore` cannot look past a symbolic link — asked about a
# path under one it dies `fatal: pathspec '…' is beyond a symbolic link` (rc 128), which a bare
# `if !` reads as "not ignored". A git worktree's `.claude/tasks` IS such a symlink (worktree-
# setup.sh points it at the main checkout's), so the lexical question refused runs whose dir git
# ignores perfectly well. The nearest EXISTING ancestor is therefore resolved with `cd … && pwd -P`
# and the not-yet-existing segments are re-appended: the result names the repository that holds the
# bytes, which is the only one whose answer means anything.
resolve_phys() { # $1 = absolute lexical path → PHYS_BASE (existing, resolved) + PHYS_OUT
  local base="$1" rest=""
  while [ ! -d "$base" ]; do
    case "$base" in
      */?*) rest="${base##*/}${rest:+/$rest}"; base="${base%/*}"; [ -n "$base" ] || base=/ ;;
      *) base=/; break ;;
    esac
  done
  PHYS_BASE="$(cd "$base" 2>/dev/null && pwd -P)" || return 1
  [ -n "$PHYS_BASE" ] || return 1
  case "$rest" in
    '') PHYS_OUT="$PHYS_BASE" ;;
    *)  case "$PHYS_BASE" in /) PHYS_OUT="/$rest" ;; *) PHYS_OUT="$PHYS_BASE/$rest" ;; esac ;;
  esac
}

# git prints the common dir relative to ITS cwd when that cwd is the repo top, absolute otherwise —
# and it is resolved here too, so the two repositories the stamp rule compares are comparable.
git_common_dir() { # $1 = a dir → its repo's physical common dir on stdout, non-zero if none
  local out res
  out="$(git -C "$1" rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  case "$out" in /*) ;; *) out="$1/$out" ;; esac
  res="$(cd "$out" 2>/dev/null && pwd -P)" || return 1
  [ -n "$res" ] || return 1
  printf '%s' "$res"
}

# the one-liner task-workspace.md prescribes, with the newline care worktree-setup.sh pays: an
# exclude file whose last byte is not a newline is legal, and appending blind would glue the
# pattern onto the developer's last rule — breaking theirs and never adding ours.
stamp_exclude() { # $1 = the repo's physical common dir
  local cdir="$1" exclude
  mkdir -p "$cdir/info" 2>/dev/null || return 0
  exclude="$cdir/info/exclude"
  # the pattern is root-anchored: a deeper `.claude/tasks/` stays unignored and re-enters here on
  # every retry, so a blind append would grow the developer's file one duplicate line per run
  grep -qxF '.claude/tasks/' "$exclude" 2>/dev/null && return 0
  if [ -s "$exclude" ] && [ -n "$(tail -c 1 "$exclude" 2>/dev/null)" ]; then printf '\n' >> "$exclude"; fi
  printf '.claude/tasks/\n' >> "$exclude"
}

# THE GATE ITSELF. --out must be a path git ignores, judged at its PHYSICAL location, because
# "never reaches a commit" is a requirement and because it is what keeps a ticket that says "save
# to ~/…" inside a repo's scratch: a physical location in no repository at all is refused. Under
# `.claude/tasks/` the stamp task-workspace.md prescribes is written — only when that physical repo
# is the cwd's own (a worktree and its main checkout share one common dir, so the symlink case
# still stamps) — and the run proceeds; any other unignored dir is refused. On success the caller
# reads OUT_DIR_ABS: every later path is the PHYSICAL one, which is what was cleared here and what
# says out loud which checkout a worktree's symlinked .claude/tasks really wrote to.
OUT_DIR_ABS=""
out_dir_gate() { # $1 = the requested dir → 0 with OUT_DIR_ABS set, else 1 with the refusal on stderr
  local abs common cwd_common
  abs="$(abs_dir "$1")"
  PHYS_BASE=""; PHYS_OUT=""
  resolve_phys "$abs" || { echo "error=out_dir_not_writable out=$abs" >&2; return 1; }
  OUT_DIR_ABS="$PHYS_OUT"
  common="$(git_common_dir "$PHYS_BASE" || true)"
  [ -n "$common" ] || {
    echo "error=out_dir_not_in_repo out=$OUT_DIR_ABS (it resolves outside every git repository — use a path under .claude/tasks/ in a checkout)" >&2
    return 1
  }
  if ! git -C "$PHYS_BASE" check-ignore -q "$OUT_DIR_ABS" 2>/dev/null; then
    # the stamp is this repo's to write, so it is offered only when the bytes land in the SAME
    # repository the caller is standing in — a worktree and its main checkout share one common dir,
    # a different checkout's `.claude/tasks` gets no line from us and is refused by the re-check
    case "$OUT_DIR_ABS/" in
      */.claude/tasks/*)
        cwd_common="$(git_common_dir "$PWD" || true)"
        if [ -n "$cwd_common" ] && [ "$cwd_common" = "$common" ]; then stamp_exclude "$common"; fi ;;
    esac
    git -C "$PHYS_BASE" check-ignore -q "$OUT_DIR_ABS" 2>/dev/null || {
      echo "error=out_dir_not_ignored out=$OUT_DIR_ABS (git would track it — use a path under .claude/tasks/, or ignore it first)" >&2
      return 1
    }
  fi
  mkdir -p "$OUT_DIR_ABS" 2>/dev/null || { echo "error=out_dir_not_writable out=$OUT_DIR_ABS" >&2; return 1; }
  return 0
}
