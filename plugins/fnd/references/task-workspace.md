# Task workspace — per-ticket cache of reader outputs & working notes

Once `jira-reader` / `figma-reader` have pulled a ticket or a Figma node, their structured
output is saved to files in the project so the **next** skill — or a new session, or the turn
after a `/compact` — reads the file instead of re-spawning the agent. Facts that live here
survive context compaction, so compacting between workflow steps becomes cheap. Better still,
at a step boundary with a complete workspace prefer `/clear` + invoking the next skill fresh
over `/compact` — the next skill re-ingests from these files and no lossy summary is carried
forward.

## Location & layout

`.claude/fnd/<work-id>/` in the project repo — one folder per **unit of work**; the folder is a
**cache**, safe to delete at any time (suggest removing it once the ticket is Done). `<work-id>` is
the **ticket key** (`ELC-206`) for single-ticket work; for a **batch shipping as one PR**
(several bug tickets fixed on one branch, no full series per bug) use the **branch slug**
(`fix-plp-bugs`) with one `ticket-<KEY>.md` per ticket inside:

| File | Holds | Written by |
|---|---|---|
| `ticket.md` — in a batch, `ticket-<KEY>.md` each | `jira-reader` structured output, **verbatim** (Description, AC, Assumptions, TA, Steps to Test, links) | `jira-reader` (the calling skill only on an inline fetch or a failed save) |
| `figma-<node-id>.md` | one `figma-reader` build spec, **verbatim** — one file per node | `figma-reader` (the calling skill only on an inline fetch or a failed save) |
| `doc-<slug>-<hash>.md` | one linked doc's **extracted** content (data models, copy, field lists — never the raw page); slug from the page title + a short URL hash (`doc-data-mapping-9f3c.md`), so same-titled docs don't collide | `doc-reader` (the calling skill only on the inline fallback) |
| `plan.md` | the **approved implementation plan**, verbatim | `develop-feature-or-fix`, at its ✋ checkpoint |
| `qa.md` | the **approved QA checklist**, then the pass/fail report + confirmed findings with their repro values | `qa-feature-or-fix` |
| `steps-to-test.md` | the **approved Steps to Test** (local copy of what went to Jira) | `write-steps-to-test` |
| `metaobject-setup.graphql` | the Mode 2 living data-model setup file (`references/metafield-metaobject-setup.md`); inspection drafts and per-step hand-off copies go in `tmp/` | `develop-feature-or-fix` |
| `notes.md` | append-only dated log: checkpoint decisions, gotchas, provisioned metafield/metaobject gids, preview theme name/id, test page paths; in a batch — root cause + fix summary per bug | any skill, at natural boundaries |
| `progress.md` | work checklist — what's done, what's next (date + one-line status) | every series skill, at completion |
| `tmp/` | scratch made while working — test scripts, query drafts, JSON dumps, screenshots — instead of littering the project root | anyone; delete freely |

