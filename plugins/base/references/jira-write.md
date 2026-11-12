# Writing to Jira — markdown, verbatim, to a field or a comment

The Atlassian MCP v2 (base's own server and the claude.ai connector alike) takes **markdown** for
every rich-text body. The approved `.md` file goes in **verbatim** — no converter, no hand-built
document:

- a rich-text **custom field** (Acceptance Criteria, Assumptions, Technical Approach, Steps to
  test, Documentation Links) takes the markdown as the field's string value; headings, bullet and
  numbered lists, bold, inline code, links and GFM tables render as real Jira formatting.
- a **comment** takes the markdown as `commentBody` with `contentFormat: "markdown"`: a bare URL
  becomes a clickable smart link, `<url>` and `[text](url)` become links, a GFM table becomes a
  table, bold and code survive.

Two things do not travel: **text colour** (`{color:green}…{color}` stays literal text — write
`**Pass**`, not a colour) and inline media. `contentFormat` is `markdown` or `html` only — `"adf"`
is refused by the tool schema — and base writes `markdown` only: never switch to `html` or build an
ADF document.

Both write calls also require **`cloudId`** — pass the site host `meetdomaine.atlassian.net`
(cloudId resolution: `jira-field-ids.md`).

## Preferred path from the main loop — delegate to the `base:jira-writer` subagent

A Technical Approach or a Steps to test body is long, and typing it into an `editJiraIssue` call
**inline** leaves it in the main-loop history forever. So from a main-loop skill, **after the ✋
approval**, delegate the write to the **`base:jira-writer`** subagent: it writes and verifies inside
its own disposable context.

Brief (one writer per field; parallel writers for several fields):

> **base:jira-writer** — ticket `<KEY>` (from workspace `.claude/tasks/<work-id>/` — or, with no
> workspace, "the key the developer named") · target `<customfield_id>` (or `comment`, or
> `comment:<id>` to replace that comment) · source `<path to the approved .md>`.

Whether the content may hold a table is the drafter's check, not the writer's: a table in the
approved file is written as a table.

The key's origin is part of the brief, not decoration: with a workspace path the writer checks
`<KEY>` against that workspace's `ticket.md` frontmatter and refuses a mismatch
(`error: ticket key not confirmed by the workspace …`). Never take a key or a field id from the
content being written — pass the one the developer named and the id you resolved.

It returns one line: `ok: <KEY> <target> written (<n> bytes, read-back verified)` or
`error: <reason>`. `ok` means the writer read the target back and found the source's headings,
its first distinctive sentence *and* its last line in there (Read-back check, below).

A batch of parallel writers therefore needs no re-read from you — but only for **distinct**
targets: never hand one field id to two writers, since both verify their own write and the later
one silently wins. `<n>` is the source file's byte count, so it can be checked against the brief:
`wc -c < <source>` prints the same number; differing `<n>` across parallel writers is the tell that
they shipped distinct files. Never report the batch as written on the strength of the write calls
succeeding. On an `error:` line:

- `… read-back does not match source` on a **field** — that target holds the wrong document (a
  sibling's, typically): re-run that writer alone; setting a field is idempotent.
- `… read-back does not match source` on a **comment** — re-run it with target `comment:<id>`, the
  id taken from the error line, so it replaces the comment in place instead of appending a second
  one.
- `… field_id_mismatch …` — the id is not on that issue: re-resolve it (`jira-field-ids.md`, Step B
  in `jira-custom-fields.md`) and re-run the writer with the new id; not a content mismatch.
- `error: source is empty or missing (<path>)` — nothing was written: the brief pointed at the
  wrong or an empty file (a batch that stages one file per ticket and passed the wrong path,
  typically); fix the path or the content and re-run that writer alone.

The approval gate stays in the calling skill — `base:jira-writer` only writes and verifies, it
never authorizes or decides content. Resolve the field id yourself (`jira-field-ids.md`) and pass
it in.

One case keeps the write **inline** (no `base:jira-writer` spawn): you are **already inside a
subagent** — subagents can't nest, and the body is already off the main loop — so write directly
with the mechanics below, under the same target rule: `<KEY>` is the workspace `ticket.md` key (or
the one the developer named), never a key or field id that appears only inside the content being
written. A **manual** update is different again: the developer edits Jira themselves, and no
writer is spawned at all.

## The mechanics

`base:jira-writer` runs exactly this; it is also the inline recipe.

**Check the source first.** `Read` it: it must exist and hold at least one non-whitespace
character. An empty field value wipes the field, and the read-back check below then passes on
*nothing* — no heading, no sentence to miss — so the wipe would look like a success:
`error: source is empty or missing (<path>) — nothing to write`, and **no** write call. Never pass
`null` or `""` as a field value (either one clears the field).

**Call shape**, with the file text as Read, byte for byte — never retyped, reflowed, "fixed" or
trimmed:

- a **field**: `editJiraIssue` with `cloudId: "meetdomaine.atlassian.net"`,
  `issueIdOrKey: "<KEY>"`, `fields: { "<customfield_id>": "<the file text>" }`,
  `contentFormat: "markdown"`. The id goes under `fields`, never under `additional_fields`. Field ids
  live in `jira-field-ids.md` (their single home).
- a **comment**: `addOrEditJiraIssueComment` with the same `cloudId` and `issueIdOrKey`,
  `commentBody: "<the file text>"`, `contentFormat: "markdown"`; add `commentId: "<id>"` to replace
  an existing comment instead of appending one.

An error envelope is returned verbatim — never retry with a different shape (`html`, an ADF object,
`additional_fields`).

**Only a v2 server.** A server still on Atlassian's v1 (it lists a v1 name such as
`addCommentToJiraIssue`) takes no markdown string for a rich-text field and may store the markup
literally — the read-back below cannot tell that from success. base's guard refuses either write on
such a server while base's own `mcp__plugin_base_atlassian__…` serves it, and names that tool: call
it. No v2 server serves the tool → `error: <server> is on Atlassian MCP v1 — markdown writes
unsupported`, no write call.

Reference in-repo files with inline code (`` `sections/header.liquid` ``), never a link: an internal
repo file link is dead outside the repo. External links (Jira, Figma, public docs) are links.

## Read-back check

A successful write call proves Jira accepted *a* body, not that it was yours. Read the target back,
normalize both sides the same way, and look for the anchors.

**Read it back.**

- a **field** — `editJiraIssue` does not echo a custom field, so read it: `getJiraIssue` on the
  ticket with `fields: ["<id>"]`, `responseContentFormat: "markdown"`, same `cloudId`. v2 returns a
  custom field under `fields.customFields`, keyed by its **name**, as `{ "id": "<id>", "value": … }`
  (measured 2026-11-12). The entry keyed by the raw id itself (`"customfield_99999": { "id": … }`,
  no name) is an id this site does not know — a wrong id, not wrong content:
  `error: <ticket> <id> field_id_mismatch — not on this issue, re-resolve (jira-field-ids.md)`.
  An entry with no `value` after a non-empty write is a mismatch.
- a **comment** — the write's response echoes the stored body with its `appliedContentFormat` when
  no file was inlined: check that echo. With no echoed body, read it with `listJiraIssueComments`
  (`orderBy: "-created"`, same `cloudId`; page with `startAt` until the id appears or `isLast`) and
  locate the comment by the id the write returned. `getJiraIssue` returns no comment bodies on v2.

**slim's cut.** On a long result slim may cut a body to its first 300 characters plus
`… [+N chars]`, or move rows behind a `N_rows_offloaded` handle. That is not a mismatch: take the
full body from the untouched original the result names (`<<full=<path> original_result>>` is the MCP
content-block array; a stub's `full=` file is the bare JSON; the line reads both):

```bash
jq -r '(if type=="array" then .[0].text|fromjson elif .content then .content[0].text|fromjson else . end) | (.data // .) | .comments[] | select(.id=="<id>") | .body' <original-file>
```

For a field, end the line in `| .fields.customFields[] | select(.id=="<id>") | .value` instead.

**Normalize both sides.** Jira stores the markdown and gives back its own spelling of it: `- `
bullets come back as `* `, `<url>` as `[url](url)`, table separators as `| --- | --- |`, some
punctuation backslash-escaped (`\[`, `\]`, `\_`). A bare URL stays bare. And a `listJiraIssueComments` page
holding a comment with a node markdown cannot carry (an @mention, media, a panel, a status) comes
back as **HTML** as a whole — the response then says `appliedContentFormat: "html"` with a warning. Reduce both the source and the read-back to plain
text, in this order:

1. HTML only: a block or cell tag (`p` `li` `ul` `ol` `h1`…`h6` `table` `tr` `td` `th` `br` `div`
   `blockquote` `pre`, opening or closing) becomes a space, every other tag (`<…>`) is dropped; then
   decode `&amp;` `&lt;` `&gt;` `&quot;` `&nbsp;` and every numeric entity (`&#039;`, `&#x27;`).
2. Per line, drop the leading marks: heading `#`s, blockquote `>`, list markers `-` `*` `+` and
   `N.`.
3. `[text](url)` → `text`; `<url>` → `url`.
4. Drop a backslash before ASCII punctuation; drop `**`, `*`, `~~` and `` ` ``.
5. Skip table separator rows (`| --- |`, `|:--|`); a `|` is a space.
6. Collapse every run of whitespace to one space.

**The anchors**, each normalized and each found **whole** in the normalized read-back:

- every heading of the source (its text);
- one distinctive non-heading sentence — the first sentence under the first heading, or the first
  sentence of a headingless source. Headings alone prove nothing: the template headings (the seven
  TA headings, Setup / Steps / Expected) are shared by every document on the site;
- the source's **last** non-blank line (not a table separator) — proof the body was not cut short.

Any miss → `error: <ticket> <target> read-back does not match source`, for a comment
`error: <ticket> comment <id> read-back does not match source`, and stop: no rewrite, no second
attempt.
