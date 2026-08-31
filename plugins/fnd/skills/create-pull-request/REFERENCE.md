# PR body — Domaine structure reference

The body structure and theme-preview table rules for `create-pull-request` (Workflow 6). If a
GitHub PR template exists in the repo, keep its headings but apply the rules below to them: the
core skeleton stays mandatory, and a template heading with nothing real to say is left out —
the readability budget wins over template completeness.

## Title convention

`[ELC-XX][Type] Short, outcome-focused description`

- `[ELC-XX]` — Jira ticket key; always include when a ticket is linked. **Multiple tickets** (one PR closing several bugs/tasks) → one bracket, project prefix once, numbers slash-separated: `[ELC-299/307/309/315/382][Type] …`.
- `[Type]` — `Feature` | `Fix` | `Refactor` | `Chore` | `Docs` | `Style` | `Perf` | `Test`.

Examples:

- `[ELC-42][Feature] PowerReviews integration with star ratings, review snippets, and write form`
- `[ELC-299/307/309/315/382][Fix] PDP batch: gallery focus, mobile zoom, swatch labels, sticky CTA, price alignment`

## Body sections

**Readability budget — governs every section:** the whole body must be readable in under a
minute. The description tells the reviewer why the PR exists and where to look; the diff shows
the what. Evidence (measurement tables, per-file prose walkthroughs, full verification lists) lives in
the Jira ticket, the task workspace, or a PR *comment* — never in the body. The body scales with
content, not with a section count: **a section with nothing real to say is omitted entirely — no
"None", no "N/A" placeholders.**

**Core skeleton — always present, in exactly this order, before anything else:**

