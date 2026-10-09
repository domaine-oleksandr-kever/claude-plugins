# Checklist Evaluation Guide

How to evaluate each item in `pre-submission-checklist.md` against real estimate content, not just
confirm the section exists. Distilled from
[Estimation Best Practices — Domaine SE](https://app.notion.com/p/3571e5089a25814da7b9e59ebe27bac2)
and [Project Estimate Review Process](https://app.notion.com/p/11a1e5089a2580ff9c77e4b14a8f7846).

Core stance: **assume everything is in scope until it's explicitly marked out.** A blank
out-of-scope section is itself a finding, not a pass.

**Unchecked rows keep their hours — that's expected, not a finding.** Domaine's estimator template
pre-populates FED/BED/QA/BSA hour cells on every line item, including ones marked
`In Scope? = False`. This lets an SE flip a row into scope later without re-estimating it from
scratch. A False row with populated hours is normal template behavior, not a placeholder, not an
inconsistency, and not evidence the workbook is unfinished. Never cite it as a 🚩 flag under any
category. The only thing that matters is whether the tab/phase-level SUBTOTAL and EST. TOTAL rows
correctly exclude those hours (they normally do, via formulas keyed off the In Scope? flag) — spot
check the totals if something looks off, but the presence of hours on a False row by itself is not
a problem worth raising.

## 1 — Quality & Presentation

- **Spell check / grammar** — Read every visible cell across every tab. Flag typos, broken
  formatting, or leftover placeholder text ("Lorem ipsum," "TBD," "xx hours").
- **Line item clarity** — For each line item, ask: would a non-technical client stakeholder
  understand this? Flag internal shorthand, tool names with no context, or acronyms not spelled out
  anywhere in the sheet.
- **No placeholders** — Search explicitly for "TBD," "TODO," "???", `In Scope? = True` rows with
  zero hours and no rationale, and empty required cells (e.g. a genuinely blank OOS section, or an
  OOS row that still reads the unfilled template text, like "OOS Item / Assumes OOS Item is out of
  scope").
  **This check applies only to rows that are in scope or to sections meant to hold real content.**
  An unchecked (`In Scope? = False`) row that still has populated FED/BED/QA/BSA hour cells is not a
  placeholder — Domaine's estimator template intentionally keeps default hours on unselected rows so
  they're ready to use if the item gets pulled into scope later. Don't flag it, and don't read it as
  incomplete or ambiguous.

## 2 — Scope & Assumptions

- **Assumptions vs. line items consistency** — Extract every Key Assumption. For each one, scan the
  line items in every tab for contradictions. Example failure: assumption says "single storefront"
  but a build-tab line item scopes multi-region logic; or a Site Configuration line reading "single
  language / single currency" sitting directly above an International Configuration line assuming
  Shopify Markets + Translate & Adapt. Cite the specific assumption and the contradicting line item,
  and name which one you think is wrong. Also check for in-scope (`In Scope? = True`) items with
  zero hours, and open items that contradict a closed assumption.
  **Do not flag out-of-scope (`In Scope? = False`) rows for carrying populated hour cells.**
  Retaining a default hour value on an unchecked row is normal template behavior, not a sign of an
  incomplete or contradictory estimate — see the "Unchecked rows keep their hours" note below.
  Only evaluate hour values, complexity ratings, and bundle justification against rows where
  `In Scope? = True`.
- **Named-hour commitment framing** — For assumptions like "Domaine has included up to 50 BED hours
  for [system]," check whether that number consumes the role's entire phase budget (no runway — any
  overage becomes a PCR) and whether the language is explicit about *consultation only* vs.
  hands-on implementation. Ambiguous framing here is where scope disputes start. On multi-site,
  lower per-site Build hours are only defensible if there's an explicit assumption that subsequent
  sites inherit Core code/config — if it isn't written down, flag it.
- **Unexplained bundles** — Among rows marked `In Scope? = True`, flag any single line item at or
  above ~40-55 hours that has no breakdown or written justification in its description/assumptions.
  A bundle is fine if the description explains why it can't be split; a bundle with just a number is
  not. Skip this check entirely for `In Scope? = False` rows — their hours aren't being committed to.
- **Complexity ratings honest** — Among rows marked `In Scope? = True`, check each significant line
  item's Low/Med/High rating against `complexity-framework.md`. Complexity is about risk and
  unknowns, not hours — a bundle can carry big hours and still be under-rated if it touches
  cart/checkout, needs both FE and BE code, or depends on an external system. Run the
  three-question screen from the framework and flag anything custom or integration-touching marked
  Low, and anything cart/checkout/payment-touching marked below High. Don't rate complexity on
  `In Scope? = False` rows — they're not part of the committed scope, so an under-rating there
  doesn't under-scope anything.
- **Design/build parity** — Build a mental (or literal) list of `In Scope? = True` components in
  the Build tab and cross-check each against `In Scope? = True` items in the Design tab, and vice
  versa. Common misses to check by name every time: mini cart, bundle PDP, dev handoff hours in
  design. Flag any in-scope component present in one tab and absent (or marked out of scope) in the
  other. Two rows both marked `False` in different tabs are not a mismatch — that's just two things
  neither tab is building.
- **Out-of-scope documentation** — Check specifically for explicit mention (in-scope or
  out-of-scope) of: data migration, SEO/URL migration, backend/ERP integrations, content entry,
  legacy customer account support. If any of these is simply absent from the estimate with no OOS
  note, flag it — don't assume silence means "not applicable."
- **Timeline realism** *(🟡 judgment)* — Pull the client's target launch date (from the sheet, Drive
  docs, or Bluedot/Slack scoping context) and the scoped effort/phase breakdown. Do the math on
  whether the timeline is plausible given total hours and team size implied. Present the math; do
  not issue a pass/fail verdict yourself — this is SE judgment.
- **Studio vs. Domaine classification** *(🟡 judgment)* — Confirm the estimate states which offering
  it is. If ambiguous or unstated, flag it rather than guessing.

## 3 — Cross-Functional Alignment

- **Integration approach documented** — For every line item referencing a third-party system (CDP,
  ERP, search, CRM, payments, or any named vendor/app), confirm the description/assumptions include
  an approach — not just an hour count. "Rudderstack integration — 34 hours" with nothing else is a
  fail; a sentence on what's in/out and what it depends on is a pass.
- **High-risk/novel scope flagged** *(🟡 judgment)* — Identify anything that reads as
  technically untested, unusually large scale, or dependent on an unvalidated third-party. Surface
  it explicitly even if it isn't a hard fail — this is what reviewers catch if the SE doesn't flag
  it first. First-time use of a new Shopify feature and custom backend integrations (ERP/OMS/PIM)
  are the usual suspects — cross-check against the High-complexity triggers in
  `complexity-framework.md`.
- **Role coverage vs. scope** *(🟡 judgment)* — Sanity-check role hours against the work: BED
  present where international markets, regional payments, tax, or ERP/OMS integration are scoped;
  QA hours divided across sites/brands/surfaces (show the arithmetic — under ~30 hrs per site on a
  multi-site build needs more hours or an explicit assumption that Core FSUAT covers all sites);
  and Discovery hours actually grounding any integration committed in Build (if Build promises 50
  BED hours of ERP work but Discovery carries 10, the architecture is unknown at commit time).
- **SME input on backend/complex scope** — Process confirmation, same pattern as first-pass
  self-review: ask the SE directly whether they've gotten the necessary SME input, feedback, or
  sign-off on backend, integration, or other complex scope. Slack/Bluedot may corroborate when
  present, but absence of a written trail is not a finding — SEs often consult offline. Do not
  invent a checklist row, do not use ❓ for missing scoping history, and do not assume yes.

## 4 — Commercial Readiness

- **Revenue viability** *(🟡 judgment)* — Surface the total estimated value, hours, and any pricing
  outliers found in the sheet or CRM context. Do not assert whether the deal "makes sense" — that's
  AE/SE judgment.
- **Competitive positioning** *(🟡 judgment)* — Same treatment: surface facts (pricing relative to
  scope size, any comparable prior estimates if referenced), leave the verdict to the SE.
- **Multi-option/phased separation** — If the estimate presents more than one scenario, confirm each
  has its own tab/section and that assumptions in one don't bleed into another (e.g. a "single
  storefront" assumption stated once but applied globally when Option B is multi-site).
- **Currency and rate card** — Confirm the currency used matches the client's stated region, and
  that the rate card referenced (if identifiable in the sheet) matches current rates. If you cannot
  verify "current" rate card without a live source, say so explicitly rather than passing it.
- **Escalation/risk items flagged** *(🟡 judgment)* — Check whether known risks or open questions
  are called out anywhere in the estimator. A clean estimate with zero risks flagged on a complex
  project is itself worth a light flag — ask whether that's really true.

## 5 — Final Gate

- **First-pass self-review** — This is a process confirmation, not something derivable from the
  document. Ask the SE directly whether they've done this if the answer isn't stated; don't assume
  yes.
- **SOW-ready** — This is the composite verdict: true only if every 🔴 item above passed and no 🟡
  item was left as an open, unresolved flag by the SE.

## Common Failure Modes to Actively Search For

These are the patterns that recur in real review threads — check for them explicitly rather than
waiting for them to surface:

- Assumptions copied from a prior estimate and never updated for this scope.
- Reviewer has to ask "is X in scope?" because migration/SEO/content entry/backend integration is
  never mentioned at all.
- Client-requested launch date entered as the delivery date with no math run against it.
- Build component with no design-tab counterpart.
- Integration line item with an hour count and no approach description.
- Currency/rate card mismatched to client region.