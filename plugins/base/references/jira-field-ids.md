# Jira field IDs — meetdomaine site (single home)

Custom-field IDs are **site-global** (`meetdomaine.atlassian.net`); a different Atlassian
site has different IDs. Verified 2026-05-30 (ELC-61), re-read on v2 2026-11-12 (ELC-1864). This
table's only other home is the live response's `fields.customFields` — never copy it into skills or
agents.

| Field               | Field ID                 |
| ------------------- | ------------------------ |
| Description         | `description` (standard) |
| Last updated        | `updated` (standard)     |
| Attachments         | `attachment` (standard)  |
| Comments            | `listJiraIssueComments` (v2 has no comment field) |
| Acceptance Criteria | `customfield_10036`      |
| Assumptions         | `customfield_10037`      |
| Technical Approach  | `customfield_10038`      |
| Steps to test       | `customfield_10040`      |
| Documentation Links | `customfield_10047`      |

Request shape — every Jira **issue** tool (`getJiraIssue`, `listJiraIssueComments`,
`editJiraIssue`, `addOrEditJiraIssueComment`) requires **`cloudId`**:

```
cloudId: "meetdomaine.atlassian.net",
issueIdOrKey: "<KEY>",
fields: ["summary", "description", "status", "issuetype", "assignee", "updated",
         "attachment",
         "customfield_10036", "customfield_10037", "customfield_10038",
         "customfield_10040", "customfield_10047"],
responseContentFormat: "markdown"
```

**The response shape (Atlassian MCP v2, measured 2026-11-12).** The body is `{"data": {…}}`. The
custom fields sit under `data.fields.customFields`, each keyed by its field **name** as
`{ "id": "<id>", "value": … }`; an empty field has no `value`. An id the site does not know comes
back keyed by the **raw id** itself (`"customfield_99999": { "id": "customfield_99999" }`) — that,
not an error, is the wrong-id signal. No `names` map is needed or returned.

**Formats.** `responseContentFormat` takes `markdown` or `html`; `"adf"` is refused by the schema.
Rich-text values (description, custom fields) come as markdown strings — measured 2026-11-12 even
with `responseContentFormat: "html"` asked and with an inline image in the field (it reads as
`![](blob:https://media…&id=<media id>&…)`, the media id only). Should a response ever carry
`appliedContentFormat: "html"`, compact its values as the comments below; the measured whole-page
HTML switch is `listJiraIssueComments`'.

**Comments.** `getJiraIssue` reports no comment bodies on v2 (a `fields: ["comment"]` request
returns nothing for it): read them with `listJiraIssueComments` (`orderBy`, `startAt`,
`maxResults` ≤ 100; `total` and `isLast` on the page; each comment's `id`, `author.displayName`,
`created`, `updated`, `body`, `parentId`). A page holding any comment with a node markdown cannot
carry (an @mention, media, a panel, a status) comes back as HTML as a whole
(`appliedContentFormat: "html"`, a `warning`); the same comment read alone comes as markdown. In markdown, an inline image reads as
`![](blob:https://media…&id=<media id>&…__fileName=null…)` — the media id only, **no file name**, no
alt. In HTML, the media node carries `data-id` (the media id) and `data-alt` — the attachment's file
name (measured 2026-11-12: `data-alt` equalled the attachment row's `filename`). Mentions come as
`<custom data-type="mention" …>@Name</custom>` in markdown and as a `data-type="mention"` span in
HTML. `base:jira-reader` lists the attachment rows on their own, with their `author` and `created`;
the only join to a comment is that file name (its prompt → Fetch the attachments, step 4).

The site host works as `cloudId` directly; only if it is rejected call
`getAccessibleAtlassianResources` (no params) for the site's UUID and use that instead.

An id keyed **by itself** in `customFields` → wrong/renamed ID: rediscover per
`jira-custom-fields.md` → Step B, use the resolved ID for the session, and report
`field_id_mismatch: <old> → <new>` in your result so the developer can fix this table
once, site-wide (offer `/base:report-plugin-issue`; never edit or file unasked).
