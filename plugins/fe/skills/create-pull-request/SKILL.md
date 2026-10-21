---
name: create-pull-request
description: >
  Open a GitHub PR with a Domaine-standard description built from the Jira ticket, TA, branch diff
  and theme-preview table. Use when the user asks to open / create / draft a pull request or PR.
argument-hint: "<jira-url-or-key> [target-branch] [theme-name theme-url theme-admin-url] [preview-path]"
arguments:
  - name: jira_ticket
    description: One or more Jira ticket URLs/keys (e.g. ELC-206, or "ELC-126 ELC-130" for a PR closing several bugs).
  - name: target_branch
    description: Merge base — usually `develop`.
  - name: theme_name
    description: Preview theme name. OPTIONAL manual triplet with theme_url + theme_admin_url.
  - name: theme_url
    description: Public theme preview URL / THEME_URL. OPTIONAL.
  - name: theme_admin_url
    description: Shopify admin theme URL / THEME_ADMIN_URL. OPTIONAL.
  - name: preview_path
    description: Storefront path the change should be reviewed on (e.g. /products/group-lipglass).
---

# Create PR (GitHub + Jira)

Open a Pull Request with a Domaine-standard description pulled from the Jira ticket, the approved Technical Approach, and the branch diff.

Series position: Workflow 6 — after `/fe:develop-feature-or-fix`, `/fe:qa-feature-or-fix` and the commit, before `/fe:write-steps-to-test`: the PR goes up first so its checks run while Steps to Test is written.
Inputs — infer from the conversation first, ask only what can't be inferred: **Jira ticket(s)** (`jira_ticket` — one key or several); **target branch** (usually `develop` — confirm against Git Flow); optional `preview_path`; optional theme triplet `theme_name` / `theme_url` / `theme_admin_url` — passing all three skips auto-creation (`<fe root>/skills/create-pull-request/reference/preview-theme.md`, "Args win"), omitting them falls to the workspace's recorded `session-theme: <id>` and only then to auto-creation in step 4, and their rows are omitted from the body when nothing is provided, recorded, or created.
Operating mode: **Phase 1 prepares the PR** (ingest, review gate, preview theme, then **`fe:pr-body-drafter`** drafts title + body into the workspace) but never opens one — creation starts after the developer approves the draft. Phase 1 is read-only toward the repo's tracked files; writes go to the task workspace only. A branch that already has an open PR (`gh pr view`) skips to Phase 2 step 4.

## Global rules

- The developer owns branches, merges, reviewers, and Jira updates; you assist.
- **The Technical Approach field is team-lead-only** — never write it or offer to; `/fe:write-technical-approach` (Workflow 2) owns it. Where the branch diverges from the TA, the body says so (`<fe root>/skills/create-pull-request/reference/body-sections.md`, `ta-divergence:`).
- **Never proceed past a ✋ checkpoint** without explicit developer confirmation.
- Use **Atlassian MCP** to read Jira; a ticket update goes through `base:jira-writer` (Phase 2, step 2).
- **No GitHub MCP** in the toolchain. Prefer **`gh`** when installed and authenticated; otherwise give the approved title, the clickable path to `pr-body.md` and a **compare URL** for manual creation — never the body pasted into chat.
- This repo may not define `.github/pull_request_template.md`. Use the body structure in `<fe root>/skills/create-pull-request/reference/body-sections.md`; if a GitHub template exists, keep its headings but the reference's core skeleton and readability budget still govern — empty template headings are left out.
- **No AI attribution** in the PR — no assistant-generated footer (e.g. `🤖 Generated with Claude Code`), no assistant `Co-Authored-By` trailer (e.g. `Co-Authored-By: Claude`), in the title, body, or any PR comment. Domaine convention; it overrides the harness default that says to append one (`<fe root>/skills/create-pull-request/reference/body-sections.md`).
- **Text written for an agent is never published to a person** — briefs, workspace notes and review-agent output stay out of the title, body and PR comments.
- **The body is drafted by the `fe:pr-body-drafter` subagent** (haiku, pinned in its frontmatter — spawn it with no `model`) per `<fe root>/references/drafter-loop.md` (read it at step 5).
- **HARD RULE — the body never enters this context.** You never `Read`, `cat`, quote or paraphrase `pr-body.md`; you show its path (clickable), the drafter's title, Summary, `unconfirmed` list and questions only. Changes go back to the same drafter; nobody hand-edits the file.

