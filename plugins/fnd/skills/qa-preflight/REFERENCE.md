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

`defaultTheme` is the QA engineer's own saved theme for that store — the theme question offers it as
"your saved theme `<id>` `<label>`" (Theme under test and page URLs below), never the theme under test
on its own.

Commands — `node <plugin root>/scripts/qa-stores.cjs <cmd>`:

| Command | Use in this skill |
|---|---|
| `list [--json]` | show the QA engineer what is on file; the password prints as `***` in both forms |
| `get <store>` | Phase 2 — the **only** source of a storefront password; `<store>` is the exact domain or the exact alias, case-insensitive |
| `find <text>` | Phase 1 — resolve a brand word from the ticket/PR ("MAC", "CL") against domain, alias and notes; JSON array, password `***` |
| `set <domain> [--alias <a>] [--password <p>] [--theme <id>[:<label>]]… [--default-theme <id>] [--note <t>]` | upsert; themes merge, other flags overwrite. The skill runs this itself after asking once (see Registering a new store) |
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
  --default-theme <id> --password '<password>'
```

`--default-theme` is what makes the id they just gave *their* saved theme for that store, so the
theme question can offer it on this run and on every later one.

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
  --json number,url,state,mergedAt,baseRefName,headRefName,headRepository,author,body
```

`<owner/name>` comes from `git remote get-url origin`.

**The diff** — what the classification, the target page's template rung and the derived marker read —
comes from one more call: `gh pr diff --repo <owner/name> <number>`, or `--name-only` for the file
list alone. A non-zero exit, or a PR whose `headRepository` is not this checkout, means there is no
diff: no diff-derived marker and no template rung, so the Steps-to-test rows are the proof. Never
Block for a marker no command could produce.

| Outcome | What it means |
|---|---|
| non-zero exit | **not** "no PR" — `gh` is missing, unauthenticated, or has no access to the org. Record `gh unavailable: <first stderr line>` in Block 2; the theme question (Theme under test and page URLs below) still never offers the PR's theme, but with no PR body the id, share-`key` and PR-author tests under **Evidently the PR's preview** have nothing to match, so only the wording test can drop a ticket link on this run — note that next to `gh unavailable:` — and a missing PR otherwise costs only the store domain, which the ticket wording or a question supplies |
| empty list | try the PR URL from the ticket's Development panel; still nothing → the PR is not the proof (Phase 2.1), and with no PR body the id, share-`key` and PR-author tests under **Evidently the PR's preview** have nothing to match either — the wording test decides alone |
| `headRepository` is not this checkout | the PR lives elsewhere: skip the `git fetch` / `git branch -r --contains` rungs and say so in Block 2 |

