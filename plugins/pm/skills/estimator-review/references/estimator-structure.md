# Domaine Estimator Structure

The estimate is a `.xlsx` workbook (usually opened from Google Drive, sometimes native Google
Sheets). Know the tab layout before reviewing — a contradiction or gap can live in any tab, and
some tabs are deliberately off-limits (see the carve-out at the bottom).

## Typical tabs

- **External Summary** — phase-level estimates, kickoff and launch dates, key assumptions, project
  categorization. The client-facing framing lives here.
- **Internal Summary** — per-phase hours and per-phase role breakdowns. **Read hours and roles
  only** — skip price, cost, profit, GM columns.
- **Monthly Revenue Breakdown** — phasing. Not used for review.
- **Discovery** — workshop-level line items.
- **Design** — design batch breakdowns.
- **Build - Core Site** — feature-level scope with FED / BED / QA / BSA hours per item; an
  "In Scope?" flag in column A.
- **Build - Multi-site** — per-site setup line items (present on multi-site/multi-brand variants).
- **Data Migrations & Custom Backend** — migration and integration consultation lines.
- **CRM, POS, B2B, SEO** — discipline tabs, often zeroed out when not part of the engagement.
- **Settings** — rate card and multipliers. **Out of scope for this review — do not read.**

## Column conventions

- Column A carries an **"In Scope?"** flag on the Build/discipline tabs. A discipline tab that
  isn't part of the engagement should show a genuinely zeroed SUBTOTAL / EST. TOTAL for that tab —
  check the aggregate row, driven by the In Scope? flag, not the individual line items above it.
  Individual rows marked `In Scope? = False` are expected to retain their hours
  (FED/BED/QA/BSA) even when the whole tab or an individual feature is out of scope — that's
  intentional, so the row is ready to flip back into scope later without re-estimating. Do not flag
  a False row for having populated hours; only flag if the tab's own SUBTOTAL/EST. TOTAL row fails
  to net to zero when the whole tab is out of scope.
- Role hour columns are typically **FED** (front-end dev), **BED** (back-end dev), **QA**, **BSA**
  (business/systems analyst). **TA** (technical architect) shows on complex programs, mostly in
  Discovery.
- Each significant line item carries a **complexity rating** (Low / Medium / High) — see
  `complexity-framework.md`.

## Project-type variants (filename bracket tag)

Domaine estimator filenames carry a bracket tag: `[Online Store Baseline]`, `[Multi-site]`,
`[Multi-brand]`, `[B2B]`, `[POS]`, `[PCR]`, `[Build 2.0]`, etc. The tag reweights which checks
matter most:

- **Multi-site** → per-site protection language, QA depth per site, per-site config/app/theme
  divergence.
- **Multi-brand** → shared vs. brand-specific component boundaries, per-brand design divergence.
- **B2B** → catalog, company/location modeling, registration flow, payment terms, payment/discount
  function complexity.
- **POS** → hardware assumptions, location modeling, inventory sync.
- **PCR** (Project Change Request) → review the **delta against the original SOW only**; skip the
  full structural review.
- **Build 2.0** → inherited-code assumptions, what's actually being reused vs. rebuilt.

If no tag is visible, infer the variant from the assumptions/External Summary and state what you
inferred.

## Off-limits — do not read or comment on

- Settings tab (rate card, multipliers).
- Any price, cost, profit, gross margin, ABR, or blended-rate column on any tab.
- Whether the deal should be approved, held, or escalated on commercial grounds.

Read the Internal Summary for **hours and role allocations only**. If the user asks about margin or
pricing, say it's outside this review and point them to their Delivery Director / estimating lead.
The official Commercial Readiness checklist items (revenue viability, competitive positioning) are
surfaced as **facts for SE judgment**, never as a pricing verdict — see `evaluation-guide.md`.