---
name: develop-feature-or-fix
description: >
  Implement a feature or fix from an approved Technical Approach, validated Jira ticket, and
  Figma designs — plan, get plan approval, then implement with in-browser validation —
  Workflow 3. Use when the user asks to develop / implement / build a feature or fix from a
  Jira ticket and design.
argument-hint: "<jira-url-or-key> [figma-node-url]"
arguments:
  - name: jira_ticket
    description: Jira ticket URL or key (e.g. ELC-206). If absent, infer it from the conversation context (ticket already discussed); ask only if it can't be inferred.
  - name: figma_url
    description: Figma URL with the node id for the relevant frame/component. Ask if missing or node-less.
---

# Develop Feature or Fix (Jira + Figma)

Implement a feature or fix with an approved Technical Approach, validated ticket, and design references.

Series position: Workflow 3 — after `write-technical-approach`, before `qa-feature-or-fix`.
Inputs (ask if missing): **Jira ticket URL or key** (`jira_ticket`); confirmation that **Description, AC, Technical Approach, and a Figma URL with a node** are on the ticket.
Operating mode: **Phase 1 produces the plan** (ingest ticket + designs, align with the TA; its only writes are workspace artifacts) — no production code until the developer approves it. On Claude Code: run Phase 1 in plan mode and leave plan mode after the developer approves the plan.
Other hosts (Claude Code unchanged) — Cursor: Composer 2.5 → Sonnet for a simple scoped ticket (Liquid section/block, CSS — avoid Opus), Sonnet → GPT-5.5 for planning or a medium multi-file feature, and planning runs in Plan Mode whenever the change trips a guidelines trigger (>~5 files, multiple app layers, migrations, checkout / customer data / auth / payments / security, multi-repo, a new architectural pattern, ambiguous requirements); Codex (proposed): the `routine` → `standard` tiers, `deep-review` for planning, with the ids in `<plugin root>/references/host-model-map.md`; OpenCode: the session's own model — no pin.

## Global rules

- **Never proceed past a ✋ checkpoint** without explicit developer confirmation.
- **Atlassian MCP** for Jira; **Figma MCP** for design extraction; **Chrome DevTools MCP** for in-browser validation when the preview is running. Ticket / design / codebase **reads are delegated to the `jira-reader`, `figma-reader`, and `theme-explorer` subagents** so raw ADF, node trees, and broad search stay out of this context — see steps 1, 3, 4.
- **Browser-MCP prerequisite:** the local dev server must be running (see `<plugin root>/references/preflight-checklist.md` → Local dev server; **plugin root** = the plugin's own directory, `../../` relative to this skill's directory — every bundled path below uses that form, and on Claude Code it is `${CLAUDE_PLUGIN_ROOT}` — the host substitutes the absolute path into this text, so the path you see here is the one to write into commands, no shell variable carries it). Confirm before validation.
- Respect the repo's coding rules. **Extend — never directly modify** `src/entry/core/*` JS/TS; prefer extending or composing core Liquid blocks/snippets per project conventions.

---

## Phase 1 — Analysis & planning `[plan mode]`

**Kick off the reads in parallel.** When the task scope is already clear (the ticket is in
context or the request is explicit), spawn `jira-reader`, the `figma-reader`(s), and
`theme-explorer` **concurrently** — they're independent. If the scope is only defined by the
ticket you're still fetching, start `theme-explorer` once `jira-reader` returns the AC / TA so
it knows what to map. Steps 1, 3, 4 are reads; step 5 (linked docs) runs once `jira-reader`
returns the links; steps 2 and 6–8 run after the reads return.