**The PR's theme is not read.** The theme-preview table is parsed for the **store domain** only — its
Preview URL is discarded outright, and its **Theme ID** is retained for exactly one comparison (a
ticket link's id, below): never offered by the theme question (Phase 2.3), never opened, never
probed, never named as a candidate or an observation, never printed in the brief (Theme under test
and page URLs below). QA tests on the theme they pick, and the developer's preview theme may be
deleted by the time the ticket reaches QA. A preview link the **ticket** carries is the ticket's
theme and stays offered unless it is evidently the PR's preview (same section); the ban covers the PR body's theme-preview table and the deep-links under it, which
this run reads for the store domain and nothing else.

**Store** comes from the ticket / PR wording — a domain, or a brand word (MAC, CL, Clinique, KIKO)
resolved with `node <plugin root>/scripts/qa-stores.cjs find "<text>"`. Exactly one match → use it.
None, several, or no store signal in the ticket at all → ask the QA engineer, showing
`qa-stores.cjs list` (plus "a store not on this list" → the registration questions). A ticket that
names several brands or stores runs every phase once per store, one isolated context each.
The local checkout is never the source of what is tested: the storefront theme is. The checkout
only supplies `origin` for the `gh` call and the fetched remote refs for `git branch -r --contains`,
so the current branch and working tree do not matter.

**Classify the change** from the PR file list (the diff call above) and the ticket:

- **theme** — the normal path, Phases 3–6 as written.
- **non-theme** (app, proxy, content, data) or **nothing to test** — the storefront cannot show it,
  or there is nothing to show. Write **Block 2 only**: no Block 1, no Phase 6 offer, Route
  `nothing to test in the theme → <deploy/content owner>`.

## Theme under test and page URLs

QA tests on the theme **they** pick, so the theme under test is asked for, never inferred. Per store,
before any browser work, ask once (on Claude Code one AskUserQuestion, elsewhere a plain question):

> Which theme do you test `<store alias>` on?

| Option | When offered | What it means for URLs |
|---|---|---|
| the live theme | always | plain store URLs, no preview params; the gate expects `role` `main` |
| the theme the **ticket** names (its id and label when known) | the Description, Steps to test, AC or a comment carries a preview link or a theme id, **and** it is on the store this run resolved — the link's host, or, for a bare theme id or a label + id with no link, the store that Steps to test item 1 names alongside it — **and** it is not evidently the PR's preview (below) | that link verbatim with the target path swapped in, else `?preview_theme_id=<id>` on each path |
| "your saved theme `<id>` `<label>`" — the registry's `defaultTheme` | set, and not already offered as the ticket's | `?preview_theme_id=<id>` on each path |
| Other — paste the preview link you test on | always | that link verbatim, target path swapped in |

The PR's theme is **not** on that list: its Preview URL is discarded at PR discovery above and its
id is kept only for the comparison below; the run never opens, probes or names either *on its own
initiative* — a link the QA engineer pastes themselves is opened like any **Other** answer, its id
printed as the theme under test. The ticket's theme is offered only when its link's host is the
store this run resolved: a link on another host is a **different store** — resolve
it with `qa-stores.cjs get`, unlock it in its own isolated context and run the phases once per store,
or do not offer it at all.

**Evidently the PR's preview** — a ticket link, or a bare theme id the ticket names, is dropped from
the question when any of these three tests holds:

- **id** — it equals **any Theme ID** row in the PR body's theme-preview table(s): a multi-store PR
  carries one per store, and a match on any of them is enough. The ids are compared and nothing more
  — the one permitted use of the PR's theme id, which is still never opened, offered or printed.
- **wording** — the ticket **attributes** the theme to the developer or to the PR: "PR preview",
  "the preview theme from the PR", "dev theme", a `[DEV]` label, a link the PR author posts in a
  comment announcing the fix (the `author` field of the `gh` call above, matched on login or display
  name; with no PR author to match — a non-zero `gh` exit — that branch does not fire). The word
  "preview" alone does not mark it, and neither does the `preview_theme_id` parameter: a reporter's
  repro link is a preview link too.
- **share `key`** — its `key=` hash is one that also appears in the PR body: a `key` is
  per-share-link, so an identical `key` is the PR's own link re-posted. A bare `?preview_theme_id=`
  is **not** a shape test — that is what every preview link looks like.

With no PR body (a non-zero `gh` exit, an empty list) the id and share-`key` tests have nothing to
compare against and the wording test decides alone. The question then offers the **live** theme ·
"your saved theme" (when set) · **Other** only, and the dropped link is not mentioned in the brief — not on the Deployed line, not
in **Observations**. Its `<path>` may still answer a target-page rung like any ticket URL — path only, never its `preview_theme_id`, share `key` or other params —
because the URL the run opens and prints is built on the chosen theme; the link itself, its id and
its `key` are never printed. A saved theme whose id happens to equal the PR table's is still the
engineer's own registered theme and stays offered — the ban is on the PR table as a *source* of
candidates, not on an id the engineer registered themselves. And a link the QA engineer pastes
themselves — at this question or at the gate's step-4 question — is honoured even when it is the PR's
preview: these tests only keep it off the offered list, and the Deployed line records it as chosen by
the QA engineer. A ticket link or id that is not evidently the PR's — the reporter's repro link on
another theme, a QA theme named in Steps to test — stays offered.

**Live** → no preview link is needed, every page URL is the plain store URL, and the gate checks `role`
`main` and records the id it read; nothing is compared against any other id. **Not live** → the run
needs a way onto that theme: `?preview_theme_id=<id>` when they picked an offered id, otherwise the
link the ticket or the engineer supplies — a theme share link, or any URL carrying
`?preview_theme_id=<id>`. It does **not** start the browser phase without one. A free-form answer that
names a theme the run has neither a link nor an id for is asked once more; still none → **Block**,
reason `no preview link for theme under test`. **Exactly one theme is examined per store per run** —
the chosen one, or the replacement link pasted at the gate's step-4 question, which supersedes it and
is the only restart allowed. A superseded theme survives only as that question's one-line evidence,
never as a brief row and never as a screenshot. No other theme is opened, read, screenshotted or
reported on: not the PR's, not the ticket's when the engineer chose live, not a develop or UAT
theme. Record the choice —
`live`, or the preview link — and that the QA engineer made it, on Block 2's Deployed line, which
prints the theme finally examined.

**Page URL.** One absolute URL per page, built from what their answer **is**:

- live → `https://<domain><path>`, no params: a URL found in the ticket or anywhere else contributes
  its `<path>` only — `preview_theme_id`, `key`, `_ab`, `_fd`, `_sc` are dropped, and the theme those
  params name is not opened;
- any preview URL they chose — pasted, or the one the ticket named → **that URL verbatim**, with only
  the path swapped for the target path and every param kept (`preview_theme_id`, `key`, `_ab`, `_fd`,
  `_sc`) — its host too, when it differs from the registry domain;
- a bare theme id, picked from the question (the ticket's id, or the registry's
  `defaultTheme`) → `https://<domain><path>?preview_theme_id=<id>`, joined with `&` when the path
  already has a query. Choosing an offered id counts as supplying the theme: the URL is constructible
  from it, so that answer never hits the Block above.

`<path>` is the **real** path the run opened — the resolved product / collection / page handle, never a
template name and never "the PDP" — and it carries its leading `/`, so the built URL never doubles it.
The theme under test's id is the `preview_theme_id` of the link they gave, or the id they picked: it is
the id the gate compares `Shopify.theme.id` against and the id Block 1 and Block 2 print. A theme share
link always carries it; a pasted URL with no `preview_theme_id` but a theme id in its path
(`/themes/<id>/…` — the Admin editor or preview URL) supplies the id: build
`https://<domain><path>?preview_theme_id=<id>` from it. Only a URL carrying no id at all is not a
preview link — ask once more, then **Block**, reason `no preview link for theme under test`.

**The hard rule for the brief.** Every URL the brief carries — the PR link on the Deployed line, every
**For human eyes** row, a **Needs data** row that names a page — is absolute, resolved and clickable: one URL per
page, comma-separated when a row spans several. The tester clicks and lands there, never hunting a
handle, an id or a link. Forbidden, all of them: `PR preview URL`, `(in preflight.md)`, `see Deployed
line`, a path without scheme and domain, a template name in place of the page, and a handle the tester
would have to look up.

The storefront password is never part of a URL: it lives in the password cookie of the run's isolated
context, and the tester enters it themselves.

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
2. **Theme gate.** Open the target page at the page URL built from the engineer's answer (Theme
   under test and page URLs above): the plain store URL when they test live, their preview link with
   the target path swapped in and every param kept when they do not. A bare `preview_theme_id` works
   anonymously for any theme of the store once the storefront is unlocked — it is what a theme share
   link is. Then read:

   ```js
   () => (typeof Shopify === 'undefined' || !Shopify.theme)
     ? { id: null, role: null, name: null, shop: null }
     : { id: String(Shopify.theme.id), role: Shopify.theme.role, name: Shopify.theme.name,
         shop: Shopify.shop }
   ```

   `shop` is the store's `<handle>.myshopify.com`; its handle builds the admin URLs of Block 2's
   **Needs data** recipes and is never a gate criterion.

   | Reading | Meaning for the brief |
   |---|---|
   | `role: "main"`, whatever `id` reads | the expected reading when the engineer chose **live** — the published theme *is* the theme under test: record the `id` and `name` read as the theme under test. Nothing is compared against any other id |
   | `id` matches the engineer's theme, `role: "unpublished"` | the expected reading when they gave a **preview link** — it put us on the theme under test |
   | a preview link, but `role: "main"` — the id read is the published theme's | their link does not put us on that theme — an id that no longer exists renders the published theme. Say so in **Observations**, ask once (paste another preview link, or test live), then rerun the gate; no answer → **Block**, reason `theme <id> not reachable`. The run never continues on a theme the engineer did not choose; this row wins over `id` differs below |
   | `id: null` | not a Shopify storefront render (a 404, a challenge page, a redirect to the password page): treat as a mismatch |
   | `id` differs from the engineer's preview theme and the row above does not apply | re-navigate **once** (a first hit can land before the preview cookie is set); still different → **Block**, reason `theme <id> not reachable`, naming the theme the engineer's link points at (the id may be wrong or the theme deleted — say which store answered and what `Shopify.theme` returned) |

   **Target page.** Precedence, in order: a URL or path in Steps to test → a path in the ticket —
   its **path only**, never the `preview_theme_id`, share `key` or any other param of a link found
   there, and a bare `/` does not satisfy this rung → a storefront path the PR body names in prose,
   never its Preview URL or the deep-links under it (discarded at PR discovery, so no path is taken
   from them) → the template the diff touches (`templates/<name>.json` → that template's storefront
   path; the diff comes from the call in PR discovery) → ask the QA engineer. Never guess a handle —
   a gate passed on the home page proves nothing about a PDP change. This precedence decides the
   **path**; Theme under test and page URLs decides the URL around it.
