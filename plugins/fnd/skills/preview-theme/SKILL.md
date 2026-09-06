---
name: preview-theme
description: >
  Create or refresh an unpublished Shopify PREVIEW theme from the current branch. Use when
  the user asks to create / make / spin up a preview theme, test the preview script, or
  update / refresh / redeploy / rebuild a preview / push a fix to one. A bare theme id
  means refresh that theme.
argument-hint: "[create|refresh] [theme-id] [--name \"[TICKET] …\"] [--reuse] [--no-build]"
arguments:
  - name: mode
    description: create | refresh. Omitted → auto-routing (see Route the mode).
  - name: theme_id
    description: Numeric id of an existing preview theme — implies refresh (a gid or a name is refused).
  - name: jira_keys
    description: Jira key(s)/numbers to derive the create name from (e.g. ELC-126, or "299 307 309"). Optional.
  - name: theme_name
    description: Explicit preview theme name — overrides derivation from jira_keys.
  - name: preview_path
    description: Storefront path to deep-link the preview to (e.g. /products/group-lipglass). Optional.
  - name: build_overrides
    description: --no-build (developer already built) / --build-script <name> (a package.json script other than `build`). Optional.
allowed-tools: Read, Glob, Bash(${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh*)
---

# Preview theme (create / refresh)

Both modes wrap `<plugin root>/scripts/create-preview-theme.sh` — **plugin root** = the
plugin's own directory, `../../` relative to this skill's directory, and every
`<plugin root>/…` path below resolves the same way; on Claude Code it is `${CLAUDE_PLUGIN_ROOT}` —
the host substitutes the absolute path into this text, so the path you see here is the one to write
into commands (no shell variable carries it). It is the same script `create-pull-request` uses — running this skill is a good way to
test the mechanics in isolation. **create** builds a named, **unpublished** theme = your branch's code (built
locally) + the dev theme's customizer settings. **refresh** redeploys the branch's code
into an existing preview **without touching its customizer settings** — everything except
`config/settings_data.json`, `templates/**/*.json`, and section groups `sections/*.json`
is pushed, so the content a reviewer configured stays put. Full contract:
`<plugin root>/skills/create-pull-request/REFERENCE.md → Preview theme`. The
**`error=` outcomes** + **page deep-link formulas** the steps below defer to live in the
errors reference — `<plugin root>/references/preview-theme-errors.md` (read it
when a run fails or a deep-link is needed).

When this checkout is a `git worktree` — or anything else already holds port 9292 — its dev
server has to start on the theme the workspace's `notes.md` records as `session-theme:` and
the port it records as `dev-port:` (`npm run dev -- --theme <id> --port <N>`), otherwise it
silently collides with the main checkout's server or overwrites the shared dev theme
(`<plugin root>/references/session-theme.md`).

> **Security:** the Theme Access token lives in `shopify.theme.toml`. **Never read that
> file** — the script consumes the token inside the `shopify` subprocess and never prints
> it. Pass nothing secret on the command line.

## Route the mode

- Explicit `create` / `refresh` → that mode.
- A bare **theme id** → **refresh** that theme.
- Neither: a preview-theme id for this ticket is already known (the workspace `notes.md`
  `session-theme: <id>` line **wins** — that is this work stream's theme, refresh it rather
  than creating a second one; then the conversation, the PR preview table, a preview URL's
  `?preview_theme_id=<id>`, an admin `/themes/<id>` URL) → **refresh** it; otherwise →
  **create**. The
  developer's wording wins over the default ("update/refresh/push the fix" → refresh —
  ask for the id if unknown, pointing at the sources above; never guess an id).
- The modes are NOT interchangeable: `create --reuse` re-overlays the dev theme's
  settings onto the existing theme; `refresh` preserves the theme's settings. When the
  reviewer may have configured content on the preview, refresh is the safe choice.

## Steps — create

1. **Detect.** Run `create-preview-theme.sh info`. **Success** → show the detected `store`,
   `dev_theme_id`, and `dev_theme_name`. Any `error=` line → the errors reference's
   **`error=` outcomes**, and never read the toml yourself.
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
   `--build-script <name>` when the production build is a different `package.json` script —
   a script **name**, never a shell command (anything else is refused before any
   push). **Any `error=` line** → report it plainly,
   then follow the errors reference's **`error=` outcomes** — it names, per code, whether
   anything was pushed, whether retrying is right, and the recovery. Don't improvise one.
   A run that exits 0 with `overlay=partial` + `warn=overlay_file_dropped` lines is NOT a
   clean success: the named settings files never landed (their pages 404 or go stale) —
   report the warn lines and follow the same reference's recovery before offering the URL.
5. **Report.** Print the resulting `theme_id`, `preview_url`, `editor_url`, `reused`,
   `built`, and — when it isn't `verified` — the `overlay=` verdict with its warn
   lines. If a `preview_path` is known, also give the page-deep-linked preview and the
   editor-on-template link (formulas: the errors reference's **Page deep-links**); path or
   template unknown → **ask, never guess**.
6. **Record it as the work stream's session theme.** When a task workspace for this work-id
   exists, append the id to its `notes.md` as a dated `session-theme: <id> (<name>)
   <preview_url>` bullet — otherwise the next fnd `ship` skill run, qa phase or PR run finds
   no line and creates a *second* theme for the same stream. Do **not** pass `--pin-toml`
   here: the pin rewrites the developer's `shopify.theme.toml` and is the session-theme
   offer's call (`<plugin root>/references/session-theme.md`), not this skill's.

## Steps — refresh

1. **Identify the theme.** Need the target's numeric `theme_id` (see Route the mode for
   where to find it). Do not guess.
2. **Confirm before mutating.** This rebuilds and overwrites the theme's **code**
   (settings are preserved). Show the target id and `[ update / cancel ]`.
3. **Refresh.** Run `create-preview-theme.sh refresh --theme <id>` (add `--no-build` /
   `--build-script <name>` as above). Any `error=` line → report it plainly and follow the
   errors reference's **`error=` outcomes**; don't read the toml yourself.
4. **Report.** Print the returned `theme_id`, `preview_url`, `editor_url`, and `built`.
   Remind the developer that customizer settings were intentionally left as-is.
5. **Record it when the workspace hasn't.** When a task workspace for this work-id exists
   and its `notes.md` has no `session-theme:` line, append the refreshed id the same way as
   create's step 6 (dated bullet, only the parts the script returned — refresh hands back no
   name) — and, for the same reason as there, **without** `--pin-toml`.

## Quality bar

- Never expose the access token; never read `shopify.theme.toml` directly.
- Always confirm before creating or overwriting a theme.
- Report exactly what the script returned — don't invent URLs the script didn't produce.
