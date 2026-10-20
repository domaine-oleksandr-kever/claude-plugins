# Preview theme — auto-create or manual

One section of the `/fe:create-pull-request` (Workflow 6) reference; the index is `../REFERENCE.md`.

The Preview row needs an unpublished theme that shows **this branch's code** with the developer's
**configured customizer content**. So `<fe root>/scripts/create-preview-theme.sh` builds the local repo
(`npm run build`) and pushes the built code, then overlays only the dev theme's settings —
`config/settings_data.json`, `templates/**/*.json`, and section groups `sections/*.json`. It does
**not** clone the dev theme's code (which may be stale or broken); code always comes from the
branch. The script reads the store / dev-theme-id / Theme Access token from `shopify.theme.toml`
out of the **one environment block** the Shopify CLI resolves — reported as `env=`, and the same
block the `pin` subcommand and the `--pin-toml` flag write this work stream's **session theme**
into, keeping the value they replaced on a commented `# fe:superseded` line
(`<fe root>/references/session-theme.md`). To redeploy code into an existing preview theme later
(e.g. after a fix) without disturbing its settings, the `refresh` mode (the
`/fe:preview-theme`) pushes code only.

> **Settings ↔ code drift (`error=settings_drift`):** the dev theme can be **"ahead"** of this
> branch — e.g. its `templates/product.json` references a block type (`subscription_selector`) whose
> schema lives only in another feature branch. Shopify rejects pushing that template onto a preview
> built from this branch's code. A partial overlay would give a misleading preview, so the script
> **stops** with `error=settings_drift`. Its keys — the reaped `created_theme=` /
> `created_theme_deleted=`, the `--reuse` `mixed_state=`, the transient `overlay_push_failed` /
> `overlay_pull_failed` retry, the silent-drop `overlay=partial` / `overlay=empty` warns — and every
> recovery, including the manual dev-theme duplication and the `theme_name` + `theme_url` +
> `theme_admin_url` re-run after it: `<fe root>/references/preview-theme-errors.md`, the `settings_drift` entry.

Code pushes never use `--path .` — the script **assembles a clean push root** of only the
canonical theme dirs and pushes that, so non-theme repo paths can't leak into the push or crash
the CLI. For a file living *inside* a theme dir that still shouldn't ship, pass
`--ignore-extra "<glob>"` (both `create` and `refresh` accept it, repeatable). On a push failure
the script prints the real cause plus a `log=<path>` to the full `shopify` stderr — read that,
don't guess; a held throttle (`cause=throttled`) and the reap keys are `error=` outcomes in
`<fe root>/references/preview-theme-errors.md`.

> **Security:** the access token lives in `shopify.theme.toml`. **Never `Read` that file** —
> it would pull the token into context. The script consumes the token inside the `shopify`
> subprocess and never prints it; it returns only non-secret fields.

Decision flow (step 4 of the skill):

1. **Args win.** If `theme_name` / `theme_url` / `theme_admin_url` were passed in, use them; skip creation.
2. **Session theme wins over auto-creation.** The workspace `notes.md` records a `session-theme: <id>` line → that theme *is* this PR's preview theme (`<fe root>/references/session-theme.md`). **`refresh`** it onto the branch's code (`<fe root>/scripts/create-preview-theme.sh refresh --theme <id>`) — code only, the reviewer-facing settings stay put — and build the table from the returned `theme_id` / `preview_url` / `editor_url`. Skip creation; skip the ask (the developer already chose this theme). The name comes from the `notes.md` line when it recorded one — otherwise omit the **Theme name** row rather than inventing a name. **Skip the refresh when nothing changed:** every `session-theme-pushed:` line naming this `<id>` carries a sha — none is `-`, since a dev server handed over for the id may still be uploading after a later clean refresh — and `git diff --quiet <sha> HEAD -- <scope>` on the last one exits 0 → say "preview is current (pushed at <sha>)" and build the table from the `session-theme:` line, the editor URL from `info`'s `store` (`https://admin.shopify.com/store/<store>/themes/<id>/editor`). Scope: a checkout with a `./package.json` builds, so everything a build may read — `. ':(exclude)*.md' ':(exclude).github' ':(exclude).prettierignore'`; without one, the dirs the script pushes (`assets blocks config layout locales sections snippets templates`). No such line, or any `-` one → refresh as above, and write the workspace lines per `<fe root>/references/preview-theme-errors.md` → Reading a create/refresh result.
3. **`info`** (`<fe root>/scripts/create-preview-theme.sh info`) detects `store`, `env`, `dev_theme_id`, `dev_theme_name`.
   - **`error=…`** (no `shopify.theme.toml`, missing `shopify`/`jq`, unparseable config, an unresolvable environment block) → **manual path**: ask the developer for the theme name + Preview / Admin URLs.
   - **success** → propose the new name (swap the role prefix for the Jira key: `[DEV] Kever | Domaine` → `[ELC-126] Kever | Domaine`; **multiple tickets** → one bracket, prefix once, slash-separated numbers: `[ELC-299/307/309/315/382] Kever | Domaine`) and **ask before mutating**: `create the preview theme now? [ yes / no ]`. One PR = one preview theme regardless of how many tickets it carries — the preview overlays the dev theme's **current** customizer settings, so it reflects the content configured right now, not one ticket in isolation.
4. **`create`** (`<fe root>/scripts/create-preview-theme.sh create --name "<name>" [--reuse]`) builds the branch, assembles the built code into a clean temp dir, pushes it to a new unpublished theme, then overlays the dev theme's customizer settings. It prints `theme_id`, `preview_url`, `editor_url`, `reused`. The skill passes `--reuse` **by default — deliberate**: one PR = one preview theme, so a re-run refreshes the same `[ELC-…]` theme instead of stacking duplicates. Note it will overwrite a pre-existing theme that happens to carry the same name (the bracketed ticket naming keeps collisions ticket-scoped). Record the returned id as the workspace's `session-theme: <id>` line, so aftercare and every later refresh reuse this theme instead of stacking another — **recorded, not pinned**: like the qa phase's fallback this runs unattended, so it never passes `--pin-toml`; the Step 0 session-theme gate re-asserts the pin on the next entry (`<fe root>/references/session-theme.md`). Every run's output — `warn=build_dirtied=`, an unreviewable exit-0 verdict, the workspace lines — is read per `<fe root>/references/preview-theme-errors.md` → Reading a create/refresh result; an `error=` → that key's entry there (per key: was anything pushed, retry or not, the recovery — the `awk` line at the file's top, never the whole file).
