# Steps to Test — Domaine format

Output standard for the `write-steps-to-test` skill and the pipeline steps-to-test phase: **one numbered
list** in the General or Bug item order of Domaine's company guide ("Writing Steps to Test"), nothing else.
The QA engineer already has the AC; what they lack is **how this was built** — theme, page, section, settings,
data, the developer's choices. So **fewer test cases, more how it was built**, written for someone opening the
Shopify admin for the first time.

## Templates

**General (feature / improvement)** — Theme, Where + setup, the walk-through with the guide's item 4 folded
into each step, Edge cases, Context / out of scope. `n+1` / `n+2` denote the last two numbers of the run; the
output carries the real digits (`8.`, `9.`).

```markdown
1. **Theme:** <store + theme, label + id>; <preview link or **Preview** route>. <Market / viewport if it matters, + how to set it.>

2. **Where:** page `<path>` (admin: <exact route, labels verbatim>). The section is **<name as the admin sees it>**.
   - <ships on `<template>` — find it in the sidebar, don't **Add section**; if it is missing, set it up as:>
   - <Customize route, or one editor deep link> > **Add section** > **<Section name>** (drag <position>);
   - **<Setting label>** → `<value>`; **Add block** > **<Block name>** > **<Setting>** → **<option>**;
   - add <content: product / image / copy>, then **Save**. <Theme code updated again → redo this setup.>
   - data you need, in <admin path>: <role> — `e.g. <handle>` + <properties> <(store-wide) (restore: <how>)>.

3. On `<path>`, <action>. You should see <exact outcome — copy verbatim, values, counts>.
4. <Next action, location first.> <Expectation clause.>

n+1. **Edge cases:**
   - <blank / overflow / boundary on a new setting> → <expected behaviour>;
   - <platform limitation> → <what happens; not a bug>.

n+2. **Context / out of scope:**
   - <new setting + its default, where the value comes from>;
   - <what was left unchanged, or a known limit, stated as not a bug>;
   - <not in this ticket: <area> — <one clause why>>.
```

**Bug (defect fix)** — the guide's four items; no scenarios, no regression sweep. The location, the setup
recipe and the expectations all live in item 4.

```markdown
1. **Theme:** <as above — store, theme, how to open it>.
2. **Why the bug happened:** <root cause in terms the tester can observe, 1–2 sentences>.
3. **What was changed to fix it:** <the change in plain terms, new limits / values; a setting by its verbatim editor label>.
4. **What to expect:** on `<path>` (admin: <editor route>), <the data / viewport / locale that used to trigger it>; <what it does now>; <the new boundary and what happens past it>; <what a regression looks like>. <Touches a setting or needs data → item 2's recipe + that setting's blank / overflow / boundary expectation.>
```

## Item-by-item rules

**1. Theme.** Store + theme, label + id (order: Theme resolution, below), and the route that opens it, since
every later path resolves against it: confirmed id, no editor work → the preview link
`https://<store>.myshopify.com/?preview_theme_id=<id>`; else `Online Store > Themes > *<theme>* >
**Preview**`; either way, "stay in that preview session". Never the PR's own preview theme. Market / viewport
/ locale / customer state only when the behaviour depends on them, with how to set each. No storefront
passwords, no deploy or CI mechanics (workflows, pushes, tags, PR links); naming the branch a theme receives
("the theme the TL deploys `develop` to") is allowed.

**2. Where + setup.** Pages by path; the section or block **by the name the admin sees**, read from the
`{% schema %}` with `t:` keys resolved through `locales/en.default.schema.json`, never a code name. A label
you cannot read is **unverified**: write it plus `(name as the code spells it — confirm the admin label)`
and raise it in the presentation — marked, never dropped. Sub-bullets, one action each:

- **Where** — the store by its alias, then the editor route as the admin shows it (`Online Store > Themes >
  <theme> > Customize > <page / template>`) or one deep link,
  `https://admin.shopify.com/store/<handle>/themes/<theme id>/editor?previewPath=<url-encoded path>`.
- **Setup from scratch** — for everything the change adds and every setting whose default, options or wiring
  it changes: **Add section** / **Add block** by their editor names, the placement, every setting that must
  leave its default by its **label** with its value by its **option label**, the content, then **Save**. QA
  builds it; an empty section on the QA theme is expected. The recipe may sit in item 2 or be the walk-through
  steps themselves when building the section **is** the test.
- **Already there** — from the repo, never from the QA theme's state, which you cannot see: in the template
  JSON → "ships on the `<template>` template — find it in the sidebar, don't **Add section**"; else "if it is
  missing, set it up as: …".
- **Data you need** — in dependency order: store / market settings (toggle by verbatim label with its value) →
  metafield definitions (owner · **Name** · `namespace.key` · type · `Settings > Custom data > … > Add
  definition`) → metaobject definitions → entries (`Content > Metaobjects > <type> > Add entry`) → values →
  fixtures. Tag **(store-wide)** or **(per-theme)** where it matters; store-wide data is shared with the live
  theme — use QA fixtures.
- **Restore** — a store-wide mutation ends with its restore in the same bullet (`(restore: Activate)`);
  per-theme settings need none.
- **Fixtures** — handle plus the property that makes it right: `e.g. /products/studio-fix-fluid (40+ shades,
  in stock)`; the handle is the example, the properties the requirement. Once, after the first handle:
  `Handles are examples — if one is missing on your store, use any product with the same properties and say
  which one you used.`
- **Created in setup** — an entity that exists only once QA makes it (an issued gift card, a discount) is
  named by its role, with where its value appears and whether it shows once. A state only time reaches is
  a dated instruction (`**Expiration date** = today, check it the next calendar day`); the steps needing it
  name their day.