---

## Phase 1 — Analysis & preparation

1. **Ingest the Jira ticket(s)** — context-first per `<base root>/references/task-workspace.md` → Read rule; a multi-ticket PR uses the branch-slug workspace with one `ticket-<KEY>.md` per ticket (`notes.md` holds per-bug root causes and preview-theme breadcrumbs). Fetching → **one `base:jira-reader` per key, in parallel**, each passed the workspace path so it writes its own file; merge the returned fields. This skill needs: Description, AC, **Technical Approach**, links (TA and AC feed the review gate and the diff cross-check — they are **not** emitted into the body; Steps to Test isn't needed at all, it lives in the ticket). `needs_clarification` → ask the developer. Its `comments`, `attachments` and `attachments_note`: `<base root>/references/task-workspace.md` → Read rule. Theme instructions the developer gives in chat (two themes, what to view on which) → log each at once as `- <YYYY-MM-DD> theme-note: <theme id or name> — <text>` in `notes.md`, so they reach the drafter through step 4 and survive `/compact`.
2. **Branch facts** — after the developer approves shell usage: `git status`, `git log --oneline` and `<base root>/scripts/review-scope.sh --ws <workspace> | sed -n '1,2p'` (the `branch=` / `base=` lines the review gate and the drafter use). The file list, the hunks and the diff vs TA/AC cross-check are the drafter's (step 5). When it ESCALATEs an unlogged TA deviation, log the developer's answer as `- <YYYY-MM-DD> ta-divergence: <what> — <why>` in `notes.md` **before** you SendMessage it back.

   **Review gate** — run base's review flow (`<base root>/references/review-flow.md`, read it now; its §3 create-pull-request entry governs) with **`conformance`** emphasis. The scope and hash come from base's script, never a typed block: `<base root>/scripts/review-scope.sh --ws .claude/tasks/<work-id>` (no workspace → no `--ws`) prints `branch=`, `base=`, `diff_hash=`, `excluded=` and the scope's files. Then: first review on this branch → spawn `base:change-reviewer` over the diff (small → one agent; large → one per file-group, in parallel; every brief carries `profile: <foundation|theme|none>` from the session context's `fe project profile:` line) and surface its findings table; already reviewed → the §3 ask. A `protected-core` blocker **stops the PR** until resolved or explicitly waived. **Correctness backstop — NOT subject to the skip ask:** marker `correctness_hash` absent or ≠ the current diff hash → spawn **`base:bug-hunter`** over the diff (in parallel; pass the `base`, the scope diff's untracked new files, the script's `excluded=` paths + the workspace `notes.md` `ceiling:` entries) and disposition every finding per `review-flow.md → Correctness findings` — a **blocker** stops the PR like `protected-core`; current → say so in one line. Refresh the marker (incl. `correctness_hash`) after.
