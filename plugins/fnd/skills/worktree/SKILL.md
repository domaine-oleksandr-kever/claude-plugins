---
name: worktree
description: >
  Set up — or tear down — an isolated `git worktree` so a run gets its own checkout, branch,
  dev port, and preview theme instead of occupying the main repo. Use when the user asks to create / set up
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
allowed-tools: Read, Glob, Edit, AskUserQuestion, Bash(${CLAUDE_PLUGIN_ROOT}/scripts/worktree-setup.sh*), Bash(${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh*), Bash(cd:*)
---

# Worktree (create / remove)

A thin wrapper over `<plugin root>/scripts/worktree-setup.sh`, where **plugin root** = the
plugin's own directory — `../../` relative to this skill's directory — and every
`<plugin root>/…` path below resolves the same way; on Claude Code it is `${CLAUDE_PLUGIN_ROOT}` —
the host substitutes the absolute path into this text, so the path you see here is the one to write
into commands (no shell variable carries it). Run it from the client theme repo root. The script owns every decision — worktree directory, branch reuse, `npm ci`,
the gitignored config copies (`shopify.theme.toml`, `.env`), the `.claude/tasks` symlink back to
the main repo, the free dev port, the hand-off block. This skill resolves the work-id, runs the
script, relays what it printed, and — once the worktree exists — settles its **session theme**
(step 4) so the new checkout's dev server never syncs into the shared dev theme.

> **This session stays in the main checkout.** An agent session cannot relocate itself into a
> new worktree — it needs its own terminal and its own session (`claude` on Claude Code).
> Never `cd` into the worktree and keep working here; hand the developer the launch block
> instead. (Step 4's one-shot `cd <worktree> && <script>` inside a single Bash call is fine — the subshell exits with the
> command and the session's own cwd never moves.)

## Steps

1. **Resolve `<WORK-ID>`.** A Jira key when one is in play (argument, conversation, or the
   current branch); otherwise a kebab-case slug for the work (`header-refactor`). State the
   resolved id in one line when it was inferred rather than passed. Ambiguous → ask; never
   invent a key.
2. **Run** `<plugin root>/scripts/worktree-setup.sh <WORK-ID> [<base-branch>]`. It is
   idempotent — re-running on an existing worktree just re-prints the hand-off.
3. **Relay verbatim.** Print the script's output, above all the hand-off block (the `cd … &&
   claude` line, the follow-up slash command, and the dev port) — the developer pastes it, so
   do not paraphrase, re-wrap, or "improve" the paths.
4. **Session theme** (create only). The flow — including the exact question — is
   `<plugin root>/references/session-theme.md`, **the same single question
   `ship` Step 0 asks** (on Claude Code: one AskUserQuestion):
   - The shared workspace `notes.md` already records a `session-theme: <id>` line → don't ask;
     run `…/create-preview-theme.sh pin --theme <id>` (a freshly copied toml is never pinned;
     an idempotent re-run's `toml=kept` copy may already be — either way re-pinning is
     byte-idempotent) and say so in one line.
   - Otherwise offer: **create one now** (`<plugin root>/scripts/create-preview-theme.sh
     create --name "<name>" --reuse --pin-toml` — `<name>` is the derivation the PR uses,
     `info`'s `dev_theme_name` with the role prefix swapped for the key
     (`[ELC-206] Kever | Domaine`; a slug work-id is bracketed verbatim —
     `[header-refactor] Kever | Domaine` — so a later `--reuse` still matches), never a
     free-text description, or a later `--reuse` misses
     it and stacks a second theme) vs **pin an existing theme id** the developer supplies
     (`…/create-preview-theme.sh pin --theme <id>`). Record the id as a dated
     `session-theme: <id>` bullet in the shared `.claude/tasks/<WORK-ID>/notes.md` the instant
     the script returns it. A `create` that exits 0 but prints `overlay=partial` +
     `warn=overlay_file_dropped` is not a reviewable preview — the named settings files never
     landed and their pages 404 or serve stale content — and neither is a `--reuse` run printing
     `overlay=empty` + `warn=overlay_empty` (nothing overlaid, the theme keeps its previous
     settings); hand the id over with that caveat and
     `<plugin root>/references/preview-theme-errors.md`, not as a clean preview.

   Either way, run the script **with the new worktree as the working directory** — a one-shot
   `cd <worktree> && …` inside a single Bash call, whose subshell exits when the command does,
   so the session's own cwd never moves — the build must come from that branch and the pin
   must land on the
   worktree's own `shopify.theme.toml`, never the main checkout's. Then, on **both** paths,
   extend the hand-off you just relayed with the theme id, its preview/editor links when the
   script returned them, and the dev-server line `npm run dev -- --theme <id> --port <N>` with
   the id filled in — the script's own block deliberately leaves it as a placeholder. Any
   `error=` → report it, leave the worktree in place; it is usable, just unpinned. Never read
   or echo `shopify.theme.toml`. Close with the reminder above: new terminal, new session.
5. **Remove:** `worktree-setup.sh --remove <WORK-ID>`. A refusal on a dirty tree is a real
   answer — report it and ask before re-running with `--force`. The task workspace
   (`.claude/tasks/<WORK-ID>/`) lives in the main repo and survives removal; the session theme
   it recorded is not the script's business — deleting it is the developer's call.

Any `error=` line from `worktree-setup.sh` → report it plainly and stop. Do not work around it with raw
`git worktree` commands — the guards exist because the failure they name is real.

## Quality bar

- The hand-off block reaches the developer character-for-character.
- No behavior reimplemented here: the worktree script, plus the preview-theme script when the
  developer accepts the session-theme offer, are the only things that mutate anything — this
  skill only sequences them and records the id.
- Never suggest continuing the current session inside the new worktree.
