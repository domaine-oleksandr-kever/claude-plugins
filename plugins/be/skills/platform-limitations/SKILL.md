---
name: platform-limitations
description: >
  Common Shopify platform limitations and their workarounds — checkout, Functions, metafields and
  data, theme, API and rate limits, integrations, B2B — checked against the current API version.
  Use when asked whether Shopify can do X, when a build hits a platform limit, or when planning
  checkout, Functions, metafields, theme, API or integration work.
argument-hint: "[area or question]"
---

# /be:platform-limitations

Answer "can Shopify do X?" and "we hit a limit — now what?" from Domaine's limitation → workaround
tables, with the limit itself checked against Shopify's current documentation.

`<be root>` = the path on the session's `be plugin root:` line. The tables:
`<be root>/skills/platform-limitations/references/limitation-workarounds.md`.

## Steps

1. **Confirm the area.** Map the question to one section of the tables — Checkout, Function,
   Metafield & Data, Theme, API & Rate Limits, Integration, B2B. A question that spans two reads
   both; one that names no area clearly → ask which surface the build is on before answering.
2. **Read the table** for that area: the limitation rows that match, and their workarounds.
3. **Verify the current limit** against base's Shopify Dev MCP server before answering —
   `learn_shopify_api` first (its `conversationId` goes with every later call), then its
   documentation search for the limit. Limits change by API version: say which version the
   answer holds for. Where the documentation and the table disagree, the documentation wins and
   the answer says the table is out of date for that row. Without the server in this session,
   answer from the table, say the limit is unverified, and point at https://shopify.dev/docs.
4. **Answer** in three parts, per limitation:
   - **Limitation** — what Shopify does not allow, with the limit and the API version.
   - **Workaround** — the table's workaround, fitted to this build.
   - **What to tell the merchant** — one or two plain sentences: what they get, what they give
     up, what it costs in effort.
5. **No workaround** → follow the table's Escalation section in order and say which steps apply.

When the question comes from a ticket with a task workspace (`.claude/tasks/<KEY>/`), add one
dated line per limitation found to its `notes.md`.
