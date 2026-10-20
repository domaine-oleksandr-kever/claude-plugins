# Steps to Test — Domaine format

Output standard for `/fe:write-steps-to-test` and the pipeline steps-to-test phase: **one numbered
list** in the General or Bug item order of Domaine's company guide ("Writing Steps to Test"), nothing else.
The QA engineer already has the AC; what they lack is **how this was built** — theme, page, section, settings,
data, the developer's choices. So **fewer test cases, more how it was built**, written for someone opening the
Shopify admin for the first time.
When the session carries the how-to-explain convention, sentences follow it; this format decides
structure and mandatory wording.

## Which template

An explicit `ticket_type` argument decides; with no argument, Jira issue type `Bug` selects the Bug template
and anything else the General one.

## Sections — one file each, under `steps-to-test/`

- [Templates](steps-to-test/templates.md) — the General and Bug skeletons.
- [Item-by-item rules](steps-to-test/item-rules.md) — theme, where + setup, fixtures, the walk-through, edge
  cases, context, Bug item 4, visual aids.
- [Shape and size](steps-to-test/shape-and-size.md) — one list, one line per item, observable words, the
  word budget.
- [Theme resolution (item 1)](steps-to-test/theme-resolution.md) — which theme item 1 names.
- [Self-check before presenting](steps-to-test/self-check.md) — the checklist run before the draft is shown.
