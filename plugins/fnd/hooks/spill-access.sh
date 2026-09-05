#!/bin/sh
# PreToolUse hook (matcher: Bash / Read / Grep) — MEASUREMENT ONLY, it never blocks a call, never
# prints to stdout and never alters tool input; any internal failure just exits 0.
#
# Why it exists: `json-slim --report` calls a platform-overflow whale MISSED when no later json-slim
# run compressed it, so reading that spill with anything else counted as a miss — the real case
# (ELC, 2026-08-25) was three targeted `jq` queries over a 236 KB tool-results file, which is exactly
# the right move. This hook records that SOME tool touched a spill, and --report pairs the two.
#
# stdin: PreToolUse event JSON ({tool_name, tool_input:{command | file_path | pattern,path}, cwd}).
# `command` is a STRING on Claude Code / Cursor / OpenCode and an ARGV ARRAY on Codex's shell tools;
# every match below runs over the raw text of the tool_input slice, so both spellings read the same.
#
# Switches, read with the Domaine env-file precedence (process env > nearest
# <cwd-or-ancestor>/.claude/domaine.env > $XDG_CONFIG_HOME|~/.config/domaine/env) — env_get mirrors
# scripts/env-file.cjs's KEY=VALUE / `#`-comment / first-line-wins / no-dequoting rules:
#   FND_SPILL_ACCESS   default 1; "0" disables the hook (the wiring pre-gates on it too).
#   FND_MCP_SLIM_DEBUG unset/"0" → write nothing (the log is a debug artefact); "1"/"2" → write,
#                      stamped as `lvl` the way json-slim's debugLevel() reads it.
#   FND_MCP_SLIM_DIR   log dir; else Node's os.tmpdir(): $TMPDIR, $TMP, $TEMP, else /tmp.
# Divergences from env-file.cjs, all sh-shaped: no allowlist (only FND_* keys are ever asked for),
# no Windows %APPDATA% global layer, and a process-env value is read untrimmed.
#
# One JSONL line per DISTINCT spill path is appended to <dir>/fnd-mcp-slim-debug.log — the same file
# the compressor writes — rotated to .log.1 at 5 MB (json-slim's DEBUG_LOG_MAX):
#   {"ts":…,"project":…,"lvl":1|2,"entry":"access","tool":"Bash|Read|Grep","via":…,"spill":…}
# No node on purpose: this fires on EVERY Bash/Read/Grep call, where sh+grep costs ~7 ms against
# node's ~29 ms, so the whole script is one `cat` plus the forks the writing path alone pays.
#
# What the measurement does NOT know, each one worth a line because --report reads these as reads:
#   * PreToolUse fires when the call is PROPOSED — a denied or failing read is recorded like any other;
#   * a command that only NAMES a spill (rm/mv/cp/ln/touch/ls/echo/stat) is recorded as `via:"named"`,
#     which --report deliberately does not pair as a recovery;
#   * the json-slim skip below matches the WHOLE event, so a payload that merely mentions the CLI in a
#     description is not recorded either — under-counting a read is the safe direction here;
#   * BSD `date` has no `%3N`, so `ts` carries `.000` and an access in the SAME second as the event it
#     recovers sorts BEFORE it and does not pair;
#   * `project` is the payload cwd's basename, not json-slim's projectName() (which prefers the nearest
#     `.git` ancestor) — no consumer aggregates access lines by project;
#   * at most 8 distinct paths per call (json-slim's SPILL_LOG_MAX), and a token still carrying a glob
#     metacharacter is dropped rather than recorded or expanded;
#   * a relative spill token is joined to the PAYLOAD cwd textually — a `cd` earlier in the command is
#     not followed — and a token carrying `../`, a `~`, a `$VAR` or a URL scheme is dropped, not recorded.
# -f matters: the extracted tokens are word-split unquoted below, and pathname expansion on them would
# let one `rm <dir>/tool-results/*` record every whale on disk as read.
set -uf

input="$(cat 2>/dev/null || true)"

# Fast reject on the raw event, before any fork: only the two spill families are of interest, and a
# json-slim run logs its own `entry:"cli"` line — recording it here would double-count the recovery.
case "$input" in
  *json-slim.cjs*) exit 0 ;;
  *fnd-mcp-slim-*|*tool-results*) ;;
  *) exit 0 ;;
esac

