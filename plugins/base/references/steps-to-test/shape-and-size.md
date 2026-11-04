# Steps to Test — Shape and size

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

- **One physical line per item and per bullet.** Never wrap: `md-to-adf --no-tables` reads a
  continuation line as a new paragraph and splits the list. Fold a second sentence in or nest it.
- **One ordered list, items 1–4**, numbered through. Nested bullets one level deep, under items 3 and 4
  only. No headings, tables, `✅` markers, accordion / expand blocks, troubleshooting or FAQ blocks — QA
  asks in the ticket.
- **Examples are shapes, not facts.** Every quoted example in these references shows the shape of a
  bullet; none of its facts (a storage, a duration, a filter, a count, a value, a label, a route, a page
  kind) goes into the field unless a source of this ticket shows that fact.
- **Every fact traces to a source** — the diff, the theme code the changed files call or import (read it —
  grep the helper — before calling a fact unconfirmed), `{% schema %}` and locales, the ticket, linked docs,
  `notes.md`, the developer's answers; a fact no source shows is written as the best reading of the sources
  and listed as unconfirmed in the presentation, never as an example's value.
- **Field-ready, no document meta** — no title, summary, revision history or rationale; no note to the developer,
  brief text or line meant for an agent.
- **No repetition.** QA reads the Description and AC first: no feature summary, no AC paraphrase, no root
  cause, no "what changed".
- **Setup, not testing.** No walk-through, no "You should see …", no expected results, no pass / fail
  language — QA decides how to test from the AC. A recipe to find a fixture QA cannot configure is setup,
  and its item 4 clause "a page with none of these today is not a failed test" is a fact, not a verdict.
- **Observable words only** — labels as the admin spells them, in bold; routes as `A > B > C`; paths as
  `/products/…`. No code identifiers, file names, setting ids, class names or locale keys — except a found
  fixture's signature, the locator of an off-screen observation (the request path, the element attribute,
  the cookie or dataLayer key as the code writes it) and an identifier the admin shows for QA to search by (a
  definition's `namespace.key`, a metaobject type handle) after its label, in a code span; a theme setting id
  is never shown in the admin, so it stays out.
- **No hedged actions** — no "if present", "roughly", "skip if": an action is taken or the bullet goes.
  An `optional:` setup bullet, item 1's unconfirmed theme, a time-only state, a found fixture's "look
  first" and "the source decides", and an entity the store may already hold (a definition, a market, a
  customer account, a selling plan) written as the action plus `— if the store already has one, use it` in
  the same bullet are not hedges.
- **Absolute storefront and admin hosts only in item 1** — the store host, the Shopify admin host and the
  preview link; every other storefront or admin path stays relative. A third-party admin where QA configures
  something (Talon.One, Fredhopper, an app's own admin) is named by its host in item 3, once, as the start of
  its route. Never fork per store.
- **Banned:** deploy or CI mechanics, storefront passwords, the PR's own preview theme, "works correctly",
  "or similar".
- **Size.** Target 50–120 words; a one-setting change can be 30. Every sentence is an action or a fact QA
  needs to reach the change — cut anything else. Going over the target is fine whenever every remaining
  clause is setup or a fact QA needs; vagueness is not. To shorten, cut wording, then item 4 — never a setup
  bullet item 3 needs, and never a route, a label, a value or a locator.
