# Jira custom fields — discovery reference

Shared reference for every workflow that ingests a Jira ticket (`base:jira-reader`, and a team
plugin's skills — `/fe:write-technical-approach`, `/fe:develop-feature-or-fix`, …).
It documents how to locate the ticket fields the workflows depend on:

**Description · Acceptance Criteria · Assumptions · Technical Approach · Documentation Links · Steps to test**

## Why this is needed

The default `getJiraIssue` call (even with `responseContentFormat: "markdown"`) returns
only a **narrow default field set** — typically `summary`, `description`, `status`, `assignee`.
Acceptance Criteria, Assumptions, Technical Approach, Documentation Links, and Steps to test all
live in **custom fields** that must be **explicitly requested by ID**, or discovered (Step B).

## Step A — Known field IDs (meetdomaine site)

The verified ID table and the ready-to-paste request shape live in
**`jira-field-ids.md`** — their single home; do not copy them here or into skills/agents.

### Empty field vs. wrong ID — don't run discovery for an empty field

A field with no value does **not** mean the ID is wrong. On the Atlassian MCP v2 every requested
custom field comes back under `fields.customFields` (measured 2026-11-12, ELC-1864):

| Case                        | `customFields` entry                              | Meaning                        |
| --------------------------- | ------------------------------------------------- | ------------------------------ |
| Field exists, **filled**    | keyed by the field name, `{ "id", "value" }`      | use it                         |
| Field exists, **empty**     | keyed by the field name, `{ "id" }` (no `value`)  | genuinely empty - **leave it** |
| Field ID **does not exist** | keyed by the **raw id**, `{ "id" }`               | wrong ID - go to **Step B**    |

(An unknown custom-field ID raises no error: "keyed by its own id, no name resolved" is the signal,
not a failed request.)

So the decision rule:

- ID keyed **by its field name** → the ID is correct. No `value` just means the field is empty on
  this ticket; **do not** fall through to Step B, just note it's empty.
- ID keyed **by itself** → the ID is wrong / not on this site → fall through to **Step B** to
  rediscover it.

> ⚠️ Note: an earlier version of the playbook mis-mapped Acceptance Criteria onto the Assumptions
> field id. Take both ids from the `jira-field-ids.md` table, never from memory.

### Are these IDs the same in every project?

**Within one Atlassian site, yes.** Custom-field IDs are **global to the site** (`cloudId`), not
per-project — so these IDs hold for every project on `meetdomaine.atlassian.net` (ELC and others).
But:

- A **different Atlassian site / space has completely different IDs** — never assume these IDs
  there.
- A project may simply **not expose a given field** on its screens, so it comes back with no value even
  though the ID is valid.

In both cases, fall through to Step B to resolve the live IDs.

## Step B — Discovery fallback (when Step A is null/missing or you're on a new site)

This was verified working — it's the source of the `jira-field-ids.md` table.

1. Call `getJiraIssue` on a representative ticket with the required **`cloudId`** (the site
   host, e.g. `meetdomaine.atlassian.net` — cloudId resolution: `jira-field-ids.md`) and either
   `view: "evidence"` (fetches and maps every custom field) or a broad custom-field range:

   ```
   cloudId: "<site host or UUID>", issueIdOrKey: "<KEY>", view: "evidence"
   // or, to keep the response smaller:
   fields: ["customfield_10030", ..., "customfield_10060"]
   ```

2. The response's `fields.customFields` maps each field's **name** to `{ "id", "value" }` (e.g.
   `"Acceptance Criteria": { "id": "customfield_XXXXX", … }`). Scan it for the names you need
   ("Acceptance Criteria", "Assumptions", "Technical Approach", "Documentation Links",
   "Steps to test") to resolve the live IDs; an entry keyed by its raw id is not a field here.

3. Cross-check the values: AC / Assumptions / TA / Documentation Links are rich-text fields (a
   markdown string, or HTML when the response says `appliedContentFormat: "html"`); no `value`
   means the field is empty on that ticket, not that the ID is wrong.

4. Reuse the resolved IDs for the rest of the session.

5. **If a resolved ID differs from the `jira-field-ids.md` table (and you're on
   `meetdomaine`), report it** — `field_id_mismatch: <old> → <new>` in your result; the
   main session offers `/base:report-plugin-issue`. The IDs are site-wide, so fixing the
   table once spares every workflow from re-running discovery. Only edit on confirmation.

> Tip: `view: "evidence"` returns a large response, which slim compresses or stubs. Narrow the
> original it names to the map you need rather than reading the whole payload. A stub's `full=`
> file is the bare JSON — `mcp__slim__view({ path: "<that file>", jq: ".data.fields.customFields" })`
> works on it. A compressed result's `<<full=… original_result>>` file is the MCP content-block
> array, which `view`'s `jq` cannot step into — unwrap it in Bash:
> `jq -c '(if type=="array" then .[0].text|fromjson elif .content then .content[0].text|fromjson else . end) | (.data // .) | .fields.customFields | map_values(.id)' <that file>` (the same line reads a stub's file too).

## Reading rich-text values — markdown, HTML when the server says so

Always request `responseContentFormat: "markdown"`. Then decide by the response:

- `appliedContentFormat: "markdown"` → every rich-text value (description, AC, Assumptions, TA,
  Steps to test, Documentation Links) is a markdown string: use it as-is. This is what
  `getJiraIssue` returned in every measured case (2026-11-12), an inline image included
  (`![](blob:https://media…&id=<media id>&…)`, the media id only).
- `appliedContentFormat: "html"` (with a `warning`) → a fallback, not a measured `getJiraIssue`
  behaviour (the measured whole-page HTML switch is `listJiraIssueComments`', on an @mention,
  media, a panel or a status): compact each value to markdown as `base:jira-reader` does its HTML
  comment bodies (its prompt → Read the comments → HTML bodies).
- A raw ADF object (`type: "doc"`) comes only from a server still on Atlassian's v1: read its text
  and link nodes directly.

No converter script runs on the read side.

## Writing to a custom field

The write side (the markdown call shapes, the empty-source rule, the read-back check) lives in
**`jira-write.md`** — writer skills read that file, not this one.

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
