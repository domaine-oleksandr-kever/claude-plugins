# Session theme — one preview theme per work stream

Single home of the session-theme flow. `ship` (Step 0) and `worktree` both **offer** it and
must offer it identically; `preview-theme`, the pipeline's qa phase, `create-pull-request`,
and aftercare all **consume** it. Read this file when the offer actually has to run — the
silent-reuse path needs nothing from here.

## Why

`npm run dev` (`shopify theme dev -e dev`) syncs into whatever theme the `[environments.dev]`
block of `shopify.theme.toml` names — normally the shared dev theme. Two parallel sessions (main
checkout + worktree) would therefore sync two different branches into that one remote theme and
overwrite each other. A **session theme** is one unpublished preview theme owned by this work
stream and used for everything after that: the dev server, the QA rows that can't run locally,
the PR's theme-preview table, and aftercare refreshes.

## The gate — identical in `ship` and `worktree`

1. **Already chosen → don't ask, but do pin.** The shared workspace `notes.md` records a
   `session-theme: <id>` line (read the last one, same idiom as `dev-port:`:
   `grep -oE 'session-theme: [0-9]+' notes.md | tail -1 | tr -dc '0-9'`) → that id is the
   answer; skip the question and run
   `${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh pin --theme <id>` **silently** to
   re-assert it in *this* checkout's config. That is not busywork: the line outlives the
   checkout that wrote it (the workspace is shared with every worktree, and a worktree's toml
   is a fresh copy), so "recorded" never implies "pinned here". Re-pinning an id that is
   already pinned is byte-idempotent (`pin=unchanged`) and costs nothing.
   The `notes.md` line is the **only** silent-reuse trigger. Do not try to infer one from the
   config: the skills may not read it, and `info`'s `dev_theme_id` looks identical whether it
   resolves a session pin or the untouched shared dev theme — treating that as "already
   pinned" would silently adopt the shared theme, the exact collision this exists to prevent.
2. **Otherwise → one `AskUserQuestion`, never a block**, with the resolved commands (plugin
   root expanded) inside the question text so the developer sees what will run:
   - **Create one now** →
     `${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh create --name "<name>" --reuse --pin-toml`
   - **Use an existing theme** → the developer supplies the numeric id →
     `${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh pin --theme <id>` — pin-only: it
     validates the id against the store and refuses the live theme, and it pushes nothing.

   `<name>` is **the existing derivation, not a free-text description** — swap `info`'s
   `dev_theme_name` role prefix for the work-id key: `[DEV] Kever | Domaine` →
   `[ELC-206] Kever | Domaine`. `--reuse` matches by name, and the qa phase and
   `create-pull-request` derive the same string, so a name invented here (`[ELC-206] cart
   drawer fix`) makes those later calls miss and create a **second** theme for one ticket.
3. **Run it from the checkout the work lives in.** `shopify.theme.toml` is resolved relative
   to the cwd, and `create` builds the local branch — so a worktree's session theme is created
   from **inside that worktree**, never from the main checkout.
