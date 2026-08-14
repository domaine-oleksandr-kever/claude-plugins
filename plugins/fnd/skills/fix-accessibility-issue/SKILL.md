---
name: fix-accessibility-issue
description: >
  Fix accessibility issues in theme components (ARIA, focus management, screen readers).
  Use when the user asks to fix an accessibility / a11y / ARIA / keyboard / screen-reader /
  focus issue, or references a GitHub accessibility issue.
argument-hint: "<component-name | GitHub issue #>"
arguments:
  - name: target
    description: The component to fix (e.g. mega-menu, cart-drawer) or a GitHub accessibility issue number.
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(npx playwright test*), Bash(git status*), Bash(git diff*), Bash(git checkout*), Bash(git add*), Bash(git log*)
---

# Fix Accessibility Issue

Fix accessibility issues in theme components. Follow the standard issue-fix workflow (branch → implement → test → hand off the commit), with the a11y-specific rules below.

**The commit is not pre-approved here.** Staging (`git add`) is; `git commit` is not — hand the commit to `/fnd:commit` (committing is that skill's job; the developer invokes it themselves).

## Component ARIA patterns

Before implementing, **search the codebase for the existing ARIA pattern** for the component type (`Grep` for `role=`, `aria-*`, and the component name) — match it first, and reach for the **WCAG ARIA Authoring Practices (APG)** pattern only when there's no precedent.

## Critical implementation rules

- **`role` goes on the element that contains the items**, not the wrapper — screen readers need a direct parent-child relationship between the role and its items.
- **Test with an actual screen reader / accessibility tree**, not just markup validation. Verify individual items are recognized, not just containers.
- **Update page-object models** when changing roles (e.g. `navigation` → `menubar`).
- **Test focus thoroughly** — navigate away and back; focus bugs look correct but misbehave on subsequent interactions.

## Focus management

- Consistent focus behaviour across keyboard and mouse.
- Reset focus state properly when closing dropdowns/menus (ESC vs selection).
- Centralize focus-management logic — don't duplicate it across handlers.

## Implementation guidelines

- Favour semantic correctness over visual change; keep backward compatibility.
- Native browser behaviour (`<details>`, `<dialog>`, `popover`) often suffices.
- Use `aria-labelledby` to reference existing visible text instead of duplicating it in `aria-label`.
- Avoid duplicate logic between keyboard and mouse handlers; separate ARIA-state management from focus management.
- Toggle visual state via `data-*` attributes + Tailwind `data-[]:` selectors, not `classList`/`style.*` — the repo lints against those; if legacy code trips `no-restricted-syntax`, see `${CLAUDE_PLUGIN_ROOT}/references/eslint-no-restricted-syntax.md`.

## Performance

- Prefer simpler solutions before custom keyboard handling — complex key navigation introduces lag.

## Testing

- Run the relevant test suite (`npx playwright test --reporter=line`); update selectors / page objects when roles change. Verify with the accessibility tree, then record learnings.