**3…n. Steps to replicate.** One pass through the feature **as built**: imperative, location before action,
labels bold and verbatim, one action per step — or one chain along a single path. Every AC's functionality is
exercised by a step, or discharged in n+2 when this ticket delivers it outside the theme. Not one scenario per
AC, no regression sweep, no negative path unless the implementation has a deliberate one. Never restate setup;
name a fixture by its item-2 role.

**Expectations sit inside the step that produces them** — "You should see …" — never a separate Expected
block: one clause, concrete wherever a value is observable (copy verbatim, prices, counts), never "works
correctly" or "or similar". A setup step's expectation may be what the setting accepts and what happens at its
limits ("any size works, 1000x1000 preferred").

**n+1. Edge cases.** One per new or changed setting where blank, overflow or a boundary matters, plus the
cases the named data already reaches (an entity without the value, a deactivated fixture, another market),
each with its expected behaviour. A platform limitation is stated as not a bug (the colour picker cannot
exclude `#ffffff`). Soft cap ≈ 4 — coverage outranks it.

**n+2. Context / out of scope.** The developer's choices that affect testing: new settings with their defaults
and where a value comes from, what was intentionally left unchanged, known limits, copy from **Theme content**
that should stay default, and what is **not** in this ticket — including an AC item delivered outside the
theme, named as the AC names it. Up to five bullets, a clause each; omit the item only when the change made
no choice worth stating.

**Visual aids.** Where a location or setup step is not obvious from text, ask the developer **in the
presentation**, never as a line in the field, to attach a screenshot or short video by hand; the plugin
uploads nothing.

## Shape and size

These bind both templates; n+1 / n+2 and the walk-through rules name General items only.

- **One physical line per item.** Never wrap an item or a nested bullet: `md-to-adf --no-tables` reads a
  continuation line as a new paragraph and splits the list. Fold a second paragraph in or nest it.
- **One ordered list, end to end** — numbering runs through, Edge cases and Context last. No headings, no `✅`
  markers, no tables; nested bullets one level deep, under items 2, n+1 and n+2.
- **No document meta** — no title, summary, revision history or rationale.
- **Observable words only** — labels as the UI spells them, copy as it renders; no setting ids, DOM
  attributes, ARIA roles, class names, file paths or locale keys. An a11y expectation says what a screen
  reader does; **Theme content** copy is its admin route plus the string it renders.
- **No hedged actions** — no "if present", "roughly", "skip if": an action is taken or the step goes. A
  conditional inside an expectation is fine, as are item 2's "if it is missing …" and item 1's unconfirmed
  theme; a dated instruction is an action, not a hedge.
- **Absolute hosts only where they are the address** — item 1's store host and preview link, one admin/editor
  deep link in item 2; storefront paths in items 3…n stay relative. Never fork per store.
- **Size.** 150–350 words; setup-heavy (a section built from scratch, fixtures QA creates) up to 450. Coverage
  of items 1, 2 and n+2 outranks the budget; trim walk-through prose, repetition and edge cases first, never
  setup detail, a step's expectation or a developer choice. A cap, not a floor — a one-setting change is
  legitimately Example-2 short.

## Theme resolution (item 1)

In order, stopping at the first that answers:

1. **The ticket** — a QA theme link or id in the Description, Steps to test, AC or comments, unless it is
   evidently the PR's own preview theme.
2. **A theme this session confirmed on that store**, from the workspace `notes.md` — written as `id <id> as of
   <date> — confirm with the TL`.
3. **Ask the developer once** — "which theme does the TL push to for QA?" (on Claude Code one AskUserQuestion,
   elsewhere a plain question).
4. **Placeholder** — `[QA] theme — confirm with the TL`, or a known id whose owner is unknown, stated as
   unconfirmed; never invent a theme.

Never the QA store registry's `defaultTheme`, and never the session's own preview theme from the
workspace — that is the PR's theme.

## Which template

An explicit `ticket_type` argument decides; with no argument, Jira issue type `Bug` selects the Bug template
and anything else the General one.

## Self-check before presenting

- One ordered list, numbered through, nothing wrapped; bullets one level deep under items 2, n+1, n+2; no
  headings, tables, `✅` markers or document meta.
- Item 1 first, naming a theme (ticket, developer's answer, or unconfirmed — never the PR's preview) and
  opening it; store host and preview link at most once.
- Everything the change adds or reconfigures has its editor route, every non-default setting with its value
  by label and its content — in item 2 (a recipe block there ends with **Save**), in its fallback, or in the
  steps that build it.
- Item 2 names every page by path, the section as the admin sees it, and every entity the walk-through
  starts from.
- Every handle carries `e.g.` plus the properties a stand-in must share, the substitution rule appears once,
  and no step names a handle instead of its role.
- Every AC is exercised by a step, or discharged in n+2 in the AC's own words — never simply absent.
- Every step that changes or checks state carries its expectation inline, concrete where observable.
- Every new or changed setting has its blank / overflow / boundary expectation somewhere; every edge case is
  reachable with the named data; every store-wide mutation carries its restore.
- Walked through as written, nothing from memory; whatever made you hesitate gets a sentence, or a screenshot
  is asked for in the presentation.
- No banned content: the PR's preview theme, per-store forks, absolute storefront hosts in items 3…n,
  passwords, deploy or CI mechanics, "works correctly", "or similar", a hedge, a code identifier.
- The choices that affect testing are stated (defaults, what was left unchanged, limits, out of scope) or
  there genuinely are none; items 1, 2 and n+2 are complete, nothing cut to a word count — this field plus
  admin access is enough.

On the **Bug template** these apply through item 4 — the location, the trigger data / viewport / locale, the
setup recipe, a new setting's boundary expectation, what a regression looks like.