4. **Record it immediately** — a dated bullet in the shared workspace `notes.md`, same shape as
   the worktree script's line, the moment the script returns the id (before anything else, so a
   crash can't orphan a real theme):
   `- <YYYY-MM-DD> session-theme: <id> (<name>) <preview_url>`
   (the derived `<name>` already starts with the `[<KEY>]` bracket — don't print it twice).
   `create` returns a name plus `preview_url`/`editor_url`; `refresh` returns the URLs but no
   name; `pin` returns none of these. Write the parts you were actually handed and **drop the
   rest** — never invent a name or a URL.
   Add `superseded: <id>` to the same bullet when the pin reported `superseded_theme_id=` (that
   is the environment's previous theme id, and the config is gitignored).
5. **Then the dev server runs on it:** the start command the developer gets is
   `npm run dev -- --theme <id> [--port <N>]` — `--theme` always (belt and braces: explicit even
   though the toml is pinned), `--port <N>` added when port 9292 is taken by another checkout or
   the workspace records a `dev-port:` line. A dev server already running against a different
   theme has to be restarted on this one — ask the developer; never start or kill it yourself.

## Pinning

`--pin-toml` (on `create` and `refresh`) and the standalone `pin` subcommand rewrite the
`theme =` line of **one environment block** in the session's `shopify.theme.toml` — the block
the Shopify CLI resolves, since `shopify theme dev -e dev` reads `[environments.dev]` and not
whichever block is listed first. The script pins the `--env <name>` block when given; else the
block named `dev`, else `development` — by name only, so a lone block with any other name
(`[environments.production]`) is refused, never auto-picked. A toml with no `[environments.*]`
blocks but uncommented top-level `theme =`/`store =` keys is pinned at the top level
(`pin_env=-`). Anything else refuses (`error=ambiguous_env`) rather than guess. Other blocks
are never touched — a `[environments.production]` id is often the live theme's. The reported
`pin_env=` names the block it wrote.

Inside that block: the first uncommented `theme =` line takes the new id, its previous value is
kept on a commented `# … # fnd:superseded` line right above it (and reported as
`superseded_theme_id=`), any duplicate `theme =` lines in the same block are commented out
(their count reported as `commented_dupes=` — a count, unlike the id in `superseded_theme_id=`),
and a block with none gets one appended, tagged `# fnd:session-theme`, so unpinning knows the
block originally had no `theme =` line. Re-pinning the same id is byte-idempotent
(`pin=unchanged`); re-pinning a **different** id onto a tagged line just replaces the value —
the line stays session-owned, and no `fnd:superseded` marker is written for it.

After a pin, the id the script *reads* as `dev_theme_id` **is** the session theme in the usual
single-environment config — so a later `create` would overlay the session theme's own settings,
not the shared dev theme's. That is intended (the session theme was seeded from the dev theme
when it was created) and one more reason the work stream creates once and `refresh`es after. In
a multi-environment toml the script still reads the file's first uncommented line, so the two
can differ; `refresh` is unaffected either way.

- **Never `Read` or print that file, or any line of it** — the Theme Access token lives two
  lines away. Report only the path and the id the script returned.
- On `create`/`refresh` the pin is **non-fatal**: the theme id is printed first and stands even
  when the rewrite fails (`pin=failed` + `pin_error=…`). Record the id, say the pin didn't land,
  and keep using the explicit `--theme <id>` flag.
- Pinning vets the id against the store listing. When the listing is unavailable, standalone
  `pin` **refuses** (`error=theme_unverifiable` — a pin persists, so it is never applied
  unvetted; the config is untouched, retry when the store answers), while `create` and
  `refresh` with `--pin-toml` proceed and print `warn=pin_unvetted` before the pin keys
  (the id was just pushed to, so it exists).
- **Restoring by hand:** the superseded value sits on the `# theme = "…" # fnd:superseded`
  line directly above the pinned one — the developer uncomments it and comments out or deletes
  the session line below (an appended session line is tagged `# fnd:session-theme` — just
  delete it). That is the same edit `worktree-setup.sh`'s unpin makes.
- A **worktree starts unpinned on purpose.** `worktree-setup.sh` copies the source checkout's
  toml and then reverts every pin it finds in it, both shapes — `fnd:superseded` markers
  restored, `fnd:session-theme` lines deleted (`toml_unpinned=yes`; `=no` means the source was
  never pinned) — so a new stream inherits the shared dev theme rather than another stream's
  session theme — which is what its first `create` would have copied customizer settings from.
  One caveat: a hand-written theme id that `pin` reported as `pin=unchanged` carries no tag
  and is not reverted.
- `error=` outcomes (incl. the live-theme refusal that guards pin-only mode) live in
  `${CLAUDE_PLUGIN_ROOT}/references/preview-theme-errors.md`.

## Consumers — everything reuses the same theme

| Caller | Behaviour |
| --- | --- |
| `preview-theme` skill | A recorded `session-theme:` is the default **refresh** target — never create a second theme for the same work stream; a theme it creates is recorded as one. |
| pipeline **qa** | Rows marked `preview-theme` run against the session theme (`refresh --theme <id>`, settings preserved); create one only when nothing is recorded — and **record without pinning**, since phase 4 is past the ✋ and rewriting the developer's config unasked is not its call. |
| pipeline **create-pr** | The session theme is the PR's preview theme — it outranks auto-creation (explicit `theme_name`/`theme_url`/`theme_admin_url` args still win over everything). |
| pipeline **aftercare** | `refresh --theme <id from notes.md>` after each fix round — the same id. |
