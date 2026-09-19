#!/usr/bin/env bash
# SessionStart hook — the Foundation session context: the plugin root, the checkout's project
# profile, and the hooks/*.md conventions that profile and the workspace gate. Every host wiring
# spawns this one script instead of carrying its own copy of the same shell, so a convention added
# here reaches Claude Code and Codex from one edit (Cursor and OpenCode compose theirs in JS).
#
# FND_HOST is taken from the wiring that spawned this, never set here — it is the `host` column of
# the FND_HOST_TRACE log, and the wiring is the only layer that knows which host is running.
#
# The composed context becomes the session context. On the Claude host it rides in the SessionStart
# JSON envelope, the one delivery form an Agent SDK host (Cowork) injects — plain stdout reaches the
# CLI only; every other host keeps the plain text it was verified on. node builds that envelope, so
# a stray quote in a convention cannot malform it: a host that fails to parse the object drops the
# whole context silently. Either form is capped host-side at 10,000 chars, unconfigurably.
#
# The Claude envelope also carries the SESSION TITLE (`FND_SESSION_TITLE`, hooks/session-title.cjs),
# derived from the branch's ticket key — inside the same object, because the event takes one JSON
# document. It is the only thing here that reads stdin, and it reads it defensively: the context
# delivery may never depend on the hook input arriving.
#
# stderr stays empty and the exit status is always 0: a partial install may cost a session a
# convention, never the session itself.
set -u

# The env var wins so a host that installs the bundle elsewhere (Cursor's cache, Codex's
# PLUGIN_ROOT alias) is obeyed; the self-location fallback is for a direct run, where the wiring
# that would have exported one is not in play.
root="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}}"

compose() {
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
}

# FND_SESSION_TITLE the way the node entry points read it: process env, then the GLOBAL Domaine
# env file. A gate that consulted the process env alone would keep renaming sessions for a
# developer who switched the feature off in that file. Global-only, mirroring env-file.cjs — the
# project layer carries tuning keys only, and what a session is CALLED is not a repo's to set.
title_on() {
  _v="${FND_SESSION_TITLE-}"
  if [ -z "${FND_SESSION_TITLE+x}" ]; then
    _f="${XDG_CONFIG_HOME:-${HOME:-}/.config}/domaine/env"
    [ -f "$_f" ] && _v="$(sed -n '/^[[:space:]]*FND_SESSION_TITLE[[:space:]]*=/{s/^[^=]*=[[:space:]]*//;s/[[:space:]]*$//;p;q;}' "$_f" 2>/dev/null || true)"
  fi
  [ "$_v" != "0" ]
}

if [ "${FND_HOST:-}" = claude ]; then
  ctx="$(compose)"
  # The session title rides in the same envelope object (Claude Code is the only host that reads
  # one). Reading the hook input is bounded and skipped on a terminal: a by-hand run must not
  # stall the session waiting for stdin that never closes.
  hook_input=""; branch=""
  if title_on; then
    [ -t 0 ] || IFS= read -r -d '' -t 1 hook_input || true
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || branch=""
  fi
  # FNDSS_*, not FND_*: these are one call's arguments, not switches the env files or the
  # domaine-env registry know about.
  wrapped="$(printf '%s' "$ctx" | FNDSS_BRANCH="$branch" FNDSS_INPUT="$hook_input" FNDSS_MOD="$root/hooks/session-title.cjs" node -e 'let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{const o={hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s}};try{let i={};try{i=JSON.parse(process.env.FNDSS_INPUT||"{}")||{}}catch(e){}const t=require(process.env.FNDSS_MOD).startTitle(process.env.FNDSS_BRANCH,process.cwd(),i);if(t)o.hookSpecificOutput.sessionTitle=t}catch(e){}process.stdout.write(JSON.stringify(o))})' 2>/dev/null)" || wrapped=""
  # No node, or node unhappy: the plain text still reaches the CLI, which is where this path runs
  # when it is not an SDK host.
  if [ -n "$wrapped" ]; then printf '%s\n' "$wrapped"; else printf '%s\n' "$ctx"; fi
else
  compose
fi

# Last, behind the injection it reports: this context is composed by a hook that prints, so
# nothing but the hook itself could record that it fired.
"$root/hooks/host-trace.sh" SessionStart session-start inject 2>/dev/null || true
exit 0
