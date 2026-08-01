# Preview-theme runner — `error=` outcomes and page deep-links

Single home for interpreting `create-preview-theme.sh` failures and building page
deep-links, read on demand by both callers (`preview-theme` skill; `create-pull-request`
step 4). The script never half-succeeds silently — every failure exits with one `error=`
key. Flow context (decision flow, drift blockquote, push-root mechanics) stays in
`${CLAUDE_PLUGIN_ROOT}/skills/create-pull-request/REFERENCE.md → Preview theme`.

## `error=` outcomes

- **`info` errors** (no `shopify.theme.toml`, missing `shopify`/`jq`, unparseable config) → report
  the line with its fix (run from the project root / install `jq` / uncomment a `theme = "…"` line)
  and take the manual path. Never read the toml to "check".
- **`error=build_failed`** → surface the build output and **stop**: fix the branch, don't enter
  theme URLs by hand.
- **`error=theme_limit`** → the store is at its theme cap (20 / 100). Pass `--reuse` if this run
  didn't (it refreshes the same-named theme instead of stacking); otherwise delete an old theme.
- **`error=settings_drift`** → **don't retry**. The recovery is manual and the same for both modes:
  the developer **duplicates the dev theme in the Shopify admin** (a server-side copy keeps every
  setting, drifted or not) and **renames the copy to the `[ELC-…]` name** — click-path and why: the
  drift blockquote in `${CLAUDE_PLUGIN_ROOT}/skills/create-pull-request/REFERENCE.md → Preview theme`. Then
  `create-pull-request` re-runs with `theme_name` + `theme_url` + `theme_admin_url` (it uses that
  theme and skips auto-creation), while `preview-theme` just pushes code into it with
  `refresh --theme <the new id>`. The preview URL is `…/?preview_theme_id=<the new id>`.
- **`error=overlay_push_failed`** / **`error=overlay_pull_failed`** → transient or auth (`cause=`
  names it), so this one IS worth retrying; the same drift blockquote covers the `--reuse`
  `mixed_state=` case.
- **`error=ambiguous_name`** / **`error=unusable_theme_id`** → nothing was pushed; re-run
  `refresh --theme <id>` naming the one theme you mean.
- **`error=live_theme_write_refused`** → nothing was pushed: the target IS the published theme.
  Pick an unpublished/preview theme (a different id or name), never that one.
- **`error=cli_list_unreadable theme=<id>`** / **`error=live_role_unreadable`** → nothing was
  pushed; the store listing came back unreadable (or the theme carried no readable role), so the
  live-theme guard could not clear that **known** target. Check `shopify theme list` by hand,
  then re-run.
- **`error=cli_list_unreadable`** with **no `theme=`** (a `create` run resolving `--name`) →
  nothing was pushed and the name could not be resolved, so a blind re-run risks a **duplicate
  same-named theme**. Resolve the name by hand first, then `refresh --theme <id>` — or re-run
  only once the listing is readable.
- **The code push itself failed** — `error=push_code_failed` (plain `create`),
  `error=push_code_failed_reuse` (`create --reuse`), `error=refresh_push_failed` (`refresh`). Each
  prints the real cause: `log=<path>` to the full `shopify` stderr plus its last 25 lines (usually a
  rejected asset named a few lines above a ruby trace), and `cause=throttled` when the rate limit
  held. **Did anything land?** On the plain `create` the theme this run created is reaped
  (`created_theme=` + `created_theme_deleted=yes`, or `=failed` → that theme is still on the store
  burning a slot); **no `created_theme=` line at all** → the reap could not attribute a theme (an
  unreadable fresh listing, or a concurrent run made the name ambiguous) — check
  `shopify theme list` for a code-less `<name>` theme before re-running. On `--reuse` and on
  `refresh` the target **pre-existed and may now carry partial
  code** — say so, and tell the reviewer the preview is mid-update until a push succeeds. Fix the
  named cause, then re-run the same command (a re-push is idempotent — it overwrites, it never
  stacks).
- **`error=invalid_theme_id`** → nothing ran: `refresh --theme` and `pin --theme` take a
  **numeric** id; a gid (`gid://shopify/OnlineStoreTheme/…`) or a name is refused — strip it to
  the digits, or use `create --name "<name>" --reuse`, which resolves and vets a name.
