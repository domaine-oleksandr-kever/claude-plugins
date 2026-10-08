# jira-reader — cached-ticket freshness check

Read by the `base:jira-reader` agent when its task includes a cached `jira_updated` timestamp.
Jira bumps `updated` on sprint moves, rank, status/assignee flips, estimates, comments —
none of which touch the content fields the reader reports, though a new comment (and the
screenshots it brings) is still ticket content the cache has to catch up with. Classify
before re-reading the whole ticket:

1. `getJiraIssue` with `cloudId: "meetdomaine.atlassian.net"`,
   `fields: ["updated", "status", "comment", "attachment"]`, `expand: "changelog"`,
   `responseContentFormat: "markdown"` — history, the comment field, whose **bodies you never read
   here** (only its `total` and the newest `created`, both via `jq`), and the attachment metadata the
   attachments step of step 3 is built on (ids, filenames, mime types — no bodies, so it is cheap).
   Entries come **newest first**. The response is often huge, and slim hands it back compressed or
   as a stub: run the `jq` lines below on the untouched original it names (the `<<full=<path>
   original_result>>` handle, or the stub's `full=` line) — never pull the raw changelog or the
   comment bodies into context. A small response comes back untouched; read it as-is. The
   `original_result` file is the MCP content-block array (`[{"type":"text","text":"{…}"}]`), a
   stub's `full=` file the bare issue JSON; each line starts by unwrapping the first shape and
   passes the second through, so both work.

   ```bash
   jq -r --arg since "<stored jira_updated>" \
     '(if type=="array" then .[0].text|fromjson elif .content then .content[0].text|fromjson else . end)
      | [.changelog.histories[] | select(.created > $since) | .items[].field]
      | group_by(.) | map("\(.[0]) ×\(length)") | join(", ")' <original-file>
   jq -r '(if type=="array" then .[0].text|fromjson elif .content then .content[0].text|fromjson else . end)
      | "comments=\(.fields.comment.total // 0) last=\(.fields.comment.comments[-1].created // "")"' <original-file>
   ```

   (Timestamps within one API response share a format, so string compare is safe.)
2. **Content fields** — what the cache stores: `summary`, `description`,
   `Acceptance Criteria`, `Assumptions`, `Technical Approach`, `Steps to test`,
   `Documentation Links`, `Attachment` (added or removed — that one **does** create a
   changelog entry). Match the FULL name, case-insensitively — `Acceptance Criteria
   Status` is a different, workflow-tracking field, not content.
3. **None changed, but the discussion moved** — the comment `total` or the newest `created`
   from step 1 differs from `comments.md`'s `comment_count` / `last_comment_at` frontmatter
   (or that file is missing while the ticket has comments) → **comment-only refresh**: run
   the comments step and the attachments step of your prompt, rewrite `comments.md` and
   `ticket.md`'s `## Attachments` section, leave every other cached field untouched, and
   return. Step 1's response is the input for both — its comment bodies are markdown already (no
   second field read here; restore every cut body and offloaded row from the original file with the
   comment-restore `jq` line of your prompt (Read the comments), never write a `… [+N chars]` body), and
   its `attachment` field is the metadata the attachments step decides on. The `comments` lines
   returned here follow the same
   rule as a full read — the first 160 characters of each comment **verbatim**, never
   paraphrased — and `comment_links` carries every URL they hold:

   ```
   no_content_change: true
   comments_refreshed: true
   updated:            # the new value from step 1
   status:             # current status from step 1
   changed:            # e.g. "comments 4 → 6"
   comments:           # the four attachment/comment keys of your output contract,
   comment_links:      # all four in full — the caller has nothing else to read them from
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
   timestamp (100+ entries since) → do the normal full read per your prompt, including the
   workspace save (it overwrites the cached file).
