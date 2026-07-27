# Task workspace — freshness probes & session resume

Read when a cached workspace file trips a freshness trigger (new session / older than
24 h / developer hint — the triggers live in `task-workspace.md` → Freshness) or when
resuming an interrupted conversation.

## Ticket files (`ticket*.md`)

- **Cheap probe from the main loop** — `getJiraIssue` with
  `cloudId: "meetdomaine.atlassian.net"`, `fields: ["updated"]` only (tiny response, no
  subagent): match → stamp `verified_at` and trust the cache (probe at most once per
  session unless hinted).
- **Probe mismatch ≠ stale.** Jira bumps `updated` on sprint moves, rank, priority,
  status/assignee flips, estimates, comments — none of which touch what the cache stores.
  Don't re-fetch blindly: spawn `jira-reader` **passing the stored `jira_updated`** (and the
  workspace path) — it checks the changelog first (its freshness mode) and returns either
  `no_content_change` (→ keep the cache: overwrite `jira_updated` with the new value, fix the
  `status:` line if it moved, stamp `verified_at` — so the same noise never re-triggers — and
  tell the developer in one line, e.g. "ticket bump was Sprint ×1, comments — cache still
  valid") or, when a cached field really changed, the full re-read in the same spawn, which
  **rewrites the file itself** and hands back `saved_to:`.
- **Probe unavailable** (Atlassian MCP not connected)? Don't trust silently — tell the
  developer the cache age ("ticket cached N h ago — use it, or refresh?") and let them
  decide.

## Design & doc files

- `figma-*.md`: no cheap version probe exists — when in doubt, ask the developer whether
  the design changed since `fetched_at`.
- `doc-*.md`: same triggers as ticket files. Cheap probe, no full fetch — **Notion**:
  `notion-search` the stored `title` (small `page_size`, `max_highlight_length: 0`),
  match the result to the page id embedded in the stored `url`, read its `timestamp`: a
  **day**-granular last-edited date (covers connected Google-Drive docs too);
  **Confluence**: `searchConfluenceUsingCql` with `cql: "id=<pageId>"` → precise
  `lastModified`. Probe date ≤ stored `last_edited` / `fetched_at` date → fresh: stamp
  `verified_at`; newer → re-fetch, re-extract, overwrite. Same-day edits (day
  granularity) and plain-web links (no probe): ask, as with `figma-*.md`. An extract
  that lacks something *this* task needs isn't stale, it's incomplete — re-read the
  source.

## Resuming a conversation

`progress.md`'s `session` field names the conversation that last wrote to the workspace.
On *"where did we leave off on X?"*, answer from `progress.md` + `notes.md`; if it isn't
the current session, also offer `claude --resume <session>` (from this project). A detail
the workspace didn't capture → pull the last user/assistant messages from that
transcript's tail (`~/.claude/projects/<project-dir-slug>/<session>.jsonl`), not the tool
dumps.