- **`error=invalid_dev_theme_id`** / **`error=invalid_store`** → nothing ran: the toml's `theme =` /
  `store =` line is unusable (non-numeric id, or a store that isn't a myshopify handle/URL). Take the
  manual path and have the developer fix that line — never read the toml to "check". The one
  exception is `pin`, which is deliberately allowed to run on a config in that state: it exists
  to repair the `theme =` line, so `pin --theme <id>` is the fix for `invalid_dev_theme_id`.
- **Session-theme pin outcomes** (`pin`, and `create` / `refresh` with `--pin-toml` —
  `${CLAUDE_PLUGIN_ROOT}/references/session-theme.md`):
  - **`error=theme_not_found theme=<id> store=<store>`** → nothing was written: no theme with
    that id is listed on the store. Check the id (a preview URL's `?preview_theme_id=…`) or
    create one. Note `error=live_theme_write_refused` guards pin-only mode too — pinning the
    published theme would point `shopify theme dev` at the storefront.
  - **`error=theme_unverifiable`** → nothing was written: the store listing was unavailable, so
    the id could not be vetted, and a standalone `pin` refuses rather than persist an unvetted
    pin. Retry when the store answers. On `create`/`refresh --pin-toml` the same outage is
    non-blocking: the pin proceeds, flagged by a `warn=pin_unvetted` line before the pin keys
    (the id was just pushed to, so it exists) — a warning, not an error.
  - **`error=ambiguous_env envs='<a b>'`** → the toml's `[environments.*]` blocks include none
    named `dev`/`development` (a lone block with another name is refused, never auto-picked),
    so which one the dev server reads cannot be guessed. Nothing
    was written. Ask the developer which environment `npm run dev` uses and re-run with
    `--env <name>`.
  - **`error=env_not_found env='<name>'`** → that `[environments.<name>]` block isn't in the
    file (the message lists the ones that are). Nothing was written.
  - **`error=pin_toml_failed toml=<path>`** → the rewrite itself failed (permissions, disk).
    Nothing was written; the file is untouched.
  - On `create` / `refresh` those same failures are **non-fatal** and arrive as
    `pin=failed` + `pin_error=…` *after* a normal `theme_id=` line: the theme exists, only the
    config wasn't changed. Record the id, say the pin didn't land, and keep handing the
    developer the explicit `npm run dev -- --theme <id>` form. A `pin_error=` naming a
    **non-numeric theme id** means the push reported a gid — the theme is real, the config was
    correctly left alone.
  - **Restoring a pin by hand:** the superseded value sits on the `# theme = "…" #
    fnd:superseded` line directly above the pinned one — the developer uncomments it and
    deletes the session line (an appended session line is tagged `# fnd:session-theme` — just
    delete it). Same edit `worktree-setup.sh`'s unpin makes.
- **`cause=throttled`** on any push failure → the rate limit held through the script's own retries
  (the store+token limit is shared with a running `shopify theme dev`) — stop the competing
  consumer, or wait, then re-run.
- **Anything else** — the script also refuses uncoded, self-explaining states: a usage/argument error
  (`unknown arg`, `refresh requires --theme <id>`, `create requires --name`), `no access token`,
  `code push succeeded but could not parse theme id from --json`. Nothing was pushed except in that
  last one (the code IS on the theme — find its id in the admin and continue with `refresh`). Report
  the line verbatim with the fix it names, fix the invocation, re-run. Never read the toml to "check".

## Page deep-links

When the change is reviewed on a specific storefront path (`preview_path`, or inferable from
context — e.g. you developed/QA'd on `/products/group-lipglass`), deep-link the rows instead of
sending the reviewer to the home page:

- **Preview** → `https://<store>/<path>?preview_theme_id=<id>` (append the path to the base `preview_url`).
- **Admin** → the theme editor on that template: `https://<store>/admin/themes/<id>/editor?previewPath=<url-encoded path>`, or `?template=<name>` when the developer names the template (e.g. `product`, `product.lipglass`).

If the path or template is unknown or ambiguous, **ask the developer — never guess.**

**Several pages / several tickets:** when the bugs live on different pages, list one deep-link per
page in the Preview row (e.g. `[PDP](…/products/x?preview_theme_id=ID) · [Cart](…/cart?preview_theme_id=ID)`),
ideally labelled by ticket. Same preview theme ID throughout — only the path differs.
