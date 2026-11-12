# jira-reader — cached-ticket freshness check

Read by the `base:jira-reader` agent when its task includes a cached `jira_updated` timestamp.
Jira bumps `updated` on sprint moves, rank, status/assignee flips, estimates, comments —
none of which touch the content fields the reader reports, though a new comment (and the
screenshots it brings) is still ticket content the cache has to catch up with. Classify
before re-reading the whole ticket:

1. Two reads, both with `cloudId: "meetdomaine.atlassian.net"`:
   - `getJiraIssue` with `fields: ["updated", "status", "attachment"]`, `expand: "changelog"`,
     `responseContentFormat: "markdown"` — history, and the attachment metadata the attachments
     step of step 3 is built on (ids, filenames, mime types — no bodies, so it is cheap).
     Changelog entries come **newest first**, one page only (`changelog.total` is the full count).
   - `listJiraIssueComments` with `orderBy: "-created"`, `maxResults: 1` — the comment `total` and
     the newest comment's `created`; the one **body it returns you never read** (`getJiraIssue` carries no
     comments on v2).

   The changelog response is often huge, and slim hands it back compressed or as a stub: run the
   `jq` line below on the untouched original it names (the `<<full=<path> original_result>>`
   handle, or the stub's `full=` line) — never pull the raw changelog into context. A small
   response comes back untouched; read it as-is. The `original_result` file is the MCP
   content-block array (`[{"type":"text","text":"{\"data\":…}"}]`), a stub's `full=` file the
   bare JSON; the line unwraps the first shape and passes the second through, so both work.

   ```bash
   jq -r --arg since "<stored jira_updated>" \
     '(if type=="array" then .[0].text|fromjson elif .content then .content[0].text|fromjson else . end) | (.data // .)
      | [.changelog.histories[] | select(.created > $since) | .items[].field]
      | group_by(.) | map("\(.[0]) ×\(length)") | join(", ")' <original-file>
   ```

   (Timestamps within one API response share a format, so string compare is safe.)
2. **Content fields** — what the cache stores: `summary`, `description`,
   `Acceptance Criteria`, `Assumptions`, `Technical Approach`, `Steps to test`,
   `Documentation Links`, `Attachment` (added or removed — that one **does** create a
   changelog entry). Match the FULL name, case-insensitively — `Acceptance Criteria
   Status` is a different, workflow-tracking field, not content.
3. **None changed, but the discussion moved** — the comment `total` or the newest `created`
   from step 1 differs from `comments.md`'s `comment_count` (on a paged field, the total of its
   `comments: <shown>/<total>` line) / `last_comment_at` frontmatter
   (or that file is missing while the ticket has comments) → **comment-only refresh**: run
   the comments step and the attachments step of your prompt, rewrite `comments.md` and
   `ticket.md`'s `## Attachments` section, leave every other cached field untouched, and
   return. The comments step reads every comment with `listJiraIssueComments` exactly as a full
   read does (paged, HTML pages compacted, every cut body and offloaded row restored with the
   comment-restore `jq` line of your prompt — never write a `… [+N chars]` body), and step 1's
   `attachment` field is the metadata the attachments step decides on. The `comments` lines
   returned here follow the same
   rule as a full read — the first 160 characters of each comment **verbatim**, never
   paraphrased — and `comment_links` carries every URL they hold:

   ```
   no_content_change: true
   comments_refreshed: true
   updated:            # the new value from step 1
   status:             # current status from step 1
   changed:            # e.g. "comments 4 → 6"
   comments:           # the five attachment/comment keys of your output contract,
   comment_links:      # all five in full — the caller has nothing else to read them from
   newer_figma_links_in_comments:  # against the cached ticket.md's figma_urls
   attachments:
   attachments_note:
   ```
4. **Nothing changed at all** → the bump was noise (a rank, a sprint move, an estimate).
   Nothing is written (the cached file still holds the content — its `jira_updated` /
   `verified_at` stamps are the caller's to refresh). Return ONLY:

   ```
   no_content_change: true
   updated:            # the new value from step 1
   status:             # current status from step 1
   changed:            # the noise, e.g. "Sprint ×1, assignee ×4"
   ```
5. **A content field changed** — or the changelog page doesn't reach back to the stored
   timestamp (its oldest entry is newer than it while `changelog.total` exceeds the page) → do the normal full read per your prompt, including the
   workspace save (it overwrites the cached file).
