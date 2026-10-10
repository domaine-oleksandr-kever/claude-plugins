---
name: write-steps-to-test
description: >
  Write Steps to Test for a Jira ticket in Domaine's format (theme, setup, walk-through with
  expectations, edge cases, build context), then update the Jira field. Use when asked to write /
  draft Steps to Test or QA steps.
argument-hint: "<jira-url-or-key> [feature|bug]"
arguments:
  - name: jira_ticket
    description: Jira ticket URL or key (e.g. ELC-206). If absent, infer it from the conversation context (ticket already discussed); ask only if it can't be inferred.
  - name: ticket_type
    description: Whether this is a general "feature" or a "bug" ticket — it selects the template. Absent → the Jira issue type decides; an explicit value always overrides.
---

# Write Steps to Test (Jira)

Produce **Steps to Test** in Domaine's standard format.

Series position: Workflow 5 — the series' last step, after `/fe:create-pull-request`: the PR goes up first so its checks run while this is written, and the PR body and diff are its implementation context.
Operating mode: **Phase 1 is ingest + analysis** (ticket + implementation context); Phase 2 drafts the steps and optionally updates Jira. Phase 1 is read-only toward the repo's tracked files; writes go to the task workspace only.

## Global rules

- Read the ticket via the **`base:jira-reader` subagent** (Atlassian MCP) — AC, TA, issue type, links, comments, attachments; the optional write-back is **delegated to the `base:jira-writer` subagent** (the ✋ approval stays in the main loop).
- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.
- **Text written for an agent is never published to a person** — briefs, workspace notes and instructions to yourself or the developer stay out of the field.

---

## Phase 1 — Analysis

1. **Ingest the ticket** — context-first per `<base root>/references/task-workspace.md` → Read rule (pass the workspace path to the **`base:jira-reader`** subagent — it writes `ticket.md` itself); the workspace `.claude/tasks/<TICKET>/` also holds QA repro values in `notes.md`. This skill needs: Description, AC, issue type, Technical Approach, Steps to Test, Figma links, environment notes (plus `figma_urls` / `notion_urls` / `other_links`). `needs_clarification` → ask. **Read the linked docs** that define expected behaviour/data/copy **via `base:doc-reader`**, per `<base root>/references/reading-linked-docs.md`; if the Notion MCP isn't connected, tell the developer rather than writing steps blind. Its `comments`, `attachments` and `attachments_note`: `<base root>/references/task-workspace.md` → Read rule.
2. **Resolve the theme** — the theme QA tests in, in the order `<base root>/references/steps-to-test-format.md` → Theme resolution sets: the ticket first, then an id this session confirmed on that store from the workspace `notes.md` (stated as unconfirmed, with its date), then **ask the developer once** — "which theme does the TL push to for QA?" (one AskUserQuestion) — then the unconfirmed `confirm with the TL` placeholder. Never read the QA store registry for this (`<base root>/scripts/qa-stores.cjs` `defaultTheme` is the QA engineer's own theme, not the TL's target), and never the session's own preview theme from `notes.md`: that is the PR's theme and may be gone by the time QA looks.
3. **Gather the where + setup material** — the pages by path; the section / block names **as the admin sees them** (from the `{% schema %}`, `t:` keys resolved through `locales/en.default.schema.json`); the editor setup from scratch for everything the change adds or reconfigures (route, each non-default setting with its value by label, blocks, content, **Save**); and the data QA must create (metafield / metaobject definitions and values, fixtures with the properties a stand-in must share, store-wide vs per-theme). Sources: the diff, the TA, the theme repo, and the workspace `notes.md` repro values — or, with no diff available in this session, the developer's own summary of what they built, asked for once; never the QA theme's state, which you cannot see. A name you could not read from the schema or the admin is carried as **unverified** and raised at the ✋ checkpoint, never silently generalised. QA builds the section itself: what this material misses becomes a QA question.
4. **Draft the walk-through and the implementation notes** — one pass through the feature **as built** (not one scenario per AC): imperative steps, location before action, each carrying its own expectation with exact values, every AC's functionality exercised by at least one step. Name fixtures by role plus an `e.g.` handle with its properties (from `notes.md` or the developer), never a bare handle or "any product that…". Alongside it collect the developer's **choices** for the context item — new settings with their defaults, where a value comes from, what was deliberately left unchanged, known limits, what is not in this ticket — from the diff, the TA, the PR body and `notes.md`; that is the "how the ACs were achieved" part QA cannot get from the AC. On a bug ticket collect instead the root cause and what was changed to fix it.

---

## Phase 2 — Generate Steps to Test

1. **Write Steps to Test** following the Domaine format — read
   `<base root>/references/steps-to-test-format.md` now (it owns the writing rules: the
   General and Bug templates and their item order, the one-ordered-list shape, theme and
   location rules, the setup recipes, fixtures, expectations, edge cases, context / out of
   scope, and the size budget). **Template:** `ticket_type` when the caller passed one;
   otherwise the Jira issue type decides — `Bug` → Bug template, anything else → General.
   Run the reference's **Self-check** and fix violations before presenting.

### ✋ Checkpoint

Present the Steps to Test and ask the developer to **test their own instructions** — walk through them as written, as someone opening the Shopify admin for the first time, checking that every route, label and option exists in that order and that the setup alone puts the section on screen; steps that confuse the developer will confuse QA. Where a location or a setup step is not obvious from text, tell them **here, not in the field**, to attach a screenshot of the editor setup to the ticket by hand (the plugin uploads nothing). Name here — in the presentation, never in the field — everything the draft states as unconfirmed: the theme placeholder, and every label you could not read from the `{% schema %}` / `locales/*.schema.json` or the admin; ask the developer to confirm or correct each. Once approved, save them to the workspace `steps-to-test.md` (`<base root>/references/task-workspace.md`) before the Jira write-back.

2. **Update Jira** (only after approval) — ask **manual update** vs **Atlassian MCP**. Place content in the **Steps to Test** custom field per process — not only comments. For the **MCP** path: resolve the Steps-to-test field id (`<base root>/references/jira-field-ids.md`) and **delegate the write to the `base:jira-writer` subagent** (ticket — with the workspace path it came from, or "the key the developer named" when there is no workspace · that field id · the saved `steps-to-test.md`) — the field is rich-text (ADF), and delegating keeps the large ADF blob out of the main context. Mechanics + when to write inline instead: **`<base root>/references/jira-adf-write.md`**.

## Next in the series

Close out per `<base root>/references/task-workspace.md` → Progress tracking; next is `/fe:create-pull-request <ticket>` if the branch has no PR yet, else the series is complete (reviewers, QA hand-off, ticket transition stay with the developer); **offer only; never auto-run**.