3. **Marker check — on the chosen theme only.** The marker is a string the change introduces: from
   the ticket when it gives one, else derived from the PR diff (the call in PR discovery) — a class, a
   `data-` attribute, a CSS custom-property name, a locale string the diff adds. Read it the way its
   kind allows, once, on a page the diff's own files render: a class or `data-` attribute →
   `document.querySelector`; a CSS custom property →
   `getComputedStyle(<el>).getPropertyValue('--x')` non-empty, or the name present in the theme's
   stylesheet text; a locale string → `document.body.innerText.includes(…)`. Record the read and its
   result on the Deployed line. A marker whose kind cannot be read on the page opened is **not**
   "absent", and neither is a change no reachable page renders: with that, or with neither a ticket
   marker nor a diff-derived one, the Steps-to-test rows and their pass/fail are the proof — record
   `no marker — the rows are the proof` and go on, never Block for a missing marker.
4. **The chosen theme does not carry the change** — the marker is absent (stop here, before the rows
   run), or the rows ran and every one of them shows the pre-change behaviour (stop there, run no
   further rows). Browser work **stops**; nothing else is looked at, and no other theme is
   probed to find where the change does live. Go back to the QA engineer with one question
   (on Claude Code one AskUserQuestion, elsewhere a plain question):

   > Theme `<id> <label>` on `<store>` does not carry the change (`<one-line evidence>`). Is this the
   > theme you test on? Paste another preview link where the change is deployed, or confirm this theme.

   Options: **paste another preview link** → restart this phase on that link, same page-URL rules,
   one restart only (a second theme without the change is **Block**) · **this is the theme,
   continue** → **Block**. A confirm, or no answer → **Block**, reason `change not
   on theme <id> <label>`, Route `back to the QA engineer's theme choice / deploy owner`. That brief
   carries no **For human eyes** rows, no **Needs data** rows, no link to any other theme and no "the
   fix exists on theme X" statement; **Observations** may state only what was read on the chosen theme.
   Block 1 says plainly that the change is absent on that theme, so the engineer can post it as the
   ticket's answer.
