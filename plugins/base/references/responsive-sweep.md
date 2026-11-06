# Responsive sweep — layout breaks between the widths you check

`<base root>` is the path on the session's `base plugin root:` line.

A check at three or four fixed widths misses a break that lives between them (a header that wraps
to two lines at 1024–1150 px, text cut by a fixed-height block below 460 px). The sweep measures
many widths without screenshots and returns one text table.

**When** — once on each page under test, after the change is on the surface you validate and before
its result or preview goes to the developer. Only a change that touches markup, CSS or theme JSON
needs it; a copy-only or data-only change reports one line, `sweep: not run — <copy-only | data-only> change`.

`<base root>/scripts/responsive-sweep.js` defines one in-page function, `responsiveSweep(opts)`:

- `{ widths: [<breakpoint px>…], step }` starts a sweep and returns the widths to visit: 320 to 1920
  every `step` px (default 40, so a 100 px wide break shows at two widths at least), plus each
  breakpoint and 1 px below it (an `em` or `rem` breakpoint counts 16 px each).
- `{ root: '<selector>' }` (the section under test, e.g. `#shopify-section-<id>`; default `body`)
  waits for fonts and two animation frames, then measures the current width and stores the result
  on the page: sideways page scroll (always, whatever the root), an element sticking out of the
  viewport, content spilling out of its box, text cut by a fixed height (`line-clamp` labelled) or at
  the side (`ellipsis` labelled), and a heading, button, link, label or nav item of 40 characters or
  less on 2+ lines. Each finding names a short selector (`#<id ancestor> <parent> > <tag.class>`).
- `{ table: true }` folds the stored widths into the table: one row per element and finding, with the
  widths where it shows as ranges (`#shopify-section-header nav.menu > a.menu-link ×2 | 2 lines | 1024-1120`).
  A range runs from the first to the last measured width that shows the finding; the break itself
  sits between that width and the next one measured. Capped at 30 rows / 3000 bytes; the last line
  counts the dropped rows and gives the `maxRows` / `maxBytes` call that shows them.

It reads layout only: no click, no fill, no style change.

- **Playwright MCP** — one `browser_run_code_unsafe` call with inline `code`, on the page already open:
  `async (page) => { await page.addScriptTag({ path: '<base root>/scripts/responsive-sweep.js' }); const v = page.viewportSize() || { width: 1280, height: 800 }; for (const width of await page.evaluate(b => responsiveSweep({ widths: b }), [<breakpoints>])) { await page.setViewportSize({ width, height: v.height }); await page.evaluate(r => responsiveSweep({ root: r }), '<root selector>'); } await page.setViewportSize(v); return await page.evaluate(() => responsiveSweep({ table: true })); }`
- **chrome-devtools MCP** — no in-call resize, so two calls per width and a shorter list (`step: 160`):
  1. `evaluate_script` with `sourcePath: '<base root>/scripts/responsive-sweep.js'` and `format: 'script'`
     (defines the function until the next navigation);
  2. `evaluate_script` `function: "() => responsiveSweep({ widths: [<breakpoints>], step: 160 })"`;
  3. per width: `emulate` with `viewport: '<width>x<height>x1'` (each call replaces every emulation
     setting: pass the others you use), then `evaluate_script`
     `function: "() => responsiveSweep({ root: '<root selector>' })"`. Not `resize_page`: it sizes the
     window, which stops at its minimum width (500 px in a headed Chrome);
  4. `evaluate_script` `function: "() => responsiveSweep({ table: true })"`, then `emulate` with no
     `viewport` to clear the override.

  A break narrower than 160 px can fall between two widths: the report says `step 160`, and a
  layout-critical change is swept on the Playwright MCP when one is loaded.

1. **Breakpoints** — the project's own (its Tailwind config, the theme's media queries), never a
   guess; none found → the dense list alone, and the report says so.
2. **Each row is a lead, not a verdict** — check the element at that width (its computed styles, the
   Figma node) and fix it or say why it is intended (a `line-clamp`, a carousel's peeking slide).
3. **Report** — the validation result carries the table as the snippet returned it, or one line
   `sweep: not run — <reason>`. The sweep covers the one store it ran on; a section used on more
   stores → the report names each other store as `not checked`.
