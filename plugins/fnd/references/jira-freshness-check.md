# jira-reader — cached-ticket freshness check

Read by the `jira-reader` agent when its task includes a cached `jira_updated` timestamp.
Jira bumps `updated` on sprint moves, rank, status/assignee flips, estimates, comments —
none of which touch the content fields the reader reports, though a new comment (and the
screenshots it brings) is still ticket content the cache has to catch up with. Classify
before re-reading the whole ticket:

1. `getJiraIssue` with `cloudId: "meetdomaine.atlassian.net"`,
   `fields: ["updated", "status", "comment", "attachment"]`, `expand: "changelog"`,
   `responseContentFormat: "adf"` (it fetches `comment`, and only that parameter makes the
   bodies ADF with the filename in each `media` node's `attrs.alt` — omitting it returns
   markdown strings with empty-alt `blob:` images) — history,
   the comment field, whose **bodies you never read here** (only its `total` and the newest
   `created`, both via `jq`), and the attachment metadata the attachments step of step 3 is
   built on (ids, filenames, mime types — no bodies, so it is cheap). Entries come **newest first**. The response is often huge; when
   the harness saves it to a file, extract with `jq` — never pull the raw changelog or the
   comment bodies into context (a small inline response you can read as-is):

   ```bash
   jq -r --arg since "<stored jira_updated>" \
     '[.changelog.histories[] | select(.created > $since) | .items[].field]
      | group_by(.) | map("\(.[0]) ×\(length)") | join(", ")' <result-file>
   jq -r '"comments=\(.fields.comment.total // 0) last=\(.fields.comment.comments[-1].created // "")"' <result-file>
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
   return. Step 1's response is the input for both — it requested
   `responseContentFormat: "adf"`, so the comment bodies are already ADF (no second field read
   here) and `adf-to-md.cjs <file> --comments` decodes them straight from it (the converter
   unwraps the MCP envelope and `--comments` implies `--media`); its `attachment` field is the
   metadata the attachments step decides on. The `comments` lines returned here follow the same
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
