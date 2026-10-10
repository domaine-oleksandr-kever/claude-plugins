# QA Preflight — the brief

Phases 5–6 of `/qa:preflight`: `.claude/tasks/<KEY>/preflight.md`, the chat output and the opt-in
Jira comment. Block 1 is the company house style and the only part that may reach Jira; Block 2 never
does.

## A filled brief

A Partially pass run: two rows verified, one waiting on data, a stand-in used. Copy the Block 1
wording as it stands — it is what QA readers expect to see:

```markdown
# ABC-101 — QA preflight (2026-10-10)

## Block 1 — for Jira (house style)

_Preflight — automated pre-run via `/qa:preflight`, not the QA sign-off; rows below were checked
by the agent at the viewports named._

**Testing Status: Partially pass**
* Tested in Desktop on Chrome
* Tested in Mobile on Chrome (375x812 emulation)
* Tested in theme build: QA copy ACME US UAT (theme 123456789012)

**Evidence on the criteria that pass verification:**
1. {color:green}Pass{color} — Picked the shade "Ivory" on the product page: the swatch label reads "Ivory" and the price stays $42.00
2. {color:green}Pass{color} — Added the product to the bag: the cart drawer opens with one line, "Ivory", quantity 1

## Block 2 — Preflight notes (not for Jira)

**For human eyes**

- hands-on pass — rows 1, 2 — open https://acme-us-uat.myshopify.com/products/velvet-foundation?preview_theme_id=123456789012, pick "Ivory", add to bag, open the cart drawer — look at the swatch label and the drawer line

**Needs data**

- row 3 — no product with an empty shade-family metafield
  1. ACME US UAT — open https://admin.shopify.com/store/acme-us-uat/products?query=velvet-foundation
  2. Metafields → *Shade family* (`custom.shade_family`, single line text) → clear the value
  3. Save, reopen https://acme-us-uat.myshopify.com/products/velvet-foundation?preview_theme_id=123456789012 — the swatch group is hidden

**Developer gaps:** none

**Observations**

- stand-in: `/products/velvet-foundation` for e.g. `/products/silk-foundation` (40+ shades, in stock)

**Route:** ready for hands-on QA

**Deployed:** theme 123456789012 QA copy (preview link, chosen by the QA engineer) · marker `data-shade-label` found · PR https://github.com/acme/theme/pull/42
```

## Block 1

- **The label line** (`_Preflight — automated pre-run …_`) always stays, in every form: a `Testing
  Status` without it reads as the QA engineer's own verdict and invites a transition on agent
  evidence.
- **Verdict**, exactly one of four, chosen from the rows: **Pass** (every reachable row verified),
  **Fail** (at least one defect with evidence), **Block** (the gate failed, the chosen theme does not
  carry the change, or no AC could be reached), **Partially pass** (some rows verified, the rest
  `needs data` / `for human eyes` / `not-executable`). A brief with no Block 1 (non-theme, nothing to
  test) has no Testing Status at all.
- **Colour** — `{color:green}Pass{color}` / `{color:red}Fail{color}` on the status line and leading
  every numbered row, so the verdicts scan as a column; Partially pass, Block and the label line stay
  plain. `md-to-adf.cjs` turns the wiki form into Jira's colour; the file and the chat show it
  literally.
- **Pass and Partially pass** list only green rows under `**Evidence on the criteria that pass
  verification:**`, each an observed fact — what was done, what the page did.
- **Fail** lists every row that ran under `**Evidence:**`, passing rows as above, each defect
  `{color:red}Fail{color} — <where> — expected <what the AC says>, actual <what the page did>`.
- **Block** — the label line, a viewport bullet per pass that ran (none when no row ran, the desktop
  bullet alone when the run stopped after the desktop pass), the `Tested in theme build:` bullet, one
  reason line, nothing else: no evidence list. The reason line names what failed
  (`theme 123456789012 not reachable on <page URL as opened> — Shopify.theme.id is 987654321098`); for
  a change not on the theme it says so plainly (`the change is not on theme 123456789012 develop —
  <one-line evidence>`) and names no other theme.
- **`Tested in theme build:`** — `<theme label> <store alias> (theme <id>)`; a run that stopped
  before a theme was chosen writes `theme not chosen`; one that chose live and stopped before the
  gate read `Shopify.theme` writes `live <store alias> (theme not read)` (a preview link still names
  its own id). `<theme label>` is the registry's label for
  that id, else `Shopify.theme.name` from the gate, else `live` / `preview` — never invented; the
  gate's no-change question uses the same fallback.
- **Never in Block 1**: labels and components, console / network / Lighthouse / axe dumps, commit SHAs
  or diff references, test-case ids, environment matrices, timing numbers, worklogs, field updates,
  `screenshot:` lines or file names, and any Block 2 material.

## Block 2

