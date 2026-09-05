---
name: fix-breaking-changes
description: >
  Apply the fixes documented in `breaking-changes.md` to `templates/**/*.json` and
  `config/settings_data.json` via a Node script, then verify with theme check. Use when the
  user asks to fix / apply breaking changes or migrate templates after a major version bump.
argument-hint: "(reads breaking-changes.md from the project root)"
allowed-tools: Read, Edit, Grep, Glob, Bash(mkdir -p scripts), Bash(cp ${CLAUDE_PLUGIN_ROOT}/skills/fix-breaking-changes/scripts/fix-breaking-changes.template.js scripts/fix-breaking-changes.js), Bash(node scripts/fix-breaking-changes.js), Bash(shopify theme check*), Bash(rm scripts/fix-breaking-changes.js)
---

# Fix Breaking Changes

Apply the fixes documented in `breaking-changes.md` to `templates/**/*.json` and `config/settings_data.json`. Prefer the bundled script over hand-editing each file; clean it up afterwards.

**Prerequisite:** `breaking-changes.md` exists in the project root (produce it with `get-breaking-changes`).

## Process

1. **Read `breaking-changes.md`** — identify what to change: settings to remove, block types to rename, property values to update, context changes (e.g. `{{ closest.product }}` vs explicit settings).
2. **Copy the bundled script template** into the repo (`scripts/` may not exist yet). Plugin root = the plugin's own directory, `../../` relative to this skill's directory; substitute its absolute path — on Claude Code the session context opens with `fnd plugin root: <absolute path>`, and the Bash tool's shell does not set `${CLAUDE_PLUGIN_ROOT}`, so a literal one expands to empty:
   ```bash
   mkdir -p scripts
   cp <plugin root>/skills/fix-breaking-changes/scripts/fix-breaking-changes.template.js scripts/fix-breaking-changes.js
   ```
3. **Customize `applyFixes`** in `scripts/fix-breaking-changes.js` — uncomment/adapt the patterns documented in the template's own comments.
4. **Run it:**
   ```bash
   node scripts/fix-breaking-changes.js
   ```
5. **Verify:**
   ```bash
   shopify theme check --fail-level error
   ```
6. **Iterate** — if theme check still errors on templates/config, refine `applyFixes` and re-run.
7. **Handle out-of-scope issues** — if errors remain that are **not** in `templates/` or `config/settings_data.json`, **STOP** and report instead of editing blindly:

   > 🚫 BREAKING CHANGES REQUIRING MANUAL FIXES OUTSIDE templates/ AND config/
   > 1. `<file path>` — `<required change>`

   Likely files: `sections/*.liquid`, `blocks/*.liquid`, `snippets/*.liquid`, `assets/*.js|css`, `schemas/`.
8. **Clean up:**
   ```bash
   rm scripts/fix-breaking-changes.js
   ```

## Notes

- Test incrementally — run theme check after each fix type.
