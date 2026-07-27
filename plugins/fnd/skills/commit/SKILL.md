---
name: commit
description: Create git commits per the Conventional Commits spec. Use when the user asks to commit changes, write a commit message, or run git commit.
allowed-tools: Bash(git status*), Bash(git diff*), Bash(git add*), Bash(git commit*), Bash(git log*), Bash(git ls-files*), Read, Glob, Grep, Edit
---

# Commit

Create commits that follow [Conventional Commits](https://www.conventionalcommits.org/).

**Message format** — the rules, types table, subject/body guidance, examples, and
breaking-change syntax live in `${CLAUDE_PLUGIN_ROOT}/references/commit-message-format.md`.
Read it before drafting.

## Rules

- **Always ask for permission before running `git commit`.** Show the proposed message first and wait for explicit confirmation.

## Review gate (before committing)

`commit` does **not** run the hygiene review itself — it only ensures one happened. The
rule below is complete — the full flow lives in
`${CLAUDE_PLUGIN_ROOT}/references/review-flow.md`; read it only if the marker semantics
are unclear:

- Read `.git/.fnd-review`. **No marker for this branch** → offer to run
  `/fnd:pre-commit-review` first; proceed if the developer declines.
- **Marker exists** → continue; don't re-run a review unprompted.

(Your own untracked-file check in step 2 still runs regardless.)

## Workflow

1. Run `git status` and `git diff --staged` (and `git diff` for unstaged) to see what's being committed.
2. **Check for untracked referenced files** — cross-check `git status --porcelain | grep '^??'`
   (or `git ls-files --error-unmatch <path>`) against references in the diff; a referenced file
   that exists on disk but is untracked → `git add` it so it ships with the commit.
3. Pick the `type` from the dominant change.
4. **If a task/ticket is in the conversation context (e.g. ELC-61), ask the user:**
   > "Add the task as scope — e.g. `feat(ELC-61): <message>`? Or commit without it?"
   Only use the ticket as scope after the user confirms.
5. Draft the message per the format reference. Include a body unless the change is trivial.
6. Show the full message to the user and ask for permission to commit.
7. On approval, commit. Use a HEREDOC for multi-line messages:

   ```bash
   git commit -m "$(cat <<'EOF'
   feat(ELC-61): add region selector to header

   Auto-opens the dropdown when the visitor's IP resolves to an
   unsupported shipping region.
   EOF
   )"
   ```

## Next in the series

Ticket with a task workspace → close out its `commit` row per `${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md` → Progress tracking; next is normally `/fnd:write-steps-to-test <ticket>`, or `/fnd:create-pull-request <ticket>` when steps-to-test is already ticked or N/A and the branch has no open PR; **offer only; never auto-run**.
