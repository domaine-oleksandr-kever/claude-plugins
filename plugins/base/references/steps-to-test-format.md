# Steps to Test — Domaine format

Output standard for `/fe:write-steps-to-test` and the pipeline steps-to-test phase: **one numbered
list of four items** — Theme · Object · Setup · Edge cases / not obvious — nothing else. The field tells
QA **how to set the change up so it is testable**; QA tests it against the AC, which they already read.
It is not a test script: no walk-through, no expected results, nothing restated from the Description or
AC. Say **what** QA has to configure — the kind of product, collection, setting value — and let QA build
it; never hand over a ready-made fixture.
The goal every rule serves: a QA who sees this project for the first time knows, from the field alone,
where every named thing is, what to set it to and where the result shows — clarity beats the word target.
When the session carries the how-to-explain convention, sentences follow it; this format decides
structure and mandatory wording.

One skeleton for every issue type: a Bug changes what item 3 holds, not the shape.

## Sections — one file each, under `steps-to-test/`

- [Template](steps-to-test/templates.md) — the four-item skeleton, and how a Bug fills it.
- [Item-by-item rules](steps-to-test/item-rules.md) — theme, object, setup, edge cases, screenshots.
- [Shape and size](steps-to-test/shape-and-size.md) — one list, one line per item, examples as shapes and
  every fact from a source, observable words, no repetition, the word target, banned content.
- [Theme resolution (item 1)](steps-to-test/theme-resolution.md) — which theme item 1 names.
- [Self-check before presenting](steps-to-test/self-check.md) — the checklist run before the draft is shown.
