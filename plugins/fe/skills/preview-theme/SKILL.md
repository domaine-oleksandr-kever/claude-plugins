---
name: preview-theme
description: >
  Create or refresh an unpublished Shopify preview theme from the current branch. Use when asked to
  create / spin up / refresh / redeploy / rebuild a preview theme or push a fix to one; a bare theme
  id means refresh.
argument-hint: "[create|refresh] [theme-id|preview-url] [--name \"[TICKET] …\"] [--reuse] [--no-build] [--store <handle>]"
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
allowed-tools: Read, Glob, Grep, Bash(${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh*), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/worktree-theme.sh*)
---

# Preview theme (create / refresh)

Both modes wrap `<fe root>/scripts/create-preview-theme.sh`. It is the same script `/fe:create-pull-request` uses — running this skill is a good way to
test the mechanics in isolation. **create** builds a named, **unpublished** theme = your branch's code (built
locally) + the dev theme's customizer settings. **refresh** redeploys the branch's code
into an existing preview **without touching its customizer settings** — everything except
`config/settings_data.json`, `templates/**/*.json`, and section groups `sections/*.json`
is pushed, so the content a reviewer configured stays put. Full contract:
`<fe root>/skills/create-pull-request/REFERENCE.md → Preview theme`. Every run's output — the
workspace lines, the `warn=`/`overlay=` verdicts, each `error=` and the page deep-link formulas —
is read per the errors reference, `<fe root>/references/preview-theme-errors.md`: its **Reading a
create/refresh result** section after every run, one key's entry when a run warns or fails (here:
Grep the key in its `##` headings with line numbers, then Read from that line to the next heading),
**Page deep-links** when a deep-link is needed — never the whole file.

When this checkout is a `git worktree` — or anything else already holds port 9292 — its dev
server has to start on the theme the workspace's `notes.md` records as `session-theme:` and
the port it records as `dev-port:` — the start command is the one
`<fe root>/references/session-theme.md` step 5 gives for this checkout's profile
(`foundation`, session line `fe project profile: foundation`: `npm run dev -- --theme <id> --port <N>`)
— otherwise it silently collides with the main checkout's server or overwrites the shared dev
theme. A worktree fresh from `/base:worktree` runs **In a worktree** below first.

> **Security:** the Theme Access token lives in `shopify.theme.toml`. **Never read that
> file** — the script consumes the token inside the `shopify` subprocess and never prints
> it. Pass nothing secret on the command line.

## Route the mode

- Explicit `create` / `refresh` → that mode.
- A bare **theme id** → **refresh** that theme.
- **Which store:** a preview URL (or store) the developer gives whose `*.myshopify.com` host is not
  the `store=` the script reports → add `--store <that handle>` to every call (brands often have a
  store per region; a custom-domain URL → ask which store). There `create` is refused
  (`error=overlay_store_mismatch`) — refresh an existing theme. Never fall back to a raw
  `shopify theme push`.
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
   **`error=` outcomes**, and never read the toml yourself. (`create-preview-theme.sh --help`
   prints the full call shape from the script itself.)
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
   push). A checkout with no `package.json` (in it or any parent up to the repo root) takes
   neither flag — `--build-script` there is refused (`error=build_script_missing`) — the build
   is skipped (`built=skipped_no_package_json` + `warn=build_skipped_no_package_json`, exit 0)
   and the working tree is pushed as it stands. **Any `error=` line** → report it plainly,
   then follow its entry in the errors reference — it names whether anything was pushed,
   whether retrying is right, and the recovery. Don't improvise one. An exit-0 run is not
   always reviewable (`overlay=partial` / `empty` / `unverified`): the reading section says
   which. With `--reuse`, `error=reuse_unverifiable` / `error=dev_theme_write_refused` follow
   the same two consents as refresh step 3 (never add `--allow-unverified` /
   `--allow-dev-theme` on your own).
5. **Report.** Print the resulting `theme_id`, `preview_url`, `editor_url`, `reused`,
   `built`, and — when it isn't `verified` — the `overlay=` verdict with its warn lines;
   `warn=build_dirtied=` per the reading section (its `notes.md` line too). If a
   `preview_path` is known, also give the page-deep-linked preview and the editor-on-template
   link (**Page deep-links**); path or template unknown → **ask, never guess**.
