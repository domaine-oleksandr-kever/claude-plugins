# Research pressure-test — cross-checking a draft against fresh external sources

Shared reference for every flow that drafts a plan, a TA, or a ship implementation plan
(`/write-technical-approach`, `/develop-feature-or-fix`, `/fnd:ship` Step 3). A subagent
validates the **draft** against current external sources and returns findings; the raw
research never enters the calling context.

## When it applies

**Opt-in and token-heavy** — offered **once**, never auto-run, default **no**. Worth it
mainly for risky, novel, or integration-heavy work (a new app/API surface, a platform
behaviour that may have changed, a pattern the team hasn't shipped before). Routine tickets
skip it.

## The offer (solo skills)

One yes/no question, in the skill's own wording, always carrying the ⚠️ **Token-heavy**
warning and what it buys — e.g. *"Pressure-test this plan against fresh external sources
(Shopify changelogs, third-party docs)? ⚠️ **Token-heavy** — worth it mainly for risky,
novel, or integration-heavy work. `[ yes / no ]`"*. Default **no** → straight on to the
checkpoint. Ship asks it as a Step 2 policy question instead and runs the sweep in Step 3,
**before presenting** the ✋.

## The subagent brief

Spawn one **general-purpose subagent**:

- **Inputs** — the draft artifact **verbatim** (plan / TA / ship plan) plus the workspace
  extract paths (`ticket.md`, `doc-*.md`, `figma-*.md`); it **re-reads those from disk** and
  **never re-fetches the sources** (Jira, Notion, Figma) — they're already extracted.
- **Mission** — validate *this* approach against **fresh external sources** via
  WebSearch/WebFetch: Shopify changelogs and docs, third-party API docs, known-issue
  threads. A `deep-research` skill, if the session exposes one, may drive the sweep.
- **Return** — a compact findings list: **risks** / **corrections** / **confirmations**,
  each one line with its source. Never page dumps, never a research report.

**Model:** ship pins `model: opus`; the solo skills let it inherit the session model.

## Folding in

Fold the findings into the artifact and note **what changed** (a line per correction, so
the reviewer sees the delta) — then continue to the checkpoint. The research itself stays
in the subagent's context; only the findings and the edits they caused come back.
