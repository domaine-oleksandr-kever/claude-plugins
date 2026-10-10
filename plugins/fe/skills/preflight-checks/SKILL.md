---
name: preflight-checks
description: >
  Validate the local environment (MCP servers, CLI tools, project context, dev server) into a
  pass/fail report. Use at session start, on a project switch, or when asked to check environment,
  tooling or MCP connectivity.
argument-hint: "(no args — validates the current workspace)"
arguments:
  - name: workspace
    description: Project root to validate. Defaults to the current workspace; confirm it is the intended one.
allowed-tools: Read, Glob, Bash(shopify version), Bash(node -v), Bash(npm -v), Bash(git --version), Bash(gh --version), Bash(jq --version), Bash(perl -v)
---

# Preflight Checks

Confirm required tooling is installed, configured, and authenticated so you don't hit failures mid-workflow. After this passes, the environment is cleared for Workflows 2–6.

Operating mode: **validation** — Phase 1 is read-only toward the repo's tracked files; writes go to the task workspace only.

## Global rules

- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.
- For MCP checks, use the available MCP tools and **report real connection/auth outcomes — do not fabricate success**.
- The CLI version commands in this skill's allow-list are read-only and pre-approved — run them directly. Anything beyond them (the two `--check` probes of base's fetchers included) still needs the developer's go-ahead.

---

## Phase 1 — Environment validation

Run the full checklist in `<fe root>/references/preflight-checklist.md` — read it now; it owns the per-check items, commands, and remediation: **CLI tools → MCP servers → project skills & rules → local dev server → Jira attachments → Figma access → plugin update**. Three skill-side specifics: first confirm the active **workspace/IDE** matches the target project and remind the developer to verify IDE/MCP security settings against team policy; second, if the dev server isn't running, note that the develop/QA workflows need it for in-browser validation; third, the plugin-update group is about the **plugins themselves** rather than the project — installed fe and base versions vs. what the marketplace checkout could install. It is advisory: it never gates the workflows, it reports 🟡 with the reason rather than guessing, and `/fe-doctor` + `/base-doctor` are the install checks to point at when something in the plugins looks broken.

---

## Phase 2 — Report & confirmation

1. **Generate the report** per the checklist's **Report format** section (grouped summary table, 🟢/🔴/🟡 per row, version/connection detail).
2. **Flag blockers** — list critical failures + remediation; state clearly that downstream workflows should wait until critical items pass.

### ✋ Checkpoint

Present the report. Once the developer confirms issues are resolved or accepted, the environment is cleared for Workflows 2–6.

## Next in the series

Environment cleared → offer the ticket's entry point per `<base root>/references/task-workspace.md` → Progress tracking; no workspace → `/fe:write-technical-approach <ticket>` (no approved TA) or `/fe:develop-feature-or-fix <ticket>` (TA approved); **offer only; never auto-run**.
