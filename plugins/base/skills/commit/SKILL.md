---
name: commit
description: Create git commits per the Conventional Commits spec. Use when the user asks to commit changes, write a commit message, or run git commit.
allowed-tools: Bash(git status*), Bash(git diff*), Bash(git add*), Bash(git commit*), Bash(git log*), Bash(git ls-files*), Bash(git rev-parse*), Bash(git hash-object*), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/review-scope.sh*), Bash(grep*), Read, Glob, Grep, Edit
---

# Commit

Create commits that follow [Conventional Commits](https://www.conventionalcommits.org/).

**Message format** — the rules, types table, subject/body guidance, examples and breaking-change
syntax live in `${CLAUDE_PLUGIN_ROOT}/references/commit-message-format.md`. Read it before drafting.

## Rules

- **Commit directly — no preview, no permission ask.** Invoking this skill (`/base:commit`) *is* the
  authorization: draft the message and run `git commit` immediately, then report the created commit
  (hash + full message) so the developer can `git commit --amend` if the wording needs a tweak. Only
  the review gate below and step 4's ticket-scope ask may still block.
- base's guards deny an AI co-author trailer or a "Generated with" line in the message, and any
  bypass of the project's git hooks (`--no-verify`, `-n`, a `core.hooksPath` override). Write the
  message without them; a hook that fails is a finding to fix, not to skip.

## Review gate (before committing)

`/base:commit` commits only a reviewed tree. It does not review itself; the marker semantics live in
`${CLAUDE_PLUGIN_ROOT}/references/review-flow.md` §1 (read it only if this block is unclear):

- Run `${CLAUDE_PLUGIN_ROOT}/scripts/review-scope.sh --check` (add `--ws .claude/tasks/<work-id>`
  when a task workspace exists). It prints one line, `marker=<verdict> branch=… marker_branch=…
  diff_hash=… marker_hash=…`; the verdict alone decides:
  - **`fresh`** (the marker's branch and `diff_hash` match) → continue; don't re-run a review.
  - **`none`, `other-branch` or `stale`** → **do not commit yet.** Say in one line that the tree is
    unreviewed and you are running `/base:pre-commit-review` first, then run it. Another branch's
    marker counts as no marker; never edit or delete it here. When the review ends, re-run
    `--check`: `fresh` → continue to the workflow below; anything else (the developer chose skip or
    rejected the plan) → stop without committing, and name the bypass below.
- **The only bypass:** the developer, in this same turn, asks you to skip the review with the
  phrase **"commit without review"** as their own request. Then say in one line "Committing without
  a review, as asked." and go straight to the workflow; the marker stays as it is. The phrase
  negated ("don't / never commit without review") or quoted from elsewhere is not a bypass — it
  asks for the review. Neither is a "skip" in the review's ask, or the phrase in an earlier turn.
- **Re-stamp around the commit** — just before step 6 re-run `--check`; `marker=fresh` → refresh the
  marker after the commit succeeds, per review-flow.md §1 → *Re-stamp after a commit whose hooks
  rewrote the tree* (that block is the full rule). Why: husky / lint-staged reformat files during
  `git commit`, drifting the hash so a PR skill's correctness backstop re-runs `base:bug-hunter`
  over identical code. Any other verdict **before** the commit (the bypass) → no re-stamp.

(Your own untracked-file check in step 2 still runs regardless.)

## Workflow

1. Run `git status` and `git diff --staged` (and `git diff` for unstaged) to see what's being committed.
   Snapshot `git status --porcelain` and store the working-copy blob of each path whose second
   column is `M`: one `git hash-object -w -- <path…>` call.
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
   with step 1's snapshot. A tracked path whose second column was blank in step 1 (clean, or fully
   staged) and is modified now was rewritten by the repo's hooks (a pre-commit build, a formatter):
   list it under the report, say the hooks changed it, and for a file the build owns (a build
   artifact) offer `git checkout -- <file>` — never restore it, and never stage it, without the
   developer's yes. A path whose second column was `M` in step 1 (` M`, `MM`, `AM`, `RM`) holds
   unstaged work: list it only when `git hash-object` now differs from its step-1 blob, or it is
   clean now — say the hooks rewrote it, show `git diff <file>` and the step-1 blob id
   (`git cat-file -p <blob>` gets that version back), and never offer a restore.

## Next

With a task workspace, close out its `commit` row in `progress.md` per
`${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md` → Progress tracking. The next step is the team
plugin's (its series names it); **offer only, never auto-run**.
