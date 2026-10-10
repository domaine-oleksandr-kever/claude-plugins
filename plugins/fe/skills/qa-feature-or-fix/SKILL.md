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

Series position: Workflow 4 — after `/fe:develop-feature-or-fix`.
Inputs (ask if missing): **Jira ticket URL or key** (`jira_ticket`); **how to view the change** (`how_to_view` — preview URL, theme name, template/page path, flags/settings).
Operating mode: **Phase 1 is ingest + analysis** (review diff vs TA/AC, build the checklist; its only writes are workspace artifacts); Phase 2 runs the checks and produces the report. Run Phase 1 in plan mode — that is what the `[plan mode]` marker below means.

## Global rules

- **Never proceed past the ✋ checkpoint** without explicit developer confirmation.
- **Atlassian MCP** for Jira; **Chrome DevTools MCP** for browser validation; **Figma MCP** — or `base:figma-reader`'s REST fallback when none is attached — when comparing to designs if URLs are available. Ticket and design **reads are delegated to the `base:jira-reader` / `base:figma-reader` subagents** (raw payloads stay out of context).
- Local preview should be running for interactive checks (see `<fe root>/references/preflight-checklist.md` → Local dev server; **`<fe root>`** / **`<base root>`** = the paths on the session context's `fe plugin root:` / `base plugin root:` lines — write them into commands spelled out, no shell variable carries them) — confirm with the developer.

---

## Phase 1 — QA preparation `[plan mode]`

1. **Ingest the ticket** — context-first per `<base root>/references/task-workspace.md`; the workspace also holds dev's test breadcrumbs in `notes.md` (pass the workspace path to the **`base:jira-reader`** subagent — it writes `ticket.md` itself). This skill needs: Description, AC, Technical Approach, Steps to Test, environment notes (plus `figma_urls` / `notion_urls` / `other_links`). `needs_clarification` → ask. **Read the linked docs** that define expected behaviour/data/copy **via `base:doc-reader`**, per `<base root>/references/reading-linked-docs.md`; Notion MCP missing → tell the developer rather than QA'ing blind. The reader also returns `comments` (one line each) and `attachments` (local paths) in full — read `comments.md` when the task depends on the discussion, `Read` only the screenshots/frames it points at, and hand a non-empty `attachments_note` to the developer once, verbatim, never as a blocker (`<base root>/references/task-workspace.md` → Read rule, comments & attachments). A re-QA after a feedback round is driven by those comments: their findings and the screenshots/frames they attach are input for the checklist — read them before building it.
2. **Analyse the implementation** — review the diff (branch/PR or local — ask which source); cross-check changes against the TA and each AC.
3. **Generate the QA checklist** — rows for: each **acceptance criterion** → concrete test actions + expected results; **design conformance** vs the Figma build spec when a design is linked or its spec is already in context; **edge cases** from TA or code review; **break-it cases** (always include this group — derive the rows per `<base root>/references/break-it-qa.md` → Deriving the rows, read it now); **accessibility** (keyboard, focus order, semantics, visible focus, contrast on critical UI); **performance** (layout shift, heavy images/scripts, critical rendering path if touched); **cross-browser / viewport** if layout-critical — at each breakpoint the project defines, its px and 1 px below, plus one width well inside each side. Every row names its surface (page + section) and its proof: `proof: browser <script> | source <grep>`. Test each AC row: what is the cheapest wrong implementation that would pass it? Would it still hold if a competent engineer found a different, better way (if not, it encodes a route, not a result)? A weak AC is raised with the developer at the checkpoint, never rewritten.

### ✋ Checkpoint — Phase 1

Present the checklist; let the developer add/remove cases. Wait for approval before Phase 2. Once approved, save the checklist to the workspace `qa.md`.

---

## Phase 2 — QA execution

1. **Automated / assisted validation** — with Chrome DevTools MCP (when preview is available): visual pass vs Figma if linked — **context-first:** reuse `base:figma-reader` build specs already in this conversation in full (e.g. from a `/fe:develop-feature-or-fix` run) or in the task workspace (any `.claude/tasks/<TICKET>/figma-<node-id>*.md` — the plain name or a `-<file-key-prefix>` variant — is a hit only when its `url` frontmatter matches the requested file key **and** node id); spawn one `base:figma-reader` per `figma_urls` entry, in parallel, **only for specs you don't already have**, each passed the workspace path so it saves its own spec — console errors, basic performance signals (LCP/CLS context as applicable). Record **Pass / Fail / Needs review** per item with short evidence (what you checked, what you saw).
   - **Measure, don't glance** — a screenshot is a glance, never the basis of a verdict. Gather each criterion on the page it names; settle the page first (wait, scroll the target into view so lazy widgets mount); verify the real rendered content (the text, the image, the computed value), never its container; query through shadow roots. Run a row's `browser` proof twice ~250 ms apart and decide on the numbers. A transient cannot be measured before and after — push a reading per `requestAnimationFrame` into a window array. On a Fail, record the owner (theme | injected) and the reach (light DOM | shadow root | iframe); once a bug reproduces, do not disturb it.
   - **Data-driven AC — exercise each configured state, don't assume it** (store access required): flip the value via `<fe root>/scripts/shopify-admin-gql.sh` → reload → verify → **restore**, walking every enumerated/optional/conditional state; inspect the **DOM, not just the visual**; mind propagation lag (retry before calling a Fail). Full pattern: `<fe root>/references/metafield-metaobject-setup.md` → Verifying data-driven AC.
   - **Customizer-driven AC — same discipline through theme JSON** via `<fe root>/scripts/theme-json.sh` (snapshot → `set` → reload → verify → **restore**; live theme refused). Pattern: `<fe root>/references/theme-customizer-state.md`.
   - **Break-it rows** — execute per `<base root>/references/break-it-qa.md` → Executing the rows: hostile values through the same two state patterns (restore after), timing via throttle/races; a row that breaks the feature is a **finding** with evidence + the exact hostile value, filed blocking/non-blocking.
2. **Report findings** — summarize in a structured table or list; separate **blocking** vs **non-blocking**; every outcome observed in this run, gaps named (no credentials, no checkout) — never a pass without basis; a criterion you cannot describe how to measure is **Needs review**, handed to a human, never dropped — no evidence is not a refutation; suggest Jira updates (QA notes, screenshots, reopen criteria) but let the developer own ticket edits unless they ask you to use Atlassian MCP. **If you do write to a rich-text field or comment via MCP, delegate it to the `base:jira-writer` subagent** (ticket · the field id or `comment` · the approved markdown file) — it converts either to ADF, writes, and reads the target back, keeping the large payload out of the main context. Mechanics + when to write inline instead: `<base root>/references/jira-adf-write.md`. Append the pass/fail outcome and confirmed findings (with their repro values) to the workspace `qa.md`, below the checklist. When the session carries base's writing-style convention, sentences follow it; this skill decides structure and mandatory wording.

## Next in the series

Close out per `<base root>/references/task-workspace.md` → Progress tracking (status: "pass" / "2 blocking bugs"); next: all blocking checks passed → `/base:pre-commit-review` (pass it the `profile` word from the session's `fe project profile:` line); any blocking failure → offer to fix it now and re-run this QA after; **offer only; never auto-run**.
