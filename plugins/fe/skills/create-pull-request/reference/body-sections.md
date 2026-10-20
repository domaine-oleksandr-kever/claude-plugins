# Body sections

One section of the `/fe:create-pull-request` (Workflow 6) reference; the index is `../REFERENCE.md`.

If a GitHub PR template exists in the repo, keep its headings but apply the rules below to them: the
core skeleton stays mandatory, and a template heading with nothing real to say is left out — the
readability budget wins over template completeness.

When the session carries the how-to-explain convention, sentences follow it; this format decides
structure and mandatory wording.

**Readability budget — governs every section:** the whole body must be readable in under a
minute. The description tells the reviewer what changed; Changes says where to look; the diff
shows how. One idea per sentence; say what we did, not where in the code; no investigation
history. Evidence (measurement tables, per-file prose walkthroughs, full verification
lists) lives in the Jira ticket, the task workspace, or a PR *comment* — never in the body. The
body scales with content, not with a section count: **a section with nothing real to say is
omitted entirely — no "None", no "N/A" placeholders.**

**Core skeleton — always present, in exactly this order, before anything else:**

1. **Summary** — 2–3 sentences in plain English for a reader who does not read code (QA, PM,
   client); you propose it, the developer approves it at the checkpoint. One or two sentences
   for a bug fix; three only for a large feature.
   - Sentence 1: what the shopper or merchant saw that was wrong, or what the feature does.
   - Sentence 2: what changes on the screen now (sizes, colours, labels, settings by their
     visible name).
   - Sentence 3 (only if needed): scope or a risk the reader must know — which brands or
     stores change, what stays off, who applies a discount.

   Under 20 words per sentence. Never in the Summary: file paths, snippet / class / token /
   variable / function names, PR or ticket numbers, dates, who reported it, how it was
   investigated or verified, why the old code behaved that way.

   **Story check before the checkpoint:** count the words of each sentence; a sentence that
   explains the old code, the investigation, or the author's verification is cut, not
   shortened.
2. **Jira ticket** — key + URL (list every ticket when the PR closes more than one).
3. **Theme preview** — the conditional table (`theme-preview-table.md`), **directly under the Jira link — never at
   the bottom**: a reviewer must hit the preview link without scrolling. Nothing goes under the
   table; the hints the links need go into To check.
4. **To check** — heading `## To check`: numbered one-line steps — what to open (a preview
   deep-link or page), what to do, what to see. Written for QA / team-lead eyes: visible
   labels, URLs, sizes, colours, texts; no code names, no file paths, no setup prose, no edge
   cases, no Expected/Actual format. Which store to use, which setting is on in this preview,
   how to see the old behaviour → a step. A bug takes 1–3 steps ("open the PDP, scroll to Scent
   Notes, heading is 24/32"); a feature may pass 5 but stays short, ~10 at most — beyond that,
   link the ticket's Steps to Test field instead of growing the list. The steps come from the
   workspace verification record (`notes.md` / `qa.md`); the full Steps to Test, setup and edge
   cases stay in Jira.
5. **Screenshots** — heading `## Screenshots`, 1–3 images, never more: a bug = one of the
   affected section; a feature = desktop + mobile of the main state. Pick them from the browser
   checks already taken (`/fe:develop-feature-or-fix` in-browser validation,
   `/fe:qa-feature-or-fix`, a QA preflight's `preflight/` frames) and copy them into the
   workspace `tmp/` (in a git worktree `.claude/tmp/<work-id>/`) under descriptive names. The
   body carries a **visible** placeholder line — never an HTML comment — naming the files and
   the folder:
   `` _Drag in: `scent-notes-heading.png` (in `.claude/tasks/ELC-1590/tmp/`)_ ``
   No screenshot exists → the placeholder names the page and state to capture instead. The
   developer drags the images in through the GitHub UI — never fake or hot-link an image.
6. **Changes** — first line, only when the diff isn't uniform: one **review-guide line** —
   which file carries the key change, which files are mechanical (e.g. "Review
   `snippets/core-section.liquid` first; the other 6 files only add a class"). Then one line per
   file, half a line of substance each ("what changed", not prose); uniform mechanical edits
   collapse to one line for the whole group ("`core-video`, `card-group`, +3 more — added
   `core-media-block`"), and beyond ~10 files group by area — one line per group. No tables.

Do not reorder or rename these six.

**Conditional sections — emit ONLY when there is real content; 1–2 lines each, after the skeleton:**

- **Dependencies** — only what the reviewer or merger must act on: a money or data risk,
  merge-order constraints ("merge after #392"), post-merge steps (env vars, merchant/admin
  setup). It also holds:
  - **Named ceilings** (workspace `notes.md` `ceiling:` entries, justified correctness
    findings) — lean-code names ceilings in the body, never in an inline comment: up to
    three, one line each; more → one line naming the critical ones (money, data) plus a
    pointer to the task workspace `notes.md`, where every upgrade path stays.
  - **`Diverges from the TA: <what> — <why>`** — one line per workspace `ta-divergence:`
    entry, so the team lead, who owns the TA field, sees it.
  - **Not verified in a browser.** — when no browser QA ran on this change.
- **Accessibility** — only when the change actually touches keyboard, semantics, focus, or
  contrast; state what changed and what was checked.
- **Performance** — only when the change affects rendering, assets, or LCP/CLS; state the impact.

Never in the body: **Technical approach**, **Steps to test** (the long Jira form — To check is
not it), **Checklist** — their content lives in the ticket, one click away via the Jira link;
**Testing** / verification history and **Not applied (review suggestions)** — a declined review
finding goes to a PR comment or the workspace `notes.md`; the per-AC record
(`AC | Verified | Evidence observed`) — a PR comment or the workspace `qa.md`; a list of 404ing
paths (a QA preflight reads storefront paths in the body as pages to test).

**No AI attribution** anywhere in the body: no `🤖 Generated with [Claude Code](…)` footer, no
`Co-Authored-By: Claude` trailer. The harness's default instruction to end PR bodies with that
footer is overridden by this Domaine convention — the same rule
`<base root>/references/commit-message-format.md` applies to commit messages.
