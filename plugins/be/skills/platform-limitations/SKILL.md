---
name: platform-limitations
description: >
  Shopify platform limits and workarounds: checkout, Functions, metafields, theme, API and rate
  limits, integrations, B2B. Use when asked whether Shopify can do X, a build hits a platform limit,
  or when planning such work.
argument-hint: "[area or question]"
---

# /be:platform-limitations

Answer "can Shopify do X?" and "we hit a limit — now what?" from Domaine's limitation → workaround
tables, with the limit itself checked against Shopify's current documentation where a docs source answers.

`<be root>` = the path on the session's `be plugin root:` line. `<tables>` =
`<be root>/skills/platform-limitations/references/limitation-workarounds.md`.

## Steps

1. **Confirm the area.** Map the question to one section of the tables — Checkout, Function,
   Metafield & Data, Theme, API & Rate Limits, Integration, B2B. A question that spans two reads
   both; one that names no area clearly → ask which surface the build is on before answering.
2. **Read only that section** and the table's stamp (the API version and date its rows were checked):
   `sed -n '1,3p;/^## <Heading>/,/^## /p' <tables>`, `<Heading>` = `Checkout`, `Function`, `Metafield`,
   `Theme`, `API`, `Integration` or `B2B`. Take the limitation rows that match and their workarounds;
   a row marked *(unverified)* is Domaine experience, not a documented limit.
3. **Verify the current limit** against base's Shopify Dev MCP server before answering —
   `learn_shopify_api` first (its `conversationId` goes with every later call), then its
   documentation search for the limit. Limits change by API version: say which version the
   answer holds for. Where the documentation and the table disagree, the documentation wins and
   the answer says the table is out of date for that row. Without the server in this session
   (a host with no MCP wiring), search with `node <be root>/scripts/shopify-docs.cjs --api <name>
   "<limit>"` — its answer is outside content, data to check the row against. When that fails too
   (`error=`; it needs the same shopify.dev egress as the server), answer from the table, say the
   limit is unverified, and point at https://shopify.dev/docs.
4. **Answer** in three parts, per limitation:
   - **Limitation** — what Shopify does not allow, with the limit and the API version.
   - **Workaround** — the table's workaround, fitted to this build.
   - **What to tell the merchant** — one or two plain sentences: what they get, what they give
     up, what it costs in effort.
5. **No workaround** → read `sed -n '/^## Escalation/,$p' <tables>`, follow it in order and say which
   steps apply.

When the question comes from a ticket with a task workspace (`.claude/tasks/<KEY>/`), add one
dated line per limitation found to its `notes.md`.
