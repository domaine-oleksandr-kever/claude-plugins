---
name: ship
description: >
  Autonomous end-to-end delivery of a ready Jira ticket (the auto-mode alternative to
  workflows 3–6): one upfront interview + one plan/QA-checklist approval, then the whole
  series runs itself. Requires Description, AC, approved TA, Figma node. Use when the user
  asks to ship a ticket end-to-end or run the pipeline / auto mode / autopilot on a ticket.
argument-hint: "<jira-url-or-key> [figma-node-url]"
arguments:
  - name: jira_ticket
    description: Jira ticket URL or key (e.g. ELC-206). If absent, infer it from the conversation context; ask only if it can't be inferred.
  - name: figma_url
    description: Figma URL with the node id. Optional — the ticket's Figma link is used when present; ask only if both are missing.
---

# Ship — autonomous series run (auto mode)

From a ready ticket to an open PR + Steps to Test in one run. The run contract —
decision-record format, autonomy rule, escalation contract with the pre-authorized list,
judgment-call log, phase-start re-read — lives in
`${CLAUDE_PLUGIN_ROOT}/references/pipeline-mode.md`. **Read it now; it governs the run.**

Relationship to the series: the autonomous alternative to workflows 3–6. It never invokes
the solo skills — it reuses their shared references, agents, and scripts, writes the same
workspace artifacts, and ticks the same `progress.md` rows, so an interrupted run degrades
to solo cleanly. Row mapping: implement → `develop-feature-or-fix`; qa →
`qa-feature-or-fix`; finalize → `pre-commit-review` **and** `commit`; create-pr →
`create-pull-request`; steps-to-test → `write-steps-to-test`; aftercare / jira-hand-off
live only in `pipeline.md`.

Inputs (ask if missing): **Jira ticket** (`jira_ticket`); designs from the ticket's Figma
link or `figma_url`.
Operating mode: Steps 0–3 interactive (plan-mode discipline — read, align, ask; the only
writes are the workspace cache and `pipeline.md`); Step 4 autonomous.
Session model: strongest available as the conductor — **Fable recommended**, Opus
acceptable; the conductor stays on the session model while every phase agent is pinned —
rationale and assignments: `pipeline-mode.md` → Phase-agent models.

## Global rules

- **One gate.** Questions live in Step 2 and the single ✋ in Step 3. After approval: no
  questions — `ESCALATE` per the contract; everything else is decide + act + log.
- **Thin conductor.** After the ✋ this context holds decisions, the plan summary, and
  compact phase reports — nothing else. Heavy phases run as fresh subagents; never pull
  their file dumps back here.
- **Files are the memory.** Every phase re-reads its inputs from the workspace
  (phase-start re-read protocol). Ticks and artifacts are written before moving on — a
  crash at any point must leave a resumable state.
- **Crash-safe ordering:** record externally-visible results (PR URL, created theme id,
  Jira writes) to `progress.md` / `notes.md` **immediately** after the action succeeds,
  before doing anything else.

## Step 0 — Readiness (any failure → stop; nothing half-started)

1. **Resume?** Workspace `pipeline.md` with `status: active` **and** the ✋ artifacts on
   disk (`plan.md` + `qa.md` — `active` without them is a half-written record: treat as
   `draft`) → reconcile the phase ledger against ground truth per `pipeline-mode.md` →
   Decision record, re-run items 2–6 below compactly (a resume often lands in a new
   terminal), then continue from the first genuinely-undone phase (jump to Step 4).
   `status: draft` — interviewed, never approved: keep the recorded answers, redo
   Steps 1–3 compactly from the workspace cache and re-present the ✋ — approval never
   comes from a resume. `done` / `aborted` / absent → fresh run.
2. **Fresh context.** If the context monitor flagged this prompt (its notice
   recommends `/compact`), recommend the stronger option — `/clear` + rerunning
   `/fnd:ship <ticket>`; proceed only if the developer insists.
