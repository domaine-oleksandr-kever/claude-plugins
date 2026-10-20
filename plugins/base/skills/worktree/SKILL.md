---
name: worktree
description: >
  Set up or tear down an isolated git worktree with its own checkout, branch and dev port. Use when
  the user asks to create or remove a worktree, or to work in parallel without tying up the main
  checkout.
argument-hint: "<WORK-ID> [base-branch] [--branch <name>] | --remove <WORK-ID> [--force]"
arguments:
  - name: work_id
    description: Jira ticket key (ABC-206), a ticket key with a kebab-case suffix (ABC-206-badge-style) or a kebab-case slug (header-refactor). The full id names the worktree directory and the default branch; the task workspace is the ticket key (or the slug). Infer from the conversation when omitted; ask if ambiguous.
  - name: base_branch
    description: Branch the worktree's branch starts from; `origin/release/2.4.0` and `release/2.4.0` are the same. Optional — the script's default is `develop`.
  - name: branch
    description: --branch <name> replaces `feat/<WORK-ID>` — an existing local or origin branch is checked out, a new name is created from the base. Optional.
  - name: remove
    description: --remove tears the worktree down; --force additionally discards a dirty tree. Optional.
allowed-tools: Read, Glob, Bash(${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup.sh*)
---

# Worktree (create / remove)

A thin wrapper over `${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup.sh`. Run it from the project repo
root. The script owns every decision — worktree directory, branch reuse, `npm ci`, the copies of the
gitignored files, the `.claude/tasks` symlink back to the main checkout, the free dev port, the
hand-off block. This skill resolves the work-id and the copy list, runs the script, and relays what it
printed.

> **This session stays in the main checkout.** A session cannot relocate itself into a new worktree —
> the worktree needs its own terminal and its own `claude`. Never `cd` into the worktree and keep
> working here; hand the developer the launch block instead.

## The copy list

A fresh checkout lacks the gitignored files the work needs. The script copies the ones it is told to,
from the main checkout into the worktree, once (a copy, never a link; a re-entry keeps the worktree's
own):

- **`.env`, always** — base's fetchers (`jira-attachments.sh`, `figma-rest.sh`) read their
  credentials from the project's `./.env`.
- **`shopify.theme.toml`, with or without a `--copy`** — the script copies it itself when the main checkout has
  one git does not track (a tracked one is in the checkout already).
- **The team plugin's list** — a team plugin whose work needs more names it in its system-prompt
  section with exactly one line:

  ```text
  worktree copy list: <path>[, <path>…]
  ```

  Paths are relative to the repo root, files or directories, separated by `, `. Take every path from
  that line verbatim; never add one the line does not name, never invent one when no line is present.

Each path becomes one `--copy <path>` argument. The script refuses a path that leaves the checkout
(`/…`, `..`), names `.git`, `.claude`, the shared `.claude/tasks` or `.claude/settings.local.json`
(the script copies that one itself).

## Steps

0. **A worktree only when one was asked for.** The developer said "worktree" (or asked to work in
   parallel without tying up this checkout). A request for a branch — "a branch from
   release/2.4.0", "switch to feat/x" — is a branch, not a worktree: say so in one line and stop;
   never create a worktree for it.
1. **Resolve `<WORK-ID>`.** A Jira key when one is in play (argument, conversation, or the current
   branch), optionally with a kebab-case suffix the developer gave (`ABC-123-badge-style`);
   otherwise a kebab-case slug for the work (`header-refactor`). State the resolved id in one
   line when it was inferred rather than passed. Ambiguous → ask; never invent a key.
2. **Run** `${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup.sh <WORK-ID> [<base-branch>] --copy .env [--copy <path>]… [--branch <name>]`.
   Pass `--branch` only when the developer named the branch.
   It is idempotent — re-running on an existing worktree re-prints the hand-off, and its `kept=` line
   names the copies the worktree already had.
3. **Relay verbatim.** Print the script's output, above all the hand-off block (the `cd … && claude`
   line and the dev port) — the developer pastes it, so do not paraphrase, re-wrap, or "improve" the
   paths. The reply always names the worktree path (`worktree=`) and its branch (`branch=`). Name
   any `missing=` path in one line: the main checkout has no such file to copy.
4. **Then the team plugin's steps**, when its section names any for a new worktree (a per-worktree
   config to adjust, a preview to create): they run after this one, from the team plugin's own skill.
5. **Remove:** `worktree-setup.sh --remove <WORK-ID>`. A refusal on a dirty tree is a real answer —
   report its `dirty=` line and ask before re-running with `--force`. A copied file still identical
   to the main checkout's never counts as dirty; an edited copy, a new file under a copied directory
   and anything under a `kept=` path do. The task workspace (`.claude/tasks/<ticket key or slug>/`) lives in the main checkout and survives
   removal; so does the branch.

## Inside the worktree

- `.claude/tasks` is a link to the main checkout's: both sessions read and write one workspace, and
  band's checklist follows it. Write through the link; never replace it with a directory.
- The worktree's `.claude/settings.local.json` lists the main checkout's `.claude/tasks` in
  `permissions.additionalDirectories` (`tasks_dir_allowed=added|present`), so a write through the link
  no longer counts as outside the working directories: in auto mode it goes to the classifier like any
  `.claude/` write, and Manual or accept-edits mode still asks, as in the main checkout. A
  `warn=settings_local_…` line means the entry is missing: relay it, and the developer adds the path
  to `additionalDirectories` by hand (an allow rule does not help: `.claude` is a protected path).
- Screenshots and other scratch from the browser tools go under `.claude/tmp/<WORK-ID>/` of the
  worktree, not into the shared workspace's `tmp/` — base's scratch-path guard names the path when it
  refuses one.
- The dev server starts on the port the hand-off names (recorded as `dev-port:` in the workspace's
  `notes.md`).

Any `error=` line from `worktree-setup.sh` → report it plainly and stop. Do not work around it with raw
`git worktree` commands — the guards exist because the failure they name is real.
