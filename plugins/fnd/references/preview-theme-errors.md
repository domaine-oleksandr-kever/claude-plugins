# Preview-theme runner — `error=` outcomes and page deep-links

Single home for interpreting `create-preview-theme.sh` failures and building page
deep-links, read on demand by both callers (`preview-theme` skill; `create-pull-request`
step 4). Every HARD failure exits with one `error=` key. The one class Shopify hides from the
CLI — a settings file rejected server-side on a push that exits 0 with a clean stderr — is
caught instead by `create`'s overlay read-back and surfaces as `overlay=partial` +
`warn=overlay_file_dropped` on a run that still exits 0; act on those warn lines (below), never
skim past them. Flow context (decision flow, drift blockquote, push-root mechanics) stays in
`<plugin root>/skills/create-pull-request/REFERENCE.md → Preview theme`, where **plugin root** =
the plugin's own directory — this file is `<plugin root>/references/preview-theme-errors.md`, and
every `<plugin root>/…` path below resolves the same way.
On Claude Code the session context opens with `fnd plugin root: <absolute path>` — write that path
into commands; the Bash tool's shell does not set `${CLAUDE_PLUGIN_ROOT}`, so a literal one expands
to empty. On other hosts substitute the same path.

## `error=` outcomes

- **`info` errors** (no `shopify.theme.toml`, missing `shopify`/`jq`, unparseable config) → report
  the line with its fix (run from the project root / install `jq` / uncomment a `theme = "…"` line)
  and take the manual path. Never read the toml to "check". `error=common_lib_not_found path=…`
  is the plugin install, not the project: `scripts/_shopify-common.sh` must sit beside the script
  (a partial copy of `scripts/` drops it) — reinstall or update the plugin; nothing ran.
- **`error=build_failed`** → surface the build output and **stop**: fix the branch, don't enter
  theme URLs by hand.
- **`error=bad_build_script`** → nothing was built or pushed, and **retrying the same value is
  pointless**: `--build-script` takes the NAME of a script in the repo's `package.json`
  (`[A-Za-z0-9_.:-]`), never a command line — the script runs it as `npm run <name>`, never through
  a shell. Re-run with a name `package.json` defines (or `--no-build` if the repo is already built).
- **`error=build_script_missing`** → same: nothing was built or pushed, no retry. The named script
  is absent from `scripts` in `./package.json` (or there is no readable `package.json` in the
  project root the run started from). Read the repo's `package.json`, pick the script it defines
  for a production build, and re-run — or ask the developer which one to use. Don't invent one.
- **`error=theme_limit`** → the store is at its theme cap (20 / 100). Pass `--reuse` if this run
  didn't (it refreshes the same-named theme instead of stacking); otherwise delete an old theme.
- **`error=settings_drift`** → **don't retry**. The recovery is manual and the same for both modes:
  the developer **duplicates the dev theme in the Shopify admin** (a server-side copy keeps every
  setting, drifted or not) and **renames the copy to the `[ELC-…]` name** — click-path and why: the
  drift blockquote in `<plugin root>/skills/create-pull-request/REFERENCE.md → Preview theme`. Then
  `create-pull-request` re-runs with `theme_name` + `theme_url` + `theme_admin_url` (it uses that
  theme and skips auto-creation), while `preview-theme` just pushes code into it with
  `refresh --theme <the new id>`. The preview URL is `…/?preview_theme_id=<the new id>`.
- **`error=overlay_push_failed`** / **`error=overlay_pull_failed`** → transient or auth (`cause=`
  names it), so this one IS worth retrying; the same drift blockquote covers the `--reuse`
  `mixed_state=` case. `overlay_pull_failed` also fires when the pull wrote no settings file at
  all (`cause=` names the 0 *.json) — then retrying replays it: check that the toml's
  `dev_theme_id` is a real theme with customizer content before re-running.