# Spill paths AND the command's reader verb in ONE grep — the write path is fork-bound, and the two
# alternatives can never be confused: only a spill match carries a spill name. Our hook spills are
# content-addressed (fnd-mcp-slim-<16 hex>[-<hex>].json); the platform's overflow file is ANY name under
# a `tool-results/` directory (real ones are 9 random chars — mcp-slim.cjs's OVERFLOW_PATH is the single
# source of truth, and this must not be narrower than the producer of the `spill` value it pairs with,
# or the pairing silently never happens); and the other fnd- prefixes (slim-out, prompt-json, nogain) are
# not platform-overflow spills, so --report has nothing to pair a read of one with — json-slim already
# logs those reads as its own `entry:"cli"` runs — and no pattern here matches them. A path match stops
# at the shell/JSON delimiters and never spans an `=`, a redirect or an `&`, which keeps a `full=` prefix,
# a `-l<` glued in front of a path and a closing quote off the record; it need not start at a `/`, because
# a spill named relative to the cwd (`.claude/fnd-tmp/fnd-mcp-slim-<hash>.json`) is the same read, and
# --report pairs on the producer's absolute path.
#
# Both alternatives read the tool_input SLICE, never the whole event: a `transcript_path` under a
# tool-results/ dir would otherwise fabricate an access line out of an unrelated Grep, and a cwd like
# /Users/me/node.js/elc would classify the read as `via:"node"`. First occurrence to the end of the
# event — parameter expansion, no fork — falling back to the whole event on a host that sends no
# tool_input at all, where the envelope keys that mislead are absent anyway.
scan="$input"
case "$input" in *'"tool_input"'*) scan="${input#*\"tool_input\"}" ;; esac
case "$scan" in *'\'*)  # JSON string escapes: the solidus (Codex) and the ones every host writes
  # \n \t \r collapse to a SPACE, not to nothing — they are token boundaries in the command they came
  # from, so swallowing one glues the next word onto the path it follows ("<spill>\nwc -l" was recorded
  # as a spill named "<spill>\nwc", which --report can never pair).
  scan="$(printf '%s' "$scan" | sed 's:\\/:/:g; s:\\[ntr]: :g; s:\\\\:\\:g' 2>/dev/null || printf '%s' "$scan")" ;;
esac
# Verb list twin #1, the ERE — kept in sync by hand with the `via=` ladder below; sharing one variable
# would mean re-injecting it into this pattern, and that is a fork on the hot path. A verb counts only
# at a COMMAND position (start, or after a separator / quote / whitespace), so the `node` inside
# /proj/node/fixture.json is a path component, not the reader.
hits="$(printf '%s' "$scan" | grep -oE "[^\"' ,;|()=<>&]*(fnd-mcp-slim-[0-9a-f]{16}(-[0-9a-f]+)?\.json|tool-results/[^\"' ,;|()=<>&]+)|(^|[[:space:]|;&(){}\`\"'=])(jq|grep|rg|sed|awk|head|tail|cat|wc|less|node|rm|mv|cp|ln|touch|ls|echo|stat)([^[:alnum:]_-]|\$)" 2>/dev/null || true)"
# The payload cwd, read here rather than with the other envelope keys below: a relative token and its
# absolute twin in the same command are ONE path, so the dedup has to see the resolved form.
cwd=""
case "$input" in *'"cwd"'*) t="${input#*\"cwd\"}"; t="${t#*\"}"; cwd="${t%%\"*}" ;; esac
[ -n "$cwd" ] || cwd="$PWD"
cwd="${cwd%/}"

# Deduped and CAPPED here, not at the write: `ls <dir>/tool-results/*` names every whale in a directory,
# and one call may never append more than json-slim's own SPILL_LOG_MAX lines to the shared log.
paths=""; toks=""; seen=""; np=0
IFS='
'
for h in $hits; do
  case "$h" in
    *fnd-mcp-slim-*|*tool-results/*)
      # An unexpanded token is not a path anyone read: a glob, a `~`, a `$VAR` and a URL have no
      # textual resolution here, and a `../` joined to the cwd would name a file nobody asked for.
      case "$h" in *'*'*|*'?'*|*'['*|*'../'*|*'$'*|*'://'*|'~'*) continue ;; esac
      # `./x`, `x` and `<cwd>/./x` are one path spelled three ways, and the dedup below compares
      # strings — so every spelling has to reach it as the one absolute form --report pairs on.
      while :; do case "$h" in ./*) h="${h#./}" ;; *) break ;; esac; done
      case "$h" in /*) ;; *) h="$cwd/$h" ;; esac
      while :; do case "$h" in */./*) h="${h%%/./*}/${h#*/./}" ;; *) break ;; esac; done
      [ "$np" -lt 8 ] || continue
      case "$seen" in *"|$h|"*) continue ;; esac
      seen="$seen|$h|"; np=$((np+1)); paths="$paths$h$IFS" ;;
    *) toks="$toks$h " ;;
  esac
done
unset IFS
[ -n "$paths" ] || exit 0

# tool_name off the raw event with parameter expansion only — one fork saved on a path that is
# already fork-bound. FIRST occurrence of the key, so a command quoting the key name loses to the
# real field on every host whose payload puts the envelope keys first (same for `cwd`, above).
tool=Bash
case "$input" in *'"tool_name"'*) t="${input#*\"tool_name\"}"; t="${t#*\"}"; tool="${t%%\"*}" ;; esac
# Codex spells the shell tool `shell` / `local_shell`; everything that is not a file reader is a
# command, which is the only `tool` value whose `via` has to be classified.
case "$tool" in Read) tool=Read ;; Grep) tool=Grep ;; *) tool=Bash ;; esac

