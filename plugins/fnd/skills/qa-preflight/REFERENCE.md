# QA Preflight — reference

The long material for the `qa-preflight` skill: the store registry, PR discovery, the browser
mechanics and the unlock + deployed-gate procedure, what counts as evidence, the brief template to
fill verbatim, and the rules for the optional Jira comment. **Plugin root** = the plugin's own
directory, this skill's `../../` — the one holding `scripts/` and `references/`; on Claude Code the
host substitutes its absolute path into the skill text, so write that path into the commands below;
no shell variable carries it.

## Store registry — `qa-stores.cjs`

QA works across many stores; one checkout's `shopify.theme.toml` binds only one. The registry is
the plugin's answer: domain, storefront password, known themes and free-text notes per store, in
`~/.config/domaine/qa-stores.json` (directory `0700`, file `0600`).

```json
{"version":1,"stores":{"elc-us-mc-uat.myshopify.com":{
  "alias":"MAC US UAT","password":"…","themes":{"156379611322":"develop"},
  "defaultTheme":"156379611322","notes":"free text","updatedAt":"2026-09-20T09:00:00Z"}}}
```

Commands — `node <plugin root>/scripts/qa-stores.cjs <cmd>`:

| Command | Use in this skill |
|---|---|
| `list [--json]` | show the QA engineer what is on file; the password prints as `***` in both forms |
| `get <store>` | Phase 2 — the **only** source of a storefront password; `<store>` is the exact domain or the exact alias, case-insensitive |
| `find <text>` | Phase 1 — resolve a brand word from the ticket/PR ("MAC", "CL") against domain, alias and notes; JSON array, password `***` |
| `set <domain> [--alias <a>] [--password <p>] [--theme <id>[:<label>]]… [--default-theme <id>] [--note <t>]` | upsert; themes merge, other flags overwrite. **The QA engineer runs this, not the skill** (see below) |
| `unset <store>` | only when the QA engineer asks to forget a store |
| `path` | tell the user where the file lives |
| `--help` / `-h` | usage, exit 0 |

Exit codes: `0` ok · `1` no store matches the selector, or an alias that a hand-edited registry put
on two stores · `2` usage error · `3` registry unreadable, unlockable or corrupt JSON. On `3` the
message is on stderr and the file is never overwritten — pass the line to the user verbatim and
stop; a hand-edited registry is theirs to repair. A domain is accepted in any shape
(`https://qa@elc-us-mc-uat.myshopify.com:443/collections/all`) and normalised to the bare lowercase
host, so one store is one entry however it was pasted. `<domain>` on `set` must be a host: an alias
there is refused, and so is an `--alias` another domain already carries — either would give the
skill a second entry to pick the wrong password from.

**Registering a new store.** Ask the QA engineer once for the domain, the storefront password, the
theme id and an optional label and notes, then register it yourself and continue:

```
node <plugin root>/scripts/qa-stores.cjs set <domain> --alias '<label>' --theme <id>:<label> \
  --password '<password>'
```

That one command line is the single place a password may appear in something this run composes;
it lands in the session transcript, which is why the warning in the skill's Passwords rule is said
before it. Next runs find the store and ask nothing. `--password ''` records an **open**
storefront: the field is dropped, so `list`, `list --json` and `get` all report "no password" the
same way and the unlock step is skipped rather than submitting an empty string.

**Secrecy.** `get` is the only command that prints a password, and it prints it so the browser step
can type it. From that moment it is write-only: never into `preflight.md`, the chat, a Jira comment,
`notes.md`, a Bash line, or a screenshot taken while the field is visible.

## PR discovery

One `gh` call per ticket, scoped to this checkout's repo — `gh pr list` without `--repo` searches
only the current directory's remote, so an unscoped call in the wrong checkout answers "no PR" for a
ticket whose PR exists:

```
gh pr list --repo <owner/name> --search "<KEY>" --state all \
  --json number,url,state,mergedAt,baseRefName,headRefName,headRepository,body
```

