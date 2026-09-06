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
On Claude Code use the session context's `fnd plugin root:` path — `${CLAUDE_PLUGIN_ROOT}` is empty
in the Bash tool's shell.

## `error=` outcomes

- **`info` errors** (no `shopify.theme.toml`, missing `shopify`/`jq`, unparseable config) → report
  the line with the fix it names and take the manual path — never read the toml to "check".
  `error=common_lib_not_found` is the plugin install (a partial copy of `scripts/` dropped
  `_shopify-common.sh`), not the project — reinstall/update; nothing ran.
- **`error=build_failed`** → surface the build output and **stop**: fix the branch, don't enter
  theme URLs by hand.
- **`error=bad_build_script`** / **`error=build_script_missing`** → nothing was built or pushed
  and retrying the same value is pointless; the line names the rule. Don't invent a script name —
  read `package.json` for its production build script, or ask the developer (`--no-build` only when
  the repo is already built).
- **`error=theme_limit`** → re-run with `--reuse` when this run didn't; never delete a theme on
  the store without the developer.
- **`error=settings_drift`** → **don't retry**. The recovery is manual and the same for both modes:
  the developer **duplicates the dev theme in the Shopify admin** (a server-side copy keeps every
  setting, drifted or not) and **renames the copy to the `[ELC-…]` name** — why: the
  drift blockquote in `<plugin root>/skills/create-pull-request/REFERENCE.md → Preview theme`. Then
  `create-pull-request` re-runs with `theme_name` + `theme_url` + `theme_admin_url` (it uses that
  theme and skips auto-creation), while `preview-theme` just pushes code into it with
  `refresh --theme <the new id>`. The preview URL is `…/?preview_theme_id=<the new id>`. The
  script already reaped the theme this run created (`created_theme=` + `created_theme_deleted=yes`;
  `=failed` → it is still on the store burning a slot); a `--reuse` target is never deleted — it
  reports `theme=<id>`, `reused=true` and `mixed_state=` (this branch's code now sits on it with
  unmatched settings), no `created_theme` key at all.
- **`error=overlay_push_failed`** / **`error=overlay_pull_failed`** → transient or auth (`cause=`
  names it), so this one IS worth retrying — same reap / `mixed_state=` keys as `settings_drift`.
  `overlay_pull_failed` also fires when the pull wrote no settings file at
  all (`cause=` names the 0 *.json) — then retrying replays it: check that the toml's
  `dev_theme_id` is a real theme with customizer content before re-running.
- **`overlay=partial` + `warn=overlay_file_dropped file=<f> [unknown_types=<t,…>]`** (create,
  **exit 0**) → NOT a reviewable preview — the affected pages 404 or show stale content; say so
  instead of handing over the URL. Recover **per file on the surviving theme** as the hint says —
  never delete/re-create, a re-create replays the drop. `unknown_types=` is best-effort; absent,
  diff the file's section/block types against the branch by hand. Full-fidelity alternative: the
  `settings_drift` duplication above.
- **`overlay=unverified`** (create, exit 0) → landed-or-not is unknown; do the spot-check the warn
  line names before offering the preview.
- **`overlay=empty` + `warn=overlay_empty`** (create `--reuse`, exit 0) → nothing was overlaid and
  the reused theme keeps its previous settings — NOT a reviewable preview until a re-run overlays.
  On a fresh create the same pull is `error=overlay_pull_failed` and the theme is deleted.
- **`error=ambiguous_name`** / **`error=unusable_theme_id`** → nothing was pushed; re-run
  `refresh --theme <id>` naming the one theme you mean.
- **`error=live_theme_write_refused`** → nothing was pushed; never that theme. It guards pin-only
  mode too — pinning the published theme would point `shopify theme dev` at the storefront.
- **`error=cli_list_unreadable`** / **`error=live_role_unreadable`** → nothing was pushed; do the
  by-hand check the line names before any re-run. With no `theme=` on the line (a `create`
  resolving `--name`) a blind re-run stacks a **duplicate same-named theme** — resolve the name by
  hand, then `refresh --theme <id>`.
- **`error=refresh_unverifiable`** / **`error=reuse_unverifiable`** → nothing was pushed or
  created. The recorded-id exemption is an **id lookup across every workspace under the current
  directory, not provenance** — the gate in `<plugin root>/references/session-theme.md` still
  applies before an unattended refresh; a legacy `.claude/fnd/` workspace is not scanned (migrate
  it first); a `--reuse` name has no exemption at all. Re-run when the store answers.
  `--allow-unverified` lifts these two refusals only — never the live-theme or dev-theme guards —
  and is **never added unattended**.
- **`error=dev_theme_write_refused`** → nothing was pushed. Follow the hint, with two judgements
  it cannot make: the `session-theme:` record is written only after the developer confirms the id
  is this stream's theme (never to make the refusal go away), and `--allow-dev-theme` only on their
  explicit say-so — `--allow-unverified` does not cover this refusal.
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
- **`error=invalid_dev_theme_id`** / **`error=invalid_store`** → nothing ran; manual path, the
  developer fixes the line the message names — never read the toml to "check". `pin` alone runs on
  such a config on purpose: `pin --theme <id>` is the fix for `invalid_dev_theme_id`.
- **Session-theme pin outcomes** (`pin`, and `create` / `refresh` with `--pin-toml` —
  `<plugin root>/references/session-theme.md`):
  - **`error=theme_not_found`** → nothing was written; the line names the check.
  - **`error=theme_unverifiable`** → nothing was written (a standalone `pin` never persists an
    unvetted id). Under the same outage `create --pin-toml` proceeds, `refresh --pin-toml` only for
    a recorded session theme or with `--allow-unverified`, `--reuse --pin-toml` only with
    `--allow-unverified` (else `refresh_unverifiable` / `reuse_unverifiable`, above), each flagging
    `warn=pin_unvetted` before the pin keys — a warning, not an error: the id was just pushed to.
  - **`error=ambiguous_env`** → nothing was written; ask the developer which environment
    `npm run dev` uses → `--env <name>`.
  - **`error=env_not_found`** / **`error=pin_toml_failed`** → nothing was written; the line names
    the fix.
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
  (`unknown arg`, `refresh requires --theme <id>`, `create requires --name`), `error=invalid_theme_id`
  (`--theme` takes a numeric id), `no access token`,
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
