# QA Preflight — rows and evidence

Phase 4 of `/qa:preflight`: which rows run, how they run, what counts as evidence, and stand-in
fixtures. `<base root>` is the path on base's `base plugin root:` session line.

## Rows from Steps to test

The field arrives in either of two shapes, both accepted; a field that mixes them is read item by
item, and a shape complaint is at most a **Developer gaps** line, never a Block. The numbered shape is
base's `steps-to-test-format.md` — the table below is all this run needs from it; do not read it.

- **Numbered** — opens with `1.` and its item 1 names the theme.
- **Headed** (the older shape) — `Setup`, `✅ Checkpoint`, `Scenario` headings. One row per
  scenario, the regression sweep's included; the checkpoint is the theme proof the gate already ran;
  the Setup block feeds **Needs data** only when the fixture or setup it describes is absent, never
  rows.

| Item (numbered) | What it gives this run |
|---|---|
| **1 — Theme** | the ticket's theme for the theme question (gate.md), plus the market / locale / customer state / incognito conditions the rows run under — one this run cannot set read-only is `not-executable: access` on the rows that need it; a viewport named here never narrows the two passes. Never a row |
| **2 — Where + setup** | the target page's path, and the material of a **Needs data** recipe (editor route, every setting by its label with its value, data sub-bullets in order, Save, a `(restore: …)` clause) — copied into a recipe only when the fixture or setup is absent. Never a row |
| **3…n — walk-through** | one row per step this run can perform read-only — a storefront action carrying an expectation, in field order, the expectation quoted as the expected result. An **editor or Admin write** step (Add section / block, a setting set, Save, a fixture issued) is never a row, even with an expectation: it feeds a recipe, and a row it would make unobservable is `not-executable: access`, naming the write and its restore. Pure navigation folds into the next row |
| **n+1 — Edge cases** | one row per bullet, its stated behaviour the expected result; one a read-only run cannot reach is `not-executable: access` or `needs data`. A platform limitation stated as *not a bug* is a row confirming that behaviour, never a Fail |
| **n+2 — Context / out of scope** | never rows: context for the other rows — a known limit here is not a Fail; a choice contradicting the AC is an **Observations** line |

**Bug template** (theme · why it happened · what changed · what to expect): item 1 as above, items 2–3
context; item 4's lead line names the trigger fixture and feeds **Needs data** like item 2; then one
row per nested bullet, its bold label (viewport, surface, data state) the condition, its expectation
the expected result. The **Regression** bullet adds no row: each sign it lists is checked inside the
row whose case it names. An older item 4 written as one paragraph gives one row per expectation clause.

**AC rows.** Check which AC each row covers and add a row only for an AC no row reaches — never the
same check twice. Rows are numbered through the brief in its own order; `NN` in a screenshot path is
that number.

## Running the rows

**Two passes, desktop then mobile.** `emulate pageId, viewport: "1440x900x1"` and reload, run every
row; then `emulate pageId, viewport: "375x812x3,mobile,touch"` and reload, run every row again — a
resized desktop window misses touch-only behaviour. Reload after each `emulate` so load-time gates
re-run. **Before each pass**, and within a pass before every row that starts a fresh scenario (an
edge case, a Bug item 4 bullet, a headed scenario, an AC row), the cart is empty and no checkout is
open — clear it or abandon the checkout. A walk-through row continues from the step before it and
keeps its cart.

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
  metafield, no discount code, an empty metaobject); for an `e.g.` catalog handle only after the
  stand-in search found nothing. Block 2 turns it into a recipe (brief.md).
- **`for human eyes`** — visual polish against a design, hover and transition feel, copy tone,
  animation timing: anything the brief would be guessing. A first-class outcome, not a failure.
- **`not-executable: access`** — needs a write or a condition this read-only run does not have.

A value never measured is never a Pass or a Fail. **Verified n/m** counts rows with evidence at both
viewports over all rows.

## Stand-in fixtures

Steps to test names catalog fixtures as examples (`e.g. /products/silk-foundation (40+ shades, in
stock)`): the properties are the requirement, the handle a suggestion. A product / collection handle
the store lacks is a **missing example** — never a wrong theme, not yet `needs data`.

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
4. **Use it wherever the example was used** — the gate's target page, every row naming the fixture,
   the brief's URLs. Record once in **Observations**: `stand-in: /products/<used> for e.g.
   /products/<named> (<properties matched>)`.
5. **Nothing matches** → `needs data`, its recipe creating or editing a product with the stated
   properties, first line saying what was searched (`searched 412 products for 5+ shades in 2+
   families: none`).

Only catalog fixtures are substituted (products, collections, a page by handle). A metafield, a
metaobject, a template, a discount code, a section or block is what the change is built on: absent, it
is a **Developer gap** or `needs data`. A handle written without `e.g.` is matched on the properties
its own bullet states, else what the rows expect of it; with neither, the row is `needs data`, naming
the missing handle.