6. **Record it as the work stream's session theme.** When a task workspace for this work-id
   exists, write the `session-theme:` and `session-theme-pushed:` lines per the reading
   section — otherwise the next `/fe:ship` run, qa phase or PR run finds no line and creates a
   *second* theme for the same stream. Do **not** pass `--pin-toml` here: the pin rewrites the
   developer's `shopify.theme.toml` and is the session-theme offer's call
   (`<fe root>/references/session-theme.md`), not this skill's.

## Steps — refresh

1. **Identify the theme.** Need the target's numeric `theme_id` (see Route the mode for
   where to find it). Do not guess.
2. **Confirm before mutating.** This rebuilds and overwrites the theme's **code**
   (settings are preserved). Show the target id and `[ update / cancel ]`.
3. **Refresh.** Run `create-preview-theme.sh refresh --theme <id>` (add `--no-build` /
   `--build-script <name>` as above; with no `package.json` the build is skipped the same
   way). Any `error=` line → report it plainly and follow its entry in the errors reference;
   don't read the toml yourself. Two refusals need a
   distinct developer consent each: `error=refresh_unverifiable` / `error=reuse_unverifiable`
   (the store listing was silent) → report; ask the developer before re-running with
   `--allow-unverified`. `error=dev_theme_write_refused` (the target is the shared dev theme) →
   if the developer confirms the id is this stream's session theme, do step 5 (record the
   `session-theme:` line) FIRST and re-run without any flag; only an explicit "overwrite the dev
   theme" gets `--allow-dev-theme`. `error=theme_not_found` is neither of those: the listing
   answered and does not carry the id — deleted, or on another store: with a preview URL whose host
   differs, re-run with `--store <host>`; with a bare id, ask the developer whether it lives on
   another store (which handle) and re-run with `--store <handle>` — only then offer a fresh `create`.
4. **Report.** Print the returned `theme_id`, `preview_url`, `editor_url`, and `built`, and
   handle `warn=build_dirtied=` as create's step 5 does. Remind the developer that customizer
   settings were intentionally left as-is.
5. **Record it.** With a task workspace for this work-id: no `session-theme:` line yet → append
   the refreshed id as create's step 6 does (only the parts the script returned — refresh hands
   back no name), **without** `--pin-toml`; the refreshed id is the recorded session theme →
   the `session-theme-pushed:` line per the reading section, `pushed=` or not.

## In a worktree

`/base:worktree` copies `shopify.theme.toml` from the main checkout (fe's `worktree copy list:`
line), so the copy still names the main checkout's session theme — two dev servers on one theme.
Before the first create, refresh or dev-server start in a new worktree:

1. **Run** `<fe root>/scripts/worktree-theme.sh <worktree-dir>` (the `worktree=` path
   `/base:worktree` printed; from inside the worktree, `.`). It unpins the copied config through
   `session-theme.sh`, so the worktree never inherits the source checkout's session theme, and
   prints the dev-server hand-off and the pin reminder. It is idempotent: the un-pin runs once per
   worktree, and a re-run reports `toml_unpinned=already` and never undoes a pin the worktree has
   since made for itself. `warn=toml_unpin_failed` → the copy still carries the source checkout's
   pin: relay the warn line; the next run retries.
2. **Relay** what it printed — the `next:` block: the dev-server line (`npm run dev -- --theme
   <session-theme-id> --port <N>` / `shopify theme dev --theme <session-theme-id> --port <N>`) and
   the pin reminder. The script already took the port from `--port` or the `dev-port:` line
   `/base:worktree` recorded in the workspace's `notes.md` — never look it up again; only
   `dev_port=unknown` (the line then reads `--port <dev-port>`) needs one from the developer. The
   worktree then gets its own session theme: the create flow above, or the session-theme offer
   (`<fe root>/references/session-theme.md`); fill that id into `<session-theme-id>` of the
   printed line, as it is — never re-derive the line — and append the
   `session-theme-pushed: - <id>` line (a dev server on it changes the theme).
3. `error=not_a_linked_worktree` → this is the main checkout, not a failure: its own session pin
   stays; skip this section and go on. Any other `error=<reason>` line on its stdout → report it
   plainly and stop; never edit the toml by hand to work around it, and never read it.
