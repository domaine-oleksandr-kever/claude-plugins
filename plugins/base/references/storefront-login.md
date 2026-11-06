# Storefront login — a password-protected storefront in a browser MCP

`<base root>` is the path on the session's `base plugin root:` line.

1. **Password** — `node <base root>/scripts/qa-stores.cjs get <store> --field password`: its raw
   output is the fill value as is; empty = an open storefront, nothing to fill. Not on file → ask the
   developer, or a memory note holds it. A dev and a UAT store of the same brand can have different
   passwords: take each store's own, never another store's.
2. **Open** `https://<domain>/password`.
3. **Field** — `form[action*="/password"] input[name=password]`, the storefront gate's input (the
   gate form posts to `/password`; a page can carry other password inputs). A page with several
   `/password` forms → the narrower `form:has(input[value=storefront_password]) input[name=password]`
   (not every theme's gate form carries that `form_type` field). Take its `ref` / `uid` from a
   snapshot; no ref because the field is hidden behind an "Enter using password" button → click
   that button, then snapshot again.
4. **Fill** — Playwright MCP: `browser_type` (or `browser_fill_form`) on that ref; chrome-devtools
   MCP: `fill` on that uid. Never write login code: no `browser_run_code_unsafe`,
   `browser_evaluate` or `evaluate_script` that fills or submits the gate (a `.fill`, a `.value =`,
   a form submit or a POST to `/password`), also not on the field handed to it as a ref or uid. The host's auto-mode classifier blocks the password in a
   JS string as input exfiltration, a scripted fill waits 30 s on a hidden field, and base's MCP
   guard refuses such a call once per session.
5. **Submit** — Enter or a click on the form's submit button, then wait for the next page to reach
   `domcontentloaded` before any read.
6. **Verify** — still on `/password`, or a `form[action*="/password"]` on the page → the password is
   wrong or stale: ask for the current one; never submit the same one again.

## Overlays and blocked clicks

`<base root>/scripts/storefront-overlay.js` defines one in-page function, `storefrontOverlay(opts)`. It
removes the known consent overlays (`#onetrust-consent-sdk`, `#CybotCookiebotDialog`) and each
`opts.hide` selector, never an element that holds or sits in the password gate, and returns
`{ removed, kept, covering }`: `removed` adds `×N` to a selector that removed N elements, and
`covering` names each visible full-viewport fixed element and open modal still on the page. Every
name it returns selects that one element. `opts.probe` (a selector) adds `probe`: `found`,
`disabled` (also `pointer-events: none`), `hidden`, `offscreen` (also outside a clipping
ancestor), or `covered` with `by` (the element at the target's centre) and `layer` (its outermost
fixed ancestor that does not hold the target). It never fills or submits, so base's MCP guard lets
it run.

- **Playwright MCP** — one `browser_run_code_unsafe` call with inline `code` (its `filename` takes
  only a file inside the project); leave out `hide` or `probe` you do not need:
  `async (page) => { await page.addScriptTag({ path: '<base root>/scripts/storefront-overlay.js' }); return await page.evaluate(o => storefrontOverlay(o), { hide: ['<selector>'], probe: '<selector>' }); }`
- **chrome-devtools MCP** — `evaluate_script` with `sourcePath: '<base root>/scripts/storefront-overlay.js'`
  clears the known overlays; add `args: ['<uid>']` to probe that element too. With `hide` or a probe
  selector: the same `sourcePath` with `format: 'script'` (defines the function until the next
  navigation), then `function: "() => storefrontOverlay({ hide: ['<selector>'], probe: '<selector>' })"`.

1. **When** — once after the page settles (`domcontentloaded`, past the login above) and before the
   first click on it.
2. **Blocked click** — a click that fails with `intercepts pointer events` or a timeout is never
   retried unchanged: probe its target and act on the answer. `covered` → `hide` the `layer` (else
   `by`), then click once more; `disabled` → never click it (a carousel at its end, a sold-out
   variant): change the state that enables it, or report it; `hidden` / `offscreen` → open its
   container or scroll it into view; `found: false` → snapshot again.
3. **Project overlays** — a theme's own overlay (a region modal, a newsletter popup) is project
   code: the plugin holds no selector for it. Take it from the developer, the project's notes or
   memory, or a probe's `layer`, and pass it in `hide` from then on.
4. **No consent** — removing a consent banner gives no consent: consent-gated scripts (analytics,
   pixels, some widgets) stay off. A check that needs them goes to the developer.
