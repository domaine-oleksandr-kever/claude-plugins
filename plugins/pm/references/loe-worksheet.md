# LOE Estimation Worksheet

## Estimation Process

1. Break the project into discrete components
2. Classify each component by complexity
3. Apply the baseline LOE range
4. Add buffers for QA, edge cases, and review cycles
5. Sum for total project estimate

## Component LOE Baselines

### Theme Work

| Component | Low | Medium | High |
|---|---|---|---|
| Simple static section | 2h | 4h | 8h |
| Dynamic section (metafields, API) | 8h | 16h | 24h |
| Complex interactive section (JS) | 16h | 24h | 40h |
| Header/navigation redesign | 16h | 32h | 56h |
| PDP customization | 8h | 24h | 40h |
| Collection page with filters | 16h | 32h | 56h |
| Cart drawer/page redesign | 8h | 16h | 32h |
| Global site-wide changes | 8h | 16h | 32h |

### Shopify Functions

| Component | Low | Medium | High |
|---|---|---|---|
| Simple discount (threshold) | 16h | 24h | 40h |
| Complex discount (stacking/tiered) | 32h | 56h | 80h |
| Cart Transform (basic bundle) | 16h | 32h | 56h |
| Cart Transform (complex + tamper protection) | 40h | 64h | 80h |
| Delivery customization | 16h | 24h | 40h |
| Payment customization | 16h | 24h | 40h |
| Checkout validation | 16h | 24h | 40h |

### Checkout Extensions

| Component | Low | Medium | High |
|---|---|---|---|
| Simple info banner | 4h | 8h | 16h |
| Form with validation | 16h | 24h | 40h |
| Multi-step extension | 24h | 40h | 64h |
| Post-purchase upsell | 24h | 40h | 64h |
| Checkout branding setup | 4h | 8h | 16h |

### App Development

| Component | Low | Medium | High |
|---|---|---|---|
| Basic app (admin UI only) | 40h | 64h | 80h |
| App with extensions | 64h | 120h | 200h |
| App with webhooks + sync | 40h | 80h | 120h |
| Flow trigger/action extension | 16h | 24h | 40h |

### Integrations

| Component | Low | Medium | High |
|---|---|---|---|
| Simple webhook listener | 8h | 16h | 24h |
| One-way data sync | 16h | 32h | 56h |
| Bidirectional sync | 40h | 80h | 120h |
| ERP/PIM integration | 80h | 160h | 240h |

### Headless / Hydrogen

| Component | Low | Medium | High |
|---|---|---|---|
| Basic storefront (catalog + cart) | 80h | 120h | 160h |
| Full storefront (accounts, search, etc.) | 160h | 240h | 400h |
| Headless content pages | 24h | 40h | 80h |

## Complexity Factors

Rate each factor. More "High" ratings = higher end of LOE range.

| Factor | Low | Medium | High |
|---|---|---|---|
| Requirements clarity | Well-defined | Some gaps | Ambiguous/evolving |
| Third-party dependencies | None | One system | Multiple systems |
| Data complexity | Simple fields | Nested/relational | Complex modeling |
| Edge case density | Few | Moderate | Many |
| Mobile/responsive needs | Standard | Custom breakpoints | Unique mobile UX |
| Accessibility requirements | Basic compliance | Full WCAG 2.2 AA | WCAG AAA |
| Translation/markets | Single locale | 2-3 markets | 10+ markets |
| Existing technical debt | Clean codebase | Some issues | Heavy debt |

## Buffer Guidelines

| Buffer Type | Percentage | When to Apply |
|---|---|---|
| QA & testing | 20-30% | Always |
| Edge case handling | 10-20% | Complex logic |
| Merchant review cycles | 10-15% | Client-facing work |
| Platform unknowns | 10-15% | New API features, beta features |
| Integration testing | 15-25% | Third-party integrations |

## Example Estimate

| Component | Base | Complexity | Buffer | Total |
|---|---|---|---|---|
| Cart Transform (bundle) | 32h | Medium | +25% QA | 40h |
| Discount Function (tiered) | 40h | High | +30% QA + edge | 52h |
| Checkout UI (gift message) | 16h | Low | +20% QA | 20h |
| Theme sections (3x dynamic) | 48h | Medium | +25% QA | 60h |
| **Project Total** | | | | **172h** |
