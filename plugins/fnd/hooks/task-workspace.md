## Foundation convention — task workspace (per-ticket memory)

When work is tied to a Jira ticket (key in the conversation or branch name):

- **Read first.** If `.claude/tasks/<work-id>/` exists (`<work-id>` = ticket key, or branch
  slug for a batch), read it before re-asking or re-fetching: `progress.md` says where the
  work stands — report it and offer the next unchecked step; `notes.md` holds decisions and
  gotchas.
- **Write as you go** — reader outputs, doc extracts, approved plans, decisions → the
  workspace, so `/compact` and new sessions lose nothing. `progress.md`: one `- [ ]`/`- [x]` row
  per step (skill run, Jira write, PR, preview theme), never two steps in one; detail after
  `—` or in `notes.md`, never sub-bullets.
- **Placement:** scratch (test scripts, drafts, dumps) → `.claude/tasks/<work-id>/tmp/`;
  durable artifacts → workspace root — never the project root or `docs/`.
  In a worktree, screenshots go to `.claude/tmp/<work-id>/`.
  Details, freshness: `references/task-workspace.md`.
- No workspace on non-trivial ticket work → offer `save-task-context` once
  (on Claude Code, `/fnd:save-task-context`).