Read top to bottom by a person, so laid out for scanning: every label its own paragraph with a blank
line before and after; one bullet per row or fact beneath it, two sentences at most; a label with
nothing under it stays one line (`**Needs data:** none`); **Route** and **Deployed** single lines.

- **For human eyes** — one bullet per row judged `for human eyes`: `row <n> — <what a person judges>
  — <page URL as opened>[, <second page URL>]`. When no row was judged so, the **hands-on pass**
  instead, one bullet per row that ran: `hands-on pass — row <n> — open <URL>, <clicks> — look at
  <what the row proves>`, rows sharing a fixture and path collapsed into one bullet. The URL is the
  exact fixture the run used (the stand-in when one replaced an example), as opened — never the
  storefront root; a result in the cart, checkout, a drawer or a modal starts at the product the run
  added and spells the clicks (`add to bag`, `open the cart drawer`, `apply code SAVE10`). `none`,
  `all rows verified` and any wording that says the engineer need not look are forbidden — **except on
  a Block or a brief with no Block 1**: no row ran, so **For human eyes** and **Needs data** read
  `none` and no URL is made up. The batch table's **For human** column counts only rows judged `for
  human eyes`.
- **Needs data** — a **recipe** the engineer follows click by click, never a diagnosis of what the
  store lacks:
  1. **Where** — the store alias, then one absolute admin URL (`<handle>` = the gate's `shop` minus
     `.myshopify.com`): a theme setting →
     `https://admin.shopify.com/store/<handle>/themes/<theme id>/editor?previewPath=<url-encoded path>`;
     a product / collection → `…/store/<handle>/products/<id>` when the id was read, else
     `…/products?query=<handle>`; a metafield definition →
     `…/store/<handle>/settings/custom_data/<owner>/metafields`.
  2. **What** — the section by its editor name and position (`templates/<name>.json` order,
     `{% schema %}` `name`), the block, every setting by its **label** and the value by its **option
     label**, `t:` keys resolved through `locales/en.default.schema.json` — never a setting id or a
     code value; a metafield by definition name, `namespace.key`, type, owner and value.
  3. **Then** — Save, the page URL as opened, what the row then shows.

  Read from the theme code in the working tree and, for ids and metafield definitions, Admin API
  reads when a runner exists. Nothing guessed: a setting the schema does not hold is a **Developer
  gap**. Prefer the cheapest fixture (a setting on a block already on the page over a new section).
  When the theme under test is live or shared, say so on the row and leave the choice to the engineer.
- **Developer gaps** — a Steps/AC contradiction, a missing page, an absent AC, a ticket question.
- **Observations** — facts the ticket does not imply (a non-code root cause, a second broken thing, a
  404, `gh unavailable:`, a stand-in, the store notes quoted fenced), never a verdict.
- **Route** — `ready for hands-on QA` | `back to developer` | `back to the QA engineer's theme choice /
  deploy owner` | `nothing to test in the theme → <deploy/content owner>`.
- **Deployed** — last, one line, the developer's trace: `theme <id> <label> (<live | preview link>,
  chosen by the QA engineer) · marker <`<string>` found | absent | no marker — the rows are the proof>
  · PR <url | none>`; a run that stopped before the browser: `theme not chosen · PR <url | none>`. Live
  chosen but never read writes `theme not read` for `<id> <label>`; a run that stopped before the
  marker read writes `marker not read`.
  The PR appears once, as its URL, no `#<n>`. Branches, merge date and the target-page rung are not
  written.

**Every URL in the brief** is absolute, resolved and clickable — built per gate.md → Page URLs, one
per page, comma-separated when a row spans several. Forbidden: `PR preview URL`, `(in preflight.md)`,
`see Deployed line`, a path without scheme and domain, a template name for a page, a handle the tester
would have to look up, a placeholder.

## Chat output

The batch table `Ticket | Store / theme | Status | Verified n/m | For human | Needs data`, then both
blocks per ticket printed verbatim with their URLs — never abbreviated to a pointer at the file. Then
the screenshots: say once, `screenshots are not uploaded to Jira — copy the ones you need into the
comment yourself.`, then one message per row, desktop and mobile together, captioned `<KEY> row <n> —
<slug>` — in the desktop app through `SendUserFile` (`display: render`), else each file's absolute
path, one line per row. A Block sends none; its frames stay on disk, uncited.

## Jira comment

Opt-in, one comment per ticket at most.

1. **Ask once, at the end, naming keys.** Show each Block 1 in full and ask which keys to post.
   Consent covers only the keys the QA engineer names back — a bare "yes" to a multi-ticket run is a
   question, and one ticket's yes is never another's. No keys named → post nothing.
2. **Only Block 1 goes.** Write it to `.claude/tasks/<KEY>/preflight-comment.md` — no `# <KEY>`
   heading, no Block 2 — and brief `base:jira-writer` with key, workspace path, target `comment` and
   that file; never `preflight.md`, which would post Block 2 to the client's ticket.
3. No screenshot reference, file name or local path in the comment. No transitions, no field edits.