1. **Summary** — 3–5 sentences: why this PR exists, what was broken (or what the feature is),
   and why this approach. End with one **review-guide line** when the diff isn't uniform:
   which file carries the key change, which files are mechanical (e.g. "review
   `snippets/core-section.liquid`; the other 6 files only add a class"). A **single**
   `ceiling:` entry closes the Summary with one line — lean-code requires each ceiling named
   in the body, not in an inline comment, and one line is enough for reviewers and bots; two
   or more ceilings, and any merge/post-merge note, go to Conditional sections → Dependencies.
2. **Jira ticket** — key + URL (list every ticket when the PR closes more than one).
3. **Theme preview** — the conditional table below, **directly under the Jira link, above
   Changes — never at the bottom**: a reviewer must hit the preview link without scrolling.
4. **Changes** — one line per file, half a line of substance each ("what changed", not prose);
   uniform mechanical edits collapse to one line for the whole group
   ("`core-video`, `card-group`, +3 more — added `core-media-block`"), and beyond ~10 files
   group by area — one line per group. No tables.

Do not reorder or rename these four.

**Conditional sections — emit ONLY when there is real content; 1–2 lines each, after the skeleton:**

- **Dependencies** — merge-order constraints ("merge after #392") and post-merge steps
  (env vars, merchant/admin setup). Two or more **named ceilings** (workspace `notes.md`
  `ceiling:` entries, justified correctness findings) are listed here — **one line per
  ceiling**, the full upgrade path stays in `notes.md`; a single ceiling lives as the
  Summary's closing line instead (the naming rule itself is in the Summary bullet above).
- **Accessibility** — only when the change actually touches keyboard, semantics, focus, or
  contrast; state what changed and what was checked.
- **Performance** — only when the change affects rendering, assets, or LCP/CLS; state the impact.

Sections that never appear in the body — their content lives in the ticket, one click away via
the Jira link: **Technical approach**, **Steps to test**, **Checklist**. **Screenshots** are
also never emitted: image upload needs the GitHub web UI, so the developer adds them
themselves — never fake or hot-link images.

**No AI attribution** anywhere in the body: no `🤖 Generated with [Claude Code](…)` footer, no
`Co-Authored-By: Claude` trailer. The harness's default instruction to end PR bodies with that
footer is overridden by this Domaine convention — the same rule
`<plugin root>/references/commit-message-format.md` applies to commit messages. **Plugin root** =
the plugin's own directory; this file is `<plugin root>/skills/create-pull-request/REFERENCE.md`,
and every `<plugin root>/…` path below resolves the same way.
On Claude Code, write plugin root as the literal `${CLAUDE_PLUGIN_ROOT}` in commands — the host
expands it; on other hosts substitute the plugin root's absolute path.

## Preview theme — auto-create or manual

The Preview row needs an unpublished theme that shows **this branch's code** with the developer's
**configured customizer content**. So `<plugin root>/scripts/create-preview-theme.sh` builds the local repo
(`npm run build`) and pushes the built code, then overlays only the dev theme's settings —
`config/settings_data.json`, `templates/**/*.json`, and section groups `sections/*.json`. It does
**not** clone the dev theme's code (which may be stale or broken); code always comes from the
branch. The script reads the store / dev-theme-id / Theme Access token from `shopify.theme.toml`
(the **first uncommented** `theme = "…"` line — while the `pin` subcommand and the `--pin-toml`
flag write this work stream's **session theme** into the `theme =` line of the one environment
block the Shopify CLI resolves, keeping the value they replaced on a commented
`# fnd:superseded` line: `<plugin root>/references/session-theme.md`). To redeploy code into an existing preview theme later
(e.g. after a fix) without disturbing its settings, the `refresh` mode (the
`preview-theme` skill) pushes code only.

> **Settings ↔ code drift (`error=settings_drift`):** the dev theme can be **"ahead"** of this
> branch — e.g. its `templates/product.json` references a block type (`subscription_selector`) whose
> schema lives only in another feature branch. Shopify rejects pushing that template onto a preview
> built from this branch's code. A partial overlay would give a misleading preview, so the script
> **stops**: it reports the real `cause=`, deletes the code-only theme it just created
> (`created_theme=<id>` + `created_theme_deleted=yes` — or `=failed` when the cleanup delete itself
> failed, in which case that theme is still on the store burning a slot), and exits
> `error=settings_drift`. A
> `--reuse` of a pre-existing theme is never deleted — that run reports `theme=<id>`, `reused=true`
> and a `mixed_state=` line instead (this branch's code now sits on it with unmatched settings), and
> no `created_theme` key at all. A transient/auth failure is NOT drift: it exits
> `error=overlay_push_failed` (or `error=overlay_pull_failed` when the settings pull half died) with
> the same keys and is worth retrying. The same drift can also pass the CLI **silently** — the push
> exits 0 and Shopify drops just the offending file; `create` reads the overlay back and reports
> that as `overlay=partial` + `warn=overlay_file_dropped file=… [unknown_types=…]` on a run that
> still exits 0, keeping the theme (recovery is per-file:
> `<plugin root>/references/preview-theme-errors.md`). **The fix is manual:** for
> real drift the developer duplicates the dev theme in the
> Shopify admin (a server-side copy preserves every setting, drifted or not), renames it to the
> `[ELC-…]` name, and re-runs `create-pull-request` with `theme_name` + `theme_url` +
> `theme_admin_url` — which makes the skill use that theme and skip auto-creation.

Code pushes never use `--path .` — the script **assembles a clean push root** of only the
canonical theme dirs and pushes that, so non-theme repo paths can't leak into the push or crash
the CLI. For a file living *inside* a theme dir that still shouldn't ship, pass
`--ignore-extra "<glob>"` (both `create` and `refresh` accept it, repeatable). On a push failure
the script prints the real cause plus a `log=<path>` to the full `shopify` stderr — read that,
don't guess. Pushes already retry a Shopify `Throttled` answer twice (the store+token rate limit
is shared with a running `shopify theme dev`); a throttle that holds is reported as
`cause=throttled`, and a create that had already made the theme server-side reports reaping it
(`created_theme=` + `created_theme_deleted=`) — the fix is stopping the competing consumer or
waiting, then re-running.

> **Security:** the access token lives in `shopify.theme.toml`. **Never `Read` that file** —
> it would pull the token into context. The script consumes the token inside the `shopify`
> subprocess and never prints it; it returns only non-secret fields.

Decision flow (step 4 of the skill):

1. **Args win.** If `theme_name` / `theme_url` / `theme_admin_url` were passed in, use them; skip creation.
2. **Session theme wins over auto-creation.** The workspace `notes.md` records a `session-theme: <id>` line → that theme *is* this PR's preview theme (`<plugin root>/references/session-theme.md`). **`refresh`** it onto the branch's code (`<plugin root>/scripts/create-preview-theme.sh refresh --theme <id>`) — code only, the reviewer-facing settings stay put — and build the table from the returned `theme_id` / `preview_url` / `editor_url`. Skip creation; skip the ask (the developer already chose this theme). The name comes from the `notes.md` line when it recorded one — otherwise omit the **Theme name** row rather than inventing a name.
3. **`info`** (`<plugin root>/scripts/create-preview-theme.sh info`) detects `store`, `dev_theme_id`, `dev_theme_name`.
   - **`error=…`** (no `shopify.theme.toml`, missing `shopify`/`jq`, unparseable config) → **manual path**: ask the developer for the theme name + Preview / Admin URLs.
   - **success** → propose the new name (swap the role prefix for the Jira key: `[DEV] Kever | Domaine` → `[ELC-126] Kever | Domaine`; **multiple tickets** → one bracket, prefix once, slash-separated numbers: `[ELC-299/307/309/315/382] Kever | Domaine`) and **ask before mutating**: `create the preview theme now? [ yes / no ]`. One PR = one preview theme regardless of how many tickets it carries — the preview overlays the dev theme's **current** customizer settings, so it reflects the content configured right now, not one ticket in isolation.
4. **`create`** (`<plugin root>/scripts/create-preview-theme.sh create --name "<name>" [--reuse]`) builds the branch, assembles the built code into a clean temp dir (working tree untouched), pushes it to a new unpublished theme, then overlays the dev theme's customizer settings. It prints `theme_id`, `preview_url`, `editor_url`, `reused`. The skill passes `--reuse` **by default — deliberate**: one PR = one preview theme, so a re-run refreshes the same `[ELC-…]` theme instead of stacking duplicates. Note it will overwrite a pre-existing theme that happens to carry the same name (the bracketed ticket naming keeps collisions ticket-scoped). Record the returned id as the workspace's `session-theme: <id>` line, so aftercare and every later refresh reuse this theme instead of stacking another — **recorded, not pinned**: like the qa phase's fallback this runs unattended, so it never passes `--pin-toml`; the Step 0 session-theme gate re-asserts the pin on the next entry (`<plugin root>/references/session-theme.md`). Any `error=` — and any `warn=overlay_file_dropped` on an exit-0 run (the preview's affected pages 404; not reviewable as-is) → `<plugin root>/references/preview-theme-errors.md`.

