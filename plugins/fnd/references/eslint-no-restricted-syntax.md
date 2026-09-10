# ESLint: `no-restricted-syntax` for `classList` / `style.*` / `className`

Applies only in a `foundation` checkout (session line `fnd project profile: foundation`, or the
brief's `profile:`); anywhere else ignore this file — assume nothing about its lint setup, and
follow the theme's own lint config and patterns.

This repo uses `no-restricted-syntax` to discourage:

- `element.classList.add/remove/toggle(...)`
- `element.className = ...`
- `element.style.* = ...` (e.g. `style.display`)

The preferred pattern is **state via `data-*` attributes** + **Tailwind `data-[]:` selectors**.

## When you need lint to stop failing without changing code

If the codebase already contains legacy usages (especially in protected core files), and you need CI / local lint to pass **without modifying source**, you can:

- downgrade the rule to warnings by changing the severity from `"error"` to `"warn"` in `.eslintrc`
- or disable it for specific files via `overrides`

### Downgrade to warnings (recommended for legacy cleanup phase)

In `.eslintrc`:

- change:
  - `"no-restricted-syntax": ["error", ...]`
  - to:
  - `"no-restricted-syntax": ["warn", ...]`

This keeps guidance visible, but `npm run lint:js` will exit successfully.

### Disable for specific files

In `.eslintrc` add:

```json
{
  "overrides": [
    {
      "files": ["src/base/BaseElement.ts", "src/entry/back-in-stock.ts"],
      "rules": {
        "no-restricted-syntax": "off"
      }
    }
  ]
}
```

Use this when you want the rule to remain strict in most places, but allow exceptions in known legacy files.
