# fnd review flow — shared contract

Single source of truth for the "review the branch's changes" flow used by
`pre-commit-review`, `commit`, and `create-pull-request`. Those skills reference this
file instead of duplicating the logic.

The flow has three parts: **(1) a once-per-branch marker**, **(2) how the checks are
run** (cheap ones inline, expensive ones delegated to the `change-reviewer` and
`bug-hunter` agents), and **(3) what to do on entry** (first time vs. subsequent).

## 1. The marker — `.git/.fnd-review`

A tiny, branch-keyed record that answers one question: *has this branch been reviewed
before?* It lives inside `.git/`, so it is **never committed**, is local per-clone, and
survives context compaction and new sessions. It is **overwritten** each time (never
appended) → constant size, no cleanup. Always resolve the path with
`git rev-parse --git-dir` — in a linked worktree `.git` is a *file*, not a directory, so
the literal path fails; the resolved one gives each worktree its own marker.

Format (plain `key=value` lines, no `jq` needed):

```
branch=<current branch>
base=<develop|main>
diff_hash=<hash of the reviewed diff>
reviewed_at_head=<commit sha at review time>
correctness_hash=<diff hash when check F was last satisfied — line absent if never>
```

`correctness_hash` records that the **correctness pass (check F)** was handled for that
exact diff — either `bug-hunter` ran, or the correctness gate legitimately said "not
applicable". Absent or ≠ the current `diff_hash` → the branch's correctness pass is
missing or stale.

Compute scope + hash:

```bash
branch=$(git rev-parse --abbrev-ref HEAD)
base=$(git show-ref --verify --quiet refs/heads/develop && echo develop \
  || { git show-ref --verify --quiet refs/remotes/origin/develop && echo origin/develop || echo main; })
# ONE diff from the branch point to the WORKING TREE — covers committed, staged, and unstaged
# changes alike (a { base...HEAD; git diff; } pair would miss staged-but-uncommitted edits):
mb=$(git merge-base "$base" HEAD)
diff_hash=$(git diff "$mb" | git hash-object --stdin)
```

Read it:

```bash
marker="$(git rev-parse --git-dir)/.fnd-review"
if [ -f "$marker" ] && grep -qx "branch=$branch" "$marker"; then
  reviewed_before=yes
  prev_hash=$(sed -n 's/^diff_hash=//p' "$marker")
  prev_head=$(sed -n 's/^reviewed_at_head=//p' "$marker")
  prev_correctness=$(sed -n 's/^correctness_hash=//p' "$marker")   # empty → check F never satisfied
else
  reviewed_before=no   # no marker, or marker is for a different branch → first time here
fi
```

Write it (only after a review actually ran — for `pre-commit-review`, **after** its edits
are applied, so it records the final reviewed state; add the `correctness_hash` line only
when check F was handled this pass):

```bash
marker="$(git rev-parse --git-dir)/.fnd-review"
{ echo "branch=$branch"; echo "base=$base"; echo "diff_hash=$diff_hash"; \
  echo "reviewed_at_head=$(git rev-parse HEAD)"; } > "$marker"
# ONLY when check F was handled this pass (bug-hunter ran, or gate: not applicable):
echo "correctness_hash=$diff_hash" >> "$marker"
```

**Re-stamp after a commit whose hooks rewrote the tree** (`commit` only). Project commit
hooks (husky / lint-staged running prettier, `eslint --fix`) rewrite files *during*
`git commit`, so the committed tree ≠ the reviewed one and `diff_hash` drifts — which makes
`create-pull-request`'s correctness backstop re-run `bug-hunter` over semantically
identical code. Mechanical rule: re-stamp **only** when the tree being committed *is* the
reviewed tree; the sole delta is then what the project's own hooks did, inside the same
commit, and the review covered exactly that pre-hook state. Pre-commit hash ≠ the marker's
(the developer edited after the review) → do **not** re-stamp; the PR-time backstop is
legitimate.

