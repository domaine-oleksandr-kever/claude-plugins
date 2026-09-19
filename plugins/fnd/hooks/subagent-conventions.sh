#!/usr/bin/env bash
# SubagentStart hook — inject Foundation conventions into subagents. Subagents
# start with a fresh context and never see the main session's SessionStart
# output, so without this hook they would run without them. Two tiers: the
# untrusted-content rail goes to EVERY subagent (the readers, which are the ones
# handling third-party text, need it most), the code conventions only to the
# code-writing ones.
#
# stdin: SubagentStart event JSON, e.g. {"agent_type":"general-purpose",...}.
# The composed conventions become context in the subagent. On the Claude host they ride in the
# SubagentStart JSON envelope, the one delivery form an Agent SDK host (Cowork) injects — plain
# stdout reaches the CLI only, and a subagent that loses this loses the untrusted-content rail it
# handles third-party text with. Cursor spawns this script too and reads its stdout as raw text,
# so the envelope is the Claude wiring's alone. Always exits 0 — a hook failure must never block
# an agent from starting.
set -u

input="$(cat 2>/dev/null || true)"
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

agent_type=""
if command -v jq >/dev/null 2>&1; then
  agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null || true)"
fi

compose() {
  # Every subagent, no exemptions: a reader that treats fetched text as instructions is
  # exactly the failure this rail exists for.
  cat "$root/hooks/untrusted-content.md" 2>/dev/null || true

  # Agents that don't write code — skip the CODE conventions below (they are also
  # the most frequent spawns; the rail above already reached them). The
  # readers/reviewers are read-only; jira-writer writes to Jira and doc-reader
  # writes workspace markdown extracts, not code, so the code conventions don't
  # apply to them either. An unknown or unparsable type gets them:
  # over-injecting is cheap, a code-writing agent without them is not.
  case "$agent_type" in
    *jira-reader*|*jira-writer*|*figma-reader*|*doc-reader*|*theme-explorer*|*change-reviewer*|*bug-hunter*|Explore|Plan|claude-code-guide|statusline-setup)
      return 0 ;;
  esac

  cat "$root/hooks/comment-discipline.md" 2>/dev/null || true
  # The Foundation addendum rides the same probe every host's session start uses — a subagent
  # writing Liquid in a Foundation checkout needs the LiquidDoc and core rules its parent session
  # was given.
  if [ "$(bash "$root/scripts/project-profile.sh" 2>/dev/null)" = foundation ]; then
    cat "$root/hooks/comment-discipline-foundation.md" 2>/dev/null || true
  fi
  if [ "${FND_LEAN:-1}" != "0" ]; then
    cat "$root/hooks/lean-code.md" 2>/dev/null || true
  fi
}

if [ "${FND_HOST:-}" = claude ]; then
  ctx="$(compose)"
  # node builds the envelope, so a stray quote in a convention cannot malform it: a host that
  # fails to parse the object drops the whole context silently. No node, or node unhappy: the
  # plain text still reaches the CLI, which is where this path runs when it is not an SDK host.
  wrapped="$(printf '%s' "$ctx" | node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SubagentStart",additionalContext:s}}))})' 2>/dev/null)" || wrapped=""
  if [ -n "$wrapped" ]; then printf '%s\n' "$wrapped"; else printf '%s\n' "$ctx"; fi
else
  compose
fi

# Host-proof log, stated once AFTER the conventions went out: both tiers out of this hook inject,
# so one decision covers both, and it is recorded behind the act rather than ahead of it.
case "$0" in */*) _ht="${0%/*}/host-trace.sh" ;; *) _ht="./host-trace.sh" ;; esac
[ -f "$_ht" ] && . "$_ht" 2>/dev/null
command -v fnd_trace >/dev/null 2>&1 \
  && fnd_trace SubagentStart subagent-conventions inject "" "$agent_type"
exit 0