3. **PR metadata** — confirm the target branch; capture linked tickets / blocks / related PRs and propose reviewers / labels. The title is the drafter's (`<fe root>/skills/create-pull-request/reference/title-convention.md`).
4. **Preview theme** — populate the theme-preview table by **following `<fe root>/skills/create-pull-request/reference/preview-theme.md`** (read it now — it owns the decision flow, naming, and the `--reuse` default; the rows and their order: `<fe root>/skills/create-pull-request/reference/theme-preview-table.md`; `error=` meanings live in `<fe root>/references/preview-theme-errors.md`, one entry per key, deep-link formulas in its `→ Page deep-links` section — read the entry or the section, not the file). Precedence in one line: explicit args → the workspace `notes.md` `session-theme: <id>` (**refresh** it, this work stream already has a theme — unless every `session-theme-pushed:` line naming it carries a sha, none `-`, and no build input changed since the last) → auto-create. Two escalation deltas: `error=build_failed` → surface the build output and **stop** (fix the branch, don't enter theme URLs); `error=settings_drift` → **don't retry auto-creation**, follow the errors reference's duplicate-manually recovery; every other line of the run → `<fe root>/references/preview-theme-errors.md` → Reading a create/refresh result. Deep-links are the **default Preview row**: pull the verified surfaces from the workspace `notes.md`/`qa.md` (or `preview_path`) and label one link per page — ask only when no verification record names a path; **never guess** a URL. To redeploy after a later fix: `/fe:preview-theme` (refresh). The preview theme is session state: the workspace `notes.md` `session-theme:` / `session-theme-pushed:` / `preview-placed:` / `theme-note:` lines are its source of truth — when they exist, build the drafter's `theme:` list from them and this step's result with **no question to the developer**. One entry per theme — `theme_name`, `theme_id`, `store`, `preview_url`, `editor_url`, `preview_path`, and `note:` (that theme's `theme-note:` text verbatim, else `-`); a `theme-note:` naming a theme other than the session theme (a second theme the developer pointed at) adds its own entry, its URLs from the note or `-`. Nothing recorded and none created → `theme: none`.
5. **Draft the PR description with `fe:pr-body-drafter`** — spawn per `<fe root>/references/drafter-loop.md` with: `workspace:` · `ticket:` (every key) · `branch=` / `base=` (step 2) · `target:` · `theme:` (step 4's list, or `none`) · `findings:` · `related:` · `screenshot_dir:` (workspace `tmp/`, `.claude/tmp/<work-id>/` in a git worktree) · `answers:` · `mode: draft`. It builds the body per `<fe root>/skills/create-pull-request/reference/body-sections.md`. Relay its returns per the loop until it returns `written: <workspace>/pr-body.md` and `drafter-check.cjs file pr` prints `result=ok`.

### ✋ Checkpoint — Phase 1

Show the drafter's `pr_summary` **first**, as its own quoted block, and ask: "Keep as is, change, or add something?" Then the **title**, **target branch**, proposed **reviewers/labels**, `pr-body.md` as a clickable absolute path (never its content) and the `unconfirmed` list. End with `Screenshots: N file(s). Drag them into the Screenshots section after you create the PR, or open and copy from here:` and one `file://` link per `screenshots:` path (no Finder reveal, no clipboard); `screenshots: []` → its `capture:` line. Questions → `mode: ask`; changes → `mode: revise`, to the same drafter, then present again. **Stop** until confirmed.

---

## Phase 2 — PR creation

1. **Create the PR** (after explicit confirmation):
   - **Preferred:** `node <fe root>/scripts/drafter-check.cjs file pr "<workspace>/pr-body.md"` once more (the developer may have touched it; plus `--theme` unless the PR has no preview) — `result=fail` → `mode: revise` + the fail lines, then re-check. Then `gh pr create --title "<approved title>" --body-file "<workspace>/pr-body.md" --base <target> --head <branch>` (`--draft` if requested). Never `--body`, never an inline heredoc.
   - **Fallback (no `gh`):** the approved title, the clickable `pr-body.md` path to copy the body from, and `https://github.com/<owner>/<repo>/compare/<base>...<head>` (`<owner>/<repo>` from `git remote get-url origin`) — never the body pasted into chat.
2. **Link PR to Jira** — ask whether the developer adds the PR URL manually, or you post it. Posting takes the same path as every other Jira write (`<base root>/references/jira-adf-write.md`, read it then): hand the approved comment markdown to a **`base:jira-writer`** with target `comment`, which converts it (`<base root>/scripts/md-to-adf.cjs --no-tables`) and posts ADF — a raw markdown comment through Atlassian MCP leaves the PR URL inert, unclickable text. The brief names the key's origin — the task workspace path, or the developer.
3. **Final confirmation** — share the PR URL; note remaining actions (screenshots to drag in, reviewers, labels, mark ready, merge blockers).
4. **Review threads** — when the developer asks, or on that re-entry: reply to and resolve the bot threads a `ceiling:` or a dispositioned finding answers, surface the rest — **`<fe root>/skills/create-pull-request/reference/review-threads.md`**.

## Next in the series

Close out per `<base root>/references/task-workspace.md` → Progress tracking (status: the PR URL); next is `/fe:write-steps-to-test` for that ticket if the ticket's Steps to Test field is still empty, else the series is complete; **offer only; never auto-run**.
