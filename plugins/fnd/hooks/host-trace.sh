#!/bin/sh
# FND_HOST_TRACE — the host-proof log, shell half. Sourceable by every sh guard hook, and
# executable by the inline SessionStart wiring commands.
#
# Why it exists: "did this hook actually fire on this host?" could only ever be answered by a
# model reporting on itself. One JSONL line per invocation, appended by the hook itself, answers
# it from disk instead — `doctor.cjs --trace` reads the file back as an event × host matrix.
#
#   file    <spill root>/fnd-host-trace.log, spill root = FND_MCP_SLIM_DIR else
#           ${TMPDIR:-${TMP:-${TEMP:-/tmp}}} (the mirror hooks/spill-access.sh already uses);
#           rotated ONCE to fnd-host-trace.log.1 at 5 MB, like fnd-mcp-slim-debug.log.
#   record  {"ts","host","event","hook","decision","tool","agent","project"} — that key order,
#           a key whose value is unknown or empty omitted. METADATA ONLY: never a payload, never
#           command text, never prompt text, never the path of a spill.
#
# THE RULE: tracing may never change a hook's stdout, its stderr semantics or its exit code.
# Every failure is swallowed, nothing is ever printed, and fnd_trace_on_exit hands back exactly
# the status it was given.
#
# sourced — the tolerant idiom, because a partial install must never break a guard (and the
# `command -v` gate is what keeps a MISSING helper from turning into a `command not found` on the
# stderr of a hook that is contractually silent; both halves are builtins, so the cost is nil):
#   _ht="$(dirname "$0")/host-trace.sh"; [ -f "$_ht" ] && . "$_ht" 2>/dev/null
#   command -v fnd_trace_on_exit >/dev/null 2>&1 &&
#     trap 'fnd_trace_on_exit PreToolUse <hook> "$tool"' EXIT
#   fnd_trace_enabled                            0/1; resolved ONCE, cached in FND_HOST_TRACE
#   fnd_trace <event> <hook> <decision> [tool] [agent]
#   fnd_trace_on_exit <event> <hook> [tool]      as an EXIT trap:
#       trap 'fnd_trace_on_exit PreToolUse no-verify-bypass "$tool"' EXIT
#     $? is captured FIRST and mapped 0 → pass, 2 → deny, anything else → error; the status is
#     returned unchanged and the trap never exits, so it cannot alter what the guard reported.
# executed — `host-trace.sh <event> <hook> <decision> [tool] [agent]`.
#
# The switch is GLOBAL-ONLY: the process env, else $XDG_CONFIG_HOME|~/.config/domaine/env, in
# scripts/env-file.cjs's KEY=VALUE / `#`-comment / first-match-wins dialect. The project file a
# client repo can commit is NOT consulted — a repo may not arm or silence the proof of its own
# host. And the OFF path forks NOTHING (no subshell, no external command, the file read
# included): these guards run on every Bash call, so resolution is shell builtins alone.
#
# Every variable is `_fnd`-prefixed: this file is sourced INTO guards that keep their own state
# in short names (spill-access.sh's `_g`, `_e`, `_d`), and a trap firing at exit must not land in
# the middle of one of them.

# Trim ASCII whitespace off both ends of $1 into `_fndg`. Builtin-only — `sed` here would be the
# fork the off path is not allowed to pay.
_fnd_trim() {
  _fndg="${1:-}"
  while :; do case "$_fndg" in [[:space:]]*) _fndg="${_fndg#?}" ;; *) break ;; esac; done
  while :; do case "$_fndg" in *[[:space:]]) _fndg="${_fndg%?}" ;; *) break ;; esac; done
}