- **`overlay=partial` + `warn=overlay_file_dropped file=<f> [unknown_types=<t,…>]`** (create,
  **exit 0**) → the same drift as `error=settings_drift`, but Shopify rejected the file(s)
  server-side while the push reported success — caught by the read-back, not the CLI. The affected
  pages **404 (missing template) or show stale content**, so the preview is NOT reviewable until
  fixed; say so instead of handing over the preview URL as-is. Recover **per file on the surviving
  theme** — do not delete/re-create, a re-create replays the same drop: `theme-json.sh get` the
  file from the DEV theme, strip the `unknown_types=` section/block entry plus its
  `order`/`block_order` reference, `theme-json.sh set` it onto the preview theme (read-back
  verified) — or, when full-fidelity settings matter, the manual dev-theme duplication from the
  `settings_drift` entry above. `unknown_types=` is best-effort (source types matched against the
  pushed code's schemas); absent, diff the file's section/block types against the branch by hand.
- **`overlay=unverified` + `warn=overlay_unverified`** (create, exit 0) → the read-back pull
  failed, so whether every settings file landed is unknown. Spot-check a key template
  (`theme-json.sh get --theme <id> --file templates/product.json`) before offering the preview.
- **`overlay=empty` + `warn=overlay_empty dev_theme_id=<id>`** (create `--reuse`, exit 0) → the
  settings pull off the dev theme returned no `*.json`, so nothing was overlaid and the reused
  theme keeps its previous settings — NOT a reviewable preview until the overlay lands. Check that
  the id is a real theme with customizer content (`info`, `shopify theme list`), fix the toml if
  not, then re-run `create --reuse` (a re-push overwrites). On a fresh create the same pull is
  `error=overlay_pull_failed` and the theme is deleted.
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
- **`error=refresh_unverifiable theme=<id> store=<s>`** / **`error=reuse_unverifiable name=<n>`**
  → nothing was pushed or created: the store listing was **silent** (the call failed, or it named
  no theme at all), so the live-theme guard could not clear the id / the name could not be
  resolved, and — for `refresh` — no workspace under `.claude/tasks` records that id as
  `session-theme:` (a `--reuse` name has no such exemption). That check is an **id lookup across
  every workspace under the current directory, not provenance** — the gate in
  `<plugin root>/references/session-theme.md` still applies before an unattended refresh; a
  legacy `.claude/fnd/` workspace is not scanned (migrate it first). Re-run when the store
  answers. A developer may pass `--allow-unverified` (it lifts these two refusals only — never
  the live-theme guard, never the dev-theme guard); **never add it unattended**.
- **`error=dev_theme_write_refused theme=<id> name=<n>`** → nothing was pushed: the target is
  an id the toml names as the **shared dev theme** — its settings source (unless the developer
  pinned this id by hand) or an id a pin superseded. If it IS this stream's session theme, record the `session-theme:` line
  in the workspace `notes.md` (session-theme.md step 4) and re-run without any flag; else push
  to a session/preview theme (`create --name "<name>" --reuse --pin-toml` makes one).
  `--allow-dev-theme` overwrites the shared theme deliberately — only on the developer's explicit
  say-so, and `--allow-unverified` does not cover this refusal.
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
  **numeric** id; a gid (`gid://shopify/OnlineStoreTheme/…`), a name or a leading zero is refused —
  strip it to the digits, or use `create --name "<name>" --reuse`, which resolves and vets a name.
- **`error=invalid_dev_theme_id`** / **`error=invalid_store`** → nothing ran: the toml's `theme =` /
  `store =` line is unusable (non-numeric id, or a store that isn't a myshopify handle/URL). Take the
  manual path and have the developer fix that line — never read the toml to "check". The one
  exception is `pin`, which is deliberately allowed to run on a config in that state: it exists
  to repair the `theme =` line, so `pin --theme <id>` is the fix for `invalid_dev_theme_id`.
- **Session-theme pin outcomes** (`pin`, and `create` / `refresh` with `--pin-toml` —
  `<plugin root>/references/session-theme.md`):
  - **`error=theme_not_found theme=<id> store=<store>`** → nothing was written: no theme with
    that id is listed on the store. Check the id (a preview URL's `?preview_theme_id=…`) or
    create one. Note `error=live_theme_write_refused` guards pin-only mode too — pinning the
    published theme would point `shopify theme dev` at the storefront.
  - **`error=theme_unverifiable`** → nothing was written: the store listing was unavailable, so
    the id could not be vetted, and a standalone `pin` refuses rather than persist an unvetted
    pin. Retry when the store answers. Under the same outage a fresh `create --pin-toml` proceeds,
    `refresh --pin-toml` only for a recorded session theme or with `--allow-unverified`, and
    `--reuse --pin-toml` only with `--allow-unverified` (else `refresh_unverifiable` /
    `reuse_unverifiable`, above); the
    pin is then flagged by a `warn=pin_unvetted` line before the pin keys (the id was just
    pushed to, so it exists) — a warning, not an error.
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

Deep-links are the **default** form of the Preview row, not an on-request extra. Before
falling back to a bare home-page link, collect the surfaces the change was actually verified
on — **without being asked**: the workspace verification record (`notes.md` / `qa.md` test
URLs and the pages named next to screenshots), the develop/QA phases of this conversation,
an explicit `preview_path`. A path that record names is **not a guess** — use it. Then:

- **Preview** → `https://<store>/<path>?preview_theme_id=<id>` (append the path to the base `preview_url`).
  Carry every query param the feature needs to render (a market/locale switch like
  `&country=GB`, a variant selection) on **each storefront deep-link** — a link that lands on
  a page where the change is invisible is worse than no link. The Admin link never takes them.
- **Admin** → the theme editor on that template: `https://<store>/admin/themes/<id>/editor?previewPath=<url-encoded path>`, or `?template=<name>` when the developer names the template (e.g. `product`, `product.lipglass`).

Ask the developer **only** when no verification record names a path and the surface is
genuinely ambiguous — never guess a URL into the table.

**Several pages / several tickets:** one deep-link per surface in the Preview row, labelled by
surface (`[PLP](…) · [PDP](…) · [Cart](…)`, Admin last) — by ticket when a multi-ticket PR's
bugs live on different pages. Same preview theme ID throughout — only the path differs.
