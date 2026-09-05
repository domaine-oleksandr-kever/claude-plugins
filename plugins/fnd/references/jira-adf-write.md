# Writing to Jira — ADF for rich-text fields and comments

The rich-text **custom** fields — **Acceptance Criteria, Assumptions, Technical Approach,
Steps to test, Documentation Links** — store **Atlassian Document Format**, not markdown: a
bare markdown/plain string sent to one is rejected or stored literally. So when a workflow
updates one via `editJiraIssue`, **convert the approved content to an ADF document first**
and pass that object as the field value. This applies to every skill that writes back:
`write-technical-approach` (Technical Approach), `write-steps-to-test` (Steps to test), and
any `qa-feature-or-fix` write. **Description** is a *standard* field and may accept markdown,
but we send it as ADF too — one path, one converter.

**Comments go through the same converter.** `addCommentToJiraIssue` does accept markdown
(`contentFormat: "markdown"`), but the MCP's own conversion leaves a bare URL as inert,
unclickable text and backslash-escapes the `_` in its query string (a preview-theme URL
comes out as `?\_ab=0&\_fd=0`). So convert, then pass the ADF as a JSON **string** —
`commentBody: <converter stdout verbatim>` with `contentFormat: "adf"`. `commentBody` is
declared as a string, so the ADF goes in serialized, never as an object.

Both write calls also require **`cloudId`** — pass the site host
`meetdomaine.atlassian.net` (cloudId resolution: `jira-field-ids.md`).

## Preferred path from the main loop — delegate to the `jira-writer` subagent

A converted field is a large ADF blob (~3.4k tokens for a real Technical
Approach). Running the converter and typing that object into an `editJiraIssue` call
**inline** pays for it twice in the main-loop context — the converter's stdout copy and
the model-typed argument copy — and leaves it in history forever. So from a main-loop
skill, **after the ✋ approval**, delegate the write to the **`jira-writer`** subagent
instead: it converts and writes inside its own disposable context, and the ADF never
touches the main loop.

Brief (one writer per field; parallel writers for several fields):

> **jira-writer** — ticket `<KEY>` · target `<customfield_id>` (or `comment`, or
> `comment:<id>` to replace that comment) · source `<path to the approved .md>`. (Add
> `tables: keep` only if tables must be preserved.)

It returns one line: `ok: <KEY> <target> written (<n> bytes, read-back verified)` or
`error: <reason>`. `ok` means the writer read the target back and found the source's headings
*and* a distinctive sentence of it in there.

A batch of parallel writers therefore needs no re-read from you — but only for **distinct**
targets: never hand one field id to two writers, since both verify their own write and the
later one silently wins. Differing `<n>` across parallel writers is the tell that they shipped
distinct documents. Never report the batch as written on the strength of the write calls
succeeding. On an `error:` line:

- `… read-back does not match source` on a **field** — that target holds the wrong document
  (a sibling's, typically): re-run that writer alone; setting a field is idempotent.
- `… read-back does not match source` on a **comment** — re-run it with target `comment:<id>`,
  the id taken from the error line, so it replaces the comment in place instead of appending a
  second one.
- `… field_id_mismatch …` — the id is not on that issue: re-resolve it (`jira-field-ids.md`,
  Step B in `jira-custom-fields.md`) and re-run the writer with the new id; not a content
  mismatch.

The approval gate stays in the calling skill — `jira-writer` only converts-if-needed, writes
and verifies, it never authorizes or decides content. Resolve the field id yourself
(`jira-field-ids.md`) and pass it in; a manual-update path (developer edits Jira) needs no
writer at all.

One case keeps the write **inline** (no `jira-writer` spawn): you are **already inside a
subagent** — subagents can't nest, and the ADF is already off the main loop, so convert
first and write directly with the mechanics below. A **manual** update
is different again: the developer edits Jira themselves, so no converter runs and no writer
is spawned at all.

## The mechanics — use the converter, don't hand-build ADF

`jira-writer` runs exactly this; it is also the inline / manual recipe. **Plugin root** = the
plugin's own directory, this file being `<plugin root>/references/jira-adf-write.md`; substitute
its absolute path for the variable below —
on Claude Code the host expands `${CLAUDE_PLUGIN_ROOT}` itself, so the command runs verbatim.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/md-to-adf.cjs --no-tables <approved.md>   # or pipe via stdin
```

It prints the ADF document JSON to stdout; pass that object straight to `editJiraIssue`
(or, for a comment, the same text as the `commentBody` string). Dependency-free Node,
deterministic; supports headings, **bold**/*italic*/`code`/~~strike~~, links in all three
forms — `[text](url)`, `<url>`, and a bare `https://…` pasted in prose (trailing sentence
punctuation stays prose) — bullet & ordered lists, fenced code blocks, `---` rules,
blockquotes, and GFM tables. (Underscore emphasis is deliberately ignored so
`customfield_10038`-style snake_case survives — use `*`/`**` for emphasis.) Typical flow:
write the approved content to a `.md` (the workspace file, or `mktemp` — never a fixed name
in the shared temp directory, which parallel writers overwrite for each other), convert, take
the JSON from the tool result (stderr shows beside stdout — no `> adf.json` staging), then
`editJiraIssue` with `fields: { "<id>": <that JSON> }`, then run the read-back check below.

