---
name: write-steps-to-test
description: >
  Write Steps to Test for a Jira ticket in Domaine's standard format — maps each AC to
  reproducible scenarios for a tester unfamiliar with the implementation; updates the Jira
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

Operating mode: **Phase 1 in plan mode** (ingest ticket + implementation context); Phase 2 drafts the steps and optionally updates Jira.

## Global rules

- Read the ticket via the **`jira-reader` subagent** (Atlassian MCP) — AC, TA, links, attachments; the optional write-back is **delegated to the `jira-writer` subagent** (the ✋ approval stays in the main loop).
- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.

---

## Phase 1 — Analysis `[plan mode]`

1. **Ingest the ticket** — context-first per `${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md`; the workspace `.claude/fnd/<TICKET>/` also holds QA repro values in `notes.md`. This skill needs: Description, AC, Technical Approach, Steps to Test, Figma links, environment notes (plus `figma_urls` / `notion_urls` / `other_links`). `needs_clarification` → ask. **Read the linked docs** that define expected behaviour/data/copy **via `doc-reader`**, per `${CLAUDE_PLUGIN_ROOT}/references/reading-linked-docs.md`; if the Notion MCP isn't connected, tell the developer rather than writing steps blind.
2. **Analyse the implementation** — from the diff or developer summary: what shipped, which settings/metafields/templates matter, and merchant-visible paths (Online Store editor, templates, URLs).
3. **Identify test scenarios** — map each AC to one or more scenarios; include edge cases, negative paths, and data/setup prerequisites (collections, tags, markets, customer state, inventory, etc.).

---

## Phase 2 — Generate Steps to Test

1. **Write Steps to Test** following the Domaine format — read
   `${CLAUDE_PLUGIN_ROOT}/references/steps-to-test-format.md` now (it owns the writing
   rules: theme-agnostic navigation, per-step expectations, visual aids, edge cases,
   headings + steps instead of big tables, and the **General** vs **Bug** template choice
   per `ticket_type`).

### ✋ Checkpoint

Present the Steps to Test. Encourage the developer to **walk through** them (mentally or on preview) to catch gaps. Once approved, save them to the workspace `steps-to-test.md` (`${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md`) before the Jira write-back.

2. **Update Jira** (only after approval) — ask **manual update** vs **Atlassian MCP**. Place content in the **Steps to Test** custom field per process — not only comments. For the **MCP** path: resolve the Steps-to-test field id (`jira-field-ids.md`) and **delegate the write to the `jira-writer` subagent** (ticket · that field id · the saved `steps-to-test.md`) — the field is rich-text (ADF), and delegating keeps the large ADF blob out of the main context. Mechanics + when to write inline instead: **`${CLAUDE_PLUGIN_ROOT}/references/jira-adf-write.md`**.

## Quality bar

Per `${CLAUDE_PLUGIN_ROOT}/references/steps-to-test-format.md` → Quality bar: full AC
coverage; deterministic steps; theme-agnostic navigation.

## Next in the series

Check off this workflow's row in the workspace `progress.md`, then offer the next unchecked step in one line — `/fnd:create-pull-request <ticket>` if the branch has no PR yet, else the series is complete (reviewers, QA hand-off, ticket transition stay with the developer) — **offer only; never auto-run**.
