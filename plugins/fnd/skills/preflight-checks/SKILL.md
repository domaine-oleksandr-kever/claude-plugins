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
allowed-tools: Read, Glob, Bash(shopify version), Bash(node -v), Bash(npm -v), Bash(git --version), Bash(gh --version), Bash(jq --version), Bash(perl -v)
---

# Preflight Checks

Confirm required tooling is installed, configured, and authenticated so you don't hit failures mid-workflow. After this passes, the environment is cleared for Workflows 2–6.

## Global rules

- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.
- For MCP checks, use the available MCP tools and **report real connection/auth outcomes — do not fabricate success**.
- The CLI version commands in this skill's allow-list are read-only and pre-approved — run them directly. Anything beyond them still needs the developer's go-ahead.

---

## Phase 1 — Environment validation `[plan mode]`

Run the full checklist in `${CLAUDE_PLUGIN_ROOT}/references/preflight-checklist.md` (read it now — it owns the per-check items, commands, and remediation): **CLI tools → MCP servers → project skills & rules → local dev server**. Two skill-side specifics: first confirm the active **workspace/IDE** matches the target project and remind the developer to verify IDE/MCP security settings against team policy; and if the dev server isn't running, note that the develop/QA workflows need it for in-browser validation.

---

## Phase 2 — Report & confirmation

1. **Generate the report** per the checklist's **Report format** section (grouped summary table, 🟢/🔴/🟡 per row, version/connection detail).
2. **Flag blockers** — list critical failures + remediation; state clearly that downstream workflows should wait until critical items pass.

### ✋ Checkpoint

Present the report. Once the developer confirms issues are resolved or accepted, the environment is cleared for Workflows 2–6.

## Quality bar

- Honest status — no assumed green checks.
- Actionable remediation for every failure.
- Compact table suitable for pasting into a ticket or session notes.

## Next in the series

Environment cleared → offer the ticket's entry point in one line — the first unchecked step in `.claude/fnd/<TICKET>/progress.md` when a workspace exists; else `/fnd:write-technical-approach <ticket>` (no approved TA) or `/fnd:develop-feature-or-fix <ticket>` (TA approved) — **offer only; never auto-run**.