5. **Never** publish, duplicate or edit a theme, change its settings, create a preview theme, or
   make any Admin write. The gate is three reads and a navigation.

## Rows from Steps to test

The field arrives in **either** of two shapes and **both are accepted** — old tickets keep the shape
they were written in, and nothing here asks for a field to be rewritten:

- **Headed** (the pre-2026-09 shape): a Setup block, a `✅ Checkpoint` line, per-AC scenarios, a
  regression sweep, edge cases. One row per **scenario**; the Setup block feeds **Needs data** rather
  than rows, the checkpoint is the theme proof the gate already ran, and the regression sweep's
  scenarios are rows like any other.
- **Numbered** (`../../references/steps-to-test-format.md`, the company templates): one ordered list
  — item 1 the theme, item 2 where + setup, items 3…n the walk-through with each expectation inside
  its own step, then Edge cases and Context / out of scope as the last two items.

Detecting which: a numbered field opens with `1.` and its item 1 names the theme; a headed field
carries `Setup`, `✅` or `Scenario` headings. A field that mixes them is read item by item under the
mapping below, and neither shape is ever "fixed" — a shape complaint is at most a **Developer gaps**
line, never a Block.

| Item (numbered shape) | What it gives this run |
|---|---|
| **1 — Theme** | the primary source for the Phase 2.3 option "the theme the **ticket** names": its label + id — a bare label + id is offered against the store item 1 names in the same line; no store named and no link → not offered — or its `preview_theme_id` link, plus the market / locale / customer state / incognito conditions the rows then run under: a condition this run cannot set read-only is `not-executable: access` on the rows that need it, and a viewport item 1 names never narrows the two-viewport rule below. The three "evidently the PR's preview" tests above still decide, so the PR's own theme is never offered or opened from here; an unconfirmed placeholder (`[QA] theme — confirm with the TL`) names no theme, and the question falls back to live · saved theme · **Other**. Never a row. |
| **2 — Where + setup** | the target page — its `<path>` is the "a URL or path in Steps to test" rung of the target-page precedence — and the material for **Needs data** recipes: the editor route or deep link, every setting by its verbatim label with its value, the data sub-bullets in their dependency order, the closing **Save**. Copied into a Block 2 recipe when the fixture or the setup is absent, **never turned into a row**: this run is read-only, and building the section is the QA engineer's own step. A `(restore: …)` clause travels with the recipe line it belongs to. |
| **3…n — walk-through** | **one row per step this run can perform read-only** — a storefront action carrying an expectation ("You should see …", "The panel shows …"), in field order, the expectation quoted as the row's expected result. A step whose action is an **editor or Admin write** (**Add section** / **Add block** / a setting set to a value / **Save** / a fixture issued or deactivated) is **never a row, even when it carries an expectation** — it feeds a **Needs data** recipe like item 2, and where the run therefore cannot observe what that step produces, the row it would have produced is reported `not-executable: access` with what would have to be written and its restore. A read-only step with no expectation of its own — pure navigation — is folded into the next row. |
| **n+1 — Edge cases** | **one row per bullet**, its stated behaviour as the expected result. A bullet a read-only run cannot reach (it needs an admin write, a deactivated fixture, a market switch this run may not perform) is `not-executable: access` or `needs data: <what, where>`, reported with its restore, never performed. A platform limitation the bullet states as *not a bug* is a row that confirms the stated behaviour — never a Fail. |
| **n+2 — Context / out of scope** | **never rows.** Defaults, what was deliberately left unchanged, known limits and what is not in this ticket are read as context for the other rows' expectations: a known limit named here is not a Fail, and an out-of-scope area is not tested to prove it is out of scope. A choice stated here that contradicts the AC is an **Observations** line, not a verdict. |