```bash
# BEFORE `git commit` — is the tree about to be committed the reviewed one?
marker="$(git rev-parse --git-dir)/.fnd-review"
pre_hash=$(git diff "$(git merge-base "$base" HEAD)" | git hash-object --stdin)
restamp=no; keep_correctness=no
if [ -f "$marker" ] && grep -qx "branch=$branch" "$marker" && grep -qx "diff_hash=$pre_hash" "$marker"; then
  restamp=yes
  # carry correctness forward ONLY if it was current; absent or stale → do NOT add the line
  if grep -qx "correctness_hash=$pre_hash" "$marker"; then keep_correctness=yes; fi
fi

# AFTER a successful `git commit` — did the hooks rewrite files?
post_hash=$(git diff "$(git merge-base "$base" HEAD)" | git hash-object --stdin)
if [ "$restamp" = yes ] && [ "$post_hash" != "$pre_hash" ]; then
  { echo "branch=$branch"; echo "base=$base"; echo "diff_hash=$post_hash"; \
    echo "reviewed_at_head=$(git rev-parse HEAD)"; } > "$marker"
  if [ "$keep_correctness" = yes ]; then echo "correctness_hash=$post_hash" >> "$marker"; fi
fi
```

A caller whose `allowed-tools` bars shell redirection may instead rewrite those lines in
place with `Edit` — on this path the marker exists by construction.

## 2. How the checks run

The cost is **reading the changed files**, which checks A and C (and E) share. So split by
**files, not by checks**:

- **B (ticket references) and D (untracked referenced files) run inline** in the calling
  skill — they're mechanical (`git diff | grep`, `git status`) and operate on the diff
  text + git metadata, not full-file reads. B covers Jira keys **and** ticket-section pointers
  (`(AC 1a)`, `(TA 1a)`, "Acceptance Criteria", "Technical Approach", "Steps to Test"):

  ```bash
  git diff "$(git merge-base "$base" HEAD)" | grep -nE '^\+[^+]' \
    | grep -E '\b[A-Z]{2,}-[0-9]+\b|\((AC|TA)[^)]*\)|\b(AC|TA) [0-9]+[a-z]?\b|Acceptance Criteria|Technical Approach|Steps to Test'   # B candidates (incl. staged + unstaged; ^\+[^+] skips +++ headers)
  git status --porcelain | grep '^??'                                          # D candidates
  ```

- **A, C, and E are delegated to the `change-reviewer` agent** so the heavy reading stays
  out of the main context (only the findings table comes back):
  - **Small diff** (≲ 15 changed files / ≲ 1500 diff lines) → **one** `change-reviewer`.
  - **Large diff** → **one `change-reviewer` per file-group, in parallel** — each file is
    read once; wall-clock drops. Split the file list into a few balanced groups.
  - Pass each agent: the `base`, its file group, the **emphasis** (see below), and the raw
    B/D hits to confirm.

- **F (correctness) is delegated to the `bug-hunter` agent** — an adversarial pass that
  hunts for real bugs (races, merchant-invariant bypasses, state divergence between
  sibling paths, inherited-behavior traps, dropped data). It applies when the
  **correctness gate** holds:

  > **Correctness gate:** the diff touches JS/TS logic, Liquid control flow, or request
  > handling. Pure copy / CSS / locale / schema-label diffs skip it — say so in one line
  > and still record `correctness_hash` (the pass was handled: not applicable).

  Spawn it **in parallel** with the `change-reviewer` agent(s) — same diff, different
  lens; on a large diff reuse the same file-groups. Pass it the `base`, its file group,
  and the documented ceilings (`ceiling:` entries from the task workspace `notes.md`)
  when a workspace exists.

- **Emphasis by caller** — assigned per skill in §3 → Per-skill entry behaviour.

