---
name: preview-theme
description: >
  Create or refresh an unpublished Shopify PREVIEW theme from the current branch. create =
  build local code + overlay the dev theme's customizer settings (returns theme id +
  preview/editor links); refresh = rebuild and push code only into an existing preview,
  settings untouched. Use when the user asks to create / make / spin up a preview theme,
  test the preview script, or update / refresh / redeploy / rebuild a preview / push a fix
  to one. A bare theme id means refresh that theme.
argument-hint: "[create|refresh] [theme-id] [--name \"[TICKET] …\"] [--reuse] [--no-build]"
arguments:
  - name: mode
    description: create | refresh. Omitted → auto-routing (see Route the mode) — a bare theme id or refresh-wording → refresh; create-wording or no known theme → create.
  - name: theme_id
    description: Numeric id (or gid) of an existing preview theme — implies refresh. Found in the PR preview table, the preview URL (`?preview_theme_id=<id>`), or the admin theme URL (`/themes/<id>`).
  - name: jira_keys
    description: Jira key(s)/numbers to derive the create name from (e.g. ELC-126, or "299 307 309"). Optional.
  - name: theme_name
    description: Explicit preview theme name — overrides derivation from jira_keys.
  - name: preview_path
    description: Storefront path to deep-link the preview to (e.g. /products/group-lipglass). Optional.
  - name: build_overrides
    description: --no-build (developer already built) / --build-cmd "<cmd>" (non-default build). Optional.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh*)
---

# Preview theme (create / refresh)

Both modes wrap `${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh` (the same script
`create-pull-request` uses — running this skill is a good way to test the mechanics in
isolation). **create** builds a named, **unpublished** theme = your branch's code (built
locally) + the dev theme's customizer settings. **refresh** redeploys the branch's code
into an existing preview **without touching its customizer settings** — everything except
`config/settings_data.json`, `templates/**/*.json`, and section groups `sections/*.json`
is pushed, so the content a reviewer configured stays put. Full contract:
`${CLAUDE_PLUGIN_ROOT}/skills/create-pull-request/REFERENCE.md → Preview theme`.

> **Security:** the Theme Access token lives in `shopify.theme.toml`. **Never `Read` that
> file** — the script consumes the token inside the `shopify` subprocess and never prints
> it. Pass nothing secret on the command line.

## Route the mode

- Explicit `create` / `refresh` → that mode.
- A bare **theme id** → **refresh** that theme.
- Neither: a preview-theme id for this ticket is already known (conversation, the PR
  preview table, workspace `notes.md`) → **refresh** it; otherwise → **create**. The
  developer's wording wins over the default ("update/refresh/push the fix" → refresh —
  ask for the id if unknown, pointing at the sources above; never guess an id).
- The modes are NOT interchangeable: `create --reuse` re-overlays the dev theme's
  settings onto the existing theme; `refresh` preserves the theme's settings. When the
  reviewer may have configured content on the preview, refresh is the safe choice.

## Steps — create

1. **Detect.** Run `create-preview-theme.sh info`.
   - **Any `error=` line** (no `shopify.theme.toml`, missing `shopify`/`jq`, unparseable
     config) → report it plainly and stop with the fix (run from the project root /
     install jq / uncomment a `theme = "…"` line). Don't try to read the toml yourself.
   - **Success** → show the detected `store`, `dev_theme_id`, and `dev_theme_name`.
2. **Decide the name.**
   - If `theme_name` was given, use it verbatim.
   - Else if `jira_keys` were given, derive it by swapping the `[DEV]`/role prefix of
     `dev_theme_name` for the key(s): one key → `[ELC-126] Kever | Domaine`; several →
     one bracket, prefix once, numbers slash-separated → `[ELC-299/307/309] Kever | Domaine`.
   - Else **ask** the developer for the name (or the ticket key(s) to derive it).
3. **Confirm before mutating.** This builds the repo and creates a real theme on the
   store. Show the final name and `[ create / reuse existing / cancel ]`. Proceed only on
   explicit confirmation.
4. **Create.** Run `create-preview-theme.sh create --name "<name>"` (add `--reuse` to
   push into an existing same-named theme instead of making a new one). The script runs
   `npm run build`, pushes the built code (settings ignored), then overlays the dev
   theme's settings — pass `--no-build` if the developer already built, or
   `--build-cmd "<cmd>"` for a non-default build. On `error=theme_limit`, the store is at
   its cap (20 non-Plus / 100 Plus) — offer `--reuse` or deleting an old theme. On
   `error=build_failed`, surface the build output and stop.
5. **Report.** Print the resulting `theme_id`, `preview_url`, `editor_url`, `reused`, and
   `built`. If a `preview_path` is known, also give the page-deep-linked preview
   (`<preview_url-origin>/<path>?preview_theme_id=<id>`) and the editor-on-template link
   (`…/editor?previewPath=<url-encoded path>`).
   - On **`error=settings_drift`** the dev theme is **ahead of this branch**. **Don't
     retry** — tell the developer to **duplicate the dev theme manually in the admin**
     and rename it to the `[ELC-…]` name (click-path and why a server-side copy works:
     `${CLAUDE_PLUGIN_ROOT}/skills/create-pull-request/REFERENCE.md → Preview theme`);
     the preview URL is then `…/?preview_theme_id=<the new id>`.
   - On **`error=overlay_push_failed`** / **`error=overlay_pull_failed`** the failure is
     transient or auth (`cause=` names it) — this one IS worth retrying. On a `--reuse`
     target nothing was deleted: the run reports `theme=<id> reused=true mixed_state=…`,
     i.e. that theme now carries this branch's code with unmatched settings.
   - On **`error=ambiguous_name`** / **`error=unusable_theme_id`** nothing was pushed —
     pass `refresh --theme <id>` naming the one theme you mean.
   - On **`error=live_theme_write_refused`** nothing was pushed — the target IS the published
     theme; pick an unpublished/preview theme (different id or name), never that one.
   - On **`error=cli_list_unreadable`** / **`error=live_role_unreadable`** nothing was pushed —
     the store listing came back unreadable, so the live-theme guard could not clear the target;
     check `shopify theme list` by hand, then re-run.

## Steps — refresh

1. **Identify the theme.** Need the target's numeric `theme_id` (see Route the mode for
   where to find it). Do not guess.
2. **Confirm before mutating.** This rebuilds and overwrites the theme's **code**
   (settings are preserved). Show the target id and `[ update / cancel ]`.
3. **Refresh.** Run `create-preview-theme.sh refresh --theme <id>` (add `--no-build` /
   `--build-cmd "<cmd>"` as above).
   - **`error=build_failed`** → surface the build output and stop.
   - **Other `error=`** (no `shopify.theme.toml`, missing `shopify`/`jq`, push failure) →
     report it plainly with the fix; don't read the toml yourself.
4. **Report.** Print the returned `theme_id`, `preview_url`, `editor_url`, and `built`.
   Remind the developer that customizer settings were intentionally left as-is.

## Quality bar

- Never expose the access token; never read `shopify.theme.toml` directly.
- Always confirm before creating or overwriting a theme.
- Report exactly what the script returned — don't invent URLs the script didn't produce.
