# Browser sessions — one browser, tabs in the background, one context per theme

`<base root>` is the path on the session's `base plugin root:` line. base's `browser` convention is
the short form of this file; it reaches the main session and every code-writing subagent. A
password-protected storefront or an overlay: `<base root>/references/storefront-login.md`.

## Why

base starts `chrome-devtools-mcp` and `playwright` headless (`BASE_BROWSER_HEADED=1` shows the
window again), so a check never takes the developer's keyboard focus. The main agent and its
subagents share each server's one browser and its default context. A Shopify preview theme is
remembered in a cookie of the store's domain: two checks of two preview themes on one store in one
context overwrite each other's cookie, and a reload or a link without `?preview_theme_id=` then
serves the other theme, so a missing fix is really a theme swap.

## Rules

1. **One browser per session.** A new check opens a new tab in it (`new_page`, `browser_tabs`
   `action: "new"`), never a new browser or window; close the tabs you opened when the check ends.
2. **Background tabs.** chrome-devtools `new_page` always with `background: true`; `select_page`
   never with `bringToFront: true`. Prefer chrome-devtools for checks: Playwright cannot open a tab
   in the background.
3. **One theme under test = one named context.** Open its first tab with `isolatedContext:
   "<store alias>-<theme id>"` (`new_page`, or `browser_tabs` on Playwright), and every later tab of
   that theme in the same name; two themes never share a context, so never a cookie. A context is
   in memory: the storefront password is entered once per context
   (`<base root>/references/storefront-login.md`).
4. **The full preview URL every time.** Every navigation and reload of a preview theme uses
   `https://<domain><path>?preview_theme_id=<id>` (`&` when the path has a query), never a bare path,
   a clicked link alone or a plain reload. A skill's *reload (full preview URL)* (flip → reload →
   verify, `emulate` and reload, a cache-busting hard-reload) is `navigate_page` to that URL in the
   theme's context (a cache-bust adds its own param beside `preview_theme_id`), never
   `navigate_page type: "reload"`.
5. **Read the served theme before a verdict.** Before any conclusion that a fix is missing or that a
   bug reproduces on a preview theme, read the theme the page serves and compare its `id` with the
   expected one. `evaluate_script` (Playwright: `browser_evaluate`) takes an arrow function:

   ```js
   () => (typeof Shopify === 'undefined' || !Shopify.theme)
     ? { id: null, role: null, name: null, shop: null }
     : { id: String(Shopify.theme.id), role: Shopify.theme.role, name: Shopify.theme.name,
         shop: Shopify.shop }
   ```

   A different `id` is a theme swap, not a bug: reopen the full URL (rule 4) in that theme's context
   (rule 3) and check again. `id: null` is no storefront render (a 404, a challenge, the password
   page). `role: "main"` on a preview link means the link does not reach that theme (a deleted id
   renders the published one).

This snippet is the one served-theme read: qa's preflight gate (`/qa:preflight`) runs it too and adds
its own Block rules.