- **Who spawns these agents, per host.** Solo: the caller is the session and spawns them
  directly. Inside a `ship` run the caller is a phase agent — it spawns them itself where it may
  (on Claude Code, always); where it may not,
  `<plugin root>/references/pipeline-phases.md` → Orchestration says who does. Same agents,
  emphases and blocking semantics; a caller that can neither spawn nor was handed findings never
  skips the pass — it `ESCALATE`s (pipeline) or tells the developer (solo).

Merge the agent findings with the inline B/D hits into one plan/table for the developer.

### Correctness findings — disposition is mandatory

A finding tagged correctness (check F from `bug-hunter`, or stumbled on by
`change-reviewer` while reading) is **never "observation only"**. The calling skill must
close every one explicitly — **fix** it, **justify** it (the justification travels to the
PR body as a **one-line named ceiling**, placement per
`<plugin root>/skills/create-pull-request/REFERENCE.md` → Body sections — **plugin root** = the
plugin's own directory, this file being `<plugin root>/references/review-flow.md`, and every
`<plugin root>/…` path here resolves the same way;
on Claude Code use the session context's `fnd plugin root:` path — `${CLAUDE_PLUGIN_ROOT}` is empty
in the Bash tool's shell; the full reasoning stays in `notes.md`), or have the developer
**explicitly waive**
it — and record the disposition (workspace `notes.md` when one exists). A **blocking**
correctness finding stops a PR the same way a `protected-core` blocker does.

## 3. On entry — first time vs. subsequent

**Agreed rule: the first review on a branch is full; every later run asks the developer.**

```
reviewed_before == no   → run the FULL flow (§2), then write the marker (§1).
reviewed_before == yes  → ASK the developer; do not auto-skip and do not auto-rerun.
```

> **Pipeline exception:** inside a `ship` run the autonomy rule forbids the ask —
> the finalize brief replaces it deterministically: `diff_hash` unchanged → skip (say
> so); changed or marker absent → full re-review. A phase agent never asks.

When asking (subsequent runs), enrich the prompt so the decision is easy:

- Compare `diff_hash` to `prev_hash`. If **unchanged**, say *"nothing changed since the
  last review"* and recommend **skip**. If **changed**, summarize what changed since the
  last review — `git diff <prev_head>` covers commits since then plus staged and unstaged
  work in one go — which files, rough nature (comments/style vs. logic):

  ```bash
  git diff "$prev_head" --stat
  ```

- Offer: **`[ full re-review ] / [ only the changed files ] / [ skip ]`**.
  - *only the changed files* → run `change-reviewer` on just the delta vs. `prev_head`
    (cheapest useful option).
- On any run that actually reviews, **refresh the marker** afterward.

### Per-skill entry behaviour

- **`pre-commit-review`** — emphasis `hygiene` (lead A + C); the primary home of the full
  review, **including check F** (`bug-hunter` in parallel with the `change-reviewer`(s)
  when the correctness gate holds). Applies edits after developer approval, then
  writes/refreshes the marker (incl. `correctness_hash`).
- **`commit`** — does **not** itself run the hygiene review. On entry: if
  `reviewed_before == no`, offer to run the `pre-commit-review` skill first (proceed if the dev
  declines); if `yes`, continue to the commit. (Its own untracked-file check still runs.)
  Around the commit itself it applies §1's **re-stamp** rule.
- **`create-pull-request`** — final gate; emphasis **`conformance`** (lead E;
  `protected-core` = blocker): first time on branch → full; else ask. Independently of
  that choice, the **correctness backstop**: `correctness_hash` absent or ≠ the current
  diff hash → apply the gate and run `bug-hunter` before drafting. **Any `protected-core`
  blocker or blocking correctness finding stops the PR** until resolved or explicitly
  waived by the developer.

> Optional fast-path: a skill may also print an in-context sentinel
> (`✓ fnd review · branch=… · <hash>`), but the `.git/` marker is the source of truth.