Frontmatter on ticket files: `ticket`, `url`, `fetched_at` (ISO datetime), `jira_updated` (the
ticket's `updated` field as Jira returned it), and `verified_at` (last freshness probe that
matched). On `figma-*.md`: `url`, `fetched_at`. On `doc-*.md`: `url`, `title`, `fetched_at`,
`last_edited` (the source's own last-edited stamp, when known) and — when sub-pages were folded
into the extract — a `sources:` list of url + last-edited pairs. The TA
itself isn't duplicated here — it already lives in
`docs/technical-approaches/<KEY>-technical-approach.md` (gitignored) and on the ticket.

**Keep it out of git.** Before the first write, ensure the folder is ignored **locally** (never
ships in a diff):

```bash
# --git-common-dir, not --git-dir: info/exclude is shared, and a linked worktree's .git is a file
git check-ignore -q .claude/fnd || echo '.claude/fnd/' >> "$(git rev-parse --git-common-dir)/info/exclude"
```

A team that prefers a committed rule can put the line in `.gitignore` instead.

## Read rule — context-first order

1. **This conversation** — the fields are already in context, in full (not summarized): use them.
2. **The workspace files** — present and fresh (below): read them; don't spawn a reader.
3. **Fetch** — spawn `jira-reader` / `figma-reader` **with this workspace path** (they write their
   own file; what they return and what they placehold is the write rule below), or read the linked
   doc; anything fetched inline is yours to save (write rule).

### Freshness

A cached file needs re-verification when (a) it's a new session, (b) `fetched_at` /
`verified_at` is **older than 24 h** — even mid-session, or (c) the developer hints the
source changed. Any trigger fired → read **`task-workspace-freshness.md`** and follow it
(cheap probes per source type; a probe mismatch is NOT automatically stale). `notes.md`
is a log; it doesn't go stale.

## Write rule

- **The reader writes its own file.** Pass the workspace path in the brief and `jira-reader` /
  `figma-reader` / `doc-reader` each write theirs right after reading, before composing a return
  — then return `saved_to:` plus the fields you asked for. Never re-write those bytes from the
  return: that pays for the same payload twice in the main context. What comes back short:
  `jira-reader` placeholds the **body** fields you didn't name as `<in ticket.md>`
  (`<in ticket-<KEY>.md>` in a batch) — never the link lists, see its output contract;
  `figma-reader` returns `spec` **and** `assets` in full unless your brief says you are only
  **caching** the node, and then placeholds both as `<in figma-<node-id>.md>`;
  `doc-reader` always returns its extract. Read the file when you need a placeheld field.
- **Check every `saved_to`.** Empty while you *did* pass a workspace path means the save never
  landed (a denied `Write` in plan mode, say) — the reader then returns every field, so write its
  structured output to the workspace **yourself** before moving on, or the cache silently never
  materializes and the next skill re-spawns the reader. A `no_content_change` return is NOT a
  failed save — there is nothing to write; just refresh `jira_updated` / `verified_at` per
  `task-workspace-freshness.md`.
- A reader that got **no** workspace path (or a source you fetched inline) is yours to save:
  write its structured output **verbatim** — don't re-summarize; later skills need the full
  fields. Overwrite on re-fetch.
- `doc-*.md` holds the **extract** (what the task needs), not the page.
- Append to `notes.md` at natural boundaries — approved-plan decisions, provisioned data
  (gids), preview theme, test URLs, confirmed bugs + the hostile values that triggered them.
  One dated `##` entry per event, newest last.
- Scratch files created while working (test scripts, query drafts, dumps, screenshots) go in
  the workspace `tmp/` — never the project root.
- **Never** store secrets (tokens, `.env` values) or raw payloads (ADF, Figma node trees, full Notion/Confluence pages) —
  only the readers' compact structured outputs.

## Progress tracking — `progress.md`

So a **clean/new session** knows where the work stands and what to offer next. The first
series skill to run on a ticket creates the folder and this file with the full list unchecked;
outside the series (ad-hoc flows), the `save-task-context` skill or the session convention does:

```markdown
---
ticket: ELC-206
updated: <ISO datetime>
session: <$CLAUDE_CODE_SESSION_ID of the last session that wrote here>
---
- [ ] write-technical-approach
- [ ] develop-feature-or-fix
- [ ] qa-feature-or-fix
- [ ] pre-commit-review
- [ ] commit
- [ ] write-steps-to-test
- [ ] create-pull-request
```

For a **batch** (`<work-id>` = branch slug) the rows are the tickets plus the same shared tail
(pre-commit-review → … → create-pull-request) — check each bug off as it's fixed, with its root
cause: `- [x] ELC-301 — 2026-07-11, fixed: self-reference skipped in bundle resolve`.

- On completing its workflow (final report delivered and, where applicable, approved), a skill
  checks off its row and appends `— <date>, <one-line status>` (branch, PR URL, "QA: 2 blocking
  bugs", …). Re-runs update the row in place; stamp `updated` and `session` (from
  `$CLAUDE_CODE_SESSION_ID`; skip if unset) on every write.
- **Offering the next step:** offer the first unchecked row **in one line — offer only, never
  auto-run** (QA failures branch back to the implementation flow first). In a fresh session,
  reading this file replaces the lost conversation state — when the developer brings up a
  ticket that has a workspace, report where the series stands and offer the next unchecked step.
- **Resuming a conversation:** `session` names the conversation that last wrote here —
  answer "where did we leave off?" from `progress.md` + `notes.md`; recovery mechanics
  (`claude --resume`, transcript tail): `task-workspace-freshness.md` → Resuming.
