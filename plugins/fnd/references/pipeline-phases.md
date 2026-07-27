# Pipeline phases — the Step 4 phase briefs

The seven briefs the `ship` conductor spawns after the Step 3 ✋. **Read this file only once
that approval exists** — before the gate it is unusable weight, which is why `ship`'s Step 4
holds a stub and defers to here. Single home of the per-phase mission, brief contents and
reference list; the standing rules every brief inherits, the tick/verify loop and the
`ESCALATE` relay stay in `${CLAUDE_PLUGIN_ROOT}/skills/ship/SKILL.md` → Step 4, and the model
each phase is pinned to lives in `pipeline-mode.md` → Phase-agent models.

The numbers are the execution order. Every phase is a fresh general-purpose subagent unless
its brief says otherwise.

1. **implement** — one agent per plan milestone, sequential. Brief: the milestone from
   `plan.md`, the AC, `figma-<node>.md` specs, the `store-data:` map + interview answers
   from `notes.md` (provision the approved mock data first — the audit already named the
   products and values); references:
   `metafield-metaobject-setup.md` (provision first when planned; every query/mutation
   you wrote passes `validate_graphql_codeblocks` before it runs),
   `section-css-variables-pattern.md`, `eslint-no-restricted-syntax.md`,
   `theme-customizer-state.md`. In-browser validation vs design + AC (Chrome DevTools
   MCP), data/customizer state walks via the runners, `git add` every new file, test
   paths / gids / `ceiling:` entries for intentional simplifications → `notes.md`.