**Read-back check.** A successful write call proves Jira accepted *a* document, not that it was
yours. A **field**: `getJiraIssue` on the ticket with `fields: ["<id>"]`,
`responseContentFormat: "markdown"`, `expand: "names"`, same `cloudId` — the id absent from the
returned `names` map is a wrong id, not wrong content:
`error: <ticket> <id> field_id_mismatch — not on this issue, re-resolve (jira-field-ids.md)`.
A **comment**: check the create response if it echoes the stored body, otherwise `getJiraIssue`
with `fields: ["comment"]` and locate it by the id the create returned. The body that comes back
must contain **every heading of the source** AND **one distinctive non-heading sentence** of it —
the first sentence under the first heading, or the first sentence of a headingless source.
Headings alone prove nothing: the template headings (the seven TA headings, Setup / Steps /
Expected) are shared by every document on the site. Match **each** anchor by its longest plain
run — inline code, emphasis and links split a line across ADF text nodes, and a short result
(≤ 4 KB) arrives as raw ADF rather than markdown (the compression hook converts only larger
results). Any miss → `error: <ticket> <target> read-back does not match source`, for a comment
`error: <ticket> comment <id> read-back does not match source`, and stop: no rewrite, no second
attempt.

## Keep the ADF compact — a huge field value is fragile (never fall back to markdown)

A large ADF object is fragile to inline into one `editJiraIssue` call — one slip breaks
the JSON, which tempts "shortcutting" to a raw **markdown string**. Don't: Jira rich-text
**custom** fields reject it (`Operation value must be an Atlassian Document…`), and a
comment posted as markdown loses its bare URLs. Keep the ADF small instead:

- **Output is minified by default** — use `--pretty` only to eyeball it.
- **Pass `--no-tables`** — ADF `table` nodes are the heaviest construct; `--no-tables`
  renders each table row as one compact bullet.
- **Prefer headings + lists over tables in the source markdown**; reserve tables for
  genuinely tabular, short data.
- The converter **prints a size warning to stderr** when the ADF is large — a signal to
  **trim/restructure**, never to switch to markdown.

**Document wrapper** (what the converter emits):

```json
{ "type": "doc", "version": 1, "content": [ /* block nodes */ ] }
```

**Call shape:** `editJiraIssue` with `cloudId: "meetdomaine.atlassian.net"`,
`issueIdOrKey: "<KEY>"`, `fields: { "<customfield_id>": <ADF doc object> }` — field IDs
live in `jira-field-ids.md` (their single home; an ID missing from the `names` map → Step B
in `jira-custom-fields.md`). A **comment**: `addCommentToJiraIssue` with the same `cloudId`
and `issueIdOrKey`, `commentBody: "<ADF doc as one JSON string>"`, `contentFormat: "adf"`
(add `commentId` to update an existing comment).

> Honour the TA rule: **no internal repo file links** — reference in-repo files with an
> inline-`code` mark, never a `link` mark. External links (Jira, Figma, public docs) use
> `link`.
