# Common Shopify Limitations & Workarounds

Rows checked against Admin API 2026-07 (and the Functions, theme and checkout docs of that release) on 2026-10-10 through the Shopify Dev MCP. A row marked *(unverified)* states Domaine experience the docs do not cover.

## Checkout Limitations

| Limitation | Workaround |
|---|---|
| checkout.liquid is shut down: Information, Shipping and Payment steps first, Thank you and Order status pages on 2025-08-28 | Checkout extensibility: UI extensions, Functions, branding API |
| Checkout UI extensions on the Information, Shipping and Payment steps need Plus; Thank you and Order status extensions run on every plan but Starter | Non-Plus: put the feature on Thank you / Order status, or in cart before checkout |
| Only one app's post-purchase page per store (the merchant picks it); one page per extension, at most 3 accepted offers | Combine upsell and survey logic into a single extension; paginate inside its one page |
| No custom HTML/CSS in checkout *(unverified)* | Checkout UI extension components; branding API for visual customization |
| Limited checkout UI components, no DOM access *(unverified)* | Work within the sandboxed component library and its APIs; request new components through Shopify partner feedback |

## Function Limitations

| Limitation | Workaround |
|---|---|
| Custom apps with Functions need Plus; public App Store apps with Functions run on every plan | Plan the distribution model with the merchant's plan in scope |
| No network access; fetch targets exist only for custom apps on Shopify for enterprises (pickup point generator: Plus custom apps), enabled by Shopify on request | Pre-compute data into metafields or cart attributes before checkout |
| No clock or randomness in function code | Query `localTime` in the input (`date`, `dateTimeBefore` / `After` / `Between`, `timeBefore` / `After`); keep date windows in metafields |
| Bundles can't be sold with selling plans (subscriptions, pre-orders, try before you buy) | Don't bundle subscription items; handle subscriptions separately |
| One Cart Transform function per app per store (every app's runs); `lineUpdate` operations need Plus or a dev store | Combine all transform logic into one function with conditional paths |
| 11 million instructions, 128 kB input, 20 kB output for carts up to 200 lines (scaled above); 256 kB compiled binary | Rust, small input queries, few allocations; no bulk price changes across every line |
| 25 active automatic app (Function) discounts per store | Consolidate discount rules into fewer, configurable functions |
| Tags not directly fetchable in input queries | `hasAnyTag()` / `hasTags()`, or metafields, for tag-based logic |

## Metafield & Data Limitations

| Limitation | Workaround |
|---|---|
| Metafield value size: most types 64 KB, `json` 128 KB (apps using JSON fields before 2026-04-01 keep 2 MB), `id` and `url` 2 KB; a Function's input gets `null` for a value over 10,000 bytes | Split data across metafields, use metaobject references, Files API for large content |
| 256 definitions per resource type per app; TOML-declared: 128 per owner type, 25 changes per deploy | Plan namespace/key structure carefully; reuse definitions where possible |
| TOML (declarative) definitions are read-only through the Admin API | Update via `shopify.app.toml` + redeploy; runtime changes need GraphQL-created definitions |
| The metaobject `onlineStore` capability is not supported in TOML | GraphQL `metaobjectDefinitionCreate` / `Update` for metaobjects that need an Online Store template and URL |
| A metafield can't be migrated to type `id` | Plan type selection carefully at definition time |

## Theme Limitations

| Limitation | Workaround |
|---|---|
| 256 KB per Liquid file (sections, snippets, layouts, blocks); JSON templates 512 KB; `settings_data.json` 1.5 MB | Break large sections into snippets |
| No server-side computation in Liquid | An app proxy (one proxy route per app) for server logic; pre-compute values in metafields |
| 25 sections per JSON template and per section group; 50 blocks per section | Consolidate related content into fewer sections with more blocks |
| Section rendering API only works with sections *(unverified)* | Structure pages using sections for all dynamic content |
| Cannot query the Admin API from Liquid *(unverified)* | Metafields for pre-fetched data; app blocks for live data |
| Theme app extension CSS isolation *(unverified)* | Use `!important` sparingly; work within the cascade; test across themes |

## API & Rate Limits

| Limitation | Workaround |
|---|---|
| GraphQL Admin: cost-based bucket restoring 100 points/s (Advanced 200, Plus 1,000, enterprise 2,000); one query at most 1,000 points; input arrays at most 250 items | Request fewer fields, cache responses, bulk operations for large exports |
| REST Admin (legacy since 2024-10-01): 40-request bucket leaking 2/s (Plus: 400, 20/s) | New work on GraphQL; exponential backoff on 429 |
| Webhook at-least-once delivery | Process idempotently (check IDs before processing) |
| Failed webhooks retried 8 times over 4 hours, then an Admin-API-created subscription is removed; a response must come within 5 s | Answer 2xx at once and queue the work; TOML (app-specific) subscriptions; a reconciliation job for missed data |
| Storefront API: buyer traffic not rate-limited, checkout creation throttled per minute, tokenless queries at most 1,000 complexity | Cache responses aggressively; backoff on a `Throttled` answer |
| Bulk operations finish asynchronously | Subscribe to `bulk_operations/finish`, or poll the operation with backoff |

## Integration Limitations

| Limitation | Workaround |
|---|---|
| No native CRON/scheduling *(unverified)* | External scheduler (GitHub Actions, AWS EventBridge) calling the app's endpoints |
| No native message queues *(unverified)* | Shopify Flow for simple orchestration; external queues for complex workflows |
| Shopify hosts no app backend or database (Oxygen hosts Hydrogen storefronts, not apps) *(unverified)* | Metafields/metaobjects for store-bound data; the app's own hosting and database for the rest |
| Multi-store management limited *(unverified)* | Organization-level APIs where available; multi-tenant app architecture |
| POS has limited extension surfaces *(unverified)* | Check POS UI extension compatibility; not all Admin/Checkout extensions work in POS |

## B2B Limitations

| Limitation | Workaround |
|---|---|
| Payment terms: set per company location, not in accelerated checkouts, incompatible with subscriptions (a payment customization Function can't set terms on a cart with a subscription selling plan) | Terms on the location (`companyLocationUpdate`); subscription items in a separate order |
| Company metafields limited surface *(unverified)* | Admin metafield pins to make them visible; an admin UI extension for complex B2B data |

## Escalation

When a limitation has no workaround:
1. Document the limitation clearly in project scope
2. File a feature request via Shopify Partner Dashboard
3. Check if the merchant's Plus rep can escalate internally
4. Monitor Shopify changelog for upcoming features
5. Post on [community.shopify.dev](https://community.shopify.dev) for community-sourced workarounds
