---
name: create-pull-request
description: >
  Open a GitHub Pull Request with a Domaine-standard description built from the Jira ticket,
  Technical Approach, and branch diff, including the theme-preview table — Workflow 6.
  Use when the user asks to open / create / draft a pull request or PR.
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

Series position: Workflow 6 — the final step, after `develop-feature-or-fix` and `qa-feature-or-fix`.
Inputs — infer from the conversation first, ask only what can't be inferred: **Jira ticket(s)** (`jira_ticket` — one key or several); **target branch** (usually `develop` — confirm against Git Flow); optional `preview_path`; optional theme triplet `theme_name` / `theme_url` / `theme_admin_url` — passing all three skips auto-creation (REFERENCE.md → Preview theme, "Args win"), omitting them falls to the workspace's recorded `session-theme: <id>` and only then to auto-creation in step 4, and their rows are omitted from the body when nothing is provided, recorded, or created.
Operating mode: **Phase 1 in plan mode** (ingest, diff, draft title + body); leave plan mode after the developer approves the draft.

## Global rules

- The developer owns branches, merges, reviewers, and Jira updates; you assist.
- **Never proceed past a ✋ checkpoint** without explicit developer confirmation.
- Use **Atlassian MCP** to read (and optionally update) Jira.
- **No GitHub MCP** in the toolchain. Prefer **`gh`** when installed and authenticated; otherwise produce a **paste-ready** title + body and a **compare URL** for manual creation.
- This repo may not define `.github/pull_request_template.md`. Use the body structure in `create-pull-request/REFERENCE.md`; if a GitHub template exists, keep its headings but the reference's core skeleton and readability budget still govern — empty template headings are left out.

---

## Phase 1 — Analysis & preparation `[plan mode]`

1. **Ingest the Jira ticket(s)** — context-first per `${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md`; a multi-ticket PR uses the branch-slug workspace with one `ticket-<KEY>.md` per ticket (`notes.md` holds per-bug root causes and preview-theme breadcrumbs). Fetching → **one `jira-reader` per key, in parallel**, each passed the workspace path so it writes its own file; merge the returned fields. This skill needs: Description, AC, **Technical Approach**, links (TA and AC feed the review gate and the diff cross-check — they are **not** emitted into the body; Steps to Test isn't needed at all, it lives in the ticket). `needs_clarification` → ask the developer.
2. **Analyse the implementation** — after the developer approves shell usage, inspect read-only: `git status`, `git log --oneline`, `git diff <target>...HEAD --stat` and `--name-status` (the review agents below read the full diff in their own contexts — pull specific hunks here only where the body draft needs detail the TA/notes don't carry). List files created / modified / deleted. Cross-reference against the TA and AC; note gaps, intentional deviations, out-of-scope items.

   **Review gate** — run the fnd review flow (`${CLAUDE_PLUGIN_ROOT}/references/review-flow.md`, read it now; its §3 create-pull-request entry governs) with **`conformance`** emphasis: first review on this branch → spawn `change-reviewer` over the diff (small → one agent; large → one per file-group, in parallel) and surface its findings table; already reviewed → the §3 ask. A `protected-core` blocker **stops the PR** until resolved or explicitly waived. **Correctness backstop — NOT subject to the skip ask:** marker `correctness_hash` absent or ≠ the current diff hash → spawn **`bug-hunter`** over the diff (in parallel; pass the `base` + the workspace `notes.md` `ceiling:` entries) and disposition every finding per `review-flow.md → Correctness findings` — a **blocker** stops the PR like `protected-core`; current → say so in one line. Refresh the marker (incl. `correctness_hash`) after.
3. **PR metadata** — propose a title per **REFERENCE.md → Title convention** (`[ELC-XX][Type] …`; multiple tickets → one bracket, slash-separated). Confirm the target branch. Capture linked tickets / blocks / related PRs.
4. **Preview theme** — populate the theme-preview table by **following `create-pull-request/REFERENCE.md` → Preview theme** (read it now — it owns the decision flow, naming, and the `--reuse` default; `error=` meanings + page deep-link formulas live in `${CLAUDE_PLUGIN_ROOT}/references/preview-theme-errors.md`). Precedence in one line: explicit args → the workspace `notes.md` `session-theme: <id>` (**refresh** it, this work stream already has a theme) → auto-create. Two escalation deltas: `error=build_failed` → surface the build output and **stop** (fix the branch, don't enter theme URLs); `error=settings_drift` → **don't retry auto-creation**, follow the errors reference's duplicate-manually recovery. Deep-links when a storefront path is known (`preview_path` or inferable); unsure → **ask — don't guess**. To redeploy after a later fix: the `preview-theme` skill (refresh).
5. **Draft the PR description** — build the body per **`create-pull-request/REFERENCE.md` → Body sections**: the four-section core skeleton (**Summary → Jira ticket(s) → Theme preview table directly under the Jira link → Changes** — holds even under a repo PR template), then conditional sections **only where real content exists** — no "None"/"N/A" placeholders, whole body readable in under a minute. **Named ceilings** (`notes.md` `ceiling:` entries plus justified correctness findings) appear in the body as **one line each** — an unnamed intentional simplification reads as a bug to reviewers and bots; placement per the reference.

### ✋ Checkpoint — Phase 1

Present the **draft title**, **target branch**, proposed **reviewers/labels**, and the **full body** for the developer to edit and approve. **Stop** until confirmed.

---

## Phase 2 — PR creation

1. **Create the PR** (after explicit confirmation):
   - **Preferred:** `gh pr create` with the approved title and body (`--body-file` for long bodies), `--base <target>` / `--head <branch>`, `--draft` if requested.
   - **Fallback:** provide the exact markdown title + body to paste, plus the compare URL `https://github.com/<owner>/<repo>/compare/<base>...<head>` (derive `<owner>/<repo>` from `git remote get-url origin`).
2. **Link PR to Jira** — ask whether the developer adds the PR URL manually, or you update the ticket via Atlassian MCP.
3. **Final confirmation** — share the PR URL; note remaining actions (reviewers, labels, mark ready, merge blockers).

## Quality bar

- Description traceable to **AC** and **TA**.
- Diff summary accurate — no phantom files, no missing risk notes.
- Body readable in **under a minute**; no empty sections, no filler — evidence lives in the ticket / workspace / a PR comment, not the body.
- No secrets or internal-only credentials in the PR body.

## Next in the series

Close out per `${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md` → Progress tracking (status: the PR URL); next is `/fnd:write-steps-to-test <ticket>` if the ticket's Steps to Test field is still empty, else the series is complete; **offer only; never auto-run**.
