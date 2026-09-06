---
name: smoke-test
description: >
  Prove a fresh fnd install actually works on this host — invocation, bundled scripts, MCP
  servers, subagents, guard hooks, session context, MCP compression — and report a pass/fail
  matrix with remediation. Run ONCE after installing or updating the plugin, not every session
  (preflight-checks owns the recurring per-project role). Use when the user asks to smoke test /
  verify / prove the plugin install after installing or updating it, or asks whether the plugin
  is working on this host.
argument-hint: "[optional Jira ticket key — runs the deeper subagent variant, e.g. ELC-123]"
arguments:
  - name: ticket
    description: Optional Jira ticket key. When given, the subagent row runs a full jira-reader read of that ticket instead of the trivial brief.
allowed-tools: Read, Glob, Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.cjs*), Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/json-slim.cjs*), Bash(mktemp -d*), Bash(git init*), Bash(git -C*)
---

# Smoke test — prove this install works

A run-once exercise after installing or updating fnd: each layer of the plugin is used for real,
once, and reported. It needs no project — run it in any directory. The static half of the same
question (`doctor.cjs`) is also run by the installer; this skill proves the layers a script
cannot reach, from inside a live session.

**Plugin root** = the plugin's own directory, `../../` relative to this skill's directory, and
every `<plugin root>/…` path below resolves the same way; on Claude Code it is
`${CLAUDE_PLUGIN_ROOT}` — the host substitutes the absolute path into this text, so the path you see
here is the one to write into commands (no shell variable carries it).

Read `../../references/smoke-test-checks.md` now — it owns the per-server call list, expected
shapes, the scratch-repo probe, the report format, and remediation per failure.

## Global rules

- **Name the host first.** State which agent host this session runs on — Claude Code, Cursor,
  Codex CLI, or OpenCode — from signals already in this session (how this skill was invoked,
  which tools and MCP servers are exposed, which host config dir the workspace carries).
  Ambiguous → report the host as unknown and ask the developer; never guess. Every row is
  reported against that host and the plugin version from row 2.
- **Honest status — never fabricate a green row.** A row is 🟢 only when its call actually ran
  and returned what the reference expects. Not run, unavailable dependency, or an outcome you
  cannot verify → 🟡 with the reason. Failure → 🔴 with the real error text.
- **Row 5 runs only in a throwaway scratch directory** — never in the developer's repo, never in
  any checkout with real work in it. Every git command in that row carries its own `-C <scratch
  dir>`: no `cd`, no bare `git add` / `git commit`, so a lost or empty `$dir` cannot reach the
  working tree you are sitting in.
- Read-only otherwise: no repo files are written, no state is stored, re-running is harmless.
- Stop for nothing. A failed row is data, not a blocker — finish the matrix, then remediate.

## The rows

1. **Invocation + skill layer** — self-proving: if this skill loaded at all, the host discovered
   the skills dir, parsed this frontmatter, and routed the invocation. 🟢, and record the
   invocation form the developer actually used (slash command, `$name`, command shim, or
   model-invoked by description) — that is the datum, not the fact that it worked.
2. **Bundle integrity** — run `node <plugin root>/scripts/doctor.cjs` (add `--target <host>` for
   the host named in the global rules, off Claude Code). Proves the bundled scripts are reachable
   and runnable from the host's own process, and reports the version stamp every other row is
   filed under. Reference: *Row 2* for reading PASS/FAIL/SKIP and exit codes.
3. **MCP servers** — ONE cheap read-only call per server this host has configured, per the call
   table in *Row 3* of the reference. Real connect/auth outcomes only. A server the host does not
   expose is 🟡 "not configured on this host", not 🔴.
4. **Subagent layer** — spawn ONE `jira-reader` with the trivial brief in *Row 4* ("call
   `atlassianUserInfo`, report the account display name"). One spawn proves agent registration,
   delegation, and MCP access from inside a subagent. With a ticket key in `$1`, run the deeper
   variant instead: a full `jira-reader` read of that ticket.
5. **Guard hooks** — the scratch-repo probe in *Row 5*: `mktemp -d`, `git init`, one throwaway
   commit attempt with `--no-verify`. The expected outcome is the **host blocking the command**.
   Report what actually happened — blocked (🟢, quote the refusal), allowed (🔴, the guard is not
   wired on this host), or something else (🟡).
6. **Context injection** — self-report: are the fnd session conventions in your context right
   now? Name the ones you can see by their headings (*Row 6* lists them) and say through which
   mechanism they arrived on this host. None visible → 🔴 with the host's injection path named.
7. **MCP compression** — best effort, per *Row 7*. If any MCP call in rows 3–4 tripped the
   compressor (stub, spill path, or in-place rewrite marker), report which path fired. Otherwise
   run the json-slim CLI on the bundled fixture so the script half is proven on this host, and
   mark the hook half 🟡 "not exercised" — do not claim it from the CLI result.
8. **Host trace** — the same rows read back from a log instead of from memory. When
   `FND_HOST_TRACE` is on, run `node <plugin root>/scripts/doctor.cjs --trace --since <this
   session's start>` and report which `event/hook` rows logged under **this** host in this
   session: that is rows 5–7 proven from disk rather than self-reported. A row you claimed green
   above with no line in the trace is a finding, not a rounding error. Switch off → 🟡 with the
   remediation `node <plugin root>/scripts/domaine-env.cjs set FND_HOST_TRACE=1` (global-only)
   plus a new session, and re-run this skill there. Reference: *Row 8* for the expected rows per
   host.

## Report

Emit the matrix from the reference's **Report format**: host + host version, plugin version,
install mode, one row per check with 🟢/🔴/🟡 and a one-line detail, then remediation for every
non-green row. Nothing else is written anywhere.

Then triage: environment gaps (no auth, no browser, Figma desktop closed, no MCP configured) are
the developer's to fix and are named as such. A **genuine plugin defect** — a bundled script that
crashes, a wiring pointer that resolves nowhere, a guard that does not fire where the host
supports it, an instruction here that contradicts what happened — is worth filing: offer the fnd
report-plugin-issue skill (on Claude Code, `/fnd:report-plugin-issue`) with this run's host,
version, command and output; **offer only, never auto-run**.
