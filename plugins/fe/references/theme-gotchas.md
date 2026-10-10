# Theme gotchas — Shopify traps that fail silently

Read by `/fe:develop-feature-or-fix` Phase 2 (implement + in-browser validation). Each entry is a
trap that passes a build and a glance and still ships wrong. **`<fe root>`** = the path on the
session context's `fe plugin root:` line.

## Settings and templates

- Shopify does not reject an undeclared setting — it **drops** it. A value and its schema
  declaration ship together: a theme setting (`settings.*`) → `config/settings_schema.json`; a
  section setting → that section's `{% schema %}`.
- A new section or block needs `presets` to appear in the editor. Wire it on the session theme
  via `<fe root>/scripts/theme-json.sh set` and let Steps to Test carry the setup recipe — a
  deploy carries code, not template JSON.
- Alternate templates are reached with `?view=<name>` (`templates/<type>.<name>.json`). One made
  for a test needs manual cleanup: `theme-json.sh` has no delete.

## Liquid

- `content_for 'blocks'` renders the section's block list; `content_for 'block'` renders one
  static block by `type` + `id` — not interchangeable.
- `for` stops at 50 items → `paginate` for anything longer.
- No Liquid inside `{% stylesheet %}` — it is not rendered.

## CSS

- Tailwind v4 uses native `@layer`: an unlayered `!important` rule loses to a `!` utility.

## Verifying in the browser

- Liquid-error check: read `innerText` (an error inside an attribute ends at `&quot;`) and
  de-duplicate. An error naming files the diff never touched is pre-existing → note it, never a
  blocker. HTTP status: `performance.getEntriesByType('navigation')[0].responseStatus`.
- A 429 names the request that got hit, not the burst that caused it.
- Perf: Long Tasks attribute frames, not scripts → use Long Animation Frames
  (`scripts[].sourceURL`). `/cdn/shopifycloud/` and `/cdn/wpm/` are served from the merchant
  host; app extensions load from `cdn.shopify.com/extensions/…/assets/`. A warm reload shows
  `transferSize: 0` — measure transfer on a cold load.
