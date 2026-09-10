#!/usr/bin/env bash
# SessionStart hook — the Foundation session context: the plugin root, the checkout's project
# profile, and the hooks/*.md conventions that profile and the workspace gate. Every host wiring
# spawns this one script instead of carrying its own copy of the same shell, so a convention added
# here reaches Claude Code and Codex from one edit (Cursor and OpenCode compose theirs in JS).
#
# FND_HOST is taken from the wiring that spawned this, never set here — it is the `host` column of
# the FND_HOST_TRACE log, and the wiring is the only layer that knows which host is running.
#
# stdout becomes the session context. stderr stays empty and the exit status is always 0: a
# partial install may cost a session a convention, never the session itself.
set -u

# The env var wins so a host that installs the bundle elsewhere (Cursor's cache, Codex's
# PLUGIN_ROOT alias) is obeyed; the self-location fallback is for a direct run, where the wiring
# that would have exported one is not in play.
root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}}"
echo "fnd plugin root: $root"

# scripts/project-profile.sh is the single source of this answer on every host. Anything it says
# that is not one of the three values is not allowed to become session context.
p="$(bash "$root/scripts/project-profile.sh" 2>/dev/null)"
case "$p" in foundation|theme|none) ;; *) p=none ;; esac
echo "fnd project profile: $p"

cat "$root/hooks/comment-discipline.md" 2>/dev/null
# Immediately behind the block it extends — a convention landing between the two would read as a
# section of its own.
[ "$p" = foundation ] && cat "$root/hooks/comment-discipline-foundation.md" 2>/dev/null
for f in plugin-feedback task-workspace untrusted-content mcp-whale; do
  cat "$root/hooks/$f.md" 2>/dev/null
done
if [ -f shopify.theme.toml ] || [ -f .env ]; then
  cat "$root/hooks/store-access.md" 2>/dev/null || true
fi
[ "${FND_LEAN:-1}" = "0" ] || cat "$root/hooks/lean-code.md" 2>/dev/null

# Last, behind the injection it reports: this context is composed by a hook that prints, so
# nothing but the hook itself could record that it fired.
"$root/hooks/host-trace.sh" SessionStart session-start inject 2>/dev/null || true
exit 0
