---
name: write-technical-approach
description: >
  Draft a Domaine Technical Approach (TA) for a Jira ticket from its Description and
  Acceptance Criteria, then (after approval) update the Jira TA field — Workflow 2. Use when
  the user asks to write / draft / update a Technical Approach or TA for a Jira ticket.
argument-hint: "<jira-ticket-url-or-key>"
arguments:
  - name: jira_ticket
    description: Jira ticket URL or key (e.g. ELC-206). Governing source of truth for the TA. If absent, infer it from the conversation context (ticket already discussed); ask only if it can't be inferred.
---

# Write Technical Approach (Jira)

Draft a Technical Approach (TA) for a Jira ticket. Follow the phases in order.

Series position: Workflow 2 — after ticket validation, before `develop-feature-or-fix`.
Input (ask if missing): **Jira ticket URL or key** (`jira_ticket`) — its **Description** and **Acceptance Criteria** are the governing source of truth.
Operating mode: **Phase 1 is analysis + outline only** — no repo or Jira writes until the developer approves the outline (on Claude Code: run Phase 1 in plan mode and leave plan mode on approval — that is what the `[plan mode]` marker below means); Jira updates only after approval.
Model: on Claude Code unchanged (whatever the session runs); on Cursor **Claude Sonnet** (translating ambiguous requirements into a plan); on Codex (proposed) the `standard` tier of `../../references/host-model-map.md`; on OpenCode the session model — no pin.

## North star

**The ticket's Description and AC govern the TA** — ungrounded decisions land in **Assumptions** (developer-confirmed), ambiguous or incomplete AC **stops** the draft. Full grounding rules: `../../references/technical-approach-format.md` (relative to this skill's directory; `<plugin root>` below is that same `../../` — on Claude Code it is `${CLAUDE_PLUGIN_ROOT}`, the host substitutes the absolute path into this text, so the path you see here is the one to write into commands, no shell variable carries it) §North star.

## Global rules

- The developer owns Git, merges, and ticket updates; you assist.
- **Never proceed past a ✋ checkpoint** without explicit developer confirmation.
- Use **Atlassian MCP** for Jira: **reads are delegated to the `jira-reader` subagent**, and the optional Phase 2 write-back is **delegated to the `jira-writer` subagent** (the ✋ approval stays in the main loop).
- Respect Foundation conventions: follow the repo's coding rules and **extend — never directly modify** `src/entry/core/*`.
- **Client-facing repo.** Never reference tickets, repos, or Figma files from other client accounts.
- **No internal repo file links** in the TA — they render as plain text in Jira. Reference in-repo files/rules with **inline code** only (`` `sections/main-header.liquid` ``). External links (Jira, Figma, public Shopify/Domaine docs) are fine.

## Audience & voice

Senior-Shopify-developer audience, **~3-minute read** — full guidance: `../../references/technical-approach-format.md` §Target audience / §Voice.

---

## Phase 1 — Analysis & planning `[plan mode]`

1. **Ingest the ticket** — context-first per `../../references/task-workspace.md` (pass the workspace path to the **`jira-reader`** subagent — it writes `ticket.md` itself). This skill needs: Description, AC, **Assumptions**, Technical Approach, Documentation Links, Steps to Test, `figma_urls`. `needs_clarification` → ask the developer.
2. **Validate readiness** — confirm Description and AC exist and are sufficient. If missing or ambiguous, **stop**, summarize gaps, ask how to proceed.
3. **Read every linked doc** the `jira-reader` returned — one **`doc-reader`** subagent per link, in parallel, per `../../references/reading-linked-docs.md` (pass the workspace path). **Notion is mandatory — a reader naming a missing Notion MCP → stop and ask the developer** rather than drafting around it; these docs often hold the real data model and final copy the TA must reflect.
4. **Analyse the codebase** — inspect relevant areas for patterns, layout, dependencies, constraints. Apply the repo's coding rules (Liquid, blocks, Tailwind, a11y, etc.).
5. **Clarify ambiguities** — ask concise scope/edge-case/environment questions before drafting.
6. **Draft the TA outline** — read `../../references/technical-approach-format.md` now and follow its skeleton exactly (seven fixed **H4** sections, dense bullets, inline code, `·` separators, no title/metadata block). Anchor every bullet to the AC. **If the ticket/linked docs define a metafield or metaobject, name those definitions in Data / Config** (types, keys, field list, owner/namespace) and optionally carry the STEP 0 inspection query — see `../../references/metafield-metaobject-setup.md` → Planning & QA digest (the file's first ~45 lines — read only that) — so `develop-feature-or-fix` starts from a known target. When store access is available, **verify Data / Config assumptions against the real store instead of guessing**: read-only Admin GraphQL via `<plugin root>/scripts/shopify-admin-gql.sh`, current customizer/theme-JSON state via `<plugin root>/scripts/theme-json.sh get` (`../../references/theme-customizer-state.md`).

### ✋ Checkpoint — Phase 1

Present the **outline and open questions**. Wait for approval or edits before Phase 2.

---

## Phase 2 — Write & review

1. **Generate the TA** as markdown at `docs/technical-approaches/<TICKET-KEY>-technical-approach.md` (or an developer-preferred path). Strictly follow the skeleton in the format reference (step 6): starting at `#### Summary`, no title/metadata block. `docs/technical-approaches/` is **gitignored by default** — the TA stays local and doesn't ship in the client-facing repo (see the format reference) — so don't `git add` it unless `git check-ignore -q` shows the repo actually tracks that path and the developer wants it committed.
2. **Optional — pressure-test the TA with external research.** Offer once, never auto-run: *"Pressure-test this TA against fresh external sources (Shopify changelogs, third-party docs)? ⚠️ **Token-heavy** — worth it mainly for risky, novel, or integration-heavy tickets. `[ yes / no ]"`*. Default **no** — go straight to the checkpoint. On **yes**: run it on the **drafted TA** per `../../references/research-pressure-test.md` (brief, return shape, fold-in).

### ✋ Checkpoint — Phase 2

Present the draft path and summary (with any research findings folded in). The developer must **read, edit, and approve** before any Jira update.

3. **Update Jira** (only after approval) — ask whether **(a)** the developer updates manually or **(b)** you use Atlassian MCP. Put the approved TA in the **Technical Approach** custom field, not only description/comments. For **(b)**: resolve the TA field id (`jira-field-ids.md`) and **delegate the write to the `jira-writer` subagent** (ticket — with the workspace path it came from, or "the key the developer named" when there is no workspace · that field id · the approved `docs/technical-approaches/<TICKET-KEY>-technical-approach.md`) — the field is rich-text (ADF), and delegating keeps the large ADF blob out of the main context. Mechanics + when to write inline instead: **`../../references/jira-adf-write.md`**.

## Quality bar

- Every section traces to the Description + AC; out-of-AC scope lives in **Assumptions** (with a reason).
- Aligns with Foundation patterns and repo rules.
- Concise senior-level tone (~3-min read), no AI-speak, no cross-client references, no merge/deploy instructions that bypass developer ownership.

## Next in the series

Close out per `../../references/task-workspace.md` → Progress tracking; next is normally the fnd `develop-feature-or-fix` skill (`/fnd:develop-feature-or-fix <ticket>` on Claude Code) once the TA is on the ticket; **offer only; never auto-run**.
