---
name: preflight-checks
description: >
  Validate the local environment — MCP servers, CLI tools, project context, skills & rules,
  dev server — and produce a pass/fail report with blockers — Workflow 1; run at session
  start or when switching projects. Use when the user asks to run preflight / environment
  checks or validate tooling / MCP connectivity.
argument-hint: "(no args — validates the current workspace)"
arguments:
  - name: workspace
    description: Project root to validate. Defaults to the current workspace; confirm it is the intended one.
allowed-tools: Read, Glob, Bash(shopify version), Bash(node -v), Bash(npm -v), Bash(git --version), Bash(gh --version), Bash(jq --version), Bash(perl -v), Bash(git ls-remote*), Bash(timeout 8 git ls-remote*)
---

# Preflight Checks

Confirm required tooling is installed, configured, and authenticated so you don't hit failures mid-workflow. After this passes, the environment is cleared for Workflows 2–6.

Operating mode: **read-only validation** — the checks below inspect, they never write. On Claude Code: run Phase 1 in plan mode — that is what the `[plan mode]` marker below means.

## Global rules

- **Name the host first.** State which agent host this session runs on — Claude Code, Cursor, Codex CLI, or OpenCode — from signals already in this session: how this skill was invoked, which tools and MCP servers are exposed, and which host config directory the workspace carries. Run no extra commands for it (the allow-list below is the budget). Ambiguous signals → report the host as unknown and ask the developer; never guess.
- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.
- For MCP checks, use the available MCP tools and **report real connection/auth outcomes — do not fabricate success**.
- The CLI version commands in this skill's allow-list are read-only and pre-approved — run them directly. Anything beyond them still needs the developer's go-ahead.

---

## Phase 1 — Environment validation `[plan mode]`

Run the full checklist in `../../references/preflight-checklist.md` (paths like this are relative to this skill's directory) — read it now; it owns the per-check items, commands, and remediation: **CLI tools → MCP servers → project skills & rules → local dev server → plugin update → model pins**. Four skill-side specifics: first confirm the active **workspace/IDE** matches the target project and remind the developer to verify IDE/MCP security settings against team policy; second, report the detected host in that same group and run the host-dependent items against it — **project skills & rules** live in the host's own project dirs (`.claude/` on Claude Code, exactly as the checklist states; `.cursor/` on Cursor; `.agents/` + `.codex/` on Codex; `.opencode/` on OpenCode) and MCP checks cover whichever of the servers that host actually has configured; third, if the dev server isn't running, note that the develop/QA workflows need it for in-browser validation; fourth, the last two groups are about the **plugin itself** rather than the project — an update nudge (installed version vs. what the host could install — one `git ls-remote` against the clone the install points at, never a host cache that only installs write to) and, on Cursor and Codex, whether the model ids pinned in that host's generated agents still resolve. Both are advisory: they never gate the workflows, they report 🟡 with the reason rather than guessing, and a stale pin on an already-latest plugin is offered to the fnd report-plugin-issue skill instead of being patched locally.

---

## Phase 2 — Report & confirmation

1. **Generate the report** per the checklist's **Report format** section (grouped summary table, 🟢/🔴/🟡 per row, version/connection detail).
2. **Flag blockers** — list critical failures + remediation; state clearly that downstream workflows should wait until critical items pass.

### ✋ Checkpoint

Present the report. Once the developer confirms issues are resolved or accepted, the environment is cleared for Workflows 2–6.

## Next in the series

Environment cleared → offer the ticket's entry point per `../../references/task-workspace.md` → Progress tracking; no workspace → the fnd write-technical-approach skill (no approved TA) or develop-feature-or-fix (TA approved) — on Claude Code, `/fnd:write-technical-approach <ticket>` / `/fnd:develop-feature-or-fix <ticket>`; **offer only; never auto-run**.
