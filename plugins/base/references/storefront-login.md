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
