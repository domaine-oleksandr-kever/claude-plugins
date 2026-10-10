# base review flow — shared contract

Single source of truth for the "review the branch's changes" flow used by
`/base:pre-commit-review`, `/base:commit`, and a team plugin's PR skill
(`/fe:create-pull-request`). Those skills reference this file instead of duplicating the logic.

The flow has three parts: **(1) a once-per-branch marker**, **(2) how the checks are
run** (cheap ones inline, expensive ones delegated to the `base:change-reviewer` and
`base:bug-hunter` agents), and **(3) what to do on entry** (first time vs. subsequent).

## 1. The marker — `.git/.base-review`

A tiny, branch-keyed record that answers one question: *has this branch been reviewed
before?* It lives inside `.git/`, so it is **never committed**, is local per-clone, and
survives context compaction and new sessions. It is **overwritten** each time (never
appended) → constant size, no cleanup. Always resolve the path with
`git rev-parse --git-dir` — in a linked worktree `.git` is a *file*, not a directory, so
the literal path fails; the resolved one gives each worktree its own marker.

Format (plain `key=value` lines, no `jq` needed):

```
branch=<current branch>
base=<develop|main|origin/develop|origin/main>
diff_hash=<hash of the reviewed diff>
reviewed_at_head=<commit sha at review time>
correctness_hash=<diff hash when check F was last satisfied — line absent if never>
```

`correctness_hash` records that the **correctness pass (check F)** was handled for that
exact diff — either `base:bug-hunter` ran, or the correctness gate legitimately said "not
applicable". Absent or ≠ the current `diff_hash` → the branch's correctness pass is
missing or stale.

Compute scope + hash with base's script (`<base root>` = `${CLAUDE_PLUGIN_ROOT}` in base's own
skills, the `base plugin root:` path elsewhere); pass `--ws .claude/tasks/<work-id>` when a task
workspace exists:

```bash
<base root>/scripts/review-scope.sh --ws .claude/tasks/<work-id>
# branch=…  base=…  merge_base=…  diff_hash=…  excluded=…   then a blank line and the scope's files
```

The **scope** is one diff from the merge-base with `base` (develop, else main; `origin/<b>` when the
local branch is missing or only behind it) to the **working tree**: committed, staged, unstaged and
untracked work, so the hash is the same before and after `git add`. Untracked files under
`.claude/`, `docs/technical-approaches/`, any `.env*` and `settings.local.json` stay out. The files
listed after the blank line are the reviewed-files list; `--diff` prints the scope diff itself,
`--since <rev>` its `--stat` and files against `<rev>`. The script's header is the full contract.