3. **Environment** (the `preflight-checks` scope, inline and compact — classify here,
   not mid-run): Atlassian MCP up; Figma MCP when designs are involved; Chrome DevTools
   MCP; the **local dev server** running (`npm run dev` — Turbo: `shopify theme dev -e dev`
   + Vite — or `npm run theme:shopify`); not running → ask the developer to start it —
   a long-lived interactive process the developer owns; never start or kill it yourself;
   `gh auth status`; Shopify CLI present; **store access** — one cheap read through
   `${CLAUDE_PLUGIN_ROOT}/scripts/shopify-admin-gql.sh` (probe `.graphql` → scratch),
   then classify: read failed → `none`; read ok → probe
   `currentAppInstallation { accessScopes }` — a `write_*` scope present → `full`, else
   `read-only` (never infer `full` from a working read). `error=` is **not** a stop:
   record the level (`theme-json.sh` still works via the Theme Access token) plus the
   exact fix the runner prints; Step 2 turns it into a question — apply the fix, or run
   data work in **Mode 2** (`metafield-metaobject-setup.md`).
4. **Permissions.** List the side-effect commands this run will execute — `git commit`,
   `git push`, `gh pr create`, `gh pr checks` (the `--watch` loop), `gh api` (aftercare
   thread polling **and** the `graphql` `resolveReviewThread` mutation), `gh pr ready`
   (the draft end-state flip), `${CLAUDE_PLUGIN_ROOT}/scripts/*.sh`,
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/md-to-adf.cjs`, plus the policy-gated Atlassian
   MCP writes (`editJiraIssue`, `addCommentToJiraIssue`) — and confirm with the developer
   that they're allowlisted (or acceptEdits is on); offer the `settings.json` entries or
   `/fewer-permission-prompts` if not. A permission prompt mid-run kills autonomy — fix
   this before the interview, not after the ✋.
5. **Workspace.** Ensure `.claude/fnd/<work-id>/` exists with `progress.md`
   (`${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md`, incl. the git-exclude line).
6. **Branch.** Working tree clean (or only this ticket's work in it); note the current
   branch for the interview.

## Step 1 — Ingest (parallel reads, workspace-first)

As develop's Phase 1: context-first, then workspace, then fetch (layout + write rule:
`${CLAUDE_PLUGIN_ROOT}/references/task-workspace.md`) — every reader gets the workspace path
and writes its own file.
Spawn concurrently: **`jira-reader`** (Description, AC, TA, Steps to Test, links,
`figma_urls`), one **`figma-reader`** per Figma URL, **`theme-explorer`** seeded with the
task intent. Once `jira-reader` returns the links, spawn one **`doc-reader`** per
remaining doc link, in parallel, per
`${CLAUDE_PLUGIN_ROOT}/references/reading-linked-docs.md` (reuse-before-fetch; pass the
workspace path; Notion mandatory — a reader naming a missing MCP → stop and tell the
developer). Then **validate readiness**: Description, AC,
approved **Technical Approach**, Figma node — any missing → **stop** and point at the gap
(`/fnd:write-technical-approach` for a missing TA). If the ticket/docs define metafields
or metaobjects, plan the provisioning per
`${CLAUDE_PLUGIN_ROOT}/references/metafield-metaobject-setup.md` → **Planning & QA
digest** (the file's first ~45 lines — read only that; the rest is implement-phase
material). Read the
load-bearing files `theme-explorer` points to yourself — the plan is built from real
understanding, not the scout's summary.

**Store-data audit** — you (the conductor) derive the dependency list; a subagent runs
the probes. From the ticket + TA + the theme code the change touches, list
every store-data dependency needed to **build and to QA**: metafield/metaobject
definitions AND actual values, selling plan groups
(subscriptions), bundle configuration, target products/collections/pages, template
assignments, app-owned records. Then spawn one **general-purpose subagent**
(`model: sonnet`) briefed with that list, the store-access level from Step 0, the
workspace path (`.claude/fnd/<work-id>/`, so `--out` dumps land in its `tmp/`, never the
project root), and the probe rules — **strictly read-only**: GraphQL queries only (no
mutations) via `${CLAUDE_PLUGIN_ROOT}/scripts/shopify-admin-gql.sh`, targeted, not a full
catalog scan, and `theme-json.sh` **`get` only, never `set`** — it probes, it never mutates
store or theme state (that right belongs to the post-✋ phases, under snapshot→restore);
anything big goes through `--out` into the workspace `tmp/` + `jq`; never `Read` `.env` or
`shopify.theme.toml` — the bundled runners consume secrets without exposing them, and an
auth failure is a result (mark the row **unverified**), never a reason to hunt for
credentials; no/partial admin access → probe what it still can (theme code,
`theme-json.sh` state, public storefront endpoints: `/products/<handle>.js` exposes `selling_plan_groups`, while metafield-driven
markup shows only in the rendered page HTML, not in that payload) and mark the rest
**unverified**. It returns only the compact map: requirement →
**present** (+ the concrete product/entity handle that carries it — that's the QA
target), **definition-only** (schema exists, no values), **missing**, or **unverified**.
Write that map to `notes.md` as `store-data:` entries — the probe payloads stay in the
subagent. Every gap
or unverified entry becomes a Step 2 interview question — never a mid-run escalation.

## Step 2 — Interview (batched, once)

AskUserQuestion, ≤4 questions per call, 2–3 calls as the target — but **every store-data
gap always gets its question**; an extra call beats an unasked gap. Every question
carries your
recommended answer. Explore the codebase instead of asking whenever the code can answer.

- **Ticket-specific:** the design-tree walk develop does one-at-a-time — batched here:
  AC ambiguities, component/pattern choices, data-source decisions; **every store-data
  gap from the audit**, one question each with your recommended answer — provision mock
  data (say on which product and with what values; the default when **write** access
  exists — on a read-only store recommend existing data or Mode 2 instead, and name the
  break-it mutation rows that will report `not-executable: access` per `break-it-qa.md`
  so the ✋ checklist shows them upfront; provisioning per
  `metafield-metaobject-setup.md` → Planning & QA digest) vs the developer points at existing data
  (product/URL — e.g. "subscriptions live on /products/lip-pencil") vs **Mode 2**: you
  prepare the queries/mutations as the living `.graphql` file and the whole exchange —
  the developer runs each step in the GraphiQL App and pastes the returned ids back —
  **completes before the ✋** (the data must exist when Step 4 starts; the autonomous
  run can't pause for manual execution) vs static-only validation for those
  QA rows (named in the checklist, never silently skipped).
  **AC touching a logged-in customer, checkout, or account pages** can't run on the
  local dev server — decide here: mark those rows `preview-theme` (the qa phase builds
  the `[ELC-…]` preview theme and tests them on its preview URL) or
  `not-executable: access`; never simulate a logged-in state locally.
- **Policy set:** working branch (stay vs create + name) and PR target branch (default
  `develop`); commit scope (ticket key?); preview theme (auto-create `--reuse` vs manual
  triplet) + storefront path for deep-links; PR **end state — draft vs ready**
  (recommend `draft`; the PR is always *created* ready so review bots see it — aftercare
  applies the end state last, phase 6); Jira write-backs via
  MCP — Steps to Test field / PR link / hand-off comment (each yes/no); PR bots to await
  (names — before recommending "none", probe recent repo PRs for bot reviewers via
  `gh api`) + timebox in minutes (a cap on active bot work — silent bots exit early,
  pipeline-phases §6); research pressure-test of the plan — an external
  cross-check subagent, token-heavy (default no; runs in Step 3).
  QA depth is **not** a question (`break-it-qa.md` → No reduced mode — that rule's
  single home).

Write `pipeline.md` per `pipeline-mode.md` (`status: draft`; caps, the phase list).

## Step 3 — Contract ✋ (the only gate)

Draft **two artifacts** and present them together:

- **Implementation plan** — ordered, reviewable; heavy tickets split into milestones,
  each independently landable and ending in a working, clean state; metafield/metaobject
  provisioning included; deviations from the TA called out.
- **QA checklist** from the AC — the **state-variant matrix**: every AC-relevant config
  axis × each allowed value × each source that can drive it (customizer AND
  metafield/metaobject when both exist); every data-driven row names its **QA target**
  (product/entity handle) from the store-data audit — rows resolved as static-only are
  marked so; break-it rows per
  `${CLAUDE_PLUGIN_ROOT}/references/break-it-qa.md` (its rules govern — No reduced
  mode, `not-executable: access`); design
  conformance vs the Figma
  specs; accessibility; performance; viewport & cross-browser — the same dimensions
  solo QA covers.

**Policy said yes to the pressure-test** → **before presenting**, run it on the draft plan
per `${CLAUDE_PLUGIN_ROOT}/references/research-pressure-test.md`, pinning `model: opus`.

✋ Wait for explicit approval (edits welcome). Then save `plan.md` + the checklist into
`qa.md`, finalize `pipeline.md` and flip `status: draft` → `active` — only this approval
makes the record executable; the autonomy rule takes over from here.

## Step 4 — Autonomous run (conductor + phase-agents)

**Phase protocol**, for every phase in the list below unless its brief in `pipeline-phases.md`
says otherwise (one runs inline, one adds a parallel spawn): spawn a **fresh
general-purpose subagent**
whose brief contains the workspace paths (`pipeline.md`, `progress.md`, the artifacts
this phase consumes), the phase's reference list, its mission, and the standing rules —
*"follow the phase-start re-read protocol; never ask the user — return
`ESCALATE(question, context, options)` instead; never `Read` `.env` or
`shopify.theme.toml` — the bundled runners consume secrets without exposing them, and an
auth failure is a result to `ESCALATE`, never a reason to hunt for credentials; log
judgment calls to `notes.md` as dated
`pipeline:` entries; on completion write your artifact and tick your `progress.md` row
(aftercare: `pipeline.md` only); your final message is a compact report
(≤ ~20 lines), never file dumps."*
**Model tiering:** phase agents never inherit the session model — pass `model` explicitly
on every spawn; the assignments live in `pipeline-mode.md` → Phase-agent models (their
single home).
The conductor verifies tick + artifact before advancing, ticks the `pipeline.md` phase
row, and relays any `ESCALATE` via AskUserQuestion → appends the answer to `pipeline.md`
→ re-spawns the phase (it resumes from the artifacts).

The phases, in order: **implement → qa → finalize → create-pr → steps-to-test → aftercare →
jira-hand-off** (the row mapping above says which `progress.md` row each ticks). Their briefs
— mission, what the brief must contain, the per-phase reference list, the phase-local caps and
escalations — live in `${CLAUDE_PLUGIN_ROOT}/references/pipeline-phases.md`: **read it here, at
the start of Step 4, and not before** — it is this step's working spec and pure weight before
the ✋, so a run that stops at the gate never pays for it. Work it phase by phase; every brief
there inherits the protocol above.

## Final report

PR URL · checks/threads state · QA pass/fail table · Jira writes made · preview-theme
links · judgment-call digest · anything pending (bots). Set `pipeline.md` →
`status: done`; every `progress.md` row **this run owns** ticked with dates (rows ship
never runs — e.g. the pre-existing `write-technical-approach` — stay as they were). Offer workspace cleanup once
the ticket is Done. Nothing else to offer — the series is complete.

## Quality bar

- Zero unplanned stops: the interview, one ✋, and contract escalations only — a
  permission prompt mid-run is a Step 0 failure.
- Solo interop intact: same artifacts, same `progress.md` rows, `.fnd-review` stamped —
  an interrupted run continues solo without unwinding.
- Every autonomous decision is either pre-approved in `pipeline.md` or logged in
  `notes.md`.
- Output formats render from the shared references (commit message, PR body, Steps to
  Test) — parity with the solo skills' standards.
