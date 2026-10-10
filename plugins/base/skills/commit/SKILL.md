---
name: commit
description: Create git commits per the Conventional Commits spec. Use when the user asks to commit changes, write a commit message, or run git commit.
allowed-tools: Bash(git status*), Bash(git diff*), Bash(git add*), Bash(git commit*), Bash(git log*), Bash(git ls-files*), Bash(git rev-parse*), Bash(git merge-base*), Bash(git show-ref*), Bash(git hash-object*), Bash(cp*), Bash(grep*), Read, Glob, Grep, Edit
---

# Commit

Create commits that follow [Conventional Commits](https://www.conventionalcommits.org/).

**Message format** — the rules, types table, subject/body guidance, examples and breaking-change
syntax live in `${CLAUDE_PLUGIN_ROOT}/references/commit-message-format.md`. Read it before drafting.

## Rules

- **Commit directly — no preview, no permission ask.** Invoking this skill (`/base:commit`) *is* the
  authorization: draft the message and run `git commit` immediately, then report the created commit
  (hash + full message) so the developer can `git commit --amend` if the wording needs a tweak. The
  only question that may still block is step 4's ticket-scope ask.
- base's guards deny an AI co-author trailer or a "Generated with" line in the message, and any
  bypass of the project's git hooks (`--no-verify`, `-n`, a `core.hooksPath` override). Write the
  message without them; a hook that fails is a finding to fix, not to skip.

## Review gate (before committing)

`/base:commit` does **not** run the review itself — it only ensures one happened. The rule below is
complete; the full flow lives in `${CLAUDE_PLUGIN_ROOT}/references/review-flow.md` (read it only if the
marker semantics are unclear):

- Read the marker at `"$(git rev-parse --git-dir)/.base-review"` (resolved, never the literal `.git/`
  path — a linked worktree's `.git` is a file). **No marker for this branch** → offer to run
  `/base:pre-commit-review` first; proceed if the developer declines.
- **Marker exists** → continue; don't re-run a review unprompted.
- **Re-stamp around the commit** — before step 6 compute the current `diff_hash` with review-flow.md
  §1's scope + hash block (it covers untracked files; a bare `git diff | git hash-object` misses
  them); if it equals the marker's, refresh the marker after the commit succeeds, per review-flow.md
  §1 → *Re-stamp after a commit whose hooks rewrote the tree* (that block is the full rule). Why:
  husky / lint-staged reformat files during `git commit`, drifting the hash so a PR skill's
  correctness backstop re-runs `base:bug-hunter` over identical code. Hashes differ **before** the
  commit → no re-stamp.

(Your own untracked-file check in step 2 still runs regardless.)

## Workflow

1. Run `git status` and `git diff --staged` (and `git diff` for unstaged) to see what's being committed.
2. **Check for untracked referenced files** — cross-check `git status --porcelain | grep '^??'` (or
   `git ls-files --error-unmatch <path>`) against references in the diff; a referenced file that
   exists on disk but is untracked → `git add` it so it ships with the commit.
3. Pick the `type` from the dominant change.
4. **If a task/ticket is in the conversation context (e.g. ABC-61), ask the user:**
   > "Add the task as scope — e.g. `feat(ABC-61): <message>`? Or commit without it?"
   Only use the ticket as scope after the user confirms.
5. Draft the message per the format reference. Include a body unless the change is trivial.
6. Commit immediately with that message — no preview, no confirmation. Stage and commit in
   **separate** Bash calls — a guard refusal blocks the whole call before either command runs, so a
   bare retry of a bundled `git add … && git commit …` commits a stale index; re-check
   `git status --short` after any refusal before committing again. Use a HEREDOC for multi-line
   messages, then report the result (`git log --oneline -1` + the full message):

   ```bash
   git commit -m "$(cat <<'EOF'
   feat(ABC-61): add region selector to header

   Auto-opens the dropdown when the visitor's IP resolves to an
   unsupported shipping region.
   EOF
   )"
   ```
7. **Files the hooks left modified.** After the commit, run `git status --porcelain` and compare it
   with step 1's `git status`: a tracked path that was clean before the commit, or went into it, and
   is modified now was rewritten by the repo's hooks (a pre-commit build, a formatter). List those
   paths under the report, say the hooks changed them, and for a file the build owns (a build
   artifact) offer `git checkout -- <file>` — never restore it, and never stage it, without the
   developer's yes. A path already modified before the commit was left out of it on purpose: never
   offer to restore it.

## Next

With a task workspace, close out its `commit` row in `progress.md` per
`${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md` → Progress tracking. The next step is the team
plugin's (its series names it); **offer only, never auto-run**.
