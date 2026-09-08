#!/usr/bin/env bash
#
# session-theme.sh — the one home of the `# fnd:superseded` / `# fnd:session-theme` marker
# grammar: the pin that writes it, the un-pin that reverts it, and the reader that recognises a
# pinned line. Two writers that have to agree about one grammar live in one file, so they cannot
# disagree.
#
# Sourced by create-preview-theme.sh for the pin (`pin_toml`, `shared_dev_theme_ids`); run as
# `session-theme.sh unpin <toml>` by worktree-setup.sh, which shares no library and needs
# nothing but the exit code.
#
# Inputs: `pin_toml` reads its caller's `$TOML` (the config path) and `$PIN_ENV` (the target
# environment name, empty = auto) and answers through the PIN_* globals declared below.
# Everything else takes explicit parameters.
#
# The file being rewritten holds the Theme Access token: nothing here prints a line, a diff or a
# byte of it. Both rewriters preserve indentation, quoting style, trailing comments, CRLF endings
# and a missing final newline, so re-pinning the same id is a byte-for-byte no-op — which is what
# lets a skill re-enter a session and pin again without asking.
#
# Usage:
#   session-theme.sh unpin <toml>
#       → 0 = a pin was reverted; 1 = nothing to revert / absent file; 2 = usage;
#         3 = a pin is present but the rewrite failed (the file is left as it came)
#
# Sourced into a `set -euo pipefail` caller, so no shell option is set at file scope (that would
# mutate the sourcing shell) and the dispatch at the end reads nothing such a caller has not set.

# Named pin_tmpf, not mk_tmpf: create-preview-theme.sh defines its own after sourcing this file and
# would shadow it. BSD mktemp ignores $TMPDIR without a template; the bare forms are the fallback
# for an unusable one (GNU takes no argument, BSD needs -t).
pin_tmpf() { local r="${TMPDIR:-/tmp}"; mktemp "${r%/}/fnd-st.XXXXXX" 2>/dev/null || mktemp 2>/dev/null || mktemp -t fnd-st; }