**Bug template** (theme · why the bug happened · what was changed to fix it · what to expect): item 1
plays the same role as above, items 2 and 3 are context for the expectations, and the rows come from
**item 4** — the data, viewport, locale or path that used to trigger the defect, what it does now, the
new boundary and what past it looks like, what a regression would look like: one row per expectation.
The click-level recipe item 4 carries when the fix touches a setting or needs data feeds **Needs data**
exactly as item 2 does above.

**Plus one row per AC**, for either shape. The numbered shape is written so every AC is exercised by at
least one walk-through step, so the two sets usually coincide — check which AC each row covers and add
a row only for an AC no step reaches; never list the same check twice. Row numbers run through the
brief in its own order whatever each row came from, and `NN` in a screenshot path is that number.

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
  it. In a git worktree use `.claude/tmp/<KEY>/` instead (same names, same `mkdir -p`): its
  `.claude/tasks` is a symlink the screenshot servers refuse. The frame must show the thing the row
  is about; a full-page shot of a long template proves nothing, so scroll the target into view
  first. Never capture a frame with the password field filled.
- **Checkout** is walked only to the payment step: line items, quantities, bundle composition,
  discounts, shipping options, totals. Contact and address values come from the ticket, the
  workspace `notes.md`, or the QA engineer — ask once; never a real person's details and never the
  QA engineer's own account. Stop at the payment form: no card details, no order. Empty the cart or
  abandon the checkout before the next row so it starts clean. A test order is the QA engineer's
  call on their own account, never this skill's.
- **`needs data: <what, where>`** replaces a verdict when the fixture the row needs is absent (no
  product with the required metafield, no discount code, empty metaobject, no block on a dark colour
  scheme). Its Block 2 row is a **recipe** the QA engineer follows click by click — admin URL, the
  section / block / setting or metafield as the editor names it, the exact value, Save, the page URL
  to reopen — never a one-line diagnosis of what the store lacks: Block 2 → A Needs data row is a
  recipe.
