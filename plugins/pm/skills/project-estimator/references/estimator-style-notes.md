# Estimator Style Notes

Use these notes to keep estimator outputs aligned to the current Domaine package style seen in the
reference estimators.

## Syntax Patterns

- Keep descriptions short and literal.
- Put key qualifiers in assumptions, not in long prose.
- Prefer assumption bullets that start with `Assumes`.
- Make scope boundaries explicit:
  - native vs custom
  - client-owned vs Domaine-owned
  - included now vs separate future phase
- Keep outputs copy-pasteable into estimator docs or sheets.

## Archetype Guidance

### Migration / Theme-Heavy Work

Use this pattern when the work resembles a fashion-brand replatform (a migration-and-theme project):
- package the estimate cleanly by `Discovery`, `Design`, `Build`, and `Testing & Release`
- call out platform migration assumptions clearly
- isolate backend consultation, migration, B2B, or post-launch services if they are separate scope
- use assumptions to define what falls back to native Shopify patterns vs custom build work

Typical cues:
- multi-region or multi-market rollout
- data migration ownership
- theme setup, design translation, pattern library, core storefront templates
- third-party connector consultation rather than hands-on ownership

### B2B Implementation / Migration

Use this pattern when the work resembles a wholesale B2B rollout (a B2B implementation project):
- emphasize business-process and operational assumptions
- call out pricing, account structure, ordering model, and ERP/integration constraints
- keep design scope minimal when the project is templated or Horizon-led
- separate phase-one must-haves from later enhancements

Typical cues:
- wholesale customer models, company accounts, or contract pricing
- migration from Magento or another B2B stack
- Horizon/native theme usage with limited custom design
- ROI-sensitive scoping where optional features must stay separate

### Custom App / Middleware / PCR

Use this pattern when the work resembles a middleware-led integration (a custom app or PCR project):
- write tighter scoped items with direct system language
- break build work into concrete integration capabilities and lifecycle states
- call out vendor/API dependencies and middleware ownership in assumptions
- separate out-of-scope platformization, additional payment methods, or future-state enhancements

Typical cues:
- Gadget or custom app foundation
- hosted flows, middleware orchestration, state management, or persistence
- SDK/API compatibility risk
- vendor-led system of record with Domaine orchestrating the workflow

## Houring Guidance

- Use references to calibrate directionally, not mechanically.
- QA and BSA should increase when complexity comes from workflow states, integration testing,
  data mapping, approvals, UAT support, or vendor coordination.
- Keep FED at zero when the scoped work is backend-only or operational.
- Keep BED at zero when the work is presentational only and does not introduce server-side logic.
- When a row is mostly configuration or alignment, keep engineering low and let assumptions carry
  the boundary.

## When To Split Rows

Split rows when:
- one-time foundation work would otherwise be double-counted
- optional scope is still pending business-rule confirmation
- native and custom approaches would materially change the estimate
- launch/UAT stabilization should be visible as its own effort
