# jira-reader — cached-ticket freshness check

Read by the `jira-reader` agent when its task includes a cached `jira_updated` timestamp.
Jira bumps `updated` on sprint moves, rank, status/assignee flips, estimates, comments —
none of which touch the content fields the reader reports. Classify before re-reading the
whole ticket:

1. `getJiraIssue` with `cloudId: "meetdomaine.atlassian.net"`,
   `fields: ["updated", "status"]`, `expand: "changelog"` — history only, no content.
   Entries come **newest first**. The response is often huge; when the harness saves it to
   a file, extract with `jq` — never pull the raw changelog into context (a small inline
   response you can read as-is):

   ```bash
   jq -r --arg since "<stored jira_updated>" \
     '[.changelog.histories[] | select(.created > $since) | .items[].field]
      | group_by(.) | map("\(.[0]) ×\(length)") | join(", ")' <result-file>
   ```

   (Timestamps within one API response share a format, so string compare is safe.)
2. **Content fields** — what the cache stores: `summary`, `description`,
   `Acceptance Criteria`, `Assumptions`, `Technical Approach`, `Steps to test`,
   `Documentation Links`. Match the FULL name, case-insensitively — `Acceptance Criteria
   Status` is a different, workflow-tracking field, not content.
3. **None changed** → the bump was noise. An empty list means comment-only: comments never
   create changelog entries. Nothing is written (the cached file still holds the content —
   its `jira_updated` / `verified_at` stamps are the caller's to refresh). Return ONLY:

   ```
   no_content_change: true
   updated:            # the new value from step 1
   status:             # current status from step 1
   changed:            # the noise, e.g. "Sprint ×1, assignee ×4" — or "comments only"
   ```
4. **A content field changed** — or the changelog page doesn't reach back to the stored
   timestamp (100+ entries since) → do the normal full read per your prompt, including the
   workspace save (it overwrites the cached file).
