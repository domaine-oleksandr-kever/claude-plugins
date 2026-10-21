# Drafter loop — `fe:stt-drafter`, `fe:pr-body-drafter`

The long text is written and revised in the drafter's context. This session holds only the path,
the drafter's `unconfirmed` list, its questions and — for a PR — the title and Summary. The PR
drafter's `mode: jira` turn (create-pull-request Phase 2 step 2) writes `jira-comment.md` by this same loop.

## Spawn
`Agent(subagent_type: "fe:<drafter>", prompt: <brief>)` — **no `model`**: the frontmatter pins it
(sonnet / haiku), and a passed model overrides the pin. A drafter spawn **is** the delegation:
base's edit-delegation rule (`Agent(model: …)` for every file change) does not apply to it, and the
drafter's own `Write` is the file change — never wrap it in another agent.
Keep the agent id or name the result gives: every later turn goes to that same agent.
SendMessage may be a deferred tool: load it once with ToolSearch `select:SendMessage` before the
first continuation.
Brief fields every drafter takes: `workspace:` (absolute) · `ticket:` · `branch=` / `base=`
(`<base root>/scripts/review-scope.sh --ws <workspace> | sed -n '1,2p'`, both lines verbatim) ·
`answers:` (every developer answer already collected, verbatim, each with its question) ·
`mode: draft`. The skill step lists its own extra fields — `theme:` (a list, one entry per preview
theme with its `note:`) is the PR drafter's only; the stt drafter never gets the session preview.

## Check every return in code
Pipe the drafter's reply, unchanged, to
`node <fe root>/scripts/drafter-check.cjs receipt <stt|pr|jira>` (a quoted heredoc). `result=fail` →
SendMessage the `fail` lines back once (`error: receipt — <lines>`); a second fail → tell the developer
and stop.

## Its return — exactly one of
- `ESCALATE` → one AskUserQuestion with the items as asked, the first option as the recommended one;
  a free-text answer passes verbatim. Then **SendMessage the same agent** `mode: answers` + each
  question with its answer. Never answer an item yourself; a skipped item →
  `answer: skip — mark it unconfirmed`.
- `LOOKUP` (stt only) → run each item through `/base:shopify` on its store, read-only; SendMessage
  `mode: answers` + `lookups:` — per item the handle, `found` / `not found` / `no access`, and the
  properties asked, one line each. Never the query output.
- `answer:` → relay its lines to the developer as the drafter's answer.
- `written: <path>` (+ `unconfirmed:`, `report:`, the PR fields) → run
  `node <fe root>/scripts/drafter-check.cjs file <stt|pr|jira> "<path>"` (pr: the Theme preview table check
  is the default; add `--no-preview` only when `notes.md` holds the developer's recorded
  `preview-decision: no preview` line — the script itself checks it); `fail` lines → SendMessage
  `revise:` + those lines; ok → the checkpoint. On the pr drafter's jira turn every `revise:` and
  `ask:` also carries `file: jira-comment.md` (that agent wrote `pr-body.md` too).
- `error: …` → show it, fix the brief once, re-send.

**Termination:** at most 2 ESCALATE rounds, 1 LOOKUP round, 1 brief fix and 1 check-fix round per
drafter. Past any cap, tell the developer what is still open and stop — never loop.

## Never read the draft
You never `Read`, `cat`, `head`, `tail`, `sed`, `grep` the text of, open, quote, summarise or
paraphrase the draft file — not to check it, not to present it, not after an edit. The checkpoint
shows its absolute path as a clickable link, the `unconfirmed` list and the questions. The only
command on the file is `drafter-check.cjs`, which prints counts. base's guard refuses a main-session
`Read` of a task workspace's `steps-to-test.md`, `pr-body.md` or `jira-comment.md` whenever base runs — on
any model, `/base-edit-direct` included; only `BASE_GUARD=0` lifts it. That refusal is the rule, not
an obstacle to route around.

## Questions and edits
A developer question about the content ("why step 3?") → SendMessage `mode: ask` + the question
verbatim. Feedback → SendMessage `mode: revise` + their words verbatim; the drafter re-reads its file,
rewrites it and returns the same contract. Never edit the file, and never ask the developer to — if
they did anyway, the drafter's re-read picks it up.

## Continuation lost
SendMessage missing, or the agent no longer answers (a new session, `/clear`) → spawn a fresh drafter
with the same brief + `mode: revise` + `previous: <path>` + the feedback or answers.

## Hand-off
After approval the path is the hand-off: `base:jira-writer`'s `source`, or `gh pr create --body-file`.