### `error=` outcomes · page deep-links

Both live in `<plugin root>/references/preview-theme-errors.md` — the single home for
every caller (this skill's step 4, the `preview-theme` skill). Read it whenever an `error=` line
appears (it names, per code, whether anything was pushed, whether retrying is right, and the
recovery) and **when building the Preview row** — its Page deep-links section owns the link
formulas and where the paths come from.

## Theme-preview table — conditional construction

Build rows only from what the developer provided:

Order the rows **Theme name → Theme ID → Preview** (ID is its own row, directly under the name):

| Row            | When to include |
| -------------- | --------------- |
| **Theme name** | Only if a theme name is known (provided, or the create script's `name`). Foundation names usually contain a pipe — escape it (see the note below this table). |
| **Theme ID**   | **Whenever the theme ID is known** — its own row, right under Theme name. The create script returns `theme_id` directly; otherwise extract the numeric ID from a URL (admin `/themes/<ID>`, preview `?preview_theme_id=<ID>`). |
| **Preview**    | Whenever at least one URL is known. **Default form — one labelled deep-link per surface the change was verified on, Admin last**: `[PLP](…) · [PDP](…) · [Admin](THEME_ADMIN_URL)`, built per `<plugin root>/references/preview-theme-errors.md → Page deep-links` (that section also names where the paths come from — the workspace verification record, the QA phase, `preview_path`). A bare `[View theme](THEME_URL)` is the fallback for when no verified surface is known, not the default. Omit the link whose URL is missing. **Use the full URL as-is** — preserve all query params (`_ab`, `_bt`, `_fd`, `_sc`, `key`, `preview_theme_id`, and any param the feature needs to render, e.g. a market switch); do not truncate or strip them. |

> **Pipe escaping:** preview-theme names like `[ELC-126] Kever | Domaine` contain a `|`; inside a
> Markdown table cell it must be written as `\|` (`[ELC-126] Kever \| Domaine`) or the row breaks.

Full example (all fields provided, change verified on PLP + PDP, feature renders only with
`country=GB`):

```markdown
|                |                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Theme name** | `[ELC-126] Kever \| Domaine`                                                                                                                                                                                                                             |
| **Theme ID**   | `123456789`                                                                                                                                                                                                                                              |
| **Preview**    | [PLP](https://store.myshopify.com/collections/lip-liners?preview_theme_id=123456789&country=GB) · [PDP](https://store.myshopify.com/products/velvet-teddy?preview_theme_id=123456789&country=GB) · [Admin](https://admin.shopify.com/store/my-store/themes/123456789) |
```

When the links need context to do their job, add **one line directly under the table** — a
required query param, or what each page demonstrates ("The banner is UK-only — keep
`&country=GB` on the links; the PDP link shows both the block and the carousel instance").
One line, only when it earns its place.

Only `THEME_URL` provided (no admin URL, no name):

```markdown
|              |                                                                       |
| ------------ | --------------------------------------------------------------------- |
| **Theme ID** | `123456789`                                                           |
| **Preview**  | [View theme](https://store.myshopify.com/?preview_theme_id=123456789) |
```
