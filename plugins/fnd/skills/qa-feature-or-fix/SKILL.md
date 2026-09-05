---
name: qa-feature-or-fix
description: >
  Structured QA of a completed change against its Jira ticket — diff review vs TA/AC,
  approved checklist, browser-assisted checks, pass/fail report — Workflow 4. Use when the
  user asks to QA / test / verify a completed feature or fix against a Jira ticket.
argument-hint: "<jira-url-or-key> [preview-url-or-theme]"
arguments:
  - name: jira_ticket
    description: Jira ticket URL or key (e.g. ELC-206). If absent, infer it from the conversation context (ticket already discussed); ask only if it can't be inferred.
  - name: how_to_view
    description: How to view the change — preview URL, theme name, template/page path, feature flags or settings.
---

# QA Feature or Fix (Jira)

Structured QA for a completed change.

Series position: Workflow 4 — after `develop-feature-or-fix`.
Inputs (ask if missing): **Jira ticket URL or key** (`jira_ticket`); **how to view the change** (`how_to_view` — preview URL, theme name, template/page path, flags/settings).
Operating mode: **Phase 1 is ingest + analysis** (review diff vs TA/AC, build the checklist; its only writes are workspace artifacts); Phase 2 runs the checks and produces the report. On Claude Code: run Phase 1 in plan mode — that is what the `[plan mode]` marker below means.

## Global rules

- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.
- **Atlassian MCP** for Jira; **Chrome DevTools MCP** for browser validation; **Figma MCP** when comparing to designs if URLs are available. Ticket and design **reads are delegated to the `jira-reader` / `figma-reader` subagents** (raw payloads stay out of context).
- Local preview should be running for interactive checks (see `../../references/preflight-checklist.md` → Local dev server; paths like this are relative to this skill's directory, and `<plugin root>` below is that same `../../` — on Claude Code it is `${CLAUDE_PLUGIN_ROOT}`, the host substitutes the absolute path into this text, so the path you see here is the one to write into commands, no shell variable carries it) — confirm with the developer.

---

## Phase 1 — QA preparation `[plan mode]`

1. **Ingest the ticket** — context-first per `../../references/task-workspace.md`; the workspace also holds dev's test breadcrumbs in `notes.md` (pass the workspace path to the **`jira-reader`** subagent — it writes `ticket.md` itself). This skill needs: Description, AC, Technical Approach, Steps to Test, environment notes (plus `figma_urls` / `notion_urls` / `other_links`). `needs_clarification` → ask. **Read the linked docs** that define expected behaviour/data/copy **via `doc-reader`**, per `../../references/reading-linked-docs.md`; Notion MCP missing → tell the developer rather than QA'ing blind.
2. **Analyse the implementation** — review the diff (branch/PR or local — ask which source); cross-check changes against the TA and each AC.
3. **Generate the QA checklist** — rows for: each **acceptance criterion** → concrete test actions + expected results; **design conformance** vs the Figma build spec when a design is linked or its spec is already in context; **edge cases** from TA or code review; **break-it cases** (always include this group — derive the rows per `../../references/break-it-qa.md` → Deriving the rows, read it now); **accessibility** (keyboard, focus order, semantics, visible focus, contrast on critical UI); **performance** (layout shift, heavy images/scripts, critical rendering path if touched); **cross-browser / viewport** if layout-critical.

### ✋ Checkpoint — Phase 1

Present the checklist; let the developer add/remove cases. Wait for approval before Phase 2. Once approved, save the checklist to the workspace `qa.md`.

---

## Phase 2 — QA execution

1. **Automated / assisted validation** — with Chrome DevTools MCP (when preview is available): visual pass vs Figma if linked — **context-first:** reuse `figma-reader` build specs already in this conversation in full (e.g. from a `develop-feature-or-fix` run) or in the task workspace (`.claude/tasks/<TICKET>/figma-<node-id>.md`); spawn one `figma-reader` per `figma_urls` entry, in parallel, **only for specs you don't already have**, each passed the workspace path so it saves its own spec — console errors, basic performance signals (LCP/CLS context as applicable). Record **Pass / Fail / Needs review** per item with short evidence (what you checked, what you saw).
   - **Data-driven AC — exercise each configured state, don't assume it** (store access required): flip the value via `<plugin root>/scripts/shopify-admin-gql.sh` → reload → verify → **restore**, walking every enumerated/optional/conditional state; inspect the **DOM, not just the visual**; mind propagation lag (retry before calling a Fail). Full pattern: `../../references/metafield-metaobject-setup.md` → Verifying data-driven AC.
   - **Customizer-driven AC — same discipline through theme JSON** via `<plugin root>/scripts/theme-json.sh` (snapshot → `set` → reload → verify → **restore**; live theme refused). Pattern: `../../references/theme-customizer-state.md`.
   - **Break-it rows** — execute per `../../references/break-it-qa.md` → Executing the rows: hostile values through the same two state patterns (restore after), timing via throttle/races; a row that breaks the feature is a **finding** with evidence + the exact hostile value, filed blocking/non-blocking.
2. **Report findings** — summarize in a structured table or list; separate **blocking** vs **non-blocking**; suggest Jira updates (QA notes, screenshots, reopen criteria) but let the developer own ticket edits unless they ask you to use Atlassian MCP. **If you do write to a rich-text field or comment via MCP, delegate it to the `jira-writer` subagent** (ticket · the field id or `comment` · the approved markdown file) — it converts either to ADF, writes, and reads the target back, keeping the large payload out of the main context. Mechanics + when to write inline instead: `../../references/jira-adf-write.md`. Append the pass/fail outcome and confirmed findings (with their repro values) to the workspace `qa.md`, below the checklist.

## Quality bar

- Traceability from AC → test → outcome.
- Honest gaps (e.g. cannot test checkout without credentials).
- No false "pass" without basis.

## Next in the series

Close out per `../../references/task-workspace.md` → Progress tracking (status: "pass" / "2 blocking bugs"); next: all blocking checks passed → the fnd `pre-commit-review` skill (`/fnd:pre-commit-review` on Claude Code); any blocking failure → offer to fix it now and re-run this QA after; **offer only; never auto-run**.
