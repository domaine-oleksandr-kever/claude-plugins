# Jira field IDs — meetdomaine site (single home)

Custom-field IDs are **site-global** (`meetdomaine.atlassian.net`); a different Atlassian
site has different IDs. Verified 2026-05-30 (ELC-61). This table's only other home is the
live `names` map — never copy it into skills or agents.

| Field               | Field ID                 |
| ------------------- | ------------------------ |
| Description         | `description` (standard) |
| Acceptance Criteria | `customfield_10036`      |
| Assumptions         | `customfield_10037`      |
| Technical Approach  | `customfield_10038`      |
| Steps to test       | `customfield_10040`      |
| Documentation Links | `customfield_10047`      |

Request shape — every Jira **issue** tool (`getJiraIssue`, `editJiraIssue`,
`addCommentToJiraIssue`) requires **`cloudId`**. On a **read**, also **always include
`expand: "names"`** (only `getJiraIssue` takes it; it tells "empty" from "wrong ID"):

```
cloudId: "meetdomaine.atlassian.net",
issueIdOrKey: "<KEY>",
fields: ["summary", "description", "status", "assignee",
         "customfield_10036", "customfield_10037", "customfield_10038",
         "customfield_10040", "customfield_10047"],
expand: "names"
```

The site host works as `cloudId` directly; only if it is rejected call
`getAccessibleAtlassianResources` (no params) for the site's UUID and use that instead.

ID **absent from the `names` map** → wrong/renamed ID: rediscover per
`jira-custom-fields.md` → Step B, use the resolved ID for the session, and report
`field_id_mismatch: <old> → <new>` in your result so the developer can fix this table
once, site-wide (offer `/fnd:report-plugin-issue`; never edit or file unasked).
