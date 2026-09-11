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
  status/assignee flips, estimates — none of which touch what the cache stores. A **new
  comment** does (`comments.md` is a cached file). Don't re-fetch blindly: spawn `jira-reader`
  **passing the stored `jira_updated`** (and the workspace path) — it checks the changelog
  first (its freshness mode) and returns one of three things:
  - `no_content_change` alone → the bump was noise: keep the cache, overwrite `jira_updated`
    with the new value, fix the `status:` line if it moved, stamp `verified_at` — so the same
    noise never re-triggers — and tell the developer in one line, e.g. "ticket bump was
    Sprint ×1, assignee ×4 — cache still valid".
  - `no_content_change` **plus `comments_refreshed: true`** → the discussion moved: the reader
    has rewritten `comments.md` and `ticket.md`'s `## Attachments` section and hands back
    `comments` / `comment_links` / `attachments` / `attachments_note` in full. Stamp as above,
    and **surface what came back** — the new comments (and the screenshots they brought) are
    ticket content, not noise; `attachments_note` non-empty → show it verbatim, once.
  - a cached field really changed → the full re-read in the same spawn, which **rewrites the
    file itself** and hands back `saved_to:`.
- **Probe unavailable** (Atlassian MCP not connected)? Don't trust silently — tell the
  developer the cache age ("ticket cached N h ago — use it, or refresh?") and let them
  decide.

## Design & doc files

- `figma-*.md`: **`source: rest` has a cheap probe** — `scripts/figma-rest.sh "<the stored url>"
  --probe` under the plugin root (the plugin's own directory, the one holding `references/` and
  `scripts/`). It asks Figma when the **file** last changed (`GET /v1/files/<key>?depth=1` — the
  file's meta, not its tree), writes nothing, and prints one line:
  `ok=1 file_key=… node_id=… last_modified=…`. Compare that `last_modified` with the
  `last_modified` in the file's own frontmatter (the reader stores the stamp it fetched). Same
  stamp → fresh: stamp `verified_at`. Newer → spawn the reader (the file-level stamp moves when
  **any** frame in that Figma file changes, so a newer value means "re-read", not "this node
  definitely changed"). **No `last_modified` in the frontmatter** — a spec saved before the reader
  stored one — → there is no baseline to compare with: treat it like the MCP rungs below. A plain
  re-run of the fetch command is **not** a probe: on a cache hit its `last_modified` is the cached
  payload's own stamp, so it can only ever report "unchanged". Anything else (`source:
  mcp-connector` / `mcp-desktop`, or no `source` line at all) has **no** cheap version probe —
  when in doubt, ask the developer whether the design changed since `fetched_at`. Check the file's `url` first: it answers the node
  you want only when **both** its file key and its node id match the requested URL —
  otherwise it's a different design that happens to share a node id, so try the node's other
  `figma-<node-id>*.md` variants (the collision suffix) and spawn the reader only when none
  matches.
- `doc-*.md`: same triggers as ticket files. Cheap probe, no full fetch — **Notion**:
  `notion-search` the stored `title` (small `page_size`, `max_highlight_length: 0`),
  match the result to the page id embedded in the stored `url`, read its `timestamp`: a
  **day**-granular last-edited date (covers connected Google-Drive docs too);
  **Confluence**: `searchConfluenceUsingCql` with `cql: "id=<pageId>"` → precise
  `lastModified`. Probe date ≤ stored `last_edited` / `fetched_at` date → fresh: stamp
  `verified_at`; newer → re-fetch, re-extract, overwrite. Same-day edits (day
  granularity) and plain-web links (no probe): ask, as with `figma-*.md`. When the extract's
  frontmatter carries a `sources:` list (folded sub-pages), the probe covers **every** listed
  source, the same cheap probe each — the extract is only fresh when all of them are; a source
  no probe reaches → ask, as with `figma-*.md`. An extract that lacks something *this* task
  needs isn't stale, it's incomplete — re-read the source.

## Resuming a conversation

`progress.md`'s `session` field names the conversation that last wrote to the workspace.
On *"where did we leave off on X?"*, answer from `progress.md` + `notes.md`; if it isn't
the current session, also offer the resume command of the host that wrote that id
(Claude Code `claude --resume <session>`, Codex `codex resume <session>`) from this
project — and when there is no id, `progress.md` + `notes.md` alone are enough to
continue. A detail the workspace didn't capture → pull the last user/assistant messages
from that transcript's tail (on Claude Code
`~/.claude/projects/<project-dir-slug>/<session>.jsonl`; on Codex the rollout under
`~/.codex/sessions/`), not the tool dumps.