1. **Ingest the Jira ticket** — context-first per `<plugin root>/references/task-workspace.md` (pass the workspace path to the **`jira-reader`** subagent — it writes `ticket.md` itself). This skill needs: Description, AC, Technical Approach, Figma URL (plus any `figma_urls` the reader returns). `needs_clarification` → ask; a field reported empty is genuinely empty — warn the developer.
2. **Validate readiness** — if any are missing, **stop** and warn: Description, Acceptance Criteria, Technical Approach, Figma URL pointing to a **specific node**.
3. **Analyse the codebase** — delegate the broad search to the `theme-explorer` subagent (read-only scout): seed it with the task intent; it reads the project's `.claude/rules` + theme layout and returns an **impact map** (relevant files, patterns to follow, new files, schema/locale/settings impacts, rule constraints, open questions), keeping the wide search out of this context. **Then read the load-bearing files it points to yourself** — the scout finds breadth; you build the real understanding the plan and interview need. Do **not** plan from its summary alone.
4. **Analyse Figma** — for each Figma URL on the ticket (from the `jira-reader` output or the developer), **spawn one `figma-reader` subagent per URL, in parallel**; each returns a compact build spec. **Reuse before spawning:** specs already in this conversation or in the task workspace (`.claude/tasks/<TICKET>/figma-<node-id>.md`) count — spawn readers only for missing nodes, each passed the workspace path so it saves its own `figma-<node-id>.md`. These can run in parallel with the codebase analysis (step 3). If a URL has no node id or the target frame is unclear (a `figma-reader` returns `needs_clarification`), **ask** for the correct link.
5. **Read every linked doc.** Once `jira-reader` returns the links, spawn one **`doc-reader`** subagent per remaining link, **in parallel**, per `<plugin root>/references/reading-linked-docs.md` (reuse-before-fetch; pass the workspace path — the readers save `doc-<slug>-<hash>.md` themselves; Figma is already covered by step 4). **Notion links are mandatory — a reader naming a missing Notion MCP → stop and tell the developer** which links couldn't be read (enable `/mcp` or paste the content); don't plan around them. The extracts land here compact — especially any **data-mapping / schema** that defines metafields or metaobjects (feeds step 6).
6. **Store data model (metafields / metaobjects).** If the ticket or a linked doc describes a **metafield or metaobject**, the store needs that data model before the theme code can render anything. Read `<plugin root>/references/metafield-metaobject-setup.md` → **Planning & QA digest** (the file's first ~45 lines — read only that; the full file is Phase-2 material): draft the **STEP 0 inspection query** (what already exists vs what the doc requires — validate it with `validate_graphql_codeblocks` before it goes in the plan: Shopify Dev MCP, `api: "admin"`, a `learn_shopify_api` `conversationId`, `version` = the version the runner requests — `SHOPIFY_ADMIN_API_VERSION`, default `2026-04`), decide the **mode** — **(1)** store access available (CLI ≥ 4.x stored `shopify store auth`, or an Admin API token) → you'll run inspect + mutations yourself via the bundled runner, or **(2)** no store access → you'll produce a living `.graphql` file the developer runs step-by-step in the Shopify GraphiQL App — and fold the resulting definition/mock/bind steps into the implementation plan. (Provisioning happens in Phase 2; here you only plan it.)
7. **Interview the developer until you reach shared understanding** — walk down each branch of the design tree, resolving dependencies between decisions one-by-one. **Ask questions one at a time**, and **for each, give your recommended answer**. If a question can be answered by exploring the codebase, **explore the codebase instead of asking**.
8. **Create the implementation plan** — informed by the interview: ordered, reviewable steps; files/components/metafields/settings to add or change; **the metafield/metaobject setup from step 6 (which mode, which definitions/mocks)**; call out deviations from the TA and why.
9. **Optional — pressure-test the plan with external research.** Offer once, never auto-run: *"Pressure-test this plan against fresh external sources (Shopify changelogs, third-party docs)? ⚠️ **Token-heavy** — worth it mainly for risky, novel, or integration-heavy work. `[ yes / no ]"`*. Default **no** — proceed to the checkpoint. On **yes**: run it on the **draft plan** per `<plugin root>/references/research-pressure-test.md` (brief, return shape, fold-in).

### ✋ Checkpoint — Phase 1

Present the **implementation plan** (with any research findings folded in) and wait for **explicit approval** before writing production code. Once approved, save the plan verbatim to the workspace `plan.md` (`<plugin root>/references/task-workspace.md`). If the context monitor has flagged this session (its notice recommends compacting), offer the stronger option — a fresh session, then re-invoke this skill with the ticket (on Claude Code: `/clear` + `/fnd:develop-feature-or-fix <ticket>`): Phase 2 resumes from `plan.md`, and an approved plan on disk beats a lossy summary.

---

## Phase 2 — Implementation

**Resume path:** the workspace already holds an approved `plan.md` for this ticket (a fresh
session, or one cleared mid-run) → confirm in one line that it's still current and start here —
don't redo Phase 1.

1. **Provision the store data model** (only if the plan calls for it — step 6) — **before** building the Liquid that reads it, stand up the metafield/metaobject definitions, mock content, and product binding by **following `<plugin root>/references/metafield-metaobject-setup.md`** (read the **full file** now — Phase 1 read only its digest; it owns both modes' mechanics and the auth engines). **Mode 1 (store access):** STEP 0 inspection via `<plugin root>/scripts/shopify-admin-gql.sh`, diff against the doc, then the create/wire/mock/bind mutations. **Every query/mutation you wrote passes `validate_graphql_codeblocks` (Shopify Dev MCP) before it runs** — the schema server is already loaded, and a bad mutation may not be undoable. For image fields, reuse existing store media or have the dev paste a `MediaImage` gid — don't upload by default. **Mode 2 (no store access):** maintain the living `metaobject-setup.graphql` in the task workspace per the reference's step-by-step protocol. End state: a test product that renders the feature.
2. **Implement** step by step after confirmation — build from the `figma-reader` specs gathered in Phase 1 (re-query Figma MCP only for detail they didn't capture); follow the TA, AC, Foundation rules, Liquid/block patterns, Tailwind/token usage. Two Foundation patterns worth knowing: when a **section must drive its blocks' dimensions/alignment** via CSS variables (`use_section_vars`), follow `<plugin root>/references/section-css-variables-pattern.md`; for **JS/TS state**, prefer `data-*` attributes + Tailwind `data-[]:` selectors over `classList`/`style.*` mutation — the repo lints against those (`<plugin root>/references/eslint-no-restricted-syntax.md`). Pause at logical milestones for review if the change is large or risky. **`git add` every newly created file immediately after creating it** (snippet, section, `src/entry/*`, locale, doc) so nothing referenced by the code is left untracked; ticket-scoped working files (inspection/setup `.graphql`, dumps) live in the task workspace, not the repo, and are never `git add`ed.
3. **In-browser validation** — use Chrome DevTools MCP to verify UI against design and AC (layout, breakpoints, console errors). If the dev server isn't running, say what to start and retry when ready.
   - **Exercise data-driven AC by mutating the metafield/metaobject values** (only when you provisioned in step 1 **Mode 1**) — one default state doesn't prove a conditional AC: per AC, flip the value via `<plugin root>/scripts/shopify-admin-gql.sh` → reload → verify → **restore**, walking **every enumerated / optional / conditional value an AC names**; inspect the **DOM, not just the visual**; mind **propagation lag** (retry briefly before calling it a bug). Full pattern: `<plugin root>/references/metafield-metaobject-setup.md` → Verifying data-driven AC.
   - Leave the data in a known state when done (restore defaults or note what you left set). Log what QA will need — test page paths, provisioned gids, preview theme — to the workspace `notes.md`. Also log every **intentional simplification with a known ceiling** (lean-code) there as a `ceiling:` entry — what was simplified, the ceiling, the upgrade path — the moment you decide it; `create-pull-request` carries each into the PR body as a one-line named ceiling (the upgrade path stays in `notes.md`), and the `bug-hunter` review treats an *undocumented* dropped capability as a finding.
   - **Customizer-driven AC — same discipline through theme JSON:** `<plugin root>/scripts/theme-json.sh` (snapshot → `set` → reload → verify → **restore**; live theme refused), walking every enumerated/optional state. Full pattern: `<plugin root>/references/theme-customizer-state.md`.
4. **Iterative review** — accept course corrections; don't argue past scope — surface tradeoffs instead.

## Quality bar

- Meets AC and TA.
- Matches design intent (dimensions, spacing, typography, states).
- Accessibility (WCAG 2.2 AA minimum; stricter project rules where they apply) and performance considered.
- No secrets in code; no broad unsafe refactors.

## Next in the series

Close out per `<plugin root>/references/task-workspace.md` → Progress tracking (status: branch, what shipped); next is normally the fnd `qa-feature-or-fix` skill for that ticket; **offer only; never auto-run**. Heavy context → suggest a fresh session + the next invocation over compacting (on Claude Code: `/clear` over `/compact`): the workspace preserves the facts.