- **`for human eyes`** is a first-class outcome, not a failure: visual polish against a design,
  hover and transition feel, copy tone, animation timing, anything where the brief would be guessing.
  Its Block 2 line carries the **absolute page URL of every page where the person checks it**, built
  per Theme under test and page URLs, one per page when the row spans several, so the engineer clicks
  once and lands on the theme under test. The forbidden forms listed there bind this line: no
  `PR preview URL`, no `(in preflight.md)`, no `see Deployed line`, no path without scheme and domain.
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
2. {color:green}Pass{color} — <…>

## Block 2 — Preflight notes (not for Jira)

**For human eyes**
- row <n> — <what a person has to judge> — <page URL as opened, per Theme under test and page URLs,
  preview params and all>[, <second page URL as opened>]

**Needs data**
- row <n> — <what is missing, one line>
  1. <store alias> — open <absolute admin URL: the theme editor on the theme under test, landing on
     the page the row opens, or the product / collection / metafield-definition admin page>
  2. <Section — its editor name and position on the page> → <block> → <setting label> → <exact value
     or option label>[; <next setting> → <value>]
  3. Save, reopen <page URL as opened> — <what the row then shows>

**Developer gaps**
- <one gap per bullet: a Steps/AC contradiction, a missing page, an absent AC, a ticket question>

**Observations**
- <one fact per bullet — anything true but not derivable from the ticket, never a verdict>

**Route:** ready for hands-on QA | back to developer | back to the QA engineer's theme choice / deploy
owner | nothing to test in the theme → deploy owner

**Deployed:** theme <id> <label> (<live | preview link>, chosen by the QA engineer) · marker
<`<string>` found|absent | no marker — the rows are the proof> · PR <url>
```

**Block 2 is read top to bottom by a person, so it is laid out for scanning**: every label is its own
paragraph with a blank line before and after; under a label, one bullet per row or per fact — a row
whose story needs several facts (what was seen, why it cannot be reproduced here, what would prove
it) gets one bullet per fact, never one long sentence chain; a bullet is two sentences at most; a
label with nothing under it stays as one line, `**Needs data:** none`, so the reader still sees every
heading. Labels never run into each other on adjacent lines — markdown folds adjacent lines into one
paragraph, and the brief then reads as a wall of text. **Route** and **Deployed** are single lines.

**A Needs data row is a recipe, not a diagnosis.** The QA engineer reads it and provisions the
fixture without looking anything up: "the store has no card group on a dark scheme with a primary
button" is a finding they cannot act on; "Home page → section *Card group* (third on the page) →
*Colour scheme* → *Scheme 2* → block *Card* → *Button style* → *Primary* → Save" is one they can.
Every recipe names:

- **Where** — the store by its alias, then one absolute admin URL the engineer clicks and lands on.
  A theme setting: the editor on the theme under test, opened on the page the row opens,
  `https://admin.shopify.com/store/<handle>/themes/<theme id>/editor?previewPath=<url-encoded path>`
  (`<handle>` = the `shop` the gate read, minus `.myshopify.com`). A product / collection / page
  fixture: its admin page when the run read the numeric id (`…/store/<handle>/products/<id>`), else
  the admin list filtered on the handle (`…/store/<handle>/products?query=<handle>`). A metafield
  definition: `…/store/<handle>/settings/custom_data/<owner>/metafields`.
