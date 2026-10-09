# Estimate Pre-Submission Checklist

Source of truth: [Notion — Estimator Pre-Submission Checklist](https://app.notion.com/p/3571e5089a2580b5a010e5deeea4c6aa)
Last synced: 2026-07-29. If a user says the checklist has changed, re-fetch this page through
base's notion MCP (`notion-fetch`), review against the fresh text, and tell the user this file in the
pm plugin needs the update.

**The Standard:** If this estimate were copied directly into an SOW, it would be safe to execute.
Reviews are final executive approvals, not workshop sessions. If it's not ready, don't submit it.

**Priority key:** 🔴 REQUIRED = blocker, do not submit. 🟡 REVIEW = SE judgment required.

---

## 1 — Quality & Presentation

All estimates, scopes of work, proposal decks, and other client-visible content should always
follow these guidelines.

- 🔴 **Spell check and grammar review completed** — Full spell check. No typos, grammatical errors,
  or placeholder text in any visible field.
- 🔴 **All line item names are clear and client-ready** — Descriptions legible to a non-technical
  stakeholder. No internal jargon or shorthand.
- 🔴 **No placeholder or incomplete sections** — Every section filled in. No "TBD," "TODO," or
  empty fields that will appear in the final document.

## 2 — Scope & Assumptions

There should always be a short summary that explains the intent of a project scope — 2-3 sentences
covering client expectation, project complexity, and client sentiment / perceived working
relationship expectations.

- 🔴 **Key assumptions reviewed, no line items contradict them** — Key Assumptions set the baseline
  that de-risks multiple tabs. Confirm no individual line item conflicts with a stated key
  assumption.
- 🔴 **No unexplained large bundles (e.g. 55-hour blocks)** — Any large-hour bundle must have
  documented justification. If it can't be broken into two or more line items with clear
  rationale, it's not ready.
- 🔴 **Design and build tabs are in sync** — Every component scoped in build has a corresponding
  design line item, and vice versa. Common misses: mini cart in build but not design, bundle PDP in
  build but not design, dev handoff hours missing from design tab.
- 🔴 **Explicitly out-of-scope items are documented** — Data migration, SEO migration,
  backend/ERP integrations, content entry, and legacy account support are common omissions. If
  they're out of scope, state it explicitly — don't leave it implied. The OOS section of design,
  build, and back end exists for this purpose.
- 🟡 **Timeline is realistic relative to scope** — Client target launch date validated against
  actual project complexity. Flag to sales if the requested date is not achievable before the
  estimate is presented.
- 🟡 **Studio vs. Domaine approach is clear** — The offering is explicitly classifiable as Studio or
  Domaine aligned. Reference the Studio vs. Domaine Qualifying Guide if needed.

## 3 — Cross-Functional Alignment

Look out for the team that will ultimately execute the work. If proposing cutting-edge or untested
technology, make sure the appropriate assumptions and LOE are accounted for and validated with the
correct SMEs.

- 🔴 **Integration approach is documented in line item assumptions** — For any third-party
  integration (CDP, ERP, search, CRM), the approach is briefly described in the line item — not
  just an hour count. Reviewers consistently flag vague integration line items.
- 🔴 **SME input confirmed on backend/complex scope** — The submitting SE has gotten the necessary
  input, feedback, or sign-off from relevant SMEs on backend, integration, or other complex scope
  before submitting. Confirm with the SE — a written Slack/Bluedot trail is helpful but not required.
- 🟡 **High-risk or novel scope flagged for delivery team** — Anything technically untested, at
  unusual scale, or dependent on an unvalidated third-party partner should be flagged, not buried
  in assumptions.

## 4 — Commercial Readiness

Generally expected to be jointly discussed and owned by the AE and SE on the deal.

- 🟡 **Revenue viability assessed** — The deal makes commercial sense at the estimated price point.
  Close-rate risk and financial implications have been considered.
- 🟡 **Estimate is competitively positioned** — Pricing reflects market context and client
  expectations. Any outlier pricing (high or low) is intentional and documented.
- 🔴 **Multi-option or phased approaches are clearly separated** — If presenting multiple scenarios
  (e.g. single store vs. multi-site, Phase 1 vs. full scope), each has its own clean tab or section.
- 🔴 **Currency and rate card are correct** — Confirm the estimator uses the correct currency for the
  client's region and the current rate card. CAD/USD/EUR mix-ups have been caught in review.
- 🟡 **Escalation / risk items flagged for reviewer** — Known risks, open questions, or items
  requiring reviewer judgment are called out clearly either in the estimator or the review request.

## 5 — Final Gate

- 🔴 **First-pass self-review completed by submitting SE** — The SE has read the entire estimate as
  if they were the reviewer and would be comfortable defending every line.
- 🔴 **Estimate is ready to be copied into an SOW** — Final confirmation: if converted to a contract
  today, the team could execute against it without ambiguity.
