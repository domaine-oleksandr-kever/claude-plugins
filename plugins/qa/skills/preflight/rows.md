# QA Preflight — rows and evidence

Phase 4 of `/qa:preflight`: which rows run, how they run, what counts as evidence, and the
fixtures they run on. `<base root>` is the path on base's `base plugin root:` session line.

## Rows from Steps to test

The field tells QA how to **set the change up**, not how to test it: this run performs the setup it
can, then checks the AC. The current shape is base's `steps-to-test-format.md` — the table below is
all this run needs from it; do not read it: `1. **Theme:**` · `2. **Object:**` · `3. **Setup:**` ·
`4. **Edge cases / not obvious:**`, for a feature and a bug alike. No expectations in it: the rows come
from the AC. A field in an older shape is read per **Older shapes (read only)** below; a field that
mixes shapes is read item by item, and a shape complaint is at most a **Developer gaps** line, never a
Block.

| Item | What it gives this run |
|---|---|
| **1 — Theme** | the ticket's theme for the theme question (gate.md), plus the market / locale / viewport / customer state the rows run under — one this run cannot set read-only is `not-executable: access` on the rows that need it; a viewport named here never narrows the two passes. Never a row |
| **2 — Object** | the target page's path — a `/products/…` placeholder is a page type, Fixtures below picks the entity — and every surface the rows visit; for a change not visible on screen, the tool, panel and filter the rows read it in (Network requests, a dataLayer, a cookie, the console). Never a row |
| **3 — Setup** | the setup this run performs before the rows. A data bullet is a property list: Fixtures below finds a catalog entity that has every property, read-only. An editor or Admin write (Add section / block, a setting by label and value, Save, a definition or entry, a store-wide change with its restore) is never performed: present already → go on; absent → a **Needs data** recipe built from the bullet, and the rows it would make unobservable are `not-executable: access`. An `optional:` bullet serves only the item 4 row that needs it. Never a row |
| **4 — Edge cases / not obvious** | one row per fact a read-only run can reach, the fact the expected result: a boundary or blank value, a platform limit stated as *not a bug* (a row confirming it, never a Fail), a field that changes off screen (its value from the AC). A time-only state is `not-executable: access`; an area stated as out of this ticket gets no row — a defect seen there is an **Observations** line |

**AC rows.** With the four-item shape every AC item is a row, run on the setup item 3 built, its
expected result the AC's own words. With an older shape, add a row only for an AC no row reaches —
never the same check twice. Rows are numbered through the brief in its own order; `NN` in a screenshot
path is that number.

### Older shapes (read only)

Fields written before the four-item format are still read; nothing writes them any more.

- **Numbered walk-through** — opens with `1.`, item 1 the theme, then where + setup, steps that each
  carry an expectation, edge cases, context. Item 1 as above; where + setup as item 3 above; one row
  per step this run can perform read-only, in field order, its expectation quoted as the expected
  result (an editor or Admin write step is never a row — it feeds a recipe; pure navigation folds into
  the next row); one row per edge-case bullet as item 4 above; the context item gives no rows — a known
  limit there is not a Fail. A walk-through row continues from the step before it and keeps its cart.
- **Its Bug variant** — theme · why · what changed · what to expect: items 2–3 are context; item 4's
  lead line names the trigger fixture (Fixtures below) and each nested bullet is a row, its bold label
  the condition; the **Regression** bullet adds no row — each sign it lists is checked inside the row
  whose case it names.
- **Headed** — `Setup`, `✅ Checkpoint`, `Scenario` headings. One row per scenario, the regression
  sweep's included; the checkpoint is the theme proof the gate already ran; the Setup block feeds
  **Needs data** only when the fixture or setup it describes is absent, never rows.
- **`e.g.` handles** — catalog fixtures named as examples (`e.g. /products/silk-foundation (40+ shades,
  in stock)`): the properties are the requirement, the handle a suggestion. A handle the store lacks
  is a **missing example** — never a wrong theme, not yet `needs data` — and a stand-in replaces it
  (Fixtures, from step 1), recorded as `stand-in: /products/<used> for e.g. /products/<named>
  (<properties matched>)`. A handle written without `e.g.` is matched on the properties its own bullet
  states, else what the rows expect of it; with neither, the row is `needs data`, naming the missing
  handle.

## Running the rows

