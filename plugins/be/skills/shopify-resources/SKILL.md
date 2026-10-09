---
name: shopify-resources
description: >
  Guide for when and how to use Shopify's official resources and documentation.
  Use when the user asks where to find Shopify documentation, how to look up API references,
  where to get help with Shopify issues, or when deciding between different Shopify information sources.
---

# Shopify Resources

Guide for using Shopify's official documentation, community forums, and connected tools effectively.

## Resource Hierarchy

When answering Shopify questions, consult sources in this priority order:

### 1. Shopify Dev MCP (When Connected)

If base's Shopify Dev MCP server is connected (`/be-doctor` shows whether base declares it), prefer it for:
- Admin GraphQL API schema and queries
- Storefront API documentation
- Shopify Functions API reference
- Liquid objects, filters, and tags
- Shopify CLI commands and usage
- Extension API references

The Dev MCP provides real-time, authoritative documentation directly from shopify.dev. Always try it first for API and implementation questions, starting with `learn_shopify_api` (its `conversationId` goes with every later call).

### 2. Shopify Dev Docs -- https://shopify.dev/docs

The primary developer documentation. Use for:
- API references (Admin, Storefront, Partner)
- App development guides
- Theme development guides
- Functions and extensions documentation
- CLI reference
- Webhook topics and payloads
- Authentication and OAuth guides

### 3. Shopify Help Center -- https://help.shopify.com/en

Merchant-facing documentation. Use for:
- Store setup and configuration
- Shopify admin feature explanations
- Discount configuration and combination rules
- Shipping and fulfillment setup
- Payment provider documentation
- Plan features and limitations
- SEO and marketing features

### 4. Shopify Developer Community -- https://community.shopify.dev/

Developer-focused forum. Use for:
- API troubleshooting and known issues
- Extension development questions
- Workarounds for platform limitations
- Community-discovered bugs and fixes
- Feature requests and roadmap discussions

### 5. Shopify Community -- https://community.shopify.com/

General merchant and developer community. Use for:
- Store design and UX discussions
- App recommendations and reviews
- Theme customization help
- General Shopify troubleshooting
- Business and marketing strategies

## When to Use Each Resource

| Question Type | Best Resource |
|---|---|
| "How do I use this API endpoint?" | Dev MCP > shopify.dev/docs |
| "How does a merchant configure X?" | help.shopify.com |
| "Is this a known bug?" | community.shopify.dev |
| "What's the best app for Y?" | community.shopify.com |
| "How does discount stacking work?" | help.shopify.com > shopify.dev/docs |
| "What's the GraphQL mutation for Z?" | Dev MCP > shopify.dev/docs |
| "How do I set up a theme section?" | shopify.dev/docs |
| "What are the checkout extensibility targets?" | Dev MCP > shopify.dev/docs |

## Domaine's Own Sources

- **Jira and Confluence** (tickets, sprint planning, runbooks, implementation plans, handoff documents, architecture decision records): through base's Atlassian MCP server — a ticket or epic via `base:jira-reader`, a Confluence page via `base:doc-reader`.
- **Notion** (project notes, meeting notes, knowledge base): through base's Notion MCP server — a page via `base:doc-reader`.

## Staying Current

- **Shopify Changelog** (https://shopify.dev/changelog) -- API version updates, deprecations, new features
- **Shopify Editions** -- bi-annual major feature announcements
- **API versioning** -- Shopify releases quarterly API versions; deprecated versions are removed after ~12 months
- **Partner blog** (https://www.shopify.com/partners/blog) -- best practices, case studies, platform updates

## Cross-references

- See `/be:platform-limitations` for limitation workarounds and escalation paths
- See `/be:app-scope` for scoping an app or extension build with an LOE estimate
