# Reading linked docs — Notion & other external links

Shared reference for every workflow that ingests a Jira ticket (the `write-technical-approach`,
`develop-feature-or-fix`, `qa-feature-or-fix`, `write-steps-to-test` and
`create-pull-request` skills). A ticket is rarely
self-contained: it links out to **Notion** data-mapping / spec docs, **Figma** frames,
**Confluence** pages, Google docs, etc. Those links carry real scope (data models, copy, field
lists, edge cases). **Skipping them means planning against an incomplete picture.** So: read the
links, don't just collect them.

## 1 — Collect every link

From the `jira-reader` output use **`documentation_links`**, **`figma_urls`**, **`notion_urls`**,
and **`other_links`**, plus any inline links inside `description` / `acceptance_criteria` /
`technical_approach` (the `adf-to-md.cjs` decoder preserves inline-mark links **and** block-level
smart links — `inlineCard` / `blockCard` / `embedCard` — as `<url>`, so they survive into the
text). De-duplicate, then read **all** of them — not only the Notion ones.

**Reuse before fetching:** skip links whose content is already in this conversation **in full**
(not summarized or truncated away) from an earlier workflow run, and links with a **fresh**
task-workspace copy (`.claude/tasks/<work-id>/doc-*.md`, matched by `url` frontmatter —
freshness probe:
`<plugin root>/references/task-workspace-freshness.md` — **plugin root** = the plugin's own
directory, this file being `<plugin root>/references/reading-linked-docs.md`, and every
`<plugin root>/…` path below resolves the same way;
on Claude Code the session context opens with `fnd plugin root: <absolute path>` — write that path
into commands; the Bash tool's shell does not set `${CLAUDE_PLUGIN_ROOT}`, so a literal one expands
to empty).
Fetch only what's missing or stale.

## 2 — Read each link — delegate, in parallel

| Link | How to read |
| --- | --- |
| **Figma** (`figma.com`) | the `figma-reader` subagent (one per URL) — already part of the develop/QA flow. |
| **Jira** (`*.atlassian.net/browse/*`, or a bare ticket key) | already ingested by `jira-reader` — **never** spawn a `doc-reader` for one. `other_links` can contain them; skip. |
| **Everything else** — Notion, Confluence, Google docs, Shopify/3rd-party docs, articles | the **`doc-reader`** subagent — **one per link, spawned in parallel**. Brief: the URL, the task intent (what this task needs from the doc), and the workspace path (`.claude/tasks/<work-id>/`). It picks the tool (Notion MCP with sub-page follow-through / Atlassian MCP / `WebFetch`), writes the extract to `doc-<slug>-<hash>.md` itself, and returns it compactly. |

The raw pages stay in the readers' disposable contexts — the main loop receives only the
extracts: data mappings, field/property lists, copy, asset links, constraints — and (for
data-model docs) the metafield / metaobject schema, which feeds
`<plugin root>/references/metafield-metaobject-setup.md`. Read every returned
`conflicts` / `needs_clarification` field — an unreadable link or a doc-vs-ticket
contradiction surfaces to the developer, never silently drops. Reading a link inline via
the MCPs is the fallback, not the default — only for a **single** link whose MCP is
already open in this context and whose page is expected under a couple hundred lines; two
or more links, or any Notion doc with sub-pages, always delegate.

## 3 — Save what you read — the task workspace

`doc-reader` saves its own extract when briefed with the workspace path — always pass it.
When the readers return, check every `saved_to`: empty while you *did* pass a workspace
path means the save never landed (a denied `Write` in plan mode, say) — write the returned
extract to the workspace yourself before proceeding.
Only an inline read (the §2 fallback) saves manually: the **extract** (§2's "what the
task needs" — never the raw page) to `.claude/tasks/<work-id>/doc-<slug>-<hash>.md` — file format
and frontmatter: `<plugin root>/references/task-workspace.md`; freshness probes:
`task-workspace-freshness.md`. A cached extract that lacks something your task needs
isn't stale, it's incomplete — re-read the source.

## 4 — If the Notion MCP isn't configured

If the ticket has a Notion link but the **Notion MCP isn't connected** (a `doc-reader`
returns `needs_clarification` naming it, or inline tool calls fail), **do not silently
skip it** — Notion is usually where the data model and final copy live, so proceeding
blind risks building the wrong thing. **Stop and notify the developer:**

> "This ticket links Notion docs I can't read — the Notion MCP isn't connected: `<list the URLs>`.
> Either enable the Notion MCP (`/mcp`) and I'll read them, or paste the relevant content here."

Then wait. The same applies to any other link type whose tool is unavailable — name the
unreadable links and ask, rather than guessing.

## 5 — Rule of thumb

- **Read all links, every type** — Notion is mandatory, but Figma/Confluence/web links are too.
- **Notion is authoritative for data models & copy** — when it disagrees with the ticket body,
  surface the conflict to the developer instead of picking one silently.
- Treat what you read as first-class context alongside the AC — every plan/TA bullet should trace
  to the ticket **or** a linked doc.
