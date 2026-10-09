# Complexity Framework

Domaine rates every estimator line item Low / Medium / High complexity. The rating drives the hour
multiplier, so an under-rated line under-scopes the work twice — once in the hours and once in the
buffer. Under-rating is the most common underscoping pattern, especially on custom and
integration-heavy work.

Canonical source:
[Estimation, Assumptions, Complexity](https://www.notion.so/meetdomaine/Estimation-Assumptions-Complexity-77bc4e4269c341339c8a977ffe1f4bd2).
Check the Notion page if a line item doesn't clearly map to the guidance below — this file is a
working summary, not the authority. If a user says the framework changed, re-fetch the page through
base's notion MCP (`notion-fetch`), review against the fresh text, and tell the user this file in the
pm plugin needs the update.

## The core principle

**Complexity is about risk and unknowns, not hours.**

A hard-coded landing page can be 8–13 hours and still Low complexity — the work is well understood,
the failure modes are visible, and nothing outside the team's control can break it. A small UI
element rendering data from an external API can be 3–5 hours and still Medium, because an external
service can change, rate-limit, or return something unexpected.

When you catch yourself justifying a Low rating with "it's only a few hours," that's the signal
you're rating the wrong thing.

## High

Rate High when any of these are true:

- Custom checkout extensions.
- Custom add-to-cart behavior.
- Product bundles with dynamic pricing.
- Anything cart-, checkout-, or revenue-impacting. Close to absolute — a bug here loses money
  directly, so the testing burden alone justifies High.
- Work requiring both Front-End and Back-End code. The coordination cost and the surface area for
  integration bugs are what's being priced.
- Complex integrations with external APIs — anything with auth, pagination, rate limits, webhooks,
  or bidirectional sync.
- Debugging of complex or intermittent issues, especially in inherited code.
- First-time use of a new Shopify feature. Nobody on the team has hit the edge cases yet.
- Custom Backend integrations: ERP, OMS, PIM, custom customer portals, custom auth.

## Medium

Rate Medium when:

- A section fetches data from a third-party API — even a small one. External dependency is the
  trigger.
- Performance work involving heavy scripts or large image payloads.
- Responsive product cards or similar components with custom functionality beyond layout.
- Browser- or device-specific bug work.
- Anything depending on an external service, even when the build itself is small.
- Non-trivial data transformation or mapping between systems.

## Low

Rate Low when:

- Building a section from approved designs, even at 8–13 hours, where the pattern is established.
- CSS and styling updates.
- Code refactoring with no behavior change.
- Non-critical bug fixes with a known cause.
- Adding a configuration option that doesn't change functionality.
- Content and copy updates.

## Review screen — three questions per line item

Fastest way to catch under-rating:

1. **Does it touch cart, checkout, or payment?** If yes and it isn't High, that's a finding.
2. **Does it need both FE and BE code?** If yes and it's rated Low or Medium, that's a finding.
3. **Does it depend on anything outside our control** — an external API, a third-party app, a
   client system, a Shopify feature nobody's shipped yet? If yes and it's Low, that's a finding.

## Patterns that get sent back in review

- A custom integration line rated Low because the *Domaine-side* work is small, ignoring the
  unknowns on the client's system.
- Checkout or cart work rated Medium to keep the phase total down.
- A first-use-of-a-new-Shopify-feature line rated by hours rather than by unfamiliarity.
- A batch of sections all rated Low when two or three of them pull third-party data.
- Migration lines rated Low because the record count is small, when the data quality is unknown.
