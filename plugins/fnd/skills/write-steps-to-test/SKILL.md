---
name: write-steps-to-test
description: >
  Write Steps to Test for a Jira ticket in Domaine's standard format — the theme to test in, where
  the change lives plus the setup from scratch, a walk-through whose steps carry their own
  expectations, edge cases, and the implementation context a QA engineer cannot get from the AC;
  fewer test cases, more how it was built. Updates the Jira field after approval — Workflow 5.
  Use when the user asks to write / draft Steps to Test or QA steps for a Jira ticket.
argument-hint: "<jira-url-or-key> [feature|bug]"
arguments:
  - name: jira_ticket
    description: Jira ticket URL or key (e.g. ELC-206). If absent, infer it from the conversation context (ticket already discussed); ask only if it can't be inferred.
  - name: ticket_type
    description: Whether this is a general "feature" or a "bug" ticket — it selects the template. Absent → the Jira issue type decides; an explicit value always overrides.
---

# Write Steps to Test (Jira)

Produce **Steps to Test** in Domaine's standard format.

Operating mode: **Phase 1 is ingest + analysis** (ticket + implementation context; its only writes are workspace artifacts); Phase 2 drafts the steps and optionally updates Jira. On Claude Code: run Phase 1 in plan mode — that is what the `[plan mode]` marker below means.

## Global rules

- Read the ticket via the **`jira-reader` subagent** (Atlassian MCP) — AC, TA, issue type, links, comments, attachments; the optional write-back is **delegated to the `jira-writer` subagent** (the ✋ approval stays in the main loop).
- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.

---

## Phase 1 — Analysis `[plan mode]`

1. **Ingest the ticket** — context-first per `../../references/task-workspace.md` (relative to this skill's directory; pass the workspace path to the **`jira-reader`** subagent — it writes `ticket.md` itself); the workspace `.claude/tasks/<TICKET>/` also holds QA repro values in `notes.md`. This skill needs: Description, AC, issue type, Technical Approach, Steps to Test, Figma links, environment notes (plus `figma_urls` / `notion_urls` / `other_links`). `needs_clarification` → ask. **Read the linked docs** that define expected behaviour/data/copy **via `doc-reader`**, per `../../references/reading-linked-docs.md`; if the Notion MCP isn't connected, tell the developer rather than writing steps blind. The reader also returns `comments` (one line each) and `attachments` (local paths) in full — read `comments.md` when the task depends on the discussion, `Read` only the screenshots/frames it points at, and hand a non-empty `attachments_note` to the developer once, verbatim, never as a blocker (`../../references/task-workspace.md` → Read rule, comments & attachments).
2. **Resolve the theme** — the theme QA tests in, in the order `../../references/steps-to-test-format.md` → Theme resolution sets: the ticket first, then an id this session confirmed on that store from the workspace `notes.md` (stated as unconfirmed, with its date), then **ask the developer once** — "which theme does the TL push to for QA?" (on Claude Code one AskUserQuestion, elsewhere a plain question) — then the unconfirmed `confirm with the TL` placeholder. Never read the QA store registry for this (`qa-stores.cjs` `defaultTheme` is the QA engineer's own theme, not the TL's target), and never the session's own preview theme from `notes.md`: that is the PR's theme and may be gone by the time QA looks.
3. **Gather the where + setup material** — the pages by path; the section / block names **as the admin sees them** (from the `{% schema %}`, `t:` keys resolved through `locales/en.default.schema.json`); the editor setup from scratch for everything the change adds or reconfigures (route, each non-default setting with its value by label, blocks, content, **Save**); and the data QA must create (metafield / metaobject definitions and values, fixtures with the properties a stand-in must share, store-wide vs per-theme). Sources: the diff, the TA, the theme repo, and the workspace `notes.md` repro values — or, with no diff available in this session, the developer's own summary of what they built, asked for once; never the QA theme's state, which you cannot see. A name you could not read from the schema or the admin is carried as **unverified** and raised at the ✋ checkpoint, never silently generalised. QA builds the section itself: what this material misses becomes a QA question.
4. **Draft the walk-through and the implementation notes** — one pass through the feature **as built** (not one scenario per AC): imperative steps, location before action, each carrying its own expectation with exact values, every AC's functionality exercised by at least one step. Name the fixtures and values each step needs from the workspace `notes.md` or the developer, never "any product that…". Alongside it collect the developer's **choices** for the context item — new settings with their defaults, where a value comes from, what was deliberately left unchanged, known limits, what is not in this ticket — from the diff, the TA, the PR body and `notes.md`; that is the "how the ACs were achieved" part QA cannot get from the AC. On a bug ticket collect instead the root cause and what was changed to fix it.

---

## Phase 2 — Generate Steps to Test

1. **Write Steps to Test** following the Domaine format — read
   `../../references/steps-to-test-format.md` now (it owns the writing rules: the
   General and Bug templates and their item order, the one-ordered-list shape, theme and
   location rules, the setup recipes, fixtures, expectations, edge cases, context / out of
   scope, and the size budget). **Template:** `ticket_type` when the caller passed one;
   otherwise the Jira issue type decides — `Bug` → Bug template, anything else → General.
   Run the reference's **Self-check** and fix violations before presenting.

### ✋ Checkpoint

Present the Steps to Test and ask the developer to **test their own instructions** — walk through them as written, as someone opening the Shopify admin for the first time, checking that every route, label and option exists in that order and that the setup alone puts the section on screen; steps that confuse the developer will confuse QA. Where a location or a setup step is not obvious from text, tell them **here, not in the field**, to attach a screenshot of the editor setup to the ticket by hand (the plugin uploads nothing). Name here — in the presentation, never in the field — everything the draft states as unconfirmed: the theme placeholder, and every label you could not read from the `{% schema %}` / `locales/*.schema.json` or the admin; ask the developer to confirm or correct each. Once approved, save them to the workspace `steps-to-test.md` (`../../references/task-workspace.md`) before the Jira write-back.

2. **Update Jira** (only after approval) — ask **manual update** vs **Atlassian MCP**. Place content in the **Steps to Test** custom field per process — not only comments. For the **MCP** path: resolve the Steps-to-test field id (`jira-field-ids.md`) and **delegate the write to the `jira-writer` subagent** (ticket — with the workspace path it came from, or "the key the developer named" when there is no workspace · that field id · the saved `steps-to-test.md`) — the field is rich-text (ADF), and delegating keeps the large ADF blob out of the main context. Mechanics + when to write inline instead: **`../../references/jira-adf-write.md`**.

## Next in the series

Close out per `../../references/task-workspace.md` → Progress tracking; next is the fnd `create-pull-request` skill (`/fnd:create-pull-request <ticket>` on Claude Code) if the branch has no PR yet, else the series is complete (reviewers, QA hand-off, ticket transition stay with the developer); **offer only; never auto-run**.
