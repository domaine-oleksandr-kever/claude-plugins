# Common Shopify Limitations & Workarounds

## Checkout Limitations

| Limitation | Workaround |
|---|---|
| No custom HTML/CSS in checkout | Use checkout UI extensions for custom components; use branding API for visual customization |
| Checkout.liquid deprecated | Migrate to checkout extensibility (UI extensions + functions + branding) |
| One post-purchase extension per checkout | Combine upsell/survey logic into a single extension |
| Limited checkout UI components | Work within the sandboxed component library; request new components via Shopify partner feedback |
| No DOM access in extensions | Use provided hooks and components; store state in extension storage |

## Function Limitations

| Limitation | Workaround |
|---|---|
| No network access in functions | Pre-compute data and store in metafields; use fetch targets (Enterprise only) |
| No date/time access | Store timestamps in metafields or cart attributes; compute relative dates server-side |
| Cart Transform + selling plans incompatible | Don't bundle subscription items; handle subscriptions separately |
| One Cart Transform per app | Combine all transform logic into a single function with conditional paths |
| CPU instruction limits | Optimize code, minimize allocations, use Rust for performance-critical functions |
| 25 automatic discount limit | Consolidate discount rules into fewer, more flexible functions |
| Tags not directly fetchable in input queries | Use `hasAnyTag()` or metafields to pass tag-based logic |

## Metafield & Data Limitations

| Limitation | Workaround |
|---|---|
| 16KB metafield value limit (API 2026-04+) | Split data across multiple metafields, use metaobject references, use Files API for large content |
| 256 definitions per owner type per app | Plan namespace/key structure carefully; reuse definitions where possible |
| TOML definitions are read-only via API | Update via `shopify.app.toml` + redeploy; accept that runtime changes need GraphQL-created definitions |
| Online Store capability not in TOML | Use GraphQL `metaobjectDefinitionCreate` for metaobjects that need theme templates |
| Metafield type cannot be changed to `id` | Plan type selection carefully at definition time |

See base's **Shopify Dev MCP** server for metafield limits and data type reference.

## Theme Limitations

| Limitation | Workaround |
|---|---|
| 256KB per Liquid file | Break large sections into snippets |
| No server-side computation in Liquid | Use app proxy (Hydrox) for server logic; pre-compute values in metafields |
| Section rendering API only works with sections | Structure pages using sections for all dynamic content |
| 50 section limit per template | Consolidate related content into fewer sections with more blocks |
| Cannot query Admin API from Liquid | Use metafields for pre-fetched data; use app blocks for live data |
| Theme app extension CSS isolation | Use `!important` sparingly; work within cascade; test across themes |

## API & Rate Limits

| Limitation | Workaround |
|---|---|
| GraphQL 2,000-point bucket | Batch requests, cache responses, use bulk operations for large exports |
| REST 40 req/s limit | Migrate to GraphQL; implement exponential backoff |
| Webhook at-least-once delivery | Process idempotently (check order IDs before processing) |
| Webhook 48hr retry window | Monitor delivery health; implement dead letter queue for critical events |
| Storefront API rate limits | Cache responses aggressively; use ISR/SSG where possible |
| Bulk operations poll-based | Implement polling with exponential backoff; use webhooks for completion notification |

## Integration Limitations

| Limitation | Workaround |
|---|---|
| No native CRON/scheduling | Use external scheduler (GitHub Actions, AWS EventBridge) calling your app endpoints |
| No native message queues | Use Shopify Flow for simple orchestration; external queues for complex workflows |
| No native database in apps on Oxygen | Use Shopify metafields/metaobjects as data store; or use external DB (Turso, PlanetScale) |
| Multi-store management limited | Use Organization-level APIs where available; build multi-tenant app architecture |
| POS has limited extension surfaces | Check POS UI extension compatibility; not all Admin/Checkout extensions work in POS |

## B2B Limitations

| Limitation | Workaround |
|---|---|
| Payment terms per-order only | Document clearly for merchants; terms don't change customer default |
| No subscription + payment terms combo | Choose one or the other per order |
| Company metafields limited surface | Use admin metafield pins to make them visible; build admin UI extension for complex B2B data |

## Escalation

When a limitation has no workaround:
1. Document the limitation clearly in project scope
2. File a feature request via Shopify Partner Dashboard
3. Check if the merchant's Plus rep can escalate internally
4. Monitor Shopify changelog for upcoming features
5. Post on [community.shopify.dev](https://community.shopify.dev) for community-sourced workarounds
