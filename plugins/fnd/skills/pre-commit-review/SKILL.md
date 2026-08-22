---
name: pre-commit-review
description: Review the branch's changed files before committing — hygiene plus a bug-hunter correctness pass. Use when the user is about to commit, says "before commit", asks to tidy / clean a branch, check for stale comments or leftover ticket numbers, or review the changes for bugs.
---

# Pre-commit review

Hygiene **+ correctness** pass over the changed files **before a commit**. Five checks →
a written plan → developer approves/corrects → apply. **Never commits** — committing is
the fnd `commit` skill's job (`/fnd:commit` on Claude Code), and the developer invokes it
themselves.

## 0. Review-flow gate

This skill is the primary home of the fnd review flow. Follow the shared contract in
`../../references/review-flow.md` (paths in this skill are relative to this skill's
directory):

- Compute `branch` / `base` / `diff_hash` per §1 and read the marker at
  `"$(git rev-parse --git-dir)/.fnd-review"` (resolved, never the literal `.git/` path —
  a linked worktree's `.git` is a file); **first
  review on this branch** → run the full pass below; **already reviewed** → the §3 ask
  (`[ full re-review / only the changed files / skip ]`) — honour the choice.

After the pass is applied (step 4), **write/refresh the marker** (review-flow's marker block).

## 1. Determine scope

Scope = review-flow §1's diff — merge-base of the resolved `$base` to the **working tree**,
so committed, staged, and unstaged work all land in scope (this review runs *before* the
commit):

```bash
git diff --name-only "$mb"   # $base / $mb per review-flow §1
```

Review **only these files** (untracked new files surface via check D) — produce the list
only; the review agents read them (step 2).

## 2. Run the five checks

**How the work is split** (per `review-flow.md` — don't read the same files twice):

- **B and D run inline here** — they're mechanical (`git diff | grep`, `git status`), no
  agent needed.
- **A and C are delegated to the `change-reviewer` agent** (`hygiene` emphasis) so the
  heavy file-reading stays out of the main context. Small vs large diff and the
  file-group split follow `review-flow.md` §2. Pass each agent its file group, the
  `base`, and the raw B/D hits — **confirming hits is the agent's job** (it reads those
  files anyway); inline you only gather candidates. The agent may also return **E rows**
  (project-rules conformance — `protected-core` is always a blocker); they join the
  step-3 plan like every other finding.
- **F is delegated to the `bug-hunter` agent, spawned in parallel with the
  change-reviewer(s)** when the review-flow correctness gate holds (the diff touches
  JS/TS logic, Liquid control flow, or request handling — pure copy/CSS/locale diffs
  skip it, say so in one line). Pass it the `base` and the documented `ceiling:` entries
  from the workspace `notes.md` when a workspace exists. Its findings join the step-3
  plan as check-F rows, failure scenario included — the agent reports findings, not
  fixes: derive each row's **Proposed change** from the failure scenario yourself and
  carry the finding's Severity/Verdict into the row.

The five checks (A, C, and F full definitions live in the agents — their single home):

- **A — Accuracy / staleness** — run by the agent: comments that no longer match the current code.
- **B — Ticket references.** Flag any reference to the ticket **or its parts** in a comment —
  Jira keys (`\b[A-Z]{2,}-\d+\b`) and ticket-section pointers (`(AC 1a)`, `TA 3b`, and
  `Acceptance Criteria` / `Technical Approach` / `Steps to Test` used as ticket references).
  Propose removing the reference while keeping any useful context (reword to say what the code
  does or why — don't just delete the sentence). First-pass signal: review-flow's
  B-candidates grep. Raw hits go to
  the agent, which confirms each is inside a **comment** and applies the false-positive
  whitelist — its single home is the `change-reviewer` definition.
- **C — Refactor / improvement (required)** — run by the agent: duplication, dead code, unclear
  names, small correctness/readability wins — **in the changed code only**, every change gets a pass.
- **D — Untracked referenced files.** Verify every file the changed code references —
  rendered/included snippets, imported JS/TS modules, assets, sections named in `templates/*.json` —
  exists on disk **and is tracked by git**. First-pass signal:
  ```bash
  git status --porcelain | grep '^??'
  ```
  the candidates go to the `change-reviewer` with the B hits — it confirms which untracked
  paths the diff actually references. A referenced-but-untracked
  file breaks the theme on deploy — propose `git add <path>` for each one found.
- **F — Correctness (bug hunt)** — run by the `bug-hunter` agent: real bugs in how the
  diff interacts with unchanged code (races, merchant-invariant bypasses, state
  divergence between sibling paths, base-class traps), each verified with a concrete
  failure scenario.

## 3. Present the plan

Print a single review plan grouped by file. **Every check's rows go in the plan — A, B, C,
D, F, plus any E rows the agent returned** — each
row is a concrete proposed change with a one-line rationale. Number the rows sequentially in a
first `#` column so the developer can reference findings by number:

| # | File:line | Check | Issue | Proposed change |
|---|---|---|---|---|
| 1 | `snippets/foo.liquid:42` | B (ticket ref) | comment says `ELC-70 (AC 1a): …` | drop the ref → `Flattened parent: …` |
| 2 | `src/entry/bar.ts:18` | A (stale) | comment names `oldFn`, code uses `newFn` | update to `newFn` |
| 3 | `src/entry/bar.ts:30` | C (refactor) | same 5-line block duplicated below | extract `formatLabel()` helper |
| 4 | `snippets/baz.liquid:7` | D (untracked) | renders `snippets/baz__item.liquid`, file untracked | `git add snippets/baz__item.liquid` |
| 5 | `src/components/qty.ts:88` | F (correctness) | value setter re-emits `change` → second debounced pass grows the line when the request beats the 300ms debounce | don't touch `value` in the branch; snap the input back |

Then **ask the developer to review and correct** the plan ("remove any you disagree with, add
anything I missed"). **Check-F rows are dispositioned, never dropped** (review-flow.md →
Correctness findings): the developer picks fix / justify / waive per row; a justification
becomes a named ceiling — record it as a `ceiling:` entry in the workspace `notes.md`
(when one exists) so `create-pull-request` carries it into the PR body. Do not edit yet.

## 4. Apply

After the developer approves (with their corrections), make exactly the agreed edits — nothing
more. For approved check-D rows, run the agreed `git add <path>` so the referenced files are
tracked. Then **stop**: report what changed and hand the commit back to the developer — stage
the files and suggest the fnd `commit` skill (invoking it authorizes the commit — it commits
directly with a Conventional-Commits message and reports the result). Never run
`git commit` from this skill. If the branch's ticket has a task
workspace, tick `pre-commit-review` in its `progress.md`.

**Write the marker.** After the edits are applied, record the review for this branch so
`commit` / `create-pull-request` don't redundantly re-review (recompute `diff_hash` so it
reflects the post-edit state — see `../../references/review-flow.md` §1).
Include the `correctness_hash` line when check F was handled this pass (bug-hunter ran,
or the gate said not applicable):

Write it with review-flow's marker block, recomputing `diff_hash` from the post-edit tree;
append the `correctness_hash` line only when check F was handled this pass.

## Guardrails

- Report → approve → apply. Never edit before approval; never expand past the approved list.
- Only touch files in the branch diff (step 1). No drive-by changes elsewhere.
- Never commit, push, or stage-and-commit automatically.
