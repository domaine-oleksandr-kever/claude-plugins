# Jira custom fields — discovery reference

Shared reference for every workflow that ingests a Jira ticket (the `write-technical-approach`,
`develop-feature-or-fix`, `qa-feature-or-fix`, `write-steps-to-test` and `create-pull-request` skills).
It documents how to locate the ticket fields the workflows depend on:

**Description · Acceptance Criteria · Assumptions · Technical Approach · Documentation Links · Steps to test**

## Why this is needed

The default `getJiraIssue` / `fetch` call (even with `responseContentFormat: "markdown"`) returns
only a **narrow default field set** — typically `summary`, `description`, `status`, `assignee`.
Acceptance Criteria, Assumptions, Technical Approach, Documentation Links, and Steps to test all
live in **custom fields** that must be **explicitly requested by ID**, or discovered (Step B).

## Step A — Known field IDs (meetdomaine site)

The verified ID table and the ready-to-paste request shape live in
**`jira-field-ids.md`** — their single home; do not copy them here or into skills/agents.

### Empty field vs. wrong ID — don't run discovery for an empty field

A `null` value does **not** mean the ID is wrong. Verified against the live API (ELC-61,
2026-05-30):

| Case                        | `names` map        | `fields` value | Meaning                        |
| --------------------------- | ------------------ | -------------- | ------------------------------ |
| Field exists, **filled**    | has the ID + label | ADF doc / text | use it                         |
| Field exists, **empty**     | has the ID + label | `null`         | genuinely empty - **leave it** |
| Field ID **does not exist** | **absent**         | **absent**     | wrong ID - go to **Step B**    |

(An unknown custom-field ID is **silently dropped** from both `names` and `fields` — no error is
raised, so "absent from `names`" is the signal, not a failed request.)

So the decision rule:

- ID **present in the `names` map** → the ID is correct. A `null` value just means the field is
  empty on this ticket; **do not** fall through to Step B, just note it's empty.
- ID **missing from the `names` map** → the ID is wrong / not on this site → fall through to
  **Step B** to rediscover it.

> ⚠️ Note: an earlier version of the playbook mis-mapped Acceptance Criteria onto the Assumptions
> field id. Take both ids from the `jira-field-ids.md` table, never from memory.

### Are these IDs the same in every project?

**Within one Atlassian site, yes.** Custom-field IDs are **global to the site** (`cloudId`), not
per-project — so these IDs hold for every project on `meetdomaine.atlassian.net` (ELC and others).
But:

- A **different Atlassian site / space has completely different IDs** — never assume these IDs
  there.
- A project may simply **not expose a given field** on its screens, so it returns `null` even
  though the ID is valid.

In both cases, fall through to Step B to resolve the live IDs.

## Step B — Discovery fallback (when Step A is null/missing or you're on a new site)

This was verified working — it's the source of the `jira-field-ids.md` table.

1. Call `getJiraIssue` on a representative ticket with the required **`cloudId`** (the site
   host, e.g. `meetdomaine.atlassian.net` — cloudId resolution: `jira-field-ids.md`),
   **`expand: "names"`**, and either `fields: ["*all"]` or a broad custom-field range:

   ```
   cloudId: "<site host or UUID>", issueIdOrKey: "<KEY>",
   fields: ["*all"], expand: "names"
   // or, to keep the response smaller:
   fields: ["customfield_10030", ..., "customfield_10060"], expand: "names"
   ```

2. The response includes a **`names` map** of `fieldId → human-readable label` (e.g.
   `"customfield_XXXXX": "Acceptance Criteria"`). Scan it for the labels you need
   ("Acceptance Criteria", "Assumptions", "Technical Approach", "Documentation Links",
   "Steps to test") to resolve the live IDs.

3. Cross-check the `fields` values: AC / Assumptions / TA / Documentation Links are rich-text
   (ADF) fields; a `null` value means the field is empty on that ticket, not that the ID is wrong.

4. Reuse the resolved IDs for the rest of the session.

5. **If a resolved ID differs from the `jira-field-ids.md` table (and you're on
   `meetdomaine`), report it** — `field_id_mismatch: <old> → <new>` in your result; the
   main session offers the `report-plugin-issue` skill. The IDs are site-wide, so fixing the
   table once spares every workflow from re-running discovery. Only edit on confirmation.

> Tip: `fields: ["*all"]` can return a very large response. If your tooling truncates it, save the
> result to a file and grep the `names` map for the labels rather than reading the whole payload.

## Parsing ADF responses — markdown when given, decode when not

Always request `responseContentFormat: "markdown"`. Then decide **per field** by the value's shape:

- **Already a string / markdown** → use it as-is. This is what `description` and `comment` return
  under `markdown` format.
- **Still raw ADF** (a JSON object with `type: "doc"`) → **decode it with the bundled converter**.
  The markdown conversion does **not** apply to rich-text **custom** fields — Acceptance Criteria,
  Assumptions, Technical Approach, Steps to test, Documentation Links come back as raw ADF even
  under `markdown` format (verified on ELC-126). Don't hand-walk the JSON; substitute the
  plugin root — the plugin's own directory — for the placeholder below
  (on Claude Code the session context opens with `fnd plugin root: <absolute path>` — write that
  path into commands; the Bash tool's shell does not set `${CLAUDE_PLUGIN_ROOT}`, so a literal one
  expands to empty):

  ```bash
  node <plugin root>/scripts/adf-to-md.cjs <issue.json> --field <customfield_id>
  ```

  Save the getJiraIssue response to a temp file and decode each ADF field with `--field`; it prints
  clean markdown (headings, bold/italic/code/links, lists, code blocks, blockquotes, tables) —
  deterministic decoding where hand-walking drops marks and links. (An inline MCP response is
  already in context either way; only when the harness saved the response to a file does the raw
  ADF stay out entirely.) `adf-to-md.cjs` is the inverse of `md-to-adf.cjs` (used on
  the write side). A field that is `null` is genuinely empty — report it empty, don't decode.

## Writing to a custom field

The write side (converter usage, ADF compactness rules, `editJiraIssue` call shape) lives
in **`jira-adf-write.md`** — writer skills read that file, not this one.

## Fallback — Atlassian MCP unavailable

If Atlassian MCP tool calls fail ("server does not exist") or Jira is not reachable without auth,
ask the Developer to paste into the thread: issue **summary**, **description**, **Acceptance
Criteria**, **Technical Approach**, and any linked issue keys. Unauthenticated HTTP/curl to
`*.atlassian.net/browse/...` returns the SPA shell, not issue fields.

## When to update this file

This is a **manual** maintenance note — nothing here re-runs by itself; the
`jira-field-ids.md` table is only as current as the last time someone updated it. The
Step B discovery is the live source of truth when in doubt. Update that table by hand when:

- A field is renamed or added, or the agent reports `field_id_mismatch` (run Step B, then
  paste the corrected IDs into `jira-field-ids.md`).
- You're targeting a **different Atlassian site** — those IDs differ, so document them
  separately rather than overwriting the meetdomaine table.

Keep in lockstep with the skills that link here.