# The switch, resolved once per process and cached back into FND_HOST_TRACE itself as `1` / `0`,
# both of which short-circuit on every later call.
fnd_trace_enabled() {
  case "${FND_HOST_TRACE:-}" in
    1) return 0 ;;
    0) return 1 ;;
    [Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) FND_HOST_TRACE=1; return 0 ;;
    '') ;;
    *) FND_HOST_TRACE=0; return 1 ;;
  esac
  FND_HOST_TRACE=0
  # ${HOME:-}, not $HOME: a `set -u` caller must not die here on a stripped environment (cron, a
  # sandboxed exec) — a measurement helper may never take a guard down with it.
  _fndf="${XDG_CONFIG_HOME:-${HOME:-}/.config}/domaine/env"
  { [ -f "$_fndf" ] && [ -r "$_fndf" ]; } || return 1
  # `while … done < file` needs no subshell and `read` is a builtin, so the whole global-file
  # lookup stays fork-free. `IFS=` keeps the raw line; the trim below is env-file.cjs's, not the
  # shell's word splitting, so a caller's exotic IFS cannot change what this file means.
  # The braces put fd 2 on /dev/null BEFORE the input redirection is attempted: a `< file` that
  # fails reports on the *inherited* stderr, which here is a guard's model-facing verdict.
  { while IFS= read -r _fndl || [ -n "$_fndl" ]; do
    # A substring test on the raw line — a strict superset of the key match below, so first-line-
    # wins is untouched — rejects a non-matching line before it can pay for two _fnd_trim walks.
    # Without it the off path costs ~55 us per line of a global env file, on every Bash call.
    case "$_fndl" in *FND_HOST_TRACE*) ;; *) continue ;; esac
    _fnd_trim "$_fndl"; _fndl="$_fndg"
    case "$_fndl" in ''|'#'*) continue ;; esac
    case "$_fndl" in *=*) ;; *) continue ;; esac
    _fnd_trim "${_fndl%%=*}"
    [ "$_fndg" = FND_HOST_TRACE ] || continue
    _fnd_trim "${_fndl#*=}"
    case "$_fndg" in 1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) FND_HOST_TRACE=1 ;; esac
    break # first line carrying the key wins, empty value included — load()'s rule
  done < "$_fndf"; } 2>/dev/null
  [ "$FND_HOST_TRACE" = 1 ]
}

# JSON-escape $1 into `_fnde`; the fork is paid only by a value that actually carries a quote or
# a backslash, and only on the writing path. A raw control character cannot reach here: `tool`
# and `agent` are lifted out of JSON string values, where a newline is already `\n` text.
_fnd_esc() {
  case "${1:-}" in
    *\\*|*\"*) _fnde="$(printf '%s' "$1" | sed 's:\\:\\\\:g; s:":\\":g' 2>/dev/null || printf '%s' "$1")" ;;
    *) _fnde="${1:-}" ;;
  esac
}

