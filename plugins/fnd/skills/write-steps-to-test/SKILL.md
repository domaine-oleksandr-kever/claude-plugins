---
name: write-steps-to-test
description: >
  Write Steps to Test for a Jira ticket in Domaine's standard format — maps each AC to
  reproducible scenarios for a QA engineer unfamiliar with the implementation; updates the Jira
  field after approval — Workflow 5. Use when the user asks to write / draft Steps to Test or
  QA steps for a Jira ticket.
argument-hint: "<jira-url-or-key> [feature|bug]"
arguments:
  - name: jira_ticket
    description: Jira ticket URL or key (e.g. ELC-206). If absent, infer it from the conversation context (ticket already discussed); ask only if it can't be inferred.
  - name: ticket_type
    description: Whether this is a general "feature" or a "bug" ticket — the template may differ.
---

# Write Steps to Test (Jira)

Produce **Steps to Test** in Domaine's standard format.

Operating mode: **Phase 1 is ingest + analysis** (ticket + implementation context; its only writes are workspace artifacts); Phase 2 drafts the steps and optionally updates Jira. On Claude Code: run Phase 1 in plan mode — that is what the `[plan mode]` marker below means.

## Global rules

- Read the ticket via the **`jira-reader` subagent** (Atlassian MCP) — AC, TA, links, attachments; the optional write-back is **delegated to the `jira-writer` subagent** (the ✋ approval stays in the main loop).
- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.

---

## Phase 1 — Analysis `[plan mode]`

1. **Ingest the ticket** — context-first per `../../references/task-workspace.md` (relative to this skill's directory; pass the workspace path to the **`jira-reader`** subagent — it writes `ticket.md` itself); the workspace `.claude/fnd/<TICKET>/` also holds QA repro values in `notes.md`. This skill needs: Description, AC, Technical Approach, Steps to Test, Figma links, environment notes (plus `figma_urls` / `notion_urls` / `other_links`). `needs_clarification` → ask. **Read the linked docs** that define expected behaviour/data/copy **via `doc-reader`**, per `../../references/reading-linked-docs.md`; if the Notion MCP isn't connected, tell the developer rather than writing steps blind.
2. **Analyse the implementation and build the setup inventory** — from the diff or developer summary, list everything a QA engineer on a **fresh theme** must configure before anything renders; the authoritative item-class list lives in `../../references/steps-to-test-format.md` → Setup (sections + template placement, blocks, app embeds, theme settings, metafields with `namespace.key` + example values, metaobjects, alternate templates, fixtures). Tag each item store-wide vs per-theme. This inventory becomes the Setup section — anything a scenario touches but the inventory misses is a guaranteed clarifying question from QA.
3. **Identify test scenarios** — one per AC (plus at most one cross-cutting flow); note edge cases, negative paths, and the named fixtures (handles, customer emails, exact values) each scenario needs — sourced from the workspace `notes.md` repro values or the developer, never left as "any product that…".

---

## Phase 2 — Generate Steps to Test

1. **Write Steps to Test** following the Domaine format — read
   `../../references/steps-to-test-format.md` now (it owns the writing
   rules: the QA-engineer-on-their-own-fresh-theme premise, the numbered Setup section built
   from the setup inventory, environment bans, step shape, size budget, and the
   **General** vs **Bug** template choice per `ticket_type`). Run its **Self-check** and
   fix violations before presenting.

### ✋ Checkpoint

Present the Steps to Test. Encourage the developer to **walk through** them (mentally or on preview) to catch gaps — especially whether the Setup section alone gets a fresh theme to the checkpoint state. Once approved, save them to the workspace `steps-to-test.md` (`../../references/task-workspace.md`) before the Jira write-back.

2. **Update Jira** (only after approval) — ask **manual update** vs **Atlassian MCP**. Place content in the **Steps to Test** custom field per process — not only comments. For the **MCP** path: resolve the Steps-to-test field id (`jira-field-ids.md`) and **delegate the write to the `jira-writer` subagent** (ticket · that field id · the saved `steps-to-test.md`) — the field is rich-text (ADF), and delegating keeps the large ADF blob out of the main context. Mechanics + when to write inline instead: **`../../references/jira-adf-write.md`**.

## Quality bar

Per `../../references/steps-to-test-format.md` → Self-check: full AC
coverage; complete Setup (fresh theme → checkpoint); named fixtures; zero clarifying
questions.

## Next in the series

Close out per `../../references/task-workspace.md` → Progress tracking; next is the fnd `create-pull-request` skill (`/fnd:create-pull-request <ticket>` on Claude Code) if the branch has no PR yet, else the series is complete (reviewers, QA hand-off, ticket transition stay with the developer); **offer only; never auto-run**.
