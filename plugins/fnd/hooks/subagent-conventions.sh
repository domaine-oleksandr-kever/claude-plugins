#!/usr/bin/env bash
# SubagentStart hook — inject Foundation code conventions into code-writing
# subagents. Subagents start with a fresh context and never see the main
# session's SessionStart output, so without this hook general-purpose and
# workflow agents would run without the conventions.
#
# stdin: SubagentStart event JSON, e.g. {"agent_type":"general-purpose",...}.
# stdout: becomes context in the subagent. Always exits 0 — a hook failure
# must never block an agent from starting.
set -u

input="$(cat 2>/dev/null || true)"
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

agent_type=""
if command -v jq >/dev/null 2>&1; then
  agent_type="$(printf '%s' "$input" | jq -r '.agent_type // empty' 2>/dev/null || true)"
fi

# Agents that don't write code — skip them (they are also the most frequent
# spawns). The readers/reviewers are read-only; jira-writer writes to Jira and
# doc-reader writes workspace markdown extracts, not code, so the code
# conventions don't apply to them either. An unknown or
# unparsable type gets the conventions: over-injecting is cheap, a code-writing
# agent without them is not.
case "$agent_type" in
  *jira-reader*|*jira-writer*|*figma-reader*|*doc-reader*|*theme-explorer*|*change-reviewer*|*bug-hunter*|Explore|Plan|claude-code-guide|statusline-setup)
    exit 0 ;;
esac

cat "$root/hooks/comment-discipline.md" 2>/dev/null || true
if [ "${FND_LEAN:-1}" != "0" ]; then
  cat "$root/hooks/lean-code.md" 2>/dev/null || true
fi
exit 0