_fnd_write() { # <event> <hook> <decision> [tool] [agent] — always returns 0
  # host: the value each host's WIRING exports. An absent or unrecognized one is `unknown` on
  # purpose — the matrix's column set is a closed vocabulary, not whatever the environment holds.
  case "${FND_HOST:-}" in
    claude|cursor|codex|opencode) _fndhost="$FND_HOST" ;;
    *) _fndhost=unknown ;;
  esac
  # BSD `date` has no %N — it prints the format back, which is the fallback's cue. No clock at
  # all ⇒ no line: a record nobody can place in time is worse than a missing one.
  _fndnow="$(date -u '+%Y-%m-%dT%H:%M:%S|%3N' 2>/dev/null || true)"
  case "$_fndnow" in *'|'*) ;; *) return 0 ;; esac
  _fndms="${_fndnow#*|}"; _fndts="${_fndnow%%|*}"
  case "$_fndms" in ''|*[!0-9]*) _fndms=000 ;; esac
  _fndts="$_fndts.${_fndms}Z"

  _fnddir="${FND_MCP_SLIM_DIR:-}"
  [ -n "$_fnddir" ] || _fnddir="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"
  [ "$_fnddir" = / ] || _fnddir="${_fnddir%/}"

  # project: json-slim's projectName() walk — nearest `.git` above the cwd, else the cwd — and a
  # BASENAME, never a path, because the log is a per-user file several projects share.
  _fndd="${PWD:-.}"; _fndi=0; _fndroot=""
  while [ "$_fndi" -lt 64 ]; do
    if [ -e "$_fndd/.git" ]; then _fndroot="$_fndd"; break; fi
    _fndp="${_fndd%/*}"; [ -n "$_fndp" ] || _fndp=/
    [ "$_fndp" != "$_fndd" ] || break
    _fndd="$_fndp"; _fndi=$((_fndi+1))
  done
  [ -n "$_fndroot" ] || _fndroot="${PWD:-.}"
  _fndproj="${_fndroot##*/}"
  [ -n "$_fndproj" ] || _fndproj="$_fndroot"

  _fnd_esc "${1:-}"; _fndline="{\"ts\":\"$_fndts\",\"host\":\"$_fndhost\",\"event\":\"$_fnde\""
  _fnd_esc "${2:-}"; _fndline="$_fndline,\"hook\":\"$_fnde\""
  _fnd_esc "${3:-}"; _fndline="$_fndline,\"decision\":\"$_fnde\""
  if [ -n "${4:-}" ]; then _fnd_esc "$4"; _fndline="$_fndline,\"tool\":\"$_fnde\""; fi
  if [ -n "${5:-}" ]; then _fnd_esc "$5"; _fndline="$_fndline,\"agent\":\"$_fnde\""; fi
  _fnd_esc "$_fndproj"; _fndline="$_fndline,\"project\":\"$_fnde\"}"

  _fndlog="$_fnddir/fnd-host-trace.log"
  [ -d "$_fnddir" ] || mkdir -p "$_fnddir" 2>/dev/null || return 0
  # Braces, again: a trailing `2>/dev/null` is applied to the command's fds only AFTER the shell
  # has opened `<`/`>>` and already reported the failure on the stderr it inherited. An unreadable
  # or read-only log must cost this hook nothing but its own line — never a word on a guard's
  # stderr, which on the commit guards IS the verdict and on spill-access is contractually empty.
  if [ -f "$_fndlog" ] && [ "$({ wc -c < "$_fndlog"; } 2>/dev/null || echo 0)" -ge 5242880 ]; then
    mv -f "$_fndlog" "$_fndlog.1" 2>/dev/null || true
  fi
  # First writer creates the file 0600 (the node half's mode) — a subshell for the umask, paid
  # once per log, only on the writing path.
  [ -f "$_fndlog" ] || ( umask 077; : >> "$_fndlog" ) 2>/dev/null || true
  { printf '%s\n' "$_fndline" >> "$_fndlog"; } 2>/dev/null || true
  return 0
}

fnd_trace() { # <event> <hook> <decision> [tool] [agent]
  fnd_trace_enabled || return 0
  _fnd_write "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}"
}

fnd_trace_on_exit() { # <event> <hook> [tool] — EXIT trap; maps $? and preserves it
  _fndst=$? # FIRST, before anything else can overwrite it
  if fnd_trace_enabled; then
    case "$_fndst" in
      0) _fnd_write "${1:-}" "${2:-}" pass "${3:-}" "" ;;
      2) _fnd_write "${1:-}" "${2:-}" deny "${3:-}" "" ;;
      *) _fnd_write "${1:-}" "${2:-}" error "${3:-}" "" ;;
    esac
  fi
  # `return`, never `exit`: a trap that exits REPLACES the guard's verdict, and this one exists
  # to observe it. Handing the status back also keeps `set -e` callers unchanged.
  return "$_fndst"
}

# Executed rather than sourced (the inline SessionStart wiring commands). $0, never BASH_SOURCE:
# the guards that source this file are #!/bin/sh, where BASH_SOURCE does not exist. zsh sets $0
# to the SOURCED file's name too, so its own context variable settles that case first.
case "${ZSH_EVAL_CONTEXT:-}" in
  *:file*) ;;
  *) case "$0" in
       *host-trace.sh) fnd_trace "${1:-}" "${2:-}" "${3:-}" "${4:-}" "${5:-}"; exit 0 ;;
     esac ;;
esac