# Pin $1 as the session theme — scoped to ONE environment block, because that is how the Shopify
# CLI reads this file: `shopify theme dev -e dev` takes `theme =` from `[environments.dev]`, NOT
# from the first one in the file. A file-order pin would drop the session id into whichever block
# happens to be listed first (`[environments.production]` in a real multi-env config, whose id is
# usually the LIVE theme) and leave the block the dev server reads with no theme at all.
# Which block:
#   --env <name>          → [environments.<name>]         (absent → env_not_found)
#   no [environments.*]   → the top-level keys before the first section header (reported as pin_env=-)
#   any blocks            → `dev`, else `development` — by NAME, never by count (a single block
#                           under any other name, e.g. production, is NOT auto-picked); else the
#                           top-level keys, when an uncommented top-level `theme =`/`store =`
#                           precedes the first header (pin_env=-); else ambiguous_env — refuse,
#                           never guess
# Inside that block the FIRST uncommented `theme =` line takes the new id and every LATER
# uncommented `theme =` line in the SAME block is prefixed with `# ` (value intact, uncomment to
# restore; their count is reported as `commented_dupes=`). Blocks the pin does not target are
# never touched.
# The value being replaced is not lost either: the original line is kept, commented, directly
# above the pinned one and marked `# fnd:superseded` — this file is gitignored, so once the shared
# dev theme id is overwritten it exists nowhere else. A block that ALREADY carries a real marker
# line (`# theme = … # fnd:superseded` — a stray comment merely containing the string is not one)
# keeps it untouched: the first pin's value is the one worth restoring, and re-pins must neither
# stack markers nor lose the original.
# With no uncommented `theme =` in the block, one is inserted after its `store =` line, else right
# under the block header — carrying a trailing `# fnd:session-theme` tag: the block had no
# `theme =` of its own, so there is nothing to supersede, and the tag is what lets
# the un-pin below DELETE the line and restore the original no-theme state. A re-pin of a
# different id on a tagged line swaps the value, keeps the tag and writes no marker (the line is
# session-owned).
PIN_ACTION=""; PIN_DUPES=0; PIN_OLD=""; PIN_ENV_USED=""; PIN_PATH=""; PIN_TMP=""; PIN_META=""
PIN_ERR_KEY=""; PIN_ERR_MSG=""
resolve_pin_path() {
  local d b
  d="$(dirname "$TOML")"; b="$(basename "$TOML")"
  PIN_PATH="$(cd "$d" 2>/dev/null && pwd)/$b" || PIN_PATH="$TOML"
}
pin_toml() { # $1 = theme id → 0 + PIN_ACTION=rewritten|appended|unchanged; 1 + PIN_ERR_KEY/_MSG
  local id="$1" target link hops dir tmp meta endnl mode had status envs
  resolve_pin_path
  PIN_ERR_KEY="pin_toml_failed"
  PIN_ERR_MSG="toml=$PIN_PATH — could not rewrite the \`theme =\` line (check the file's permissions and its directory's, and free disk space)"

  # Follow a symlinked config to its target: the rename below would otherwise REPLACE the link
  # with a regular file and silently unpin whatever the developer pointed it at. Bounded, so a
  # symlink cycle is a failure and not a hang.
  target="$TOML"; hops=0
  while [ -L "$target" ] && [ "$hops" -lt 16 ]; do
    link="$(readlink "$target")" || return 1
    case "$link" in /*) target="$link" ;; *) target="$(dirname "$target")/$link" ;; esac
    hops=$((hops + 1))
  done
  [ -f "$target" ] || return 1
  dir="$(dirname "$target")"

  # A file whose last byte is not a newline must not gain one — that alone would make a re-pin a
  # "change" and cost idempotence. Command substitution strips trailing newlines, so an empty
  # result means the last byte IS one.
  endnl=1
  if [ -s "$target" ] && [ -n "$(tail -c 1 "$target" 2>/dev/null)" ]; then endnl=0; fi

  # awk writes the new file to stdout and its findings (which block it chose, what it replaced) to
  # a side file: one pass owns the block resolution, so the report can never describe a different
  # rewrite than the one on disk. Nothing in it is secret — an env name, a theme id, two counts.
  meta="$(pin_tmpf)" || return 1
  PIN_META="$meta"
  # Same-directory temp + rename: rename(2) is atomic and never crosses a filesystem, so a kill
  # mid-write cannot leave the developer with a truncated (token-less) config.
  tmp="$(mktemp "$dir/.fnd-pin.XXXXXX" 2>/dev/null)" || { rm -f "$meta"; PIN_META=""; return 1; }
  PIN_TMP="$tmp"
  if ! awk -v id="$id" -v want="$PIN_ENV" -v endnl="$endnl" -v meta="$meta" '
    function emit(t) { if (started) printf "\n"; printf "%s", t; started = 1 }
    function nocr(s) { sub(/\r$/, "", s); return s }
    function valof(orig,   v, q, p, h) {
      v = nocr(orig)
      sub(/^[ \t]*theme[ \t]*=[ \t]*/, "", v)
      q = substr(v, 1, 1)
      if (q == "\"" || q == SQ) {
        v = substr(v, 2); p = index(v, q)
        if (p > 0) v = substr(v, 1, p - 1)
      } else {
        h = index(v, "#"); if (h > 0) v = substr(v, 1, h - 1)
        sub(/[ \t]+$/, "", v)
      }
      return v
    }
    function repin(orig, newid,   s, cr, pre, rest, q, p, tail) {
      s = orig; cr = ""
      if (s ~ /\r$/) { cr = "\r"; sub(/\r$/, "", s) }
      if (!match(s, /^[ \t]*theme[ \t]*=[ \t]*/)) return orig
      pre = substr(s, 1, RLENGTH); rest = substr(s, RLENGTH + 1)
      q = substr(rest, 1, 1)
      if (q == "\"" || q == SQ) {
        p = index(substr(rest, 2), q)
        tail = (p > 0) ? substr(rest, p + 2) : ""
      } else {
        match(rest, /^[^ \t#]*/)
        if (RLENGTH > 0) { q = ""; tail = substr(rest, RLENGTH + 1) }
        else { q = "\""; tail = rest }
      }
      return pre q newid q tail cr
    }
    BEGIN { SQ = "\047"; n = 0 }
    { line[++n] = $0 }
    END {
      # 1. map the uncommented section headers and the environment blocks among them
      nenv = 0; nh = 0; firsthdr = 0; envs = ""
      for (i = 1; i <= n; i++) {
        s = nocr(line[i])
        if (s ~ /^[ \t]*#/) continue
        if (s ~ /^[ \t]*\[/) {
          if (firsthdr == 0) firsthdr = i
          hline[++nh] = i
          nm = s; sub(/^[ \t]*\[[ \t]*/, "", nm); sub(/[ \t]*\].*$/, "", nm)
          if (index(nm, "environments.") == 1) {
            nenv++; ename[nenv] = substr(nm, 14); eline[nenv] = i
            envs = (envs == "") ? ename[nenv] : envs " " ename[nenv]
          }
        }
      }
      # 2. choose the block (hdr = its header line; 0 = the top-level keys). By NAME only —
      # `shopify theme dev -e <name>` resolves by name, so "there happens to be exactly one
      # block" proves nothing about which environment the dev server reads and a lone
      # [environments.production] must not be auto-picked. The top-level keys are the fallback
      # when the file actually HAS them (an uncommented theme=/store= before the first header).
      toplevel = 0
      toplim = (firsthdr > 0) ? firsthdr - 1 : n
      for (i = 1; i <= toplim; i++) {
        s = nocr(line[i])
        if (s ~ /^[ \t]*#/) continue
        if (s ~ /^[ \t]*(theme|store)[ \t]*=/) { toplevel = 1; break }
      }
      hdr = -1; used = "-"
      if (want != "") {
        for (j = 1; j <= nenv; j++) if (ename[j] == want) { hdr = eline[j]; used = want }
        if (hdr < 0) { print "status=env_not_found" > meta; print "envs=" envs > meta; exit 1 }
      } else if (nenv == 0) {
        hdr = 0
      } else {
        for (j = 1; j <= nenv; j++) if (ename[j] == "dev") { hdr = eline[j]; used = "dev" }
        if (hdr < 0) for (j = 1; j <= nenv; j++) if (ename[j] == "development") { hdr = eline[j]; used = "development" }
        if (hdr < 0 && toplevel) hdr = 0
        if (hdr < 0) { print "status=ambiguous_env" > meta; print "envs=" envs > meta; exit 1 }
      }
      if (hdr > 0) {
        rstart = hdr + 1; rend = n
        for (j = 1; j <= nh; j++) if (hline[j] > hdr) { rend = hline[j] - 1; break }
      } else {
        rstart = 1; rend = (firsthdr > 0) ? firsthdr - 1 : n
      }
      # 3. what is in that block. `marked` matches only a REAL marker line — a commented
      # `theme =` carrying the string — because a stray comment that merely mentions
      # fnd:superseded must not suppress the marker a real pin still owes the file. `tagged`
      # means the first uncommented `theme =` line is a session-owned append (trailing
      # `# fnd:session-theme`): re-pinning it swaps the value and keeps the tag, and no marker
      # is ever written for it — the original state had no `theme =` line to restore.
      first = 0; extra = 0; anchor = 0; marked = 0; tagged = 0
      for (i = rstart; i <= rend; i++) {
        s = nocr(line[i])
        if (s ~ /^[ \t]*#/) { if (s ~ /^[ \t]*#[ \t]*theme[ \t]*=.*fnd:superseded/) marked = 1; continue }
        if (s ~ /^[ \t]*theme[ \t]*=/) {
          if (first == 0) { first = i; if (s ~ /#[ \t]*fnd:session-theme[ \t]*$/) tagged = 1 }
          else extra++
          continue
        }
        if (anchor == 0 && s ~ /^[ \t]*store[ \t]*=/) anchor = i
      }
      old = ""; mark = ""; ins = ""; at = -1
      if (first > 0) {
        old = valof(line[first])
        if (old != id && marked == 0 && tagged == 0) {
          mo = line[first]; mcr = ""
          if (mo ~ /\r$/) { mcr = "\r"; sub(/\r$/, "", mo) }
          mark = "# " mo "  # fnd:superseded" mcr
        }
        line[first] = repin(line[first], id)
        for (i = first + 1; i <= rend; i++) {
          s = nocr(line[i])
          if (s ~ /^[ \t]*#/) continue
          if (s ~ /^[ \t]*theme[ \t]*=/) line[i] = "# " line[i]
        }
      } else {
        ref = (anchor > 0) ? anchor : hdr
        at = (ref > 0) ? ref : rend
        ind = ""; cr = ""
        if (ref > 0) {
          if (line[ref] ~ /\r$/) cr = "\r"
          match(line[ref], /^[ \t]*/); ind = substr(line[ref], 1, RLENGTH)
        }
        ins = ind "theme = \"" id "\" # fnd:session-theme" cr
      }
      print "status=ok" > meta
      print "env=" used > meta
      print "had=" (first > 0 ? 1 : 0) > meta
      print "commented_dupes=" extra > meta
      print "old=" old > meta
      started = 0
      if (ins != "" && at == 0) emit(ins)
      for (i = 1; i <= n; i++) {
        if (mark != "" && i == first) emit(mark)
        emit(line[i])
        if (ins != "" && i == at) emit(ins)
      }
      if (started && endnl == 1) printf "\n"
    }
  ' "$target" > "$tmp" 2>/dev/null; then
    status="$(grep '^status=' "$meta" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    envs="$(grep '^envs=' "$meta" 2>/dev/null | head -1 | cut -d= -f2- || true)"
    case "$status" in
      env_not_found)
        PIN_ERR_KEY="env_not_found"
        PIN_ERR_MSG="env='$PIN_ENV' toml=$PIN_PATH — no \`[environments.$PIN_ENV]\` block in it (present: ${envs:-none})" ;;
      ambiguous_env)
        PIN_ERR_KEY="ambiguous_env"
        PIN_ERR_MSG="envs='$envs' toml=$PIN_PATH — no environment block named \`dev\`/\`development\` and no top-level \`theme =\`/\`store =\` keys, so which block \`shopify theme dev\` reads cannot be guessed; re-run with --env <name>" ;;
    esac
    rm -f "$tmp" "$meta"; PIN_TMP=""; PIN_META=""; return 1
  fi
  [ -s "$tmp" ] || { rm -f "$tmp" "$meta"; PIN_TMP=""; PIN_META=""; return 1; }

  PIN_ENV_USED="$(grep '^env=' "$meta" | head -1 | cut -d= -f2- || true)"
  had="$(grep '^had=' "$meta" | head -1 | cut -d= -f2- || true)"
  PIN_DUPES="$(grep '^commented_dupes=' "$meta" | head -1 | cut -d= -f2- || true)"
  PIN_OLD="$(grep '^old=' "$meta" | head -1 | cut -d= -f2- || true)"
  rm -f "$meta"; PIN_META=""
  case "$PIN_DUPES" in ''|*[!0-9]*) PIN_DUPES=0 ;; esac
  # only a value that actually went away is worth reporting — the caller records it so the
  # environment can be restored without hunting the id down in the Shopify admin
  [ "$PIN_OLD" != "$id" ] || PIN_OLD=""

  if cmp -s "$tmp" "$target"; then
    rm -f "$tmp"; PIN_TMP=""; PIN_ACTION="unchanged"; return 0
  fi
  # mktemp creates 0600; a config the developer keeps at 0644 must not silently change mode.
  # GNU first: on Linux `stat -f` is a different valid command (filesystem status) that exits 0
  # with non-octal output, so BSD-first would skip the fallback and silently drop the mode.
  mode="$(stat -c '%a' "$target" 2>/dev/null || stat -f '%Lp' "$target" 2>/dev/null || true)"
  case "$mode" in ''|*[!0-7]*) ;; *) chmod "$mode" "$tmp" 2>/dev/null || true ;; esac
  mv -f "$tmp" "$target" 2>/dev/null || { rm -f "$tmp"; PIN_TMP=""; return 1; }
  PIN_TMP=""
  if [ "$had" = "1" ]; then PIN_ACTION="rewritten"; else PIN_ACTION="appended"; fi
  return 0
}

# Undo EVERY session-theme pin in a shopify.theme.toml (worktree-setup.sh copies the main
# checkout's config and runs this on the copy) — block-agnostic, because a multi-environment
# toml can carry one pin per block. The pin above leaves one of two shapes behind:
#   - a REWRITE keeps the value it replaced on the line directly ABOVE the pinned one, commented
#     and marked `# fnd:superseded` — the restore is purely local: uncomment that line (dropping
#     the marker) and comment out the session id under it. Value-preserving both ways, so nothing
#     is lost whichever theme the developer wants back. Only a real marker line (`# theme = …`
#     carrying the string) counts — a stray comment merely mentioning fnd:superseded is not one.
#   - an APPEND (the block had no `theme =` line) tags the inserted line `# fnd:session-theme` —
#     the line is session-owned and the original state had no `theme =` at all, so the restore is
#     DELETION of that line.
# A copy with neither shape (never pinned) is left exactly as it came.
# Returns 0 only when a pin was actually reverted, 1 when there was nothing to revert, 3 when a
# pin is there but the rewrite failed — the caller must not mistake that for "never pinned".
unpin_toml() { # $1 = the copied toml
  local f="$1" tmp endnl st
  [ -f "$f" ] || return 1
  grep -Eq 'fnd:(superseded|session-theme)' "$f" 2>/dev/null || return 1
  endnl=1
  if [ -s "$f" ] && [ -n "$(tail -c 1 "$f" 2>/dev/null)" ]; then endnl=0; fi
  tmp="$(pin_tmpf)" || return 3
  st=0; awk -v endnl="$endnl" '
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
  ' "$f" > "$tmp" 2>/dev/null || st=$?
  # awk's own exit 1 is "found markers, none revertable" (a stray comment); anything else is a
  # failed rewrite
  if [ "$st" -ne 0 ]; then rm -f "$tmp"; [ "$st" -eq 1 ] && return 1; return 3; fi
  [ -s "$tmp" ] || { rm -f "$tmp"; return 3; }
  # cat->, never mv: mktemp lives in $TMPDIR (a rename could cross filesystems) and the in-place
  # copy keeps the destination file's own inode and mode
  cat "$tmp" > "$f" || { rm -f "$tmp"; return 3; }
  rm -f "$tmp"
  return 0
}

# The shared dev theme ids: every id a pin superseded, plus EVERY block's settings source — its
# first uncommented `theme =` — unless that line is itself pinned (a marker above it in the same
# block, or the uncommented `# fnd:session-theme` tag, pin_toml's `tagged` test). Per block, because
# each block names its own environment's shared theme and a session pin in one of them says nothing
# about the others. Third reader of the marker/tag shapes in this file, after pin_toml writes them
# and unpin_toml reverts them.
shared_dev_theme_ids() { # $1 = toml, $2 = the id the caller read, $3/$4 = the line range it read it from
  local ids v
  ids="$(awk -v dev="$2" -v from="${3:-0}" -v to="${4:-0}" '
    function val(s,   v) {
      v = s
      sub(/^[ \t]*#?[ \t]*theme[ \t]*=[ \t]*/, "", v); sub(/[ \t]*#.*$/, "", v); gsub(/["\047 ]/, "", v)
      return v
    }
    { sub(/\r$/, "") }
    /^[ \t]*\[/ { marked = 0; first = 0; next }
    /^[ \t]*#[ \t]*theme[ \t]*=/ && /fnd:superseded/ { marked = 1; print val($0); next }
    /^[ \t]*#/ { next }
    /^[ \t]*theme[ \t]*=/ && !first {
      first = 1
      if (marked || $0 ~ /#[ \t]*fnd:session-theme[ \t]*$/) next
      print val($0)
      # the caller parsed the same line with the full scalar reader; on the block it read, its
      # value is the authority — this line-shape parse only has to cover the OTHER blocks
      if (from > 0 && NR >= from && (to == 0 || NR <= to)) print dev
    }
  ' "$1" 2>/dev/null || true)"
  for v in $ids; do case "$v" in ''|*[!0-9]*) ;; *) printf '%s\n' "$v" ;; esac; done
}

# Only an executed copy dispatches: sourced, BASH_SOURCE names this file and $0 the caller, so
# the CLI never fires inside create-preview-theme.sh's shell.
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  if [ "${1:-}" = unpin ] && [ $# -eq 2 ]; then
    unpin_toml "$2"; exit $?
  fi
  printf 'error=usage: session-theme.sh unpin <toml>\n'; exit 2
fi