`<owner/name>` comes from `git remote get-url origin`.

| Outcome | What it means |
|---|---|
| non-zero exit | **not** "no PR" — `gh` is missing, unauthenticated, or has no access to the org. Record `gh unavailable: <first stderr line>` in Block 2 and take the theme id from the registry |
| empty list | try the PR URL from the ticket's Development panel; still nothing → the PR is not the proof (Phase 2.1) |
| `headRepository` is not this checkout | the PR lives elsewhere: skip the `git fetch` / `git branch -r --contains` rungs and say so in Block 2 |

**Theme id** comes from the PR body's theme-preview table — the **Theme ID** row, else
`preview_theme_id=` in its **Preview** row. Keep that Preview URL **whole**: it carries the share
`key` and the `_ab` / `_fd` / `_sc` params the gate below needs.

**Store** comes from the ticket / PR wording — a domain, or a brand word (MAC, CL, Clinique, KIKO)
resolved with `node <plugin root>/scripts/qa-stores.cjs find "<text>"`. Exactly one match → use it.
None, several, or no store signal in the ticket at all → ask the QA engineer, showing
`qa-stores.cjs list` (plus "a store not on this list" → the registration questions). A ticket that
names several brands or stores runs every phase once per store, one isolated context each.
The local checkout is never the source of what is tested: the storefront theme is. The checkout
only supplies `origin` for the `gh` call and the fetched remote refs for `git branch -r --contains`,
so the current branch and working tree do not matter.

**Classify the change** from the PR file list and the ticket:

- **theme** — the normal path, Phases 3–6 as written.
- **non-theme** (app, proxy, content, data) or **nothing to test** — the storefront cannot show it,
  or there is nothing to show. Write **Block 2 only**: no Block 1, no Phase 6 offer, Route
  `nothing to test in the theme → <deploy/content owner>`.

## Unlock and deployed gate

One **isolated browser context per store** — so two stores' cookie jars, and their password
sessions, never mix. The 2026-09-18 release session proved the mechanism on two UAT stores in
parallel; keep it.