# The nearest .claude/domaine.env, resolved ONCE — env-file.cjs's projectPath() walk, whose answer
# cannot change between the three keys asked for below.
envf=""; _d="$cwd"; _i=0
while [ "$_i" -lt 50 ]; do
  if [ -f "$_d/.claude/domaine.env" ]; then envf="$_d/.claude/domaine.env"; break; fi
  _p="${_d%/*}"; [ -n "$_p" ] || _p=/
  [ "$_p" != "$_d" ] || break
  _d="$_p"; _i=$((_i+1))
done

env_get() { # $1 = key → its effective value in `_g` (a variable, not stdout: `$(…)` is a fork)
  eval "_s=\${$1+x}; _g=\${$1-}"
  [ -z "${_s}" ] || return 0
  # ${HOME:-}, not $HOME: `set -u` would abort the whole hook on a stripped environment (cron, a
  # sandboxed exec), and a measurement hook may never write to stderr or exit non-zero.
  for _f in "$envf" "${XDG_CONFIG_HOME:-${HOME:-}/.config}/domaine/env"; do
    [ -n "$_f" ] && [ -f "$_f" ] || continue
    # load() takes the FIRST layer that CARRIES the key, empty value included (`FND_MCP_SLIM_DIR=` in the
    # project file shadows the global one), so a match has to be told apart from "no such line" — hence
    # the `=` sentinel the value is printed behind and stripped off again.
    _g="$(sed -n "/^[[:space:]]*$1[[:space:]]*=/{
s/^[^=]*=[[:space:]]*//
s/[[:space:]]*\$//
s/^/=/
p
q
}" "$_f" 2>/dev/null || true)"
    case "$_g" in =*) _g="${_g#=}"; return 0 ;; esac
  done
  _g=""
}

env_get FND_SPILL_ACCESS
[ "$_g" != "0" ] || exit 0
# json-slim's debugLevel(): any integer ≥ 2 is the everything level, 1/true/yes/on is KEY events,
# anything else (unset included) means the log is off and this hook writes nothing at all.
lvl=0
env_get FND_MCP_SLIM_DEBUG; dbg="$_g"
case "$dbg" in
  '') ;;
  *[!0-9]*) case "$dbg" in [Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) lvl=1 ;; esac ;;
  *) if [ "$dbg" -ge 2 ] 2>/dev/null; then lvl=2; elif [ "$dbg" -eq 1 ] 2>/dev/null; then lvl=1; fi ;;
esac
[ "$lvl" != 0 ] || exit 0

env_get FND_MCP_SLIM_DIR; dir="$_g"
[ -n "$dir" ] || dir="${TMPDIR:-${TMP:-${TEMP:-/tmp}}}"
[ "$dir" = / ] || dir="${dir%/}"

via="$tool"
if [ "$tool" = Bash ]; then
  # By PRECEDENCE, not by position: `grep … | jq …` is a jq read of the spill, and a reader verb
  # anywhere outranks the naming-only ones (`rm`, `ls`, `mv`, `echo` … touch the NAME, not the bytes —
  # --report must not count those as the recovery, so they get their own `via`).
  # Verb list twin #2, the ladder — its alternation lives in the harvesting grep above.
  case "$toks" in
    *jq*) via=jq ;;
    *grep*|*rg*) via=grep ;;
    *sed*|*awk*|*head*|*tail*|*cat*|*wc*|*less*) via=shell ;;
    *node*) via=node ;;
    *rm*|*mv*|*cp*|*ln*|*touch*|*ls*|*echo*|*stat*) via=named ;;
    *) via=other ;;
  esac
fi

esc() { # $1 JSON-escaped into `_e`; the fork is paid only by a path that actually needs it
  case "$1" in *\\*|*\"*) _e="$(printf '%s' "$1" | sed 's:\\:\\\\:g; s:":\\":g' 2>/dev/null)" ;; *) _e="$1" ;; esac
}
project="${cwd##*/}"
[ -n "$project" ] || project="$cwd"
# BSD date has no %N — it prints the format back, which is the fallback's cue.
now="$(date -u '+%Y-%m-%dT%H:%M:%S|%3N' 2>/dev/null || true)"
ms="${now#*|}"; ts="${now%%|*}"
case "$ms" in ''|*[!0-9]*) ms=000 ;; esac
ts="$ts.${ms}Z"

log="$dir/fnd-mcp-slim-debug.log"
[ -d "$dir" ] || mkdir -p "$dir" 2>/dev/null || exit 0
if [ -f "$log" ] && [ "$(wc -c < "$log" 2>/dev/null || echo 0)" -ge 5242880 ]; then
  mv -f "$log" "$log.1" 2>/dev/null || true
fi
esc "$project"; project="$_e"
# Built whole, then appended ONCE: the paths of one call belong to one event, and N opens of a log the
# compressor also appends to is N chances to interleave.
batch=""
IFS='
'
for p in $paths; do
  esc "$p"
  batch="$batch{\"ts\":\"$ts\",\"project\":\"$project\",\"lvl\":$lvl,\"entry\":\"access\",\"tool\":\"$tool\",\"via\":\"$via\",\"spill\":\"$_e\"}
"
done
unset IFS
printf '%s' "$batch" >> "$log" 2>/dev/null || true
exit 0
