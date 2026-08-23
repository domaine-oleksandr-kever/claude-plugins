# Pipeline mode — the `ship` run contract

How an autonomous `ship` run records its decisions, when it may act without asking,
when it must escalate, and how every phase re-grounds itself. Solo skills never read this
file — the pipeline is opt-in and leaves solo behavior untouched.

## Decision record — `.claude/tasks/<work-id>/pipeline.md`

Written by ship at the end of the interview as `status: draft`, armed to `active` only
by the ✋ approval; the single source of pre-approved decisions.

```markdown
---
status: draft   # draft | active | done | aborted
started: <ISO datetime>
session: <$CLAUDE_CODE_SESSION_ID>
---
## Policy answers
- working branch: <existing|create + name> · target branch: <develop|main|…>
- commit scope: <ticket key? yes|no> · PR end state: <draft|ready> (created ready; applied by aftercare — rationale: ship Step 2)
- preview theme: <auto|manual triplet> · storefront path: </products/…>
- Jira write-backs via MCP: steps-to-test <yes|no> · PR link <yes|no> · hand-off comment <yes|no>
- bots: <names> · bot timebox: <min> (cap on active bot work; silence by ~10 min after PR creation → early exit)
- store data: <gap → resolution: existing on <product> | mock on <product> | Mode 2 (.graphql, dev-run pre-gate) | static-only> (one per audit gap)
## Ticket answers
- <question> → <accepted answer> (recommended: <what ship suggested>)
## Caps
- qa fix→re-QA cycles: 2 · aftercare rounds: 2
## Phases
- [ ] implement
- [ ] qa
- [ ] finalize
- [ ] create-pr
- [ ] steps-to-test
- [ ] aftercare
- [ ] jira-hand-off
```

`status: draft` means interviewed, not yet approved — a resume never enters the
autonomous run from it; the ✋ approval flips it to `active`. It flips to `done` at the
final report, `aborted` when the developer stops the run.
The Phases list is the resume ledger — but on resume, reconcile it against **ground truth**
(`progress.md` ticks, `git log`, `gh pr view`, Jira fields) before trusting it: solo skills
may have advanced the series meanwhile, and a crash can land between an action succeeding
and its tick. Never redo a done phase; never create a duplicate PR.

## Autonomy rule

After the single ✋ (plan + QA checklist) approval: **no further questions.** An answer
recorded in `pipeline.md` is pre-approved. Anything else that is off the escalation
contract: decide, act, and log the call (below). Phases tick `progress.md` exactly like
the solo skills and move straight on — no offer-next inside a run.

## Escalation contract

Escalate — the conductor asks the developer (on Claude Code: AskUserQuestion); a phase agent
returns `ESCALATE(question, context, options)` instead of asking — ONLY for:

- missing access / credentials (store, `gh`, an MCP server);
- an AC contradiction or material ambiguity the interview didn't cover;
- a destructive or irreversible action outside the pre-authorized list;
- a QA blocking failure that survives the fix cap;
- a `protected-core` blocker from the conformance review;
- scope growth beyond the ticket;
- any escalation a phase brief or shared reference explicitly names (e.g.
  `error=build_failed` on preview creation, bot findings surviving the aftercare cap, a
  store-data gap the audit missed, an unfixable reviewer F row, a git hook failing on a
  pre-existing repo defect).

Append the developer's answer to `pipeline.md` (the record grows mid-run), then continue.

**Pre-authorized by the record:** commit; push to the working branch; `gh pr create`; the
agreed Jira field writes; preview-theme creation; store TEST-state mutations under
snapshot → mutate → verify → restore — dev/preview theme customizer state via
`theme-json.sh` (the live theme is refused by the script) and test metafield/metaobject
entries per `references/metafield-metaobject-setup.md`.

## Judgment-call log

Every non-escalated call goes to the workspace `notes.md` as a dated `pipeline:` entry —
what was decided, why, and what a reviewer would need in order to undo it. The final
report and the Jira hand-off comment are distilled from these entries.

## Phase-agent models

Phase agents never inherit the session model — the conductor passes the phase's model on every
spawn (this section is the single home of the **Step 4 phase-agent** assignments; the briefs
those agents get live in `pipeline-phases.md` — **read only at the start of Step 4**, never
before the gate). Two tiers, by phase: **reasoning-heavy** — implement, qa, and the fix agents
in the qa loop and aftercare; **mechanical** — finalize, create-pr, steps-to-test, and the
aftercare poll/triage agent (its fix agents are reasoning-heavy). What each tier pins to is the
host's business — on Claude Code: `opus` for reasoning-heavy, `sonnet` for mechanical. Off Claude
Code, read the phase rows of `host-model-map.md` (generated: one tier table owns every non-Claude
pin, so no id is ever repeated in prose) and pass the id for this host; on OpenCode there is no
pin at all — phases inherit the session model, and tiering is opt-in via the optional
model-profile fragment. The inline conductor step (jira-hand-off) delegates its
one Jira write to the `jira-writer` subagent (so the comment body never enters the
conductor context); `jira-writer` pins its own model via frontmatter (on Claude Code:
`sonnet`), so the conductor passes none.
Pre-gate helpers (the Step 1 store-data audit, the Step 3 research pressure-test) are
pinned inline where ship spawns them; the reader agents pin via frontmatter. The
conductor itself stays on the session model — planning, decomposition, and synthesis are
where it earns its price — so run ship on the **strongest session model the host offers**
(on Claude Code: **Fable recommended**, Opus acceptable; elsewhere the conductor row of
`host-model-map.md`, which on OpenCode is the session model as selected); anything lighter
weakens the one context that makes every
judgment call. Gotcha, on Claude Code: a `CLAUDE_CODE_SUBAGENT_MODEL` env var silently
overrides every pin, including the bundled agents' frontmatter models — it must be unset
or `inherit`.

## Phase-start re-read protocol

Every phase — first run or resumed — STARTS by re-reading from disk, unconditionally:
`pipeline.md`, `progress.md`, and the artifacts it consumes (`ticket.md` AC, `plan.md`,
`qa.md`, `notes.md` as applicable). Context is a cache; the workspace is the truth. After
any compaction the in-context ticket is a lossy summary — never move on with it. This
rule is what makes auto-compact mid-run harmless.
