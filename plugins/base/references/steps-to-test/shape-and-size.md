# Steps to Test — Shape and size

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

These bind both templates; n+1 / n+2 and the walk-through rules name General items only.

- **One physical line per item.** Never wrap an item or a nested bullet: `md-to-adf --no-tables` reads a
  continuation line as a new paragraph and splits the list. Fold a second paragraph in or nest it.
- **One ordered list, end to end** — numbering runs through, Edge cases and Context last. No headings, no `✅`
  markers, no tables; nested bullets one level deep, under items 2, n+1 and n+2 (General) and item 4 (Bug).
- **No document meta** — no title, summary, revision history or rationale.
- **Observable words only** — labels as the UI spells them, copy as it renders; no setting ids, DOM
  attributes, ARIA roles, class names, file paths or locale keys. An a11y expectation says what a screen
  reader does; **Theme content** copy is its admin route plus the string it renders.
- **No hedged actions** — no "if present", "roughly", "skip if": an action is taken or the step goes. A
  conditional inside an expectation is fine, as are item 2's "if it is missing …" and item 1's unconfirmed
  theme; a dated instruction is an action, not a hedge.
- **Absolute hosts only where they are the address** — item 1's store host and preview link, one admin/editor
  deep link in item 2; storefront paths in items 3…n stay relative. Never fork per store.
- **Size.** 150–350 words; setup-heavy (a section built from scratch, fixtures QA creates) up to 450. Coverage
  of items 1, 2 and n+2 outranks the budget; trim walk-through prose, repetition and edge cases first, never
  setup detail, a step's expectation or a developer choice. A cap, not a floor — a one-setting change is
  legitimately Example-2 short.
