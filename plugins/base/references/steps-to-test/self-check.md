# Steps to Test — Self-check before presenting

One section of the Steps to Test format; the index is `../steps-to-test-format.md`.

- One ordered list, numbered through, nothing wrapped; bullets one level deep under items 2, n+1, n+2
  (Bug: item 4); no headings, tables, `✅` markers or document meta.
- Item 1 first, naming a theme (ticket, developer's answer, or unconfirmed — never the PR's preview) and
  opening it; store host and preview link at most once.
- Everything the change adds or reconfigures has its editor route, every non-default setting with its value
  by label and its content — in item 2 (a recipe block there ends with **Save**), in its fallback, or in the
  steps that build it.
- Item 2 names every page by path, the section as the admin sees it, and every entity the walk-through
  starts from.
- Every catalog handle, in either template, carries `e.g.` plus the properties a stand-in must share; the
  substitution rule appears once, as its own sentence; no step names a handle instead of its role; every
  handle was confirmed on item 1's store in this session, or is named as unconfirmed in the presentation.
- Every AC is exercised by a step, or discharged in n+2 in the AC's own words — never simply absent.
- Every step that changes or checks state carries its expectation inline, concrete where observable.
- Every new or changed setting has its blank / overflow / boundary expectation somewhere; every edge case is
  reachable with the named data; every store-wide mutation carries its restore.
- Walked through as written, nothing from memory; whatever made you hesitate gets a sentence, or a screenshot
  is asked for in the presentation.
- No banned content: the PR's preview theme, per-store forks, absolute storefront hosts in items 3…n,
  passwords, deploy or CI mechanics, "works correctly", "or similar", a hedge, a code identifier.
- The choices that affect testing are stated (defaults, what was left unchanged, limits, out of scope) or
  there genuinely are none; items 1, 2 and n+2 are complete, nothing cut to a word count — this field plus
  admin access is enough.

On the **Bug template** these apply through item 4 — the location, the trigger data / viewport / locale (the
trigger and boundary products as `e.g.` handles with their properties), the setup recipe, a new setting's
boundary expectation, what a regression looks like — and item 4 is a lead line plus one bold-labelled bullet
per case (trigger · each further surface or viewport · boundary with its restore · **Regression**), never one
paragraph; a viewport-dependent fix carries the breakpoint in px in item 1 and in the bullet labels.
