---
name: write-steps-to-test
description: >
  Write setup-only Steps to Test for a Jira ticket in Domaine's format (theme, object, setup, edge
  cases), then update the Jira field. Use when asked to write / draft Steps to Test or QA steps.
argument-hint: "<jira-url-or-key> [feature|bug]"
arguments:
  - name: jira_ticket
    description: Jira ticket URL or key (e.g. ELC-206). If absent, infer it from the conversation context (ticket already discussed); ask only if it can't be inferred.
  - name: ticket_type
    description: Whether this is a "feature" or a "bug" ticket — one skeleton serves both; for a bug, item 3 holds the state that makes the defect reachable. Absent → the Jira issue type decides; an explicit value always overrides.
---

# Write Steps to Test (Jira)

Produce **Steps to Test** in Domaine's standard format: four items — Theme · Object · Setup · Edge cases / not obvious — that tell QA how to set the change up. QA tests it against the AC; the field is not a test script.

Series position: Workflow 5 — the series' last step, after `/fe:create-pull-request`: the PR goes up first so its checks run while this is written, and the PR body and diff are its implementation context.
Operating mode: **Phase 1 is ingest** (ticket, linked docs, the branch facts); Phase 2 has **`fe:stt-drafter`** draft the steps into the workspace and, after approval, updates Jira. Phase 1 is read-only toward the repo's tracked files; writes go to the task workspace only.

## Global rules

- Read the ticket via the **`base:jira-reader` subagent** (Atlassian MCP) — AC, TA, issue type, links, comments, attachments; the optional write-back is **delegated to the `base:jira-writer` subagent** (the ✋ approval stays in the main loop).
- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.
- **Text written for an agent is never published to a person** — briefs, workspace notes and instructions to yourself or the developer stay out of the field.
- **Drafting is delegated to the `fe:stt-drafter` subagent** (opus, pinned in its frontmatter — spawn it with no `model`); the loop — spawn, receipt check, ESCALATE relay, SendMessage continuation, questions, edits, caps — is `<fe root>/references/drafter-loop.md` (read it now).
- **HARD RULE — the draft never enters this context.** You never `Read`, `cat`, quote or paraphrase `steps-to-test.md`; you show its path (clickable), the drafter's `unconfirmed` list and its questions — nothing else of it. Every change goes back to the same drafter; neither you nor the developer edits the file.

---

## Phase 1 — Analysis

1. **Ingest the ticket** — context-first per `<base root>/references/task-workspace.md` → Read rule (pass the workspace path to the **`base:jira-reader`** subagent — it writes `ticket.md` itself); the workspace `.claude/tasks/<TICKET>/` also holds QA repro values in `notes.md`. This skill needs: Description, AC, issue type, Technical Approach, Steps to Test, Figma links, environment notes (plus `figma_urls` / `notion_urls` / `other_links`). `needs_clarification` → ask. **Read the linked docs** that define expected behaviour/data/copy **via `base:doc-reader`**, per `<base root>/references/reading-linked-docs.md`; if the Notion MCP isn't connected, tell the developer rather than writing steps blind. Its `comments`, `attachments` and `attachments_note`: `<base root>/references/task-workspace.md` → Read rule. The drafter reads those files itself — don't pull their bodies into this context beyond what the ask needs.
2. **Collect what the drafter cannot get itself** — `<base root>/scripts/review-scope.sh --ws .claude/tasks/<work-id> | sed -n '1,2p'` → its `branch=` / `base=` lines. No branch diff in this checkout → ask the developer once for their own summary of what they built (`developer_summary`). Plus `ticket_type` when the caller passed one, and every answer the developer already gave in this conversation (theme, labels, data), verbatim. An answer about where the change is observed (a request, a console message) goes in verbatim too: a claim for the drafter to check against the code, not a fact. Theme resolution, the object, the setup, the edge cases and the no-repetition pass are the drafter's (its agent file carries the rules); it needs no store access — data is written as properties.

---

## Phase 2 — Generate Steps to Test

1. **Draft with `fe:stt-drafter`** — spawn it per `<fe root>/references/drafter-loop.md` with the brief: `workspace:` · `ticket:` · `ticket_type:` (the argument, else `issue type decides`) · `branch=` / `base=` or `developer_summary:` · `answers:` · `mode: draft`. Relay its returns per the loop until it returns `written: <workspace>/steps-to-test.md` and `drafter-check.cjs file stt` prints `result=ok`.

### ✋ Checkpoint

Show `steps-to-test.md` as a clickable absolute path — never its content — and ask the developer to **set the change up by their own item 3**: open the file and follow it as written, as someone opening the Shopify admin for the first time, checking that every route, label and option exists in that order and that the setup alone makes the change reachable. Then list the drafter's `unconfirmed` items and ask them to confirm or correct each. On `ac: empty`, tell them the ticket has no AC and show the `ac_proposal:` line verbatim as a suggestion to hand to the TL — never written to the field or Jira. Its `screenshot:` items are setup screenshots the developer attaches to the field by hand **after item 4**, each with a one-line caption (`Item 3 — Delivery Banner settings`), so the list is never broken (the plugin uploads nothing). Result screenshots stay in the PR. Questions → `mode: ask`; corrections → `mode: revise` with their words, to the same drafter, then present again. On approval the file is already in the workspace (`<base root>/references/task-workspace.md`): it is what Jira gets.

2. **Update Jira** (only after approval) — ask **manual update** vs **Atlassian MCP**. Place content in the **Steps to Test** custom field per process — not only comments. For the **MCP** path: resolve the Steps-to-test field id (`<base root>/references/jira-field-ids.md`) and **delegate the write to the `base:jira-writer` subagent** (ticket — with the workspace path it came from, or "the key the developer named" when there is no workspace · that field id · the approved `steps-to-test.md` path the drafter returned) — the field is rich-text (ADF), and delegating keeps the large ADF blob out of the main context. Mechanics + when to write inline instead: **`<base root>/references/jira-adf-write.md`**.

## Next in the series

Close out per `<base root>/references/task-workspace.md` → Progress tracking; next is `/fe:create-pull-request <ticket>` if the branch has no PR yet, else the series is complete (reviewers, QA hand-off, ticket transition stay with the developer); **offer only; never auto-run**.