**Mechanics.** Per store: `new_page url: https://<domain>/password, isolatedContext: "<store alias>"`
— the named context is what keeps two stores' password cookies apart. Keep the returned `pageId` per
store and pass it on every later `fill` / `click` / `press_key` / `evaluate_script` / `emulate` /
`take_screenshot`; finish one store's rows before touching the other's page. Unlock =
`take_snapshot` (gives the password input's `uid`) → `fill pageId, uid, value` → `click` the submit
button's uid, or `press_key` `Enter` → `wait_for`. Viewports: `emulate pageId, viewport: "1440x900x1"`
(desktop) and `emulate pageId, viewport: "375x812x3,mobile,touch"` (mobile), then re-navigate so
load-time gates re-run.

`evaluate_script` takes a **function declaration** — an arrow function, never a bare expression —
and `id: null` below is the `Shopify`-undefined row of the table.

1. **Unlock.** Navigate `https://<domain>/password`, fill the storefront-password input, submit.
   Verify with a read, not with the absence of an error, and never with the body class alone:

   ```js
   () => ({ locked: document.body.classList.contains('template-password')
              || location.pathname.startsWith('/password')
              || !!document.querySelector('form[action*="/password"]'),
            path: location.pathname })
   ```

   `locked` is true when **any** of the three holds — the class, a `/password` pathname, or a
   password form in the DOM — because the class is theme-specific: a Foundation or brand
   `password.liquid` need not emit `template-password`, and a submit that leaves `path` under
   `/password` is a rejected password whatever the class says.
   `locked: true` after the submit → the password is wrong or stale: say so, ask the QA engineer for
   the current one, store it with `qa-stores.cjs set <domain> --password '<new>'`, then retry.
   Two failures → **Block**, reason `storefront password rejected`; never brute-force a third.
   A storefront with no password answers `locked: false` on the first navigation — fine, go on.
2. **Theme gate.** Open the target page on the theme under test: when the PR Preview row has a URL,
   use it **verbatim** (keep every param — `_ab` / `_fd` / `_sc` / `key` — and only swap in the
   target path); otherwise append `?preview_theme_id=<id>` to the target path. A bare
   `preview_theme_id` works anonymously for any theme of the store once the storefront is unlocked —
   it is what a theme share link is. Then read:

   ```js
   () => (typeof Shopify === 'undefined' || !Shopify.theme)
     ? { id: null, role: null, name: null }
     : { id: String(Shopify.theme.id), role: Shopify.theme.role, name: Shopify.theme.name }
   ```

   | Reading | Meaning for the brief |
   |---|---|
   | `id` matches, `role: "main"` | **live on this store** — the change is published; the preview params are redundant but harmless |
   | `id` matches, `role: "unpublished"` | **preview active** — the share link put us on the theme under test |
   | `id: null` | not a Shopify storefront render (a 404, a challenge page, a redirect to the password page): treat as a mismatch |
   | `id` differs | re-navigate **once** (a first hit can land before the preview cookie is set); still different → **Block**, reason `theme <id> not reachable` (the id may be wrong or the theme deleted — say which store answered and what `Shopify.theme` returned) |

   **Target page.** Precedence, in order: a URL or path in Steps to test → a path in the ticket or
   in the PR Preview row's deep-links → the template the diff touches (`templates/<name>.json` →
   that template's storefront path) → ask the QA engineer. Never guess a handle. Record the chosen
   path and which rung answered on Block 2's Deployed line — a gate passed on the home page proves
   nothing about a PDP change.
3. **Marker check, when the ticket gives one.** A string the change introduces (a class name, a
   `data-` attribute, a locale string) confirms the *code*, not just the theme id —
   `document.querySelector` for it once and record the result on the Deployed line. Absent while the
   theme id matched is a finding for Block 2 ("theme reachable, marker absent — ask the developer
   when it was last pushed"), not a silent pass. With no PR to lean on (PR discovery above) the
   marker is the only proof the change is deployed: absent or not given → **Block**.
4. **Never** publish, duplicate or edit a theme, change its settings, create a preview theme, or
   make any Admin write. The gate is three reads and a navigation.

## Evidence rules

- **Every row gets both viewports** — the two `emulate` strings under Mechanics above, not a
  narrowed desktop window: the house style says "Mobile", and a resized desktop UA misses touch-only
  behaviour. Reload after switching so load-time gates re-run.
- **DOM before pixels.** Whatever can be read — text, an attribute, a computed style, a cart line's
  quantity — is read with `evaluate_script` and quoted in the evidence line. A screenshot alone
  proves the page rendered, not that the value is right.
- **One screenshot per row per viewport**, saved as
  `.claude/tasks/<KEY>/preflight/NN-<slug>-<desktop|mobile>.png` — `NN` is the row number in the
  brief, `<slug>` a few kebab-case words from the row. Create the directory once before the first
  shot — `mkdir -p .claude/tasks/<KEY>/preflight` — `take_screenshot`'s `filePath` does not create
  it. The frame must show the thing the row is about; a full-page shot of a long template proves
  nothing, so scroll the target into view first. Never capture a frame with the password field
  filled.
- **Checkout** is walked only to the payment step: line items, quantities, bundle composition,
  discounts, shipping options, totals. Contact and address values come from the ticket, the
  workspace `notes.md`, or the QA engineer — ask once; never a real person's details and never the
  QA engineer's own account. Stop at the payment form: no card details, no order. Empty the cart or
  abandon the checkout before the next row so it starts clean. A test order is the QA engineer's
  call on their own account, never this skill's.
- **`needs data: <what, where>`** replaces a verdict when the fixture the row needs is absent (no
  product with the required metafield, no discount code, empty metaobject). Name what is missing and
  where it would be configured, so the developer or the QA engineer can provision it.
- **`for human eyes`** is a first-class outcome, not a failure: visual polish against a design,
  hover and transition feel, copy tone, animation timing, anything where the brief would be guessing.
- **`not-executable: access`** marks a derived break-it or data row whose hostile value needs a write
  this read-only run doesn't have (`../../references/break-it-qa.md` → Read-only store ≠ reduced
  mode). Derived, reported, never silently dropped and never "pass".
- **Verified n/m** in the batch table counts rows with evidence at **both** viewports over all rows.
  A row that passed on desktop and failed on mobile is a Fail with the mobile screenshot, never a
  pass with a caveat.

## Brief template

`.claude/tasks/<KEY>/preflight.md`. Block 1 is the company house style and is the only part that may
reach Jira; Block 2 never does. Fill this verbatim — the wording of the Block 1 lines is what QA
readers expect to see, so keep it even when it feels repetitive:

```markdown
# <KEY> — QA preflight (<YYYY-MM-DD>)

## Block 1 — for Jira (house style)

_Preflight — automated pre-run via fnd `qa-preflight`, not the QA sign-off; rows below were checked
by the agent at the viewports named._

**Testing Status: {color:green}Pass{color}**
* Tested in Desktop on Chrome
* Tested in Mobile on Chrome (375x812 emulation)
* Tested in theme build: <theme label> <store alias> (theme <id>)

**Evidence on the criteria that pass verification:**
1. {color:green}Pass{color} — <AC or step restated as an observed fact — what was done, what the page did>
   screenshot: 01-<slug>-desktop.png, 01-<slug>-mobile.png
2. {color:green}Pass{color} — <…>
   screenshot: 02-<slug>-desktop.png, 02-<slug>-mobile.png

## Block 2 — Preflight notes (not for Jira)

**Deployed:** PR #<n> <url> · <headRef> → <baseRef> · merged <date> · on <branches carrying it> ·
theme <id> role <main|unpublished> · target path <path> (<which rung chose it>) ·
marker `<string>` <found|absent|not given>
**For human eyes:** <row> — <what a person has to judge>
**Needs data:** <row> — <what is missing, where it is configured>
**Developer gaps:** <Steps/AC contradiction, missing page, absent AC, ticket question>
**Observations:** <anything true but not derivable from the ticket — never a verdict>
**Route:** ready for hands-on QA | back to developer | nothing to test in the theme → deploy owner
```

**Colour** is the house style's own: the verdict word is green for Pass and red for Fail, on the
status line and at the **start** of every numbered row (`{color:green}Pass{color}` /
`{color:red}Fail{color}` — `md-to-adf.cjs` turns the Jira wiki form into the editor's palette
colour). Leading, not trailing, so the column of verdicts scans at a glance and a long row never
hides its outcome below the fold. Only Pass and Fail rows are coloured; a Block verdict and the
label line stay plain. The wiki form is what `preflight.md` and the chat output carry — a terminal
renders no colour, so the reader sees `{color:green}Pass{color}` literally there and the green only
once the comment lands in Jira.

The label line above the status is the one deliberate deviation from the surveyed shape, and it
always stays — in the Fail and Block forms too. A `Testing Status: …` posted without it reads as the
QA engineer's own verdict and invites a `Ready for QA → Ready for UAT` transition on agent evidence,
which is exactly what a preflight must only precede.

Verdict vocabulary, exactly these four: **Pass** (every reachable row verified), **Fail** (at least
one defect with evidence), **Block** (the gate failed, or no AC could be reached), **Partially pass**
(some rows verified, the rest `needs data` / `for human eyes` / `not-executable`). Choose the
verdict from the rows, never to be helpful. A run with **no Block 1** — a non-theme change, or
nothing to test — has no Testing Status line at all: the four values apply only to a theme change
that was actually exercised.

**Fail** keeps the same header and lists every row that ran — the passing ones as above, each
defect as a red row with expected vs actual, plus its screenshot — so the reader sees what still
holds next to what broke. **Partially pass** uses the Pass shape (green rows only; the rows left
for human eyes or waiting on data are Block 2 material, never listed here):

```markdown
_Preflight — automated pre-run via fnd `qa-preflight`, not the QA sign-off; rows below were checked
by the agent at the viewports named._

**Testing Status: {color:red}Fail{color}**
* Tested in Desktop on Chrome
* Tested in Mobile on Chrome (375x812 emulation)
* Tested in theme build: <theme label> <store alias> (theme <id>)

**Evidence:**
1. {color:green}Pass{color} — <observed fact>
   screenshot: 01-<slug>-desktop.png, 01-<slug>-mobile.png
2. {color:red}Fail{color} — <where> — expected <what the AC says>, actual <what the page did>
   screenshot: 03-<slug>-mobile.png
```

**Block** is the shortest form: the label line, the three bullets, then one line of reason
(`theme 156379611322 not reachable on elc-us-mc-uat.myshopify.com — Shopify.theme.id is 150843719862`)
and nothing else. No partial evidence list under a Block — the run has no ground to stand on.

### What never goes in Block 1

Domaine's QA engineers never record these, so a brief that adds them does not read as native and
gives the ticket a shape its readers don't expect: labels and components, console / network /
Lighthouse / axe dumps, commit SHAs or diff references (PR links come from developers), test-case
ids, environment matrices, timing or performance numbers, worklogs, Acceptance-Criteria-Status field
updates, and a pass or fail on an AC that could not be reached (that is a **Block** with a one-line
reason). Agent-only material — the deployed gate, observations, `needs data`, `for human eyes`,
routing — belongs in Block 2, below the house-style part, never mixed into it.

Block 2's **Observations** is for facts the ticket does not imply — a non-code root cause ("the
locale merge keeps the live value, so this is a content fix, here is where"), a second broken thing
noticed in passing, a page that 404s. Stating it is the job; deciding what it means is not.

## Jira comment

Opt-in and one comment per ticket at most.

1. **Ask once per ticket, at the end of the run.** Show each ticket's Block 1 text in full and ask
   which keys to post, naming them (`ELC-1335`, `ELC-1332`). Consent covers only the keys the QA
   engineer names back — a bare "yes" to a multi-ticket run is a question, not an approval, and one
   ticket's yes is never another's. No keys named → post nothing; the files on disk are the
   deliverable.
2. **Only Block 1 goes.** `jira-writer` posts its source file verbatim, so the source must be a
   separate `.claude/tasks/<KEY>/preflight-comment.md` holding Block 1 and nothing else — no
   `# <KEY>` heading, no Block 2 — and that is the path the writer is briefed with. Handing it
   `preflight.md` posts Block 2 to the client's ticket. Block 2 never goes, not even summarized.
3. Screenshot references become plain `screenshot: <file>` lines. The QA engineer attaches the files
   by hand from `.claude/tasks/<KEY>/preflight/` — there is no attachment upload in this skill, and
   inventing one by pasting a local path as a link is worse than the plain line.
4. The write goes through the **`jira-writer`** subagent — brief it with the ticket key **plus the
   workspace path the key came from**, target `comment`, and the path of the approved
   `preflight-comment.md` (`../../references/jira-adf-write.md`). It converts to ADF, posts once and
   reads the comment back.
5. **No transitions and no field edits.** Moving `Ready for QA → Ready for UAT`, failing a ticket
   back to `In Progress`, filing a bug ticket, or touching Acceptance Criteria Status is the QA
   engineer's judgement and their account. Say what the brief suggests; let them do it.
6. A `cc @PM / @dev` line is common in the house style but names people this run cannot pick — add it
   only if the QA engineer dictates the handles.