- **What** — the section by its editor name and its position on the page (`templates/<name>.json`
  lists the page's sections in order; `{% schema %}` → `name`), the block by its name, every setting
  by its **label** and the value by its **option label** — the names the editor shows, read from the
  section's or block's `{% schema %}` (`t:` keys resolved through `locales/en.default.schema.json`),
  never the code's (`variant="secondary"`, a setting id, a scheme number the editor does not show).
  A metafield: the definition name, `namespace.key`, type, the owner (a product by title and handle),
  the value to enter. A discount / customer / order fixture: the admin object and its fields.
- **Then** — Save, the page URL as opened (per Theme under test and page URLs) and what the row
  shows once the fixture is there.

Sources are the theme code in the working tree (the PR's branch, or the branch the merge landed on)
and, for numeric ids and metafield definitions, Admin API **reads** through
`node <plugin root>/scripts/shopify-admin-gql.sh --query <file.graphql>` when the repo carries
credentials — reads only; the run's posture stays read-only, the QA engineer makes the change.
Nothing is guessed: a label the schema does not hold, a section the template does not carry, a
metafield with no definition → the row is a **Developer gap** ("no setting exposes X"), not a
recipe. Prefer the cheapest fixture: one setting on a block already on the page the row opens over
a new section; a value on an existing product over a new product. The recipe edits the theme under
test — when that theme is live or a shared UAT theme, say so on the row ("<theme label> is shared:
change it, or test on your own copy") and leave the choice to the engineer.

**Deployed** closes Block 2 and stays that one short line — the theme examined, the marker read and
the PR link: a developer's trace, not something the QA engineer reads. The PR appears once, as its
URL — no `#<n>` beside it, a renderer that turns the URL into a chip would show the number twice.
Head and base branch, merge date, the branches carrying the merge, the target page and which rung
chose its path are not written into the brief at all.

`<theme label>` is the registry's label for that theme id, else the `name` the gate read
(`Shopify.theme.name`), else `live` for the published theme and `preview` otherwise — never invented.
The same fallback fills `<label>` in the no-change question of the gate's step 4. Every
`<page URL as opened>` is the URL built per Theme under test and page URLs, params and all — e.g.
`https://<domain>/products/<handle>?preview_theme_id=<id>`.

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
one defect with evidence), **Block** (the gate failed, the chosen theme does not carry the change, or
no AC could be reached), **Partially pass** (some rows verified, the rest `needs data` /
`for human eyes` / `not-executable`). Choose the
verdict from the rows, never to be helpful. A run with **no Block 1** — a non-theme change, or
nothing to test — has no Testing Status line at all: the four values apply only to a theme change
that was actually exercised.

**Fail** keeps the same header and lists every row that ran — the passing ones as above, each
defect as a red row with expected vs actual — so the reader sees what still holds next to what
broke; its screenshot reaches the engineer in chat (Screenshots in chat below), not as a line here. **Partially pass** uses the Pass shape (green rows only; the rows left
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
2. {color:red}Fail{color} — <where> — expected <what the AC says>, actual <what the page did>
```

**Block** is the shortest form: the label line, the `Tested in theme build:` bullet, then one line of
reason (`theme 156379611322 not reachable on
https://elc-us-mc-uat.myshopify.com/products/<handle>?preview_theme_id=156379611322 —
Shopify.theme.id is 150843719862`) and nothing else. A run that never reached the rows drops the two
viewport bullets — it tested nothing at either viewport and must not say it did. No partial evidence
list under a Block — the run has no ground to stand on, and the screenshots of rows that did run stay
on disk, uncited. When the reason is that the chosen theme does not carry the change, that
one line says so plainly (`the change is not on theme 156379611322 develop — <one-line evidence>`), so
the QA engineer can post it as the ticket's answer; it names no other theme.

**Screenshots in chat.** Block 1 carries no `screenshot:` lines: the skill has no attachment upload,
and a filename or a local path in the client's ticket points at nothing. The frames reach the QA
engineer in the chat instead, right after the two blocks of their ticket, **one message per row** —
the row's desktop and mobile frames together, captioned `<KEY> row <n> — <slug>` — so they copy the
image and paste it into the Jira comment themselves. On a host with a file-send tool (on Claude
Code in the desktop app: `SendUserFile`, `display: render`) send the files; on a host without one,
print each file's absolute path, one line per row. Say once per run, before the first image:
`screenshots are not uploaded to Jira — copy the ones you need into the comment yourself.` The `NN`
prefix ties every file to its Block 1 row. A **Block** sends nothing — its frames stay on disk,
uncited.

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
3. No screenshot references in the comment — no `screenshot:` line, no filename, no local path: the
   skill has no attachment upload, and a name the reader cannot open is noise in the client's ticket.
   The frames were shown in chat (Brief template → Screenshots in chat); the QA engineer pastes the
   ones they want into the comment by hand.
4. The write goes through the **`jira-writer`** subagent — brief it with the ticket key **plus the
   workspace path the key came from**, target `comment`, and the path of the approved
   `preflight-comment.md` (`../../references/jira-adf-write.md`). It converts to ADF, posts once and
   reads the comment back.
5. **No transitions and no field edits.** Moving `Ready for QA → Ready for UAT`, failing a ticket
   back to `In Progress`, filing a bug ticket, or touching Acceptance Criteria Status is the QA
   engineer's judgement and their account. Say what the brief suggests; let them do it.
6. A `cc @PM / @dev` line is common in the house style but names people this run cannot pick — add it
   only if the QA engineer dictates the handles.