2. **qa** — a fresh agent that did NOT implement, **plus a parallel `bug-hunter` spawn**
   over the diff as it stands at qa time (pre-finalize; pass the base branch and the
   `notes.md` `ceiling:` entries) —
   live QA can't reproduce timing races on a slow local proxy; the static hunt covers
   them from the code. The qa agent's brief: **first extend `qa.md`** with break-it rows
   derived from the *final diff* per `break-it-qa.md` → Deriving the rows (interactions
   added during implementation aren't in the gate-approved checklist — append them,
   marked `post-plan`), then execute `qa.md` verbatim + `break-it-qa.md` → Executing the
   rows; **QA targets (products/entities) come from the `store-data:` map in
   `notes.md`** — never rediscover them by scanning the store; a data gap the audit
   missed → ESCALATE, don't improvise; state walks through
   `${CLAUDE_PLUGIN_ROOT}/scripts/shopify-admin-gql.sh` /
   `${CLAUDE_PLUGIN_ROOT}/scripts/theme-json.sh` (snapshot → mutate → verify →
   **restore**); rows marked `preview-theme` (logged-in customer / checkout / account
   pages) → first build the `[ELC-…]` preview theme
   (`${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh create --name "<name>" --reuse`,
   id + links → `notes.md`) and run them against its preview URL — never simulate a
   logged-in state on the dev server; evidence per row; append the pass/fail report + findings with exact
   repro values to `qa.md`, blocking vs non-blocking. Merge the `bug-hunter` findings
   into the same triage — every one **dispositioned** (fix / justify → `ceiling:` entry +
   PR body / ESCALATE), never dropped.
   **QA loop:** blocking findings (either source) → a fix agent scoped to them → a fresh
   qa agent re-runs the affected rows (a fixed bug-hunter finding is re-verified by code
   read when it can't be reproduced live); **cap 2 cycles**, then ESCALATE with the report.
3. **finalize** — review + commit in one pass. Review per
   `${CLAUDE_PLUGIN_ROOT}/references/review-flow.md` with `hygiene` emphasis
   (`change-reviewer` subagent(s)) — §3's pre-existing-marker question is replaced by
   the pipeline exception (current `diff_hash` → skip and say so; stale or absent →
   full re-review; never ask); apply the objective classes (comment accuracy,
   ticket-ref stripping, untracked referenced files) — C-class refactor findings are NOT
   applied autonomously (the change already passed QA); log them to `notes.md` for the
   report and hand-off. **F-class (correctness) findings never land in that log-only
   bucket**: an F row from the reviewer → fix it when that fits the qa cap and is
   AC-compatible; justify → `ceiling:` entry + PR body; else ESCALATE.
   Stamp `.git/.fnd-review`; `diff_hash` is always the post-finalize diff. The hunt ran in
   the **qa** phase, over the pre-finalize diff, so `correctness_hash` follows
   `review-flow.md`'s rule (check F handled *for that exact diff*): finalize touched no
   correctness surface → stamp the post-finalize hash; finalize changed **code** the hunt
   never saw (an F-class fix, a logic edit) → **omit the `correctness_hash` line** and say so
   in the report: the conductor then spawns `bug-hunter` over the final diff and stamps, or
   leaves the missing pass to phase 4's backstop. Never recompute it blindly. Commit
   per `${CLAUDE_PLUGIN_ROOT}/references/commit-message-format.md` (scope per policy;
   body from plan + notes), then push the working branch. Tick **both**
   `pre-commit-review` and `commit` rows.
4. **create-pr** — agent. Brief: the policy answers (preview theme / target branch /
   storefront path), the `notes.md` `ceiling:` entries (+ the preview-theme id if qa
   already created it), and
   `${CLAUDE_PLUGIN_ROOT}/skills/create-pull-request/REFERENCE.md` — it owns the title
   convention, the body order (Summary → Jira → theme-preview table in the top third;
   ceilings → Dependencies) and the preview-theme decision flow (`[ELC-…]` naming,
   `--reuse`). Escalations, verbatim in the brief: `error=build_failed` → ESCALATE with
   the build output; `error=settings_drift` → the reference's manual recovery;
   conformance pass (`change-reviewer`, `conformance` emphasis) — a `protected-core`
   blocker → ESCALATE; **correctness backstop** per
   `${CLAUDE_PLUGIN_ROOT}/references/review-flow.md` §3's create-pull-request entry —
   `correctness_hash` absent or ≠ the current diff hash → the conductor applies the gate and
   spawns `bug-hunter` over the diff **before** spawning this phase, refreshing the marker
   after; a blocking finding ESCALATEs like `protected-core`, so the agent drafts only once
   the pass is clean. `gh pr create --base <target> --body-file <tmp>` — **never
   `--draft`** (the end state is aftercare's to apply). **Crash-safe, verbatim in the
   brief: the moment the PR exists, record its URL to `progress.md` + `notes.md` and
   tick the `create-pull-request` row — before any remaining work.** Return: PR URL,
   theme id + preview/editor links, ≤10-line report. The conductor verifies the tick
   and the recorded URL before advancing.
5. **steps-to-test** — agent; fills the bot wait. Write per
   `${CLAUDE_PLUGIN_ROOT}/references/steps-to-test-format.md` from the AC + `qa.md` +
   `notes.md` repro values; save `steps-to-test.md`; policy allows → write the field via
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/md-to-adf.cjs --no-tables` + `editJiraIssue`
   (`${CLAUDE_PLUGIN_ROOT}/references/jira-adf-write.md`).
6. **aftercare** — `gh pr checks --watch`; a failing check → diagnose → fix agent →
   commit + push (counts toward the aftercare-rounds cap). Then poll the policy bots' review threads via
   `gh api` (~90 s interval, up to the timebox). Per finding: triage vs AC/TA —
   AC-compatible → fix; contradicts AC or out of scope → don't, and say why. After any
   fixes: refresh the preview theme code
   (`${CLAUDE_PLUGIN_ROOT}/scripts/create-preview-theme.sh refresh --theme <id from
   notes.md>` — settings
   untouched), re-verify the touched flow in the browser, commit + push. Reply to
   **every** thread (what was done / why not) and resolve it (`gh api graphql`,
   `resolveReviewThread`). **Cap 2 rounds** → ESCALATE survivors. Timebox expiry with
   silent bots → "bots pending" in the report; move on. **Final thread sweep —
   unconditional**, even when the policy says no bots / timebox 0: no earlier than
   ~5 min after PR creation, re-poll the review threads once — bots post minutes after
   the PR opens, and a `skipping`/absent check is not proof of no review. New threads →
   run a bot round on them (caps apply); out of cap → report them as pending — never
   report "no threads" from a poll that raced the bot. **Last, apply the PR end-state
   policy** — on both exits (bot rounds done AND timebox expiry): `draft` →
   `gh pr ready --undo <pr>` flips the now-reviewed PR to draft (log to `notes.md`);
   `ready` → leave as-is.
7. **jira-hand-off** — inline in the conductor (no phase subagent, so no model to pin), but
   delegate its one Jira write to the `jira-writer` subagent so the comment body
   never lands in the conductor context. Policy allows → write the approved
   comment to a temp file (a **clickable PR link** + the distilled judgment calls from
   `notes.md`: accepted edge cases, anything not implemented and why, open questions),
   then spawn `jira-writer` (ticket · `comment` · that file) for the one
   `addCommentToJiraIssue` write (`${CLAUDE_PLUGIN_ROOT}/references/jira-adf-write.md`);
   policy forbids → print the comment for manual paste.