Files a preview build rewrote (the workspace's `build-dirtied:` lines since the last bare one) are
a build artifact, not the developer's change: their working-tree rewrite leaves the scope, the hash
and the agents' file groups. A file with no committed or staged change of its own leaves whole and
is named in `excluded=`; one the branch committed or staged stays in, diffed up to the index. A bare
line with no paths ends the exclusion.

Read it (`branch` and `diff_hash` are the script's values):

```bash
marker="$(git rev-parse --git-dir)/.base-review"
if [ -f "$marker" ] && grep -qx "branch=$branch" "$marker"; then
  reviewed_before=yes
  prev_hash=$(sed -n 's/^diff_hash=//p' "$marker")
  prev_head=$(sed -n 's/^reviewed_at_head=//p' "$marker")
  prev_correctness=$(sed -n 's/^correctness_hash=//p' "$marker")   # empty → check F never satisfied
else
  reviewed_before=no   # no marker, or marker is for a different branch → first time here
fi
```

Write it (only after a review actually ran — for `/base:pre-commit-review`, **after** its edits
are applied, so it records the final reviewed state; add the `correctness_hash` line only
when check F was handled this pass):

```bash
marker="$(git rev-parse --git-dir)/.base-review"
{ echo "branch=$branch"; echo "base=$base"; echo "diff_hash=$diff_hash"; \
  echo "reviewed_at_head=$(git rev-parse HEAD)"; } > "$marker"
# ONLY when check F was handled this pass (bug-hunter ran, or gate: not applicable):
echo "correctness_hash=$diff_hash" >> "$marker"
```

**Re-stamp after a commit whose hooks rewrote the tree** (`/base:commit` only). Project commit
hooks (husky / lint-staged running prettier, `eslint --fix`) rewrite files *during*
`git commit`, so the committed tree ≠ the reviewed one and `diff_hash` drifts — which makes a
PR skill's correctness backstop re-run `base:bug-hunter` over semantically identical code. Mechanical rule: re-stamp **only** when the tree being committed *is* the
reviewed tree; the sole delta is then what the project's own hooks did, inside the same
commit, and the review covered exactly that pre-hook state. Pre-commit hash ≠ the marker's
(the developer edited after the review) → do **not** re-stamp; the PR-time backstop is
legitimate.

```bash
# BEFORE `git commit` — is the tree about to be committed the reviewed one?
# (diff_hash, branch, base: review-scope.sh's output just before)
marker="$(git rev-parse --git-dir)/.base-review"
pre_hash=$diff_hash
restamp=no; keep_correctness=no
if [ -f "$marker" ] && grep -qx "branch=$branch" "$marker" && grep -qx "diff_hash=$pre_hash" "$marker"; then
  restamp=yes
  # carry correctness forward ONLY if it was current; absent or stale → do NOT add the line
  if grep -qx "correctness_hash=$pre_hash" "$marker"; then keep_correctness=yes; fi
fi

# AFTER a successful `git commit` — did the hooks rewrite files? (re-run review-scope.sh)
post_hash=$diff_hash
if [ "$restamp" = yes ] && [ "$post_hash" != "$pre_hash" ]; then
  { echo "branch=$branch"; echo "base=$base"; echo "diff_hash=$post_hash"; \
    echo "reviewed_at_head=$(git rev-parse HEAD)"; } > "$marker"
  if [ "$keep_correctness" = yes ]; then echo "correctness_hash=$post_hash" >> "$marker"; fi
fi
```

A caller whose `allowed-tools` bars shell redirection may instead compare with `grep` or `Read` and
rewrite those lines in place with `Edit` — on this path the marker exists by construction.

## 2. How the checks run

The cost is **reading the changed files**, which checks A and C (and E) share. So split by
**files, not by checks**:

- **B (ticket references) and D (untracked referenced files) run inline** in the calling
  skill — they're mechanical (`git diff | grep`, `git status`) and operate on the diff
  text + git metadata, not full-file reads. B covers Jira keys **and** ticket-section pointers
  (`(AC 1a)`, `(TA 1a)`, "Acceptance Criteria", "Technical Approach", "Steps to Test"):

  ```bash
  <base root>/scripts/review-scope.sh --ws <ws> --diff | grep -nE '^\+[^+]' \
    | grep -E '\b[A-Z]{2,}-[0-9]+\b|\((AC|TA)[^)]*\)|\b(AC|TA) [0-9]+[a-z]?\b|Acceptance Criteria|Technical Approach|Steps to Test'   # B candidates (the scope diff; ^\+[^+] skips +++ headers)
  git status --porcelain | grep '^??'                                          # D candidates
  ```

- **A, C, and E are delegated to the `base:change-reviewer` agent** so the heavy reading stays
  out of the main context (only the findings table comes back). The file list is
  review-scope.sh's: an untracked new file in it is part of the change, reviewed like any other.
  - **Small diff** (≲ 15 changed files / ≲ 1500 diff lines) → **one** `base:change-reviewer`.
  - **Large diff** → **one `base:change-reviewer` per file-group, in parallel** — each file is
    read once; wall-clock drops. Split the file list into a few balanced groups.
  - Pass each agent: the `base`, its file group, the **emphasis** (see below), the `profile`
    word your caller supplies (a team plugin names its profiles, e.g. fe's
    `foundation|theme|none`; it gates the team rules of check E, and without one the agent
    assumes `none`), and the raw B/D hits to confirm.

- **F (correctness) is delegated to the `base:bug-hunter` agent** — an adversarial pass that
  hunts for real bugs (races, merchant-invariant bypasses, state divergence between
  sibling paths, inherited-behavior traps, dropped data). It applies when the
  **correctness gate** holds:

  > **Correctness gate:** the diff touches JS/TS logic, Liquid control flow, or request
  > handling. Pure copy / CSS / locale / schema-label diffs skip it — say so in one line
  > and still record `correctness_hash` (the pass was handled: not applicable).

  Spawn it **in parallel** with the `base:change-reviewer` agent(s) — same diff, different
  lens; on a large diff reuse the same file-groups. Pass it the `base`, its file group (on a
  small diff, the scope diff's untracked new files), the build-dirtied paths in `excluded=`, and
  the documented ceilings (`ceiling:` entries from the task workspace `notes.md`)
  when a workspace exists.

- **Emphasis by caller** — assigned per skill in §3 → Per-skill entry behaviour.

- **Who spawns these agents.** The caller — the session, or a team plugin's phase agent —
  spawns them directly. Same agents, emphases and blocking semantics everywhere; a caller that
  can neither spawn nor was handed findings never skips the pass — it `ESCALATE`s (pipeline) or
  tells the developer (solo).

Merge the agent findings with the inline B/D hits into one plan/table for the developer.

### Correctness findings — disposition is mandatory

A finding tagged correctness (check F from `base:bug-hunter`, or stumbled on by
`base:change-reviewer` while reading) is **never "observation only"**. The calling skill must
close every one explicitly — **fix** it, **justify** it (with a reason a reader of the CODE can
check: this branch is unreachable because <condition>, the platform offers no way to <thing>;
the justification travels to the PR body as a **one-line named ceiling**, where the team's PR
skill places it; the full reasoning stays in `notes.md`), or have the developer **explicitly
waive** it — and record the disposition (workspace `notes.md` when one exists). A **blocking**
correctness finding stops a PR the same way any other blocker does.

## 3. On entry — first time vs. subsequent

**Agreed rule: the first review on a branch is full; every later run asks the developer.**

```
reviewed_before == no   → run the FULL flow (§2), then write the marker (§1).
reviewed_before == yes  → ASK the developer; do not auto-skip and do not auto-rerun.
```

> **Pipeline exception:** inside a team plugin's autonomous run (`/fe:ship`) the autonomy rule
> forbids the ask —
> the finalize brief replaces it deterministically: `diff_hash` unchanged → skip (say
> so); changed or marker absent → full re-review. A phase agent never asks.

When asking (subsequent runs), enrich the prompt so the decision is easy:

- Compare `diff_hash` to `prev_hash`. If **unchanged**, say *"nothing changed since the
  last review"* and recommend **skip**. If **changed**, summarize what changed since the
  last review — the scope against `<prev_head>` covers commits since then plus
  staged, unstaged and untracked work in one go — which files, rough nature (comments/style vs. logic):

  ```bash
  <base root>/scripts/review-scope.sh --ws <ws> --since "$prev_head"
  ```

- Offer: **`[ full re-review ] / [ only the changed files ] / [ skip ]`**.
  - *only the changed files* → run `base:change-reviewer` on just the delta vs. `prev_head`
    (cheapest useful option) — the files that command lists after its blank line.
- On any run that actually reviews, **refresh the marker** afterward.

### Per-skill entry behaviour

- **`/base:pre-commit-review`** — emphasis `hygiene` (lead A + C); the primary home of the full
  review, **including check F** (`base:bug-hunter` in parallel with the
  `base:change-reviewer`(s) when the correctness gate holds). Applies edits after developer
  approval, then writes/refreshes the marker (incl. `correctness_hash`).
- **`/base:commit`** — does **not** itself run the hygiene review. On entry: if
  `reviewed_before == no`, offer to run `/base:pre-commit-review` first (proceed if the dev
  declines); if `yes`, continue to the commit. (Its own untracked-file check still runs.)
  Around the commit itself it applies §1's **re-stamp** rule.
- **A team plugin's PR skill** (`/fe:create-pull-request`) — final gate; emphasis
  **`conformance`** (lead E, with the team rules its profile names): first time on branch →
  full; else ask. Independently of that choice, the **correctness backstop**:
  `correctness_hash` absent or ≠ the current diff hash → apply the gate and run
  `base:bug-hunter` before drafting. **Any blocker — a team rule's or a blocking correctness
  finding — stops the PR** until resolved or explicitly waived by the developer.

> Optional fast-path: a skill may also print an in-context sentinel
> (`✓ base review · branch=… · <hash>`), but the `.git/` marker is the source of truth.
