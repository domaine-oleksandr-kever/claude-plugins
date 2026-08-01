---
name: worktree
description: >
  Set up — or tear down — an isolated `git worktree` so a run gets its own checkout, branch,
  and dev port instead of occupying the main repo. Use when the user asks to create / set up
  a worktree (for a ticket key or a slug), to work on something in parallel without tying up
  the main checkout, or to remove / clean up a worktree.
argument-hint: "<WORK-ID> [base-branch] | --remove <WORK-ID> [--force]"
arguments:
  - name: work_id
    description: Jira ticket key (ELC-206) or a kebab-case slug (header-refactor) — the same work-id the task workspace uses. Infer from the conversation when omitted; ask if ambiguous.
  - name: base_branch
    description: Branch the worktree's `feat/<WORK-ID>` starts from. Optional — the script's default is `develop`.
  - name: remove
    description: --remove tears the worktree down; --force additionally discards a dirty tree. Optional.
allowed-tools: Read, Glob, Bash(${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup.sh*)
---

# Worktree (create / remove)

A thin wrapper over `${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup.sh`, run from the client
theme repo root. The script owns every decision — worktree directory, branch reuse, `npm ci`,
the gitignored config copies (`shopify.theme.toml`, `.env`), the `.claude/fnd` symlink back to
the main repo, the free dev port, the hand-off block. This skill resolves the work-id, runs the script, and relays what it printed.

> **This session stays in the main checkout.** A Claude session cannot relocate itself into a
> new worktree — it needs its own terminal and its own `claude`. Never `cd` into the worktree
> and keep working here; hand the developer the launch block instead.

## Steps

1. **Resolve `<WORK-ID>`.** A Jira key when one is in play (argument, conversation, or the
   current branch); otherwise a kebab-case slug for the work (`header-refactor`). State the
   resolved id in one line when it was inferred rather than passed. Ambiguous → ask; never
   invent a key.
2. **Run** `${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup.sh <WORK-ID> [<base-branch>]`. It is
   idempotent — re-running on an existing worktree just re-prints the hand-off.
3. **Relay verbatim.** Print the script's output, above all the hand-off block (the `cd … &&
   claude` line, the follow-up slash command, and the dev port) — the developer pastes it, so
   do not paraphrase, re-wrap, or "improve" the paths. Close with the reminder above: new
   terminal, new session.
4. **Remove:** `worktree-setup.sh --remove <WORK-ID>`. A refusal on a dirty tree is a real
   answer — report it and ask before re-running with `--force`. The task workspace
   (`.claude/fnd/<WORK-ID>/`) lives in the main repo and survives removal; a preview theme
   created from the worktree is not the script's business.

Any `error=` line → report it plainly and stop. Do not work around it with raw
`git worktree` commands — the guards exist because the failure they name is real.

## Quality bar

- The hand-off block reaches the developer character-for-character.
- No behavior reimplemented here: one script call per request, nothing else mutates the repo.
- Never suggest continuing the current session inside the new worktree.
