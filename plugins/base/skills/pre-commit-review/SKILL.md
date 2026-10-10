---
name: pre-commit-review
description: Review the branch's changed files before committing — hygiene plus a bug-hunter correctness pass. Use when the user is about to commit, says "before commit", asks to tidy / clean a branch, check for stale comments or leftover ticket numbers, or review the changes for bugs.
argument-hint: "[profile: <word>]"
arguments:
  - name: profile
    description: The checkout's profile word a team plugin names (fe passes foundation|theme|none), with the team rules it carries. Optional — from the caller's brief or the team plugin's section; absent means none.
---

# Pre-commit review

Hygiene **+ correctness** pass over the changed files **before a commit**. Five checks → a written
plan → developer approves/corrects → apply. **Never commits** — committing is `/base:commit`'s job,
and the developer invokes it themselves.

## 0. Review-flow gate

This skill is the primary home of base's review flow. Follow the shared contract in
`${CLAUDE_PLUGIN_ROOT}/references/review-flow.md`:

- Compute `branch` / `base` / `diff_hash` per §1 and read the marker at
  `"$(git rev-parse --git-dir)/.base-review"` (resolved, never the literal `.git/` path — a linked
  worktree's `.git` is a file); **first review on this branch** → run the full pass below; **already
  reviewed** → the §3 ask (`[ full re-review / only the changed files / skip ]`) — honour the choice.

After the pass is applied (step 4), **write/refresh the marker** (review-flow's marker block).

## 1. Determine scope

Scope = review-flow §1's **scope diff** — merge-base of the resolved `$base` to the **working
tree**: committed, staged, unstaged and untracked work (this review runs *before* the commit).
Review **only the files its `--name-only` lists** — produce the list; the agents read them (step 2).

**Profile.** The `profile` word comes from whoever invoked this skill: the argument, a team plugin's
brief, or the team plugin's own system-prompt section naming the checkout's profile and its team
rules. base detects none itself. With none → `profile: none` (the repo's own rule files only).

## 2. Run the five checks

**How the work is split** (per `review-flow.md` — don't read the same files twice):

- **B and D run inline here** — they're mechanical (`git diff | grep`, `git status`), no agent
  needed.
- **A and C are delegated to `base:change-reviewer`** (`hygiene` emphasis) so the heavy file-reading
  stays out of the main context. Small vs large diff and the file-group split follow `review-flow.md`
  §2. Pass each agent its file group, the `base`, the `profile` word with the team rules it carries,
  and the raw B/D hits — **confirming hits is the agent's job** (it reads those files anyway); inline
  you only gather candidates. The agent may also return **E rows** (project-rules conformance, as the
  team rules in its brief or the repo's `.claude/rules/*.md` state them); they join the step-3 plan
  like every other finding, with the severity the agent gave them.
- **F is delegated to `base:bug-hunter`, spawned in parallel with the change-reviewer(s)** when the
  review-flow correctness gate holds (the diff touches logic, control flow or request handling — pure
  copy/CSS/locale diffs skip it, say so in one line). Pass it the `base`, the untracked new files
  from the step-1 list, the documented `ceiling:` entries from the workspace `notes.md` when a
  workspace exists, and any domain hints the team plugin's section gives. Its findings join the
  step-3 plan as check-F rows, failure scenario included — the agent reports findings, not fixes:
  derive each row's **Proposed change** from the failure scenario yourself and carry the finding's
  Severity/Verdict into the row.

The five checks (A, C and F full definitions live in the agents — their single home):

- **A — Accuracy / staleness** — run by the agent: comments that no longer match the current code.
- **B — Ticket references.** Flag any reference to the ticket **or its parts** in a comment — Jira
  keys (`\b[A-Z]{2,}-\d+\b`) and ticket-section pointers (`(AC 1a)`, `TA 3b`, and `Acceptance
  Criteria` / `Technical Approach` / `Steps to Test` used as ticket references). Propose removing the
  reference while keeping any useful context (reword to say what the code does or why — don't just
  delete the sentence). First-pass signal: review-flow's B-candidates grep. Raw hits go to the agent,
  which confirms each is inside a **comment** and applies the false-positive whitelist — its single
  home is the `base:change-reviewer` definition.
- **C — Refactor / improvement (required)** — run by the agent: duplication, dead code, unclear
  names, a file or edit the finished change no longer needs (fix = delete), small
  correctness/readability wins — **in the changed code only**, every change gets a pass.
- **D — Untracked referenced files.** Verify every file the changed code references — included
  partials, imported modules, assets, config entries — exists on disk **and is tracked by git**.
  First-pass signal: review-flow's D-candidates line; the candidates go to `base:change-reviewer`
  with the B hits — it confirms which untracked paths the diff actually references. A
  referenced-but-untracked file breaks the build or the deploy — propose `git add <path>` for each.
- **F — Correctness (bug hunt)** — run by `base:bug-hunter`: real bugs in how the diff interacts with
  unchanged code (races, invariant bypasses, state divergence between sibling paths, base-class
  traps), each verified with a concrete failure scenario.

## 3. Present the plan

Print a single review plan grouped by file. **Every check's rows go in the plan — A, B, C, D, F,
plus any E rows the agent returned** — each row is a concrete proposed change with a one-line
rationale. Number the rows sequentially in a first `#` column so the developer can reference findings
by number:

| # | File:line | Check | Issue | Proposed change |
|---|---|---|---|---|
| 1 | `src/header.ts:42` | B (ticket ref) | comment says `ABC-70 (AC 1a): …` | drop the ref → `Flattened parent: …` |
| 2 | `src/bar.ts:18` | A (stale) | comment names `oldFn`, code uses `newFn` | update to `newFn` |
| 3 | `src/bar.ts:30` | C (refactor) | same 5-line block duplicated below | extract `formatLabel()` helper |
| 4 | `src/baz.ts:7` | D (untracked) | imports `src/baz-item.ts`, file untracked | `git add src/baz-item.ts` |
| 5 | `src/qty.ts:88` | F (correctness) | value setter re-emits `change` → a second debounced pass doubles the line when the request beats the 300 ms debounce | don't touch `value` in the branch; snap the input back |

Then **ask the developer to review and correct** the plan ("remove any you disagree with, add anything
I missed"). **Check-F rows are dispositioned, never dropped** (review-flow.md → Correctness findings):
the developer picks fix / justify / waive per row; a justification (a reason a reader of the code
can check, not intent) becomes a named ceiling — record it as a `ceiling:` entry in the workspace
`notes.md` (when one exists) so the team's PR skill carries it into the PR body. Do not edit yet.

## 4. Apply

After the developer approves (with their corrections), make exactly the agreed edits — nothing more.
For approved check-D rows, run the agreed `git add <path>` so the referenced files are tracked. Then
**stop**: report what changed and hand the commit back to the developer — stage the files and suggest
`/base:commit` (invoking it authorizes the commit — it commits directly with a Conventional-Commits
message and reports the result). Never run `git commit` from this skill. If the branch's ticket has a
task workspace, tick `pre-commit-review` in its `progress.md` when the series has that row.

**Write the marker** with review-flow's marker block, recomputing `diff_hash` from the post-edit tree
(`${CLAUDE_PLUGIN_ROOT}/references/review-flow.md` §1), so `/base:commit` and a team PR skill don't
re-review redundantly. Append the `correctness_hash` line only when check F was handled this pass
(`base:bug-hunter` ran, or the gate said not applicable).

## Guardrails

- Report → approve → apply. Never edit before approval; never expand past the approved list.
- Only touch files in the step-1 list. No drive-by changes elsewhere.
- Never commit, push, or stage-and-commit automatically.