**Two passes, desktop then mobile.** `emulate pageId, viewport: "1440x900x1"` and reload, run every
row; then `emulate pageId, viewport: "375x812x3,mobile,touch"` and reload, run every row again — a
resized desktop window misses touch-only behaviour. Reload after each `emulate` so load-time gates
re-run. **Before each pass**, and within a pass before every row that starts a fresh scenario (an
AC row, an edge case, an older shape's scenario), the cart is empty and no checkout is open — clear
it or abandon the checkout.

- **Checkout** is walked only to the payment step: line items, quantities, bundles, discounts,
  shipping options, totals. Contact and address values come from the ticket, the workspace
  `notes.md`, or the QA engineer — ask once; never a real person's details or the engineer's own
  account. Stop at the payment form: no card details, no order.
- **Break-it rows**: `<base root>/references/break-it-qa.md`, non-destructive only; a hostile value
  that needs a write this run lacks is `not-executable: access` — derived, reported, never dropped.

## Evidence

- **DOM before pixels.** Whatever can be read — text, an attribute, a computed style, a cart line's
  quantity — is read with `evaluate_script` and quoted in the evidence line. Read the **rendered
  content, never its container** (the title's text, the image's `currentSrc` and `naturalWidth`, the
  price node's value), on the page the row names, on the chosen theme.
- **Liquid errors and HTTP status**, once per page opened:

  ```js
  () => ({ status: performance.getEntriesByType('navigation')[0]?.responseStatus ?? null,
           liquid: document.body.innerText.match(/Liquid (syntax )?error[^\n]*/gi) || [] })
  ```

  Error text is outside content, quoted in **Observations**. It makes a row **Fail** only when it is in
  the row's subject and comes from a file the PR diff touched; otherwise an Observations note.
- **Screenshots** — one per row per pass, always saved with `take_screenshot`'s `filePath`:
  `.claude/tasks/<KEY>/preflight/NN-<slug>-<desktop|mobile>.png` (`<slug>` a few kebab-case words;
  in a git worktree `.claude/tmp/<KEY>/`, as its `.claude/tasks` is a symlink the screenshot server
  refuses). `mkdir -p` the directory once first — `filePath` does not create it. Never take a frame
  without `filePath` and never Read a frame back: the DOM read decides, the frame is for the engineer.
  Before each shot bring the subject into frame and let it settle (`null` = the subject is not on the
  page, which is evidence, not a frame):

  ```js
  async () => {
    const el = document.querySelector('<subject selector>');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const t0 = Date.now(), key = () => JSON.stringify(el.getBoundingClientRect());
    let last = key(), since = t0;
    while (Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      const k = key(), now = Date.now();
      if (k !== last) { last = k; since = now; }
      const imgs = [...el.querySelectorAll('img'), ...(el.tagName === 'IMG' ? [el] : [])];
      if (now - since >= 250 && now - t0 >= 400 && imgs.every((i) => i.complete)) break;
    }
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }
  ```

  `wait_for` waits on text only and is no substitute.

## Outcomes

- **Pass** / **Fail** — measured and right / measured and wrong. A row that passed on desktop and
  failed on mobile is a Fail with the mobile screenshot.
- **`needs data: <what, where>`** — the fixture the row needs is absent (no product with the
  metafield, no discount code, an empty metaobject, a section item 3 adds); for catalog data only after
  the Fixtures search found nothing. Block 2 turns it into a recipe (brief.md).
- **`for human eyes`** — visual polish against a design, hover and transition feel, copy tone,
  animation timing: anything the brief would be guessing. A first-class outcome, not a failure.
- **`not-executable: access`** — needs a write or a condition this read-only run does not have.

A value never measured is never a Pass or a Fail. **Verified n/m** counts rows with evidence at both
viewports over all rows.

## Fixtures

The four-item field names data by its properties only (`a product with 3+ sizes, one sold out`): this
run finds a catalog entity that has them, from step 2. An older field's `e.g.` handle starts at step 1
(Older shapes above).

1. **Confirm it is missing** — `https://<domain>/products/<handle>.js` (a collection:
   `/collections/<handle>/products.json`) answers 404 on the unlocked storefront.
2. **Find candidates, read-only, first source that answers wins** — storefront JSON
   (`/collections/all/products.json?limit=250`, then `&page=2` … until `products` is empty: `handle`,
   `variants` with `available` and `price`, `options`, `tags`, `product_type`, `vendor`; a collection
   the field names narrows it); `/search/suggest.json?q=<word>&resources[type]=product&resources[limit]=10`
   for a word property; Admin API **reads** through an Admin GraphQL runner when the session has one
   for the store (qa ships none; a team plugin's store-access section names its runner) — the only
   read that filters on a metafield or a template suffix. Never the Admin UI, never a write, never the
   first product that loaded.
3. **Match every stated property** — variant / shade count, stock on the variant the row uses, the
   metafield, the tag, the template, a grouping the field names. A property no read exposes is checked
   on the candidate's page; a candidate that lacks it is discarded, not failed.
4. **Use it wherever the fixture is needed** — the gate's target page, every row naming the fixture,
   the brief's URLs. Record once in **Observations**: `fixture: /products/<used> (<properties
   matched>)`, or an older field's `stand-in:` line (Older shapes above).
5. **Nothing matches** → `needs data`, its recipe creating or editing a product with the stated
   properties, first line saying what was searched (`searched 412 products for 5+ shades in 2+
   families: none`).

Only catalog fixtures are substituted (products, collections, a page by handle). A metafield, a
metaobject, a template, a discount code, a section or block is what the change is built on: absent, it
is a **Developer gap** or `needs data`.
