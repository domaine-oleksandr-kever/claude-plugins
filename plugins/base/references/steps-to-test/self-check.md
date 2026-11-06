# Steps to Test — Self-check before presenting

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

- **Reader test — the purpose of every rule below.** Read the draft as a QA who sees this project for the
  first time, with no code and no admin open. For every noun in the field answer three questions: where do I
  find it (a route, a panel, an attribute, the exact admin name), what do I set it to, where does the result
  show. Any noun without an answer is rewritten until it has one. Clarity beats the word target: never cut a
  route, a label, a value or a locator to fit.
- One ordered list, items 1–4 numbered through, nothing wrapped; bullets one level deep under items 3
  and 4 only; no headings, tables, `✅` markers, accordion, FAQ or document meta.
- Item 1 names the environment, the store and a theme (ticket, developer's answer, or unconfirmed — never
  the PR's preview) and opens it; the storefront and Shopify admin hosts and the preview link appear there and
  nowhere else (a third-party admin's host starts its route in item 3, once); the storefront host is always named (unless the store is `unconfirmed: store:`), and only
  the `?preview_theme_id=` link is withheld with the placeholder theme, an unconfirmed id or a Prod store (route form instead); the
  preview link is bare (no code span, no label); the environment and the store never contradict each
  other.
- Item 2 names where the change lives — every page by path, the section / block by its admin label, every
  surface it reaches — and, for a change not visible on screen, the tool, panel and filter, every
  `DevTools > Network` mention with its filter, every `DevTools > Elements` mention with its attribute or
  selector in a code span.
- Everything the change adds or re-wires has its route and every non-default setting with its value by
  label in item 3, in dependency order; a theme-editor recipe ends with **Save**.
- Every state the Description or AC claims — fixed, kept or limited — has its setup in item 3, without
  `optional:`; a storefront state the shopper must be in before the change is reachable (a customer kind
  logged in, a cart of N items or past a threshold, consent accepted or declined, a market chosen) is an item 3
  requirement with its route when not obvious; item 3 holds no storefront action that is the test itself (a
  filter chosen, a term typed, a button clicked), a cache in the way's clear route excepted.
- Every data need in item 3 is a property list whose counts and values make the changed behaviour
  distinguishable from the unchanged one; a metafield value uses the entry's `Metafields` route; zero catalog handles, titles or "the page that is already
  set up" anywhere in the field (a path in item 2 is a page type, and so is a `/pages/<x>` whose
  `page.<x>.json` (or `.liquid`) the repo ships, and so is Shopify's built-in `/collections/all`); an entity QA creates is named by its
  role; every store-wide mutation carries its restore.
- No invented before: no Prod or other store as a "before"; a theme without the change only when the ticket
  or the developer's answer names it.
- An entity QA cannot configure (a feed, a third-party service, time) has a finding recipe in item 3: its
  signature in a source that still shows it after the change, never the symptom the change removes, where to
  look first, and that the source decides; item 4 says a page with none is not a failed test.
- The state that makes the changed code path run (the diff's `if` / `elsif` / `unless` guard) is an item 3
  bullet; the state that bypasses it is an item 4 fact.
- Every off-screen observation names the request as the code sends it, or the attribute as the code
  writes it, its value only as a shape with placeholders; an answer the code or a review
  contradicts, or that no source shows, is `unconfirmed: observation:` in the presentation.
- A cache between QA and the change names what it holds, where, and how QA empties it (clear site data or a
  wait past its TTL), never a bare wait.
- A store state that would hide or override the change (an active offer, an app override, a feature flag,
  a cookie / consent state) is named in item 3 as required absent or present.
- Nothing restated from the Description or AC: compare each sentence against the workspace `ticket.md`
  (with no AC, against the Description alone) and cut any feature summary, AC paraphrase, root cause or
  "what changed".
- Every item 4 line is a fact this change creates or changes — a boundary, a blank, a platform limit, a
  time-only state, an out-of-scope area, a field that changes, an unmentioned visible change "by design" —
  not a scenario, not an expected value and not behaviour nearby code already had.
- Every fact in the field (a storage, a duration, a filter, a count, a value, a label, a route) traces to
  a named source of this ticket; no sentence or clause is copied from an example in these references.
- Every unverified admin label is written as the best admin-style label, never the code spelling, and is
  listed as unconfirmed in the presentation; when the admin shows an identifier QA can search by (a
  definition's `namespace.key`, a metaobject type handle), it follows the label in a code span, a theme setting
  id never; every setup screenshot is asked for there as a `screenshot:`
  item.
- Word count targets 50–120 (a one-setting change may be 30); over it is fine while every clause is setup or
  a fact QA needs — cut wording, then item 4, never a setup bullet, a route, a label, a value or a locator.
- No banned content: a walk-through, "You should see", an expected result, the PR's preview theme,
  storefront or Shopify admin hosts outside item 1, passwords, deploy or CI mechanics, "works correctly",
  "or similar", a hedge (an existing-entity `— if the store already has one, use it` is not one), a code
  identifier (a found fixture's quoted signature, an off-screen observation's locator, an admin-shown
  `namespace.key` or metaobject type handle after its label and "look first" excepted), an example sentence
  from these references.
