# Domaine Estimator Structure

The estimate is a `.xlsx` workbook (usually opened from Google Drive, sometimes native Google
Sheets). Know the tab layout before reviewing — a contradiction or gap can live in any tab, and
the Settings tab and every price, cost or margin column are off-limits (the skill's commercial
restraint).

## Typical tabs

- **External Summary** — phase-level estimates, kickoff and launch dates, key assumptions, project
  categorization. The client-facing framing lives here.
- **Internal Summary** — per-phase hours and per-phase role breakdowns. **Read hours and roles
  only.**
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

- Column A carries an **"In Scope?"** flag on the Build/discipline tabs. A discipline tab outside
  the engagement shows a zeroed SUBTOTAL / EST. TOTAL row; False rows keep their hours (the In Scope?
  rule in `pre-submission-checklist.md`).
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
