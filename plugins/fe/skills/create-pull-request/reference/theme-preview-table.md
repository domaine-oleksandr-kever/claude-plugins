# Theme-preview table — conditional construction

One section of the `/fe:create-pull-request` (Workflow 6) reference; the index is `../REFERENCE.md`.

Build rows only from what the developer provided:

Order the rows **Theme name → Theme ID → Preview** (ID is its own row, directly under the name):

| Row            | When to include |
| -------------- | --------------- |
| **Theme name** | Only if a theme name is known (provided, or the create script's `name`). Foundation names usually contain a pipe — escape it (see the note below this table). |
| **Theme ID**   | **Whenever the theme ID is known** — its own row, right under Theme name. The create script returns `theme_id` directly; otherwise extract the numeric ID from a URL (admin `/themes/<ID>`, preview `?preview_theme_id=<ID>`). |
| **Preview**    | Whenever at least one URL is known. **Default form — one labelled deep-link per surface the change was verified on, Admin last**: `[PLP](…) · [PDP](…) · [Admin](THEME_ADMIN_URL)` — `THEME_ADMIN_URL` is the script's `editor_url` (`…/themes/<id>/editor`, never the bare `/themes/<id>` page) plus `?previewPath=…` — built per `<fe root>/references/preview-theme-errors.md → Page deep-links` (that section also names where the paths come from — the workspace verification record, the QA phase, `preview_path`). A bare `[View theme](THEME_URL)` is the fallback for when no verified surface is known, not the default. Omit the link whose URL is missing. **Use the full URL as-is** — preserve all query params (`_ab`, `_bt`, `_fd`, `_sc`, `key`, `preview_theme_id`, and any param the feature needs to render, e.g. a market switch); do not truncate or strip them. |

> **Pipe escaping:** preview-theme names like `[ELC-126] Kever | Domaine` contain a `|`; inside a
> Markdown table cell it must be written as `\|` (`[ELC-126] Kever \| Domaine`) or the row breaks.

Full example (all fields provided, change verified on PLP + PDP, feature renders only with
`country=GB`):

```markdown
|                |                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Theme name** | `[ELC-126] Kever \| Domaine`                                                                                                                                                                                                                             |
| **Theme ID**   | `123456789`                                                                                                                                                                                                                                              |
| **Preview**    | [PLP](https://store.myshopify.com/collections/lip-liners?preview_theme_id=123456789&country=GB) · [PDP](https://store.myshopify.com/products/velvet-teddy?preview_theme_id=123456789&country=GB) · [Admin](https://admin.shopify.com/store/my-store/themes/123456789/editor?previewPath=%2Fproducts%2Fvelvet-teddy) |
```

Only `THEME_URL` provided (no admin URL, no name):

```markdown
|              |                                                                       |
| ------------ | --------------------------------------------------------------------- |
| **Theme ID** | `123456789`                                                           |
| **Preview**  | [View theme](https://store.myshopify.com/?preview_theme_id=123456789) |
```
