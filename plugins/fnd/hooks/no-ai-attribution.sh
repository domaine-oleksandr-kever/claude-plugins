#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash) — deterministic guard for the Domaine
# commit-message rule: no AI attribution. The harness injects "End git commit
# messages with: Co-Authored-By: Claude …" into every agent's system prompt;
# the commit-message-format reference forbids it, and in that instruction
# fight the system prompt sometimes wins (subagents included). Blocking the
# call is the only outcome that can't lose the fight.
#
# stdin: PreToolUse event JSON ({"tool_name":"Bash","tool_input":{"command":…}}).
# `command` is a STRING on Claude Code and Cursor and an ARGV ARRAY on Codex's
# shell / local_shell tools — both are normalized to one line below.
# Exit 2 + stderr blocks the call and feeds the message back to the model;
# exit 0 lets it through. A hook failure must never block a commit.
#
# Best-effort by design — tests/no-verify-bypass-matrix.sh (its N/M/NJ
# sections) is the FP/FN contract; run it after any regex change. Known residual FPs: a commit
# message that merely MENTIONS the trailer text (docs about this rule), and a
# `;`-chained command that greps for the trailer AFTER the commit — both get
# a clear re-run message; reword or split the command. Known residual FNs: a
# message staged to a file by an earlier Write/Bash call and committed via
# `git commit -F file` is invisible to a Bash-command matcher, and a `|`/`&`
# inside the quoted message truncates the scanned segment before the trailer.
set -u

input="$(cat 2>/dev/null || true)"

# Host-proof log via an EXIT trap: every path out (fast rejects included) is recorded from the
# status this guard actually returned; a missing helper is simply never called. `${0%/*}`, not a
# `dirname` fork — this hook runs on every Bash call.
case "$0" in */*) _ht="${0%/*}/host-trace.sh" ;; *) _ht="./host-trace.sh" ;; esac
[ -f "$_ht" ] && . "$_ht" 2>/dev/null
command -v fnd_trace_on_exit >/dev/null 2>&1 \
  && trap 'fnd_trace_on_exit PreToolUse no-ai-attribution' EXIT

# Fast reject, before the jq/sed/grep pipeline this hook pays on EVERY Bash call: a
# block needs BOTH a `git … commit` segment and one of the trailer words the matcher
# below keys on, and neither can appear in the command without appearing in stdin
# (this hook scans the command verbatim — no dequoting). `claude` is deliberately not
# a trigger on its own: it sits in half the paths of a Claude Code session, and every
# matched alternative carries one of these three words anyway. The trailer phrase is
# matched loosely (`*generated*with*`, not the literal pair) because the matcher below
# reads the message with newlines flattened to spaces: a wrapped `Generated⏎with` is one
# phrase to it and two words here. A `\u`-escaped keyword only appears after the jq
# decode, so anything carrying one stays in.
shopt -s nocasematch 2>/dev/null || true
case "$input" in *commit*|*\\u*) ;; *) exit 0 ;; esac
case "$input" in *co-authored-by*|*anthropic*|*generated*with*|*\\u*) ;; *) exit 0 ;; esac

# An ARGV ARRAY is joined into one space-separated line before the segment matcher reads it:
# `jq -r` on an array prints one element PER LINE, and `grep -o` below is per-line, so `git`
# and `commit` on separate lines form no segment at all and the trailer rides through. Same
# normalization as no-verify-bypass.sh, deliberately kept in step with it.
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '(.tool_input.command // empty)
    | if type == "array" then map(select(type == "string")) | join(" ") else . end' 2>/dev/null || true)"
fi
if [ -z "$cmd" ]; then
  # No (working) jq: pull the "command" JSON value with sed and unescape
  # just enough to scan. Approximate, but far better than fail-open.
  cmd="$(printf '%s' "$input" | tr '\n' ' ' \
    | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*"((\\.|[^"\\])*)".*/\1/p' \
    | sed -E 's/\\n/ /g; s/\\t/ /g; s/\\"/"/g; s/\\\\/\\/g' || true)"
fi
if [ -z "$cmd" ]; then
  # …and the array form with that same toolbox: the bracket span, joined on the JSON element
  # separator (`","` cannot appear unescaped inside a JSON string). A span holding a bracket of
  # its own is not extractable this way — the fail-closed branch owns that case.
  arr="$(printf '%s' "$input" | tr '\n' ' ' \
    | sed -nE 's/.*"command"[[:space:]]*:[[:space:]]*\[([^][]*)\].*/\1/p' || true)"
  if [ -n "$arr" ]; then
    cmd="$(printf '%s' "$arr" \
      | sed -E 's/^[[:space:]]*"//; s/"[[:space:]]*$//; s/"[[:space:]]*,[[:space:]]*"/ /g' \
      | sed -E 's/\\n/ /g; s/\\t/ /g; s/\\"/"/g; s/\\\\/\\/g' || true)"
  fi
fi
if [ -z "$cmd" ]; then
  # An argv array this toolbox could not read is the one unreadable payload that may NOT exit 0.
  # The stdin prefilters above already required a `commit` AND a trailer word, so anything
  # reaching here is a commit call carrying attribution text that cannot be inspected — blocked
  # rather than waved through. Every other unreadable payload stays fail-open.
  case "$input" in *'"command"'*)
    if printf '%s' "$input" | tr '\n' ' ' | grep -qE '"command"[[:space:]]*:[[:space:]]*\['; then
      case "$input" in *commit*)
        echo "Domaine convention (references/commit-message-format.md): this call carries an argv-array command the fnd commit-message guard could not parse, so the git commit inside it is blocked rather than run unchecked. Re-run it as a single command string (e.g. bash -lc '<command>'), without the Co-Authored-By / Generated-with-Claude trailer." >&2
        exit 2 ;;
      esac
    fi ;;
  esac
fi
[ -n "$cmd" ] || exit 0

# Isolate each `git … commit …` segment — same shape as no-verify-bypass.sh:
# a run of global options may sit between git and commit (-C <path>, -c
# <k>=<v>, --git-dir=…), the leading boundary keeps `legit commit` out.
# Differences, both because trailers live at the message END: newlines
# flatten to spaces first (trailers sit inside multi-line -m/-F- messages,
# which must stay part of their segment), and `;` does not stop a segment
# (a `;` inside the quoted message must not hide the trailer behind it).
segs="$(printf '%s' "$cmd" | tr '\n' ' ' \
  | grep -oE '(^|[^[:alnum:]_.-])git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit[^|&]*' || true)"
[ -n "$segs" ] || exit 0

# Claude/Anthropic attributions only — human Co-Authored-By trailers pass.
# Scoped to the commit segments so trailer text elsewhere in a compound
# command (`grep -r "Co-Authored-By: Claude" … && git commit`) doesn't trip.
# The display-name span stops at `<`, so an @anthropic.com address (any agent
# identity, any subdomain) needs its own alternative; a look-alike host
# (jane@anthropic.example.com, jane@notanthropic.community) still passes.
if printf '%s' "$segs" | grep -qiE 'co-authored-by:[^<>]*(claude|anthropic|<[^<>]*@([[:alnum:]-]+\.)*anthropic\.com)|noreply@anthropic\.com|generated with \[?claude'; then
  echo "Domaine convention (references/commit-message-format.md): commit messages carry no AI attribution. Re-run the same git commit without the Co-Authored-By / Generated-with-Claude trailer." >&2
  exit 2
fi
exit 0
