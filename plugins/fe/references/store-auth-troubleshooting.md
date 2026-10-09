# Store auth — troubleshooting & the re-auth blurb

Read this only when `store auth` fails, expires, or the browser step misbehaves
(gated from `metafield-metaobject-setup.md` → Store access).

Browser-step troubleshooting: **HTTP 431** on the authorize URL = cookie bloat on
`.myshopify.com` — have the developer open that same URL in an **incognito** window (log in
there; the CLI keeps listening on its localhost callback, so the flow completes) or clear
cookies for the store domain and retry. A "This store will be right back" page means a wrong
or paused store domain.

**Asking the developer to (re-)auth — short, with context.** The developer may not know this
CLI 4.x flow exists, so never just say "auth expired". And don't interrupt at all if the runner
already fell back to the token engine — the work isn't blocked; mention it at the next natural
pause. When you ARE blocked (neither engine set up) or want the preferred engine back, ask with
a compact blurb like:

> Store auth for `<domain>` is missing/expired — it's an online token (max 24 h, dies with your
> admin session). One command restores it; it's the Shopify CLI 4.x flow that installs a
> Shopify-managed app on the store, so no token ever lands in the repo. Run it right here:
>
> `! shopify store auth --store <domain> --scopes <scopes the task needs>`
>
> A browser window will open — approve it there. It needs the store's **"Install apps"**
> permission; if you don't have it, say so and we'll use `SHOPIFY_ADMIN_TOKEN` in `.env`
> (or the GraphiQL flow) instead. And tell me if this store should stay **read-only** — then
> I'll request only the `read_*` scopes and hand the mutations to you instead of running them.

The `!` prefix runs the command inside the Claude Code session, so its output lands in the
conversation. If the developer asks *you* to run it, run it in the foreground and tell them to
complete the browser approval.
