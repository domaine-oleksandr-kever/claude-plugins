---
name: save-task-context
description: >
  Create or update the task workspace (`.claude/fnd/<work-id>/`) from what is already in the
  conversation — ticket fields, decisions, root causes, progress — so the next skill or a
  fresh session resumes without re-running readers. Use when the user asks to save / remember
  the task context or progress (сохранить контекст) or set up a task workspace.
argument-hint: "[ticket-key(s) or branch]"
arguments:
  - name: work_id
    description: Ticket key (ELC-206), several keys (a batch), or a branch slug. If absent, infer from the conversation and the current branch; ask only if genuinely ambiguous.
---

# Save Task Context

Persist the current working context into the task workspace so it survives `/compact` and new
sessions. Layout, freshness, and write rules: `${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md`.

**Source of truth is this conversation — spawn no readers.** This skill writes down what is
already known; missing data is reported as a gap, not fetched.

1. **Resolve `<work-id>`** — one ticket → its key; several tickets shipping as one PR on one
   branch → the branch slug (with one `ticket-<KEY>.md` per ticket inside). State the resolved
   id in one line if it was inferred rather than passed.
2. **Ensure the folder** — `git check-ignore -q .claude/fnd || echo '.claude/fnd/' >> "$(git rev-parse --git-common-dir)/info/exclude"`
   (the common dir, not `.git/`: the exclude file is shared and a linked worktree's `.git` is a file),
   then create `.claude/fnd/<work-id>/` if absent. Merge into existing files — don't blow away
   earlier entries.
3. **Write what the conversation holds** (verbatim, per the reference):
   - ticket fields you actually have → `ticket.md` / `ticket-<KEY>.md` (stamp `fetched_at`, and
     record `jira_updated` when the ticket's updated timestamp appeared in the conversation —
     without it every later freshness check degrades to a full re-read; if it never appeared,
     note that gap in the file; a field you never saw stays absent and is listed as a gap);
   - Figma build specs → `figma-<node-id>.md`;
   - an approved plan / QA checklist + report / Steps to Test produced this session →
     `plan.md` / `qa.md` / `steps-to-test.md`;
   - decisions, gotchas, and — per bug — root cause, fix summary, how it was verified → dated
     entries in `notes.md`;
   - where the work stands → `progress.md` (series rows for a single ticket; ticket rows plus
     the shared `pre-commit-review → commit → write-steps-to-test → create-pull-request` tail
     for a batch).
4. **Report** — one compact list: files written, one line on what each holds, and the known
   gaps (e.g. "ELC-302 AC never fetched"). Offer — don't run — a `jira-reader` fetch for gaps
   worth filling.

Never store secrets or raw payloads. Scratch files created while working belong in
`.claude/fnd/<work-id>/tmp/`, not the project root.
