# Steps to Test — Self-check before presenting

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

- One ordered list, items 1–4 numbered through, nothing wrapped; bullets one level deep under items 3
  and 4 only; no headings, tables, `✅` markers, accordion, FAQ or document meta.
- Item 1 names the environment, the store and a theme (ticket, developer's answer, or unconfirmed — never
  the PR's preview) and opens it; the store host and preview link appear there and nowhere else, and
  not at all with the placeholder theme, an unconfirmed id or a Prod store (route form instead); the
  preview link is bare (no code span, no label); the environment and the store never contradict each
  other.
- Item 2 names where the change lives — every page by path, the section / block by its admin label, every
  surface it reaches — and, for a change not visible on screen, the tool, panel and filter.
- Everything the change adds or re-wires has its route and every non-default setting with its value by
  label in item 3, in dependency order; a theme-editor recipe ends with **Save**.
- Every state the Description or AC claims — fixed, kept or limited — has its setup in item 3, without
  `optional:`; item 3 holds no storefront action (a filter chosen, a term typed, a cart filled).
- Every data need in item 3 is a property list whose counts and values make the changed behaviour
  distinguishable from the unchanged one; a metafield value uses the entry's `Metafields` route; zero catalog handles, titles or "the page that is already
  set up" anywhere in the field (a path in item 2 is a page type); an entity QA creates is named by its
  role; every store-wide mutation carries its restore.
- A store state that would hide or override the change (an active offer, an app override, a feature flag,
  a cookie / consent state) is named in item 3 as required absent or present.
- Nothing restated from the Description or AC: compare each sentence against the workspace `ticket.md`
  (with no AC, against the Description alone) and cut any feature summary, AC paraphrase, root cause or
  "what changed".
- Every item 4 line is a fact this change creates or changes — a boundary, a blank, a platform limit, a
  time-only state, an out-of-scope area, a field that changes, an unmentioned visible change "by design" —
  not a scenario, not an expected value and not behaviour nearby code already had.
- Every unverified admin label is written as the best admin-style label, never the code spelling, and is
  listed as unconfirmed in the presentation; every setup screenshot is asked for there as a `screenshot:`
  item.
- Word count within 50–120 (a one-setting change may be 30), or over it only for setup item 3 needs.
- No banned content: a walk-through, "You should see", an expected result, the PR's preview theme,
  absolute hosts outside item 1, passwords, deploy or CI mechanics, "works correctly", "or similar", a
  hedge, a code identifier.
