# PR body — Domaine structure reference

The body structure and theme-preview table rules for `create-pull-request` (Workflow 6). If a
GitHub PR template exists in the repo, merge these sections into it rather than dropping any.

## Title convention

`[ELC-XX][Type] Short, outcome-focused description`

- `[ELC-XX]` — Jira ticket key; always include when a ticket is linked. **Multiple tickets** (one PR closing several bugs/tasks) → one bracket, project prefix once, numbers slash-separated: `[ELC-299/307/309/315/382][Type] …`.
- `[Type]` — `Feature` | `Fix` | `Refactor` | `Chore` | `Docs` | `Style` | `Perf` | `Test`.

Examples:

- `[ELC-42][Feature] PowerReviews integration with star ratings, review snippets, and write form`
- `[ELC-299/307/309/315/382][Fix] PDP batch: gallery focus, mobile zoom, swatch labels, sticky CTA, price alignment`

## Body sections

**The first three sections are FIXED and ordered — emit them in exactly this order at the very top of the body, before anything else:**

1. **Summary** — what was implemented and why (short, reviewer-friendly).
2. **Jira ticket** — key + URL (list every ticket when the PR closes more than one).
3. **Theme preview** — the conditional table below, in the **top third of the body — never
   at the bottom** among the trailing sections: a reviewer must hit the preview link
   without scrolling. Do not reorder or rename these three.

Then the remaining sections (adapt headings if a team template exists; their relative order is flexible, but they all come **after** the fixed three):

- **Technical approach** — summary of the approved TA; call out deviations or additions made during implementation and why.
- **Changes made** — grouped by area (sections/blocks/snippets, styles, schemas/locales, config, scripts).
- **Steps to test** — paste from Jira, or summarise with a pointer to the ticket field if long.
- **Screenshots / visual evidence** — captures, Figma frames, or DevTools validation notes. If none, say "N/A — non-visual change" or state what was verified.
- **Accessibility** — WCAG-oriented notes (keyboard, semantics, contrast), or "None".
- **Performance** — rendering, assets, LCP/CLS touchpoints, or "None".
- **Dependencies** — other PRs, env vars, merchant setup, post-merge steps, and **named
  ceilings**: every intentional simplification with a known ceiling (workspace `notes.md`
  `ceiling:` entries, justified correctness findings) with its upgrade path — lean-code
  requires the ceiling named here, not in an inline comment.
- **Checklist** — self-review complete, tested locally, no console errors in happy path, a11y spot-check if UI changed.

## Preview theme — auto-create or manual

The Preview row needs an unpublished theme that shows **this branch's code** with the developer's
**configured customizer content**. So `${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh` builds the local repo
(`npm run build`) and pushes the built code, then overlays only the dev theme's settings —
`config/settings_data.json`, `templates/**/*.json`, and section groups `sections/*.json`. It does
**not** clone the dev theme's code (which may be stale or broken); code always comes from the
branch. The script reads the store / dev-theme-id / Theme Access token from `shopify.theme.toml`
(the **uncommented** `theme = "…"` line). To redeploy code into an existing preview theme later
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
> the same keys and is worth retrying. **The fix is manual:** for
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
2. **`info`** (`${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh info`) detects `store`, `dev_theme_id`, `dev_theme_name`.
   - **`error=…`** (no `shopify.theme.toml`, missing `shopify`/`jq`, unparseable config) → **manual path**: ask the developer for the theme name + Preview / Admin URLs.
   - **success** → propose the new name (swap the role prefix for the Jira key: `[DEV] Kever | Domaine` → `[ELC-126] Kever | Domaine`; **multiple tickets** → one bracket, prefix once, slash-separated numbers: `[ELC-299/307/309/315/382] Kever | Domaine`) and **ask before mutating**: `create the preview theme now? [ yes / no ]`. One PR = one preview theme regardless of how many tickets it carries — the preview overlays the dev theme's **current** customizer settings, so it reflects the content configured right now, not one ticket in isolation.
3. **`create`** (`${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh create --name "<name>" [--reuse]`) builds the branch, assembles the built code into a clean temp dir (working tree untouched), pushes it to a new unpublished theme, then overlays the dev theme's customizer settings. It prints `theme_id`, `preview_url`, `editor_url`, `reused`. The skill passes `--reuse` **by default — deliberate**: one PR = one preview theme, so a re-run refreshes the same `[ELC-…]` theme instead of stacking duplicates. Note it will overwrite a pre-existing theme that happens to carry the same name (the bracketed ticket naming keeps collisions ticket-scoped). On `error=theme_limit` the store is at its cap (20 / 100) — `--reuse` already avoids stacking; delete an old theme.

### Page deep-links

When the change is reviewed on a specific storefront path (`preview_path`, or inferable from
context — e.g. you developed/QA'd on `/products/group-lipglass`), deep-link the rows instead of
sending the reviewer to the home page:

- **Preview** → `https://<store>/<path>?preview_theme_id=<id>` (append the path to the base `preview_url`).
- **Admin** → the theme editor on that template: `https://<store>/admin/themes/<id>/editor?previewPath=<url-encoded path>`, or `?template=<name>` when the developer names the template (e.g. `product`, `product.lipglass`).

If the path or template is unknown or ambiguous, **ask the developer — never guess.**

**Several pages / several tickets:** when the bugs live on different pages, list one deep-link per
page in the Preview row (e.g. `[PDP](…/products/x?preview_theme_id=ID) · [Cart](…/cart?preview_theme_id=ID)`),
ideally labelled by ticket. Same preview theme ID throughout — only the path differs.

## Theme-preview table — conditional construction

Build rows only from what the developer provided:

Order the rows **Theme name → Theme ID → Preview** (ID is its own row, directly under the name):

| Row            | When to include |
| -------------- | --------------- |
| **Theme name** | Only if a theme name is known (provided, or the create script's `name`). Foundation names usually contain a pipe — escape it (see the note below this table). |
| **Theme ID**   | **Whenever the theme ID is known** — its own row, right under Theme name. The create script returns `theme_id` directly; otherwise extract the numeric ID from a URL (admin `/themes/<ID>`, preview `?preview_theme_id=<ID>`). |
| **Preview**    | Whenever at least one URL is known. Render available links: `[View theme](THEME_URL)` and/or `[Admin](THEME_ADMIN_URL)` separated by ` · `. Omit the link whose URL is missing. **Use the full URL as-is** — preserve all query params (`_ab`, `_bt`, `_fd`, `_sc`, `key`, `preview_theme_id`); do not truncate or strip them. |

> **Pipe escaping:** preview-theme names like `[ELC-126] Kever | Domaine` contain a `|`; inside a
> Markdown table cell it must be written as `\|` (`[ELC-126] Kever \| Domaine`) or the row breaks.

Full example (all fields provided):

```markdown
|                |                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Theme name** | `[ELC-126] Kever \| Domaine`                                                                                                               |
| **Theme ID**   | `123456789`                                                                                                                                |
| **Preview**    | [View theme](https://store.myshopify.com/?preview_theme_id=123456789) · [Admin](https://admin.shopify.com/store/my-store/themes/123456789) |
```

Only `THEME_URL` provided (no admin URL, no name):

```markdown
|              |                                                                       |
| ------------ | --------------------------------------------------------------------- |
| **Theme ID** | `123456789`                                                           |
| **Preview**  | [View theme](https://store.myshopify.com/?preview_theme_id=123456789) |
```
