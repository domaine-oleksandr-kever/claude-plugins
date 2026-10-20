# Storefront login — a password-protected storefront in a browser MCP

`<base root>` is the path on the session's `base plugin root:` line.

1. **Password** — `node <base root>/scripts/qa-stores.cjs get <store> --field password`: its raw
   output is the fill value as is; empty = an open storefront, nothing to fill. Not on file → ask the
   developer, or a memory note holds it. A dev and a UAT store of the same brand can have different
   passwords: take each store's own, never another store's.
2. **Open** `https://<domain>/password`.
3. **Field** — `form:has(input[value=storefront_password]) input[name=password]`, the storefront
   gate's input (a page can carry other password inputs); take its `ref` / `uid` from a snapshot.
4. **Fill** — Playwright MCP: `browser_type` (or `browser_fill_form`) on that ref; chrome-devtools
   MCP: `fill` on that uid. Never through `browser_evaluate` / `evaluate_script` with the password
   in a JS string: the host's auto-mode classifier blocks that as input exfiltration.
5. **Submit** — Enter or a click on the form's submit button, then wait for the next page to reach
   `domcontentloaded` before any read.
6. **Verify** — still on `/password`, or a `form[action*="/password"]` on the page → the password is
   wrong or stale: ask for the current one; never submit the same one again.
